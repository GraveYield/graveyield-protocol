// SPDX-License-Identifier: Apache-2.0
//
// GraveVault — settlement program.
//
// Consumes EligibilityCert PDAs from GraveScanner and executes the salvage:
// snapshot LP holders, CPI to AMM remove_liquidity, CPI to Jupiter v6 for
// quote-side swap, and distribute proceeds 40 / 40 / 20 to original LPs,
// salvor, and protocol respectively.
//
// Charter invariants enforced at the program level (bytecode):
//
//   * 20% protocol share is a CEILING, not a target. Cannot be raised.
//   * `lp_holder_pool_vault` is unsweepable by any admin key, ever.
//   * Emergency pause is immediate but `claim_lp_proceeds` stays live.
//   * One settlement per pool (settlement state is one-way).
//
// Charter process commitments (NOT program-enforced — process/owner-gated):
//
//   * 72h timelock on all parameter changes.
//   * Standard upgrades = 7-day notice + 72h timelock.
//   * Emergency upgrades = 24h timelock + 5-day post-mortem.
//   * No token, NFT, points, airdrop, or staking at any layer.
//
// See:
//   - docs/whitepaper.md
//   - docs/grave-scanner-grave-vault-combined.md
//   - docs/architecture/charter-invariants.md

#![allow(clippy::result_large_err)]
// The pinned Anchor line's `#[program]` macro expansion calls the deprecated
// `AccountInfo::realloc()` (replaced by `AccountInfo::resize()` in Solana SDK
// 2.x / 3.x). Until Anchor's upstream fix lands, we silence the lint at
// crate level so `cargo clippy -D warnings` stays green. The deprecation
// does not affect runtime behaviour — `realloc` is still available, just
// discouraged.
#![allow(deprecated)]
// The pinned Anchor line's `#[program]` macro and Solana's
// `solana_program_entrypoint::custom_panic_default!` macro emit
// `#[cfg(feature = "custom-panic")]`, `#[cfg(feature = "anchor-debug")]`, and
// `#[cfg(target_os = "solana")]` tags inside our crate. On Rust 1.80+ these
// trip the `unexpected_cfgs` lint because the consuming crate did not declare
// them. We silence at crate level until the upstream macros emit
// `check-cfg` directives themselves.
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
// Anchor.toml). Assigned per DR-002; deployed and accepted on-chain on
// 2026-11-12 (56/56 W2 acceptance — docs/DEVNET.md and
// docs/w2-ns3-acceptance/ carry the record, re-verified independently on
// 2026-11-15). The vault crate compiles the GraveScanner NS-3 ID in via its
// grave_scanner crate dependency (EligibilityCert seeds::program), so scanner
// and vault ELFs must always be rebuilt together from the same synchronized
// tree. The NS-2 deployment (Bd5smh…s7rg) and the NS-1 frozen static reference
// (HUyoG5…ox3v6) are preserved in docs/LEGACY_DEPLOYMENTS.md — never reuse
// their keypairs for mainnet (KEYS-003).
declare_id!("7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya");

#[program]
pub mod grave_vault {
    use super::*;

    /// Initialise the GraveVault protocol config PDA.
    ///
    /// Governance-authority-gated: config changes are restricted to the
    /// protocol governance authority. Multisig (Squads v4 3-of-5) + 72h
    /// timelock are the committed Mainnet posture — not enforced by the
    /// current programs (charter-invariant process commitments).
    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        instructions::initialize::handler(ctx, params)
    }

    /// Update GraveVault protocol config. Governance-authority-gated;
    /// multisig + 72h timelock are the committed Mainnet posture, not
    /// enforced by the current programs. Cannot raise `protocol_share_bps`
    /// above the Charter ceiling (2000 bps).
    pub fn update_protocol_config(
        ctx: Context<UpdateProtocolConfig>,
        params: UpdateProtocolConfigParams,
    ) -> Result<()> {
        instructions::update_protocol_config::handler(ctx, params)
    }

    /// Governance-authority-gated. Pauses new salvages immediately.
    /// `claim_lp_proceeds` remains live during pause — original LPs always
    /// recover their share.
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
