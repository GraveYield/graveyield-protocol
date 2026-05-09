// SPDX-License-Identifier: Apache-2.0
//
// emergency_pause — multisig-only, immediate. Sets `emergency_paused`.
// claim_lp_proceeds remains live during pause; only salvage_pool is gated.

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
