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
use crate::attestation::{self, ATTESTATION_MSG_LEN};
use crate::constants::{ELIGIBILITY_ANCHOR_SEED, ELIGIBILITY_CERT_SEED, LAUNCH_PRICE_SEED};
use crate::criteria::{self, CriteriaInputs, CriteriaThresholds, Phase};
use crate::errors::GraveScannerError;
use crate::state::{EligibilityAnchor, EligibilityCert, LaunchPrice, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EvaluatePoolPhase2Params {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    /// Indexer-signed Criterion 1 attestation — same canonical 112-byte
    /// format as Phase 1 (see `evaluate_pool_phase1.rs` / spec §5 D8).
    /// Must be issued fresh for Phase 2: the multi-epoch confirmation gap
    /// guarantees the Phase 1 attestation's slot has aged out of
    /// SlotHashes, so only a newly signed attestation can pass.
    pub msg: [u8; ATTESTATION_MSG_LEN],
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
    /// criteria) is dispatched through the `adapters` module. Vault and
    /// lp_mint accounts are passed via `remaining_accounts`.
    pub pool: UncheckedAccount<'info>,

    /// CHECK: instructions sysvar, address-constrained. Used to locate
    /// the `ed25519_program` verify instruction and this instruction's
    /// own data for attestation offset validation (ORACLE-002).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::id())]
    pub instruction_sysvar: UncheckedAccount<'info>,

    /// CHECK: slot hashes sysvar, address-constrained. Anchors the
    /// attestation's `issued_slot` to a real recent slot (freshness).
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::id())]
    pub slot_hashes: UncheckedAccount<'info>,

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

    // Criterion 1 evidence: fresh indexer-signed attestation (ORACLE-002,
    // Phase 1.2 / spec D8). The Phase 1 attestation cannot be replayed
    // here — its issued_slot has aged out of SlotHashes during the
    // multi-epoch confirmation gap.
    let attested_last_swap_ts = attestation::verify_last_swap_attestation(
        &ctx.accounts.instruction_sysvar,
        &ctx.accounts.slot_hashes,
        attestation::AttestationRef {
            msg: &params.msg,
            amm_program_id: &params.amm_program_id,
            pool_address: &params.pool_address,
            oracle: &cfg.activity_oracle,
        },
        clock.unix_timestamp,
        clock.slot,
    )?;

    let pool_data: PoolData = adapters::extract_pool_data(
        &ctx.accounts.pool.to_account_info(),
        &params.pool_address,
        ctx.remaining_accounts,
    )?;

    // Locker introspection. v1.0 supports the UNCX Raydium V4 locker
    // (LOCKER-001, Phase 1.1): the per-pool marker PDA gates the check —
    // absent on chain = no lock ever created (proven zero); present =
    // TokenLock evidence must be supplied and is strictly validated
    // (ownership + discriminator + PDA re-derivation + (pool, mint)
    // binding). See `adapters/locker.rs` for the evidence model.
    let lp_locked_amount = adapters::locker::locked_lp_amount(
        &pool_data.lp_mint,
        &params.pool_address,
        ctx.remaining_accounts,
    )?;

    let inputs = CriteriaInputs {
        last_swap_unix_ts: attested_last_swap_ts,
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
