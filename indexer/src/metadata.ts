// SPDX-License-Identifier: Apache-2.0
//
// Token metadata — the fourth stage of the Phase 9 indexer pipeline.
// Reads mint account data (supply, decimals) for the pool's three
// mints: base (memecoin), quote (WSOL or stable), and LP. The metadata
// feeds the candidate scoring (price collapse estimation needs
// decimals for the Q64.64 price math) and the observability layer
// (operators want to see "this pool has 1M LP tokens, 9 decimals").
//
// The SDK's `unpackMint` from `@solana/spl-token` does the parsing;
// this module wraps it with the pool-context plumbing and a
// batch-fetch pattern (three `getAccountInfo` calls per pool — one
// per mint).

import { Connection, PublicKey } from "@solana/web3.js";
import { unpackMint } from "@solana/spl-token";
import type { DiscoveredPool, TokenMetadata } from "./types.js";

/**
 * Read token metadata (supply, decimals) for a pool's three mints.
 * Returns null if any mint account is missing or uninitialized.
 */
export async function readTokenMetadata(
  connection: Connection,
  pool: DiscoveredPool,
): Promise<TokenMetadata | null> {
  try {
    const [baseInfo, quoteInfo, lpInfo] = await Promise.all([
      connection.getAccountInfo(pool.pool.baseMint),
      connection.getAccountInfo(pool.pool.quoteMint),
      connection.getAccountInfo(pool.pool.lpMint),
    ]);

    if (!baseInfo || !quoteInfo || !lpInfo) return null;

    const baseMint = unpackMint(pool.pool.baseMint, baseInfo);
    const quoteMint = unpackMint(pool.pool.quoteMint, quoteInfo);
    const lpMint = unpackMint(pool.pool.lpMint, lpInfo);

    if (!baseMint.isInitialized || !quoteMint.isInitialized || !lpMint.isInitialized) {
      return null;
    }

    return {
      poolAddress: pool.poolAddress,
      baseMint: pool.pool.baseMint,
      baseDecimals: baseMint.decimals,
      baseSupply: baseMint.supply,
      quoteMint: pool.pool.quoteMint,
      quoteDecimals: quoteMint.decimals,
      quoteSupply: quoteMint.supply,
      lpMint: pool.pool.lpMint,
      lpDecimals: lpMint.decimals,
      lpSupply: lpMint.supply,
    };
  } catch {
    return null;
  }
}
