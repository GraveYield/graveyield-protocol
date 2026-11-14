// SPDX-License-Identifier: Apache-2.0
//
// Last activity indexing — the second stage of the Phase 9 indexer
// pipeline. For each discovered pool, derive the most recent swap
// timestamp from RPC transaction history by scanning the pool's
// signature list and confirming each transaction invoked the AMM
// program on this pool.
//
// This module wraps the SDK's `deriveLastSwapV4` (the same function the
// salvor bot uses for C1 attestation derivation) and relies on its
// Correction 001 §1 compatibility contract:
//
//   verified        → ActivityRecord with the swap fields + noSwapFound=false
//   no_swap_in_scan → ActivityRecord with noSwapFound=TRUE (definitive: the
//                     scan covered the pool's full available history and
//                     every candidate is provably not an economic swap)
//   incomplete      → deriveLastSwapV4 throws LastSwapEvidenceIncompleteError
//                     → ActivityRecord with unresolved=TRUE and
//                     noSwapFound=FALSE. This record can NEVER back a C1
//                     inactivity pass (eligibility.ts), and it is NOT
//                     cached so the next cycle re-scans when the evidence
//                     may be complete.
//
// The indexer caches results per pool address and only re-scans when the
// cache expires (default: 1 hour). A pool that has not swapped in 90+ days
// is unlikely to swap in the next hour, so the cache is safe.
//
// ORACLE-002 / ORACLE-003: the activity record produced here is the
// seed for the on-chain C1 attestation. The indexer's activity oracle
// key signs the 112-byte attestation message, and the SDK's
// `buildAttestationMessage` + `buildEd25519VerifyInstruction` produce
// the precompile instruction that the on-chain GraveScanner verifies.

import { Connection } from "@solana/web3.js";
import {
  deriveLastSwapV4,
  LastSwapEvidenceIncompleteError,
  RAYDIUM_V4_PROGRAM_ID,
} from "@graveyield/sdk";
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
   *
   * Correction 001 §1: `deriveLastSwapV4` returns a value only for a
   * verified swap, returns `null` ONLY for a definitive no_swap_in_scan
   * (complete scan, every candidate provably not an economic swap), and
   * THROWS `LastSwapEvidenceIncompleteError` for incomplete evidence.
   * Incomplete evidence becomes an explicit `unresolved` record — never
   * `noSwapFound: true`, never cached, so the next cycle re-scans.
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
    let record: ActivityRecord;
    try {
      const derivation = await deriveLastSwapV4(
        connection,
        RAYDIUM_V4_PROGRAM_ID,
        pool.poolAddress,
        {
          scanLimit,
        },
      );
      record = derivation
        ? {
            poolAddress: pool.poolAddress,
            lastSwapUnixTs: derivation.lastSwapUnixTs,
            lastSwapSlot: derivation.slot,
            lastSwapSignature: derivation.signature,
            noSwapFound: false,
            unresolved: false,
          }
        : {
            // Definitive: the scan covered the pool's full available
            // history and every candidate is provably not an economic
            // swap (deriveLastSwapV4 returns null only in this state).
            poolAddress: pool.poolAddress,
            lastSwapUnixTs: 0,
            lastSwapSlot: 0,
            lastSwapSignature: "",
            noSwapFound: true,
            unresolved: false,
          };
    } catch (err) {
      if (!(err instanceof LastSwapEvidenceIncompleteError)) {
        // RPC/network/decoding failures are NOT evidence states — keep the
        // existing propagation behavior so operators see them.
        throw err;
      }
      // D5 / Correction 001: incomplete evidence stays explicitly
      // unresolved. It must never become `noSwapFound: true`, and the C1
      // pre-filter refuses to pass inactivity from it.
      record = {
        poolAddress: pool.poolAddress,
        lastSwapUnixTs: 0,
        lastSwapSlot: 0,
        lastSwapSignature: "",
        noSwapFound: false,
        unresolved: true,
      };
    }

    // Only resolved evidence is cached. An unresolved record re-scans on
    // the next cycle (the evidence may be complete by then); caching it
    // would freeze the unresolved state for the whole TTL.
    if (!record.unresolved) {
      this.cache.set(key, { record, cachedAtMs: now });
    }
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
