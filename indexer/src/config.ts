// SPDX-License-Identifier: Apache-2.0
//
// Phase 9 indexer configuration.
//
// The indexer reads its configuration from environment variables with
// safe defaults. The critical parameters are:
//
//   * RPC_URL — the Solana RPC endpoint (devnet or mainnet-beta)
//   * SCANNER_PROGRAM_ID — the on-chain GraveScanner program ID
//   * ACTIVITY_ORACLE_KEY — the Ed25519 secret key for signing C1 attestations
//   * MIN_TVL_LAMPORTS — the local TVL floor (defaults to the spec default)
//   * MAX_CANDIDATES_PER_CYCLE — how many candidates to submit per scan
//   * POLL_INTERVAL_MS — how often to re-scan
//
// The activity oracle key is the same key registered in the on-chain
// `ProtocolConfig.activity_oracle`. The indexer holds it because it is
// the activity-indexing oracle (ORACLE-002 / ORACLE-003).

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/** Devnet GraveScanner program ID (handoff §3.2). */
export const DEVNET_SCANNER_PROGRAM_ID = new PublicKey(
  "5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF",
);

/** Devnet GraveVault program ID (handoff §3.2). */
export const DEVNET_VAULT_PROGRAM_ID = new PublicKey(
  "HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6",
);

/** Spec default: minimum TVL in lamports (0.5 SOL). */
export const DEFAULT_MIN_TVL_LAMPORTS = 500_000_000n;

/** Spec default: inactivity threshold in seconds (90 days). */
export const DEFAULT_INACTIVITY_SECONDS = 7_776_000n;

/** Spec default: price collapse in bps (99% = 9,900). */
export const DEFAULT_PRICE_COLLAPSE_BPS = 9_900;

/** Spec default: LP burn dust threshold (1,000 raw LP tokens). */
export const DEFAULT_LP_BURN_DUST_THRESHOLD = 1_000n;

/** Spec default: minimum epoch confirmation (2 consecutive epochs). */
export const DEFAULT_MIN_EPOCH_CONFIRMATION = 2n;

/** Indexer configuration — read from env with safe defaults. */
export interface IndexerConfig {
  /** Solana RPC endpoint. */
  rpcUrl: string;
  /** Cluster identifier. */
  cluster: "devnet" | "mainnet-beta";
  /** GraveScanner program ID. */
  scannerProgramId: PublicKey;
  /** GraveVault program ID (read-only — for ProtocolConfig decoding). */
  vaultProgramId: PublicKey;
  /** Activity oracle Ed25519 secret key (32 bytes). */
  activityOracleSecretKey: Uint8Array | null;
  /** Activity oracle public key (derived from the secret, or configured directly). */
  activityOraclePublicKey: PublicKey;
  /** Local TVL floor in lamports (defaults to spec). */
  minTvlLamports: bigint;
  /** Local inactivity threshold in seconds (defaults to spec). */
  inactivitySeconds: bigint;
  /** Local price collapse threshold in bps (defaults to spec). */
  priceCollapseBps: number;
  /** Local LP burn dust threshold (defaults to spec). */
  lpBurnDustThreshold: bigint;
  /** Max candidates to submit per scan cycle. */
  maxCandidatesPerCycle: number;
  /** Polling interval in milliseconds. */
  pollIntervalMs: number;
  /** Max pools to enumerate per scan (Raydium V4 has thousands). */
  maxPoolsPerScan: number;
  /** Signature scan limit for deriveLastSwapV4. */
  signatureScanLimit: number;
}

/**
 * Load configuration from environment variables.
 *
 * Required env:
 *   - RPC_URL (defaults to devnet)
 *   - ACTIVITY_ORACLE_KEY (base58-encoded 32-byte Ed25519 secret key; optional —
 *     if absent, the indexer runs in discovery-only mode without submitting)
 *
 * Optional env:
 *   - SCANNER_PROGRAM_ID (defaults to devnet)
 *   - CLUSTER (defaults to "devnet")
 *   - MIN_TVL_LAMPORTS (defaults to spec)
 *   - MAX_CANDIDATES_PER_CYCLE (defaults to 5)
 *   - POLL_INTERVAL_MS (defaults to 300000 = 5 minutes)
 *   - MAX_POOLS_PER_SCAN (defaults to 1000)
 *   - SIGNATURE_SCAN_LIMIT (defaults to 1000)
 */
export function loadConfig(): IndexerConfig {
  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const clusterEnv = process.env.CLUSTER ?? "devnet";
  const cluster: "devnet" | "mainnet-beta" =
    clusterEnv === "mainnet-beta" ? "mainnet-beta" : "devnet";

  const scannerProgramId = process.env.SCANNER_PROGRAM_ID
    ? new PublicKey(process.env.SCANNER_PROGRAM_ID)
    : DEVNET_SCANNER_PROGRAM_ID;
  const vaultProgramId = DEVNET_VAULT_PROGRAM_ID;

  // Activity oracle key — base58-encoded 32-byte Ed25519 secret key.
  // If absent, the indexer runs in discovery-only mode.
  let activityOracleSecretKey: Uint8Array | null = null;
  let activityOraclePublicKey: PublicKey = PublicKey.default;
  const oracleKeyEnv = process.env.ACTIVITY_ORACLE_KEY;
  if (oracleKeyEnv) {
    try {
      const decoded = bs58.decode(oracleKeyEnv);
      if (decoded.length === 32) {
        activityOracleSecretKey = new Uint8Array(decoded);
        // Derive the public key from the secret key using tweetnacl.
        const nacl = require("tweetnacl");
        const kp = nacl.sign.keyPair.fromSecretKey(activityOracleSecretKey);
        activityOraclePublicKey = new PublicKey(kp.publicKey);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `ACTIVITY_ORACLE_KEY is ${decoded.length} bytes (expected 32); running in discovery-only mode`,
        );
      }
    } catch {
      // eslint-disable-next-line no-console
      console.warn(
        "ACTIVITY_ORACLE_KEY is not valid base58; running in discovery-only mode",
      );
    }
  }

  return {
    rpcUrl,
    cluster,
    scannerProgramId,
    vaultProgramId,
    activityOracleSecretKey,
    activityOraclePublicKey,
    minTvlLamports: process.env.MIN_TVL_LAMPORTS
      ? BigInt(process.env.MIN_TVL_LAMPORTS)
      : DEFAULT_MIN_TVL_LAMPORTS,
    inactivitySeconds: process.env.INACTIVITY_SECONDS
      ? BigInt(process.env.INACTIVITY_SECONDS)
      : DEFAULT_INACTIVITY_SECONDS,
    priceCollapseBps: process.env.PRICE_COLLAPSE_BPS
      ? parseInt(process.env.PRICE_COLLAPSE_BPS, 10)
      : DEFAULT_PRICE_COLLAPSE_BPS,
    lpBurnDustThreshold: process.env.LP_BURN_DUST_THRESHOLD
      ? BigInt(process.env.LP_BURN_DUST_THRESHOLD)
      : DEFAULT_LP_BURN_DUST_THRESHOLD,
    maxCandidatesPerCycle: process.env.MAX_CANDIDATES_PER_CYCLE
      ? parseInt(process.env.MAX_CANDIDATES_PER_CYCLE, 10)
      : 5,
    pollIntervalMs: process.env.POLL_INTERVAL_MS
      ? parseInt(process.env.POLL_INTERVAL_MS, 10)
      : 300_000,
    maxPoolsPerScan: process.env.MAX_POOLS_PER_SCAN
      ? parseInt(process.env.MAX_POOLS_PER_SCAN, 10)
      : 1000,
    signatureScanLimit: process.env.SIGNATURE_SCAN_LIMIT
      ? parseInt(process.env.SIGNATURE_SCAN_LIMIT, 10)
      : 1000,
  };
}
