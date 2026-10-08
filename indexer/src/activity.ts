// SPDX-License-Identifier: Apache-2.0
//
// Last activity indexing — the second stage of the Phase 9 indexer
// pipeline. For each discovered pool, derive the most recent swap
// timestamp from RPC transaction history by scanning the pool's
// signature list and confirming each transaction invoked the AMM
// program on this pool.
//
// This module wraps the SDK's `deriveLastSwapV4` (the same function the
// salvor bot uses for C1 attestation derivation). The indexer caches
// results per pool address and only re-scans when the cache expires
// (default: 1 hour). A pool that has not swapped in 90+ days is
// unlikely to swap in the next hour, so the cache is safe.
//
// ORACLE-002 / ORACLE-003: the activity record produced here is the
// seed for the on-chain C1 attestation. The indexer's activity oracle
// key signs the 112-byte attestation message, and the SDK's
// `buildAttestationMessage` + `buildEd25519VerifyInstruction` produce
// the precompile instruction that the on-chain GraveScanner verifies.

import { Connection, PublicKey } from "@solana/web3.js";
import { deriveLastSwapV4, RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";
import type { ActivityRecord, DiscoveredPool } from "./types.js";

/** Cache entry for a pool's activity record. */
interface CacheEntry {
  record: ActivityRecord;
  /** When the cache entry was populated (unix ms). */
  cachedAtMs: number;
}

/**
 * ActivityIndexer — caches last-swap derivations per pool address.
 *
 * The cache TTL is configurable (default 1 hour). A pool that has not
 * swapped in 90+ days is unlikely to swap in the next hour, so a 1h
 * cache is safe. Pools that swap more frequently fail the C1
 * inactivity filter anyway, so re-scanning them sooner would not
 * change the candidate set.
 */
export class ActivityIndexer {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? 3_600_000; // 1 hour
  }

  /**
   * Index the last-swap activity for a discovered pool. Returns from
   * cache if fresh; otherwise scans signature history via
   * `deriveLastSwapV4`.
   */
  async indexActivity(
    connection: Connection,
    pool: DiscoveredPool,
    opts?: { scanLimit?: number },
  ): Promise<ActivityRecord> {
    const key = pool.poolAddress.toBase58();
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.cachedAtMs < this.ttlMs) {
      return cached.record;
    }

    const scanLimit = opts?.scanLimit ?? 1000;
    const derivation = await deriveLastSwapV4(
      connection,
      RAYDIUM_V4_PROGRAM_ID,
      pool.poolAddress,
      { scanLimit },
    );

    const record: ActivityRecord = derivation
      ? {
          poolAddress: pool.poolAddress,
          lastSwapUnixTs: derivation.lastSwapUnixTs,
          lastSwapSlot: derivation.slot,
          lastSwapSignature: derivation.signature,
          noSwapFound: false,
        }
      : {
          poolAddress: pool.poolAddress,
          lastSwapUnixTs: 0,
          lastSwapSlot: 0,
          lastSwapSignature: "",
          noSwapFound: true,
        };

    this.cache.set(key, { record, cachedAtMs: now });
    return record;
  }

  /** Clear the cache (e.g. on a fresh scan cycle). */
  clear(): void {
    this.cache.clear();
  }

  /** Current cache size (for observability). */
  size(): number {
    return this.cache.size;
  }
}
