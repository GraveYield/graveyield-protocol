// SPDX-License-Identifier: Apache-2.0
//
// AMM-pool and locker adapters. Each adapter parses a vendor-specific
// account layout into the universal `PoolData` struct consumed by the
// `criteria` evaluator. New AMM support is added by implementing a new
// adapter module here.
//
// Convention since m4 (Raydium V4 layout adapter): each adapter takes
// both the pool account AND the `remaining_accounts` slice. Reserves and
// LP supply for the pool live on separate SPL token accounts (the pool's
// coin_vault, pc_vault, lp_mint) — these MUST be included in
// `remaining_accounts` by the caller. Adapters look them up by Pubkey.
// Adapters whose layout parsing isn't yet implemented continue to revert
// `AmmAdapterUnimplemented`.
//
// Locker adapter (`locker.rs`) follows the same `remaining_accounts`
// convention for UNCX / PinkSale / Team Finance locker container accounts.
//
// Auditor's one-liner: `grep -rn "PRE-MAINNET-TODO" programs/`.

use anchor_lang::prelude::*;

use crate::errors::GraveScannerError;

pub mod locker;
pub mod meteora;
pub mod orca_whirlpool;
pub mod pumpswap;
pub mod raydium_clmm;
pub mod raydium_v4;

// =====================================================================
// Universal pool data shape.
// =====================================================================

/// AMM-agnostic snapshot of a pool's state at the moment of evaluation.
/// Produced by `extract_pool_data` and fed into the `criteria` module.
#[derive(Clone, Copy, Debug)]
pub struct PoolData {
    /// Unix timestamp of the last on-chain swap. Used for Criterion 1.
    /// AMM-specific: Raydium V4 does not store a last-swap timestamp on
    /// the pool account; in that case the adapter returns 0 and the
    /// handler reads `last_swap_unix_ts` from instruction params instead
    /// (gated by the ORACLE-002 PRE-MAINNET-TODO until indexer-signed
    /// attestation lands).
    pub last_swap_unix_ts: i64,
    /// Base-side reserves (the memecoin / measured token).
    pub base_reserve: u64,
    /// Quote-side reserves (typically lamports of SOL or base units of USDC).
    pub quote_reserve: u64,
    /// Outstanding LP token supply. Used for Criterion 4.
    pub lp_supply: u64,
    /// Mint of the base token.
    pub base_mint: Pubkey,
    /// Mint of the quote token.
    pub quote_mint: Pubkey,
    /// LP mint — needed for the Criterion 5 locker check.
    pub lp_mint: Pubkey,
}

impl PoolData {
    /// Compute the current price as quote-per-base in Q64.64 fixed-point.
    /// Returns `Err(MathOverflow)` on degenerate inputs (zero base reserves).
    pub fn current_price_q64x64(&self) -> Result<u128> {
        require!(self.base_reserve > 0, GraveScannerError::PoolDataParseError);
        let scaled = (self.quote_reserve as u128)
            .checked_shl(64)
            .ok_or(GraveScannerError::MathOverflow)?;
        scaled
            .checked_div(self.base_reserve as u128)
            .ok_or_else(|| GraveScannerError::MathOverflow.into())
    }
}

// =====================================================================
// Account-lookup helper for adapter parsers.
// =====================================================================

/// Find an `AccountInfo` in `accounts` whose key matches `key`.
///
/// Adapters call this to resolve the pool's vault and lp_mint accounts
/// from the instruction's `remaining_accounts` slice.
pub fn find_account_by_key<'info>(
    accounts: &'info [AccountInfo<'info>],
    key: &Pubkey,
) -> Result<&'info AccountInfo<'info>> {
    accounts
        .iter()
        .find(|info| info.key == key)
        .ok_or_else(|| GraveScannerError::PoolDataParseError.into())
}

// =====================================================================
// Top-level dispatch by AMM program ID.
// =====================================================================

/// Parse a pool account into `PoolData` based on its owning program.
///
/// `pool_account_info.owner` is matched against the known AMM program
/// IDs declared in each adapter module. Mismatches return
/// `UnsupportedAmm`; supported AMMs whose parser is not yet implemented
/// return `AmmAdapterUnimplemented`.
///
/// `remaining_accounts` is the full instruction `remaining_accounts`
/// slice. Adapters look up the pool's vault and lp_mint accounts here.
pub fn extract_pool_data<'info>(
    pool_account_info: &AccountInfo<'info>,
    expected_pool_address: &Pubkey,
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<PoolData> {
    require_keys_eq!(
        *pool_account_info.key,
        *expected_pool_address,
        GraveScannerError::UnsupportedAmm
    );

    let owner = pool_account_info.owner;
    if owner == &raydium_v4::PROGRAM_ID {
        raydium_v4::parse(pool_account_info, remaining_accounts)
    } else if owner == &raydium_clmm::PROGRAM_ID {
        raydium_clmm::parse(pool_account_info, remaining_accounts)
    } else if owner == &orca_whirlpool::PROGRAM_ID {
        orca_whirlpool::parse(pool_account_info, remaining_accounts)
    } else if owner == &pumpswap::PROGRAM_ID {
        pumpswap::parse(pool_account_info, remaining_accounts)
    } else if owner == &meteora::PROGRAM_ID {
        meteora::parse(pool_account_info, remaining_accounts)
    } else {
        err!(GraveScannerError::UnsupportedAmm)
    }
}
