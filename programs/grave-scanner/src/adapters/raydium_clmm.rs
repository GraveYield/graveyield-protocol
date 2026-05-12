// SPDX-License-Identifier: Apache-2.0
//
// Raydium CLMM (Concentrated Liquidity Market Maker) pool adapter — stub.
//
// Mainnet program ID: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
//
// Concentrated liquidity introduces tick-range reserve calculation; this
// adapter must aggregate across active tick ranges rather than reading a
// single vault pair. v1.1 milestone.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

use super::PoolData;
use crate::errors::GraveScannerError;

/// Mainnet Raydium CLMM program ID.
pub const PROGRAM_ID: Pubkey = pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

/// Parse a Raydium CLMM pool account into `PoolData`.
///
/// PRE-MAINNET-TODO(CPI): Raydium CLMM pool layout parsing + tick-range reserve calculation | reverts: AmmAdapterUnimplemented | verify: against mainnet pool fixtures and Raydium CLMM SDK
pub fn parse<'info>(
    _pool_account_info: &AccountInfo<'info>,
    _remaining_accounts: &[AccountInfo<'info>],
) -> Result<PoolData> {
    err!(GraveScannerError::AmmAdapterUnimplemented)
}
