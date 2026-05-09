// SPDX-License-Identifier: Apache-2.0
//
// update_protocol_config — multisig-only, 72h-timelocked. Enforces:
//
//   * `protocol_share_bps` cannot be raised above PROTOCOL_SHARE_BPS_CEILING.
//   * Splits (LP / salvor / protocol) must sum to exactly 10_000.
//
// The timelock itself is enforced by the multisig (Squads v4) via its
// transaction-buffer scheduling; this instruction trusts that scheduling and
// validates the new values on apply.

use anchor_lang::prelude::*;

use crate::constants::PROTOCOL_SHARE_BPS_CEILING;
use crate::errors::GraveVaultError;
use crate::state::ProtocolConfig;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateProtocolConfigParams {
    pub lp_holder_share_bps: Option<u16>,
    pub salvor_share_bps: Option<u16>,
    pub protocol_share_bps: Option<u16>,
    pub max_priority_fee_ceiling_lamports: Option<u64>,
    pub max_slippage_bps: Option<u16>,
    pub jupiter_dust_threshold_lamports: Option<u64>,
    pub timelock_seconds: Option<i64>,
}

#[derive(Accounts)]
pub struct UpdateProtocolConfig<'info> {
    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump = protocol_config.bump,
        has_one = authority @ GraveVaultError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateProtocolConfig>,
    params: UpdateProtocolConfigParams,
) -> Result<()> {
    let cfg = &mut ctx.accounts.protocol_config;

    if let Some(v) = params.lp_holder_share_bps {
        cfg.lp_holder_share_bps = v;
    }
    if let Some(v) = params.salvor_share_bps {
        cfg.salvor_share_bps = v;
    }
    if let Some(v) = params.protocol_share_bps {
        require!(
            v <= PROTOCOL_SHARE_BPS_CEILING,
            GraveVaultError::ProtocolShareExceedsCeiling
        );
        cfg.protocol_share_bps = v;
    }

    let total = (cfg.lp_holder_share_bps as u32)
        + (cfg.salvor_share_bps as u32)
        + (cfg.protocol_share_bps as u32);
    require!(total == 10_000, GraveVaultError::InvalidShareSplit);

    if let Some(v) = params.max_priority_fee_ceiling_lamports {
        cfg.max_priority_fee_ceiling_lamports = v;
    }
    if let Some(v) = params.max_slippage_bps {
        require!(v <= 10_000, GraveVaultError::SlippageExceeded);
        cfg.max_slippage_bps = v;
    }
    if let Some(v) = params.jupiter_dust_threshold_lamports {
        cfg.jupiter_dust_threshold_lamports = v;
    }
    if let Some(v) = params.timelock_seconds {
        cfg.timelock_seconds = v;
    }

    Ok(())
}
