# GraveYield Protocol — Phase 0 Baseline Report

> **Date:** 2026-10-24 · **Author:** lead protocol engineer (Phase 0 baseline engagement)
> **Audited state:** `graveyield-protocol` @ `0ed5c6f` (main, 2026-10-12) · `salvor-bots` @ `ea88283` (2026-10-10) · `graveyield-console` @ `c7dd9e4` (2026-10-23) · `graveyield-site` @ `78375e0` (2026-10-23)
> **Cluster:** Solana devnet (`https://api.devnet.solana.com`), epoch 1191, health `ok`, read at slot ≈ 514,6xx,xxx on 2026-10-24 12:2x–12:4x UTC.
> **Method:** read-only. No keys requested, used, or committed. No transactions submitted. No deployments or upgrades performed. Every on-chain claim below was re-derived from raw JSON-RPC (`getAccountInfo`, `getTransaction`, `getSignaturesForAddress`, `getProgramAccounts`, `getBalance`, `getEpochInfo`) with independent PDA/programdata decoding — not taken from docs. This report contains no secrets; all credentials referenced during the audit were session-scoped and never written to any file.

---

## 0. Executive summary

The devnet deployment documented in `docs/DEVNET.md` is **real and matches its documentation in every verifiable detail**: both programs live at the documented IDs, both `ProtocolConfig` PDAs exist at the documented addresses with exactly the spec defaults, the emergency-control drill transactions are on-chain, and no undocumented state exists (each program owns exactly one account — its config).

However, the deployment is **operationally frozen**:

1. **The upgrade authority and the config authority are the same single deployer key** (`GCCuhCXd5qWVUik38Qv3maoRUoe2upiyJByo2Qyb68yk`), which is **also both oracle keys** — and `docs/OPS.md` states the deployer keys were **wiped per custody policy**. If that statement is accurate (it cannot be verified from chain), then **no upgrade, no config update, no oracle rotation, no pause toggle, and no anchor invalidation can ever be executed again** against this deployment, and the oracle-gated evaluation pipeline (C1/C2 attestations) can never run. The devnet deployment is a permanent, immutable record — not a working environment.
2. **The deployed ELFs are stale.** Four commits after the 2026-10-08 deploy touched `programs/` (including scanner's no-op-pause refusal and sweep-window floor, and a vault parity pass). `programdata.slot == deploy slot` proves no upgrade ever happened, so devnet behavior demonstrably diverges from `main` HEAD — and can never be brought current without the (wiped) authority key.
3. A fresh devnet deployment with newly generated, custody-held keypairs is therefore **required** for any further protocol-level devnet work. That is exactly the KEYS-003 sync flow already scripted for mainnet; it must be applied to devnet now.

Separately, the test estate is strong but **not CI-gated** (CI runs zero tests), the two copies of the SDK have **diverged with three bug fixes stranded in `salvor-bots`** (price inversion, priority-fee unit mismatch, snapshot sort order), and the 47 fork-harness tests have not been executed since the Phase 12 changes (compile-validated only, per the CHANGELOG's own admission).

I executed **668 tests across three repos in this session: 668 passed, 0 failed, 0 skipped inappropriately** — including live read-only smoke tests against the real devnet configs and the OPS scenarios SC-01/SC-02 against the live cluster.

---

## 1. Verified on-chain state (devnet, 2026-10-24)

All values below were read via raw JSON-RPC and decoded independently (PDA derivation and programdata/config borsh decoding re-implemented from first principles; the decoder outputs cross-check against the SDK's own live smoke tests, which passed).

### 1.1 Programs

| Item | GraveScanner | GraveVault |
|---|---|---|
| Program ID | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` | `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` |
| Owner | `BPFLoaderUpgradeab1e…` (upgradeable loader) | same |
| Executable | true | true |
| ProgramData address | `DzRuBh14DDEoLh3s7XZWFX3GmpqFMthobw87cNvaDMFX` | `on8DEjwWa4ok7AnbJ2buzuVLGz6Q3AqvQgPzcjDQQsw` |
| ELF size | 365,552 bytes (~366 KB as documented) | 405,016 bytes (~405 KB as documented) |
| Deployed/last-upgraded slot | 508,888,241 | 508,888,318 |
| **Upgrade authority** | **`GCCuhCXd5qWVUik38Qv3maoRUoe2upiyJByo2Qyb68yk`** (present, Option=1) | same |
| Upgraded since deploy? | **No** (programdata slot equals deploy tx slot) | **No** |

Verification anchors (all confirmed on-chain, all successful, all fee-payer = `GCCuhCXd…`):

| Step | Signature | Slot | UTC time (chain) |
|---|---|---|---|
| Scanner deploy | `PUXKJWGYnGg5JkEFLRqqjrdrbNyDFWMKRCrpYcY32K6Fq3SXdZTgv86EFKbnxYr5oLaB2vmxamZwVoSJ36N12ww` | 508,888,241 | 2026-10-08 17:12:52 |
| Vault deploy | `5gEVQfsddMg5kHqiasw2JwKPwa1CGNpJ57CuksMiau9GhGigYe9CkQV5TAxuAtnHJDpA3nPy8eABd67vrq55HgN6` | 508,888,318 | 2026-10-08 17:13:10 |
| Scanner config init | `5boq7igXj311M836EUDFgsxq1goNj5kabniX4QYj7ZFnBb471NydLTE4gvps55EjGssxhPnaBbCyx6jPvLBeqTTh` | 508,888,495 | 2026-10-08 17:13:52 |
| Vault config init | `2psMkdruwRQvdssBRiUTGtdThbCCH9nUhSgyWCJi3vJsWbYGNBPjJLwxYtoVd8hPBqJ95z9HFF4hrjpg3ETEty9H` | 508,888,498 | 2026-10-08 17:13:53 |
| Scanner pause | `3ZmBhk4oU4jkwA21M132ieorWWcWqnu3ffrDrpufaR1xES5WwRVvhdHKPQn9A9fpoexZQ3RvU4dkPHQeQHfgekGU` | 508,888,530 | 2026-10-08 17:14:00 |
| Scanner unpause | `5etKbsLNcAkJbsfedv8hvoTem721YZMo5SG1m1mAYWLZxewPB5nFtKi947kth8cgyRuyWP92tSkFovmJnLdpK3hn` | 508,888,532 | 2026-10-08 17:14:01 |
| Vault pause | `4zYzBvQmKGMuDoEv2FmzDo7HRDiW27dyfqKgJVm4eedTtKHRtdPderi2u3SGomHKsqRqA3yGi94KRUii2sYdapap` | 508,888,552 | 2026-10-08 17:14:06 |
| Vault unpause | `2EYULdig8ow2VXcwHHHtg3reBqVqabkohKvuwWfgw176wgUPmpgFnAgnkGUJKE2PfCCT2s45J3ungNuFvSuTaAHc` | 508,888,556 | 2026-10-08 17:14:06 |

> **Date note:** the chain says the sequence executed **2026-10-08 17:12–17:14 UTC**; `docs/DEVNET.md` and the CHANGELOG say "2026-10-09". Off by one day (likely local-timezone attribution). Cosmetic, but it should be corrected to the UTC date.

The four drill transactions' logs contain `Program log: Instruction: EmergencyPause` for the correct programs, with the boolean argument flipping 1→0 (pause→unpause) in the documented order, 8–14 s after the init transactions. This is on-chain proof the drill ran as documented.

The drill's **intruder-rejection step leaves no on-chain trace by construction**: `protocol_admin.mjs` uses `sendAndConfirmTransaction`, whose preflight simulation fails with `Unauthorized` before submission, so the rejected transaction is never landed. The step's evidence therefore exists only in the operator's session log; the authorization gate itself is verified by source review (`has_one = authority @ Unauthorized` on both programs' `EmergencyPause`/`UpdateProtocolConfig` contexts) and by the drill's design. Classified: **documentation claim consistent with implementation, not independently verifiable from chain**.

### 1.2 ProtocolConfig accounts (initialized accounts)

Both config PDAs were re-derived from seeds (`["protocol_config"]`) and **match the documented addresses exactly** (bump 255 for both):

- GraveScanner: `GcdZJhCpg7sjgEEHTsoSkT2Pi83d8kP3NrTqdvMm2Bhu`
- GraveVault: `2SCqqpEwKMuWnJWe7UQJTzFeDPif4jUPUspWKZdZ5vaU`

Both accounts carry the Anchor discriminator `cf5bfa1c98b3d7d1` = `sha256("account:ProtocolConfig")[0..8]` — they are genuine Anchor `ProtocolConfig` accounts. Full decode:

| Field (GraveScanner) | On-chain value | Spec default | Match |
|---|---|---|---|
| authority | `GCCuhCXd5qWVUik38Qv3maoRUoe2upiyJByo2Qyb68yk` | deployer at init | ✓ |
| pending_authority / eta | system program / 0 (zeroed) | zeroed | ✓ |
| inactivity_seconds | 7,776,000 | 7,776,000 (90 d) | ✓ |
| price_collapse_bps | 9,900 | 9,900 | ✓ |
| min_tvl_lamports | 500,000,000 | 500,000,000 (0.5 SOL) | ✓ |
| anchor_staleness_seconds | 1,209,600 | 1,209,600 (14 d) | ✓ |
| lp_burn_dust_threshold | 1,000 | 1,000 | ✓ |
| cert_ttl_seconds | 3,600 | 3,600 | ✓ |
| paused | false | false (drill restored) | ✓ |
| **activity_oracle** | **`GCCuhCXd…` (= authority = deployer)** | authority at init | ✓ |
| **launch_price_oracle** | **`GCCuhCXd…` (= authority = deployer)** | authority at init | ✓ |
| bump / reserved[64] | 255 / all zero | — | ✓ |

| Field (GraveVault) | On-chain value | Spec default | Match |
|---|---|---|---|
| authority | `GCCuhCXd5qWVUik38Qv3maoRUoe2upiyJByo2Qyb68yk` | deployer at init | ✓ |
| pending_authority / eta | zeroed | zeroed | ✓ |
| lp_holder_share_bps | 4,000 | 4,000 | ✓ |
| salvor_share_bps | 4,000 | 4,000 | ✓ |
| protocol_share_bps | 2,000 | 2,000 (Charter ceiling) | ✓ |
| max_priority_fee_ceiling_lamports | 1,000,000,000 | 1,000,000,000 | ✓ |
| max_slippage_bps | 300 | 300 | ✓ |
| jupiter_dust_threshold_lamports | 666,666 | 666,666 | ✓ |
| timelock_seconds | 259,200 | 259,200 (72 h) | ✓ |
| emergency_paused | false | false (drill restored) | ✓ |
| bump / reserved[96] | 255 / all zero | — | ✓ |

### 1.3 Program-owned accounts (the full universe)

`getProgramAccounts` (unfiltered, per the OPS.md note that devnet owns few accounts):

- GraveScanner owns **exactly 1 account**: its ProtocolConfig PDA.
- GraveVault owns **exactly 1 account**: its ProtocolConfig PDA.

**There are no `EligibilityAnchor`, `EligibilityCert`, `LaunchPrice`, `PoolRegistry`, `SalvageReceipt`, or `ClaimRecord` accounts anywhere on devnet.** No pool has ever been evaluated, certified, or salvaged against this deployment. This is consistent with the site's own honest status line ("no salvage has run yet") and with DEVNET.md's declared scope (deploy → init → drill only).

### 1.4 Authority / oracle / emergency-control configuration summary

| Control | Value on-chain | Consequence |
|---|---|---|
| Program upgrade authority (both) | deployer key, single key | Programs upgradeable — but only by the deployer key |
| Config authority (both) | deployer key | All governance instructions require that key |
| activity_oracle / launch_price_oracle | deployer key (both) | All attestation-gated flows require that key to sign Ed25519 attestations |
| Emergency pause state | unpaused, both programs | Post-drill restored state confirmed |

**Critical coupling:** one key controls upgrades, config, oracles, and pause on devnet. `docs/OPS.md` §7 states that key's private material was **wiped** ("deployer keys were throwaways, wiped per custody policy"). If true, every one of those capabilities is permanently gone — including `update_protocol_config`, which is the *only* mechanism to re-point the oracles. The 5,974,471,920 lamports (~5.97 SOL) still sitting at that address are consistent with "key discarded, funds abandoned" and are also corroborated (independently) by `sdk/test/devnetSmoke.test.ts`'s comment ("the deployer still holds 5.97 SOL"). **Whether the key truly no longer exists is not verifiable from chain — it is the single most important unknown in this baseline.**

---

## 2. Verified repository state (`graveyield-protocol` @ `0ed5c6f`)

### 2.1 Program ID consistency (verified across every reference site)

`5JiCVx…` / `HUyoG5…` are identical in all of:

- `programs/grave-scanner/src/lib.rs` (`declare_id!`) and `programs/grave-vault/src/lib.rs` (`declare_id!`)
- `Anchor.toml` `[programs.localnet]` and `[programs.devnet]`
- `scripts/devnet/deploy_devnet.sh` (`EXPECTED_SCANNER` / `EXPECTED_VAULT` identity gates)
- `scripts/devnet/protocol_admin.mjs` (`SCANNER_PROGRAM_ID` / `VAULT_PROGRAM_ID`)
- `sdk/` (protocol repo copy — constants + PDA helpers; live smoke tests assert against devnet)
- `salvor-bots/src/client.ts` (`DEVNET_SCANNER_PROGRAM_ID` / `DEVNET_VAULT_PROGRAM_ID`)
- `graveyield-console/src/lib/gy/data.ts`
- `docs/DEVNET.md`, `docs/PRE_MAINNET_CHECKLIST.md` (KEYS-003 row)

No stale or conflicting program ID was found in any tracked file. The old "SHA-256-derived placeholder" IDs survive only in prose descriptions, not as active references.

### 2.2 Key hygiene (verified)

- **No keypair material is committed.** `git ls-files` contains no `*-keypair.json`, no `keys/`, no `id*.json`, no `deployer*.json`. `.gitignore` explicitly blocks `keys/`, `*-keypair.json`, `id*.json`, `deployer*.json`, `upgrade-authority*.json`.
- `scripts/devnet/deploy_devnet.sh` enforces keypairs outside the repo, refuses identity mismatches between keypair pubkeys and the compiled `declare_id!`, refuses stale `target/deploy` artifacts, and refuses underfunded deployers.
- `scripts/devnet/local_rehearsal.sh` mints deployer/intruder keys into a `mktemp` dir and discards them; it requires the canonical program keypairs only because the ELF `declare_id!` must match.

### 2.3 Source-vs-deployment drift (verified)

Commit history shows the deploy (chain: 2026-10-08 17:12 UTC) was made from approximately `5cc46cd` (2026-10-08 22:52 UTC commit time; the deploy tooling itself landed in `830e7cb`). **Four subsequent commits on `main` touch `programs/`:**

| Commit | Date | Programs/ impact |
|---|---|---|
| `f68bdac` | 2026-10-11 | scanner: refuse no-op pause toggles (`InvariantViolation` 6006); floor-lock the anchor sweep window |
| `8132014` | 2026-10-12 | scanner: bring `EligibilityAnchor` to parity with `EligibilityCert` |
| `92ce017` | 2026-10-12 | chore: drop fossil `Xargo.toml` (build hygiene) |
| `0ed5c6f` | 2026-10-12 | vault: parity pass on state PDAs, CPI stubs, `emergency_pause` (7022 refusal) |

Since `programdata.slot == deploy slot` (no upgrade ever landed), **the deployed devnet ELFs do not contain these behavior changes** — e.g. the deployed scanner still accepts no-op pause toggles, contrary to the code now on `main` and the comments now in the vault state docs. Any drill or tooling expectation derived from HEAD source will not match deployed behavior.

### 2.4 CI (verified from `.github/workflows/ci.yml` + GitHub Actions API)

Jobs: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `anchor build --no-idl` (with a documented platform-tools v1.54 pin), `pnpm -r typecheck`, terminology lint, doc-links lint. Recent runs on dependabot branches and the main head are green.

**CI executes zero tests.** No `cargo test`, no `pnpm -r test`, no fork harness. All 668 test results reported in §4 were produced by this audit, not by CI. Also: `anchor build --no-idl` means **no IDL is produced or committed anywhere** — every downstream consumer (SDK, `protocol_admin.mjs`, console) hand-rolls discriminators (correctly, per the discriminator tests, but it is a standing maintenance liability).

### 2.5 Documentation discrepancies found (full reconciliation)

| # | Document | Claim | Verified reality | Severity |
|---|---|---|---|---|
| D1 | `OPS.md` §7 | deployer keys "wiped per custody policy"; devnet oracle keys "de-pointed" | Oracles are *pointed* at the deployer key on-chain; the claim is that the *private material is destroyed*. If true, ops via that authority are impossible forever. Wording "de-pointed" is misleading — the config is **pointed at a dead key**. | High (wording + consequence) |
| D2 | `DEVNET.md` | "Status: EXECUTED … live on devnet" | Confirmed on-chain, but ELFs are 4 commits stale and the doc does not say so | High (omission) |
| D3 | `DEVNET.md` / `CHANGELOG.md` | executed "2026-10-09" | Chain timestamps: 2026-10-08 17:12–17:14 UTC | Low |
| D4 | `DEVNET.md` §1 stage 2 | "Funding check — deployer balance ≥ 2 SOL" | Script refuses below **6** SOL (`if (( BAL < 6 ))`); the same doc's Prerequisites say ≥ 6 SOL | Low (internal contradiction) |
| D5 | `tests/README.md` | "Run: `anchor test`" as the entry point | Root `tests/` contains only a README; `Anchor.toml`'s ts-mocha glob matches zero files → `anchor test` runs 0 tests. Real suites live in workspace packages (`node:test`) and `cargo test` | Medium (misleading runbook) |
| D6 | `tests/README.md` | SDK "108 tests", indexer "29 tests" | Confirmed exactly (108 and 29) | — (accurate) |
| D7 | `PRE_MAINNET_CHECKLIST.md` | rows KEYS-003, ORACLE-003 🟥 etc. | Confirmed current: 6 `PRE-MAINNET-TODO` markers in source; live checklist rows are consistent with source state. The promised CI marker-audit ("added in a follow-up PR") does not exist yet | Low (acknowledged) |
| D8 | `OPS.md` §1/§5 | services + scenarios executable, read-only | Confirmed: SC-01/SC-02 executed against live devnet in this audit, all checks green | — (accurate) |
| D9 | Site (`graveyield-site`) | "Both programs live on devnet… no salvage has run yet… drill passed" | Matches on-chain truth exactly | — (accurate) |
| D10 | Console README | "Simulated telemetry", read-only/dry-run devnet | Matches repo content; program IDs match deployment | — (accurate) |

### 2.6 Governance structure (source-verified)

- Devnet runs **single-key** authority (documented, accepted for operability). `initialize` docs and the Charter call for **Squads v4 3-of-5 multisig at mainnet**; nothing on devnet is multisig.
- `GOV-001` (🟡): the 72h timelock exists only as Squads-side process; `pending_authority*` fields are write-only reserved state and `TimelockNotElapsed` (7014) is never raised. Confirmed in source comments and in the vault state lifecycle diagram.
- On-chain `emergency_pause` semantics match spec: scanner pause gates only `evaluate_pool_*`; vault pause gates `salvage_pool` while `claim_lp_proceeds` stays live; both refuse no-op toggles **in HEAD source** (not in deployed ELFs — see §2.3).

---

## 3. Sibling repositories (verified)

### 3.1 `salvor-bots` @ `ea88283`

- Five-bot fleet (scout / conservative / sniper / experimental / monitor) + `fleet-core` + `fleet-ops`, per Phases 10–11. Root package is `@graveyield/sdk` v0.2.0 — the canonical SDK home since Phase 8 (consistent with `OPS.md` §6's install instruction).
- **Tests (executed here): 238 passed / 0 failed** — fleet-core 74, scout 87, sniper 7, experimental 9, conservative 13, monitor 21, fleet-ops 27.
- **Fresh-clone test gap:** bare `pnpm -r test` fails with `ERR_MODULE_NOT_FOUND` (@graveyield/fleet-core) until `pnpm -r build` runs first; `pnpm -r typecheck` likewise reports 3 errors that all disappear after a build. No CI workflow exists in this repo, so nothing catches this.
- **SDK divergence (high priority):** `salvor-bots/src/{client,priorityFee,snapshot}.ts` differ from `graveyield-protocol/sdk/src/` — the salvor-bots copies carry three FLEET-M0 audit fixes that the protocol repo's SDK lacks:
  - **F5** (`client.ts`): like-for-like price was **inverted** for pools whose coin-side mint sorts after its pc-side mint; fixed copy always uses the coin/pc ratio to mirror the on-chain adapter.
  - **F1** (`priorityFee.ts`): `derivePriorityFeeLamports` mixes a total-lamport margin with a per-CU price — the fixed copy deprecates it and routes executors to `derivePriorityFeePlan`; the protocol repo still ships the buggy version **with tests pinning the buggy behavior**.
  - **F7** (`snapshot.ts`): holder ordering used base58 **string** sort instead of pubkey **byte** order → intermittent "entries not sorted" Merkle failures (a few percent per pair); fixed copy sorts by bytes.
  The last commit touching the salvor-bots copies is 2026-10-09; the protocol copy is 2026-10-08. **The newer, fixed logic exists only in `salvor-bots`.**

### 3.2 `graveyield-console` @ `c7dd9e4`

Next.js 16 operations console. Honestly labeled: "Simulated telemetry" badge, devnet-era fixture pool data, dry-run/read-only salvage actions, real wallet connection only for balance display. Program IDs match the deployment. Prisma schema is an unused scaffold (User/Post). No CI. No secrets committed (env usage is runtime-only).

### 3.3 `graveyield-site` @ `78375e0`

Static one-page site. Claims audited against chain: "Live on Solana devnet", "Deployed on devnet, 9 October 2026" (same off-by-one day as DEVNET.md), "Both programs live", "Configs at spec defaults", "Pause and authority-rejection drill passed", "No salvage has run yet", "Nothing on mainnet". **All accurate** (modulo the date nit). The "Not yet live" list matches the blocker register below (first salvage, indexer/snapshot/SDK release, multisig custody, audit).

---

## 4. Test estate: implemented vs executed (this audit)

Executed 2026-10-24, Rust 1.91.1 (per `rust-toolchain.toml`), Node 24, pnpm 9.12.0. `DEVNET_RPC_URL` was set so the SDK's devnet smoke suite runs against the live cluster.

| Suite | Declared | Executed here | Result | Notes |
|---|---|---|---|---|
| `grave-scanner` host (`cargo test -p grave-scanner --lib`) | 88 + proptests + Phase 12 adversary | **113** | **113 pass / 0 fail** | incl. criteria/attestation/adapter unit + proptests + adversary battery |
| `grave-vault` host (`cargo test -p grave-vault --lib`) | 22 + 15 proptests + Phase 12 | **41** | **41 pass / 0 fail** | incl. merkle proptests, settlement arithmetic |
| `grave-snapshotter` (`cargo test -p grave-snapshotter`) | 53 (38 lib + 15 integration) | **53** | **53 pass / 0 fail** | matches docs exactly |
| `sdk` (`pnpm --filter @graveyield/sdk test`) | 108 | **108** | **108 pass / 0 fail / 0 skipped** | **incl. 3 live-devnet smoke checks against the real config PDAs + read-only `evaluatePool` on a real Raydium V4 pool** |
| `indexer` | 29 | **29** | **29 pass / 0 fail** | |
| `ops` | — | **47** | **47 pass / 0 fail** | |
| `adversary` | 39 (Phase 12) | **39** | **39 pass / 0 fail** | 15 threat classes |
| Fork harnesses (7 suites in `programs/grave-vault/tests/`) | 47 tests | **0 executed** | n/a | require `cargo build-sbf` ELFs + ~7 MB mainnet fixtures (`scripts/fetch_v4_fork_fixtures.mjs`); CHANGELOG (Phase 12) admits they were only *compile-validated* post-rollback; they self-skip without fixtures, so CI never runs them either |
| Root `anchor test` | — | 0 tests | n/a | placeholder (`tests/` has only a README) — see D5 |
| OPS scenarios SC-01 / SC-02 (live devnet, read-only) | — | **2 runs** | **both `ok: true`** | indexer cycle ran (discovery-only, 0 results — no oracle key); vault sweep: 0 receipts/claims/registries; SC-02 all 7 audit checks green; vault config readback OK |
| **Total** | | **668** | **668 pass / 0 fail** | |

Skipped-test scan: the only skip mechanism in the repo is `sdk/test/devnetSmoke.test.ts`'s env-gated skip (it **ran** here — 0 skipped). No `#[ignore]`, no `.skip()`, no `todo!()` markers in test code.

**Status classification:**
- **Implemented + tested (host level, this audit):** scanner/vault/snapshotter logic, SDK, indexer, ops, adversary battery.
- **Implemented + compile-validated only:** fork harnesses (47 tests) — the deepest integration evidence (real mainnet Raydium bytecode, full lifecycle, security negatives) has **not been executed** since the Phase 6–12 changes were finalized.
- **Operationally verified (this audit):** devnet deployment existence/shape, config contents, drill execution, SDK read path, OPS scenarios.
- **Not operationally verifiable from here:** fork suites, any authority-gated or oracle-signed devnet flow (dead-key problem), `anchor build` under the CI's exact pinned toolchain (not reproduced locally for the SBF target).

---

## 5. Blocker register (ranked by severity × dependency)

| ID | Severity | Blocker | Evidence | Depends on |
|---|---|---|---|---|
| **B1** | **Critical** | **Dead authority/oracle key custody on devnet.** Single deployer key controls upgrades + config + both oracles; OPS.md states it was wiped. If true: no upgrades, no `update_protocol_config`, no oracle rotation, no `emergency_pause`, no `invalidate_anchor`, and no attestation-gated flow (`record_launch_price`, `evaluate_pool_phase_1/2`) can ever execute against the current deployment. | §1.4 (on-chain authority map) + `OPS.md` §7 + smoke-test comment | — |
| **B2** | **Critical** | **Deployed devnet ELFs stale vs `main`** (4 program commits incl. behavior changes); unfixable in place because upgrading requires B1's key. | §2.3 | B1 (for the upgrade path), resolved by fresh deploy |
| **B3** | **High** | **SDK divergence with stranded bug fixes.** Protocol repo's `sdk/` still ships F1 (priority-fee unit mismatch), F5 (price inversion), F7 (base58 sort) — fixed only in `salvor-bots/src/`; protocol tests pin the F1-buggy behavior. Two "canonical" SDK copies now drift. | §3.1 diff evidence | — |
| **B4** | **High** | **CI gates zero tests.** fmt/clippy/build/typecheck/lints only; the 668 passing tests are not enforced on any PR. Fork harnesses (the deepest 47 tests) are not run anywhere post-Phase-12 (compile-validated only). | §2.4, §4 | — |
| **B5** | **High** | **salvor-bots fresh-clone failure + no CI.** `pnpm -r test`/`typecheck` fail until `pnpm -r build`; repo has no workflows at all. | §3.1 | — |
| **B6** | **Medium** | **Single-key devnet governance** (upgrade + config + oracles one key). Accepted for devnet operability by design; becomes unacceptable on mainnet (Squads 3-of-5 planned). Track, don't fix, on devnet. | §2.6 | B1/B2 resolution defines what "operator keys" even are |
| **B7** | **Medium** | **ORACLE-003 (🟥):** no oracle operational runbook — hosted indexer signing, key custody/rotation for both oracle keys, freshness monitoring (SlotHashes ~512-slot window), downtime policy. Hard mainnet blocker; needed for any real devnet evaluation too. | `PRE_MAINNET_CHECKLIST.md` ORACLE-003 | B1/B2 (needs live oracle keys first) |
| **B8** | **Medium** | **Open CPI/adapter surface (v1.1 scope):** scanner adapters for Raydium CLMM, Orca Whirlpool, PumpSwap, Meteora (CPI-002/003/004/005) and vault CPI stubs (CPI-006/007/008) revert `AmmCpiUnimplemented`/`UnsupportedAmm`; KEYS-001 Meteora placeholder ID; KEYS-002 flat dust threshold. Only Raydium V4 pools are salvageable today. | `PRE_MAINNET_CHECKLIST.md`, 6 source markers | — |
| **B9** | **Low** | **Doc/tooling debt:** D3/D4/D5 above; no committed IDL (`--no-idl`); GOV-001 on-chain timelock fields reserved-only; checklist CI marker-audit not yet implemented; devnet date off-by-one in site + DEVNET.md. | §2.5 | — |

Dependency ordering: **B1 → B2 → (oracle re-pointing) → B7 → first real devnet evaluation**; B3/B4/B5 are independent parallel tracks that should start immediately; B8 is the v1.1 feature line; B9 is housekeeping.

---

## 6. Decision: is the current devnet deployment usable?

**Decision: treat the current deployment as a frozen historical record; require a FRESH devnet deployment for all further protocol-level work. Do not attempt in-place remediation except under the key-recovery contingency below.**

Rationale:

1. **The authority surface is (by the project's own statement) destroyed.** Every governance instruction, both oracle keys, and the upgrade path all resolve to one keypair that custody policy says was wiped. Nothing in this baseline can restore writability of that deployment.
2. **The deployed code is behind `main`** in behavior-relevant ways (§2.3), and cannot be upgraded without that same key.
3. **The oracle-gated pipeline can never run** against the existing configs, because the oracle signer is that same key. Since `ProtocolConfig` is init-once, even a recovered *different* key cannot help — only the original authority could re-point the oracles.
4. What the deployment *does* provide — permanent, verifiable proof of the Phase 11 drill and spec-default configs — is preserved by simply leaving it untouched. It remains referenced by tx signatures in DEVNET.md.

**Contingency (the only alternative):** if the deployer keypair can in fact be recovered from custody, an upgrade-in-place path exists: rebuild both ELFs at HEAD, `solana program deploy` (upgrade) with the recovered authority, then rotate `activity_oracle` / `launch_price_oracle` to fresh dedicated keys via `update_protocol_config`, and re-run the drill. This path is cheaper but depends entirely on key recovery, and leaves the single-key weakness in place. **Owner must state, in writing, which path is real: key recovery (yes/no).**

Fresh-deployment consequences (both paths eventually need these): new program keypairs ⇒ **new program IDs** ⇒ the KEYS-003-style sync must update `declare_id!` ×2, `Anchor.toml`, `deploy_devnet.sh` expected IDs, `protocol_admin.mjs` constants, SDK constants (both copies), console `data.ts`, and the docs' ID tables + tx signature tables.

---

## 7. Exact next steps (with acceptance criteria)

**NS-1 — Owner decision on key custody (gates everything).**
Write the custody answer (key recoverable: yes/no) into a decision record (issue or `docs/DECISIONS.md`).
*Accept:* written decision exists; B1 reclassified from "unknown" to resolved-either-way.

**NS-2 — Fresh devnet deployment (path B; do after NS-1 = no).**
Generate 3 fresh keypairs (scanner, vault, deployer) **in custody, never in git**; fund deployer ≥ 6 SOL; run `scripts/devnet/deploy_devnet.sh`; `protocol_admin.mjs init-all`; run both drills; sync all program-ID references (list in §6); update DEVNET.md status block with the new tx signatures and correct UTC dates.
*Accept:* new IDs live on devnet; both configs decoded at spec defaults (this report's §1.2 checks re-run green); both drills pass (pause → intruder-reject → unpause); `getProgramAccounts` shows exactly 2 accounts; zero references to old IDs remain in active code paths (`grep -rn "5JiCVx\|HUyoG5" --exclude docs/DEVNET.md` returns only historical/appendix mentions); DEVNET.md carries the new signature table.

**NS-3 — Upgrade-in-place (path A; only if NS-1 = yes).**
Rebuild ELFs at HEAD via the CI-equivalent pinned toolchain; deploy-upgrade both programs; re-run both drills (which now also proves the 6006/7022 no-op-refusal on-chain); rotate both oracles to fresh dedicated keys.
*Accept:* `programdata.slot` > deploy slot for both programs; drill passes against the new behavior; config oracles ≠ config authority; SDK smoke tests still green (same IDs).

**NS-4 — Reunify the SDK (B3).** Backport F1/F5/F7 from `salvor-bots/src/` into `graveyield-protocol/sdk/`, update the protocol repo's pinned vectors (they currently pin F1's buggy behavior), and adopt a single-source-of-truth policy (protocol repo ships the package; salvor-bots consumes it — or vice versa — with a CI drift check on the shared files).
*Accept:* `diff -r` between the two copies is empty for the shared modules or the vendoring policy is documented in both repos; protocol SDK tests updated and green; a CI job fails on future divergence.

**NS-5 — Gate the tests that already exist (B4).** Add CI jobs: `cargo test -p grave-scanner --lib && cargo test -p grave-vault --lib && cargo test -p grave-snapshotter`, and `pnpm -r build && pnpm -r test` (protocol), plus a nightly/label-gated fork-harness job (`scripts/build_fork_harness.sh` + `fetch_v4_fork_fixtures.mjs` + the 7 fork suites).
*Accept:* every PR runs ≥ 668 host/TS tests; a nightly run executes 47/47 fork tests green; a deliberately seeded failure turns CI red (verify once).

**NS-6 — Fix salvor-bots DX + add CI (B5).** Add `pretest: pnpm -r build` (or make `test` depend on build) and a minimal CI workflow (typecheck + build + test).
*Accept:* fresh clone passes `pnpm -r test` without manual pre-build; CI green on next push.

**NS-7 — Oracle runbook (B7 / ORACLE-003).** Write the operational runbook covering both oracle flows: hosted indexer derivation of last-swap + launch-price attestations, signing service, key custody + rotation drills, SlotHashes freshness monitoring, downtime policy.
*Accept:* `docs/ORACLE_RUNBOOK.md` exists; ORACLE-003 row moves to Retired with PR SHA; `scripts/list-pre-mainnet-todos.sh` output reconciled.

**NS-8 — Documentation corrections (B9 / D1–D5).** Fix: OPS.md "de-pointed" wording (→ "pointed at the destroyed deployer key; unusable"), DEVNET.md 2-SOL vs 6-SOL contradiction, execution dates (2026-10-08 UTC) in DEVNET.md + site, tests/README `anchor test` claim, and add a "deployed ELF vintage" note or (post NS-2/NS-3) remove it.
*Accept:* doc-links + terminology lint green; this report's discrepancy table D1–D5 each marked resolved or explicitly accepted.

**NS-9 — (Recommended) Generate and commit IDLs.** Use the nightly toolchain step CI already documents as deferred; commit `target/idl/*.json`.
*Accept:* IDL files in repo; `protocol_admin.mjs`/SDK discriminator tables cross-checked against IDL once (one-off assertion test).

---

## 8. Verified facts vs documentation claims vs unknowns

**Verified facts (evidence above):** program IDs, deployment existence/slots/ELF sizes, upgrade authority identity, config addresses + every field value, drill transactions on-chain, exactly-2-accounts universe, no upgrades since deploy, no keypairs in git, program-ID consistency across all repos, CI job inventory (no tests), 668/668 local test passes incl. live devnet smoke + SC-01/02, SDK divergence contents (F1/F5/F7), salvor-bots fresh-clone failure, deployed-ELF staleness (4 commits), oracle signer = deployer key on-chain.

**Documentation claims (consistent with evidence, not independently provable from chain):** drill intruder-rejection occurred (no on-chain trace possible); deployer keys wiped (consistent with frozen funds + custody policy; unverifiable); Phase 2.1–6 fork proofs ran when their phases shipped (CHANGELOG/test-README narrative; not re-runnable here); Phase 12 fork tests compile-validated only (CHANGELOG admission — taken at face value).

**Unknowns (ranked):** (1) does the deployer keypair still exist in anyone's custody? — the single decision-critical unknown (NS-1); (2) exact source commit the deployed ELFs were built from (≈`5cc46cd`±hours; ELF hash comparison would settle it if a reproducible build is ever set up); (3) whether dependabot's open Oct-17 bumps (tokio, serde_json, types/node) hide any breakage — CI green on their branches, unmerged as of audit; (4) console runtime behavior beyond static review (not built/run in this audit; static claims verified only).

---

## Appendix A — Reproduction

On-chain: raw JSON-RPC against `https://api.devnet.solana.com` — `getAccountInfo` on the four addresses in §1.1/§1.2; `getTransaction` (json, maxSupportedTransactionVersion 0) on the eight signatures in §1.1; `getSignaturesForAddress` on both program IDs and both config PDAs (limit 100 — returns exactly the 8 transactions above and nothing else); `getProgramAccounts` on both program IDs; `getBalance` on `GCCuhCXd…` → 5,974,471,920 lamports; `getEpochInfo` → epoch 1191. PDA derivation: `sha256(seed ‖ bump ‖ program_id ‖ "ProgramDerivedAddress")` off-curve search; ProgramData decode: tag u32 (=3) ‖ slot u64 ‖ Option u8 ‖ authority [32] (borsh layout, verified against raw hex).

Tests: `cargo test -p grave-scanner --lib` / `-p grave-vault --lib` / `-p grave-snapshotter` (Rust 1.91.1); `pnpm install && pnpm -r build && DEVNET_RPC_URL=https://api.devnet.solana.com pnpm -r test` (protocol); same pattern in `salvor-bots` (build before test). OPS scenarios: `RPC_URL=… OPS_STATE_DIR=… node ops/dist/bin.js scenario sc-01|sc-02`.

Raw evidence artifacts from this audit (session-local, not committed): `dv_check_output.json`, `dv_check2_output.json`, `ops-state/scenario-sc-01-*.json`, `ops-state/scenario-sc-02-*.json`, `rust_tests.log`.

## Appendix B — Key addresses reference (all public keys, no secrets)

| Role | Value |
|---|---|
| GraveScanner program | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` |
| GraveVault program | `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` |
| Scanner ProgramData | `DzRuBh14DDEoLh3s7XZWFX3GmpqFMthobw87cNvaDMFX` |
| Vault ProgramData | `on8DEjwWa4ok7AnbJ2buzuVLGz6Q3AqvQgPzcjDQQsw` |
| Scanner ProtocolConfig PDA (bump 255) | `GcdZJhCpg7sjgEEHTsoSkT2Pi83d8kP3NrTqdvMm2Bhu` |
| Vault ProtocolConfig PDA (bump 255) | `2SCqqpEwKMuWnJWe7UQJTzFeDPif4jUPUspWKZdZ5vaU` |
| Deployer / upgrade authority / config authority / both oracles | `GCCuhCXd5qWVUik38Qv3maoRUoe2upiyJByo2Qyb68yk` |
