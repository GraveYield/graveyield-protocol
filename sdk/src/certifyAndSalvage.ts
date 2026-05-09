// SPDX-License-Identifier: Apache-2.0
//
// certifyAndSalvage — one-step bundle helper.
//
// EligibilityCert TTL is 1 hour. Submitting Phase-2 certify and salvage_pool
// in separate transactions risks the cert expiring before salvage lands.
// This helper packs both into a single atomic Solana transaction so the
// salvor never races the cert TTL against network congestion.

import type { TransactionInstruction } from "@solana/web3.js";
import type { GraveYieldClient } from "./client.js";

export interface CertifyAndSalvageInput {
  client: GraveYieldClient;
  poolAddress: import("@solana/web3.js").PublicKey;
}

export interface CertifyAndSalvageOutput {
  /** Phase-2 evaluate_pool instruction. */
  certifyIx: TransactionInstruction;
  /** salvage_pool instruction. */
  salvageIx: TransactionInstruction;
}

/**
 * Build the (certify, salvage) instruction pair. Caller assembles them into
 * a single transaction with appropriate priority fee + compute budget.
 *
 * TODO(sdk m1+m5): wire up the actual instruction builders.
 */
export async function buildCertifyAndSalvage(
  _input: CertifyAndSalvageInput,
): Promise<CertifyAndSalvageOutput> {
  throw new Error("not yet implemented — sdk m1+m5");
}
