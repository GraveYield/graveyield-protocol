# GraveYield Engineering Handoff — 2026-10-28 · Volume IV

**Pre-W1 state freeze & Lifecycle Rehearsal Harness kickoff**

| | |
|---|---|
| Prepared by | sethoshi.eth — engagement lead (Z.ai session) |
| Prepared for | the protocol owner (sethoshi18) — and the next engineering session |
| Date | 2026-10-28 |
| Scope | State freeze of the whole engagement after the 2026-10-28 documentation push; condensed W1 reconnaissance; next-session execution plan |
| Classification | internal engineering · secret-free by construction (public addresses only; no key material, no tokens) |
| Document family | Vol II — pre-Phase-2 handoff (2026-10-26) · Vol III — Phase 2 handoff (2026-10-26, in `graveyield-protocol/docs/handoffs/`) · **Vol IV — this document** |

---

## 0. How to use this volume

This volume exists because the working thread that produced it has become long, and
the workspace this engagement runs in has a documented history of hard resets that
erase session context (it happened at least twice: it destroyed the pre-Phase-2
worklog, and it destroyed the NS-2 authority key — see §2.4 and §7 B1). If this
session dies, this file plus the repositories must be sufficient to resume without
loss. Read it in this order depending on who you are:

- **A fresh engineering session resuming W1**: read §2 (charter and red lines) →
  §8 (the W1 authorization, verbatim) → §12 (execution checklist) → then the
  condensed reconnaissance in §9–§11. Do not skip §2 or §8: the W1 authorization
  carries mandatory pre-implementation constraints and hard stop conditions.
- **The owner**: §1 is the ten-bullet state summary; §5 is the credential state
  (one action item: rotate the PAT); §6.4 is the decision that still gates all
  devnet progress; §13 lists what was deliberately *not* done.
- **An auditor** (the docs' own "Phase 13" target): §4 and §14 give the evidence
  trail — every load-bearing claim in this volume cites a source that is either a
  repository path, a worklog task with recorded exit codes, or a report already
  committed to `graveyield-protocol/docs/assessments/`.

Two honesty rules govern this document, inherited from the engagement charter:
first, every claim is labeled with how it was verified and when; second, anything
that is a *hypothesis* rather than a verified fact is explicitly marked
**DRAFT — verify at step 0** (this applies to the whole of §10–§11, which are
inputs to W1's mandated reconnaissance, not a substitute for it).

---

## 1. Executive summary

1. **All code is on GitHub and green.** Four repos (`graveyield-protocol`,
   `grave-indexer`, `salvor-bots`, `graveyield-console`) are fully pushed;
   heads as of 2026-10-28: protocol `5a02e47`, indexer `e9109e6`, salvor-bots
   `cefbed0`, console `8d9dc3e`. The indexer pins the protocol as a submodule at
   `vendor/protocol = 5b84440`. CI on the two heads touched this session is
   completed-success (§4.2).
2. **All owner-session work products are now in-repo.** The 2026-10-28 push
   landed the Phase 3 readiness assessment, the 2026-10-27 Next-Milestone
   assessment, the Phase 2 handoff volume (Vol III, docx), and the full
   Oracle-Custody Registration Guide (docx) into the repositories, indexed from
   `graveyield-protocol/docs/README.md` (§4.4).
3. **The project has never executed its own lifecycle on any live cluster.** A
   decisive `getProgramAccounts` census (2026-10-27) shows exactly one account
   per program on devnet — the two ProtocolConfigs. Zero anchors, certs,
   launch prices, registries, receipts, claim records. Everything else is
   fork-tested or simulated (§6.2).
4. **The single hard blocker on devnet progress is B1**: the NS-2
   ProtocolConfig authority key (which was also both oracle signers and the
   upgrade authority) was erased in a workspace reset. Until the owner resolves
   custody (register oracles if the key survives / NS-3 refresh if not), no
   attestation-gated write can succeed on devnet (§7).
5. **W1 is authorized and is the only authorized task.** The owner authorized
   the *Lifecycle Rehearsal Harness* — a one-command, fully local end-to-end
   pass through the real program binaries and the real TypeScript clients, with
   adversarial cases — with eight explicit requirements, seven acceptance
   criteria, a mandatory pre-implementation constraint analysis, and a hard stop
   after W1 (§8). W1 has **not been started** beyond reconnaissance preparation.
6. **W1 needs no owner authority.** It runs on `solana-test-validator` with
   fresh local keys; the authority/oracle roles are minted locally and registered
   via the exact `ORACLE_CUSTODY.md` procedure, so the B1 situation does not
   block it (§10.2). This is also its honest boundary: it validates program
   behavior and client wiring, not the devnet custody situation.
7. **The environment has known gaps that W1 step 0 must resolve**, chiefly: no
   Rust/Solana toolchain in this workspace (ELFs must be rebuilt locally or
   fetched from CI artifacts — owner decision D5), and an unresolved question
   about how to load NS-2 ELFs at the NS-2 program IDs locally when the canonical
   program keypairs' custody is unknown (§11 C1–C2, marked DRAFT).
8. **The off-chain execution stack is built and tested but has never moved a
   real transaction.** Scout runs dry-run only; fleet-core is hard-gated to
   `mode:"live"` and all 354 salvor tests run against fakes; the production
   Scout→executor envelope transport does not exist (B3) (§7, §9.3).
9. **Standing hygiene risks carried forward**: the PAT transited chat on
   2026-10-28 and must be rotated by the owner; workspace restores repeatedly
   re-loosen file modes (chmod-only churn, now cleaned again); a tool-output
   display artifact in this environment truncates the literal `[m` sequence,
   which produced weeks of false "malformed CI trigger" reports — byte-level
   checks are the only authoritative read (§2.4).
10. **One new pre-existing signal needs triage**: a scheduled `fork-harness`
    run on protocol `5b84440` (2026-10-27) concluded `failure`. It predates the
    2026-10-28 push and is unrelated to it (docs-only change), but nobody has
    diagnosed it yet (§4.2).

---

## 2. Continuity, charter and working agreements

### 2.1 Engagement frame

- **Owner and identity**: GitHub user `sethoshi18` (ID `55265644`), display name
  `sethoshi.eth`. All repository commits use the identity
  `sethoshi.eth <55265644+sethoshi18@users.noreply.github.com>`. Pushes are
  executed *as the owner* using an owner-provided PAT under the env-only
  discipline of §5.1. (Exception noted for provenance: the six Phase 3 console
  commits were authored `Z User <z@container>` per the 2026-10-27 assessment —
  cosmetic, recorded in the assessment, not corrected.)
- **Repositories** (all under the `GraveYield` org; indexer and the four-repo set
  are public):
  `graveyield-protocol` (canonical spec + programs + SDK),
  `grave-indexer` (evidence pipeline; pins protocol as submodule),
  `salvor-bots` (execution stack; carries a byte-identical SDK mirror enforced
  by the protocol repo's `sdk-sync-check` CI job),
  `graveyield-console` (Next.js UI),
  `graveyield-site` (exists on the org; no local clone; untouched).
- **Session protocol**: each session opens by reading the handoff volume and
  `/home/z/my-project/worklog.md`; every task appends to the worklog (§2.3);
  every report distinguishes real execution from simulation; every command
  reported must have actually run with its real exit code.

### 2.2 Red lines (standing prohibitions — verbatim in spirit, binding always)

1. **Never generate, recover, or expose production keys.** No mainnet keypair may
   be created, derived, restored, or displayed. Devnet-only disposable keys are
   permitted (the payer in §5.2 is one) and live outside every repository.
2. **No governance changes.** No `update_protocol_config` against the *live
   devnet* deployment, no timelock/multisig actions, no authority transfers.
   (Inside the W1 local validator, governing the *local* deployment with *fresh
   local* keys is precisely the point — that is not a governance change.)
3. **No program deployments to any live cluster.** Local test-validator deploys
   are fine; devnet/mainnet deploys require explicit owner authorization.
4. **No devnet transactions and no fees** except where an owner decision has
   already funded and authorized them (the 2026-10-26 verify-path matrix was
   such a case; nothing new is authorized).
5. **Never weaken existing security checks or modify production behavior to
   make a harness pass.** If the harness fails, the failure is reported, not
   papered over.
6. **Never represent an incomplete harness as full lifecycle validation.** Every
   mocked, stubbed, or compressed boundary must be labeled in the run report.
7. **No mock may silently replace real program execution** in anything claimed
   as lifecycle coverage.

### 2.3 Worklog protocol

The shared worklog is `/home/z/my-project/worklog.md`. It is **append-only**;
each task block starts with a line containing exactly `---` and carries:

```
Task ID: <id>            (global order; parallel work = 2-a, 2-b, …)
Agent: <who>
Task: <what was asked>

Work Log:
- <concrete steps with real exit codes, commit SHAs, file counts>

Stage Summary:
- <key results, decisions, artifacts>
```

Current state through this volume: Tasks 0–11 are recorded (0–1 session open and
clones; 2–5 Phase 2 build-out; 6-6c push runbook + devnet payer + CI fixes;
7-7b live 13/13 matrix + push; 8 custody guides; 9 Phase 3 readiness assessment;
10 P3-A console/indexer real-data pass; 10.1 push + CI verification; 11 the
2026-10-28 documentation push). This volume is accompanied by worklog Task 12.

### 2.4 Workspace fragility notes (read before trusting any observation)

- **Hard resets happen.** At least twice the workspace was destroyed and
  restored from partial artifacts. Assume anything outside Git and outside
  `download/` can vanish: it already erased one worklog and one authority
  keypair. This is why this volume exists and why the owner asked for repo
  landings of all work products.
- **Filemode churn on restore.** Every restore re-loosens file modes
  (100644→100755 across whole trees) with zero content delta. As of 2026-10-28
  all four repos are clean again (verified: `git status --porcelain` = 0 files;
  `git diff --stat` = 0 insertions/deletions). If you see hundreds of "modified"
  files, check `git diff --stat` before believing them; restore with
  `git checkout -- .` only after confirming zero content delta.
- **Tool-output display artifact.** This environment's transport drops the
  two-character sequence `[m` from displayed text, so `branches: [main]` renders
  as `branches: ain]`. This caused a weeks-long false report of malformed CI
  triggers across six workflow files. The byte-level truth (verified 2026-10-27,
  recorded in the Next-Milestone assessment §1.2): **all six workflow files are
  valid**; the Phase 3 commit `8d9dc3e` was right. Treat any bracketed-main
  display anomaly here as suspect and verify with a byte count.
- **pnpm workspace build order.** `salvor-bots` packages cross-reference each
  other's `dist/`; run `pnpm -r build` before `pnpm -r test`. The root SDK
  mirror is tested with `pnpm -w test`. pnpm 9 is installed via
  `npm i -g pnpm@9` if missing.
- **Submodule.** `grave-indexer/vendor/protocol` is a real git submodule pinned
  to protocol `5b84440`; the offline test battery uses it as a real copy. After
  workspace restores, `git -C vendor/protocol checkout -- .` clears its internal
  mode churn (it is currently clean).

---

## 3. Verified repository and CI state (as of 2026-10-28)

### 3.1 Repositories and sync

| Repo | Remote main | Local | Delta | Last change |
|---|---|---|---|---|
| graveyield-protocol | `5a02e47` | same | in sync | 2026-10-28 docs landing (assessments + Vol III handoff + docs index) on top of `5b84440` (Dependabot triage record) |
| grave-indexer | `e9109e6` | same | in sync | 2026-10-28 custody-guide docx landing on top of `159a244` (cluster-split fix); submodule `vendor/protocol = 5b84440` |
| salvor-bots | `cefbed0` | same | in sync | NS-2 fresh devnet deployment — re-key programs (DR-001) |
| graveyield-console | `8d9dc3e` | same* | in sync* | freshness tests (P3-A final commit) — *local clone was 6 behind and was never fast-forwarded locally; remote is authoritative and green |

All four local trees: `git status --porcelain` = 0 entries; only-filemode drift
restored 2026-10-28. The indexer submodule is clean at its pin.

### 3.2 CI state

| Repo @ head | Workflow | Conclusion |
|---|---|---|
| protocol @ `5a02e47` | CI (rust fmt/clippy/test, ts build+test, sdk-sync, anchor build, typecheck, lint, terminology, doc-links) | **success** (run 40633519919) |
| protocol @ `5a02e47` | CodeQL | **success** (run 40633520084) |
| indexer @ `e9109e6` | ci (build + typecheck + offline battery; devnet evidence smoke) | **success** |
| protocol @ `5b84440` | fork-harness (scheduled, 2026-10-27) | **failure — PRE-EXISTING, undiagnosed** |

The fork-harness failure deserves a triage pass (likely fixture-fetch or
toolchain flake; it runs seven fork suites against real mainnet fixtures). It
predates the docs-only push of 2026-10-28 and is not caused by it. Historically
the same workflow's badge was green; nothing in this engagement changed program
code since `5b84440`.

Also verified (2026-10-27, byte-level, see §2.4): all six workflow files across
the repos contain a valid `branches: [main]` filter; the long-reported malformed
trigger was a display artifact, not a defect.

### 3.3 Test batteries (independently re-run 2026-10-27, remote heads)

| Suite | Head | Result | Exit |
|---|---|---|---|
| graveyield-console (`bun test`) | `8d9dc3e` | 45/45 pass | 0 |
| grave-indexer offline battery + typecheck (src+test) | `159a244` | 59/59 pass, clean | 0 |
| salvor-bots workspace packages (7 suites) | `cefbed0` | 238/238 pass | 0 |
| salvor-bots root SDK mirror | `cefbed0` | 116/116 pass | 0 |
| protocol TS workspace (sdk, indexer, ops, adversary) | `5b84440` | 231/231 pass | 0 |
| protocol Rust unit + 7 fork suites | `5b84440` | not runnable in this workspace (no toolchain) — CI-based evidence | — |

### 3.4 Documentation landings (2026-10-28, both commits authored by the owner identity)

- `graveyield-protocol/docs/assessments/` — `phase3-assessment.md`,
  `phase4-assessment.md` (the 2026-10-27 Next-Milestone Assessment), and a
  provenance `README.md`; indexed from `docs/README.md` under "Session
  assessments and handoff volumes" with an explicit *working records, not
  canon* clause.
- `graveyield-protocol/docs/handoffs/GraveYield_Engineering_Handoff_Phase2_2026-10-26.docx`
  — Vol III of this family.
- `grave-indexer/docs/GraveYield_Oracle-Custody_Registration_Guide_2026-10-26.docx`
  — the full 23-page custody walkthrough, cross-linked from
  `docs/ORACLE_CUSTODY.md` ("Full illustrated guide" section).
- Pre-push gates that ran green: `doc-links-lint.sh` (109 relative links
  resolve), `terminology-lint.sh` (no forbidden vocabulary), secret scan over
  markdown and unzipped docx (zero token/key matches), files normalized back to
  mode 100644.

---

## 4. What is real vs simulated today (short form; full matrix in the Next-Milestone assessment §3)

- **Implemented and live-proven (read paths):** devnet deployment + configs;
  indexer discovery/evidence pipeline; verify-path 13/13 live matrix against the
  deployed scanner (2026-10-26 record, `examples/verify-path-report.live.json`);
  SDK read paths and devnet smokes; console Graveyard rendering of a real
  mainnet snapshot and live ProtocolConfig pulse decoding (fail-closed).
- **Implemented and tested, never executed live anywhere:** every
  attestation-gated on-chain write (`record_launch_price`,
  `evaluate_pool_phase_1/2`), the entire salvage path (withdraw CPI, slippage
  ceiling, 40/40/20 settlement, receipts), LP claims, dust sweep, scout
  submission mode, fleet-core live submit (hard-gated), monitor reconcile
  against a real receipt.
- **Simulated:** console fleet feed/KPIs/claims fixtures (labeled; three
  specific label gaps tracked as W1b), the Jupiter leg in tests (documented
  test-only stand-in at the pinned aggregator program ID).
- **Impossible right now:** any attestation-signed on-chain action on devnet —
  both registered oracles equal the erased NS-2 authority key (§7 B1).

---

## 5. Credential and token state

### 5.1 PAT handling runbook (owner-provided token, env-only discipline)

The established, charter-compliant way this engagement pushes to GitHub:

1. Owner pastes the PAT in chat → operator exports it **only** as
   `GH_TOKEN` in the executing shell. It is never printed, never written to
   disk, never embedded in URLs, argv, or git config.
2. Git auth goes through `scripts/git-askpass.sh` (token-free helper that reads
   `GH_TOKEN` from the environment at call time; `Username` → `x-access-token`,
   `Password` → `$GH_TOKEN`), invoked as
   `GIT_ASKPASS=… git -c credential.helper= push <url> main:main`.
3. API reads use `curl -H @-` with the auth header supplied on stdin.
4. Identity gate before any push: `/user` must return `sethoshi18` / `55265644`.
5. After every push: `ls-remote` head must equal local head must equal API head
   (three-way verification), then CI is polled on the pushed SHA.

Reusable scripts from this session: `scripts/survey_repos.sh` (fetch + ahead/
behind + remote heads for all four repos), `scripts/push_docs_2026-10-28.sh`
(identity gate → push → three-way head gate → API author check → CI listing).
Both follow the runbook and never persist the token.

> **⚠️ ACTION REQUIRED (owner): rotate the PAT.** It transited chat on
> 2026-10-28 (and on earlier occasions). Nothing on disk or in any repo contains
> it — the runbook is env-only by construction — but chat transport is not a
> secret channel. Post-rotation, pushes simply wait for the fresh token; the
> runbook is unchanged.

### 5.2 Key inventory

| Key | Where | State | Rules |
|---|---|---|---|
| Devnet payer `8G6nsmrAG3JnQYoPcQzjYpfRgJ2PJJX5AgNPcaodcP6L` | `/home/z/my-project/keys/devnet-payer.json`, mode 0600, outside every repo | funded 0.05 SOL devnet (5× the original requirement); balance verified 2026-10-27 | devnet-only; never commit; re-check `chmod 600` after any workspace restore (restores keep re-loosening it) |
| NS-2 authority key (= both oracle signers + upgrade authority, `AsB5u…EWXa`) | **erased** in the 2026-10-26 workspace reset | unknown custody — owner decision D1 | never regenerate/re-key without owner decision (§7 B1) |
| Canonical NS-2 program keypairs (scanner/vault deploy keys) | unknown in this workspace (`local_rehearsal.sh` looks in `${GY_DEVNET_KEYS:-$HOME/my-project/devnet-keys}`) | custody unverified — W1 step 0 item | never fabricate; if absent, W1 uses the local-build or loader path (§11 C1) |
| W1 fresh local keys | to be minted by the harness into a temp dir, gitignored, 0600, discarded | not yet created | ephemeral by design; nothing persists |

---

## 6. Devnet deployment and economics (NS-2)

### 6.1 Coordinates (all public, verified live 2026-10-27)

| Object | Address | Notes |
|---|---|---|
| GraveScanner program | `CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54` | executable, BPF-loader-owned |
| GraveVault program | `Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg` | executable |
| scanner ProtocolConfig PDA | `Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD` | 252 bytes, scanner-owned |
| vault ProtocolConfig PDA | `hyKk983fguE2CGA5Dx5TLKfBft1AJrm7CHoe1PTUipS` | 210 bytes, vault-owned |
| Retired DR-001 scanner | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` | still on-chain, historical artifact only |
| Devnet payer | `8G6nsmrAG3JnQYoPcQzjYpfRgJ2PJJX5AgNPcaodcP6L` | 0.05 SOL |

Console constants and regression tests pin the NS-2 IDs (Phase 3 guards fail
loudly on the retired ones); indexer defaults match.

### 6.2 The decisive census

`getProgramAccounts` on both programs (2026-10-27): exactly **one account per
program** — the two ProtocolConfigs. Zero EligibilityAnchor, EligibilityCert,
LaunchPrice, PoolRegistry, SalvageReceipt, ClaimRecord accounts exist. **The
lifecycle has never executed on-chain** — not one stage of it — anywhere outside
the in-VM fork harness. This is the fact that motivates W1 (rehearse locally)
and W3 (first controlled devnet run, separately authorized).

### 6.3 Epoch pacing

Epoch 1193 at verification time; 432,000 slots/epoch ≈ 2–4 days wall clock per
epoch on devnet. The C6 two-epoch confirmation (`MIN_EPOCH_CONFIRMATION=2`) is
therefore ~4–6 days of wall clock on real devnet — W1 compresses this with
`--slots-per-epoch` (e.g. 32) so the boundary runs in minutes locally; W3 pays
the real wait. Fork tests prove the boundary (6016 at gap 1, pass at exactly 2).

### 6.4 Cost ledger

- **W1 costs nothing**: local validator, airdropped local SOL, no live-cluster
  writes, no infrastructure.
- **W2/D1 path (a)** (key survives → register oracles): one 80-byte
  `update_protocol_config` transaction; rent-free; payer funded.
- **W2/D1 path (b)** (NS-3 refresh): rehearsed scripts exist; devnet-only cost
  ≈ **6–8 SOL of rent**; produces new program IDs requiring mechanical updates
  already guarded by console regression tests.
- **W3**: devnet pool creation + salvage → modest rent/fees on devnet only.

---

## 7. Blocker register (restated for W1 scoping)

**Critical (gates devnet progress, NOT W1):**

- **B1 — NS-2 ProtocolConfig authority key erased.** One keypair was, at
  initialize: config authority for both programs, both oracle signers, and
  program upgrade authority. Consequences while unresolved: no
  `update_protocol_config` on the live deployment (oracle registration 9.5
  cannot execute); no valid C1/C2 attestations can verify on devnet (6026 on
  every submission); no authority pause/unpause; no upgrades. Owner decision D1:
  (a) key in owner custody → execute `grave-indexer/docs/ORACLE_CUSTODY.md` as
  written; (b) key lost → approve NS-3 refresh. **No session may attempt any
  re-key, regeneration, or governance action on the live deployment.**
- **B2 — No registered oracle keypair** (subsumed by B1): the positive-path
  verify case ends 6026 by design until registration; scout submission mode
  requires `ACTIVITY_ORACLE_KEY`.

**Integration gaps (must close before/at fleet operation; not W1 blockers):**

- **B3 — Scout→executor transport missing.** Envelope format exists and is
  validated, but nothing in production converts `ScoutOpportunity` →
  `OpportunityEnvelope` or carries it; every `buildEnvelope` call site is a
  test; `wireFleet` wires Scout+Monitor only.
- **B4 — Production attestation source missing.** fleet-core's
  `LocalAttestationSource` is tests + devnet drill; the intended indexer oracle
  service has no client.
- **B5 — `deriveLastSwapV4` robustness** (ALT / version-1 transactions):
  activity derivation failed for 11 of 12 enriched pools in the Phase 3
  snapshot; caps attestation yield on mainnet-like data. Tracked as W4
  (protocol changeset + salvor mirror sync).
- **B6 — Shared `FleetStore` / lease fencing (finding F5):** single-process
  only; expired-lease takeover unfenced. Tracked as W5.

**Pre-mainnet tracked rows (safe to wait):** KEYS-003 (custody-generated
mainnet keypairs), GOV-001 (timelock wiring decision — currently deliberately
unwired, 7014 never raised), ORACLE-003 (custody/rotation drills outstanding),
CPI-002…008 (non-V4 AMMs — v1.1), LOCKER-002, KEYS-002, NS-8 (doc corrections),
NS-9 (IDLs not committed), SDK npm publish. W1b (console honesty micro-fixes)
remains approved-in-principle, unstarted.

---

## 8. The W1 authorization (verbatim, from the owner, this thread)

> **Proceed with W1: Lifecycle Rehearsal Harness**, based on the 2026-10-27
> Next-Milestone Assessment. This is an implementation authorization for W1
> only. Do not begin W2 or W3.
>
> **Objective:** Build a reproducible, single-command local end-to-end
> rehearsal harness that uses the real deployed program binaries (appropriate
> local-validator setup) and the real TypeScript SDK/client paths, and includes
> adversarial testing.
>
> **Requirements:**
> 1. Inspect the existing fork harnesses, local rehearsal scripts, deployment
>    scripts, SDK builders, scanner, vault, indexer, and Salvor client
>    interfaces before designing anything new.
> 2. Reuse existing infrastructure and fixtures wherever possible; do not
>    duplicate settlement logic or create a second implementation of the
>    protocol.
> 3. Define exactly which lifecycle stages the harness can rehearse, which need
>    oracle authorization, and which cannot be tested due to the missing
>    authority key.
> 4. Cover the happy path and the relevant negative cases: unauthorized
>    operations, illegal lifecycle transitions, replay attempts, duplicate
>    claims, accounting invariants, transaction atomicity.
> 5. Use deterministic fixtures and document all preconditions; do not
>    silently substitute mocks for real program execution.
> 6. Clearly distinguish: real program execution vs mocked RPC vs stubbed
>    Jupiter vs off-chain simulation.
> 7. Never generate, recover, or expose production keys; attempt no governance
>    changes; deploy no programs; submit no devnet transactions; incur no fees.
> 8. Do not weaken existing security checks or modify production behavior to
>    make the harness pass.
>
> **Acceptance criteria:**
> 1. A documented, reproducible single command from a clean checkout.
> 2. The harness uses real program binaries and real TS client paths for every
>    stage it claims to cover.
> 3. Explicit assertions for both success and adversarial cases.
> 4. Assertions verify expected account state changes, balance conservation,
>    and atomic rollback where applicable.
> 5. Every mocked or untested boundary is documented.
> 6. Existing test suites remain green.
> 7. A final report lists: files changed, commands, exit codes, test results,
>    known limitations, and the exact lifecycle stages validated.
>
> **Before implementation, identify any technical constraint that prevents a
> genuinely end-to-end local rehearsal and propose the smallest valid
> alternative. Do not represent an incomplete harness as full lifecycle
> validation.**
>
> **Stop after W1 and report the evidence.** W2 requires a separate owner
> decision, and W3 remains unauthorized until the local validation results and
> authority situation have been reviewed.

Supplementary definition of done (from the assessment the owner authorized
against, §7 of that document): machine-readable JSON run report with per-stage
tx signature, slot, program logs and asserted events
(`EligibilityAnchorWritten`, `EligibilityCertIssued`, `PoolSalvaged`,
`SalvageCompleted`, `LpClaimProcessed`); final balances exactly 40/40/20
(± D7 floor rounding); Σ ClaimRecords == registry cumulative == Σ floors
recomputed from the snapshotter artifact; adversarial cases assert the precise
error code (6026/7002/7003/7010/7009/7018, registry-init failure) **and** a
before/after balance-invariant check proving zero state movement; headless-CI-
able; ELFs sha256-pinned against `docs/DEVNET.md`; tooling decision D5
(install toolchain vs fetch CI artifacts) to be settled at step 0.

**Status: W1 has NOT been started.** What exists so far is the reconnaissance
preparation in §9–§11 of this volume — explicitly *inputs* to the mandated
step-0 inspection, not its replacement.

---

## 9. Condensed reconnaissance — the reuse map (W1 requirement 1 input)

Everything below exists at the current heads and is a candidate for direct
reuse. Paths are relative to each repo root. This map was assembled from the
2026-10-27 deep-dives plus this session's verification; the next session must
re-verify the load-bearing entries at step 0 before designing (requirement 1).

### 9.1 graveyield-protocol (programs, SDK, fork harnesses, devnet kit)

| Asset | Role | W1 relevance |
|---|---|---|
| `scripts/devnet/local_rehearsal.sh` | Boots `solana-test-validator`, mints throwaway deployer/intruder keys, deploys both ELFs via the production `deploy_devnet.sh`, initializes both ProtocolConfigs via `protocol_admin.mjs init-all`, runs pause/intruder-reject/unpause drills. Fully self-cleaning (mktemp + trap). | **The boot/teardown pattern to copy.** ⚠️ Its deploy path (`solana program deploy`) requires program keypairs matching the ELFs' embedded `declare_id!` and refuses without them (exit 2) — see constraint C1. |
| `scripts/devnet/deploy_devnet.sh` | Production deploy script (build → identity check → deploy → fund guards). | Reused verbatim by the rehearsal script; the identity-check behavior is the thing W1 must either satisfy (keypair custody) or route around (validator loader flags — C1, DRAFT). |
| `scripts/devnet/protocol_admin.mjs` | `init-all` (both ProtocolConfigs) + `drill` (pause/intruder/unpause) + `decodeProtocolConfig` readback at pinned offsets. | Config initialization and readback verification for the local deployment. |
| `scripts/build_fork_harness.sh` | Builds scanner/vault/jupiter_v6_stub ELFs (`cargo build-sbf`), copies to `tests/fixtures/`, fetches mainnet fixtures, runs **all seven** fork suites. | The canonical build+run pipeline; also the proof that the Jupiter stand-in is built from `programs/grave-vault/tests/jupiter_v6_stub/`. |
| `scripts/fetch_v4_fork_fixtures.mjs` | Pulls REAL mainnet Raydium V4 state + program ELFs (pool `58oQCh…YQo2`), cross-validates every account against authoritative layouts (AmmInfo 752 B offsets, Serum MarketState), writes `*.bin` + `manifest.json`; fails loudly on mismatch; fixtures gitignored (multi-MB). | **Deterministic-fixture source** (requirement 5). The manifest's cross-validation is the determinism guarantee to inherit. |
| `programs/grave-vault/tests/*_fork.rs` (7 suites, ~50 tests) | raydium_v4 (withdraw CPI wire), jupiter_conversion (route vetting/slippage/orientation), settlement_economics (40/40/20 + D7/D6), lp_claim (merkle/double-claim), full_lifecycle, scanner_windows (attestation windows/replays/oneshot), security_negative (on-chain negatives). | The behavioral oracle for W1: every happy-path and adversarial expectation W1 asserts on a live validator has a fork-tested precedent to match against. |
| `programs/grave-vault/tests/jupiter_v6_stub/` | Test-only Jupiter v6 stand-in at the pinned aggregator program ID. | The conversion leg stand-in (boundary to label — C3). |
| `sdk/src/*` | The real TS client: `client.ts` (program ID constants incl. devnet strings + PublicKey forms in `config`), `instructions.ts`, `discriminators.ts`, `pdas.ts`, `borsh.ts`, `accountDecoders.ts`, `certifyAndSalvage.ts`, `salvagePool.ts`, `lastSwapAttestation.ts` (112 B C1) + `launchPriceAttestation.ts` (168 B C2), `snapshot.ts`, `simulation.ts`, `priorityFee.ts` (charter fee guard), `merkle.ts`, `raydiumV4.ts` + `raydiumV4Constants.ts`, `web3compat.ts`. | **The "real TS client path" W1 must drive** (requirement 2) — the harness calls these builders against the local RPC, never in-process program invocations. |
| `sdk/test/fakeRpc.ts`, `sdk/test/devnetSmoke.test.ts` | Existing test plumbing patterns. | Shape reference for the harness's RPC-facing layers. |
| `adversary/` (8 suites) + `ops/` (scenarios, vault observer, health) | Offline adversarial battery + ops tooling. | Adversarial expectation source (requirement 4); `ops` scenarios may seed harness case structure. |
| `indexer/`, `snapshotter/` (Rust crates) | On-chain indexer + snapshot builder (merkle tree, artifact). | The **real snapshotter** runs as a local binary in the happy path (assessment §6 step 3). |
| `Anchor.toml`, `rust-toolchain.toml` (1.91.1) | Build config. | Needed only if the toolchain path (D5-a) is chosen. |
| `docs/DEVNET.md`, `docs/ORACLE_PIPELINE.md`, `docs/technical-documentation.md:489`, `docs/PROTOCOL_SPEC.md`, `docs/ADVERSARY.md`, `docs/PRE_MAINNET_CHECKLIST.md` | Deployment record (ELF sha256s, NS-2), oracle pipeline + §6.4 key-erasure record, Jupiter stand-in documentation, frozen spec, threat taxonomy, checklist. | DEVNET.md is the sha256 pin source for requirement "no drift"; ORACLE_PIPELINE §2.3 documents the as-implemented 6024/6025/6026 check order. |

### 9.2 grave-indexer (evidence pipeline + custody runbook)

| Asset | Role | W1 relevance |
|---|---|---|
| `src/evidencePath.ts` + `src/sign.ts` | The verify-path harness: 13-case matrix (6 verifier-level + 7 program-level), `resolvePayerKeypair` (`PAYER_KEY_FILE`, custody rules mirroring `ORACLE_KEY_FILE`), `signLaunchPriceMessage` (168 B) vs `signAttestationMessage` (112 B, cross-format use throws). | **The existing model for "real TS client against a real program with exact-error assertions"** — W1's adversarial cases mirror its structure, pointed at the local validator instead of devnet. |
| `src/config.ts` | `ORACLE_IS_REGISTERED` (declared, not consumed — decorative), program-ID overrides, key-file resolution. | Step-0 note: W1's local run WILL consume real registration, so the flag's decorativeness must not leak into harness logic. |
| `src/discovery.ts` + `src/activityLive.ts` | Pool discovery + activity derivation (`deriveLastSwapV4`, ALT/v1 gap B5). | Discovery stage realism; the ALT/v1 yield gap shapes fixture selection (C5). |
| `src/consoleSnapshot.ts` | Phase 3 typed, secret-free, fail-closed snapshot contract. | Pattern reference for machine-readable run reports (acceptance criterion 2/7). |
| `docs/ORACLE_CUSTODY.md` (+ full docx guide) | The 4-step registration procedure: offline 0600 keygen → 80-byte `update_protocol_config` registration → `ORACLE_KEY_FILE` → verify-path acceptance. | **W1 executes this procedure verbatim against the local deployment** (fresh local authority + oracles) — validating the runbook itself. |
| `docs/ORACLE_PIPELINE.md` | As-implemented oracle interface, §6.4 key-erasure record, §8.3 ALT limitation. | Constraint citations for the matrix. |
| `examples/verify-path-report.live.json` | The green 13/13 live report (2026-10-26). | Report schema precedent. |

### 9.3 salvor-bots (execution stack)

| Asset | Role | W1 relevance |
|---|---|---|
| root `src/` | Byte-identical SDK mirror (enforced by protocol CI `sdk-sync-check` — any divergence fails). | If W1 changes SDK code (it should not), the mirror must be synced in the same coordinated changeset. |
| `scout/` | Discovery → prefilter → admission (hard/soft refusals) → submission builders; dry-run mode live-proven; submission mode never run. | W1 exercises scout submission builders against the local validator where they bind to real stages (C2 boundary for the queue→executor seam). |
| `fleet-core/` | The full engine: `pipeline.ts` (prepare/simulate/submit), hard `mode:"live"` gate, `LocalAttestationSource`, `estimator.ts`, `revalidate.ts`, `policy.ts`, `route.ts`, `raydiumAccounts.ts`, 15-state lifecycle, at-most-once admission. All 238 tests against `FakeConnection`. | **The salvage executor W1 drives in `mode:"live"` against the local RPC** — the first-ever non-fake submit path execution. |
| `fleet-ops/` | Wires Scout + Monitor (`wireFleet`); no executor wiring (B3). | Defines the seam W1 does NOT cover; harness drives fleet-core directly. |
| `monitor/` | Reconcile receipts (40/40/20 ±1 lamport checks). | Settlement verification stage of the happy path. |
| `conservative/`, `experimental/`, `sniper/` | Strategy packages (offline-tested). | Out of W1 scope; do not wire. |
| Build order | `pnpm -r build` **before** `pnpm -r test` (dist cross-references); root mirror via `pnpm -w test`. | Environment precondition (§2.4). |

### 9.4 graveyield-console (consumer; honesty gaps)

| Asset | Role | W1 relevance |
|---|---|---|
| `src/lib/gy/data.ts` | NS-2 program IDs + PDA regression guards. | Program-ID ground truth for harness constants. |
| Snapshot loader + Graveyard/pulse surfaces | Fail-closed real-data rendering. | None directly (W1 emits its own report); W1b's honesty fixes remain unstarted. |

---

## 10. DRAFT lifecycle-stage × testability matrix (verify at step 0 — requirement 3 input)

**DRAFT — verify at step 0.** Classification logic: on the local validator, the
harness mints a **fresh local authority** and registers **fresh local oracle
keys** via the exact `ORACLE_CUSTODY.md` procedure — so "needs oracle
authorization" stages become locally executable, and the *missing devnet
authority key (B1) blocks nothing locally*. What remains non-rehearsable locally
is driven by physics (real Jupiter, wall-clock epochs) and by the missing
production seams (B3/B4), not by key custody.

| # | Lifecycle stage | Locally rehearsable (real ELF + real TS client) | Needs oracle auth | Blocked by missing authority key | Boundary to label |
|---|---|---|---|---|---|
| 1 | Validator boot + program load at NS-2 IDs | DRAFT yes (loader path C1 vs keypair path) | — | no | ELF provenance (sha256 vs DEVNET.md) |
| 2 | ProtocolConfig initialize (`init-all`) | yes | — | no (fresh local authority) | none |
| 3 | Oracle registration (`update_protocol_config`, 80 B) | yes — exercises ORACLE_CUSTODY.md verbatim | authority (fresh local) | no | runbook validation, not devnet custody |
| 4 | Candidate discovery + evidence (indexer path) | partial (fixture pool; read-only RPC) | — | no | mainnet fixture freshness; B5 yield gap |
| 5 | `record_launch_price` (168 B C2 attestation) | yes | launch-price oracle (fresh local) | no | — |
| 6 | `evaluate_pool_phase_1` (112 B C1 attestation → anchor) | yes | activity oracle (fresh local) | no | — |
| 7 | C6 two-epoch confirmation | yes (compressed `--slots-per-epoch`) | — | no | **compressed epochs ≠ wall-clock epochs** |
| 8 | `evaluate_pool_phase_2` (→ eligibility cert) | yes | activity oracle | no | cert-expiry crossing not provable in-VM (inherited) |
| 9 | Snapshotter run (merkle artifact) | yes (real `grave-snapshotter` binary) | — | no | snapshot trust boundary (documented) |
| 10 | Vault salvage — withdraw CPI (Raydium V4) | yes (fixture pool accounts) | — | no | fixture pool is a mainnet clone, frozen state |
| 11 | Vault salvage — Jupiter conversion leg | yes with **stub** | — | no | **test-only Jupiter stand-in; real aggregator never exercised** |
| 12 | Settlement + receipts (40/40/20, D7/D6) | yes | — | no | — |
| 13 | `monitor.reconcile` (±1 lamport) | yes | — | no | — |
| 14 | `claim_lp_proceeds` ×N (merkle) | yes (fresh local holders) | — | no | — |
| 15 | `sweep_dust` | yes | — | no | — |
| 16 | Pause / intruder-reject / unpause drills | yes (via `protocol_admin.mjs drill`) | authority | no | — |
| 17 | Squads timelock / multisig governance | **no** | — | no | GOV-001 unwired; no Squads program locally — out of scope, documented |
| 18 | Anything against the LIVE devnet deployment | **no — unauthorized** | — | **yes (B1)** | devnet custody situation is W2's subject, not W1's |

Adversarial cases to assert (each: exact error code + zero-state-movement
balance check, per the DoD): unauthorized attestation signer (6026, and the
6025 sig-placement pin per `ORACLE_PIPELINE.md` §2.3 check order), ineligible
pool (C1/C3 variants), replayed salvage (PoolRegistry `init` failure),
duplicate claim (7010), overclaim (7009), expired-cert salvage (7002), paused
salvage (7003), tampered snapshot supply (7018), illegal transitions
(cert-before-anchor, salvage-before-cert), plus atomicity checks (failed
salvage leaves no partial PDA state — "no PDA survives the revert").

---

## 11. DRAFT constraint analysis — candidates for "smallest valid alternative" (verify at step 0)

**DRAFT — hypotheses with proposed resolutions, to be confirmed or replaced by
the mandated step-0 inspection.** The W1 authorization requires this analysis
*before implementation*; the next session owns the verdicts.

- **C1 — Program identity vs keypair custody (the sharpest one).**
  `local_rehearsal.sh`'s deploy path (`solana program deploy` via
  `deploy_devnet.sh`) requires program keypairs matching the ELFs' embedded
  `declare_id!` (NS-2 IDs); their canonical keypair files' custody in this
  workspace is unverified. *Candidate smallest alternatives:* (a) load the
  NS-2 ELFs directly with `solana-test-validator --bpf-program <ID> <so>` /
  `--upgradeable-program` (loader flag places the program at the given address
  without the deploy keypair — **verify this flag's exact semantics for
  upgradeable programs at step 0**); or (b) rebuild ELFs locally with fresh
  local program IDs (requires toolchain — C2 — and yields new IDs, weakening
  the "exact NS-2 bytes at NS-2 IDs" DoD); or (c) locate the canonical
  keypairs (`GY_DEVNET_KEYS` / `$HOME/my-project/devnet-keys` world) if the
  owner holds them. Preference order as it stands: (a) > (c) > (b).
- **C2 — No Rust/Solana toolchain in this workspace** (verified 2026-10-27:
  cargo/anchor/solana CLI absent). Owner decision D5: (a) install the
  toolchain (self-sufficient; heavier setup) or (b) fetch CI-built ELF
  artifacts with the owner PAT (lighter; adds a CI-artifact dependency and a
  token touchpoint). If (a), pin versions to `rust-toolchain.toml` (1.91.1) +
  Solana CLI 3.0.10 / platform-tools ≥ v1.54 per `build_fork_harness.sh`.
- **C3 — Real Jupiter v6 aggregator cannot run locally** (needs live mainnet
  routing state). *Smallest alternative (already the fork harness's own
  answer):* the documented `jupiter_v6_stub` at the pinned aggregator program
  ID, labeled as a stub in every run report. Real-aggregator compatibility
  stays an open item (never claimed as validated).
- **C4 — The Scout→executor seam does not exist** (B3). W1 therefore drives
  fleet-core's pipeline directly (the real executor) and exercises scout's
  submission builders where they bind to real stages; the queue→handoff
  transport itself is out of harness scope and documented as untested-by-W1.
  Do not build the transport to make the harness look end-to-end — that is W5
  work with an owner decision behind it.
- **C5 — `deriveLastSwapV4` ALT/version-1 yield gap** (B5; 11/12 pools failed
  activity derivation in the Phase 3 snapshot). The harness must not depend on
  the broken path for determinism: either select/construct fixture pool state
  whose activity derives, or feed attestations directly (the indexer path
  stays covered by its own suite). Labeled either way.
- **C6 — Fixture logistics.** Fork fixtures are gitignored multi-MB ELFs +
  account bins with a cross-validating `manifest.json`. The harness should
  reuse `fetch_v4_fork_fixtures.mjs` (network read-only, no cost) and fail
  loudly on manifest mismatch; determinism comes from the manifest, not from
  committing binaries.
- **C7 — Snapshotter as a real binary.** The happy path calls for the real
  `grave-snapshotter` crate binary; step 0 must confirm it builds/runs in the
  chosen toolchain path and can target a local RPC URL (its `rpc.rs` accepts
  an endpoint — verify).

---

## 12. Next-session execution checklist (W1, ordered)

1. **Open**: read this volume; read the worklog tail; verify the four repos'
   status (expect: in sync with §3.1 heads, clean trees; if not, stop and
   diff).
2. **Step 0 — mandated inspection** (requirement 1): walk the §9 reuse map,
   confirming each load-bearing entry at the current head; resolve C1–C7 with
   verdicts; produce the **final** lifecycle-stage matrix (replacing §10's
   draft) and the final constraint statement. Present nothing for approval —
   the authorization is already given — but record everything in the worklog.
3. **Tooling decision D5**: pick and set up the ELF path (loader flags vs
   toolchain install); record sha256 of every ELF used against `DEVNET.md`.
4. **Design the harness** as a thin orchestrator over reused assets
   (requirement 2): one command, e.g.
   `bash scripts/devnet/lifecycle_rehearsal.sh` (name free, location should
   follow the repo's existing `scripts/devnet/` convention); stages per §10
   rows 1–16; adversarial cases per §10's list; JSON run report per the DoD.
5. **Implement** in the protocol repo (it owns programs + SDK + devnet kit),
   with salvor-bots imports where fleet-core/monitor are driven — mind the
   `sdk-sync-check` CI job and the workspace build order. Keys: minted at run
   time into mktemp dirs, 0600, never committed (requirement 7).
6. **Self-verify** (acceptance criteria): run the single command from a clean
   state; then re-run all existing suites (protocol TS 231, salvor 354,
   indexer 59, console 45; Rust suites if toolchain available) — requirement
   that everything stays green; secret-scan the diff; run the repo linters if
   docs changed.
7. **Stop and report** (stop condition): evidence report with files changed,
   commands, exit codes, test results, known limitations, the exact validated
   stage list, and the real-vs-mock boundary table. **Do not begin W2 or W3.**
8. If the session ends mid-work: the worklog + this volume are the recovery
   anchors; commit nothing partially — partial harness state lives in the
   worktree, documented in the worklog.

---

## 13. Evidence appendix — the 2026-10-28 session (commands actually run)

- Survey: `scripts/survey_repos.sh` — for each of 4 repos: `git branch -vv`,
  `ls-remote`, `fetch --prune`, `rev-list --left-right --count main...origin/main`
  → result: 0 local-only commits everywhere; indexer 0/2, console 0/6 behind;
  remote heads authoritative (§3.1). Submodule check: gitlink `5b84440`, dir
  dirty from mode churn only → cleaned.
- Hygiene: `git checkout -- .` in all four repos + submodule after verifying
  `git diff --stat` = 0 insertions/deletions (filemode churn only);
  `chmod 600 keys/devnet-payer.json` (restore had re-loosened it).
- Secret scans over the docx/md set (including unzipped `word/document.xml`):
  zero matches for token/private-key/seed patterns. Handoff Vol III sniff:
  "secret-free by construction" confirmed; custody guide's only marker is the
  workspace key path already public in `ORACLE_CUSTODY.md`.
- Lints (protocol, pre-commit): `doc-links-lint.sh` → "checked 109 relative
  link target(s) … ok", exit 0; `terminology-lint.sh` → ok, exit 0.
- Commits (identity `sethoshi.eth <55265644+sethoshi18@users.noreply.github.com>`):
  protocol `5a02e47` "docs: land session assessment reports + Phase 2 handoff
  volume" (5 files, +355, incl. two docx binaries); indexer `e9109e6`
  "docs(custody): land full Oracle-Custody Registration Guide (docx)" (2 files,
  +8) — indexer commit rebased onto `origin/main` (`159a244`) for a clean
  fast-forward; no force-push anywhere.
- Pushes via `scripts/push_docs_2026-10-28.sh` (env-only token, askpass,
  identity gate `sethoshi18/55265644`): `5b84440..5a02e47 main->main` exit 0;
  `159a244..e9109e6 main->main` exit 0. Three-way head gate (ls-remote == local
  == API) passed for both; API author check passed for both.
- CI polls (authenticated): protocol @ `5a02e47` → CI success (run
  40633519919), CodeQL success (run 40633520084); indexer @ `e9109e6` → ci
  success. Pre-existing scheduled `fork-harness` failure on `5b84440`
  (2026-10-27) observed and flagged, not diagnosed (§3.2).
- Deliberately not pushed: `keys/` (secret), `scripts/` workspace plumbing,
  live `worklog.md`, transport bundles (`grave-indexer-phase2.bundle`,
  `phase2-tree.zip`), `download/grave-indexer-examples/` (already in-repo),
  `download/README.md` (placeholder).

---

## 14. Source-document index (where every fact lives)

| Fact cluster | Canonical source |
|---|---|
| Engagement charter, red lines, session protocol | Vol III (`graveyield-protocol/docs/handoffs/GraveYield_Engineering_Handoff_Phase2_2026-10-26.docx`) §2 |
| Phase 2 build-out, live 13/13 matrix, payer funding, custody guides | worklog Tasks 6–8; `grave-indexer/docs/ORACLE_PIPELINE.md`; `grave-indexer/docs/ORACLE_CUSTODY.md` (+ docx) |
| Phase numbering collision + P3-A scoping | `graveyield-protocol/docs/assessments/phase3-assessment.md` |
| Post-Phase-3 verified state, coverage matrix §3, blockers §4, roadmap §5, W1 shape §6, DoD §7, decisions §8 | `graveyield-protocol/docs/assessments/phase4-assessment.md` (the 2026-10-27 Next-Milestone Assessment) |
| P3-A execution record (6 console + 2 indexer commits, CI green) | worklog Tasks 10, 10.1 |
| 2026-10-28 push evidence, lints, CI runs | worklog Task 11; §13 of this volume |
| Devnet coordinates + ELF sha256 pins | `graveyield-protocol/docs/DEVNET.md` |
| Oracle check order (6024/6025/6026 as implemented) | `grave-indexer/docs/ORACLE_PIPELINE.md` §2.3 |
| Fork-suite behavioral expectations | `graveyield-protocol/programs/grave-vault/tests/*.rs` + `tests/README.md` |
| W1 authorization verbatim | §8 of this volume (owner message, this thread) |
