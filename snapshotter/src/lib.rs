// SPDX-License-Identifier: Apache-2.0
//
// grave-snapshotter — the off-chain LP-holder snapshotter (Phase 5.1).
//
// ROLE IN THE LIFECYCLE
//
// The on-chain claims path (`claim_lp_proceeds`) verifies a sorted-pair
// Merkle proof of `(lp_holder, lp_balance_at_snapshot)` against a root that
// `salvage_pool` seals into `PoolRegistry` at salvage time, and computes the
// payout as `floor(lp_holder_pool_lamports × balance / lp_total_supply_at_snapshot)`.
// The fork harness (Phase 4) proved that economics end-to-end with a forged
// snapshot — this crate is the real snapshot producer the harness stood in
// for (`tests/README.md`: "the snapshotter itself is a Phase 5 deliverable").
//
// SNAPSHOT POINT (normative)
//
// The snapshot is taken BEFORE the salvage: the root and
// `lp_total_supply_at_snapshot` are submitted to `salvage_pool`, which pins
// the supply against the live `lp_mint.supply` (`InvalidSnapshotData`). A
// pre-salvage snapshot is the only defensible point — it captures every LP
// token that the salvage will convert, including the tokens the salvor burns
// to execute it.
//
// POLICIES (spec rev 1.8.0, D11)
//
// 1. Burned LP needs no exclusion: burned tokens are gone from circulation,
//    so they never appear as a balance. The snapshot enforces the SPL
//    invariant `Σ enumerated balances == lp_mint.supply` as a hard check
//    (`SupplyMismatch`), which proves the enumeration is complete.
// 2. The salvor's pre-burn balance is INCLUDED like any other holder. The
//    on-chain denominator is the full pre-burn supply; excluding the
//    salvor's share from the numerator would permanently strand that
//    fraction of the LP bucket (it could never be claimed by anyone).
// 3. Locked LP (UNCX Raydium V4 locker) is attributed to the beneficial
//    owner recorded in each `TokenLock.lock_owner`, not to the custody
//    account that happens to hold the tokens (a PDA can never sign a
//    claim). The custody account is identified by exact-balance
//    reconciliation — its balance must equal `Σ current_locked_amount`
//    (the 74/74 mainnet reconciliation pattern from LOCKER-001) — and is
//    fail-closed: ambiguity or a missing custody account aborts the
//    snapshot rather than guessing.
// 4. Zero-balance accounts and operator-declared sink owners (incinerator
//    style accounts that can never sign a claim) are excluded from the
//    leaf set and recorded in an explicit exclusion ledger, so every token
//    of supply is accounted for: `entries_total + sink_exclusions_total ==
//    enumerated_total == supply`.
//
// DETERMINISM CONTRACT
//
// Given the same underlying ledger state, `SnapshotBuilder::build` returns
// a bit-identical snapshot: per-owner aggregation over a `BTreeMap`
// (ascending pubkey byte order), lock records sorted by address before
// aggregation, fixed ledger ordering (ascending owner bytes during the
// exclusion pass), and no timestamps, RNG, or ambient state in the output.
// Consumers can therefore recompute and cross-verify any published
// snapshot. The snapshot slot is recorded from the data source, and the
// on-chain supply pin at salvage time is the final integrity anchor: the
// verifier cannot detect a faithfully-verified-but-wrong root supply chain
// (spec §6.3), so the snapshotter is built to be re-runnable and auditable
// instead of trusted.
//
// PRE-MAINNET-TODO(SNAPSHOT): Merkle tree builder + proof generator + deterministic snapshot persistence (roadmap Phase 5.2) | reverts: N/A (off-chain; the on-chain verifier rejects bad proofs) | verify: tree output must satisfy grave_vault::merkle::verify_proof and match the fork-suite convention (odd node promotes)

pub mod builder;
pub mod error;
pub mod locked;
pub mod model;
pub mod rpc;
pub mod source;

pub use builder::{SnapshotBuilder, SnapshotRequest};
pub use error::SnapshotError;
pub use locked::{InMemoryLocks, LockedLpEvidence, TokenLockRecord};
pub use model::{
    CustodyMatchMethod, CustodyResolution, ExcludedBalance, ExclusionReason, HolderEntry,
    LockedReport, LpSnapshot, MintSupply, Reconciliation, TokenAccountSnapshot,
};
pub use source::{InMemorySource, LpAccountSource};
