// SPDX-License-Identifier: Apache-2.0
//
// Phase 2 of evaluate_pool. Re-verifies all six criteria after the multi-epoch
// confirmation gap and issues an `EligibilityCert` (TTL = 1 hour). GraveVault
// consumes the cert to authorise `salvage_pool`.

use anchor_lang::prelude::*;

use crate::constants::{
    ELIGIBILITY_ANCHOR_SEED, ELIGIBILITY_CERT_SEED, ELIGIBILITY_CERT_TTL_SECONDS,
    MIN_EPOCH_CONFIRMATION,
};
use crate::errors::GraveScannerError;
use crate::state::{EligibilityAnchor, EligibilityCert, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EvaluatePoolPhase2Params {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
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

    /// CHECK: AMM-specific introspection (re-verification of all six criteria).
    pub pool: UncheckedAccount<'info>,

    #[account(mut)]
    pub writer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<EvaluatePoolPhase2>,
    params: EvaluatePoolPhase2Params,
) -> Result<()> {
    let clock = Clock::get().map_err(|_| GraveScannerError::InvalidClock)?;
    let anchor_account = &ctx.accounts.eligibility_anchor;

    require!(
        !anchor_account.invalidated,
        GraveScannerError::AnchorInvalidated
    );

    require!(
        clock
            .epoch
            .saturating_sub(anchor_account.first_eligible_epoch)
            >= MIN_EPOCH_CONFIRMATION,
        GraveScannerError::EpochConfirmationPending
    );

    require_keys_eq!(
        ctx.accounts.pool.key(),
        params.pool_address,
        GraveScannerError::UnsupportedAmm
    );

    // TODO(GraveScanner): re-verify all six criteria against current pool state.
    // Stub returns success for scaffolding only.

    let cert = &mut ctx.accounts.eligibility_cert;
    cert.amm_program_id = params.amm_program_id;
    cert.pool_address = params.pool_address;
    cert.writer = ctx.accounts.writer.key();
    cert.anchor_epoch = anchor_account.first_eligible_epoch;
    cert.cert_epoch = clock.epoch;
    cert.issued_at = clock.unix_timestamp;
    cert.expires_at = clock
        .unix_timestamp
        .checked_add(ELIGIBILITY_CERT_TTL_SECONDS)
        .ok_or(GraveScannerError::MathOverflow)?;
    cert.bump = ctx.bumps.eligibility_cert;
    cert._reserved = [0u8; 64];

    emit!(EligibilityCertIssued {
        amm_program_id: params.amm_program_id,
        pool_address: params.pool_address,
        writer: ctx.accounts.writer.key(),
        anchor_epoch: cert.anchor_epoch,
        cert_epoch: cert.cert_epoch,
        expires_at: cert.expires_at,
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
}
