# Phase 5.1 — Stage A Reconciliation Log (graveyield-protocol)

> **Stage:** Phase 5.1 Stage A — documentation reconciliation only. **No code, test, workflow, or dependency file was modified** (`git diff --stat` for this branch touches `docs/security/*.md` exclusively).
> **Trigger:** PR #67 (Phase 5.1 preflight) merged; `origin/main` advanced to `1865908` (including PR #69 — minimatch dependency fix, Dependabot alert #13's dependency).
> **Authority:** preflight report §6 (D-1…D-5 discrepancy inventory) is the work order; owner instruction adds the P5-01 refresh, the Dependabot-statement correction, and preservation directives (P5-04 retraction, fork flake, P5-A1, historical IDs).
> **Companion documents:** [`PHASE5_FINDINGS_REGISTER.md`](PHASE5_FINDINGS_REGISTER.md) · [`PHASE5_COVERAGE_MATRIX.md`](PHASE5_COVERAGE_MATRIX.md) · [`PHASE5_BASELINE_REPORT.md`](PHASE5_BASELINE_REPORT.md) · [`PHASE5_1_PREFLIGHT_REPORT.md`](PHASE5_1_PREFLIGHT_REPORT.md).

---

## 1. Synchronization and tree verification (exact commands and results)

| Command | Result |
| --- | --- |
| `git fetch origin --prune` | exit 0; `origin/main` `dbd7bf5` → `1865908` (merge of PR #67) |
| `git checkout main && git pull --ff-only origin main` | exit 0; fast-forward to `1865908` |
| `git log --oneline -3` | `1865908` Merge PR #67 · `dbd7bf5` Merge PR #69 · `be29607` preflight correction |
| `git status -sb` | `## main...origin/main` — clean, in sync |
| `git stash list` | empty (0 entries) |

Stage A work then proceeded on branch `p5-1/stage-a-doc-reconciliation` off `1865908`.

## 2. Fresh dependency-audit evidence (P5-01 refresh)

| Command | Result (2026-11-01, on `main @ 1865908`) |
| --- | --- |
| `pnpm audit` (pnpm 9.12.0) | **1 vulnerability found — Severity: 1 high**: `bigint-buffer@1.1.5` (GHSA-3gc7-fjrx-p6mg; 12 paths via `@solana/spl-token → @solana/buffer-layout-utils`), the **documented accepted risk** (register §1.5 alert #1). **No minimatch finding.** |
| `git show origin/main:package.json` → `.pnpm.overrides` | `"minimatch": ">=11.0.1 <12"` present (landed by PR #69, commit `09cee65`, merge `dbd7bf5`) |
| `git show origin/main:pnpm-lock.yaml` → minimatch | resolves `minimatch@11.0.3` (≥ 11.0.1 first-patched); its dependency is `@isaacs/nonrecursive-glob-match@1.0.3` — **`brace-expansion` no longer carried**, which is why the originally suggested `brace-expansion` override was unnecessary |
| `GET /repos/GraveYield/graveyield-protocol/dependabot/alerts/13` | `state: "open"`, package `minimatch`, range `< 11.0.1`, first patched `11.0.1`, `fixed_at: null` — **auto-closure is pending Dependabot's re-scan of the fixed manifest** at reconciliation time. The remediation itself is independently verified by the lockfile + audit evidence above. Reported honestly rather than claimed closed. |

**Register consequence:** P5-01 status **Open → Fixed and verified** (repo record: PR #69; verification artifact: fresh audit + lockfile). No other finding's status changed by evidence; P5-02 (`sha2` multi-instance) is unaffected by #69 and remains **Needs further investigation**.

## 3. Status normalization per the declared vocabulary (preflight §6 D-3)

Declared vocabulary (register preamble): **Fixed and verified / Open / Accepted risk / Needs further investigation / Superseded**.

| Register location | Before | After | Note |
| --- | --- | --- | --- |
| §1.2, D6–D10 | `Closed (accurate)` | **Fixed and verified** (accuracy confirmations; historical wording preserved in the cell) | no action required either way |
| §2, P5-08 | `Record only` | **Accepted risk** (informational record; "record only" wording preserved in the cell) | nothing here is a protocol risk |
| §1.6, PROTOCOL_SPEC §8 ledger row | `Fixed` | **Fixed and verified** | evidence column already stated verification |
| §1.1, B1 | dual: `Superseded … → re-opened as P5-A1` | **Superseded** (P5-A1 pointer + original wording preserved in the cell) | exactly one status; P5-A1 unchanged (**Open**) |
| §1.6, sha2 incident row | dual: `Fixed and verified at the time → re-opened as P5-02` | **Superseded** (by P5-02; original wording preserved in the cell) | exactly one status |

No finding was closed, downgraded, or renumbered by normalization; every original ID survives.

## 4. Finding-ID space reconciliation (preflight §6 D-1)

All live `F5-nn` cross-references in the baseline report and coverage matrix now point at the canonical register IDs. The mapping below is the record; the preflight §6 D-1 inventory remains the historical description of the drift.

| Original reference | Canonical ID | Where corrected |
| --- | --- | --- |
| F5-01 (minimatch audit finding) | **P5-01** | baseline §4.4, §5; register P5-01 row unchanged |
| F5-02 (second audit finding = bigint-buffer) | register §1.5 alert #1 (dangling ID retired) | baseline §4.4 |
| F5-03 (rust lockfile reachability) | register §1.5 alerts #3/#4/#7 (dangling ID retired) | baseline §4.4 |
| F5-04 (sha2 multi-instance) | **P5-02** | baseline §5 |
| F5-05 (claims live during pause) | **P5-05** | baseline §6.4, §7.1 |
| F5-06 (residual dust — matrix CL-05/G4) | **P5-06** | baseline §7.4; matrix CL-05, verdict C, G4 |
| F5-06 (no-op pause toggle — matrix AU-04/G2) | **P5-11** (minted — see §5) | matrix AU-04, G2 |
| F5-07 (scanner handler gaps) | **P5-03** | baseline §7.2; matrix AU-05, G3 |
| F5-07 (fork not PR-gated — the overloaded second use) | **P5-04** | baseline §7.7; matrix G5 |
| F5-08 (baseline §4.2 "compile-validated only") | none (dangling; historical narrative) | baseline §4.2 — narrative kept, bogus ID retired |
| F5-09 (fuzz layer) | **P5-09** | matrix EL-06, G8 |
| F5-10 (real Jupiter v6) | **P5-10** | matrix ST-03, ST-08, verdict D, G6 |
| F5-11 (SDK-only priority-fee ceiling) | **P5-12** (minted — see §5) | matrix ST-10, verdict D |
| F5-A1 (matrix AU-02) | **P5-A1** | matrix AU-02 |
| F2/F3 "(ADVERSARY)" shorthand | **ADV-F2 / ADV-F3** (explicit) | matrix ST-05, ST-09 |

Verification: `grep -nF 'F5-' docs/security/PHASE5_COVERAGE_MATRIX.md` → only 2 intentional hits (the header note describing the correction; the quoted original citation inside AU-04). Baseline: 0 live `F5-nn` references remain (only quoted historical citations).

## 5. Ownership gaps closed by minting (preflight §6 D-2 / D-1 dangling)

| New ID | Severity | Content | Status |
| --- | --- | --- | --- |
| **P5-11** | Low | No-op emergency-pause toggles are not pinned by any test (both programs; scanner 6006 / vault 7003 refuses-first). Resolves the AU-04/G2 "F5-06" collision. | **Open** |
| **P5-12** | Info | Priority-fee ceiling is SDK/operator-enforced only; on-chain 7008 reserved, never raised. Gives the dangling ST-10 "F5-11" a stable owning ID; kept visible for the Phase 13 external audit. | **Accepted risk** (documented boundary) |

Both rows explicitly mark themselves as minted at Stage A reconciliation so the 5.0/5.1 history stays auditable.

## 6. Coverage-matrix PASS-scope annotations (preflight §6 D-4)

Narrowed or annotated — never downgraded without evidence:

| Row | Change |
| --- | --- |
| ST-03 | PASS annotated: executed against the test-only Jupiter v6 **stub**; real aggregator route semantics unexercised (P5-10) |
| ST-10 | `PASS (SDK layer)` split into **PASS** (SDK layer executed) + **N/A-proc** (on-chain layer unenforced by design, 7008 reserved); dangling ref resolved to P5-12 |
| CL-05 | PASS annotated: divisible recipes + conservation executed; the non-divisible ≤ N−1 residual case is **not** tested (P5-06) |
| EL-07 | gap cell relabeled **Documented testing limitation** (explicit disposition, no register ID; host predicates are the compensating control) — PASS unchanged |
| CL-03 | gap cell annotated: no downgrade warranted (on-chain 7018 pin is the tested final authority) — PASS unchanged |
| AU-04 | observed result `NONE → gap` normalized to the declared **`NONE`** vocabulary with the P5-11 gap pointer |
| ST-02 | **Flake note added** (preservation directive): `inverted_orientation_pool_converts_memecoin` — one non-deterministic failure in the Phase 5.1 preflight (2026-11-01), then 11 consecutive clean executions incl. isolated rerun; root cause unconfirmed; **disposition unresolved** — Stage B/D to choose targeted repro/hardening vs documented bounded-retry policy. No test modified. |
| G7 | severity cell relabeled **Documented testing limitations** (explicit Stage A disposition — not register findings); `sweep_stale_anchor` account-constraint layer explicitly disposed into P5-03's scope |

## 7. Traceability closure (preflight §6 D-5)

| Item | Final disposition |
| --- | --- |
| Claims live during pause | G1 → P5-05 (unchanged, clean) |
| No-op pause toggle | G2/AU-04 → **P5-11** (minted) |
| Scanner config bounds (6006 handler) | G3/AU-05 → P5-03 (unchanged, clean) |
| `sweep_stale_anchor` handler paths | P5-03 (handler) + account-constraint coverage **explicitly included in P5-03's scope** (register row + baseline §7.2 + matrix G7) |
| `invalidate_anchor` fork coverage | **Documented testing limitation** (matrix G7; no register ID — unit predicates are the compensating control) |
| Cert-expiry wall-clock crossing | **Documented testing limitation** (matrix EL-07 + G7) |
| SDK-only priority-fee ceiling | **P5-12** (minted; Accepted risk) |
| Rounding dust | G4/CL-05 → P5-06 (unchanged, clean) |
| Real Jupiter v6 | G6/ST-03/ST-08 → P5-10 (unchanged, clean) |

## 8. Stale Dependabot statement — correction

- **Where:** register §2, P5-01 row (only occurrence of the claim).
- **As written:** "Dependabot alerts are disabled on this repo, so nothing else will flag it."
- **Corrected to:** Dependabot alerts are enabled — **alert #13** was raised for exactly the minimatch finding on 2026-11-01; its auto-closure follows Dependabot's re-scan of the fixed manifest (API state still `open` at reconciliation time; see §2 above).
- **Related stale line (pre-existing on `main` from the Phase 5.0 docs):** none other found — `grep -in 'dependabot alerts are disabled' docs/` returns only the register row now corrected. The register §1.6 note "Dependabot ignores majors" is a factual statement about `dependabot.yml` config and is untouched.

## 9. Preservation directives — compliance

| Directive | Where preserved |
| --- | --- |
| P5-04 false-positive retraction (fork-harness "branch filter") | preflight §7.1 untouched (merged doc); matrix/baseline references to the trigger are consistent with the retraction; baseline §7.7 now cites it; **no document resurrects the retracted claim** (`grep 'ain]'` over `docs/` → no hits) |
| Jupiter conversion flake + unresolved disposition | matrix ST-02 flake note (§6 above); register §4 Stage A addendum; preflight §3.1 remains the evidence record |
| P5-A1 open pending owner custody decision | register §2 cross-cutting block + §4 P0 untouched (**Open, Critical, owner decision**); matrix AU-02 pointer corrected to P5-A1 |
| Historical finding IDs and assessment history | every original ID (B1–B9, D1–D10, ADV-Fn, P4-Bn, P5-01…P5-10, DR-001, NS-n) survives; normalization cells quote the original status wording; the 5.0 snapshot values (543/543, ELF hashes, §5 dependency table) are unmodified; original dual-status wording preserved in-cell; `git history` retains the untouched originals |

## 10. Verification (exact commands and results, on the Stage A branch)

| Command | Result |
| --- | --- |
| `git diff --stat main` | docs-only: 3 modified files under `docs/security/` + this log (no code/test/CI/dependency files) |
| `bash scripts/terminology-lint.sh` | `ok: no forbidden vocabulary detected` |
| `bash scripts/doc-links-lint.sh` | `ok: all relative markdown links resolve` (115 targets re-checked) |
| `grep -rnF 'F5-' docs/security/PHASE5_BASELINE_REPORT.md` | quoted historical citations only (0 live references) |
| `grep -in 'dependabot alerts are disabled' docs/` | no hits (corrected) |
| `grep -rn 'ain]' docs/` | no hits (retraction preserved, claim not resurrected) |
| `pnpm audit` | 1 finding — accepted `bigint-buffer` only (see §2) |

## 11. Remaining unresolved findings (status after Stage A)

| ID | Status | Note |
| --- | --- | --- |
| **P5-A1** (Critical) | **Open** | sole P0 — owner decision on devnet key custody (restore vs DR-001-style redeployment); blocks all live-chain verification incl. the real-Jupiter end-to-end proof |
| P5-02 | Needs further investigation | sha2 multi-instance: confirm which hasher instance the ELF uses; upstream-chain property |
| P5-03 | Open | scanner handler tests (6006 bound + `sweep_stale_anchor` paths + account-constraint layer) |
| P5-04 | Open | fork harness not PR-gated (policy choice; trigger verified functioning per preflight §7.1 retraction) |
| P5-05, P5-06 | Open | charter/pause + residual-dust pins (P1 class) |
| P5-07 | Open | CI supply-chain hardening (pre-mainnet) |
| P5-10 | Open (documented) | real Jupiter v6 unexercised — blocked by P5-A1 for the end-to-end proof |
| P5-11 | Open (minted Stage A) | no-op pause-toggle test pin (P1 class) |
| P5-12 | Accepted risk (minted Stage A) | priority-fee on-chain non-enforcement — Phase 13 audit-carry |
| B5, B7, B8, B9 residuals, D5, ADV-F3, ADV-F2/F5/F8/F9, GOV-001, KEY-*/ORACLE-003/LOCKER-002/CPI-002…008 | unchanged | carried per the register; external-audit / pre-mainnet tracks |
| Fork flake | **Disposition unresolved** | preflight §3.1; Stage B/D decision required |

**Known limitations of this reconciliation:**
1. Statuses reflect evidence available on 2026-11-01; Dependabot alert #13's auto-closure was still pending at reconciliation time (remediation independently verified — §2).
2. No test suites were re-run in Stage A (docs-only stage); all test-execution citations remain the Phase 5.0/preflight records on the stated commits.
3. The register title/headers still say "@ `78b5d87`" — intentionally preserved as the assessment-snapshot designation; the reconciliation notes at the top of each document state the current `origin/main` (`1865908`).

## 12. Stop-point statement

Stage A reconciliation is complete: the three Phase 5.0 documents are mutually consistent, use the declared status vocabulary, carry corrected canonical IDs, and reflect the P5-01/PR #69 reality with fresh audit evidence — with every preservation directive honored. **Stage A stops here.** No code, tests, dependencies, or CI workflows were touched; Stage B has not begun. Awaiting owner review of the documentation-only PR.
