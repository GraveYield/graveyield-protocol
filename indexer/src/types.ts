// SPDX-License-Identifier: Apache-2.0
//
// Phase 9 — GraveScanner v2 indexer shared types.
//
// The indexer is the wide funnel: enumerate every Raydium V4 pool, apply
// a cheap off-chain pre-filter for the six derelict-pool criteria, score
// the survivors, queue them by priority, and submit the top candidates
// to the on-chain GraveScanner Phase 1. The on-chain scanner remains the
// narrow authority — it is the only way to mint an EligibilityCert that
// GraveVault accepts.
//
// These types flow through the pipeline:
//
//   DiscoveredPool         — raw enumeration output (pool address + AmmInfo)
//   ActivityRecord         — last-swap timestamp + slot from signature history
//   ReserveRecord          — vault balances + LP supply
//   TokenMetadata          — mint supply + decimals for base/quote/LP
//   PreFilterResult        — per-criterion pass/fail + failed list
//   Candidate              — a pool that passed the pre-filter (all six)
//   ScoredCandidate        — candidate + numeric score for queue ordering
//   SubmissionResult       — outcome of the on-chain Phase 1 submission

import type { PublicKey } from "@solana/web3.js";

/** A pool discovered by the Raydium V4 source. */
export interface DiscoveredPool {
  poolAddress: PublicKey;
  /** The parsed AmmInfo fields (vaults, mints). */
  pool: {
    coinVault: PublicKey;
    pcVault: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    lpMint: PublicKey;
  };
  /** Slot at which the pool account was fetched. */
  fetchedAtSlot: number;
}

/** Last-swap activity record from signature history. */
export interface ActivityRecord {
  poolAddress: PublicKey;
  /** Unix timestamp (seconds) of the pool's most recent swap. */
  lastSwapUnixTs: number;
  /** Slot of the most recent swap. */
  lastSwapSlot: number;
  /** Signature of the most recent swap transaction (audit anchor). */
  lastSwapSignature: string;
  /** True if the scan exhausted all signatures without finding a swap. */
  noSwapFound: boolean;
}

/** Vault reserves + LP supply read from SPL token accounts. */
export interface ReserveRecord {
  poolAddress: PublicKey;
  /** Coin-side (base) vault balance in base units. */
  coinReserve: bigint;
  /** Pc-side (quote) vault balance in base units. */
  pcReserve: bigint;
  /** LP mint total supply in base units. */
  lpSupply: bigint;
  /** True if the WSOL side was identified (exactly one of coin/pc is WSOL). */
  wsolSideIdentified: boolean;
  /** The quote-side reserve in lamports (for TVL filtering). */
  tvlLamports: bigint;
}

/** Token metadata for the pool's three mints. */
export interface TokenMetadata {
  poolAddress: PublicKey;
  baseMint: PublicKey;
  baseDecimals: number;
  baseSupply: bigint;
  quoteMint: PublicKey;
  quoteDecimals: number;
  quoteSupply: bigint;
  lpMint: PublicKey;
  lpDecimals: number;
  lpSupply: bigint;
}

/** Per-criterion pre-filter result. Cheap and non-authoritative. */
export interface PreFilterResult {
  poolAddress: PublicKey;
  passed: boolean;
  failedCriteria: string[];
  /** The six-criterion bitmap (0x3F = all pass). Mirrors the on-chain bitmap. */
  criteriaBitmap: number;
}

/** A candidate pool that passed all six pre-filter criteria. */
export interface Candidate {
  poolAddress: PublicKey;
  ammProgramId: PublicKey;
  /** The discovery data (pool fields, reserves, activity, metadata). */
  discovery: DiscoveredPool;
  activity: ActivityRecord;
  reserves: ReserveRecord;
  metadata: TokenMetadata;
  /** The pre-filter result that admitted this candidate. */
  preFilter: PreFilterResult;
}

/** A candidate with a numeric score for queue ordering. */
export interface ScoredCandidate {
  candidate: Candidate;
  /** Higher score = higher priority. */
  score: number;
  /** Breakdown of the score components (for debugging / observability). */
  scoreBreakdown: {
    inactivityMargin: number;
    tvlMargin: number;
    priceCollapseMargin: number;
  };
}

/** Result of submitting a candidate to the on-chain GraveScanner Phase 1. */
export interface SubmissionResult {
  poolAddress: PublicKey;
  /** The transaction signature (if submitted). */
  signature?: string;
  /** "submitted" | "confirmed" | "failed" | "skipped" */
  status: "submitted" | "confirmed" | "failed" | "skipped";
  /** Error message if status is "failed". */
  error?: string;
  /** The EligibilityAnchor PDA address (for result tracking). */
  anchorPda: PublicKey;
}

/** Result of tracking a submission's on-chain outcome. */
export interface TrackingResult {
  poolAddress: PublicKey;
  anchorPda: PublicKey;
  /** "anchor-written" | "anchor-missing" | "cert-written" | "cert-missing" */
  status: "anchor-written" | "anchor-missing" | "cert-written" | "cert-missing";
  /** The anchor's first_eligible_epoch if the anchor exists. */
  anchorFirstEligibleEpoch?: bigint;
  /** The cert's expires_at if the cert exists. */
  certExpiresAt?: bigint;
}
