// SPDX-License-Identifier: Apache-2.0
//
// GraveScanner — on-chain eligibility evaluation and two-phase certification
// for derelict pools.
//
// GraveScanner does NOT execute salvages. Its sole responsibility is producing
// authoritative `EligibilityAnchor` and `EligibilityCert` PDAs that GraveVault
// consumes to authorise a `salvage_pool` call.
//
// See:
//   - docs/whitepaper.md
//   - docs/grave-scanner-grave-vault-combined.md
//   - docs/architecture/eligibility-anchors.md

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

pub mod adapters;
pub mod attestation;
pub mod constants;
pub mod criteria;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

// NS-3 devnet program ID (owner-generated, owner-held keypair; mirrored in
// Anchor.toml). Assigned per DR-002; deployed to Devnet and accepted on
// 2026-11-12 (56/56 W2 acceptance; independently re-verified 2026-11-15) —
// see docs/DEVNET.md and docs/w2-ns3-acceptance/. The earlier NS-2
// deployment (CuQZes…Ao54) and the NS-1 frozen static reference (5JiCV…zvNF)
// are preserved in docs/LEGACY_DEPLOYMENTS.md — never reuse their keypairs
// for mainnet (KEYS-003).
declare_id!("EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL");

#[program]
pub mod grave_scanner {
    use super::*;

    /// Initialise the GraveScanner protocol config PDA. Permissionless one-time
    /// PDA creation; the first successful caller supplies the authority pubkey.
    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        instructions::initialize::handler(ctx, params)
    }

    /// Record an AMM pool's launch price snapshot (Phase 0). Used by
    /// Criterion 2 (≥99% price collapse) during evaluate_pool. The price
    /// is accepted ONLY as a 168-byte oracle-signed Ed25519 attestation
    /// (ORACLE-001, Phase 1.3 / spec D9) verified via the ed25519
    /// precompile — caller-supplied baselines revert. Init-once per pool.
    pub fn record_launch_price(
        ctx: Context<RecordLaunchPrice>,
        params: RecordLaunchPriceParams,
    ) -> Result<()> {
        instructions::record_launch_price::handler(ctx, params)
    }

    /// Phase 1 — evaluate all six derelict criteria and write an
    /// `EligibilityAnchor` PDA. Sets `first_eligible_epoch = current_epoch`.
    /// C1 inactivity evidence is an indexer-signed Ed25519 attestation
    /// (ORACLE-002, spec §5 / D8) — caller-supplied timestamps revert.
    pub fn evaluate_pool_phase_1(
        ctx: Context<EvaluatePoolPhase1>,
        params: EvaluatePoolPhase1Params,
    ) -> Result<()> {
        instructions::evaluate_pool_phase1::handler(ctx, params)
    }

    /// Phase 2 — re-verify all six criteria after the multi-epoch confirmation
    /// gap (≥2 consecutive Solana epochs, ~4-6 days). On success, writes an
    /// `EligibilityCert` PDA with TTL = 1h. GraveVault consumes the cert to
    /// authorise `salvage_pool`. Requires a fresh indexer-signed C1
    /// attestation — the Phase 1 attestation is long stale by design.
    pub fn evaluate_pool_phase_2(
        ctx: Context<EvaluatePoolPhase2>,
        params: EvaluatePoolPhase2Params,
    ) -> Result<()> {
        instructions::evaluate_pool_phase2::handler(ctx, params)
    }

    /// Governance-authority-gated (`has_one = authority` signer check),
    /// immediate. Invalidates an anchor pre-cert; no salvage authority.
    pub fn invalidate_anchor(
        ctx: Context<InvalidateAnchor>,
        params: InvalidateAnchorParams,
    ) -> Result<()> {
        instructions::invalidate_anchor::handler(ctx, params)
    }

    /// Permissionless. Closes uncertified `EligibilityAnchor` PDAs once
    /// `current_epoch > anchor.first_eligible_epoch + ceil(anchor_staleness_seconds / epoch_duration)`.
    /// Rent returns to the original anchor writer; conveys no salvage authority.
    /// See v4.0.1 spec patch.
    pub fn sweep_stale_anchor(ctx: Context<SweepStaleAnchor>) -> Result<()> {
        instructions::sweep_stale_anchor::handler(ctx)
    }

    /// Governance-authority-gated, immediate — no on-chain timelock; the
    /// 72h Squads buffer is a process commitment. Updates thresholds/staleness.
    pub fn update_protocol_config(
        ctx: Context<UpdateProtocolConfig>,
        params: UpdateProtocolConfigParams,
    ) -> Result<()> {
        instructions::update_protocol_config::handler(ctx, params)
    }

    /// Governance-authority-gated, immediate. Toggles `paused` in
    /// ProtocolConfig. When `true`, both `evaluate_pool_phase_1` and
    /// `evaluate_pool_phase_2` revert with `ProtocolPaused`. The other
    /// instructions remain callable so the configured authority can recover
    /// the protocol from a paused state. Mirrors GraveVault's `emergency_pause`.
    pub fn emergency_pause(ctx: Context<EmergencyPause>, paused: bool) -> Result<()> {
        instructions::emergency_pause::handler(ctx, paused)
    }
}
