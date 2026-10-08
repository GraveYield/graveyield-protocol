// SPDX-License-Identifier: Apache-2.0
//
// Reserve/TVL reading + filtering — the third stage of the Phase 9
// indexer pipeline. For each discovered pool, reads the SPL token
// balances of the coin_vault and pc_vault accounts, identifies the
// WSOL side, and computes the TVL in lamports. The result feeds the
// C3 (min TVL) and C4 (LP not burned) pre-filter criteria.
//
// The SDK's `readVaultReserve` and `readLpMintSupply` do the heavy
// lifting; this module wraps them with the pool-context plumbing and
// the WSOL-side identification (the `UnsupportedBaseToken` 7019 guard
// — exactly one of coin/pc must be WSOL for v1.0).

import { Connection } from "@solana/web3.js";
import {
  readVaultReserve,
  readLpMintSupply,
  identifyBaseToken,
  WSOL_MINT,
} from "@graveyield/sdk";
import type { DiscoveredPool, ReserveRecord } from "./types.js";

/**
 * Read vault reserves + LP supply for a discovered pool.
 *
 * Returns null if any account is missing or the pool has no WSOL side
 * (7019 guard — v1.0 only supports pools with exactly one WSOL side).
 */
export async function readReserves(
  connection: Connection,
  pool: DiscoveredPool,
): Promise<ReserveRecord | null> {
  try {
    const coinReserve = await readVaultReserve(connection, pool.pool.coinVault);
    const pcReserve = await readVaultReserve(connection, pool.pool.pcVault);
    const lpSupply = await readLpMintSupply(connection, pool.pool.lpMint);

    // Identify the WSOL side. v1.0 requires exactly one WSOL side;
    // pools with both or neither are rejected (7019).
    let wsolSideIdentified = true;
    let tvlLamports = 0n;
    try {
      const orientation = identifyBaseToken({
        poolAddress: pool.poolAddress,
        coinVault: pool.pool.coinVault,
        pcVault: pool.pool.pcVault,
        baseMint: pool.pool.baseMint,
        quoteMint: pool.pool.quoteMint,
        lpMint: pool.pool.lpMint,
      });
      // TVL = the WSOL-side reserve (in lamports, since WSOL has 9 decimals).
      tvlLamports = pool.pool.baseMint.equals(WSOL_MINT) ? coinReserve : pcReserve;
      void orientation; // used for the 7019 guard only
    } catch {
      // 7019: no WSOL side → skip this pool for v1.0.
      wsolSideIdentified = false;
      tvlLamports = 0n;
    }

    return {
      poolAddress: pool.poolAddress,
      coinReserve,
      pcReserve,
      lpSupply,
      wsolSideIdentified,
      tvlLamports,
    };
  } catch {
    // Account missing or RPC error — skip this pool.
    return null;
  }
}

/**
 * Filter reserves by TVL. Returns true if the pool's quote-side TVL
 * meets or exceeds the threshold (C3 min TVL criterion).
 */
export function meetsTvlThreshold(reserves: ReserveRecord, minTvlLamports: bigint): boolean {
  return reserves.wsolSideIdentified && reserves.tvlLamports >= minTvlLamports;
}

/**
 * Filter reserves by LP supply. Returns true if the LP supply is
 * above the dust threshold (C4 LP not burned criterion). Pools whose
// LP supply is <= threshold are treated as fully burned.
 */
export function meetsLpSupplyThreshold(reserves: ReserveRecord, dustThreshold: bigint): boolean {
  return reserves.lpSupply > dustThreshold;
}
