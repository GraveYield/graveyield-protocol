// SPDX-License-Identifier: Apache-2.0
//
// Indexer service — wraps the Phase 9 GraveScannerV2 loop into the ops
// framework: health heartbeats, cycle counters, failure alerts.
//
// Without an activity oracle key the underlying indexer is
// discovery-only by design (it logs candidates without submitting);
// the service surfaces that mode in its heartbeat detail so an operator
// can tell "running dry" from "running and submitting" at a glance.

import type { GraveScannerV2, SubmissionResult } from "@graveyield/indexer";

import type { AlertManager } from "./alerts.js";
import type { HealthRegistry } from "./health.js";

/** Service options. */
export interface IndexerServiceOptions {
  scanner: GraveScannerV2;
  health: HealthRegistry;
  alerts: AlertManager;
  /** Whether the wrapped scanner is configured to submit on chain. */
  submissionMode: boolean;
  /** Cycle interval in ms (drives the freshness window). */
  pollIntervalMs?: number;
}

/** The indexer service. */
export class IndexerService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: IndexerServiceOptions) {
    const poll = opts.pollIntervalMs ?? 5 * 60 * 1000;
    this.opts.health.register("indexer", 3 * poll);
  }

  /** Run one scan cycle with full observability. */
  async runOnce(): Promise<SubmissionResult[]> {
    const { health, alerts } = this.opts;
    health.counter("indexer.cycles");
    try {
      const results = await this.opts.scanner.runOnce();
      const submitted = results.filter((r) => r.status === "submitted" || r.status === "confirmed").length;
      const failed = results.filter((r) => r.status === "failed").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      health.counter("indexer.submitted", submitted);
      health.counter("indexer.failed", failed);
      health.counter("indexer.skipped", skipped);
      health.heartbeat(
        "indexer",
        failed > 0 ? "degraded" : "ok",
        `results=${results.length} submitted=${submitted} failed=${failed} skipped=${skipped} ` +
          `mode=${this.opts.submissionMode ? "submission" : "discovery-only"}`,
      );
      if (failed > 0) {
        alerts.raise("indexer-submission-failed", "warn",
          "One or more indexer submissions failed",
          { failed, mode: this.opts.submissionMode ? "submission" : "discovery-only" });
      }
      return results;
    } catch (error) {
      health.counter("indexer.cycle-errors");
      const message = error instanceof Error ? error.message : String(error);
      health.heartbeat("indexer", "down", `cycle failed: ${message}`);
      alerts.raise("indexer-cycle-failed", "critical",
        "Indexer scan cycle threw — the funnel is stalled",
        { error: message });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Cycle forever on `intervalMs`. Returns the stop function. */
  start(intervalMs: number): () => void {
    if (this.timer) return () => this.stop();
    const tick = (): void => {
      this.runOnce().catch(() => {
        // runOnce already heartbeated + alerted; the loop must survive.
      });
    };
    this.timer = setInterval(tick, intervalMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
