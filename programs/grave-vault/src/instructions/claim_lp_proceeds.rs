// SPDX-License-Identifier: Apache-2.0
//
// claim_lp_proceeds — original LP holder withdraws their pro-rata share from
// `lp_holder_pool_vault`.
//
// 1. Verify a Merkle proof of (lp_holder, lp_balance_at_snapshot) against
//    `pool_registry.lp_snapshot_merkle_root`. The root was sealed at
//    salvage time and is immutable thereafter.
// 2. Compute pro-rata share:
//        amount = lp_holder_pool_total_lamports
//                 * lp_balance_at_snapshot
//                 / lp_total_supply_at_snapshot
// 3. Reject if (a) claim would push cumulative claimed past the total
//    (defense-in-depth — Merkle root uniqueness should prevent this), or
//    (b) lp_balance_at_snapshot is zero (invalid claim).
// 4. Transfer `amount` lamports from `lp_holder_pool_vault` to `lp_holder`
//    via system_program::transfer (lp_holder_pool_vault PDA-signs with its
//    own seeds; the PDA is system-owned, so its seeds are its signing
//    authority).
// 5. Init ClaimRecord PDA — the existence of this PDA is the canonical
//    double-claim defense (a second claim by the same (pool, holder) pair
//    fails at the `init` constraint).
// 6. Emit LpClaimProcessed event.
//
// Charter invariant: this instruction stays LIVE during emergency pause —
// original LPs always recover their share regardless of operational state.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;

use crate::constants::*;
use crate::errors::GraveVaultError;
use crate::merkle;
use crate::state::{ClaimRecord, PoolRegistry};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimLpProceedsParams {
    pub pool_address: Pubkey,
    /// LP token balance at snapshot for this holder. Verified via the
    /// Merkle proof against `pool_registry.lp_snapshot_merkle_root`.
    pub lp_balance_at_snapshot: u64,
    /// Sorted-pair Merkle proof of `(lp_holder, lp_balance_at_snapshot)`.
    /// Length is unrestricted on-chain; off-chain the builder produces
    /// ceil(log2(N)) elements for N holders.
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

    /// Init-on-PDA is the canonical double-claim defense. A second
    /// `claim_lp_proceeds` call by the same (pool, holder) pair fails at
    /// this constraint before any lamports move.
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

    /// Same `lp_holder_pool_vault` written to by salvage_pool. Native-SOL
    /// system account; system_program::transfer signs with the PDA's own
    /// seeds via invoke_signed below.
    ///
    /// Charter invariant: only `claim_lp_proceeds` may debit this account.
    /// No admin key, multisig path, or governance instruction can sweep it.
    #[account(
        mut,
        seeds = [LP_HOLDER_POOL_SEED, params.pool_address.as_ref()],
        bump,
    )]
    pub lp_holder_pool_vault: SystemAccount<'info>,

    #[account(mut)]
    pub lp_holder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimLpProceeds>, params: ClaimLpProceedsParams) -> Result<()> {
    let registry = &mut ctx.accounts.pool_registry;
    let clock = Clock::get()?;

    // ---------------- Reject obviously-invalid claims ----------------

    require!(
        params.lp_balance_at_snapshot > 0,
        GraveVaultError::InvalidClaimProof
    );

    // Defense in depth: a snapshot with zero total supply would imply
    // division-by-zero in the pro-rata math below. salvage_pool refuses
    // zero-supply snapshots (InvalidSnapshotData) — re-check here so a
    // corrupted PoolRegistry cannot trigger a panic.
    require!(
        registry.lp_total_supply_at_snapshot > 0,
        GraveVaultError::InvalidClaimProof
    );

    // ---------------- Verify Merkle proof ----------------

    let leaf = merkle::compute_leaf(
        &ctx.accounts.lp_holder.key(),
        params.lp_balance_at_snapshot,
    );
    require!(
        merkle::verify_proof(
            registry.lp_snapshot_merkle_root,
            leaf,
            &params.merkle_proof,
        ),
        GraveVaultError::InvalidClaimProof
    );

    // ---------------- Compute pro-rata share ----------------

    // u128 intermediate to avoid overflow when lp_holder_pool_total_lamports
    // * lp_balance approaches u64::MAX * u64::MAX. Division by
    // lp_total_supply_at_snapshot (verified > 0 above) brings the result
    // back to u64-fitting range as long as the math is internally consistent.
    let amount: u128 = (registry.lp_holder_pool_total_lamports as u128)
        .checked_mul(params.lp_balance_at_snapshot as u128)
        .ok_or(GraveVaultError::MathOverflow)?
        .checked_div(registry.lp_total_supply_at_snapshot as u128)
        .ok_or(GraveVaultError::MathOverflow)?;
    let amount_u64: u64 = amount
        .try_into()
        .map_err(|_| GraveVaultError::MathOverflow)?;

    // Conservation check: cumulative claimed must never exceed the total.
    // Init-on-PDA already prevents the SAME holder from double-claiming;
    // this protects against arithmetic drift across DIFFERENT holders
    // (rounding remainders accumulating beyond the bucket).
    let new_claimed = registry
        .lp_holder_pool_claimed_lamports
        .checked_add(amount_u64)
        .ok_or(GraveVaultError::MathOverflow)?;
    require!(
        new_claimed <= registry.lp_holder_pool_total_lamports,
        GraveVaultError::MathOverflow
    );
    registry.lp_holder_pool_claimed_lamports = new_claimed;

    // ---------------- Transfer SOL: vault → holder ----------------

    // lp_holder_pool_vault is a system-owned PDA created by salvage_pool's
    // lazy-init. To debit it via system_program::transfer we sign with its
    // own seeds (the PDA's "address authority"). The vault's lamports are
    // rent-exempt minimum + accumulated salvage proceeds; the transfer is
    // a no-op if amount_u64 == 0 (defensive — should be impossible since
    // we rejected lp_balance == 0 above and lp_holder_pool_total > 0 if
    // anyone is claiming).
    if amount_u64 > 0 {
        let pool_bytes = params.pool_address.to_bytes();
        let bump = [ctx.bumps.lp_holder_pool_vault];
        let seeds: &[&[u8]] = &[LP_HOLDER_POOL_SEED, &pool_bytes, &bump];

        let ix = system_instruction::transfer(
            &ctx.accounts.lp_holder_pool_vault.key(),
            &ctx.accounts.lp_holder.key(),
            amount_u64,
        );
        invoke_signed(
            &ix,
            &[
                ctx.accounts.lp_holder_pool_vault.to_account_info(),
                ctx.accounts.lp_holder.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;
    }

    // ---------------- Init ClaimRecord ----------------

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
