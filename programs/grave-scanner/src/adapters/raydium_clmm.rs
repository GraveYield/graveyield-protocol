// SPDX-License-Identifier: Apache-2.0
//
// Raydium CLMM (concentrated liquidity) pool adapter.
//
// Mainnet program ID: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
//
// CLMM pool state lives in `PoolState` accounts; reserves are
// derived from the active tick range and not directly stored as
// "amounts" the way V4 does. Salvage of CLMM positions is a v1.1
// roadmap item — V4 covers the bulk of derelict pools.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

use super::PoolData;
use crate::errors::GraveScannerError;

/// Mainnet Raydium CLMM program ID.
pub const PROGRAM_ID: Pubkey = pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

/// Parse a Raydium CLMM pool account into `PoolData`.
///
/// PRE-MAINNET-TODO(CPI): Raydium CLMM pool layout parsing + tick-range reserve calculation | reverts: AmmAdapterUnimplemented | verify: against mainnet pool fixtures and Raydium CLMM SDK
pub fn parse(_pool_account_info: &AccountInfo) -> Result<PoolData> {
    err!(GraveScannerError::AmmAdapterUnimplemented)
}
