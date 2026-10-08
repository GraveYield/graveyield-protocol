// SPDX-License-Identifier: Apache-2.0
//
// Candidate scoring — the sixth stage of the Phase 9 indexer pipeline.
// Combines the C1 inactivity margin, C3 TVL margin, and C2 price
// collapse potential into a single numeric score for queue ordering.
//
// The score is NOT the on-chain eligibility decision — the on-chain
// GraveScanner is the authority. The score only prioritizes which
// candidates to submit first (higher score = submit first) because the
// indexer's per-cycle submission budget is limited by `maxCandidatesPerCycle`.
//
// Scoring formula:
//
//   score = inactivityMargin * tvlMargin * priceCollapseMargin
//
// where each margin is the ratio of the pool's value to the threshold:
//
//   inactivityMargin = elapsedSeconds / inactivityThreshold  (≥ 1.0 to pass C1)
//   tvlMargin = tvlLamports / minTvlLamports                 (≥ 1.0 to pass C3)
//   priceCollapseMargin = dropBps / priceCollapseBps         (≥ 1.0 to pass C2)
//
// A pool with score ≥ 1.0 on all three dimensions would pass C1, C2, C3
// (the three quantitative criteria). The product rewards pools that
// exceed ALL thresholds by the widest combined margin — those are the
// most likely to remain eligible through the multi-epoch confirmation
// gap (C6) and to produce the largest salvage proceeds.
//
// C4 (LP not burned), C5 (no lock), and C6 (epoch confirmed) are
// binary pass/fail and contribute no margin — they gate admission to
// the candidate set but do not affect ordering.

import type { Candidate, ScoredCandidate } from "./types.js";

/** Thresholds for the margin computation. */
export interface ScoringThresholds {
  inactivitySeconds: bigint;
  minTvlLamports: bigint;
  priceCollapseBps: number;
}

/** Compute the Q64.64 price-drop in bps from launch price to current price. */
function computeDropBps(launchQ64x64: bigint, currentQ64x64: bigint): number {
  if (launchQ64x64 <= 0n) return 0;
  if (currentQ64x64 >= launchQ64x64) return 0;
  const delta = launchQ64x64 - currentQ64x64;
  const dropBps = Number((delta * 10_000n) / launchQ64x64);
  return Math.min(dropBps, 10_000);
}

/** Compute the current pool price as quote-per-base in Q64.64. */
function quotePerBaseQ64x64(baseReserve: bigint, quoteReserve: bigint): bigint {
  if (baseReserve <= 0n) return 0n;
  return (quoteReserve << 64n) / baseReserve;
}

/**
 * Score a candidate. Returns the score + the per-criterion margin
 * breakdown for observability.
 *
 * The candidate must already have passed the pre-filter (all six
 * criteria). The score only affects queue ordering.
 */
export function scoreCandidate(
  candidate: Candidate,
  thresholds: ScoringThresholds,
  opts?: { launchPriceQ64x64?: bigint; currentPriceQ64x64?: bigint },
): ScoredCandidate {
  // C1 inactivity margin.
  const elapsedSeconds: bigint = candidate.activity.noSwapFound
    ? thresholds.inactivitySeconds * 10n // very old if no swap found at all
    : BigInt(Math.floor(Date.now() / 1000)) - BigInt(candidate.activity.lastSwapUnixTs);
  const inactivityMargin =
    Number(elapsedSeconds) / Number(thresholds.inactivitySeconds);

  // C3 TVL margin.
  const tvlMargin =
    Number(candidate.reserves.tvlLamports) / Number(thresholds.minTvlLamports);

  // C2 price collapse margin. If launch/current prices are supplied,
  // compute the actual drop; otherwise estimate from the reserve ratio
  // (a pool with very little quote-side liquidity relative to its base
  // side has likely collapsed).
  let priceCollapseMargin: number;
  if (opts?.launchPriceQ64x64 && opts?.currentPriceQ64x64) {
    const dropBps = computeDropBps(opts.launchPriceQ64x64, opts.currentPriceQ64x64);
    priceCollapseMargin = dropBps / thresholds.priceCollapseBps;
  } else {
    // Estimate: a pool with a high base/quote reserve ratio likely
    // collapsed (the base token's value dropped relative to the quote).
    // This is a rough proxy; the real C2 check needs the recorded
    // LaunchPrice PDA, which the indexer fetches via the SDK.
    const baseReserve = candidate.reserves.coinReserve;
    const quoteReserve = candidate.reserves.pcReserve;
    if (baseReserve > 0n && quoteReserve > 0n) {
      const currentPrice = quotePerBaseQ64x64(baseReserve, quoteReserve);
      // Assume a nominal launch price of 1.0 (Q64.64 = 1<<64) for the
      // estimate. The real launch price comes from the LaunchPrice PDA.
      const nominalLaunch = 1n << 64n;
      const dropBps = computeDropBps(nominalLaunch, currentPrice);
      priceCollapseMargin = dropBps / thresholds.priceCollapseBps;
    } else {
      priceCollapseMargin = 0;
    }
  }

  const score = inactivityMargin * tvlMargin * priceCollapseMargin;

  return {
    candidate,
    score,
    scoreBreakdown: {
      inactivityMargin,
      tvlMargin,
      priceCollapseMargin,
    },
  };
}
