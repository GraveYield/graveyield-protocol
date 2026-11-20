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
//
// M1 SOURCING GATE (D-01, GY-M1-ODR-001 §3): `enqueue` is the single
// choke point every candidate-ingestion path must pass — the scanner
// loop, any additional AmmSource, and direct programmatic injection.
// With M1 sourcing enforced (the default for the M1 milestone), a
// candidate whose discovery record does not satisfy the exact
// WSOL-on-pc_mint predicate is refused admission and can never enter
// the M1 candidate queue through an alternate path. Enforcement uses
// the SDK's canonical `evaluateM1Sourcing` guard — no second predicate
// implementation and no second WSOL definition here. Non-M1 operation
// can disable the gate explicitly via `m1SourcingEnforced: false`.

import { evaluateM1Sourcing, type M1SourcingRejectionReason } from "@graveyield/sdk";
import type { ScoredCandidate } from "./types.js";

/** Machine-checkable outcome of one `enqueue` call. */
export type M1QueueAdmission =
  | { admitted: true }
  | {
      admitted: false;
      /** Exact D-01 rejection reason (SDK `M1SourcingRejectionReason`). */
      reason: M1SourcingRejectionReason;
      /** Human-readable detail for logs and operator artifacts. */
      detail: string;
    };

/**
 * CandidateQueue — a priority queue of scored candidates.
 *
 * Deduplicates by pool address (highest score wins). Ordered by score
 * descending so the `drain(n)` method yields the top N candidates.
 *
 * With M1 sourcing enforced (default), `enqueue` independently verifies
 * the candidate's pool orientation (coin_mint non-WSOL, pc_mint WSOL,
 * exactly one WSOL side) and refuses admission on any failure — the
 * returned `M1QueueAdmission` records the exact rejection reason.
 */
export class CandidateQueue {
  private readonly entries = new Map<string, ScoredCandidate>();
  private readonly m1SourcingEnforced: boolean;

  constructor(opts?: { m1SourcingEnforced?: boolean }) {
    // Default TRUE: the M1 milestone (D-01, owner-approved) requires the
    // quote-side sourcing predicate on the M1 candidate queue. Non-M1
    // operation must disable it explicitly.
    this.m1SourcingEnforced = opts?.m1SourcingEnforced ?? true;
  }

  /** Whether the D-01 M1 sourcing gate is active on this queue. */
  get m1Enforced(): boolean {
    return this.m1SourcingEnforced;
  }

  /**
   * Add or update a scored candidate. If the pool is already queued, the
   * higher score wins. With M1 sourcing enforced, a candidate that fails
   * the exact WSOL quote-side predicate is refused (never stored) and the
   * outcome carries the machine-checkable rejection reason.
   */
  enqueue(scored: ScoredCandidate): M1QueueAdmission {
    if (this.m1SourcingEnforced) {
      // The candidate's discovery record carries the parsed Raydium V4
      // AmmInfo fields: baseMint IS coin_mint, quoteMint IS pc_mint.
      const verdict = evaluateM1Sourcing({
        coinMint: scored.candidate.discovery.pool.baseMint,
        pcMint: scored.candidate.discovery.pool.quoteMint,
      });
      if (!verdict.accepted) {
        return { admitted: false, reason: verdict.reason, detail: verdict.detail };
      }
    }
    const key = scored.candidate.poolAddress.toBase58();
    const existing = this.entries.get(key);
    if (!existing || scored.score > existing.score) {
      this.entries.set(key, scored);
    }
    return { admitted: true };
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
