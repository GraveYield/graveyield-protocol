// SPDX-License-Identifier: Apache-2.0
//
// Raydium V4 pool discovery — the first stage of the Phase 9 indexer
// pipeline. Enumerates every 752-byte AmmInfo account owned by the
// Raydium V4 AMM program via `getProgramAccounts` with a dataSize
// filter, parses the canonical fields, and yields `DiscoveredPool`
// records for downstream activity/reserve/metadata enrichment.
//
// v1 target: Raydium V4 only (roadmap Phase 9: "Don't support every
// DEX. Start with: Raydium V4 only."). Additional AMM sources land in
// Phase 15 (Raydium CLMM, Orca, PumpSwap, Meteora).

import { Connection, PublicKey } from "@solana/web3.js";
import { RAYDIUM_V4_PROGRAM_ID, parseV4AmmInfo, RAYDIUM_V4_AMM_INFO_SIZE } from "@graveyield/sdk";
import type { AmmSource } from "../scanner.js";
import type { DiscoveredPool } from "../types.js";

/**
 * RaydiumV4Source — enumerates Raydium V4 AMM pools via
 * `getProgramAccounts` with a dataSize filter (752 bytes).
 */
export class RaydiumV4Source implements AmmSource {
  readonly name = "raydium-v4";
  readonly programId = RAYDIUM_V4_PROGRAM_ID;

  constructor(private readonly opts?: { maxPools?: number }) {}

  async *enumeratePools(connection: Connection): AsyncIterable<DiscoveredPool> {
    const maxPools = this.opts?.maxPools ?? Infinity;
    let count = 0;

    // getProgramAccounts with a dataSize filter for the canonical 752-byte
    // AmmInfo layout. This is the cheapest RPC call for pool enumeration —
    // it returns every account owned by the V4 program that matches the
    // size, with the account data base64-encoded.
    const accounts = await connection.getProgramAccounts(RAYDIUM_V4_PROGRAM_ID, {
      encoding: "base64",
      filters: [{ dataSize: RAYDIUM_V4_AMM_INFO_SIZE }],
    });

    for (const account of accounts) {
      if (count >= maxPools) break;
      const data = Buffer.from(account.account.data);
      if (data.length !== RAYDIUM_V4_AMM_INFO_SIZE) continue;

      let poolAddress: PublicKey;
      try {
        poolAddress = new PublicKey(account.pubkey);
      } catch {
        continue;
      }

      let parsed;
      try {
        parsed = parseV4AmmInfo(poolAddress, new Uint8Array(data));
      } catch {
        // Not a canonical AmmInfo (shouldn't happen with the size filter,
        // but defensive — a corrupted account could fail the parser).
        continue;
      }

      yield {
        poolAddress,
        pool: {
          coinVault: parsed.coinVault,
          pcVault: parsed.pcVault,
          baseMint: parsed.baseMint,
          quoteMint: parsed.quoteMint,
          lpMint: parsed.lpMint,
        },
        fetchedAtSlot: 0, // getProgramAccounts doesn't return a slot; best-effort
      };
      count++;
    }
  }
}
