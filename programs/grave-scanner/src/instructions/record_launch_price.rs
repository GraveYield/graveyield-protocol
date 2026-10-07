// SPDX-License-Identifier: Apache-2.0
//
// Records a pool's Criterion 2 launch-price baseline into the init-once
// `LaunchPrice` PDA (ORACLE-001, Phase 1.3 / spec D9).
//
// Authoritative evidence model (spec `PROTOCOL_SPEC.md` §5, decision D9):
// the launch price is the quote-per-base price formed by the pool's vault
// balances immediately BEFORE the pool's first successful swap, derived
// off chain from Raydium V4 transaction history. The value reaches this
// instruction ONLY as a 168-byte Ed25519 attestation signed by
// `ProtocolConfig.launch_price_oracle` and verified in-transaction via
// the `ed25519_program` precompile (`crate::attestation`). A
// caller-supplied price is accepted only when it byte-exactly echoes the
// attested price; every other input reverts.
//
// Why no SlotHashes freshness check (unlike the C1 attestation): the
// launch price is a time-invariant historical fact, and this PDA is
// init-once — replaying an old-but-valid attestation cannot overwrite
// anything because the second `init` fails. See spec D9.
//
// Manipulation coverage:
//   * fake-HIGH baseline (false C2 collapse) — requires a forged oracle
//     signature; reverts 6024/6025/6026/6027.
//   * fake-LOW baseline (permanent C2 denial-of-service on the init-once
//     record) — same signature gate.
//   * zero baseline — reverts 6032 (`InvalidLaunchPrice`).
//   * wrong token pair — the attestation binds (base_mint, quote_mint);
//     the evaluate_pool handlers additionally re-check the recorded pair
//     against the live pool's parsed mints (6033) before C2 can use it.

use anchor_lang::prelude::*;

use crate::attestation::{self, LAUNCH_PRICE_MSG_LEN};
use crate::constants::{LAUNCH_PRICE_SEED, PROTOCOL_CONFIG_SEED};
use crate::errors::GraveScannerError;
use crate::state::LaunchPrice;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RecordLaunchPriceParams {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub launch_price_q64x64: u128,
    /// Oracle-signed Criterion 2 attestation (168 bytes, canonical layout
    /// in `attestation.rs` / spec §5, decision D9):
    /// `amm_program_id ‖ pool_address ‖ base_mint ‖ quote_mint ‖
    /// first_swap_slot ‖ first_swap_unix_ts ‖ launch_price_q64x64 ‖
    /// issued_slot`.
    ///
    /// The transaction MUST carry an `ed25519_program` verify instruction
    /// immediately before this one whose signature covers exactly these
    /// bytes with `ProtocolConfig.launch_price_oracle` as the public key.
    /// The attestation is the LAST params field so the precompile's
    /// message span (data[152..end]) is exactly these 168 bytes.
    pub msg: [u8; LAUNCH_PRICE_MSG_LEN],
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

    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, crate::state::ProtocolConfig>,

    /// CHECK: instructions sysvar, address-constrained. Used to locate
    /// the `ed25519_program` verify instruction and this instruction's
    /// own data for attestation offset validation (ORACLE-001 / D9).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::id())]
    pub instruction_sysvar: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RecordLaunchPrice>, params: RecordLaunchPriceParams) -> Result<()> {
    let cfg = &ctx.accounts.protocol_config;
    require!(!cfg.paused, GraveScannerError::ProtocolPaused);

    let clock = Clock::get().map_err(|_| GraveScannerError::InvalidClock)?;

    // Criterion 2 evidence: oracle-signed Ed25519 attestation (ORACLE-001,
    // Phase 1.3 / spec D9). Verifies the runtime-checked precompile
    // signature binds exactly the embedded 168-byte message to the
    // configured launch-price oracle, then validates the message fields
    // (pool + mint + price binding, price > 0, first-swap timestamp and
    // slot sanity). The params echo of the attested price is mandatory —
    // the attestation is the single source of truth.
    let (launch_price_q64x64, first_swap_slot, first_swap_unix_ts) =
        attestation::verify_launch_price_attestation(
            &ctx.accounts.instruction_sysvar,
            attestation::LaunchPriceAttestationRef {
                msg: &params.msg,
                amm_program_id: &params.amm_program_id,
                pool_address: &params.pool_address,
                base_mint: &params.base_mint,
                quote_mint: &params.quote_mint,
                launch_price_q64x64: params.launch_price_q64x64,
                oracle: &cfg.launch_price_oracle,
            },
            clock.unix_timestamp,
            clock.slot,
        )?;

    let lp = &mut ctx.accounts.launch_price;

    lp.amm_program_id = params.amm_program_id;
    lp.pool_address = params.pool_address;
    lp.base_mint = params.base_mint;
    lp.quote_mint = params.quote_mint;
    lp.launch_price_q64x64 = launch_price_q64x64;
    // Provenance: when the attested price was established (the pool's
    // first swap) and when this record was written. Both make the
    // init-once baseline auditable against the original attestation.
    lp.first_swap_slot = first_swap_slot;
    lp.first_swap_unix_ts = first_swap_unix_ts;
    lp.recorded_slot = clock.slot;
    lp.recorded_at = clock.unix_timestamp;
    lp.bump = ctx.bumps.launch_price;
    lp._reserved = [0u8; 16];

    Ok(())
}
