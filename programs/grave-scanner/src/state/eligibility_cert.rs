// SPDX-License-Identifier: Apache-2.0
//
// EligibilityCert PDA — written by Phase 2 of evaluate_pool. TTL = 1 hour.
// GraveVault consumes this PDA to authorise a salvage_pool call.
//
// Seeds: [b"eligibility_cert", amm_program_id, pool_address]

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct EligibilityCert {
    /// Underlying AMM program.
    pub amm_program_id: Pubkey,

    /// AMM pool address this cert is for.
    pub pool_address: Pubkey,

    /// Account that paid for and wrote this cert.
    pub writer: Pubkey,

    /// Epoch in which the originating EligibilityAnchor was written.
    pub anchor_epoch: u64,

    /// Epoch in which this cert was written (must be ≥ anchor_epoch + 2).
    pub cert_epoch: u64,

    /// Unix timestamp at which this cert was issued.
    pub issued_at: i64,

    /// Unix timestamp at which this cert expires (issued_at + 3600).
    pub expires_at: i64,

    /// Bitmap of the six derelict-pool criteria validated at Phase 2.
    /// MUST equal `crate::criteria::ALL_CRITERIA_MASK` (0x3F) and MUST
    /// match the originating EligibilityAnchor's bitmap.
    pub criteria_bitmap: u8,

    /// Bump for [b"eligibility_cert", amm_program_id, pool_address].
    pub bump: u8,

    /// Reserved for future upgrades.
    pub _reserved: [u8; 64],
}

impl EligibilityCert {
    pub const SEED: &'static [u8] = b"eligibility_cert";

    /// True if `now` is past `expires_at`. Used by GraveVault as a hard gate.
    pub fn is_expired(&self, now: i64) -> bool {
        now >= self.expires_at
    }
}
