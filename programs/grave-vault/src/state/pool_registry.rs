// SPDX-License-Identifier: Apache-2.0
//
// PoolRegistry PDA — created by salvage_pool, records the salvage state for
// a given AMM pool. Supports idempotency: a second salvage_pool call against
// the same pool fails because this PDA already exists.
//
// Seeds: [b"pool_registry", pool_address]

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct PoolRegistry {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub salvor: Pubkey,

    /// 32-byte Merkle root of the LP holder snapshot at salvage time.
    pub lp_snapshot_merkle_root: [u8; 32],

    /// Total LP token supply at snapshot. Used to compute pro-rata claims.
    pub lp_total_supply_at_snapshot: u64,

    /// Total quote-side proceeds available to the LP holder pool (lamports).
    pub lp_holder_pool_total_lamports: u64,

    /// Cumulative claimed by LP holders (lamports). Cannot exceed
    /// lp_holder_pool_total_lamports.
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
}
