# Phase 5.1 — Preflight Report (graveyield-protocol)

> **Stage:** Phase 5.1 — Security Hardening & Findings Reconciliation (Preflight; no code changes made in this stage).
> **Baseline reference:** Phase 5.0 assessment of `main @ 78b5d87`, delivered 2026-11-01 as commit `e61de4a` on branch `p5-0/baseline-security-assessment`.
> **Preflight date:** 2026-11-01 (UTC). **Method:** repository-first re-verification — remote fetch, working-tree inspection, document integrity hashing, full test-baseline reproduction, and finding-by-finding cross-check. Nothing below is carried over from Phase 5.0 without re-verification.
> **Instruction honored:** this report is delivered **before any implementation**; Stage A–D work begins only after owner approval.

---

## 1. Repository state (verified)

| Item | Verified value | Evidence |
| --- | --- | --- |
| Remote | `https://github.com/GraveYield/graveyield-protocol.git` | `git remote -v` |
| Remote fetch | executed this preflight (exit 0) | `git fetch origin --prune` |
| **`origin/main`** | **`78b5d87`** — identical to the Phase 5.0 baseline commit; **no commits have landed since the assessment** | `git rev-parse origin/main`; `git log 78b5d87..origin/main` → empty |
| Local `main` | `78b5d87` == `origin/main` (in sync) | `git log origin/main..78b5d87` → empty |
| Working branch at preflight start | `p5-0/baseline-security-assessment` @ `e61de4a` (the Phase 5.0 deliverables commit — docs-only, one commit ahead of `main`) | `git status -sb`; `git log --oneline -2` |
| Working tree | **clean** (no modified/untracked files); no stashes | `git status --short`; `git stash list` |
| Phase 5.0 document integrity | all three `docs/security/PHASE5_*.md` files **byte-identical** to commit `e61de4a` | sha256 comparison working tree vs `git show e61de4a:…` |
| Tracked files | 249 (+3 security docs on the assessment branch) | `git ls-files \| wc -l` |

**Consequence:** because `origin/main` has not advanced past `78b5d87`, **no Phase 5.0 finding can have been addressed by subsequent commits.** Every finding is re-verified below against the same code state the assessment covered (plus the one docs commit).

## 2. Execution environment (re-verified, exact)

| Tool | Version used | vs. repo pin |
| --- | --- | --- |
| rustc/cargo | **1.91.1** | exact match (`rust-toolchain.toml`) |
| solana-cli / cargo-build-sbf | **3.0.10** | exact match |
| node | **24.22.1** | ≥24 ✓ |
| pnpm | **9.12.0** (corepack shim; `corepack enable --install-directory ~/.local/bin` required in this sandbox — the indexer's `typecheck` script shells out to `pnpm` internally) | exact match |
| anchor CLI | not installed (not required; same as Phase 5.0) | §6.4 of baseline report |
| Disk | 9.9 GB, 1.5 GB free → `CARGO_PROFILE_TEST_DEBUG=0` used for Rust builds (debuginfo stripping only; no effect on test selection/assertions) | same deviation as Phase 5.0, disclosed |
| Fork-harness prerequisites | **ELFs still byte-identical to the Phase 5.0 build**: `grave_scanner.so` `d47f315a…7b1473`, `grave_vault.so` `33cfd453…d15076be3`, `jupiter_v6_stub.so` `8a5f60bc…770c7`; mainnet fixtures present (gitignored, fetched during 5.0) | `sha256sum target/deploy/*.so` |

## 3. Test baseline reproduction (all executed this preflight)

**Grand total: 543 executed · 543 passed · 0 failed · 0 skipped** on the canonical re-run — equal to the Phase 5.0 baseline. One **transient flake** was observed on the very first fork pass (detail below); it is disclosed, not averaged away.

| Suite | Command | Result (this preflight) |
| --- | --- | --- |
| grave-scanner lib | `cargo test -p grave-scanner --lib` | **112 passed / 0 failed**, 0.06 s |
| grave-vault lib | `cargo test -p grave-vault --lib` | **40 passed / 0 failed**, 7.22 s |
| grave-snapshotter lib+integ | `cargo test -p grave-snapshotter` | **38 + 7 + 8 = 53 passed / 0 failed** |
| **Rust host subtotal** | | **205 / 205** |
| TS workspaces | `pnpm -r test` (`DEVNET_RPC_URL=https://api.devnet.solana.com`) — scripts/devnet **51**, sdk **122** (incl. live devnet smoke), indexer **29**, ops **47**, adversary **39** | **288 / 288**, exit 0 |
| Fork suites (7) | `cargo test -p grave-vault --test <suite>` × 7 | **50 / 50** on the canonical pass: raydium_v4 **10**, jupiter_conversion **12**, settlement_economics **7**, lp_claim **5**, full_lifecycle **1**, scanner_windows **6**, security_negative **9** |
| **Fork subtotal** | | **50 / 50** |

**Local CI gates re-run:** `cargo fmt --all -- --check` **OK** · `cargo clippy --all-targets -- -D warnings` **OK (zero warnings)** · `pnpm -r typecheck` **OK** (exit 0) · `pnpm fmt:ts:check` **OK** · `scripts/terminology-lint.sh` **OK** · `scripts/doc-links-lint.sh` **OK**.

### 3.1 Fork flake — disclosed observation (new)

- **First fork pass of this session:** `jupiter_conversion_fork` returned **11 passed / 1 failed** — `inverted_orientation_pool_converts_memecoin` panicked at `programs/grave-vault/tests/jupiter_conversion_fork.rs:899` (`panic!("full-pipeline salvage failed: {e:?}")`), i.e. the salvage transaction failed mid-test. All other six suites passed on that same first pass.
- **Re-verification:** the failing test **passed in isolation**; the full suite then passed **12/12 in three consecutive runs** (two default-thread runs, one `--test-threads=1`) **and in 8 further repetitions** — 11 consecutive clean executions after the single failure. Final canonical per-suite pass (recorded above): **50/50**.
- **Interpretation (bounded, honest):** the failure is **not deterministic**. It reproduces neither in isolation nor on rerun; timing sensitivity under system load (program-test clock/processing behavior) is the leading hypothesis and is consistent with the already-documented program-test wall-clock limitation (baseline report §7.8), but the root cause is **not confirmed**. Phase 5.0 ran the same suites 50/50 on the same machine.
- **Disposition requested:** record as a flake observation with owner-visible evidence (this report). Stage B/D should decide between (a) a targeted repro/hardening investigation of the affected test's time dependencies, and (b) documenting the flake with a bounded retry policy. **No test was modified or weakened during preflight.**

## 4. Findings status cross-check (re-verified today, no code changes)

`origin/main` == baseline commit ⇒ nothing addressed upstream. Spot re-verification of the actionable findings:

| ID | Register status | Preflight re-verification | Evidence (executed today) |
| --- | --- | --- | --- |
| P5-01 (minimatch) | Open | **Still open** — `pnpm audit` = 2 findings (bigint-buffer accepted + minimatch MODERATE) | `pnpm audit` output this session |
| P5-02 (sha2 multi-instance) | Needs further investigation | **Unchanged** — `Cargo.lock` carries sha2 **0.9.9 / 0.10.9 / 0.11.1** | grep over `Cargo.lock` |
| P5-03 (scanner handler gaps) | Open | **Still open** — 6006 raise sites exist (`errors.rs:230`, used by `emergency_pause.rs` refuses-first + config bounds); **no test** drives `update_protocol_config` handler reverts for `price_collapse_bps > 10_000`; **no test** touches `sweep_stale_anchor` handler paths (grep across `programs/grave-scanner/src` test code: none) | greps this session |
| P5-04 (fork not PR-gated) | Open | **Still open** — `ci.yml` has no fork job (comments only, lines 59–60); `fork-harness.yml` gates PR runs on the `fork-harness` label; nightly 03:00 UTC + dispatch | workflow inspection |
| P5-05 (claims live during pause unpinned) | Open | **Still open** — `lp_claim_fork.rs` contains no pause interaction (grep: none) | grep this session |
| P5-06 (residual dust undocumented/unpinned) | Open | **Still open** — `PROTOCOL_SPEC.md` documents dust policy D6 and residual-TVL but **no per-claim floor residual bound** | grep this session |
| P5-07 (CI supply-chain) | Open | **Still open** — actions pinned by major tag (`checkout@v7`, `setup-node@v7`, `rust-cache@v2`, `pnpm/action-setup@v6`, `upload-artifact@v4`, `dtolnay/rust-toolchain@stable`); Solana CLI via `sh -c "$(curl -sSfL https://release.anza.xyz/v3.0.10/install)"` (ci.yml:151, fork-harness.yml:61); platform-tools tarball downloaded without checksum (ci.yml:219, fork-harness.yml:79) | workflow inspection |
| P5-08 (ELF provenance record) | Record only (see §6 D-2) | ELFs re-hashed today — **identical to the recorded values** | `sha256sum target/deploy/*.so` |
| P5-09 (fuzz layer proptest-only) | Accepted risk (documented) | Unchanged (no fuzz targets added) | — |
| P5-10 (real Jupiter v6 unexercised) | Open (documented) | Unchanged — suites still run against the pinned stub | fork execution today |
| **P5-A1** (NS-2 key custody) | **Open, Critical, owner decision** | **Carried unchanged** — cannot be re-verified locally (no key material on any side); not affected by any commit since baseline | §7 of the pending decision brief |
| D5 (`anchor test` runs 0 tests) | Open | **Still open** — root `tests/` = `README.md` only; `Anchor.toml` `test = "pnpm exec ts-mocha … 'tests/**/*.ts'"` matches zero files | `ls tests/`; `Anchor.toml` |
| B9 residual / NS-9 IDLs, marker-audit CI job (D7) | Open | Unchanged | — |

## 5. Relevant source and test locations for the 5.1 stages (verified present)

| Stage B/C/D target | Path (all exist; inspected this preflight) |
| --- | --- |
| B1 pause-claims pin | `programs/grave-vault/tests/lp_claim_fork.rs`; pause plumbing `programs/grave-vault/src/instructions/emergency_pause.rs`; claim instruction `programs/grave-vault/src/instructions/claim_lp_proceeds.rs` (no pause check — invariant to pin) |
| B2 no-op pause toggles | `programs/grave-scanner/src/instructions/emergency_pause.rs` (6006 refuses-first, lines ~49–53); vault equivalent `programs/grave-vault/src/instructions/emergency_pause.rs` |
| B3 config bound + stale-anchor | `programs/grave-scanner/src/instructions/update_protocol_config.rs`; `programs/grave-scanner/src/instructions/sweep_stale_anchor.rs`; `programs/grave-scanner/src/constants.rs` (`MIN_ANCHOR_STALENESS_SECONDS`) |
| B4 dust doc + fork recipe | `docs/PROTOCOL_SPEC.md` §6.4; `programs/grave-vault/tests/lp_claim_fork.rs`; claim math `claim_lp_proceeds.rs:133-158` |
| C1 minimatch | root `package.json` (`pnpm.overrides`); console-repo precedent for the exact override block |
| C2 sha2 path | `Cargo.lock`; `dependabot.yml:28-37`; Merkle byte-identity proptests (`programs/grave-vault/src/merkle.rs`, `snapshotter/src/tree.rs`) |
| D1/D2 workflows | `.github/workflows/ci.yml`, `fork-harness.yml`, `codeql.yml`, `devnet-smoke.yml`, `lockfile-refresh.yml` |
| A reconciliation targets | `docs/security/PHASE5_BASELINE_REPORT.md`, `PHASE5_COVERAGE_MATRIX.md`, `PHASE5_FINDINGS_REGISTER.md` |

## 6. Discrepancies between the three Phase 5.0 documents (Stage A input)

The three documents are internally strong but carry **reconcilable inconsistencies**. All were located by grep this preflight; none alter the assessment's substantive conclusions.

### D-1. Finding-ID space drift: `F5-nn` references vs `P5-nn` register definitions

The register defines **P5-01…P5-10 + P5-A1**. The baseline report and coverage matrix reference findings as **F5-nn** (15 references). Mapping established this preflight:

| Ref used in baseline/matrix | Actual register ID | Note |
| --- | --- | --- |
| F5-01 (minimatch audit finding) | **P5-01** | prefix drift |
| F5-02 (second audit finding = bigint-buffer) | none (accepted-risk row: register §1.5 alert #1) | dangling ID |
| F5-03 (rust lockfile reachability) | none (register §1.5 alert table rows) | dangling ID |
| F5-04 (sha2 multi-instance) | **P5-02** | prefix + number drift |
| F5-05 (claims live during pause) | **P5-05** | prefix drift only |
| F5-06 (residual dust) | **P5-06** | prefix drift only — **but see D-2 collision** |
| F5-07 (scanner handler gaps) | **P5-03** | prefix + number drift |
| F5-07 again (fork not PR-gated) | **P5-04** | **overloaded ID** — one ref, two findings |
| F5-08 (residual dust, matrix G4) | **P5-06** | drift |
| F5-08 (baseline §4.2: "fork suites compile-validated only; see findings register F5-08") | **none** | dangling — historical narrative with no register entry |
| F5-09 (fuzz layer) | **P5-09** | prefix drift only |
| F5-10 (real Jupiter v6) | **P5-10** | prefix drift only |
| F5-11 (SDK-only priority-fee ceiling) | **none** | **dangling** — ST-10 cites a register finding that does not exist |

### D-2. No-op pause-toggle test gap has no owning register ID

Coverage matrix AU-04 and gap G2 assign the no-op-toggle test gap to "F5-06", which collides with the dust finding (register P5-06). The register's only pointer for no-op toggles is a §1.6 CHANGELOG row ("Fixed and verified (behavior) — but see **P5-03** (test pin missing)") — but **P5-03's own text covers only `price_collapse_bps > 10_000` and `sweep_stale_anchor`**, not no-op toggles. Net: the gap the Phase 5.1 instruction calls out as Stage B2 currently has **no precise owning finding**. Reconciliation must either scope it into P5-03 explicitly or mint a dedicated ID.

### D-3. Status-vocabulary violations inside the register (declared vocabulary: Fixed and verified / Open / Accepted risk / Needs further investigation / Superseded)

| Location | As written | Required normalization |
| --- | --- | --- |
| Register §1.2, D6–D10 (line 34) | `**Closed (accurate)**` | not in vocabulary → `Fixed and verified` (accuracy confirmations with no action required) with the historical note preserved |
| Register §2, P5-08 (line 103) | `**Record only**` | not in vocabulary → `Accepted risk` (informational record; carry the "record only" wording in the evidence column) or explicit owner-chosen mapping |
| Register §1.6, PROTOCOL_SPEC §8 ledger row (line 84) | `**Fixed** (per ledger; sampled re-verification…)` | `Fixed and verified` — the evidence column already states verification |
| Register §1.1, B1 (line 15) | `**Superseded** … → **re-opened as P5-A1**` | dual status → exactly one (recommended: `Superseded`, with the P5-A1 pointer preserved in the evidence column; P5-A1 already carries status Open) |
| Register §1.6, sha2 incident row (line 75) | `**Fixed and verified at the time** → **re-opened as P5-02**` | same treatment (recommended: `Superseded` by P5-02, pointer preserved) |

### D-4. PASS-scope candidates in the coverage matrix (Stage A3 — narrow or annotate, never without evidence)

| Matrix row | As written | Issue |
| --- | --- | --- |
| ST-03 (failed swap leg) | `PASS` | exercised against the **stub** Jupiter v6 at the pinned ID; real aggregator unexercised (P5-10) → tested portion = route-vetting/atomicity vs stub; untested portion = real Jupiter route-API semantics → narrow the claim or annotate the testing limitation explicitly |
| ST-10 (priority-fee ceiling) | `PASS (SDK layer)` | informal qualifier; the on-chain layer is unenforced by design (7008 reserved) → split into executed SDK-layer PASS + `N/A-proc`/accepted-boundary component; resolve the dangling F5-11 reference (D-1) |
| CL-05 (rounding) | `PASS` | non-divisible per-claim floor residual case untested (G4/P5-06) → tested portion = divisible recipes + conservation; untested = ≤ N−1 residual pin → narrow or annotate |
| EL-07 (multi-epoch gate) | `PASS` | wall-clock cert-expiry crossing not fork-provable (program-test clock) → annotate as documented testing limitation; host predicate coverage is real and stays PASS |
| CL-03 (snapshot balances) | `PASS` | live-RPC holder enumeration itself exercised only in ops/indexer contexts; final authority (on-chain 7018 pin) is tested → annotate, no downgrade warranted |
| AU-04 (no-op toggle) | `NONE → gap` | informal suffix; normalize to the declared `NONE` vocabulary with the gap pointer (D-2) |

### D-5. Coverage-register traceability items that currently resolve to "documented limitation" with no finding ID

Per the Phase 5.1 instruction §A2, each must end up with exactly one of: finding ID / accepted-risk disposition / documented testing limitation / documented out-of-scope designation. Current state:

| Item | Current traceability | Missing piece |
| --- | --- | --- |
| Claims live during pause | G1 → P5-05 ✓ | none (clean) |
| No-op pause toggle (both programs) | G2/AU-04 → F5-06 (collision) | owning ID (D-2) |
| Scanner config bounds (6006 handler) | G3/AU-05 → P5-03 ✓ | none |
| `sweep_stale_anchor` handler paths | G3 → P5-03 ✓ | none (handler); **account-constraint coverage** has no test anywhere — must be explicitly dispositioned in Stage A/B |
| `invalidate_anchor` fork coverage | G7 ("documented limitations (accepted)") | no register ID; needs explicit documented-testing-limitation disposition |
| Cert-expiry wall-clock | G7 / matrix EL-07 note | same — make the testing-limitation disposition explicit |
| SDK-only priority-fee ceiling | ST-10 → F5-11 (dangling) | register entry or explicit disposition (D-1) |
| Rounding dust | G4/CL-05 → P5-06 ✓ | none |
| Real Jupiter v6 | G6/ST-03/ST-08 → P5-10 ✓ | none |

## 7. New preflight observations (not in the Phase 5.0 register)

1. **`fork-harness.yml` malformed PR branch filter** (line 34, exact bytes verified): `branches: ain]` — evidently a typo for `branches: [main]`. YAML parses it as the string `ain]`, which **matches no real branch, so the label-gated pull_request trigger can never fire**; in practice the fork suite runs only via nightly cron + manual dispatch. This defect predates Phase 5.1 (present at `78b5d87`) but was not flagged in the Phase 5.0 documents. Stage D should fix it alongside P5-04 (path-filtered PR enforcement), and P5-04's remediation is incomplete without it.
2. **Fork flake** (§3.1): one non-deterministic failure of `inverted_orientation_pool_converts_memecoin` observed on the first pass of the session; 11 consecutive clean executions since. Recorded with evidence; root cause unconfirmed.

## 8. Branching / PR plan for Phase 5.1 (established at preflight)

- `p5-0/baseline-security-assessment` @ `e61de4a` — the Phase 5.0 deliverables (docs-only), **pushed and opened as a PR against `main`** so the 5.0 baseline becomes reviewable/mergeable.
- `p5-1/preflight` @ this report — **stacked PR targeting `p5-0/baseline-security-assessment`** so the diff is exactly the preflight document.
- Every subsequent stage (A/B/C/D) gets its own focused branch and PR per the instruction; nothing merges without owner review.

## 9. Stop-point statement

Preflight complete per the Phase 5.1 instruction §2: repository state established (§1), baseline tests reproduced with full disclosure of the one flake (§3), findings re-verified with none addressed upstream (§4), Stage targets located (§5), and the full discrepancy inventory between the three assessment documents produced (§6), plus two new observations (§7). **No code, test, workflow, or document content has been modified by Phase 5.1 yet.** Execution stops here and awaits owner approval before Stage A.
