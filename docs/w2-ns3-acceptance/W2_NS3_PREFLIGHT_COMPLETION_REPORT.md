# W2 — NS-3 Devnet Preflight Completion Report

**Prepared for:** the GraveYield owner (sole reviewer; sole custody holder)
**Scope:** W2 preflight completion only — no redesign, no security audit, no deployment.
**Verification commit:** `80fdfca2dd686985967a308101c6fca92f84f10b` ("fix: seed verified platform-tools v1.54 cache"), branch `main`
**Verification window:** 2026-11-12, 02:16–03:05 UTC (all live evidence timestamped in §14)
**Custody:** untouched. No keypair was read, requested, derived, stored, or displayed. No transaction was signed, simulated, or submitted. No blockchain state was changed.

---

## 1. Executive summary

Every work package (WP1–WP6) was completed against the current HEAD with direct evidence, and every check that this preflight could execute locally passed:

- The repository is at the expected commit with a clean tree and no drift from `origin/main`.
- CI on `80fdfca` is green (all enumerated check runs `success`, including `anchor build`, the fail-closed ELF provenance gate, and the salvor-bots SDK mirror sync).
- The platform-tools v1.54 compiler-resolution question is **resolved with evidence at three independent levels**: agave v3.0.10 source (workspace metadata IS read), the binary's own version banner (built-in default is v1.51, overridden by metadata), and this sandbox's actual build run (rustup linked `1.89.0-sbpf-solana-v1.54`; atime evidence confirms the v1.54 cache directory was the executed toolchain).
- A fresh `deploy_devnet.sh --build-only` run was safety-verified by reading the script first, then executed in a clean sandbox: both programs compiled, both ELFs byte-match the provenance manifest pins exactly (independent `sha256sum`), SBPF v0 and NS-3 structural identity passed, legacy canaries passed, and the fail-closed provenance gate returned `PROVENANCE OK`.
- The devnet-tools test suite passes **410/410** (including the 37 deployment-gate regression tests) at HEAD.
- Read-only Devnet RPC confirms: the cluster genesis matches the pinned Devnet genesis exactly; the deployer balance is exactly **12.1 SOL** and governance exactly **10.0 SOL** at 2026-11-12T02:37:23Z; nothing exists yet at the NS-3 addresses — the documented "assigned, NOT yet deployed" state.
- All four repositories (protocol, salvor-bots, console, indexer) carry consistent NS-3 identities; `sdk/src` and `salvor-bots/src` are byte-equal; NS-1/NS-2 references are historical records or fail-closed canaries, never active configuration.

**Overall W2 preflight classification: READY FOR OWNER REVIEW.**

This classification is NOT deployment acceptance. The on-chain acceptance verifiers legitimately report FAIL today because nothing is deployed yet — the deployment itself is the owner's manual act (mode 2 of `docs/DEVNET.md`). The preflight establishes that the bytes, toolchain, identities, scripts, funding, and verification pipeline are all verified and waiting on the owner's execution. No blocker to the owner executing the deployment was found.

**Report delivery note (explicit interpretation, flagged for owner review):** the task brief's prohibited list forbids commit/push of *code*, while the final instruction directs this report to be pushed and a PR opened. This report is documentation only — no source file, manifest, identity, or configuration was modified. It is delivered as a new file on an unmerged branch with a PR for owner review; nothing was merged. If the owner disagrees with this interpretation, close the PR; the same file is also delivered out-of-band.

---

## 2. Repository baseline

| Requirement | Status | Evidence |
|---|---|---|
| Current HEAD and branch | **PASS** | `80fdfca2dd686985967a308101c6fca92f84f10b` on `main` (§14.1) |
| Local `main` matches `origin/main` | **PASS** | `git branch -vv`: no ahead/behind; GitHub branch API independently reports the same SHA (§14.1) |
| Working tree clean | **PASS** | `git status --porcelain` empty (§14.1) |
| Commit `80fdfca` is the v1.54 cache change | **PASS** | Full subject line matches; PR #100/#101 merges and `e752b9c` present in history (§14.1) |
| Working-tree state after clone | **PASS** | Fresh clone at 02:16:29Z; no local artifacts existed before this session |

The historical claims in the task brief (W1 rehearsal, Stage 16 guard, PR #100/#101, `e752b9c`, `80fdfca`) were reconfirmed against the actual history, not taken on trust (§14.1).

## 3. CI results

| Requirement | Status | Evidence |
|---|---|---|
| CI status of the current commit | **PASS** | GitHub Actions run "CI" for SHA `80fdfca…`: completed / **success** (event: push, created 2026-11-12T01:48:05Z — immediately after the push) (§14.2) |
| Check runs green | **PASS (12 of 12)** | All 12 check runs for the SHA individually enumerated, all `success`: `anchor build`, `cargo clippy`, `cargo fmt --check`, `cargo test (host)`, `pnpm build + test`, `pnpm typecheck`, `ts lint + format`, `sdk sync (salvor-bots mirror)`, `doc link integrity`, `terminology lint`, and both CodeQL analyses (`Analyze (javascript-typescript)` ×2: source + actions) (§14.2) |
| v1.54 cache change passed CI | **PASS** | The `anchor build` job — which consumes the platform-tools pinning mechanism — is `success` on this exact SHA, including its fail-closed `Verify ELF deployment provenance` step (§14.2, ci.yml lines 356–513) |

No inference from earlier commits was used: every query was filtered by the current SHA.

## 4. Toolchain and platform-tools findings (WP2)

The manifest pins (`scripts/devnet/provenance.manifest.json`): `solana_cli 3.0.10`, platform-tools **v1.54**, archive SHA-256 `fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e`, SBPF v0 (`e_machine 263`, `e_flags 0`).

Distinguishing the five layers the task required:

| Layer | Finding | Status |
|---|---|---|
| 1. Workspace metadata | `Cargo.toml` declares `[workspace.metadata.solana] tools-version = "v1.54"` with the comment "cargo-build-sbf reads this" | **PASS — claim verified true** (source-level, below) |
| 2. Installed cargo-build-sbf | `solana-cargo-build-sbf 3.0.10` (release tarball, tag `v3.0.10`); its own banner prints the compiled-in default `platform-tools v1.51` | **PASS** |
| 3. Anchor's toolchain override | Repo-documented mechanism (ci.yml lines 343–355): anchor 1.2.2 passes `--tools-version v1.57`; cargo-build-sbf honors the flag; CI pre-seeds v1.51 + v1.57 with verified v1.54 bytes | **PASS (repo-documented; not on this deploy path)** |
| 4. Actual platform-tools binary selected during the build | Three-level evidence, below | **PASS — v1.54 bytes executed** |
| 5. Cache directories seeded by the script | `deploy_devnet.sh` lines 261–275: `rm -rf` + re-extract of v1.51, v1.54, v1.57 from the hash-verified archive, every run | **PASS** |

**Resolution evidence (three independent levels):**

1. **Source (authoritative).** agave tag `v3.0.10`, `platform-tools-sdk/cargo-build-sbf/src/toolchain.rs`: `DEFAULT_PLATFORM_TOOLS_VERSION = "v1.51"`; `install_and_link_tools()` reads `metadata.workspace_metadata.get("solana").get("tools-version")` when no `--tools-version` flag is passed and uses it in preference to the default; `install_if_missing()` skips the download when `~/.cache/solana/<ver>/platform-tools` exists and is non-empty, and **never validates the directory's contents**. Therefore: the deploy flow (`cargo build-sbf`, no flag) resolves **v1.54** via the workspace metadata; the seeded directory contents are the only integrity guarantee — exactly the gap the script's fix-B re-seed closes every run (§14.3).
2. **Binary.** `cargo-build-sbf --version` prints `platform-tools v1.51` (the default constant), consistent with (1).
3. **Runtime (this sandbox's build).** After the run, rustup showed a linked toolchain named **`1.89.0-sbpf-solana-v1.54`** — the name is only derivable from the v1.54 resolution path (base rust version probed from the v1.54 directory). The v1.54 cache directory's `rust/bin/rustc` carries the latest access time among the three seeded dirs (02:44:19Z, during the build; v1.57's remained at its extraction time 02:43:13Z, i.e. never executed; v1.51's 02:44:02Z matches the source's `get_base_rust_version(DEFAULT)` compatibility probe). The final ELF digests byte-match the pins recorded from the pinned toolchain (§5), closing the loop.

**Honest nuances (recorded, none affect provenance):**

- The second `cargo-build-sbf` invocation's generated script traced a `rustup toolchain link 1.84.1-sbpf-solana-v1.51` — the default-format *name*. Because every seeded directory contains byte-identical verified v1.54 contents, whichever name resolves, the executed bytes are the verified v1.54 toolchain; this name-vs-content distinction is precisely why the plaintext stamp is never trusted and the archive digest is the only trust anchor. The provenance invariant holds under either resolution.
- cargo-build-sbf's post-processing fetched a third-party Criterion tarball (Snaipe/Criterion v2.3.3, unverified). It does not enter the deployed bytes — the final ELF digests byte-match the manifest pins regardless (digest-neutral, empirically proven).
- This sandbox ran the build with `CARGO_BUILD_JOBS=1` (memory-constrained container). Parallelism does not affect ELF bytes (`codegen-units = 1`, `lto = "fat"` in the release profile), and the digest match proves it.

## 5. Build and ELF provenance results (WP3)

**Safety gate first:** the `--build-only` path (`deploy_devnet.sh` lines 375–396) was read line-by-line before execution: it touches no keypair argument, performs no RPC, runs no `solana` CLI command, and exits before the deploy-path code. The only network operation is the pinned platform-tools download when the local archive copy is missing, which is digest-verified against the manifest before extraction (fail-closed). Execution was therefore permitted and performed.

| Requirement | Status | Evidence |
|---|---|---|
| Both programs compile | **PASS** | `Finished release profile` for scanner (3m 29s) and vault (5.73s), exit 0 (§14.4) |
| Both ELFs exist | **PASS** | `target/deploy/grave_scanner.so`, `target/deploy/grave_vault.so` |
| SHA-256 match manifest | **PASS** | Independent `sha256sum`: scanner `e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98`, vault `8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83` — both identical to the manifest pins (§14.4) |
| SBPF architecture checks | **PASS** | Gate output: `SBPF v0 confirmed (e_machine 263, e_flags 0)` for both ELFs |
| NS-3 identity checks | **PASS** | `structural NS-3 identity OK (1 occurrence(s) inside allocated sections)` for both |
| Legacy identity canaries | **PASS** | No NS-1/NS-2 ID bytes (`5JiCV…`, `HUyoG5…`, `CuQZes…`, `Bd5smh…` — the fail-closed `NS3_LEGACY_IDS` list in `ns3_verify_elf.mjs`) present in either ELF (gate passed; any hit closes it) |
| Platform-tools archive digest verification | **PASS** | `platform-tools v1.54 archive OK (sha256 fcc41631…)` — verified by the bounded checker before seeding, and again by the final gate |
| Provenance verification | **PASS** | `PROVENANCE OK — the bytes to deploy are exactly the recorded deployment digests.`; wrapper exit 0 (§14.4) |

**A build-only success is not a Devnet deployment success** — restate of the task's own rule: the on-chain acceptance verifiers (§9) currently report FAIL, which is the correct pre-deployment state.

## 6. Deployment script review (WP4)

Reviewed in full: `scripts/devnet/deploy_devnet.sh` (527 lines), `scripts/devnet/protocol_admin.mjs` (guard and authority sections), `docs/DEVNET.md` (755 lines), the CI workflow, and the deployment-gate tests.

| Question | Finding |
|---|---|
| Deployer identity consistent everywhere | **Yes.** `EXPECTED_*` constants (deploy script lines 101–102) == `Anchor.toml` `[programs.devnet]` == `ns3_identities.mjs` == SDK/config constants in all downstream repos; consistency is asserted by `test/ns3_sync.test.mjs` (green) |
| Scanner/vault keypair identities expected to match approved IDs | **Yes, and enforced.** Keypair pubkeys must equal the compiled `declare_id!` values or the script refuses (lines 432–440); keypairs are owner-held outside the repository and never copied into `target/deploy/` (CI additionally drops any cached keypair, ci.yml lines 376–385) |
| Fee payer / initial upgrade authority relationships correct | **Yes.** Deployer signs and pays both deploys and becomes initial upgrade authority (decoded from ProgramData at acceptance); governance is the initial and permanent ProtocolConfig authority; `register-oracle` re-points the two scanner oracle fields from governance to the dedicated keys (DEVNET.md §3–§4, the "honest form" note) |
| Deployment sequential and non-atomic | **Yes.** Two separate `solana program deploy` invocations (lines 500–503); no atomicity is claimed anywhere |
| Scanner succeeds but Vault fails | Script exits non-zero at the failed deploy; Scanner remains live and upgradeable by the same authority. Recovery is documented: a re-run repeats the full gate sequence and the Scanner deploy becomes an UPGRADE (same address, same authority — DEVNET.md lines 308–311); the provenance gate and identity checks still apply on every retry. Balance for the remaining Vault deploy is re-checked by stage [3/7] on the re-run |
| Recovery and retry behavior adequately documented | **Yes** — mode-2 stage list, funding sequence, and the redeploy-as-upgrade rule cover the partial-failure path. One minor operational inconsistency was found (below) |
| Balance that must remain after deployment | Runbook: no enforced post-deploy floor; the owner re-checks the live lamport balance after BOTH deploys and before `init-*`, and must cover two init fees plus the optional `register-oracle` fee — dust-scale. Against the ≈5.7–6.0 SOL estimated deployment expenditure from 12.1 SOL observed, the expected remaining headroom is ≈6+ SOL — ample |
| Governance and oracle roles as intended | **Yes.** On Devnet the admin CLI hard-pins the governance authority for every governance operation (deployer/oracles/other keys refused); `--authority` is mandatory on `init-*` (no deployer fallback); oracle registration is governance-signed with an optional separate fee payer |
| Required owner decisions remaining | None found in the repository for W2 devnet (DECISIONS.md has no open items; multisig/timelock wiring is explicitly mainnet scope — KEYS-003/GOV-001). The only remaining W2 "decision" is executing the deployment itself, which is the owner's act by design |

**Minor operational finding (non-blocking):** `scripts/devnet/deploy_devnet.sh` is committed with mode 100644 (not executable), while `docs/DEVNET.md` §2/§3 and the script header invoke it as `scripts/devnet/deploy_devnet.sh …`. A fresh clone executing the documented command line gets `Permission denied`; `bash scripts/devnet/deploy_devnet.sh …` works. Recommend either `chmod +x` in a reviewed PR or a docs note (§13, step 6).

## 7. Authority and custody findings

| Requirement | Status | Evidence |
|---|---|---|
| NS-3 identity baseline matches repository | **PASS** | All eight values in the task brief byte-match `ns3_identities.mjs` (the single identity module), `Anchor.toml`, `deploy_devnet.sh`, `docs/DEVNET.md`, and the downstream repos |
| Pinned Devnet genesis | **PASS** | Live `getGenesisHash` at 02:37:23Z returned `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` — exact match (§14.5) |
| ProtocolConfig PDAs | **PASS** | Locally re-derived with `ns3_derive_pdas.mjs` (node, offline): scanner `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe`, vault `5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda`, both bump 255 — match the brief and the pinned derivations |
| Owner-reported balances re-checked read-only | **PASS (deployer, governance)** | Deployer 12,100,000,000 lamports (12.1 SOL); governance 10,000,000,000 lamports (10.0 SOL) — exactly the owner's reported figures (§14.5). Intruder: address not supplied in the brief, not checkable — **UNVERIFIED** (owner-reported 0.1 SOL; requirement is 0.01 SOL fee dust, so the claim is sufficient if accurate) |
| Custody boundaries respected | **PASS** | No keypair file was accessed, requested, or displayed; no private key material exists in any workspace used; no transaction was signed/simulated/submitted; no cluster state changed; no `solana` config was created or mutated (all RPC via explicit-endpoint JSON-RPC `curl`) |
| Historical identities not substituted | **PASS** | The historical deployer `5mUyn9Lf…` appears nowhere in any active configuration; NS-1/NS-2 IDs appear only as documented history and fail-closed canaries (§10) |

## 8. Initialization and oracle registration requirements

Sequence after the owner's two deploys (all owner-executed, mode 2; full commands in DEVNET.md §3–§4):

1. `protocol_admin.mjs init-scanner` and `init-vault` — deployer keypair signs/pays; `--authority BMnrpx9m…` REQUIRED (refused if omitted or malformed; on Devnet the governance key is hard-pinned — deployer and oracle keys are refused). All-zero params land the approved spec defaults (table DEVNET.md §4: scanner 90 d inactivity / 99 % collapse / 0.5 SOL min TVL / 14 d staleness / 1 000 LP dust / 3 600 s cert TTL; vault 4000/4000/2000 bps / 1 SOL priority ceiling / 300 bps slippage / 666 666 dust / 72 h reserved timelock). Re-init on an initialized config fails at the Anchor init constraint — init-once by design.
2. Emergency-control drills per program — governance keypair signs AND pays its two transactions; a throwaway intruder keypair attempts an unauthorized pause and MUST revert with the program's `Unauthorized` (scanner 6000 / vault 7000); intruder needs its own 0.01 SOL dust.
3. `register-oracle` — governance is the only instruction-level signer; `--fee-payer` deployer optional; wires the two dedicated oracle keys (`2ZygwHN…`, `97JVKVd…`) into the scanner config. Until this runs, both oracle fields still equal the initialization authority and the acceptance verifier will keep reporting Section C FAIL — by design.
4. Acceptance verification — read-only (§9); both verifiers must pass on the same cluster.

Funding prerequisites against observed balances: deployer 12.1 SOL (≥ 6 SOL gate; ample for deploys + fees), governance 10.0 SOL (drills; ample), intruder 0.1 SOL claimed (0.01 needed; claim not independently checkable). **No unresolved policy decision was found** — everything above is already specified in the repository; the only remaining actor is the owner.

## 9. Read-only acceptance verifier review (WP5)

`scripts/devnet/verify_ns3_deployment.mjs` (1,259 lines) reviewed with emphasis on behavior, plus its 45,877-byte test suite:

- **Read-only by construction:** the only RPC methods reachable are `getEpochInfo`, `getGenesisHash`, `getAccountInfo` (code-checked; no `sendTransaction`/`signTransaction`/`simulateTransaction`/`requestAirdrop` anywhere). `read_only: true` is emitted in JSON output. The CLI accepts only `--url`, `--commitment`, `--json`; the former identity-override flags are actively refused (usage error), so the eight pinned identities can never be coaxed (fix C).
- **Genesis gate first:** a foreign genesis is an immediate FAIL with no deployment check evaluated; a failed genesis request is UNVERIFIED → INCOMPLETE. Verified in code (lines 387–429).
- **Required checks confirmed present:** program existence/executability/loader ownership; embedded ProgramData pointer == independently derived loader PDA; ProgramData decode (u32 tag 3 + u64 slot + 1-byte authority flag + 32-byte authority at offset 13); upgrade authority == deployer; independent PDA derivation (bump 255); account ownership; Anchor `account:ProtocolConfig` discriminator (first 8 bytes of sha256("account:ProtocolConfig")); byte-offset schema decode against the Rust structs; governance authority; the two approved default tables; dedicated oracle identities; pause flags reported verbatim; NS-1/NS-2 residual report-only section; RPC-failure handling (never misread as absence); PASS/FAIL/UNVERIFIED per check with overall PASS (exit 0) / FAIL (exit 1) / INCOMPLETE (exit 3) / usage (exit 2).
- **Tests:** the full devnet-tools suite passes **410/410** at HEAD, including `verify_ns3_deployment.test.mjs` (mock-based behavior tests) and the 37 deployment-gate tests (`deploy_gate.test.mjs`). Mock tests are treated as behavior evidence only — live state below is the on-chain evidence.
- **Live run (2026-11-12T02:50:0xZ, slot 521319065, FINALIZED):** overall **FAIL (pass 3 / fail 26 / unverified 0 / info 4)**, exit 1. Genesis PASS; both independent PDA derivations PASS; every other FAIL is the precise "no account exists at …" absence message. Per the verifier's own semantics and DEVNET.md §5: **this is the correct report for a not-yet-executed deployment — a deployment prerequisite, not a verifier defect.** The same shape was recorded by the committed §5.1 tool `verify_ns3_elf_digests.mjs` (overall FAIL, pass 1 / fail 26, exit 1; genesis PASS; strict short-circuit behavior intact).
- The prior committed acceptance record (`docs/w2-ns3-acceptance/W2_ACCEPTANCE_REPORT.md`, classification REJECTED at commit `eaaf935…`) describes exactly this state and stands unchanged by this preflight.

## 10. Cross-repository identity consistency (WP6)

| Repository | NS-3 identities | Legacy NS-1/NS-2 references | Classification |
|---|---|---|---|
| `graveyield-protocol` @ `80fdfca` | `declare_id!` in both `lib.rs`, `Anchor.toml`, deploy script, admin CLI, SDK, identity module — all identical (asserted by green `ns3_sync.test.mjs`) | `lib.rs` header comments ("never reuse"), `Anchor.toml` comment, `NS3_LEGACY_IDS` canary list in `ns3_verify_elf.mjs` (fail-closed ELF scan), `docs/LEGACY_DEPLOYMENTS.md` (designated sole home of execution records), tests | Intentional historical records + defensive canaries — never active config |
| `salvor-bots` @ `8d8b6aa` | `DEVNET_SCANNER_PROGRAM_ID` / `DEVNET_VAULT_PROGRAM_ID` exact match | One doc comment pointing at `docs/LEGACY_DEPLOYMENTS.md` | Historical comment only |
| `graveyield-console` @ `9e000a9` | `PROGRAM_IDS` constants: both program IDs AND both PDAs exact match; deployment date `null` until recorded | Labeled `ns1:`/`ns2:` historical record objects ("shared authority key permanently lost (DR-002)") | Intentional historical records |
| `grave-indexer` @ `17998ba` | `config.ts` NS-3 program IDs + `NS3_GOVERNANCE_AUTHORITY` exact match; deployer named as fee payer / upgrade authority only | Comments + NS-2-era `examples/*.json` evidence bundles | Intentional historical records |

Additional hard evidence: `diff -r sdk/src salvor-bots/src` is **byte-equal** (the policy CI's `sdk sync (salvor-bots mirror)` job enforces on every push — green on this SHA — plus a weekly cron for salvor-side-only edits). All four repositories are public and were inspected read-only; none was modified.

## 11. Outstanding blockers

**None for the W2 preflight.** For completeness, the deployment-prerequisite list (expected state, not blockers to THIS preflight):

1. The two NS-3 programs are not yet deployed on Devnet (accounts absent) — owner mode-2 execution required.
2. ProtocolConfig PDAs uninitialized; oracle fields not yet rotated; drills not yet run — owner sequence per §8.
3. Acceptance verifiers will keep reporting FAIL until (1)–(2) are done — by design.

## 12. Owner decisions required

1. **Execute the NS-3 deployment** (mode 2, DEVNET.md §3) — owner custody keys on an owner-controlled host. Exact command sequence in §13.
2. **Review and merge (or close) this report's PR** — the report was delivered as documentation on an unmerged branch per the final instruction of the task; the merge decision is the owner's. No code, manifest, identity, or configuration file was touched.
3. **Rotate the GitHub PAT provided in the task chat** — it transited the conversation in plaintext. This report never stores, displays, or embeds it. Recommend revoking and re-issuing from `github.com/settings/tokens` regardless of whether it is used again.
4. **Optional:** confirm the intruder keypair's 0.1 SOL balance (address not supplied to this preflight; 0.01 SOL dust is required by the drills).

## 13. Exact recommended next steps

All steps owner-executed on an owner-controlled host, from a fresh clone of `main` (one documentation nit first):

1. *(Housekeeping PR)* `git mv`-free fix: make the runbook command executable — `git update-index --chmod=+x scripts/devnet/deploy_devnet.sh` in a reviewed PR, or add "run via `bash`" to DEVNET.md §2/§3.
2. `bash scripts/check-toolchain.sh` — confirm the five pinned tools (solana 3.0.10, anchor 1.2.2, rust 1.91.1, node 24, pnpm 9).
3. `bash scripts/devnet/deploy_devnet.sh --build-only` — rebuild + provenance gate (this preflight already proved it byte-reproduces the pinned digests on a clean host).
4. Fund re-check (read-only): `solana --url https://api.devnet.solana.com balance --lamports <deployer>`, `<governance>`, intruder — must satisfy DEVNET.md §3 before proceeding.
5. Deploy: `bash scripts/devnet/deploy_devnet.sh --url https://api.devnet.solana.com --scanner-keypair <KP> --vault-keypair <KP> --deployer <KP>` (the script's seven fail-closed stages run automatically).
6. Initialize, drill, register oracles — DEVNET.md §4 commands verbatim (governance authority `BMnrpx9m…`; oracles `2ZygwHN…`, `97JVKVd…`).
7. Acceptance: `node scripts/devnet/verify_ns3_deployment.mjs --url https://api.devnet.solana.com` and `node scripts/devnet/verify_ns3_elf_digests.mjs --url https://api.devnet.solana.com` — both must PASS (exit 0). Record the signatures in DEVNET.md per its own instruction.
8. Merge or close the report PR; rotate the PAT (§12.3).

## 14. Evidence appendix

Verification commit for every item below: `80fdfca2dd686985967a308101c6fca92f84f10b`. Full logs preserved in the session workspace: `scripts/build_only_run1.log`, `scripts/devnet_tests.log`, `scripts/verify_acceptance_live.txt`, `scripts/verify_elf_digests_live.txt`, `scripts/devnet_ro_checks.sh` + its transcript.

### 14.1 Repository baseline (02:16:29Z)

```
$ git rev-parse HEAD
80fdfca2dd686985967a308101c6fca92f84f10b
$ git log --oneline -3
80fdfca fix: seed verified platform-tools v1.54 cache
e752b9c test: add scanner protocol config layout coverage
9c2f704 Merge pull request #101 from GraveYield/fix/ci-apt-mirror-transient-retry
$ git branch -vv
* main 80fdfca [origin/main] fix: seed verified platform-tools v1.54 cache
$ git status --porcelain=v1
(empty)
# GitHub branch API (independent): branches/main commit.sha = 80fdfca2dd68…f10b
```

### 14.2 CI for the current SHA

```
$ GET /repos/GraveYield/graveyield-protocol/commits/80fdfca…/check-runs   → total_count 12
  ALL 12 completed/success: Analyze (javascript-typescript) ×2 (CodeQL source + actions);
  doc link integrity; pnpm typecheck; cargo clippy; pnpm build + test;
  sdk sync (salvor-bots mirror); cargo fmt --check; terminology lint; anchor build;
  cargo test (host); ts lint + format
$ GET /actions/runs?head_sha=80fdfca…  → CI: completed/success (push, 2026-11-12T01:48:05Z);
  CodeQL: completed/success; Code Quality: completed/success
```

### 14.3 Toolchain-resolution source evidence (agave tag `v3.0.10`, `platform-tools-sdk/cargo-build-sbf/src/toolchain.rs`)

```rust
pub(crate) const DEFAULT_PLATFORM_TOOLS_VERSION: &str = "v1.51";
// install_and_link_tools():
let workspace_tools_version = metadata.workspace_metadata
    .get("solana").and_then(|v| v.get("tools-version")).and_then(|v| v.as_str());
// match (workspace, package): (Some(w), None) => w; (None, None) => DEFAULT…
let platform_tools_version = validate_platform_tools_version(platform_tools_version, DEFAULT…);
if !config.skip_tools_install { install_tools(config, &platform_tools_version, false); }
// install_if_missing(): skips download iff ~/.cache/solana/<ver>/platform-tools
// exists and is non-empty; the directory's CONTENTS are never validated.
```

Runtime evidence from the build run: `rustup toolchain list` → `1.89.0-sbpf-solana-v1.54` (linked);
atimes of `<cache>/vX/platform-tools/rust/bin/rustc`: v1.51 02:44:02Z (default-version probe),
v1.54 02:44:19Z (executed), v1.57 02:43:13Z (never executed).

### 14.4 Build-only run (single pass, exit 0; CARGO_BUILD_JOBS=1 on a 2-core/4-GB container)

```
$ bash scripts/devnet/deploy_devnet.sh --build-only
== platform-tools archive re-verification: ~/.cache/solana/.graveyield-platform-tools-v1.54.tar.bz2 ==
bounded-provenance-check: checker exited 0 with the recorded 'PROVENANCE OK' verdict — exit 0
platform-tools v1.54 archive OK (sha256 fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e)
platform-tools v1.54 cache seeded from the verified archive: ~/.cache/solana/v1.51/platform-tools
platform-tools v1.54 cache seeded from the verified archive: ~/.cache/solana/v1.54/platform-tools
platform-tools v1.54 cache seeded from the verified archive: ~/.cache/solana/v1.57/platform-tools
cargo-build-sbf version OK: solana-cargo-build-sbf 3.0.10
   Compiling grave-scanner v0.1.0 … Finished `release` profile [optimized] target(s) in 3m 29s
   Compiling grave-scanner v0.1.0 … Compiling grave-vault v0.1.0 … Finished … in 5.73s
== provenance gate (scripts/devnet/provenance.manifest.json) ==
PASS [digest-scanner] sha256 e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98 matches the … pin
PASS [arch-scanner]   SBPF v0 confirmed (e_machine 263, e_flags 0)
PASS [identity-scanner] structural NS-3 identity OK (1 occurrence(s) inside allocated sections)
PASS [digest-vault]   sha256 8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83 matches the … pin
PASS [arch-vault]     SBPF v0 confirmed (e_machine 263, e_flags 0)
PASS [identity-vault] structural NS-3 identity OK (1 occurrence(s) inside allocated sections)
PASS [platform-tools] platform-tools v1.54 tarball sha256 matches the manifest pin
PROVENANCE OK — the bytes to deploy are exactly the recorded deployment digests.
== build-only complete — ELFs in target/deploy/ are provenance-verified (gitignored). Nothing was deployed. ==

$ sha256sum target/deploy/*.so        # independent re-hash, outside the gate
e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98  target/deploy/grave_scanner.so
8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83  target/deploy/grave_vault.so

# Archive fetched fresh from the manifest URL; pre-gate local digest check:
platform-tools archive sha256: fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e
manifest pin     sha256:       fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e  → DIGEST MATCH
```

Tool versions used: solana-cli 3.0.10 (src:96c3a851), solana-cargo-build-sbf 3.0.10, host rust/cargo 1.91.1
(rustup, per `rust-toolchain.toml`), node v24.22.2, platform-tools archive v1.54 (digest above).

### 14.5 Read-only Devnet RPC (endpoint `https://api.devnet.solana.com`, explicit on every call)

```
timestamp_utc=2026-11-12T02:37:23Z
getGenesisHash      → "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"   (= pinned; MATCH)
getAccountInfo scanner EFJpKtWx…AQJL → value: null   (not deployed — expected)
getAccountInfo vault   7VxUGJNg…shya → value: null   (not deployed — expected)
getAccountInfo scanner PDA 5PK9pz4F… → value: null   (uninitialized — expected)
getAccountInfo vault   PDA 5aocH2UA… → value: null   (uninitialized — expected)
getBalance deployer   cfJKAzSp…4831 → 12100000000 lamports (12.1 SOL)
getBalance governance BMnrpx9m…uwf5 → 10000000000 lamports (10.0 SOL)
```

### 14.6 Local PDA derivation (offline, `node scripts/devnet/ns3_derive_pdas.mjs`)

```
Scanner ProtocolConfig PDA 5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe (bump 255)
Vault   ProtocolConfig PDA 5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda (bump 255)
Scanner ProgramData FxYDhTruh16EoKBgiJaWZCQ9QojWQZGS8J1dXyfSt9dG   (PDA([scanner ID], BPFLoaderUpgradeable))
Vault   ProgramData 9wyRhAC8Sasb46bhWW4jxsK6rGKpEGXf6Riz2ibKZgC4
```

### 14.7 Test suite (HEAD)

```
$ cd scripts/devnet && node --test --test-reporter=spec 'test/**/*.test.mjs'
ℹ tests 410   ℹ suites 52   ℹ pass 410   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0
# deploy_gate.test.mjs alone contains 37 test() declarations — the deployment-gate regression set
# Workspace: pnpm install --frozen-lockfile && pnpm -r build → exit 0 (all packages)
# sdk/src vs salvor-bots/src: diff -r → byte-equal (IN SYNC)
```

### 14.8 Live acceptance verifiers (read-only)

```
$ node scripts/devnet/verify_ns3_deployment.mjs --url https://api.devnet.solana.com
overall: FAIL (pass 3 / fail 26 / unverified 0 / info 4)   slot 521319065 epoch 1206 finalized
G1 PASS (genesis match); B1/B6 PASS (independent PDA derivation == pinned, bump 255);
A*/C*/D* FAIL — "no account exists at <pinned address>" (deployment prerequisite, per §5 semantics)

$ node scripts/devnet/verify_ns3_elf_digests.mjs --url https://api.devnet.solana.com
overall: FAIL (pass 1 / fail 26 / unverified 0 / info 0)   slot 521319072
G1 PASS; all program/ProgramData checks FAIL as definitive absence (same prerequisite)
```

### 14.9 Observations recorded during this preflight

- `scripts/devnet/deploy_devnet.sh` git mode is 100644 (non-executable); the runbook invokes it directly (§6, §13.1).
- cargo-build-sbf's post-processing downloaded a third-party Criterion v2.3.3 tarball (unverified upstream); digest-neutral for the deployed ELFs (§4).
- GitHub API rate limiting (unauthenticated, 60/h) initially constrained the check-run enumeration; the complete 12-of-12 listing was obtained after the window reset, with no failure observed by any query.

---

*End of evidence. Nothing in this report authorizes or performs a deployment; the chain remains untouched.*
