// SPDX-License-Identifier: Apache-2.0
//
// update_protocol_config — multisig-only, 72h-timelocked at the GraveVault
// Charter level. Updates GraveScanner thresholds and the staleness window.

use anchor_lang::prelude::*;

use crate::constants::{MIN_ANCHOR_STALENESS_SECONDS, MIN_CERT_TTL_SECONDS};
use crate::errors::GraveScannerError;
use crate::state::ProtocolConfig;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateProtocolConfigParams {
    pub inactivity_seconds: Option<u64>,
    pub price_collapse_bps: Option<u16>,
    pub min_tvl_lamports: Option<u64>,
    pub anchor_staleness_seconds: Option<u64>,
    /// LP-supply dust threshold for Criterion 4 ("LP not burned"). Pools
    /// with `lp_supply <= lp_burn_dust_threshold` are treated as burned.
    /// Governance-tunable to match dust outcomes seen on mainnet.
    pub lp_burn_dust_threshold: Option<u64>,
    /// EligibilityCert TTL in seconds. Floor: `MIN_CERT_TTL_SECONDS` (600).
    /// Any value below the floor reverts with `CertTtlBelowMinimum`.
    pub cert_ttl_seconds: Option<i64>,
    /// Rotate the Criterion 1 activity oracle (public key whose Ed25519
    /// signatures authorize last-swap attestations). Multisig-only.
    pub activity_oracle: Option<Pubkey>,
    /// Rotate the Criterion 2 launch-price oracle (public key whose
    /// Ed25519 signatures authorize launch-price attestations, spec D9).
    /// Multisig-only. Rotation does NOT affect already-recorded
    /// LaunchPrice PDAs (init-once).
    pub launch_price_oracle: Option<Pubkey>,
}

#[derive(Accounts)]
pub struct UpdateProtocolConfig<'info> {
    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump = protocol_config.bump,
        has_one = authority @ GraveScannerError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateProtocolConfig>,
    params: UpdateProtocolConfigParams,
) -> Result<()> {
    apply_config_update(&mut ctx.accounts.protocol_config, &params)
}

/// The handler's validation + assignment logic, extracted verbatim so the
/// config bounds are testable at the handler level without an Anchor
/// account context (P5-03 remediation layer 1 — the register explicitly
/// distinguishes these host tests from the Anchor instruction/context-level
/// coverage, which the fork harness drives against the real BPF). Pure code
/// motion: the instruction path is byte-for-byte the same logic, and the
/// instruction-level behavior stays pinned by the fork suites.
pub(crate) fn apply_config_update(
    cfg: &mut ProtocolConfig,
    params: &UpdateProtocolConfigParams,
) -> Result<()> {
    if let Some(v) = params.inactivity_seconds {
        cfg.inactivity_seconds = v;
    }
    if let Some(v) = params.price_collapse_bps {
        require!(v <= 10_000, GraveScannerError::InvariantViolation);
        cfg.price_collapse_bps = v;
    }
    if let Some(v) = params.min_tvl_lamports {
        cfg.min_tvl_lamports = v;
    }
    if let Some(v) = params.anchor_staleness_seconds {
        // Hardcoded floor: governance cannot shrink the sweep window below
        // MIN_ANCHOR_STALENESS_SECONDS (3 epochs / 6 days). A window that
        // short would let the permissionless `sweep_stale_anchor` close
        // anchors before the Phase 2 confirmation gap can elapse. Raising
        // the floor requires a program upgrade, not a config update.
        require!(
            v >= MIN_ANCHOR_STALENESS_SECONDS,
            GraveScannerError::InvariantViolation
        );
        cfg.anchor_staleness_seconds = v;
    }
    if let Some(v) = params.lp_burn_dust_threshold {
        cfg.lp_burn_dust_threshold = v;
    }
    if let Some(v) = params.cert_ttl_seconds {
        // Hardcoded floor: governance cannot push cert_ttl below 600s.
        // Raising the floor requires a program upgrade.
        require!(
            v >= MIN_CERT_TTL_SECONDS,
            GraveScannerError::CertTtlBelowMinimum
        );
        cfg.cert_ttl_seconds = v;
    }
    if let Some(v) = params.activity_oracle {
        cfg.activity_oracle = v;
    }
    if let Some(v) = params.launch_price_oracle {
        cfg.launch_price_oracle = v;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{DEFAULT_ANCHOR_STALENESS_SECONDS, DEFAULT_PRICE_COLLAPSE_BPS};
    use anchor_lang::error::Error as AnchorError;

    /// On-chain code of an Anchor custom error (e.g. 6006), for asserting
    /// the documented codes rather than Rust variant identity.
    fn code_of(err: &AnchorError) -> u32 {
        match err {
            AnchorError::AnchorError(ae) => ae.error_code_number,
            other => panic!("expected an Anchor custom error, got {other:?}"),
        }
    }

    /// A config in the same shape `initialize` leaves behind when the fork
    /// harness boots it (explicit values, default staleness).
    fn base_config() -> ProtocolConfig {
        ProtocolConfig {
            authority: Pubkey::new_unique(),
            pending_authority: Pubkey::default(),
            pending_authority_eta: 0,
            inactivity_seconds: 90 * 24 * 60 * 60,
            price_collapse_bps: 5_000,
            min_tvl_lamports: 1,
            anchor_staleness_seconds: DEFAULT_ANCHOR_STALENESS_SECONDS,
            lp_burn_dust_threshold: 1_000,
            cert_ttl_seconds: 3_600,
            paused: false,
            activity_oracle: Pubkey::new_unique(),
            launch_price_oracle: Pubkey::new_unique(),
            bump: 255,
            _reserved: [0u8; 64],
        }
    }

    fn params(price_collapse_bps: Option<u16>) -> UpdateProtocolConfigParams {
        UpdateProtocolConfigParams {
            inactivity_seconds: None,
            price_collapse_bps,
            min_tvl_lamports: None,
            anchor_staleness_seconds: None,
            lp_burn_dust_threshold: None,
            cert_ttl_seconds: None,
            activity_oracle: None,
            launch_price_oracle: None,
        }
    }

    /// Field-by-field no-mutation assertion: a rejected update must leave
    /// every config field exactly as it was (on-chain the transaction
    /// revert provides the same guarantee atomically).
    fn assert_unchanged(cfg: &ProtocolConfig, before: &ProtocolConfig) {
        assert_eq!(cfg.authority, before.authority);
        assert_eq!(cfg.pending_authority, before.pending_authority);
        assert_eq!(cfg.pending_authority_eta, before.pending_authority_eta);
        assert_eq!(cfg.inactivity_seconds, before.inactivity_seconds);
        assert_eq!(cfg.price_collapse_bps, before.price_collapse_bps);
        assert_eq!(cfg.min_tvl_lamports, before.min_tvl_lamports);
        assert_eq!(
            cfg.anchor_staleness_seconds,
            before.anchor_staleness_seconds
        );
        assert_eq!(cfg.lp_burn_dust_threshold, before.lp_burn_dust_threshold);
        assert_eq!(cfg.cert_ttl_seconds, before.cert_ttl_seconds);
        assert_eq!(cfg.paused, before.paused);
        assert_eq!(cfg.activity_oracle, before.activity_oracle);
        assert_eq!(cfg.launch_price_oracle, before.launch_price_oracle);
        assert_eq!(cfg.bump, before.bump);
        assert_eq!(cfg._reserved, before._reserved);
    }

    #[test]
    fn price_collapse_bps_within_bound_is_applied() {
        let mut cfg = base_config();
        apply_config_update(&mut cfg, &params(Some(9_900)))
            .expect("a typical in-bound value must apply");
        assert_eq!(cfg.price_collapse_bps, 9_900);
    }

    #[test]
    fn price_collapse_bps_boundary_10_000_is_accepted() {
        // The bound is inclusive: 10_000 bps = 100% collapse is the exact
        // documented edge of the Criterion 2 domain.
        let mut cfg = base_config();
        apply_config_update(&mut cfg, &params(Some(10_000)))
            .expect("the 10_000 boundary value must be accepted");
        assert_eq!(cfg.price_collapse_bps, 10_000);
    }

    #[test]
    fn price_collapse_bps_above_10_000_reverts_6006_without_mutation() {
        let mut cfg = base_config();
        let before = cfg.clone();
        let err = apply_config_update(&mut cfg, &params(Some(10_001)))
            .expect_err("price_collapse_bps > 10_000 must revert 6006");
        assert_eq!(code_of(&err), 6006, "bound violation is InvariantViolation");
        // Refused first: the rejected single-field update leaves EVERY
        // field untouched (on-chain the transaction revert provides the
        // same guarantee atomically; the fork suite asserts it at the
        // account level).
        assert_unchanged(&cfg, &before);
    }

    #[test]
    fn staleness_window_below_floor_reverts_6006_and_boundary_applies() {
        let mut cfg = base_config();
        let before = cfg.clone();
        let mut p = params(None);
        p.anchor_staleness_seconds = Some(crate::constants::MIN_ANCHOR_STALENESS_SECONDS - 1);
        let err = apply_config_update(&mut cfg, &p)
            .expect_err("a sub-floor sweep window must revert 6006");
        assert_eq!(
            code_of(&err),
            6006,
            "sub-floor window is InvariantViolation"
        );
        assert_unchanged(&cfg, &before);

        let mut p = params(None);
        p.anchor_staleness_seconds = Some(crate::constants::MIN_ANCHOR_STALENESS_SECONDS);
        apply_config_update(&mut cfg, &p).expect("exactly the floor must be accepted");
        assert_eq!(
            cfg.anchor_staleness_seconds,
            crate::constants::MIN_ANCHOR_STALENESS_SECONDS
        );
    }

    #[test]
    fn cert_ttl_below_floor_reverts_6019_and_boundary_applies() {
        let mut cfg = base_config();
        let before = cfg.clone();
        let mut p = params(None);
        p.cert_ttl_seconds = Some(599);
        let err = apply_config_update(&mut cfg, &p).expect_err("a 599s cert TTL must revert 6019");
        assert_eq!(code_of(&err), 6019, "sub-floor TTL is CertTtlBelowMinimum");
        assert_unchanged(&cfg, &before);

        let mut p = params(None);
        p.cert_ttl_seconds = Some(600);
        apply_config_update(&mut cfg, &p).expect("exactly the 600s floor must be accepted");
        assert_eq!(cfg.cert_ttl_seconds, 600);
    }

    #[test]
    fn scalar_and_oracle_fields_apply_without_bounds() {
        // inactivity, min TVL, dust threshold and the two oracle keys are
        // governance-authority values with no numeric bound in the handler
        // — a valid multi-field update applies every field.
        let mut cfg = base_config();
        let activity = Pubkey::new_unique();
        let launch_price = Pubkey::new_unique();
        let p = UpdateProtocolConfigParams {
            inactivity_seconds: Some(1),
            price_collapse_bps: Some(DEFAULT_PRICE_COLLAPSE_BPS),
            min_tvl_lamports: Some(42),
            anchor_staleness_seconds: None,
            lp_burn_dust_threshold: Some(7),
            cert_ttl_seconds: None,
            activity_oracle: Some(activity),
            launch_price_oracle: Some(launch_price),
        };
        apply_config_update(&mut cfg, &p).expect("a fully valid update must apply");
        assert_eq!(cfg.inactivity_seconds, 1);
        assert_eq!(cfg.price_collapse_bps, DEFAULT_PRICE_COLLAPSE_BPS);
        assert_eq!(cfg.min_tvl_lamports, 42);
        assert_eq!(cfg.lp_burn_dust_threshold, 7);
        assert_eq!(cfg.activity_oracle, activity);
        assert_eq!(cfg.launch_price_oracle, launch_price);
    }

    /// Closeout hardening (2026-11-02): a MULTI-field update where a later
    /// invalid field follows earlier valid assignments. This pins the
    /// documented distinction between three layers.
    ///
    /// In-memory handler behavior: `apply_config_update` validates and
    /// assigns field-by-field, so after a later rejection the earlier VALID
    /// assignments are still visible in the struct (partial application is
    /// the handler's real semantics).
    ///
    /// On-chain transaction atomicity: Anchor only re-serializes the
    /// account after the handler returns `Ok`, so the tentative writes are
    /// discarded by the transaction revert; the on-chain account keeps its
    /// exact pre-call state.
    ///
    /// Account-level preservation is asserted by the fork suite
    /// (`scanner_config_bounds_reject_and_preserve_state`), which runs the
    /// real BPF against a real account.
    ///
    /// This test intentionally does NOT pretend the handler is a
    /// transaction; it locks the actual field-by-field semantics so a
    /// future refactor that silently changes validation order or
    /// partial-application behavior is caught.
    #[test]
    fn multi_field_update_reverts_6019_after_earlier_valid_assignments() {
        let mut cfg = base_config();
        let before = cfg.clone();
        let mut p = params(None);
        // Earlier fields: one unbounded scalar (assigned first) and one
        // valid bounded value — both assignments execute before the
        // failure point.
        p.inactivity_seconds = Some(1);
        p.price_collapse_bps = Some(9_900);
        // A later invalid field: sub-floor cert TTL reverts 6019.
        p.cert_ttl_seconds = Some(599);
        let err = apply_config_update(&mut cfg, &p)
            .expect_err("the later invalid field must revert 6019");
        assert_eq!(
            code_of(&err),
            6019,
            "sub-floor cert TTL is CertTtlBelowMinimum"
        );
        // In-memory: the earlier valid assignments ARE visible — the
        // handler is not a transaction (on-chain the revert discards these
        // tentative writes; the fork test pins the account-level result).
        assert_eq!(cfg.inactivity_seconds, 1);
        assert_eq!(cfg.price_collapse_bps, 9_900);
        // The rejected field itself was never assigned...
        assert_eq!(cfg.cert_ttl_seconds, before.cert_ttl_seconds);
        // ...and every field after the failure point is untouched.
        assert_eq!(cfg.activity_oracle, before.activity_oracle);
        assert_eq!(cfg.launch_price_oracle, before.launch_price_oracle);
    }

    #[test]
    fn on_chain_6006_6019_codes_match_docs() {
        // Lock the two codes this handler raises against the documented
        // numbering (docs/error_codes.md) — mirrors the errors.rs lock test.
        assert_eq!(u32::from(GraveScannerError::InvariantViolation), 6006);
        assert_eq!(u32::from(GraveScannerError::CertTtlBelowMinimum), 6019);
    }
}
