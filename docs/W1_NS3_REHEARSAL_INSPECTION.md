# W1 Lifecycle Rehearsal Harness — NS-3 Inspection Report

Inspection performed before any W1 adaptation, per the W1 assignment's
"inspect before coding" gate. Everything below was verified against
`origin/main` at commit `8da44c0429761fc70623a5eb5366c54724074c72` (PR #83
merge). No code was modified when this report was written.

Scope: `scripts/devnet/lifecycle_rehearsal/` + everything it references
(`lib.mjs` web3 resolution, `pin_elfs.mjs` ELF sources,
`prepare_local_accounts.mjs` genesis accounts, `drive_lifecycle.mjs` stages
and adversarial battery, `scripts/devnet/test/` regression suites,
`ns3_*` provenance tooling, `deploy_devnet.sh --build-only`, CI workflows,
`sdk/`, `snapshotter/`, the `GraveYield/salvor-bots` companion checkout).

## 1. What already works (verified, not assumed)

- **NS-3 identities are already consistent at HEAD.** The inspection leads
  claiming "hardcoded NS-2 identities in `lib.mjs` / `pin_elfs.mjs` /
  `prepare_local_accounts.mjs`" are STALE for this tree:
  `lib.mjs` (`IDS`), `pin_elfs.mjs` (`SCANNER_ID`/`VAULT_ID`),
  `prepare_local_accounts.mjs` (loader flags) and `drive_lifecycle.mjs`
  (report metadata) all carry the NS-3 IDs
  (`EFJpKtWx…` / `7VxUGJNg…`). No executed logic in the harness is NS-2-coupled.
- **The 16-stage driver + adversarial battery** (`drive_lifecycle.mjs`)
  executes real transactions through the real SDK builders, the real Rust
  snapshotter bin, and salvor-bots `fleet-core` mode:`"live"`, with exact-code
  adversarial assertions (A1–A5, A6–A10, A9a–c, S15-resweep) and a measured
  zero-state-movement invariant (`evaluateZeroMovement`, unit-tested).
- **ELF provenance machinery exists and is fail-closed**:
  `ns3_check_provenance.mjs` + `provenance.manifest.json` pin exactly the
  approved NS-3 digests (`e24ddc5e…` scanner, `8c71fe9d…` vault, SBPF v0
  `e_machine 263 / e_flags 0`, platform-tools v1.54 archive
  `fcc41631…`); `ns3_verify_elf.mjs` additionally canaries NS-1/NS-2 ID bytes.
  `deploy_devnet.sh --build-only` is an authenticated local build path
  (archive hash-verified EVERY run, cargo-build-sbf version gate, provenance
  gate at the end) that needs no keypairs and submits nothing.
- **Regression suites pass on this tree**: `pnpm --filter
  @graveyield/devnet-tools test` → 192 tests / 22 suites, 0 failures
  (includes `elf_dump`, `zero_movement`, `monitor_gate`,
  `fixture_vault_signer`, `ns3_*` suites).
- **Both TS workspaces build**: `graveyield-protocol` (`sdk/dist`) and the
  `GraveYield/salvor-bots` companion (`dist`, `fleet-core/dist`,
  `monitor/dist`) — the harness resolves its single web3.js instance and
  fleet-core/monitor from the salvor checkout (`SALVOR_BOTS`).
- **`local_rehearsal_ns3.sh`** already proves the NS-3 authority arrangement
  (deploy-at-declare_id via `--bpf-program`, throwaway governance, drill,
  oracle registration) — narrower than W1 but consistent with it.

## 2. What is still NS-2-specific

Only three places, all in the W1 harness surface:

1. **`scripts/devnet/lifecycle_rehearsal.sh` step [2/7]** — the DEFAULT ELF
   source is a Devnet `solana program dump` (`--rpc
   https://api.devnet.solana.com` hardcoded). This is the real NS-2-era
   coupling that matters: W1 requires the harness to execute LOCALLY BUILT,
   hash-verified artifacts and to NOT depend on Devnet program bytes.
2. **`drive_lifecycle.mjs` stage 1** — stale label/detail text "ELF load at
   NS-2 IDs" (cosmetic, but the run report misdescribes the identity).
3. **`lifecycle_rehearsal/README.md`** — stage-1 row says "NS-2 IDs".

No NS-1/NS-2 program IDs appear in any executed path; `NS3_LEGACY_IDS`
correctly retains NS-1/NS-2 IDs as negative canaries (must stay).

## 3. What is already NS-3-compatible

- `lib.mjs` identity table, PDA derivations, UNCX marker seed.
- `prepare_local_accounts.mjs` loader flags and account plan.
- SDK clients (`sdk/`) — program IDs are injected per client, no deployment
  identity baked in; CI's sdk-sync check keeps `salvor-bots/src` a byte-equal
  mirror.
- `register_oracle.mjs`, `monitor_gate.mjs`, `protocol_admin.mjs`
  (parameterized), snapshotter (identity-agnostic), probes.
- `pin_elfs.mjs` already has the `--local-so` pre-deployment path with honest
  "local build" provenance recording.

## 4. What requires adaptation (the W1 change set)

1. **Orchestrator ELF pipeline** (`lifecycle_rehearsal.sh`): replace the
   Devnet-dump default with — build via `deploy_devnet.sh --build-only`
   (authenticated toolchain) → fail-closed provenance gate
   (`ns3_check_provenance.mjs` against `provenance.manifest.json`) →
   `pin_elfs.mjs --local-so`. One command, zero public-cluster RPC for
   program bytes.
2. **Stage 1 hardening** (`drive_lifecycle.mjs`): after boot, hash the
   LOADED on-chain program bytes and require sha256 equality with BOTH the
   pin table AND the approved manifest digests before any lifecycle stage
   runs (§8.A "verify the approved ELF hashes / the local program loading
   process"). Fix the NS-2 label.
3. **`pin_elfs.mjs` local path**: cross-check the local ELFs against the
   approved manifest inside the pin step too (defense in depth — a
   standalone `--local-so` invocation can no longer pin unverified bytes).
4. **Report completeness (§11)**: record base branch/commit, feature
   branch/commit, toolchain versions, local-validator genesis identity, and
   a REAL/MOCK/STUB/EXTERNAL/NOT TESTED component classification; emit a
   readable Markdown summary next to the JSON report.

## 5. What is missing

- §11 metadata (repo/branch/SHA/toolchain/genesis/classifications) in the
  run report — the driver records program IDs and ELF pins but not the
  deployment-identity context.
- Markdown summary output (JSON + log exist).
- A CI job for the harness itself would need the salvor-bots checkout +
  mainnet fixture fetch + full SBF toolchain in one job; left as a
  documented follow-up recommendation (existing CI checks stay intact and
  already cover the devnet-tools suites, sdk-sync, provenance).

## 6. What is mocked, simulated, or boundary-labeled (all already labeled)

Verified in code + README (none silent): synthetic C1 last-swap timestamps
(slot anchor REAL from the `SlotHashes` sysvar); launch price ×200
synthetic collapse; LP mint supply re-pinned to the local holder set (C6);
conversion leg config-skipped via `u64::MAX` dust — **Jupiter v6 is NOT
exercised** (route-account shim satisfies fleet-core's destination
validation but is never executed; C3); compressed clock
(`--slots-per-epoch 32`); 7002 expired-cert negative fork-covered; monitor
rounding-remainder acceptance (Finding D); re-sweep 3012-vs-7021 observation
(Finding C). Raydium V4, Serum DEX and the pool accounts are REAL mainnet
bytes fetched read-only at run time by the repo's cross-validating fetcher
(third-party fixtures, not GraveYield program bytes; the only remaining
public-RPC reads in the pipeline, and strictly read-only).

### Post-inspection note (found during the W1 adaptation runs)

The October-era F3 fixture adaptation (re-pin the local market's stored
nonce to fleet-core's `["vault-signer", market]` string-seed bump + re-point
the market vault owners) is **obsolete against the current salvor-bots
main** (`8d8b6aa`, `ns3/devnet-preparation`): fleet-core now derives the
market vault signer with the REAL OpenBook rule
`create_program_address([market, stored_nonce_le])`, and the re-pinned
nonce 253 is ON-CURVE under it — the fail-closed discovery hard-fails
("address must fall off the ed25519 curve"). The W1 adaptation therefore
RETIRED the re-pin: `prepare_local_accounts.mjs` loads the market
UNMODIFIED (the unmodified fixture is canonical under both the real rule
and current fleet-core), keeps the real-rule provenance assertion, and
`test/fixture_vault_signer.test.mjs` gained a regression guard documenting
the retired adaptation.

## 7. What cannot be validated without owner intervention

- Devnet/Mainnet deployment state (`verify_ns3_deployment.mjs`) —
  owner-executed, read-only; out of W1 scope (no public-cluster operations).
- Real Jupiter v6 route execution (needs a live route source; the protocol's
  own settlement/accounting is verified independently of it).
- Production authority/oracle custody keys — local rehearsal uses throwaway
  identities by design (PR #81); the permanent NS-3 governance/oracle keys
  never enter local state.
- Salvor fleet execution against public clusters (fleet-core mode:`"live"`
  is exercised against the local validator only).
