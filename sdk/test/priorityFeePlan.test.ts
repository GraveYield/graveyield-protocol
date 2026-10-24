// SPDX-License-Identifier: Apache-2.0
//
// derivePriorityFeePlan regression tests (FLEET-M0 audit F1/F2).
//
// These pin the D3 fee model at its correct dimensionality:
//
//   1. TOTAL fee budget = floor(marginRatio × expectedProfitLamports)
//                          [lamports].
//   2. Per-CU price     = floor(budget × 1e6 / computeUnitLimit)
//                          [micro-lamports/CU], capped at the ceiling.
//
// The property under test — the one the deprecated
// `computeOperationalMaxLamportsPerCu` could NOT guarantee — is:
//
//   maxMicroLamportsPerCu × computeUnitLimit ≤ maxTotalFeeLamports × 1e6
//
// i.e. the configured fee budget can never exceed the strategy's allowed
// share of expected profit, and the per-CU price can never exceed the
// on-chain ceiling, for ARBITRARY profit / cuLimit / ceiling combos.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import {
  derivePriorityFeePlan,
  computeOperationalMaxLamportsPerCu,
  MICRO_LAMPORTS_PER_LAMPORT,
} from "../src/index.js";

describe("derivePriorityFeePlan", () => {
  test("profit-margin binds: per-CU price = floor(budget × 1e6 / cuLimit)", () => {
    // Expected profit 0.1 SOL = 1e8 lamports; margin 25% → budget
    // 2.5e7 lamports = 2.5e13 µL. cuLimit 200_000 →
    // floor(2.5e13 / 2e5) = 125_000_000 µL/CU.
    const plan = derivePriorityFeePlan({
      expectedProfitLamports: new BN(100_000_000),
      computeUnitLimit: 200_000,
      protocolCeilingMicroLamportsPerCu: new BN(1_000_000_000),
    });
    assert.equal(plan.binding, "profit-margin");
    assert.equal(plan.maxTotalFeeLamports.toString(10), "25000000");
    assert.equal(plan.maxMicroLamportsPerCu.toString(10), "125000000");
    // Exact division: price × cuLimit == budget × 1e6.
    assert.equal(
      plan.maxMicroLamportsPerCu.mul(new BN(200_000)).toString(10),
      "25000000000000",
    );
  });

  test("floor rounding: indivisible budgets round the PRICE down, never the budget up", () => {
    // budget = floor(132 × 0.25) = 33 lamports = 3.3e7 µL;
    // cuLimit 200_000 → floor(3.3e7 / 2e5) = 165 exactly.
    const exact = derivePriorityFeePlan({
      expectedProfitLamports: new BN(132),
      computeUnitLimit: 200_000,
      protocolCeilingMicroLamportsPerCu: new BN(1_000_000_000),
    });
    assert.equal(exact.maxMicroLamportsPerCu.toString(10), "165");

    // budget = floor(28 × 0.25) = 7 lamports = 7e6 µL;
    // cuLimit 300_000 → floor(7e6 / 3e5) = 23 (floor of 23.33).
    const floored = derivePriorityFeePlan({
      expectedProfitLamports: new BN(28),
      computeUnitLimit: 300_000,
      protocolCeilingMicroLamportsPerCu: new BN(1_000_000_000),
    });
    assert.equal(floored.maxMicroLamportsPerCu.toString(10), "23");
    // 23 × 300_000 = 6.9e6 µL = 6.9 lamports ≤ 7-lamport budget.
    assert.equal(
      floored.maxMicroLamportsPerCu.mul(new BN(300_000)).toString(10),
      "6900000",
    );
  });

  test("charter-ceiling binds: price capped, actual total strictly under budget", () => {
    // Profit 10 SOL; margin 25% → budget 2.5e9 lamports = 2.5e15 µL;
    // cuLimit 300_000 → uncapped price would be 8.33e9 µL/CU, above the
    // 50_000 ceiling → capped. Actual total = 5e4 × 3e5 = 1.5e10 µL
    // (= 15_000 lamports), far below the 2.5e9-lamport budget.
    const plan = derivePriorityFeePlan({
      expectedProfitLamports: new BN(10_000_000_000),
      computeUnitLimit: 300_000,
      protocolCeilingMicroLamportsPerCu: new BN(50_000),
      marginRatio: 0.25,
    });
    assert.equal(plan.binding, "charter-ceiling");
    assert.equal(plan.maxMicroLamportsPerCu.toString(10), "50000");
    assert.equal(
      plan.maxMicroLamportsPerCu.mul(new BN(300_000)).toString(10),
      "15000000000",
    );
    assert.ok(
      plan.maxMicroLamportsPerCu
        .mul(new BN(300_000))
        .lte(plan.maxTotalFeeLamports.mul(new BN(MICRO_LAMPORTS_PER_LAMPORT))),
    );
    assert.equal(plan.maxTotalFeeLamports.toString(10), "2500000000");
  });

  test("PROPERTY: price × cuLimit ≤ budget × 1e6 across arbitrary combos", () => {
    // Deterministic sweep over representative magnitudes (no RNG —
    // reproducible failures).
    const profits = [0n, 1n, 999n, 1_000_000n, 500_000_000n, 10_000_000_000n, 10n ** 15n];
    const cuLimits = [1, 1_400, 50_000, 200_000, 483_111, 1_400_000];
    const ceilings = [0n, 1n, 50_000n, 1_000_000n, 1_000_000_000n];
    const margins = [0, 0.05, 0.25, 0.5, 1];
    for (const profit of profits) {
      for (const cu of cuLimits) {
        for (const ceiling of ceilings) {
          for (const margin of margins) {
            const plan = derivePriorityFeePlan({
              expectedProfitLamports: new BN(profit),
              computeUnitLimit: cu,
              protocolCeilingMicroLamportsPerCu: new BN(ceiling),
              marginRatio: margin,
            });
            // (a) per-CU price never exceeds the ceiling…
            assert.ok(
              plan.maxMicroLamportsPerCu.lte(new BN(ceiling)),
              `ceiling violated: profit=${profit} cu=${cu} ceiling=${ceiling} margin=${margin}`,
            );
            // …and (b) the TOTAL fee the price can produce never exceeds
            // the margin budget (floor rounding only goes down).
            const totalFeeMicro = plan.maxMicroLamportsPerCu.mul(new BN(cu));
            const budgetMicro = plan.maxTotalFeeLamports.mul(
              new BN(MICRO_LAMPORTS_PER_LAMPORT),
            );
            assert.ok(
              totalFeeMicro.lte(budgetMicro),
              `budget exceeded: profit=${profit} cu=${cu} ceiling=${ceiling} margin=${margin}`,
            );
            // (c) the binding flag is consistent.
            const profitCapPrice = plan.maxTotalFeeLamports
              .mul(new BN(MICRO_LAMPORTS_PER_LAMPORT))
              .div(new BN(cu));
            const expectedBinding = profitCapPrice.gt(new BN(ceiling))
              ? "charter-ceiling"
              : "profit-margin";
            assert.equal(plan.binding, expectedBinding);
          }
        }
      }
    }
  });

  test("zero expected profit yields a zero price (fail-closed, no free fees)", () => {
    const plan = derivePriorityFeePlan({
      expectedProfitLamports: new BN(0),
      computeUnitLimit: 200_000,
      protocolCeilingMicroLamportsPerCu: new BN(1_000_000_000),
    });
    assert.equal(plan.binding, "profit-margin");
    assert.equal(plan.maxTotalFeeLamports.isZero(), true);
    assert.equal(plan.maxMicroLamportsPerCu.isZero(), true);
  });

  test("zero ceiling yields a zero price (Charter forbids any priority fee)", () => {
    const plan = derivePriorityFeePlan({
      expectedProfitLamports: new BN(1_000_000_000),
      computeUnitLimit: 200_000,
      protocolCeilingMicroLamportsPerCu: new BN(0),
    });
    assert.equal(plan.binding, "charter-ceiling");
    assert.equal(plan.maxMicroLamportsPerCu.isZero(), true);
  });

  test("F1 regression: the legacy math permits an over-budget total fee at 1.4M CU", () => {
    // The deprecated helper returns margin × profit AS a per-CU price.
    // profit 2 SOL, margin 25% → X = 5e8, returned as "5e8 µL/CU". At a
    // 1.4M CU limit (a realistic size for the certify+salvage bundle)
    // that permits 5e8 × 1.4e6 = 7e14 µL = 0.7 SOL of total fees against
    // a budget of 0.5 SOL — a 40% overspend. The plan derives the price
    // from the budget instead.
    const profit = new BN(2_000_000_000);
    const legacy = computeOperationalMaxLamportsPerCu(profit, new BN(1_000_000_000), 0.25);
    assert.equal(legacy.toString(10), "500000000");
    const legacyTotalMicro = legacy.mul(new BN(1_400_000));
    assert.equal(legacyTotalMicro.toString(10), "700000000000000"); // 0.7 SOL
    const budgetMicro = new BN(500_000_000).mul(new BN(MICRO_LAMPORTS_PER_LAMPORT)); // 5e14
    assert.ok(legacyTotalMicro.gt(budgetMicro)); // the hole, demonstrated

    const plan = derivePriorityFeePlan({
      expectedProfitLamports: profit,
      computeUnitLimit: 1_400_000,
      protocolCeilingMicroLamportsPerCu: new BN(1_000_000_000),
      marginRatio: 0.25,
    });
    // budget 5e8 lamports = 5e14 µL; price = floor(5e14 / 1.4e6) = 357_142_857.
    assert.equal(plan.maxTotalFeeLamports.toString(10), "500000000");
    assert.equal(plan.maxMicroLamportsPerCu.toString(10), "357142857");
    // price × cuLimit = 499_999_999_800_000 ≤ 5e14 ✓.
    assert.equal(
      plan.maxMicroLamportsPerCu.mul(new BN(1_400_000)).toString(10),
      "499999999800000",
    );
    assert.ok(
      plan.maxMicroLamportsPerCu.mul(new BN(1_400_000)).lte(budgetMicro),
    );
  });

  test("input validation: margins, cuLimit, negative amounts", () => {
    const base = {
      expectedProfitLamports: new BN(1),
      computeUnitLimit: 200_000,
      protocolCeilingMicroLamportsPerCu: new BN(1_000),
    };
    assert.throws(() => derivePriorityFeePlan({ ...base, marginRatio: -0.1 }), RangeError);
    assert.throws(() => derivePriorityFeePlan({ ...base, marginRatio: 1.1 }), RangeError);
    assert.throws(() => derivePriorityFeePlan({ ...base, marginRatio: NaN }), RangeError);
    assert.throws(
      () => derivePriorityFeePlan({ ...base, computeUnitLimit: 0 }),
      RangeError,
    );
    assert.throws(
      () => derivePriorityFeePlan({ ...base, computeUnitLimit: 20_000.5 }),
      RangeError,
    );
    assert.throws(
      () =>
        derivePriorityFeePlan({
          ...base,
          expectedProfitLamports: new BN(-1),
        }),
      RangeError,
    );
    assert.throws(
      () =>
        derivePriorityFeePlan({
          ...base,
          protocolCeilingMicroLamportsPerCu: new BN(-5),
        }),
      RangeError,
    );
  });
});
