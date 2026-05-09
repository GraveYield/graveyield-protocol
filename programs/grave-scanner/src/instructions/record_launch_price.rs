// SPDX-License-Identifier: Apache-2.0

use anchor_lang::prelude::*;

use crate::constants::LAUNCH_PRICE_SEED;
use crate::state::LaunchPrice;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RecordLaunchPriceParams {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub launch_price_q64x64: u128,
}

#[derive(Accounts)]
#[instruction(params: RecordLaunchPriceParams)]
pub struct RecordLaunchPrice<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + LaunchPrice::INIT_SPACE,
        seeds = [
            LAUNCH_PRICE_SEED,
            params.amm_program_id.as_ref(),
            params.pool_address.as_ref(),
        ],
        bump,
    )]
    pub launch_price: Account<'info, LaunchPrice>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RecordLaunchPrice>, params: RecordLaunchPriceParams) -> Result<()> {
    // PRE-MAINNET-TODO(ORACLE): cross-check launch_price_q64x64 against
    // on-chain pool reserves at the supplied first_swap_slot rather than
    // trusting the caller | reverts: PoolDataParseError on mismatch |
    // verify: against AMM transaction history at the recorded slot.
    let clock = Clock::get()?;
    let lp = &mut ctx.accounts.launch_price;

    lp.amm_program_id = params.amm_program_id;
    lp.pool_address = params.pool_address;
    lp.base_mint = params.base_mint;
    lp.quote_mint = params.quote_mint;
    lp.launch_price_q64x64 = params.launch_price_q64x64;
    lp.recorded_slot = clock.slot;
    lp.recorded_at = clock.unix_timestamp;
    lp.bump = ctx.bumps.launch_price;
    lp._reserved = [0u8; 32];

    Ok(())
}
