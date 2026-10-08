// SPDX-License-Identifier: Apache-2.0
//
// Anchor discriminators — the 8-byte SHA-256 prefixes Anchor uses to
// dispatch instruction handlers and identify account types.
//
//   Instruction discriminator  = sha256("global:<snake_case_name>")[0..8]
//   Account discriminator      = sha256("account:<PascalCaseName>")[0..8]
//
// Anchor CLI is not installed in this repo and there is no IDL anywhere
// (the SDK is IDL-free, see HANDOFF_PHASE8 §5.2 — pattern proven in
// `scripts/devnet/protocol_admin.mjs`). These helpers compute the same
// bytes Anchor's `#[program]` / `#[account]` macros would emit.
//
// Reference: https://www.anchor-lang.sg/docs/program-structure/internal
// (Anchor 0.32.1 — the runtime version pinned in `Anchor.toml`).

import { createHash } from "node:crypto";

/** First 8 bytes of `sha256("global:<snake_case>")`. Used as instruction data prefix. */
export function globalDiscriminator(snakeName: string): Uint8Array {
  return createHash("sha256").update(`global:${snakeName}`).digest().subarray(0, 8);
}

/** First 8 bytes of `sha256("account:<PascalCase>")`. Lives at the start of every Anchor state account. */
export function accountDiscriminator(pascalName: string): Uint8Array {
  return createHash("sha256").update(`account:${pascalName}`).digest().subarray(0, 8);
}

// ----------------------------------------------------------- cache of named
//
// Pre-computed discriminators for the on-chain instructions and accounts
// the SDK drives. Listed in the same order as the Rust `lib.rs::#[program]`
// blocks so any future drift surfaces immediately.

export const ScannerIx = {
  initialize: globalDiscriminator("initialize"),
  recordLaunchPrice: globalDiscriminator("record_launch_price"),
  evaluatePoolPhase1: globalDiscriminator("evaluate_pool_phase_1"),
  evaluatePoolPhase2: globalDiscriminator("evaluate_pool_phase_2"),
  invalidateAnchor: globalDiscriminator("invalidate_anchor"),
  sweepStaleAnchor: globalDiscriminator("sweep_stale_anchor"),
  updateProtocolConfig: globalDiscriminator("update_protocol_config"),
  emergencyPause: globalDiscriminator("emergency_pause"),
} as const;

export const VaultIx = {
  initialize: globalDiscriminator("initialize"),
  updateProtocolConfig: globalDiscriminator("update_protocol_config"),
  emergencyPause: globalDiscriminator("emergency_pause"),
  salvagePool: globalDiscriminator("salvage_pool"),
  claimLpProceeds: globalDiscriminator("claim_lp_proceeds"),
  sweepDust: globalDiscriminator("sweep_dust"),
} as const;

export const AccountDisc = {
  ProtocolConfig: accountDiscriminator("ProtocolConfig"),
  EligibilityAnchor: accountDiscriminator("EligibilityAnchor"),
  EligibilityCert: accountDiscriminator("EligibilityCert"),
  LaunchPrice: accountDiscriminator("LaunchPrice"),
  PoolRegistry: accountDiscriminator("PoolRegistry"),
  SalvageReceipt: accountDiscriminator("SalvageReceipt"),
  ClaimRecord: accountDiscriminator("ClaimRecord"),
} as const;
