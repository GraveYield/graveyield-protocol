// SPDX-License-Identifier: Apache-2.0
//
// GraveVault — settlement program.
//
// Consumes EligibilityCert PDAs from GraveScanner and executes the salvage:
// snapshot LP holders, CPI to AMM remove_liquidity, CPI to Jupiter v6 for
// quote-side swap, and distribute proceeds 40 / 40 / 20 to original LPs,
// salvor, and protocol respectively.
//
// Charter invariants enforced at the program level:
//
//   * 20% protocol share is a CEILING, not a target. Cannot be raised.
//   * `lp_holder_pool_vault` is unsweepable by any admin key, ever.
//   * 72h timelock on all parameter changes.
//   * Emergency pause is immediate but `claim_lp_proceeds` stays live.
//   * Standard upgrades = 7-day notice + 72h timelock.
//   * Emergency upgrades = 24h timelock + 5-day post-mortem.
//   * No token, NFT, points, airdrop, or staking at any layer.
//
// See:
//   - docs/whitepaper.md
//   - docs/grave-scanner-grave-vault-combined.md
//   - docs/architecture/charter-invariants.md

#![allow(clippy::result_large_err)]
// Anchor's `#[program]` macro expansion calls deprecated SDK methods
// (`AccountInfo::realloc()` etc.) on Anchor 0.31.x/0.32.x with Solana SDK
// 2.x/3.x. We silence the lint at crate level so `cargo clippy -D warnings`
// stays green until upstream removes the deprecation churn.
#![allow(deprecated)]
// Anchor's `#[program]` macro and Solana's `custom_panic_default!` emit
// `#[cfg(feature = "custom-panic")]`, `#[cfg(feature = "anchor-debug")]`,
// and `#[cfg(target_os = "solana")]` tags inside our crate. On Rust 1.80+
// these trip the `unexpected_cfgs` lint because the consuming crate did
// not declare them. We silence at crate level until the upstream macros
// emit `check-cfg` directives.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod cpi;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

// Localnet placeholder (deterministic SHA-256 seed; not a real keypair). Run
// `anchor keys list && anchor keys sync` after generating real keypairs to
// replace this and the matching entry in Anchor.toml.
declare_id!("FZbMHXKRsgXXoEGfSPF5gw74ThKBauThDfpCPt1MvKfw");

#[program]
pub mod grave_vault {
    use super::*;

    /// Initialise the GraveVault protocol config PDA. Multisig-only at launch.
    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        instructions::initialize::handler(ctx, params)
    }

    /// Update GraveVault protocol config. Multisig + 72h timelock.
    /// Cannot raise `protocol_share_bps` above the Charter ceiling (2000 bps).
    pub fn update_protocol_config(
        ctx: Context<UpdateProtocolConfig>,
        params: UpdateProtocolConfigParams,
    ) -> Result<()> {
        instructions::update_protocol_config::handler(ctx, params)
    }

    /// Multisig-only. Pauses new salvages immediately. `claim_lp_proceeds`
    /// remains live during pause — original LPs always recover their share.
    pub fn emergency_pause(ctx: Context<EmergencyPause>, paused: bool) -> Result<()> {
        instructions::emergency_pause::handler(ctx, paused)
    }

    /// Permissionless. Executes a salvage: pre-flight, LP snapshot, CPI to AMM
    /// remove_liquidity, CPI to Jupiter v6 swap, 40/40/20 distribution, and
    /// emits a `SalvageCompleted` event with a SalvageReceipt PDA.
    pub fn salvage_pool<'info>(
        ctx: Context<'_, '_, '_, 'info, SalvagePool<'info>>,
        params: SalvagePoolParams,
    ) -> Result<()> {
        instructions::salvage_pool::handler(ctx, params)
    }

    /// Permissionless (per LP holder). Claims the LP holder's pro-rata share
    /// from `lp_holder_pool_vault`. Live during emergency pause.
    pub fn claim_lp_proceeds(
        ctx: Context<ClaimLpProceeds>,
        params: ClaimLpProceedsParams,
    ) -> Result<()> {
        instructions::claim_lp_proceeds::handler(ctx, params)
    }
}
