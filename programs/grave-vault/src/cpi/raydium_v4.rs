// SPDX-License-Identifier: Apache-2.0
//
// Raydium V4 `Withdraw` CPI.
//
// Burns LP from the SALVOR's token account (the salvor signs the outer
// salvage transaction and therefore acts as the withdraw's `user_owner`)
// and credits base + memecoin to the vault's destination token accounts.
// The account ordering + instruction encoding below mirror
// the Raydium V4 withdraw wire format accepted by the DEPLOYED mainnet
// program — 22 accounts + 9-byte data `[tag = 4][amount u64 LE]` (the
// optional min_coin/min_pc slippage pair is omitted — absent = None)
// — verified byte-for-byte against live mainnet withdraw transactions
// (scripts/probe_v4_withdraw_order.mjs) and executed end-to-end by the
// fork harness. The vault enforces its own post-CPI bounds
// (`base_received > 0`, the Phase 3 slippage ceiling + Jupiter-leg floor).
//
// Of the 22 accounts the V4 withdraw expects, 7 come from the named
// salvage_pool `Accounts` struct: user_owner = the `salvor`, plus
// token_program, pool, lp_mint, salvor_lp_token_account (the burn source),
// vault_base_token_account and vault_memecoin_token_account. The remaining
// 13 come from `remaining_accounts` and are pool-specific (OpenBook market
// + vault internals). Their order is documented below.
//
// VERIFICATION (Phase 2.1, CPI-009): this exact ordering + count is proven
// against the real mainnet Raydium V4 bytecode in the
// solana-program-test fork harness
// (`programs/grave-vault/tests/raydium_v4_fork.rs`): the happy path must
// execute a real LP burn + reserve transfer against live AmmInfo/market
// state, and scrambled orderings must be rejected by the real program.
// Earlier revisions sent 18 accounts, which the real program rejects with
// `WrongAccountsNumber` (0x1771) on every call — caught by this harness.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::TokenAccount;

use crate::constants::{
    RAYDIUM_V4_AMM_AUTHORITY, RAYDIUM_V4_INSTRUCTION_TAG_WITHDRAW, RAYDIUM_V4_PROGRAM_ID,
    RAYDIUM_V4_WITHDRAW_REMAINING_ACCOUNTS_REQUIRED,
};
use crate::cpi::{RemoveLiquidityInput, RemoveLiquidityOutput};
use crate::errors::GraveVaultError;

/// Indices into `remaining_accounts` (13 entries). Naming matches Raydium
/// V4 source. The two padding accounts (filled with the pool account,
/// positions 8/9 of the wire list) are handled internally. Public because
/// `salvage_pool` reads the AMM coin/pc vault balances at the same indices
/// for the Phase 3 slippage ceiling.
pub mod ra_idx {
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
    pub const MARKET_BIDS: usize = 11;
    pub const MARKET_ASKS: usize = 12;
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
    // is the security boundary for the entire CPI. The same key is the
    // program account we thread into the CPI list.
    require!(
        *input.pool.owner == RAYDIUM_V4_PROGRAM_ID,
        GraveVaultError::PreflightFailed
    );
    require_keys_eq!(
        *input.amm_program.key,
        RAYDIUM_V4_PROGRAM_ID,
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

    // 9-byte data: [tag = 4][amount: u64 LE]. The optional
    // min_coin / min_pc slippage pair is omitted (absent = None); the vault
    // applies its own post-CPI checks (base_received > 0, Jupiter-leg floor).
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

    // 22-account list per the Raydium V4 withdraw wire format as accepted
    // by the DEPLOYED mainnet program — verified byte-for-byte against real
    // mainnet withdraw transactions on the SOL/USDC pool (see
    // tests/raydium_v4_fork.rs and scripts/probe_v4_withdraw_order.mjs).
    // Positions 8/9 are two padding slots; live traffic fills them with the
    // pool account itself.
    let pool_info = input.pool;
    let metas = vec![
        // 0 token_program
        AccountMeta::new_readonly(*input.token_program.key, false),
        // 1 amm
        AccountMeta::new(*input.pool.key, false),
        // 2 amm_authority (validated against the constant below)
        AccountMeta::new_readonly(*input.remaining_accounts[ra_idx::AMM_AUTHORITY].key, false),
        // 3 amm_open_orders (writable on live traffic)
        AccountMeta::new(
            *input.remaining_accounts[ra_idx::AMM_OPEN_ORDERS].key,
            false,
        ),
        // 4 amm_target_orders (V4 mutates calc_pnl_x / calc_pnl_y)
        AccountMeta::new(
            *input.remaining_accounts[ra_idx::AMM_TARGET_ORDERS].key,
            false,
        ),
        // 5 amm_lp_mint (burn)
        AccountMeta::new(*input.lp_mint.key, false),
        // 6 amm_coin_vault
        AccountMeta::new(*input.remaining_accounts[ra_idx::AMM_COIN_VAULT].key, false),
        // 7 amm_pc_vault
        AccountMeta::new(*input.remaining_accounts[ra_idx::AMM_PC_VAULT].key, false),
        // 8-9 padding (live traffic passes the pool account)
        AccountMeta::new(*pool_info.key, false),
        AccountMeta::new(*pool_info.key, false),
        // 10 market_program
        AccountMeta::new_readonly(*input.remaining_accounts[ra_idx::MARKET_PROGRAM].key, false),
        // 11 market (writable on live traffic)
        AccountMeta::new(*input.remaining_accounts[ra_idx::MARKET].key, false),
        // 12 market_coin_vault (writable on live traffic)
        AccountMeta::new(
            *input.remaining_accounts[ra_idx::MARKET_COIN_VAULT].key,
            false,
        ),
        // 13 market_pc_vault (writable on live traffic)
        AccountMeta::new(
            *input.remaining_accounts[ra_idx::MARKET_PC_VAULT].key,
            false,
        ),
        // 14 market_vault_signer (ignored — no market CPI in withdraw)
        AccountMeta::new_readonly(
            *input.remaining_accounts[ra_idx::MARKET_VAULT_SIGNER].key,
            false,
        ),
        // 15 user_lp_account (burned)
        AccountMeta::new(*input.user_lp_token_account.key, false),
        // 16 user_coin_account
        AccountMeta::new(*user_coin_acc.key, false),
        // 17 user_pc_account
        AccountMeta::new(*user_pc_acc.key, false),
        // 18 user_owner = the SALVOR (their signature on the outer salvage
        // transaction propagates through this plain invoke; writable
        // on live traffic)
        AccountMeta::new(*input.user_owner.key, true),
        // 19 market_event_queue (writable on live traffic)
        AccountMeta::new(
            *input.remaining_accounts[ra_idx::MARKET_EVENT_QUEUE].key,
            false,
        ),
        // 20 market_bids (writable on live traffic)
        AccountMeta::new(*input.remaining_accounts[ra_idx::MARKET_BIDS].key, false),
        // 21 market_asks (writable on live traffic)
        AccountMeta::new(*input.remaining_accounts[ra_idx::MARKET_ASKS].key, false),
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
        // The callee program itself — the runtime resolves the CPI's
        // program_id against the caller's account list first.
        input.amm_program.clone(),
        input.token_program.clone(),
        input.pool.clone(),
        amm_authority.clone(),
        input.remaining_accounts[ra_idx::AMM_OPEN_ORDERS].clone(),
        input.remaining_accounts[ra_idx::AMM_TARGET_ORDERS].clone(),
        input.lp_mint.clone(),
        input.remaining_accounts[ra_idx::AMM_COIN_VAULT].clone(),
        input.remaining_accounts[ra_idx::AMM_PC_VAULT].clone(),
        // padding slots (pool, twice)
        input.pool.clone(),
        input.pool.clone(),
        input.remaining_accounts[ra_idx::MARKET_PROGRAM].clone(),
        input.remaining_accounts[ra_idx::MARKET].clone(),
        input.remaining_accounts[ra_idx::MARKET_COIN_VAULT].clone(),
        input.remaining_accounts[ra_idx::MARKET_PC_VAULT].clone(),
        input.remaining_accounts[ra_idx::MARKET_VAULT_SIGNER].clone(),
        input.user_lp_token_account.clone(),
        user_coin_acc.clone(),
        user_pc_acc.clone(),
        input.user_owner.clone(),
        input.remaining_accounts[ra_idx::MARKET_EVENT_QUEUE].clone(),
        input.remaining_accounts[ra_idx::MARKET_BIDS].clone(),
        input.remaining_accounts[ra_idx::MARKET_ASKS].clone(),
    ];

    // ---------------- Snapshot pre-balances ----------------

    let pre_base = read_token_amount(input.vault_base_token_account)?;
    let pre_memecoin = read_token_amount(input.vault_memecoin_token_account)?;

    // ---------------- Invoke ----------------

    // No PDA seeds: the withdraw signer is the SALVOR, whose signature is
    // already on the outer transaction and propagates through this CPI.
    invoke(&ix, &account_infos).map_err(|_| error!(GraveVaultError::AmmRedemptionFailed))?;

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
    require!(base_received > 0, GraveVaultError::AmmRedemptionFailed);

    Ok(RemoveLiquidityOutput {
        base_received,
        memecoin_received,
    })
}
