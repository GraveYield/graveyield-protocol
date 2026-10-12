// SPDX-License-Identifier: Apache-2.0
//
// emergency_pause — multisig-only, immediate. Toggles
// `ProtocolConfig.emergency_paused`. When paused, `salvage_pool` reverts
// with `ProtocolPaused` (7003); `claim_lp_proceeds` stays live so
// original LPs always recover their share (Charter invariant).
//
// Refuses-first: a toggle that would not change the flag reverts with
// `InvariantViolation` (7022) instead of performing a redundant write
// and a second `ProtocolPauseChanged` emission that a log reader could
// mistake for an intervening un-pause. Mirrors the GraveScanner
// `emergency_pause` discipline (6006) so the two programs' pause audit
// trails have the same shape.
//
// Unlike `update_protocol_config` (which the multisig schedules behind
// its own 72h timelock), emergency pause is intentionally immediate so
// the multisig can stop new salvages the moment an exploit or AMM-side
// incident is observed. The Charter framing — "Emergency pause is
// immediate" — mirrors the GraveScanner equivalent
// (programs/grave-scanner/src/instructions/emergency_pause.rs).

use anchor_lang::prelude::*;

use crate::errors::GraveVaultError;
use crate::state::ProtocolConfig;

#[derive(Accounts)]
pub struct EmergencyPause<'info> {
    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump = protocol_config.bump,
        has_one = authority @ GraveVaultError::Unauthorized,
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
    // polluting the pause audit trail (same discipline as GraveScanner's
    // `emergency_pause` and `invalidate_anchor`'s re-invalidation
    // refusal). Reverts before any state change or emission.
    require!(
        cfg.emergency_paused != paused,
        GraveVaultError::InvariantViolation
    );

    cfg.emergency_paused = paused;

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
