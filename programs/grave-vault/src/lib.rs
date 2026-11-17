// SPDX-License-Identifier: Apache-2.0
//
// GraveVault — settlement program.
//
// Consumes EligibilityCert PDAs from GraveScanner and executes the salvage:
// snapshot LP holders, CPI to AMM remove_liquidity, CPI to Jupiter v6 for
// quote-side swap, and distribute proceeds 40 / 40 / 20 to original LPs,
// salvor, and protocol respectively.
//
// Charter — split into bytecode-enforced invariants (verified against this
// implementation) and process commitments (governance policy, NOT enforced
// by current bytecode; a future program upgrade could change the enforced
// list). Enforced now: 20% protocol-share ceiling; only `claim_lp_proceeds`
// debits `lp_holder_pool_vault`; pause blocks salvage while claims stay
// live; one settlement per pool (init-once PoolRegistry + SalvageReceipt).
// Process commitments: 72h parameter-change timelock; standard upgrades =
// 7-day notice + 72h timelock; emergency upgrades = 24h timelock + 5-day
// postmortem; no token/NFT/points/airdrop/staking at any layer.
//
// See:
//   - docs/whitepaper.md
//   - docs/grave-scanner-grave-vault-combined.md
//   - docs/architecture/charter-invariants.md

#![allow(clippy::result_large_err)]
// Historical attribution (recorded under the 0.32.x line): Anchor 0.32.1's
// `#[program]` macro expansion called the deprecated `AccountInfo::realloc()`
// (replaced by `AccountInfo::resize()` in Solana SDK 2.x / 3.x). Under the
// current anchor-lang 1.2.2 toolchain this crate compiles warning-free without
// the allow (verified by host `cargo check`), so the `#![allow(deprecated)]`
// below is a retained no-op — kept unchanged in this comments-only pass.
#![allow(deprecated)]
// The `#[program]` macro (first recorded under Anchor 0.32.x; verified still
// true under anchor-lang 1.2.2) emits `#[cfg(feature = "custom-panic")]`,
// `#[cfg(feature = "anchor-debug")]`, `#[cfg(feature = "custom-heap")]`, and
// `#[cfg(target_os = "solana")]` tags inside our crate. On Rust 1.80+ these
// trip the `unexpected_cfgs` lint because the consuming crate did not declare
// them. Still required: removing the allow makes the warnings fire (verified
// by host `cargo check`), so it is silenced at crate level.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod cpi;
pub mod errors;
pub mod instructions;
pub mod merkle;
pub mod state;

use instructions::*;

// NS-3 devnet program ID (owner-generated, owner-held keypair; mirrored in
// Anchor.toml). Assigned per DR-002; deployed to Devnet and accepted on
// 2026-11-12 (56/56 W2 acceptance; independently re-verified 2026-11-15) —
// see docs/DEVNET.md and docs/w2-ns3-acceptance/. The vault
// crate compiles the GraveScanner NS-3 ID in via its grave_scanner crate
// dependency (EligibilityCert seeds::program), so scanner and vault ELFs
// must always be rebuilt together from the same synchronized tree. The NS-2
// deployment (Bd5smh…s7rg) and the NS-1 frozen static reference (HUyoG5…ox3v6)
// are preserved in docs/LEGACY_DEPLOYMENTS.md — never reuse their keypairs
// for mainnet (KEYS-003).
declare_id!("7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya");

#[program]
pub mod grave_vault {
    use super::*;

    /// Initialise the GraveVault protocol config PDA; permissionless one-time init.
    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        instructions::initialize::handler(ctx, params)
    }

    /// Update GraveVault protocol config (authority-gated; no on-chain timelock).
    /// Cannot raise `protocol_share_bps` above the Charter ceiling (2000 bps).
    pub fn update_protocol_config(
        ctx: Context<UpdateProtocolConfig>,
        params: UpdateProtocolConfigParams,
    ) -> Result<()> {
        instructions::update_protocol_config::handler(ctx, params)
    }

    /// Governance-authority-gated. Pauses new salvages immediately.
    /// `claim_lp_proceeds` stays live — LPs always recover their share.
    pub fn emergency_pause(ctx: Context<EmergencyPause>, paused: bool) -> Result<()> {
        instructions::emergency_pause::handler(ctx, paused)
    }

    /// Permissionless. Executes a salvage: pre-flight, LP snapshot, CPI to AMM
    /// remove_liquidity, CPI to Jupiter v6 swap, 40/40/20 distribution, and
    /// emits a `SalvageCompleted` event with a SalvageReceipt PDA.
    pub fn salvage_pool<'info>(
        ctx: Context<'info, SalvagePool<'info>>,
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

    /// Permissionless (Phase 4, D6 dust policy). Recovers the memecoin
    /// retained in the vault memecoin ATA after a salvage (below-threshold
    /// dust or route residual — see `SalvageReceipt.dust_memecoin_lamports`)
    /// to the protocol treasury's ATA for the same mint, closes the vault
    /// ATA (rent reclaimed by the caller), and stamps the receipt. The
    /// destination is pinned by ATA derivation and cannot be redirected.
    pub fn sweep_dust(ctx: Context<SweepDust>, params: SweepDustParams) -> Result<()> {
        instructions::sweep_dust::handler(ctx, params)
    }
}
