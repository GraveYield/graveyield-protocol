// SPDX-License-Identifier: Apache-2.0
//
// ClaimRecord PDA — created when an original LP holder withdraws their
// pro-rata share from `lp_holder_pool_vault`. Prevents double-claims.
//
// Seeds: [b"claim_record", pool_address, lp_holder]

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct ClaimRecord {
    pub pool_address: Pubkey,
    pub lp_holder: Pubkey,

    /// Lamports claimed by this holder.
    pub amount_lamports: u64,

    /// LP token balance at snapshot for this holder.
    pub lp_balance_at_snapshot: u64,

    /// Slot at which the claim was processed.
    pub claimed_at_slot: u64,

    /// Unix timestamp when claimed.
    pub claimed_at_ts: i64,

    /// Bump for [b"claim_record", pool_address, lp_holder].
    pub bump: u8,

    /// Reserved.
    pub _reserved: [u8; 32],
}

impl ClaimRecord {
    pub const SEED: &'static [u8] = b"claim_record";
}
