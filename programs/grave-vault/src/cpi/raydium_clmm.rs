// SPDX-License-Identifier: Apache-2.0
//
// Raydium CLMM (Concentrated Liquidity Market Maker) — honest-stub adapter for m5.
//
// Mainnet program ID: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
//
// Raydium CLMM is a concentrated-liquidity AMM. Removing liquidity
// requires a position NFT and tick-range fee collection, mirroring the
// Orca Whirlpool shape but with Raydium's own account layout and
// instruction encoding. The full position-burn semantics are deferred
// to v1.1.
//
// Refuses-first: reverts with `AmmCpiUnimplemented` (7017) today rather
// than silently succeeding, so a salvor that targets a Raydium CLMM
// pool gets an explicit, named error. The dispatcher
// (`cpi::dispatch_remove_liquidity`) routes here on `pool.owner` match;
// a non-CLMM owner never reaches this code path.
//
// See `docs/PRE_MAINNET_CHECKLIST.md` entry `CPI-006`.

use anchor_lang::prelude::*;

use crate::constants::RAYDIUM_CLMM_PROGRAM_ID;
use crate::cpi::{RemoveLiquidityInput, RemoveLiquidityOutput};
use crate::errors::GraveVaultError;

/// Mainnet Raydium CLMM program ID. Mirrors the constant in
/// `crate::constants` so a reader of this adapter sees the dispatch key
/// without jumping files. The dispatcher re-derives the match from
/// `pool.owner` at runtime; this const is for documentation and
/// future test scaffolding.
pub const PROGRAM_ID: Pubkey = RAYDIUM_CLMM_PROGRAM_ID;

/// `remove_liquidity` for Raydium CLMM — honest-stub.
///
/// PRE-MAINNET-TODO(CPI-006): Implement the real Raydium CLMM
/// position-burn CPI before mainnet. Concentrated-liquidity withdraw
/// requires: (1) position NFT ownership, (2) `collect_fees` across the
/// position's tick range, (3) `decrease_liquidity` to claim base +
/// memecoin reserves, (4) position burn. The account layout and
/// remaining_accounts shape will differ materially from Raydium V4's
/// 22-account withdraw. | reverts: `AmmCpiUnimplemented` (7017) |
/// verify: against Raydium CLMM SDK and mainnet position-burn
/// transactions in a fork harness mirroring `tests/raydium_v4_fork.rs`.
pub fn remove_liquidity<'a, 'info>(
    _input: RemoveLiquidityInput<'a, 'info>,
) -> Result<RemoveLiquidityOutput> {
    Err(error!(GraveVaultError::AmmCpiUnimplemented))
}
