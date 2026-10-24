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
 * ⚠️ DEPRECATED for executor decisions — unit mismatch (FLEET-M0 audit
 * F1). This function mixes two different dimensions: `expectedProfitLamports`
 * is a TOTAL amount (lamports) while the returned value is used as a
 * PER-COMPUTE-UNIT price. `floor(marginRatio × profit)` as a per-CU price
 * with a typical 200k–500k CU limit allows a total fee up to
 * `cuLimit ×` the intended budget whenever the profit share exceeds the
 * ceiling, and starves the fee budget whenever it does not.
 *
 * Kept for API compatibility (the Phase 8 test vectors pin its behavior).
 * New executor code MUST use `derivePriorityFeePlan`, which carries the
 * transaction's compute-unit limit and derives the per-CU price from the
 * TOTAL fee budget with exact integer math.
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

// ------------------------------------------------------------- fee plan (D3)

/** Micro-lamports per lamport — `ComputeBudgetProgram.setComputeUnitPrice`'s unit. */
export const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

/** Result of `derivePriorityFeePlan` — the fee budget for ONE transaction. */
export interface PriorityFeePlan {
  /**
   * Maximum TOTAL priority fee for the transaction (lamports):
   * `floor(marginRatio × expectedProfitLamports)`. This is the hard
   * budget: `maxMicroLamportsPerCu × computeUnitLimit` can never exceed
   * it (floor rounding only goes down).
   */
  maxTotalFeeLamports: BN;
  /**
   * Maximum per-CU price for `setComputeUnitPrice` (micro-lamports/CU):
   * `min(floor(maxTotalFeeLamports × 1e6 / computeUnitLimit), ceiling)`.
   */
  maxMicroLamportsPerCu: BN;
  /**
   * Which constraint bound the per-CU price: `"profit-margin"` when the
   * D3 margin budget is the tighter bound, `"charter-ceiling"` when the
   * advisory ProtocolConfig ceiling is.
   */
  binding: "profit-margin" | "charter-ceiling";
}

/**
 * Derive the D3-compliant priority-fee plan for one transaction
 * (FLEET-M0 audit F1 — supersedes `computeOperationalMaxLamportsPerCu`
 * for executor decisions).
 *
 * Spec D3: SDKs must reject submissions above
 * `min(ceiling, margin-ratio × expected profit)`. Dimensionally that
 * means TWO bounds on different quantities:
 *
 *   1. TOTAL fee budget  = floor(marginRatio × expectedProfitLamports)
 *                          (lamports — the profit share).
 *   2. PER-CU price cap  = the Charter ceiling as stored in the Vault
 *                          ProtocolConfig, in the unit
 *                          `computeBudgetIxs` feeds to
 *                          `setComputeUnitPrice` (micro-lamports/CU).
 *
 * The per-CU price is derived from the total budget:
 * `floor(maxTotalFeeLamports × 1_000_000 / computeUnitLimit)`, then
 * capped at the ceiling. All amount math is BN integers — no floats.
 *
 * `protocolCeilingMicroLamportsPerCu` is the raw ProtocolConfig field
 * (`max_priority_fee_ceiling_lamports`, default 1e9). The SDK has always
 * consumed that field as micro-lamports/CU (it is passed straight to
 * `setComputeUnitPrice({ microLamports })`); the field NAME is a legacy
 * drift the spec wording inherited (FLEET-M0 audit F2).
 */
export function derivePriorityFeePlan(opts: {
  /** Expected NET profit for the whole operation, in lamports (≥ 0). */
  expectedProfitLamports: BN;
  /** The transaction's compute-unit limit (must be > 0). */
  computeUnitLimit: number;
  /** Vault ProtocolConfig ceiling, in micro-lamports/CU (advisory per D3). */
  protocolCeilingMicroLamportsPerCu: BN;
  /** Share of expected profit spendable on priority fees (default 25%). */
  marginRatio?: number;
}): PriorityFeePlan {
  const marginRatio = opts.marginRatio ?? DEFAULT_MARGIN_RATIO;
  if (!Number.isFinite(marginRatio) || marginRatio < 0 || marginRatio > 1) {
    throw new RangeError("marginRatio must be a finite number in [0, 1]");
  }
  if (opts.expectedProfitLamports.isNeg()) {
    throw new RangeError("expectedProfitLamports must be non-negative");
  }
  if (!Number.isFinite(opts.computeUnitLimit) || !Number.isInteger(opts.computeUnitLimit) || opts.computeUnitLimit <= 0) {
    throw new RangeError("computeUnitLimit must be a positive integer");
  }
  if (opts.protocolCeilingMicroLamportsPerCu.isNeg()) {
    throw new RangeError("protocolCeilingMicroLamportsPerCu must be non-negative");
  }

  // 1. TOTAL budget: floor(margin × profit) via the same 10_000-bps
  //    quantisation the legacy helper uses (marginRatio is a JS number;
  //    the AMOUNT math below stays in BN).
  const marginBps = new BN(Math.round(marginRatio * MARGIN_RATIO_PRECISION_BPS));
  const maxTotalFeeLamports = opts.expectedProfitLamports
    .mul(marginBps)
    .div(new BN(MARGIN_RATIO_PRECISION_BPS));

  // 2. Per-CU price from the total budget, exact integer floor:
  //    floor(totalFeeLamports × 1e6 micro-lamports/lamport / cuLimit).
  const profitCapPrice = maxTotalFeeLamports
    .mul(new BN(MICRO_LAMPORTS_PER_LAMPORT))
    .div(new BN(opts.computeUnitLimit));

  // 3. Charter cap: the per-CU price may never exceed the ceiling.
  if (profitCapPrice.gt(opts.protocolCeilingMicroLamportsPerCu)) {
    return {
      maxTotalFeeLamports,
      maxMicroLamportsPerCu: opts.protocolCeilingMicroLamportsPerCu,
      binding: "charter-ceiling",
    };
  }
  return {
    maxTotalFeeLamports,
    maxMicroLamportsPerCu: profitCapPrice,
    binding: "profit-margin",
  };
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
