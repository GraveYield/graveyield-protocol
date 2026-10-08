// SPDX-License-Identifier: Apache-2.0
//
// Off-chain pre-filter for the six derelict-pool criteria. Cheaper than the
// on-chain check because it can short-circuit on the first failing criterion
// using cached data, and it does not write any PDAs.
//
// The pre-filter is the indexer's "wide funnel" — it eliminates pools
// that obviously don't meet the criteria so the on-chain scanner (the
// "narrow authority") only processes genuine candidates. The on-chain
// GraveScanner is the source of truth; this function is the pre-filter
// that picks candidates worth submitting to Phase 1.
//
// Six criteria (mirrors the on-chain `criteria::evaluate`):
//   C1: inactivity ≥ threshold (default 90 days)
//   C2: price collapse ≥ threshold (default 99% = 9900 bps)
//   C3: TVL ≥ threshold (default 0.5 SOL)
//   C4: LP not burned (supply > dust threshold)
//   C5: no LP locked (UNCX marker absent — Phase 9 surfaces as a flag)
//   C6: multi-epoch confirmed (≥ 2 epochs since Phase 1 anchor)
//
// The pre-filter evaluates C1–C5 from the indexed data; C6 is only
// checkable after a Phase 1 anchor exists, so the pre-filter assumes
// C6 passes for new candidates (the on-chain scanner enforces it at
// Phase 2).

import type { ActivityRecord, ReserveRecord, TokenMetadata, PreFilterResult } from "./types.js";

/** Per-criterion bitmap — mirrors the on-chain `criteria.rs` constants. */
export const CRITERION_INACTIVITY = 0x01;
export const CRITERION_PRICE_COLLAPSE = 0x02;
export const CRITERION_MIN_TVL = 0x04;
export const CRITERION_LP_NOT_BURNED = 0x08;
export const CRITERION_NO_LOCK = 0x10;
export const CRITERION_EPOCH_CONFIRMED = 0x20;
export const ALL_CRITERIA_MASK = 0x3f;

/** Thresholds for the pre-filter. */
export interface PreFilterThresholds {
  inactivitySeconds: bigint;
  priceCollapseBps: number;
  minTvlLamports: bigint;
  lpBurnDustThreshold: bigint;
}

/**
 * Evaluate the six criteria against indexed pool data. The on-chain
 * GraveScanner is the source of truth; this function is the wide-funnel
 * pre-filter that picks candidates worth submitting to Phase 1.
 *
 * C5 (no LP locked) is evaluated as a flag in v1 — the UNCX marker PDA
 * check is the on-chain adapter's job. The pre-filter assumes C5 passes
 * unless the operator supplies locker evidence indicating otherwise.
 */
export function preFilterPool(
  activity: ActivityRecord,
  reserves: ReserveRecord,
  _metadata: TokenMetadata,
  thresholds: PreFilterThresholds,
): PreFilterResult {
  const poolAddress = activity.poolAddress;
  let bitmap = 0;
  const failed: string[] = [];

  // C1 — inactivity.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const elapsed = activity.noSwapFound
    ? thresholds.inactivitySeconds * 10n // very old if no swap found
    : now - BigInt(activity.lastSwapUnixTs);
  if (elapsed >= thresholds.inactivitySeconds) {
    bitmap |= CRITERION_INACTIVITY;
  } else {
    failed.push("C1-inactivity");
  }

  // C2 — price collapse. The pre-filter does NOT have the recorded
  // LaunchPrice PDA — that's a Phase 1/Phase 2 on-chain read. The
  // pre-filter estimates C2 from the reserve ratio: a pool with a very
  // low quote/base ratio likely collapsed. This is a rough proxy; the
  // on-chain C2 check uses the authoritative LaunchPrice record.
  //
  // For v1, the pre-filter assumes C2 passes if the pool has a WSOL
  // side (so the price math is meaningful) and lets the on-chain
  // scanner make the authoritative call.
  if (reserves.wsolSideIdentified) {
    bitmap |= CRITERION_PRICE_COLLAPSE;
  } else {
    failed.push("C2-price-collapse");
  }

  // C3 — min TVL.
  if (reserves.tvlLamports >= thresholds.minTvlLamports) {
    bitmap |= CRITERION_MIN_TVL;
  } else {
    failed.push("C3-min-tvl");
  }

  // C4 — LP not burned.
  if (reserves.lpSupply > thresholds.lpBurnDustThreshold) {
    bitmap |= CRITERION_LP_NOT_BURNED;
  } else {
    failed.push("C4-lp-not-burned");
  }

  // C5 — no LP locked. v1 assumes no lock (the on-chain adapter is the
  // authority; the SDK surfaces the UNCX marker as a flag).
  bitmap |= CRITERION_NO_LOCK;

  // C6 — multi-epoch confirmed. The pre-filter assumes C6 passes for
  // new candidates (the on-chain scanner enforces it at Phase 2).
  bitmap |= CRITERION_EPOCH_CONFIRMED;

  return {
    poolAddress,
    passed: bitmap === ALL_CRITERIA_MASK,
    failedCriteria: failed,
    criteriaBitmap: bitmap,
  };
}
