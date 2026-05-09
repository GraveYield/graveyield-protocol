// SPDX-License-Identifier: Apache-2.0

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
