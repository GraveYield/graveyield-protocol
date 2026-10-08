// SPDX-License-Identifier: Apache-2.0
//
// Snapshot data model. Every aggregate carries enough ledger context that a
// third party can recompute the snapshot from the same inputs and compare
// it field-by-field — the determinism contract is the snapshot's audit
// story (spec §6.3: the on-chain verifier cannot detect a wrong root
// supply chain, so the producer must be verifiable instead of trusted).

use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;

use crate::error::SnapshotError;

/// One claimant in the snapshot: the holder pubkey and its LP balance at
/// the snapshot point.
///
/// Ordering is canonical: `Ord` derives to (owner bytes, balance), and the
/// builder guarantees unique owners, so a serialized entry list is sorted
/// by owner bytes ascending.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct HolderEntry {
    pub owner: Pubkey,
    pub lp_balance: u64,
}

/// Why a balance is present in the exclusion ledger instead of the leaf set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExclusionReason {
    /// Zero-balance token account — nothing to claim; listed so every
    /// enumerated account is accounted for.
    ZeroBalance,
    /// Operator-declared sink owner (incinerator-style account that can
    /// never sign a claim). Its balance is deducted from the leaf set and
    /// appears in the reconciliation as unclaimable supply.
    ExplicitSink,
}

/// A balance that was deliberately kept out of the leaf set, with its
/// reason. Burned LP does NOT appear here — burned tokens are gone from
/// circulation and therefore never enumerate in the first place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExcludedBalance {
    pub owner: Pubkey,
    pub lp_balance: u64,
    pub reason: ExclusionReason,
}

/// One SPL token account holding the snapshot's LP mint, as served by the
/// enumeration source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenAccountSnapshot {
    /// The token account's own address.
    pub address: Pubkey,
    /// The token account's `owner` field — who controls the balance.
    pub owner: Pubkey,
    /// Raw token amount (LP tokens are typically 9-decimals; no decimal
    /// scaling is applied anywhere in the claims path — the on-chain
    /// pro-rata math uses raw units against raw supply).
    pub amount: u64,
}

/// The LP mint's supply at the snapshot slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MintSupply {
    pub amount: u64,
    /// Slot at which the source served this value; recorded as the
    /// snapshot slot. The on-chain supply pin (`InvalidSnapshotData`) is
    /// the final integrity anchor at salvage time.
    pub slot: u64,
}

/// How the custody account was identified during locked-LP resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CustodyMatchMethod {
    /// Exactly one enumerated account held exactly `Σ current_locked_amount`.
    ExactBalanceMatch,
    /// Several accounts matched; `custody_owner_overrides` resolved it.
    ExplicitOverride,
}

/// The resolved custody account that physically holds the locked LP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustodyResolution {
    pub token_account: Pubkey,
    pub owner: Pubkey,
    /// Always equal to the report's `total_locked` (reconciliation gate).
    pub balance: u64,
    pub method: CustodyMatchMethod,
}

/// Locked-LP resolution report: beneficial-owner attributions that were
/// merged into the leaf set, plus the custody account they were lifted
/// from. Attributions are sorted by owner bytes (same canonical order as
/// the leaf set).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockedReport {
    /// Number of validated TokenLock records behind the attributions.
    pub lock_records_seen: usize,
    /// `Σ current_locked_amount` across all validated locks.
    pub total_locked: u64,
    /// Per-beneficial-owner locked totals (may share owners with the leaf
    /// set — the builder merges locked and unlocked balances).
    pub attributions: Vec<HolderEntry>,
    /// The custody account the locked tokens were attributed away from,
    /// or `None` when nothing is locked.
    pub custody: Option<CustodyResolution>,
}

/// Closing the token ledger: every enumerated token is either a claimable
/// leaf, an unclaimable declared sink, or locked-but-attributed (which
/// re-enters the leaf set). The builder enforces
/// `entries_total + sink_exclusions_total == enumerated_total == supply`.
///
/// `Serialize`/`Deserialize` because the sealed snapshot artifact carries
/// the reconciliation so readers can audit the conservation identity
/// without re-enumerating (spec D12).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reconciliation {
    /// Sum of all enumerated token-account balances — enforced equal to
    /// `lp_total_supply_at_snapshot` (`SupplyMismatch` otherwise).
    pub enumerated_total: u64,
    /// Sum of the leaf-set balances.
    pub entries_total: u64,
    /// Sum of `ExclusionReason::ExplicitSink` balances (zero-balance
    /// exclusions contribute nothing and are ledger entries only).
    pub sink_exclusions_total: u64,
}

/// The finished snapshot: the deterministic input to the Phase 5.2 Merkle
/// tree builder and, via the tree root, to `salvage_pool`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LpSnapshot {
    pub pool_address: Pubkey,
    pub amm_program_id: Pubkey,
    pub lp_mint: Pubkey,
    pub snapshot_slot: u64,
    pub lp_total_supply_at_snapshot: u64,
    /// The leaf set — sorted by owner bytes ascending, unique owners,
    /// strictly positive balances.
    pub entries: Vec<HolderEntry>,
    /// Exclusion ledger — ascending owner bytes (BTreeMap pass order).
    pub exclusions: Vec<ExcludedBalance>,
    pub locked: LockedReport,
    pub reconciliation: Reconciliation,
}

impl LpSnapshot {
    /// Defense-in-depth validation of the determinism invariants on the
    /// leaf set. The builder upholds them by construction; this re-check
    /// keeps a future builder refactor from silently shipping a
    /// non-canonical snapshot.
    pub(crate) fn validate_entries(entries: &[HolderEntry]) -> Result<(), SnapshotError> {
        if entries.is_empty() {
            return Err(SnapshotError::EmptySnapshot);
        }
        for pair in entries.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            if a.owner >= b.owner {
                return Err(SnapshotError::InvariantViolated(format!(
                    "entries not canonically sorted / unique at owner {}",
                    a.owner
                )));
            }
            if a.lp_balance == 0 {
                return Err(SnapshotError::InvariantViolated(format!(
                    "zero-balance entry for owner {} reached the leaf set",
                    a.owner
                )));
            }
        }
        if entries.last().is_some_and(|e| e.lp_balance == 0) {
            return Err(SnapshotError::InvariantViolated(
                "zero-balance final entry reached the leaf set".to_string(),
            ));
        }
        Ok(())
    }
}
