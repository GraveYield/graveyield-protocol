// SPDX-License-Identifier: Apache-2.0

import type { PublicKey } from "@solana/web3.js";
import type BN from "bn.js";

/**
 * The six derelict-pool eligibility criteria evaluated by GraveScanner.
 * See docs/architecture/eligibility-anchors.md.
 */
export interface EligibilityCriteria {
  /** Criterion 1 — minimum trading inactivity (default 90 days). */
  inactivitySeconds: number;
  /** Criterion 2 — minimum price collapse from launch in bps (default 9_900 = 99%). */
  priceCollapseBps: number;
  /** Criterion 3 — minimum residual TVL (default 0.5 SOL in lamports). */
  minTvlLamports: BN;
  /** Criterion 4 — LP must NOT be burned. */
  lpNotBurned: true;
  /** Criterion 5 — LP must NOT be locked. */
  lpNotLocked: true;
  /** Criterion 6 — multi-epoch confirmation (≥ 2 consecutive Solana epochs). */
  minEpochConfirmation: number;
}

/**
 * Outcome of an eligibility evaluation against a specific pool.
 */
export interface EligibilityResult {
  poolAddress: PublicKey;
  ammProgramId: PublicKey;
  eligible: boolean;
  failedCriteria: string[];
  /** Set when eligible — the EligibilityAnchor PDA address. */
  anchorPda?: PublicKey;
  /** Set when eligible AND ≥2 epochs have passed — the EligibilityCert PDA. */
  certPda?: PublicKey;
}

/**
 * 40 / 40 / 20 distribution amounts after a successful salvage.
 * `lpHolder + salvor + protocol === total`.
 */
export interface SalvageDistribution {
  total: BN;
  lpHolder: BN;
  salvor: BN;
  protocol: BN;
}

/**
 * Snapshot of LP holders captured before the AMM remove_liquidity CPI.
 * Used to build the Merkle root locked into PoolRegistry.
 */
export interface LpSnapshot {
  poolAddress: PublicKey;
  lpMint: PublicKey;
  totalSupply: BN;
  holders: Array<{ holder: PublicKey; balance: BN }>;
  merkleRoot: Uint8Array;
}

/**
 * Operational priority-fee policy used by the salvor bot. The SDK enforces
 * `operationalMaxLamportsPerCu <= protocolCeilingLamportsPerCu` and refuses
 * to submit transactions that would exceed the on-chain Charter ceiling.
 */
export interface PriorityFeePolicy {
  protocolCeilingLamportsPerCu: BN;
  operationalMaxLamportsPerCu: BN;
  /** Default = 25% of expected profit margin (lamports). */
  marginRatio: number;
}

/**
 * Cluster identifier for the SDK. Devnet/mainnet program IDs are wired in via
 * the cluster string at construct time.
 */
export type Cluster = "localnet" | "devnet" | "mainnet-beta";
