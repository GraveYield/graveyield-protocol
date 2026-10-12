// SPDX-License-Identifier: Apache-2.0
//
// initialize — multisig-only at launch. Creates the singleton
// `ProtocolConfig` PDA. Called once per program deployment; a second
// call reverts at the `init` constraint (PDA already exists).
//
// Zero-means-default convention: every numeric param field uses `0` as
// the "accept the constant from `constants.rs`" sentinel. This lets the
// multisig initialize with all-zeros to take the canonical 40/40/20
// split and the documented operational defaults, or override individual
// fields without re-stating the rest.
//
// Charter invariants validated at write time (and re-validated by
// `update_protocol_config` on every subsequent change):
//   * `protocol_share_bps` ≤ `PROTOCOL_SHARE_BPS_CEILING` (2_000 = 20%).
//     Governance can lower but cannot raise — raising requires a
//     program upgrade, not a config update.
//   * Share split (`lp_holder + salvor + protocol`) must sum to exactly
//     10_000 bps. A split that doesn't sum is rejected with
//     `InvalidShareSplit` (7004).
//
// The 72h timelock on parameter changes is enforced by the Squads
// multisig's transaction-buffer scheduling, not by this program (spec
// D2 deferral). `pending_authority` / `pending_authority_eta` /
// `timelock_seconds` are write-only reserved state in v1.0 — no
// instruction reads them — see `update_protocol_config.rs`'s
// PRE-MAINNET-TODO(GOV).

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GraveVaultError;
use crate::state::ProtocolConfig;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub authority: Pubkey,
    /// All bps fields use 0 to mean "accept defaults from constants.rs".
    pub lp_holder_share_bps: u16,
    pub salvor_share_bps: u16,
    pub protocol_share_bps: u16,
    pub max_priority_fee_ceiling_lamports: u64,
    pub max_slippage_bps: u16,
    pub jupiter_dust_threshold_lamports: u64,
    pub timelock_seconds: i64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
    let cfg = &mut ctx.accounts.protocol_config;

    cfg.authority = params.authority;
    cfg.pending_authority = Pubkey::default();
    cfg.pending_authority_eta = 0;

    cfg.lp_holder_share_bps = if params.lp_holder_share_bps == 0 {
        DEFAULT_LP_HOLDER_SHARE_BPS
    } else {
        params.lp_holder_share_bps
    };
    cfg.salvor_share_bps = if params.salvor_share_bps == 0 {
        DEFAULT_SALVOR_SHARE_BPS
    } else {
        params.salvor_share_bps
    };
    cfg.protocol_share_bps = if params.protocol_share_bps == 0 {
        DEFAULT_PROTOCOL_SHARE_BPS
    } else {
        params.protocol_share_bps
    };

    // Charter ceiling check.
    require!(
        cfg.protocol_share_bps <= PROTOCOL_SHARE_BPS_CEILING,
        GraveVaultError::ProtocolShareExceedsCeiling
    );

    // Splits must sum to exactly 10_000.
    let total = (cfg.lp_holder_share_bps as u32)
        + (cfg.salvor_share_bps as u32)
        + (cfg.protocol_share_bps as u32);
    require!(total == 10_000, GraveVaultError::InvalidShareSplit);

    cfg.max_priority_fee_ceiling_lamports = if params.max_priority_fee_ceiling_lamports == 0 {
        DEFAULT_MAX_PRIORITY_FEE_CEILING_LAMPORTS
    } else {
        params.max_priority_fee_ceiling_lamports
    };
    cfg.max_slippage_bps = if params.max_slippage_bps == 0 {
        DEFAULT_MAX_SLIPPAGE_BPS
    } else {
        params.max_slippage_bps
    };
    cfg.jupiter_dust_threshold_lamports = if params.jupiter_dust_threshold_lamports == 0 {
        DEFAULT_JUPITER_DUST_THRESHOLD_LAMPORTS
    } else {
        params.jupiter_dust_threshold_lamports
    };
    cfg.timelock_seconds = if params.timelock_seconds == 0 {
        DEFAULT_TIMELOCK_SECONDS
    } else {
        params.timelock_seconds
    };

    cfg.emergency_paused = false;
    cfg.bump = ctx.bumps.protocol_config;
    cfg._reserved = [0u8; 96];

    Ok(())
}
