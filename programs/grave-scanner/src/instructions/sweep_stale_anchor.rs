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
    let cfg = &ctx.accounts.protocol_config;
    let anchor_account = &ctx.accounts.eligibility_anchor;

    // Defense-in-depth: clamp the window at the read path, not just the
    // write paths. A config written before MIN_ANCHOR_STALENESS_SECONDS
    // existed (or by a pre-upgrade program) must never enable a sweep
    // inside the Phase 2 confirmation window. The clamp only ever WIDENS
    // the window — it can never make a legitimate sweep revert, and it
    // cannot be bypassed because the configured value is still bounded by
    // the floor on every write path.
    let staleness_seconds = cfg
        .anchor_staleness_seconds
        .max(MIN_ANCHOR_STALENESS_SECONDS);

    // ceil(staleness_seconds / approx_epoch_duration_seconds)
    let staleness_epochs = staleness_seconds
        .saturating_add(APPROX_EPOCH_DURATION_SECONDS.saturating_sub(1))
        .checked_div(APPROX_EPOCH_DURATION_SECONDS)
        .ok_or(GraveScannerError::MathOverflow)?;

    let earliest_sweep_epoch = anchor_account
        .first_eligible_epoch
        .checked_add(staleness_epochs)
        .ok_or(GraveScannerError::MathOverflow)?;

    require!(
        clock.epoch > earliest_sweep_epoch,
        GraveScannerError::AnchorNotStale
    );

    emit!(AnchorSwept {
        amm_program_id: anchor_account.amm_program_id,
        pool_address: anchor_account.pool_address,
        swept_by: ctx.accounts.caller.key(),
        rent_returned_to: anchor_account.writer,
    });

    Ok(())
}

#[event]
pub struct AnchorSwept {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub swept_by: Pubkey,
    pub rent_returned_to: Pubkey,
}
