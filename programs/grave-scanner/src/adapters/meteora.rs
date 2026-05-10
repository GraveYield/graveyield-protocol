// SPDX-License-Identifier: Apache-2.0
//
// Meteora DLMM / Dynamic Pools adapter.
//
// Mainnet program ID is parameterizable per pool variant (DLMM vs
// Dynamic AMM); the placeholder below is the DLMM program. Meteora
// support is a v1.1 roadmap item; V4/Whirlpool cover the v1.0 launch
// scope.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

use super::PoolData;
use crate::errors::GraveScannerError;

/// Meteora DLMM program ID.
///
/// PRE-MAINNET-TODO(KEYS): confirm Meteora DLMM mainnet program ID and add Dynamic AMM variant | reverts: UnsupportedAmm if owner mismatch | verify: against Meteora SDK constants
pub const PROGRAM_ID: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

/// Parse a Meteora pool account into `PoolData`.
///
/// PRE-MAINNET-TODO(CPI): Meteora DLMM/Dynamic AMM pool layout parsing | reverts: AmmAdapterUnimplemented | verify: against Meteora SDK
pub fn parse(_pool_account_info: &AccountInfo) -> Result<PoolData> {
    err!(GraveScannerError::AmmAdapterUnimplemented)
}
