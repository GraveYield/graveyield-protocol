// SPDX-License-Identifier: Apache-2.0
//
// GraveVault ProtocolConfig — multisig-controlled, 72h-timelocked.
// (On-chain timelock wiring is a documented deferral — spec D2; the 72h
// buffer is enforced by the Squads governance flow, not by this program.)
//
// =====================================================================
// Config lifecycle (singleton, init-once at `initialize`):
// =====================================================================
//
//   none ──initialize──> live (Charter ceiling + share split validated
//                          at write time; defaults applied for zero
//                          params)
//                          │
//           ┌──────────────┴───────────────────┐
//           v                                  v
//       update_protocol_config            emergency_pause
//       (multisig + 72h timelock via      (multisig, immediate —
//        Squads; validates ceiling +      refuses-first on no-op
//        share-sum on apply)              toggle, 7022)
//
// The Charter ceiling on `protocol_share_bps` (≤ 2000 = 20%) is
// re-asserted at every write path (`initialize`, `update_protocol_config`)
// — it cannot be raised even by multisig vote. The 40/40/20 split must
// sum to exactly 10_000 bps at every write. `emergency_paused` is the
// only field that mutates outside `update_protocol_config`, and only
// `emergency_pause` may touch it.

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    /// Squads v4 multisig PDA controlling this protocol.
    pub authority: Pubkey,

    /// Pending authority during a 72h timelock rotation. Zeroed when not pending.
    pub pending_authority: Pubkey,

    /// Unix timestamp at which `pending_authority` becomes effective.
    pub pending_authority_eta: i64,

    /// Original LP holder share in basis points (default 4_000 = 40%).
    pub lp_holder_share_bps: u16,

    /// Salvor share in basis points (default 4_000 = 40%).
    pub salvor_share_bps: u16,

    /// Protocol share in basis points. Capped at PROTOCOL_SHARE_BPS_CEILING
    /// (2_000 = 20%) — governance can lower but cannot raise above ceiling.
    /// Re-asserted at every write path (`initialize`,
    /// `update_protocol_config`).
    pub protocol_share_bps: u16,

    /// Charter-level priority fee ceiling (lamports per CU).
    pub max_priority_fee_ceiling_lamports: u64,

    /// Maximum slippage in bps for the Jupiter swap leg.
    pub max_slippage_bps: u16,

    /// Jupiter dust threshold in lamports.
    pub jupiter_dust_threshold_lamports: u64,

    /// Timelock window in seconds (default 72h).
    pub timelock_seconds: i64,

    /// True if the protocol is currently paused. New salvages are rejected
    /// (`ProtocolPaused`, 7003); `claim_lp_proceeds` continues to work
    /// (Charter invariant). Mutated only by `emergency_pause`, which
    /// refuses-first on a no-op toggle (`InvariantViolation`, 7022).
    pub emergency_paused: bool,

    /// Bump for [b"protocol_config"].
    pub bump: u8,

    /// Reserved for future upgrades.
    pub _reserved: [u8; 96],
}

impl ProtocolConfig {
    pub const SEED: &'static [u8] = b"protocol_config";
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Layout stability: the config's serialized footprint must not
    /// drift without a program upgrade. Pins the total serialized size
    /// against accidental field reordering or `_reserved` carve-outs.
    /// Mirrors `SalvageReceipt::receipt_layout_offsets_are_stable` and
    /// the GraveScanner `ProtocolConfig` layout pin so a divergence
    /// between the two programs' config PDAs surfaces here rather than
    /// at audit time.
    #[test]
    fn account_layout_is_stable() {
        // 8 (Anchor discriminator) + INIT_SPACE.
        let expected_space = 8
            + 32 // authority
            + 32 // pending_authority
            + 8 // pending_authority_eta
            + 2 // lp_holder_share_bps
            + 2 // salvor_share_bps
            + 2 // protocol_share_bps
            + 8 // max_priority_fee_ceiling_lamports
            + 2 // max_slippage_bps
            + 8 // jupiter_dust_threshold_lamports
            + 8 // timelock_seconds
            + 1 // emergency_paused
            + 1 // bump
            + 96; // _reserved
        assert_eq!(8 + ProtocolConfig::INIT_SPACE, expected_space);
    }

    /// Borsh roundtrip preserves every field. The config is mutated in
    /// place by `update_protocol_config` and `emergency_pause`; a
    /// serialization drift would corrupt the share split and the
    /// pause flag — both security-critical. Catches deserialization
    /// drift early, same guarantee as the salvage receipt's roundtrip.
    #[test]
    fn borsh_roundtrip_preserves_config_state() {
        let cfg = ProtocolConfig {
            authority: Pubkey::new_from_array([0xB1u8; 32]),
            pending_authority: Pubkey::new_from_array([0xB2u8; 32]),
            pending_authority_eta: 1_700_000_000,
            lp_holder_share_bps: 4_000,
            salvor_share_bps: 4_000,
            protocol_share_bps: 2_000,
            max_priority_fee_ceiling_lamports: 1_000_000_000,
            max_slippage_bps: 300,
            jupiter_dust_threshold_lamports: 666_666,
            timelock_seconds: 72 * 60 * 60,
            emergency_paused: true,
            bump: 255,
            _reserved: [0u8; 96],
        };

        let bytes = cfg.try_to_vec().expect("borsh serialize");
        let d = ProtocolConfig::try_from_slice(&bytes).expect("borsh deserialize");

        assert_eq!(d.authority, cfg.authority);
        assert_eq!(d.pending_authority, cfg.pending_authority);
        assert_eq!(d.pending_authority_eta, 1_700_000_000);
        assert_eq!(d.lp_holder_share_bps, 4_000);
        assert_eq!(d.salvor_share_bps, 4_000);
        assert_eq!(d.protocol_share_bps, 2_000);
        assert_eq!(d.max_priority_fee_ceiling_lamports, 1_000_000_000);
        assert_eq!(d.max_slippage_bps, 300);
        assert_eq!(d.jupiter_dust_threshold_lamports, 666_666);
        assert_eq!(d.timelock_seconds, 72 * 60 * 60);
        assert!(d.emergency_paused);
        assert_eq!(d.bump, 255);
        assert_eq!(d._reserved, [0u8; 96]);
        assert_eq!(bytes.len(), ProtocolConfig::INIT_SPACE);
    }
}
