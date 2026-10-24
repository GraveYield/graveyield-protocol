#!/usr/bin/env bash
# scripts/build_fork_harness.sh — build + fetch + run ALL fork harnesses:
#   Phase 2.1 (withdraw CPI): programs/grave-vault/tests/raydium_v4_fork.rs
#   Phase 3  (conversion pipeline): programs/grave-vault/tests/jupiter_conversion_fork.rs
#   Phase 4  (settlement economics): programs/grave-vault/tests/settlement_economics_fork.rs
#   Phase 5.3 (LP claims): programs/grave-vault/tests/lp_claim_fork.rs
#   Phase 6  (full lifecycle): programs/grave-vault/tests/full_lifecycle_fork.rs
#   Phase 7  (security hardening, scanner side — windows/rotations/replays/pause):
#            programs/grave-vault/tests/scanner_windows_fork.rs
#   Phase 7  (security hardening, vault side — on-chain negative paths):
#            programs/grave-vault/tests/security_negative_fork.rs
#
# All SEVEN suites run here. (Pre-baseline, this script only ran the first
# five — scanner_windows_fork and security_negative_fork were added later
# and silently never wired in; found in the Phase 0 audit, NS-5.)
# Requires: rustup (1.91.1 per rust-toolchain.toml), the Solana CLI 3.0.10
# (cargo-build-sbf) with platform-tools >= v1.54, node (for the fixture
# fetcher), and network access to a mainnet RPC (env RPC_URL, default
# https://api.mainnet-beta.solana.com).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/6] building grave_scanner.so (cargo build-sbf)"
(cd programs/grave-scanner && cargo build-sbf)

echo "==> [2/6] building grave_vault.so (cargo build-sbf)"
(cd programs/grave-vault && cargo build-sbf)

echo "==> [3/6] building the test-only Jupiter stand-in (jupiter_v6_stub)"
(cd programs/grave-vault/tests/jupiter_v6_stub && cargo build-sbf)

echo "==> [4/6] copying the programs into the fixture directory"
mkdir -p programs/grave-vault/tests/fixtures
cp target/deploy/grave_scanner.so programs/grave-vault/tests/fixtures/grave_scanner.so
cp target/deploy/grave_vault.so programs/grave-vault/tests/fixtures/grave_vault.so
cp target/deploy/jupiter_v6_stub.so programs/grave-vault/tests/fixtures/jupiter_v6_stub.so

echo "==> [5/6] fetching mainnet fixtures (both pools + program ELFs)"
node scripts/fetch_v4_fork_fixtures.mjs

echo "==> [6/6] running all seven fork suites"
cargo test -p grave-vault --test raydium_v4_fork -- --nocapture
cargo test -p grave-vault --test jupiter_conversion_fork -- --nocapture
cargo test -p grave-vault --test settlement_economics_fork -- --nocapture
cargo test -p grave-vault --test lp_claim_fork -- --nocapture
cargo test -p grave-vault --test full_lifecycle_fork -- --nocapture
cargo test -p grave-vault --test scanner_windows_fork -- --nocapture
cargo test -p grave-vault --test security_negative_fork -- --nocapture
