// SPDX-License-Identifier: Apache-2.0
//
// claim_lp_proceeds — original LP holder withdraws their pro-rata share from
// `lp_holder_pool_vault`. Verifies a Merkle proof against the snapshot root
// recorded in PoolRegistry. Idempotent via the ClaimRecord PDA.
//
// Charter invariant: this instruction stays LIVE during emergency pause —
// original LPs always recover their share regardless of operational state.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GraveVaultError;
use crate::state::{ClaimRecord, PoolRegistry};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimLpProceedsParams {
    pub pool_address: Pubkey,
    /// LP token balance at snapshot for this holder.
    pub lp_balance_at_snapshot: u64,
    /// Merkle proof for (lp_holder, lp_balance_at_snapshot) against
    /// `pool_registry.lp_snapshot_merkle_root`.
    pub merkle_proof: Vec<[u8; 32]>,
}

#[derive(Accounts)]
#[instruction(params: ClaimLpProceedsParams)]
pub struct ClaimLpProceeds<'info> {
    #[account(
        mut,
        seeds = [POOL_REGISTRY_SEED, params.pool_address.as_ref()],
        bump = pool_registry.bump,
    )]
    pub pool_registry: Account<'info, PoolRegistry>,

    #[account(
        init,
        payer = lp_holder,
        space = 8 + ClaimRecord::INIT_SPACE,
        seeds = [
            CLAIM_RECORD_SEED,
            params.pool_address.as_ref(),
            lp_holder.key().as_ref(),
        ],
        bump,
    )]
    pub claim_record: Account<'info, ClaimRecord>,

    /// CHECK: same `lp_holder_pool_vault` written to by salvage_pool.
    /// Charter-invariant: only `claim_lp_proceeds` may debit this account.
    #[account(
        mut,
        seeds = [LP_HOLDER_POOL_SEED, params.pool_address.as_ref()],
        bump,
    )]
    pub lp_holder_pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub lp_holder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ClaimLpProceeds>,
    params: ClaimLpProceedsParams,
) -> Result<()> {
    let registry = &mut ctx.accounts.pool_registry;

    // TODO(GraveVault m6): verify Merkle proof of (lp_holder, lp_balance) against
    // registry.lp_snapshot_merkle_root. Stub returns InvalidClaimProof on call
    // until wired up so accidental claims cannot succeed.
    require!(
        !params.merkle_proof.is_empty(),
        GraveVaultError::InvalidClaimProof
    );

    // Pro-rata math:
    //   amount = registry.lp_holder_pool_total_lamports
    //          * lp_balance_at_snapshot
    //          / registry.lp_total_supply_at_snapshot
    let amount: u128 = (registry.lp_holder_pool_total_lamports as u128)
        .checked_mul(params.lp_balance_at_snapshot as u128)
        .ok_or(GraveVaultError::MathOverflow)?
        .checked_div(registry.lp_total_supply_at_snapshot as u128)
        .ok_or(GraveVaultError::MathOverflow)?;
    let amount_u64: u64 = amount.try_into().map_err(|_| GraveVaultError::MathOverflow)?;

    let new_claimed = registry
        .lp_holder_pool_claimed_lamports
        .checked_add(amount_u64)
        .ok_or(GraveVaultError::MathOverflow)?;
    require!(
        new_claimed <= registry.lp_holder_pool_total_lamports,
        GraveVaultError::MathOverflow
    );
    registry.lp_holder_pool_claimed_lamports = new_claimed;

    // TODO(GraveVault m6): SOL transfer from lp_holder_pool_vault to lp_holder.

    let clock = Clock::get()?;
    let record = &mut ctx.accounts.claim_record;
    record.pool_address = params.pool_address;
    record.lp_holder = ctx.accounts.lp_holder.key();
    record.amount_lamports = amount_u64;
    record.lp_balance_at_snapshot = params.lp_balance_at_snapshot;
    record.claimed_at_slot = clock.slot;
    record.claimed_at_ts = clock.unix_timestamp;
    record.bump = ctx.bumps.claim_record;
    record._reserved = [0u8; 32];

    emit!(LpClaimProcessed {
        pool_address: params.pool_address,
        lp_holder: ctx.accounts.lp_holder.key(),
        amount_lamports: amount_u64,
    });

    Ok(())
}

#[event]
pub struct LpClaimProcessed {
    pub pool_address: Pubkey,
    pub lp_holder: Pubkey,
    pub amount_lamports: u64,
}
