// SPDX-License-Identifier: Apache-2.0
//
// Locker introspection adapter — Criterion 5 ("no LP tokens locked").
//
// At launch, GraveYield checks LP-token holdings against three lockers:
//   - UNCX Locker
//   - PinkSale Locker
//   - Team Finance Locker
//
// All three reverts on call until their account layouts are wired in
// follow-up PRs. The cautious failure mode is to revert with
// `LockerAdapterUnimplemented` rather than return zero — a stub that
// returned zero would silently certify locked pools as eligible.
//
// The handler passes the LP mint and an optional set of locker
// "container" accounts via `remaining_accounts`. When the relevant
// adapter is implemented, it MUST iterate the supplied locker accounts
// and sum any locked balance for the supplied LP mint.

use anchor_lang::prelude::*;

use crate::errors::GraveScannerError;

/// Sum LP tokens locked across all known lockers for the supplied LP mint.
///
/// PRE-MAINNET-TODO(LOCKER): UNCX / PinkSale / Team Finance locker program ID + account layout introspection | reverts: LockerAdapterUnimplemented | verify: against UNCX, PinkSale, Team Finance public docs and on-chain artifacts (cross-check with adapters/locker_release_*.rs once those land)
pub fn locked_lp_amount(_lp_mint: &Pubkey, _remaining_accounts: &[AccountInfo]) -> Result<u64> {
    err!(GraveScannerError::LockerAdapterUnimplemented)
}
