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
    pub sink_exclusions: Vec<Pubkey>,
    /// Escape hatch for custody disambiguation: if several enumerated
    /// accounts hold exactly the locked total, exactly one of them must
    /// have its owner listed here, or the snapshot aborts
    /// (`CustodyAmbiguous`).
    pub custody_owner_overrides: Vec<Pubkey>,
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

        // ---- 5. Exclusion pass (ascending owner bytes) ----------------------
        let sinks: BTreeSet<Pubkey> = self.request.sink_exclusions.iter().copied().collect();
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
        request.sink_exclusions = vec![key(0x20)];
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
        request.sink_exclusions = vec![key(0x30)]; // custody declared sink
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
