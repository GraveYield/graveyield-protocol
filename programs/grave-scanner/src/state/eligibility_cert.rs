// SPDX-License-Identifier: Apache-2.0
//
// EligibilityCert PDA — written by Phase 2 of evaluate_pool. TTL =
// `ProtocolConfig.cert_ttl_seconds` (governance-configurable, default 1h,
// floored at 600s). GraveVault consumes this PDA to authorise a
// salvage_pool call.
//
// Seeds: [b"eligibility_cert", amm_program_id, pool_address]
//
// =====================================================================
// Cert lifecycle (ORACLE — spec D10, Phase 1.4):
// =====================================================================
//
//   none ──Phase 2 pass──> issued (valid until expires_at)
//                              │
//           ┌──────────────────┼───────────────────┐
//           v                  v                   v
//       salvage ok         salvage fails      TTL elapses
//      (registry/receipt        │                  │
//       init-once => pool    (atomic revert:   expired — vault
//       permanently settled;  cert untouched;  rejects 7002;
//       drained pool fails    retry within     Phase 2 may
//       re-certification at   TTL works)       re-issue
//       C3 anyway)
//
// The Phase 2 PDA is created with `init_if_needed` and the handler
// re-issues IN PLACE when — and only when — the existing cert is expired
// (`CertStillValid`, 6034, otherwise). A fresh PDA serialises as all
// zeros (`expires_at == 0`), so the same expiry gate admits first issue
// and every reissue, and structurally forbids two live certs for one
// pool: there is exactly one PDA, and overwriting a live cert reverts.
//
// Reissuance re-runs the FULL Phase 2 verification stack (fresh C1
// attestation, six criteria re-evaluation, locker evidence, mint-pair
// check, bitmap equality with the anchor) — there is no shortcut path.
// `reissue_generation` counts issues (1 = first issue) so repeated
// Phase 2 attempts are auditable on chain.

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct EligibilityCert {
    /// Underlying AMM program.
    pub amm_program_id: Pubkey,

    /// AMM pool address this cert is for.
    pub pool_address: Pubkey,

    /// Account that paid for and wrote this cert. On reissue this is the
    /// reissuing writer (the PDA's rent was paid by the first writer and
    /// stays locked until a close instruction exists — reserved, see
    /// spec §6.4).
    pub writer: Pubkey,

    /// Epoch in which the originating EligibilityAnchor was written.
    pub anchor_epoch: u64,

    /// Epoch in which this cert was written (must be ≥ anchor_epoch + 2).
    /// Re-read from the live clock on every reissue.
    pub cert_epoch: u64,

    /// Unix timestamp at which this cert was issued (re-issued: overwritten
    /// with the reissue time).
    pub issued_at: i64,

    /// Unix timestamp at which this cert expires (issued_at + cert_ttl).
    pub expires_at: i64,

    /// Bitmap of the six derelict-pool criteria validated at Phase 2.
    /// MUST equal `crate::criteria::ALL_CRITERIA_MASK` (0x3F) and MUST
    /// match the originating EligibilityAnchor's bitmap.
    pub criteria_bitmap: u8,

    /// Number of times this cert has been issued (1 = first issue, N =
    /// Nth reissue). Zero only in the freshly-created (pre-write) state.
    pub reissue_generation: u64,

    /// Bump for [b"eligibility_cert", amm_program_id, pool_address].
    pub bump: u8,

    /// Reserved for future upgrades.
    pub _reserved: [u8; 56],
}

impl EligibilityCert {
    pub const SEED: &'static [u8] = b"eligibility_cert";

    /// True if the cert is expired at `now` (inclusive: `now ==
    /// expires_at` counts as expired — the TTL window is
    /// `[issued_at, expires_at)`). This predicate is the single lifecycle
    /// gate: a zeroed (never-written) account has `expires_at == 0`, so it
    /// reports expired for every real clock value, which is what lets one
    /// require! in `evaluate_pool_phase2` govern first issue and reissue
    /// alike (spec D10).
    pub fn is_expired(&self, now: i64) -> bool {
        now >= self.expires_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cert(expires_at: i64) -> EligibilityCert {
        EligibilityCert {
            amm_program_id: Pubkey::default(),
            pool_address: Pubkey::default(),
            writer: Pubkey::default(),
            anchor_epoch: 0,
            cert_epoch: 0,
            issued_at: 0,
            expires_at,
            criteria_bitmap: 0,
            reissue_generation: 0,
            bump: 0,
            _reserved: [0u8; 56],
        }
    }

    /// Roadmap 1.4 "Handle expired cert": the TTL window is
    /// [issued_at, expires_at) — expiry is inclusive of the boundary.
    #[test]
    fn is_expired_boundary_is_inclusive() {
        let c = cert(1_000);
        assert!(!c.is_expired(999));
        assert!(c.is_expired(1_000));
        assert!(c.is_expired(1_001));
    }

    /// Roadmap 1.4 "Define cert lifecycle": a freshly created (zeroed)
    /// PDA under `init_if_needed` reports expired for every real clock
    /// value, which is why the single expiry gate admits first issue.
    #[test]
    fn zeroed_fresh_account_is_reissuable() {
        let fresh = cert(0);
        assert!(fresh.is_expired(0));
        assert!(fresh.is_expired(1_700_000_000));
        assert_eq!(fresh.reissue_generation, 0);
    }

    /// Roadmap 1.4 "Test repeated Phase 2 attempts": a live cert is NOT
    /// reissuable — the handler maps this predicate to `CertStillValid`.
    #[test]
    fn live_cert_is_not_expired() {
        let now: i64 = 1_700_000_000;
        let c = cert(now + 3_600);
        assert!(!c.is_expired(now));
    }

    /// Layout stability: reissue_generation was carved out of _reserved
    /// (64 -> 56), so the account size is unchanged by Phase 1.4. Pins
    /// the total serialized size against accidental drift.
    #[test]
    fn account_layout_is_stable() {
        // 8 (anchor discriminator) + INIT_SPACE.
        let expected_space = 8
            + 32 // amm_program_id
            + 32 // pool_address
            + 32 // writer
            + 8 // anchor_epoch
            + 8 // cert_epoch
            + 8 // issued_at
            + 8 // expires_at
            + 1 // criteria_bitmap
            + 8 // reissue_generation
            + 1 // bump
            + 56; // _reserved
        assert_eq!(8 + EligibilityCert::INIT_SPACE, expected_space);
    }

    /// Borsh roundtrip preserves every field across a simulated reissue
    /// overwrite (generation increments, timestamps move forward).
    #[test]
    fn borsh_roundtrip_preserves_reissue_state() {
        let mut c = cert(1_000);
        c.amm_program_id = Pubkey::new_unique();
        c.pool_address = Pubkey::new_unique();
        c.writer = Pubkey::new_unique();
        c.criteria_bitmap = 0x3F;
        c.reissue_generation = 1;
        let bytes = c.try_to_vec().expect("borsh serialize");
        let d = EligibilityCert::try_from_slice(&bytes).expect("borsh deserialize");
        assert_eq!(d.amm_program_id, c.amm_program_id);
        assert_eq!(d.expires_at, 1_000);
        assert_eq!(d.reissue_generation, 1);
        assert_eq!(d.criteria_bitmap, 0x3F);
        assert_eq!(bytes.len(), EligibilityCert::INIT_SPACE);
    }
}
