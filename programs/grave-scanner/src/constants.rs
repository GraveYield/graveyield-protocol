// SPDX-License-Identifier: Apache-2.0
//
// GraveScanner constants — locked thresholds and PDA seeds.
// Do not change without updating docs/architecture/eligibility-anchors.md.

// =================================================================
// Eligibility thresholds (Charter-locked at launch, governance-tunable
// within ranges enforced by `update_protocol_config`).
// =================================================================

/// Minimum trading inactivity to consider a pool derelict (Criterion 1).
/// 90 days, expressed in seconds.
pub const DEFAULT_INACTIVITY_SECONDS: u64 = 90 * 24 * 60 * 60;

/// Minimum price collapse from launch to consider a pool derelict (Criterion 2).
/// 99% in basis points (10_000 = 100%).
pub const DEFAULT_PRICE_COLLAPSE_BPS: u16 = 9_900;

/// Minimum residual TVL in lamports for a pool to remain in scope (Criterion 3).
/// 0.5 SOL.
pub const DEFAULT_MIN_TVL_LAMPORTS: u64 = 500_000_000;

/// Minimum consecutive Solana epoch confirmation between Phase 1 anchor and
/// Phase 2 cert (Criterion 6). ~4-6 days at standard epoch length.
pub const MIN_EPOCH_CONFIRMATION: u64 = 2;

/// Default LP-supply dust threshold for Criterion 4 ("LP not burned").
/// Pools whose outstanding LP supply is `<=` this value are considered
/// fully burned. 1_000 raw LP tokens is a safe floor pre-mainnet — the
/// real production value should be set per-AMM after analysing
/// incinerator-balance distributions.
///
/// PRE-MAINNET-TODO(KEYS): replace flat threshold with percent-of-original-supply or incinerator-balance check | reverts: PoolNotEligible | verify: against historical pool burn distributions
pub const DEFAULT_LP_BURN_DUST_THRESHOLD: u64 = 1_000;

/// Default staleness window for uncertified `EligibilityAnchor` PDAs.
/// 14 days in seconds. After this window any account can call
/// `sweep_stale_anchor` to reclaim rent.
pub const DEFAULT_ANCHOR_STALENESS_SECONDS: u64 = 14 * 24 * 60 * 60;

/// Default `EligibilityCert` TTL — 1 hour, expressed in seconds. Governance
/// can lower or raise this via `update_protocol_config` but never below
/// `MIN_CERT_TTL_SECONDS`.
///
/// Used as the default value when `initialize` is called with
/// `cert_ttl_seconds = 0`. Live values live in `ProtocolConfig.cert_ttl_seconds`
/// (see `state/protocol_config.rs`).
pub const DEFAULT_CERT_TTL_SECONDS: i64 = 60 * 60;

/// Hardcoded floor on `cert_ttl_seconds`. Governance cannot configure a
/// cert TTL shorter than this, even by accident — `update_protocol_config`
/// rejects any value below this with `CertTtlBelowMinimum`.
///
/// Rationale: a cert TTL below 10 minutes makes the certify-and-salvage
/// bundle helper brittle against ordinary mempool latency. Raising this
/// floor requires a program upgrade, not a config update.
pub const MIN_CERT_TTL_SECONDS: i64 = 600;

/// `EligibilityCert` TTL constant retained for backwards-compatible imports
/// (e.g., older test fixtures). Prefer `ProtocolConfig.cert_ttl_seconds`
/// at runtime; this alias mirrors `DEFAULT_CERT_TTL_SECONDS`.
#[deprecated(
    note = "Use ProtocolConfig.cert_ttl_seconds at runtime, or DEFAULT_CERT_TTL_SECONDS for defaults."
)]
pub const ELIGIBILITY_CERT_TTL_SECONDS: i64 = DEFAULT_CERT_TTL_SECONDS;

// =================================================================
// PDA seeds.
// =================================================================

pub const PROTOCOL_CONFIG_SEED: &[u8] = b"protocol_config";
pub const ELIGIBILITY_ANCHOR_SEED: &[u8] = b"eligibility_anchor";
pub const ELIGIBILITY_CERT_SEED: &[u8] = b"eligibility_cert";
pub const LAUNCH_PRICE_SEED: &[u8] = b"launch_price";

/// Approximate Solana epoch duration in seconds. Used only for the staleness
/// arithmetic in `sweep_stale_anchor`. The on-chain check is epoch-based
/// (not wall-clock based) so this is informational.
pub const APPROX_EPOCH_DURATION_SECONDS: u64 = 2 * 24 * 60 * 60;
