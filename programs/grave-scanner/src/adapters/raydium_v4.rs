// SPDX-License-Identifier: Apache-2.0
//
// Raydium V4 (legacy AMM v4) pool adapter.
//
// Mainnet program ID: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
//
// The full Raydium V4 pool account layout is documented at
// https://github.com/raydium-io/raydium-amm/blob/master/program/src/state.rs.
// The fields of interest for GraveScanner are:
//   - `pool_open_time` and `swap_*_amount` counters (for last-swap heuristics)
//   - `coin_vault_amount`, `pc_vault_amount` (reserves)
//   - `lp_mint_supply` (LP supply via the lp_mint account, not the pool)
//
// Last-swap timestamp is not directly stored on-chain by Raydium V4;
// the indexer-grade approach is to use the most recent slot at which
// the swap counters changed. For the on-chain handler, the salvor SDK
// supplies this via a `record_pool_activity` instruction that the
// indexer signs (see roadmap m4).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

use super::PoolData;
use crate::errors::GraveScannerError;

/// Mainnet Raydium V4 program ID.
pub const PROGRAM_ID: Pubkey = pubkey!("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

/// Parse a Raydium V4 pool account into `PoolData`.
///
/// PRE-MAINNET-TODO(CPI): Raydium V4 pool layout parsing | reverts: AmmAdapterUnimplemented | verify: against mainnet pool fixtures (e.g. 9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2 SOL/USDC) and Raydium SDK source-of-truth field offsets
pub fn parse(_pool_account_info: &AccountInfo) -> Result<PoolData> {
    err!(GraveScannerError::AmmAdapterUnimplemented)
}
