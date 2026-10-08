// SPDX-License-Identifier: Apache-2.0
//
// Candidate queue — the seventh stage of the Phase 9 indexer pipeline.
// A priority queue that orders scored candidates by score descending
// and deduplicates by pool address. The indexer drains the top N
// candidates per scan cycle (N = `maxCandidatesPerCycle` from config)
// and submits them to the on-chain GraveScanner.
//
// The queue is in-memory for v1. A persistent backing store (Redis,
// SQLite) lands with the Phase 11 observability row. The in-memory
// queue is sufficient for the v1 discovery target (Raydium V4 only)
// because the candidate set is small enough to fit in memory and the
// indexer process is the only producer.

import type { ScoredCandidate } from "./types.js";

/**
 * CandidateQueue — a priority queue of scored candidates.
 *
 * Deduplicates by pool address (highest score wins). Ordered by score
 * descending so the `drain(n)` method yields the top N candidates.
 */
export class CandidateQueue {
  private readonly entries = new Map<string, ScoredCandidate>();

  /** Add or update a scored candidate. If the pool is already queued, the higher score wins. */
  enqueue(scored: ScoredCandidate): void {
    const key = scored.candidate.poolAddress.toBase58();
    const existing = this.entries.get(key);
    if (!existing || scored.score > existing.score) {
      this.entries.set(key, scored);
    }
  }

  /** Drain the top N candidates by score descending. Removes them from the queue. */
  drain(n: number): ScoredCandidate[] {
    const all = [...this.entries.values()];
    all.sort((a, b) => b.score - a.score);
    const out = all.slice(0, n);
    for (const s of out) {
      this.entries.delete(s.candidate.poolAddress.toBase58());
    }
    return out;
  }

  /** Peek at the top N candidates without removing them. */
  peek(n: number): ScoredCandidate[] {
    const all = [...this.entries.values()];
    all.sort((a, b) => b.score - a.score);
    return all.slice(0, n);
  }

  /** Remove a specific pool from the queue (e.g. after a failed submission). */
  remove(poolAddress: string): boolean {
    return this.entries.delete(poolAddress);
  }

  /** Current queue size. */
  size(): number {
    return this.entries.size;
  }

  /** Clear the queue (e.g. on a fresh scan cycle). */
  clear(): void {
    this.entries.clear();
  }

  /** Check if a pool is already in the queue. */
  has(poolAddress: string): boolean {
    return this.entries.has(poolAddress);
  }
}
