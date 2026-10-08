// SPDX-License-Identifier: Apache-2.0
//
// @graveyield/sdk — TypeScript salvor SDK.
//
// Exposes the GraveYield client, types, helpers, instruction builders,
// account decoders, PDA derivation, error decoding, simulation helpers,
// and the eight top-level operations a salvor bot needs (Phase 8 exit
// condition):
//
//   evaluatePool         — pure read; checks all six derelict-pool criteria
//   recordLaunchPrice    — tx: C2 precompile + record_launch_price
//   phase1               — tx: C1 precompile + evaluate_pool_phase_1
//   phase2               — tx: fresh C1 precompile + evaluate_pool_phase_2
//   snapshotLpHolders    — off-chain LP-holder snapshot + Merkle root
//   buildMerkleTree      — TS port of snapshotter/src/tree.rs
//   certifyAndSalvage    — bundle phase2 + salvage_pool (atomic, beats cert TTL)
//   claimLpProceeds      — claim_lp_proceeds tx with proof
//
// The SDK NEVER bypasses Charter invariants: it refuses to submit any
// transaction that would exceed the on-chain `max_priority_fee_ceiling_lamports`
// and falls back to operator-side safety limits derived from expected
// profit margin. Operators cannot opt out via SDK config.

// ----- top-level client + types -----
export * from "./client.js";
export * from "./types.js";

// ----- infrastructure -----
export * from "./priorityFee.js";
export * from "./certifyAndSalvage.js";
export * from "./lastSwapAttestation.js";
export * from "./launchPriceAttestation.js";
export * from "./borsh.js";
export * from "./discriminators.js";
export * from "./pdas.js";
export * from "./errors.js";
export * from "./accountDecoders.js";
export * from "./raydiumV4.js";
export * from "./raydiumV4Constants.js";
export * from "./merkle.js";
export * from "./snapshot.js";
export * from "./simulation.js";

// ----- instruction builders -----
export * from "./instructions.js";
export * from "./salvagePool.js";
