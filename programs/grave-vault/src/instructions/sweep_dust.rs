// SPDX-License-Identifier: Apache-2.0
//
// sweep_dust — Phase 4 (D6) dust policy recovery path.
//
// After a salvage, memecoin can remain in the vault memecoin ATA in two
// ways:
//
//   1. The conversion leg was SKIPPED because the withdraw paid less than
//      `jupiter_dust_threshold_lamports` memecoin — the amount is recorded
//      on the SalvageReceipt as `dust_memecoin_lamports` (D6: retained,
//      unconverted, never counted as distributed proceeds).
//   2. The conversion leg RAN but the route did not fully drain the ATA
//      (route residual) — also recorded on the receipt.
//
// In both cases the retained tokens previously had no closure, sweep, or
// recovery path (PRE-MAINNET-TODO(DUST), retired). This instruction is the
// policy: transfer the vault memecoin ATA's ENTIRE balance to the protocol
// treasury's ATA for the same mint, close the vault memecoin ATA (rent
// reclaimed by the caller), and stamp `dust_swept_at_ts` on the receipt.
//
// Properties:
//   * PERMISSIONLESS. Anyone may sweep. The caller cannot profit from the
//     tokens themselves (destination is pinned by ATA derivation to the
//     protocol treasury) and cannot redirect the rent (the vault ATA close
//     destination is the caller — the standard rent-reclaim incentive, and
//     the only reward a sweeper gets).
//   * MINT-BOUND. The submitted `memecoin_mint` must equal
//     `salvage_receipt.memecoin_mint` (recorded by salvage_pool), so a
//     junk-mint ATA of the vault authority cannot be laundered through a
//     foreign pool's receipt.
//   * ONE-SHOT. `receipt.dust_swept_at_ts != 0` reverts
//     `DustAlreadySwept` (7021); an empty ATA reverts
//     `DustNothingToSweep` (7020).
//   * CHARTER-SAFE. `lp_holder_pool_vault` is untouched — the sweep moves
//     memecoin tokens, never the LP-holder SOL proceeds, and the treasury
//     ATA is not the unsweepable LP-holder bucket.
//   * PAUSE-INDEPENDENT. Reads no pause flag: it moves no settlement
//     proceeds, so it may run regardless of operational state (mirrors the
//     rent-reclaim/governance paths, not the salvage path).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::GraveVaultError;
use crate::state::SalvageReceipt;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SweepDustParams {
    /// The salvaged pool. Selects the receipt PDA.
    pub pool_address: Pubkey,
}

#[derive(Accounts)]
#[instruction(params: SweepDustParams)]
pub struct SweepDust<'info> {
    /// The pool's receipt: proves the salvage happened, binds the mint,
    /// carries the one-shot guard, and records the sweep timestamp.
    #[account(
        mut,
        seeds = [SalvageReceipt::SEED, params.pool_address.as_ref()],
        bump = salvage_receipt.bump,
    )]
    pub salvage_receipt: Box<Account<'info, SalvageReceipt>>,

    /// CHECK: Singleton vault authority PDA — the owner of the vault
    /// memecoin ATA. PDA-signs the token transfer and the ATA close via
    /// `invoke_signed`. Never holds lamports itself.
    #[account(mut, seeds = [VAULT_AUTHORITY_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// The vault's memecoin ATA, created by `salvage_pool` (init_if_needed
    /// there). MUST already exist: this instruction does not recreate it —
    /// a missing account fails the transaction, which is the correct
    /// outcome for a pool that never salvaged anything into it.
    #[account(
        mut,
        associated_token::mint = memecoin_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_memecoin_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Protocol treasury PDA (same seeds `salvage_pool` pays the
    /// protocol share to). Owner of the destination ATA; not itself
    /// debited or credited here.
    #[account(seeds = [PROTOCOL_TREASURY_SEED], bump)]
    pub protocol_treasury: UncheckedAccount<'info>,

    /// The ONLY permitted sweep destination: the treasury's ATA for the
    /// same mint. Derived — the caller cannot substitute a personal
    /// account (Anchor's associated-token constraints reject it before
    /// the handler runs).
    #[account(
        init_if_needed,
        payer = sweeper,
        associated_token::mint = memecoin_mint,
        associated_token::authority = protocol_treasury,
    )]
    pub protocol_treasury_token_account: Box<Account<'info, TokenAccount>>,

    /// The pool's memecoin mint. Bound to `salvage_receipt.memecoin_mint`
    /// in the handler.
    pub memecoin_mint: Box<Account<'info, Mint>>,

    /// Permissionless caller: pays the treasury-ATA init rent if needed
    /// and receives the vault-ATA rent when it is closed. Cannot redirect
    /// the swept tokens (pinned destination) or the receipt state.
    #[account(mut)]
    pub sweeper: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SweepDust>, params: SweepDustParams) -> Result<()> {
    // ---- Mint binding: the submitted mint must be the receipt's mint ----
    require_keys_eq!(
        ctx.accounts.memecoin_mint.key(),
        ctx.accounts.salvage_receipt.memecoin_mint,
        GraveVaultError::PreflightFailed
    );

    // ---- One-shot guard: the receipt stamps the first successful sweep ----
    require!(
        ctx.accounts.salvage_receipt.dust_swept_at_ts == 0,
        GraveVaultError::DustAlreadySwept
    );

    // ---- Nothing to sweep: the conversion leg fully drained the ATA ----
    let dust = ctx.accounts.vault_memecoin_token_account.amount;
    require!(dust > 0, GraveVaultError::DustNothingToSweep);

    let clock = Clock::get()?;

    // ---- Transfer the ENTIRE retained balance to the treasury ATA ----
    {
        let bump = [ctx.bumps.vault_authority];
        let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &bump];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_memecoin_token_account.to_account_info(),
                to: ctx
                    .accounts
                    .protocol_treasury_token_account
                    .to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, dust)?;
    }

    // ---- Close the vault memecoin ATA; rent goes to the sweeper ----
    {
        let bump = [ctx.bumps.vault_authority];
        let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &bump];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let close_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_memecoin_token_account.to_account_info(),
                destination: ctx.accounts.sweeper.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::close_account(close_ctx)?;
    }

    // ---- Stamp the receipt ----
    let receipt = &mut ctx.accounts.salvage_receipt;
    receipt.dust_swept_at_ts = clock.unix_timestamp;

    emit!(DustSwept {
        pool_address: params.pool_address,
        memecoin_mint: ctx.accounts.memecoin_mint.key(),
        amount: dust,
        sweeper: ctx.accounts.sweeper.key(),
    });

    Ok(())
}

#[event]
pub struct DustSwept {
    pub pool_address: Pubkey,
    pub memecoin_mint: Pubkey,
    pub amount: u64,
    pub sweeper: Pubkey,
}
