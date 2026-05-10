// SPDX-License-Identifier: Apache-2.0
//
// AMM-pool and locker adapters. Each adapter parses a vendor-specific
// account layout into the universal `PoolData` struct consumed by the
// `criteria` evaluator. New AMM support is added by implementing a new
// adapter module here.
//
// All adapter parse functions in this milestone are honest stubs that
// revert with a named error code (`AmmAdapterUnimplemented` for AMMs,
// `LockerAdapterUnimplemented` for lockers). The architectural surface
// is exercised by virtue of compilation; runtime behavior is supplied
// by follow-up PRs that implement the actual byte-layout parsing.
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
// Top-level dispatch by AMM program ID.
// =====================================================================

/// Parse a pool account into `PoolData` based on its owning program.
///
/// `pool_account_info.owner` is matched against the known AMM program
/// IDs declared in each adapter module. Mismatches return
/// `UnsupportedAmm`; supported AMMs whose parser is not yet implemented
/// return `AmmAdapterUnimplemented`.
pub fn extract_pool_data(
    pool_account_info: &AccountInfo,
    expected_pool_address: &Pubkey,
) -> Result<PoolData> {
    require_keys_eq!(
        *pool_account_info.key,
        *expected_pool_address,
        GraveScannerError::UnsupportedAmm
    );

    let owner = pool_account_info.owner;
    if owner == &raydium_v4::PROGRAM_ID {
        raydium_v4::parse(pool_account_info)
    } else if owner == &raydium_clmm::PROGRAM_ID {
        raydium_clmm::parse(pool_account_info)
    } else if owner == &orca_whirlpool::PROGRAM_ID {
        orca_whirlpool::parse(pool_account_info)
    } else if owner == &pumpswap::PROGRAM_ID {
        pumpswap::parse(pool_account_info)
    } else if owner == &meteora::PROGRAM_ID {
        meteora::parse(pool_account_info)
    } else {
        err!(GraveScannerError::UnsupportedAmm)
    }
}
