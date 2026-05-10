// SPDX-License-Identifier: Apache-2.0
//
// Phase 2 of evaluate_pool. Re-verifies all six criteria after the
// multi-epoch confirmation gap and issues an `EligibilityCert` (TTL =
// `ProtocolConfig.cert_ttl_seconds`, governance-configurable, default 1h,
// floored at MIN_CERT_TTL_SECONDS=600s). GraveVault consumes the cert to
// authorise `salvage_pool`.
//
// Phase 2 also enforces that the bitmap matches the originating
// EligibilityAnchor — a Phase 1 pass cannot be downgraded silently.

use anchor_lang::prelude::*;

use crate::adapters::{self, PoolData};
use crate::constants::{ELIGIBILITY_ANCHOR_SEED, ELIGIBILITY_CERT_SEED, LAUNCH_PRICE_SEED};
use crate::criteria::{self, CriteriaInputs, CriteriaThresholds, Phase};
use crate::errors::GraveScannerError;
use crate::state::{EligibilityAnchor, EligibilityCert, LaunchPrice, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EvaluatePoolPhase2Params {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    /// Last on-chain swap timestamp; see Phase 1 docs for the
    /// PRE-MAINNET-TODO(ORACLE) note on cryptographic verification.
    pub last_swap_unix_ts: i64,
}

#[derive(Accounts)]
#[instruction(params: EvaluatePoolPhase2Params)]
pub struct EvaluatePoolPhase2<'info> {
    #[account(seeds = [ProtocolConfig::SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [
            ELIGIBILITY_ANCHOR_SEED,
            params.amm_program_id.as_ref(),
            params.pool_address.as_ref(),
        ],
        bump = eligibility_anchor.bump,
    )]
    pub eligibility_anchor: Account<'info, EligibilityAnchor>,

    #[account(
        init,
        payer = writer,
        space = 8 + EligibilityCert::INIT_SPACE,
        seeds = [
            ELIGIBILITY_CERT_SEED,
            params.amm_program_id.as_ref(),
            params.pool_address.as_ref(),
        ],
        bump,
    )]
    pub eligibility_cert: Account<'info, EligibilityCert>,

    #[account(
        seeds = [
            LAUNCH_PRICE_SEED,
            params.amm_program_id.as_ref(),
            params.pool_address.as_ref(),
        ],
        bump = launch_price.bump,
    )]
    pub launch_price: Account<'info, LaunchPrice>,

    /// CHECK: AMM-specific introspection (re-verification of all six
    /// criteria) is dispatched through the `adapters` module.
    pub pool: UncheckedAccount<'info>,

    #[account(mut)]
    pub writer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<EvaluatePoolPhase2>, params: EvaluatePoolPhase2Params) -> Result<()> {
    let cfg = &ctx.accounts.protocol_config;
    require!(!cfg.paused, GraveScannerError::ProtocolPaused);

    let clock = Clock::get().map_err(|_| GraveScannerError::InvalidClock)?;
    let anchor_account = &ctx.accounts.eligibility_anchor;

    require!(
        !anchor_account.invalidated,
        GraveScannerError::AnchorInvalidated
    );

    let pool_data: PoolData =
        adapters::extract_pool_data(&ctx.accounts.pool.to_account_info(), &params.pool_address)?;

    let lp_locked_amount =
        adapters::locker::locked_lp_amount(&pool_data.base_mint, ctx.remaining_accounts)?;

    let inputs = CriteriaInputs {
        last_swap_unix_ts: params.last_swap_unix_ts,
        current_unix_ts: clock.unix_timestamp,
        launch_price_q64x64: ctx.accounts.launch_price.launch_price_q64x64,
        current_price_q64x64: pool_data.current_price_q64x64()?,
        current_tvl_lamports: pool_data.quote_reserve,
        lp_supply: pool_data.lp_supply,
        lp_locked_amount,
        current_epoch: clock.epoch,
        anchor_first_eligible_epoch: Some(anchor_account.first_eligible_epoch),
    };
    let thresholds = CriteriaThresholds {
        inactivity_seconds: cfg.inactivity_seconds,
        price_collapse_bps: cfg.price_collapse_bps,
        min_tvl_lamports: cfg.min_tvl_lamports,
        lp_burn_dust_threshold: cfg.lp_burn_dust_threshold,
    };
    let bitmap = criteria::evaluate(&inputs, &thresholds, Phase::Two)?;

    // Phase 2 must reproduce the same bitmap that Phase 1 produced. A
    // mismatch signals that the criteria semantics drifted between phases
    // (parameter change, adapter upgrade, etc.) — refuse to certify.
    require!(
        bitmap == anchor_account.criteria_bitmap,
        GraveScannerError::CriteriaBitmapMismatch
    );

    let cert = &mut ctx.accounts.eligibility_cert;
    cert.amm_program_id = params.amm_program_id;
    cert.pool_address = params.pool_address;
    cert.writer = ctx.accounts.writer.key();
    cert.anchor_epoch = anchor_account.first_eligible_epoch;
    cert.cert_epoch = clock.epoch;
    cert.issued_at = clock.unix_timestamp;
    // TTL is governance-configurable per ProtocolConfig (with a hardcoded
    // floor enforced in `update_protocol_config`). Reading here keeps cert
    // freshness in lockstep with the live config.
    cert.expires_at = clock
        .unix_timestamp
        .checked_add(cfg.cert_ttl_seconds)
        .ok_or(GraveScannerError::MathOverflow)?;
    cert.criteria_bitmap = bitmap;
    cert.bump = ctx.bumps.eligibility_cert;
    cert._reserved = [0u8; 64];

    emit!(EligibilityCertIssued {
        amm_program_id: params.amm_program_id,
        pool_address: params.pool_address,
        writer: ctx.accounts.writer.key(),
        anchor_epoch: cert.anchor_epoch,
        cert_epoch: cert.cert_epoch,
        expires_at: cert.expires_at,
        criteria_bitmap: bitmap,
    });

    Ok(())
}

#[event]
pub struct EligibilityCertIssued {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub writer: Pubkey,
    pub anchor_epoch: u64,
    pub cert_epoch: u64,
    pub expires_at: i64,
    pub criteria_bitmap: u8,
}
