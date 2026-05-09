// SPDX-License-Identifier: Apache-2.0
//
// LaunchPrice PDA — captures a pool's reference launch price for the
// Criterion 2 ≥99% price-collapse check. Written once per pool (Phase 0).
//
// Seeds: [b"launch_price", amm_program_id, pool_address]

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct LaunchPrice {
    /// Underlying AMM program.
    pub amm_program_id: Pubkey,

    /// AMM pool address this snapshot is for.
    pub pool_address: Pubkey,

    /// Mint of the base token (the one being measured).
    pub base_mint: Pubkey,

    /// Mint of the quote token (typically WSOL or USDC).
    pub quote_mint: Pubkey,

    /// Price in fixed-point Q64.64 representation. Sufficient for ≥99% drop math.
    pub launch_price_q64x64: u128,

    /// Slot at which the launch price was captured.
    pub recorded_slot: u64,

    /// Unix timestamp when recorded.
    pub recorded_at: i64,

    /// Bump for [b"launch_price", amm_program_id, pool_address].
    pub bump: u8,

    /// Reserved for future upgrades.
    pub _reserved: [u8; 32],
}

impl LaunchPrice {
    pub const SEED: &'static [u8] = b"launch_price";
}
