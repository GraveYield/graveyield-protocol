// SPDX-License-Identifier: Apache-2.0
//
// update_protocol_config — multisig-only, 72h-timelocked at the GraveVault
// Charter level. Updates GraveScanner thresholds and the staleness window.

use anchor_lang::prelude::*;

use crate::constants::MIN_CERT_TTL_SECONDS;
use crate::errors::GraveScannerError;
use crate::state::ProtocolConfig;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateProtocolConfigParams {
    pub inactivity_seconds: Option<u64>,
    pub price_collapse_bps: Option<u16>,
    pub min_tvl_lamports: Option<u64>,
    pub anchor_staleness_seconds: Option<u64>,
    /// EligibilityCert TTL in seconds. Floor: `MIN_CERT_TTL_SECONDS` (600).
    /// Any value below the floor reverts with `CertTtlBelowMinimum`.
    pub cert_ttl_seconds: Option<i64>,
}

#[derive(Accounts)]
pub struct UpdateProtocolConfig<'info> {
    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump = protocol_config.bump,
        has_one = authority @ GraveScannerError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateProtocolConfig>,
    params: UpdateProtocolConfigParams,
) -> Result<()> {
    let cfg = &mut ctx.accounts.protocol_config;

    if let Some(v) = params.inactivity_seconds {
        cfg.inactivity_seconds = v;
    }
    if let Some(v) = params.price_collapse_bps {
        require!(v <= 10_000, GraveScannerError::InvariantViolation);
        cfg.price_collapse_bps = v;
    }
    if let Some(v) = params.min_tvl_lamports {
        cfg.min_tvl_lamports = v;
    }
    if let Some(v) = params.anchor_staleness_seconds {
        cfg.anchor_staleness_seconds = v;
    }
    if let Some(v) = params.cert_ttl_seconds {
        // Hardcoded floor: governance cannot push cert_ttl below 600s.
        // Raising the floor requires a program upgrade.
        require!(
            v >= MIN_CERT_TTL_SECONDS,
            GraveScannerError::CertTtlBelowMinimum
        );
        cfg.cert_ttl_seconds = v;
    }

    Ok(())
}
