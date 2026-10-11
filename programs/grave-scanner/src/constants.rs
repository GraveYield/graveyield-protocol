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

/// Hardcoded floor on `anchor_staleness_seconds`. Governance cannot
/// configure a staleness window short enough to let `sweep_stale_anchor`
/// close an anchor before the Phase 2 confirmation gap has fully elapsed.
///
/// Rationale: the sweep window and the Phase 2 gate are two hands on the
/// same clock. Phase 2 opens at `first_eligible_epoch +
/// MIN_EPOCH_CONFIRMATION`; the earliest possible sweep fires at
/// `first_eligible_epoch + ceil(window / epoch) + 1`. Sizing the floor at
/// `MIN_EPOCH_CONFIRMATION + 1` epochs guarantees Phase 2 always has at
/// least one full epoch of open window before any sweep can close the
/// anchor underneath it. A zero- or one-epoch window would otherwise let
/// a permissionless sweep destroy anchors mid-confirmation — a pure
/// liveness-griefing primitive. Enforced at both config write paths
/// (`initialize`, `update_protocol_config`) and clamped defensively at
/// the read path (`sweep_stale_anchor`), so a config written before this
/// floor existed can never trigger a premature sweep either. Raising the
/// floor requires a program upgrade, not a config update.
pub const MIN_ANCHOR_STALENESS_SECONDS: u64 =
    (MIN_EPOCH_CONFIRMATION + 1) * APPROX_EPOCH_DURATION_SECONDS;

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
/// arithmetic in `sweep_stale_anchor` and the `MIN_ANCHOR_STALENESS_SECONDS`
/// floor. The on-chain check is epoch-based (not wall-clock based) so this
/// is informational.
pub const APPROX_EPOCH_DURATION_SECONDS: u64 = 2 * 24 * 60 * 60;

#[cfg(test)]
mod tests {
    use super::*;

    /// Locks the staleness floor's relationship to the Phase 2 window:
    /// ceil(floor / epoch) must equal `MIN_EPOCH_CONFIRMATION + 1`, so the
    /// earliest possible sweep (`first_eligible_epoch + floor_epochs + 1`)
    /// always leaves Phase 2 — gated at `first_eligible_epoch +
    /// MIN_EPOCH_CONFIRMATION` — at least one full epoch of open window.
    /// A future edit that moves either constant silently breaks the
    /// certify-then-sweep ordering; this test is the tripwire.
    #[test]
    fn staleness_floor_keeps_phase2_window_open() {
        let floor_epochs = MIN_ANCHOR_STALENESS_SECONDS.div_ceil(APPROX_EPOCH_DURATION_SECONDS);
        assert_eq!(floor_epochs, MIN_EPOCH_CONFIRMATION + 1);
        // 3 epochs at the 2-day approximation = 6 days.
        assert_eq!(MIN_ANCHOR_STALENESS_SECONDS, 518_400);
    }
}
