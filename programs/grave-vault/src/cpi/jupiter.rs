// SPDX-License-Identifier: Apache-2.0
//
// Jupiter v6 swap CPI helper.
//
// The salvor's bot pre-computes the route via Jupiter's quote API and passes
// the encoded `route` instruction data + the per-route accounts as inputs
// to `salvage_pool`. This helper builds the cross-program invocation with
// `vault_authority` as the signer (the vault owns the source memecoin) and
// returns the delta of the destination base-token account balance.
//
// Slippage is enforced by the caller after this returns — compare the
// returned `output_amount` against `params.min_quote_output_lamports` (or
// the dust-threshold pre-check that may have skipped the call entirely).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::TokenAccount;

use crate::constants::{JUPITER_V6_PROGRAM_ID, VAULT_AUTHORITY_SEED};
use crate::errors::GraveVaultError;

/// Input to the Jupiter v6 swap CPI.
pub struct JupiterSwapInput<'a, 'info> {
    pub vault_authority: &'a AccountInfo<'info>,
    /// The vault's destination token account for the swap output. We snapshot
    /// its balance pre/post to compute the actual output amount (independent
    /// of any quoted-output value passed in `route_data`).
    pub destination_token_account: &'a AccountInfo<'info>,
    /// Route accounts the salvor's quote produced. Forwarded verbatim to
    /// Jupiter v6. Salvor is responsible for ordering correctly.
    pub route_accounts: &'a [AccountInfo<'info>],
    /// Route instruction data (typically Jupiter v6 `route` discriminator +
    /// encoded plan). Forwarded verbatim.
    pub route_data: Vec<u8>,
    /// PDA bump for `vault_authority`.
    pub vault_authority_bump: u8,
}

/// Result of a Jupiter swap: actual lamports/tokens delivered to the
/// destination token account (post - pre balance).
#[derive(Clone, Copy, Debug, Default)]
pub struct JupiterSwapOutput {
    pub output_amount: u64,
}

pub fn swap<'a, 'info>(input: JupiterSwapInput<'a, 'info>) -> Result<JupiterSwapOutput> {
    // Empty route is an obvious caller bug — fail early rather than make
    // Jupiter return a less helpful error.
    require!(
        !input.route_data.is_empty(),
        GraveVaultError::JupiterSwapFailed
    );

    // Snapshot destination token account balance.
    let pre_balance: u64 = {
        let data = input.destination_token_account.try_borrow_data()?;
        let acct = TokenAccount::try_deserialize(&mut &data[..])
            .map_err(|_| error!(GraveVaultError::JupiterSwapFailed))?;
        acct.amount
    };

    // Build CPI. Jupiter's route doesn't require the destination token
    // account to be in any specific position — it's part of `route_accounts`.
    // We just forward what the salvor's quote produced.
    let mut metas: Vec<AccountMeta> = Vec::with_capacity(input.route_accounts.len());
    for acct in input.route_accounts.iter() {
        metas.push(AccountMeta {
            pubkey: *acct.key,
            is_signer: acct.is_signer,
            is_writable: acct.is_writable,
        });
    }
    // Ensure vault_authority is marked signer in the meta list (it must be
    // because we sign for it). The salvor's quote may or may not have
    // flagged this; the actual signing happens via invoke_signed's seeds.
    for meta in metas.iter_mut() {
        if meta.pubkey == *input.vault_authority.key {
            meta.is_signer = true;
        }
    }

    let ix = Instruction {
        program_id: JUPITER_V6_PROGRAM_ID,
        accounts: metas,
        data: input.route_data,
    };

    // Build account list for invoke_signed — must include every account
    // referenced by the instruction's metas. The salvor provided them in
    // `route_accounts`.
    let mut account_infos: Vec<AccountInfo<'info>> =
        Vec::with_capacity(input.route_accounts.len());
    for acct in input.route_accounts.iter() {
        account_infos.push((*acct).clone());
    }

    let bump = [input.vault_authority_bump];
    let signer_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &bump];
    invoke_signed(&ix, &account_infos, &[signer_seeds])
        .map_err(|_| error!(GraveVaultError::JupiterSwapFailed))?;

    // Snapshot post balance.
    let post_balance: u64 = {
        let data = input.destination_token_account.try_borrow_data()?;
        let acct = TokenAccount::try_deserialize(&mut &data[..])
            .map_err(|_| error!(GraveVaultError::JupiterSwapFailed))?;
        acct.amount
    };

    let output_amount = post_balance
        .checked_sub(pre_balance)
        .ok_or(error!(GraveVaultError::MathOverflow))?;

    Ok(JupiterSwapOutput { output_amount })
}
