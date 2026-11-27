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
// Version handling is explicit: the CURRENT format_version is the only
// one that verifies. A genuine v1 document (which carries none of the v2
// fields) is refused at deserialization — the v2 struct requires
// `exclusions` and `locked`, so a legacy artifact can never reach
// `verify_integrity` at all. A document that DOES carry the v2 fields but
// labels itself v1 (or any other version) reaches `verify_integrity` and
// fails the explicit format_version gate — it is never silently
// reinterpreted under v2 semantics. The root, leaves, proofs, and
// reconciliation identity are byte-identical to v1 for the same snapshot
// — only additive fields changed.
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
// check: `verify_integrity` — the CLAIMS-GRADE contract — rebuilds the
// tree from the persisted entries and fails closed unless every leaf,
// every proof, the root, the depth, the count, the closing reconciliation
// identity, the exclusion ledger, the locked-LP report, and the
// provenance cross-checks all re-derive exactly, AND complete governed-
// input provenance is present. A provenance-less artifact sealed through
// the non-claims compatibility path (`seal`) is verifiable only through
// `verify_integrity_compatibility`, which is explicitly NOT claims-grade
// and still refuses explicit sink exclusions without governed provenance.
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
use std::str::FromStr;

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

/// The only supported lock-evidence source: real RPC evidence via the
/// wired UNCX adapter (`RpcLockedLpEvidence`). Any other value — file,
/// in-memory, or a future name — is refused; there is no second
/// interpretation of lock evidence in this implementation.
pub const LOCK_EVIDENCE_SOURCE_RPC: &str = "rpc";

/// Structural + supported-value validation of the lock-evidence
/// provenance (D2-03). Checked at SEAL time (so a misdescribing
/// provenance can never be sealed) and again at VERIFY time (so a
/// tampered or malformed artifact is refused). Fails closed on: an
/// unsupported source, a program identity this implementation does not
/// support, an unsupported commitment level, or a zero anchor slot.
fn validate_lock_evidence_provenance_values(
    lock: &LockEvidenceProvenance,
) -> Result<(), SnapshotError> {
    if lock.source != LOCK_EVIDENCE_SOURCE_RPC {
        return Err(SnapshotError::ArtifactMismatch(format!(
            "unsupported lock_evidence.source `{}` (supported: `{}`)",
            lock.source, LOCK_EVIDENCE_SOURCE_RPC
        )));
    }
    let program = Pubkey::from_str(&lock.program_id).map_err(|e| {
        SnapshotError::ArtifactMismatch(format!(
            "lock_evidence.program_id `{}` is not a valid base58 pubkey: {e}",
            lock.program_id
        ))
    })?;
    if program != crate::locked::uncx::PROGRAM_ID {
        return Err(SnapshotError::ArtifactMismatch(format!(
            "unsupported lock_evidence.program_id {program} (this implementation \
             supports exactly the UNCX locker program {})",
            crate::locked::uncx::PROGRAM_ID
        )));
    }
    // Commitment: only the levels explicitly supported for claims-grade
    // snapshot construction. Single source of truth: `rpc::
    // parse_commitment` (the same gate the CLI's --commitment flag uses).
    if crate::rpc::parse_commitment(&lock.commitment).is_err() {
        return Err(SnapshotError::ArtifactMismatch(format!(
            "unsupported lock_evidence.commitment `{}` (supported for claims-grade \
             construction: confirmed, finalized)",
            lock.commitment
        )));
    }
    if lock.anchor_slot == 0 {
        return Err(SnapshotError::ArtifactMismatch(
            "lock_evidence.anchor_slot is 0 — a snapshot is never anchored to a \
             fabricated or missing state slot"
                .to_string(),
        ));
    }
    Ok(())
}

/// Structural validation of the sink-ledger provenance (D2-03): the
/// supported schema version, a non-empty ledger identity, and a
/// well-formed lowercase SHA-256 hex input digest. Note the trust
/// boundary: this validates the provenance STRUCTURE — a syntactically
/// valid field is NOT proof that the ledger was owner-approved or that
/// its bytes were authenticated (D-04-D process control).
fn validate_sink_ledger_provenance_values(
    ledger: &SinkLedgerProvenance,
) -> Result<(), SnapshotError> {
    if ledger.schema_version != crate::sink_ledger::SINK_LEDGER_SCHEMA_VERSION {
        return Err(SnapshotError::ArtifactMismatch(format!(
            "unsupported sink_ledger provenance schema_version {} (expected {})",
            ledger.schema_version,
            crate::sink_ledger::SINK_LEDGER_SCHEMA_VERSION
        )));
    }
    if ledger.ledger_id.trim().is_empty() {
        return Err(SnapshotError::ArtifactMismatch(
            "sink_ledger.ledger_id is empty — the governed ledger identity is required".to_string(),
        ));
    }
    // Input digest: exactly a lowercase 64-hex-character SHA-256
    // representation (the CLI seals `SinkLedger::input_digest_hex`).
    let digest = ledger.input_sha256.as_bytes();
    if digest.len() != 64
        || !digest
            .iter()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(SnapshotError::ArtifactMismatch(format!(
            "sink_ledger.input_sha256 `{}` is not a lowercase 64-character \
             SHA-256 hex digest",
            ledger.input_sha256
        )));
    }
    Ok(())
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
    /// Seal a snapshot + tree into the publishable artifact WITHOUT
    /// governed-input provenance — the non-claims compatibility path.
    /// The CLI production path uses [`Self::seal_with_provenance`] so the
    /// sealed artifact identifies the sink ledger and lock evidence it
    /// was produced from.
    ///
    /// Fail-closed against mixed-up handles: the tree is re-derived from
    /// the snapshot's leaf set and must equal the supplied tree
    /// (`ArtifactMismatch` otherwise). There is no path to publish an
    /// artifact whose root does not derive from its own entries.
    ///
    /// The resulting artifact carries NO governed-input provenance, so it
    /// can never pass the claims-grade [`Self::verify_integrity`]
    /// contract — regardless of whether it carries sink exclusions. It is
    /// verifiable only through [`Self::verify_integrity_compatibility`]
    /// (which additionally refuses explicit sink exclusions without
    /// governed provenance) and must never be accepted as a claims-grade
    /// production snapshot. Production seals go through
    /// [`Self::seal_with_provenance`].
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
    /// the artifact it rides on. Structural validation (D2-03) also runs
    /// at seal time: unsupported sources, program identities, commitment
    /// levels, ledger versions, or malformed digests are refused, and an
    /// explicitly-sunk snapshot may never be sealed without the
    /// sink-ledger provenance naming the governed ledger that produced
    /// the exclusions.
    pub fn seal_with_provenance(
        snapshot: &LpSnapshot,
        tree: &SnapshotMerkleTree,
        provenance: ArtifactProvenance,
    ) -> Result<Self, SnapshotError> {
        // Structural + supported-value validation FIRST (D2-03): no
        // unsupported provenance value is ever accepted, even if the
        // cross-checks below would agree with it.
        validate_lock_evidence_provenance_values(&provenance.lock_evidence)?;
        if let Some(ledger) = &provenance.sink_ledger {
            validate_sink_ledger_provenance_values(ledger)?;
        }
        // Governed-exclusion invariant (D2-02 at seal time): a snapshot
        // with explicit sink exclusions must name the governed ledger
        // that produced them — sealing with the sink-ledger provenance
        // absent would publish exclusions with no governed origin.
        if provenance.sink_ledger.is_none()
            && snapshot
                .exclusions
                .iter()
                .any(|e| e.reason == ExclusionReason::ExplicitSink)
        {
            return Err(SnapshotError::ArtifactMismatch(
                "snapshot contains explicit sink exclusions but the provenance carries \
                 no governed sink ledger; exclusions require sink-ledger provenance"
                    .to_string(),
            ));
        }
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

    /// Full CLAIMS-GRADE self-check of a (loaded or sealed) artifact: the
    /// tree rebuilt from the persisted entries must re-derive every leaf,
    /// every proof, the root, the depth, the count, the closing
    /// reconciliation identity, the exclusion ledger, the locked-LP
    /// report, and the provenance cross-checks. Any drift is
    /// `ArtifactMismatch`; structurally impossible entry sets
    /// (non-canonical, empty, zero balances) are the tree builder's
    /// fail-closed errors.
    ///
    /// CLAIMS-GRADE PROVENANCE REQUIREMENT: complete, valid governed-input
    /// provenance (lock evidence, plus the governed sink-ledger section
    /// when explicit sink exclusions are present) is REQUIRED —
    /// regardless of whether the artifact carries sink exclusions. An
    /// artifact with no provenance section can never pass this contract
    /// and can never be accepted as a claims-grade production snapshot;
    /// provenance-less compatibility artifacts are verifiable only
    /// through [`Self::verify_integrity_compatibility`], which is
    /// explicitly NOT claims-grade. The CLI and the fork harnesses — the
    /// production-facing claims consumers — use this contract.
    pub fn verify_integrity(&self) -> Result<(), SnapshotError> {
        self.verify_structure()?;
        if self.provenance.is_none() {
            return Err(SnapshotError::ArtifactMismatch(
                "claims-grade verification requires complete governed-input provenance: \
                 the artifact carries no provenance section and cannot be accepted as a \
                 claims-grade snapshot; provenance-less compatibility artifacts verify \
                 only through `verify_integrity_compatibility` and are never claims-grade"
                    .to_string(),
            ));
        }
        self.verify_provenance()?;
        Ok(())
    }

    /// NON-CLAIMS compatibility verification — explicitly NOT claims-grade.
    ///
    /// Runs the same structural re-derivation as [`Self::verify_integrity`]
    /// (root, leaves, proofs, depth, count, reconciliation identity,
    /// exclusion ledger, locked report) and retains the governed-exclusion
    /// invariant: an artifact carrying explicit sink exclusions still
    /// requires governed sink-ledger provenance here. What it tolerates —
    /// and what [`Self::verify_integrity`] refuses — is a provenance-less
    /// artifact with NO explicit sink exclusions.
    ///
    /// This contract exists for non-claims compatibility consumers of
    /// artifacts sealed through the provenance-less `seal()` path. An
    /// artifact accepted by this function is NOT a claims-grade
    /// production snapshot and must never be treated as one; claims-grade
    /// acceptance goes through [`Self::verify_integrity`] only.
    pub fn verify_integrity_compatibility(&self) -> Result<(), SnapshotError> {
        self.verify_structure()?;
        self.verify_provenance()?;
        Ok(())
    }

    /// Structural re-derivation shared by both verification contracts:
    /// format version gate, tree/leaf/proof/root/depth/count, the closing
    /// reconciliation identity, the exclusion ledger, and the locked-LP
    /// report.
    fn verify_structure(&self) -> Result<(), SnapshotError> {
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

    /// Provenance validation (D2-03). Structural and supported-value
    /// checks (source, program identity, commitment, anchor slot; ledger
    /// schema version, identity, input digest) plus the cross-field
    /// agreement between the sealed provenance and the artifact's own
    /// locked report, sink totals, and exclusion ledger.
    ///
    /// Reached by BOTH verification contracts. Under the claims-grade
    /// contract ([`Self::verify_integrity`]) a None provenance is
    /// refused before this runs, so the None branch below only serves
    /// the compatibility contract — where a provenance-less artifact
    /// with explicit sink exclusions is still refused fail-closed
    /// (D2-02 at verify time).
    ///
    /// TRUST BOUNDARY: this validates artifact STRUCTURE, supported
    /// values, and internal consistency. It does NOT establish that an
    /// RPC response was authentic, that an external locker statement was
    /// truthful, or that an owner approved the sink ledger — those are
    /// outside this verification's guarantees.
    fn verify_provenance(&self) -> Result<(), SnapshotError> {
        // How many explicit sink exclusions does this artifact carry?
        let explicit_sinks = self
            .exclusions
            .iter()
            .filter(|e| e.reason == "explicit_sink")
            .count();
        let provenance = match &self.provenance {
            Some(p) => p,
            None => {
                // Governed-exclusion invariant (D2-02 at verify time,
                // compatibility contract): a provenance-less (non-
                // production compatibility) artifact cannot verify once
                // it carries explicit sink exclusions — there is no
                // governed ledger to attribute them to. It is also never
                // claims-grade (see `verify_integrity`).
                if explicit_sinks > 0 {
                    return Err(SnapshotError::ArtifactMismatch(
                        "artifact contains explicit sink exclusions but carries no \
                         provenance; exclusions require governed sink-ledger provenance"
                            .to_string(),
                    ));
                }
                return Ok(());
            }
        };
        // Supported-value validation, deterministically fail-closed.
        validate_lock_evidence_provenance_values(&provenance.lock_evidence)?;
        if let Some(ledger) = &provenance.sink_ledger {
            validate_sink_ledger_provenance_values(ledger)?;
        } else if explicit_sinks > 0 {
            return Err(SnapshotError::ArtifactMismatch(
                "artifact contains explicit sink exclusions but the provenance carries \
                 no governed sink ledger; exclusions require sink-ledger provenance"
                    .to_string(),
            ));
        }
        // Cross-field consistency with the artifact's own contents.
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
    use crate::sink_ledger::{SinkLedger, SinkLedgerEntry};
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

    /// The governed sink ledger binding the standard test pool's sink
    /// (owner 0x50, token account key(0x03), 500 LP). Exclusions are
    /// governed (D2-02): the ledger — not a direct declaration — is the
    /// authoritative source of the sink set.
    fn governed_sink_ledger() -> SinkLedger {
        SinkLedger {
            schema_version: crate::sink_ledger::SINK_LEDGER_SCHEMA_VERSION,
            ledger_id: "GY-SINK-TEST-001".to_string(),
            pool_address: key(0xAA),
            amm_program_id: key(0xAB),
            lp_mint: key(0x01),
            entries: vec![SinkLedgerEntry {
                owner: key(0x50),
                token_account: key(0x03),
                lp_mint: key(0x01),
                raw_balance: 500,
                rationale: "incinerator address, funds provably unrecoverable".to_string(),
                evidence_references: vec!["gy-evidence-001".to_string()],
                approval_identities: vec!["owner-identity-1".to_string()],
                independent_reviewer: "reviewer-identity-1".to_string(),
                approved_at: "2026-11-27T00:00:00Z".to_string(),
            }],
        }
    }

    /// The standard pool shape: 4 holders, one governed sink, one custody
    /// account, one lock. Supply 8_000 = 4_000 + 2_500 + 500(sink) +
    /// 1_000(custody, locked for 0x60).
    fn standard_snapshot() -> LpSnapshot {
        let lp_mint = key(0x01);
        let source = InMemorySource::new(
            lp_mint,
            123,
            8_000,
            vec![
                acct(1, 0x10, 4_000),
                acct(2, 0x20, 2_500),
                acct(3, 0x50, 500),   // governed sink
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
            sink_ledger: Some(governed_sink_ledger()),
        };
        SnapshotBuilder::new(request)
            .build(&source, &locks)
            .unwrap()
    }

    fn standard_tree() -> SnapshotMerkleTree {
        SnapshotMerkleTree::from_snapshot(&standard_snapshot()).unwrap()
    }

    /// The standard pool sealed WITHOUT provenance — the isolated
    /// non-production compatibility path (`seal`). An artifact in this
    /// shape carrying explicit sink exclusions cannot pass either
    /// verification contract, and the artifact can never pass the
    /// claims-grade contract at all (provenance is required).
    fn sealed_artifact() -> SnapshotArtifact {
        SnapshotArtifact::seal(&standard_snapshot(), &standard_tree()).unwrap()
    }

    /// A pool WITHOUT any sink exclusion (two holders, no locks), sealed
    /// WITHOUT provenance: the shape that previously slipped through
    /// `verify_integrity` as if it were claims-grade merely because it
    /// carried no explicit sink exclusions.
    fn sealed_provenance_less_sinkless_artifact() -> SnapshotArtifact {
        let lp_mint = key(0x01);
        let source = InMemorySource::new(
            lp_mint,
            77,
            5_000,
            vec![acct(1, 0x10, 3_000), acct(2, 0x20, 2_000)],
        );
        let locks = InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![]);
        let request = SnapshotRequest {
            pool_address: key(0xAA),
            amm_program_id: key(0xAB),
            lp_mint,
            sink_exclusions: vec![],
            custody_owner_overrides: vec![],
            sink_ledger: None,
        };
        let snapshot = SnapshotBuilder::new(request)
            .build(&source, &locks)
            .unwrap();
        let tree = SnapshotMerkleTree::from_snapshot(&snapshot).unwrap();
        SnapshotArtifact::seal(&snapshot, &tree).unwrap()
    }

    /// The standard pool sealed WITH governed-input provenance — the CLI
    /// production path.
    fn sealed_provenance_artifact() -> SnapshotArtifact {
        SnapshotArtifact::seal_with_provenance(
            &standard_snapshot(),
            &standard_tree(),
            sample_provenance(),
        )
        .unwrap()
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
        let a = sealed_artifact();
        let b = sealed_artifact();
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
        let a = sealed_provenance_artifact();
        let b = sealed_provenance_artifact();
        assert_eq!(a.to_json_pretty().unwrap(), b.to_json_pretty().unwrap());
        let loaded = SnapshotArtifact::from_json(&a.to_json_pretty().unwrap()).unwrap();
        assert_eq!(loaded, a);
        loaded
            .verify_integrity()
            .expect("provenance artifact is sound");
    }

    /// The CLI production path: a provenance-sealed artifact passes the
    /// full integrity check (valid artifacts still verify, D2-03).
    #[test]
    fn provenance_sealed_artifact_passes_verify_integrity() {
        sealed_provenance_artifact()
            .verify_integrity()
            .expect("a provenance-sealed artifact is sound");
    }

    /// D2-02 at the artifact layer: the provenance-less compatibility
    /// path (`seal`) is explicitly isolated — an artifact carrying
    /// explicit sink exclusions WITHOUT governed sink-ledger provenance
    /// cannot pass `verify_integrity`, so no compatibility artifact is
    /// ever acceptable as a claims-grade snapshot with exclusions.
    #[test]
    fn seal_without_provenance_cannot_verify_an_artifact_with_explicit_sinks() {
        let artifact = sealed_artifact();
        // Sanity: the standard pool does carry a governed sink exclusion.
        assert_eq!(artifact.exclusions.len(), 1);
        assert_eq!(artifact.exclusions[0].reason, "explicit_sink");
        assert!(artifact.provenance.is_none());
        let err = artifact.verify_integrity().unwrap_err();
        assert!(
            matches!(err, SnapshotError::ArtifactMismatch(ref m) if m.contains("no provenance")),
            "the error must name the missing governed provenance: {err}"
        );
    }

    /// CLAIMS-GRADE PROVENANCE REQUIREMENT (correction): an artifact with
    /// NO provenance can no longer pass `verify_integrity` merely because
    /// it carries no explicit sink exclusions. Claims-grade verification
    /// ALWAYS requires complete, valid governed-input provenance — locker
    /// evidence included — regardless of exclusions; a provenance-less
    /// compatibility artifact cannot be accepted as claims-grade.
    #[test]
    fn provenance_less_artifact_without_exclusions_cannot_verify_as_claims_grade() {
        let artifact = sealed_provenance_less_sinkless_artifact();
        assert!(artifact.provenance.is_none());
        assert!(
            artifact
                .exclusions
                .iter()
                .all(|e| e.reason != "explicit_sink"),
            "the fixture carries no explicit sink exclusions"
        );
        let err = artifact.verify_integrity().unwrap_err();
        assert!(
            matches!(err, SnapshotError::ArtifactMismatch(ref m) if m.contains("no provenance")),
            "the claims-grade contract must refuse a provenance-less artifact: {err}"
        );
    }

    /// The legitimate non-claims compatibility use is preserved and
    /// clearly separate: the same provenance-less, exclusion-free
    /// artifact still verifies through `verify_integrity_compatibility` —
    /// a contract whose documentation explicitly states it is NOT
    /// claims-grade.
    #[test]
    fn compatibility_contract_still_verifies_the_provenance_less_sinkless_artifact() {
        let artifact = sealed_provenance_less_sinkless_artifact();
        artifact
            .verify_integrity_compatibility()
            .expect("the non-claims compatibility contract verifies this artifact");
    }

    /// With explicit sink exclusions, the provenance-less artifact is
    /// refused by BOTH contracts — the compatibility path can never
    /// launder ungoverned exclusions either (D2-02 at verify time).
    #[test]
    fn provenance_less_artifact_with_exclusions_is_rejected_by_both_contracts() {
        let artifact = sealed_artifact();
        assert!(artifact.provenance.is_none());
        assert!(artifact.verify_integrity().is_err());
        let err = artifact.verify_integrity_compatibility().unwrap_err();
        assert!(
            matches!(err, SnapshotError::ArtifactMismatch(ref m) if m.contains("no provenance")),
            "the compatibility contract must refuse exclusions without governed provenance: {err}"
        );
    }

    /// The production path is unchanged: a complete, valid provenance
    /// artifact passes BOTH contracts (the claims-grade gate is satisfied
    /// by governed provenance).
    #[test]
    fn provenance_artifact_passes_both_contracts() {
        let artifact = sealed_provenance_artifact();
        artifact
            .verify_integrity()
            .expect("claims-grade contract accepts governed provenance");
        artifact
            .verify_integrity_compatibility()
            .expect("compatibility contract accepts governed provenance");
    }

    /// D2-02 at the artifact layer, symmetric case: provenance present,
    /// but the sink-ledger section stripped while explicit exclusions
    /// remain — verification fails closed.
    #[test]
    fn provenance_without_the_sink_ledger_section_cannot_verify_explicit_sinks() {
        let artifact = sealed_provenance_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        value["provenance"]["sink_ledger"] = serde_json::Value::Null;
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn provenance_records_ledger_and_lock_evidence_context() {
        let artifact = sealed_provenance_artifact();
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
        let (snapshot, tree) = (standard_snapshot(), standard_tree());
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
        let artifact = sealed_provenance_artifact();
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

    /// D2-04: a GENUINE v1 artifact — the v2-only fields (`exclusions`,
    /// `locked`, `provenance`) actually stripped, not merely relabeled —
    /// is refused at DESERIALIZATION: the v2 struct requires `exclusions`
    /// and `locked` (non-Option), so a legacy document can never reach
    /// `verify_integrity`'s version gate at all. The asserted failure
    /// stage is therefore the JSON parser (`Serialization`), NOT an
    /// explicit format_version mismatch — see
    /// `a_v1_labeled_v2_document_fails_the_explicit_version_gate` for the
    /// case that does reach the version gate.
    #[test]
    fn a_genuine_v1_artifact_is_rejected_at_deserialization() {
        let artifact = sealed_provenance_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        // REALLY strip the v2-only fields: a v1 document has none of them.
        let obj = value.as_object_mut().unwrap();
        obj.remove("exclusions");
        obj.remove("locked");
        obj.remove("provenance");
        obj["format_version"] = serde_json::Value::from(1);
        let v1_document = serde_json::to_string_pretty(&value).unwrap();
        // Sanity: the document really is v1-shaped (no v2 fields remain).
        assert!(value.get("exclusions").is_none());
        assert!(value.get("locked").is_none());
        assert!(value.get("provenance").is_none());
        assert_eq!(value["format_version"], 1);
        // The parser rejects it before version validation runs.
        let err = SnapshotArtifact::from_json(&v1_document).unwrap_err();
        assert!(
            matches!(err, SnapshotError::Serialization(ref m) if m.contains("missing field")),
            "a genuine v1 artifact fails deserialization on the required v2 fields: {err}"
        );
    }

    /// D2-04, the other half of version handling: a document that DOES
    /// carry every v2 field but labels itself format_version 1 parses
    /// fine and then fails `verify_integrity`'s EXPLICIT version gate —
    /// never silently reinterpreted under v2 semantics. Version handling
    /// stays fail-closed at both stages.
    #[test]
    fn a_v1_labeled_v2_document_fails_the_explicit_version_gate() {
        let artifact = sealed_provenance_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        value["format_version"] = serde_json::Value::from(1);
        let loaded = SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        let err = loaded.verify_integrity().unwrap_err();
        assert!(
            matches!(err, SnapshotError::ArtifactMismatch(ref m) if m.contains("format_version 1")),
            "the error must name the rejected version: {err}"
        );
    }

    /// D2-04: a v2 artifact whose version-specific provenance section is
    /// MISSING (the field is optional, defaulting to None) is refused by
    /// `verify_integrity` the moment explicit sink exclusions are present
    /// — the governed provenance is required to attribute them. The
    /// MALFORMED provenance cases (unsupported source/program/commitment,
    /// bad ledger version, malformed digest) are covered by the
    /// provenance-tampering tests below.
    #[test]
    fn a_v2_artifact_with_a_missing_provenance_section_cannot_verify_explicit_sinks() {
        let artifact = sealed_provenance_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        value.as_object_mut().unwrap().remove("provenance");
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        let err = tampered.verify_integrity().unwrap_err();
        assert!(
            matches!(err, SnapshotError::ArtifactMismatch(ref m) if m.contains("no provenance")),
            "the error must name the missing governed provenance: {err}"
        );
    }

    // -----------------------------------------------------------------
    // D2-03 provenance tampering: every provenance field category is
    // checked for supported values and internal consistency. Changing a
    // provenance field to an unsupported or inconsistent value must make
    // `verify_integrity` fail, deterministically.
    // -----------------------------------------------------------------

    /// Locker evidence SOURCE: only `"rpc"` is supported.
    #[test]
    fn provenance_tampering_rejects_an_unsupported_lock_evidence_source() {
        let artifact = sealed_provenance_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        value["provenance"]["lock_evidence"]["source"] = serde_json::Value::from("memory");
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        let err = tampered.verify_integrity().unwrap_err();
        assert!(matches!(
            err,
            SnapshotError::ArtifactMismatch(ref m) if m.contains("lock_evidence.source")
        ));
    }

    /// Locker PROGRAM IDENTITY: only the UNCX locker program this
    /// implementation actually recognizes is supported.
    #[test]
    fn provenance_tampering_rejects_an_unsupported_locker_program_id() {
        let artifact = sealed_provenance_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        // A syntactically valid but unsupported program id.
        value["provenance"]["lock_evidence"]["program_id"] =
            serde_json::Value::from(key(0xEE).to_string());
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        let err = tampered.verify_integrity().unwrap_err();
        assert!(matches!(
            err,
            SnapshotError::ArtifactMismatch(ref m) if m.contains("lock_evidence.program_id")
        ));
    }

    /// Locker PROGRAM IDENTITY, malformed variant: a non-base58 string is
    /// rejected as well.
    #[test]
    fn provenance_tampering_rejects_a_malformed_locker_program_id() {
        let artifact = sealed_provenance_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        value["provenance"]["lock_evidence"]["program_id"] =
            serde_json::Value::from("not-a-base58-pubkey!");
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    /// COMMITMENT: only the levels explicitly supported for claims-grade
    /// construction are accepted.
    #[test]
    fn provenance_tampering_rejects_an_unsupported_commitment() {
        let artifact = sealed_provenance_artifact();
        for bad in ["processed", "latest", "", "Confirmed"] {
            let mut value: serde_json::Value =
                serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
            value["provenance"]["lock_evidence"]["commitment"] = serde_json::Value::from(bad);
            let tampered =
                SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
            let err = tampered.verify_integrity().unwrap_err();
            assert!(
                matches!(
                    err,
                    SnapshotError::ArtifactMismatch(ref m) if m.contains("lock_evidence.commitment")
                ),
                "commitment `{bad}` must be refused"
            );
        }
    }

    /// ANCHOR SLOT: a zero anchor slot is internally inconsistent — the
    /// builder never anchors a snapshot to a fabricated/missing slot.
    #[test]
    fn provenance_tampering_rejects_a_zero_anchor_slot() {
        let artifact = sealed_provenance_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        value["provenance"]["lock_evidence"]["anchor_slot"] = serde_json::Value::from(0);
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    /// SINK-LEDGER provenance: the schema version must be the supported
    /// one.
    #[test]
    fn provenance_tampering_rejects_an_unsupported_ledger_schema_version() {
        let artifact = sealed_provenance_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        value["provenance"]["sink_ledger"]["schema_version"] = serde_json::Value::from(2);
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        let err = tampered.verify_integrity().unwrap_err();
        assert!(matches!(
            err,
            SnapshotError::ArtifactMismatch(ref m) if m.contains("schema_version")
        ));
    }

    /// SINK-LEDGER provenance: the ledger identity must be present.
    #[test]
    fn provenance_tampering_rejects_an_empty_ledger_identity() {
        let artifact = sealed_provenance_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        value["provenance"]["sink_ledger"]["ledger_id"] = serde_json::Value::from("   ");
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        let err = tampered.verify_integrity().unwrap_err();
        assert!(matches!(
            err,
            SnapshotError::ArtifactMismatch(ref m) if m.contains("ledger_id")
        ));
    }

    /// INPUT DIGEST: the SHA-256 representation must be a lowercase
    /// 64-hex-character string.
    #[test]
    fn provenance_tampering_rejects_malformed_input_digests() {
        let artifact = sealed_provenance_artifact();
        let valid_digest = artifact
            .provenance
            .as_ref()
            .unwrap()
            .sink_ledger
            .as_ref()
            .unwrap()
            .input_sha256
            .clone();
        let cases = [
            ("deadbeef".to_string(), "too short"),
            ("0".repeat(63), "one character short"),
            (format!("{}g", &valid_digest[..63]), "non-hex character"),
            (valid_digest.to_uppercase(), "uppercase digest"),
        ];
        for (digest, why) in cases {
            let mut value: serde_json::Value =
                serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
            value["provenance"]["sink_ledger"]["input_sha256"] =
                serde_json::Value::from(digest.clone());
            let tampered =
                SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
            let err = tampered.verify_integrity().unwrap_err();
            assert!(
                matches!(
                    err,
                    SnapshotError::ArtifactMismatch(ref m) if m.contains("input_sha256")
                ),
                "digest `{why}` must be refused"
            );
        }
    }

    /// CROSS-FIELD: an internally consistent but content-drifting anchor
    /// slot disagrees with the artifact's own snapshot slot.
    #[test]
    fn provenance_tampering_rejects_an_anchor_slot_disagreeing_with_the_artifact() {
        let artifact = sealed_provenance_artifact();
        let mut value: serde_json::Value =
            serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
        value["provenance"]["lock_evidence"]["anchor_slot"] =
            serde_json::Value::from(artifact.snapshot_slot + 1);
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn verify_integrity_catches_a_tampered_exclusion_ledger() {
        let artifact = sealed_provenance_artifact();
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
        let artifact = sealed_provenance_artifact();
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
        let snapshot = standard_snapshot();
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
        let artifact = sealed_artifact();
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
        let artifact = sealed_provenance_artifact();
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
        let artifact = sealed_provenance_artifact();
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
        let artifact = sealed_provenance_artifact();
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
