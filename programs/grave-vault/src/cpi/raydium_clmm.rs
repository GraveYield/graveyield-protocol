// SPDX-License-Identifier: Apache-2.0
//
// Raydium CLMM — honest-stub adapter for m5.
//
// PRE-MAINNET-TODO(CPI): Implement the real Raydium CLMM `remove_liquidity`
// CPI before mainnet. The full pool layout parsing + position-burn
// semantics are deferred to v1.1. Reverts with `AmmCpiUnimplemented`
// today rather than silently succeeding so a salvor that targets a
// Raydium CLMM pool gets an explicit, named error.
//
// See `docs/PRE_MAINNET_CHECKLIST.md` entry `CPI-006`.

use anchor_lang::prelude::*;

use crate::cpi::{RemoveLiquidityInput, RemoveLiquidityOutput};
use crate::errors::GraveVaultError;

pub fn remove_liquidity<'a, 'info>(
    _input: RemoveLiquidityInput<'a, 'info>,
) -> Result<RemoveLiquidityOutput> {
    Err(error!(GraveVaultError::AmmCpiUnimplemented))
}
