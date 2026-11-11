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
#
# Skip-integrity contract (test-infra audit, 2026-11):
#   This script is the EXPLICIT fork workflow (Workflow B). It exports
#   GRAVEYIELD_FORK_HARNESS=1, under which the suites treat a missing
#   required fixture as a test FAILURE instead of a skip — a suite can
#   never silently skip its assertions here. Phase 6 additionally verifies
#   every fixture the manifest references (plus the three locally built
#   ELFs) BEFORE any suite runs, so a broken fixture set fails loudly at
#   the source. Ordinary `cargo test --workspace` runs (Workflow A) are
#   unaffected: without the flag, absent fixtures skip with a loud banner.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/7] building grave_scanner.so (cargo build-sbf)"
(cd programs/grave-scanner && cargo build-sbf)

echo "==> [2/7] building grave_vault.so (cargo build-sbf)"
(cd programs/grave-vault && cargo build-sbf)

echo "==> [3/7] building the test-only Jupiter stand-in (jupiter_v6_stub)"
(cd programs/grave-vault/tests/jupiter_v6_stub && cargo build-sbf)

echo "==> [4/7] copying the programs into the fixture directory"
mkdir -p programs/grave-vault/tests/fixtures
cp target/deploy/grave_scanner.so programs/grave-vault/tests/fixtures/grave_scanner.so
cp target/deploy/grave_vault.so programs/grave-vault/tests/fixtures/grave_vault.so
cp target/deploy/jupiter_v6_stub.so programs/grave-vault/tests/fixtures/jupiter_v6_stub.so

echo "==> [5/7] fetching mainnet fixtures (both pools + program ELFs)"
node scripts/fetch_v4_fork_fixtures.mjs

echo "==> [6/7] verifying harness prerequisites (fail-closed)"
# The explicit fork workflow must never reach the suites with an incomplete
# fixture set. Every `file` reference in the manifest is checked BYTE-EXACTLY
# against the data_len the fetcher recorded for that account: a zero-length
# account fixture is legitimate (a vault-signer PDA carries lamports but no
# on-chain data, and an unfunded PDA is faithfully recorded as an empty
# system account), but any size drift means a truncated or stale file.
# Entries without a data_len — and the three locally built ELFs — must be
# non-empty. A missing orientation_pool is a legitimately optional fetcher
# outcome — warned, not fatal. Regression scenarios for this verifier:
# scripts/build_fork_harness_verifier_test.mjs.
node --input-type=module <<'VERIFY'
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = "programs/grave-vault/tests/fixtures";
const BUILT = ["grave_scanner.so", "grave_vault.so", "jupiter_v6_stub.so"];
const problems = [];
const check = (name, expectedLen) => {
  let size = null;
  try {
    size = statSync(join(FIXTURES, name)).size;
  } catch {
    problems.push(`${name} (missing)`);
    return;
  }
  if (typeof expectedLen === "number") {
    if (size !== expectedLen)
      problems.push(`${name} (size ${size}, manifest data_len ${expectedLen})`);
  } else if (size === 0) {
    problems.push(`${name} (empty — no data_len recorded, non-empty required)`);
  }
};

const manifestPath = join(FIXTURES, "manifest.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.error(`FAIL: ${manifestPath} is missing or unparseable: ${e.message}`);
  process.exit(1);
}

// Every `file` reference anywhere in the manifest (pool 1, orientation
// pool) must resolve to a fixture on disk whose size matches the recorded
// data_len byte-for-byte (or be non-empty when no data_len is recorded).
const walk = (node) => {
  if (Array.isArray(node)) {
    for (const item of node) walk(item);
    return;
  }
  if (node && typeof node === "object") {
    if (typeof node.file === "string")
      check(node.file, typeof node.data_len === "number" ? node.data_len : undefined);
    for (const value of Object.values(node)) walk(value);
  }
};
walk(manifest);
for (const name of BUILT) check(name);

if (problems.length > 0) {
  console.error(
    `FAIL: fork-harness prerequisites incomplete — missing/corrupt fixture(s):\n` +
      problems.map((m) => `  - ${m}`).join("\n") +
      `\nRe-run this script (or scripts/fetch_v4_fork_fixtures.mjs) before running the suites.`
  );
  process.exit(1);
}

if (!manifest.orientation_pool) {
  console.warn(
    `WARN: manifest has no orientation_pool section — the fetcher could not load an\n` +
      `inverted-orientation pool from mainnet this run. jupiter_conversion_fork's\n` +
      `inverted-orientation test will SKIP (loudly) and the other suites are unaffected.`
  );
}
console.log(`prerequisites OK: every manifest-referenced fixture matches its recorded data_len + ${BUILT.length} built ELFs present`);
VERIFY

echo "==> [7/7] running all seven fork suites (GRAVEYIELD_FORK_HARNESS=1: missing required fixtures FAIL, never skip)"
# Under this flag the suites' skip_or_fail! gates turn any missing required
# fixture into a hard test failure — with `set -e`, the harness cannot report
# success while a suite silently skipped its actual assertions.
export GRAVEYIELD_FORK_HARNESS=1
cargo test -p grave-vault --test raydium_v4_fork -- --nocapture
cargo test -p grave-vault --test jupiter_conversion_fork -- --nocapture
cargo test -p grave-vault --test settlement_economics_fork -- --nocapture
cargo test -p grave-vault --test lp_claim_fork -- --nocapture
cargo test -p grave-vault --test full_lifecycle_fork -- --nocapture
cargo test -p grave-vault --test scanner_windows_fork -- --nocapture
cargo test -p grave-vault --test security_negative_fork -- --nocapture

echo ""
echo "FORK HARNESS COMPLETE: all seven suites ran under GRAVEYIELD_FORK_HARNESS=1."
echo "Review the output above for 'SKIP (optional)' banners — those mark fixture"
echo "configurations that were legitimately absent and NOT exercised this run."
