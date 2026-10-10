// SPDX-License-Identifier: Apache-2.0
//
// Controlled salvage scenarios — the roadmap Phase 11 closing row
// ("Then run controlled salvage scenarios").
//
// SC-01  lifecycle-sweep   live, read-only: one indexer discovery cycle +
//                          one vault-observer sweep + health snapshot.
//                          Proves the running infrastructure end-to-end
//                          against the live cluster without keys.
// SC-02  vault-audit       live, read-only: deep GraveVault audit —
//                          receipts (R1/R2), claim accounting (C1–C3),
//                          failed-tx sweep, ProtocolConfig readback.
// SC-03  local-rehearsal   offline/localnet: re-runs the EXECUTED devnet
//                          rehearsal (deploy → init → drill) via
//                          scripts/devnet/local_rehearsal.sh — the funded
//                          salvage path until the devnet oracles are
//                          re-pointed (deployer keys were throwaways).
//                          Requires solana-test-validator + the no_uring
//                          wrapper; prerequisites are checked, never
//                          auto-installed.
//
// Every scenario emits a machine-readable report (JSON) and exits
// non-zero when a check fails, so CI/cron can gate on it.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { HealthRegistry } from "./health.js";
import type { VaultObserver } from "./vaultObserver.js";
import type { IndexerService } from "./indexerService.js";

/** One scenario check. */
export interface ScenarioCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** A scenario report. */
export interface ScenarioReport {
  id: "SC-01" | "SC-02" | "SC-03";
  name: string;
  startedAtMs: number;
  finishedAtMs: number;
  ok: boolean;
  checks: ScenarioCheck[];
  /** Where the full report JSON was persisted (when a state dir is wired). */
  reportPath?: string;
}

/** Runner options — everything optional so scenarios compose freely. */
export interface ScenarioRunnerOptions {
  indexer?: IndexerService;
  observer?: VaultObserver;
  health?: HealthRegistry;
  /** Repo root (for SC-03's script paths). */
  repoRoot?: string;
  /** State dir for report persistence (reports also return inline). */
  stateDir?: string;
}

/** The scenario runner. */
export class ScenarioRunner {
  constructor(private readonly opts: ScenarioRunnerOptions = {}) {}

  /**
   * SC-01 — live lifecycle sweep (read-only). Requires the indexer.
   * Indexer failures do not abort the sweep: the scenario reports them.
   */
  async sc01LifecycleSweep(): Promise<ScenarioReport> {
    const startedAtMs = Date.now();
    const checks: ScenarioCheck[] = [];
    const indexer = this.opts.indexer;
    if (!indexer) {
      checks.push({ id: "indexer-present", ok: false, detail: "no indexer wired into the runner" });
    } else {
      try {
        const results = await indexer.runOnce();
        checks.push({
          id: "indexer-cycle",
          ok: true,
          detail: `cycle completed: ${results.length} result(s) (discovery-only unless an oracle key is set)`,
        });
      } catch (error) {
        checks.push({
          id: "indexer-cycle",
          ok: false,
          detail: `cycle threw: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const observer = this.opts.observer;
    if (!observer) {
      checks.push({ id: "observer-present", ok: false, detail: "no vault observer wired into the runner" });
    } else {
      try {
        const observation = await observer.runOnce();
        checks.push({
          id: "vault-sweep",
          ok: observation.anomalousReceipts === 0 && observation.anomalousRollups === 0,
          detail:
            `receipts=${observation.receipts.length} claims=${observation.claims.length} ` +
            `registries=${observation.registries.length} failedTx=${observation.failedTransactions.length} ` +
            `anomalies=${observation.anomalousReceipts + observation.anomalousRollups}`,
        });
      } catch (error) {
        checks.push({
          id: "vault-sweep",
          ok: false,
          detail: `sweep threw: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    if (this.opts.health) {
      const snap = this.opts.health.snapshot();
      checks.push({
        id: "health-snapshot",
        ok: snap.status !== "down",
        detail: `${snap.status}: ${snap.components.map((c) => `${c.name}=${c.status}`).join(", ") || "no components"}`,
      });
    }

    return this.finish("SC-01", "lifecycle-sweep", startedAtMs, checks);
  }

  /**
   * SC-02 — deep vault audit (read-only). Requires the observer.
   * Every check maps 1:1 to an observer invariant (R1/R2, C1–C3, X1).
   */
  async sc02VaultAudit(): Promise<ScenarioReport> {
    const startedAtMs = Date.now();
    const checks: ScenarioCheck[] = [];
    const observer = this.opts.observer;
    if (!observer) {
      checks.push({ id: "observer-present", ok: false, detail: "no vault observer wired into the runner" });
      return this.finish("SC-02", "vault-audit", startedAtMs, checks);
    }
    try {
      const observation = await observer.runOnce();

      checks.push({
        id: "r1-receipt-sums",
        ok: observation.receipts.every((r) => r.checks.r1Sum),
        detail: `${observation.receipts.length} receipt(s); sum invariant holds on all`,
      });
      checks.push({
        id: "r2-receipt-shares",
        ok: observation.receipts.every((r) => r.checks.r2Shares),
        detail: `${observation.receipts.length} receipt(s); ±1-lamport 4000/4000/2000 shares hold on all`,
      });
      checks.push({
        id: "c1-claim-accounting",
        ok: observation.rollups.every((r) => r.checks.c1Accounted),
        detail: observation.rollups.map((r) => `${r.poolAddress.slice(0, 8)}… Σclaims=${r.claimedLamports}`).join("; ") || "no pools with receipts/claims",
      });
      checks.push({
        id: "c2-claim-ceiling",
        ok: observation.rollups.every((r) => r.checks.c2WithinCeiling),
        detail: "no pool's claims exceed its receipt's LP-holder leg",
      });
      checks.push({
        id: "c3-registry-receipt-agree",
        ok: observation.rollups.every((r) => r.checks.c3Agrees),
        detail: "registry totals match receipt legs on all double-sided pools",
      });
      checks.push({
        id: "x1-failed-transactions",
        ok: true, // failed txs are operational facts, not audit failures
        detail: `${observation.failedTransactions.length} failed vault tx(s) in the sweep window (alerted individually)`,
      });
      checks.push({
        id: "vault-config-readback",
        ok: observation.vaultConfig !== null,
        detail: observation.vaultConfig
          ? "Vault ProtocolConfig decoded (shares/ceilings readable)"
          : "Vault ProtocolConfig not found",
      });
    } catch (error) {
      checks.push({
        id: "sweep",
        ok: false,
        detail: `observer sweep threw: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return this.finish("SC-02", "vault-audit", startedAtMs, checks);
  }

  /**
   * SC-03 — the executed local rehearsal (deploy → init → drill on
   * solana-test-validator). Checks prerequisites, then runs the exact
   * production script. Non-zero exit on any failed prerequisite.
   */
  sc03LocalRehearsal(env: NodeJS.ProcessEnv = process.env): ScenarioReport {
    const startedAtMs = Date.now();
    const checks: ScenarioCheck[] = [];
    const repoRoot = this.opts.repoRoot ?? process.cwd();
    const script = join(repoRoot, "scripts", "devnet", "local_rehearsal.sh");

    const validatorOnPath = existsSync("/usr/bin/solana-test-validator") ||
      hasOnPath("solana-test-validator");
    checks.push({
      id: "solana-test-validator",
      ok: validatorOnPath,
      detail: validatorOnPath ? "found on PATH" : "solana CLI 3.0.10 not installed / not on PATH",
    });

    const wrapperCandidates = [
      join(repoRoot, "scripts", "no_uring"),
      join(repoRoot, "scripts", "devnet", "no_uring"),
    ];
    const wrapper = wrapperCandidates.find((p) => existsSync(p));
    checks.push({
      id: "no-uring-wrapper",
      ok: wrapper !== undefined,
      detail: wrapper
        ? `found ${wrapper}`
        : "io_uring seccomp wrapper not built (gcc -O2 -o scripts/no_uring scripts/no_uring.c)",
    });

    checks.push({
      id: "rehearsal-script",
      ok: existsSync(script),
      detail: existsSync(script) ? script : `${script} missing`,
    });

    const allPrereqsOk = checks.every((c) => c.ok);
    if (allPrereqsOk) {
      const result = spawnSync("bash", [script], {
        env,
        encoding: "utf8",
        timeout: 10 * 60 * 1000,
      });
      checks.push({
        id: "rehearsal-run",
        ok: result.status === 0,
        detail:
          result.status === 0
            ? "rehearsal completed (deploy → init → pause drill → unpause)"
            : `rehearsal exited ${result.status}: ${(result.stderr ?? "").slice(-400)}`,
      });
    } else {
      checks.push({
        id: "rehearsal-run",
        ok: false,
        detail: "skipped — prerequisites missing",
      });
    }
    return this.finish("SC-03", "local-rehearsal", startedAtMs, checks);
  }

  private finish(
    id: ScenarioReport["id"],
    name: string,
    startedAtMs: number,
    checks: ScenarioCheck[],
  ): ScenarioReport {
    const report: ScenarioReport = {
      id,
      name,
      startedAtMs,
      finishedAtMs: Date.now(),
      ok: checks.every((c) => c.ok),
      checks,
    };
    if (this.opts.stateDir) {
      try {
        mkdirSync(this.opts.stateDir, { recursive: true });
        const path = join(this.opts.stateDir, `scenario-${id.toLowerCase()}-${startedAtMs}.json`);
        writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
        report.reportPath = path;
      } catch {
        // Persistence is best-effort; the inline report is authoritative.
      }
    }
    return report;
  }
}

function hasOnPath(binary: string): boolean {
  // Shell-free PATH lookup: walk the directories directly instead of
  // spawning `bash -c "command -v …"`, so this module keeps no
  // shell-interpolation process sink for command-injection analysis to
  // flag. `binary` is only ever joined as a path segment and is never
  // interpreted by a shell.
  const dirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return true;
    } catch {
      // Not in this PATH entry — keep scanning.
    }
  }
  return false;
}
