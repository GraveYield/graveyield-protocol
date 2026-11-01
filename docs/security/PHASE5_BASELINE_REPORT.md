# Phase 5.0 — Baseline Verification Report (graveyield-protocol)

> **Stage:** Phase 5.0 — Baseline Verification and Security Gap Assessment (assessment-first; no protocol code, economics, account layouts, instruction behavior, or architecture was modified).
> **Assessed commit:** `main @ 78b5d87` — "fix(cargo): restore workspace.package.homepage with a domain-free URL" (`78b5d875fb8f179aa0bab40df7826addf8706f5d`).
> **Assessment date:** 2026-11-01 (UTC). **Method:** the repository itself is the source of truth — every claim below cites a file, a command, or an executed result. Nothing was carried over from prior summaries without re-verification.
> **Companion documents:** [`PHASE5_COVERAGE_MATRIX.md`](PHASE5_COVERAGE_MATRIX.md) (attack-class → test mapping), [`PHASE5_FINDINGS_REGISTER.md`](PHASE5_FINDINGS_REGISTER.md) (findings disposition + prioritized plan), [`PHASE5_1_PREFLIGHT_REPORT.md`](PHASE5_1_PREFLIGHT_REPORT.md), [`PHASE5_1_STAGE_A_RECONCILIATION_LOG.md`](PHASE5_1_STAGE_A_RECONCILIATION_LOG.md).
>
> **Stage A reconciliation (2026-11-01):** this document remains the Phase 5.0 record of `main @ 78b5d87` — assessment values (543/543 execution results, ELF hashes, toolchain table, §5 dependency rows) are preserved unmodified. Stage A refreshed only *cross-references*: the drifted `F5-nn` IDs now point at the canonical register IDs (full mapping in the reconciliation log; drift inventory: preflight report §6 D-1), and the P5-01/minimatch rows carry a post-PR-#69 resolution pointer. Current `origin/main` is `1865908` (merge of PR #67; PR #69 dependency remediation landed — see register P5-01). No assessment value was altered.

---

## 1. Repository state (verified)

| Item | Verified value | Evidence |
| --- | --- | --- |
| Remote | `https://github.com/GraveYield/graveyield-protocol` | clone log |
| HEAD at assessment | `78b5d87` (main) | `git rev-parse HEAD` |
| Branch status | `main` == `origin/main`, working tree **clean** at clone; work performed on branch `p5-0/baseline-security-assessment` | `git status -sb` |
| Tracked files | 249 | `git ls-files \| wc -l` |
| Recent history | Active through PR #57 (`chore/solana-crates-3.1-close-rustls`); HEAD is one docs-repair commit ahead of the stack-migration line (`2b0bc24`); the console repo's vendored SDK pins `2b0bc24`, and `sdk/src` was re-verified **byte-identical** to `GraveYield/salvor-bots@main` during this assessment (see §6) | `git log --oneline -20`; `diff -r sdk/src _salvor-bots/src` |
| Cargo workspace | `programs/grave-scanner`, `programs/grave-vault`, `programs/grave-vault/tests/jupiter_v6_stub` (test-only), `snapshotter` | `Cargo.toml` |
| pnpm workspaces | `sdk`, `indexer`, `ops`, `adversary`, `scripts/devnet` | `pnpm-workspace.yaml` |
| Toolchain pins | Solana CLI 3.0.10 · Anchor 1.2.2 · Rust 1.91.1 · Node 24 · pnpm 9 (`Anchor.toml`, `rust-toolchain.toml`, `package.json`) | pins verified at execution time |

## 2. Component inventory (verified)

| Component | Path | Security-relevant surface |
| --- | --- | --- |
| **GraveScanner** (Anchor) | `programs/grave-scanner/src/` — 27 files | Six-criteria evaluation (`criteria.rs`, 711 L), oracle attestation verification (`attestation.rs`, 1556 L), two-phase certification (`evaluate_pool_phase1/2.rs`), AMM adapters (`adapters/`, Raydium V4 real; CLMM/Orca/PumpSwap/Meteora stubs), UNCX locker introspection (`adapters/locker.rs`, 679 L), config authority (`update_protocol_config.rs`), `emergency_pause.rs`, `invalidate_anchor.rs`, `sweep_stale_anchor.rs`, `record_launch_price.rs`, `initialize.rs` |
| **GraveVault** (Anchor) | `programs/grave-vault/src/` — 32 files | Settlement (`instructions/salvage_pool.rs`, 1266 L), Merkle verifier (`merkle.rs`, 357 L), claims (`instructions/claim_lp_proceeds.rs`, 216 L), dust sweep (`instructions/sweep_dust.rs`), CPI layer (`cpi/` — Raydium V4 real; Jupiter v6 route forwarding; CLMM/Orca/PumpSwap stubs), config/pause/initialize |
| **Salvor SDK** (TS) | `sdk/src/` — 20 files | Attestation builders (`lastSwapAttestation.ts`, `launchPriceAttestation.ts`), PDA derivation (`pdas.ts`, `web3compat.ts`), instruction builders (`instructions.ts`, `salvagePool.ts`, `certifyAndSalvage.ts`), Merkle mirror (`merkle.ts`), snapshot enumeration (`snapshot.ts`), Charter fee guard (`client.ts`, `priorityFee.ts`), decoders, error table |
| **Indexer** (TS) | `indexer/src/` — 14 files | Raydium V4 discovery, criteria pre-filter (C2/C5/C6 assume-pass off-chain by design), activity-oracle signing via `ACTIVITY_ORACLE_KEY`, C1 attestation submission |
| **Ops** (TS) | `ops/src/` — 11 files | Read-only observer with accounting alerts, Merkle service with artifact self-verification, health, scenarios; no keys by design |
| **Adversary battery** (TS) | `adversary/src` + `adversary/test` | 15 threat classes, 30 TS cases (ADV-ID…ADV-DC), manifest integrity test; refuses/pinned/finding verdict model |
| **Snapshotter** (Rust) | `snapshotter/src/` — 10 files | Deterministic LP-holder enumeration, sealed artifact with whole-tree integrity gate (`artifact.rs`), UNCX locked-LP attribution (`locked.rs`), reference Merkle tree (`tree.rs`) |
| **Adapters** | `adapters/` | Contract stubs only (future lockers) — no code |
| **Scripts** | `scripts/` | `build_fork_harness.sh` (the fork entry point), `fetch_v4_fork_fixtures.mjs` (mainnet fixture fetcher + layout validator), devnet deploy/rehearsal scripts, lifecycle rehearsal harness, toolchain/lint checks |
| **Integration tests** | `programs/grave-vault/tests/*.rs` | Seven fork suites (50 tests), test-only Jupiter v6 stub program |
| **CI** | `.github/workflows/` | `ci.yml`, `codeql.yml`, `devnet-smoke.yml`, `fork-harness.yml`, `lockfile-refresh.yml` |

## 3. Execution environment (verified, exact)

| Tool | Version used | vs. repo pin |
| --- | --- | --- |
| rustc/cargo (host) | **1.91.1** (rustup, minimal + rustfmt + clippy) | exact match |
| solana-cli / cargo-build-sbf | **3.0.10** (`release.anza.xyz/v3.0.10/install`) | exact match |
| platform-tools | **v1.54** override installed into `~/.cache/solana/v1.51/platform-tools` (CI `ci.yml:216-226` equivalent; cargo 1.89.0) | CI-equivalent |
| node | **24.22.1** | ≥24 ✓ |
| pnpm | **9.12.0** (corepack) | exact match |
| anchor CLI | **not installed** (not required: the fork harness invokes `cargo build-sbf` directly; `anchor build` additionally wraps IDL generation only) | see §6.4 |
| Network | crates.io, release.anza.xyz, GitHub releases, public mainnet RPC (fixtures), public devnet RPC (sdk smoke) | available |

**Environment deviation, disclosed:** a 9.9 GB sandbox disk forced `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0` for host/fork Rust builds (debuginfo stripping only — no change to test selection, assertions, or semantics). Fork-suite fixture state is gitignored by design and was fetched during this assessment (40 RPC calls, layout-validated by `fetch_v4_fork_fixtures.mjs`).

**ELF provenance (built from the assessed tree, CI-equivalent toolchain):**

```
d47f315aa5f7638a4a723caff2071565c7dd5079c36b5b80997d66c03d7b1473  grave_scanner.so
33cfd453658d729753de955e93e052b715eb8a38674047b6d6ffde9d15076be3  grave_vault.so
8a5f60bcc6c1c5407c2e0b5ca9301a4afc038aab8b7d0b2576b99a1a80d770c7  jupiter_v6_stub.so
```

## 4. Test baseline inventory & execution results

Grand total **executed: 543 · passed: 543 · failed: 0 · skipped: 0** (255 Rust + 288 TS), plus all local-runnable CI gates green. Classification vocabulary per the task: Implemented / Compiled / Executed / Passed / Skipped / Failed / Not implemented. Compilation is never reported as execution.

### 4.1 Rust host suites (cargo, host target — no validator, no network)

| Suite | Command | Tests | Classification | Result |
| --- | --- | --- | --- | --- |
| grave-scanner lib | `cargo test -p grave-scanner --lib` | 112 (incl. 15 proptest: criteria 3, attestation 4) | Implemented → Compiled → **Executed → Passed** | 112/0, 0.06 s |
| grave-vault lib | `cargo test -p grave-vault --lib` | 40 (incl. 8 proptest: merkle 5, salvage split 3) | Implemented → Compiled → **Executed → Passed** | 40/0, 7.06 s |
| grave-snapshotter lib + integration | `cargo test -p grave-snapshotter` | 38 lib + 15 integration (7 `tests/merkle.rs` + 8 `tests/snapshot.rs`) | Implemented → Compiled → **Executed → Passed** | 53/0 |
| **Rust host subtotal** | | **205** | | **205 passed / 0 failed / 0 ignored** |

### 4.2 Fork suites (in-process VM via `solana-program-test`, real mainnet bytecode + account state)

Prerequisites satisfied here: three ELFs built via `cargo build-sbf` (§3 hashes), fixtures fetched via `node scripts/fetch_v4_fork_fixtures.mjs` (pools `58oQCh…` base-is-coin and `AVs9TA4…` inverted orientation). All seven suites were **actually executed** — this is the first verified fork execution in recent repo history (prior sessions recorded fork suites as compile-validated only — historical note; the original "F5-08" citation here was a dangling ID with no register entry, corrected at Stage A reconciliation).

| Suite (file) | Command | Tests | Result |
| --- | --- | --- | --- |
| `raydium_v4_fork.rs` | `cargo test -p grave-vault --test raydium_v4_fork` | 10 | **10 passed** (incl. `real_v4_withdraw_burns_lp_and_settles_40_40_20`) |
| `jupiter_conversion_fork.rs` | same pattern | 12 | **12 passed** |
| `settlement_economics_fork.rs` | same pattern | 7 | **7 passed** |
| `lp_claim_fork.rs` | same pattern | 5 | **5 passed** |
| `full_lifecycle_fork.rs` | same pattern | 1 | **1 passed** (`candidate_pool_to_lp_claim_end_to_end`) |
| `scanner_windows_fork.rs` | same pattern | 6 | **6 passed** |
| `security_negative_fork.rs` | same pattern | 9 | **9 passed** |
| **Fork subtotal** | | **50** | **50 passed / 0 failed / 0 skipped** |

Note: without `tests/fixtures/` these suites self-skip with `SKIP:` (graceful no-op pass). During this assessment fixtures existed, so **no test was skipped**. The `jupiter_v6_stub` crate contains no tests (it is a built artifact used by the suites).

### 4.3 TypeScript suites (node ≥24 built-in runner + tsx; `pnpm -r test`, `DEVNET_RPC_URL=https://api.devnet.solana.com`)

| Workspace | Command (per workspace `test` script) | Tests | Result |
| --- | --- | --- | --- |
| sdk | `node --test --import tsx/esm 'test/**/*.test.ts'` | **122** | **122 passed / 0 skipped** — includes the **live devnet smoke** (`devnetSmoke.test.ts`, read-only): decodes the deployed NS-2 ProtocolConfig PDAs and runs `evaluatePool` against a real devnet pool |
| indexer | same runner | 29 | **29 passed** |
| ops | same runner | 47 | **47 passed** |
| adversary | same runner | 39 | **39 passed** (15 threat classes; manifest-integrity test enforces coverage) |
| scripts/devnet | `node --test 'test/**/*.test.mjs'` | 51 | **51 passed** (lifecycle-rehearsal helpers, findings A–E regression pins) |
| **TS subtotal** | | **288** | **288 passed / 0 failed / 0 skipped** |

### 4.4 Local-runnable CI gates (all green)

| Gate | Command | Result |
| --- | --- | --- |
| Rust format | `cargo fmt --all -- --check` | **OK** |
| Rust lint | `cargo clippy --all-targets -- -D warnings` (workspace incl. jupiter stub) | **OK, zero warnings** |
| TS typecheck | `pnpm -r typecheck` | **OK** |
| TS lint + format | `pnpm lint` + `pnpm fmt:ts:check` | **OK** |
| Terminology lint | `bash scripts/terminology-lint.sh` | **OK** |
| Doc-links lint | `bash scripts/doc-links-lint.sh` (109 links) | **OK** |
| SDK mirror sync | `diff -r sdk/src <salvor-bots>/src` (ci.yml `sdk-sync-check` equivalent) | **byte-identical** |
| npm audit | `pnpm audit` | **2 findings** (as run in Phase 5.0) — see findings register **P5-01** and §1.5 alert #1 (the original "F5-01/F5-02" citations were ID drift/dangling, corrected at Stage A). *Stage A post-script:* after PR #69 the same command returns **1 finding** (the accepted bigint-buffer only). |
| Rust lockfile reachability | `cargo tree -i <crate>@<version>` | see §5 / register §1.5 (alerts #3/#4/#7 — the original "F5-03" citation was a dangling ID, corrected at Stage A) |

### 4.5 Not executed here (with missing prerequisites — recorded honestly)

| Item | Status | Why |
| --- | --- | --- |
| `anchor build --no-idl` (ci.yml `anchor-build` job) | **Not executed** | `anchor-cli 1.2.2` requires a nightly-compiled CLI (~5–7 min compile). The BPF compile it wraps **was** executed directly via `cargo build-sbf` with the same platform-tools v1.54 pin, producing the ELFs whose hashes are in §3. Missing prerequisite: anchor CLI binary only. |
| `anchor test` (root `tests/`) | **Not implemented** | Root `tests/` contains only `README.md` (21 KB plan doc). The `Anchor.toml` test glob `tests/**/*.ts` matches **zero** files — `anchor test` would boot a validator (cloning mainnet Raydium V4 per `[test.validator]`) and run 0 tests. Matches baseline discrepancy D5 (still open). |
| CodeQL (`codeql.yml`) | **Not executed** | Requires GitHub infrastructure. Note: JS/TS-only matrix; Rust is outside static analysis; job is inactive while the repo is private. |
| `devnet-smoke.yml` as a scheduled workflow | **Not executed as workflow** | Its payload — sdk suite with `DEVNET_RPC_URL` — **was executed** locally with the same env and passed (§4.3). |
| `lockfile-refresh.yml` | **Not executed** | `workflow_dispatch`-only evidence job; its reachability-evidence step was reproduced manually via `cargo tree -i` (§5). |
| `scripts/devnet/lifecycle_rehearsal.sh` + local/devnet rehearsals | **Not executed** | Requires the `salvor-bots` workspace and validator orchestration; out of minimal assessment scope. Recorded as Implemented / not-executed-here. The rehearsal helper modules' unit tests (51) were executed (§4.3). |
| cargo-fuzz / libfuzzer / AFL / fast-check | **Not implemented** | No fuzz targets exist anywhere in the repo (grep-verified). The property layer is proptest only (15 properties + 1 committed regression seed `programs/grave-vault/proptest-regressions/merkle.txt`). Documented Phase 7 design decision in `tests/README.md`. |

## 5. Dependency security posture (re-verified today)

The Dependabot triage (`docs/SECURITY_ALERT_TRIAGE.md`) deferred alerts #3/#5/#6/#8 to "the anchor stack upgrade". **That upgrade has since landed** (anchor 1.2.2 / agave solana-\* 3.1.x, commits `4674463`, `7e3375c`). This assessment re-checked `Cargo.lock` and produced fresh reachability evidence:

| Crate | Version(s) in lock | Advisory status | Carrier (cargo tree) | Disposition |
| --- | --- | --- | --- | --- |
| `atty` | — (absent) | alert #2 (LOW) | — | **Closed by migration** |
| `rustls-webpki` | 0.103.16 only | alerts #5/#6/#8 | — | **Closed by migration** (0.103.16 ≥ 0.103.13) |
| `ed25519-dalek` | **1.0.1** + 2.2.0 | alert #3 (MEDIUM) — 1.0.1 vulnerable | `agave-precompiles 3.1.12 ← solana-runtime ← solana-program-test ← grave-vault [dev-dep]` | **Still present, dev-only** — fork-harness test binary only; not compiled into any deployed ELF; unfixable locally (upstream agave chain). Accepted risk, evidence refreshed 2026-11-01. |
| `curve25519-dalek` | **3.2.0** + 4.1.3 | alert #4 (LOW) — 3.2.0 vulnerable | `ed25519-dalek 1.0.1 ← agave-precompiles ← … [dev-dep]` | same as above |
| `rand` | **0.7.3** + 0.8.8/0.9.5/0.10.3 | alert #7 (LOW) — 0.7.3 vulnerable | `ed25519-dalek 1.0.1 ← agave-precompiles ← … [dev-dep]` | same as above |
| `sha2` | 0.9.9 / 0.10.9 / **0.11.1** | no advisory; **single-instance property changed** | 0.9.9 ← `ed25519-dalek 1.0.1 ← agave-precompiles`; 0.10.9 ← snapshotter + `solana-sha256-hasher` sha2 feature (the Merkle core line per `dependabot.yml:28-37`); 0.11.1 ← `k256 ← solana-secp256k-program ← agave-precompiles` | **New observation (register P5-02)**: the migration re-introduced a multi-instance sha2 tree. The Merkle determinism core itself is pinned (byte-identity proptests vs the snapshotter pass; executed here), so determinism is test-enforced — but the Phase 12 "single crypto core" property is no longer literally true. Needs follow-up confirmation that the pin test still enforces the *right* instance. |
| npm `bigint-buffer` 1.1.5 | present (HIGH) | GHSA-3gc7-fjrx-p6mg | `@solana/spl-token → @solana/buffer-layout-utils` | **Unchanged accepted risk** (no upstream fix exists; unreachable call signature per triage — re-confirmed `pnpm audit` 2026-11-01) |
| npm `minimatch` 10.2.6 | present (MODERATE) | GHSA-g3hv-75wg-m249 | `eslint@10.13.0` (dev tooling only) | **New finding (register P5-01)** — published after the Phase 12 dependency pass; patchable exactly the way the console repo patched it (`minimatch >=11.0.1` + `brace-expansion ^5` overrides). Not patched in this stage (assessment-first) — **since remediated by PR #69 (2026-11-01); register P5-01 = Fixed and verified** (the `brace-expansion` override proved unnecessary). |

## 6. First-hand code verification (spot audits performed during this assessment)

The following enforcement points were read and verified directly (not via summary), with file:line anchors:

1. **Oracle signature chain** (`attestation.rs`): `verify_ed25519_offsets_at` pins exactly-one signature, canonical sig/pk placements inside the precompile ix, oracle-key equality, and message span `(offset,len)` equality against the scanner ix data — the bytes `params.msg` are provably what the oracle signed (`attestation.rs:254-339`). The runtime verifies the signature itself; the program verifies *what* was signed.
2. **Attestation freshness & binding** (`attestation.rs:378-410`): message binds `(amm_program_id, pool_address)` (6027), timestamp `0 < ts ≤ now` (6028), `issued_slot` in-bounds (6030), SlotHashes membership + hash equality (6029/6031) — all fail-closed.
3. **Multi-epoch gate** (`evaluate_pool_phase2.rs:115-215`): pause gate → anchor not-invalidated → fresh C1 attestation (Phase-1 evidence cannot survive the multi-epoch gap — SlotHashes window ~512 slots) → C2 launch-price mint binding → locker evidence validation → criteria re-evaluation → **bitmap must equal the Phase-1 anchor bitmap** (drift refusal) → cert lifecycle gate (only expired certs rewritable) → TTL floor.
4. **Claims** (`claim_lp_proceeds.rs`): zero-balance/supply rejection → Merkle proof against the sealed registry root → u128 pro-rata with explicit overflow checks → cumulative-claimed conservation (`new_claimed ≤ lp_holder_pool_total_lamports`) → PDA-signed system transfer → **init-once `ClaimRecord` PDA as the double-claim defense** → no pause check (claims live during pause — charter invariant, code-confirmed; see register P5-05 for the test gap).
5. **Merkle verifier** (`merkle.rs`): sorted-pair SHA-256, promotion convention, and the 5-property proptest battery binding producer (`grave-snapshotter`) to verifier — executed in §4.1.
6. **Settlement** (`salvage_pool.rs`): pause gate (7003) → cert freshness/bitmap/binding → AMM executable + pool-owner check → **supply pin** `lp_mint.supply == lp_total_supply_at_snapshot` (7018) → init-once `PoolRegistry`/`SalvageReceipt` PDAs (double-salvage defense) → orientation derived from on-chain mints, exactly-one-WSOL-side else 7019 pre-CPI → submitted mints bound to pool bytes (7013) → route-account vetting (no protected account may appear; vault WSOL destination must be present) → slippage ceiling vs pool-implied price with effective cap `min(config, HARD)` tightened by override, enforced **before** the swap CPI (7007) → post-swap output assert → share-sum + 20 % ceiling re-check before distribution → PDA-signed transfers.
7. **Authority model**: `has_one = authority` on both programs' `update_protocol_config` / `emergency_pause` / `invalidate_anchor`; bounded config writes (price_collapse ≤ 10 000, staleness floor `MIN_ANCHOR_STALENESS_SECONDS`, cert-TTL floor 600 s, share ceiling 20 %, share-sum == 10 000); refuses-first pause/invalidation toggles; init-once config PDAs; `sweep_stale_anchor` is permissionless but `writer`-bound for rent return and gated on the floor-locked staleness window.
8. **Artifact integrity** (`snapshotter/src/artifact.rs`): `seal` refuses a foreign tree; `verify_integrity` re-derives root/leaves/proofs/reconciliation identity and fails closed; deterministic JSON. Console-side and ops-side mirrors verified by their suites (executed).

## 7. Missing test coverage identified (summary)

Full scenario mapping is in [`PHASE5_COVERAGE_MATRIX.md`](PHASE5_COVERAGE_MATRIX.md) §5. Highlights:

1. Charter invariant "claims remain live during pause" is code-true but pinned by **no test** (register P5-05).
2. Scanner handler-level reverts for `price_collapse_bps > 10_000` (6006) and the entire `sweep_stale_anchor` handler are untested (documented GOV gap in `docs/ADVERSARY.md` §4 — still true; register P5-03, whose Stage A scope also covers `sweep_stale_anchor` account-constraint coverage).
3. Pause no-op-toggle refuses-first reverts (both programs) untested (register P5-11, minted at Stage A reconciliation).
4. Residual per-claim floor dust (≤ N−1 lamports, permanently locked in the unsweepable LP vault) has no explicit test or documented magnitude bound (register P5-06).
5. `invalidate_anchor` / `sweep_stale_anchor` have no fork-harness coverage (unit predicates only) — documented in `docs/assessments/phase4-assessment.md` §3, still true.
6. Real Jupiter v6 is never exercised (test-only stub at the pinned program ID) — documented; still true.
7. Fork suites are not PR-gated (nightly 03:00 UTC / label / dispatch only) — a fork-breaking PR passes `ci.yml` until the nightly run (register P5-04; the preflight §7.1 retraction confirms the label-gated trigger itself is intact and functioning).
8. Cert-expiry wall-clock crossing is not fork-provable in-VM (program-test freezes `unix_timestamp` on warp); covered only by host predicate tests — documented Phase 7 note, still true.
9. The root `tests/` Anchor+ts-mocha harness remains **not implemented** while `Anchor.toml` advertises it (D5).
10. No fuzz layer beyond proptest (no cargo-fuzz/fast-check targets).

## 8. Stop-point statement

Per the Phase 5.0 Definition of Done: baseline established (§1–3), suites inventoried (§4 + companion matrix), baseline tests executed (§4: 543/543, all local-runnable CI gates green), attack classes mapped (coverage matrix), findings classified (findings register), missing coverage identified (§7 + matrix §5), and a prioritized implementation plan produced (findings register §4). **This stage stops here, before Stage 5.1, and reports.**
