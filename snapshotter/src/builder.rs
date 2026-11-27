// SPDX-License-Identifier: Apache-2.0
//
// The deterministic snapshot builder (Phase 5.1 core).
//
// Pipeline (all steps deterministic; see the crate root for the normative
// policies):
//
//   1. Read the LP mint supply (+ served slot) from the source — this is
//      the state anchor. A read without a usable context slot (slot 0)
//      aborts (`MissingStateContext`); no slot is ever fabricated.
//   2. Enumerate every SPL token account holding the LP mint, pinned to
//      the anchor slot (`min_context_slot`) — the source must fail rather
//      than serve state older than the anchor.
//   3. HARD GATE: Σ enumerated balances == mint supply (`SupplyMismatch`).
//      A complete SPL enumeration always satisfies this; failing it means
//      inconsistent source state and an unusable snapshot.
//   4. Post-enumeration supply re-read, pinned to the same anchor slot.
//      The supply MUST equal the initial read (`SupplyDrift` otherwise) —
//      supply drift between the reads means no single chain state was
//      observed and the snapshot is refused. LIMITATION: equality proves
//      the TOTAL did not drift; it cannot detect a same-total holder
//      transfer between the anchor and the enumeration (D-06 P2 boundary).
//   5. Aggregate balances per owner (`BTreeMap` — ascending pubkey bytes).
//   6. Exclusion pass (ascending owner order): zero-balance owners and
//      declared sink owners move to the exclusion ledger.
//   7. Locked-LP resolution: validate + aggregate TokenLock records,
//      identify the custody account by exact-balance reconciliation
//      (fail-closed on ambiguity or absence), remove the custody balance,
//      attribute the locked amounts to the beneficial `lock_owner`s.
//   8. Merge attributions into the per-owner map (locked + unlocked).
//   9. Emit the canonically ordered leaf set + ledgers, and enforce the
//      closing identity
//      `entries_total + sink_exclusions_total == enumerated_total == supply`.

use std::collections::{BTreeMap, BTreeSet};

use solana_sdk::pubkey::Pubkey;

use crate::error::SnapshotError;
use crate::locked::LockedLpEvidence;
use crate::model::{
    CustodyMatchMethod, CustodyResolution, ExcludedBalance, ExclusionReason, HolderEntry,
    LockedReport, LpSnapshot, Reconciliation, TokenAccountSnapshot,
};
use crate::sink_ledger::SinkLedger;
use crate::source::LpAccountSource;

/// The snapshot request: which pool/mint to snapshot, and the two
/// operator-supplied policy inputs (sink exclusions and custody
/// disambiguation overrides). Everything else is derived on chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRequest {
    /// The AMM pool account (Raydium V4 `AmmInfo`) — binds TokenLock
    /// evidence to the pool, mirroring the on-chain scanner check.
    pub pool_address: Pubkey,
    /// The AMM program id (informational metadata in v1.0; the adapter
    /// dispatch point for multi-venue expansion).
    pub amm_program_id: Pubkey,
    /// The pool's LP mint to snapshot.
    pub lp_mint: Pubkey,
    /// Owners that can never sign a claim (incinerator-style accounts).
    /// Their balances leave the leaf set and are recorded in the exclusion
    /// ledger. Burned LP needs no entry here — burned tokens never
    /// enumerate.
    ///
    /// GOVERNED-INPUT INVARIANT (D2-02 / D-04-D / WD-07): a nonempty
    /// `sink_exclusions` REQUIRES a supplied governed `sink_ledger`, and
    /// the validated ledger is the authoritative source of the exclusions
    /// actually applied. A request that declares exclusions directly with
    /// no ledger — or a ledger that disagrees with the declarations — is
    /// rejected fail-closed; there is no legacy path that constructs a
    /// claims-grade snapshot from ungoverned exclusions.
    pub sink_exclusions: Vec<Pubkey>,
    /// Escape hatch for custody disambiguation: if several enumerated
    /// accounts hold exactly the locked total, exactly one of them must
    /// have its owner listed here, or the snapshot aborts
    /// (`CustodyAmbiguous`).
    pub custody_owner_overrides: Vec<Pubkey>,
    /// The governed sink-exclusion ledger (D-04-C/D, WD-07). REQUIRED for
    /// any nonempty `sink_exclusions`: its entries are validated against
    /// the enumerated holder set (identity, balances, token accounts) and
    /// its owner set MUST equal `sink_exclusions` — any disagreement
    /// aborts the snapshot. The ledger — not the raw request field — is
    /// the authoritative source of the exclusions applied to the leaf
    /// set. An absent ledger is only valid with EMPTY exclusions. The
    /// builder re-runs [`SinkLedger::validate`] on every supplied ledger
    /// — including one constructed directly in memory (the fields are
    /// public) — so a structurally invalid ledger cannot bypass `parse`
    /// and reach the pipeline. A validated ledger is structurally valid;
    /// its approval authenticity is a D-04-D process control outside this
    /// code.
    pub sink_ledger: Option<SinkLedger>,
}

/// Builds [`LpSnapshot`]s from a [`LpAccountSource`] + [`LockedLpEvidence`].
#[derive(Debug, Clone)]
pub struct SnapshotBuilder {
    request: SnapshotRequest,
}

impl SnapshotBuilder {
    pub fn new(request: SnapshotRequest) -> Self {
        Self { request }
    }

    /// The request this builder was configured with.
    pub fn request(&self) -> &SnapshotRequest {
        &self.request
    }

    /// Produce the deterministic snapshot. See the module docs for the
    /// pipeline; every failure mode aborts (`SnapshotError`), nothing is
    /// guessed.
    ///
    /// CONSISTENT-STATE PROTOCOL (WD-02 fix): the initial supply read
    /// anchors the run at its served context slot; the enumeration and the
    /// post-enumeration supply re-read are both pinned to that slot and
    /// must be served from a state at least as new. The re-read's supply
    /// must equal the initial supply. Any failure — missing context slot,
    /// stale state, supply drift — aborts the snapshot; nothing is
    /// produced or sealed from inconsistent state.
    pub fn build(
        &self,
        source: &dyn LpAccountSource,
        locks: &dyn LockedLpEvidence,
    ) -> Result<LpSnapshot, SnapshotError> {
        // ---- 0. Governed-exclusion gate (D2-02 / D-04-D / WD-07) ----------
        // Sink exclusions are never operator-declared directly. A nonempty
        // `sink_exclusions` without the governed ledger is a bypass of
        // ledger validation and is rejected BEFORE any state is read —
        // deterministically, fail-closed. There is no legacy path through
        // this builder that constructs a claims-grade snapshot from
        // ungoverned exclusions.
        if self.request.sink_ledger.is_none() && !self.request.sink_exclusions.is_empty() {
            return Err(SnapshotError::SinkExclusionsRequireLedger {
                declared: self.request.sink_exclusions.len(),
            });
        }

        // ---- 1. Initial supply read = the state anchor --------------------
        let initial = source.initial_supply(&self.request.lp_mint)?;
        let supply = initial.amount;
        if initial.slot == 0 {
            // Context metadata missing/unusable: refuse rather than record
            // a fabricated slot.
            return Err(SnapshotError::MissingStateContext);
        }
        let anchor_slot = initial.slot;

        // ---- 2. Full enumeration, pinned to the anchor --------------------
        let accounts = source.token_accounts(&self.request.lp_mint, anchor_slot)?;

        // ---- 3. Completeness gate: Σ balances == supply --------------------
        let mut enumerated_total: u128 = 0;
        for account in &accounts {
            enumerated_total = enumerated_total
                .checked_add(account.amount as u128)
                .ok_or(SnapshotError::Overflow)?;
        }
        if enumerated_total != supply as u128 {
            return Err(SnapshotError::SupplyMismatch {
                mint_supply: supply,
                enumerated_total: to_u64(enumerated_total)?,
            });
        }

        // ---- 3b. Post-enumeration supply re-read, pinned to the anchor -----
        // The re-read must observe the SAME total supply, otherwise the
        // enumeration spans more than one chain state and nothing may be
        // sealed. Note honestly what this does and does not prove: supply
        // equality detects SUPPLY drift, but a same-total holder transfer
        // between the anchor and the enumeration is invisible to it —
        // holder-level revalidation is the separate D-06 P2 control.
        let final_read = source.final_supply(&self.request.lp_mint, anchor_slot)?;
        if final_read.slot == 0 {
            return Err(SnapshotError::MissingStateContext);
        }
        if final_read.slot < anchor_slot {
            return Err(SnapshotError::StaleState {
                anchor_slot,
                served_slot: final_read.slot,
            });
        }
        if final_read.amount != supply {
            return Err(SnapshotError::SupplyDrift {
                anchor_slot,
                initial_supply: supply,
                final_supply: final_read.amount,
            });
        }

        // ---- 4. Per-owner aggregation (deterministic order) ----------------
        let mut per_owner: BTreeMap<Pubkey, u64> = BTreeMap::new();
        for account in &accounts {
            let entry = per_owner.entry(account.owner).or_insert(0);
            *entry = entry
                .checked_add(account.amount)
                .ok_or(SnapshotError::Overflow)?;
        }

        // ---- 4b. Governed sink-ledger reconciliation (D-04-C/D, WD-07) -----
        if let Some(ledger) = &self.request.sink_ledger {
            // AUTHORITATIVE STRUCTURAL VALIDATION: the ledger fields are
            // public, so a caller can construct `SinkLedger` directly and
            // skip `SinkLedger::parse`. The builder re-runs the exact
            // validation `parse` performs (schema version, ledger
            // identity, D-04-D entry fields, duplicate/ambiguity
            // rejection) BEFORE using the ledger — parser and builder
            // share one authoritative contract, and an invalid in-memory
            // ledger is rejected here, not partially applied.
            ledger.validate()?;
            // Pool/AMM/mint identity binding: a ledger for another pool is
            // never applied.
            ledger.validate_identity(
                &self.request.pool_address,
                &self.request.amm_program_id,
                &self.request.lp_mint,
            )?;
            // The request's declared exclusions must mirror the ledger
            // exactly — a ledger plus extra operator sinks (or a ledger
            // whose owners are not actually declared) is an ambiguous
            // configuration and aborts.
            let ledger_owners: BTreeSet<Pubkey> = ledger.entries.iter().map(|e| e.owner).collect();
            let declared: BTreeSet<Pubkey> = self.request.sink_exclusions.iter().copied().collect();
            if declared != ledger_owners {
                return Err(SnapshotError::SinkLedgerConflict(format!(
                    "sink_exclusions ({}) and governed ledger owners ({}) disagree; \
                     apply the ledger exactly or drop it",
                    declared.len(),
                    ledger_owners.len()
                )));
            }
            // Every declaration must reconcile against the enumeration:
            // the owner is enumerated, the declared balance equals the
            // owner's total enumerated balance, and the declared token
            // account exists under that owner carrying the full balance
            // (a spread balance is ambiguous — fail closed).
            for entry in &ledger.entries {
                let enumerated = match per_owner.get(&entry.owner) {
                    Some(total) => *total,
                    None => {
                        return Err(SnapshotError::SinkLedgerEntryNotEnumerated {
                            owner: entry.owner.to_string(),
                        })
                    }
                };
                if enumerated != entry.raw_balance {
                    return Err(SnapshotError::SinkLedgerBalanceMismatch {
                        owner: entry.owner.to_string(),
                        ledger_balance: entry.raw_balance,
                        enumerated_balance: enumerated,
                    });
                }
                match accounts.iter().find(|a| a.address == entry.token_account) {
                    Some(acct) if acct.owner == entry.owner && acct.amount == entry.raw_balance => {
                    }
                    _ => {
                        return Err(SnapshotError::SinkLedgerTokenAccountMismatch {
                            owner: entry.owner.to_string(),
                            token_account: entry.token_account.to_string(),
                        })
                    }
                }
            }
        }

        // ---- 5. Exclusion pass (ascending owner bytes) ----------------------
        // The validated governed ledger — not the raw request field — is
        // the authoritative source of the sink set: when a ledger is
        // supplied it was already enforced to equal the declared
        // exclusions, and without a ledger the gate above guarantees the
        // declared set is empty.
        let sinks: BTreeSet<Pubkey> = match &self.request.sink_ledger {
            Some(ledger) => ledger.entries.iter().map(|e| e.owner).collect(),
            None => BTreeSet::new(),
        };
        let mut exclusions: Vec<ExcludedBalance> = Vec::new();
        let mut sink_total: u128 = 0;
        let mut claimable: BTreeMap<Pubkey, u64> = BTreeMap::new();
        for (owner, amount) in per_owner {
            if amount == 0 {
                exclusions.push(ExcludedBalance {
                    owner,
                    lp_balance: 0,
                    reason: ExclusionReason::ZeroBalance,
                });
                continue;
            }
            if sinks.contains(&owner) {
                sink_total = sink_total
                    .checked_add(amount as u128)
                    .ok_or(SnapshotError::Overflow)?;
                exclusions.push(ExcludedBalance {
                    owner,
                    lp_balance: amount,
                    reason: ExclusionReason::ExplicitSink,
                });
                continue;
            }
            claimable.insert(owner, amount);
        }

        // ---- 6. Locked-LP resolution ----------------------------------------
        let records = locks.token_locks(
            &self.request.pool_address,
            &self.request.lp_mint,
            anchor_slot,
        )?;
        // Deterministic aggregation order regardless of source ordering.
        let mut records = records;
        records.sort_by(|a, b| a.address.cmp(&b.address));

        let mut attributions: BTreeMap<Pubkey, u64> = BTreeMap::new();
        let mut total_locked: u128 = 0;
        for record in &records {
            total_locked = total_locked
                .checked_add(record.current_locked_amount as u128)
                .ok_or(SnapshotError::Overflow)?;
            let entry = attributions.entry(record.lock_owner).or_insert(0);
            *entry = entry
                .checked_add(record.current_locked_amount)
                .ok_or(SnapshotError::Overflow)?;
        }

        let mut custody: Option<CustodyResolution> = None;
        if total_locked > 0 {
            let locked_total_u64 = to_u64(total_locked)?;
            // Custody candidates: individual ACCOUNTS holding exactly the
            // locked total (the 74/74 mainnet reconciliation identity).
            let candidates: Vec<&TokenAccountSnapshot> = accounts
                .iter()
                .filter(|a| a.amount as u128 == total_locked)
                .collect();
            let chosen: &TokenAccountSnapshot = match candidates.len() {
                1 => candidates[0],
                0 => {
                    return Err(SnapshotError::CustodyNotFound {
                        locked_total: locked_total_u64,
                    })
                }
                _ => {
                    // Ambiguous — the only escape is an explicit override
                    // that selects exactly one candidate owner.
                    let overrides: BTreeSet<Pubkey> = self
                        .request
                        .custody_owner_overrides
                        .iter()
                        .copied()
                        .collect();
                    let mut via_override: Vec<&TokenAccountSnapshot> = candidates
                        .iter()
                        .copied()
                        .filter(|a| overrides.contains(&a.owner))
                        .collect();
                    if via_override.len() != 1 {
                        return Err(SnapshotError::CustodyAmbiguous {
                            locked_total: locked_total_u64,
                            candidates: candidates.len(),
                        });
                    }
                    via_override.remove(0)
                }
            };
            if attributions.contains_key(&chosen.owner) {
                return Err(SnapshotError::LockOwnerIsCustody {
                    owner: chosen.owner.to_string(),
                });
            }
            // Remove the custody OWNER entirely (a custody PDA holds only
            // locked tokens; if it was sink-excluded above, that is a
            // misconfiguration — locked LP must re-enter via its owners).
            let removed = claimable
                .remove(&chosen.owner)
                .ok_or(SnapshotError::CustodyExcludedAsSink)?;
            debug_assert_eq!(removed, chosen.amount);
            custody = Some(CustodyResolution {
                token_account: chosen.address,
                owner: chosen.owner,
                balance: chosen.amount,
                method: if candidates.len() == 1 {
                    CustodyMatchMethod::ExactBalanceMatch
                } else {
                    CustodyMatchMethod::ExplicitOverride
                },
            });
        }

        // ---- 7. Merge attributions (locked + unlocked per owner) ------------
        // Report list first (BTreeMap iteration is already canonical);
        // the map is consumed by the merge below.
        let attribution_list: Vec<HolderEntry> = attributions
            .iter()
            .map(|(owner, lp_balance)| HolderEntry {
                owner: *owner,
                lp_balance: *lp_balance,
            })
            .collect();
        for (owner, amount) in attributions {
            let entry = claimable.entry(owner).or_insert(0);
            *entry = entry.checked_add(amount).ok_or(SnapshotError::Overflow)?;
        }

        // ---- 8. Leaf set + closing identity ----------------------------------
        let entries: Vec<HolderEntry> = claimable
            .into_iter()
            .map(|(owner, lp_balance)| HolderEntry { owner, lp_balance })
            .collect();
        let mut entries_total: u128 = 0;
        for entry in &entries {
            entries_total = entries_total
                .checked_add(entry.lp_balance as u128)
                .ok_or(SnapshotError::Overflow)?;
        }
        if entries_total + sink_total != enumerated_total {
            return Err(SnapshotError::InvariantViolated(format!(
                "entries ({entries_total}) + sink exclusions ({sink_total}) != enumerated ({enumerated_total})"
            )));
        }

        let locked = LockedReport {
            lock_records_seen: records.len(),
            total_locked: to_u64(total_locked)?,
            attributions: attribution_list,
            custody,
        };
        let reconciliation = Reconciliation {
            enumerated_total: to_u64(enumerated_total)?,
            entries_total: to_u64(entries_total)?,
            sink_exclusions_total: to_u64(sink_total)?,
        };

        LpSnapshot::validate_entries(&entries)?;
        Ok(LpSnapshot {
            pool_address: self.request.pool_address,
            amm_program_id: self.request.amm_program_id,
            lp_mint: self.request.lp_mint,
            // The recorded slot is the anchored initial supply read's
            // actual RPC context slot — never a post-hoc best-effort
            // `getSlot()`, never zero, never fabricated.
            snapshot_slot: anchor_slot,
            lp_total_supply_at_snapshot: supply,
            entries,
            exclusions,
            locked,
            reconciliation,
        })
    }
}

fn to_u64(value: u128) -> Result<u64, SnapshotError> {
    value.try_into().map_err(|_| SnapshotError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locked::{InMemoryLocks, TokenLockRecord};
    use crate::model::TokenAccountSnapshot;
    use crate::sink_ledger::{SinkLedger, SinkLedgerEntry};
    use crate::source::InMemorySource;

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    fn acct(address: u8, owner: u8, amount: u64) -> TokenAccountSnapshot {
        TokenAccountSnapshot {
            address: key(address),
            owner: key(owner),
            amount,
        }
    }

    fn lock(address_seed: u8, global_id: u64, owner: u8, amount: u64) -> TokenLockRecord {
        TokenLockRecord {
            address: key(address_seed),
            lock_global_id: global_id,
            current_locked_amount: amount,
            lock_owner: key(owner),
        }
    }

    fn snapshot_request(lp_mint: Pubkey) -> SnapshotRequest {
        SnapshotRequest {
            pool_address: key(0xAA),
            amm_program_id: key(0xAB),
            lp_mint,
            sink_exclusions: vec![],
            custody_owner_overrides: vec![],
            sink_ledger: None,
        }
    }

    /// A structurally valid governed ledger bound to this test module's
    /// pool identity (pool 0xAA, AMM 0xAB, LP mint as given), carrying the
    /// supplied sink entries. Used wherever a test requires exclusions:
    /// direct declaration without the ledger is rejected (D2-02).
    fn governed_ledger(lp_mint: Pubkey, entries: Vec<SinkLedgerEntry>) -> SinkLedger {
        SinkLedger {
            schema_version: crate::sink_ledger::SINK_LEDGER_SCHEMA_VERSION,
            ledger_id: "GY-SINK-TEST-001".to_string(),
            pool_address: key(0xAA),
            amm_program_id: key(0xAB),
            lp_mint,
            entries,
        }
    }

    fn ledger_entry(
        lp_mint: Pubkey,
        owner: u8,
        token_account: u8,
        balance: u64,
    ) -> SinkLedgerEntry {
        SinkLedgerEntry {
            owner: key(owner),
            token_account: key(token_account),
            lp_mint,
            raw_balance: balance,
            rationale: "incinerator address, funds provably unrecoverable".to_string(),
            evidence_references: vec!["gy-evidence-001".to_string()],
            approval_identities: vec!["owner-identity-1".to_string()],
            independent_reviewer: "reviewer-identity-1".to_string(),
            approved_at: "2026-11-27T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn closing_identity_holds_with_sinks_and_locks() {
        // supply 10_000: holder A 6_000 (unlocked), sink 1_000, custody 3_000
        // locked for B (2_000) and C (1_000).
        let lp_mint = key(0x01);
        let source = InMemorySource::new(
            lp_mint,
            42,
            10_000,
            vec![
                acct(1, 0x10, 6_000),
                acct(2, 0x20, 1_000), // sink
                acct(3, 0x30, 3_000), // custody
            ],
        );
        let locks = InMemoryLocks::from_records(
            &key(0xAA),
            &lp_mint,
            vec![lock(0x51, 1, 0x40, 2_000), lock(0x52, 2, 0x50, 1_000)],
        );
        let mut request = snapshot_request(lp_mint);
        // Exclusions are routed through the governed ledger (D2-02): a
        // direct declaration with no ledger is rejected before any read.
        request.sink_exclusions = vec![key(0x20)];
        request.sink_ledger = Some(governed_ledger(
            lp_mint,
            vec![ledger_entry(lp_mint, 0x20, 0x02, 1_000)],
        ));
        let snapshot = SnapshotBuilder::new(request)
            .build(&source, &locks)
            .unwrap();

        assert_eq!(snapshot.reconciliation.enumerated_total, 10_000);
        assert_eq!(snapshot.reconciliation.sink_exclusions_total, 1_000);
        assert_eq!(snapshot.reconciliation.entries_total, 9_000);
        assert_eq!(snapshot.lp_total_supply_at_snapshot, 10_000);
        assert_eq!(snapshot.snapshot_slot, 42);
        // Leaf set: A 6_000 + B 2_000 + C 1_000, ascending owner bytes.
        assert_eq!(
            snapshot.entries,
            vec![
                HolderEntry {
                    owner: key(0x10),
                    lp_balance: 6_000
                },
                HolderEntry {
                    owner: key(0x40),
                    lp_balance: 2_000
                },
                HolderEntry {
                    owner: key(0x50),
                    lp_balance: 1_000
                },
            ]
        );
        assert_eq!(snapshot.locked.total_locked, 3_000);
        assert_eq!(snapshot.locked.custody.as_ref().unwrap().balance, 3_000);
        assert_eq!(
            snapshot.locked.custody.as_ref().unwrap().method,
            CustodyMatchMethod::ExactBalanceMatch
        );
    }

    #[test]
    fn custody_ambiguity_fails_closed_without_override() {
        let lp_mint = key(0x02);
        // Two accounts both holding exactly the locked total 500.
        let source = InMemorySource::new(
            lp_mint,
            7,
            1_500,
            vec![acct(1, 0x10, 500), acct(2, 0x20, 500), acct(3, 0x30, 500)],
        );
        let locks =
            InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x51, 1, 0x40, 500)]);
        let err = SnapshotBuilder::new(snapshot_request(lp_mint))
            .build(&source, &locks)
            .unwrap_err();
        assert_eq!(
            err,
            SnapshotError::CustodyAmbiguous {
                locked_total: 500,
                candidates: 3
            }
        );
    }

    #[test]
    fn custody_owner_override_resolves_ambiguity() {
        let lp_mint = key(0x03);
        let source = InMemorySource::new(
            lp_mint,
            7,
            1_500,
            vec![acct(1, 0x10, 500), acct(2, 0x20, 500), acct(3, 0x30, 500)],
        );
        let locks =
            InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x51, 1, 0x40, 500)]);
        let mut request = snapshot_request(lp_mint);
        request.custody_owner_overrides = vec![key(0x20)];
        let snapshot = SnapshotBuilder::new(request)
            .build(&source, &locks)
            .unwrap();
        let custody = snapshot.locked.custody.unwrap();
        assert_eq!(custody.owner, key(0x20));
        assert_eq!(custody.method, CustodyMatchMethod::ExplicitOverride);
        // The real holder keeps their balance; only the custody owner's
        // balance was lifted and re-attributed.
        assert_eq!(
            snapshot.entries,
            vec![
                HolderEntry {
                    owner: key(0x10),
                    lp_balance: 500
                },
                HolderEntry {
                    owner: key(0x30),
                    lp_balance: 500
                },
                HolderEntry {
                    owner: key(0x40),
                    lp_balance: 500
                },
            ]
        );
    }

    #[test]
    fn custody_not_found_fails_closed() {
        let lp_mint = key(0x04);
        let source = InMemorySource::new(
            lp_mint,
            7,
            1_000,
            vec![acct(1, 0x10, 400), acct(2, 0x20, 600)],
        );
        let locks =
            InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x51, 1, 0x40, 300)]);
        let err = SnapshotBuilder::new(snapshot_request(lp_mint))
            .build(&source, &locks)
            .unwrap_err();
        assert_eq!(err, SnapshotError::CustodyNotFound { locked_total: 300 });
    }

    #[test]
    fn lock_owner_matching_custody_owner_fails_closed() {
        let lp_mint = key(0x05);
        // The custody account (owner 0x30, balance 700) is ALSO the
        // beneficial owner of the only lock — attributing to a PDA would
        // strand the claim.
        let source = InMemorySource::new(
            lp_mint,
            7,
            1_000,
            vec![acct(1, 0x10, 300), acct(2, 0x30, 700)],
        );
        let locks =
            InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x51, 1, 0x30, 700)]);
        let err = SnapshotBuilder::new(snapshot_request(lp_mint))
            .build(&source, &locks)
            .unwrap_err();
        assert!(matches!(err, SnapshotError::LockOwnerIsCustody { .. }));
    }

    #[test]
    fn custody_marked_as_sink_is_a_misconfiguration() {
        let lp_mint = key(0x06);
        let source = InMemorySource::new(
            lp_mint,
            7,
            1_000,
            vec![acct(1, 0x10, 300), acct(2, 0x30, 700)],
        );
        let locks =
            InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x51, 1, 0x40, 700)]);
        let mut request = snapshot_request(lp_mint);
        // The custody owner is declared a sink via the governed ledger
        // (D2-02: no direct declaration without the ledger).
        request.sink_exclusions = vec![key(0x30)];
        request.sink_ledger = Some(governed_ledger(
            lp_mint,
            vec![ledger_entry(lp_mint, 0x30, 0x02, 700)],
        ));
        let err = SnapshotBuilder::new(request)
            .build(&source, &locks)
            .unwrap_err();
        assert_eq!(err, SnapshotError::CustodyExcludedAsSink);
    }

    #[test]
    fn supply_mismatch_fails_closed() {
        let lp_mint = key(0x07);
        let source = InMemorySource::new(
            lp_mint,
            7,
            9_999, // wrong: accounts sum to 1_000
            vec![acct(1, 0x10, 400), acct(2, 0x20, 600)],
        );
        let locks = InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![]);
        let err = SnapshotBuilder::new(snapshot_request(lp_mint))
            .build(&source, &locks)
            .unwrap_err();
        assert_eq!(
            err,
            SnapshotError::SupplyMismatch {
                mint_supply: 9_999,
                enumerated_total: 1_000
            }
        );
    }

    #[test]
    fn zero_supply_yields_empty_snapshot_error() {
        let lp_mint = key(0x08);
        let source = InMemorySource::new(lp_mint, 7, 0, vec![]);
        let locks = InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![]);
        let err = SnapshotBuilder::new(snapshot_request(lp_mint))
            .build(&source, &locks)
            .unwrap_err();
        assert_eq!(err, SnapshotError::EmptySnapshot);
    }

    #[test]
    fn lock_owner_also_holding_unlocked_lp_is_merged_into_one_entry() {
        let lp_mint = key(0x09);
        // Owner 0x10 holds 5_000 unlocked AND 2_000 locked (via custody 0x30).
        let source = InMemorySource::new(
            lp_mint,
            7,
            10_000,
            vec![
                acct(1, 0x10, 5_000),
                acct(2, 0x20, 3_000),
                acct(3, 0x30, 2_000), // custody
            ],
        );
        let locks =
            InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x51, 1, 0x10, 2_000)]);
        let snapshot = SnapshotBuilder::new(snapshot_request(lp_mint))
            .build(&source, &locks)
            .unwrap();
        assert_eq!(
            snapshot.entries,
            vec![
                HolderEntry {
                    owner: key(0x10),
                    lp_balance: 7_000
                },
                HolderEntry {
                    owner: key(0x20),
                    lp_balance: 3_000
                },
            ]
        );
    }

    /// D2-02 negative: a request that declares sink exclusions directly
    /// with NO governed ledger is rejected before any state is read — the
    /// library-level bypass is closed, deterministically.
    #[test]
    fn direct_sink_exclusions_without_a_ledger_are_rejected() {
        let lp_mint = key(0x0a);
        let source = InMemorySource::new(
            lp_mint,
            7,
            1_000,
            vec![acct(1, 0x10, 500), acct(2, 0x20, 500)],
        );
        let locks = InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![]);
        let mut request = snapshot_request(lp_mint);
        request.sink_exclusions = vec![key(0x20)];
        let err = SnapshotBuilder::new(request)
            .build(&source, &locks)
            .unwrap_err();
        assert_eq!(
            err,
            SnapshotError::SinkExclusionsRequireLedger { declared: 1 }
        );
    }

    /// D2-02 negative: attempted exclusions with an absent ledger fail
    /// closed identically regardless of the declared set's size — no
    /// exclusion ever applies ungoverned.
    #[test]
    fn absent_ledger_with_attempted_exclusions_is_rejected() {
        let lp_mint = key(0x0b);
        let source = InMemorySource::new(
            lp_mint,
            7,
            1_000,
            vec![acct(1, 0x10, 500), acct(2, 0x20, 500)],
        );
        let locks = InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![]);
        let mut request = snapshot_request(lp_mint);
        request.sink_exclusions = vec![key(0x10), key(0x20)];
        let err = SnapshotBuilder::new(request)
            .build(&source, &locks)
            .unwrap_err();
        assert_eq!(
            err,
            SnapshotError::SinkExclusionsRequireLedger { declared: 2 }
        );
    }

    /// D2-02 negative: the gate fires BEFORE any source read and before
    /// ledger reconciliation — even a sink owner that never enumerates is
    /// rejected with the bypass error, not a reconciliation error.
    #[test]
    fn exclusion_gate_fires_before_any_state_read() {
        let lp_mint = key(0x0c);
        let source = InMemorySource::new(lp_mint, 7, 1_000, vec![acct(1, 0x10, 1_000)]);
        let locks = InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![]);
        let mut request = snapshot_request(lp_mint);
        request.sink_exclusions = vec![key(0x99)]; // never enumerated
        let err = SnapshotBuilder::new(request)
            .build(&source, &locks)
            .unwrap_err();
        assert!(matches!(
            err,
            SnapshotError::SinkExclusionsRequireLedger { .. }
        ));
    }
}

/// Consistent-state acceptance tests (WD-02 fix). A scripted source with
/// full control over every read exercises the pinned protocol
/// deterministically, without a network.
#[cfg(test)]
mod consistent_state_tests {
    use super::*;
    use crate::locked::InMemoryLocks;
    use crate::model::{MintSupply, TokenAccountSnapshot};

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    fn acct(address: u8, owner: u8, amount: u64) -> TokenAccountSnapshot {
        TokenAccountSnapshot {
            address: key(address),
            owner: key(owner),
            amount,
        }
    }

    fn request(lp_mint: Pubkey) -> SnapshotRequest {
        SnapshotRequest {
            pool_address: key(0xAA),
            amm_program_id: key(0xAB),
            lp_mint,
            sink_exclusions: vec![],
            custody_owner_overrides: vec![],
            sink_ledger: None,
        }
    }

    /// A scripted source: every read is served from a configurable state
    /// and every `min_context_slot` the builder pins is recorded for
    /// assertions. Deterministic stand-in for the RPC source.
    struct ScriptedSource {
        lp_mint: Pubkey,
        initial: MintSupply,
        accounts: Result<Vec<TokenAccountSnapshot>, SnapshotError>,
        final_read: Result<MintSupply, SnapshotError>,
        observed_enumeration_pins: std::cell::RefCell<Vec<u64>>,
        observed_final_pins: std::cell::RefCell<Vec<u64>>,
    }

    impl ScriptedSource {
        /// One coherent state: all three reads serve the same slot/supply.
        fn consistent(
            lp_mint: Pubkey,
            slot: u64,
            supply: u64,
            accounts: Vec<TokenAccountSnapshot>,
        ) -> Self {
            Self {
                lp_mint,
                initial: MintSupply {
                    amount: supply,
                    slot,
                },
                accounts: Ok(accounts),
                final_read: Ok(MintSupply {
                    amount: supply,
                    slot,
                }),
                observed_enumeration_pins: std::cell::RefCell::new(Vec::new()),
                observed_final_pins: std::cell::RefCell::new(Vec::new()),
            }
        }
    }

    impl LpAccountSource for ScriptedSource {
        fn initial_supply(&self, lp_mint: &Pubkey) -> Result<MintSupply, SnapshotError> {
            if lp_mint != &self.lp_mint {
                return Err(SnapshotError::Source("mint mismatch".to_string()));
            }
            Ok(self.initial)
        }

        fn token_accounts(
            &self,
            lp_mint: &Pubkey,
            min_context_slot: u64,
        ) -> Result<Vec<TokenAccountSnapshot>, SnapshotError> {
            if lp_mint != &self.lp_mint {
                return Err(SnapshotError::Source("mint mismatch".to_string()));
            }
            self.observed_enumeration_pins
                .borrow_mut()
                .push(min_context_slot);
            self.accounts.clone()
        }

        fn final_supply(
            &self,
            lp_mint: &Pubkey,
            min_context_slot: u64,
        ) -> Result<MintSupply, SnapshotError> {
            if lp_mint != &self.lp_mint {
                return Err(SnapshotError::Source("mint mismatch".to_string()));
            }
            self.observed_final_pins.borrow_mut().push(min_context_slot);
            self.final_read.clone()
        }
    }

    fn no_locks(lp_mint: &Pubkey) -> InMemoryLocks {
        InMemoryLocks::from_records(&key(0xAA), lp_mint, vec![])
    }

    /// Acceptance 1+2: the enumeration and the final supply re-read are
    /// both pinned to the initial supply read's context slot. (The RPC
    /// wire shapes for commitment + minContextSlot are pinned in rpc.rs.)
    #[test]
    fn enumeration_and_final_read_are_pinned_to_the_anchor_slot() {
        let lp_mint = key(0x01);
        let source = ScriptedSource::consistent(
            lp_mint,
            123,
            1_000,
            vec![acct(1, 0x10, 600), acct(2, 0x20, 400)],
        );
        let snapshot = SnapshotBuilder::new(request(lp_mint))
            .build(&source, &no_locks(&lp_mint))
            .unwrap();
        assert_eq!(
            *source.observed_enumeration_pins.borrow(),
            vec![123],
            "enumeration must receive the anchor slot as min_context_slot"
        );
        assert_eq!(
            *source.observed_final_pins.borrow(),
            vec![123],
            "final supply re-read must receive the same anchor slot"
        );
        assert_eq!(snapshot.snapshot_slot, 123);
    }

    /// Acceptance 3: a holder transfer between the reads that changes the
    /// total supply is rejected — the re-read no longer matches the anchor.
    #[test]
    fn supply_drift_between_reads_is_rejected() {
        let lp_mint = key(0x02);
        let mut source = ScriptedSource::consistent(
            lp_mint,
            100,
            10_000,
            vec![acct(1, 0x10, 6_000), acct(2, 0x20, 4_000)],
        );
        // A mint burned/minted between the reads: supply moved, accounts
        // still sum to the INITIAL supply.
        source.final_read = Ok(MintSupply {
            amount: 10_500,
            slot: 105,
        });
        let err = SnapshotBuilder::new(request(lp_mint))
            .build(&source, &no_locks(&lp_mint))
            .unwrap_err();
        assert_eq!(
            err,
            SnapshotError::SupplyDrift {
                anchor_slot: 100,
                initial_supply: 10_000,
                final_supply: 10_500,
            }
        );
    }

    /// Acceptance 4: a same-total holder transfer between the anchor and
    /// the enumeration is NOT detected by the supply equality check — and
    /// the implementation must not claim otherwise. The snapshot proceeds
    /// with the enumeration's per-holder attribution (which is bounded
    /// below by the anchor slot) and records the ANCHOR slot. Holder-level
    /// revalidation is the separate D-06 P2 control, out of scope here.
    #[test]
    fn same_total_holder_transfer_is_not_detectable_by_supply_equality() {
        let lp_mint = key(0x03);
        let mut source = ScriptedSource::consistent(
            lp_mint,
            100,
            10_000,
            // Enumeration served at a state NEWER than the anchor where a
            // same-total transfer (A -> B) has already moved balances.
            vec![acct(1, 0x10, 5_000), acct(2, 0x20, 5_000)],
        );
        // Same total at a later slot: equality holds, nothing is caught.
        source.final_read = Ok(MintSupply {
            amount: 10_000,
            slot: 110,
        });
        let snapshot = SnapshotBuilder::new(request(lp_mint))
            .build(&source, &no_locks(&lp_mint))
            .expect("the builder cannot and must not reject a same-total transfer");
        // The recorded state anchor is still the initial read's slot.
        assert_eq!(snapshot.snapshot_slot, 100);
        assert_eq!(snapshot.lp_total_supply_at_snapshot, 10_000);
        // Attribution reflects the enumeration as served — the honest
        // statement of what D1 guarantees (and what it does not).
        assert_eq!(
            snapshot.entries,
            vec![
                HolderEntry {
                    owner: key(0x10),
                    lp_balance: 5_000
                },
                HolderEntry {
                    owner: key(0x20),
                    lp_balance: 5_000
                },
            ]
        );
    }

    /// Acceptance 5: a stale or insufficient RPC context is rejected —
    /// both when the enumeration cannot reach the anchor and when the
    /// final re-read serves an older slot.
    #[test]
    fn stale_contexts_are_rejected() {
        let lp_mint = key(0x04);
        // Enumeration that cannot establish the pinned state (the RPC
        // source surfaces this as an error; the builder must abort).
        let mut source = ScriptedSource::consistent(
            lp_mint,
            100,
            1_000,
            vec![acct(1, 0x10, 600), acct(2, 0x20, 400)],
        );
        source.accounts = Err(SnapshotError::StaleState {
            anchor_slot: 100,
            served_slot: 90,
        });
        let err = SnapshotBuilder::new(request(lp_mint))
            .build(&source, &no_locks(&lp_mint))
            .unwrap_err();
        assert!(
            matches!(err, SnapshotError::StaleState { .. }),
            "a stale enumeration context must abort the snapshot"
        );

        // Final re-read served from a state OLDER than the anchor.
        let mut source = ScriptedSource::consistent(
            lp_mint,
            100,
            1_000,
            vec![acct(1, 0x10, 600), acct(2, 0x20, 400)],
        );
        source.final_read = Ok(MintSupply {
            amount: 1_000,
            slot: 90,
        });
        let err = SnapshotBuilder::new(request(lp_mint))
            .build(&source, &no_locks(&lp_mint))
            .unwrap_err();
        assert_eq!(
            err,
            SnapshotError::StaleState {
                anchor_slot: 100,
                served_slot: 90,
            }
        );
    }

    /// Acceptance 6: missing context metadata (slot 0) fails closed on
    /// both the initial and the final read — no slot is fabricated.
    #[test]
    fn missing_context_metadata_fails_closed() {
        let lp_mint = key(0x05);
        // Initial read without a usable context slot.
        let source = ScriptedSource::consistent(
            lp_mint,
            0,
            1_000,
            vec![acct(1, 0x10, 600), acct(2, 0x20, 400)],
        );
        let err = SnapshotBuilder::new(request(lp_mint))
            .build(&source, &no_locks(&lp_mint))
            .unwrap_err();
        assert_eq!(err, SnapshotError::MissingStateContext);

        // Final read without a usable context slot.
        let mut source = ScriptedSource::consistent(
            lp_mint,
            100,
            1_000,
            vec![acct(1, 0x10, 600), acct(2, 0x20, 400)],
        );
        source.final_read = Ok(MintSupply {
            amount: 1_000,
            slot: 0,
        });
        let err = SnapshotBuilder::new(request(lp_mint))
            .build(&source, &no_locks(&lp_mint))
            .unwrap_err();
        assert_eq!(err, SnapshotError::MissingStateContext);
    }

    /// Acceptance 7: snapshot metadata records the ACTUAL anchored context
    /// slot from the supply read — not a later slot served by the final
    /// re-read, not a post-hoc `getSlot()`.
    #[test]
    fn metadata_records_the_anchored_context_slot() {
        let lp_mint = key(0x06);
        let mut source = ScriptedSource::consistent(
            lp_mint,
            123,
            1_000,
            vec![acct(1, 0x10, 600), acct(2, 0x20, 400)],
        );
        // The final re-read observes a LATER slot; the anchor must not move.
        source.final_read = Ok(MintSupply {
            amount: 1_000,
            slot: 200,
        });
        let snapshot = SnapshotBuilder::new(request(lp_mint))
            .build(&source, &no_locks(&lp_mint))
            .unwrap();
        assert_eq!(snapshot.snapshot_slot, 123);
        assert_eq!(snapshot.lp_total_supply_at_snapshot, 1_000);
    }
}

/// Governed sink-ledger + lock-evidence acceptance tests (WD-07 / D-04-C+D).
#[cfg(test)]
mod governed_input_tests {
    use super::*;
    use crate::locked::{InMemoryLocks, LockedLpEvidence, TokenLockRecord};
    use crate::model::TokenAccountSnapshot;
    use crate::sink_ledger::{SinkLedger, SinkLedgerEntry};
    use crate::source::InMemorySource;

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    fn acct(address: u8, owner: u8, amount: u64) -> TokenAccountSnapshot {
        TokenAccountSnapshot {
            address: key(address),
            owner: key(owner),
            amount,
        }
    }

    fn lock(address_seed: u8, global_id: u64, owner: u8, amount: u64) -> TokenLockRecord {
        TokenLockRecord {
            address: key(address_seed),
            lock_global_id: global_id,
            current_locked_amount: amount,
            lock_owner: key(owner),
        }
    }

    fn entry(owner_seed: u8, token_seed: u8, balance: u64) -> SinkLedgerEntry {
        SinkLedgerEntry {
            owner: key(owner_seed),
            token_account: key(token_seed),
            lp_mint: key(0x01),
            raw_balance: balance,
            rationale: "incinerator address, funds provably unrecoverable".to_string(),
            evidence_references: vec!["gy-evidence-001".to_string()],
            approval_identities: vec!["owner-identity-1".to_string()],
            independent_reviewer: "reviewer-identity-1".to_string(),
            approved_at: "2026-11-27T00:00:00Z".to_string(),
        }
    }

    fn ledger(entries: Vec<SinkLedgerEntry>) -> SinkLedger {
        SinkLedger {
            schema_version: crate::sink_ledger::SINK_LEDGER_SCHEMA_VERSION,
            ledger_id: "GY-SINK-TEST-001".to_string(),
            pool_address: key(0xAA),
            amm_program_id: key(0xAB),
            lp_mint: key(0x01),
            entries,
        }
    }

    fn request(lp_mint: Pubkey, ledger: Option<SinkLedger>, sinks: Vec<Pubkey>) -> SnapshotRequest {
        SnapshotRequest {
            pool_address: key(0xAA),
            amm_program_id: key(0xAB),
            lp_mint,
            sink_exclusions: sinks,
            custody_owner_overrides: vec![],
            sink_ledger: ledger,
        }
    }

    /// Pool shape: holder 0x10 (4_000), sink 0x20 via token account 0x21
    /// (1_000), custody 0x30 (2_000) locked for 0x40. Supply 7_000.
    fn source() -> InMemorySource {
        InMemorySource::new(
            key(0x01),
            123,
            7_000,
            vec![
                acct(0x10, 0x10, 4_000),
                acct(0x21, 0x20, 1_000),
                acct(0x30, 0x30, 2_000),
            ],
        )
    }

    fn locks_for(lp_mint: &Pubkey) -> InMemoryLocks {
        InMemoryLocks::from_records(&key(0xAA), lp_mint, vec![lock(0x71, 1, 0x40, 2_000)])
    }

    /// Acceptance: a valid governed ledger is accepted and its exclusions
    /// reconcile exactly with the enumerated balances and supply. The
    /// ledger here is constructed DIRECTLY in memory (never passed
    /// through `SinkLedger::parse`) — a structurally valid in-memory
    /// ledger still builds.
    #[test]
    fn valid_governed_ledger_is_accepted_and_reconciles() {
        let lp_mint = key(0x01);
        let sink_ledger = Some(ledger(vec![entry(0x20, 0x21, 1_000)]));
        let snapshot = SnapshotBuilder::new(request(lp_mint, sink_ledger, vec![key(0x20)]))
            .build(&source(), &locks_for(&lp_mint))
            .unwrap();
        assert_eq!(snapshot.reconciliation.enumerated_total, 7_000);
        assert_eq!(snapshot.reconciliation.sink_exclusions_total, 1_000);
        assert_eq!(snapshot.reconciliation.entries_total, 6_000);
        assert_eq!(
            snapshot.exclusions,
            vec![ExcludedBalance {
                owner: key(0x20),
                lp_balance: 1_000,
                reason: ExclusionReason::ExplicitSink,
            }]
        );
        // The sink never reaches the leaf set; the locked LP is attributed.
        assert!(!snapshot.entries.iter().any(|e| e.owner == key(0x20)));
        assert_eq!(snapshot.locked.total_locked, 2_000);
        assert_eq!(
            snapshot.entries,
            vec![
                HolderEntry {
                    owner: key(0x10),
                    lp_balance: 4_000
                },
                HolderEntry {
                    owner: key(0x40),
                    lp_balance: 2_000
                },
            ]
        );
    }

    /// DIRECT-CONSTRUCTION BYPASS (correction): `SinkLedger`'s fields are
    /// public, so a caller can construct the type in memory and skip
    /// `SinkLedger::parse` entirely. The builder re-runs the same
    /// authoritative validation BEFORE using the ledger — every shape
    /// `parse` rejects is rejected here too, deterministically.
    #[test]
    fn directly_constructed_invalid_ledgers_are_rejected_at_build() {
        let lp_mint = key(0x01);
        // Unsupported schema version (fail-closed on unknown formats).
        let mut bad = ledger(vec![entry(0x20, 0x21, 1_000)]);
        bad.schema_version = 99;
        assert_eq!(
            SnapshotBuilder::new(request(lp_mint, Some(bad), vec![key(0x20)]))
                .build(&source(), &locks_for(&lp_mint))
                .unwrap_err(),
            SnapshotError::SinkLedgerUnsupportedVersion {
                found: 99,
                expected: crate::sink_ledger::SINK_LEDGER_SCHEMA_VERSION,
            }
        );
        // Missing ledger identity.
        let mut bad = ledger(vec![entry(0x20, 0x21, 1_000)]);
        bad.ledger_id = "   ".to_string();
        assert!(matches!(
            SnapshotBuilder::new(request(lp_mint, Some(bad), vec![key(0x20)]))
                .build(&source(), &locks_for(&lp_mint)),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
        // Same owner declared twice (conflicting sink declarations).
        let dup = ledger(vec![entry(0x20, 0x21, 1_000), entry(0x20, 0x22, 1_000)]);
        assert!(matches!(
            SnapshotBuilder::new(request(lp_mint, Some(dup), vec![key(0x20)]))
                .build(&source(), &locks_for(&lp_mint)),
            Err(SnapshotError::SinkLedgerDuplicateEntry(_))
        ));
        // Same token account under two owners.
        let dup_acct = ledger(vec![entry(0x20, 0x21, 1_000), entry(0x30, 0x21, 1_000)]);
        assert!(matches!(
            SnapshotBuilder::new(request(lp_mint, Some(dup_acct), vec![key(0x20)]))
                .build(&source(), &locks_for(&lp_mint)),
            Err(SnapshotError::SinkLedgerDuplicateEntry(_))
        ));
        // Zero-balance sink declaration.
        let zero = ledger(vec![entry(0x20, 0x21, 0)]);
        assert!(matches!(
            SnapshotBuilder::new(request(lp_mint, Some(zero), vec![key(0x20)]))
                .build(&source(), &locks_for(&lp_mint)),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
        // Empty rationale (D-04-D).
        let mut bad = ledger(vec![entry(0x20, 0x21, 1_000)]);
        bad.entries[0].rationale = "  ".to_string();
        assert!(matches!(
            SnapshotBuilder::new(request(lp_mint, Some(bad), vec![key(0x20)]))
                .build(&source(), &locks_for(&lp_mint)),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
        // Missing evidence references (D-04-D).
        let mut bad = ledger(vec![entry(0x20, 0x21, 1_000)]);
        bad.entries[0].evidence_references = vec![];
        assert!(matches!(
            SnapshotBuilder::new(request(lp_mint, Some(bad), vec![key(0x20)]))
                .build(&source(), &locks_for(&lp_mint)),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
        // Missing approval identities (D-04-D).
        let mut bad = ledger(vec![entry(0x20, 0x21, 1_000)]);
        bad.entries[0].approval_identities = vec![];
        assert!(matches!(
            SnapshotBuilder::new(request(lp_mint, Some(bad), vec![key(0x20)]))
                .build(&source(), &locks_for(&lp_mint)),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
        // Token account equal to the owner (not a distinct account).
        let self_account = ledger(vec![entry(0x20, 0x20, 1_000)]);
        assert!(matches!(
            SnapshotBuilder::new(request(lp_mint, Some(self_account), vec![key(0x20)]))
                .build(&source(), &locks_for(&lp_mint)),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
        // Entry mint disagreeing with the ledger's mint.
        let mut bad = ledger(vec![entry(0x20, 0x21, 1_000)]);
        bad.entries[0].lp_mint = key(0x02);
        assert!(matches!(
            SnapshotBuilder::new(request(lp_mint, Some(bad), vec![key(0x20)]))
                .build(&source(), &locks_for(&lp_mint)),
            Err(SnapshotError::SinkLedgerIdentityMismatch(_))
        ));
    }

    /// DIRECT CONSTRUCTION, positive case: a structurally VALID in-memory
    /// ledger (never passed through `parse`) still builds — the shared
    /// validation accepts well-formed ledgers from either entry path.
    #[test]
    fn directly_constructed_valid_ledger_still_builds() {
        let lp_mint = key(0x01);
        let ledger = ledger(vec![entry(0x20, 0x21, 1_000)]);
        ledger
            .validate()
            .expect("the in-memory ledger satisfies the authoritative validation");
        let snapshot = SnapshotBuilder::new(request(lp_mint, Some(ledger), vec![key(0x20)]))
            .build(&source(), &locks_for(&lp_mint))
            .expect("a valid directly constructed ledger builds");
        assert_eq!(snapshot.reconciliation.sink_exclusions_total, 1_000);
    }

    /// A governed ledger scoped to another pool / AMM / mint is rejected.
    #[test]
    fn foreign_pool_amm_or_mint_ledger_is_rejected_at_build() {
        let lp_mint = key(0x01);
        let mut foreign = ledger(vec![entry(0x20, 0x21, 1_000)]);
        foreign.pool_address = key(0xBB);
        let err = SnapshotBuilder::new(request(lp_mint, Some(foreign), vec![key(0x20)]))
            .build(&source(), &locks_for(&lp_mint))
            .unwrap_err();
        assert!(matches!(err, SnapshotError::SinkLedgerIdentityMismatch(_)));

        let mut foreign_mint = ledger(vec![entry(0x20, 0x21, 1_000)]);
        foreign_mint.lp_mint = key(0x02);
        let err = SnapshotBuilder::new(request(lp_mint, Some(foreign_mint), vec![key(0x20)]))
            .build(&source(), &locks_for(&lp_mint))
            .unwrap_err();
        assert!(matches!(err, SnapshotError::SinkLedgerIdentityMismatch(_)));
    }

    /// Acceptance: ledger balances that disagree with the enumeration are
    /// rejected (reconciliation is enforced, not assumed).
    #[test]
    fn ledger_balance_mismatch_is_rejected() {
        let lp_mint = key(0x01);
        let mismatched = Some(ledger(vec![entry(0x20, 0x21, 900)])); // enumerated: 1_000
        let err = SnapshotBuilder::new(request(lp_mint, mismatched, vec![key(0x20)]))
            .build(&source(), &locks_for(&lp_mint))
            .unwrap_err();
        assert_eq!(
            err,
            SnapshotError::SinkLedgerBalanceMismatch {
                owner: key(0x20).to_string(),
                ledger_balance: 900,
                enumerated_balance: 1_000,
            }
        );
    }

    /// An owner not present in the enumeration is rejected.
    #[test]
    fn ledger_owner_not_enumerated_is_rejected() {
        let lp_mint = key(0x01);
        let ghost = Some(ledger(vec![entry(0x90, 0x91, 1_000)]));
        let err = SnapshotBuilder::new(request(lp_mint, ghost, vec![key(0x90)]))
            .build(&source(), &locks_for(&lp_mint))
            .unwrap_err();
        assert_eq!(
            err,
            SnapshotError::SinkLedgerEntryNotEnumerated {
                owner: key(0x90).to_string(),
            }
        );
    }

    /// The declared token account must exist under the entry's owner
    /// carrying the full declared balance — a spread balance is ambiguous
    /// and rejected.
    #[test]
    fn ledger_token_account_mismatch_is_rejected() {
        let lp_mint = key(0x01);
        // Ledger claims the balance sits in token account 0x22 — which is
        // not the enumerated account of the sink owner.
        let wrong_account = Some(ledger(vec![entry(0x20, 0x22, 1_000)]));
        let err = SnapshotBuilder::new(request(lp_mint, wrong_account, vec![key(0x20)]))
            .build(&source(), &locks_for(&lp_mint))
            .unwrap_err();
        assert_eq!(
            err,
            SnapshotError::SinkLedgerTokenAccountMismatch {
                owner: key(0x20).to_string(),
                token_account: key(0x22).to_string(),
            }
        );

        // A sink owner whose balance is spread across two accounts is
        // ambiguous under the exact-account contract and rejected.
        let spread = InMemorySource::new(
            lp_mint,
            123,
            7_000,
            vec![
                acct(0x10, 0x10, 4_000),
                acct(0x21, 0x20, 500),
                acct(0x22, 0x20, 500),
                acct(0x30, 0x30, 2_000),
            ],
        );
        let half_and_half = Some(ledger(vec![entry(0x20, 0x21, 1_000)]));
        let err = SnapshotBuilder::new(request(lp_mint, half_and_half, vec![key(0x20)]))
            .build(&spread, &locks_for(&lp_mint))
            .unwrap_err();
        assert_eq!(
            err,
            SnapshotError::SinkLedgerTokenAccountMismatch {
                owner: key(0x20).to_string(),
                token_account: key(0x21).to_string(),
            }
        );
    }

    /// The request's sink_exclusions must mirror the governed ledger
    /// exactly — a ledger plus extra operator sinks is an ambiguous
    /// configuration.
    #[test]
    fn ledger_and_declared_sinks_must_agree() {
        let lp_mint = key(0x01);
        // Ledger says one sink; request declares two.
        let err = SnapshotBuilder::new(request(
            lp_mint,
            Some(ledger(vec![entry(0x20, 0x21, 1_000)])),
            vec![key(0x20), key(0x10)],
        ))
        .build(&source(), &locks_for(&lp_mint))
        .unwrap_err();
        assert!(matches!(err, SnapshotError::SinkLedgerConflict(_)));
    }

    /// An explicit empty governed ledger is valid and applies no
    /// exclusions (this is an APPROVED empty ledger, distinct from a
    /// missing ledger).
    #[test]
    fn explicit_empty_ledger_is_valid_and_applies_nothing() {
        let lp_mint = key(0x01);
        let snapshot = SnapshotBuilder::new(request(lp_mint, Some(ledger(vec![])), vec![]))
            .build(&source(), &locks_for(&lp_mint))
            .unwrap();
        assert_eq!(snapshot.reconciliation.sink_exclusions_total, 0);
        assert!(snapshot
            .exclusions
            .iter()
            .all(|e| e.reason == ExclusionReason::ZeroBalance));
    }

    /// WD-07 REGRESSION, lib level: with an EMPTY lock list supplied where
    /// real locks exist, the custody-PDA owner silently becomes an
    /// ordinary claimable leaf. This is exactly the failure the CLI now
    /// prevents by requiring `--lock-evidence rpc` — the test documents
    /// the failure mode so the CLI requirement cannot be silently relaxed.
    #[test]
    fn empty_lock_list_reduces_the_custody_owner_to_an_ordinary_leaf() {
        let lp_mint = key(0x01);
        let empty_locks = InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![]);
        let snapshot = SnapshotBuilder::new(request(lp_mint, None, vec![]))
            .build(&source(), &empty_locks)
            .unwrap();
        // The custody owner 0x30 — which can never sign a claim — now
        // holds an ordinary 2_000 leaf. No error, no attribution.
        assert!(snapshot
            .entries
            .iter()
            .any(|e| e.owner == key(0x30) && e.lp_balance == 2_000));
        assert_eq!(snapshot.locked.total_locked, 0);
        assert!(snapshot.locked.custody.is_none());
    }

    /// With real evidence the same pool attributes correctly (contrast to
    /// the empty-list regression above).
    #[test]
    fn real_lock_evidence_attributes_the_custody_balance() {
        let lp_mint = key(0x01);
        let snapshot = SnapshotBuilder::new(request(lp_mint, None, vec![]))
            .build(&source(), &locks_for(&lp_mint))
            .unwrap();
        assert!(!snapshot.entries.iter().any(|e| e.owner == key(0x30)));
        assert_eq!(snapshot.locked.total_locked, 2_000);
        assert!(snapshot
            .entries
            .iter()
            .any(|e| e.owner == key(0x40) && e.lp_balance == 2_000));
    }

    /// Acceptance: missing/failed locker evidence fails closed — a source
    /// error aborts the snapshot instead of degrading to an empty list.
    #[test]
    fn unavailable_lock_evidence_fails_closed() {
        struct UnavailableLocks;
        impl LockedLpEvidence for UnavailableLocks {
            fn token_locks(
                &self,
                _amm_id: &Pubkey,
                _lp_mint: &Pubkey,
                _min_context_slot: u64,
            ) -> Result<Vec<TokenLockRecord>, SnapshotError> {
                Err(SnapshotError::Source(
                    "UNCX getProgramAccounts failed: node unreachable".to_string(),
                ))
            }
        }
        let lp_mint = key(0x01);
        let err = SnapshotBuilder::new(request(lp_mint, None, vec![]))
            .build(&source(), &UnavailableLocks)
            .unwrap_err();
        assert!(matches!(err, SnapshotError::Source(_)));
    }
}
