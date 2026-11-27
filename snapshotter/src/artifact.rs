// SPDX-License-Identifier: Apache-2.0
//
// The sealed snapshot artifact (Phase 5.2 persistence layer).
//
// `SnapshotBuilder` produces the canonical leaf set; `SnapshotMerkleTree`
// seals it into a root. This module persists the result as the artifact a
// claims service publishes and LP holders consume: pool/mint/slot/supply
// metadata, the Merkle root, and — per holder — the owner, balance, leaf,
// and sorted-pair proof ready for `claim_lp_proceeds`'s
// `merkle_proof: Vec<[u8; 32]>` parameter.
//
// FORMAT v2 (WD-07)
//
// v1 carried only the reconciliation totals. A reviewer of a v1 artifact
// could verify the conservation identity but could not see WHICH balances
// were excluded or how locked LP was attributed, and nothing bound the
// exclusions to a governed ledger or the locked-LP treatment to real
// locker evidence. v2 adds, without changing Merkle semantics:
//
//   * `exclusions` — the per-owner exclusion ledger (reason + balance);
//   * `locked` — the locked-LP report (records seen, total, per-owner
//     attributions, the resolved custody account);
//   * `provenance` — the governed sink ledger's identity/version/exact
//     input digest and the lock-evidence source/context, sealing WHICH
//     governed inputs produced the artifact.
//
// Version handling is explicit: `verify_integrity` refuses any other
// format_version (a v1 artifact fails with an explicit mismatch, it is
// never silently reinterpreted under v2 semantics). The root, leaves,
// proofs, and reconciliation identity are byte-identical to v1 for the
// same snapshot — only additive fields changed.
//
// DETERMINISTIC SERIALIZATION (roadmap 5.2: "persist snapshot metadata" +
// "verify root determinism")
//
// The artifact's JSON is a pure function of its data: structs serialize
// fields in declaration order, entries are the snapshot's canonical
// ascending-owner order, proofs are tree order, hashes are lowercase hex,
// pubkeys are canonical base58, and no map with iteration-order freedom
// appears anywhere. Sealing the same snapshot twice therefore yields
// byte-identical JSON, and a third party can recompute the artifact
// bit-for-bit from the same snapshot (spec D12). Readers get the mirror
// check: `verify_integrity` rebuilds the tree from the persisted entries
// and fails closed unless every leaf, every proof, the root, the depth,
// the count, the closing reconciliation identity, the exclusion ledger,
// the locked-LP report, and the provenance cross-checks all re-derive
// exactly.
//
// TRUST BOUNDARY (spec §6.3)
//
// The artifact is the published claim of an honest snapshot; the on-chain
// verifier remains the final gate (`verify_proof` + the supply pin at
// salvage). What this module adds is auditability: any published artifact
// can be checked against its own entries without re-running an RPC
// enumeration, and any Drift between the two is loud. The sealed
// provenance identifies the governed inputs; it does NOT prove owner
// approval of a sink ledger — a valid schema is not an approval
// (`sink_ledger.rs`).

use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;

use crate::error::SnapshotError;
use crate::model::{CustodyMatchMethod, ExclusionReason, HolderEntry, LpSnapshot, Reconciliation};
use crate::tree::SnapshotMerkleTree;

/// Current artifact format version. Bumped on any breaking layout change;
/// `verify_integrity` refuses other versions (fail-closed on a format it
/// cannot fully re-derive). v2 = v1 + exclusions + locked report +
/// provenance (additive; Merkle semantics unchanged).
pub const ARTIFACT_FORMAT_VERSION: u32 = 2;

/// One claimant in the published artifact: the holder, its balance, its
/// leaf hash, and its ready-to-submit Merkle proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactEntry {
    #[serde(with = "base58_pubkey")]
    pub owner: Pubkey,
    pub lp_balance: u64,
    /// SHA256(pubkey || balance_le) — `grave_vault::merkle::compute_leaf`
    /// format (hex-encoded in JSON).
    #[serde(with = "hex32")]
    pub leaf: [u8; 32],
    /// Sorted-pair siblings, leaf→root order, ready for
    /// `claim_lp_proceeds` (hex-encoded in JSON). Promotion levels
    /// contribute no element (see `tree.rs`).
    #[serde(with = "vec_hex32")]
    pub proof: Vec<[u8; 32]>,
}

/// One excluded balance in the published exclusion ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactExclusion {
    #[serde(with = "base58_pubkey")]
    pub owner: Pubkey,
    pub lp_balance: u64,
    /// `"zero_balance"` or `"explicit_sink"`.
    pub reason: String,
}

/// The custody account the locked LP was attributed away from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactCustody {
    #[serde(with = "base58_pubkey")]
    pub token_account: Pubkey,
    #[serde(with = "base58_pubkey")]
    pub owner: Pubkey,
    /// Always equal to the report's `total_locked` (reconciliation gate).
    pub balance: u64,
    /// `"exact_balance_match"` or `"explicit_override"`.
    pub method: String,
}

/// One beneficial-owner locked-LP attribution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactAttribution {
    #[serde(with = "base58_pubkey")]
    pub owner: Pubkey,
    pub lp_balance: u64,
}

/// The published locked-LP report: how locker-held LP was re-attributed
/// into the leaf set (WD-07 — a reviewer can see the custody attribution
/// without re-running the enumeration).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactLockedReport {
    /// Number of validated TokenLock records behind the attributions.
    pub lock_records_seen: usize,
    /// `Σ current_locked_amount` across all validated locks.
    pub total_locked: u64,
    /// Per-beneficial-owner locked totals, canonical ascending-owner
    /// order (may share owners with the leaf set — locked and unlocked
    /// balances are merged).
    pub attributions: Vec<ArtifactAttribution>,
    /// The custody account the locked tokens were attributed away from,
    /// or `None` when nothing is locked.
    pub custody: Option<ArtifactCustody>,
}

/// Provenance of the governed sink ledger sealed into this artifact: an
/// independent reviewer can establish exactly which ledger (version,
/// identity, exact input bytes) was used. This records the ledger's
/// declared identity — it is NOT proof of owner approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SinkLedgerProvenance {
    /// The ledger schema version (this build: 1, `gy.sink-ledger.v1`).
    pub schema_version: u32,
    /// The published per-pool ledger's identity, as declared in the input.
    pub ledger_id: String,
    /// SHA-256 (lowercase hex) of the EXACT ledger input bytes consumed
    /// by the CLI.
    pub input_sha256: String,
    /// Number of governed sink declarations applied.
    pub entry_count: usize,
    /// Total LP excluded under the ledger (reconciles with the artifact's
    /// `reconciliation.sink_exclusions_total`).
    pub sink_exclusions_total: u64,
}

/// Provenance of the locked-LP evidence: which source produced the lock
/// records and the pinned state they were queried at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockEvidenceProvenance {
    /// Evidence source: `"rpc"` (the wired `RpcLockedLpEvidence` — real
    /// UNCX `getProgramAccounts` evidence from the configured RPC).
    pub source: String,
    /// The locker program the evidence was queried against (UNCX
    /// Raydium AMM V4 locker, base58).
    pub program_id: String,
    /// The commitment every read of the run used (from the CLI flag).
    pub commitment: String,
    /// The anchored state slot the evidence query was pinned to (same
    /// anchor as the holder enumeration).
    pub anchor_slot: u64,
    /// Validated TokenLock records seen (equals `locked.lock_records_seen`).
    pub records_seen: usize,
    /// `Σ current_locked_amount` (equals `locked.total_locked`).
    pub total_locked: u64,
}

/// The governed-input provenance sealed into the artifact (WD-07): which
/// sink ledger and which locker evidence produced this snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactProvenance {
    /// The governed sink ledger, or `None` when the CLI ran without
    /// `--sink-ledger` (no governed exclusions were supplied — an absent
    /// ledger is never equivalent to an approved empty ledger; the
    /// absence is explicit and reviewer-visible).
    pub sink_ledger: Option<SinkLedgerProvenance>,
    /// The locked-LP evidence source and context.
    pub lock_evidence: LockEvidenceProvenance,
}

/// The sealed, publishable snapshot artifact. Deterministic end to end:
/// the same snapshot always seals to a byte-identical JSON document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotArtifact {
    pub format_version: u32,
    #[serde(with = "base58_pubkey")]
    pub pool_address: Pubkey,
    #[serde(with = "base58_pubkey")]
    pub amm_program_id: Pubkey,
    #[serde(with = "base58_pubkey")]
    pub lp_mint: Pubkey,
    /// Slot the source served the anchored supply read at (carried from
    /// the snapshot; the on-chain supply pin at salvage is the final
    /// anchor).
    pub snapshot_slot: u64,
    /// The pre-salvage LP supply — the value `salvage_pool` pins against
    /// the live mint and the claims denominator.
    pub lp_total_supply_at_snapshot: u64,
    /// The Merkle root to seal into `PoolRegistry` (hex in JSON).
    #[serde(with = "hex32")]
    pub merkle_root: [u8; 32],
    /// Canonical holders in the leaf set.
    pub leaf_count: usize,
    /// Hashing levels above the leaves (0 = single leaf is the root).
    pub tree_depth: usize,
    /// One entry per claimant, canonical ascending-owner order, proofs
    /// index-aligned with the tree.
    pub entries: Vec<ArtifactEntry>,
    /// Closing token-ledger identity from the snapshot
    /// (`entries_total + sink_exclusions_total == enumerated_total ==
    /// lp_total_supply_at_snapshot`), carried so a reader can audit the
    /// conservation without re-enumerating.
    pub reconciliation: Reconciliation,
    /// The per-owner exclusion ledger (zero-balance + governed sink
    /// exclusions), canonical ascending-owner order (v2).
    pub exclusions: Vec<ArtifactExclusion>,
    /// The locked-LP attribution report (v2).
    pub locked: ArtifactLockedReport,
    /// Governed-input provenance (v2): sink ledger + lock evidence.
    /// `None` only for artifacts sealed without provenance input (the
    /// CLI always supplies it via `seal_with_provenance`).
    pub provenance: Option<ArtifactProvenance>,
}

fn exclusion_reason_str(reason: &ExclusionReason) -> &'static str {
    match reason {
        ExclusionReason::ZeroBalance => "zero_balance",
        ExclusionReason::ExplicitSink => "explicit_sink",
    }
}

fn custody_method_str(method: &CustodyMatchMethod) -> &'static str {
    match method {
        CustodyMatchMethod::ExactBalanceMatch => "exact_balance_match",
        CustodyMatchMethod::ExplicitOverride => "explicit_override",
    }
}

impl SnapshotArtifact {
    /// Seal a snapshot + tree into the publishable artifact (without
    /// governed-input provenance). The CLI path uses
    /// [`Self::seal_with_provenance`] so the sealed artifact identifies
    /// the sink ledger and lock evidence it was produced from.
    ///
    /// Fail-closed against mixed-up handles: the tree is re-derived from
    /// the snapshot's leaf set and must equal the supplied tree
    /// (`ArtifactMismatch` otherwise). There is no path to publish an
    /// artifact whose root does not derive from its own entries.
    pub fn seal(snapshot: &LpSnapshot, tree: &SnapshotMerkleTree) -> Result<Self, SnapshotError> {
        let rebuilt = SnapshotMerkleTree::from_snapshot(snapshot)?;
        if rebuilt != *tree {
            return Err(SnapshotError::ArtifactMismatch(
                "the supplied tree does not match the snapshot's leaf set".to_string(),
            ));
        }
        let entries = snapshot
            .entries
            .iter()
            .enumerate()
            .map(|(i, e)| ArtifactEntry {
                owner: e.owner,
                lp_balance: e.lp_balance,
                leaf: tree.leaf(i).expect("tree indexes mirror the snapshot"),
                proof: tree.proof(i).expect("tree indexes mirror the snapshot"),
            })
            .collect();
        let exclusions = snapshot
            .exclusions
            .iter()
            .map(|e| ArtifactExclusion {
                owner: e.owner,
                lp_balance: e.lp_balance,
                reason: exclusion_reason_str(&e.reason).to_string(),
            })
            .collect();
        let locked = ArtifactLockedReport {
            lock_records_seen: snapshot.locked.lock_records_seen,
            total_locked: snapshot.locked.total_locked,
            attributions: snapshot
                .locked
                .attributions
                .iter()
                .map(|a| ArtifactAttribution {
                    owner: a.owner,
                    lp_balance: a.lp_balance,
                })
                .collect(),
            custody: snapshot.locked.custody.as_ref().map(|c| ArtifactCustody {
                token_account: c.token_account,
                owner: c.owner,
                balance: c.balance,
                method: custody_method_str(&c.method).to_string(),
            }),
        };
        Ok(Self {
            format_version: ARTIFACT_FORMAT_VERSION,
            pool_address: snapshot.pool_address,
            amm_program_id: snapshot.amm_program_id,
            lp_mint: snapshot.lp_mint,
            snapshot_slot: snapshot.snapshot_slot,
            lp_total_supply_at_snapshot: snapshot.lp_total_supply_at_snapshot,
            merkle_root: tree.root(),
            leaf_count: tree.leaf_count(),
            tree_depth: tree.tree_depth(),
            entries,
            reconciliation: snapshot.reconciliation,
            exclusions,
            locked,
            provenance: None,
        })
    }

    /// Seal with governed-input provenance (the CLI production path).
    ///
    /// The provenance is cross-checked against the snapshot BEFORE
    /// sealing — a provenance block that disagrees with the snapshot's
    /// locked report, anchored slot, or sink totals is refused
    /// (`ArtifactMismatch`), so the sealed provenance cannot misdescribe
    /// the artifact it rides on.
    pub fn seal_with_provenance(
        snapshot: &LpSnapshot,
        tree: &SnapshotMerkleTree,
        provenance: ArtifactProvenance,
    ) -> Result<Self, SnapshotError> {
        // Cross-check the lock-evidence provenance against the snapshot.
        if provenance.lock_evidence.total_locked != snapshot.locked.total_locked {
            return Err(SnapshotError::ArtifactMismatch(format!(
                "provenance lock_evidence.total_locked ({}) != snapshot total_locked ({})",
                provenance.lock_evidence.total_locked, snapshot.locked.total_locked
            )));
        }
        if provenance.lock_evidence.records_seen != snapshot.locked.lock_records_seen {
            return Err(SnapshotError::ArtifactMismatch(format!(
                "provenance lock_evidence.records_seen ({}) != snapshot lock_records_seen ({})",
                provenance.lock_evidence.records_seen, snapshot.locked.lock_records_seen
            )));
        }
        if provenance.lock_evidence.anchor_slot != snapshot.snapshot_slot {
            return Err(SnapshotError::ArtifactMismatch(format!(
                "provenance lock_evidence.anchor_slot ({}) != snapshot_slot ({})",
                provenance.lock_evidence.anchor_slot, snapshot.snapshot_slot
            )));
        }
        // Cross-check the sink-ledger provenance against the snapshot.
        if let Some(ledger) = &provenance.sink_ledger {
            if ledger.sink_exclusions_total != snapshot.reconciliation.sink_exclusions_total {
                return Err(SnapshotError::ArtifactMismatch(format!(
                    "provenance sink_ledger.sink_exclusions_total ({}) != reconciliation \
                     sink_exclusions_total ({})",
                    ledger.sink_exclusions_total, snapshot.reconciliation.sink_exclusions_total
                )));
            }
            let explicit_sinks = snapshot
                .exclusions
                .iter()
                .filter(|e| e.reason == ExclusionReason::ExplicitSink)
                .count();
            if ledger.entry_count != explicit_sinks {
                return Err(SnapshotError::ArtifactMismatch(format!(
                    "provenance sink_ledger.entry_count ({}) != explicit sink exclusions ({})",
                    ledger.entry_count, explicit_sinks
                )));
            }
        }
        let mut artifact = Self::seal(snapshot, tree)?;
        artifact.provenance = Some(provenance);
        Ok(artifact)
    }

    /// The sealed Merkle root.
    pub fn root(&self) -> [u8; 32] {
        self.merkle_root
    }

    /// The artifact entry for `owner`, if present. Linear scan — no
    /// sortedness precondition, correct on any loaded artifact.
    pub fn proof_for(&self, owner: &Pubkey) -> Option<&ArtifactEntry> {
        self.entries.iter().find(|e| &e.owner == owner)
    }

    /// Full self-check of a (loaded or sealed) artifact: the tree rebuilt
    /// from the persisted entries must re-derive every leaf, every proof,
    /// the root, the depth, the count, the closing reconciliation
    /// identity, the exclusion ledger, the locked-LP report, and — when
    /// present — the provenance cross-checks. Any drift is
    /// `ArtifactMismatch`; structurally impossible entry sets
    /// (non-canonical, empty, zero balances) are the tree builder's
    /// fail-closed errors.
    pub fn verify_integrity(&self) -> Result<(), SnapshotError> {
        if self.format_version != ARTIFACT_FORMAT_VERSION {
            return Err(SnapshotError::ArtifactMismatch(format!(
                "unsupported artifact format_version {} (expected {})",
                self.format_version, ARTIFACT_FORMAT_VERSION
            )));
        }
        let entries: Vec<HolderEntry> = self
            .entries
            .iter()
            .map(|e| HolderEntry {
                owner: e.owner,
                lp_balance: e.lp_balance,
            })
            .collect();
        let tree = SnapshotMerkleTree::from_entries(&entries)?;
        if tree.root() != self.merkle_root {
            return Err(SnapshotError::ArtifactMismatch(
                "root does not derive from the persisted entries".to_string(),
            ));
        }
        if self.leaf_count != entries.len() || self.leaf_count != tree.leaf_count() {
            return Err(SnapshotError::ArtifactMismatch(
                "leaf_count disagrees with the persisted entries".to_string(),
            ));
        }
        if self.tree_depth != tree.tree_depth() {
            return Err(SnapshotError::ArtifactMismatch(
                "tree_depth disagrees with the persisted entries".to_string(),
            ));
        }
        for (i, entry) in self.entries.iter().enumerate() {
            if tree.leaf(i) != Some(entry.leaf) {
                return Err(SnapshotError::ArtifactMismatch(format!(
                    "leaf mismatch at entry {i} (owner {})",
                    entry.owner
                )));
            }
            if tree.proof(i).as_ref() != Some(&entry.proof) {
                return Err(SnapshotError::ArtifactMismatch(format!(
                    "proof mismatch at entry {i} (owner {})",
                    entry.owner
                )));
            }
        }
        // Closing identity, re-checked from the persisted fields alone.
        let mut total: u128 = 0;
        for entry in &self.entries {
            total = total
                .checked_add(entry.lp_balance as u128)
                .ok_or(SnapshotError::Overflow)?;
        }
        let reconciliation = &self.reconciliation;
        if total != reconciliation.entries_total as u128 {
            return Err(SnapshotError::ArtifactMismatch(format!(
                "Σ persisted balances ({total}) != reconciliation.entries_total ({})",
                reconciliation.entries_total
            )));
        }
        if reconciliation.entries_total + reconciliation.sink_exclusions_total
            != reconciliation.enumerated_total
        {
            return Err(SnapshotError::ArtifactMismatch(
                "reconciliation identity entries + sinks != enumerated broken".to_string(),
            ));
        }
        if reconciliation.enumerated_total != self.lp_total_supply_at_snapshot {
            return Err(SnapshotError::ArtifactMismatch(
                "reconciliation.enumerated_total != lp_total_supply_at_snapshot".to_string(),
            ));
        }
        self.verify_exclusion_ledger()?;
        self.verify_locked_report()?;
        self.verify_provenance()?;
        Ok(())
    }

    /// Exclusion ledger: canonical order, sane balances, sink total
    /// reconciles with the closing identity, and no overlap with the
    /// claimable leaf set.
    fn verify_exclusion_ledger(&self) -> Result<(), SnapshotError> {
        let mut sink_total: u128 = 0;
        let mut previous: Option<Pubkey> = None;
        for exclusion in &self.exclusions {
            if let Some(prev) = previous {
                if exclusion.owner <= prev {
                    return Err(SnapshotError::ArtifactMismatch(
                        "exclusions are not in canonical ascending-owner order".to_string(),
                    ));
                }
            }
            previous = Some(exclusion.owner);
            match exclusion.reason.as_str() {
                "zero_balance" => {
                    if exclusion.lp_balance != 0 {
                        return Err(SnapshotError::ArtifactMismatch(format!(
                            "zero_balance exclusion for owner {} carries a nonzero balance",
                            exclusion.owner
                        )));
                    }
                }
                "explicit_sink" => {
                    sink_total = sink_total
                        .checked_add(exclusion.lp_balance as u128)
                        .ok_or(SnapshotError::Overflow)?;
                }
                other => {
                    return Err(SnapshotError::ArtifactMismatch(format!(
                        "unknown exclusion reason `{other}` for owner {}",
                        exclusion.owner
                    )));
                }
            }
            // NOTE: an owner MAY legitimately appear here AND in the leaf
            // set — a holder whose only unlocked token account is at zero
            // balance is ledgered as zero_balance and re-enters the leaf
            // set through the locked-LP attribution. Total-level
            // reconciliation (checked below) is the integrity gate; an
            // owner-set overlap is not an invariant.
        }
        if sink_total != self.reconciliation.sink_exclusions_total as u128 {
            return Err(SnapshotError::ArtifactMismatch(format!(
                "Σ explicit sink exclusions ({sink_total}) != \
                 reconciliation.sink_exclusions_total ({})",
                self.reconciliation.sink_exclusions_total
            )));
        }
        Ok(())
    }

    /// Locked-LP report: attributions sum to the locked total, custody
    /// presence matches the locked total, and the custody owner never
    /// keeps a claimable leaf (a PDA cannot sign a claim).
    fn verify_locked_report(&self) -> Result<(), SnapshotError> {
        let locked = &self.locked;
        let mut attributed: u128 = 0;
        let mut previous: Option<Pubkey> = None;
        for attribution in &locked.attributions {
            if let Some(prev) = previous {
                if attribution.owner <= prev {
                    return Err(SnapshotError::ArtifactMismatch(
                        "locked attributions are not in canonical ascending-owner order"
                            .to_string(),
                    ));
                }
            }
            previous = Some(attribution.owner);
            attributed = attributed
                .checked_add(attribution.lp_balance as u128)
                .ok_or(SnapshotError::Overflow)?;
        }
        if attributed != locked.total_locked as u128 {
            return Err(SnapshotError::ArtifactMismatch(format!(
                "Σ locked attributions ({attributed}) != locked.total_locked ({})",
                locked.total_locked
            )));
        }
        match &locked.custody {
            Some(custody) => {
                if locked.total_locked == 0 {
                    return Err(SnapshotError::ArtifactMismatch(
                        "custody resolution present with zero locked total".to_string(),
                    ));
                }
                if custody.balance != locked.total_locked {
                    return Err(SnapshotError::ArtifactMismatch(format!(
                        "custody balance ({}) != locked.total_locked ({})",
                        custody.balance, locked.total_locked
                    )));
                }
                if self.entries.iter().any(|e| e.owner == custody.owner) {
                    return Err(SnapshotError::ArtifactMismatch(format!(
                        "custody owner {} also holds a claimable leaf; attributing to a PDA \
                         would strand the claim",
                        custody.owner
                    )));
                }
            }
            None if locked.total_locked != 0 => {
                return Err(SnapshotError::ArtifactMismatch(
                    "locked total > 0 but no custody resolution".to_string(),
                ));
            }
            None => {}
        }
        Ok(())
    }

    /// Provenance cross-checks: the sealed provenance must agree with the
    /// artifact's own locked report and sink totals.
    fn verify_provenance(&self) -> Result<(), SnapshotError> {
        let provenance = match &self.provenance {
            Some(p) => p,
            None => return Ok(()),
        };
        if provenance.lock_evidence.total_locked != self.locked.total_locked {
            return Err(SnapshotError::ArtifactMismatch(
                "provenance lock_evidence.total_locked != locked.total_locked".to_string(),
            ));
        }
        if provenance.lock_evidence.records_seen != self.locked.lock_records_seen {
            return Err(SnapshotError::ArtifactMismatch(
                "provenance lock_evidence.records_seen != locked.lock_records_seen".to_string(),
            ));
        }
        if provenance.lock_evidence.anchor_slot != self.snapshot_slot {
            return Err(SnapshotError::ArtifactMismatch(
                "provenance lock_evidence.anchor_slot != snapshot_slot".to_string(),
            ));
        }
        if let Some(ledger) = &provenance.sink_ledger {
            if ledger.sink_exclusions_total != self.reconciliation.sink_exclusions_total {
                return Err(SnapshotError::ArtifactMismatch(
                    "provenance sink_ledger.sink_exclusions_total != reconciliation \
                     sink_exclusions_total"
                        .to_string(),
                ));
            }
            let explicit_sinks = self
                .exclusions
                .iter()
                .filter(|e| e.reason == "explicit_sink")
                .count();
            if ledger.entry_count != explicit_sinks {
                return Err(SnapshotError::ArtifactMismatch(
                    "provenance sink_ledger.entry_count != explicit sink exclusions".to_string(),
                ));
            }
        }
        Ok(())
    }

    /// Canonical published form: pretty JSON, deterministic bytes.
    pub fn to_json_pretty(&self) -> Result<String, SnapshotError> {
        serde_json::to_string_pretty(self).map_err(|e| SnapshotError::Serialization(e.to_string()))
    }

    /// Compact JSON (same canonical field/data ordering).
    pub fn to_json(&self) -> Result<String, SnapshotError> {
        serde_json::to_string(self).map_err(|e| SnapshotError::Serialization(e.to_string()))
    }

    /// Load an artifact from JSON. Structural only — run
    /// [`Self::verify_integrity`] on the result before trusting it.
    pub fn from_json(json: &str) -> Result<Self, SnapshotError> {
        serde_json::from_str(json).map_err(|e| SnapshotError::Serialization(e.to_string()))
    }
}

// ---------------------------------------------------------------------
// Hex codec for 32-byte hashes (lowercase; readers accept either case).
// Kept dependency-free on purpose: the artifact format is normative, and
// a two-function codec is easier to audit than a transitive dependency.
// ---------------------------------------------------------------------

pub(crate) mod hex32 {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub(crate) fn serialize<S: Serializer>(
        value: &[u8; 32],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&super::encode_hex(value))
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(deserializer)?;
        super::decode_hex32(&s).map_err(de::Error::custom)
    }
}

// Pubkeys serialize as canonical base58 STRINGS, not the byte arrays
// solana-sdk 2.x's default serde impls produce — the artifact is published
// for LP holders who must be able to find their own wallet in it. Decode
// goes through `Pubkey::from_str` (strict base58 + length check), so no
// extra dependency is pulled in.
pub(crate) mod base58_pubkey {
    use serde::{de, Deserialize, Deserializer, Serializer};
    use solana_sdk::pubkey::Pubkey;
    use std::str::FromStr;

    pub(crate) fn serialize<S: Serializer>(
        value: &Pubkey,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Pubkey, D::Error> {
        let s = String::deserialize(deserializer)?;
        Pubkey::from_str(&s).map_err(|e| de::Error::custom(format!("invalid base58 pubkey: {e}")))
    }
}

pub(crate) mod vec_hex32 {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub(crate) fn serialize<S: Serializer>(
        value: &[[u8; 32]],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(value.iter().map(|h| super::encode_hex(h)))
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<[u8; 32]>, D::Error> {
        let items = Vec::<String>::deserialize(deserializer)?;
        items
            .iter()
            .map(|s| super::decode_hex32(s).map_err(de::Error::custom))
            .collect()
    }
}

pub(crate) fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub(crate) fn decode_hex32(s: &str) -> Result<[u8; 32], String> {
    let bytes = s.as_bytes();
    if bytes.len() != 64 {
        return Err(format!(
            "expected 64 hex characters for a 32-byte hash, got {}",
            bytes.len()
        ));
    }
    let mut out = [0u8; 32];
    for (i, pair) in bytes.chunks(2).enumerate() {
        let hi =
            hex_val(pair[0]).ok_or_else(|| format!("invalid hex character at offset {}", i * 2))?;
        let lo = hex_val(pair[1])
            .ok_or_else(|| format!("invalid hex character at offset {}", i * 2 + 1))?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact::SinkLedgerProvenance;
    use crate::locked::{InMemoryLocks, TokenLockRecord};
    use crate::model::TokenAccountSnapshot;
    use crate::sink_ledger::SinkLedger;
    use crate::source::InMemorySource;
    use crate::{SnapshotBuilder, SnapshotRequest};

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

    /// A small but production-shaped snapshot: 3 claimants, one sink, one
    /// custody account, one lock. Supply 8_000 = 4_000 + 2_500 + 500(sink)
    /// + 1_000(custody, locked for 0x60).
    fn sealed_artifact() -> (LpSnapshot, SnapshotArtifact) {
        let lp_mint = key(0x01);
        let source = InMemorySource::new(
            lp_mint,
            123,
            8_000,
            vec![
                acct(1, 0x10, 4_000),
                acct(2, 0x20, 2_500),
                acct(3, 0x50, 500),   // sink
                acct(4, 0x40, 1_000), // custody
            ],
        );
        let locks =
            InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x71, 1, 0x60, 1_000)]);
        let request = SnapshotRequest {
            pool_address: key(0xAA),
            amm_program_id: key(0xAB),
            lp_mint,
            sink_exclusions: vec![key(0x50)],
            custody_owner_overrides: vec![],
            sink_ledger: None,
        };
        let snapshot = SnapshotBuilder::new(request)
            .build(&source, &locks)
            .unwrap();
        let tree = SnapshotMerkleTree::from_snapshot(&snapshot).unwrap();
        let artifact = SnapshotArtifact::seal(&snapshot, &tree).unwrap();
        (snapshot, artifact)
    }

    fn sample_provenance() -> ArtifactProvenance {
        ArtifactProvenance {
            sink_ledger: Some(SinkLedgerProvenance {
                schema_version: 1,
                ledger_id: "GY-SINK-TEST-001".to_string(),
                input_sha256: SinkLedger::input_digest_hex(b"exact-ledger-input"),
                entry_count: 1,
                sink_exclusions_total: 500,
            }),
            lock_evidence: crate::artifact::LockEvidenceProvenance {
                source: "rpc".to_string(),
                program_id: crate::locked::uncx::PROGRAM_ID.to_string(),
                commitment: "confirmed".to_string(),
                anchor_slot: 123,
                records_seen: 1,
                total_locked: 1_000,
            },
        }
    }

    #[test]
    fn seal_is_byte_deterministic_across_rebuilds() {
        let (_, a) = sealed_artifact();
        let (_, b) = sealed_artifact();
        let json_a = a.to_json_pretty().unwrap();
        let json_b = b.to_json_pretty().unwrap();
        assert_eq!(json_a, json_b, "the same snapshot must seal byte-for-byte");
        // Compact form is deterministic too.
        assert_eq!(a.to_json().unwrap(), b.to_json().unwrap());
        // And the round trip preserves the structure exactly.
        let loaded = SnapshotArtifact::from_json(&json_a).unwrap();
        assert_eq!(loaded, a);
        assert_eq!(loaded.to_json_pretty().unwrap(), json_a);
    }

    #[test]
    fn sealed_artifact_with_provenance_is_deterministic_and_round_trips() {
        let (snapshot, tree) = {
            let lp_mint = key(0x01);
            let source = InMemorySource::new(
                lp_mint,
                123,
                8_000,
                vec![
                    acct(1, 0x10, 4_000),
                    acct(2, 0x20, 2_500),
                    acct(3, 0x50, 500),   // sink
                    acct(4, 0x40, 1_000), // custody
                ],
            );
            let locks =
                InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x71, 1, 0x60, 1_000)]);
            let request = SnapshotRequest {
                pool_address: key(0xAA),
                amm_program_id: key(0xAB),
                lp_mint,
                sink_exclusions: vec![key(0x50)],
                custody_owner_overrides: vec![],
                sink_ledger: None,
            };
            let snapshot = SnapshotBuilder::new(request)
                .build(&source, &locks)
                .unwrap();
            let tree = SnapshotMerkleTree::from_snapshot(&snapshot).unwrap();
            (snapshot, tree)
        };
        let a =
            SnapshotArtifact::seal_with_provenance(&snapshot, &tree, sample_provenance()).unwrap();
        let b =
            SnapshotArtifact::seal_with_provenance(&snapshot, &tree, sample_provenance()).unwrap();
        assert_eq!(a.to_json_pretty().unwrap(), b.to_json_pretty().unwrap());
        let loaded = SnapshotArtifact::from_json(&a.to_json_pretty().unwrap()).unwrap();
        assert_eq!(loaded, a);
        loaded
            .verify_integrity()
            .expect("provenance artifact is sound");
    }

    #[test]
    fn sealed_artifact_passes_verify_integrity() {
        let (_, artifact) = sealed_artifact();
        artifact
            .verify_integrity()
            .expect("a sealed artifact is sound");
    }

    #[test]
    fn provenance_records_ledger_and_lock_evidence_context() {
        let (snapshot, tree) = {
            let lp_mint = key(0x01);
            let source = InMemorySource::new(
                lp_mint,
                123,
                8_000,
                vec![
                    acct(1, 0x10, 4_000),
                    acct(2, 0x20, 2_500),
                    acct(3, 0x50, 500),   // sink
                    acct(4, 0x40, 1_000), // custody
                ],
            );
            let locks =
                InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x71, 1, 0x60, 1_000)]);
            let request = SnapshotRequest {
                pool_address: key(0xAA),
                amm_program_id: key(0xAB),
                lp_mint,
                sink_exclusions: vec![key(0x50)],
                custody_owner_overrides: vec![],
                sink_ledger: None,
            };
            let snapshot = SnapshotBuilder::new(request)
                .build(&source, &locks)
                .unwrap();
            let tree = SnapshotMerkleTree::from_snapshot(&snapshot).unwrap();
            (snapshot, tree)
        };
        let artifact =
            SnapshotArtifact::seal_with_provenance(&snapshot, &tree, sample_provenance()).unwrap();
        let ledger = artifact
            .provenance
            .as_ref()
            .unwrap()
            .sink_ledger
            .as_ref()
            .unwrap();
        assert_eq!(ledger.schema_version, 1);
        assert_eq!(ledger.ledger_id, "GY-SINK-TEST-001");
        assert_eq!(
            ledger.input_sha256,
            SinkLedger::input_digest_hex(b"exact-ledger-input")
        );
        assert_eq!(ledger.entry_count, 1);
        assert_eq!(ledger.sink_exclusions_total, 500);
        let lock = &artifact.provenance.as_ref().unwrap().lock_evidence;
        assert_eq!(lock.source, "rpc");
        assert_eq!(lock.program_id, crate::locked::uncx::PROGRAM_ID.to_string());
        assert_eq!(lock.commitment, "confirmed");
        assert_eq!(lock.anchor_slot, artifact.snapshot_slot);
        assert_eq!(lock.records_seen, artifact.locked.lock_records_seen);
        assert_eq!(lock.total_locked, artifact.locked.total_locked);
        // The exclusion ledger and locked report are reviewer-visible.
        assert_eq!(artifact.exclusions.len(), 1);
        assert_eq!(artifact.exclusions[0].reason, "explicit_sink");
        assert_eq!(artifact.locked.total_locked, 1_000);
        assert!(artifact.locked.custody.is_some());
    }

    #[test]
    fn seal_rejects_provenance_that_disagrees_with_the_snapshot() {
        let (snapshot, tree) = {
            let lp_mint = key(0x01);
            let source = InMemorySource::new(
                lp_mint,
                123,
                8_000,
                vec![
                    acct(1, 0x10, 4_000),
                    acct(2, 0x20, 2_500),
                    acct(3, 0x50, 500),   // sink
                    acct(4, 0x40, 1_000), // custody
                ],
            );
            let locks =
                InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x71, 1, 0x60, 1_000)]);
            let request = SnapshotRequest {
                pool_address: key(0xAA),
                amm_program_id: key(0xAB),
                lp_mint,
                sink_exclusions: vec![key(0x50)],
                custody_owner_overrides: vec![],
                sink_ledger: None,
            };
            let snapshot = SnapshotBuilder::new(request)
                .build(&source, &locks)
                .unwrap();
            let tree = SnapshotMerkleTree::from_snapshot(&snapshot).unwrap();
            (snapshot, tree)
        };
        // Wrong locked total in the provenance.
        let mut bad = sample_provenance();
        bad.lock_evidence.total_locked = 999;
        let err = SnapshotArtifact::seal_with_provenance(&snapshot, &tree, bad).unwrap_err();
        assert!(matches!(err, SnapshotError::ArtifactMismatch(_)));

        // Wrong anchor slot.
        let mut bad = sample_provenance();
        bad.lock_evidence.anchor_slot = 200;
        assert!(matches!(
            SnapshotArtifact::seal_with_provenance(&snapshot, &tree, bad),
            Err(SnapshotError::ArtifactMismatch(_))
        ));

        // Wrong sink total in the ledger provenance.
        let mut bad = sample_provenance();
        bad.sink_ledger.as_mut().unwrap().sink_exclusions_total = 600;
        assert!(matches!(
            SnapshotArtifact::seal_with_provenance(&snapshot, &tree, bad),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn verify_integrity_rejects_provenance_drift_on_a_loaded_artifact() {
        let (snapshot, tree) = {
            let lp_mint = key(0x01);
            let source = InMemorySource::new(
                lp_mint,
                123,
                8_000,
                vec![
                    acct(1, 0x10, 4_000),
                    acct(2, 0x20, 2_500),
                    acct(3, 0x50, 500),   // sink
                    acct(4, 0x40, 1_000), // custody
                ],
            );
            let locks =
                InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x71, 1, 0x60, 1_000)]);
            let request = SnapshotRequest {
                pool_address: key(0xAA),
                amm_program_id: key(0xAB),
                lp_mint,
                sink_exclusions: vec![key(0x50)],
                custody_owner_overrides: vec![],
                sink_ledger: None,
            };
            let snapshot = SnapshotBuilder::new(request)
                .build(&source, &locks)
                .unwrap();
            let tree = SnapshotMerkleTree::from_snapshot(&snapshot).unwrap();
            (snapshot, tree)
        };
        let artifact =
            SnapshotArtifact::seal_with_provenance(&snapshot, &tree, sample_provenance()).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        value["provenance"]["lock_evidence"]["total_locked"] = serde_json::Value::from(42);
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn verify_integrity_rejects_a_v1_artifact_explicitly() {
        // A v1 artifact (the previous format) must fail with an explicit
        // version mismatch — never silently reinterpreted under v2.
        let (_, artifact) = sealed_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        // Strip the v2-only fields to reconstruct a v1-shaped document.
        value["format_version"] = serde_json::Value::from(1);
        let v1_shaped = serde_json::to_string_pretty(&value).unwrap();
        let loaded = SnapshotArtifact::from_json(&v1_shaped).unwrap();
        let err = loaded.verify_integrity().unwrap_err();
        assert!(
            matches!(err, SnapshotError::ArtifactMismatch(ref m) if m.contains("format_version 1")),
            "the error must name the rejected version: {err}"
        );
    }

    #[test]
    fn verify_integrity_catches_a_tampered_exclusion_ledger() {
        let (_, artifact) = sealed_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        // Bump the sink exclusion's balance: the exclusion ledger no
        // longer reconciles with the closing identity.
        value["exclusions"][0]["lp_balance"] = serde_json::Value::from(501);
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn verify_integrity_catches_a_tampered_locked_report() {
        let (_, artifact) = sealed_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        // Drop the custody resolution while the locked total is nonzero.
        value["locked"]["custody"] = serde_json::Value::Null;
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn seal_rejects_a_foreign_tree() {
        let (snapshot, _) = sealed_artifact();
        // A tree over a DIFFERENT leaf set must not seal this snapshot.
        let other_entries = vec![
            HolderEntry {
                owner: key(0x90),
                lp_balance: 1_111,
            },
            HolderEntry {
                owner: key(0x91),
                lp_balance: 2_222,
            },
        ];
        let foreign_tree = SnapshotMerkleTree::from_entries(&other_entries).unwrap();
        let err = SnapshotArtifact::seal(&snapshot, &foreign_tree).unwrap_err();
        assert!(matches!(err, SnapshotError::ArtifactMismatch(_)));
    }

    #[test]
    fn proof_lookup_finds_the_right_claimant() {
        let (_, artifact) = sealed_artifact();
        // 0x60 holds 1_000 locked LP re-attributed to it.
        let entry = artifact.proof_for(&key(0x60)).expect("claimant present");
        assert_eq!(entry.lp_balance, 1_000);
        assert_eq!(
            artifact.proof_for(&key(0x99)),
            None,
            "non-holders have no proof"
        );
        // Every stored proof is non-trivially shaped for this 3-leaf tree:
        // 3 leaves -> depth 2; the promoted leaf's proof is 1 element.
        assert_eq!(artifact.tree_depth, 2);
        assert!(artifact.entries.iter().all(|e| !e.proof.is_empty()));
        assert!(artifact
            .entries
            .iter()
            .any(|e| e.proof.len() < artifact.tree_depth));
    }

    #[test]
    fn verify_integrity_catches_a_tampered_balance() {
        let (_, artifact) = sealed_artifact();
        let mut json = artifact.to_json_pretty().unwrap();
        // Bump the first entry's balance through raw JSON surgery (the
        // attacker's edit), then reload.
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let owner = artifact.entries[0].owner.to_string();
        let found = value["entries"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|e| e["owner"] == serde_json::Value::String(owner.clone()))
            .unwrap();
        found["lp_balance"] = serde_json::Value::from(artifact.entries[0].lp_balance + 1);
        json = serde_json::to_string_pretty(&value).unwrap();
        let tampered = SnapshotArtifact::from_json(&json).unwrap();
        // The persisted balance now disagrees with the persisted leaf /
        // proof / root / reconciliation — integrity must fail closed.
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn verify_integrity_catches_a_tampered_root() {
        let (_, artifact) = sealed_artifact();
        let json = artifact.to_json_pretty().unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        value["merkle_root"] = serde_json::Value::String(encode_hex(&[0u8; 32]));
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn verify_integrity_catches_an_unsupported_format_version() {
        let (_, artifact) = sealed_artifact();
        let json = artifact.to_json_pretty().unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        value["format_version"] = serde_json::Value::from(99);
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn hex_codec_round_trips_and_is_strict() {
        let bytes = [
            0x00, 0x01, 0x0a, 0x0f, 0xa0, 0xff, 0x7f, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01,
        ];
        let encoded = encode_hex(&bytes);
        assert_eq!(encoded.len(), 64);
        assert!(!encoded.contains(|c: char| c.is_ascii_uppercase()));
        assert_eq!(decode_hex32(&encoded).unwrap(), bytes);
        // Uppercase is accepted on read (output is always lowercase).
        let upper = encoded.to_uppercase();
        assert_eq!(decode_hex32(&upper).unwrap(), bytes);
        // Wrong length, bad characters — all refused.
        assert!(decode_hex32("").is_err());
        assert!(decode_hex32(&encoded[..63]).is_err());
        assert!(decode_hex32(&format!("{encoded}0")).is_err());
        assert!(decode_hex32(&format!("{}g", &encoded[..63])).is_err());
    }
}
