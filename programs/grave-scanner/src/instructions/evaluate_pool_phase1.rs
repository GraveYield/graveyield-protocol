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
use crate::constants::{ELIGIBILITY_ANCHOR_SEED, LAUNCH_PRICE_SEED};
use crate::criteria::{self, CriteriaInputs, CriteriaThresholds, Phase};
use crate::errors::GraveScannerError;
use crate::state::{EligibilityAnchor, LaunchPrice, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EvaluatePoolPhase1Params {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    /// Last on-chain swap timestamp supplied by the salvor SDK and
    /// cross-checked by the indexer. Pre-mainnet, this is taken at face
    /// value; the production handler verifies via an adapter-provided
    /// last-swap proof or a record_pool_activity attestation.
    ///
    /// PRE-MAINNET-TODO(ORACLE): cryptographic proof of last swap timestamp | reverts: PoolDataParseError on mismatch | verify: against AMM transaction history or signed attestation
    pub last_swap_unix_ts: i64,
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

    #[account(mut)]
    pub writer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<EvaluatePoolPhase1>, params: EvaluatePoolPhase1Params) -> Result<()> {
    let cfg = &ctx.accounts.protocol_config;
    require!(!cfg.paused, GraveScannerError::ProtocolPaused);

    let clock = Clock::get().map_err(|_| GraveScannerError::InvalidClock)?;

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

    // Locker introspection. Honest-stub adapter pattern: reverts with
    // `LockerAdapterUnimplemented` until UNCX/PinkSale/TeamFinance
    // adapters land. Receives the true LP mint (post-m4) so the locker
    // check is semantically correct once implemented.
    let lp_locked_amount =
        adapters::locker::locked_lp_amount(&pool_data.lp_mint, ctx.remaining_accounts)?;

    let inputs = CriteriaInputs {
        last_swap_unix_ts: params.last_swap_unix_ts,
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
