// SPDX-License-Identifier: Apache-2.0
//
// Orca Whirlpool pool adapter — stub.
//
// Mainnet program ID: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
//
// Whirlpool is also concentrated-liquidity; reserves require token-vault
// aggregation rather than a single base/quote read.

use anchor_lang::prelude::*;

use super::PoolData;
use crate::errors::GraveScannerError;

/// Mainnet Orca Whirlpool program ID.
pub const PROGRAM_ID: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

/// Parse an Orca Whirlpool pool account into `PoolData`.
///
/// PRE-MAINNET-TODO(CPI): Orca Whirlpool layout parsing + token-vault reserve aggregation | reverts: AmmAdapterUnimplemented | verify: against Whirlpool SDK and mainnet pool fixtures
pub fn parse(
    _pool_account_info: &AccountInfo,
    _remaining_accounts: &[AccountInfo],
) -> Result<PoolData> {
    err!(GraveScannerError::AmmAdapterUnimplemented)
}
