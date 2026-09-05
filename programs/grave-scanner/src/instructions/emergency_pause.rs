// SPDX-License-Identifier: Apache-2.0
//
// emergency_pause — multisig-only, immediate. Toggles `ProtocolConfig.paused`.
//
// When paused, `evaluate_pool_phase_1` and `evaluate_pool_phase_2` revert with
// `ProtocolPaused`. `sweep_stale_anchor`, `invalidate_anchor`, and config
// updates remain callable — pause is an evaluation kill-switch, not a
// full-program halt.
//
// Unlike `update_protocol_config` (which the multisig schedules behind its own
// 72h timelock), emergency pause is intentionally immediate so the multisig
// can stop new evaluations the moment an exploit or AMM-side incident is
// observed. The Charter framing — "Emergency pause is immediate" — mirrors
// the GraveVault equivalent (programs/grave-vault/src/instructions/emergency_pause.rs).

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
