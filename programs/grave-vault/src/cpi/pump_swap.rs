// SPDX-License-Identifier: Apache-2.0
//
// PumpSwap — honest-stub adapter for m5.
//
// Mainnet program ID: PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP
//
// PumpSwap (pump.fun graduated AMM) pools share a similar two-vault
// shape with Raydium V4, but the AMM account layout differs in field
// offsets and the vault types. A V4-style withdraw is not wire-
// compatible; the real adapter must parse the PumpSwap pool account
// and emit the program's own withdraw instruction encoding.
//
// Refuses-first: reverts with `AmmCpiUnimplemented` (7017) today rather
// than silently succeeding, so a salvor that targets a PumpSwap pool
// gets an explicit, named error. The dispatcher
// (`cpi::dispatch_remove_liquidity`) routes here on `pool.owner` match;
// a non-PumpSwap owner never reaches this code path.
//
// See `docs/PRE_MAINNET_CHECKLIST.md` entry `CPI-008`.

use anchor_lang::prelude::*;

use crate::constants::PUMP_SWAP_PROGRAM_ID;
use crate::cpi::{RemoveLiquidityInput, RemoveLiquidityOutput};
use crate::errors::GraveVaultError;

/// Mainnet PumpSwap program ID. Mirrors the constant in
/// `crate::constants` so a reader of this adapter sees the dispatch key
/// without jumping files. The dispatcher re-derives the match from
/// `pool.owner` at runtime; this const is for documentation and
/// future test scaffolding.
pub const PROGRAM_ID: Pubkey = PUMP_SWAP_PROGRAM_ID;

/// `remove_liquidity` for PumpSwap — honest-stub.
///
/// PRE-MAINNET-TODO(CPI-008): Implement the real PumpSwap
/// `remove_liquidity` CPI before mainnet. PumpSwap's withdraw instruction
/// expects a different account list and instruction encoding than
/// Raydium V4's 22-account `[tag=4][amount]` wire format; the adapter
/// must parse the PumpSwap pool account to derive base orientation and
/// bind the submitted mints to the pool's own bytes (same CPI-010
/// discipline as the V4 path). | reverts: `AmmCpiUnimplemented` (7017)
/// | verify: against PumpSwap SDK and mainnet withdraw transactions in
/// a fork harness mirroring `tests/raydium_v4_fork.rs`.
pub fn remove_liquidity<'a, 'info>(
    _input: RemoveLiquidityInput<'a, 'info>,
) -> Result<RemoveLiquidityOutput> {
    Err(error!(GraveVaultError::AmmCpiUnimplemented))
}
