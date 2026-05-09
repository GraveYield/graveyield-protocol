// SPDX-License-Identifier: Apache-2.0
//
// invalidate_anchor — multisig-only, immediate. Marks an EligibilityAnchor as
// invalidated so it cannot be certified into an EligibilityCert. Conveys no
// salvage authority. Used when out-of-band signal indicates the pool is no
// longer derelict (e.g., upstream team reactivated it).
//
// Per v4.0.1 spec patch: this remains multisig-only; auto-invalidation was
// rejected as redundant with Phase 2's natural re-verification gate.

use anchor_lang::prelude::*;

use crate::constants::ELIGIBILITY_ANCHOR_SEED;
use crate::errors::GraveScannerError;
use crate::state::{EligibilityAnchor, ProtocolConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InvalidateAnchorParams {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
}

#[derive(Accounts)]
#[instruction(params: InvalidateAnchorParams)]
pub struct InvalidateAnchor<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump = protocol_config.bump,
        has_one = authority @ GraveScannerError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [
            ELIGIBILITY_ANCHOR_SEED,
            params.amm_program_id.as_ref(),
            params.pool_address.as_ref(),
        ],
        bump = eligibility_anchor.bump,
    )]
    pub eligibility_anchor: Account<'info, EligibilityAnchor>,

    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<InvalidateAnchor>,
    _params: InvalidateAnchorParams,
) -> Result<()> {
    let anchor_account = &mut ctx.accounts.eligibility_anchor;
    anchor_account.invalidated = true;

    emit!(AnchorInvalidated {
        amm_program_id: anchor_account.amm_program_id,
        pool_address: anchor_account.pool_address,
        invalidated_by: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event]
pub struct AnchorInvalidated {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub invalidated_by: Pubkey,
}
