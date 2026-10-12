// SPDX-License-Identifier: Apache-2.0
//
// Orca Whirlpool — honest-stub adapter for m5.
//
// Mainnet program ID: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
//
// Orca Whirlpool is a concentrated-liquidity AMM. Removing liquidity
// requires burning a position NFT and collecting fees across the
// position's tick range — a fundamentally different account layout
// from Raydium V4's single-pool withdraw. The full position-burn
// semantics are deferred to v1.1.
//
// Refuses-first: reverts with `AmmCpiUnimplemented` (7017) today rather
// than silently succeeding, so a salvor that targets an Orca Whirlpool
// pool gets an explicit, named error. The dispatcher
// (`cpi::dispatch_remove_liquidity`) routes here on `pool.owner` match;
// a non-Orca owner never reaches this code path.
//
// See `docs/PRE_MAINNET_CHECKLIST.md` entry `CPI-007`.

use anchor_lang::prelude::*;

use crate::constants::ORCA_WHIRLPOOL_PROGRAM_ID;
use crate::cpi::{RemoveLiquidityInput, RemoveLiquidityOutput};
use crate::errors::GraveVaultError;

/// Mainnet Orca Whirlpool program ID. Mirrors the constant in
/// `crate::constants` so a reader of this adapter sees the dispatch key
/// without jumping files. The dispatcher re-derives the match from
/// `pool.owner` at runtime; this const is for documentation and
/// future test scaffolding.
pub const PROGRAM_ID: Pubkey = ORCA_WHIRLPOOL_PROGRAM_ID;

/// `remove_liquidity` for Orca Whirlpool — honest-stub.
///
/// PRE-MAINNET-TODO(CPI-007): Implement the real Orca Whirlpool
/// position-burn CPI before mainnet. Concentrated-liquidity withdraw
/// requires: (1) position NFT ownership transfer to the vault or
/// salvor-as-signer, (2) `collect_fees` across the position's tick
/// range, (3) `decrease_liquidity` to claim the base + memecoin
/// reserves, (4) `burn_position` to retire the NFT. The account layout
/// and remaining_accounts shape will differ materially from Raydium V4.
/// | reverts: `AmmCpiUnimplemented` (7017) | verify: against Whirlpool
/// SDK and mainnet position-burn transactions in a fork harness
/// mirroring `tests/raydium_v4_fork.rs`.
pub fn remove_liquidity<'a, 'info>(
    _input: RemoveLiquidityInput<'a, 'info>,
) -> Result<RemoveLiquidityOutput> {
    Err(error!(GraveVaultError::AmmCpiUnimplemented))
}
