// SPDX-License-Identifier: Apache-2.0
//
// GraveScanner error codes. The on-chain code numbers are stable and
// MUST match the spec (Whitepaper v4.0.1 §3, Combined Tech Doc v3.0.1 §3.5).
//
// Anchor's `#[error_code]` macro adds a default offset of 6000 to each
// variant's Rust discriminant. To produce the canonical spec codes
// 6000..=6018, the discriminants below are 0..=18 (with the 12..=14 gap
// preserved for future v4.x additions).
//
// Do not renumber existing variants. New variants append at the next
// free discriminant.

use anchor_lang::prelude::*;

#[error_code]
pub enum GraveScannerError {
    /// On-chain code 6000. Caller lacks the multisig authority required.
    #[msg("Unauthorized: caller is not the protocol multisig.")]
    Unauthorized = 0,

    /// On-chain code 6001. Derelict-pool criteria check failed.
    #[msg("Pool does not satisfy all six derelict-pool criteria.")]
    PoolNotEligible = 1,

    /// On-chain code 6002. LaunchPrice PDA missing for this pool.
    #[msg("Launch price record not found for this pool.")]
    LaunchPriceNotFound = 2,

    /// On-chain code 6003. AMM program mismatch / unsupported pool layout.
    #[msg("AMM program mismatch or unsupported pool layout.")]
    UnsupportedAmm = 3,

    /// On-chain code 6004. Arithmetic overflow during eligibility math.
    #[msg("Arithmetic overflow during eligibility computation.")]
    MathOverflow = 4,

    /// On-chain code 6005. Clock sysvar unavailable.
    #[msg("Clock sysvar unavailable or returned invalid data.")]
    InvalidClock = 5,

    /// On-chain code 6006. ProtocolConfig update violates a locked invariant.
    #[msg("Protocol config update violates a locked invariant.")]
    InvariantViolation = 6,

    /// On-chain code 6007. AMM adapter registered but parser not implemented.
    /// Canonical revert for the honest-stub adapter pattern; see
    /// `docs/PRE_MAINNET_CHECKLIST.md` for the live list.
    #[msg("AmmAdapterUnimplemented: AMM adapter parser is a pre-mainnet stub.")]
    AmmAdapterUnimplemented = 7,

    /// On-chain code 6008. Locker adapter registered but not implemented.
    /// Returning Err rather than zero prevents silent certification of
    /// pools whose LP tokens are locked in UNCX/PinkSale/Team Finance.
    #[msg("LockerAdapterUnimplemented: locker adapter is a pre-mainnet stub.")]
    LockerAdapterUnimplemented = 8,

    /// On-chain code 6009. Pool account data did not match the expected
    /// layout (corrupt, wrong length, or degenerate fields).
    #[msg("PoolDataParseError: pool account data did not match the expected layout.")]
    PoolDataParseError = 9,

    /// On-chain code 6010. GraveScanner is paused — `evaluate_pool_*`
    /// reverts. Has no effect on rent reclaim or GraveVault claim path.
    #[msg("ProtocolPaused: GraveScanner is paused; evaluate_pool is disabled.")]
    ProtocolPaused = 10,

    /// On-chain code 6011. Phase 2 produced a bitmap that disagrees with
    /// the originating EligibilityAnchor — refuse to promote a downgrade.
    #[msg("CriteriaBitmapMismatch: Phase 2 bitmap does not match anchor's bitmap.")]
    CriteriaBitmapMismatch = 11,

    // ----- v4.0 anchor / cert error codes (6015..=6018) -----
    //
    // Discriminants 12..=14 are reserved for future v4.x additions to the
    // pre-anchor error space (e.g., new pool-data parse failure modes).
    /// On-chain code 6015. Phase 2 attempted without an EligibilityAnchor.
    #[msg("EligibilityAnchor PDA not found.")]
    AnchorNotFound = 15,

    /// On-chain code 6016. Phase 2 attempted inside the confirmation gap.
    #[msg("EpochConfirmationPending: anchor first_eligible_epoch + MIN_EPOCH_CONFIRMATION not yet reached.")]
    EpochConfirmationPending = 16,

    /// On-chain code 6017. EligibilityAnchor was invalidated by multisig.
    #[msg("AnchorInvalidated: this anchor was invalidated by multisig.")]
    AnchorInvalidated = 17,

    /// On-chain code 6018. `sweep_stale_anchor` called before the
    /// staleness window elapsed.
    #[msg("AnchorNotStale: staleness window has not yet elapsed.")]
    AnchorNotStale = 18,
}
