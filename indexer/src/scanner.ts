// SPDX-License-Identifier: Apache-2.0

import type { Connection, PublicKey } from "@solana/web3.js";
import type { DiscoveredPool } from "./types.js";

/**
 * AMM enumeration source. The indexer iterates supported AMM programs and
 * yields candidate pool addresses for downstream eligibility evaluation.
 *
 * v1: only `RaydiumV4Source` is implemented (roadmap Phase 9:
 * "Don't support every DEX. Start with: Raydium V4 only.").
 * Additional sources land in Phase 15 (Raydium CLMM, Orca, PumpSwap, Meteora).
 */
export interface AmmSource {
  /** Human-readable name for logs ("raydium-v4", "orca-whirlpool", "meteora-dlmm"). */
  name: string;
  /** AMM on-chain program ID. */
  programId: PublicKey;
  /** Yield candidate pool addresses with parsed AmmInfo fields. */
  enumeratePools(connection: Connection): AsyncIterable<DiscoveredPool>;
}

/**
 * Top-level scanner loop. Walks each registered AMM source, runs the
 * cheap pre-filter from `eligibility.ts`, scores survivors, queues them
 * by priority, and submits the top N to the on-chain GraveScanner
 * Phase 1. The loop re-scans on a configurable interval.
 *
 * The on-chain GraveScanner remains the narrow authority — it is the
 * only way to mint an EligibilityCert that GraveVault accepts.
 */
export interface ScannerOptions {
  connection: Connection;
  sources: AmmSource[];
  /** Polling interval in milliseconds. Default 300_000 (5 minutes). */
  intervalMs?: number;
  /** Max candidates to submit per scan cycle. Default 5. */
  maxCandidatesPerCycle?: number;
  /** Max pools to enumerate per scan. Default 1000. */
  maxPoolsPerScan?: number;
  /** Signature scan limit for deriveLastSwapV4. Default 1000. */
  signatureScanLimit?: number;
  /** Activity oracle keypair (for signing C1 attestations). Optional —
   *  if absent, the indexer runs in discovery-only mode. */
  oracleKeypair?: import("@solana/web3.js").Keypair;
  /** Writer keypair (for paying EligibilityAnchor PDA rent). Optional —
   *  if absent, submissions are skipped. */
  writerKeypair?: import("@solana/web3.js").Keypair;
  /** Pre-filter thresholds. Defaults to spec. */
  thresholds?: {
    inactivitySeconds: bigint;
    priceCollapseBps: number;
    minTvlLamports: bigint;
    lpBurnDustThreshold: bigint;
  };
  /** Scanner program ID (for submission + tracking). */
  scannerProgramId: PublicKey;
  /** Vault program ID (for ProtocolConfig decoding). */
  vaultProgramId: PublicKey;
}
