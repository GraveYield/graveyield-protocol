# GraveYield — Authoritative NS-3 Baseline Report

> **Date:** 2026-11-17 · **Status:** Authoritative current-state baseline
> **Supersedes:** [`BASELINE_REPORT.md`](BASELINE_REPORT.md) (2026-10-24) as the
> current-state reference. The October report is **preserved unchanged** as a
> historical record of the NS-1/NS-2 era; nothing in it has been edited or
> retracted by this report.
> **Method:** documentation and evidence reconciliation only. All five
> repositories were inspected at their current `main` HEAD on 2026-11-17
> (exact SHAs in §3). No Rust, TypeScript, or configuration source was
> modified; no program was built or deployed; no on-chain transaction was
> executed. Every on-chain value quoted here is a committed, previously
> recorded deployment-evidence artifact re-verified against the repositories —
> not a new RPC observation — except where explicitly marked otherwise.

---

## 1. Executive Summary

### What GraveYield actually is

GraveYield is a Solana-first DeFi infrastructure project creating a
**deterministic lifecycle for abandoned liquidity**: two on-chain programs
(GraveScanner — eligibility certification; GraveVault — settlement), a
TypeScript SDK, an oracle-evidence indexer pipeline, a salvor-bot fleet, an
operations console, and a public site. The canonical term for the recovery
operation is **salvage**; the project's forbidden synonym family for it is
banned repo-wide and enforced by `scripts/terminology-lint.sh`.

### The one-paragraph answer

As of 2026-11-17, GraveYield has **built and deployed** the two core programs
on Solana Devnet (deployment generation **NS-3**, executed by the owner on
2026-11-12, accepted 56/56 the same day, independently re-verified 14/14 on
2026-11-15), with the deployed ELF bytes cryptographically pinned to the
repository's provenance manifest. It has **implemented and test-proven** (at
host-unit, fork-simulation, and local-rehearsal levels) the full eligibility
→ certification → salvage → claim machinery, the oracle attestation schemes,
the SDK, an indexer evidence pipeline, a five-role salvor fleet, and an
operations console. It has **not** executed a single end-to-end salvage on
any cluster, **has no** hosted oracle operations, **has not** completed a
security audit, and **is not** on mainnet. The devnet deployment is
operationally frozen by design discipline (owner-held custody, owner-executed
writes) rather than by a lost key — unlike NS-1 and NS-2.

### Final verdict

- **Genuinely complete:** the NS-3 deployment, initialization, oracle
  registration, and governance drills (56/56 + 14/14 recorded evidence);
  the deployed-ELF provenance pin discipline (fail-closed CI gate, byte-equal
  rebuilds); the Phase 0 documentation truth passes across all five repos
  (PR #111 protocol, #3 indexer, #4 salvor-bots, #12 console, #2 site);
  the SDK single-source-of-truth discipline (byte-identical mirror, CI-enforced).
- **Partially complete:** end-to-end lifecycle exercise (proven only in fork
  simulations and the local W1 rehearsal — never against the live devnet
  deployment); indexer evidence-path verification (13/13 recorded run is
  NS-2-era; program-level subcases self-skip without a funded payer);
  console alignment (audit corrections A1–A6/B1–B2 exist only on an unmerged
  branch; lifecycle integration is design-only); public documentation lineage
  (GY-DOC-RECON-001 is an unmerged draft with 21 open questions).
- **Outstanding:** first live end-to-end salvage; hosted oracle operations
  (ORACLE-003); security audit; mainnet custody and key ceremony; several
  owner decisions (§11).
- **Frozen-baseline assessment:** the *deployment and provenance* baseline is
  frozen and internally consistent — the ELFs on devnet are byte-pinned, the
  pins are CI-enforced, and deliberate change requires a reviewed re-pin PR
  plus an owner redeployment. The *project* baseline is not frozen in the
  sense of "nothing left to do": eight register items are deferred, blocked,
  or awaiting owner decisions (§10). Moving to the next roadmap milestone
  requires, at minimum: (1) owner disposition of PR #13 (console corrections)
  and PR #104 (alignment report), (2) the first owner-gated end-to-end devnet
  exercise against NS-3, and (3) the ORACLE-003 runbook before any scheduled
  oracle operation.

---

## 2. Scope, Methodology, and Evidence Standards

### 2.1 What this report did

- Cloned all five repositories at their current `main` HEAD (2026-11-17) and
  inspected source, docs, tests, CI workflows, and committed evidence
  artifacts directly (not from summaries).
- Fetched the full pull-request history of all five repos (100 most recent
  each), open issues, and the workflow-run status of every HEAD.
- Read the complete W2 NS-3 acceptance record set
  (`docs/w2-ns3-acceptance/`), the independent read-only verification record
  (2026-11-15), the decision register (`docs/DECISIONS.md`), the legacy
  deployment record (`docs/LEGACY_DEPLOYMENTS.md`), the pre-mainnet
  checklist, and the provenance manifest.
- Fetched the unmerged draft report `docs/GY-DOC-RECON-001_ALIGNMENT_REPORT.md`
  from PR #104's head branch (`5f71258454cae7bbee11417ec6f4a32817f3b762`),
  because it is **not on `main`** — it exists only as an open, explicitly
  do-not-merge review artifact (§11).
- Reconstructed the Phase 0 reconciliation register (P-01…P-09) from the
  applied-then-partially-reverted commit `3eac25b` ("docs(programs):
  reconcile stale deployment/governance comments…"), the final PR #111 diff,
  and the PR #111 description; the register has no separate committed file.
- Verified the salvor-bots SDK mirror byte-equality directly
  (`diff -rq salvor-bots/src graveyield-protocol/sdk/src` → identical).

### 2.2 Evidence standards applied

1. **Direct verification** — a fact this inspection established from the
   working tree or GitHub API at the recorded HEAD (e.g. `declare_id!`
   values, file existence, CI conclusions, byte-equality of the SDK mirror).
2. **Committed evidence artifacts** — previously recorded deployment/CI
   evidence committed to the repositories (e.g.
   `docs/w2-ns3-acceptance/evidence/verify_acceptance_post_deployment.txt`).
   These are quoted as recorded; this report did not re-run the verifiers or
   re-read the cluster.
3. **Claims from existing documentation** — statements taken from README/docs
   at HEAD. Where a claim could not be corroborated by (1) or (2), it is
   labeled as a documentation claim, not a verified fact.

### 2.3 What this report deliberately does not claim

- No mainnet deployment, production custody, or operational oracle service.
- No completed security audit (the only open issue, #23, is unsolicited
  audit-firm outreach, not an engagement record).
- No end-to-end salvage operation: none has ever run on devnet or elsewhere
  (stated by the W2 acceptance record, the 2026-11-15 independent
  verification, and the public site itself).
- No claim that deployment acceptance proves protocol operation.

---

## 3. Repository and Commit Baseline

All SHAs below were read from `origin/main` on 2026-11-17 and re-confirmed
against the GitHub API branch endpoint. CI conclusions are from the GitHub
Actions API for each recorded HEAD.

| Repository | HEAD commit (main) | Commit date (UTC) | HEAD subject | CI at HEAD |
|---|---|---|---|---|
| `graveyield-protocol` | `e0f86b202786a6316243f7937ed075d93882ba7c` | 2026-11-16T20:45:55Z | Merge PR #111 (docs/phase0-recon-comments) | CI #362 success; CodeQL #350 success; Code Quality #140 success; `fork-harness` success on PR #111 head `046fca0c` |
| `grave-indexer` | `93ce7897837e09c21056cfe8d070a55411b77194` | 2026-11-16T22:44:36Z | Merge PR #3 (docs/phase0-recon-indexer) | `ci` #19 success |
| `salvor-bots` | `080c15c449d3095e90e3b29db38b3e585db1ebc5` | 2026-11-16T22:24:27Z | Merge PR #4 (docs/phase0-recon-readme) | CI #17 success |
| `graveyield-console` | `31b08d263fa5d0ef5dc052d1671af92a5b505a01` | 2026-11-14T16:38:06Z | Merge PR #12 (docs/phase2-implementation-report) | CI #31 success; Vercel success |
| `graveyield-site` | `fd9eb69a1711bc0764e82c627750964a38d2daf0` | 2026-11-15T09:58:59Z | Merge PR #2 (docs: align site with current NS-3 protocol state) | No GitHub Actions in repo; Vercel success |

### Merged PRs that define this baseline

| Repo | PR | Merged (UTC) | Content |
|---|---|---|---|
| protocol | #111 | 2026-11-16T20:45:55Z | Phase 0 reconciliation PR-1: P-01/P-04/P-05/P-06 addressed; P-02/P-03/P-08/P-09 and the Rust-source parts of P-07 **deferred** by owner decision (deployed ELF provenance stays authoritative); DEVNET.md §1 deferral note added |
| protocol | #110 | 2026-11-15T06:12:53Z | NS-3 deployment/acceptance record reconciliation; committed the 2026-11-15 independent read-only verification record |
| protocol | #105 | 2026-11-14T04:41:04Z | IMPL-001 Phase A — canonical Raydium V4 last-swap evidence (D4/D5) in the core SDK (+5,124/−87 across 24 files) |
| protocol | #103 | 2026-11-12T19:58:27Z | W2 NS-3 post-deployment acceptance report (56/56) |
| protocol | #100 | 2026-11-11T14:14:51Z | Fork suites can no longer silently skip or fabricate measurements |
| protocol | #99 | 2026-11-11T03:49:07Z | Bounded fail-closed execution for the NS-3 provenance checker (issue #98 teardown-hang workaround) |
| protocol | #89 | 2026-11-07 | Reproducible read-only deployed-ELF digest verifier (`verify_ns3_elf_digests.mjs`) |
| protocol | #84 | 2026-11-06T03:12:20Z | W1 NS-3 lifecycle rehearsal — 16 stages + adversarial battery, local approved-hash ELF pipeline |
| protocol | #83 | 2026-11-05 | Fail-closed ELF deployment provenance on every deploy path + read-only acceptance verifier |
| protocol | #82 | 2026-11-05T03:40:28Z | CI anchor build aligned with the deployment ELF provenance (arch + pinned platform-tools) |
| protocol | #80 | 2026-11-04T21:18:15Z | NS-3 (DR-002) identity synchronization, keypair-free build path, oracle-registration tooling |
| protocol | #78/#79 | 2026-11-03 | NS-2 frozen as legacy (DR-002); NS-3 path recorded |
| indexer | #2 | 2026-11-14T10:02:03Z | IMPL-001 Phase B — indexer consumes the canonical SDK last-swap evidence; `vendor/protocol` pinned to `2a8aac19` (PR #105 merge) |
| indexer | #3 | 2026-11-16T22:44:37Z | Phase 0 reconciliation — documentation truth pass (I-01…I-06) |
| salvor-bots | #2 | 2026-11-04 | NS-3 identity re-sync + test-vector fixes (BL-4) |
| salvor-bots | #3 | 2026-11-14T06:56:52Z | SDK mirror synced to IMPL-001 Phase A |
| salvor-bots | #4 | 2026-11-16T22:24:27Z | Phase 0 reconciliation — README/CI-comment truth pass (S-01…S-05) |
| console | #9/#10 | 2026-11-04 | NS-3 identity re-pin; NS-2 retired |
| console | #12 | 2026-11-14T16:38:07Z | Phase 2 implementation report + lifecycle integration design (**docs only**) |
| site | #1 | 2026-11-04 | "deployment PENDING" → accurate preparation language |
| site | #2 | 2026-11-15T09:59:00Z | Site aligned with the NS-3 deployed state |

### Open PRs and issues (as of 2026-11-17)

- **protocol #104 (OPEN, draft, do-not-merge):** GY-DOC-RECON-001
  consolidated documentation & specification alignment report — one file,
  `docs/GY-DOC-RECON-001_ALIGNMENT_REPORT.md` (+2,396 lines), revision 5
  (2026-11-14). Not on `main`; its 21 owner questions (Q-01…Q-21) are
  **open**, not resolved (§11).
- **protocol dependabot:** #109 (@solana/web3.js 3.1.1→3.2.1), #108
  (prettier), #107 (typescript-eslint), #94 (eslint) — open, unmerged.
- **protocol issue #98 (open):** investigation record — NS-3 Node.js
  provenance-CLI stdout hang; root cause confirmed at mechanism level
  (Node v24.22.2 `process.exit()` teardown deadlock); mitigated in production
  by PR #99's bounded fail-closed wrapper.
- **protocol issue #23 (open):** unsolicited security-audit services
  solicitation (2026-05-30). No audit engagement is recorded anywhere.
- **indexer, salvor-bots, console, site:** no open issues; no open PRs.

---

## 4. Protocol Architecture and Implementation Status

All statements in this section are from direct source inspection at
`e0f86b2` unless labeled otherwise.

### 4.1 GraveScanner (`programs/grave-scanner/`)

- **Program ID (source-verified):** `declare_id!("EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL")`
  (`src/lib.rs:51`).
- **Implemented instructions (8):** `initialize`, `record_launch_price`,
  `evaluate_pool_phase_1`, `evaluate_pool_phase_2`, `invalidate_anchor`,
  `sweep_stale_anchor`, `update_protocol_config`, `emergency_pause`
  (`src/lib.rs:59-129`).
- **Eligibility model:** six criteria C1–C6 evaluated in the spec's
  cheapest-first order (`src/criteria.rs`); threshold defaults pinned in
  `src/constants.rs` (inactivity 7,776,000 s = 90 d; price collapse
  9,900 bps = ≥99 %; min TVL 500,000,000 raw quote-side units; LP-burn dust
  threshold 1,000 raw units; anchor staleness 14 d; cert TTL 3,600 s; epoch
  confirmation ≥ 2). Two-phase certification: Phase 1 anchors, Phase 2
  re-derives at least two epochs later with an identical criterion bitmap
  (`init_if_needed` D10 cert lifecycle per `Cargo.toml`).
- **Oracle evidence:** C1 = indexer-signed 112-byte Ed25519 activity
  attestation, C2 = oracle-signed 168-byte launch-price attestation; both
  verified in-transaction via the `ed25519_program` precompile
  (`src/attestation.rs`; ORACLE-001/ORACLE-002 retired in
  `docs/PRE_MAINNET_CHECKLIST.md`). C1 freshness re-anchored to `SlotHashes`
  (~512-slot window); C2 is replay-proof by init-once PDA design.
- **Adapters:** Raydium V4 fully implemented
  (`src/adapters/raydium_v4.rs` — canonical 752-byte AmmInfo parse, WSOL-side
  7019 guard). Raydium CLMM, Orca Whirlpool, PumpSwap, and Meteora adapters
  are **placeholders** gated by `UnsupportedAmm`/placeholder ID per the live
  checklist rows CPI-002/003/004/005 and KEYS-001 — not implemented (v1.1).
- **Locker introspection:** UNCX Raydium V4 locker only (LOCKER-001 retired,
  verified against live mainnet state per checklist); LOCKER-002
  (PinkSale/Team Finance/Streamflow) **not implemented** — such pools are
  treated as unlocked (⬜ tracking row).
- **Known stale source comments (deferred corrections):** the NS-3 program-ID
  block at `src/lib.rs:46` still reads "deployment and on-chain acceptance
  are PENDING" — factually stale since 2026-11-12; correction P-02 deferred
  for ELF-provenance reasons (§9.1).

### 4.2 GraveVault (`programs/grave-vault/`)

- **Program ID (source-verified):** `declare_id!("7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya")`
  (`src/lib.rs:63`).
- **Implemented instructions (6):** `initialize`, `update_protocol_config`,
  `emergency_pause`, `salvage_pool`, `claim_lp_proceeds`, `sweep_dust`
  (`src/lib.rs:70-114`).
- **Settlement economics:** canonical 40 % LP holders / 40 % salvor / 20 %
  protocol split (`src/constants.rs`: 4_000/4_000/2_000 bps); protocol share
  ceiling 2,000 bps enforced in bytecode (config update above it reverts
  7005); priority-fee ceiling default 1,000,000,000 lamports; slippage
  ceiling default 300 bps with a hard max of 1,000 bps and tighten-only
  override (SLIP-001 retired); Jupiter dust threshold default 666,666
  lamports. LP-holder proceeds live in a per-pool bucket whose only debit
  path is Merkle-verified claims (`claim_lp_proceeds`, proof convention
  byte-locked with the SDK and snapshotter).
- **Salvage path:** `salvage_pool` executes the full atomic flow —
  eligibility-cert freshness gates, Raydium V4 withdraw CPI (22-account
  ordering proven against real mainnet bytecode by the fork harness),
  optional Jupiter v6 conversion leg with route-account vetting (CPI-011
  closed), slippage floor before the CPI (7007), receipt with 40/40/20 +
  retained-dust record, one settlement per pool (init-once `PoolRegistry`).
  Orientation is derived from the pool's own mints; exactly one side must be
  WSOL, else 7019 before any CPI (CPI-010 retired).
- **Dust handling (D6 policy, DUST-001 retired):** below-threshold memecoin
  residuals recorded on `SalvageReceipt`; permissionless one-shot
  `sweep_dust` moves them to the protocol treasury ATA, closes the vault
  memecoin ATA (7020 empty / 7021 second-sweep guards); the LP-holder bucket
  is untouched by design.
- **Fail-closed stubs (verified at source):** `src/cpi/raydium_clmm.rs`,
  `src/cpi/orca_whirlpool.rs`, `src/cpi/pump_swap.rs` all revert with
  `AmmCpiUnimplemented` (7017) — CPI-006/007/008 are not implemented (v1.1).
- **Known stale source comments (deferred corrections):** the NS-3 block at
  `src/lib.rs:55` still reads "PENDING" (P-03 deferred); instruction doc
  comments still present "Multisig-only (Squads v4 3-of-5)" / "Multisig +
  72h timelock" as if enforced (P-08 deferred); the vault charter header
  still presents bytecode-enforced invariants and process commitments as one
  list (P-09 deferred). See §9.1.

### 4.3 Protocol SDK (`sdk/`, package `@graveyield/sdk` v0.2.0)

- 22 TypeScript modules: `GraveYieldClient` with eight top-level operations
  (`evaluatePool`, `recordLaunchPrice`, `phase1`, `phase2`,
  `snapshotLpHolders`, `buildMerkleTree`, `certifyAndSalvage`,
  `claimLpProceeds`), IDL-free Anchor instruction builders (hand-rolled
  discriminators + borsh), 12 PDA derivations, protocol/account decoders,
  error mirror (Scanner 6000–6034; Vault 7000–7021), Charter fee policy +
  `derivePriorityFeePlan`, canonical Raydium V4 evidence classification
  (`raydiumV4Evidence.ts`, IMPL-001 Phase A), simulation wrappers.
- **Workspace package, not published to npm.** `sdk/PUBLISH.md` states the
  package is publish-ready and awaits owner npm credentials.
- **Single source of truth discipline:** `salvor-bots/src/` is a byte-identical
  vendored mirror (verified directly this session: `diff -rq` → identical);
  CI job `sdk-sync-check` fails on any divergence (`.github/workflows/ci.yml:150`).
- Known mirror gap: the on-chain vault error enum pins 7000–7022
  (`errors.rs` self-tests) while the SDK mirror stops at 7021 — open
  documentation-sync item Q-14 in the draft alignment report.
- Known stale docblock (newly recorded here): `sdk/src/client.ts:90-96`
  still says NS-3 "Deployment and on-chain acceptance are PENDING" — stale
  since 2026-11-12; fixing it requires a coordinated protocol + salvor-bots
  mirror PR (CI byte-equality) and is **out of scope** for this
  documentation-only task (register G-07).

### 4.4 Supporting components in the protocol repo

- **`indexer/`** (in-repo workspace package): discovery pre-filter, scoring,
  candidate queue, tracking, and a `submit.ts` path that holds
  `ACTIVITY_ORACLE_KEY` env custody — overlaps the dedicated
  `grave-indexer` repo; consolidation/retirement is open owner decision Q-05.
- **`ops/`** (Phase 11 services): indexer service, vault observer, Merkle
  service, alerting, health, and scenarios SC-01/SC-02 (runbook
  `docs/OPS.md`).
- **`snapshotter/`** (Rust): LP-holder snapshot pipeline → sealed
  `SnapshotArtifact` with Merkle root + per-holder proofs; tree convention
  bit-locked against the on-chain `verify_proof` (SNAPSHOT-001 retired).
- **`adversary/`**: 15 threat classes, 39 tests (Phase 12 battery).
- **Devnet tooling (`scripts/devnet/`):** three execution modes
  (agent local rehearsal on 127.0.0.1 / owner-executed deployment /
  agent read-only verification), `deploy_devnet.sh` with fail-closed
  identity + funding + provenance gates, `protocol_admin.mjs`,
  `verify_ns3_deployment.mjs` (29 checks), `verify_ns3_elf_digests.mjs`
  (27 checks), `ns3_check_provenance.mjs`, `ns3_verify_elf.mjs`,
  `ns3_derive_pdas.mjs`, `ns3_identities.mjs`, and the W1 16-stage
  lifecycle rehearsal harness.

---

## 5. NS-3 Devnet Deployment Baseline

All values below are from the committed acceptance evidence
(`docs/w2-ns3-acceptance/W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md`,
`evidence/verify_acceptance_post_deployment.txt`,
`evidence/verify_elf_digests_post_deployment.txt`), the 2026-11-15
independent verification record
(`docs/w2-ns3-acceptance/INDEPENDENT_READONLY_VERIFICATION_2026-11-15.md`),
and source cross-checks. Cluster re-reads were **not** performed for this
report.

### 5.1 Deployment identity

| Item | Value |
|---|---|
| Generation | **NS-3** (DR-002 refresh) — the active deployment |
| Network / cluster | Solana **Devnet** — `https://api.devnet.solana.com` |
| Genesis hash (pinned) | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Deployment date | **2026-11-12** (deploys 16:40–16:42 UTC; oracle registration 18:25 UTC, `getBlockTime` per PR #110 record) |
| GraveScanner program ID | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` (deploy slot 521,526,224) |
| GraveVault program ID | `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya` (deploy slot 521,526,300) |
| GraveScanner ProtocolConfig PDA | `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe` (seeds `["protocol_config"]`, bump 255; init slot 521,526,590) |
| GraveVault ProtocolConfig PDA | `5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda` (seeds `["protocol_config"]`, bump 255; init slot 521,526,710) |
| ProgramData (scanner) | `FxYDhTruh16EoKBgiJaWZCQ9QojWQZGS8J1dXyfSt9dG` |
| ProgramData (vault) | `9wyRhAC8Sasb46bhWW4jxsK6rGKpEGXf6Riz2ibKZgC4` |
| Deployer / fee payer / **initial upgrade authority** | `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` (owner custody; single key — **not** rotated to multisig) |
| Governance authority (ProtocolConfig, both programs) | `BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5` |
| Activity oracle (C1, registered) | `2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o` |
| Launch-price oracle (C2, registered) | `97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee` |
| Oracle registration scope | **GraveScanner only** — the record explicitly claims no separate GraveVault oracle registration (W2 §5) |

Deployment / initialization / registration transaction signatures (recorded
in W2 §5; all confirmed `meta.err = null` by the 2026-11-15 independent
verification):

| Operation | Signature |
|---|---|
| GraveScanner deployment | `4ZPJW8sZubvLcoMa6KK8MDJFChcgx61BMt7hhSfMXvEkyGwMhSmJYTfsehE2b2LZg73k65WaJaL6B71WG6JjBXQ8` |
| GraveVault deployment | `7jV6Ao2uDycUrZ8KTpKyxWpvetewwaChvUYCTE58jYsVFwvVaUnf5rBp5rD57VFQJos5wEg7WaXopw1aybKDqCG` |
| GraveScanner ProtocolConfig init | `27buHLDqnsagD7YMvEopQsxW6v3Uy6PraXEUp8yeMStCXZT6q1zpixrN6aR2NNA33EdXdBoWAmmnPMQFEmH3nrik` |
| GraveVault ProtocolConfig init | `36WE4ZhLNNLfJGfhuxaze5n8KNu2RP3FMBvCexV1vpmtShFuvDTRbjuqiYqWQykFvNcXBhGBYSpmGD1WauBToraL` |
| GraveScanner oracle registration | `3US6jRzFC3yrx9qaqPMaVajEVcMdjau7eNKgpXrYwVGNrX73ESaQBXdGSUJyfCptaF7KhGCJgCqQnCyYGfAEfw5Z` |

### 5.2 ProtocolConfig configuration (approved defaults)

The W2 verifier checked both config accounts against "approved-default"
values; the 2026-11-15 independent decode confirms "spec-default values" at
252 B (scanner) / 210 B (vault). The code-pinned defaults
(`programs/grave-scanner/src/constants.rs`, `programs/grave-vault/src/constants.rs`)
are: scanner — inactivity 7,776,000 s; collapse 9,900 bps; min TVL
500,000,000 raw units; LP dust 1,000; anchor staleness 1,209,600 s; cert TTL
3,600 s. Vault — 4,000/4,000/2,000 bps; priority-fee ceiling 1,000,000,000
lamports; slippage 300 bps (hard 1,000); Jupiter dust 666,666 lamports;
timelock field 259,200 s. Scanner `paused = false`, vault
`emergency_paused = false` at acceptance and at the 2026-11-15 read.

### 5.3 Governance authority and custody status (the honest form)

- The governance authority is the **initial and permanent ProtocolConfig
  authority** of both programs; `register-oracle` re-pointed the two scanner
  oracle signer fields from the initialization authority to the dedicated
  keys (DEVNET.md "Authority arrangement (NS-3, honest form)").
- `pending_authority` / `pending_authority_eta` / `timelock_seconds` are
  **reserved write-only state — not an enforced authority transfer and not
  an enforced timelock**; no on-chain instruction reads them and error 7014
  is never raised (W2 INFO items 1–2; `docs/PRE_MAINNET_CHECKLIST.md` GOV-001).
- The **upgrade authority remains the single deployer key** for both NS-3
  programs. Nothing constrains future upgrades except owner custody
  discipline. The "72h timelock" language anywhere in the docs refers to the
  planned Squads governance process, never to on-chain enforcement.
- Program keypairs live in owner custody outside git; no key material is
  committed anywhere (verified by the October baseline's repo-wide scan and
  by the deploy script's refuse-paths; no contrary evidence found at HEAD).

### 5.4 Governance drills (recorded, 2026-11-12)

| Test | GraveScanner | GraveVault |
|---|---|---|
| Governance pause / paused readback | PASS | PASS |
| Unauthorized pause attempt | Rejected — `Unauthorized (0x1770)` | Rejected — `Unauthorized (0x1b58)` |
| Governance unpause / final state | PASS — `paused = false` | PASS — `emergency_paused = false` |

These drills establish the tested pause/unpause/unauthorized behavior only;
the acceptance record itself states they are not a comprehensive
authorization assessment.

### 5.5 Legacy generations (NS-1, NS-2) — historical records

| Generation | Deployed | Scanner / Vault | Authority | Status |
|---|---|---|---|---|
| NS-1 | 2026-10-09 | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` / `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` | `GCCuhCXd…68yk` — dead (DR-001) | Frozen static reference; current on-chain status not established in the legacy record |
| NS-2 | 2026-10-25 | `CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54` / `Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg` | `AsB5u…EWXa` — permanently lost (DR-002) | Confirmed deployed and executable; superseded; authority not revoked on-chain |

Both remain present on devnet (W2 INFO items 3–6). Their sole record home is
[`LEGACY_DEPLOYMENTS.md`](LEGACY_DEPLOYMENTS.md); they are never deployment
targets. The 2026-10-24 [`BASELINE_REPORT.md`](BASELINE_REPORT.md) audited
the NS-1 deployment and produced the blocker register (B1–B9) and the
fresh-deployment decision chain (DR-001 → NS-2 → DR-002 → NS-3); it is
retained unchanged as the historical root of this lineage.

---

## 6. ELF Provenance and Verification Evidence

### 6.1 Approved pins

Single source: [`../scripts/devnet/provenance.manifest.json`](../scripts/devnet/provenance.manifest.json)
(schema `graveyield.provenance/1`), consumed by both `deploy_devnet.sh` and
the CI fail-closed gate:

| Artifact | SHA-256 (pinned = deployed) | Deployed size |
|---|---|---|
| `target/deploy/grave_scanner.so` | `e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98` | 321,056 B |
| `target/deploy/grave_vault.so` | `8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83` | 361,528 B |
| platform-tools v1.54 tarball (linux-x86_64) | `fcc41631c7f77561bf5412218bf297501dccf030ea280f338f0ace2aab9f31e` | — |

Toolchain pins: SBPF v0 (`e_machine 263`, `e_flags 0`), Solana CLI 3.0.10,
platform-tools v1.54, host Rust 1.91.1 (`rust-toolchain.toml`), Anchor
1.2.2 (`anchor-lang`/`anchor-spl` per `Cargo.toml` + `Anchor.toml`), Node 24,
pnpm 9.12.0. `scripts/check-toolchain.sh` verifies all five toolchain pins.

### 6.2 Verification procedure and recorded evidence

1. **Fail-closed build gate (CI, every anchor build):**
   `ns3_check_provenance.mjs` rebuilds and refuses any digest drift from the
   manifest (PR #83/#82; workflow step "Verify ELF deployment provenance").
   On the current `main` tree the rebuild is byte-identical to the pins
   (PR #111 verification record).
2. **Structural ELF identity:** `ns3_verify_elf.mjs` asserts the expected
   NS-3 program IDs in the allocated sections and the absence of NS-1/NS-2
   ID bytes (`OK scanner: STRUCTURAL` / `OK vault: STRUCTURAL` per PR #111).
3. **Post-deployment digest verification (owner-run, 2026-11-12):**
   `node scripts/devnet/verify_ns3_elf_digests.mjs --url https://api.devnet.solana.com`
   → **27/27 PASS** at finalized slot 521,557,485 (epoch 1207). Committed
   artifact: `docs/w2-ns3-acceptance/evidence/verify_elf_digests_post_deployment.txt`.
4. **Deployment acceptance (owner-run, 2026-11-12):**
   `node scripts/devnet/verify_ns3_deployment.mjs …` → **29/29 PASS** at
   finalized slot 521,557,300 (epoch 1207). Committed artifact:
   `evidence/verify_acceptance_post_deployment.txt`. Combined acceptance
   record: **56/56, 0 failed, 0 unverified**.
5. **Independent read-only re-verification (2026-11-15):** ad-hoc plain
   JSON-RPC (genesis/epoch/account/transaction/blocktime only) → **14/14** at
   finalized slot 522,363,929 (epoch 1209), including fresh SHA-256 of both
   deployed payloads matching the pins. Recorded verbatim in
   [`w2-ns3-acceptance/INDEPENDENT_READONLY_VERIFICATION_2026-11-15.md`](w2-ns3-acceptance/INDEPENDENT_READONLY_VERIFICATION_2026-11-15.md).
   Recorded limitation: the raw per-check transcript was not retained; the
   PR #110 description is the surviving record.

**Whether the deployed digests match the approved pins: yes** — verified at
acceptance (27/27) and re-verified independently (2026-11-15). The manifest
at HEAD pins exactly the deployed values; the interim re-pin that recorded
never-deployed digests (`ae777eb3…7004b` scanner / `6fd86675…6199c` vault,
commit `9a75e39`) was withdrawn in `677aab6` before merge, and PR #111
restored the manifest byte-for-byte to `main`'s state.

### 6.3 What ELF verification does and does not establish

Matching digests prove the deployed bytes equal the approved build outputs.
They do **not** prove the authenticity of every transitive build dependency
or the manifest's original trust anchors (W2 §8 scope limitation), and they
are **not** evidence of any protocol operation. The verifier's "digest_match"
semantic after any future source change without redeployment is honestly
"right shape, wrong bytes" until an owner redeploys (DEVNET.md §1).

### 6.4 The verification ladder (do not conflate these)

| Level | Evidence | Status |
|---|---|---|
| Deployment acceptance | W2 29/29 (slot 521,557,300) | Recorded, PASS |
| ELF digest verification | W2 27/27 (slot 521,557,485) + 2026-11-15 re-check | Recorded, PASS |
| Read-only on-chain verification | 14/14 independent (slot 522,363,929, 2026-11-15) | Recorded, PASS |
| Structural checks | `ns3_verify_elf` STRUCTURAL ×2; fork-suite skip-integrity contract (PR #100) | Implemented, green in CI |
| Program-level simulations | 7 fork suites against real mainnet Raydium V4/OpenBook/token bytecode in `solana-program-test` (CI `fork-harness`, success on PR #111 head); W1 16-stage lifecycle rehearsal + adversarial battery on `solana-test-validator` with throwaway keys (PR #84/#85/#86; `docs/w1-post-merge/W1_POST_MERGE_VERIFICATION.md`: "16 stages + adversarial battery all green", zero-movement invariant proved) | Implemented, green |
| **Actual end-to-end protocol operation on the live deployment** | **None.** No `EligibilityAnchor`, `EligibilityCert`, `LaunchPrice`, `PoolRegistry`, `SalvageReceipt`, or `ClaimRecord` account exists on devnet; no salvage has ever been executed (W2 §9 scope limitations; 2026-11-15 limitation: "No end-to-end salvage lifecycle has occurred on Devnet") | **Not achieved** |

---

## 7. Cross-Repository Implementation Status

### 7.A `graveyield-protocol`

Covered in §4. Summary status:

| Component | Implementation status | Verification status |
|---|---|---|
| GraveScanner (8 instructions) | Implemented | Host tests (128 lib tests per PR #111 record) + fork windows + live acceptance of config/drills; evaluation path never exercised on devnet |
| GraveVault (6 instructions) | Implemented | Host tests (40) + 7 fork suites incl. full lifecycle against real mainnet bytecode; settlement path never exercised on devnet |
| SDK v0.2.0 | Implemented (workspace; unpublished) | 185 tests per PR #111 record incl. live-devnet smoke; byte-mirror CI-enforced |
| In-repo `indexer/` package | Implemented (overlap with dedicated repo) | 34 tests; consolidation decision open (Q-05) |
| `ops/` services | Implemented | 47 tests; scenarios run read-only |
| `snapshotter/` | Implemented | 53 tests; byte-locked Merkle convention |
| `adversary/` battery | Implemented | 39 tests |
| Devnet tooling + provenance gates | Implemented | devnet-tools 410 tests per PR #111 record; gates green in CI |
| Rust-source comment truth (P-02/03/08/09, P-07 source parts) | **Deferred** — stale comments remain at scanner `lib.rs:46`, vault `lib.rs:55`, instruction doc comments, charter header | N/A — deliberately not applied (§9.1) |

### 7.B `grave-indexer` (`93ce7897`)

- **Purpose:** Raydium V4 pool discovery (mainnet, read-only) and oracle
  evidence pipeline producing attestations byte-compatible with the on-chain
  GraveScanner contract (ORACLE-002). README is explicit that committed live
  verification artifacts record the **NS-2** identities and that the matrix
  re-runs against NS-3 "once the live oracle path is exercised".
- **Implemented (16 `src/` modules, direct inspection):** raw JSON-RPC
  `getProgramAccounts` discovery with identity-slice mode and a 7019-guard
  classification (`discovery.ts`; ~706,002-account mainnet corpus in the
  committed live artifact); durable ingestion ledger with
  new/duplicate/changed/conflict/staleness states and fail-closed conflict
  exclusion (`ingest.ts`); provenance primitives with endpoint redaction
  (`provenance.ts`); canonical last-swap derivation wrapping the SDK's
  `deriveLastSwapEvidenceV4` with TTL cache, incomplete-refresh rule,
  regression detection, and an attestation admission gate
  (`activityLive.ts`, IMPL-001 Phase B); evidence bundles and issuance
  (`evidence.ts`, `issue.ts`, `sign.ts`); an off-chain mirror of the on-chain
  check order 6024–6031 (`verify.ts`); append-only replay journal
  (`journal.ts`); the 13-case live verification matrix with deployment-state
  gating and honest `skipped` reporting (`evidencePath.ts`); deployment-state
  classification (`deploymentState.ts`); console snapshot artifact with
  honest criteria (only C1/C3 derivable; C2/C4/C5/C6 stay "pending");
  health registry; CLI (`discover | collect | verify-path | health |
  console-snapshot`). **No transaction is ever sent** — the only
  chain-mutating primitive is `simulateTransaction`.
- **SDK pin:** `vendor/protocol` git submodule → `2a8aac191d5c3e53beaf82977b04bd79385e8954`
  (the IMPL-001 Phase A merge, PR #105). Bare clones must init submodules.
- **Testing:** 126 offline `node:test` cases + 3 `DEVNET_RPC_URL`-gated
  devnet smoke tests (counts verified statically against README's claim).
  CI runs `build-and-test` plus a `devnet-smoke` job with the public devnet
  RPC; a scheduled daily evidence smoke (cron 06:11 UTC) runs `verify-path`
  and mainnet discovery **only if the corresponding secrets are configured** —
  whether they are configured is not verifiable from the repos (open
  question Q-09 in the draft alignment report).
- **Evidence-path honesty (must not be overstated):** the committed 13/13
  PASS, 0-skipped matrix artifact (`examples/verify-path-report.live.json`)
  is the **2026-10-26 NS-2-era run**. Under CI conditions the program-level
  batch self-skips ("skipped — unfunded payer (no airdrop requested; faucet
  is strict opt-in)") and `allPass` is computed over the 6 verifier-level
  cases only. **No committed artifact shows the full matrix running against
  NS-3.**
- **Limitations recorded in-repo (`docs/ORACLE_PIPELINE.md` §8):** program
  cases need a funded payer; SDK derivation robustness (unresolved ALT
  lookups / v1 transactions cause candidate skips — 3 of ~17 candidates
  issued bundles in the reference run; fix belongs to the protocol SDK);
  eligibility vs validity split (the pipeline proves evidence validity, not
  pool eligibility).
- **Truth-pass residuals found by this inspection (register G-13/G-14):**
  `SUBMIT=1` is documented in comments as an opt-in send path but no such
  code exists; `ORACLE_IS_REGISTERED` is parsed in `config.ts:132` and
  advertised by the CLI help but never consumed; `docs/ORACLE_PIPELINE.md`
  §8 item 2 retains pre-registration framing ("until a dedicated oracle key
  is registered…") although §2.5 records that registration executed
  2026-11-12; the ledger's provenance view hard-codes
  `cluster: "mainnet-beta"` / `endpointKind: "public-rpc"` regardless of the
  actual discovery endpoint.

### 7.C `salvor-bots` (`080c15c4`)

- **Implemented (direct inspection):** five bot roles over a shared engine —
  Scout (discovery/enrich/pre-filter/score/queue/phase-1 submission/monitor;
  never salvages), Conservative (reference executor), Sniper (urgency-ordered
  executor), Experimental (risk-capped sandbox executor), Monitor/Risk
  (read-only receipt verifier — no keys, no builder, no submission path) —
  plus a fleet service runner (`fleet-ops`) and the shared `fleet-core`
  engine (single `StrategyExecutor` orchestration, 992-line
  `ExecutionPipeline`, lease-based `FleetStore`, 15-state lifecycle).
  Executors are **dry-run by default with a hard throw** on non-live submit;
  live mode additionally requires a signer and explicit `liveEnablement`
  with no env-only bypass.
- **SDK integration:** all packages consume `@graveyield/sdk` as a workspace
  dependency whose `src/` is the byte-identical mirror (verified). No npm
  dependency.
- **Coordination reality:** in-memory only — single-process topology in v1;
  cross-process/multi-host coordination is explicitly NOT shipped; Scout's
  candidate queue is in-memory (Redis/SQLite explicitly deferred).
- **CI:** single `verify` job — build (root mirror + all 7 workspace
  packages), typecheck, eslint, prettier, full test suite. CI status comment
  and README counts updated by PR #4 (S-01…S-05). CI green at HEAD (#17).
- **Planned, NOT implemented (code-checked):** strategy-specific Salvors /
  Specialist role (descoped by mandate), multi-DEX support (Raydium V4 only
  in v1), multi-chain support, cross-process coordination, persistent queue
  store, SDK off-chain locker cross-check for non-UNCX lockers (LOCKER-002).
- **Stale comments found by this inspection (register G-07/G-16):**
  `src/client.ts:90-96` (mirror-locked) still says NS-3 acceptance "PENDING";
  `scout/src/config.ts:15-21` still says "deployment pending… until the owner
  executes the NS-3 deployment and the oracle registration" — both stale
  since 2026-11-12; `scout/test/devnetSmoke.test.ts:9-13` still claims the
  devnet oracles "point at the since-wiped deployer key", which was true for
  NS-2 and is **no longer true for NS-3** (dedicated oracles registered
  2026-11-12). The README itself is accurate.

### 7.D `graveyield-console` (`31b08d26`)

- **Stack:** Next.js 16 (App Router) + React 19 + Tailwind 4 + shadcn/ui,
  Bun runtime (CI pins Bun 1.3.14), version 0.3.0, deployed on Vercel.
- **Implemented surfaces (direct inspection):** five views on one route —
  Overview (live devnet pulse of both programs + ProtocolConfig PDAs; KPI
  cards and bot feed remain **simulated fixtures, labeled**), Graveyard
  (snapshot-artifact-backed pool explorer with four-state freshness model,
  per-pool provenance, six-criteria display, dry-run re-evaluation, and
  "Certify & salvage" **disabled for submission by design**), Salvor Fleet
  (reads `FLEET_STATE_DIR` JSONL trails via `/api/gy/fleet`; withholds data
  without configuration), LP Claims (real distribution + on-chain
  `ClaimRecord` re-read; the only user-facing transaction is
  `claim_lp_proceeds`, driven through a prepare → simulate → approve →
  submit → reconcile machine), Protocol (live ops, charter invariants,
  program IDs, PDA map, spec-vs-live config comparison, error decoder
  6000–6034 / 7000–7022).
- **Data sources:** three API routes (`/api/gy/snapshot`, `/api/gy/fleet`,
  `/api/gy/claims`) over env-configured artifact URLs/paths; devnet RPC
  (`api.devnet.solana.com` default, three separate RPC surfaces — B1
  unification not merged); wallet adapter on devnet.
- **SDK consumption:** vendored subset at `src/lib/gy/vendor/graveyield-sdk/`
  pinned to protocol commit `2b0bc240` with SHA-256 pinning tests — **this
  predates IMPL-001 Phase A** (the canonical SDK has since moved via PR #105,
  now mirrored at `1847550`+); the vendor contains no
  `raydiumV4Evidence.ts`/`lastSwapAttestation.ts` and builds against
  web3.js 1.99.0 via `.js` shims while upstream uses 3.x. Re-vendoring is an
  open alignment task (register G-11).
- **What is NOT on main (critical):** PR #13 (audit-driven corrections
  A1–A6 / B1–B2 + 45 regression tests) and PR #14 (r1–r3 revised report)
  were **closed unmerged**. Every checked symptom remains on `main`:
  token-orientation display bug, unguarded `lastSwapUnix` in the estimator,
  estimator fed a display label instead of the mint, `score.toFixed(2)`
  presentation, 5-row `VAULT_IX` missing `sweep_dust`, old footer text,
  three RPC surfaces, and **no cluster (genesis-hash) verification** — the
  devnet badge is an assertion, not a check. The merged PR #12 report itself
  discloses: "The code corrections documented in §B–§F are NOT part of PR
  #12." Register G-08/G-09/G-10.
- **Build/test status:** CI green at HEAD (#31): bun typecheck/lint/test/
  build/audit (zero findings) + Vercel deploy. Main carries the 18-file
  pre-#13 test suite (271 `test()` declarations counted statically); the
  45-test regression suite exists only on the unmerged branch.

### 7.E `graveyield-site` (`fd9eb69a`)

- **Content (full read of `index.html`, the only content file):** positions
  GraveYield as "the settlement layer for derelict liquidity"; states "NS-3
  deployed on Solana Devnet on 12 November 2026 — recorded acceptance 56/56.
  Nothing on mainnet; no salvage has run yet"; the Status section and footer
  explicitly disclaim mainnet, audit, production custody, and end-to-end
  salvage; "Still required" card lists the first end-to-end salvage,
  production oracle operations, mainnet keys/multisig custody, and an
  independent security audit; eligibility criteria C1–C6 are described with
  their raw-unit and UNCX-only caveats; 40/40/20 is described as an
  initialized, governance-configurable default with the 20 % ceiling; the
  maritime-salvage framing is called an analogy.
- **Framing compliance:** the forbidden synonym appears **zero** times; the
  operative terms are "salvage"/"salvor"/"derelict"/"abandoned" — consistent
  with the canonical framing and the terminology lint.
- **Supporting evidence:** all acceptance claims match the committed
  evidence (56/56, 14/14 at slot 522,363,929); links point into
  `docs/DEVNET.md` and the verification record.
- **Remaining discrepancies (register G-37):** the hero pill and headline
  assert deployment status without the first-viewport qualifiers that the
  meta description carries; "governance-configurable" appears in the
  Settlement card and footer without the deployer-key caveat that the
  Status section carries; program IDs are not published on the page
  (verification is delegated via links); no CI, no sitemap, no robots.txt;
  the only external runtime target is the console's vercel.app link.

---

## 8. Testing and CI Status

### 8.1 What CI actually runs (graveyield-protocol, `.github/workflows/ci.yml`)

| Job | Content |
|---|---|
| `rust-fmt` | `cargo fmt --check` |
| `rust-clippy` | `cargo clippy --all-targets -- -D warnings` |
| `rust-host-tests` | `cargo test` — grave-scanner (lib), grave-vault (lib), grave-snapshotter (lib + integration) |
| `ts-build-and-test` | workspace `pnpm` build + `node:test` batteries (sdk, in-repo indexer, ops, adversary, devnet-tools) |
| `ts-typecheck` | workspace typecheck |
| `sdk-sync-check` | checks out `salvor-bots@main` and **fails on any byte divergence** of the SDK mirror |
| `anchor-build` | pinned-toolchain `anchor build` (SBPF v0, checksum-verified platform-tools v1.54, cached program keypairs dropped) + **structural ELF identity check** + **fail-closed provenance gate** + ELF artifact upload |

Additional workflows: `codeql.yml` (CodeQL), `devnet-smoke.yml` (scheduled
SDK devnet smoke, read-only), `fork-harness.yml` (fail-closed fork-relevant
change classification; fetches multi-MB mainnet fixtures; runs **all seven
fork suites** — `full_lifecycle_fork`, `security_negative_fork`,
`raydium_v4_fork`, `jupiter_conversion_fork`, `settlement_economics_fork`,
`lp_claim_fork`, `scanner_windows_fork` — plus the fork-support regression
suite; suites cannot silently skip since PR #100), `lockfile-refresh.yml`.
Documentation gates: `scripts/terminology-lint.sh` (forbidden vocabulary)
and `scripts/doc-links-lint.sh` (relative-link integrity) are enforced by CI
and re-run for this report in §12.

### 8.2 Recorded test results (as claims + CI corroboration)

- **PR #111 verification record (documentation claim, corroborated by CI
  #362 success):** cargo scanner 128 / vault 40 / snapshotter 5 suites; 715
  workspace tests (sdk 185 incl. live-devnet smoke, devnet-tools 410 incl.
  both provenance test batteries, indexer 34, ops 47, adversary 39);
  terminology lint PASS; doc-links lint PASS (160 links); toolchain pins 5/5.
- **This report did not re-execute test suites locally.** Test-count
  reconciliation across repos remains a known documentation-risk item
  (draft alignment report Q-13). All five HEADs are CI-green (§3), which is
  the enforced verification for this baseline.

### 8.3 Sibling-repo CI

- **grave-indexer:** `build-and-test` (submodules recursive, offline tests) +
  `devnet-smoke` (public devnet RPC; verifier-level cases run, program-level
  batch self-skips without a funded payer) + scheduled evidence smoke
  (secret-gated; no-op behavior if secrets absent — Q-09). Green at HEAD.
- **salvor-bots:** build/typecheck/lint/format/test across root mirror + 7
  packages; devnet smoke suite is `DEVNET_RPC_URL`-gated (skips offline).
  Green at HEAD.
- **graveyield-console:** bun install/typecheck/lint/test/build/audit
  (zero findings) + Vercel. Green at HEAD (#31). Note: CI on the **unmerged**
  PR #13 branch (`0e71c49c`) also passed — the corrections are buildable,
  just not merged.
- **graveyield-site:** no repository CI; Vercel deployment check success.

---

## 9. Deferred Work and Known Limitations

### 9.1 The Phase 0 reconciliation register (P-01…P-09) — exact status

The register was defined and executed as PR #111 ("Phase 0 reconciliation —
PR-1 of the approved plan", branch `docs/phase0-recon-comments`). An earlier
revision (commit `3eac25b`) applied all nine corrections, including the
Rust-source comment edits; the owner decided on 2026-11-16 that **the
deployed ELF provenance stays authoritative**, the ELF-shifting edits were
reverted (`677aab6`), and only the non-ELF-affecting parts landed in the
final PR #111 diff.

| ID | Correction | Surface | Status |
|---|---|---|---|
| P-01 | `Anchor.toml` program-ID comment → deployed status (2026-11-12, 56/56) | config comment (non-ELF) | **Addressed** (PR #111) |
| P-02 | Scanner `lib.rs` NS-3 block: "PENDING" → deployed | **Rust source comment** | **Deferred** — stale text remains at `programs/grave-scanner/src/lib.rs:46` |
| P-03 | Vault `lib.rs` NS-3 block: same rewrite | **Rust source comment** | **Deferred** — stale text remains at `programs/grave-vault/src/lib.rs:55` |
| P-04 | `Anchor.toml` `[scripts]` ts-mocha target commented out with limitation note (harness never landed; `anchor test` runs no suite) | config comment (non-ELF) | **Addressed** (PR #111; tests/README.md updated) |
| P-05 | Anchor 0.32.x → 1.2.2 across README badges/table/quickstart, CONTRIBUTING, `docs/technical-documentation.md` | docs (non-ELF) | **Addressed** (PR #111) |
| P-06 | CI badge URL → canonical `GraveYield/graveyield-protocol` path | docs (non-ELF) | **Addressed** (PR #111) |
| P-07 | "Anchor 0.31.x/0.32.x" behavior-note attributions → "the pinned Anchor line" (scanner+vault lib.rs headers, both `instructions/mod.rs`, `raydium_v4.rs` adapter notes) — plus the non-source part: scanner `Cargo.toml` `anchor-debug` comment | Rust source comments + Cargo.toml comment | **Split:** Cargo.toml part **Addressed** (PR #111, proven byte-inert); **Rust-source parts Deferred** |
| P-08 | "Multisig-only (Squads v4 3-of-5)" / "Multisig + 72h timelock" instruction doc comments → governance-authority-gated with multisig+timelock as the committed Mainnet posture, not current-program enforcement | **Rust source comments** | **Deferred** |
| P-09 | Vault `lib.rs` charter header split into bytecode-enforced invariants vs process commitments | **Rust source comment** | **Deferred** |

**Why the Rust-source corrections are deferred (the specific conflict,
documented in `docs/DEVNET.md` §1):** any edit to the program Rust sources —
comments included — shifts source line numbers and with them the SBF ELFs'
embedded line/panic-location metadata, changing the built bytes away from
the deployed digests. This was established empirically: the comment-edited
tree reproducibly built to different digests across three independent
pinned-toolchain builds (CI run 43907738016 + two local `--build-only`
rebuilds, agreeing byte-for-byte). The rebuilt digests from that tree
(`ae777eb3…7004b` / `6fd86675…6199c`) were never deployed and never approved;
the interim re-pin was withdrawn. What is **verified**: the delta was
comment-only; the digests shifted reproducibly; reverting restored
byte-identical digests (the gate passes on `main`). What is **not
established**: the exact byte-level mechanism (no archived copy of the
comment-edited ELFs was retained); the line-metadata explanation is recorded
as a plausible hypothesis, not a fact.

**The four-way distinction (DEVNET.md §1):**

1. **The deployed ELF artifacts** — immutable historical fact on Devnet since
   2026-11-12; not revisable by any build.
2. **The approved SHA-256 provenance pins** — the manifest values; the
   authority the fail-closed gate enforces; authoritative per the owner's
   2026-11-16 decision.
3. **Locally rebuilt ELF artifacts** — build outputs; a rebuild from the
   current tree matches the pins; the comment-edited tree's rebuild did not.
4. **The documented process for legitimate future ELF changes** — a
   deliberate, reviewed digest re-pin PR per the DEVNET.md §1 procedure,
   followed by an owner-executed redeployment.

A **documentation correction** (this report, README updates) touches no
bytes; a **source-comment change** can shift ELF bytes and therefore the
pins; a **binary change** is a new build output requiring a new approved pin;
a **deployment change** is the owner-only on-chain act that makes new bytes
the deployed reality. Deferred corrections remain open until a reviewed
re-pin PR plus redeployment; they are **not** treated as completed anywhere
in this report.

### 9.2 Other known limitations (implemented vs planned)

- **No live end-to-end operation** (§6.4) — the deepest proven evidence is
  fork simulation + the local W1 rehearsal.
- **Oracle operations unbuilt** — ORACLE-003 (🟥): hosted indexer signing,
  key custody/rotation, freshness monitoring, downtime policy do not exist.
- **Audit not performed** — no engagement, report, or firm relationship is
  recorded anywhere in the five repos.
- **Single-key upgrade authority on devnet** — accepted for devnet
  operability; unacceptable for mainnet (Squads 3-of-5 is the committed
  posture, not an artifact).
- **Timelock/authority-transfer fields are write-only** (GOV-001).
- **Non-Raydium-V4 AMMs and non-UNCX lockers unhandled** (CPI-002…008,
  LOCKER-002, KEYS-001).
- **Flat LP dust threshold** (KEYS-002) — safe floor, not a final policy.
- **IDL never generated or committed** (`anchor build --no-idl`; October
  baseline B9/NS-9 never executed) — every consumer hand-rolls
  discriminators (correctly tested, but a standing maintenance liability).
- **Priority-fee ceiling is SDK/operator policy, not bytecode enforcement**
  (error 7008 reserved and never raised; Phase 5 finding P5-12) — carried to
  the future audit as a scoping question.
- **Console alignment debt** (§7.D): A1–A6/B1–B2 unmerged; lifecycle design
  unimplemented; vendored SDK pre-Phase-A; `deployedAt: null` and stale
  "PENDING" comments in `data.ts`; three RPC surfaces; no genesis check.
- **Indexer evidence-path gaps** (§7.B): NS-3 matrix run missing; funded-payer
  dependency; dead-letter `SUBMIT`/`ORACLE_IS_REGISTERED` knobs; minor
  internal recency drift in ORACLE_CUSTODY/ORACLE_PIPELINE prose.
- **Salvor-bots stale comments** (§7.C): client docblock, scout config, and
  scout devnet-smoke header still describe the pre-NS-3 oracle situation.
- **SDK error-mirror tail** (Q-14): on-chain 7022 not yet mirrored.
- **Monitoring confidence** (Q-09): whether the scheduled smoke secrets are
  configured is not verifiable from the repos.

---

## 10. Consolidated Gap Register

Status categories are used exactly as defined (one per item, not mixed).
"Phase" classifies the item: **P0** = Phase 0 documentation/baseline matter,
**DEV** = subsequent development task, **OPS** = operational prerequisite,
**PRE-MN** = pre-mainnet blocker, **ROADMAP** = long-term roadmap.

| ID | Area | Description | Current status | Impact | Dependency / required decision | Target phase |
|---|---|---|---|---|---|---|
| G-01 | Deployment | NS-3 programs deployed, initialized, drilled, scanner oracles registered on Devnet (56/56 W2 + 14/14 independent) | **Verified** | Foundation for all further work | None | P0 (complete) |
| G-02 | Provenance | Deployed ELFs match manifest pins; fail-closed CI gate + rebuild byte-equality | **Verified** | Protects deployment integrity | Re-pin PR + owner redeployment for any future change | P0 (complete) |
| G-03 | Protocol docs | Rust-source comment corrections P-02/P-03 (stale "PENDING" NS-3 blocks at scanner `lib.rs:46`, vault `lib.rs:55`) | **Deferred** | Cosmetic-vs-byte trade-off: comments contradict deployed reality | Reviewed re-pin PR (DEVNET.md §1 procedure) + owner redeployment | DEV |
| G-04 | Protocol docs | Rust-source parts of P-07 (Anchor-attribution comments in lib.rs headers, both `instructions/mod.rs`, `raydium_v4.rs`) | **Deferred** | Same conflict as G-03 | Same as G-03 | DEV |
| G-05 | Protocol docs | P-08 instruction doc comments still present multisig/timelock as if enforced | **Deferred** | Governance misunderstanding risk for integrators | Same as G-03 | DEV |
| G-06 | Protocol docs | P-09 vault charter header not split into bytecode-enforced vs process commitments | **Deferred** | Same audience as G-05 | Same as G-03 | DEV |
| G-07 | SDK / salvor-bots | Stale NS-3 "PENDING" docblocks: `sdk/src/client.ts:90-96` (protocol + byte-locked salvor mirror), `scout/src/config.ts:15-21`, `scout/test/devnetSmoke.test.ts:9-13` (oracles "point at the since-wiped deployer key" — false since 2026-11-12) | **Deferred** (TS-only, not ELF-affecting, but CI byte-equality requires a coordinated two-repo PR; recorded, not fixed, per task scope) | Misleads bot operators reading source | Coordinated protocol+salvor-bots mirror PR | DEV |
| G-08 | Console | Audit corrections A1–A6 / B1–B2 + 45 regression tests (PR #13) not merged; all symptoms present on `main` (token orientation, estimator guard/mint input, score cell, `VAULT_IX` missing `sweep_dust`, footer, 3 RPC surfaces, no genesis check) | **Not implemented** (branch `fix/phase2-audit-corrections` CI-green, closed) | Console displays mis-oriented tokens; cluster identity asserted, not verified | Owner disposition of PR #13 (re-open/re-land/rebase onto post-#12 main) | DEV |
| G-09 | Console | Lifecycle integration (design `docs/lifecycle-integration-design.md`, owner decision O4) — no lifecycle reads, no `PoolState` extension | **Not implemented** (design only, merged via PR #12) | Console cannot show pool lifecycle truthfully | Owner approval of O4 scope, then implementation | DEV |
| G-10 | Console | NS-3 acceptance not reflected: `data.ts` `deployedAt: null`, "Deployment and on-chain acceptance are PENDING" comment (deferred item O2 of PR #12 report) | **Not implemented** | Console understates deployment state | Small doc-constants PR | DEV |
| G-11 | Console | Vendored SDK subset pinned to pre-Phase-A commit `2b0bc240`; lacks canonical last-swap evidence modules; web3.js 1.x shims | **Partially implemented** (works for its surface, behind canonical SDK) | Console not aligned with canonical evidence formats | Re-vendor + sha-pin update decision | DEV |
| G-12 | Indexer | 13-case evidence-path matrix never recorded against NS-3 (committed 13/13 artifact is NS-2, 2026-10-26); program-level cases self-skip without funded payer | **Not independently verified** (for NS-3) | Live oracle path on NS-3 unproven end-to-end | Owner-funded payer (≥0.01 SOL devnet) + `PAYER_KEY_FILE` run; record artifact | OPS |
| G-13 | Indexer | Dead-letter knobs: `SUBMIT=1` documented but no send path exists; `ORACLE_IS_REGISTERED` parsed but unused | **Partially implemented** (docs describe capability the repo deliberately lacks) | Doc/code drift | Small truth-pass PR | DEV |
| G-14 | Indexer docs | ORACLE_PIPELINE §8 item 2 and ORACLE_CUSTODY opening retain pre-registration framing vs §2.5's 2026-11-12 registration record | **Partially implemented** (recency drift, not code defect) | Reader confusion about oracle status | Small doc PR | P0 |
| G-15 | Salvor fleet | Cross-process coordination / persistent queue store (Redis/SQLite) not shipped; in-memory single-process v1 | **Not implemented** (explicitly documented boundary) | Fleet cannot scale beyond one process per bot | Design + implementation decision | ROADMAP |
| G-16 | Salvor fleet | Live attestation-signed submissions never exercised against NS-3 (executors dry-run-only by default; no funded payer path) | **Not independently verified** | No bot has ever interacted with the live deployment | Depends on G-12 + owner enablement | OPS |
| G-17 | End-to-end | First end-to-end salvage (certify → salvage → claim) on the live NS-3 deployment; no lifecycle accounts exist on devnet | **Not implemented** (on-chain; machinery implemented + fork-proven) | Core product claim unproven operationally | Owner-gated exercise (mode-2 discipline), depends on G-12 | OPS |
| G-18 | Oracle ops | ORACLE-003 runbook: hosted indexer service, key custody/rotation, freshness monitoring, downtime policy | **Not implemented** (🟥 checklist row) | No operational oracle capability; blocks any scheduled evaluation | Dedicated build + owner custody decisions | PRE-MN |
| G-19 | Multi-DEX | Scanner adapters CLMM/Orca/PumpSwap/Meteora (CPI-002…005, KEYS-001) and vault CPI trio (CPI-006…008) are fail-closed stubs (7017/`UnsupportedAmm`) | **Not implemented** | Only Raydium V4 pools salvageable | v1.1 milestone scope | ROADMAP |
| G-20 | Locker scope | LOCKER-002: non-UNCX lockers invisible to C5; locked pools can pass | **Not implemented** (⬜ tracking; mitigation is operator-enforced off-chain cross-check) | Eligibility false-positives possible | Owner decision Q-04 on canonical lock scope | PRE-MN |
| G-21 | Economics | KEYS-002 flat `lp_burn_dust_threshold` (1,000 raw units) and C3 raw-unit TVL floor semantics (no decimals/value normalization) | **Requires owner decision** (Q-03) | Eligibility precision across quote mints | Owner decision before mainnet docs/readiness | PRE-MN |
| G-22 | Governance | GOV-001: `pending_authority`/`timelock_seconds` write-only; 7014 never raised; upgrade authority = single deployer key | **Requires owner decision** (wire on-chain timelock or document reserved) | Mainnet custody posture | Squads 3-of-5 custody plan | PRE-MN |
| G-23 | Keys | KEYS-003: mainnet keypairs under custody; never reuse devnet keys; full ID-surface sync list in DECISIONS.md DR-001 §4 | **Not implemented** (🟥 checklist row) | Hard mainnet blocker | Owner key ceremony | PRE-MN |
| G-24 | Security | Independent security audit; audit handoff path exists (`PRE_MAINNET_CHECKLIST.md` §Audit handoff); issue #23 is unsolicited outreach only | **Not implemented** | Hard mainnet blocker | Owner engagement decision | PRE-MN |
| G-25 | Docs lineage | GY-DOC-RECON-001 alignment report unmerged (PR #104, revision 5, do-not-merge) with 21 open owner questions | **Requires owner decision** | Canonical-documentation state ambiguous | Owner review/disposition of PR #104 + Q-01…Q-21 | P0 |
| G-26 | Docs lineage | Whitepaper version lineage (v4.0 md vs v4.0.1 comment references vs docx metadata; Q-01/WP-02); GhostPools r5 revision (Q-11/GP-01…05); spec baseline re-pin (SP-01); roadmap form (Q-12) | **Requires owner decision** | Public-document integrity | Owner decisions inside PR #104 review | P0 |
| G-27 | Repo split | In-repo `indexer/` package overlaps dedicated `grave-indexer` repo; `submit.ts` holds `ACTIVITY_ORACLE_KEY` env custody (ADR D3 narrowing) | **Requires owner decision** (Q-05) | Custody-surface widening; duplicate maintenance | Owner adopts Deliverable 3 §16 recommendation or alternatives | OPS |
| G-28 | Scale | Discovery backfill/cursor policy at ~706k pools (Q-07); mainnet RPC provider strategy (Q-08); full-archive RPC for C2 derivation (Q-20) | **Requires owner decision** | Evidence completeness + cost at scale | Owner decisions before mainnet funnel | PRE-MN |
| G-29 | Monitoring | Scheduled evidence-smoke secrets (`DEVNET_RPC_URL`/`MAINNET_RPC_URL`) configured-or-not unverifiable from repos (Q-09) | **Not independently verified** | Monitoring may be silently no-op | Owner check in GitHub settings | OPS |
| G-30 | SDK | Error-mirror tail 7022 (Q-14); npm publication (PUBLISH.md ready; owner credentials) | **Partially implemented** | Integrator mirror drift; SDK not installable from registry | Hygiene changeset + owner publish session | DEV |
| G-31 | Build | No committed IDL (`anchor build --no-idl`); discriminators hand-rolled everywhere (October B9/NS-9 unexecuted) | **Not implemented** | Maintenance liability; auditor convenience | Generate + commit IDLs, cross-check once | DEV |
| G-32 | Dependency PRs | Dependabot PRs #109/#108/#107/#94 open (web3.js 3.1.1→3.2.1 etc.) | **Not implemented** (unmerged) | Low; CI green without them | Routine review | DEV |
| G-33 | Provenance tooling | Node v24.22.2 provenance-CLI teardown hang — root cause confirmed (issue #98); production mitigated by bounded fail-closed wrapper (PR #99); no upstream fix | **Partially implemented** (workaround shipped; underlying behavior documented) | Tooling flakiness on exact Node version | Track Node fix; keep bounded wrapper | DEV |
| G-34 | Console docs | PR #14 (r1–r3 revised implementation report) closed unmerged; `main` carries the r1-only PR #12 versions | **Requires owner decision** | Delivery-status wording in repo understates/misstates (r3 says code delivered as PR #13 — which is also unmerged) | Owner picks #12-version vs #14-version vs re-land | P0 |
| G-35 | Site | Hero pill/headline and footer lack the first-viewport qualifiers the meta description and Status section carry; program IDs not published on page | **Partially implemented** (site aligned by PR #2; polish items remain) | First-read impression may overstate | Small site PR | P0 |
| G-36 | Test counts | Cross-repo test-count reconciliation (372 vs static ~373 salvor; 715 protocol claim vs CI; Q-13) | **Not independently verified** (this report did not re-run suites; CI-green is the enforced evidence) | Documentation precision only | Adopt per-repo commit-pinned counts | P0 |

Register discipline notes: no item is counted twice across categories;
implementation status is never inferred from code existence alone (G-17 is
"Not implemented" on-chain although fully implemented in code); deferred
items G-03…G-07 are deliberately **not** classified as done.

---

## 11. Outstanding Owner Decisions

Extracted from the draft alignment report (PR #104, Q-01…Q-21), the decision
register, the console implementation report (O-items), and this baseline's
findings. **None of these is silently marked resolved.**

1. **PR #104 disposition (G-25/G-26).** Merge as review artifact, extract
   into actionable PRs, or retire — plus ratification of Q-01 (whitepaper
   lineage: recommend adopting Version 4.1.0 draft), Q-02 (canonical C1–C6
   labels + historical mapping), Q-11 (GhostPools r5 qualifications),
   Q-12 (status-based roadmap), SP-01 (spec baseline re-pin).
2. **Console PR #13 and PR #14 (G-08/G-34).** Decide whether the A1–A6/B1–B2
   corrections branch is re-based and landed, and which revision of the
   implementation report is canonical.
3. **Console lifecycle scope (G-09, O4).** Approve the design before any
   lifecycle code lands.
4. **Lock-scope canon (G-20, Q-04).** Is UNCX-only detection the canonical C5,
   or is the implementation incomplete relative to the historical
   governance/pool-authority lock requirement? Publication and mainnet
   blocker until answered.
5. **C3 threshold semantics + KEYS-002 (G-21, Q-03).** Raw-unit floor vs
   normalized/percent reform.
6. **LP sourcing for salvage (Q-16).** The withdraw burns salvor-held LP;
   whether permissionless settlement is achievable in practice depends on how
   a salvor acquires LP for dispersed pools — owner decision before mainnet
   funnel design.
7. **Repo split / oracle-key custody (G-27, Q-05).** Retire the in-repo
   submit path and narrow ops to monitoring, per the recommendation.
8. **Scale + RPC strategy (G-28, Q-07/Q-08/Q-20).** Bounded scans vs
   cursors; provider strategy; archive RPC ownership for C2.
9. **Monitoring secrets (G-29, Q-09).** Verify scheduled-smoke secrets in
   GitHub settings.
10. **Mainnet custody chain (G-22/G-23).** GOV-001 timelock decision, KEYS-003
    key ceremony, Squads 3-of-5 arrangements.
11. **Audit engagement (G-24).** Select and commission the independent audit.
12. **Deferred-correction schedule (G-03…G-07).** When to bundle the
    Rust-source comment corrections into a reviewed re-pin PR + owner
    redeployment, and the coordinated SDK docblock PR.
13. **SDK publication (G-30).** Owner npm credentials session.

---

## 12. Pre-Testnet and Pre-Mainnet Considerations

GraveYield has no separate testnet generation; the next milestone after the
current devnet era is mainnet preparation. The honest sequence:

1. **Close the Phase 0 documentation state** (PR #104 disposition, G-34,
   G-14, G-35, G-36) so the public record is internally consistent.
2. **Prove the live path on devnet before anything else** (G-12 → G-16 →
   G-17): a funded-payer 13/13 matrix run against NS-3, one owner-gated
   end-to-end certify-and-salvage exercise, and a recorded
   SalvageReceipt/ClaimRecord artifact set. Until this happens, "deployment
   acceptance" must continue to be described exactly as the W2 record
   describes it.
3. **Build the oracle operation** (G-18) — the ORACLE-003 runbook is the
   single hard blocker that stands between the current state and any
   scheduled evaluation traffic.
4. **Mainnet readiness chain** (G-22/G-23/G-24 + checklist rows): custody
   decisions, key ceremony, GOV-001 resolution, LOCKER-002/Q-04 scope,
   KEYS-002/Q-03 economics, audit handoff (`scripts/list-pre-mainnet-todos.sh`
   output attached per the checklist's auditor one-liner).
5. **Hygiene that audits will ask for** (G-31 IDLs, G-30 error-mirror tail,
   G-33 Node-version note, G-32 dependabot queue).

The devnet deployment itself needs no pre-mainnet action to remain valid:
it is pinned, accepted, and independently re-verifiable at any time via the
committed verifiers.

---

## 13. Recommended Next Steps

In dependency order, each with its acceptance condition:

1. **Owner dispositions (no code):** rule on PR #104, PR #13/#14 console
   branches, and the thirteen decisions in §11. *Accept:* each open PR has a
   recorded owner decision; no question in §11 is left silently open.
2. **NS-3 live exercise package (owner-gated, mode-2 discipline):** fund a
   devnet payer, run the full 13-case matrix with 0 skipped against NS-3,
   then one end-to-end certify-and-salvage drill with recorded artifacts.
   *Accept:* committed NS-3 evidence-path report with 0 skipped; lifecycle
   accounts exist on devnet and are reconciled against the fork-suite
   expectations.
3. **Truth-pass PRs (documentation-only, no ELF impact):** indexer
   G-13/G-14, salvor G-07 (coordinated mirror PR), console G-10, site G-35.
   *Accept:* terminology + doc-links lint green; no manifest change.
4. **Deferred-correction bundle (G-03…G-06):** one reviewed PR carrying all
   Rust-source comment corrections, built through the fail-closed gate,
   digests re-pinned deliberately per DEVNET.md §1, redeployed by the owner.
   *Accept:* new pins recorded with from→to digests; owner redeployment
   verified by `verify_ns3_elf_digests.mjs` 27/27 against the new pins.
5. **Console alignment (G-08/G-09/G-11):** land the corrections branch
   (rebased onto post-#12 main), then implement the approved lifecycle
   design, then re-vendor the canonical SDK.
6. **ORACLE-003 runbook + hosted indexer service (G-18):** the operational
   prerequisite for any scheduled oracle traffic.
7. **Mainnet preparation:** begin the §12 chain in parallel where decisions
   are the only dependency (custody, audit engagement).

---

## 14. Historical References and Evidence Index

### Historical deployment records (preserved, not rewritten)

- 2026-10-24 Phase 0 baseline (NS-1 era; blocker register B1–B9; the root of
  the DR-001 → NS-2 → DR-002 → NS-3 chain): [`BASELINE_REPORT.md`](BASELINE_REPORT.md)
- NS-1/NS-2 lineage, addresses, on-chain state, authority loss:
  [`LEGACY_DEPLOYMENTS.md`](LEGACY_DEPLOYMENTS.md)
- Decision records DR-001 (2026-10-25) and DR-002 (2026-11-03):
  [`DECISIONS.md`](DECISIONS.md)
- Earlier W2 records retained unchanged: `W2_ACCEPTANCE_REPORT.md`
  (REJECTED pre-deployment run — preserved as a valid record of that run),
  `W2_NS3_PREFLIGHT_COMPLETION_REPORT.md`, `W2_NS3_PREFLIGHT_CORRECTIONS.md`,
  `W2_NS3_FINAL_OWNER_HANDOFF.md` (all under `docs/w2-ns3-acceptance/`)
- Pre-deployment verifier JSON artifacts (`verify_ns3_deployment.output.json`,
  `elf_digest_check.json` — the earlier absent-deployment FAIL/UNVERIFIABLE
  runs, retained as historical evidence; the post-deployment PASS evidence
  lives in `docs/w2-ns3-acceptance/evidence/*.txt`)
- W1 NS-3 rehearsal inspection and post-merge verification:
  [`W1_NS3_REHEARSAL_INSPECTION.md`](W1_NS3_REHEARSAL_INSPECTION.md),
  [`w1-post-merge/W1_POST_MERGE_VERIFICATION.md`](w1-post-merge/W1_POST_MERGE_VERIFICATION.md)
- Unmerged draft (PR #104 head `5f712584`):
  `docs/GY-DOC-RECON-001_ALIGNMENT_REPORT.md` — revision 5, 2026-11-14

### Primary NS-3 evidence (this baseline's deployment sources)

- `docs/w2-ns3-acceptance/W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md` (56/56)
- `docs/w2-ns3-acceptance/evidence/verify_acceptance_post_deployment.txt` (29/29)
- `docs/w2-ns3-acceptance/evidence/verify_elf_digests_post_deployment.txt` (27/27)
- `docs/w2-ns3-acceptance/INDEPENDENT_READONLY_VERIFICATION_2026-11-15.md` (14/14)
- `scripts/devnet/provenance.manifest.json` (digest + toolchain pins)
- `docs/DEVNET.md` §1 (provenance discipline + deferred-correction record)

### PR evidence index

- PR #111 (Phase 0 reconciliation; deferral decision + full verification
  record), #110 (record reconciliation + independent verification source),
  #105 (IMPL-001 Phase A), #103 (W2 acceptance), #100 (fork skip-integrity),
  #99 (provenance checker bounding), #89 (digest verifier), #84/#85/#86
  (W1 rehearsal + verification), #83/#82 (fail-closed provenance), #80
  (NS-3 identity sync), #78/#79 (NS-2 legacy freeze)
- Indexer PR #2 (Phase B) / #3 (I-01…I-06); salvor PR #3 (mirror sync) /
  #4 (S-01…S-05); console PR #12 (merged docs) vs #13/#14 (closed unmerged);
  site PR #1/#2

### Verification-reproduction paths (for future readers)

- Deployment acceptance:
  `node scripts/devnet/verify_ns3_deployment.mjs --url https://api.devnet.solana.com`
- ELF digests:
  `node scripts/devnet/verify_ns3_elf_digests.mjs --url https://api.devnet.solana.com`
- PDA derivation: `node scripts/devnet/ns3_derive_pdas.mjs`
- Identity constants: `scripts/devnet/ns3_identities.mjs`
- Toolchain pins: `bash scripts/check-toolchain.sh`
- Marker audit: `bash scripts/list-pre-mainnet-todos.sh`
