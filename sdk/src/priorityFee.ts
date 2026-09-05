// SPDX-License-Identifier: Apache-2.0
//
// Priority-fee policy enforcement for the salvor SDK.
//
// Charter rule: every transaction submitted by the SDK must have
// `compute_unit_price <= protocolCeilingLamportsPerCu`. The SDK additionally
// applies an operational maximum derived from expected profit margin
// (default = 25%).

import BN from "bn.js";
import type { PriorityFeePolicy } from "./types.js";

/** Default operational margin ratio: 25% of expected profit. */
export const DEFAULT_MARGIN_RATIO = 0.25;

/** Basis-point precision used when converting `marginRatio` (a JS number) to BN. */
const MARGIN_RATIO_PRECISION_BPS = 10_000;

/**
 * Compute the SDK's operational max compute-unit price for a transaction
 * given (a) the protocol Charter ceiling and (b) the salvor's expected
 * profit margin.
 *
 * The returned value is bounded above by the Charter ceiling. If the
 * computed value would exceed the ceiling, the function returns the ceiling.
 *
 * Math runs in BN throughout — `BN.toNumber()` throws for values above
 * `Number.MAX_SAFE_INTEGER` (~9.0e15), which is reachable for real Solana
 * lamport amounts. We instead quantise `marginRatio` to a 10_000-bps integer
 * and multiply/divide in BN.
 */
export function computeOperationalMaxLamportsPerCu(
  expectedProfitLamports: BN,
  protocolCeilingLamportsPerCu: BN,
  marginRatio: number = DEFAULT_MARGIN_RATIO,
): BN {
  if (!Number.isFinite(marginRatio) || marginRatio < 0 || marginRatio > 1) {
    throw new RangeError("marginRatio must be a finite number in [0, 1]");
  }
  if (expectedProfitLamports.isNeg()) {
    throw new RangeError("expectedProfitLamports must be non-negative");
  }
  const marginBps = new BN(
    Math.round(marginRatio * MARGIN_RATIO_PRECISION_BPS),
  );
  const scaledProfit = expectedProfitLamports
    .mul(marginBps)
    .div(new BN(MARGIN_RATIO_PRECISION_BPS));
  if (scaledProfit.gt(protocolCeilingLamportsPerCu)) {
    return protocolCeilingLamportsPerCu;
  }
  return scaledProfit;
}

/**
 * Return a `PriorityFeePolicy` ready to attach to a transaction. The SDK
 * caller should reject submission if `operationalMaxLamportsPerCu` is zero
 * (no headroom for priority fee) and surface the underlying reason.
 */
export function buildPriorityFeePolicy(opts: {
  expectedProfitLamports: BN;
  protocolCeilingLamportsPerCu: BN;
  marginRatio?: number;
}): PriorityFeePolicy {
  const operationalMaxLamportsPerCu = computeOperationalMaxLamportsPerCu(
    opts.expectedProfitLamports,
    opts.protocolCeilingLamportsPerCu,
    opts.marginRatio ?? DEFAULT_MARGIN_RATIO,
  );
  return {
    protocolCeilingLamportsPerCu: opts.protocolCeilingLamportsPerCu,
    operationalMaxLamportsPerCu,
    marginRatio: opts.marginRatio ?? DEFAULT_MARGIN_RATIO,
  };
}

/**
 * Hard-fail predicate. The SDK MUST refuse to submit a transaction whose
 * `compute_unit_price` exceeds either operational or protocol ceiling.
 */
export function shouldRejectFee(
  feeLamportsPerCu: BN,
  policy: PriorityFeePolicy,
): boolean {
  if (feeLamportsPerCu.gt(policy.protocolCeilingLamportsPerCu)) return true;
  if (feeLamportsPerCu.gt(policy.operationalMaxLamportsPerCu)) return true;
  return false;
}
