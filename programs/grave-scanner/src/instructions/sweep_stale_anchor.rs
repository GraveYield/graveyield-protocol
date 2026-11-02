// SPDX-License-Identifier: Apache-2.0
//
// sweep_stale_anchor — permissionless. Closes EligibilityAnchor PDAs once
// the staleness window has elapsed. Rent returns to the original anchor
// writer. Conveys no salvage authority.
//
// Scope note (code is authoritative): the sweep closes ANY anchor whose
// window has elapsed — one that was never certified and one whose pool WAS
// certified alike. That is safe by construction: a cert's TTL (governance-
// configurable, floored at 10 minutes, default 1 hour) is orders of
// magnitude shorter than the sweep window (floored at 3 epochs / 6 days by
// MIN_ANCHOR_STALENESS_SECONDS), so by the time an anchor is sweepable,
// any cert minted from it has long expired. A swept anchor never
// underwrites a live salvage path; the PDA can be re-created by a fresh
// Phase 1 run.
//
// Introduced by v4.0.1 spec patch — solves the rent-recovery problem for
// anchors that were never certified (pool no longer derelict at Phase 2).

use anchor_lang::prelude::*;

use crate::constants::{APPROX_EPOCH_DURATION_SECONDS, MIN_ANCHOR_STALENESS_SECONDS};
use crate::errors::GraveScannerError;
use crate::state::{EligibilityAnchor, ProtocolConfig};

#[derive(Accounts)]
pub struct SweepStaleAnchor<'info> {
    #[account(seeds = [ProtocolConfig::SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        close = anchor_writer,
        constraint =
            eligibility_anchor.writer == anchor_writer.key()
            @ GraveScannerError::Unauthorized,
    )]
    pub eligibility_anchor: Account<'info, EligibilityAnchor>,

    /// CHECK: this is the original anchor writer; rent returns here on close.
    /// Verified above via `eligibility_anchor.writer`.
    #[account(mut)]
    pub anchor_writer: UncheckedAccount<'info>,

    /// Permissionless caller — anyone can trigger the sweep.
    pub caller: Signer<'info>,
}

pub fn handler(ctx: Context<SweepStaleAnchor>) -> Result<()> {
    let clock = Clock::get().map_err(|_| GraveScannerError::InvalidClock)?;

    sweep_gate(
        ctx.accounts.eligibility_anchor.first_eligible_epoch,
        ctx.accounts.protocol_config.anchor_staleness_seconds,
        clock.epoch,
    )?;

    emit!(AnchorSwept {
        amm_program_id: ctx.accounts.eligibility_anchor.amm_program_id,
        pool_address: ctx.accounts.eligibility_anchor.pool_address,
        swept_by: ctx.accounts.caller.key(),
        rent_returned_to: ctx.accounts.eligibility_anchor.writer,
    });

    Ok(())
}

/// The handler's staleness decision, extracted verbatim so the window math
/// is testable at the handler level without an Anchor account context (P5-03
/// remediation layer 1). Pure code motion: the handler passes the same three
/// inputs the inline version read from the accounts, and the instruction-level
/// behavior (writer binding, PDA derivation, ownership — all constraint-layer)
/// stays pinned by the fork suites.
///
/// Defense-in-depth: clamps the window at the read path, not just the write
/// paths. A config written before MIN_ANCHOR_STALENESS_SECONDS existed (or by
/// a pre-upgrade program) must never enable a sweep inside the Phase 2
/// confirmation window. The clamp only ever WIDENS the window — it can never
/// make a legitimate sweep revert, and it cannot be bypassed because the
/// configured value is still bounded by the floor on every write path.
pub(crate) fn sweep_gate(
    first_eligible_epoch: u64,
    configured_staleness_seconds: u64,
    current_epoch: u64,
) -> Result<()> {
    let staleness_seconds = configured_staleness_seconds.max(MIN_ANCHOR_STALENESS_SECONDS);

    // ceil(staleness_seconds / approx_epoch_duration_seconds)
    let staleness_epochs = staleness_seconds
        .saturating_add(APPROX_EPOCH_DURATION_SECONDS.saturating_sub(1))
        .checked_div(APPROX_EPOCH_DURATION_SECONDS)
        .ok_or(GraveScannerError::MathOverflow)?;

    let earliest_sweep_epoch = first_eligible_epoch
        .checked_add(staleness_epochs)
        .ok_or(GraveScannerError::MathOverflow)?;

    require!(
        current_epoch > earliest_sweep_epoch,
        GraveScannerError::AnchorNotStale
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On-chain code of an Anchor custom error, for asserting the documented
    /// codes (6018 AnchorNotStale / 6004 MathOverflow) rather than variants.
    fn code_of(err: &anchor_lang::error::Error) -> u32 {
        match err {
            anchor_lang::error::Error::AnchorError(ae) => ae.error_code_number,
            other => panic!("expected an Anchor custom error, got {other:?}"),
        }
    }

    const EPOCH: u64 = APPROX_EPOCH_DURATION_SECONDS; // 172_800 = 2 days
    /// ceil(MIN_ANCHOR_STALENESS_SECONDS / EPOCH) = 3 epochs (the floor
    /// window: 3 × 2 days = 6 days).
    const MIN_EPOCHS: u64 = MIN_ANCHOR_STALENESS_SECONDS.div_ceil(EPOCH);

    #[test]
    fn sweep_rejected_while_window_not_elapsed_6018() {
        // An anchor written at epoch 10 with the floor window (3 epochs) is
        // unsweepable for the whole window — every epoch before 10 + 3
        // reverts 6018.
        for current in [10, 11, 12] {
            let err = sweep_gate(10, MIN_ANCHOR_STALENESS_SECONDS, current)
                .expect_err("a sweep inside the window must revert");
            assert_eq!(
                code_of(&err),
                6018,
                "epoch {current} must be AnchorNotStale"
            );
        }
    }

    #[test]
    fn sweep_boundary_is_strict_inequality() {
        // earliest_sweep_epoch = 10 + 3 = 13 with the floor window: the
        // boundary epoch itself is still rejected (strict `>`), one epoch
        // later passes.
        let err = sweep_gate(10, MIN_ANCHOR_STALENESS_SECONDS, 10 + MIN_EPOCHS)
            .expect_err("the boundary epoch must still revert 6018");
        assert_eq!(code_of(&err), 6018);
        sweep_gate(10, MIN_ANCHOR_STALENESS_SECONDS, 10 + MIN_EPOCHS + 1)
            .expect("one epoch past the boundary must be sweepable");
    }

    #[test]
    fn configured_window_below_floor_is_clamped_up() {
        // Read-path clamp: a sub-floor (or legacy pre-floor) config value
        // can never arm the sweep early — it behaves exactly like the MIN
        // window. 0 and the value one second under the floor both clamp to
        // the 3-epoch window.
        for configured in [0u64, MIN_ANCHOR_STALENESS_SECONDS - 1] {
            let err = sweep_gate(10, configured, 10 + MIN_EPOCHS)
                .expect_err("a clamped sub-floor window must still gate the boundary");
            assert_eq!(code_of(&err), 6018);
            sweep_gate(10, configured, 10 + MIN_EPOCHS + 1)
                .expect("the clamped window must open one epoch past the boundary");
        }
    }

    #[test]
    fn configured_window_above_floor_widens_monotonically() {
        // min+1 second crosses the 2-day epoch boundary: ceil((min+1)/EPOCH)
        // = 4 epochs, so the sweep opens one epoch later than with the MIN
        // window. Governance can widen the window; it can never narrow it.
        sweep_gate(10, MIN_ANCHOR_STALENESS_SECONDS, 10 + MIN_EPOCHS + 1)
            .expect("the MIN window opens at min+1 epochs");
        let err = sweep_gate(10, MIN_ANCHOR_STALENESS_SECONDS + 1, 10 + MIN_EPOCHS + 1)
            .expect_err("a one-second-wider window must push the boundary an epoch out");
        assert_eq!(code_of(&err), 6018);
        sweep_gate(10, MIN_ANCHOR_STALENESS_SECONDS + 1, 10 + MIN_EPOCHS + 2)
            .expect("the widened window opens one epoch later");
    }

    #[test]
    fn sweep_epoch_overflow_fails_closed_6004() {
        // A hostile/absurd anchor epoch must not wrap: the checked add
        // fails closed with MathOverflow instead of arming an early sweep.
        let err = sweep_gate(u64::MAX, u64::MAX, u64::MAX)
            .expect_err("an overflowing epoch add must fail closed");
        assert_eq!(code_of(&err), 6004);
    }

    #[test]
    fn on_chain_6018_code_matches_docs() {
        assert_eq!(u32::from(GraveScannerError::AnchorNotStale), 6018);
    }
}

#[event]
pub struct AnchorSwept {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub swept_by: Pubkey,
    pub rent_returned_to: Pubkey,
}
