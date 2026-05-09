// SPDX-License-Identifier: Apache-2.0
//
// GraveScanner error codes. Numbers are stable; do not renumber existing
// variants. New variants append at the end.

use anchor_lang::prelude::*;

#[error_code]
pub enum GraveScannerError {
    /// Caller lacks the multisig authority required for this instruction.
    #[msg("Unauthorized: caller is not the protocol multisig.")]
    Unauthorized = 6000,

    /// One or more derelict-pool criteria failed during evaluate_pool.
    #[msg("Pool does not satisfy all six derelict-pool criteria.")]
    PoolNotEligible = 6001,

    /// The launch price record is missing for this pool.
    #[msg("Launch price record not found for this pool.")]
    LaunchPriceNotFound = 6002,

    /// AMM-specific account layout did not match the expected program.
    #[msg("AMM program mismatch or unsupported pool layout.")]
    UnsupportedAmm = 6003,

    /// Arithmetic overflow during eligibility evaluation.
    #[msg("Arithmetic overflow during eligibility computation.")]
    MathOverflow = 6004,

    /// Slot or epoch information is unavailable.
    #[msg("Clock sysvar unavailable or returned invalid data.")]
    InvalidClock = 6005,

    /// Protocol config update violated a locked invariant or out-of-range value.
    #[msg("Protocol config update violates a locked invariant.")]
    InvariantViolation = 6006,

    // ----- v4.0 anchor / cert error codes -----
    /// Phase 2 was attempted without an existing EligibilityAnchor.
    #[msg("EligibilityAnchor PDA not found.")]
    AnchorNotFound = 6015,

    /// Phase 2 attempted before the multi-epoch confirmation gap elapsed.
    #[msg("EpochConfirmationPending: anchor first_eligible_epoch + MIN_EPOCH_CONFIRMATION not yet reached.")]
    EpochConfirmationPending = 6016,

    /// EligibilityAnchor was previously invalidated; cannot be certified.
    #[msg("AnchorInvalidated: this anchor was invalidated by multisig.")]
    AnchorInvalidated = 6017,

    /// `sweep_stale_anchor` called before the staleness window elapsed.
    #[msg("AnchorNotStale: staleness window has not yet elapsed.")]
    AnchorNotStale = 6018,
}
