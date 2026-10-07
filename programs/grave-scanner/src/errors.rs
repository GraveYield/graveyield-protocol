// SPDX-License-Identifier: Apache-2.0
//
// GraveScanner error codes. The on-chain code numbers are stable and
// MUST match the spec (Whitepaper v4.0.1 §3, Combined Tech Doc v3.0.1 §3.5).
//
// Anchor's `#[error_code]` macro adds a default offset of 6000 to each
// variant's Rust discriminant. To produce the canonical spec codes
// 6000..=6019, the discriminants below are 0..=19 (with the 12..=14 gap
// preserved for future v4.x additions).
//
// Do not renumber existing variants. New variants append at the next
// free discriminant.

use anchor_lang::prelude::*;

#[error_code]
pub enum GraveScannerError {
    /// On-chain code 6000. Caller lacks the multisig authority required.
    #[msg("Unauthorized: caller is not the protocol multisig.")]
    Unauthorized = 0,

    /// On-chain code 6001. Derelict-pool criteria check failed.
    #[msg("Pool does not satisfy all six derelict-pool criteria.")]
    PoolNotEligible = 1,

    /// On-chain code 6002. LaunchPrice PDA missing for this pool.
    #[msg("Launch price record not found for this pool.")]
    LaunchPriceNotFound = 2,

    /// On-chain code 6003. AMM program mismatch / unsupported pool layout.
    #[msg("AMM program mismatch or unsupported pool layout.")]
    UnsupportedAmm = 3,

    /// On-chain code 6004. Arithmetic overflow during eligibility math.
    #[msg("Arithmetic overflow during eligibility computation.")]
    MathOverflow = 4,

    /// On-chain code 6005. Clock sysvar unavailable.
    #[msg("Clock sysvar unavailable or returned invalid data.")]
    InvalidClock = 5,

    /// On-chain code 6006. ProtocolConfig update violates a locked invariant.
    #[msg("Protocol config update violates a locked invariant.")]
    InvariantViolation = 6,

    /// On-chain code 6007. AMM adapter registered but parser not implemented.
    /// Canonical revert for the honest-stub adapter pattern; see
    /// `docs/PRE_MAINNET_CHECKLIST.md` for the live list.
    #[msg("AmmAdapterUnimplemented: AMM adapter parser is a pre-mainnet stub.")]
    AmmAdapterUnimplemented = 7,

    /// On-chain code 6008. Locker adapter registered but not implemented.
    /// Retired as a live call site by the Phase 1.1 UNCX Raydium V4
    /// adapter (LOCKER-001); retained as a stable code-space slot for
    /// future locker-family additions that ship without a parser.
    #[msg("LockerAdapterUnimplemented: locker adapter is a pre-mainnet stub.")]
    LockerAdapterUnimplemented = 8,

    /// On-chain code 6009. Pool account data did not match the expected
    /// layout (corrupt, wrong length, or degenerate fields).
    #[msg("PoolDataParseError: pool account data did not match the expected layout.")]
    PoolDataParseError = 9,

    /// On-chain code 6010. GraveScanner is paused — `evaluate_pool_*`
    /// reverts. Has no effect on rent reclaim or GraveVault claim path.
    #[msg("ProtocolPaused: GraveScanner is paused; evaluate_pool is disabled.")]
    ProtocolPaused = 10,

    /// On-chain code 6011. Phase 2 produced a bitmap that disagrees with
    /// the originating EligibilityAnchor — refuse to promote a downgrade.
    #[msg("CriteriaBitmapMismatch: Phase 2 bitmap does not match anchor's bitmap.")]
    CriteriaBitmapMismatch = 11,

    // ----- v4.0 anchor / cert error codes (6015..=6018) -----
    //
    // Discriminants 12..=14 are reserved for future v4.x additions to the
    // pre-anchor error space (e.g., new pool-data parse failure modes).
    /// On-chain code 6015. Phase 2 attempted without an EligibilityAnchor.
    #[msg("EligibilityAnchor PDA not found.")]
    AnchorNotFound = 15,

    /// On-chain code 6016. Phase 2 attempted inside the confirmation gap.
    #[msg("EpochConfirmationPending: anchor first_eligible_epoch + MIN_EPOCH_CONFIRMATION not yet reached.")]
    EpochConfirmationPending = 16,

    /// On-chain code 6017. EligibilityAnchor was invalidated by multisig.
    #[msg("AnchorInvalidated: this anchor was invalidated by multisig.")]
    AnchorInvalidated = 17,

    /// On-chain code 6018. `sweep_stale_anchor` called before the
    /// staleness window elapsed.
    #[msg("AnchorNotStale: staleness window has not yet elapsed.")]
    AnchorNotStale = 18,

    /// On-chain code 6019. `update_protocol_config` rejected a
    /// `cert_ttl_seconds` value below the hardcoded `MIN_CERT_TTL_SECONDS`
    /// floor (600s = 10 min). Raising the floor requires a program upgrade.
    #[msg("CertTtlBelowMinimum: cert_ttl_seconds below MIN_CERT_TTL_SECONDS floor.")]
    CertTtlBelowMinimum = 19,

    // ----- v4.1 locker-adapter error codes (6020..=6023) -----
    // LOCKER-001 (Phase 1.1, UNCX Raydium V4 locker adapter).
    /// On-chain code 6020. The UNCX per-pool lock marker PDA
    /// `["global_lp_tracker", amm_id]` was not supplied in
    /// `remaining_accounts`. The SDK must derive and attach it — without
    /// it there is no sound way to evaluate Criterion 5.
    #[msg("LockerMarkerAccountRequired: UNCX lock marker PDA missing from remaining_accounts.")]
    LockerMarkerAccountRequired = 20,

    /// On-chain code 6021. The marker exists on chain (the pool was
    /// locked at least once) but no TokenLock evidence was supplied.
    /// Completeness of the supplied evidence is mandatory in this case.
    #[msg("LockerLockEvidenceRequired: UNCX marker exists but no TokenLock evidence supplied.")]
    LockerLockEvidenceRequired = 21,

    /// On-chain code 6022. A supplied locker-program account failed
    /// validation: ownership, discriminator, size, or PDA re-derivation
    /// from its own `lock_global_id`.
    #[msg("InvalidLockerAccount: locker account failed validation (disc/size/PDA/ownership).")]
    InvalidLockerAccount = 22,

    /// On-chain code 6023. A supplied TokenLock is bound to a different
    /// `(amm_id, lp_mint)` pair than the pool under evaluation.
    #[msg("LockerAccountMismatch: TokenLock bound to a different pool or LP mint.")]
    LockerAccountMismatch = 23,

    // ----- v4.2 last-swap attestation error codes (6024..=6031) -----
    // ORACLE-002 (Phase 1.2, indexer-signed inactivity evidence).
    /// On-chain code 6024. No `ed25519_program` verify instruction was
    /// found immediately before the scanner instruction, so no oracle
    /// signature was evaluated in this transaction.
    #[msg("AttestationMissing: no ed25519 verify instruction precedes this instruction.")]
    AttestationMissing = 24,

    /// On-chain code 6025. The precompile's Ed25519SignatureOffsets are
    /// malformed or do not bind the signature to exactly the 112-byte
    /// attestation embedded in this instruction's data (wrong count,
    /// out-of-bounds, wrong instruction index, or non-canonical message
    /// offset).
    #[msg("InvalidAttestationOffsets: ed25519 offsets do not bind the signature to the embedded attestation.")]
    InvalidAttestationOffsets = 25,

    /// On-chain code 6026. The public key covered by the runtime-verified
    /// signature is not the configured `activity_oracle`.
    #[msg(
        "AttestationOracleMismatch: signature public key is not the configured activity oracle."
    )]
    AttestationOracleMismatch = 26,

    /// On-chain code 6027. The attestation message binds a different
    /// `(amm_program_id, pool_address)` pair than the instruction params.
    #[msg("AttestationBindingMismatch: attestation bound to a different AMM program or pool.")]
    AttestationBindingMismatch = 27,

    /// On-chain code 6028. The attested last-swap timestamp is the zero
    /// sentinel or lies in the future relative to the current Clock.
    #[msg("AttestationTimestampInvalid: attested timestamp is zero or in the future.")]
    AttestationTimestampInvalid = 28,

    /// On-chain code 6029. The attestation's `issued_slot` no longer
    /// resolves in the SlotHashes sysvar — the attestation is stale
    /// (replayed outside the ~512-slot freshness window).
    #[msg("AttestationStale: issued_slot aged out of the SlotHashes window.")]
    AttestationStale = 29,

    /// On-chain code 6030. The `issued_slot` resolves in SlotHashes but
    /// the attested hash does not match the chain's hash for that slot.
    #[msg("AttestationSlotHashMismatch: attested slot hash does not match SlotHashes.")]
    AttestationSlotHashMismatch = 30,

    /// On-chain code 6031. The attestation's `issued_slot` is zero or in
    /// the future relative to the current slot.
    #[msg("AttestationSlotInvalid: attestation issued_slot is zero or in the future.")]
    AttestationSlotInvalid = 31,

    // ----- v4.3 launch-price attestation error codes (6032..=6033) -----
    // ORACLE-001 (Phase 1.3, oracle-signed launch-price baseline).
    /// On-chain code 6032. The attested launch price is zero — a price
    /// collapse baseline must be strictly positive (C2's drop math is
    /// undefined for a zero baseline).
    #[msg("InvalidLaunchPrice: attested launch price is zero.")]
    InvalidLaunchPrice = 32,

    /// On-chain code 6033. The recorded launch-price baseline belongs to
    /// a different token pair than the live pool under evaluation — the
    /// recorded (base_mint, quote_mint) must equal the pool's parsed
    /// mints before C2 can consume the price.
    #[msg("LaunchPriceMintMismatch: launch price recorded for a different token pair.")]
    LaunchPriceMintMismatch = 33,

    // ----- v4.4 cert lifecycle error codes (6034) -----
    // CERT-001 (Phase 1.4, expiry-gated cert reissuance / spec D10).
    /// On-chain code 6034. Phase 2 was re-run while the existing
    /// EligibilityCert for this pool is still live (before its
    /// `expires_at`). Overwriting a live cert is forbidden — wait for
    /// the TTL to elapse, then re-run Phase 2 to reissue. This gate is
    /// what makes two live certs for one pool structurally impossible.
    #[msg("CertStillValid: eligibility cert is still live; reissue only after expiry.")]
    CertStillValid = 34,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Locks down the on-chain error code numbering against accidental drift.
    ///
    /// Anchor's `#[error_code]` macro adds the default 6000 offset to every
    /// Rust discriminant. We rely on the discriminants below being 0..=34
    /// (with the 12..=14 gap) so the on-chain codes match the documented
    /// range in `docs/error_codes.md`. A future contributor who
    /// switches to explicit `= 6000`-style discriminants would unknowingly
    /// shift every code by +6000.
    #[test]
    fn on_chain_codes_match_docs() {
        let cases: &[(GraveScannerError, u32)] = &[
            (GraveScannerError::Unauthorized, 6000),
            (GraveScannerError::PoolNotEligible, 6001),
            (GraveScannerError::LaunchPriceNotFound, 6002),
            (GraveScannerError::UnsupportedAmm, 6003),
            (GraveScannerError::MathOverflow, 6004),
            (GraveScannerError::InvalidClock, 6005),
            (GraveScannerError::InvariantViolation, 6006),
            (GraveScannerError::AmmAdapterUnimplemented, 6007),
            (GraveScannerError::LockerAdapterUnimplemented, 6008),
            (GraveScannerError::PoolDataParseError, 6009),
            (GraveScannerError::ProtocolPaused, 6010),
            (GraveScannerError::CriteriaBitmapMismatch, 6011),
            (GraveScannerError::AnchorNotFound, 6015),
            (GraveScannerError::EpochConfirmationPending, 6016),
            (GraveScannerError::AnchorInvalidated, 6017),
            (GraveScannerError::AnchorNotStale, 6018),
            (GraveScannerError::CertTtlBelowMinimum, 6019),
            (GraveScannerError::LockerMarkerAccountRequired, 6020),
            (GraveScannerError::LockerLockEvidenceRequired, 6021),
            (GraveScannerError::InvalidLockerAccount, 6022),
            (GraveScannerError::LockerAccountMismatch, 6023),
            (GraveScannerError::AttestationMissing, 6024),
            (GraveScannerError::InvalidAttestationOffsets, 6025),
            (GraveScannerError::AttestationOracleMismatch, 6026),
            (GraveScannerError::AttestationBindingMismatch, 6027),
            (GraveScannerError::AttestationTimestampInvalid, 6028),
            (GraveScannerError::AttestationStale, 6029),
            (GraveScannerError::AttestationSlotHashMismatch, 6030),
            (GraveScannerError::AttestationSlotInvalid, 6031),
            (GraveScannerError::InvalidLaunchPrice, 6032),
            (GraveScannerError::LaunchPriceMintMismatch, 6033),
            (GraveScannerError::CertStillValid, 6034),
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
