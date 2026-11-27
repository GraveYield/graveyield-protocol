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
    /// The initial (or final) supply read carried no usable RPC context
    /// slot (slot 0 / missing context metadata). A snapshot without a real
    /// state anchor cannot be audited and is refused — no slot is ever
    /// fabricated.
    MissingStateContext,
    /// A pinned read was served from a state older than the anchor slot
    /// the snapshot was pinned to. The read is stale and the snapshot is
    /// aborted.
    StaleState { anchor_slot: u64, served_slot: u64 },
    /// The LP mint supply changed between the anchored initial read and
    /// the post-enumeration re-read. The two reads cannot describe one
    /// chain state; the snapshot is refused (fail-closed — no partial or
    /// "best-effort" snapshot is sealed).
    SupplyDrift {
        anchor_slot: u64,
        initial_supply: u64,
        final_supply: u64,
    },
    /// A governed sink ledger failed structural validation (malformed
    /// JSON, missing/empty required D-04-D fields, duplicate or ambiguous
    /// entries). The ledger is rejected in full — never partially applied.
    SinkLedgerInvalid(String),
    /// The sink ledger's schema version is not supported by this build.
    SinkLedgerUnsupportedVersion { found: u32, expected: u32 },
    /// The sink ledger (or one of its entries) does not match the snapshot
    /// request's pool / AMM program / LP mint identity.
    SinkLedgerIdentityMismatch(String),
    /// The sink ledger declares the same owner or token account more than
    /// once, or conflicts with the request's declared sink exclusions.
    SinkLedgerDuplicateEntry(String),
    /// The sink ledger's declared balance for an owner does not equal the
    /// owner's total enumerated balance.
    SinkLedgerBalanceMismatch {
        owner: String,
        ledger_balance: u64,
        enumerated_balance: u64,
    },
    /// The sink ledger declares an owner that is not present in the
    /// enumerated holder set.
    SinkLedgerEntryNotEnumerated { owner: String },
    /// The sink ledger's declared token account is not an enumerated
    /// account owned by the entry's owner carrying the full declared
    /// balance (a spread balance is ambiguous and rejected).
    SinkLedgerTokenAccountMismatch {
        owner: String,
        token_account: String,
    },
    /// The request's `sink_exclusions` and the governed ledger disagree.
    SinkLedgerConflict(String),
    /// The request declares nonempty `sink_exclusions` directly, WITHOUT
    /// the governed sink ledger. Sink exclusions may only come from a
    /// validated governed ledger (D-04-D / WD-07); direct declaration is
    /// a bypass of ledger validation and is rejected fail-closed — no
    /// claims-grade snapshot may contain exclusions that were not derived
    /// from the governed ledger.
    SinkExclusionsRequireLedger { declared: usize },
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
            Self::MissingStateContext => write!(
                f,
                "supply read served no usable context slot (slot 0); refusing to \
                 record a fabricated snapshot slot"
            ),
            Self::StaleState {
                anchor_slot,
                served_slot,
            } => write!(
                f,
                "pinned read served state at slot {served_slot}, older than the \
                 anchored slot {anchor_slot}; the RPC cannot establish the \
                 required consistency"
            ),
            Self::SupplyDrift {
                anchor_slot,
                initial_supply,
                final_supply,
            } => write!(
                f,
                "LP supply changed between the anchored reads at slot {anchor_slot}: \
                 initial {initial_supply}, post-enumeration {final_supply}; \
                 the enumeration does not represent one chain state"
            ),
            Self::SinkLedgerInvalid(msg) => {
                write!(f, "governed sink ledger rejected: {msg}")
            }
            Self::SinkLedgerUnsupportedVersion { found, expected } => write!(
                f,
                "unsupported sink ledger schema_version {found} (expected {expected}); \
                 refusing to interpret an unknown format"
            ),
            Self::SinkLedgerIdentityMismatch(msg) => {
                write!(f, "sink ledger identity mismatch: {msg}")
            }
            Self::SinkLedgerDuplicateEntry(msg) => {
                write!(f, "sink ledger duplicate/conflicting entry: {msg}")
            }
            Self::SinkLedgerBalanceMismatch {
                owner,
                ledger_balance,
                enumerated_balance,
            } => write!(
                f,
                "sink ledger balance for owner {owner} is {ledger_balance} but the \
                 enumerated total is {enumerated_balance}; reconciliation fails closed"
            ),
            Self::SinkLedgerEntryNotEnumerated { owner } => write!(
                f,
                "sink ledger declares owner {owner} but no token account for that owner \
                 was enumerated"
            ),
            Self::SinkLedgerTokenAccountMismatch {
                owner,
                token_account,
            } => write!(
                f,
                "sink ledger token account {token_account} for owner {owner} is not an \
                 enumerated account owned by that owner carrying the full declared balance"
            ),
            Self::SinkLedgerConflict(msg) => {
                write!(
                    f,
                    "sink ledger conflicts with the request's sink exclusions: {msg}"
                )
            }
            Self::SinkExclusionsRequireLedger { declared } => write!(
                f,
                "{declared} sink exclusion(s) declared directly without a governed sink \
                 ledger; sink exclusions require `sink_ledger` (D-04-D / WD-07) and are \
                 never accepted as a direct, ungoverned input — refusing the bypass"
            ),
        }
    }
}

impl std::error::Error for SnapshotError {}
