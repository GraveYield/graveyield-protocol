// SPDX-License-Identifier: Apache-2.0
//
// certifyAndSalvage — one-step bundle helper.
//
// EligibilityCert TTL is 1 hour. Submitting Phase-2 certify and salvage_pool
// in separate transactions risks the cert expiring before salvage lands.
// This helper packs both into a single atomic Solana transaction so the
// salvor never races the cert TTL against network congestion.
//
// Transaction shape (instructions in order):
//   0: ed25519_program verify  (C1 last-swap attestation)
//   1: GraveScanner::evaluate_pool_phase_2
//   2: GraveVault::salvage_pool
//
// The precompile's `scannerInstructionIndex` is 1 (the phase 2 ix is
// instruction index 1, immediately after the precompile). The
// salvage_pool instruction is a separate program and does NOT carry the
// attestation — the on-chain scanner verifies the signature is fresh
// (SlotHashes window) before issuing the cert, and the cert is then
// consumed by salvage_pool in the same atomic transaction.

import type { TransactionInstruction } from "@solana/web3.js";
import type { GraveYieldClient, Phase2Input } from "./client.js";
import type { SalvagePoolIxInput } from "./salvagePool.js";

/** Inputs to `buildCertifyAndSalvage`. */
export interface CertifyAndSalvageInput {
  client: GraveYieldClient;
  /** The phase-2 certify inputs (C1 precompile + evaluate_pool_phase_2). */
  phase2: Phase2Input;
  /** The salvage_pool inputs (Merkle root, Jupiter route, etc.). */
  salvage: SalvagePoolIxInput;
}

/** The bundle: phase-2 certify + salvage_pool instructions, plus the C1 precompile. */
export interface CertifyAndSalvageOutput {
  /** Ed25519 precompile ix — MUST be the FIRST instruction in the bundle. */
  precompileIx: TransactionInstruction;
  /** Phase-2 evaluate_pool instruction. */
  certifyIx: TransactionInstruction;
  /** salvage_pool instruction. */
  salvageIx: TransactionInstruction;
}

/**
 * Build the (precompile, certify, salvage) instruction triple. The
 * caller assembles them into a single transaction with appropriate
 * priority fee + compute budget — the SDK's `GraveYieldClient.
 * computeBudgetIxs` enforces the Charter ceiling on the priority fee.
 *
 * The certify-and-salvage bundle is the salvor's atomic exit point: the
 * cert is issued and consumed in the same atomic transaction, so the
 * 1h TTL cannot race network congestion.
 */
export async function buildCertifyAndSalvage(
  input: CertifyAndSalvageInput,
): Promise<CertifyAndSalvageOutput> {
  const { precompileIx, phase2Ix } = input.client.buildPhase2Ix(input.phase2);
  // Re-use the salvage_pool builder directly. The cert TTL is 1h; the
  // bundle makes this a non-issue.
  const { buildSalvagePoolIx } = await import("./salvagePool.js");
  const salvageIx = buildSalvagePoolIx(input.salvage);
  return { precompileIx, certifyIx: phase2Ix, salvageIx };
}
