// SPDX-License-Identifier: Apache-2.0
//
// GraveVault ProtocolConfig — multisig-controlled, 72h-timelocked.

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
    pub protocol_share_bps: u16,

    /// Charter-level priority fee ceiling (lamports per CU).
    pub max_priority_fee_ceiling_lamports: u64,

    /// Maximum slippage in bps for the Jupiter swap leg.
    pub max_slippage_bps: u16,

    /// Jupiter dust threshold in lamports.
    pub jupiter_dust_threshold_lamports: u64,

    /// Timelock window in seconds (default 72h).
    pub timelock_seconds: i64,

    /// True if the protocol is currently paused. New salvages are rejected;
    /// `claim_lp_proceeds` continues to work.
    pub emergency_paused: bool,

    /// Bump for [b"protocol_config"].
    pub bump: u8,

    /// Reserved for future upgrades.
    pub _reserved: [u8; 96],
}

impl ProtocolConfig {
    pub const SEED: &'static [u8] = b"protocol_config";
}
