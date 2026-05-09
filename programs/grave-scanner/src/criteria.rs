// SPDX-License-Identifier: Apache-2.0
//
// Shared 6-criterion derelict-pool evaluator. Used by both
// `evaluate_pool_phase_1` and `evaluate_pool_phase_2` so that the
// definition of "derelict" lives in exactly one place.
//
// Inputs are pre-extracted by the calling handler (via the `adapters`
// module for AMM-specific account layouts and locker introspection).
// This module is a pure function over those inputs — no I/O, no
// `Clock::get` — which makes it cheaply testable and audit-friendly.
//
// Spec reference: GraveYield Whitepaper v4.0.1 §3, Combined Tech Doc
// v3.0.1 §3.5.

use anchor_lang::prelude::*;

use crate::constants::MIN_EPOCH_CONFIRMATION;
use crate::errors::GraveScannerError;

// =====================================================================
// Bitmap layout for the six criteria. The full mask is 0b0011_1111 = 0x3F.
// EligibilityAnchor and EligibilityCert both store an 8-bit bitmap field.
// =====================================================================

pub const CRITERION_INACTIVITY: u8 = 1 << 0; //         0x01 — Criterion 1
pub const CRITERION_PRICE_COLLAPSE: u8 = 1 << 1; //     0x02 — Criterion 2
pub const CRITERION_MIN_TVL: u8 = 1 << 2; //            0x04 — Criterion 3
pub const CRITERION_LP_NOT_BURNED: u8 = 1 << 3; //      0x08 — Criterion 4
pub const CRITERION_NO_LOCK: u8 = 1 << 4; //            0x10 — Criterion 5
pub const CRITERION_EPOCH_CONFIRMED: u8 = 1 << 5; //    0x20 — Criterion 6

/// All six criteria satisfied. v4.0 mask is `0b00111111`.
pub const ALL_CRITERIA_MASK: u8 = CRITERION_INACTIVITY
    | CRITERION_PRICE_COLLAPSE
    | CRITERION_MIN_TVL
    | CRITERION_LP_NOT_BURNED
    | CRITERION_NO_LOCK
    | CRITERION_EPOCH_CONFIRMED;

// =====================================================================
// Pure inputs and thresholds. No Anchor accounts; trivially unit-testable.
// =====================================================================

/// Inputs collected by the instruction handler before evaluation.
///
/// Price fields use Q64.64 fixed-point representation — `quote_per_base`
/// = `(quote_reserve as u128) << 64 / (base_reserve as u128)`. The
/// `current_tvl_lamports` is the residual quote-side value of the pool
/// expressed in lamports (or USDC base units for stable-quote pools).
#[derive(Clone, Copy, Debug)]
pub struct CriteriaInputs {
    /// Last on-chain swap timestamp (unix seconds).
    pub last_swap_unix_ts: i64,
    /// Current on-chain time (unix seconds).
    pub current_unix_ts: i64,
    /// Recorded launch price as quote-per-base in Q64.64.
    pub launch_price_q64x64: u128,
    /// Current pool price as quote-per-base in Q64.64.
    pub current_price_q64x64: u128,
    /// Total residual TVL of the pool in lamports (or quote base units).
    pub current_tvl_lamports: u64,
    /// Outstanding LP token supply.
    pub lp_supply: u64,
    /// LP tokens currently locked in any external locker contract.
    pub lp_locked_amount: u64,
    /// Current Solana epoch.
    pub current_epoch: u64,
    /// `EligibilityAnchor.first_eligible_epoch` — required only for Phase 2.
    pub anchor_first_eligible_epoch: Option<u64>,
}

/// Thresholds extracted from `ProtocolConfig`. Passed by value so the
/// evaluator does not need an Anchor `Account` reference.
#[derive(Clone, Copy, Debug)]
pub struct CriteriaThresholds {
    pub inactivity_seconds: u64,
    pub price_collapse_bps: u16,
    pub min_tvl_lamports: u64,
    pub lp_burn_dust_threshold: u64,
}

/// Phase tag — Phase 1 stamps `first_eligible_epoch`, Phase 2 enforces the
/// multi-epoch confirmation gap.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    One,
    Two,
}

// =====================================================================
// Evaluator.
// =====================================================================

/// Evaluate all six derelict-pool criteria. Returns the criteria bitmap
/// when every criterion passes; otherwise returns `Err(PoolNotEligible)`
/// (or a more specific error for the multi-epoch path).
///
/// The evaluator short-circuits on the first miss for both deterministic
/// gas cost and clearer audit traces. Callers that want to write a
/// partial bitmap (e.g. for off-chain diagnostics) should call the
/// per-criterion helpers directly.
pub fn evaluate(
    inputs: &CriteriaInputs,
    thresholds: &CriteriaThresholds,
    phase: Phase,
) -> Result<u8> {
    let mut bitmap: u8 = 0;

    // Criterion 1 — inactivity.
    require!(
        inputs.current_unix_ts >= inputs.last_swap_unix_ts,
        GraveScannerError::InvalidClock
    );
    let elapsed_seconds = (inputs.current_unix_ts as i128)
        .checked_sub(inputs.last_swap_unix_ts as i128)
        .ok_or(GraveScannerError::MathOverflow)? as u128;
    require!(
        elapsed_seconds >= thresholds.inactivity_seconds as u128,
        GraveScannerError::PoolNotEligible
    );
    bitmap |= CRITERION_INACTIVITY;

    // Criterion 2 — price collapse.
    require!(
        inputs.launch_price_q64x64 > 0,
        GraveScannerError::LaunchPriceNotFound
    );
    let drop_bps = compute_drop_bps(inputs.launch_price_q64x64, inputs.current_price_q64x64)?;
    require!(
        drop_bps >= thresholds.price_collapse_bps,
        GraveScannerError::PoolNotEligible
    );
    bitmap |= CRITERION_PRICE_COLLAPSE;

    // Criterion 3 — residual TVL.
    require!(
        inputs.current_tvl_lamports >= thresholds.min_tvl_lamports,
        GraveScannerError::PoolNotEligible
    );
    bitmap |= CRITERION_MIN_TVL;

    // Criterion 4 — LP supply not burned to dust.
    //
    // Strict ">" so that a `lp_burn_dust_threshold` of 0 still rejects
    // pools whose LP supply has been entirely incinerated (LP supply == 0
    // is unambiguously "burned").
    require!(
        inputs.lp_supply > thresholds.lp_burn_dust_threshold,
        GraveScannerError::PoolNotEligible
    );
    bitmap |= CRITERION_LP_NOT_BURNED;

    // Criterion 5 — no LP tokens locked.
    require!(
        inputs.lp_locked_amount == 0,
        GraveScannerError::PoolNotEligible
    );
    bitmap |= CRITERION_NO_LOCK;

    // Criterion 6 — multi-epoch confirmation.
    match phase {
        Phase::One => {
            // Phase 1 stamps `first_eligible_epoch = current_epoch`. The
            // confirmation requirement is structurally satisfied by the
            // epoch stamp itself; the gap is enforced at Phase 2.
            bitmap |= CRITERION_EPOCH_CONFIRMED;
        }
        Phase::Two => {
            let anchor_epoch = inputs
                .anchor_first_eligible_epoch
                .ok_or(GraveScannerError::AnchorNotFound)?;
            let elapsed_epochs = inputs.current_epoch.saturating_sub(anchor_epoch);
            require!(
                elapsed_epochs >= MIN_EPOCH_CONFIRMATION,
                GraveScannerError::EpochConfirmationPending
            );
            bitmap |= CRITERION_EPOCH_CONFIRMED;
        }
    }

    require!(
        bitmap == ALL_CRITERIA_MASK,
        GraveScannerError::PoolNotEligible
    );
    Ok(bitmap)
}

/// Compute price drop in basis points. Both inputs are Q64.64 fixed-point.
/// Returns 0 if the current price has risen above launch (pool re-floated),
/// capped at 10_000.
///
/// Formula: `floor((launch - current) * 10_000 / launch)`.
pub fn compute_drop_bps(launch_q64x64: u128, current_q64x64: u128) -> Result<u16> {
    if current_q64x64 >= launch_q64x64 {
        return Ok(0);
    }
    let delta = launch_q64x64
        .checked_sub(current_q64x64)
        .ok_or(GraveScannerError::MathOverflow)?;
    let scaled = delta
        .checked_mul(10_000u128)
        .ok_or(GraveScannerError::MathOverflow)?;
    let bps = scaled
        .checked_div(launch_q64x64)
        .ok_or(GraveScannerError::MathOverflow)?;
    Ok(if bps > 10_000 { 10_000 } else { bps as u16 })
}

// =====================================================================
// Unit tests. These are pure-Rust and do not hit Anchor's account model,
// so they run on `cargo test` without `solana-test-validator`.
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn default_thresholds() -> CriteriaThresholds {
        CriteriaThresholds {
            inactivity_seconds: 90 * 24 * 60 * 60,
            price_collapse_bps: 9_900,
            min_tvl_lamports: 500_000_000,
            lp_burn_dust_threshold: 1_000,
        }
    }

    /// Inputs for a "perfect derelict pool": all six criteria comfortably pass.
    fn passing_inputs() -> CriteriaInputs {
        CriteriaInputs {
            last_swap_unix_ts: 0,
            current_unix_ts: 100 * 24 * 60 * 60, // 100 days idle
            launch_price_q64x64: 1u128 << 64,    // 1.0 in Q64.64
            current_price_q64x64: 1u128 << 56,   // ≈ 1/256 = 99.6% drop
            current_tvl_lamports: 1_000_000_000,
            lp_supply: 1_000_000,
            lp_locked_amount: 0,
            current_epoch: 1_000,
            anchor_first_eligible_epoch: Some(998),
        }
    }

    #[test]
    fn evaluate_phase_one_all_pass_returns_full_mask() {
        let inputs = passing_inputs();
        let bitmap = evaluate(&inputs, &default_thresholds(), Phase::One).unwrap();
        assert_eq!(bitmap, ALL_CRITERIA_MASK);
        assert_eq!(bitmap, 0x3F);
    }

    #[test]
    fn evaluate_phase_two_with_sufficient_epoch_gap_passes() {
        let inputs = passing_inputs();
        let bitmap = evaluate(&inputs, &default_thresholds(), Phase::Two).unwrap();
        assert_eq!(bitmap, ALL_CRITERIA_MASK);
    }

    /// Helper: assert that `err` is the expected `GraveScannerError`.
    /// Compares the on-chain error code number rather than the full debug
    /// string, since `error_origin` differs based on call site.
    fn assert_err(err: anchor_lang::error::Error, expected: GraveScannerError) {
        match err {
            anchor_lang::error::Error::AnchorError(e) => {
                let expected_code: u32 = expected.into();
                assert_eq!(
                    e.error_code_number, expected_code,
                    "got error {} ({}), expected {}",
                    e.error_code_number, e.error_name, expected_code
                );
            }
            other => panic!("expected AnchorError, got {other:?}"),
        }
    }

    #[test]
    fn criterion_one_rejects_recently_active_pool() {
        let mut inputs = passing_inputs();
        inputs.last_swap_unix_ts = inputs.current_unix_ts - (10 * 24 * 60 * 60); // 10 days
        let err = evaluate(&inputs, &default_thresholds(), Phase::One).unwrap_err();
        assert_err(err, GraveScannerError::PoolNotEligible);
    }

    #[test]
    fn criterion_two_rejects_pool_below_collapse_threshold() {
        let mut inputs = passing_inputs();
        // current price = launch / 2 → 50% drop, well below 99% threshold.
        inputs.current_price_q64x64 = inputs.launch_price_q64x64 / 2;
        assert!(evaluate(&inputs, &default_thresholds(), Phase::One).is_err());
    }

    #[test]
    fn criterion_two_treats_floor_at_zero_as_full_drop() {
        let mut inputs = passing_inputs();
        inputs.current_price_q64x64 = 0;
        let bitmap = evaluate(&inputs, &default_thresholds(), Phase::One).unwrap();
        assert_eq!(bitmap, ALL_CRITERIA_MASK);
    }

    #[test]
    fn criterion_two_rejects_pool_that_re_floated() {
        let mut inputs = passing_inputs();
        // Current price > launch — Criterion 2 returns 0 bps drop.
        inputs.current_price_q64x64 = inputs.launch_price_q64x64 * 2;
        assert!(evaluate(&inputs, &default_thresholds(), Phase::One).is_err());
    }

    #[test]
    fn criterion_three_rejects_pool_below_min_tvl() {
        let mut inputs = passing_inputs();
        inputs.current_tvl_lamports = 100_000_000; // 0.1 SOL — below 0.5 SOL threshold
        assert!(evaluate(&inputs, &default_thresholds(), Phase::One).is_err());
    }

    #[test]
    fn criterion_four_rejects_pool_with_burned_lp() {
        let mut inputs = passing_inputs();
        inputs.lp_supply = 0;
        assert!(evaluate(&inputs, &default_thresholds(), Phase::One).is_err());
    }

    #[test]
    fn criterion_five_rejects_pool_with_locked_lp() {
        let mut inputs = passing_inputs();
        inputs.lp_locked_amount = 1;
        assert!(evaluate(&inputs, &default_thresholds(), Phase::One).is_err());
    }

    #[test]
    fn criterion_six_rejects_phase_two_inside_confirmation_gap() {
        let mut inputs = passing_inputs();
        inputs.current_epoch = 999; // anchor at 998 → only 1 epoch elapsed
        let err = evaluate(&inputs, &default_thresholds(), Phase::Two).unwrap_err();
        assert_err(err, GraveScannerError::EpochConfirmationPending);
    }

    #[test]
    fn criterion_six_rejects_phase_two_without_anchor_epoch() {
        let mut inputs = passing_inputs();
        inputs.anchor_first_eligible_epoch = None;
        let err = evaluate(&inputs, &default_thresholds(), Phase::Two).unwrap_err();
        assert_err(err, GraveScannerError::AnchorNotFound);
    }

    #[test]
    fn compute_drop_bps_at_99_percent() {
        let launch = 1u128 << 64;
        let current = launch / 100;
        let bps = compute_drop_bps(launch, current).unwrap();
        // 99% drop = 9_900 bps, allowing for floor rounding.
        assert!((9_899..=9_900).contains(&bps), "got {bps} bps");
    }

    #[test]
    fn compute_drop_bps_at_zero_current() {
        let bps = compute_drop_bps(1u128 << 64, 0).unwrap();
        assert_eq!(bps, 10_000);
    }

    #[test]
    fn compute_drop_bps_returns_zero_when_current_above_launch() {
        let bps = compute_drop_bps(1u128 << 64, 2u128 << 64).unwrap();
        assert_eq!(bps, 0);
    }
}
