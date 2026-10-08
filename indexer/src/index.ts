// SPDX-License-Identifier: Apache-2.0
//
// GraveScanner v2 — off-chain indexer (Phase 9).
//
// The on-chain GraveScanner program is the authority on eligibility for any
// specific pool. The off-chain indexer's job is the wide funnel: enumerate
// every Raydium V4 pool, compute a cheap pre-filter for the six derelict
// criteria, score the survivors, queue them by priority, and submit the
// top N to the on-chain GraveScanner Phase 1. The on-chain scanner remains
// the narrow authority — it is the only way to mint an EligibilityCert that
// GraveVault accepts.
//
// Pipeline (per scan cycle):
//
//   1. Raydium pool discovery     — `sources/raydiumV4.ts` (getProgramAccounts)
//   2. Last activity indexing     — `activity.ts` (deriveLastSwapV4, cached)
//   3. Reserve/TVL filtering      — `reserves.ts` (readVaultReserve + WSOL guard)
//   4. Token metadata             — `metadata.ts` (unpackMint for 3 mints)
//   5. Pre-filter (6 criteria)    — `eligibility.ts` (preFilterPool)
//   6. Candidate scoring          — `scoring.ts` (scoreCandidate)
//   7. Queue                      — `queue.ts` (CandidateQueue, priority by score)
//   8. Scanner submission         — `submit.ts` (phase1 tx with C1 attestation)
//   9. Scanner result tracking    — `tracking.ts` (monitor Anchor/Cert PDAs)
//
// The loop re-scans on a configurable interval (default 5 minutes). Each
// cycle drains the top `maxCandidatesPerCycle` from the queue, submits
// them, and tracks the results. Pools that fail submission are re-queued
// (up to a retry limit); pools that succeed are tracked until the cert
// expires.

export * from "./scanner.js";
export { preFilterPool, CRITERION_INACTIVITY, CRITERION_PRICE_COLLAPSE, CRITERION_MIN_TVL, CRITERION_LP_NOT_BURNED, CRITERION_NO_LOCK, CRITERION_EPOCH_CONFIRMED, ALL_CRITERIA_MASK } from "./eligibility.js";
export type { PreFilterThresholds } from "./eligibility.js";
export * from "./types.js";
export * from "./config.js";
export * from "./sources/raydiumV4.js";
export * from "./activity.js";
export * from "./reserves.js";
export * from "./metadata.js";
export * from "./scoring.js";
export * from "./queue.js";
export * from "./submit.js";
export * from "./tracking.js";

import { Connection } from "@solana/web3.js";
import { loadConfig, type IndexerConfig } from "./config.js";
import { RaydiumV4Source } from "./sources/raydiumV4.js";
import { ActivityIndexer } from "./activity.js";
import { readReserves } from "./reserves.js";
import { readTokenMetadata } from "./metadata.js";
import { preFilterPool, type PreFilterThresholds } from "./eligibility.js";
import { scoreCandidate } from "./scoring.js";
import { CandidateQueue } from "./queue.js";
import { submitCandidate } from "./submit.js";
import { trackSubmission } from "./tracking.js";
import type { Candidate, DiscoveredPool, ScoredCandidate, SubmissionResult } from "./types.js";
import type { ScannerOptions } from "./scanner.js";

/**
 * GraveScannerV2 — the main indexer loop.
 *
 * Construction takes the `ScannerOptions` (connection, sources, thresholds).
 * Call `start()` to run the loop forever (or `runOnce()` for a single cycle).
 */
export class GraveScannerV2 {
  private readonly opts: ScannerOptions;
  private readonly activityIndexer: ActivityIndexer;
  private readonly queue: CandidateQueue;
  private running = false;

  constructor(opts: ScannerOptions) {
    this.opts = opts;
    this.activityIndexer = new ActivityIndexer();
    this.queue = new CandidateQueue();
  }

  /**
   * Run a single scan cycle. Discovers pools, indexes activity, reads
   * reserves + metadata, pre-filters, scores, queues, and submits the
   * top N candidates. Returns the submission results.
   */
  async runOnce(): Promise<SubmissionResult[]> {
    const thresholds: PreFilterThresholds = this.opts.thresholds ?? {
      inactivitySeconds: 7_776_000n,
      priceCollapseBps: 9_900,
      minTvlLamports: 500_000_000n,
      lpBurnDustThreshold: 1_000n,
    };

    const results: SubmissionResult[] = [];

    for (const source of this.opts.sources) {
      let discoveredCount = 0;
      let candidateCount = 0;

      for await (const pool of source.enumeratePools(this.opts.connection)) {
        discoveredCount++;

        // 2. Index activity (cached).
        const activity = await this.activityIndexer.indexActivity(
          this.opts.connection,
          pool,
          { scanLimit: this.opts.signatureScanLimit ?? 1000 },
        );

        // 3. Read reserves + TVL.
        const reserves = await readReserves(this.opts.connection, pool);
        if (!reserves) continue; // account missing or no WSOL side

        // 4. Read token metadata.
        const metadata = await readTokenMetadata(this.opts.connection, pool);
        if (!metadata) continue; // mint missing or uninitialized

        // 5. Pre-filter (6 criteria).
        const preFilter = preFilterPool(activity, reserves, metadata, thresholds);
        if (!preFilter.passed) continue;

        // 6. Score the candidate.
        const candidate: Candidate = {
          poolAddress: pool.poolAddress,
          ammProgramId: source.programId,
          discovery: pool,
          activity,
          reserves,
          metadata,
          preFilter,
        };
        const scored = scoreCandidate(candidate, {
          inactivitySeconds: thresholds.inactivitySeconds,
          minTvlLamports: thresholds.minTvlLamports,
          priceCollapseBps: thresholds.priceCollapseBps,
        });

        // 7. Enqueue.
        this.queue.enqueue(scored);
        candidateCount++;
      }

      // eslint-disable-next-line no-console
      console.log(
        `[${source.name}] discovered ${discoveredCount} pools, ${candidateCount} passed pre-filter, queue size ${this.queue.size()}`,
      );
    }

    // 8. Drain the top N candidates and submit.
    const maxSubmit = this.opts.maxCandidatesPerCycle ?? 5;
    const top = this.queue.drain(maxSubmit);
    for (const scored of top) {
      const submitOpts: { writer?: import("@solana/web3.js").Keypair; oracleKeypair?: import("@solana/web3.js").Keypair } = {};
      if (this.opts.writerKeypair) submitOpts.writer = this.opts.writerKeypair;
      if (this.opts.oracleKeypair) submitOpts.oracleKeypair = this.opts.oracleKeypair;
      const result = await submitCandidate(
        this.opts.connection,
        {
          rpcUrl: this.opts.connection.rpcEndpoint,
          cluster: "devnet",
          scannerProgramId: this.opts.scannerProgramId,
          vaultProgramId: this.opts.vaultProgramId,
          activityOracleSecretKey: this.opts.oracleKeypair?.secretKey ?? null,
          activityOraclePublicKey: this.opts.oracleKeypair?.publicKey ?? PublicKey_default(),
          minTvlLamports: thresholds.minTvlLamports,
          inactivitySeconds: thresholds.inactivitySeconds,
          priceCollapseBps: thresholds.priceCollapseBps,
          lpBurnDustThreshold: thresholds.lpBurnDustThreshold,
          maxCandidatesPerCycle: maxSubmit,
          pollIntervalMs: this.opts.intervalMs ?? 300_000,
          maxPoolsPerScan: this.opts.maxPoolsPerScan ?? 1000,
          signatureScanLimit: this.opts.signatureScanLimit ?? 1000,
        },
        scored.candidate,
        submitOpts,
      );
      results.push(result);

      // eslint-disable-next-line no-console
      console.log(
        `[submit] ${scored.candidate.poolAddress.toBase58()} score=${scored.score.toFixed(2)} status=${result.status}${result.signature ? ` sig=${result.signature.slice(0, 16)}...` : ""}${result.error ? ` err=${result.error}` : ""}`,
      );

      // 9. Track the submission.
      if (result.status === "confirmed" || result.status === "submitted") {
        const tracking = await trackSubmission(
          this.opts.connection,
          this.opts.scannerProgramId,
          scored.candidate.poolAddress,
        );
        // eslint-disable-next-line no-console
        console.log(
          `[track] ${scored.candidate.poolAddress.toBase58()} status=${tracking.status}` +
          `${tracking.anchorFirstEligibleEpoch ? ` epoch=${tracking.anchorFirstEligibleEpoch}` : ""}` +
          `${tracking.certExpiresAt ? ` cert_expires=${tracking.certExpiresAt}` : ""}`,
        );
      }
    }

    return results;
  }

  /**
   * Start the scan loop. Re-scans every `intervalMs` milliseconds until
   * `stop()` is called.
   */
  async start(): Promise<void> {
    this.running = true;
    const intervalMs = this.opts.intervalMs ?? 300_000;
    // eslint-disable-next-line no-console
    console.log(`graveyield-indexer: starting scan loop (interval ${intervalMs}ms)`);

    while (this.running) {
      try {
        await this.runOnce();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("scan cycle failed:", err);
      }
      await sleep(intervalMs);
    }
  }

  /** Stop the scan loop (after the current cycle completes). */
  stop(): void {
    this.running = false;
  }

  /** Current queue size (for observability). */
  queueSize(): number {
    return this.queue.size();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default PublicKey placeholder (for discovery-only mode without an oracle key). */
function PublicKey_default(): import("@solana/web3.js").PublicKey {
  const { PublicKey } = require("@solana/web3.js");
  return new PublicKey("11111111111111111111111111111111");
}

/**
 * Build a GraveScannerV2 from the environment-driven `IndexerConfig`.
 * This is the convenience constructor for the CLI entry point.
 */
export function buildScanner(config: IndexerConfig): GraveScannerV2 {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const source = new RaydiumV4Source({ maxPools: config.maxPoolsPerScan });
  return new GraveScannerV2({
    connection,
    sources: [source],
    intervalMs: config.pollIntervalMs,
    maxCandidatesPerCycle: config.maxCandidatesPerCycle,
    maxPoolsPerScan: config.maxPoolsPerScan,
    signatureScanLimit: config.signatureScanLimit,
    scannerProgramId: config.scannerProgramId,
    vaultProgramId: config.vaultProgramId,
    thresholds: {
      inactivitySeconds: config.inactivitySeconds,
      priceCollapseBps: config.priceCollapseBps,
      minTvlLamports: config.minTvlLamports,
      lpBurnDustThreshold: config.lpBurnDustThreshold,
    },
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  // eslint-disable-next-line no-console
  console.log(
    `graveyield-indexer: cluster=${config.cluster} rpc=${config.rpcUrl} scanner=${config.scannerProgramId.toBase58()}`,
  );
  if (!config.activityOracleSecretKey) {
    // eslint-disable-next-line no-console
    console.log("  running in discovery-only mode (no ACTIVITY_ORACLE_KEY set)");
  }

  const scanner = buildScanner(config);
  await scanner.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
