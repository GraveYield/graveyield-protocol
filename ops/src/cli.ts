// SPDX-License-Identifier: Apache-2.0
//
// graveyield-ops CLI — the Phase 11 service entrypoints.
//
//   graveyield-ops indexer          one indexer cycle (discovery-only
//                                   unless ACTIVITY_ORACLE_KEY is set)
//   graveyield-ops vault-observer   one GraveVault sweep
//   graveyield-ops merkle --pool P  one Merkle snapshot artifact
//   graveyield-ops scenario sc-01|sc-02|sc-03
//   graveyield-ops health           print the health snapshot
//   graveyield-ops all              run indexer + observer (+ merkle when
//                                   MERKLE_MAX_POOLS_PER_CYCLE > 0) forever
//
// Modes: every command is one-shot by default; `--loop` runs the
// scheduled service. `all` is always long-running. Exit codes: 0 ok,
// 1 check/command failure, 2 usage error.
//
// Argument syntax accepts both `--key=value` and `--key value`
// (the protocol_admin.mjs convention).

import { Connection, PublicKey } from "@solana/web3.js";

import { AlertManager, composeAlertSinks, ConsoleAlertSink, JsonlAlertSink, WebhookAlertSink, type AlertSink } from "./alerts.js";
import { loadOpsConfig, type OpsConfig } from "./config.js";
import { HealthRegistry } from "./health.js";
import { IndexerService } from "./indexerService.js";
import { DirectoryArtifactStore, MerkleService } from "./merkleService.js";
import { ScenarioRunner, type ScenarioReport } from "./scenarios.js";
import { connectionChainView } from "./views.js";
import { buildScanner, loadConfig } from "@graveyield/indexer";
import { VaultObserver } from "./vaultObserver.js";

/** Parse argv accepting both --key=value and --key value. */
export function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        args[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          args[token.slice(2)] = next;
          i++;
        } else {
          args[token.slice(2)] = true;
        }
      }
    }
  }
  return args;
}

/** Shared service wiring (health + alerts + chain view). */
export interface OpsWiring {
  config: OpsConfig;
  health: HealthRegistry;
  alerts: AlertManager;
  indexerService: IndexerService;
  observer: VaultObserver;
  merkle: MerkleService;
}

/** Wire the full ops stack (used by every command). */
export function wireOps(config: OpsConfig): OpsWiring {
  const health = new HealthRegistry("graveyield-ops");
  const sinks: AlertSink[] = [new ConsoleAlertSink(), JsonlAlertSink.toFile(`${config.stateDir}/alerts.jsonl`)];
  if (config.alertWebhookUrl) sinks.push(new WebhookAlertSink(config.alertWebhookUrl));
  const alerts = new AlertManager(composeAlertSinks(...sinks), config.alertDedupMs);

  const connection = new Connection(config.rpcUrl, "confirmed");
  const chain = connectionChainView(connection);

  // The scanner consumes the indexer's own env contract (RPC_URL, CLUSTER,
  // MAX_CANDIDATES_PER_CYCLE, …); ops-level env adds the state dir, alert
  // webhook and schedules on top.
  const scanner = buildScanner(loadConfig());
  const submissionMode = Boolean(process.env.ACTIVITY_ORACLE_KEY) && process.env.SCOUT_DRY_RUN !== "1";
  const indexerService = new IndexerService({
    scanner,
    health,
    alerts,
    submissionMode,
    pollIntervalMs: config.indexerPollMs,
  });

  const observer = new VaultObserver({
    vaultProgramId: config.vaultProgramId,
    chain,
    health,
    alerts,
    pollIntervalMs: config.observerPollMs,
    failedTxSweepLimit: config.failedTxSweepLimit,
  });

  const merkle = new MerkleService({
    health,
    alerts,
    store: new DirectoryArtifactStore(`${config.stateDir}/merkle`),
    pollIntervalMs: config.merkleIntervalMs || 300_000,
  });

  return { config, health, alerts, indexerService, observer, merkle };
}

/** CLI main. Exported for tests; `bin` wiring calls it with process.argv. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const positional = (argv ?? []).filter((a) => !a.startsWith("--"));
  const cmd = positional[0] ?? "";

  const config = loadOpsConfig();

  switch (cmd) {
    case "indexer": {
      const wiring = wireOps(config);
      if (args.loop === true) {
        return runForever(wiring, () => wiring.indexerService.start(config.indexerPollMs));
      }
      const results = await wiring.indexerService.runOnce();
      console.log(JSON.stringify({ indexer: results.map((r) => r.poolAddress.toBase58()) }, null, 2));
      return 0;
    }
    case "vault-observer": {
      const wiring = wireOps(config);
      if (args.loop === true) {
        return runForever(wiring, () => wiring.observer.start(config.observerPollMs));
      }
      const observation = await wiring.observer.runOnce();
      console.log(JSON.stringify(observationToJson(observation), null, 2));
      return observation.anomalousReceipts + observation.anomalousRollups === 0 ? 0 : 1;
    }
    case "merkle": {
      const poolRaw = args.pool;
      if (typeof poolRaw !== "string" || poolRaw.length === 0) {
        process.stderr.write("merkle requires --pool <base58 pool address>\n");
        return 2;
      }
      const wiring = wireOps(config);
      const connection = new Connection(config.rpcUrl, "confirmed");
      const artifact = await wiring.merkle.buildForPool(connection, new PublicKey(poolRaw));
      console.log(JSON.stringify(artifact, null, 2));
      return 0;
    }
    case "scenario": {
      const id = typeof args.id === "string" ? args.id : positional[1] ?? "";
      const wiring = wireOps(config);
      const runner = new ScenarioRunner({
        indexer: wiring.indexerService,
        observer: wiring.observer,
        health: wiring.health,
        stateDir: config.stateDir,
        repoRoot: repoRootOf(import.meta.url),
      });
      let report: ScenarioReport;
      if (id === "sc-01" || id === "SC-01") report = await runner.sc01LifecycleSweep();
      else if (id === "sc-02" || id === "SC-02") report = await runner.sc02VaultAudit();
      else if (id === "sc-03" || id === "SC-03") report = runner.sc03LocalRehearsal();
      else {
        process.stderr.write("scenario requires sc-01 | sc-02 | sc-03\n");
        return 2;
      }
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    case "health": {
      const wiring = wireOps(config);
      console.log(wiring.health.render());
      return 0;
    }
    case "all": {
      const wiring = wireOps(config);
      const stops = [
        wiring.indexerService.start(config.indexerPollMs),
        wiring.observer.start(config.observerPollMs),
      ];
      if (config.merkleIntervalMs > 0) {
        // The merkle schedule needs pools; wire SC-01's discovery output
        // into it. Until a pool set exists, the schedule is a no-op loop.
        stops.push(wiring.merkle.start([], new Connection(config.rpcUrl, "confirmed"), config.merkleIntervalMs));
      }
      installSignalHandlers(stops);
      process.stdout.write(`${wiring.health.summary()}\n`);
      setInterval(() => process.stdout.write(`${wiring.health.summary()}\n`), 60_000).unref();
      return new Promise(() => {}); // run until signaled
    }
    default:
      process.stderr.write(
        [
          "graveyield-ops — Phase 11 ops services",
          "",
          "usage: graveyield-ops <command> [options]",
          "",
          "commands:",
          "  indexer            one indexer cycle (or --loop)",
          "  vault-observer     one GraveVault sweep (or --loop)",
          "  merkle --pool P    one Merkle snapshot artifact",
          "  scenario sc-01     live lifecycle sweep (read-only)",
          "  scenario sc-02     deep vault audit (read-only)",
          "  scenario sc-03     local deploy+drill rehearsal",
          "  health             print the health snapshot",
          "  all                run everything forever",
          "",
        ].join("\n"),
      );
      return 2;
  }
}

/** Run a start function forever, handling SIGINT/SIGTERM into exit 0. */
function runForever(wiring: OpsWiring, start: () => () => void): number {
  const stop = start();
  installSignalHandlers([stop]);
  process.stdout.write(`${wiring.health.summary()}\n`);
  return new Promise(() => {}) as unknown as number;
}

function installSignalHandlers(stops: Array<() => void>): void {
  const shutdown = (): void => {
    for (const stop of stops) {
      try {
        stop();
      } catch {
        // shutdown must always complete
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** The observation shape is bigint-heavy; render a JSON-safe projection. */
function observationToJson(observation: Awaited<ReturnType<VaultObserver["runOnce"]>>): Record<string, unknown> {
  return {
    takenAtMs: observation.takenAtMs,
    slot: observation.slot,
    receipts: observation.receipts.map((r) => ({
      address: r.address,
      pool: r.receipt.poolAddress.toBase58(),
      totalProceedsLamports: r.receipt.totalProceedsLamports.toString(10),
      lpHolderAmountLamports: r.receipt.lpHolderAmountLamports.toString(10),
      salvorAmountLamports: r.receipt.salvorAmountLamports.toString(10),
      protocolAmountLamports: r.receipt.protocolAmountLamports.toString(10),
      checks: r.checks,
    })),
    claims: observation.claims.map((c) => ({
      address: c.address,
      pool: c.claim.poolAddress.toBase58(),
      holder: c.claim.lpHolder.toBase58(),
      amountLamports: c.claim.amountLamports.toString(10),
    })),
    registries: observation.registries.map((r) => ({
      address: r.address,
      pool: r.registry.poolAddress.toBase58(),
      claimedLamports: r.registry.lpHolderPoolClaimedLamports.toString(10),
    })),
    rollups: observation.rollups.map((r) => ({
      ...r,
      claimedLamports: r.claimedLamports.toString(10),
      registryClaimedLamports: r.registryClaimedLamports?.toString(10) ?? null,
      receiptLpHolderLamports: r.receiptLpHolderLamports?.toString(10) ?? null,
    })),
    failedTransactions: observation.failedTransactions,
    anomalousReceipts: observation.anomalousReceipts,
    anomalousRollups: observation.anomalousRollups,
  };
}

/** Repo root from this module's URL (ops/dist/cli.js → repo root). */
function repoRootOf(moduleUrl: string): string {
  const filePath = new URL("..", moduleUrl).pathname; // ops/
  return `${filePath}..`;
}
