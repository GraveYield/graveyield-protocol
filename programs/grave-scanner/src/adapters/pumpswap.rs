// SPDX-License-Identifier: Apache-2.0
//
// PumpSwap (pump.fun graduated AMM) pool adapter — stub.
//
// Mainnet program ID: PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP
//
// PumpSwap pools share a similar two-vault shape with Raydium V4, but
// the AMM account layout differs in field offsets and the vault types.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

use super::PoolData;
use crate::errors::GraveScannerError;

/// Mainnet PumpSwap program ID.
pub const PROGRAM_ID: Pubkey = pubkey!("PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP");

/// Parse a PumpSwap pool account into `PoolData`.
///
/// PRE-MAINNET-TODO(CPI): PumpSwap pool layout parsing | reverts: AmmAdapterUnimplemented | verify: against PumpSwap SDK and mainnet pool fixtures
pub fn parse<'info>(
    _pool_account_info: &AccountInfo<'info>,
    _remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<PoolData> {
    err!(GraveScannerError::AmmAdapterUnimplemented)
}
