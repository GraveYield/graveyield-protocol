// SPDX-License-Identifier: Apache-2.0
//
// EligibilityAnchor PDA — written by Phase 1 of evaluate_pool, consumed by
// Phase 2 (certify). v4.0 introduces the two-phase model.
//
// Seeds: [b"eligibility_anchor", amm_program_id, pool_address]
//
// =====================================================================
// Anchor lifecycle (ORACLE — spec D10, Phase 1.4):
// =====================================================================
//
//   none ──Phase 1 pass──> written (criteria_bitmap == ALL_CRITERIA_MASK,
//                            first_eligible_epoch stamped)
//                              │
//           ┌──────────────────┼───────────────────┐
//           v                  v                   v
//       Phase 2 cert       multisig           staleness window
//       issued (cert       invalidates        elapses — anyone may
//       carries TTL;       anchor before      sweep & reclaim rent
//       anchor stays       Phase 2 (Anchor-   (sweep_stale_anchor).
//       live in place)     Invalidated 6017)  A swept anchor can be
//                              │               re-created by a fresh
//                              v               Phase 1 run.
//                         Phase 2 refuse:
//                         AnchorInvalidated.
//
// The anchor is a *staging* record: it carries no salvage authority and
// no TTL. Once written it lives on-chain until either (a) Phase 2
// promotes it to an EligibilityCert (the anchor itself is untouched —
// the cert is a separate PDA), (b) multisig invalidates it
// (`invalidate_anchor`), or (c) the staleness window elapses and any
// caller sweeps it for rent reclamation (`sweep_stale_anchor`). The
// `invalidated` flag is one-way: `invalidate_anchor` refuses to
// re-invalidate an already-invalidated anchor (refuses-first discipline,
// spec D10) so the audit trail records exactly one invalidation per
// anchor.
//
// The `criteria_bitmap` is the bridge between Phase 1 and Phase 2.
// Phase 1 stamps it with the live evaluator output (must equal
// `crate::criteria::ALL_CRITERIA_MASK` = 0x3F for the anchor to be
// worth writing); Phase 2 re-runs the evaluator and refuses to certify
// if its bitmap disagrees (`CriteriaBitmapMismatch`, 6011). This pins
// the definition of "derelict" across the two-phase gap.

use anchor_lang::prelude::*;

use crate::criteria::ALL_CRITERIA_MASK;

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
    /// One-way flag: `invalidate_anchor` refuses to re-invalidate an
    /// already-invalidated anchor (refuses-first, spec D10).
    pub invalidated: bool,

    /// Bitmap of the six derelict-pool criteria that passed at Phase 1.
    /// All six pass = `crate::criteria::ALL_CRITERIA_MASK` (0x3F). Phase 2
    /// must reproduce the same bitmap before promoting to an
    /// `EligibilityCert` (`CriteriaBitmapMismatch`, 6011, otherwise).
    pub criteria_bitmap: u8,

    /// Bump for [b"eligibility_anchor", amm_program_id, pool_address].
    pub bump: u8,

    /// Reserved for future upgrades.
    pub _reserved: [u8; 64],
}

impl EligibilityAnchor {
    pub const SEED: &'static [u8] = b"eligibility_anchor";

    /// True iff the anchor's criteria bitmap records all six derelict-pool
    /// criteria as passed. Phase 1 only writes an anchor when this will be
    /// true (the evaluator returns `PoolNotEligible`, 6001, otherwise), so
    /// a live anchor that fails this predicate signals a downstream bug or
    /// a hand-edited account. Phase 2 re-runs the evaluator rather than
    /// trusting this predicate, but readers (indexers, dashboards, audit
    /// tooling) can use it as a cheap integrity check.
    pub fn is_complete(&self) -> bool {
        self.criteria_bitmap == ALL_CRITERIA_MASK
    }

    /// True iff multisig has invalidated this anchor. Used by
    /// `invalidate_anchor` (refuses-first gate) and by `evaluate_pool_phase2`
    /// (refuses to certify an invalidated anchor with `AnchorInvalidated`,
    /// 6017). Exposed as a predicate so call-site `require!`s read as
    /// English rather than bare boolean negation.
    pub fn is_invalidated(&self) -> bool {
        self.invalidated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor() -> EligibilityAnchor {
        EligibilityAnchor {
            amm_program_id: Pubkey::default(),
            pool_address: Pubkey::default(),
            writer: Pubkey::default(),
            first_eligible_epoch: 0,
            written_at: 0,
            invalidated: false,
            criteria_bitmap: ALL_CRITERIA_MASK,
            bump: 0,
            _reserved: [0u8; 64],
        }
    }

    /// Phase 1 only writes an anchor when all six criteria pass. A live
    /// anchor therefore reports `is_complete() == true`. Pin the predicate
    /// to `ALL_CRITERIA_MASK` so a future mask extension (e.g., a seventh
    /// criterion) cannot silently flip this to false on existing anchors.
    #[test]
    fn is_complete_matches_all_criteria_mask() {
        let a = anchor();
        assert!(a.is_complete());

        let mut partial = anchor();
        partial.criteria_bitmap = ALL_CRITERIA_MASK & !crate::criteria::CRITERION_INACTIVITY;
        assert!(!partial.is_complete());

        let mut empty = anchor();
        empty.criteria_bitmap = 0;
        assert!(!empty.is_complete());
    }

    /// `is_invalidated()` mirrors the field read used by both
    /// `invalidate_anchor` (refuses-first) and `evaluate_pool_phase2`
    /// (AnchorInvalidated 6017). Pinning it keeps the two call sites
    /// aligned if the storage layout ever changes (e.g., a packed bit
    /// field replacing the standalone bool).
    #[test]
    fn is_invalidated_predicate_matches_field() {
        let mut a = anchor();
        assert!(!a.is_invalidated());
        a.invalidated = true;
        assert!(a.is_invalidated());
    }

    /// Layout stability: the anchor's serialized footprint must not drift
    /// without a program upgrade. Pins the total serialized size against
    /// accidental field reordering or `_reserved` carve-outs. Mirrors the
    /// cert's `account_layout_is_stable` test so a divergence between the
    /// two state PDAs surfaces here rather than at audit time.
    #[test]
    fn account_layout_is_stable() {
        // 8 (anchor discriminator) + INIT_SPACE.
        let expected_space = 8
            + 32 // amm_program_id
            + 32 // pool_address
            + 32 // writer
            + 8 // first_eligible_epoch
            + 8 // written_at
            + 1 // invalidated
            + 1 // criteria_bitmap
            + 1 // bump
            + 64; // _reserved
        assert_eq!(8 + EligibilityAnchor::INIT_SPACE, expected_space);
    }

    /// Borsh roundtrip preserves every field across a simulated
    /// invalidation write (the only post-init mutation path; Phase 1
    /// re-runs are blocked by `init` on the same PDA). Catches
    /// deserialization drift early — the same guarantee the cert's
    /// roundtrip test provides for reissue.
    #[test]
    fn borsh_roundtrip_preserves_anchor_state() {
        let mut a = anchor();
        a.amm_program_id = Pubkey::new_unique();
        a.pool_address = Pubkey::new_unique();
        a.writer = Pubkey::new_unique();
        a.first_eligible_epoch = 777;
        a.written_at = 1_700_000_000;
        a.criteria_bitmap = ALL_CRITERIA_MASK;
        a.bump = 254;
        // Simulate a multisig invalidation post-write.
        a.invalidated = true;

        let bytes = borsh::to_vec(&a).expect("borsh serialize");
        let d = EligibilityAnchor::try_from_slice(&bytes).expect("borsh deserialize");

        assert_eq!(d.amm_program_id, a.amm_program_id);
        assert_eq!(d.pool_address, a.pool_address);
        assert_eq!(d.writer, a.writer);
        assert_eq!(d.first_eligible_epoch, 777);
        assert_eq!(d.written_at, 1_700_000_000);
        assert!(d.is_invalidated());
        assert!(d.is_complete());
        assert_eq!(d.criteria_bitmap, ALL_CRITERIA_MASK);
        assert_eq!(d.bump, 254);
        assert_eq!(bytes.len(), EligibilityAnchor::INIT_SPACE);
    }
}
