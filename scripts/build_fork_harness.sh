#!/usr/bin/env bash
# scripts/build_fork_harness.sh — build + fetch + run the Phase 2.1 Raydium
# V4 fork harness (programs/grave-vault/tests/raydium_v4_fork.rs).
#
# Requires: rustup (1.91.1 per rust-toolchain.toml), the Solana CLI 3.0.10
# (cargo-build-sbf) with platform-tools >= v1.54, node (for the fixture
# fetcher), and network access to a mainnet RPC (env RPC_URL, default
# https://api.mainnet-beta.solana.com).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/4] building grave_vault.so (cargo build-sbf)"
(cd programs/grave-vault && cargo build-sbf)

echo "==> [2/4] copying the program into the fixture directory"
mkdir -p programs/grave-vault/tests/fixtures
cp target/deploy/grave_vault.so programs/grave-vault/tests/fixtures/grave_vault.so

echo "==> [3/4] fetching mainnet fixtures (pool state + program ELFs)"
node scripts/fetch_v4_fork_fixtures.mjs

echo "==> [4/4] running the fork suite"
cargo test -p grave-vault --test raydium_v4_fork -- --nocapture
