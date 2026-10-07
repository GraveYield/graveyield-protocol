// SPDX-License-Identifier: Apache-2.0
//
// Phase 1 of evaluate_pool. Verifies all six derelict-pool criteria via the
// `criteria` evaluator and writes an EligibilityAnchor PDA stamped with
// `first_eligible_epoch = current_epoch`.
//
// Phase 2 must wait at least MIN_EPOCH_CONFIRMATION (= 2) consecutive Solana
// epochs after this anchor before issuing an EligibilityCert.

use anchor_lang::prelude::*;

use crate::adapters::{self, PoolData};
use crate::attestation::{self, ATTESTATION_MSG_LEN};
use crate::constants::{ELIGIBILITY_ANCHOR_SEED, LAUNCH_PRICE_SEED};
use crate::criteria::{self, CriteriaInputs, CriteriaThresholds, Phase};
use crate::errors::GraveScannerError;
use crate::state::{EligibilityAnchor, LaunchPrice, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EvaluatePoolPhase1Params {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    /// Indexer-signed Criterion 1 attestation (112 bytes, canonical
    /// layout in `attestation.rs` / spec §5, decision D8):
    /// `amm_program_id ‖ pool_address ‖ last_swap_unix_ts ‖ issued_slot ‖ slot_hash`.
    ///
    /// The transaction MUST carry an `ed25519_program` verify instruction
    /// immediately before this one whose signature covers exactly these
    /// bytes with `ProtocolConfig.activity_oracle` as the public key. The
    /// issued slot must still resolve in SlotHashes — stale attestations
    /// are rejected. Caller-supplied timestamps are no longer accepted.
    pub msg: [u8; ATTESTATION_MSG_LEN],
}

#[derive(Accounts)]
#[instruction(params: EvaluatePoolPhase1Params)]
pub struct EvaluatePoolPhase1<'info> {
    #[account(seeds = [ProtocolConfig::SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = writer,
        space = 8 + EligibilityAnchor::INIT_SPACE,
        seeds = [
            ELIGIBILITY_ANCHOR_SEED,
            params.amm_program_id.as_ref(),
            params.pool_address.as_ref(),
        ],
        bump,
    )]
    pub eligibility_anchor: Account<'info, EligibilityAnchor>,

    #[account(
        seeds = [
            LAUNCH_PRICE_SEED,
            params.amm_program_id.as_ref(),
            params.pool_address.as_ref(),
        ],
        bump = launch_price.bump,
    )]
    pub launch_price: Account<'info, LaunchPrice>,

    /// CHECK: AMM-specific account introspection happens via the
    /// `adapters` module. The account is validated against
    /// `params.pool_address` and dispatched by `pool.owner`. Vault and
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

pub fn handler(ctx: Context<EvaluatePoolPhase1>, params: EvaluatePoolPhase1Params) -> Result<()> {
    let cfg = &ctx.accounts.protocol_config;
    require!(!cfg.paused, GraveScannerError::ProtocolPaused);

    let clock = Clock::get().map_err(|_| GraveScannerError::InvalidClock)?;

    // Criterion 1 evidence: indexer-signed Ed25519 attestation (ORACLE-002,
    // Phase 1.2 / spec D8). Verifies the runtime-checked precompile
    // signature binds exactly the embedded 112-byte message to the
    // configured activity oracle, then validates the message fields
    // (pool binding, timestamp sanity, slot freshness via SlotHashes).
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

    // Extract AMM-side pool snapshot. Per the m4 convention, the adapter
    // reads reserves/lp_supply from the pool's vault and lp_mint accounts
    // passed via `remaining_accounts`. Raydium V4 is wired; the other
    // adapters revert `AmmAdapterUnimplemented` until their layout
    // parsers land.
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
    // binding). Receives the pool address for the marker derivation and
    // the binding checks, and the true LP mint (post-m4).

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
        anchor_first_eligible_epoch: None,
    };
    let thresholds = CriteriaThresholds {
        inactivity_seconds: cfg.inactivity_seconds,
        price_collapse_bps: cfg.price_collapse_bps,
        min_tvl_lamports: cfg.min_tvl_lamports,
        lp_burn_dust_threshold: cfg.lp_burn_dust_threshold,
    };
    let bitmap = criteria::evaluate(&inputs, &thresholds, Phase::One)?;

    let anchor_account = &mut ctx.accounts.eligibility_anchor;
    anchor_account.amm_program_id = params.amm_program_id;
    anchor_account.pool_address = params.pool_address;
    anchor_account.writer = ctx.accounts.writer.key();
    anchor_account.first_eligible_epoch = clock.epoch;
    anchor_account.written_at = clock.unix_timestamp;
    anchor_account.invalidated = false;
    anchor_account.criteria_bitmap = bitmap;
    anchor_account.bump = ctx.bumps.eligibility_anchor;
    anchor_account._reserved = [0u8; 64];

    emit!(EligibilityAnchorWritten {
        amm_program_id: params.amm_program_id,
        pool_address: params.pool_address,
        writer: ctx.accounts.writer.key(),
        first_eligible_epoch: clock.epoch,
        criteria_bitmap: bitmap,
    });

    Ok(())
}

#[event]
pub struct EligibilityAnchorWritten {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub writer: Pubkey,
    pub first_eligible_epoch: u64,
    pub criteria_bitmap: u8,
}
