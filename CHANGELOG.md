# Changelog

All notable changes to the GraveYield protocol monorepo are documented here.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version bumps in this file refer to the workspace as a whole; per-program
version pinning lives in each program's `Cargo.toml`.

## [Unreleased]

## [v1.0.6] — 2026-05-10

### m3 — GraveVault `salvage_pool` pre-flight + cert freshness gates

This release lands milestone 3 of the canonical 10-step build sequence:
**GraveVault `salvage_pool` pre-flight + PoolRegistry**. The CPI bodies
for AMM `remove_liquidity` (m5), Jupiter swap (m6), and 40/40/20
distribution (m7) remain honest-stubbed and explicitly marked.

#### Added

- **`MIN_CERT_TTL_SECONDS = 600`** floor in `programs/grave-scanner/src/constants.rs`.
  Hardcoded; raising it requires a program upgrade.
- **`ProtocolConfig.cert_ttl_seconds: i64`** field on the GraveScanner
  ProtocolConfig (governance-configurable, 72h timelocked, default 3600s).
  This replaces the previously-hardcoded `ELIGIBILITY_CERT_TTL_SECONDS`
  const at the runtime path in `evaluate_pool_phase_2`. The const itself
  is retained as `DEFAULT_CERT_TTL_SECONDS` for default-handling at init,
  and an `#[deprecated]` alias is left at `ELIGIBILITY_CERT_TTL_SECONDS`
  for backwards-compatible test fixtures.
- **Error 6019 `CertTtlBelowMinimum`** on GraveScanner. Raised by
  `initialize` and `update_protocol_config` when a `cert_ttl_seconds`
  parameter falls below `MIN_CERT_TTL_SECONDS`.
- **`init_if_needed` Anchor feature** on `programs/grave-vault/Cargo.toml`
  for the `lp_holder_pool_vault` SystemAccount. First salvage of a pool
  creates the 0-data system-owned PDA; subsequent salvages of the same
  pool are gated upstream by the `pool_registry` init constraint.

#### Changed

- **`salvage_pool` pre-flight gates wired** in `programs/grave-vault/src/instructions/salvage_pool.rs`:
  - Pause check (`ProtocolPaused`).
  - **Cert freshness** via `EligibilityCert::is_expired(now)` (`EligibilityCertExpired`).
  - **Cert criteria bitmap** must equal `0x3F` (all six derelict-pool
    criteria validated at Phase 2) (`InvalidEligibilityCert`).
  - **Cert pool / AMM binding** — `cert.amm_program_id == params.amm_program_id`
    AND `cert.pool_address == params.pool_address` (`InvalidEligibilityCert`).
  - Pool account address consistency (`PreflightFailed`).
- **`eligibility_cert` account** in `salvage_pool` migrated from
  `UncheckedAccount<'info>` to `Account<'info, EligibilityCert>`. Anchor
  now handles the 8-byte discriminator check and owner-program (`grave_scanner::ID`)
  validation automatically; the previous manual ownership require! is
  redundant and removed.
- **`lp_holder_pool_vault`** in both `salvage_pool` and `claim_lp_proceeds`
  migrated from `UncheckedAccount<'info>` to `SystemAccount<'info>`. In
  `salvage_pool` the constraint adds `init_if_needed` + `space = 0`. The
  account remains charter-invariant unsweepable; only `claim_lp_proceeds`
  may debit it (against a valid Merkle proof, m6+).
- **`evaluate_pool_phase_2`** now reads `cfg.cert_ttl_seconds` from
  ProtocolConfig instead of the hardcoded const when stamping
  `cert.expires_at`.

#### Honest stubs (audit-pending, unchanged from v1.0.5)

- AMM `remove_liquidity` CPI for Raydium V4: wired in v1.0.5; not yet
  integration-tested against a seeded localnet pool (OpenBook seed harness
  is a v1.1 deliverable).
- AMM adapters for Raydium CLMM, Orca Whirlpool, PumpSwap: revert
  `AmmAdapterUnimplemented`.
- Locker release adapters (UNCX / PinkSale / Team Finance): revert
  `LockerAdapterUnimplemented`.
- Jupiter v6 swap CPI: not yet wired; m6 deliverable.
- 40/40/20 distribution math: not yet wired; m7 deliverable.
  `SalvageReceipt` distribution fields are zeroed at init.
- LP-holder Merkle proof verification in `claim_lp_proceeds`: returns
  `InvalidClaimProof` until m6 wires the SHA-256 sorted-pair verification.

#### Verification status

- `cargo check`: not yet run in this sandbox — pending Seth's
  ship-now-vs-verify-first call. v1.0.7 will be the post-verification
  patch with any compile fixes named in the CHANGELOG.

#### Pre-mainnet checklist

- Replace placeholder program IDs in both crates' `declare_id!` and
  `Anchor.toml` with real keypairs via `anchor keys list && anchor keys sync`.
- Re-deploy ProtocolConfig PDAs on devnet — adding `cert_ttl_seconds`
  changes `INIT_SPACE` and existing config accounts will fail `realloc`
  unless rotated through a fresh `initialize`. (Pre-mainnet: no live
  config exists, so this is a no-op for the canonical deploy path.)
