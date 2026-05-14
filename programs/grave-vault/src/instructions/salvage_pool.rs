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
// This handler currently lands m3 (pre-flight + PoolRegistry init + cert
// freshness gates). The CPI bodies for steps 5–7 are tracked as m4–m7 in
// the canonical 10-step build sequence and are honest-stubbed today —
// distribution math fields are zeroed at the SalvageReceipt level.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};

use crate::constants::*;
use crate::errors::GraveVaultError;
use crate::state::{PoolRegistry, ProtocolConfig, SalvageReceipt};

use grave_scanner::state::EligibilityCert;

/// Bitmap mask for "all six derelict-pool criteria pass" on an EligibilityCert.
///
/// Must match `grave_scanner::criteria::ALL_CRITERIA_MASK`. Hardcoded here
/// rather than imported so a misnamed re-export on the Scanner side fails
/// at compile time rather than silently. Updating this constant requires
/// updating the Scanner-side mask in lock-step (see Combined Tech Doc §3.5).
pub const ALL_CRITERIA_MASK: u8 = 0b00111111; // 0x3F = 6 criteria

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

    /// EligibilityCert PDA from the GraveScanner program.
    ///
    /// Anchor validates here:
    ///   - PDA derivation under `grave_scanner::ID` (via `seeds::program`)
    ///   - 8-byte discriminator (via `Account<EligibilityCert>`)
    ///   - Owner program == `grave_scanner::ID` (Account<...> default behavior)
    ///
    /// Pool / AMM / freshness / criteria-bitmap checks are layered in the
    /// handler — `Account<...>` only validates the wire format and ownership.
    #[account(
        seeds = [
            ELIGIBILITY_CERT_SEED,
            params.amm_program_id.as_ref(),
            params.pool_address.as_ref(),
        ],
        seeds::program = grave_scanner::ID,
        bump = eligibility_cert.bump,
    )]
    pub eligibility_cert: Account<'info, EligibilityCert>,

    /// Per-pool registry; init-on-PDA is the canonical double-salvage defense
    /// (a second salvage_pool against the same pool fails because this PDA
    /// already exists).
    #[account(
        init,
        payer = salvor,
        space = 8 + PoolRegistry::INIT_SPACE,
        seeds = [POOL_REGISTRY_SEED, params.pool_address.as_ref()],
        bump,
    )]
    pub pool_registry: Account<'info, PoolRegistry>,

    /// Per-pool immutable receipt; second canonical defense layer.
    #[account(
        init,
        payer = salvor,
        space = 8 + SalvageReceipt::INIT_SPACE,
        seeds = [SALVAGE_RECEIPT_SEED, params.pool_address.as_ref()],
        bump,
    )]
    pub salvage_receipt: Account<'info, SalvageReceipt>,

    /// CHECK: LP-holder share vault — native-SOL system account, system-owned,
    /// 0-data. Created lazily on first salvage of this pool via a manual
    /// system_program::create_account CPI in the handler. Anchor 0.32 rejects
    /// `init`/`init_if_needed` on `SystemAccount`, so the explicit CPI is the
    /// replacement pattern. Subsequent (would-be) salvages of the same pool
    /// are blocked at the `pool_registry` init gate, so the lazy-init only
    /// matters on the first call. Charter invariant: this account is
    /// UNSWEEPABLE by any admin key, ever; only `claim_lp_proceeds` may debit
    /// it against a valid Merkle proof.
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

    // Gate 1: emergency pause. claim_lp_proceeds stays live during pause;
    // only salvage_pool is gated.
    require!(!cfg.emergency_paused, GraveVaultError::ProtocolPaused);

    let cert = &ctx.accounts.eligibility_cert;

    // Gate 2: cert freshness. `is_expired` does the canonical comparison
    // `now >= expires_at`. The TTL window is governance-configurable in
    // GraveScanner ProtocolConfig (floored at MIN_CERT_TTL_SECONDS = 600s
    // by `update_protocol_config`).
    let clock = Clock::get()?;
    require!(
        !cert.is_expired(clock.unix_timestamp),
        GraveVaultError::EligibilityCertExpired
    );

    // Gate 3: cert criteria bitmap. All six derelict-pool criteria must
    // have passed at Phase 2. Anything else means the cert was issued in
    // a degraded mode and is not authoritative for salvage.
    require!(
        cert.criteria_bitmap == ALL_CRITERIA_MASK,
        GraveVaultError::InvalidEligibilityCert
    );

    // Gate 4: cert binds to THIS pool / THIS AMM. Anchor's seed derivation
    // gates the PDA path; we additionally require the cert's stored fields
    // match the params (defense in depth against a malicious cross-pool
    // submission with a forged seed match).
    require_keys_eq!(
        cert.amm_program_id,
        params.amm_program_id,
        GraveVaultError::InvalidEligibilityCert
    );
    require_keys_eq!(
        cert.pool_address,
        params.pool_address,
        GraveVaultError::InvalidEligibilityCert
    );

    // Gate 5: pool address consistency between accounts and params.
    require_keys_eq!(
        ctx.accounts.pool.key(),
        params.pool_address,
        GraveVaultError::PreflightFailed
    );

    // Lazy-init the LP-holder share vault. Anchor 0.32 forbids
    // `init`/`init_if_needed` on `SystemAccount`, so we issue the
    // create_account CPI ourselves. On the second salvage attempt for the
    // same pool, this branch is unreachable because the `pool_registry`
    // init constraint above already failed — so this is effectively first-
    // salvage-only and the safety footgun cited by upstream does not apply.
    let vault = &ctx.accounts.lp_holder_pool_vault;
    if vault.lamports() == 0 {
        let rent = Rent::get()?.minimum_balance(0);
        let pool_bytes = params.pool_address.to_bytes();
        let vault_bump = ctx.bumps.lp_holder_pool_vault;
        let seeds: &[&[u8]] = &[LP_HOLDER_POOL_SEED, &pool_bytes, &[vault_bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.salvor.to_account_info(),
                    to: vault.to_account_info(),
                },
                signer_seeds,
            ),
            rent,
            0,
            &system_program::ID,
        )?;
    }

    // ---- Pre-flight complete. Below this line is m4–m7 territory. ----

    // TODO(GraveVault m4): LP holder snapshot + Merkle root verification.
    //   — Today: trust salvor-supplied root, lock it into PoolRegistry.
    //   — Future: parse on-chain LP token holders and recompute root.
    // TODO(GraveVault m5): CPI to AMM remove_liquidity (Raydium V4 first).
    //   — Today: stub (no CPI). lp_holder_pool_total_lamports stays 0.
    //   — Future: vault_authority PDA-signs the LP burn / withdrawal.
    // TODO(GraveVault m6): CPI to Jupiter v6 swap (skip below dust).
    //   — Today: stub. min_quote_output_lamports parameter is captured
    //     but not enforced because nothing is being swapped yet.
    // TODO(GraveVault m7): compute 40/40/20 distribution and route lamports.
    //   — Today: stub. SalvageReceipt distribution fields are zeroed.

    // Capture min_quote_output_lamports in a local so the unused-variable
    // lint stays quiet through m6. Removing this is part of m6.
    let _expected_quote_floor = params.min_quote_output_lamports;

    let registry = &mut ctx.accounts.pool_registry;
    registry.amm_program_id = params.amm_program_id;
    registry.pool_address = params.pool_address;
    registry.salvor = ctx.accounts.salvor.key();
    registry.lp_snapshot_merkle_root = params.lp_snapshot_merkle_root;
    registry.lp_total_supply_at_snapshot = params.lp_total_supply_at_snapshot;
    registry.lp_holder_pool_total_lamports = 0; // populated by m7
    registry.lp_holder_pool_claimed_lamports = 0;
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
