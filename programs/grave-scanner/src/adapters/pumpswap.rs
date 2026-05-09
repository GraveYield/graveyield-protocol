// SPDX-License-Identifier: Apache-2.0
//
// PumpSwap (pump.fun's bonding-curve graduated AMM) pool adapter.
//
// Mainnet program ID: PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP
//
// PumpSwap is the post-graduation AMM for pump.fun tokens that
// reach the bonding-curve cap. Pre-graduation pools live in the
// pump.fun program itself and are out of scope for derelict-pool
// salvage (graduations are gated by liquidity thresholds GraveYield
// would never trigger on).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

use super::PoolData;
use crate::errors::GraveScannerError;

/// Mainnet PumpSwap program ID.
pub const PROGRAM_ID: Pubkey = pubkey!("PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP");

/// Parse a PumpSwap pool account into `PoolData`.
///
/// PRE-MAINNET-TODO(CPI): PumpSwap pool layout parsing | reverts: AmmAdapterUnimplemented | verify: against PumpSwap SDK and mainnet pool fixtures
pub fn parse(_pool_account_info: &AccountInfo) -> Result<PoolData> {
    err!(GraveScannerError::AmmAdapterUnimplemented)
}
