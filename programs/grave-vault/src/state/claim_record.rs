// SPDX-License-Identifier: Apache-2.0
//
// ClaimRecord PDA — created when an original LP holder withdraws their
// pro-rata share from `lp_holder_pool_vault`. Prevents double-claims.
//
// Seeds: [b"claim_record", pool_address, lp_holder]
//
// =====================================================================
// Claim lifecycle (Charter invariant: claim_lp_proceeds stays live
// during emergency pause — original LPs always recover their share):
// =====================================================================
//
//   none ──claim_lp_proceeds──> written (amount_lamports stamped,
//                                PDA exists = double-claim defense)
//                              │
//                              v
//                        one-shot: the PDA's existence is the
//                        canonical gate. A second claim by the same
//                        (pool, holder) pair fails at the `init`
//                        constraint before any lamports move — no
//                        arithmetic, no Merkle re-verification, no
//                        emission. The `init`-on-PDA pattern is the
//                        single source of truth for "has this holder
//                        claimed?".
//
// The Merkle root sealing the eligible holder set lives on
// `PoolRegistry`, not here — ClaimRecord only records what THIS holder
// claimed and when. Cumulative-claimed accounting (conservation check
// across holders) also lives on PoolRegistry; ClaimRecord is per-holder.

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct ClaimRecord {
    pub pool_address: Pubkey,
    pub lp_holder: Pubkey,

    /// Lamports claimed by this holder in this single claim.
    pub amount_lamports: u64,

    /// LP token balance at snapshot for this holder. Verified against
    /// the PoolRegistry's Merkle root in `claim_lp_proceeds` before
    /// this PDA is initialised; recorded here so the receipt is
    /// self-describing for indexers without a Merkle-proof replay.
    pub lp_balance_at_snapshot: u64,

    /// Slot at which the claim was processed.
    pub claimed_at_slot: u64,

    /// Unix timestamp when claimed.
    pub claimed_at_ts: i64,

    /// Bump for [b"claim_record", pool_address, lp_holder].
    pub bump: u8,

    /// Reserved for future upgrades. MUST remain zeroed until consumed.
    pub _reserved: [u8; 32],
}

impl ClaimRecord {
    pub const SEED: &'static [u8] = b"claim_record";
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Layout stability: the claim record's serialized footprint must
    /// not drift without a program upgrade. Pins the total serialized
    /// size against accidental field reordering or `_reserved` carve-outs.
    /// Mirrors the `SalvageReceipt::receipt_layout_offsets_are_stable`
    /// and GraveScanner `EligibilityCert::account_layout_is_stable`
    /// tests so a divergence between sibling state PDAs surfaces here
    /// rather than at audit time.
    #[test]
    fn account_layout_is_stable() {
        // 8 (Anchor discriminator) + INIT_SPACE.
        let expected_space = 8
            + 32 // pool_address
            + 32 // lp_holder
            + 8 // amount_lamports
            + 8 // lp_balance_at_snapshot
            + 8 // claimed_at_slot
            + 8 // claimed_at_ts
            + 1 // bump
            + 32; // _reserved
        assert_eq!(8 + ClaimRecord::INIT_SPACE, expected_space);
    }

    /// Borsh roundtrip preserves every field. The claim record is
    /// write-once (init-on-PDA), so this is the only serialization
    /// path; a drift here would corrupt every downstream indexer that
    /// decodes the PDA. Catches deserialization drift early — same
    /// guarantee `SalvageReceipt`'s roundtrip provides for the
    /// salvage path and `EligibilityAnchor`'s for the scanner path.
    #[test]
    fn borsh_roundtrip_preserves_claim_state() {
        let record = ClaimRecord {
            pool_address: Pubkey::new_from_array([0xA1u8; 32]),
            lp_holder: Pubkey::new_from_array([0xA2u8; 32]),
            amount_lamports: 0xA3A3_A3A3_A3A3_A3A3,
            lp_balance_at_snapshot: 0xA4A4_A4A4_A4A4_A4A4,
            claimed_at_slot: 0xA5A5_A5A5_A5A5_A5A5,
            claimed_at_ts: 0x0A6A_6A6A_6A6A_6A6A,
            bump: 254,
            _reserved: [0u8; 32],
        };

        let bytes = record.try_to_vec().expect("borsh serialize");
        let d = ClaimRecord::try_from_slice(&bytes).expect("borsh deserialize");

        assert_eq!(d.pool_address, record.pool_address);
        assert_eq!(d.lp_holder, record.lp_holder);
        assert_eq!(d.amount_lamports, record.amount_lamports);
        assert_eq!(d.lp_balance_at_snapshot, record.lp_balance_at_snapshot);
        assert_eq!(d.claimed_at_slot, record.claimed_at_slot);
        assert_eq!(d.claimed_at_ts, record.claimed_at_ts);
        assert_eq!(d.bump, 254);
        assert_eq!(d._reserved, [0u8; 32]);
        assert_eq!(bytes.len(), ClaimRecord::INIT_SPACE);
    }
}
