# Dependabot Alert Triage Record

Triage date: 2026-10-25 · Evidence tooling: `.github/workflows/lockfile-refresh.yml`
(runs 40184040708, 40184390061 — `cargo tree -i` per locked version) · Executor: sethoshi.eth

Every dismissal below is `tolerable_risk` with the reachability evidence here. None of
these close a path to production; each names its consumer chain and why the vulnerable
code cannot be reached from this repository.

## #1 — bigint-buffer ≤ 1.1.5 (HIGH, npm) — CVE-2025-3194 / GHSA-3gc7-fjrx-p6mg

- Upstream trigger: `toBigIntLE(null)` → native addon crash (CWE-120). No fixed version
  exists (Dependabot `first_patched_version = NONE`; Snyk SNYK-JS-BIGINTBUFFER-3364597).
- Entry into the tree: declared by `@solana/buffer-layout-utils@0.3.0` (dependency of
  `@solana/spl-token@0.4.15`). **No GraveYield workspace imports bigint-buffer** (rg over
  sdk / indexer / ops / adversary / scripts: zero hits).
- The sole calling code is `buffer-layout-utils`'s `bigInt`/`u64`/`u128` layout codecs:
  `toBigIntLE(Buffer.from(blob(length).decode(buffer, offset)))` — the argument is always
  a fresh `Buffer` copy of a fixed 8/16-byte slice cut by a schema-constant layout length.
  It cannot be `null` (`Buffer.from(null)` throws) and its length is not attacker-controlled.
- `spl-token`'s `unpackAccount` / `unpackMint` (our only spl-token call surface) validate
  account data length before layout decode.
- Reachability of the vulnerable call signature: **none**. Re-open if
  `@solana/buffer-layout-utils` changes its codecs to pass unvalidated input.

## #2 — atty ≤ 0.2.14 (LOW, rust) — GHSA-g98v-hv3f-hcfr

- Chain: `atty 0.2.14` ← `env_logger 0.9.3` ← `solana-logger 2.3.1` ← `solana-genesis-config`
  ← `solana-accounts-db` ← `solana-program-test 2.3.13` ← **`[dev-dependencies]`** of
  `grave-vault` / `grave-snapshotter`.
- No upstream fix exists (crate is deprecated/unmaintained). Not compiled into any deployed
  program ELF (SBF builds exclude dev-dependencies); test-harness only, and the unaligned
  read requires a Windows console. Accepted.

## #3 — ed25519-dalek < 2.0.0 (MEDIUM, rust) — GHSA-w5vr-6qhr-36cc

- Chain: `ed25519-dalek 1.0.1` ← `solana-runtime 2.3.13` (→ `solana-banks-server` →
  `solana-program-test`, dev-deps) and ← `ed25519-dalek-bip32 0.2.0` ← `solana-keypair 2.2.3`
  ← `solana-client 2.3.13` (dev-dep of `grave-snapshotter`).
- On-chain ed25519 verification happens via the ed25519 native program (syscall), never via
  this crate; the double-public-key signing oracle is not reachable from test harness code.
- Remediation is upstream (Solana monorepo dropping dalek 1.x) — no semver-compatible
  lockfile escape (`cargo update -p ed25519-dalek --precise 2.x` is blocked by the ^1
  requirement). Accepted; revisit with the anchor 0.32.1 stack upgrade.

## #4 — curve25519-dalek < 4.1.3 (LOW, rust) — GHSA-x4gp-pqpj-f43q

- The vulnerable copy is **3.2.0** (4.1.3 also present and fixed). Chain: `curve25519-dalek
  3.2.0` ← `ed25519-dalek 1.0.1` (same dev-dependency test stack as #3). Timing-variability
  advisory; test-only reachability. Accepted.

## #5 / #6 / #8 — rustls-webpki ≥ 0.101.0, < 0.103.12 / < 0.103.13 (LOW×2, HIGH, rust)

- The vulnerable copy is **0.101.7** (0.103.15 also present — ≥ 0.103.13, not affected).
- Chain: `rustls-webpki 0.101.7` ← `rustls 0.21.12` ← `tokio-rustls 0.24.1` ←
  `tokio-tungstenite 0.20.1` ← `solana-pubsub-client 2.3.13` ← `solana-client 2.3.13` ←
  **`[dev-dependencies]`** of `grave-snapshotter` / `grave-vault` (and `solana-banks-server`
  test harness via `solana-runtime`).
- The HIGH advisory (#8) is a panic-DoS while parsing malformed CRL `BIT STRING`s — reachable
  only if a test client parses an attacker-supplied TLS certificate chain; devnet RPC tests
  pin the public cluster's certificates. Accepted; revisit with the anchor stack upgrade.

## #7 — rand ≥ 0.7.0, < 0.8.6 (LOW, rust) — GHSA-cq9v-f236-94qc

- The vulnerable copy is **0.7.3** (0.8.6 / 0.9.5 / 0.10.3 also present and fine). Chain:
  `rand 0.7.3` ← `ed25519-dalek 1.0.1` (same dev-dependency test stack as #3). The unsound
  behavior requires `rand::rng()` with a custom logger — unused in test harness code.
  Accepted.

## Update mechanics (why no lockfile commit accompanied this triage)

`cargo update -p rustls-webpki --precise 0.103.13` and `-p curve25519-dalek --precise
4.1.3` are **no-ops**: the vulnerable copies are old majors semver-blocked by their
consumers (the lockfile diff from run 40184040708 was empty). The only real remediation
is the upstream stack upgrade that retires the old majors; it is tracked as a follow-up
(anchor 0.32.1 → current, which also moves solana 2.2.x test deps to the 2.3 generation).
