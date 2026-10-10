// SPDX-License-Identifier: Apache-2.0
//
// Service health registry — the Phase 11 observability backbone.
//
// Every long-running ops service registers a component here and reports
// a heartbeat after each cycle. The registry renders a JSON snapshot
// suitable for a process supervisor (systemd `ExecStartPost`, a
// `watchjq` loop, an uptime probe, or plain `graveyield-ops health`).
//
// Design rules:
//   * zero external dependencies (Node stdlib only);
//   * statuses are derived, never asserted: a component that has not
//     heartbeated within its freshness window is reported `stale`
//     even if its last cycle succeeded;
//   * counters are monotonic integers (cycles, submissions, failures…);
//   * the snapshot is deterministic for identical state — the same
//     registry contents always render to the same JSON.

/** Component health status, as reported by the service itself. */
export type ComponentStatus = "ok" | "degraded" | "down";

/** What the health snapshot reports for a component AFTER freshness math. */
export type ReportedStatus = ComponentStatus | "stale" | "never-reported";

/** One monitored service component. */
export interface HealthComponent {
  /** Component name, e.g. "indexer", "vault-observer", "merkle". */
  name: string;
  /** Last self-reported status. */
  status: ComponentStatus;
  /** Human-readable detail from the last heartbeat (e.g. cycle outcome). */
  detail: string;
  /** Epoch ms of the last heartbeat. */
  lastHeartbeatAtMs: number | null;
  /** A component is `stale` when now − lastHeartbeat exceeds this window. */
  freshnessWindowMs: number;
}

/** One line of the health snapshot's rendered output. */
export interface HealthComponentReport {
  name: string;
  /** `ok` | `degraded` | `down` | `stale` | `never-reported` — freshness applied. */
  status: ReportedStatus;
  detail: string;
  lastHeartbeatAtMs: number | null;
  ageMs: number | null;
}

/** Machine-readable health snapshot. */
export interface HealthSnapshot {
  service: string;
  startedAtMs: number;
  /** Epoch ms at which the snapshot was taken. */
  takenAtMs: number;
  uptimeMs: number;
  components: HealthComponentReport[];
  /** Monotonic counters, sorted by name for deterministic output. */
  counters: Record<string, number>;
  /** Overall status: `ok` only when every component is ok. */
  status: "ok" | "degraded" | "down";
}

/**
 * The health registry. One instance per service process.
 *
 * `nowMs` is injectable so tests can drive staleness deterministically.
 */
export class HealthRegistry {
  private readonly components = new Map<string, HealthComponent>();
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly service: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAtMs = now();
  }

  /** Process start time (set at construction). */
  public readonly startedAtMs: number;

  /**
   * Register a component. Re-registering an existing name preserves its
   * heartbeat history (registration is idempotent) but updates the
   * freshness window.
   */
  register(name: string, freshnessWindowMs: number): void {
    const existing = this.components.get(name);
    if (existing) {
      existing.freshnessWindowMs = freshnessWindowMs;
      return;
    }
    this.components.set(name, {
      name,
      status: "ok",
      detail: "registered",
      lastHeartbeatAtMs: null,
      freshnessWindowMs,
    });
  }

  /**
   * Record a heartbeat. `status` is the component's own assessment of its
   * last cycle: `ok` (work completed), `degraded` (partial failure —
   * retries/absent data), or `down` (the cycle could not run).
   */
  heartbeat(name: string, status: ComponentStatus, detail: string): void {
    const component = this.components.get(name);
    if (!component) {
      throw new Error(`HealthRegistry: heartbeat for unregistered component "${name}"`);
    }
    component.status = status;
    component.detail = detail;
    component.lastHeartbeatAtMs = this.now();
  }

  /** Increment a monotonic counter (default delta 1). */
  counter(name: string, delta = 1): void {
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + delta);
  }

  /** Read a counter (0 if absent). */
  counterValue(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /** Render the JSON-serializable snapshot (deterministic ordering). */
  snapshot(): HealthSnapshot {
    const nowMs = this.now();
    const reports: HealthComponentReport[] = [];
    for (const component of [...this.components.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const ageMs =
        component.lastHeartbeatAtMs === null ? null : nowMs - component.lastHeartbeatAtMs;
      reports.push({
        name: component.name,
        status: deriveReportedStatus(component, nowMs),
        detail: component.detail,
        lastHeartbeatAtMs: component.lastHeartbeatAtMs,
        ageMs,
      });
    }
    const counters: Record<string, number> = {};
    for (const key of [...this.counters.keys()].sort()) {
      const value = this.counters.get(key);
      if (value !== undefined) counters[key] = value;
    }
    return {
      service: this.service,
      startedAtMs: this.startedAtMs,
      takenAtMs: nowMs,
      uptimeMs: nowMs - this.startedAtMs,
      components: reports,
      counters,
      status: overallStatus(reports),
    };
  }

  /** Render the snapshot as formatted JSON (2-space, stable key order). */
  render(): string {
    return JSON.stringify(this.snapshot(), null, 2);
  }

  /** One-line console summary, e.g. `graveyield-ops: ok (indexer ok, merkle ok)`. */
  summary(): string {
    const snap = this.snapshot();
    const parts = snap.components.map((c) => `${c.name} ${c.status}`);
    return `${snap.service}: ${snap.status}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  }
}

/** Apply the freshness window to a component's self-reported status. */
function deriveReportedStatus(
  component: HealthComponent,
  nowMs: number,
): ReportedStatus {
  if (component.lastHeartbeatAtMs === null) return "never-reported";
  const age = nowMs - component.lastHeartbeatAtMs;
  if (age > component.freshnessWindowMs) return "stale";
  return component.status;
}

/** Overall status: worst reported status wins (`down` > degraded/stale/unproven > ok). */
function overallStatus(reports: HealthComponentReport[]): HealthSnapshot["status"] {
  let status: HealthSnapshot["status"] = "ok";
  for (const report of reports) {
    if (report.status === "down") return "down";
    if (
      report.status === "degraded" ||
      report.status === "stale" ||
      report.status === "never-reported"
    ) {
      status = "degraded";
    }
  }
  return status;
}
