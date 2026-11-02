# Phase 5.1 — Stage B Remediation Log (graveyield-protocol)

> **Stage:** Phase 5.1 Stage B — controlled implementation and verification of the remaining verified engineering, regression-testing, CI, and supply-chain gaps.
> **Baseline:** `origin/main` @ `93be57a` (merge of PR #70 — Stage A documentation reconciliation, verified merged via the GitHub API before any work began).
> **Branches (one PR per independent remediation group, nothing merged by this stage):**
> - branch `p5-1/stage-b-fork-pins` → PR #71 — test-coverage pins (P5-03, P5-05, P5-06, P5-11) + the P5-06 spec section.
> - branch `p5-1/stage-b-ci-supply-chain` → PR #72 — fork-harness PR path automation (P5-04), SHA-pinned actions + checksum-verified platform-tools (P5-07), accurate sha2 pin rationale (P5-02).
> - `p5-1/stage-b-docs` → this document + register/matrix updates (PR opened last so it can cite the first two PRs' CI results).
> **Disclosed environment deviation:** the delivery sandbox was reset before this stage — no Rust toolchain, no Solana CLI, no fork fixtures or ELFs existed. Rust 1.91.1 (exact repo pin) and Solana CLI 3.0.10 (exact repo pin) were installed for this stage; the fork harness (two program ELFs + the Jupiter v6 stub + both mainnet fixture pools) was rebuilt from `scripts/build_fork_harness.sh`'s steps. Disk constraints were managed by pruning build intermediates between builds (disclosed where relevant); no test selection, assertion, or fixture content was affected.
> **Not affected by any of this stage's work (owner items preserved):** P5-A1 remains **Open** (sole P0, owner custody decision — untouched); P5-08 uses the owner-approved **"Record only (informational)"** status; the Jupiter conversion flake remains **disposition-unresolved** (§5 below); the P5-04 false-positive retraction (preflight §7.1) is untouched — `codeql.yml`'s `branches: [main]` was re-verified byte-exact via three channels (`git cat-file` + `od -c` + raw.githubusercontent at `93be57a`) and the `ain]` display remains the known rendering artifact.

---

## 1. Synchronization and tree verification

| Command | Result |
| --- | --- |
| `git remote -v` | `https://github.com/GraveYield/graveyield-protocol.git` |
| `git fetch origin --prune` | exit 0; `origin/main` `1865908` → `93be57a` |
| `GET /repos/GraveYield/graveyield-protocol/pulls/70` (API) | `merged: true`, `merge_commit_sha: 93be57a3…`, merged 2026-11-01T17:21:39Z |
| `git log origin/main --oneline -2` | `93be57a` Merge PR #70 · `185d03b` Stage A correction pass |
| `git checkout -b p5-1/stage-b-remediation origin/main` | created at `93be57a`; working tree clean (`git status --porcelain` → 0 entries) |

## 2. Implementation ledger

### 2.1 P5-03 — Scanner handler-level + Anchor instruction/context-level coverage

**Original issue (register row):** no test drives `update_protocol_config` handler reverts for `price_collapse_bps > 10_000` (6006) or any `sweep_stale_anchor` handler path; the account-constraint layer (PDA derivation, writer binding, ownership, pre-handler rejection) was likewise test-less repo-wide.

**Implementation (both layers the register prescribes):**

- **Layer 1 — handler level (host).** `programs/grave-scanner/src/instructions/update_protocol_config.rs` and `sweep_stale_anchor.rs`: the handlers' validation/assignment logic was extracted **verbatim** into `pub(crate) fn apply_config_update(...)` / `pub(crate) fn sweep_gate(...)` (pure code motion — the instruction path executes the identical logic; no semantic, wire, or account change), with 13 new `#[cfg(test)]` tests:
  - `price_collapse_bps_within_bound_is_applied`, `price_collapse_bps_boundary_10_000_is_accepted` (inclusive boundary), `price_collapse_bps_above_10_000_reverts_6006_without_mutation` (6006 + full no-mutation assertion, field-by-field),
  - `staleness_window_below_floor_reverts_6006_and_boundary_applies` (518_399 → 6006; 518_400 accepted), `cert_ttl_below_floor_reverts_6019_and_boundary_applies` (599 → 6019; 600 accepted),
  - `scalar_and_oracle_fields_apply_without_bounds`, `on_chain_6006_6019_codes_match_docs`,
  - `sweep_rejected_while_window_not_elapsed_6018`, `sweep_boundary_is_strict_inequality` (epoch == earliest reverts; +1 passes), `configured_window_below_floor_is_clamped_up` (read-path clamp: 0 and floor−1 behave like the floor), `configured_window_above_floor_widens_monotonically` (min+1 s ⇒ one epoch later), `sweep_epoch_overflow_fails_closed_6004`, `on_chain_6018_code_matches_docs`.
- **Layer 2 — Anchor instruction/context level (real BPF via `solana-program-test`).** New fork tests in `programs/grave-vault/tests/scanner_windows_fork.rs` (the suite that drives the real `grave_scanner.so`):
  - `scanner_config_bounds_reject_and_preserve_state` — 10_001 reverts 6006 at the handler (constraint layer passes: right PDA, right authority); the config PDA re-read shows **every field unchanged**; 10_000 accepted and applied.
  - `sweep_stale_anchor_window_writer_and_pdas_enforced` — (a) window-not-elapsed 6018 with anchor + writer lamports preserved (only the failed tx's fee charged); (b) wrong rent-recipient slot reverts **6000 at the constraint layer before the handler** (proven: the window is still closed, yet the binding fires first); (c) a foreign account in the `eligibility_anchor` slot fails the constraint layer (generic instruction error — not 6018/6006), anchor intact; (d) strict `>` boundary at the clamped floor window (boundary epoch 6018; +1 epoch succeeds); (e) permissionless success by a third-party caller — **rent returns to the original writer, the caller receives nothing but pays its fee**, anchor PDA closed.

**Verification (executed this session, on commit `95feb3d`):**

| Command | Result |
| --- | --- |
| `cargo test -p grave-scanner --lib` | **125 passed / 0 failed** (112 baseline + 13 new), 0.06 s |
| `cargo test -p grave-vault --test scanner_windows_fork` | **9 passed / 0 failed** (6 baseline + 3 new) |
| `cargo clippy --all-targets -- -D warnings` | exit 0 |
| `cargo fmt --all -- --check` | OK |

**Honest layering note (per the register's rule):** the host tests do NOT establish Anchor account-constraint enforcement — that is established by the Layer 2 fork tests against the real BPF. Neither layer claims the other.

### 2.2 P5-11 — No-op emergency-pause toggles (both programs)

**Original issue:** a no-op toggle must revert refuses-first (scanner 6006, vault 7022) instead of double-emitting `ProtocolPauseChanged`; source-verified but untested.

**Implementation:** two fork tests driving the real ELFs:

- `scanner_noop_pause_toggles_revert_refuses_first` (scanner_windows_fork.rs): unpause-while-unpaused → 6006, flag unchanged; pause → success; pause-while-paused → 6006, flag unchanged; positive control unpause → success.
- `vault_noop_pause_toggles_revert_refuses_first_7022` (security_negative_fork.rs): the mirrored 7022 pin on GraveVault (with the 7003-is-`ProtocolPaused` clarification in the test comment).

**Verification:** both suites executed — scanner_windows 9/9, security_negative 10/10 (9 baseline + 1 new). The refused-toggle "no second event" property holds by construction (a reverted transaction emits nothing); the pinned, executable property is the error code + unchanged flag.

### 2.3 P5-05 — Charter invariant "claims remain live during pause"

**Original issue:** `claim_lp_proceeds` has no pause check by design; no test would fail if a refactor added one.

**Implementation:** `claims_remain_live_during_emergency_pause` (lp_claim_fork.rs): the vault is paused via the real `emergency_pause` instruction in the same VM (the `emergency_paused` flag is deserialized from the live config PDA — the same state `salvage_pool`'s 7003 gate reads), then a Merkle-proven claim executes: exact lamport movement (`before − fee − record rent + pro_rata`), registry `lp_holder_pool_claimed_lamports` ticks, the ClaimRecord carries the floor amount, vault balance = rent + bucket − claimed; unpause restores the flag. A future pause gate on claims fails this test.

**Verification:** `cargo test -p grave-vault --test lp_claim_fork` → **7 passed / 0 failed** (5 baseline + 2 new).

### 2.4 P5-06 — Per-claim floor-rounding residual dust

**Original issue:** each claim floors `bucket × balance / supply`, leaving ≤ N−1 lamports in the unsweepable `lp_holder_pool_vault` permanently; the bound was undocumented and unpinned (the existing lifecycle test asserts only a loose `≤ N` side-condition on a divisible recipe).

**Implementation:**

- **Test:** `claim_rounding_residual_dust_within_n_minus_1` (lp_claim_fork.rs) — non-divisible recipe: three holders with balances **1, 2, S−3** (Σ = S exactly, so the bound's assumption holds), all N claim, and the test asserts (i) every claim pays exactly `floor(bucket × balance / supply)`; (ii) the cumulative counter equals Σ floors; (iii) the vault keeps exactly rent + residual; (iv) **residual < N (≤ N−1)**; (v) the recipe's divisibility escape is asserted, not assumed: residual = 0 only when the bucket itself divides by the supply; otherwise ≥ 1. The sub-lamport entitlement behavior (the b=1 holder claims successfully and pays 0 when `bucket < supply`) is pinned too.
- **Doc:** `docs/PROTOCOL_SPEC.md` §6.4 gains the bound statement (≤ N−1 lamports, assumption: the snapshot leaf set covers the supply), the permanence property (vault unsweepable, 7006 — no redistribution mechanism exists or is introduced), the floor-0 semantics, and the pinning test name.

**Verification:** lp_claim_fork 7/7. Observed run (from the test's own log line): `bucket 8529629951 / supply 85323356220839 / claimed 8529629950 / residual 1 (≤ N−1 = 2)`.

**Mathematical statement (verified by the test, not substituted for it):** Σᵢ floor(B·bᵢ/S) ≥ Σᵢ (B·bᵢ − (S−1))/S = B − N(S−1)/S > B − N, so residual = B − Σ floors ≤ N−1 whenever Σ bᵢ = S. No protocol change was made or needed: the residual is bounded accounting dust no party can claim, sweep, or redirect.

### 2.5 P5-02 — sha2 multi-instance investigation

**Original issue:** `Cargo.lock` carries sha2 0.9.9 + 0.10.9 + 0.11.1; the Phase 12 "single crypto core" property was no longer literally true; remediation = confirm which hasher the ELF uses, re-word the dependabot comment, disposition the rest.

**Investigation evidence (executed this session):**

| Question | Evidence | Result |
| --- | --- | --- |
| What does the ELF use? | `python3` byte-count over `target/deploy/grave_vault.so`: exactly **1** occurrence of `sol_sha256`; the full `sol_*` import set listed (no crypto-core code) | The on-chain SHA-256 is the **runtime `sol_sha256` syscall** — no sha2 crate instance is linked into any deployed ELF |
| Why no sha2 in the ELF? | `cargo tree -p grave-vault -e normal -i sha2@0.10.9` → carriers are `anchor-lang-idl` + `anchor-syn` chains (**proc-macros** — compile-time only); `solana_sha256_hasher` is used without its `sha2` feature on the normal graph (syscall path); the `sha2` feature is dev-only | Proc-macros and dev/test deps never enter the SBF binary |
| Where does 0.9.9 come from? | Lock carriers: `ed25519-dalek 1.0.1`, `libsecp256k1 0.6.0` ← `agave-precompiles 3.1.12` / `agave-syscalls 3.1.12`; the original session's `cargo tree -e dev --target all -i sha2@0.9.9` printed nothing because `-e dev` traverses ONLY dev-dependency edges and stops after the first hop — re-run 2026-11-02 with `-e normal,dev --target all` (and host-target) **does** print the chain: `agave-precompiles` ← `solana-runtime` ← `solana-banks-server` ← `solana-program-test` ← [dev-deps] `grave-vault`/`grave-snapshotter` | **Corrected 2026-11-02:** unreachable from every crate's **normal (artifact-producing) graph** — nothing shipped links it; reachable only through the `solana-program-test` dev-dependency chain in host TEST binaries (test-binary linkage, zero impact on shipped artifacts) |
| Where does 0.11.1 come from? | `anchor-syn` (proc-macro, host-side, reachable); ~~`k256`/`solana-ed25519` unreachable from all workspace graphs~~ **CORRECTED 2026-11-02:** `k256` (via `solana-sdk` → `solana-program` → `solana-secp256k1-recover`) and `solana-ed25519` (via `solana-client` → `solana-signature`) ARE reachable — they resolve 0.11.1 inside `grave-snapshotter`'s normal host graph (scanner/vault normal graphs carry 0.11.1 via `anchor-syn` proc-macro chains only — see the addendum below) | **Corrected:** host-side proc-macro chains (scanner/vault) **+ the snapshotter's normal host graph** — 0.11.1 is therefore expected to link into the snapshotter host binary (signature/RPC machinery, not the Merkle producer path); this is a build-graph-derived expectation — final-binary linkage was NOT independently verified (no built host binary was inspected; QUALIFIED 2026-11-02, pre-merge review) |
| What is the reachable, load-bearing instance? | `grave-snapshotter`'s direct `sha2 = "0.10"` (the off-chain Merkle producer) and the dev-graph `solana-sha256-hasher` with `features = ["sha2"]` (host-test hasher) both resolve **0.10.9 — the same lockfile instance**; byte-identity proptests pin producer ↔ verifier; the fork claim tests prove the **syscall** accepts 0.10.9-produced roots end-to-end | 0.10.9 is the single crypto core that exists in any artifact that runs |

**Implementation:** `.github/dependabot.yml`'s sha2 pin comment re-worded to exactly these facts (PR #72). No dependency or lockfile change — the smallest justified mitigation, since the multi-instance tree is host/toolchain-graph phenomenon plus dead lock weight, and removing lock entries would be resolution churn for zero risk delta.

**Disposition reached:** the two actionable remediation items the register prescribed are done and evidenced; the residual observation is documented as host-side informational (upstream-controlled). Proposed register status: **Fixed and verified** (flagged for owner ratification — see §6).

**Closeout re-verification (2026-11-02, post-merge closeout audit — commands executed against current `main`, results quoted):**

| Command (repo root) | Result |
| --- | --- |
| `cargo tree -p grave-snapshotter -e normal -i sha2@0.11.1` | prints `k256 v0.14.0 ← solana-secp256k1-recover v3.3.1 ← solana-program v3.0.0 ← solana-sdk v3.0.0 ← grave-snapshotter` AND `solana-ed25519 v0.2.4 ← solana-signature v3.6.0 ← solana-client v3.1.12 ← grave-snapshotter` — **0.11.1 IS in the snapshotter's normal host graph** |
| `cargo tree -p grave-scanner -e normal -i sha2@0.11.1`; same for `grave-vault` | `anchor-syn v1.2.2` proc-macro chains only (compile-time; never linked into a binary) |
| `cargo tree --workspace -e normal,dev --target all -i sha2@0.11.1` | additionally shows dev-graph exposure via `solana-program-test` → `solana-runtime` → `agave-precompiles`/`agave-syscalls` → `k256`/`solana-secp256k1-program` |
| `cargo tree --workspace -e normal,dev -i sha2@0.9.9` (host target; also `--target all`) | prints `ed25519-dalek v1.0.1 ← agave-precompiles ← solana-runtime ← solana-banks-server ← solana-program-test ← [dev-deps] grave-vault` — **0.9.9 is dev/test-graph only** |
| `cargo tree -p grave-snapshotter -e normal -i sha2@0.10.9` | the snapshotter's direct `sha2 = "0.10"` producer dependency (`snapshotter/Cargo.toml:45`) resolves 0.10.9 — the single hashing-core instance (unchanged) |

**Four-layer distinction (replaces the earlier conflated wording):** (1) *dependency-graph reachability* — 0.11.1 reachable (snapshotter normal graph; scanner/vault proc-macro chains; program-test dev chains), 0.9.9 dev/test-graph only, 0.10.9 snapshotter-direct; (2) *compilation into a host binary* — stated as a build-graph-derived EXPECTATION, not a binary-inspection fact: 0.11.1 is a normal-graph dependency of the snapshotter host build and is expected to link into the host binary's signature/RPC machinery, but final-binary linkage was NOT independently verified (no built snapshotter binary was inspected — the only binary inspections performed are the on-chain ELF byte counts cited in layer 4); 0.9.9 only into host test binaries (dev-graph), 0.10.9 into the snapshotter binary's producer path (same caveat — graph + direct source usage, no host-binary inspection); (3) *runtime/code-path reachability* — NOT established by either investigation; graph reachability is not evidence of execution on a vulnerable code path; (4) *on-chain program/ELF exposure* — none established (unchanged: the ELFs contain no sha2 crate; the on-chain primitive is the `sol_sha256` syscall). **Disposition unchanged** — still **Fixed and verified** with owner ratification pending (§6); what changed is the documentation, which now states the carriers' true reachability. The earlier "unreachable from all workspace graphs" wording was an artifact of the under-scoped `-e dev` traversal (dev-only edges) and is retracted in the register and the dependabot comment.

### 2.6 P5-04 — Fork-harness PR enforcement

**Original issue:** the 50 fork tests ran nightly/label/dispatch only; a PR breaking a fork-only path passed CI until the nightly.

**Implementation (`.github/workflows/fork-harness.yml`, PR #72):**

- A cheap `changes` job (checkout `fetch-depth: 0` + `git diff --name-only <base>...HEAD`) classifies the diff against fork-relevant paths: `programs/**`, `snapshotter/**`, `sdk/**`, workspace manifests, `rust-toolchain.toml`, `Anchor.toml`, both harness scripts, and the workflow itself.
- The heavy job (`needs: changes`) runs when `fork_relevant == 'true'` **or** the PR carries the `fork-harness` label (the manual escape hatch preserved for any PR, including docs-only). Nightly cron + `workflow_dispatch` unchanged; concurrency group unchanged (no duplicate/conflicting executions).
- `pull_request` types extended to `[opened, synchronize, reopened, labeled]`.
- A skipped harness run is now a **visible skipped job**; docs-only PRs never pay the build-sbf + fixtures cost.

**Verification:** all workflow YAMLs parse (`yaml.safe_load`); the filter expression was executed locally against the real PR #71 diff (programs+docs → `fork_relevant=true`) and simulations (docs-only → false; sdk-only → true). **Live CI verification (executed):** PR #72's own Actions run exercised the new `changes` job + path filter end-to-end (`detect fork-relevant changes: success` → heavy job ran → `build + fetch + run 7 fork suites: success`). PR #71's fork run was triggered via the pre-existing `fork-harness` label under the workflow version on its own merge-ref (the new workflow file lives only on #72 until it merges): `build + fetch + run 7 fork suites: success` — the label escape hatch demonstrably still works.

**Closeout correction (2026-11-02, post-merge closeout audit):** the audit found the classification **FAIL-OPEN**: `CHANGED="$(git diff --name-only "$BASE...HEAD" || true)"` swallowed a failed diff; the empty result fell through to `fork_relevant=false`, so a code PR whose diff computation failed would silently skip all seven fork suites. Fixed fail-closed in the closeout PR:

- the classification logic now lives in **`scripts/classify_fork_changes.sh`** (prints exactly `run`/`skip`, always exits 0; failed diff, missing/unresolvable base or head, empty diff, and a matching-tool failure — a grep error (exit ≥ 2), per the pre-merge review — all classify as **run**; only a clean grep exit 1 counts as "no match"; the classifier script itself is part of the fork-relevant path set);
- the workflow's `changes` job output defaults to `run` when the classification step produces nothing (`fork_relevant: ${{ steps.filter.outputs.fork_relevant || 'run' }}`);
- the heavy job's condition runs unless the changes job **explicitly** classified `skip` on a **successful** changes run (`needs.changes.result != 'success'` ⇒ run; `always() && !cancelled()` so the condition evaluates even when the changes job failed, while honoring cancellation);
- `|| true` is gone — the diff exit status is checked and a failure fails closed;
- the path policy itself is unchanged (programs/snapshotter/sdk/manifests/toolchain/Anchor.toml/harness scripts/workflow + the classifier).

**Verification:** `scripts/classify_fork_changes_test.sh` — fixture-based, **23/23 green**: docs-only ⇒ skip; source/snapshotter/sdk/test-suite/harness/fixture-fetcher/workflow/manifests/lockfile/toolchain/Anchor.toml ⇒ run; no-merge-base (failed diff) ⇒ run; missing base/head/empty arg ⇒ run; empty diff ⇒ run; schedule/dispatch bypass ⇒ run; matching-tool failure fails closed (PATH-stubbed grep: error exit 2 ⇒ run, clean no-match exit 1 ⇒ skip, match exit 0 ⇒ run). (Fixture note: the first test run exposed a fixture bug — `git checkout -B` prunes emptied directories, which made three scenarios pass via the fail-closed empty-head path instead of real classification; the fixture now recreates parent dirs and all scenarios pass with empty stderr.) Failure-path scenarios are local evidence only; a GitHub-side diff or grep failure cannot be forced in CI — live CI evidence for the corrected filter is the closeout PR's own fork-harness runs, which touch the classifier and the workflow so the filter fires on them: **run #28** (id 41388484183, head `228ca99`, created 2026-11-02T04:26:34Z) and **run #29** (id 41389016994, head `ab3dd20`, created 2026-11-02T04:32:13Z) — the classification step fired the heavy job and **both runs concluded `success`** (#28 at 04:29:37Z, #29 at 04:36:03Z; all seven fork suites green on GitHub Actions).

### 2.7 P5-07 — CI supply-chain hardening

**Original issue:** actions pinned by major tag; Solana CLI + platform-tools fetched without checksum verification; CodeQL inactive while private (by design); branch protection tier-gated.

**Implemented (PR #72, smallest verified steps):**

1. **SHA-pinned every third-party action** across all five workflows (43 `uses:` entries, zero left on mutable tags; the original record said "24" — a miscount, re-counted and re-verified 2026-11-02: 43 entries, 8 unique action@SHA pairs, 7 distinct SHAs), each with a version comment; Dependabot's `github-actions` ecosystem keeps the SHA+comment pairs current:
   - `actions/checkout` → `3d3c42e5…90b1` (# v7.0.1) · `actions/setup-node` → `949feb24…15c1` (# v7.1.0) · `actions/upload-artifact` → `ea165f8d…fa02` (# v4.6.2) · `pnpm/action-setup` → `0977fd99…cc86` (# v6.0.10) · `Swatinem/rust-cache` → `d1527c8f…12e0` (# v2.9.3) · `github/codeql-action/{init,analyze}` → `9b325408…e370` (# v4.39.1) · `dtolnay/rust-toolchain` → `b725eda5…2c8` (stable branch head, pinned 2026-11-01).
   - SHAs resolved via the GitHub API tag→commit resolution this session (annotated tags dereferenced to commits). Post-closeout Dependabot merges **#74/#75** (2026-11-02, into main) refreshed two pairs without changing the counts (re-verified against merged main): `actions/upload-artifact` → `cf430e03…46cd9` (# v7.0.2) · `pnpm/action-setup` → `ea17c68d…d413` (# v6.1.0) — still 43 entries, 8 pairs, 7 distinct SHAs, zero mutable tags.
2. **Checksum-verified the platform-tools fetch**: the v1.54 tarball is now `sha256sum -c`-verified before extraction in both `ci.yml` and `fork-harness.yml`. Hash `fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e` computed this session by streaming the actual upstream release artifact (`curl | sha256sum`) — not copied from any document.
3. **Not implemented, documented (owner-visible):** the Solana CLI installer (`release.anza.xyz`) publishes no signed checksums — hash-pinning or self-hosting it is the remaining trusted-fetch gap, recorded in the register rather than silently accepted; CodeQL's auto-engage-on-flip-public and branch-protection-on-tier-allow are settings-level and unchanged.

**Verification:** `yaml.safe_load` on all five workflows + dependabot.yml; `pnpm audit` re-run → 1 finding (the accepted bigint-buffer only; no dependency/lockfile change in this PR).

## 3. Verification battery — local vs CI

**Local (delivery sandbox, disclosed reset-and-rebuild environment; commands exact, results unedited):**

| Suite / gate | Command | Result |
| --- | --- | --- |
| grave-scanner host | `cargo test -p grave-scanner --lib` | **125 / 125** (112 baseline + 13 new) |
| grave-vault host | `cargo test -p grave-vault --lib` | **40 / 40** |
| grave-snapshotter | `cargo test -p grave-snapshotter` | **53 / 53** (38 lib + 7 merkle + 8 snapshot) |
| **Rust host subtotal** | | **218 / 218** |
| fork: scanner_windows | suite binary (7 suites, `cargo test -p grave-vault --tests --no-run` built) | **9 / 9** |
| fork: security_negative | | **10 / 10** |
| fork: lp_claim | | **7 / 7** |
| fork: raydium_v4 | | **10 / 10** |
| fork: settlement_economics | | **7 / 7** |
| fork: full_lifecycle | | **1 / 1** |
| fork: jupiter_conversion | | **12 / 12** |
| **Fork subtotal** | | **56 / 56** (50 baseline + 6 new) |
| formatting | `cargo fmt --all -- --check` | OK |
| clippy | `cargo clippy --all-targets -- -D warnings` | exit 0 |
| terminology | `bash scripts/terminology-lint.sh` | `ok: no forbidden vocabulary detected` |
| doc links | `bash scripts/doc-links-lint.sh` | `ok` (124 targets) |
| workflow syntax | `yaml.safe_load` × 5 workflows + dependabot.yml | OK |
| dependency audit | `pnpm audit` | 1 finding — the accepted `bigint-buffer` only |
| TS workspaces | not re-run locally — no TS file changed in any Stage B branch; covered by CI (`pnpm -r build/test/typecheck`) on both PRs | CI: green (§ CI table) |

**ELF provenance (rebuilt this session with the pinned toolchain; PR #71):**

| Artifact | sha256 (this rebuild) | vs Phase 5.0 record |
| --- | --- | --- |
| `grave_vault.so` | `33cfd453658d729753de955e93e052b715eb8a38674047b6d6ffde9d15076be3` | **byte-identical** (vault source untouched — deterministic SBF build re-confirmed) |
| `grave_scanner.so` | `2346bd8a45c0c05447f939c023fa74f3401976bda83245a26e5d909176acf828` | differs — expected: the P5-03 handler code motion changed the source |
| `jupiter_v6_stub.so` | `8a5f60bcc6c1c5407c2e0b5ca9301a4afc038aab8b7d0b2576b99a1a80d770c7` | byte-identical |

**CI (GitHub Actions — executed on both PRs, all green; the first true CI execution of the new fork tests and of the new path-filter machinery):**

| PR (head commit) | Check | Conclusion |
| --- | --- | --- |
| #71 (`p5-1/stage-b-fork-pins` @ `95feb3d`) | build + fetch + run 7 fork suites | **success** — all 56 fork tests green in Actions (incl. the 6 new fork tests) |
| #71 | cargo fmt --check / cargo clippy / cargo test (host) | success |
| #71 | pnpm build + test / pnpm typecheck / ts lint + format | success |
| #71 | anchor build / sdk sync / CodeQL | success |
| #71 | terminology lint / doc link integrity | success |
| #72 (`p5-1/stage-b-ci-supply-chain` @ `e7df5f3`) | **detect fork-relevant changes** (the new `changes` job) | **success** — the path filter fired on the PR (it touches `fork-harness.yml`), then the heavy job ran: **build + fetch + run 7 fork suites: success** |
| #72 | cargo fmt / clippy / host tests / pnpm build+test / typecheck / ts lint / anchor build / sdk sync / CodeQL / terminology / doc links | success |

Check-run counts at documentation time: **14/14 success on #71, 15/15 success on #72** (GitHub API `check-runs`, all `completed`/`success`; no re-run was performed). Both PRs' CI therefore independently re-verified every local execution above — host suites, fork suites (including all six new fork tests), lints, doc gates, TS workspaces, and the anchor build of the code-motion scanner change.

## 4. Jupiter conversion fork-test flake — controlled reproduction record

**Prior record (preserved):** preflight §3.1 — one failure of `inverted_orientation_pool_converts_memecoin` (panic at `jupiter_conversion_fork.rs:899`, "full-pipeline salvage failed"), then 11 consecutive clean executions incl. an isolation rerun; provisional classification: nondeterministic, timing-sensitive; no root cause.

**This stage's controlled attempts (all executed; both outcomes recorded; nothing deleted, weakened, skipped, or suppressed):**

| Attempt | Configuration | Runs | Failures |
| --- | --- | --- | --- |
| A1–A4 | default threads | 4 | 0 |
| A5 | default threads | 1 | **1 — `inverted_orientation_pool_converts_memecoin`, exit 101, `full-pipeline salvage failed: AccountInUse` (panic at `jupiter_conversion_fork.rs:899`) — the same test, same line, same 11/1 split as the preflight observation** |
| B1–B5 | `--test-threads=1` | 5 | 0 |
| C1–C6 | default threads under 6-core busy-loop CPU load | 6 | **1 — `full_pipeline_converts_memecoin_to_sol`, same `AccountInUse` at the same line 899** |
| A6–A10 | default threads | 5 | 0 |
| Regression pass | default threads (final PR #71 commit) | 1 | 0 |

**Total: 21 runs, 2 failures (both `AccountInUse`), 19 clean** — consistent with the preflight's 1-in-12 rate. Raw logs preserved locally (`/tmp/jup-r1.log`, `/tmp/jup-l6.log`; excerpts below; the repo's `*.log` gitignore excludes committing the full files).

**Run-count discrepancy (preserved verbatim, not corrected — closeout 2026-11-02):** the table above sums to **22** runs (4+1+5+6+5+1), not the 21 stated in the prose (which implies 19 clean; the table implies 20). Per the closeout rules the count was NOT "fixed" by arithmetic alone. Recovery attempts on 2026-11-02: the Stage B session's raw logs (`/tmp/jup-r1.log`, `/tmp/jup-l6.log`) are gone with the sandbox; the session's cached tool outputs contain document reads only, no run logs; GitHub Actions has no record of the campaign (it ran locally) — every fork-harness workflow run in the retention window is green (nightly #17 2026-10-31 and #19 2026-11-01; PR runs #22/#23 2026-11-01), so no CI artifact contradicts or corroborates either count. Both the 21/2/19 prose total and the 22-row table are therefore PRESERVED AS RECORDED with this explicit discrepancy note. The material facts are unaffected: 2 × `AccountInUse` at `jupiter_conversion_fork.rs:899` (different tests), 5/5 clean at `--test-threads=1`, disposition UNRESOLVED.

**What the reproduction established (new, beyond the preflight):**

1. The failing transaction dies with **`AccountInUse`** — a transaction-level account-lock error raised by the VM **before the program runs** (the salvage handler never executes; zero state movement; not a slippage, clock, or protocol error).
2. The flake is **not test-specific**: under load a different test failed with the identical error at the identical panic line. The preflight's single observation (the inverted-orientation test) was one sample of the same underlying nondeterminism.
3. Single-threaded execution was clean in 5/5 runs, and the failures only appeared with the harness's default parallel test execution — consistent with a **test-harness concurrency limitation** (parallel `solana-program-test` VMs sharing the process runtime), not with any protocol behavior.

**Remaining uncertainty (honest):** the exact upstream mechanism inside solana-program-test 3.1.12 that surfaces `AccountInUse` across independent per-test banks was not established — per-bank locks should be immune to cross-VM collisions, so the mechanism is some shared runtime/banks-server state; that is a dependency-internals question outside this repo's Stage B scope. **Disposition: UNRESOLVED, unchanged** — the flake is retained with its history; it is not classified as fixed, and no test was modified to obtain green CI.

**Owner-visible options (not implemented — policy decision):** (a) run the fork suites with `--test-threads=1` in `fork-harness.yml` (cheap, removes the concurrency trigger, lengthens the suite by minutes); (b) carry the flake to an upstream solana-program-test investigation. Single-threading is a MITIGATION of the observed concurrency trigger, not a permanent fix: it does not establish the upstream mechanism (see the remaining-uncertainty paragraph above) and would remove the default-thread executions that surface the flake's diagnostics; adopting it is the owner's policy decision and must not be recorded as a fix of this finding. Either way the failure mode is now characterized well enough to triage instantly: `AccountInUse` at a salvage call = harness race, not a protocol regression.

## 5. Remaining limitations and disclosures

1. **Environment:** the sandbox was reset before Stage B; toolchains and the fork harness were rebuilt (exact repo pins). Disk pressure forced pruning of build intermediates between phases; all suites were (re-)run to completion on the final commits — no partial builds are claimed anywhere.
2. **Test counts:** the Phase 5.0 "543" baseline is a historical record and was NOT reused as evidence. This stage's evidence is the 218 host + 56 fork executions above, plus CI runs on PRs #71/#72. TS suites were not re-run locally (no TS changes; CI covers them).
3. **`sweep_stale_anchor` fork coverage nuance:** the suite-level rejection in (c) (foreign account in the anchor slot) asserts a generic instruction error rather than a custom code — the constraint layer's owner/discriminator failure is an Anchor runtime error, not a program-defined code; the 6000 writer-binding case is the precisely-asserted custom-code rejection.
4. **The `fork-harness` label was added to PR #71** by this agent (the API call is quoted in the stage report) to trigger the fork suite under the workflow version on #71's merge-ref — the designed escape hatch, used for verification.
5. **P5-10 (real Jupiter v6)** remains open — blocked by P5-A1 for the end-to-end proof; nothing in this stage changes that.

## 6. Owner-level items and proposed statuses

| Finding | Proposed status | Note |
| --- | --- | --- |
| P5-03 | **Fixed and verified** | both prescribed layers implemented + executed (§2.1) |
| P5-05 | **Fixed and verified** | Charter invariant pinned (§2.3) |
| P5-06 | **Fixed and verified** | bound pinned + documented (§2.4) |
| P5-11 | **Fixed and verified** | both programs pinned (§2.2) |
| P5-02 | **Fixed and verified** | investigation evidenced; dependabot comment accurate; residual documented as host-side informational — **flagged for owner ratification** because the fix is evidence + documentation, not a tree change; reachability documentation corrected 2026-11-02 (log §2.5 closeout re-verification), disposition unchanged |
| P5-04 | **Fixed and verified** | path automation implemented + locally verified; CI-execution evidence = PR #72's own run (§3) — the PR touches the workflow, so the filter fires on it; closeout 2026-11-02: fail-open diff-failure mode found by the post-merge audit and corrected fail-closed (§2.6 closeout correction; fixture tests 23/23 incl. matching-tool-failure fail-closed), and the correction PR's own fork-harness runs **#28/#29 concluded success** — live evidence the fail-closed filter fires and the heavy job passes end-to-end |
| P5-07 | **Open** (narrowed) | SHA pins + platform-tools checksum done; remaining: Solana-installer checksum/self-host, branch protection on tier allow, CodeQL auto-engages on flip-public — all documented, pre-mainnet class |
| P5-A1 | **Open — untouched** | sole P0, owner custody decision; no work in this stage touched deployment authority, oracle keys, or custody |
| P5-08 | **Record only (informational)** | owner approval of the vocabulary extension applied in the register preamble (this PR) |
| Jupiter flake | **Unresolved — preserved** | §4; reproduction history extended, cause class narrowed to a harness-level `AccountInUse` race; not misrepresented as fixed |

**Stop-point statement:** Stage B stops here. No protocol semantics, economics, LP entitlements, settlement rules, account layouts, instruction behavior, P5-A1 custody arrangements, or console-repo files were touched. The three PRs await owner review; nothing was merged.
