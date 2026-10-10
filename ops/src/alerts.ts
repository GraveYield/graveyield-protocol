// SPDX-License-Identifier: Apache-2.0
//
// Alerting — the Phase 11 observability alarm path.
//
// Services raise alerts with a stable `code` (e.g. "receipt-sum-mismatch"),
// a severity, and structured context. The AlertManager:
//   * deduplicates repeated codes within a suppression window (an
//     every-minute observer must not page an operator every minute for
//     the same stuck receipt);
//   * fans every accepted (and suppressed-counted) alert out to sinks;
//   * never throws — a broken webhook must not take down the observer.
//
// Sinks are the transport: console (stderr — stdout stays structured),
// JSONL file (the persistent audit trail under the ops state dir), and
// an optional webhook (injectable fetch, disabled unless configured).

import { appendFileSync, mkdirSync } from "node:fs";

/** Alert severity, ordered. */
export type AlertSeverity = "info" | "warn" | "critical";

/** A structured operational alert. */
export interface Alert {
  /** Stable machine code, e.g. "receipt-sum-mismatch". */
  code: string;
  severity: AlertSeverity;
  /** Human-readable message. */
  message: string;
  /** Epoch ms when the alert was raised. */
  atMs: number;
  /** Structured context (pool, signature, expected vs actual…). */
  context: Record<string, string | number | boolean | null>;
  /** true when this raise was suppressed by the dedup window. */
  suppressed: boolean;
}

/** Alert transport. */
export interface AlertSink {
  /** Deliver one alert. Implementations must not throw. */
  deliver(alert: Alert): Promise<void> | void;
}

/** Console sink — writes to stderr so stdout remains structured output. */
export class ConsoleAlertSink implements AlertSink {
  constructor(
    private readonly write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  ) {}

  deliver(alert: Alert): void {
    const ctx = Object.keys(alert.context).length
      ? ` ${JSON.stringify(alert.context)}`
      : "";
    this.write(
      `[ALERT:${alert.severity}] ${alert.code}${alert.suppressed ? " (suppressed-repeat)" : ""} — ${alert.message}${ctx}`,
    );
  }
}

/** JSONL file sink — one JSON object per line, append-only. */
export class JsonlAlertSink implements AlertSink {
  private readonly lines: string[] = [];

  constructor(
    private readonly append: (line: string) => void = () => {},
  ) {}

  /** Wire a real file appender writing to `filePath` (created on demand). */
  static toFile(filePath: string): JsonlAlertSink {
    return new JsonlAlertSink((line) => {
      mkdirSync(filePath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
      appendFileSync(filePath, `${line}\n`);
    });
  }

  deliver(alert: Alert): void {
    const line = JSON.stringify(alert);
    this.lines.push(line);
    try {
      this.append(line);
    } catch {
      // A failing file sink must never break the caller.
    }
  }

  /** Test/inspection hook: lines delivered so far. */
  deliveredLines(): readonly string[] {
    return this.lines;
  }
}

/** Webhook sink — POSTs the alert as JSON. Never throws. */
export class WebhookAlertSink implements AlertSink {
  private lastError: string | null = null;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async deliver(alert: Alert): Promise<void> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "graveyield-alert", ...alert }),
      });
      if (!response.ok) {
        this.lastError = `webhook responded ${response.status}`;
      } else {
        this.lastError = null;
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Last delivery error (null when healthy or never used). */
  lastDeliveryError(): string | null {
    return this.lastError;
  }
}

/** Compose sinks; every sink receives every accepted raise. */
export function composeAlertSinks(...sinks: AlertSink[]): AlertSink {
  return {
    deliver(alert: Alert): void | Promise<void> {
      for (const sink of sinks) {
        try {
          const result = sink.deliver(alert);
          // Propose async completion but do not let one sink block others.
          if (result instanceof Promise) result.catch(() => {});
        } catch {
          // Isolate sink failures.
        }
      }
    },
  };
}

/**
 * The alert manager. `nowMs` and `sink` are injectable for tests.
 *
 * Dedup semantics: the same `code` raised again within `dedupWindowMs`
 * is delivered with `suppressed: true` (visible in the JSONL trail,
 * counted, but easy to filter at the paging layer).
 */
export class AlertManager {
  private readonly lastRaiseByCode = new Map<string, number>();
  private readonly countByCode = new Map<string, number>();

  constructor(
    private readonly sink: AlertSink,
    private readonly dedupWindowMs: number = 30 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Raise an alert. Returns the (possibly suppressed) alert that was
   * delivered to the sinks.
   */
  raise(
    code: string,
    severity: AlertSeverity,
    message: string,
    context: Record<string, string | number | boolean | null> = {},
  ): Alert {
    const nowMs = this.now();
    const last = this.lastRaiseByCode.get(code);
    const suppressed = last !== undefined && nowMs - last < this.dedupWindowMs;
    this.lastRaiseByCode.set(code, nowMs);
    this.countByCode.set(code, (this.countByCode.get(code) ?? 0) + 1);
    const alert: Alert = {
      code,
      severity,
      message,
      atMs: nowMs,
      context,
      suppressed,
    };
    try {
      const result = this.sink.deliver(alert);
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // A sink failure must never break the raising service.
    }
    return alert;
  }

  /** Times a code has been raised (accepted + suppressed) since start. */
  raiseCount(code: string): number {
    return this.countByCode.get(code) ?? 0;
  }
}
