// SPDX-License-Identifier: Apache-2.0
//
// emergency_pause — governance-authority-gated (`has_one = authority` signer
// check), immediate; toggles `ProtocolConfig.paused` (not multisig-gated).
//
// When paused, `evaluate_pool_phase_1`/`evaluate_pool_phase_2` revert with
// `ProtocolPaused`. `sweep_stale_anchor`, `invalidate_anchor`, and config
// updates remain callable — pause is an evaluation kill-switch, not a halt.
//
// Refuses-first: a toggle that would not change the flag reverts with
// `InvariantViolation` (6006) instead of performing a redundant write and a
// second `ProtocolPauseChanged` emission that a log reader could mistake for
// an intervening un-pause.
//
// Unlike `update_protocol_config` (the Squads governance flow — a process
// commitment, not on-chain enforcement — schedules config changes behind a
// 72h buffer), emergency pause is intentionally immediate so the configured
// authority can stop new evaluations the moment an exploit or AMM-side
// incident is observed. Mirrors the GraveVault equivalent (instructions/emergency_pause.rs).

use anchor_lang::prelude::*;

use crate::errors::GraveScannerError;
use crate::state::ProtocolConfig;

#[derive(Accounts)]
pub struct EmergencyPause<'info> {
    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump = protocol_config.bump,
        has_one = authority @ GraveScannerError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<EmergencyPause>, paused: bool) -> Result<()> {
    let cfg = &mut ctx.accounts.protocol_config;

    // Refuses-first: the instruction's assumption is that the toggle
    // actually transitions the flag. A call whose requested state equals
    // the current state would perform a no-op write and emit a second
    // `ProtocolPauseChanged` indistinguishable from a real transition —
    // polluting the pause audit trail (same discipline as
    // `invalidate_anchor`'s re-invalidation refusal). Reverts before any
    // state change or emission.
    require!(cfg.paused != paused, GraveScannerError::InvariantViolation);

    cfg.paused = paused;

    emit!(ProtocolPauseChanged {
        paused,
        changed_by: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event]
pub struct ProtocolPauseChanged {
    pub paused: bool,
    pub changed_by: Pubkey,
}
