# @graveyield/sdk

TypeScript salvor SDK for GraveYield Protocol.

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

// Evaluate a candidate pool.
const result = await client.evaluatePool(new PublicKey("pool address"));

// Build a Charter-aware priority fee policy.
const policy = buildPriorityFeePolicy({
  expectedProfitLamports: new BN(1_500_000),
  protocolCeilingLamportsPerCu: new BN(1_000_000_000),
});
```

## Charter awareness

The SDK refuses to submit any transaction whose `compute_unit_price` would
exceed the on-chain `max_priority_fee_ceiling_lamports` Charter parameter.
This is a non-negotiable invariant — operators cannot opt out via SDK config.

## Status

Phase 0 scaffold. Implementations land per the m1–m8 build sequence
documented in [`../docs/grave-scanner-grave-vault-combined.md`](../docs/grave-scanner-grave-vault-combined.md).
