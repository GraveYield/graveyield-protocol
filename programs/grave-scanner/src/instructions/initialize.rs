// SPDX-License-Identifier: Apache-2.0

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::ProtocolConfig;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub authority: Pubkey,
    /// Use 0 to accept defaults from `constants.rs`.
    pub inactivity_seconds: u64,
    pub price_collapse_bps: u16,
    pub min_tvl_lamports: u64,
    pub anchor_staleness_seconds: u64,
    pub lp_burn_dust_threshold: u64,
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

    cfg.inactivity_seconds = if params.inactivity_seconds == 0 {
        DEFAULT_INACTIVITY_SECONDS
    } else {
        params.inactivity_seconds
    };
    cfg.price_collapse_bps = if params.price_collapse_bps == 0 {
        DEFAULT_PRICE_COLLAPSE_BPS
    } else {
        params.price_collapse_bps
    };
    cfg.min_tvl_lamports = if params.min_tvl_lamports == 0 {
        DEFAULT_MIN_TVL_LAMPORTS
    } else {
        params.min_tvl_lamports
    };
    cfg.anchor_staleness_seconds = if params.anchor_staleness_seconds == 0 {
        DEFAULT_ANCHOR_STALENESS_SECONDS
    } else {
        params.anchor_staleness_seconds
    };
    cfg.lp_burn_dust_threshold = if params.lp_burn_dust_threshold == 0 {
        DEFAULT_LP_BURN_DUST_THRESHOLD
    } else {
        params.lp_burn_dust_threshold
    };

    cfg.paused = false;
    cfg.bump = ctx.bumps.protocol_config;
    cfg._reserved = [0u8; 64];

    Ok(())
}
