// SPDX-License-Identifier: Apache-2.0

use anchor_lang::prelude::*;

#[error_code]
pub enum GraveVaultError {
    /// Caller lacks the multisig authority required for this instruction.
    #[msg("Unauthorized: caller is not the protocol multisig.")]
    Unauthorized = 7000,

    /// EligibilityCert PDA missing, expired, or owned by the wrong program.
    #[msg("Invalid or expired EligibilityCert.")]
    InvalidEligibilityCert = 7001,

    /// EligibilityCert TTL has passed. Re-run Phase 2 to mint a fresh cert.
    #[msg("EligibilityCert is expired.")]
    EligibilityCertExpired = 7002,

    /// Protocol is paused — only `claim_lp_proceeds` is callable.
    #[msg("Protocol is paused. salvage_pool is unavailable.")]
    ProtocolPaused = 7003,

    /// Distribution shares (LP / salvor / protocol) did not sum to 10_000 bps.
    #[msg("Share basis-point sum is not exactly 10_000.")]
    InvalidShareSplit = 7004,

    /// Attempted to raise `protocol_share_bps` above the Charter ceiling.
    #[msg("Protocol share exceeds Charter ceiling (PROTOCOL_SHARE_BPS_CEILING).")]
    ProtocolShareExceedsCeiling = 7005,

    /// Attempted to sweep, close, or otherwise drain `lp_holder_pool_vault`.
    /// This account is unsweepable by any admin key, ever (Charter invariant).
    #[msg("Charter violation: lp_holder_pool_vault is unsweepable.")]
    LpHolderPoolUnsweepable = 7006,

    /// Slippage on the Jupiter swap leg exceeded the configured maximum.
    #[msg("Slippage exceeded configured maximum.")]
    SlippageExceeded = 7007,

    /// Transaction priority fee exceeds the Charter ceiling.
    #[msg("Priority fee exceeds Charter ceiling.")]
    PriorityFeeExceedsCeiling = 7008,

    /// Arithmetic overflow during distribution math.
    #[msg("Arithmetic overflow during distribution.")]
    MathOverflow = 7009,

    /// LP holder is not in the snapshot Merkle tree, or proof is invalid.
    #[msg("Claim proof failed verification against the snapshot Merkle root.")]
    InvalidClaimProof = 7010,

    /// Claim has already been processed for this (pool, lp_holder) pair.
    #[msg("Claim record already exists; proceeds were already withdrawn.")]
    ClaimAlreadyProcessed = 7011,

    /// Quote output below the Jupiter dust threshold; salvage skipped or aborted.
    #[msg("Output below Jupiter dust threshold.")]
    BelowDustThreshold = 7012,

    /// Pre-flight check against the on-chain pool failed.
    #[msg("Pre-flight check against pool state failed.")]
    PreflightFailed = 7013,

    /// Timelock window has not yet elapsed for a queued parameter change.
    #[msg("Timelock window has not elapsed.")]
    TimelockNotElapsed = 7014,

    // ----- m5 additions (CPI execution path) -----

    /// AMM remove_liquidity CPI returned an error or zero output.
    #[msg("AMM redemption CPI failed.")]
    AmmRedemptionFailed = 7015,

    /// Jupiter v6 swap CPI returned an error or zero output.
    #[msg("Jupiter v6 swap CPI failed.")]
    JupiterSwapFailed = 7016,

    /// AMM CPI adapter is registered but not implemented (CLMM / Orca / PumpSwap
    /// pre-mainnet stubs). Pool owner does not match the Raydium V4 program.
    /// See docs/PRE_MAINNET_CHECKLIST.md for the live list.
    #[msg("AmmCpiUnimplemented: AMM CPI adapter is a pre-mainnet stub.")]
    AmmCpiUnimplemented = 7017,

    /// Snapshot `lp_total_supply_at_snapshot` does not match the on-chain
    /// LP mint supply at salvage time. The salvor's snapshot is stale or
    /// the LP supply moved between snapshot and submission.
    #[msg("Snapshot mismatch with on-chain LP token state.")]
    InvalidSnapshotData = 7018,

    /// Pool base token is not WSOL. USDC/USDT base support is a v1.1
    /// deliverable that requires a token-account variant of
    /// `lp_holder_pool_vault` and protocol_treasury.
    #[msg("Unsupported base token: pool base must be WSOL (v1.0).")]
    UnsupportedBaseToken = 7019,
}
