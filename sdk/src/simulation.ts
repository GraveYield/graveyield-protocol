// SPDX-License-Identifier: Apache-2.0
//
// Simulation helpers — thin wrappers over `Connection.simulateTransaction`
// that surface parseable results to SDK consumers. Used by every
// top-level SDK operation that bundles a transaction (Phase 8 contract:
// "simulation helpers" in the handoff §4 list).

import {
  type Connection,
  type Transaction,
  type SimulatedTransactionResponse,
  type Commitment,
} from "@solana/web3.js";
import { decodeGraveYieldError, type DecodedGraveYieldError } from "./errors.js";

/** Result of a simulation run through the SDK. */
export interface SdkSimulationResult {
  /** Raw transaction-level result from web3.js. */
  raw: SimulatedTransactionResponse;
  /** Decoded GraveYield custom error if the simulation reverted with one. */
  graveYieldError?: DecodedGraveYieldError | undefined;
  /** Convenience: true iff the simulation would commit. */
  ok: boolean;
  /** Logs of the simulated transaction (if any). */
  logs: string[] | null;
  /** Units consumed (if reported). */
  unitsConsumed?: number | undefined;
}

/**
 * Simulate a built transaction. The transaction MUST already carry a
 * valid blockhash — `simulateTransaction` will reject otherwise.
 *
 * web3.js 1.99's `simulateTransaction` has two overloads:
 *   (Transaction, Signer[]?, ...) — legacy form
 *   (VersionedTransaction, SimulateTransactionConfig?) — versioned form
 * We support the legacy `Transaction` overload; the optional signers
 * are passed positionally.
 */
export async function simulateTransaction(
  connection: Connection,
  tx: Transaction,
  opts?: { commitment?: Commitment; signers?: ReadonlyArray<{ publicKey: import("@solana/web3.js").PublicKey }> },
): Promise<SdkSimulationResult> {
  // web3.js 1.99's `simulateTransaction` has two relevant overloads for
  // a legacy `Transaction`:
  //   1) (tx, Signer[], includeAccounts?) — legacy 3-arg form
  //   2) (tx, SimulateTransactionConfig?) — config form (preferred)
  // We use the config form so we can pass `commitment` cleanly.
  const signers = (opts?.signers as unknown as Parameters<typeof Object.values>[0]) ?? [];
  void signers;
  const sim = await connection.simulateTransaction(tx, {
    replaceRecentBlockhash: false,
    sigVerify: false,
    commitment: opts?.commitment,
  } as never);
  const raw = sim.value;
  const logs = raw.logs ?? null;
  const err = raw.err;
  const graveYieldError = err ? decodeGraveYieldError(err) : undefined;
  return {
    raw,
    graveYieldError,
    ok: err === null || err === undefined,
    logs,
    unitsConsumed: (raw.unitsConsumed ?? undefined) as number | undefined,
  };
}

/**
 * Run a simulation against a connection and decode any GraveYield custom
 * error. Convenience for "would this tx revert with one of these codes?"
 * checks. Returns `null` if the simulation would succeed.
 */
export async function simulateAndDecode(
  connection: Connection,
  tx: Transaction,
  opts?: { commitment?: Commitment; signers?: ReadonlyArray<{ publicKey: import("@solana/web3.js").PublicKey }> },
): Promise<DecodedGraveYieldError | null> {
  const result = await simulateTransaction(connection, tx, opts);
  return result.graveYieldError ?? null;
}
