# @graveyield/ops — Phase 11 infrastructure & observability

The operations layer that turns the Phase 8–10 components into **running
services**: the indexer sweeps, the GraveVault observer indexes receipts /
claims / failed transactions, the Merkle service produces deterministic
snapshot artifacts, and the scenario runner executes the roadmap's
"controlled salvage scenarios". Everything is read-only unless an operator
explicitly configures keys.

> The full runbook (supervision, env vars, alerting, scenario
> procedures) lives in [`docs/OPS.md`](../docs/OPS.md).

## The services

| Service | Module | Roadmap row it closes | What it does |
|---|---|---|---|
| Indexer service | `indexerService.ts` | "indexer running" | wraps the Phase 9 `GraveScannerV2` loop with health heartbeats, cycle counters, and failure alerts |
| Vault observer | `vaultObserver.ts` | "events indexed / salvage receipts indexed / claims indexed / failed transactions monitored" | sweeps every GraveVault account, decodes with the SDK's decoders, verifies the 40/40/20 invariants, reconciles claim accounting, sweeps failed txs |
| Merkle service | `merkleService.ts` | "Merkle service running" | builds deterministic, self-verifying snapshot artifacts (integrity hash + root rebuild + proof check on every load) |
| Health | `health.ts` | "alerting" (half) | component registry with derived staleness, monotonic counters, JSON snapshots |
| Alerts | `alerts.ts` | "alerting" (other half) | coded alerts with severity + dedup windows; console / JSONL / webhook sinks |
| Scenarios | `scenarios.ts` | "then run controlled salvage scenarios" | SC-01 lifecycle sweep, SC-02 vault audit, SC-03 local deploy+drill rehearsal |

## Design rules

- **Read-only by construction.** The observer and the scenarios hold no
  keypairs and build no instructions. The indexer only submits when the
  operator sets `ACTIVITY_ORACLE_KEY` (the Phase 9 contract).
- **Narrow injectable chain view.** Every service reads the chain through
  `ChainView` (`views.ts`) — four methods. Production wires a real
  `Connection` via `connectionChainView`; tests wire canned fixtures. No
  service knows web3.js beyond that seam.
- **SDK decoders are the only decoders.** The observer dispatches on
  `AccountDisc` and calls `decodeSalvageReceipt` / `decodeClaimRecord` /
  `decodePoolRegistry` / `decodeVaultProtocolConfig`. No hand-rolled
  layouts anywhere in ops.
- **Fail-closed artifacts.** A Merkle artifact that fails its integrity
  hash, root rebuild, or proof check throws — it can never reach a claim
  flow silently.
- **Zero new dependencies.** `@solana/web3.js`, `@graveyield/sdk`,
  `@graveyield/indexer`, `bn.js` — nothing else. The webhook sink uses
  the injectable global `fetch`.

## The receipt invariants (R1/R2, C1–C3)

Identical to the fleet Monitor's reconcile semantics:

- **R1** — `lpHolder + salvor + protocol == totalProceeds` per receipt.
- **R2** — each leg within **1 lamport** of its 4000/4000/2000 bps share.
- **C1** — Σ `ClaimRecord.amountLamports` per pool == the registry's
  on-chain `lpHolderPoolClaimedLamports`.
- **C2** — Σ claims ≤ the receipt's LP-holder leg (no overclaim).
- **C3** — registry `lpHolderPoolTotalLamports` == receipt
  `lpHolderAmountLamports` on double-sided pools.

## CLI

```bash
graveyield-ops indexer              # one discovery cycle (or --loop)
graveyield-ops vault-observer       # one GraveVault sweep (or --loop)
graveyield-ops merkle --pool P      # one snapshot artifact
graveyield-ops scenario sc-01       # live lifecycle sweep (read-only)
graveyield-ops scenario sc-02       # deep vault audit (read-only)
graveyield-ops scenario sc-03       # local deploy+drill rehearsal
graveyield-ops health               # health snapshot
graveyield-ops all                  # everything, forever
```

Exit codes: `0` ok · `1` checks failed · `2` usage. Argument syntax
accepts both `--key=value` and `--key value`.

## Tests

47 offline tests (`node:test` + `tsx`): health freshness/status math,
alert dedup + sink isolation, hand-encoded vault accounts through the SDK
decoders (every invariant incl. the ±1-lamport tolerance boundary),
artifact tamper detection, and scenario wiring with fakes. No network.
