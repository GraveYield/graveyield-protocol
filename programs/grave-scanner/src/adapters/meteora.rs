// SPDX-License-Identifier: Apache-2.0
//
// Meteora (DLMM + Dynamic AMM) pool adapter — stub.
//
// Mainnet program ID is AUDIT-PENDING — both Meteora DLMM and Dynamic AMM
// are supported targets; the canonical placeholder here resolves to the
// DLMM program at the time of writing but the KEYS-001 row in
// docs/PRE_MAINNET_CHECKLIST.md tracks the confirmation step.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

use super::PoolData;
use crate::errors::GraveScannerError;

/// Mainnet Meteora DLMM program ID — placeholder until confirmed.
///
/// PRE-MAINNET-TODO(KEYS): confirm Meteora DLMM mainnet program ID and add Dynamic AMM variant | reverts: UnsupportedAmm if owner mismatch | verify: against Meteora SDK constants
pub const PROGRAM_ID: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

/// Parse a Meteora pool account into `PoolData`.
///
/// PRE-MAINNET-TODO(CPI): Meteora DLMM/Dynamic AMM pool layout parsing | reverts: AmmAdapterUnimplemented | verify: against Meteora SDK
pub fn parse<'info>(
    _pool_account_info: &AccountInfo<'info>,
    _remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<PoolData> {
    err!(GraveScannerError::AmmAdapterUnimplemented)
}
