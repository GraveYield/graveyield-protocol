// SPDX-License-Identifier: Apache-2.0
//
// LaunchPrice PDA — captures a pool's reference launch price for the
// Criterion 2 ≥99% price-collapse check. Written once per pool, and ONLY
// from an oracle-signed attestation (ORACLE-001, Phase 1.3 / spec D9) —
// caller-supplied prices revert.
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

    /// Mint of the base token (the one being measured). Bound by the
    /// attestation; re-checked against the live pool's parsed mints by
    /// both evaluate_pool handlers before C2 can consume the price.
    pub base_mint: Pubkey,

    /// Mint of the quote token (typically WSOL or USDC). Bound by the
    /// attestation and re-checked alongside `base_mint`.
    pub quote_mint: Pubkey,

    /// Price in fixed-point Q64.64 representation. Sufficient for ≥99% drop math.
    pub launch_price_q64x64: u128,

    /// Slot of the pool's first successful swap — the instant the price
    /// baseline was established (attested; ORACLE-001 / spec D9).
    pub first_swap_slot: u64,

    /// Unix timestamp of the pool's first successful swap (attested).
    pub first_swap_unix_ts: i64,

    /// Slot at which the launch price was recorded on chain.
    pub recorded_slot: u64,

    /// Unix timestamp when recorded.
    pub recorded_at: i64,

    /// Bump for [b"launch_price", amm_program_id, pool_address].
    pub bump: u8,

    /// Reserved for future upgrades.
    pub _reserved: [u8; 16],
}

impl LaunchPrice {
    pub const SEED: &'static [u8] = b"launch_price";
}
