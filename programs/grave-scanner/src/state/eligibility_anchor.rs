// SPDX-License-Identifier: Apache-2.0
//
// EligibilityAnchor PDA — written by Phase 1 of evaluate_pool, consumed by
// Phase 2 (certify). v4.0 introduces the two-phase model.
//
// Seeds: [b"eligibility_anchor", amm_program_id, pool_address]

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct EligibilityAnchor {
    /// Underlying AMM program (Raydium V4, Orca Whirlpool, Meteora, …).
    pub amm_program_id: Pubkey,

    /// AMM pool address this anchor is for.
    pub pool_address: Pubkey,

    /// Account that paid for and wrote this anchor. Rent returns here on close.
    pub writer: Pubkey,

    /// First Solana epoch in which this pool met all six criteria.
    pub first_eligible_epoch: u64,

    /// Unix timestamp when the anchor was written.
    pub written_at: i64,

    /// True if multisig invalidated this anchor before certification.
    pub invalidated: bool,

    /// Bump for [b"eligibility_anchor", amm_program_id, pool_address].
    pub bump: u8,

    /// Reserved for future upgrades.
    pub _reserved: [u8; 64],
}

impl EligibilityAnchor {
    pub const SEED: &'static [u8] = b"eligibility_anchor";
}
