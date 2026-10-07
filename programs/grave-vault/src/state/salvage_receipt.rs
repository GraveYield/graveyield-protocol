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

    // ---- Phase 4 (D6 dust policy) additions ----
    /// The memecoin (non-base) mint this salvage recovered. Recorded so
    /// `sweep_dust` can bind the submitted mint to the receipt instead of
    /// trusting the sweeper, and so the receipt fully identifies the
    /// salvage for indexing.
    pub memecoin_mint: Pubkey,

    /// Memecoin amount RETAINED in the vault memecoin ATA at the end of
    /// the salvage: the below-threshold dust when the conversion leg was
    /// skipped (D6), or the route residual when the swap leg ran but did
    /// not fully drain the ATA. Outside the 40/40/20 settlement — dust is
    /// "retained, unconverted", never counted as distributed proceeds.
    pub dust_memecoin_lamports: u64,

    /// Unix timestamp of the `sweep_dust` recovery, or 0 while the
    /// retained memecoin is still sitting in the vault memecoin ATA.
    pub dust_swept_at_ts: i64,

    /// Bump for [b"salvage_receipt", pool_address].
    pub bump: u8,

    /// Reserved.
    pub _reserved: [u8; 32],
}

impl SalvageReceipt {
    pub const SEED: &'static [u8] = b"salvage_receipt";
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the borsh layout byte-for-byte. The fork harnesses read receipt
    /// fields at raw offsets (72 / 80 / 88 / 96) to avoid a client-code
    /// dependency, and the indexer mirrors the layout — a silent field
    /// reorder would corrupt every downstream consumer. New fields append
    /// AFTER `issued_at_ts` and BEFORE `bump`; existing offsets never move.
    #[test]
    fn receipt_layout_offsets_are_stable() {
        let receipt = SalvageReceipt {
            pool_address: Pubkey::new_from_array([1u8; 32]),
            salvor: Pubkey::new_from_array([2u8; 32]),
            lp_holder_amount_lamports: 0xA1A1_A1A1_A1A1_A1A1,
            salvor_amount_lamports: 0xA2A2_A2A2_A2A2_A2A2,
            protocol_amount_lamports: 0xA3A3_A3A3_A3A3_A3A3,
            total_proceeds_lamports: 0xA4A4_A4A4_A4A4_A4A4,
            issued_at_slot: 0xA5A5_A5A5_A5A5_A5A5,
            issued_at_ts: 0x0A6A_6A6A_6A6A_6A6A,
            memecoin_mint: Pubkey::new_from_array([3u8; 32]),
            dust_memecoin_lamports: 0xA7A7_A7A7_A7A7_A7A7,
            dust_swept_at_ts: 0x0A8A_8A8A_8A8A_8A8A,
            bump: 255,
            _reserved: [0u8; 32],
        };
        let mut data = Vec::new();
        receipt.try_serialize(&mut data).unwrap();

        let u64_at = |off: usize| u64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        assert_eq!(u64_at(72), receipt.lp_holder_amount_lamports);
        assert_eq!(u64_at(80), receipt.salvor_amount_lamports);
        assert_eq!(u64_at(88), receipt.protocol_amount_lamports);
        assert_eq!(u64_at(96), receipt.total_proceeds_lamports);
        assert_eq!(u64_at(104), receipt.issued_at_slot);
        assert_eq!(u64_at(112) as i64, receipt.issued_at_ts);
        assert_eq!(&data[120..152], receipt.memecoin_mint.as_ref());
        assert_eq!(u64_at(152), receipt.dust_memecoin_lamports);
        assert_eq!(u64_at(160), receipt.dust_swept_at_ts as u64);
        assert_eq!(data[168], 255);
        assert_eq!(data.len(), 8 + 32 + 32 + 8 * 6 + 32 + 8 + 8 + 1 + 32);
    }
}
