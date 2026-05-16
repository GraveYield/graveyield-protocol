// SPDX-License-Identifier: Apache-2.0
//
// Raydium V4 `Withdraw` CPI.
//
// Burns LP from `vault_lp_token_account` (vault_authority PDA-signs as
// `user_owner`) and credits base + memecoin to the vault's destination
// token accounts. The exact account ordering below mirrors Raydium V4
// `processor.rs::process_withdraw`. The instruction discriminator is
// `u8 = 4`; the data layout is `[tag][amount: u64 LE]` = 9 bytes.
//
// Of the 18 accounts the V4 withdraw expects, 7 come from the named
// salvage_pool `Accounts` struct (token_program, pool, lp_mint,
// vault_lp_token_account, vault_base_token_account,
// vault_memecoin_token_account, vault_authority). The remaining 11 come
// from `remaining_accounts` and are pool-specific (OpenBook market +
// vault internals). Their order is documented below.
//
// PRE-MAINNET-TODO(CPI): Verify the account order against a live Raydium
// V4 pool (e.g. 9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2) via a
// solana-program-test fork test before mainnet. The amm_authority
// validation below catches an obviously-wrong layout (account at
// remaining[0] must equal the fixed RAYDIUM_V4_AMM_AUTHORITY) but does
// not catch a swap of, say, amm_open_orders ↔ amm_target_orders.
// See `docs/PRE_MAINNET_CHECKLIST.md` entry CPI-001 (retired by PR #13
// for the Scanner-side adapter; this is the Vault-side counterpart).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::TokenAccount;

use crate::constants::{
    RAYDIUM_V4_AMM_AUTHORITY, RAYDIUM_V4_INSTRUCTION_TAG_WITHDRAW, RAYDIUM_V4_PROGRAM_ID,
    RAYDIUM_V4_WITHDRAW_REMAINING_ACCOUNTS_REQUIRED, VAULT_AUTHORITY_SEED,
};
use crate::cpi::{RemoveLiquidityInput, RemoveLiquidityOutput};
use crate::errors::GraveVaultError;

/// Indices into `remaining_accounts`. Naming matches Raydium V4 source.
mod ra_idx {
    pub const AMM_AUTHORITY: usize = 0;
    pub const AMM_OPEN_ORDERS: usize = 1;
    pub const AMM_TARGET_ORDERS: usize = 2;
    pub const AMM_COIN_VAULT: usize = 3;
    pub const AMM_PC_VAULT: usize = 4;
    pub const MARKET_PROGRAM: usize = 5;
    pub const MARKET: usize = 6;
    pub const MARKET_COIN_VAULT: usize = 7;
    pub const MARKET_PC_VAULT: usize = 8;
    pub const MARKET_VAULT_SIGNER: usize = 9;
    pub const MARKET_EVENT_QUEUE: usize = 10;
}

/// Read a token account's `amount` field by deserialising the raw account
/// data. Avoids requiring an `Account<TokenAccount>` wrapper here — the
/// `AccountInfo` is already mutable-borrowed during the CPI flow.
fn read_token_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    let acct = TokenAccount::try_deserialize(&mut &data[..])
        .map_err(|_| error!(GraveVaultError::AmmRedemptionFailed))?;
    Ok(acct.amount)
}

pub fn remove_liquidity<'a, 'info>(
    input: RemoveLiquidityInput<'a, 'info>,
) -> Result<RemoveLiquidityOutput> {
    // ---------------- Validate inputs ----------------

    // The remaining_accounts slice must have exactly the required count.
    require!(
        input.remaining_accounts.len() == RAYDIUM_V4_WITHDRAW_REMAINING_ACCOUNTS_REQUIRED,
        GraveVaultError::PreflightFailed
    );

    // Pool must be owned by the Raydium V4 program. The dispatcher already
    // routed us here on that basis, but we re-assert because pool ownership
    // is the security boundary for the entire CPI.
    require!(
        *input.pool.owner == RAYDIUM_V4_PROGRAM_ID,
        GraveVaultError::PreflightFailed
    );

    // amm_authority is a fixed PDA — validating it catches an obviously
    // wrong remaining_accounts ordering without depending on a real fork
    // test. (See the PRE-MAINNET-TODO note in the module header.)
    let amm_authority = &input.remaining_accounts[ra_idx::AMM_AUTHORITY];
    require_keys_eq!(
        *amm_authority.key,
        RAYDIUM_V4_AMM_AUTHORITY,
        GraveVaultError::PreflightFailed
    );

    // ---------------- Build instruction ----------------

    // 9-byte data: [tag = 4][amount: u64 LE]
    let mut data = Vec::with_capacity(9);
    data.push(RAYDIUM_V4_INSTRUCTION_TAG_WITHDRAW);
    data.extend_from_slice(&input.lp_amount.to_le_bytes());

    // Decide which of vault_base / vault_memecoin maps to user_coin vs
    // user_pc based on the salvage_pool handler's mint inspection.
    let (user_coin_acc, user_pc_acc) = if input.base_is_coin_side {
        // Pool's coin side is the base (WSOL). Withdraw deposits coin →
        // vault_base, pc → vault_memecoin.
        (
            input.vault_base_token_account,
            input.vault_memecoin_token_account,
        )
    } else {
        // Pool's pc side is the base. Swap them.
        (
            input.vault_memecoin_token_account,
            input.vault_base_token_account,
        )
    };

    // 18-account list per Raydium V4 processor::process_withdraw.
    let metas = vec![
        // 0 token_program
        AccountMeta::new_readonly(*input.token_program.key, false),
        // 1 amm
        AccountMeta::new(*input.pool.key, false),
        // 2 amm_authority
        AccountMeta::new_readonly(RAYDIUM_V4_AMM_AUTHORITY, false),
        // 3 amm_open_orders
        AccountMeta::new(
            *input.remaining_accounts[ra_idx::AMM_OPEN_ORDERS].key,
            false,
        ),
        // 4 amm_target_orders
        AccountMeta::new(
            *input.remaining_accounts[ra_idx::AMM_TARGET_ORDERS].key,
            false,
        ),
        // 5 amm_lp_mint
        AccountMeta::new(*input.lp_mint.key, false),
        // 6 amm_coin_vault
        AccountMeta::new(*input.remaining_accounts[ra_idx::AMM_COIN_VAULT].key, false),
        // 7 amm_pc_vault
        AccountMeta::new(*input.remaining_accounts[ra_idx::AMM_PC_VAULT].key, false),
        // 8 market_program
        AccountMeta::new_readonly(*input.remaining_accounts[ra_idx::MARKET_PROGRAM].key, false),
        // 9 market
        AccountMeta::new(*input.remaining_accounts[ra_idx::MARKET].key, false),
        // 10 market_coin_vault
        AccountMeta::new(
            *input.remaining_accounts[ra_idx::MARKET_COIN_VAULT].key,
            false,
        ),
        // 11 market_pc_vault
        AccountMeta::new(*input.remaining_accounts[ra_idx::MARKET_PC_VAULT].key, false),
        // 12 market_vault_signer
        AccountMeta::new_readonly(
            *input.remaining_accounts[ra_idx::MARKET_VAULT_SIGNER].key,
            false,
        ),
        // 13 user_lp_account (signer = user_owner)
        AccountMeta::new(*input.vault_lp_token_account.key, false),
        // 14 user_coin_account
        AccountMeta::new(*user_coin_acc.key, false),
        // 15 user_pc_account
        AccountMeta::new(*user_pc_acc.key, false),
        // 16 user_owner = vault_authority (signer via invoke_signed)
        AccountMeta::new_readonly(*input.vault_authority.key, true),
        // 17 market_event_queue
        AccountMeta::new(
            *input.remaining_accounts[ra_idx::MARKET_EVENT_QUEUE].key,
            false,
        ),
    ];

    let ix = Instruction {
        program_id: RAYDIUM_V4_PROGRAM_ID,
        accounts: metas,
        data,
    };

    // Account-infos list passed to invoke_signed must contain every account
    // referenced by the instruction's metas. Order doesn't have to match
    // the meta list — invoke_signed resolves by pubkey.
    let account_infos: Vec<AccountInfo<'info>> = vec![
        input.token_program.clone(),
        input.pool.clone(),
        amm_authority.clone(),
        input.remaining_accounts[ra_idx::AMM_OPEN_ORDERS].clone(),
        input.remaining_accounts[ra_idx::AMM_TARGET_ORDERS].clone(),
        input.lp_mint.clone(),
        input.remaining_accounts[ra_idx::AMM_COIN_VAULT].clone(),
        input.remaining_accounts[ra_idx::AMM_PC_VAULT].clone(),
        input.remaining_accounts[ra_idx::MARKET_PROGRAM].clone(),
        input.remaining_accounts[ra_idx::MARKET].clone(),
        input.remaining_accounts[ra_idx::MARKET_COIN_VAULT].clone(),
        input.remaining_accounts[ra_idx::MARKET_PC_VAULT].clone(),
        input.remaining_accounts[ra_idx::MARKET_VAULT_SIGNER].clone(),
        input.vault_lp_token_account.clone(),
        user_coin_acc.clone(),
        user_pc_acc.clone(),
        input.vault_authority.clone(),
        input.remaining_accounts[ra_idx::MARKET_EVENT_QUEUE].clone(),
    ];

    // ---------------- Snapshot pre-balances ----------------

    let pre_base = read_token_amount(input.vault_base_token_account)?;
    let pre_memecoin = read_token_amount(input.vault_memecoin_token_account)?;

    // ---------------- Invoke ----------------

    let bump = [input.vault_authority_bump];
    let signer_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &bump];
    invoke_signed(&ix, &account_infos, &[signer_seeds])
        .map_err(|_| error!(GraveVaultError::AmmRedemptionFailed))?;

    // ---------------- Snapshot post-balances + return delta ----------------

    let post_base = read_token_amount(input.vault_base_token_account)?;
    let post_memecoin = read_token_amount(input.vault_memecoin_token_account)?;

    let base_received = post_base
        .checked_sub(pre_base)
        .ok_or(error!(GraveVaultError::MathOverflow))?;
    let memecoin_received = post_memecoin
        .checked_sub(pre_memecoin)
        .ok_or(error!(GraveVaultError::MathOverflow))?;

    // A zero-base receive on a non-trivial LP burn is a strong signal that
    // something went wrong (e.g. the pool is empty, or accounts were
    // mis-mapped). We reject it explicitly rather than let the downstream
    // distribution math silently emit zero salvor / lp_holder shares.
    require!(
        base_received > 0,
        GraveVaultError::AmmRedemptionFailed
    );

    Ok(RemoveLiquidityOutput {
        base_received,
        memecoin_received,
    })
}
