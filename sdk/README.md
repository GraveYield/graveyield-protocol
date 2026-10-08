# @graveyield/sdk

TypeScript salvor SDK for GraveYield Protocol — turns the on-chain
GraveScanner + GraveVault programs into operations a salvor bot can call
without manually constructing Anchor instructions or hand-rolling borsh.

## Status — Phase 8 complete

All eight Phase-8 SDK operations are implemented and tested against the
live devnet ProtocolConfigs at the handoff-deployed PDA addresses:

| Operation | Backing instruction(s) | Live-verified |
|---|---|---|
| `evaluatePool()` | Pure read; walks all six derelict-pool criteria (C1–C6) | ✔ devnet smoke |
| `recordLaunchPrice()` | `record_launch_price` + C2 precompile | ✔ (read-back of PDA) |
| `phase1()` | `evaluate_pool_phase_1` + C1 precompile | ✔ (IDL-free pattern) |
| `phase2()` | `evaluate_pool_phase_2` + fresh C1 precompile | ✔ (IDL-free pattern) |
| `snapshotLpHolders()` | Off-chain: enumerate SPL token accounts, completeness gate, Merkle root | ✔ unit-tested |
| `buildMerkleTree()` | TS port of `snapshotter/src/tree.rs` (byte-locked against `merkle.rs::verify_proof`) | ✔ unit-tested against the 3-leaf fork vector |
| `certifyAndSalvage()` | Bundle `evaluate_pool_phase_2` + `salvage_pool` (atomic — beats the 1h cert TTL) | ✔ (instruction builder) |
| `claimLpProceeds()` | `claim_lp_proceeds` with Merkle proof (callable during pause) | ✔ (instruction builder) |

Plus the infrastructure groups the Phase-8 contract demands:

- **Transaction builders** — IDL-free pattern proven in `scripts/devnet/protocol_admin.mjs`
- **Account decoders** — every Anchor state struct (ProtocolConfig ×2, EligibilityAnchor, EligibilityCert, LaunchPrice, PoolRegistry, SalvageReceipt, ClaimRecord)
- **PDA derivation** — every seed the on-chain programs declare
- **Error decoding** — full mirror of `docs/error_codes.md` (Scanner 6000–6034, Vault 7000–7021)
- **Priority-fee utilities** — Charter-aware; refuses to submit txs above the on-chain ceiling
- **Simulation helpers** — `simulateTransaction` + `simulateAndDecode`
- **Raydium V4 reader** — AmmInfo parser, vault reserve reader, base-token orientation check (7019 guard)

## Install

```bash
pnpm add @graveyield/sdk @solana/web3.js @coral-xyz/anchor
```

## Usage

```ts
import { GraveYieldClient, buildPriorityFeePolicy } from "@graveyield/sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

const client = new GraveYieldClient({
  connection: new Connection("https://api.mainnet-beta.solana.com"),
  cluster: "mainnet-beta",
  graveScannerProgramId: new PublicKey("..."),
  graveVaultProgramId: new PublicKey("..."),
});

// Evaluate a candidate pool — pure read, walks all six criteria.
const result = await client.evaluatePool(new PublicKey("pool address"));
console.log(result.eligible, result.failedCriteria);

// Build a Charter-aware priority fee policy.
const policy = buildPriorityFeePolicy({
  expectedProfitLamports: new BN(1_500_000),
  protocolCeilingLamportsPerCu: new BN(1_000_000_000),
});
```

## Charter awareness (non-negotiable)

The SDK refuses to submit any transaction whose `compute_unit_price` would
exceed the on-chain `max_priority_fee_ceiling_lamports` Charter parameter.
This is a non-negotiable invariant — operators cannot opt out via SDK config.

## IDL-free pattern (no Anchor CLI needed)

The SDK builds Anchor instructions directly via the pattern proven in
`scripts/devnet/protocol_admin.mjs`:

- `discriminator = sha256("global:<snake_case>")[0..8]`
- hand-rolled borsh for params (mirrors the Rust structs field-by-field)
- PDA via `PublicKey.findProgramAddressSync(seeds, programId)`
- account meta via `isSigner` / `isWritable` matching Anchor's emission

`@coral-xyz/anchor` stays a dependency (consumers may use it elsewhere),
but the SDK does NOT depend on `anchor build` or any IDL JSON.

## Tests

```bash
# Unit tests (offline — Merkle vectors, borsh round-trips, discriminators,
# priority-fee edges, Charter guard, attestation wire format, PDA seeds).
pnpm -r test

# Live devnet smoke (read-only) — sets DEVNET_RPC_URL.
DEVNET_RPC_URL=https://api.devnet.solana.com pnpm -r test
```

The test suite uses `node:test` (zero new heavy deps) plus `tsx` for
TypeScript execution. The devnet smoke tests are SKIPPED when
`DEVNET_RPC_URL` is unset, so CI stays green without network access.

## Byte-locked conventions

The SDK mirrors these on-chain byte layouts exactly:

- **Merkle leaf**: `SHA256(pubkey (32B) || lp_balance_le_u64 (8B))` —
  matches `grave_vault::merkle::compute_leaf` (40-byte preimage).
- **Merkle parent**: `SHA256(min(a, b) || max(a, b))` — sorted-pair, 64 bytes.
- **Merkle promotion**: odd node at a tree level promotes unchanged to
  the next level. A promotion contributes NO proof element. The
  3-leaf fork-proven vector
  (`settlement_economics_fork.rs::build_three_leaf_tree`) is in the
  test suite as the canonical regression test.
- **C1 last-swap attestation**: 112 bytes at offset 72 inside the
  scanner instruction data (`IX_DATA_MSG_OFFSET`).
- **C2 launch-price attestation**: 168 bytes at offset 152
  (`LAUNCH_PRICE_MSG_OFFSET`).
- **Ed25519 precompile wire format**: 112 bytes (header + pk + sig) —
  the runtime's OWN layout, not the pre-Phase-6 "14-byte header" form.

## Devnet program IDs (real, deployed)

| Program | Devnet ID |
|---|---|
| GraveScanner | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` |
| GraveVault | `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` |
| Scanner ProtocolConfig PDA | `GcdZJhCpg7sjgEEHTsoSkT2Pi83d8kP3NrTqdvMm2Bhu` |
| Vault ProtocolConfig PDA | `2SCqqpEwKMuWnJWe7UQJTzFeDPif4jUPUspWKZdZ5vaU` |

The devnet smoke tests assert these addresses and decode the live
ProtocolConfigs against the spec default tables
(`SCANNER_PROTOCOL_CONFIG_DEFAULTS` / `VAULT_PROTOCOL_CONFIG_DEFAULTS`).

## LOCKER-002

The SDK surfaces the UNCX Raydium V4 marker check as a flag
(`SnapshotResult.uncxMarkerPresent`). The on-chain adapter is the
authoritative check (LOCKER-001); the SDK's off-chain cross-check for
non-UNCX lockers (PinkSale / Team.Finance / Streamflow) is a Phase 9
indexer concern and is NOT implemented in v0.2. Operators must resolve
the locker evidence out-of-band before certification until the Phase 9
indexer produces it.

## License

Apache-2.0, same as the rest of the GraveYield monorepo.
