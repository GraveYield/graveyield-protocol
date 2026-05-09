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

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

// Localnet placeholder (deterministic SHA-256 seed; not a real keypair). Run
// `anchor keys list && anchor keys sync` after generating real keypairs to
// replace this and the matching entry in Anchor.toml.
declare_id!("7ZZ78chnUh5iipPgwR4L8fT8wKFmUM7kauRzjaYARr9m");

#[program]
pub mod grave_scanner {
    use super::*;

    /// Initialise the GraveScanner protocol config PDA.
    /// Multisig-only at launch (Squads v4 3-of-5).
    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        instructions::initialize::handler(ctx, params)
    }

    /// Record an AMM pool's launch price snapshot (Phase 0).
    /// Used by Criterion 2 (≥99% price collapse) during evaluate_pool.
    pub fn record_launch_price(
        ctx: Context<RecordLaunchPrice>,
        params: RecordLaunchPriceParams,
    ) -> Result<()> {
        instructions::record_launch_price::handler(ctx, params)
    }

    /// Phase 1 — evaluate all six derelict criteria and write an
    /// `EligibilityAnchor` PDA. Sets `first_eligible_epoch = current_epoch`.
    pub fn evaluate_pool_phase_1(
        ctx: Context<EvaluatePoolPhase1>,
        params: EvaluatePoolPhase1Params,
    ) -> Result<()> {
        instructions::evaluate_pool_phase1::handler(ctx, params)
    }

    /// Phase 2 — re-verify all six criteria after the multi-epoch confirmation
    /// gap (≥2 consecutive Solana epochs, ~4-6 days). On success, writes an
    /// `EligibilityCert` PDA with TTL = 1h. GraveVault consumes the cert to
    /// authorise `salvage_pool`.
    pub fn evaluate_pool_phase_2(
        ctx: Context<EvaluatePoolPhase2>,
        params: EvaluatePoolPhase2Params,
    ) -> Result<()> {
        instructions::evaluate_pool_phase2::handler(ctx, params)
    }

    /// Multisig-only, immediate. Invalidates an `EligibilityAnchor` before its
    /// Phase 2 certification. Conveys no salvage authority.
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

    /// Multisig-only, 72h timelock at the GraveScanner level. Updates
    /// thresholds, anchor_staleness_seconds, and authority keys.
    pub fn update_protocol_config(
        ctx: Context<UpdateProtocolConfig>,
        params: UpdateProtocolConfigParams,
    ) -> Result<()> {
        instructions::update_protocol_config::handler(ctx, params)
    }
}
