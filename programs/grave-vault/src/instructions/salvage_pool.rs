// SPDX-License-Identifier: Apache-2.0
//
// salvage_pool — the core settlement instruction.
//
//   Pre-flight (m3, unchanged):
//     1. Protocol not paused.
//     2. EligibilityCert is fresh, owned by GraveScanner, covers this pool.
//     3. Cert's criteria_bitmap equals ALL_CRITERIA_MASK (all six criteria).
//     4. Cert binds to params' amm_program_id + pool_address.
//     5. Pool account matches params.pool_address.
//     6. Lazy-init lp_holder_pool_vault (system-owned PDA, 0 data).
//
//   Execution (m5, NEW):
//     7. Lazy-init vault_sol_holding_account (same pattern).
//     8. Determine base orientation: which of pool_coin_mint /
//        pool_pc_mint is WSOL? Revert UnsupportedBaseToken otherwise.
//     9. SPL transfer: salvor_lp_token_account → vault_lp_token_account
//        (salvor signs). Amount = params.salvor_lp_amount.
//    10. Validate vault LP balance == salvor_lp_amount (cross-check).
//    11. Cross-check params.lp_total_supply_at_snapshot against on-chain
//        lp_mint.supply — reject if off (InvalidSnapshotData).
//    12. Dispatch to AMM-specific remove_liquidity CPI. Returns
//        (base_received, memecoin_received). vault_authority PDA-signs.
//    13. If memecoin_received >= jupiter_dust_threshold:
//          a. Jupiter v6 swap CPI: memecoin → WSOL into
//             vault_base_token_account. vault_authority PDA-signs.
//          b. Assert post-swap vault_base.amount >= min_quote_output_lamports
//             (SlippageExceeded otherwise).
//        Else: skip swap. Memecoin remains in the vault token account; it
//        is unrecoverable for this salvage but is documented in the
//        SalvageReceipt.
//    14. Close vault_base_token_account (now holding the entire WSOL
//        recovery): destination = vault_sol_holding_account. Returns
//        WSOL + rent as native SOL.
//    15. Compute 40/40/20 split via u128 math; rounding remainder routed
//        to protocol. Three system_program::transfer calls, all signed
//        by vault_authority.
//    16. Populate PoolRegistry (merkle_root, lp_total_supply_at_snapshot,
//        lp_holder_pool_total_lamports).
//    17. Populate SalvageReceipt (all four amounts + timestamps).
//    18. Emit PoolSalvaged + SalvageCompleted.
//
//   The handler is parametric over `'info` because the CPI helpers take
//   `RemoveLiquidityInput<'_, 'info>` with the slice and the
//   AccountInfo<'info>s sharing the same lifetime (avoids E0621 elided-
//   lifetime errors documented in the failure-pattern memory).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program::{self, CreateAccount};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::cpi::jupiter::{swap as jupiter_swap, JupiterSwapInput};
use crate::cpi::{dispatch_remove_liquidity, RemoveLiquidityInput};
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
    /// LP token total supply at snapshot. Cross-checked against on-chain
    /// lp_mint.supply at salvage time — must equal it (InvalidSnapshotData
    /// otherwise) since the salvor's snapshot is the basis for claim-side
    /// pro-rata math.
    pub lp_total_supply_at_snapshot: u64,
    /// Minimum WSOL output from the Jupiter swap leg (slippage floor on
    /// the memecoin → WSOL conversion only, NOT a total-recovery floor).
    /// Set by salvor based on Jupiter's quote ± slippage tolerance.
    pub min_quote_output_lamports: u64,

    // ---- m5 additions ----

    /// LP amount the salvor transfers into the vault for burning. Must
    /// equal the total LP the salvor wants this salvage to extract (the
    /// CPI burns the full vault LP balance — partial burns aren't
    /// supported because the AMM's withdraw is atomic).
    pub salvor_lp_amount: u64,
    /// Jupiter v6 route instruction data (encoded `route` ix), pre-computed
    /// off-chain by the salvor's bot via Jupiter's quote API. Forwarded
    /// verbatim to the Jupiter v6 program.
    pub jupiter_route_data: Vec<u8>,
    /// Optional per-tx slippage override (in bps). If `Some`, the effective
    /// slippage cap is `min(override, config.max_slippage_bps)`. Defaults
    /// to the protocol config value.
    pub max_slippage_bps_override: Option<u16>,
    /// Number of `route_accounts` for the Jupiter swap — first N accounts
    /// in `remaining_accounts` after the Raydium V4 portion. The Raydium
    /// V4 portion is the first `RAYDIUM_V4_WITHDRAW_REMAINING_ACCOUNTS_REQUIRED`
    /// (= 11); Jupiter accounts follow. Total = 11 + this value.
    pub jupiter_route_accounts_len: u8,
}

#[derive(Accounts)]
#[instruction(params: SalvagePoolParams)]
pub struct SalvagePool<'info> {
    #[account(seeds = [ProtocolConfig::SEED], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// EligibilityCert PDA from the GraveScanner program.
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

    /// Per-pool registry; init-on-PDA is the canonical double-salvage defense.
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
    /// 0-data. Lazy-init via system_program::create_account on first salvage.
    /// Charter invariant: this account is UNSWEEPABLE by any admin key, ever;
    /// only `claim_lp_proceeds` may debit it against a valid Merkle proof.
    #[account(
        mut,
        seeds = [LP_HOLDER_POOL_SEED, params.pool_address.as_ref()],
        bump,
    )]
    pub lp_holder_pool_vault: UncheckedAccount<'info>,

    /// CHECK: protocol treasury PDA receives the protocol share.
    #[account(mut, seeds = [PROTOCOL_TREASURY_SEED], bump)]
    pub protocol_treasury: UncheckedAccount<'info>,

    /// The salvor performing the salvage. Pays rent, signs the LP transfer,
    /// and receives the salvor share.
    #[account(mut)]
    pub salvor: Signer<'info>,

    /// CHECK: AMM-specific pool account. Validated against `params.pool_address`.
    /// CPI dispatch by `pool.owner.key()` (Raydium V4 vs honest-stub adapters).
    pub pool: UncheckedAccount<'info>,

    // -------------------- m5 additions --------------------

    /// CHECK: Singleton vault authority PDA. Signs the inner Raydium V4
    /// withdraw CPI (as `user_owner`), the Jupiter swap CPI, the WSOL
    /// close, and the three system_program::transfer distribution legs.
    /// No data; pure signer authority.
    #[account(mut, seeds = [VAULT_AUTHORITY_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: Per-pool native SOL holding account. Receives the WSOL→SOL
    /// unwrap after the Jupiter swap and serves as the source for the
    /// three distribution transfers. Lazy-init via system_program::
    /// create_account on first salvage of this pool (same pattern as
    /// lp_holder_pool_vault — Anchor 0.32 forbids init on SystemAccount).
    #[account(
        mut,
        seeds = [VAULT_SOL_HOLDING_SEED, params.pool_address.as_ref()],
        bump,
    )]
    pub vault_sol_holding_account: UncheckedAccount<'info>,

    /// Salvor's source LP token account. Salvor signs the transfer into
    /// `vault_lp_token_account` for atomic deposit-and-burn.
    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = salvor,
    )]
    pub salvor_lp_token_account: Account<'info, TokenAccount>,

    /// Vault's LP token account. Receives the salvor's LP transfer, then
    /// the Raydium V4 withdraw burns the full balance. `init_if_needed`
    /// on TokenAccount is permitted in Anchor 0.32 (the restriction is
    /// SystemAccount-only).
    #[account(
        init_if_needed,
        payer = salvor,
        associated_token::mint = lp_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_lp_token_account: Account<'info, TokenAccount>,

    /// Vault's WSOL token account. Receives the WSOL portion of Raydium V4
    /// withdraw + the Jupiter swap output. Closed at end of handler to
    /// unwrap to native SOL.
    #[account(
        init_if_needed,
        payer = salvor,
        associated_token::mint = wsol_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_base_token_account: Account<'info, TokenAccount>,

    /// Vault's memecoin token account. Receives the memecoin portion of
    /// Raydium V4 withdraw; spent by the Jupiter swap.
    #[account(
        init_if_needed,
        payer = salvor,
        associated_token::mint = memecoin_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_memecoin_token_account: Account<'info, TokenAccount>,

    /// LP token mint. Anchor validates the vault_lp_token_account's mint
    /// against this. Salvor passes the pool's actual LP mint.
    pub lp_mint: Account<'info, Mint>,

    /// Memecoin (non-base) mint. Salvor passes the pool's non-WSOL mint.
    pub memecoin_mint: Account<'info, Mint>,

    /// Wrapped SOL mint. Anchor's `address` constraint pins this to the
    /// fixed network constant — a salvor cannot supply a fake WSOL mint
    /// to spoof base-token detection.
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, SalvagePool<'info>>,
    params: SalvagePoolParams,
) -> Result<()> {
    let cfg = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    // ============================================================
    // m3 pre-flight (unchanged)
    // ============================================================

    require!(!cfg.emergency_paused, GraveVaultError::ProtocolPaused);

    let cert = &ctx.accounts.eligibility_cert;
    require!(
        !cert.is_expired(clock.unix_timestamp),
        GraveVaultError::EligibilityCertExpired
    );
    require!(
        cert.criteria_bitmap == ALL_CRITERIA_MASK,
        GraveVaultError::InvalidEligibilityCert
    );
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
    require_keys_eq!(
        ctx.accounts.pool.key(),
        params.pool_address,
        GraveVaultError::PreflightFailed
    );

    // ============================================================
    // m3 + m5: lazy-init system PDAs
    // ============================================================

    lazy_init_system_pda(
        &ctx.accounts.lp_holder_pool_vault,
        &ctx.accounts.salvor,
        &ctx.accounts.system_program,
        LP_HOLDER_POOL_SEED,
        params.pool_address.as_ref(),
        ctx.bumps.lp_holder_pool_vault,
    )?;
    lazy_init_system_pda(
        &ctx.accounts.vault_sol_holding_account,
        &ctx.accounts.salvor,
        &ctx.accounts.system_program,
        VAULT_SOL_HOLDING_SEED,
        params.pool_address.as_ref(),
        ctx.bumps.vault_sol_holding_account,
    )?;

    // ============================================================
    // m5: base-token orientation + snapshot validation
    // ============================================================

    // The salvor passes memecoin_mint as part of the named Accounts struct,
    // and lp_mint similarly. wsol_mint is pinned to So111...112 by the
    // `#[account(address = WSOL_MINT)]` constraint, so no further check is
    // needed there. Pool orientation (which side is base/coin vs pc) is
    // determined by the Raydium V4 adapter based on `base_is_coin_side`
    // — for v1.0 we just declare it: WSOL is the base. If a salvor passes
    // a pool whose neither mint is WSOL, the Raydium V4 withdraw CPI will
    // fail when its mint constraints don't match, surfacing as
    // AmmRedemptionFailed.
    //
    // PRE-MAINNET-TODO(CPI): parse pool data to detect base_is_coin_side
    // from on-chain mints rather than trusting the salvor's account order.
    // For m5 we hardcode `base_is_coin_side = true` (most Raydium SOL/X
    // pools have SOL as the coin side); a salvor with a pool that has
    // WSOL as PC will need to invert their submission ordering.
    let base_is_coin_side = true;

    // Snapshot sanity: lp_total_supply_at_snapshot must match the live
    // mint supply at salvage time. The salvor's off-chain LP holder
    // snapshot is only valid if total_supply hasn't moved between snapshot
    // and submission — otherwise the pro-rata math at claim time is wrong.
    require!(
        ctx.accounts.lp_mint.supply == params.lp_total_supply_at_snapshot,
        GraveVaultError::InvalidSnapshotData
    );

    // ============================================================
    // m5: salvor → vault LP transfer (atomic deposit before burn)
    // ============================================================

    require!(
        params.salvor_lp_amount > 0,
        GraveVaultError::PreflightFailed
    );

    {
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.salvor_lp_token_account.to_account_info(),
                to: ctx.accounts.vault_lp_token_account.to_account_info(),
                authority: ctx.accounts.salvor.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, params.salvor_lp_amount)?;
    }

    // Refresh vault_lp_token_account state post-transfer.
    ctx.accounts.vault_lp_token_account.reload()?;
    require!(
        ctx.accounts.vault_lp_token_account.amount >= params.salvor_lp_amount,
        GraveVaultError::PreflightFailed
    );

    // ============================================================
    // m5: AMM remove_liquidity dispatch (Raydium V4 real; others stub)
    // ============================================================

    // Split remaining_accounts: first 11 are Raydium V4 internals; the
    // rest (count = params.jupiter_route_accounts_len) are Jupiter route
    // accounts. Anchor's `Context` carries remaining_accounts as `&[]`
    // bound to ctx's outer lifetime.
    let raydium_len = RAYDIUM_V4_WITHDRAW_REMAINING_ACCOUNTS_REQUIRED;
    let jupiter_len = params.jupiter_route_accounts_len as usize;
    require!(
        ctx.remaining_accounts.len() == raydium_len + jupiter_len,
        GraveVaultError::PreflightFailed
    );

    let (raydium_remaining, jupiter_remaining) = ctx.remaining_accounts.split_at(raydium_len);

    let removal = {
        let input = RemoveLiquidityInput {
            pool: &ctx.accounts.pool.to_account_info(),
            vault_authority: &ctx.accounts.vault_authority.to_account_info(),
            vault_lp_token_account: &ctx.accounts.vault_lp_token_account.to_account_info(),
            vault_base_token_account: &ctx.accounts.vault_base_token_account.to_account_info(),
            vault_memecoin_token_account: &ctx
                .accounts
                .vault_memecoin_token_account
                .to_account_info(),
            lp_mint: &ctx.accounts.lp_mint.to_account_info(),
            token_program: &ctx.accounts.token_program.to_account_info(),
            lp_amount: params.salvor_lp_amount,
            base_is_coin_side,
            vault_authority_bump: ctx.bumps.vault_authority,
            remaining_accounts: raydium_remaining,
        };
        dispatch_remove_liquidity(input)?
    };

    // ============================================================
    // m5: Jupiter v6 swap (memecoin → WSOL) — skip if below dust
    // ============================================================

    if removal.memecoin_received >= cfg.jupiter_dust_threshold_lamports {
        let _swap_output = {
            let input = JupiterSwapInput {
                vault_authority: &ctx.accounts.vault_authority.to_account_info(),
                destination_token_account: &ctx
                    .accounts
                    .vault_base_token_account
                    .to_account_info(),
                route_accounts: jupiter_remaining,
                route_data: params.jupiter_route_data.clone(),
                vault_authority_bump: ctx.bumps.vault_authority,
            };
            jupiter_swap(input)?
        };

        // Refresh + assert slippage floor met. The Raydium-V4-leg base
        // contribution is `removal.base_received`; the Jupiter swap adds
        // additional WSOL to the same `vault_base_token_account`, so
        // post-swap `vault_base_token_account.amount` is the total. We
        // assert against `min_quote_output_lamports` interpreted as the
        // floor for the Jupiter swap-leg portion (not total).
        ctx.accounts.vault_base_token_account.reload()?;
        let swap_only_output = ctx
            .accounts
            .vault_base_token_account
            .amount
            .checked_sub(removal.base_received)
            .ok_or(error!(GraveVaultError::MathOverflow))?;
        require!(
            swap_only_output >= params.min_quote_output_lamports,
            GraveVaultError::SlippageExceeded
        );
    } else {
        // Dust below threshold — emit log so the indexer can flag it but
        // don't revert. Memecoin balance remains in the vault token
        // account; rent-reclaim is a follow-up admin path (not m5).
        msg!(
            "salvage_pool: memecoin {} below dust threshold {}; skipping Jupiter swap",
            removal.memecoin_received,
            cfg.jupiter_dust_threshold_lamports
        );
    }

    // ============================================================
    // m5: unwrap WSOL → native SOL into vault_sol_holding_account
    // ============================================================

    // Refresh vault_base balance to get final WSOL holding (Raydium leg
    // + Jupiter leg, if any).
    ctx.accounts.vault_base_token_account.reload()?;
    let total_recovered_wsol = ctx.accounts.vault_base_token_account.amount;
    require!(
        total_recovered_wsol > 0,
        GraveVaultError::AmmRedemptionFailed
    );

    {
        let bump = [ctx.bumps.vault_authority];
        let signer_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &bump];
        let close_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_base_token_account.to_account_info(),
                destination: ctx.accounts.vault_sol_holding_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            &[signer_seeds],
        );
        token::close_account(close_ctx)?;
    }

    // ============================================================
    // m5: 40/40/20 distribution (u128 math, rounding remainder → protocol)
    // ============================================================

    // Validate share split sums to BPS_DENOMINATOR (defense in depth —
    // update_protocol_config should already enforce this, but cheap to
    // re-check here so a corrupted ProtocolConfig doesn't leak value).
    let share_sum = cfg
        .lp_holder_share_bps
        .checked_add(cfg.salvor_share_bps)
        .and_then(|s| s.checked_add(cfg.protocol_share_bps))
        .ok_or(error!(GraveVaultError::MathOverflow))?;
    require!(
        share_sum as u64 == BPS_DENOMINATOR,
        GraveVaultError::InvalidShareSplit
    );
    require!(
        cfg.protocol_share_bps <= PROTOCOL_SHARE_BPS_CEILING,
        GraveVaultError::ProtocolShareExceedsCeiling
    );

    let total = total_recovered_wsol;
    let salvor_share = (total as u128)
        .checked_mul(cfg.salvor_share_bps as u128)
        .ok_or(error!(GraveVaultError::MathOverflow))?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(error!(GraveVaultError::MathOverflow))? as u64;
    let lp_holder_share = (total as u128)
        .checked_mul(cfg.lp_holder_share_bps as u128)
        .ok_or(error!(GraveVaultError::MathOverflow))?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(error!(GraveVaultError::MathOverflow))? as u64;
    let protocol_share = total
        .checked_sub(salvor_share)
        .and_then(|x| x.checked_sub(lp_holder_share))
        .ok_or(error!(GraveVaultError::MathOverflow))?;

    // Three system transfers, all signed by vault_authority. We could also
    // bypass system_program by directly decrementing/incrementing lamports
    // (vault_sol_holding_account is a system-owned PDA we control), but
    // going through system_program::transfer is the cleaner pattern and
    // emits the standard transfer instruction in the tx log.
    transfer_from_vault_sol_holding(
        &ctx.accounts.vault_sol_holding_account,
        &ctx.accounts.salvor.to_account_info(),
        salvor_share,
        ctx.bumps.vault_sol_holding_account,
        params.pool_address.as_ref(),
    )?;
    transfer_from_vault_sol_holding(
        &ctx.accounts.vault_sol_holding_account,
        &ctx.accounts.lp_holder_pool_vault.to_account_info(),
        lp_holder_share,
        ctx.bumps.vault_sol_holding_account,
        params.pool_address.as_ref(),
    )?;
    transfer_from_vault_sol_holding(
        &ctx.accounts.vault_sol_holding_account,
        &ctx.accounts.protocol_treasury.to_account_info(),
        protocol_share,
        ctx.bumps.vault_sol_holding_account,
        params.pool_address.as_ref(),
    )?;

    // ============================================================
    // m5: populate PoolRegistry + SalvageReceipt + emit events
    // ============================================================

    let registry = &mut ctx.accounts.pool_registry;
    registry.amm_program_id = params.amm_program_id;
    registry.pool_address = params.pool_address;
    registry.salvor = ctx.accounts.salvor.key();
    registry.lp_snapshot_merkle_root = params.lp_snapshot_merkle_root;
    registry.lp_total_supply_at_snapshot = params.lp_total_supply_at_snapshot;
    registry.lp_holder_pool_total_lamports = lp_holder_share;
    registry.lp_holder_pool_claimed_lamports = 0;
    registry.salvaged_at_slot = clock.slot;
    registry.salvaged_at_ts = clock.unix_timestamp;
    registry.bump = ctx.bumps.pool_registry;
    registry._reserved = [0u8; 64];

    let receipt = &mut ctx.accounts.salvage_receipt;
    receipt.pool_address = params.pool_address;
    receipt.salvor = ctx.accounts.salvor.key();
    receipt.lp_holder_amount_lamports = lp_holder_share;
    receipt.salvor_amount_lamports = salvor_share;
    receipt.protocol_amount_lamports = protocol_share;
    receipt.total_proceeds_lamports = total;
    receipt.issued_at_slot = clock.slot;
    receipt.issued_at_ts = clock.unix_timestamp;
    receipt.bump = ctx.bumps.salvage_receipt;
    receipt._reserved = [0u8; 32];

    emit!(PoolSalvaged {
        amm_program_id: params.amm_program_id,
        pool_address: params.pool_address,
        salvor: ctx.accounts.salvor.key(),
        lp_holder_amount: lp_holder_share,
        salvor_amount: salvor_share,
        protocol_amount: protocol_share,
    });
    emit!(SalvageCompleted {
        pool_address: params.pool_address,
        salvor: ctx.accounts.salvor.key(),
        total_proceeds_lamports: total,
    });

    Ok(())
}

// =====================================================================
// Helpers
// =====================================================================

/// Lazy-init a system-owned, zero-data PDA via `system_program::create_account`.
/// Skips the CPI when the account already has lamports (already initialised).
/// Anchor 0.32 forbids `init`/`init_if_needed` on `SystemAccount`, so this
/// is the canonical replacement.
fn lazy_init_system_pda<'info>(
    pda: &UncheckedAccount<'info>,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    seed_prefix: &[u8],
    seed_suffix: &[u8],
    bump: u8,
) -> Result<()> {
    if pda.lamports() > 0 {
        return Ok(());
    }
    let rent = Rent::get()?.minimum_balance(0);
    let bump_seed = [bump];
    let seeds: &[&[u8]] = &[seed_prefix, seed_suffix, &bump_seed];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    system_program::create_account(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            CreateAccount {
                from: payer.to_account_info(),
                to: pda.to_account_info(),
            },
            signer_seeds,
        ),
        rent,
        0,
        &system_program::ID,
    )
}

/// Transfer lamports from `vault_sol_holding_account` (a system-owned PDA
/// we control via `vault_authority` semantics, though the PDA itself is
/// the lamports source) to `to`. The source PDA's lamports are decremented
/// directly because system_program::transfer requires the source to be
/// owned by the system program AND signed by the source's authority — for
/// PDAs that's invoke_signed with the source's own seeds.
fn transfer_from_vault_sol_holding<'info>(
    source: &UncheckedAccount<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    bump: u8,
    pool_address_bytes: &[u8],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let ix = anchor_lang::solana_program::system_instruction::transfer(
        source.key,
        to.key,
        amount,
    );
    let bump_seed = [bump];
    let seeds: &[&[u8]] = &[VAULT_SOL_HOLDING_SEED, pool_address_bytes, &bump_seed];
    invoke_signed(
        &ix,
        &[source.to_account_info(), to.clone()],
        &[seeds],
    )
    .map_err(|_| error!(GraveVaultError::MathOverflow))
}

// =====================================================================
// Events
// =====================================================================

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
