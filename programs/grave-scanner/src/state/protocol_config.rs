// SPDX-License-Identifier: Apache-2.0
//
// GraveScanner ProtocolConfig — multisig-controlled, 72h-timelocked.

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

    /// Emergency pause flag. When `true`, `evaluate_pool_*` reverts with
    /// `ProtocolPaused`. Has no effect on rent reclaim (`sweep_stale_anchor`)
    /// or governance instructions. Per spec: GraveVault's
    /// `claim_lp_proceeds` remains live independently of this flag.
    pub paused: bool,

    /// Bump for ['protocol_config'] PDA.
    pub bump: u8,

    /// Reserved for future upgrades. MUST remain zeroed until consumed.
    pub _reserved: [u8; 64],
}

impl ProtocolConfig {
    pub const SEED: &'static [u8] = b"protocol_config";
}
