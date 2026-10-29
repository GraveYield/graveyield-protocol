// SPDX-License-Identifier: Apache-2.0
//
// monitor_gate.mjs — explicit classification of monitor reconciliation
// outcomes for stage 13 (Finding D fix).
//
// The shipped @graveyield/monitor labels a receipt "receipt-verified" only
// when sums AND per-leg ±1-lamport share checks AND the executor's reported
// numbers all match (monitor.ts:531-532, shareMatches at 589-593). The
// on-chain program allocates the PROTOCOL leg as the exact remainder
// (total − 2·floor(total·40%)), which can sit floor(20%)+2 — outside the
// monitor's ±1 tolerance — so a CORRECT receipt can be labeled
// "receipt-anomaly" (sums and reported figures still agree).
//
// This gate makes the stage's accepted outcomes EXPLICIT instead of
// relabeling the anomaly: a "receipt-verified" status is accepted as
// verified; a "receipt-anomaly" is accepted ONLY when it is exactly the
// known rounding remainder (sums agree, reported figures agree, and every
// leg equals its exact allocation — the delta vs floor(20%) is recorded).
// Anything else is rejected and fails the stage.
//
// PURE — unit-tested without a validator (test/monitor_gate.test.mjs).

/** Exact program allocation: LP and salvor legs are floors of 40%; the
 * protocol leg takes the exact remainder (run-36 finding). */
export function expectedLegs(total) {
  const floor40 = (total * 4000n) / 10_000n;
  return {
    lpHolder: floor40,
    salvor: floor40,
    protocol: total - floor40 - floor40,
  };
}

/**
 * Classify one monitor reconcile result.
 *
 * @returns {{accepted: true, kind: "receipt-verified", protocolDeltaLamports: bigint, reason: string}
 *          |{accepted: true, kind: "accepted-rounding-remainder", protocolDeltaLamports: bigint, reason: string}
 *          |{accepted: false, kind: "rejected", protocolDeltaLamports: bigint|null, reason: string}}
 */
export function classifyReconciliation(rec) {
  const asBigInt = (v) => {
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  };
  const protocolDelta = () => {
    const r = rec?.receipt;
    if (!r) return null;
    const total = asBigInt(r.totalProceedsLamports);
    const protocol = asBigInt(r.protocolAmountLamports);
    if (total === null || protocol === null) return null;
    return protocol - (total * 2000n) / 10_000n;
  };

  if (rec?.status === "receipt-verified") {
    return {
      accepted: true,
      kind: "receipt-verified",
      protocolDeltaLamports: protocolDelta(),
      reason: "monitor verified sums, ±1-lamport share tolerance, and reported figures",
    };
  }

  if (rec?.status === "receipt-anomaly") {
    const sumsOk = rec.detail?.sumsOk === true;
    const reportedOk = rec.detail?.reportedOk === true;
    const r = rec.receipt;
    const total = r ? asBigInt(r.totalProceedsLamports) : null;
    const legs = r
      ? {
          lpHolder: asBigInt(r.lpHolderAmountLamports),
          salvor: asBigInt(r.salvorAmountLamports),
          protocol: asBigInt(r.protocolAmountLamports),
        }
      : null;
    const exactLegs =
      total !== null && legs && !Object.values(legs).some((v) => v === null)
        ? expectedLegs(total)
        : null;
    const legsExact =
      exactLegs !== null &&
      legs.lpHolder === exactLegs.lpHolder &&
      legs.salvor === exactLegs.salvor &&
      legs.protocol === exactLegs.protocol;

    if (sumsOk && reportedOk && legsExact) {
      const delta = protocolDelta();
      return {
        accepted: true,
        kind: "accepted-rounding-remainder",
        protocolDeltaLamports: delta,
        reason:
          "receipt-anomaly is EXACTLY the known rounding remainder: sums and reported figures agree and every leg equals its exact program allocation (protocol leg = total − 2·floor(40%) vs the monitor's ±1-lamport floor(20%) check) — labeled boundary, not a relabel",
      };
    }
    return {
      accepted: false,
      kind: "rejected",
      protocolDeltaLamports: protocolDelta(),
      reason: `unexpected receipt-anomaly (sumsOk=${sumsOk} reportedOk=${reportedOk} legsExact=${legsExact}) — genuinely unexpected discrepancies must fail the stage`,
    };
  }

  return {
    accepted: false,
    kind: "rejected",
    protocolDeltaLamports: protocolDelta(),
    reason: `monitor status ${rec?.status ?? "(none)"} is not an accepted stage-13 outcome`,
  };
}
