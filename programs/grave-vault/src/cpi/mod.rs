// SPDX-License-Identifier: Apache-2.0
//
// AMM-specific CPI helpers for the salvage_pool execution path. Each adapter
// implements `remove_liquidity` returning the (base, memecoin) amounts
// received. Dispatch by `pool.owner.key()`.
//
// Raydium V4 is the only real implementation in m5; CLMM, Orca Whirlpool,
// and PumpSwap return `AmmCpiUnimplemented` (honest-stub pattern per
// `docs/PRE_MAINNET_CHECKLIST.md`). Each stub is a separate file rather than
// a single match arm so adding a real implementation later is a localised
// change.

pub mod jupiter;
pub mod orca_whirlpool;
pub mod pump_swap;
pub mod raydium_clmm;
pub mod raydium_v4;

use anchor_lang::prelude::*;

use crate::constants::{
    ORCA_WHIRLPOOL_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID, RAYDIUM_CLMM_PROGRAM_ID,
    RAYDIUM_V4_PROGRAM_ID,
};
use crate::errors::GraveVaultError;

/// Result of a single AMM `remove_liquidity` CPI: gross amounts transferred
/// into the vault's base + memecoin token accounts, computed as the
/// post-call balance minus the pre-call balance.
#[derive(Clone, Copy, Debug, Default)]
pub struct RemoveLiquidityOutput {
    pub base_received: u64,
    pub memecoin_received: u64,
}

/// Inputs for AMM `remove_liquidity` CPI. The vault holds the LP tokens at
/// call time (salvor pre-transferred salvor_lp_amount before the CPI). The
/// CPI burns those LP and credits base + memecoin to vault token accounts;
/// `vault_authority` PDA-signs as the LP token account's owner via
/// `invoke_signed`.
pub struct RemoveLiquidityInput<'a, 'info> {
    pub pool: &'a AccountInfo<'info>,
    pub vault_authority: &'a AccountInfo<'info>,
    pub vault_lp_token_account: &'a AccountInfo<'info>,
    pub vault_base_token_account: &'a AccountInfo<'info>,
    pub vault_memecoin_token_account: &'a AccountInfo<'info>,
    pub lp_mint: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    /// LP amount to burn. Must equal the balance of `vault_lp_token_account`
    /// at call time (we burn the full vault LP holding atomically).
    pub lp_amount: u64,
    /// `true` if pool's "coin" side is the base (WSOL), `false` if "pc" side
    /// is the base. Set by the salvage_pool handler after mint inspection.
    pub base_is_coin_side: bool,
    /// PDA bump for `vault_authority` — `[VAULT_AUTHORITY_SEED, &[bump]]`.
    pub vault_authority_bump: u8,
    /// Pool-specific accounts (OpenBook market, vault signer, etc.) that
    /// aren't in the named `Accounts` struct. Length is asserted by the
    /// adapter against `RAYDIUM_V4_WITHDRAW_REMAINING_ACCOUNTS_REQUIRED`
    /// (or the equivalent for other AMMs).
    pub remaining_accounts: &'a [AccountInfo<'info>],
}

/// Dispatch by `pool.owner.key()`. Non-Raydium-V4 AMMs revert with
/// `AmmCpiUnimplemented` (7017). The honest-stub pattern keeps the
/// architectural surface exercised end-to-end while the real CLMM/Orca/
/// PumpSwap adapters are deferred to v1.1.
pub fn dispatch_remove_liquidity<'a, 'info>(
    input: RemoveLiquidityInput<'a, 'info>,
) -> Result<RemoveLiquidityOutput> {
    let pool_owner = *input.pool.owner;
    if pool_owner == RAYDIUM_V4_PROGRAM_ID {
        raydium_v4::remove_liquidity(input)
    } else if pool_owner == RAYDIUM_CLMM_PROGRAM_ID {
        raydium_clmm::remove_liquidity(input)
    } else if pool_owner == ORCA_WHIRLPOOL_PROGRAM_ID {
        orca_whirlpool::remove_liquidity(input)
    } else if pool_owner == PUMP_SWAP_PROGRAM_ID {
        pump_swap::remove_liquidity(input)
    } else {
        Err(error!(GraveVaultError::AmmCpiUnimplemented))
    }
}
