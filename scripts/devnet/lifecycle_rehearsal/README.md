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
| 13 | reconciliation | salvor-bots `@graveyield/monitor` `reconcile` → `receipt-verified` |
| 14 | claims | `claim_lp_proceeds` ×3 from the **Rust** artifact proofs; paid exactly `floor(pool × balance / supply)` |
| 15 | dust | permissionless `sweep_dust` → treasury; re-sweep reverts `7021` |
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
- **F3 — market nonce**: the real SOL/USDC Serum v3 market stores
  `vault_signer_nonce = 1` (u64 LE @45) → non-canonical vault signer →
  fleet-core's canonical derivation fails closed. `prepare_local_accounts.mjs`
  re-pins the local market's nonce to the canonical bump and re-points both
  market vault token accounts to the canonical signer. Evidence:
  `probe_vault_signer.mjs`.

## Labeled boundaries (none silent)

synthetic C1 last-swap timestamps · launch price ×200 · LP mint supply
re-pinned to the local holder set (economics grounded in the manifest's
`amm_lp_amount`, NOT the re-pinned supply) · conversion leg config-skipped
(`u64::MAX` dust) · route-account shim satisfies fleet-core's destination
validation but is never executed on-chain (skipped leg) · compressed clock ·
`7002`/gap-1 timing may land fork-covered · fresh local keys (devnet payer
custody NOT involved).

## Files

- `lifecycle_rehearsal.sh` (repo `scripts/devnet/`) — orchestrator
- `lib.mjs` — plumbing: single web3.js instance from the salvor checkout,
  BigInt-safe JSON, sysvar slot-hash reader, v0/ALT-aware sender, error-family
  classifier mirroring grave-indexer's `classifySim`, ESM `require` shim for
  the SDK's lazy spl-token load
- `pin_elfs.mjs` — devnet dumps + mainnet fixture fetch + sha256 pin table
- `prepare_local_accounts.mjs` — patched accounts + holder ATAs + loader flags
  (written ONCE, after the holder section — run-2 fix)
- `register_oracle.mjs` — the 80-byte governance ix + readback asserts
- `drive_lifecycle.mjs` — the 16-stage + adversarial driver
- `probe_slothash.mjs`, `probe_vault_signer.mjs` — F1/F3 evidence probes
