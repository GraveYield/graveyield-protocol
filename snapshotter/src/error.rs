// SPDX-License-Identifier: Apache-2.0
//
// Snapshot errors. Fail-closed by design: every variant aborts the
// snapshot instead of producing a root the operator cannot audit.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotError {
    /// The underlying data source failed (RPC transport error, account
    /// fetch error, unsupported query, ...).
    Source(String),
    /// The mint's recorded supply disagrees with the sum of all enumerated
    /// token-account balances. A complete SPL token-account enumeration
    /// always satisfies `Σ balances == mint.supply`; a mismatch means the
    /// enumeration was served from inconsistent state (or is incomplete)
    /// and must not be sealed into a Merkle root.
    SupplyMismatch {
        mint_supply: u64,
        enumerated_total: u64,
    },
    /// `Σ current_locked_amount > 0` but the enumeration contains no single
    /// custody account holding exactly that amount.
    CustodyNotFound { locked_total: u64 },
    /// More than one enumerated account holds exactly the locked total and
    /// no `custody_owner_overrides` entry resolves the ambiguity.
    CustodyAmbiguous {
        locked_total: u64,
        candidates: usize,
    },
    /// A TokenLock record failed structural validation (size,
    /// discriminator, PDA re-derivation, or (amm_id, lp_mint) binding).
    LockRecordInvalid { address: String, reason: String },
    /// A lock's beneficial owner is the custody account itself; attributing
    /// the claim to a program-derived account would strand it.
    LockOwnerIsCustody { owner: String },
    /// The custody owner was excluded before attribution (e.g. declared as
    /// a sink) — a misconfiguration, since locked LP must re-enter the leaf
    /// set via its lock owners.
    CustodyExcludedAsSink,
    /// The snapshot contains no claimable entries (e.g. a zero-supply mint
    /// or a fully-excluded holder set). The on-chain side rejects zero
    /// supply snapshots (`InvalidSnapshotData`); the snapshotter refuses to
    /// produce one in the first place.
    EmptySnapshot,
    /// An internal invariant was violated. This is a bug, not an input
    /// problem — the snapshot is aborted.
    InvariantViolated(String),
    /// Arithmetic overflow while aggregating balances.
    Overflow,
    /// Snapshot artifact (de)serialization failed (JSON structure or hex
    /// field encoding).
    Serialization(String),
    /// A sealed artifact disagrees with the tree/snapshot it claims to
    /// represent: root, leaf, proof, count, depth, format version, or the
    /// closing reconciliation identity failed to re-derive. The artifact
    /// is refused instead of published.
    ArtifactMismatch(String),
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Source(msg) => write!(f, "data source failure: {msg}"),
            Self::SupplyMismatch {
                mint_supply,
                enumerated_total,
            } => write!(
                f,
                "enumerated balance total {enumerated_total} != mint supply {mint_supply}; \
                 enumeration is incomplete or inconsistent"
            ),
            Self::CustodyNotFound { locked_total } => write!(
                f,
                "locked total {locked_total} but no enumerated account holds exactly \
                 that amount — custody account missing from the enumeration"
            ),
            Self::CustodyAmbiguous {
                locked_total,
                candidates,
            } => write!(
                f,
                "{candidates} accounts hold exactly the locked total {locked_total}; \
                 supply custody_owner_overrides to disambiguate"
            ),
            Self::LockRecordInvalid { address, reason } => {
                write!(f, "invalid TokenLock {address}: {reason}")
            }
            Self::LockOwnerIsCustody { owner } => write!(
                f,
                "TokenLock owner {owner} is the custody account itself; \
                 attributing to a PDA would strand the claim"
            ),
            Self::CustodyExcludedAsSink => write!(
                f,
                "custody owner was excluded as a sink before attribution; locked LP \
                 must re-enter the leaf set via its lock owners"
            ),
            Self::EmptySnapshot => write!(
                f,
                "snapshot has no claimable entries; refusing to produce an empty root"
            ),
            Self::InvariantViolated(msg) => write!(f, "internal invariant violated: {msg}"),
            Self::Overflow => write!(f, "arithmetic overflow while aggregating balances"),
            Self::Serialization(msg) => write!(f, "artifact serialization failure: {msg}"),
            Self::ArtifactMismatch(msg) => write!(
                f,
                "sealed artifact does not derive from its own entries: {msg}"
            ),
        }
    }
}

impl std::error::Error for SnapshotError {}
