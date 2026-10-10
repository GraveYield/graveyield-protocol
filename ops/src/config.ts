// SPDX-License-Identifier: Apache-2.0
//
// Ops configuration — env-driven with safe defaults (same convention as
// the Phase 9 indexer). Everything defaults to a read-only, dry-run,
// local-state posture: no webhook, discovery-only indexer, no keys.

import { PublicKey } from "@solana/web3.js";

/** Devnet GraveScanner program ID (docs/DEVNET.md). */
export const DEVNET_SCANNER_PROGRAM_ID = new PublicKey(
  "5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF",
);

/** Devnet GraveVault program ID (docs/DEVNET.md). */
export const DEVNET_VAULT_PROGRAM_ID = new PublicKey(
  "HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6",
);

/** Ops configuration. */
export interface OpsConfig {
  /** Solana RPC endpoint. */
  rpcUrl: string;
  /** Cluster label (informational; goes into reports). */
  cluster: "devnet" | "mainnet-beta" | "localnet";
  /** GraveScanner program ID. */
  scannerProgramId: PublicKey;
  /** GraveVault program ID. */
  vaultProgramId: PublicKey;
  /** Long-running state dir (JSONL trails, artifacts, health snapshots). */
  stateDir: string;
  /** Indexer cycle interval in ms. */
  indexerPollMs: number;
  /** Vault-observer cycle interval in ms. */
  observerPollMs: number;
  /** Merkle-service cycle interval in ms (0 disables the schedule). */
  merkleIntervalMs: number;
  /** Signatures inspected per failed-tx sweep. */
  failedTxSweepLimit: number;
  /** Alert dedup window in ms (same code suppressed inside the window). */
  alertDedupMs: number;
  /** Webhook endpoint for critical alerts (empty = disabled). */
  alertWebhookUrl: string;
  /** How many pools the merkle service snapshots per cycle (0 = none scheduled). */
  merkleMaxPoolsPerCycle: number;
}

/** Read the ops configuration from the environment. */
export function loadOpsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
  const cluster = env.CLUSTER === "mainnet-beta"
    ? "mainnet-beta"
    : env.CLUSTER === "localnet"
      ? "localnet"
      : "devnet";
  return {
    rpcUrl: env.RPC_URL ?? "https://api.devnet.solana.com",
    cluster,
    scannerProgramId: env.SCANNER_PROGRAM_ID
      ? new PublicKey(env.SCANNER_PROGRAM_ID)
      : DEVNET_SCANNER_PROGRAM_ID,
    vaultProgramId: env.VAULT_PROGRAM_ID
      ? new PublicKey(env.VAULT_PROGRAM_ID)
      : DEVNET_VAULT_PROGRAM_ID,
    stateDir: env.OPS_STATE_DIR ?? "ops-state",
    indexerPollMs: positiveInt(env.INDEXER_POLL_MS, 5 * 60 * 1000),
    observerPollMs: positiveInt(env.OBSERVER_POLL_MS, 60 * 1000),
    merkleIntervalMs: nonNegativeInt(env.MERKLE_INTERVAL_MS, 0),
    failedTxSweepLimit: positiveInt(env.FAILED_TX_SWEEP_LIMIT, 50),
    alertDedupMs: positiveInt(env.ALERT_DEDUP_MS, 30 * 60 * 1000),
    alertWebhookUrl: env.ALERT_WEBHOOK_URL ?? "",
    merkleMaxPoolsPerCycle: nonNegativeInt(env.MERKLE_MAX_POOLS_PER_CYCLE, 0),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}
