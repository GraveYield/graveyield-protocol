# W1.1 Post-Merge Lifecycle Verification — PR #84 merge commit `3effaec`

Status: **READY FOR PR REVIEW** (post-merge acceptance evidence; all 16 lifecycle stages and
all 14 adversarial cases passed with measured results; no correction was necessary; no
protocol, economics, security-boundary, or test change was made on this branch).

## 1. What this document is — and what it is not

- This is the **W1.1 post-merge acceptance record**. It was produced by rerunning the complete
  W1 lifecycle rehearsal against the exact PR #84 merge commit
  `3effaecba2a7e6556884b2e12a087f426dea02bb`, on the dedicated branch
  `test/w1-post-merge-verification`.
- The original W1 rehearsal run **predates the final PR #84 security corrections and the
  merge**. It is **historical, pre-merge evidence only** and is not presented here as
  post-merge acceptance evidence. Its raw run artifacts were never committed to git (the
  rehearsal writes them to the gitignored `target/lifecycle-rehearsal/`); the historical
  engineering context is preserved in
  [docs/W1_NS3_REHEARSAL_INSPECTION.md](../W1_NS3_REHEARSAL_INSPECTION.md) and in the PR #84
  review record.
- The two files in this directory are the **verbatim, unedited artifacts** of the W1.1 run:
  - `run-report-2026-11-06T06-49-37-889Z.json` — machine-readable run report
  - `run-report-2026-11-06T06-49-37-889Z.summary.md` — Markdown run summary

## 2. Git provenance (Section A)

| Item | Value |
|---|---|
| Target merge commit | `3effaecba2a7e6556884b2e12a087f426dea02bb` (Merge PR #84) |
| Ancestor check | confirmed ancestor of `origin/main`; `origin/main` == `3effaec…` at fetch time (no baseline drift; no approval substitution needed) |
| Tested HEAD | `3effaecba2a7e6556884b2e12a087f426dea02bb` (detached content, dedicated branch) |
| Branch | `test/w1-post-merge-verification` (created from the exact target commit) |
| Working tree | clean (`git status --short` empty; recorded by the run report: `feature_branch: test/w1-post-merge-verification`, `feature_commit: 3effaec…`) |
| Salvor checkout | salvor-bots `8d8b6aa66303b04019fa4e094e3b41705685aace` @ `main`, `dirty: false` |

## 3. Toolchain and artifact provenance (Section B) — reconciliation

Approved pins recorded in `scripts/devnet/provenance.manifest.json` (unchanged on this
branch): Solana CLI `3.0.10`, SBPF v0, platform-tools `v1.54`
(archive sha256 `fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e`) and
the approved Scanner/Vault ELF digests. The manifest does not carry the Anchor CLI
version or the embedded rustc version as standalone fields; those two values are
attributed from their direct evidence sources:

- Anchor CLI `1.2.2` — from the `scripts/check-toolchain.sh` output recorded in §3.1.
- embedded SBF rustc `1.89.0-dev` — from the toolchain information embedded in the
  SHA-256-pinned platform-tools v1.54 archive (inspection recorded in §3.2).

### 3.1 What was measured in this W1.1 run

| Item | Result |
|---|---|
| `scripts/check-toolchain.sh` | all checks passed (exit 0): solana 3.0.10, anchor 1.2.2, rust 1.91.1 (host), node 24.22.2, pnpm 9.15.9 |
| platform-tools archive | downloaded by `deploy_devnet.sh --build-only` and sha256-verified against the manifest pin (`PASS [platform-tools]`), then re-verified a second time on the cached copy (`platform-tools v1.54 archive OK (sha256 fcc41631…)`). The verified archive is the only trust anchor: the v1.51-labeled and v1.57-labeled cache directories are deleted and re-seeded **from the verified archive on every build run** (`fix B` in the script). |
| ELFs | **rebuilt fresh** by the authenticated flow (`deploy_devnet.sh --build-only` — no keypairs, no RPC, no deployment), then independently sha256-summed: scanner `e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98` ✓, vault `8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83` ✓ — byte-exact approved NS-3 digests. |
| Loaded-byte provenance | stage 1 verifies the **on-chain loaded program data** byte-contains the pinned ELF whose sha256 equals the approved digests (distinction between build provenance and loaded-artifact provenance is preserved; both were independently established in this run). |

### 3.2 The "platform-tools v1.51" reconciliation (resolved, with evidence)

The run report's toolchain string records the raw `cargo-build-sbf --version` output:
`solana-cargo-build-sbf 3.0.10 platform-tools v1.51 rustc 1.89.0`. The `v1.51` there is the
**compile-time default-version label** of `cargo-build-sbf` (the cache directory name it
resolves first) — it is **not** evidence of the bytes that compiled the ELFs. What actually
happened in this run, each step directly evidenced:

1. The deploy flow sha256-verifies the **v1.54** archive against the manifest pin and deletes
   + re-seeds the v1.51-labeled cache path **from the verified v1.54 archive** (build log:
   `platform-tools v1.54 cache seeded from the verified archive: …/v1.51/platform-tools`).
2. Direct inspection after the build: the rustc inside the v1.51-labeled cache path reports
   **`rustc 1.89.0-dev`** — i.e. the v1.51 **path label** holds v1.54 **archive bytes**.
3. `cargo-build-sbf` detects the true platform-tools version of the seeded content and
   materializes `~/.cache/solana/v1.54/platform-tools` (its rustc also reports `1.89.0-dev`).
4. The rustup toolchain link actually created and used for SBF compilation is named
   **`1.89.0-sbpf-solana-v1.54`** (confirmed via `rustup toolchain list` after the build).

Conclusion: the SBF compilation ran on the **v1.54 archive content with embedded rustc
`1.89.0-dev`** — the approved NS-3 build toolchain — and the resulting ELFs are byte-identical
to the approved digests, which independently corroborates the toolchain conclusion. The
report's `platform_tools_version` field additionally records
`v1.54 (embedded rustc 1.89.0-dev; approved NS-3 build toolchain)` together with the pinned
archive sha256, so both the label discrepancy and its resolution are visible in the report
itself. No claim in this section rests on the ELF digest match alone.

## 4. Execution results (Section C)

Harness: `bash scripts/devnet/lifecycle_rehearsal.sh` (default `--url` is the fixed local
endpoint; the script refuses any other URL before any operation). Validator:
`solana-test-validator`, local only, `http://127.0.0.1:8899`, `--slots-per-epoch 32`
(compressed clock — labeled boundary). Identities: fresh throwaway local keys only.

- **Harness exit status: 0** (`LIFECYCLE REHEARSAL COMPLETE — 16 stages + adversarial battery all green`).
- **Stages: 16 passed / 0 failed / 0 incomplete.**
- **Adversarial cases: 14 passed / 0 failed / 0 incomplete.**
- `all_pass: true`; JSON reporting stamp `reporting.complete: true`, `error: null`.
- Local validator genesis this run: `2LAii5zpmgJXN65WUmW6kyogsFQc1PgyZrjf6UWBtmaE`.
- Program IDs: scanner `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL`, vault
  `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya` (NS-3, unchanged); Raydium V4 fixture loaded
  at the canonical `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`.
- Real submit-path signatures this run: ALT `HsEVMRQfjEYXEvqn7Nn2VzodrLZGpw2j6HL5yW8bn25g`,
  salvage `66tf95mnggYpFdLKvTjbAgyvihbLYGQC5BDouUTB6gpjKL5zs4v74NwgVzrdR91ALExMYWRphxnh66Syjq3FAmUx`.

Stage results (all PASS — full details in the JSON/MD artifacts):

| # | Stage |
|---|---|
| 1 | validator boot + ELF load at NS-3 IDs (approved-hash verified) |
| 2 | ProtocolConfig initialize (SDK builders; vault dust = u64::MAX) |
| 3 | oracle registration via 80-byte update_protocol_config |
| 4 | discovery/evaluation wiring smoke (SDK evaluatePool) |
| 5 | record_launch_price (168B attestation) |
| 6 | evaluate_pool_phase_1 → EligibilityAnchorWritten |
| 7 | compressed 2-epoch confirmation + 6016-at-gap-1 |
| 8 | evaluate_pool_phase_2 → EligibilityCertIssued |
| 9 | REAL Rust snapshotter + SDK snapshot root-equality |
| 10 | fleet-core salvage-only prepare + simulate (mode:"live") |
| 11 | fleet-core salvage submit through the REAL live submit path (v0/ALT) |
| 12 | settlement shares 40/40/20 ±1 lamport (receipt) |
| 13 | salvor-bots monitor reconcile |
| 14 | claim_lp_proceeds ×N from Rust artifact proofs (+ dup/7010 negatives) |
| 15 | sweep_dust (permissionless) positive + re-sweep negative |
| 16 | emergency-control drills via protocol_admin.mjs (scanner + vault) |

Adversarial results (all PASS, all with `zero_movement.proved = true` — full observed codes in
the artifacts):

| ID | Case (expected → observed) |
|---|---|
| A1 | missing ed25519 precompile → 6024 |
| A2 | tampered oracle signature → precompile family (code 2) |
| A3 | non-canonical precompile offsets → 6025 |
| A4 | unauthorized oracle key → 6026 |
| A5 | malformed 111-byte attestation → anchor-decode family (code 102) |
| A10 | phase_2 before any anchor → 3012 |
| S7-gap1 | phase_2 inside the confirmation gap → 6016 |
| A6 | salvage while paused → 7003 |
| A7 | tampered lp_total_supply_at_snapshot → 7018 |
| A8 | replayed salvage after completion → registry init failure (anchor-decode family) |
| A9a | duplicate claim → ClaimRecord init failure (anchor-decode family) |
| A9b | tampered Merkle proof → 7010 |
| A9c | inflated lp_balance_at_snapshot → 7010 |
| S15-resweep | second sweep_dust → 3012 |

Independently recomputed settlement arithmetic (stage 12 receipt):
total `9,886,126,516` lamports — `lpHolder 3,954,450,606` (= exact 40% floor, Δ0),
`salvor 3,954,450,606` (= exact 40% floor, Δ0), `protocol 1,977,225,304` (= 20% floor +1, the
rounding remainder); legs sum exactly to the total; stage-13 monitor verdict this run:
`receipt-verified` (delta 1 lamport, within the monitor's ±1-lamport tolerance).

### Zero-movement evidence gaps

None. Every one of the 14 adversarial cases carries a `zero_movement` object with
`proved: true` plus per-check fields (`accounts_unchanged`, `sol_unchanged`,
`tokens_unchanged`, `pdas_absent`, `fee_ok`, fee deltas) and the rejected transaction id +
slot in the JSON artifact. Logs tails are recorded when available: 13 of the 14 cases
carry a populated `logs_tail`, and A2's is empty — valid evidence, not missing evidence,
because the A2 failure occurs at instruction 0 (the signature-verification precompile
errors before the program is ever invoked, so no program logs are emitted). An empty
logs tail therefore does not indicate missing transaction evidence or a failed
adversarial test; the transaction id and slot are present for every case.

### Deviations from the original W1 run

None of substance. Same harness, same merged implementation, same approved pins. The only
run-to-run differences are inherently per-run values (throwaway keys, validator genesis,
ALT/salvage signatures, slot numbers, fixture fetch timestamps) and the stage-13 monitor
verdict, which this run reached `receipt-verified` (the prior run labeled the same 1-lamport
rounding remainder as `accepted-rounding-remainder` — both are the monitor's documented
tolerance behavior, never a relabel of a failure).

## 5. Reporting and security review (Section D)

- JSON report: `docs/w1-post-merge/run-report-2026-11-06T06-49-37-889Z.json` (verbatim copy of
  `target/lifecycle-rehearsal/run-report-2026-11-06T06-49-37-889Z.json`)
- Markdown report: `docs/w1-post-merge/run-report-2026-11-06T06-49-37-889Z.summary.md`
- Reporting completeness: `reporting: { complete: true, markdown_path: …, error: null }` — the
  mandatory dual-report finalization stamped the JSON; the Markdown exists at the recorded
  path; JSON and Markdown were cross-checked for consistency (30 `PASS` cells = 16 stages +
  14 adversarial; identical provenance, genesis, branch and commit lines).
- Secret sanitization: scanned the JSON report, the Markdown summary and the driver log for
  credential markers (`github_pat`, `ghp_`, `gho_`, `x-access-token`, `password`,
  `private_key`, `privatekey`), URL userinfo (`://…@`) and query parameters (`?x=…`) —
  **zero matches**. Both recorded repository values pass the sanitizer invariant
  (no `@`, `?` or `#` characters): `https://github.com/GraveYield/graveyield-protocol.git`,
  `https://github.com/GraveYield/salvor-bots.git`.
- PR #84 corrections verified present in the merged tree before the run:
  `sanitizeRemoteUrl` (userinfo/query/fragment dropped, strict `[@?#]`-free invariant,
  unparseable input withheld as null — never fabricated); early-failure `failFast()` routes
  through the same mandatory `completeReporting()` as normal completion; `w1ExitStatus` is
  fail-closed (missing/malformed reporting confirmation can never yield exit 0); JSON and
  Markdown consume the same sanitized provenance.
- No production custody paths or key material were touched; no Devnet/Mainnet transactions;
  no deployments, initializations, authority rotations or upgrades; the only public-cluster
  reads are the rehearsal's documented read-only third-party fixture fetches (Raydium V4 /
  Serum / pool accounts), which are part of the approved harness flow.

## 6. Regression tests

No correction was necessary, so no new regression test was added and **no test, guard,
assertion or reporting logic was modified**. The existing devnet regression suite was re-run
as evidence:

```
node --test scripts/devnet/test/*.test.mjs
# exit 0 — tests 246 · suites 32 · pass 246 · fail 0 · cancelled 0 · skipped 0 (20.9s)
```

## 7. Boundaries and limitations (Section D) — unchanged, all still explicit

None of the following was silently upgraded. The run report's component classification
(Jupiter v6: NOT TESTED; Devnet/Mainnet deployment acceptance: NOT TESTED; all other listed
components: REAL) and the eleven labeled boundaries are reproduced verbatim in
`run-report-2026-11-06T06-49-37-889Z.summary.md`.

- Jupiter v6 conversion execution: **NOT TESTED** (conversion leg config-skipped via
  u64::MAX dust threshold; route-account shim satisfies fleet-core destination validation but
  is never executed on-chain).
- Public-cluster behavior: **NOT TESTED** (local validator only).
- Production oracle-attestation delivery: **NOT TESTED** (local throwaway oracle keys).
- Live public-cluster fleet-core discovery: **NOT TESTED** (the local market is the real,
  unmodified mainnet fixture; static fixtures cannot cover live market states).
- Production custody-key operations: **NOT TESTED** (by design).
- NS-3 deployment acceptance (`verify_ns3_deployment.mjs`): **NOT TESTED** — owner-executed,
  read-only, public-cluster step, out of W1 scope.

Documented deviations preserved unchanged: synthetic last-swap timestamps (C1); synthetic
launch-price collapse ×200; LP mint supply re-pinning (C6); config-skipped Jupiter conversion
leg (C3); route-account shim not executed on-chain; fork-covered negatives not measurable on
a live local validator (7002 expired-cert; 7021 one-shot sweep guard); monitor
rounding-remainder tolerance (Finding D); closed-ATA decode behavior on repeat dust sweep
(3012 precedes 7021 — Finding C); OpenBook market fixture and real vault-signer derivation
(Finding E remediation on the salvor side; string-seed re-pin retired).

## 8. Known observations (no action taken on this branch)

1. **Cosmetic**: the Markdown stage table renders stage 13's object-valued detail cell as
   `[object Object]` (pre-existing rendering behavior for structured details; the JSON
   retains the full object: `accepted_kind`, `verdict_reason`, per-check booleans). This is
   not a regression of the PR #84 corrections and does not affect any result; left untouched
   to keep this verification branch free of implementation changes.
2. **Environment note (not evidence-relevant)**: the verification sandbox was recycled twice
   during this assignment, wiping home-directory tool installs and untracked build artifacts
   between runs. The toolchain was then reinstalled from the same pinned sources and the
   byte-exact ELF reproduction (same digests from a fresh build) demonstrates the rebuild's
   correctness. Disk pressure required deleting the re-seedable v1.57 platform-tools cache
   copy (re-derivable from the hash-verified archive; the rehearsal does not invoke anchor).

## 9. Recommendation

**READY FOR PR REVIEW** — the exact merged PR #84 implementation completes the full W1
lifecycle rehearsal on a local validator under the approved security boundaries, with build
provenance and loaded-byte provenance independently established, mandatory reporting
completed and stamped, and no security boundary weakened.
