// SPDX-License-Identifier: Apache-2.0
//
// salvage_pool — the core settlement instruction.
//
// 1. Pre-flight against PoolRegistry (idempotency) and EligibilityCert.
// 2. Verify EligibilityCert is fresh (not expired) and ownership is GraveScanner.
// 3. Verify protocol is not paused.
// 4. Snapshot LP holders into a Merkle tree (off-chain caller supplies root +
//    LP total supply; on-chain handler trusts the salvor's snapshot but locks
//    it permanently into PoolRegistry — claims later verify against this root).
// 5. CPI to AMM remove_liquidity (Raydium V4 first; adapter pattern for others).
// 6. CPI to Jupiter v6 swap (skip below dust threshold).
// 7. Distribute proceeds 40 / 40 / 20 to lp_holder_pool_vault, salvor, treasury.
// 8. Issue SalvageReceipt and emit SalvageCompleted / PoolSalvaged events.
//
// This scaffold defines the account context, parameters, and event shape. The
// CPI bodies are TODO — they are tracked as the m1-m8 build sequence.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GraveVaultError;
use crate::state::{PoolRegistry, ProtocolConfig, SalvageReceipt};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SalvagePoolParams {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    /// Off-chain LP-holder snapshot Merkle root (32 bytes).
    pub lp_snapshot_merkle_root: [u8; 32],
    /// LP token total supply at snapshot.
    pub lp_total_supply_at_snapshot: u64,
    /// Minimum acceptable quote-side output (lamports). Aborts if below.
    pub min_quote_output_lamports: u64,
}

#[derive(Accounts)]
#[instruction(params: SalvagePoolParams)]
pub struct SalvagePool<'info> {
    #[account(seeds = [ProtocolConfig::SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// EligibilityCert PDA from the GraveScanner program. We validate the
    /// owner program and the seed derivation here without taking a hard
    /// dependency on the GraveScanner account types.
    /// CHECK: owner program and PDA derivation are validated in the handler.
    #[account(
        seeds = [
            ELIGIBILITY_CERT_SEED,
            params.amm_program_id.as_ref(),
            params.pool_address.as_ref(),
        ],
        seeds::program = grave_scanner::ID,
        bump,
    )]
    pub eligibility_cert: UncheckedAccount<'info>,

    #[account(
        init,
        payer = salvor,
        space = 8 + PoolRegistry::INIT_SPACE,
        seeds = [POOL_REGISTRY_SEED, params.pool_address.as_ref()],
        bump,
    )]
    pub pool_registry: Account<'info, PoolRegistry>,

    #[account(
        init,
        payer = salvor,
        space = 8 + SalvageReceipt::INIT_SPACE,
        seeds = [SALVAGE_RECEIPT_SEED, params.pool_address.as_ref()],
        bump,
    )]
    pub salvage_receipt: Account<'info, SalvageReceipt>,

    /// CHECK: lp_holder_pool_vault PDA. Receives the LP-holder share. This
    /// account is UNSWEEPABLE by any admin key (Charter invariant). It is
    /// only debited by `claim_lp_proceeds` against a valid Merkle proof.
    #[account(
        mut,
        seeds = [LP_HOLDER_POOL_SEED, params.pool_address.as_ref()],
        bump,
    )]
    pub lp_holder_pool_vault: UncheckedAccount<'info>,

    /// CHECK: protocol treasury PDA receives the protocol share.
    #[account(mut, seeds = [PROTOCOL_TREASURY_SEED], bump)]
    pub protocol_treasury: UncheckedAccount<'info>,

    /// The salvor performing the salvage. Pays rent and receives the salvor share.
    #[account(mut)]
    pub salvor: Signer<'info>,

    /// CHECK: AMM-specific pool account. Validated against `params.pool_address`.
    pub pool: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SalvagePool>, params: SalvagePoolParams) -> Result<()> {
    let cfg = &ctx.accounts.protocol_config;

    require!(!cfg.emergency_paused, GraveVaultError::ProtocolPaused);

    // EligibilityCert ownership check. The seeds::program above validates the
    // PDA was derived under GraveScanner; we additionally check the owner.
    require_keys_eq!(
        *ctx.accounts.eligibility_cert.owner,
        grave_scanner::ID,
        GraveVaultError::InvalidEligibilityCert
    );

    // TODO(GraveVault m1): deserialise EligibilityCert via grave_scanner::state
    // type once the cross-program account binding is wired up. For now the
    // seed-based derivation gates correctness.

    // TODO(GraveVault m1): read cert.expires_at and require !cert.is_expired(now).

    // Pre-flight: verify pool address consistency.
    require_keys_eq!(
        ctx.accounts.pool.key(),
        params.pool_address,
        GraveVaultError::PreflightFailed
    );

    // TODO(GraveVault m2): CPI to AMM remove_liquidity.
    // TODO(GraveVault m3): CPI to Jupiter v6 swap (skip below dust).
    // TODO(GraveVault m4): compute 40/40/20 distribution and route lamports.

    let registry = &mut ctx.accounts.pool_registry;
    registry.amm_program_id = params.amm_program_id;
    registry.pool_address = params.pool_address;
    registry.salvor = ctx.accounts.salvor.key();
    registry.lp_snapshot_merkle_root = params.lp_snapshot_merkle_root;
    registry.lp_total_supply_at_snapshot = params.lp_total_supply_at_snapshot;
    registry.lp_holder_pool_total_lamports = 0; // populated post-distribution
    registry.lp_holder_pool_claimed_lamports = 0;
    let clock = Clock::get()?;
    registry.salvaged_at_slot = clock.slot;
    registry.salvaged_at_ts = clock.unix_timestamp;
    registry.bump = ctx.bumps.pool_registry;
    registry._reserved = [0u8; 64];

    let receipt = &mut ctx.accounts.salvage_receipt;
    receipt.pool_address = params.pool_address;
    receipt.salvor = ctx.accounts.salvor.key();
    receipt.lp_holder_amount_lamports = 0;
    receipt.salvor_amount_lamports = 0;
    receipt.protocol_amount_lamports = 0;
    receipt.total_proceeds_lamports = 0;
    receipt.issued_at_slot = clock.slot;
    receipt.issued_at_ts = clock.unix_timestamp;
    receipt.bump = ctx.bumps.salvage_receipt;
    receipt._reserved = [0u8; 32];

    emit!(PoolSalvaged {
        amm_program_id: params.amm_program_id,
        pool_address: params.pool_address,
        salvor: ctx.accounts.salvor.key(),
        lp_holder_amount: receipt.lp_holder_amount_lamports,
        salvor_amount: receipt.salvor_amount_lamports,
        protocol_amount: receipt.protocol_amount_lamports,
    });

    emit!(SalvageCompleted {
        pool_address: params.pool_address,
        salvor: ctx.accounts.salvor.key(),
        total_proceeds_lamports: receipt.total_proceeds_lamports,
    });

    Ok(())
}

#[event]
pub struct PoolSalvaged {
    pub amm_program_id: Pubkey,
    pub pool_address: Pubkey,
    pub salvor: Pubkey,
    pub lp_holder_amount: u64,
    pub salvor_amount: u64,
    pub protocol_amount: u64,
}

#[event]
pub struct SalvageCompleted {
    pub pool_address: Pubkey,
    pub salvor: Pubkey,
    pub total_proceeds_lamports: u64,
}
