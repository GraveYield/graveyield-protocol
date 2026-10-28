# GraveYield — Phase 3 Readiness Assessment (2026-10-27)

Report-only. No code was changed. All facts verified in this session with real
command exit codes.

## 1. Verified current project state

| Repo | Local head | Remote sync | Tests | Status |
|---|---|---|---|---|
| graveyield-protocol | `5b84440` | == origin/main | 231 host + 354 SDK/indexer + fork suites | Devnet NS-2 deployment live (2026-10-25); protocol Phases 1.1–9, 11, 12 complete per docs |
| grave-indexer | `b07a40e` | **1 ahead** (only `b07a40e` docs commit local) | **51/51 offline PASS re-run today, exit 0** | Phase 2 pipeline complete; verify-path 13/13 live |
| salvor-bots | `cefbed0` | == origin/main | 350 tests (7 packages) | Fleet shipped; dry-run default; live-enablement blocked on oracle keys |
| graveyield-console | `cd0e6c8` | == origin/main | bun unit battery (3 files) | UI complete; **all telemetry simulated**; **stale program IDs** |

Hygiene note: all four repos show chmod-only working-tree drift (100644→100755,
0 content delta) — cosmetic, not committed anywhere.

## 2. Phase 2 readiness and remaining blockers

Evidence-based: Phase 2 (grave-indexer) is **shipped and pushed**.

- Remote main = `5a6aa0f` ("fix: program-level live matrix green against
  deployed devnet scanner") — confirmed via `git ls-remote`.
- Acceptance matrix: `examples/verify-path-report.live.json` — 13 cases,
  `allPass: true`, `payerFunded: true`, 0 skipped. 7 program-level cases ran
  live against GraveScanner `CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54`
  with exact error codes observed (6024/6025/6026 incl. the 9.5 gate).
- Offline battery re-verified this session: 51/51 pass, exit 0.

Outstanding items (all owner-gated, none block Phase 3 candidates):

1. **Oracle-custody registration (item 9.5)** — now explicitly set aside per
   your direction. Additional nuance found in `docs/ORACLE_PIPELINE.md` §6.4:
   the ProtocolConfig authority keypair (deployer `AsB5u…EWXa`) was **erased
   in a workspace reset**, so registration against the *current* deployment
   may be impossible without a DR-001-style re-key/redeploy. The custody guide
   (`docs/ORACLE_CUSTODY.md`) remains valid for a post-rekey deployment.
2. **CI status of `5a6aa0f`** — unverifiable this session (GitHub API
   rate-limited without token; no `GH_TOKEN` in env). The push itself is
   confirmed.
3. **Local-only commit `b07a40e`** (custody guide) — push pending token.

## 3. The Phase 3 definition gap

"Phase 3" is **not defined anywhere** in the repositories or docs under the
numbering you used for Phase 2 (grave-indexer delivery). Three numbering
systems coexist:

| System | "Phase 3" means | Status |
|---|---|---|
| Protocol implementation phases (PRE_MAINNET_CHECKLIST, spec, tests/README) | Jupiter conversion pipeline, fork-proven | **Already complete** — CPI-010/CPI-011/SLIP-001 retired, spec rev 1.6.0, both WSOL orientations proven against real mainnet pool state |
| Salvage-lifecycle phases (combined tech doc §6) | Submission (quote → build salvage tx) | Already implemented (SDK builders, `certifyAndSalvage`, fleet-core pipeline) |
| Owner session phases (worklog; Phase 1 = console/fleet build+reliability 2026-10-25, Phase 2 = grave-indexer) | **Undefined** | Gap |

Doc drift found: the whitepaper references a per-milestone breakdown
(`grave-scanner-grave-vault-combined.md`) that does not exist as markdown.

## 4. Proposed Phase 3 candidates (for approval)

- **P3-A (recommended): Console "real data" pass** — replace simulated
  telemetry with provenance-backed real data from the Phase 2 indexer
  (committed secret-free snapshot artifacts), fix the stale hardcoded program
  IDs (console `data.ts` points at the frozen 2026-10-09 deployment
  `5JiCVx…`/`HUyoG5…` instead of live NS-2 `CuQZes…`/`Bd5smh…`), live
  read-only on-chain reads where RPC suffices. No VPS, no owner keys, builds
  directly on Phase 2 output, user-visible.
- **P3-B: Non-hosting protocol hardening rows** — GOV-001 (timelock:
  wire on-chain or document-reserve), KEYS-002 (LP-burn dust threshold as
  percent-of-supply), Jupiter stand-in verification plan. Touches on-chain
  code → devnet redeploy (owner-gated: custody keys, ≥6 SOL funding).
- **P3-C: Multi-DEX adapters (v1.1 milestone)** — CPI-002/003/004/006/007/008
  (CLMM, Orca, PumpSwap, Meteora scanner parsers + vault CPIs). Largest
  scope; spec + fork-harness work per DEX.
- **Excluded**: ORACLE-003 hosted oracle service (VPS — set aside), KEYS-003
  mainnet keys (mainnet/irreversible — excluded by your rules), fleet
  live-enablement (blocked on oracle keys).

## 5. Ordered execution plan for P3-A (recommended)

1. **Task 3.2 — Fix program IDs + constants to NS-2** (smallest increment,
   immediate correctness): console `src/lib/gy/data.ts:17-23` → live devnet
   IDs; pin with a unit test; typecheck+tests+build green. DoD: commit with
   test evidence.
2. **Task 3.1 — Snapshot data contract**: new indexer CLI command
   (`console-snapshot`) reusing discovery/evidence modules; typed,
   secret-free `ConsoleData` artifact (pools, margins, provenance, generatedAt,
   slot); console loader with fail-closed validation + freshness badge.
   Tests: snapshot schema + secret scan (indexer); loader validation (console).
3. **Task 3.4 — Graveyard wired to snapshot pools**: real pools with
   six-criteria pre-evaluation; estimator untouched (already integer-exact
   port of fleet-core). Pool detail shows real reserves/last-swap with
   provenance.
4. **Task 3.3 — Live read-only chain reads**: Overview pulse from
   ProtocolConfig decode + PDA counts; truthful real/simulated labeling on
   every widget.
5. **Task 3.5 — CI fixes + freshness gate**: fix malformed `branches: ain]`
   trigger (present in BOTH console and salvor-bots CI files — a real bug);
   snapshot-freshness check; CI green on push to main.

## 6. Ambiguities requiring your decision

1. **Which Phase 3?** Approve P3-A, P3-B, P3-C — or supply your own definition.
2. If P3-A: snapshot committed to the console repo (recommended) vs runtime fetch?
3. If P3-A: snapshot contents — raw discovery only, or scout-style scored candidates?
4. Push `b07a40e` now (needs a fresh token) or batch with the first Phase 3 commit?
5. Restore the cosmetic chmod drift across the four repos?
