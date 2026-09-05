// SPDX-License-Identifier: Apache-2.0
//
// GraveVault error codes. The on-chain code numbers are stable and MUST match
// the spec (docs/error_codes.md, Combined Tech Doc v3.0.1 §3.5).
//
// Anchor's `#[error_code]` macro emits `From<MyError> for u32` as
// `(self as u32) + OFFSET`, where OFFSET defaults to 6000. We override OFFSET
// to 7000 so the discriminants below stay at 0..=14 and the on-chain codes
// land at the canonical 7000..=7014 range documented in `docs/error_codes.md`.
//
// Without the `offset = 7000` override, the explicit discriminants (7000..)
// would compound with the 6000 default offset and emit codes 13000..=13014
// instead — silently breaking every downstream consumer (indexer parsers,
// SDK error matchers, IDL clients).
//
// Do not renumber existing variants. New variants append at the next free
// discriminant.

use anchor_lang::prelude::*;

#[error_code(offset = 7000)]
pub enum GraveVaultError {
    /// On-chain code 7000. Caller lacks the multisig authority required.
    #[msg("Unauthorized: caller is not the protocol multisig.")]
    Unauthorized = 0,

    /// On-chain code 7001. EligibilityCert PDA missing or owned by the wrong program.
    #[msg("Invalid or expired EligibilityCert.")]
    InvalidEligibilityCert = 1,

    /// On-chain code 7002. EligibilityCert TTL has passed. Re-run Phase 2.
    #[msg("EligibilityCert is expired.")]
    EligibilityCertExpired = 2,

    /// On-chain code 7003. Protocol is paused — only `claim_lp_proceeds` is callable.
    #[msg("Protocol is paused. salvage_pool is unavailable.")]
    ProtocolPaused = 3,

    /// On-chain code 7004. Distribution shares did not sum to 10_000 bps.
    #[msg("Share basis-point sum is not exactly 10_000.")]
    InvalidShareSplit = 4,

    /// On-chain code 7005. `protocol_share_bps` exceeds the Charter ceiling.
    #[msg("Protocol share exceeds Charter ceiling (PROTOCOL_SHARE_BPS_CEILING).")]
    ProtocolShareExceedsCeiling = 5,

    /// On-chain code 7006. Charter invariant: `lp_holder_pool_vault` is unsweepable.
    #[msg("Charter violation: lp_holder_pool_vault is unsweepable.")]
    LpHolderPoolUnsweepable = 6,

    /// On-chain code 7007. Slippage on the Jupiter swap leg exceeded the maximum.
    #[msg("Slippage exceeded configured maximum.")]
    SlippageExceeded = 7,

    /// On-chain code 7008. Transaction priority fee exceeds the Charter ceiling.
    #[msg("Priority fee exceeds Charter ceiling.")]
    PriorityFeeExceedsCeiling = 8,

    /// On-chain code 7009. Arithmetic overflow during distribution math.
    #[msg("Arithmetic overflow during distribution.")]
    MathOverflow = 9,

    /// On-chain code 7010. Claim proof failed verification against snapshot root.
    #[msg("Claim proof failed verification against the snapshot Merkle root.")]
    InvalidClaimProof = 10,

    /// On-chain code 7011. Claim record already exists for this (pool, lp_holder).
    #[msg("Claim record already exists; proceeds were already withdrawn.")]
    ClaimAlreadyProcessed = 11,

    /// On-chain code 7012. Quote output below the Jupiter dust threshold.
    #[msg("Output below Jupiter dust threshold.")]
    BelowDustThreshold = 12,

    /// On-chain code 7013. Pre-flight check against the on-chain pool failed.
    #[msg("Pre-flight check against pool state failed.")]
    PreflightFailed = 13,

    /// On-chain code 7014. Timelock window has not yet elapsed.
    #[msg("Timelock window has not elapsed.")]
    TimelockNotElapsed = 14,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Locks down the on-chain error code numbering against accidental drift.
    ///
    /// `docs/error_codes.md` documents 7000..=7014 as the canonical GraveVault
    /// range. Without `#[error_code(offset = 7000)]`, Anchor would add the
    /// default 6000 offset on top of any explicit discriminant — silently
    /// shifting every code by +6000 and breaking downstream consumers.
    #[test]
    fn on_chain_codes_match_docs() {
        let cases: &[(GraveVaultError, u32)] = &[
            (GraveVaultError::Unauthorized, 7000),
            (GraveVaultError::InvalidEligibilityCert, 7001),
            (GraveVaultError::EligibilityCertExpired, 7002),
            (GraveVaultError::ProtocolPaused, 7003),
            (GraveVaultError::InvalidShareSplit, 7004),
            (GraveVaultError::ProtocolShareExceedsCeiling, 7005),
            (GraveVaultError::LpHolderPoolUnsweepable, 7006),
            (GraveVaultError::SlippageExceeded, 7007),
            (GraveVaultError::PriorityFeeExceedsCeiling, 7008),
            (GraveVaultError::MathOverflow, 7009),
            (GraveVaultError::InvalidClaimProof, 7010),
            (GraveVaultError::ClaimAlreadyProcessed, 7011),
            (GraveVaultError::BelowDustThreshold, 7012),
            (GraveVaultError::PreflightFailed, 7013),
            (GraveVaultError::TimelockNotElapsed, 7014),
        ];
        for (variant, expected) in cases {
            let actual: u32 = u32::from(*variant);
            assert_eq!(
                actual,
                *expected,
                "{} expected on-chain code {}, got {}",
                variant.name(),
                expected,
                actual,
            );
        }
    }
}
