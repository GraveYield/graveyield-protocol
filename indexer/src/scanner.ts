// SPDX-License-Identifier: Apache-2.0

import type { Connection, PublicKey } from "@solana/web3.js";

/**
 * AMM enumeration source. The indexer iterates supported AMM programs and
 * yields candidate pool addresses for downstream eligibility evaluation.
 */
export interface AmmSource {
  /** Human-readable name for logs ("raydium-v4", "orca-whirlpool", "meteora-dlmm"). */
  name: string;
  /** AMM on-chain program ID. */
  programId: PublicKey;
  /** Yield candidate pool addresses. Implementations may stream or paginate. */
  enumeratePools(connection: Connection): AsyncIterable<PublicKey>;
}

/**
 * Top-level scanner loop. Walks each registered AMM source, runs the cheap
 * pre-filter from `eligibility.ts`, and reports candidates over an event
 * channel of the embedder's choosing (queue, webhook, log).
 */
export interface ScannerOptions {
  connection: Connection;
  sources: AmmSource[];
  /** Polling interval in milliseconds. Default 60_000 (1 minute). */
  intervalMs?: number;
}

export class GraveScannerV2 {
  constructor(private readonly opts: ScannerOptions) {}

  async start(): Promise<void> {
    // TODO(indexer m9): main scan loop.
    throw new Error("not yet implemented — indexer m9");
  }
}
