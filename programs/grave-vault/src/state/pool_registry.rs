// SPDX-License-Identifier: Apache-2.0
//
// PoolRegistry PDA — created by salvage_pool, records the salvage state for
// a given AMM pool. Supports idempotency: a second salvage_pool call against
// the same pool fails because this PDA already exists.
//
// Seeds: [b"pool_registry", pool_address]
//
// =====================================================================
// Salvage lifecycle (one PDA per pool, init-once idempotency gate):
// =====================================================================
//
//   none ──salvage_pool──> settled (Merkle root + lp_total_supply sealed,
//                            lp_holder_pool_total_lamports stamped)
//                              │
//           ┌──────────────────┴───────────────────┐
//           v                                      v
//       claim_lp_proceeds                      (no further salvage)
//       (per-holder, drains                    — the PDA's existence
//        lp_holder_pool_vault;                 is the idempotency gate;
//        cumulative claimed                    a second salvage_pool
//        tracked here for                      on the same pool reverts
//        conservation)                         at the `init` constraint)
//
// The Merkle root is sealed at salvage time and is immutable thereafter.
// `lp_holder_pool_claimed_lamports` is the only post-init mutation path
// (incremented by each `claim_lp_proceeds`); the conservation check
// (`claimed <= total`) is re-asserted on every claim so cumulative
// rounding drift across holders can never push the bucket negative.

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct PoolRegistry {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub salvor: Pubkey,

    /// 32-byte Merkle root of the LP holder snapshot at salvage time.
    /// Sealed by `salvage_pool`; the root is the authoritative holder
    /// set for every subsequent `claim_lp_proceeds` proof verification.
    pub lp_snapshot_merkle_root: [u8; 32],

    /// Total LP token supply at snapshot. Used to compute pro-rata claims.
    pub lp_total_supply_at_snapshot: u64,

    /// Total quote-side proceeds available to the LP holder pool (lamports).
    /// Stamped at salvage; never mutated post-init.
    pub lp_holder_pool_total_lamports: u64,

    /// Cumulative claimed by LP holders (lamports). Cannot exceed
    /// `lp_holder_pool_total_lamports` — re-asserted on every claim.
    pub lp_holder_pool_claimed_lamports: u64,

    /// Slot at which the salvage was executed.
    pub salvaged_at_slot: u64,

    /// Unix timestamp when salvaged.
    pub salvaged_at_ts: i64,

    /// Bump for [b"pool_registry", pool_address].
    pub bump: u8,

    /// Reserved.
    pub _reserved: [u8; 64],
}

impl PoolRegistry {
    pub const SEED: &'static [u8] = b"pool_registry";

    /// Lamports still claimable by LP holders: total stamped at salvage
    /// minus cumulative claimed. Saturating at 0 is safe because the
    /// conservation check in `claim_lp_proceeds` re-asserts
    /// `claimed <= total` on every claim, so a well-formed registry can
    /// never go negative; this is a read-side convenience for indexers
    /// and dashboards, not a security boundary.
    pub fn remaining_lamports(&self) -> u64 {
        self.lp_holder_pool_total_lamports
            .saturating_sub(self.lp_holder_pool_claimed_lamports)
    }

    /// True iff the LP holder pool has been fully drained — cumulative
    /// claimed equals total. Indexers use this to mark a pool's claim
    /// window as closed; the on-chain `claim_lp_proceeds` path does NOT
    /// gate on this (a zero-remaining claim would still pass the Merkle
    /// proof and the conservation check, then transfer 0 lamports —
    /// the per-holder `ClaimRecord` init is the actual double-claim gate).
    pub fn is_fully_claimed(&self) -> bool {
        self.lp_holder_pool_claimed_lamports >= self.lp_holder_pool_total_lamports
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(total: u64, claimed: u64) -> PoolRegistry {
        PoolRegistry {
            amm_program_id: Pubkey::default(),
            pool_address: Pubkey::default(),
            salvor: Pubkey::default(),
            lp_snapshot_merkle_root: [0u8; 32],
            lp_total_supply_at_snapshot: 1_000_000,
            lp_holder_pool_total_lamports: total,
            lp_holder_pool_claimed_lamports: claimed,
            salvaged_at_slot: 0,
            salvaged_at_ts: 0,
            bump: 0,
            _reserved: [0u8; 64],
        }
    }

    /// `remaining_lamports()` is a read-side convenience for indexers.
    /// Saturates at 0 so a corrupted registry cannot underflow; the
    /// on-chain conservation check is the actual security boundary.
    #[test]
    fn remaining_lamports_saturates_at_zero() {
        let r = registry(1_000, 400);
        assert_eq!(r.remaining_lamports(), 600);

        let r = registry(1_000, 1_000);
        assert_eq!(r.remaining_lamports(), 0);

        // Defensive: a corrupted registry (claimed > total) reports 0
        // rather than underflowing. The on-chain claim path would have
        // rejected the claim that pushed claimed past total, so this is
        // belt-and-suspenders for read-side consumers.
        let r = registry(1_000, 1_500);
        assert_eq!(r.remaining_lamports(), 0);
    }

    /// `is_fully_claimed()` flips at the total/claimed boundary. Used by
    /// indexers to close a pool's claim window in dashboards; the
    /// on-chain path does not gate on it.
    #[test]
    fn is_fully_claimed_boundary() {
        let r = registry(1_000, 999);
        assert!(!r.is_fully_claimed());

        let r = registry(1_000, 1_000);
        assert!(r.is_fully_claimed());

        // Defensive: over-claimed also reports true (claim window closed).
        let r = registry(1_000, 1_500);
        assert!(r.is_fully_claimed());
    }

    /// Layout stability: the registry's serialized footprint must not
    /// drift without a program upgrade. Pins the total serialized size
    /// against accidental field reordering or `_reserved` carve-outs.
    /// Mirrors `SalvageReceipt::receipt_layout_offsets_are_stable` and
    /// the GraveScanner state PDAs' layout pins.
    #[test]
    fn account_layout_is_stable() {
        // 8 (Anchor discriminator) + INIT_SPACE.
        let expected_space = 8
            + 32 // amm_program_id
            + 32 // pool_address
            + 32 // salvor
            + 32 // lp_snapshot_merkle_root
            + 8 // lp_total_supply_at_snapshot
            + 8 // lp_holder_pool_total_lamports
            + 8 // lp_holder_pool_claimed_lamports
            + 8 // salvaged_at_slot
            + 8 // salvaged_at_ts
            + 1 // bump
            + 64; // _reserved
        assert_eq!(8 + PoolRegistry::INIT_SPACE, expected_space);
    }

    /// Borsh roundtrip preserves every field. The registry is mutated
    /// in place by every `claim_lp_proceeds` (claimed counter
    /// increment), so a serialization drift would corrupt the
    /// cumulative-claimed accounting and break the conservation check.
    #[test]
    fn borsh_roundtrip_preserves_registry_state() {
        let mut r = registry(1_000_000, 400_000);
        r.amm_program_id = Pubkey::new_unique();
        r.pool_address = Pubkey::new_unique();
        r.salvor = Pubkey::new_unique();
        r.lp_snapshot_merkle_root = [0xABu8; 32];
        r.lp_total_supply_at_snapshot = 9_999_999;
        r.salvaged_at_slot = 250_000_000;
        r.salvaged_at_ts = 1_700_000_000;
        r.bump = 253;

        let bytes = borsh::to_vec(&r).expect("borsh serialize");
        let d = PoolRegistry::try_from_slice(&bytes).expect("borsh deserialize");

        assert_eq!(d.amm_program_id, r.amm_program_id);
        assert_eq!(d.pool_address, r.pool_address);
        assert_eq!(d.salvor, r.salvor);
        assert_eq!(d.lp_snapshot_merkle_root, [0xABu8; 32]);
        assert_eq!(d.lp_total_supply_at_snapshot, 9_999_999);
        assert_eq!(d.lp_holder_pool_total_lamports, 1_000_000);
        assert_eq!(d.lp_holder_pool_claimed_lamports, 400_000);
        assert_eq!(d.remaining_lamports(), 600_000);
        assert!(!d.is_fully_claimed());
        assert_eq!(d.salvaged_at_slot, 250_000_000);
        assert_eq!(d.salvaged_at_ts, 1_700_000_000);
        assert_eq!(d.bump, 253);
        assert_eq!(bytes.len(), PoolRegistry::INIT_SPACE);
    }
}
