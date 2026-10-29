# W1 Lifecycle Rehearsal Harness

One command, local, end-to-end: **16 lifecycle stages + an adversarial battery,
every one executing REAL transactions against REAL deployed program bytes
through the REAL TypeScript SDK client paths and the REAL salvor-bots
fleet-core submit path.** No mock replaces program execution anywhere; every
compressed/stubbed edge is labeled in the run report's `boundaries` array.

```bash
# prereqs: agave 3.0.10, rust 1.91.1, node ≥ 24, pnpm 9 — and BOTH workspaces
# built:  (graveyield-protocol)$ pnpm install && pnpm -r build
#         (salvor-bots)     $ pnpm install && pnpm -r build

bash scripts/devnet/lifecycle_rehearsal.sh          # uses ../salvor-bots
#   or: SALVOR_BOTS=/path/to/salvor-bots bash scripts/devnet/lifecycle_rehearsal.sh
#   artifacts + run report land in target/lifecycle-rehearsal/
```

## What it does

| # | Stage | How |
|---|---|---|
| 1 | validator boot + ELF load at the NS-2 IDs | devnet `solana program dump` (scanner/vault) + real mainnet fixtures (Raydium V4, Serum) via `--bpf-program` (no program keypairs needed); sha256 pins recorded |
| 2 | ProtocolConfig initialize | real SDK builders; vault dust = `u64::MAX` (conversion leg config-skipped — boundary C3, canonical `full_lifecycle_fork` shape) |
| 3 | oracle registration | hand-rolled 80-byte `update_protocol_config` (no SDK builder exists — governance action, per ORACLE_CUSTODY.md) |
| 4 | discovery wiring smoke | SDK `evaluatePool` against the fixture pool (tolerant — C5/C6 boundary) |
| 5 | `record_launch_price` | 168B C2 attestation, launch price = reserves price × 200 → 99.5% collapse (fork-precedented) |
| 6 | `evaluate_pool_phase_1` | 112B C1 attestation anchored to a REAL local slot hash read from the **sysvar** (finding F1) → `EligibilityAnchorWritten` |
| 7 | 2-epoch confirmation | `--slots-per-epoch 32` compressed clock + exact-code `6016` at gap-1 (fork-covered if the clock already passed — labeled) |
| 8 | `evaluate_pool_phase_2` | → `EligibilityCertIssued` |
| 9 | REAL snapshotter | `snapshotter/src/bin/grave-snapshotter-cli.rs` (Rust, `SnapshotBuilder`+`SnapshotArtifact::seal`) vs SDK snapshot — root/supply/holder equality |
| 10–11 | salvage | fleet-core `ExecutionPipeline` mode:`"live"`, salvage-only, at-most-once `InMemoryFleetStore` admission, submit through a **v0 message over a real local ALT** (finding F2) |
| 12 | settlement | receipt legs 40/40/20 bps ± 1 lamport + PDA balance cross-check |
| 13 | reconciliation | salvor-bots `@graveyield/monitor` `reconcile` → `receipt-verified`, or a `receipt-anomaly` that is EXACTLY the known protocol-leg rounding remainder (accepted + recorded with its magnitude — never relabeled; Finding D) |
| 14 | claims | `claim_lp_proceeds` ×3 from the **Rust** artifact proofs; paid exactly `floor(pool × balance / supply)` |
| 15 | dust | permissionless `sweep_dust` → treasury; re-sweep reverts `3012` (closed-ATA Anchor decode precedes the handler's `7021` — fork-covered; Finding C) |
| 16 | drills | `protocol_admin.mjs drill` (scanner + vault): pause → assert → intruder-must-revert (6000/7000) → unpause |

Adversarial battery (every case: exact code / classified family + a
zero-state-movement invariant — the only permitted movement is the failed tx's
signature fee, recorded, never normalized away):

- **A1** missing precompile → `6024`; **A2** tampered signature → precompile;
  **A3** sig offset 56 → `6025`; **A4** unauthorized oracle → `6026`;
  **A5** 111-byte message (signed over the 111 bytes — the precompile must
  verify) → anchor-decode; **A10** phase_2 before anchor → `3012` (Anchor
  `AccountNotInitialized` precedes the handler's `6015` — observed, recorded
  per red line 5)
- **A6** salvage while paused → `7003`; **A7** tampered snapshot supply →
  `7018` (both BEFORE the real salvage); **A8** replayed salvage → registry
  init failure (anchor-decode); **A9** duplicate claim (init failure) /
  tampered proof → `7010` / inflated payout → `7010` (proof binding; the
  fork's `7009` math path needs in-VM registry control — labeled)
- fork-covered negative: `7002` expired-cert (no wall-clock travel on a live
  validator; covered in-VM by the fork suites)

## Findings the harness proved (F1–F3)

- **F1 — SLOT-HASH**: `SDK.fetchSlotHash` (`getBlock(slot).blockhash`) NEVER
  equals the `SlotHashes` sysvar entry on agave 3.0.10 → every SDK-sourced
  hash reverts `6030`. The harness reads `(slot, hash)` pairs from the sysvar
  itself. Evidence: `probe_slothash.mjs`.
- **F2 — 1232-byte packet limit**: the salvage ix (21 named + 13 V4 remaining
  ≈ 1.4 kB) cannot fit a legacy packet. The SAME instructions compile into a
  `VersionedTransaction` v0 over a REAL local address-lookup table, created
  and pre-warmed BEFORE the battery so creation costs never enter a
  zero-movement window.
- **F3 — market vault signer (Finding E remediation)**: fleet-core's
  account-discovery pipeline derives the market vault signer as the
  string-seed PDA `["vault-signer", market]` under the market program — a
  scheme that matches NO real OpenBook market. The REAL OpenBook v1 rule is
  `create_program_address([market, nonce_le])`, and the real SOL/USDC
  market's stored nonce `1` (u64 LE @45) IS canonical under it — it
  reproduces the real mainnet vault signer exactly (asserted on every run
  by `probe_vault_signer.mjs` and `prepare_local_accounts.mjs`). The local
  fixture is therefore ADAPTED to fleet-core's scheme: the local market's
  stored nonce is re-pinned to the string-seed PDA's bump and both market
  vault token accounts' owner is re-pointed to that PDA. This is a
  documented fleet-core-compatibility adaptation — the local market
  DEVIATES from mainnet semantics, and the modified relationship is never
  validated on-chain by the W1 salvage path (the vault's Raydium withdraw
  CPI ignores the market vault signer). Faithful CPI evidence lives in the
  fork suite (`raydium_v4_fork.rs`), which uses the UNMODIFIED mainnet
  market. Evidence: `probe_vault_signer.mjs`, `local_plan.market`.

## Labeled boundaries (none silent)

synthetic C1 last-swap timestamps · launch price ×200 · LP mint supply
re-pinned to the local holder set (economics grounded in the manifest's
`amm_lp_amount`, NOT the re-pinned supply) · conversion leg config-skipped
(`u64::MAX` dust) · route-account shim satisfies fleet-core's destination
validation but is never executed on-chain (skipped leg) · compressed clock ·
`7002`/gap-1 timing may land fork-covered · fresh local keys (devnet payer
custody NOT involved).

## Rebuild findings (2026-10-28, runs 1–42)

The harness was rebuilt from the engagement record after the third workspace
reset destroyed the original verified commits; 20 fixes surfaced during the
rebuild iterations, the load-bearing ones beyond F1–F3:

- `AddressLookupTableProgram.createLookupTable` takes **`recentSlot`** (not
  `slot`) in web3.js 3.x; `extendLookupTable` returns a non-array wrapper that
  must be normalized.
- The `SlotHashes` sysvar is **bincode** `Vec<(u64, [u8;32])>`: an 8-byte LE
  length prefix, entries NEWEST-FIRST — a borsh-style 4-byte prefix
  misaligns every read.
- `Keypair.fromSecretKey` is **async** in web3.js 3.x; the salvor SDK's
  `web3compat` restores `findProgramAddressSync`/`createProgramAddressSync`/
  `toBuffer` — the driver's single web3 instance MUST come from the salvor
  checkout (createRequire-anchored resolution; `import.meta.resolve` ignores
  its parent argument).
- `MessageV0.compile` needs fetched `{key, state}` lookup-table accounts —
  bare PublicKeys crash `extractTableLookup`.
- web3.js 3.x `simulateTransaction` rejects a config object on a legacy
  Transaction ("Invalid arguments") and the legacy packet cannot carry the
  salvage ix — the connection shim translates the config and simulates
  oversized txs as **v0 over the ALT** ("enforced at simulate AND send").
- The salvage tx CREATES the `lp_holder_pool` PDA: its balance is the LP leg
  PLUS the account's rent-exempt reserve; claims are computed against the
  **receipt's recorded LP leg** (not the running balance), the protocol leg is
  the exact remainder (can deviate +2 from floor(20%) — the shipped monitor's
  ±1 tolerance is tighter than the allocation; labeled boundary), and the
  claim negatives must use a wallet with NO existing ClaimRecord (Anchor
  `init` runs before the handler — an already-in-use allocate would mask the
  7010).
- The re-sweep reverts **3012** (closed-ATA decode) before the handler's 7021
  on a live validator — recorded per red line 5; stage 15 + the README now
  state the OBSERVED code (Finding C).
- `protocol_admin.mjs drill` gained `--expect-vault-dust` (default unchanged)
  so the C3 `u64::MAX` initialization can be drilled honestly.

## W1 follow-up remediation (2026-10-29, Findings A–E)

- **A — stale ELF reuse**: `pin_elfs.mjs` never checked the `solana program
  dump` subprocess result and accepted any pre-existing ≥100 kB output file.
  Dumps now go through `elf_dump.mjs`: destination isolated before the dump,
  spawn error/signal/exit status checked, SBF ELF header validated, and the
  bytes byte-compared against fresh on-chain program data (RPC read-only) —
  provenance is recorded in the pin table or the run fails. Regression:
  `scripts/devnet/test/elf_dump.test.mjs`.
- **B — state-invariance claims**: `expectRevert` claimed "every other
  wallet … bit-identical" but tracked only the fee payer (≤10 k lamports,
  not exact) plus caller-listed token accounts/PDAs. It now pins the fee
  payer's debit to the transaction's EXACT `meta.fee`, bit-compares a
  default wallet set (all keypairs + settlement PDAs), token accounts, and
  any listed existing account (byte-identical), and the comparison lives in
  a pure evaluator (`lib.evaluateZeroMovement`). Regression:
  `scripts/devnet/test/zero_movement.test.mjs`.
- **C — second sweep_dust error code**: the driver asserted 3012 but its
  stage detail (and README row 15) claimed 7021. Corrected to the observed
  3012 (7021 fork-covered); the re-sweep is now a measured `expectRevert`
  case (previously it hand-wrote `zero_movement: proved: true`).
- **D — monitor reconciliation outcomes**: stage 13 accepts
  `receipt-anomaly` only when it is exactly the protocol-leg rounding
  remainder; the acceptance logic is an explicit, unit-tested gate
  (`monitor_gate.mjs`) that records the accepted kind, the discrepancy
  magnitude, and the reason — and still fails on any unexpected anomaly.
  Regression: `scripts/devnet/test/monitor_gate.test.mjs`.
- **E — fixture derivation**: the F3 narrative was inverted — the real
  market IS canonical under the real OpenBook rule; fleet-core's string-seed
  derivation is the mismatch. `probe_vault_signer.mjs` now derives with the
  REAL rule and hard-fails on mismatch, `prepare_local_accounts.mjs`
  records both derivations in `local_plan.market` and hard-fails if the
  real rule stops reproducing the manifest signer, and the fixture is
  documented as a fleet-core-compatibility adaptation. Regression:
  `scripts/devnet/test/fixture_vault_signer.test.mjs`.

## Files

- `lifecycle_rehearsal.sh` (repo `scripts/devnet/`) — orchestrator
- `lib.mjs` — plumbing: single web3.js instance from the salvor checkout,
  BigInt-safe JSON, sysvar slot-hash reader, v0/ALT-aware sender, error-family
  classifier mirroring grave-indexer's `classifySim`, ESM `require` shim for
  the SDK's lazy spl-token load
- `pin_elfs.mjs` — devnet dumps (via `elf_dump.mjs`: isolated destination,
  checked subprocess result, SBF ELF validation, on-chain byte-identity
  provenance) + mainnet fixture fetch + sha256 pin table
- `prepare_local_accounts.mjs` — patched accounts + holder ATAs + loader flags
  (written ONCE, after the holder section — run-2 fix)
- `register_oracle.mjs` — the 80-byte governance ix + readback asserts
- `drive_lifecycle.mjs` — the 16-stage + adversarial driver
- `elf_dump.mjs` — Finding A: checked, provenance-verified program dumps
- `monitor_gate.mjs` — Finding D: explicit stage-13 reconciliation gate
- `probe_slothash.mjs`, `probe_vault_signer.mjs` — F1/F3 evidence probes
- `test/` — node:test regression suites (run: `pnpm --filter @graveyield/devnet-tools test`)
