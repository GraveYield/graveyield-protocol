// SPDX-License-Identifier: Apache-2.0
//
// @graveyield/sdk — TypeScript salvor SDK.
//
// Exposes the GraveYield client, types, and helpers used by salvor bot
// operators and front-ends. The SDK NEVER bypasses Charter invariants:
// it refuses to submit any transaction that would exceed the on-chain
// `max_priority_fee_ceiling_lamports` and falls back to operator-side
// safety limits derived from expected profit margin.

export * from "./client.js";
export * from "./types.js";
export * from "./priorityFee.js";
export * from "./certifyAndSalvage.js";
