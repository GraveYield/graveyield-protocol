# GraveYield — Next-Milestone Assessment (post-Phase 3)

**Date:** 2026-10-27 · **Scope:** assessment only — no code modified, no commits, no pushes, no deployments, no transactions, no keys generated, no expenses.
**Method:** fresh verification against the live repos and cluster (remote heads, byte-level workflow checks, independent local test runs, read-only devnet RPC, targeted source reading). Prior assessment reports were used only as pointers; every load-bearing claim below was re-verified this session. Where something could not be verified, it is labeled as such.

---

## 1. Verified current state after Phase 3

### 1.1 Repositories and sync

| Repo | Remote main | Local | Delta | Phase 3 content |
|---|---|---|---|---|
| graveyield-protocol | `5b84440` | same | in sync | (Phase 3 was console/indexer work) |
| grave-indexer | `159a244` | `b07a40e` | 2 ahead on remote | `20b3eef` console-snapshot data contract (P3-A 3.1); `159a244` cluster-split fix (discovery=mainnet, config=devnet) |
| salvor-bots | `cefbed0` | same | in sync | none (correct — no salvor changes were in the approved scope) |
| graveyield-console | `8d9dc3e` | `cd0e6c8` | 6 ahead on remote | NS-2 program IDs + regression guards (`56d9a4a`, `09f78ed`), fail-closed snapshot loader (`09be9d0`), real-data Graveyard (`50a7edd`), live protocol pulse (`f2de504`), freshness tests (`8d9dc3e`) |

Notes:
- Console Phase 3 commits are authored `Z User <z@container>`, not the owner identity (`sethoshi.eth`). Cosmetic, but worth knowing for provenance.
- Working trees carry only chmod-only drift (0 insertions/deletions) — confirmed cosmetic again this session.
- `vendor/protocol` submodule in grave-indexer pins `5b84440` = current protocol head (verified).

### 1.2 CI — verified valid, prior "malformed trigger" reports were false

- All six workflow files across the four repos contain a **valid** push/PR filter on main (`branches: [main]`). Verified byte-level this session (`b'branches: [main]'` present; the mangled variant absent, count 0) after earlier reads displayed `branches: ain]`.
- **Root cause of the false reports:** this workspace's tool-output transport drops the literal two-character sequence `[m` from displayed text. Any read of `[main]` renders as `ain]`. The Phase 3 commit `8d9dc3e` ("output-rendering artifact … intended triggers were never broken") was **correct**, and its seemingly self-contradictory wording is explained by this display quirk. Earlier sessions and my own mid-session finding fell into the same trap; the byte-level check is authoritative.
- Empirical corroboration: all four repos' CI badges are green, and the Actions pages show one run per push to main with conclusions matching the known history (e.g., grave-indexer: `edb0a5b` FAILURE → `ee73b08` fix → SUCCESS). Per-run metadata (event field, job details) could not be pulled — GitHub API rate-limited without a token. Labeled: **run-level CI detail unverified; trigger validity and run existence verified.**
- salvor-bots README still claims "no CI of its own yet — NS-6" (`README.md`, 1 match for "no CI of its own"). Stale: the repo has had `ci.yml` since `7bc6a76` with green runs.

### 1.3 Tests — independently re-run this session

| Suite | Commit | Result | Exit |
|---|---|---|---|
| graveyield-console (`bun test`) | remote head `8d9dc3e` | 45/45 pass | 0 |
| grave-indexer offline battery (`pnpm test:offline`) | remote head `159a244` | 59/59 pass | 0 |
| grave-indexer typecheck (src+test) | `159a244` | clean | 0 |
| salvor-bots workspace packages (7 suites) | `cefbed0` | 238/238 pass | 0 |
| salvor-bots root SDK mirror | `cefbed0` | 116/116 pass | 0 |
| graveyield-protocol TS workspace (sdk, indexer, ops, adversary — 4 suites) | `5b84440` | 231/231 pass | 0 |
| protocol Rust unit tests + 7 fork suites | `5b84440` | **not runnable in this workspace** (no cargo/solana toolchain) | — |

Rust evidence therefore remains CI-based (fork-harness nightly + `ci` badge green) plus the documented records in `DEVNET.md` / `tests/README.md`; it is not independently re-executed here.

### 1.4 Deployment state — verified live via read-only devnet RPC (2026-10-27)

- GraveScanner `CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54`: executable, BPF-loader-owned. GraveVault `Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg`: executable. Matches `docs/DEVNET.md` (NS-2 / DR-001 refresh, 2026-10-25).
- ProtocolConfig PDAs: scanner-owned, 252 bytes; vault-owned, 210 bytes — byte lengths match the console decoder's pinned minimums.
- Retired DR-001 scanner (`5JiCVx…`) still on-chain and executable — historical artifact only, as documented.
- **Account census (fresh, decisive):** `getProgramAccounts` returns exactly **1 account** per program — the two ProtocolConfigs. **Zero** EligibilityAnchor / EligibilityCert / LaunchPrice / PoolRegistry / SalvageReceipt / ClaimRecord accounts exist. No pool has ever been evaluated, certified, or salvaged against the live deployment.
- Cluster: epoch 1193, 432,000 slots/epoch (~2–4 days/epoch ⇒ the C6 two-epoch confirmation is ~4–6 days of wall clock on real devnet).
- Devnet payer `8G6nsm…odcP6L` still holds 0.05 SOL.

### 1.5 What is real vs simulated vs unverified today (short form; full matrix in §3)

- **Implemented and live-proven (read paths):** program deployment + configs; console Graveyard rendering of a real mainnet indexer snapshot (12 enriched of 118 WSOL-supported pools, slot bounds, sha256 fingerprints, honest C1/C3 with C2/C4/C5/C6 pinned "pending"); console Overview live devnet ProtocolConfig decoding (discriminator-checked, fail-closed); indexer discovery/evidence pipeline with a 13/13 live verify-path matrix (2026-10-26 record); SDK read paths and devnet smokes.
- **Implemented and tested, never executed live:** every attestation-gated on-chain write (record_launch_price, evaluate_pool_phase_1/2), the entire salvage path (withdraw CPI, slippage ceiling, 40/40/20, receipts), LP claims, dust sweep, scout submission mode, fleet-core live submit (hard-gated), monitor reconcile against a real receipt.
- **Simulated:** console fleet feed/KPIs/claims fixtures (labeled, with specific label gaps found — §3.10), Jupiter leg in tests (documented test-only stand-in at the pinned aggregator program ID).
- **Impossible right now:** any attestation-signed on-chain action on devnet — the registered `activity_oracle` and `launch_price_oracle` both equal the NS-2 deployer key `AsB5u…EWXa`, whose keypair was erased in the 2026-10-26 workspace reset (`ORACLE_PIPELINE.md` §6.4). See §4 B1.

---

## 2. Next milestone per the existing roadmap — and the documentation gap

### 2.1 What the project's own documentation defines

The protocol repo's shipping roadmap (assembled from `CHANGELOG.md` headers, package status lines, and inline citations — there is **no single roadmap file**):

- Phases 0 → 12 are complete, including: Phase 3 = the Jupiter conversion pipeline (**completed and retired** — this is the protocol docs' own "Phase 3", distinct from the owner-session "P3-A" console pass), Phase 6 = the first full-lifecycle fork test, Phases 8–11 = SDK / indexer / salvage / devnet kit, Phase 12 = adversarial battery.
- The docs' explicit "next" is **Phase 13 — external audit** (`CHANGELOG.md`: "Next: Phase 13 (external audit) — this battery is its evidence base"; `ADVERSARY.md` §4 "Findings ledger (for the Phase 13 audit)").
- **No Phase 14 exists anywhere** (grep: 0 matches). Phase 15 = v1.1 feature line (additional AMM sources + locker adapters, `PRE_MAINNET_CHECKLIST.md:73`).

### 2.2 The documentation gap

Between "Phase 12 complete" and "Phase 13 audit", the docs themselves name an operational milestone but never sequence it as a numbered phase:

- `DEVNET.md` §"Deliberately out of scope": *"Controlled salvage scenarios — require a funded Salvor with LP in a genuinely derelict devnet pool and the SDK's instruction builders; the fork harness already proves the settlement mechanics against mainnet bytecode."*
- `technical-documentation.md:454–459`: *"The current runbook does not claim a controlled real-pool salvage has been completed on devnet."*
- Freshly verified today: zero lifecycle accounts exist on devnet (§1.4).

**Proposed milestone (grounded in existing architecture, no new numbering):** a **devnet lifecycle validation pass** — the first end-to-end execution of discovery → attestation → evaluation → certification → snapshot → salvage → claims → sweep on the live devnet programs, plus the integration rehearsal that de-risks it. It sits between Phase 12 and Phase 13 as audit-readiness evidence; after it, the docs' own next integer (13) applies unchanged. This matches the owner's directive: validate the lifecycle; do not expand infrastructure; do not invent numbering.

---

## 3. End-to-end lifecycle coverage matrix

Legend: **Impl** = implemented in code; **Test** = automated coverage (F = fork harness with real bytecode, U = host/unit, A = offline adversary); **Live** = ever executed against a real cluster (not simulation); **Gap** = what's missing. "Live" claims cite the evidence.

| # | Lifecycle stage | Impl | Test | Live | Evidence / gaps |
|---|---|---|---|---|---|
| 1 | Candidate discovery + evidence collection (Raydium V4) | Yes | U (indexer 59; SDK 116) | **Yes** — mainnet discovery runs (Phase 3 snapshot: 120 parsed / 118 supported / 12 enriched); verify-path 13/13 PASS live on devnet 2026-10-26 (`examples/verify-path-report.live.json`) | Gap: `deriveLastSwapV4` skips ALT-loaded / version-1 txs — activity derivation failed for **11 of 12** enriched pools in the Phase 3 snapshot (recorded honestly as failures; `ORACLE_PIPELINE.md` §8.3). Protocol-side fix deferred; coordinated with the byte-identical salvor mirror. |
| 2 | Scanner eligibility — C1 inactivity | Yes | U + F | No (0 anchors on-chain) | C1 only from indexer-signed 112 B attestation; SlotHashes ~512-slot window enforced (`attestation.rs`); live negative matrix 6024/6025/6026 proven; positive path blocked by oracle registration (§4 B1). |
| 3 | Scanner eligibility — C2 price collapse | Yes | U + F | No | 168 B launch-price attestation; init-once PDA; replay-proof (`scanner_windows_fork` `record_launch_price_is_oneshot`). |
| 4 | Scanner eligibility — C3 TVL / C4 supply / C5 locked-LP / C6 epochs | Yes | U + F | No | C3/C4 on-chain reads; C5 UNCX locker adapter only (LOCKER-002 tracking: other lockers invisible — treated as unlocked); C6 `MIN_EPOCH_CONFIRMATION=2` boundary fork-tested (6016 at gap 1, pass at exactly 2). |
| 5 | Anchor/cert lifecycle (TTL, invalidation, sweep) | Yes | U (partial F) | No | Cert reissue gate 6034 fork-tested; **`invalidate_anchor` and `sweep_stale_anchor` have no fork-harness coverage** (unit predicates only); cert-expiry *crossing* not fork-provable in-VM (documented; host-tested). |
| 6 | Vault salvage — Raydium V4 withdraw | Yes | F (10 tests, real bytecode) | No | 22-account wire, LP burn, reserve transfers, scrambled/fake account rejection; salvor signs as user_owner. |
| 7 | Vault salvage — conversion leg | Yes | F (12 tests) | No | Route vetting, slippage ceiling pre-CPI (7007), orientation derived from pool bytes (7019). **Real Jupiter v6 aggregator never exercised** — documented test-only stand-in at the pinned program ID (`tests/jupiter_v6_stub`, `technical-documentation.md:489`). |
| 8 | Vault salvage — settlement + receipts | Yes | F | No | Exact 40/40/20 with D7 rounding (custom-split test), dust-skip (D6) + one-shot sweep, replay protection matrix (per-pool `init` on registry/receipt, one-shot dust stamp). |
| 9 | LP-holder fairness — snapshot + claims | Yes | F (5 tests) + snapshotter crate tests | No | Merkle leaf = sha256(holder‖balance), sorted-pair, cumulative conservation cap (7009), double-claim defense (ClaimRecord init), claims live during pause (by design). Documented trust boundary: supply equality ≠ per-holder balances unchanged since snapshot. |
| 10 | Tx construction / simulation / execution boundaries | Yes | A (offline; FakeConnection) | **No real submission anywhere** | SDK builders + fleet-core pipeline: simulate-before-submit, charter fee guard (throws above live ceiling), dynamic precompile-index pinning with post-assembly assertion, **hard throw unless `mode:"live"`**, at-most-once admission, 15-state lifecycle. All 354 salvor tests run against fakes; `JupiterV6RouteAdapter` (real HTTP) never runs in tests. |
| 11 | Authorization / oracle / governance | Yes | F + live negatives | Pauses/drills **Yes** (2026-10-25 drill, both programs) | Authority gates 7000/6000 fork-tested; **on-chain timelock deliberately unwired** (D2; GOV-001; 7014 never raised); `max_priority_fee_ceiling` config-only — 7008 never raised on-chain; **oracle registration currently impossible** (B1). |
| 12 | Salvor bot integration + safeguards | Partial | A (offline) | Dry-run loops only | Scout: discovery→prefilter→admission (hard/soft refusals, adversary suite)→submission builders — submission mode never run live. fleet-ops wires Scout+Monitor only — **no production Scout→executor envelope transport exists** (every `buildEnvelope` call site is a test); production `AttestationSource` client missing; shared `FleetStore` backend missing; expired-lease takeover has no fencing token (known finding F5). |
| 13 | Failure handling / recovery / unsafe transitions | Yes (on-chain) / partial (off-chain) | F negatives (9 security + 12 conversion + 10 withdraw) + offline adversary | No | Revert atomicity ("no PDA survives the revert"), replay matrix, pause gates, epoch boundary, cert gates. Off-chain: retries classified by 24 failure classes; monitor anomaly sweep; recovery from real partial failure never observed live. |

**Summary:** every on-chain stage of the lifecycle is implemented and fork-tested against real mainnet bytecode, including the adversarial paths; what has never happened is the whole chain executing on a live cluster — not one stage of it has run on devnet (§1.4 census). The off-chain execution stack is built and offline-tested but has never moved a real transaction, and two production seams (envelope transport, attestation service client) do not exist yet. The immediate gate for any on-chain progress is the oracle/authority key situation (§4 B1).

---

## 4. Remaining security and integration blockers

### Critical (block the next milestone)

- **B1 — NS-2 ProtocolConfig authority key erased.** One keypair was, at initialize: config authority for both programs, both oracle signers, and program upgrade authority. `ORACLE_PIPELINE.md` §6.4 records it was erased in the 2026-10-26 workspace reset. Consequences while unresolved:
  - No `update_protocol_config` (oracle registration, param changes) — the outstanding **oracle-custody registration (item 9.5)** cannot execute.
  - No valid C1/C2 attestations can ever verify on devnet (6026 on every submission) — phases 1/2 cannot pass; salvage cannot be authorized.
  - No program upgrades, no pause/unpause via authority (pause drill only replays if the key exists).
  - **I did not attempt and will not attempt any re-key, regeneration, or governance action.** Required owner decision (§8 D1): (a) the key survives in owner-side custody → execute `docs/ORACLE_CUSTODY.md` as written (no redeployment), or (b) the key is gone → approve a DR-001-path-B style **NS-3 refresh** (rehearsed scripts exist: `scripts/devnet/local_rehearsal.sh`, `deploy_devnet.sh`; devnet-only cost ≈ 6–8 SOL of rent; new program IDs would require mechanical updates to console constants/tests — already pinned by the Phase 3 regression guards — and indexer defaults).
- **B2 — No registered oracle keypair.** Subsumed by B1; listed separately because the **positive-path** verify case (currently ending 6026 by design) only flips after registration, and scout submission mode requires `ACTIVITY_ORACLE_KEY`.

### Integration gaps (must close before/at fleet operation; not blockers for the first salvage)

- **B3 — Scout→executor transport missing.** Envelope format exists and is validated, but nothing in production converts `ScoutOpportunity` → `OpportunityEnvelope` or carries it (every call site is a test; `wireFleet` wires Scout+Monitor only).
- **B4 — Production attestation source missing.** fleet-core's `LocalAttestationSource` is "tests + devnet drill"; the intended indexer oracle service has no client.
- **B5 — `deriveLastSwapV4` robustness** (ALT / version-1 transactions): caps attestation yield on mainnet-like data (11/12 pools failed in the Phase 3 snapshot). Protocol-repo changeset + mirror sync.
- **B6 — Shared `FleetStore` / lease fencing** (finding F5): single-process only; expired-lease takeover unfenced.

### Pre-mainnet (tracked; safe to wait)

KEYS-003 (custody-generated mainnet keypairs — 🟥 before mainnet only), GOV-001 (timelock wiring decision), ORACLE-003 (oracle runbook completion — partially covered by `grave-indexer/docs/ORACLE_CUSTODY.md` + `ORACLE_PIPELINE.md`; the checklist row remains open until custody/rotation drills are executed), CPI-002…008 (non-V4 AMMs — v1.1), LOCKER-002, KEYS-002, NS-8 (doc corrections — some found stale this session), NS-9 (IDLs not committed), SDK npm publish (owner custody action).

---

## 5. Ordered, dependency-aware implementation roadmap

Ordered by dependency; every item maps to existing architecture and docs. Nothing here requires mainnet, VPS, hosted services, or snapshot-freshness automation (manually refreshed snapshot + honest freshness labeling remain acceptable, per owner directive).

| # | Work item | Depends on | Why now |
|---|---|---|---|
| W1 | **Lifecycle Rehearsal Harness** (local `solana-test-validator`, real NS-2 ELF bytes, real TS SDK/scout/fleet clients; full lifecycle + adversarial cases) — detail in §6 | nothing (no owner authority needed) | Smallest deliverable that validates the untested integration surface (TS-wire path, seams) using existing fixtures/runbooks; directly de-risks W3. |
| W1b | Ride-along honesty fixes (console: render "unavailable/pending" instead of computed `~20,7xx d` / `0.0%` / `0.00` from missing data; relabel fleet feed "streaming"→simulated; surface per-row data state; un-hide top-bar badge on mobile; align footer; refresh console README; fix salvor README CI staleness / close NS-6) | nothing | The project's own honesty contract is violated in three table cells today (spot-verified `graveyard.tsx:203,234–253`); cheap, reviewable, no behavior change. |
| W2 | Custody resolution → oracle registration (9.5) **or** NS-3 refresh → `ORACLE_IS_REGISTERED` positive-path flip | owner decision D1 | Unblocks every attestation-gated stage. |
| W3 | **First real devnet lifecycle**: scripted derelict devnet pool creation → scout submission mode (record_launch_price + phase 1) → real 2-epoch wait (~4–6 days) → phase 2 → real snapshotter → fleet-core live salvage (first-ever live submit) → monitor reconcile → claims + sweep; adversarial attempts on the side (unauthorized signer, expired cert, replay salvage, duplicate claim) | W1, W2 | This is the milestone the docs name but never sequenced (§2.2). |
| W4 | SDK `deriveLastSwapV4` hardening (ALT + version-1) — protocol changeset + salvor mirror sync + regression vectors | independent; before W3's mainnet-discovery reliance | Restores activity yield (today 1/12). |
| W5 | Scout→executor envelope bridge + shared-store decision + F5 fencing | W3 proven | Needed when fleet operates continuously, not before. |
| W6 | Audit-readiness cleanup: NS-8 doc corrections, NS-9 IDLs, ORACLE-003 runbook completion (custody/rotation drills), then **Phase 13 external audit** per the docs | W3 evidence | The docs' own next integer. |

---

## 6. The single highest-priority next task

**W1 — Lifecycle Rehearsal Harness: a one-command, fully local end-to-end pass of the real lifecycle through the real programs and the real TypeScript clients, with adversarial cases.**

Why this one: it is the only deliverable that (a) requires no owner authority, custody, funding, or approvals, (b) validates exactly the surface the fork harness cannot — the TS-SDK→RPC→BPF wire path, scout/pipeline seams, attestation source wiring, monitor reconciliation — and (c) is a strict prerequisite rehearsal for the first live devnet run (W3). It reuses existing, proven assets: the fork fixtures pipeline (`scripts/fetch_v4_fork_fixtures.mjs`, pool `58oQCh…YQo2`), the rehearsal patterns in `scripts/devnet/local_rehearsal.sh`, the NS-2 ELF artifacts, and the documented custody procedure (`grave-indexer/docs/ORACLE_CUSTODY.md`) — which the harness would exercise verbatim, validating the runbook itself.

Shape (proposed, for approval — no code written):

1. `solana-test-validator` boot: NS-2 program ELFs at the current program IDs; Raydium V4 program + fixture-pool accounts cloned via the existing fetch script; documented Jupiter v6 test stub at the pinned aggregator ID (same stand-in the fork harness uses, clearly labeled); small `--slots-per-epoch` (e.g. 32) so the C6 two-epoch confirmation runs in minutes.
2. Fresh local keys (gitignored, 0600): deployer/authority, activity + launch-price oracles, salvor, holder set. Authority registers the oracles via `update_protocol_config` — the exact `ORACLE_CUSTODY.md` procedure.
3. Happy path driven by the real clients (not fork-harness in-process calls): indexer-style discovery of the fixture pool → `record_launch_price` (real 168 B attestation) → `evaluate_pool_phase_1` (real 112 B attestation) → epoch warp ×2 → `evaluate_pool_phase_2` → real `grave-snapshotter` → fleet-core `prepare`/`simulate`/`submit` in live mode against the local RPC → `SalvageReceipt` → `monitor.reconcile` (40/40/20 ±1 lamport) → `claim_lp_proceeds` ×N → `sweep_dust`.
4. Adversarial cases, each asserting the exact expected error code and zero state movement: ineligible pool (C1/C3), unauthorized attestation signer (6026), replayed salvage (registry `init` failure), duplicate claim (7010), overclaim (7009), expired-cert salvage (7002), paused salvage (7003), tampered snapshot supply (7018).

Explicit honesty boundaries: the conversion leg uses the documented test-only Jupiter stand-in (real-aggregator compatibility remains open, `technical-documentation.md:489`); epoch confirmation uses compressed local epochs (wall-clock epochs only occur in W3). Neither is claimed as validated beyond what it is.

---

## 7. Definition of done and required test evidence for W1

1. **One command** (e.g. `bash scripts/devnet/lifecycle_rehearsal.sh`) runs clean end-to-end from an empty state on a fresh workspace; real exit code 0 recorded.
2. **Machine-readable report** (JSON) emitted at the end: every stage with tx signature, slot, program logs, and asserted events (`EligibilityAnchorWritten`, `EligibilityCertIssued`, `PoolSalvaged`, `SalvageCompleted`, `LpClaimProcessed`); final balances exactly 40/40/20 (±floor rounding per D7); Σ ClaimRecords == registry cumulative == Σ floors recomputed from the artifact.
3. **Every adversarial case** asserts the precise error code (6026/7002/7003/7010/7009/7018, registry-init failure) **and** a before/after balance-invariant check proving zero state movement.
4. **Freshness/provenance honest:** the run report labels the Jupiter stand-in and compressed epochs; no stage is reported "validated" beyond what ran.
5. **CI-able:** runnable headless (like `fork-harness.yml`: nightly + label-gated PR), no secrets required, keys generated ephemeral and never committed.
6. **No drift:** ELFs are the exact NS-2 bytes (sha256 recorded against `DEVNET.md`), program IDs the current ones; any deviation fails loudly.
7. Practical prerequisite (environment, not approval): a Rust/solana toolchain in the workspace to rebuild ELFs, **or** reusing CI-built artifacts (owner PAT would be needed to fetch them — a §8 D5 sub-decision).

---

## 8. Decisions / approvals required from the owner

| # | Decision | Options / consequences |
|---|---|---|
| D1 | **NS-2 authority key custody** (critical path for everything attestation-gated) | (a) key exists in owner custody → run `ORACLE_CUSTODY.md` registration (no redeploy); (b) key lost → approve NS-3 refresh (rehearsed; new program IDs ⇒ mechanical updates already guarded by console regression tests; ~6–8 SOL devnet). No action taken without your approval; no keys generated. |
| D2 | Approve W1 as the next task (as scoped in §6–§7) | Alternative: skip rehearsal and go straight to devnet after D1 — not recommended; it concentrates untested integration risk into the live run. |
| D3 | Approve W1b honesty micro-fixes | Small commit series, no behavior change. |
| D4 | Approve SDK `deriveLastSwapV4` hardening (W4) | Touches the SDK (protocol repo) but changes no wire format — robustness only (ALT lookup tables, versioned txs), with regression vectors; mirrored to salvor-bots in the same coordinated changeset. |
| D5 | Tooling for W1 | (a) install solana CLI + Rust toolchain in this workspace (local build), or (b) fetch CI-built ELFs via your PAT. Either is fine; (a) keeps the session self-sufficient. |
| D6 | Informational | If you want event-level CI verification (trigger → run linkage), it needs an authenticated session at some point; current evidence = green badges + byte-valid triggers + full local battery. |

---

## 9. What is proven vs what remains unverified

**Proven this session (independent evidence):**
- Remote/local repo states and the exact content of all 8 Phase 3 commits; NS-2 program IDs correct in console + regression guards against the retired IDs.
- CI workflow files byte-valid (push/PR on main); badges green; runs exist per push (HTML payload); the long-reported "malformed `ain]` trigger" was a workspace display artifact, not a repository defect.
- Test batteries: console 45/45, indexer 59/59 + typecheck clean (remote head), salvor 354/354, protocol TS 231/231.
- Live devnet: both programs executable, config PDAs owned (252/210 B), DR-001 artifact status, payer funded, epoch timing, and **zero lifecycle accounts** — the lifecycle has never executed on-chain anywhere outside the in-VM fork harness.
- Fork-suite scope read and mapped: ~50 tests over 7 suites covering the full happy path and the adversarial matrix (incl. 6019/7004/7005/7018 floors, pause atomicity, replay defenses, epoch boundary); no `todo!`/`unimplemented!` in programs; non-V4 AMMs fail closed (6007/7017).
- Console honesty state (spot-verified): real snapshot/pulse surfaces correct; three fabricated-looking table values from missing data; "streaming" label on a simulated feed; mobile-hidden global badge; stale READMEs (console + salvor CI claim).

**Unverified / explicitly not claimed:**
- Rust unit + fork suites not executed in this workspace (no toolchain) — evidence is CI badge + repo records + commit messages.
- CI run-level details (event type, job logs) — API rate-limited without token.
- Real Jupiter v6 aggregator behavior — never exercised anywhere (documented stand-in only).
- Any live submission by any bot/fleet component — none has ever occurred (by design, hard-gated).
- Cert-expiry wall-clock crossing on a real cluster; `invalidate_anchor`/`sweep_stale_anchor` under fork conditions; real partial-failure recovery of the fleet pipeline.
- NS-2 authority key custody (unknown; owner-side).
- Snapshot per-holder trust boundary (documented limitation — supply equality does not prove per-holder balances unchanged).

---

### Appendix — verification trail (commands actually run this session)

- Git: `ls-remote` ×4 (remote heads); `fetch` + log diffs (Phase 3 commits); `worktree add` at remote heads for indexer/console; `diff --stat` (chmod-only drift); `ls-tree HEAD vendor/protocol` (submodule pin = `5b84440`).
- Byte-level checks: Python `bytes.count(b'branches: [main]')` vs mangled variant on all six workflow files (display-safe booleans).
- Tests: `bun test` (console, worktree @ `8d9dc3e`); `pnpm test:offline` + `typecheck` (indexer worktree @ `159a244`, vendored SDK = real copy of protocol @ `5b84440`); `pnpm -r build && pnpm -r test` + `pnpm -w test` (salvor @ `cefbed0`: 238 + 116); `pnpm -r build && pnpm -r test` (protocol @ `5b84440`: 231).
- RPC (read-only, api.devnet.solana.com): `getAccountInfo` ×5 (programs + configs + retired), `getEpochInfo`, `getBalance` (payer), `getProgramAccounts` ×2 (account census).
- Source verification (spot-checks): `graveyard.tsx:203/234–253` (unconditional idle-days computation), `shell.tsx:337–339` (hidden badge), `overview.tsx:274` ("streaming"), `adapters/mod.rs` 6007 stub adversary test, `PRE_MAINNET_CHECKLIST` open rows (ORACLE-003 / KEYS-003 / GOV-001 / CPI-006 read verbatim), salvor README "no CI" staleness (count), fleet-ops `cli.ts` (no executor wiring).
