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
//   Execution (m5 -> Phase 3):
//     7. Lazy-init vault_sol_holding_account (same pattern).
//     8. Derive base orientation from the pool's ON-CHAIN AmmInfo mints
//        (coin_mint@400 / pc_mint@432): exactly one side must be WSOL,
//        else `UnsupportedBaseToken` (7019) BEFORE any CPI (CPI-010).
//        The submitted `lp_mint` and `memecoin_mint` are bound to the
//        pool's own bytes (PreflightFailed 7013 otherwise).
//     9. LP is burned IN PLACE in the salvor's account by the Raydium V4
//        withdraw CPI: the salvor signs the salvage transaction and acts
//        as the withdraw's `user_owner`; proceeds land in vault-owned
//        token accounts. `vault_authority` PDA-signs nothing on this leg.
//    10. Validate vault LP burn amount == params.salvor_lp_amount and
//        cross-check params.lp_total_supply_at_snapshot against the
//        on-chain lp_mint.supply (InvalidSnapshotData).
//    11. Dispatch to AMM-specific remove_liquidity CPI. Returns
//        (base_received, memecoin_received) via pre/post balance
//        snapshots. Requires base_received > 0.
//    12. Route-account vetting (Phase 3, N1): every Jupiter route account
//        is checked against the vault's custody/state accounts (registry,
//        receipt, LP-holder vault, treasury, SOL holding, config, cert,
//        salvor) — none may appear — and the vault's WSOL destination
//        account MUST be present. The route is otherwise opaque:
//        forwarded verbatim, so no route-plan parsing is possible or
//        needed.
//    13. Slippage ceiling (Phase 3, SLIP-001/B6): with the swap leg active,
//        the submitted floor `min_quote_output_lamports` must be at least
//        the pool-implied conversion minus the effective cap:
//        floor >= memecoin_received * wsol_reserve / memecoin_reserve
//               * (1 - cap/10_000),
//        where the reserves are the POST-withdraw pool vault balances and
//        cap = min(config.max_slippage_bps, HARD_MAX_SLIPPAGE_BPS) further
//        tightened by params.max_slippage_bps_override when provided.
//        Enforced BEFORE the swap CPI (SlippageExceeded 7007) — a salvor
//        cannot submit a losing floor at all.
//    14. If memecoin_received >= jupiter_dust_threshold:
//          a. Jupiter v6 swap CPI: memecoin -> WSOL into
//             vault_base_token_account. vault_authority PDA-signs.
//          b. Assert the swap-leg output (post-swap vault WSOL balance
//             minus base_received) >= min_quote_output_lamports
//             (SlippageExceeded otherwise) — the D4 Jupiter-leg floor.
//        Else: skip swap. Memecoin remains in the vault token account; it
//        is unrecoverable for this salvage but is documented in the
//        SalvageReceipt (dust policy: D6 / Phase 4).
//    15. Close vault_base_token_account (now holding the entire WSOL
//        recovery): destination = vault_sol_holding_account. Returns
//        WSOL + rent as native SOL.
//    16. Compute 40/40/20 split via u128 math; rounding remainder routed
//        to protocol. Three system_program::transfer calls, all signed
//        by vault_authority.
//    17. Populate PoolRegistry (merkle_root, lp_total_supply_at_snapshot,
//        lp_holder_pool_total_lamports).
//    18. Populate SalvageReceipt (all four amounts + timestamps).
//    19. Emit PoolSalvaged + SalvageCompleted.
//
//   The handler is parametric over `'info` because the CPI helpers take
//   `RemoveLiquidityInput<'_, 'info>` with the slice and the
//   AccountInfo<'info>s sharing the same lifetime (avoids E0621 elided-
//   lifetime errors documented in the failure-pattern memory).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program::{self, CreateAccount};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount};

use crate::constants::*;
use crate::cpi::jupiter::{swap as jupiter_swap, JupiterSwapInput};
use crate::cpi::raydium_v4::ra_idx;
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
    /// slippage cap tightens to `min(override, config.max_slippage_bps,
    /// HARD_MAX_SLIPPAGE_BPS)`. A floor below the pool-implied conversion
    /// minus this cap reverts `SlippageExceeded` BEFORE the swap CPI
    /// (Phase 3, SLIP-001).
    pub max_slippage_bps_override: Option<u16>,
    /// Number of `route_accounts` for the Jupiter swap — first N accounts
    /// in `remaining_accounts` after the Raydium V4 portion. The Raydium
    /// V4 portion is the first `RAYDIUM_V4_WITHDRAW_REMAINING_ACCOUNTS_REQUIRED`
    /// (= 13); Jupiter accounts follow. Total = 13 + this value.
    pub jupiter_route_accounts_len: u8,
}

#[derive(Accounts)]
#[instruction(params: SalvagePoolParams)]
pub struct SalvagePool<'info> {
    #[account(seeds = [ProtocolConfig::SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

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
    pub eligibility_cert: Box<Account<'info, EligibilityCert>>,

    /// Per-pool registry; init-on-PDA is the canonical double-salvage defense.
    #[account(
        init,
        payer = salvor,
        space = 8 + PoolRegistry::INIT_SPACE,
        seeds = [POOL_REGISTRY_SEED, params.pool_address.as_ref()],
        bump,
    )]
    pub pool_registry: Box<Account<'info, PoolRegistry>>,

    /// Per-pool immutable receipt; second canonical defense layer.
    #[account(
        init,
        payer = salvor,
        space = 8 + SalvageReceipt::INIT_SPACE,
        seeds = [SALVAGE_RECEIPT_SEED, params.pool_address.as_ref()],
        bump,
    )]
    pub salvage_receipt: Box<Account<'info, SalvageReceipt>>,

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
    /// MUST be writable: the Raydium V4 withdraw CPI mutates the AmmInfo
    /// (`lp_amount` decrement + `recent_epoch` refresh) — a readonly outer
    /// account would make the CPI fail with PrivilegeEscalationAttempt.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: The AMM program account (`pool.owner`). Threaded into the
    /// remove-liquidity CPI's account list: the runtime requires the callee
    /// program to be among the caller's accounts, otherwise the CPI fails
    /// with `MissingAccount`. Validated executable + equal to `pool.owner`
    /// in the handler.
    pub amm_program: UncheckedAccount<'info>,

    /// CHECK: Jupiter v6 program, address-pinned. Threaded into the swap
    /// CPI's account list (same runtime rule as `amm_program`).
    #[account(address = JUPITER_V6_PROGRAM_ID)]
    pub jupiter_program: UncheckedAccount<'info>,

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
    pub salvor_lp_token_account: Box<Account<'info, TokenAccount>>,

    /// Vault's WSOL token account. Receives the WSOL portion of Raydium V4
    /// withdraw + the Jupiter swap output. Closed at end of handler to
    /// unwrap to native SOL.
    #[account(
        init_if_needed,
        payer = salvor,
        associated_token::mint = wsol_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_base_token_account: Box<Account<'info, TokenAccount>>,

    /// Vault's memecoin token account. Receives the memecoin portion of
    /// Raydium V4 withdraw; spent by the Jupiter swap.
    #[account(
        init_if_needed,
        payer = salvor,
        associated_token::mint = memecoin_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_memecoin_token_account: Box<Account<'info, TokenAccount>>,

    /// LP token mint. Anchor validates the vault_lp_token_account's mint
    /// against this. Salvor passes the pool's actual LP mint. MUST be
    /// writable: the Raydium V4 withdraw burns LP (mint supply decreases)
    /// inside the CPI.
    #[account(mut)]
    pub lp_mint: Box<Account<'info, Mint>>,

    /// Memecoin (non-base) mint. Salvor passes the pool's non-WSOL mint.
    pub memecoin_mint: Box<Account<'info, Mint>>,

    /// Wrapped SOL mint. Anchor's `address` constraint pins this to the
    /// fixed network constant — a salvor cannot supply a fake WSOL mint
    /// to spoof base-token detection.
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,

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
    // The AMM program account must be the pool's owner and executable: the
    // remove-liquidity CPI invokes it, and the runtime requires the callee
    // program to be among the caller's accounts (MissingAccount otherwise).
    require!(
        ctx.accounts.amm_program.executable,
        GraveVaultError::PreflightFailed
    );
    require_keys_eq!(
        *ctx.accounts.amm_program.key,
        *ctx.accounts.pool.owner,
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
    // m5 -> Phase 3: base-token orientation + snapshot validation
    // ============================================================

    // Orientation is DERIVED from the pool's on-chain AmmInfo mints, never
    // trusted from the submission (CPI-010): coin_mint@400 and pc_mint@432
    // of the 752-byte AmmInfo — offsets proven by the GraveScanner adapter
    // and byte-verified against mainnet fixtures. Exactly one side must be
    // the address-pinned WSOL mint; anything else reverts
    // UnsupportedBaseToken (7019) BEFORE any CPI. The submitted accounts
    // are then bound to the pool's own bytes so a mis-declared memecoin or
    // LP mint cannot desynchronise the vault's token accounts from the
    // pool the cert names (the SPL token program does NOT check
    // mint-consistency on Raydium's plain transfers). Non-V4 pools skip
    // the AmmInfo parse — `dispatch_remove_liquidity` reverts them with
    // AmmCpiUnimplemented (7017) before these values are consumed.
    let is_raydium_v4_pool = *ctx.accounts.pool.owner == RAYDIUM_V4_PROGRAM_ID;
    let (base_is_coin_side, pool_memecoin_mint, pool_lp_mint) = if is_raydium_v4_pool {
        derive_pool_orientation(&ctx.accounts.pool.to_account_info())?
    } else {
        (
            true,
            ctx.accounts.memecoin_mint.key(),
            ctx.accounts.lp_mint.key(),
        )
    };
    require_keys_eq!(
        ctx.accounts.memecoin_mint.key(),
        pool_memecoin_mint,
        GraveVaultError::PreflightFailed
    );
    require_keys_eq!(
        ctx.accounts.lp_mint.key(),
        pool_lp_mint,
        GraveVaultError::PreflightFailed
    );

    // Snapshot sanity: lp_total_supply_at_snapshot must match the live
    // mint supply at salvage time. The salvor's off-chain LP holder
    // snapshot is only valid if total_supply hasn't moved between snapshot
    // and submission — otherwise the pro-rata math at claim time is wrong.
    require!(
        ctx.accounts.lp_mint.supply == params.lp_total_supply_at_snapshot,
        GraveVaultError::InvalidSnapshotData
    );

    // ============================================================
    // m5 → Phase 2.1: the LP is burned IN PLACE in the salvor's account by
    // the withdraw CPI (the salvor signs the salvage transaction and is the
    // withdraw's `user_owner`). The earlier deposit-into-the-vault step was
    // removed: it added a needless custody hop and a PDA withdrawer that
    // the deployed Raydium V4 program rejects.
    // ============================================================

    require!(
        params.salvor_lp_amount > 0,
        GraveVaultError::PreflightFailed
    );

    // ============================================================
    // m5: AMM remove_liquidity dispatch (Raydium V4 real; others stub)
    // ============================================================

    // Split remaining_accounts: first 13 are Raydium V4 internals; the
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
            amm_program: &ctx.accounts.amm_program.to_account_info(),
            user_lp_token_account: &ctx.accounts.salvor_lp_token_account.to_account_info(),
            user_owner: &ctx.accounts.salvor.to_account_info(),
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
        // ============================================================
        // Phase 3 (N1): route-account vetting. Only runs when the swap leg is
        // active; the transaction reverts atomically, so a malicious route
        // submission cannot leave state behind even though the withdraw has
        // already executed at this point.
        // ============================================================
        //
        // The route itself is opaque (forwarded verbatim — the vault makes no
        // assumptions about Jupiter's route-plan encoding), so the defenses are
        // structural:
        //   1. No route account may be one of the vault's custody/state
        //      accounts: the pool registry, the salvage receipt, the LP-holder
        //      pool vault, the protocol treasury, the transient SOL holding
        //      account, the protocol config, the cert PDA, the salvor, or the
        //      salvor's LP account. A verbatim-forwarded route whose account
        //      list includes one of these has no legitimate use — legitimate
        //      routes reference the swap venue's accounts, not the vault's
        //      settlement state.
        //   2. The vault's WSOL destination account MUST be present. A route
        //      that omits it cannot credit it; requiring it up front gives a
        //      deterministic 7013 instead of relying solely on the post-swap
        //      floor (a hijacked destination would deliver 0 and revert below).
        {
            const FORBIDDEN: [&str; 9] = [
                "pool_registry",
                "salvage_receipt",
                "lp_holder_pool_vault",
                "protocol_treasury",
                "vault_sol_holding_account",
                "protocol_config",
                "eligibility_cert",
                "salvor",
                "salvor_lp_token_account",
            ];
            for route_acct in jupiter_remaining {
                for name in FORBIDDEN.iter() {
                    let forbidden_key = match *name {
                        "pool_registry" => ctx.accounts.pool_registry.key(),
                        "salvage_receipt" => ctx.accounts.salvage_receipt.key(),
                        "lp_holder_pool_vault" => ctx.accounts.lp_holder_pool_vault.key(),
                        "protocol_treasury" => ctx.accounts.protocol_treasury.key(),
                        "vault_sol_holding_account" => ctx.accounts.vault_sol_holding_account.key(),
                        "protocol_config" => ctx.accounts.protocol_config.key(),
                        "eligibility_cert" => ctx.accounts.eligibility_cert.key(),
                        "salvor" => ctx.accounts.salvor.key(),
                        "salvor_lp_token_account" => ctx.accounts.salvor_lp_token_account.key(),
                        _ => unreachable!(),
                    };
                    require_keys_neq!(
                        *route_acct.key,
                        forbidden_key,
                        GraveVaultError::PreflightFailed
                    );
                }
            }
            require!(
            jupiter_remaining
                .iter()
                .any(|a| a.key.as_ref() == ctx.accounts.vault_base_token_account.key().as_ref()),
            GraveVaultError::PreflightFailed
        );
        }

        // ----------------------------------------------------------
        // Phase 3 (SLIP-001/B6): protocol slippage ceiling.
        //
        // The floor a salvor submits must not be more permissive than the
        // protocol allows RELATIVE to a price the chain can compute
        // without trusting anyone: the pool's own post-withdraw reserve
        // ratio. The withdraw is pro-rata, so the ratio is essentially
        // the pool's pre-withdraw price; the cap absorbs fees, impact and
        // the PnL skew. cap = min(config.max_slippage_bps,
        // HARD_MAX_SLIPPAGE_BPS), tightened by the per-tx override when
        // provided. A floor below the implied conversion minus the cap
        // reverts BEFORE the swap CPI — a losing route can never even
        // execute. The Jupiter-leg floor (below) remains the output
        // bound; this check only governs how lossy a route the salvor may
        // SUBMIT (D4, as amended by Phase 3).
        // ----------------------------------------------------------
        let effective_cap_bps =
            effective_slippage_cap_bps(cfg.max_slippage_bps, params.max_slippage_bps_override);
        let coin_vault_amount = read_token_amount(&raydium_remaining[ra_idx::AMM_COIN_VAULT])?;
        let pc_vault_amount = read_token_amount(&raydium_remaining[ra_idx::AMM_PC_VAULT])?;
        let (wsol_reserve, memecoin_reserve) = if base_is_coin_side {
            (coin_vault_amount, pc_vault_amount)
        } else {
            (pc_vault_amount, coin_vault_amount)
        };
        require!(memecoin_reserve > 0, GraveVaultError::MathOverflow);
        let implied_wsol_out = (removal.memecoin_received as u128)
            .checked_mul(wsol_reserve as u128)
            .ok_or(error!(GraveVaultError::MathOverflow))?
            .checked_div(memecoin_reserve as u128)
            .ok_or(error!(GraveVaultError::MathOverflow))?;
        let min_floor = implied_wsol_out
            .checked_mul((BPS_DENOMINATOR as u128).saturating_sub(effective_cap_bps as u128))
            .ok_or(error!(GraveVaultError::MathOverflow))?
            .checked_div(BPS_DENOMINATOR as u128)
            .ok_or(error!(GraveVaultError::MathOverflow))?;
        require!(
            (params.min_quote_output_lamports as u128) >= min_floor,
            GraveVaultError::SlippageExceeded
        );

        let _swap_output = {
            let input = JupiterSwapInput {
                jupiter_program: &ctx.accounts.jupiter_program.to_account_info(),
                vault_authority: &ctx.accounts.vault_authority.to_account_info(),
                destination_token_account: &ctx.accounts.vault_base_token_account.to_account_info(),
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
        //
        // PRE-MAINNET-TODO(DUST): retained memecoin has no closure, sweep, or
        // recovery path and the SalvageReceipt carries no field for it |
        // reverts: none (logged and skipped; BelowDustThreshold is reserved
        // and never raised) | verify: define the dust policy (ATA closure /
        // sweep destination / receipt field) in Phase 4 before mainnet
        // (PROTOCOL_SPEC.md D6)
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
        let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &bump];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let close_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_base_token_account.to_account_info(),
                destination: ctx.accounts.vault_sol_holding_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
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

/// Read a token account's `amount` field by deserialising the raw account
/// data (same approach as the CPI adapters — avoids an `Account<..>`
/// wrapper on accounts that arrive via `remaining_accounts`).
fn read_token_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    let acct = TokenAccount::try_deserialize(&mut &data[..])
        .map_err(|_| error!(GraveVaultError::PreflightFailed))?;
    Ok(acct.amount)
}

/// Derive the pool's base orientation and mints from the pool's OWN bytes
/// (CPI-010): the 752-byte Raydium V4 AmmInfo carries coin_mint@400,
/// pc_mint@432 and lp_mint@464. Exactly one side must be WSOL — pools
/// without a WSOL side (USDC/USDT-style, a v1.1 deliverable) revert
/// `UnsupportedBaseToken` (7019) here, BEFORE any CPI, instead of failing
/// inside the Raydium withdraw as `AmmRedemptionFailed`.
///
/// Returns `(base_is_coin_side, memecoin_mint, lp_mint)` so the caller can
/// bind the submitted accounts to the pool's own bytes. Only valid for
/// Raydium V4 pools — the caller gates on `pool.owner` and lets
/// `dispatch_remove_liquidity` reject other AMMs with
/// `AmmCpiUnimplemented`.
fn derive_pool_orientation(pool: &AccountInfo) -> Result<(bool, Pubkey, Pubkey)> {
    let data = pool.try_borrow_data()?;
    require!(
        data.len() == RAYDIUM_V4_AMM_INFO_SIZE,
        GraveVaultError::PreflightFailed
    );
    let read_mint = |off: usize| {
        Pubkey::new_from_array(
            data[off..off + 32]
                .try_into()
                .expect("32-byte slice at a proven offset"),
        )
    };
    let coin_mint = read_mint(RAYDIUM_V4_OFF_COIN_MINT);
    let pc_mint = read_mint(RAYDIUM_V4_OFF_PC_MINT);
    let lp_mint = read_mint(RAYDIUM_V4_OFF_LP_MINT);
    let base_is_coin_side = if coin_mint == WSOL_MINT && pc_mint != WSOL_MINT {
        true
    } else if pc_mint == WSOL_MINT && coin_mint != WSOL_MINT {
        false
    } else {
        return Err(error!(GraveVaultError::UnsupportedBaseToken));
    };
    let memecoin_mint = if base_is_coin_side {
        pc_mint
    } else {
        coin_mint
    };
    Ok((base_is_coin_side, memecoin_mint, lp_mint))
}

/// Effective on-chain slippage cap in bps (SLIP-001): the protocol config
/// value clamped by the Charter hard ceiling, further tightened by the
/// per-tx override when provided. `0` is a legitimate result — it means
/// the submitted floor must cover the full pool-implied conversion.
fn effective_slippage_cap_bps(config_bps: u16, override_bps: Option<u16>) -> u16 {
    let cap = config_bps.min(HARD_MAX_SLIPPAGE_BPS);
    match override_bps {
        Some(o) => cap.min(o),
        None => cap,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- effective_slippage_cap_bps (SLIP-001 wiring)

    #[test]
    fn cap_uses_config_value_within_hard_ceiling() {
        assert_eq!(effective_slippage_cap_bps(300, None), 300);
        assert_eq!(effective_slippage_cap_bps(50, None), 50);
    }

    #[test]
    fn cap_clamps_config_to_hard_ceiling() {
        // A config above the Charter hard ceiling (1_000 bps) is clamped.
        assert_eq!(effective_slippage_cap_bps(5_000, None), 1_000);
        assert_eq!(effective_slippage_cap_bps(u16::MAX, None), 1_000);
    }

    #[test]
    fn override_only_tightens() {
        assert_eq!(effective_slippage_cap_bps(300, Some(100)), 100);
        // A looser override cannot widen the cap.
        assert_eq!(effective_slippage_cap_bps(300, Some(900)), 300);
        // The hard ceiling still binds a loosened config + loose override.
        assert_eq!(effective_slippage_cap_bps(5_000, Some(2_000)), 1_000);
        // Zero override = strictest possible cap.
        assert_eq!(effective_slippage_cap_bps(300, Some(0)), 0);
    }

    // ---- derive_pool_orientation (CPI-010)

    /// Build a synthetic 752-byte AmmInfo with the given mints at the
    /// proven offsets.
    fn amm_info_bytes(coin_mint: &Pubkey, pc_mint: &Pubkey, lp_mint: &Pubkey) -> Vec<u8> {
        let mut buf = vec![0u8; RAYDIUM_V4_AMM_INFO_SIZE];
        buf[RAYDIUM_V4_OFF_COIN_MINT..RAYDIUM_V4_OFF_COIN_MINT + 32]
            .copy_from_slice(coin_mint.as_ref());
        buf[RAYDIUM_V4_OFF_PC_MINT..RAYDIUM_V4_OFF_PC_MINT + 32].copy_from_slice(pc_mint.as_ref());
        buf[RAYDIUM_V4_OFF_LP_MINT..RAYDIUM_V4_OFF_LP_MINT + 32].copy_from_slice(lp_mint.as_ref());
        buf
    }

    fn to_account(bytes: Vec<u8>) -> AccountInfo<'static> {
        // Leak the backing storage: unit-test-only helper with 'static
        // lifetime plumbing.
        let bytes = Box::leak(bytes.into_boxed_slice());
        let key = Box::leak(Box::new(Pubkey::new_unique()));
        let owner = Box::leak(Box::new(RAYDIUM_V4_PROGRAM_ID));
        AccountInfo {
            key,
            lamports: std::rc::Rc::new(std::cell::RefCell::new(
                Box::leak(Box::new(0u64)) as &mut u64
            )),
            data: std::rc::Rc::new(std::cell::RefCell::new(&mut bytes[..])),
            owner,
            rent_epoch: 0,
            is_signer: false,
            is_writable: false,
            executable: false,
        }
    }

    #[test]
    fn orientation_coin_wsol_derives_true() {
        let memecoin = Pubkey::new_unique();
        let lp = Pubkey::new_unique();
        let info = to_account(amm_info_bytes(&WSOL_MINT, &memecoin, &lp));
        let (base_is_coin, parsed_memecoin, parsed_lp) = derive_pool_orientation(&info).unwrap();
        assert!(base_is_coin);
        assert_eq!(parsed_memecoin, memecoin);
        assert_eq!(parsed_lp, lp);
    }

    #[test]
    fn orientation_pc_wsol_derives_false() {
        let memecoin = Pubkey::new_unique();
        let lp = Pubkey::new_unique();
        let info = to_account(amm_info_bytes(&memecoin, &WSOL_MINT, &lp));
        let (base_is_coin, parsed_memecoin, parsed_lp) = derive_pool_orientation(&info).unwrap();
        assert!(!base_is_coin);
        assert_eq!(parsed_memecoin, memecoin);
        assert_eq!(parsed_lp, lp);
    }

    #[test]
    fn orientation_without_wsol_side_fails_closed() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let lp = Pubkey::new_unique();
        let info = to_account(amm_info_bytes(&a, &b, &lp));
        let err = derive_pool_orientation(&info).unwrap_err();
        assert_eq!(err, GraveVaultError::UnsupportedBaseToken.into());
    }

    #[test]
    fn orientation_with_wsol_on_both_sides_fails_closed() {
        let lp = Pubkey::new_unique();
        let info = to_account(amm_info_bytes(&WSOL_MINT, &WSOL_MINT, &lp));
        let err = derive_pool_orientation(&info).unwrap_err();
        assert_eq!(err, GraveVaultError::UnsupportedBaseToken.into());
    }

    #[test]
    fn orientation_rejects_wrong_pool_size() {
        let info = to_account(vec![0u8; 100]);
        let err = derive_pool_orientation(&info).unwrap_err();
        assert_eq!(err, GraveVaultError::PreflightFailed.into());
    }
}

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
    let ix = anchor_lang::solana_program::system_instruction::transfer(source.key, to.key, amount);
    let bump_seed = [bump];
    let seeds: &[&[u8]] = &[VAULT_SOL_HOLDING_SEED, pool_address_bytes, &bump_seed];
    invoke_signed(&ix, &[source.to_account_info(), to.clone()], &[seeds])
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
