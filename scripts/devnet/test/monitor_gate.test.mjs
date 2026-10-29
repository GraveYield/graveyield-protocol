// SPDX-License-Identifier: Apache-2.0
//
// Finding D regression tests — the explicit stage-13 reconciliation gate
// (monitor_gate.classifyReconciliation). Covers BOTH accepted outcomes
// (receipt-verified; a receipt-anomaly that is exactly the program's
// protocol-leg rounding remainder, with the discrepancy magnitude
// recorded) and the REJECTED cases (genuinely unexpected discrepancies,
// sums disagreements, missing receipts, unknown statuses).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classifyReconciliation, expectedLegs } from "../lifecycle_rehearsal/monitor_gate.mjs";

/** Build a reconcile result shaped like @graveyield/monitor's Reconciliation. */
function rec({ total, protocol, lpHolder, salvor, status, sumsOk = true, reportedOk = true }) {
  return {
    status,
    detail: { sumsOk, reportedOk, sharesOk: false },
    receipt: {
      totalProceedsLamports: total.toString(),
      protocolAmountLamports: protocol.toString(),
      lpHolderAmountLamports: lpHolder.toString(),
      salvorAmountLamports: salvor.toString(),
      dustMemecoinLamports: "0",
    },
  };
}

// total = 1 000 004 → floor40 = 400 001 (×2), protocol remainder = 200 002,
// floor(20%) = 200 000 → the program leg sits +2 above the monitor's ±1
// tolerance: the permitted rounding case.
const REMAINDER_TOTAL = 1_000_004n;
const REMAINDER_LEGS = expectedLegs(REMAINDER_TOTAL);

describe("expectedLegs", () => {
  test("exact program allocation: floors of 40% + exact remainder", () => {
    assert.equal(REMAINDER_LEGS.lpHolder, 400_001n);
    assert.equal(REMAINDER_LEGS.salvor, 400_001n);
    assert.equal(REMAINDER_LEGS.protocol, 200_002n);
    assert.equal(
      REMAINDER_LEGS.protocol - (REMAINDER_TOTAL * 2000n) / 10_000n,
      2n,
      "the permitted case must exceed the monitor's ±1 by exactly 2",
    );
  });
});

describe("classifyReconciliation — accepted outcomes", () => {
  test("receipt-verified → accepted as verified", () => {
    const v = classifyReconciliation(
      rec({
        total: 1000n,
        protocol: 200n,
        lpHolder: 400n,
        salvor: 400n,
        status: "receipt-verified",
      }),
    );
    assert.equal(v.accepted, true);
    assert.equal(v.kind, "receipt-verified");
  });

  test("PERMITTED ROUNDING CASE: anomaly that is exactly the remainder → accepted, magnitude recorded", () => {
    const v = classifyReconciliation(
      rec({
        total: REMAINDER_TOTAL,
        protocol: REMAINDER_LEGS.protocol,
        lpHolder: REMAINDER_LEGS.lpHolder,
        salvor: REMAINDER_LEGS.salvor,
        status: "receipt-anomaly",
      }),
    );
    assert.equal(v.accepted, true);
    assert.equal(v.kind, "accepted-rounding-remainder");
    assert.equal(v.protocolDeltaLamports, 2n);
    assert.match(v.reason, /rounding remainder/);
  });

  test("remainder case with delta 0 (even split) also accepted as remainder", () => {
    const legs = expectedLegs(1_000_000n); // protocol 200 000 = floor(20%) exactly
    const v = classifyReconciliation(
      rec({
        total: 1_000_000n,
        protocol: legs.protocol,
        lpHolder: legs.lpHolder,
        salvor: legs.salvor,
        status: "receipt-anomaly",
      }),
    );
    assert.equal(v.accepted, true);
    assert.equal(v.protocolDeltaLamports, 0n);
  });
});

describe("classifyReconciliation — rejected (unexpected) outcomes", () => {
  test("GENUINELY UNEXPECTED: a leg off by more than the rounding remainder → rejected", () => {
    const v = classifyReconciliation(
      rec({
        total: REMAINDER_TOTAL,
        protocol: REMAINDER_LEGS.protocol + 5n, // skims 5 lamports from salvor side
        lpHolder: REMAINDER_LEGS.lpHolder,
        salvor: REMAINDER_LEGS.salvor - 5n,
        status: "receipt-anomaly",
      }),
    );
    assert.equal(v.accepted, false);
    assert.equal(v.kind, "rejected");
    assert.match(v.reason, /unexpected receipt-anomaly/);
  });

  test("anomaly with sums disagreeing → rejected", () => {
    const v = classifyReconciliation(
      rec({
        total: REMAINDER_TOTAL,
        protocol: REMAINDER_LEGS.protocol,
        lpHolder: REMAINDER_LEGS.lpHolder,
        salvor: REMAINDER_LEGS.salvor,
        status: "receipt-anomaly",
        sumsOk: false,
      }),
    );
    assert.equal(v.accepted, false);
  });

  test("anomaly with reported figures disagreeing → rejected", () => {
    const v = classifyReconciliation(
      rec({
        total: REMAINDER_TOTAL,
        protocol: REMAINDER_LEGS.protocol,
        lpHolder: REMAINDER_LEGS.lpHolder,
        salvor: REMAINDER_LEGS.salvor,
        status: "receipt-anomaly",
        reportedOk: false,
      }),
    );
    assert.equal(v.accepted, false);
  });

  test("anomaly with a leg wildly wrong (sums still OK) → rejected", () => {
    const v = classifyReconciliation(
      rec({
        total: REMAINDER_TOTAL,
        protocol: 300_002n, // stole 100 000 from LP holders
        lpHolder: REMAINDER_LEGS.lpHolder - 100_000n,
        salvor: REMAINDER_LEGS.salvor,
        status: "receipt-anomaly",
      }),
    );
    assert.equal(v.accepted, false);
  });

  test("anomaly with no receipt → rejected", () => {
    const v = classifyReconciliation({
      status: "receipt-anomaly",
      detail: { sumsOk: true, reportedOk: true },
      receipt: null,
    });
    assert.equal(v.accepted, false);
  });

  test("receipt-missing → rejected", () => {
    const v = classifyReconciliation({ status: "receipt-missing", detail: {}, receipt: null });
    assert.equal(v.accepted, false);
  });

  test("chain-unreadable → rejected", () => {
    const v = classifyReconciliation({
      status: "chain-unreadable",
      detail: { error: "x" },
      receipt: null,
    });
    assert.equal(v.accepted, false);
  });

  test("null/undefined result → rejected", () => {
    assert.equal(classifyReconciliation(null).accepted, false);
    assert.equal(classifyReconciliation(undefined).accepted, false);
  });
});
