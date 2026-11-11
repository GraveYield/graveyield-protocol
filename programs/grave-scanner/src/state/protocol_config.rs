// SPDX-License-Identifier: Apache-2.0
//
// GraveScanner ProtocolConfig — multisig-controlled, 72h-timelocked.
// (On-chain timelock wiring is a documented deferral — spec D2; the 72h
// buffer is enforced by the Squads governance flow, not by this program.)

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

    /// Inactivity threshold in seconds (Criterion 1).
    pub inactivity_seconds: u64,

    /// Minimum price-collapse threshold in basis points (Criterion 2).
    pub price_collapse_bps: u16,

    /// Minimum residual TVL in lamports (Criterion 3).
    pub min_tvl_lamports: u64,

    /// Staleness window for uncertified `EligibilityAnchor` PDAs (v4.0.1).
    pub anchor_staleness_seconds: u64,

    /// LP-supply dust threshold for Criterion 4 ("LP not burned"). Pools
    /// with `lp_supply <= lp_burn_dust_threshold` are treated as burned.
    pub lp_burn_dust_threshold: u64,

    /// `EligibilityCert` TTL in seconds. Governance-configurable via
    /// `update_protocol_config`, but bounded below by
    /// `MIN_CERT_TTL_SECONDS` (600s) — `update_protocol_config` rejects
    /// any value below the floor with `CertTtlBelowMinimum`.
    ///
    /// Read by `evaluate_pool_phase_2` when stamping `cert.expires_at`.
    pub cert_ttl_seconds: i64,

    /// Emergency pause flag. When `true`, `evaluate_pool_*` reverts with
    /// `ProtocolPaused`. Has no effect on rent reclaim (`sweep_stale_anchor`)
    /// or governance instructions. Per spec: GraveVault's
    /// `claim_lp_proceeds` remains live independently of this flag.
    pub paused: bool,

    /// Public key whose Ed25519 signatures authorize Criterion 1
    /// last-swap attestations (ORACLE-002, Phase 1.2 / spec D8). Set to
    /// the initial authority at `initialize` — the operator multisig runs
    /// the activity indexer until a dedicated oracle key is rotated in
    /// via `update_protocol_config`.
    pub activity_oracle: Pubkey,

    /// Public key whose Ed25519 signatures authorize Criterion 2
    /// launch-price attestations (ORACLE-001, Phase 1.3 / spec D9). Kept
    /// separate from `activity_oracle`: the launch-price baseline is
    /// init-once and permanently binding, so its signing key is isolated
    /// from the hotter activity-attestation key. Set to the initial
    /// authority at `initialize`; rotatable independently via
    /// `update_protocol_config`.
    pub launch_price_oracle: Pubkey,

    /// Bump for ['protocol_config'] PDA.
    pub bump: u8,

    /// Reserved for future upgrades. MUST remain zeroed until consumed.
    pub _reserved: [u8; 64],
}

impl ProtocolConfig {
    pub const SEED: &'static [u8] = b"protocol_config";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_layout_is_stable() {
        let expected_space = 8
            + 32 // authority
            + 32 // pending_authority
            + 8 // pending_authority_eta
            + 8 // inactivity_seconds
            + 2 // price_collapse_bps
            + 8 // min_tvl_lamports
            + 8 // anchor_staleness_seconds
            + 8 // lp_burn_dust_threshold
            + 8 // cert_ttl_seconds
            + 1 // paused
            + 32 // activity_oracle
            + 32 // launch_price_oracle
            + 1 // bump
            + 64; // _reserved

        assert_eq!(8 + ProtocolConfig::INIT_SPACE, expected_space);
        assert_eq!(expected_space, 252);
    }

    #[test]
    fn borsh_roundtrip_preserves_config_state() {
        let cfg = ProtocolConfig {
            authority: Pubkey::new_from_array([0xA1; 32]),
            pending_authority: Pubkey::new_from_array([0xA2; 32]),
            pending_authority_eta: 1_700_000_000,
            inactivity_seconds: 7_776_000,
            price_collapse_bps: 9_900,
            min_tvl_lamports: 500_000_000,
            anchor_staleness_seconds: 1_209_600,
            lp_burn_dust_threshold: 1_000,
            cert_ttl_seconds: 3_600,
            paused: true,
            activity_oracle: Pubkey::new_from_array([0xA3; 32]),
            launch_price_oracle: Pubkey::new_from_array([0xA4; 32]),
            bump: 254,
            _reserved: [0xA5; 64],
        };

        let bytes = borsh::to_vec(&cfg).expect("borsh serialize");
        let decoded = ProtocolConfig::try_from_slice(&bytes).expect("borsh deserialize");

        assert_eq!(decoded.authority, cfg.authority);
        assert_eq!(decoded.pending_authority, cfg.pending_authority);
        assert_eq!(decoded.pending_authority_eta, cfg.pending_authority_eta);
        assert_eq!(decoded.inactivity_seconds, cfg.inactivity_seconds);
        assert_eq!(decoded.price_collapse_bps, cfg.price_collapse_bps);
        assert_eq!(decoded.min_tvl_lamports, cfg.min_tvl_lamports);
        assert_eq!(
            decoded.anchor_staleness_seconds,
            cfg.anchor_staleness_seconds
        );
        assert_eq!(decoded.lp_burn_dust_threshold, cfg.lp_burn_dust_threshold);
        assert_eq!(decoded.cert_ttl_seconds, cfg.cert_ttl_seconds);
        assert_eq!(decoded.paused, cfg.paused);
        assert_eq!(decoded.activity_oracle, cfg.activity_oracle);
        assert_eq!(decoded.launch_price_oracle, cfg.launch_price_oracle);
        assert_eq!(decoded.bump, cfg.bump);
        assert_eq!(decoded._reserved, cfg._reserved);
        assert_eq!(bytes.len(), ProtocolConfig::INIT_SPACE);
    }
}
