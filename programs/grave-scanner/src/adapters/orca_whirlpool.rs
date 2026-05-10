// SPDX-License-Identifier: Apache-2.0
//
// Orca Whirlpool pool adapter.
//
// Mainnet program ID: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
//
// Whirlpool accounts hold sqrt_price_x64 and tick state; reserves
// are computed from token-vault accounts owned by the whirlpool. The
// `Whirlpool::reward_last_updated_timestamp` and explicit on-chain
// counters can serve as an upper bound on the last-swap timestamp.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

use super::PoolData;
use crate::errors::GraveScannerError;

/// Mainnet Orca Whirlpool program ID.
pub const PROGRAM_ID: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

/// Parse an Orca Whirlpool account into `PoolData`.
///
/// PRE-MAINNET-TODO(CPI): Orca Whirlpool layout parsing + token-vault reserve aggregation | reverts: AmmAdapterUnimplemented | verify: against Whirlpool SDK and mainnet pool fixtures
pub fn parse(_pool_account_info: &AccountInfo) -> Result<PoolData> {
    err!(GraveScannerError::AmmAdapterUnimplemented)
}
