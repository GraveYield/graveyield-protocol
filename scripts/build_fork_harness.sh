#!/usr/bin/env bash
# scripts/build_fork_harness.sh — build + fetch + run BOTH fork harnesses:
#   Phase 2.1 (withdraw CPI): programs/grave-vault/tests/raydium_v4_fork.rs
#   Phase 3  (conversion pipeline): programs/grave-vault/tests/jupiter_conversion_fork.rs
#
# Requires: rustup (1.91.1 per rust-toolchain.toml), the Solana CLI 3.0.10
# (cargo-build-sbf) with platform-tools >= v1.54, node (for the fixture
# fetcher), and network access to a mainnet RPC (env RPC_URL, default
# https://api.mainnet-beta.solana.com).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/5] building grave_vault.so (cargo build-sbf)"
(cd programs/grave-vault && cargo build-sbf)

echo "==> [2/5] building the test-only Jupiter stand-in (jupiter_v6_stub)"
(cd programs/grave-vault/tests/jupiter_v6_stub && cargo build-sbf)

echo "==> [3/5] copying the programs into the fixture directory"
mkdir -p programs/grave-vault/tests/fixtures
cp target/deploy/grave_vault.so programs/grave-vault/tests/fixtures/grave_vault.so
cp target/deploy/jupiter_v6_stub.so programs/grave-vault/tests/fixtures/jupiter_v6_stub.so

echo "==> [4/5] fetching mainnet fixtures (both pools + program ELFs)"
node scripts/fetch_v4_fork_fixtures.mjs

echo "==> [5/5] running both fork suites"
cargo test -p grave-vault --test raydium_v4_fork -- --nocapture
cargo test -p grave-vault --test jupiter_conversion_fork -- --nocapture
