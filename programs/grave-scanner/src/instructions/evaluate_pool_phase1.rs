// SPDX-License-Identifier: Apache-2.0
//
// Phase 1 of evaluate_pool. Verifies all six derelict-pool criteria and writes
// an EligibilityAnchor PDA stamped with `first_eligible_epoch = current_epoch`.
//
// Phase 2 must wait at least MIN_EPOCH_CONFIRMATION (= 2) consecutive Solana
// epochs after this anchor before issuing an EligibilityCert.

use anchor_lang::prelude::*;

use crate::constants::ELIGIBILITY_ANCHOR_SEED;
use crate::errors::GraveScannerError;
use crate::state::{EligibilityAnchor, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EvaluatePoolPhase1Params {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
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

    /// CHECK: AMM-specific account introspection lives in this handler. The
    /// account is validated against `params.pool_address` and the AMM program.
    pub pool: UncheckedAccount<'info>,

    #[account(mut)]
    pub writer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<EvaluatePoolPhase1>,
    params: EvaluatePoolPhase1Params,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.pool.key(),
        params.pool_address,
        GraveScannerError::UnsupportedAmm
    );

    let clock = Clock::get().map_err(|_| GraveScannerError::InvalidClock)?;

    // TODO(GraveScanner): verify all six criteria here. Stub returns success
    // for scaffolding only — the real handler reads pool reserves, last-trade
    // slots, lock/burn metadata, and the LaunchPrice PDA. See
    // docs/architecture/eligibility-anchors.md for the full spec.

    let anchor_account = &mut ctx.accounts.eligibility_anchor;
    anchor_account.amm_program_id = params.amm_program_id;
    anchor_account.pool_address = params.pool_address;
    anchor_account.writer = ctx.accounts.writer.key();
    anchor_account.first_eligible_epoch = clock.epoch;
    anchor_account.written_at = clock.unix_timestamp;
    anchor_account.invalidated = false;
    anchor_account.bump = ctx.bumps.eligibility_anchor;
    anchor_account._reserved = [0u8; 64];

    emit!(EligibilityAnchorWritten {
        amm_program_id: params.amm_program_id,
        pool_address: params.pool_address,
        writer: ctx.accounts.writer.key(),
        first_eligible_epoch: clock.epoch,
    });

    Ok(())
}

#[event]
pub struct EligibilityAnchorWritten {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub writer: Pubkey,
    pub first_eligible_epoch: u64,
}
