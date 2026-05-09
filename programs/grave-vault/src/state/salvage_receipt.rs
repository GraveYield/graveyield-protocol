// SPDX-License-Identifier: Apache-2.0
//
// SalvageReceipt PDA — issued at the end of a successful salvage_pool call.
// Records the 40/40/20 distribution amounts for downstream indexing and
// observability. Read-only after issuance.
//
// Seeds: [b"salvage_receipt", pool_address]

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct SalvageReceipt {
    pub pool_address: Pubkey,
    pub salvor: Pubkey,

    /// Amount routed to `lp_holder_pool_vault` (lamports).
    pub lp_holder_amount_lamports: u64,

    /// Amount paid out to the salvor (lamports).
    pub salvor_amount_lamports: u64,

    /// Amount routed to the protocol treasury (lamports).
    pub protocol_amount_lamports: u64,

    /// Total quote-side proceeds before split (= sum of the three above).
    pub total_proceeds_lamports: u64,

    /// Slot at which the receipt was issued.
    pub issued_at_slot: u64,

    /// Unix timestamp when issued.
    pub issued_at_ts: i64,

    /// Bump for [b"salvage_receipt", pool_address].
    pub bump: u8,

    /// Reserved.
    pub _reserved: [u8; 32],
}

impl SalvageReceipt {
    pub const SEED: &'static [u8] = b"salvage_receipt";
}
