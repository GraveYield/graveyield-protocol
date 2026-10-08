// SPDX-License-Identifier: Apache-2.0
//
// Priority-fee policy + Charter guard tests. Pins the BN arithmetic,
// the ceiling cap, the `marginRatio` bounds, and the Charter-guard
// refusal semantics (the SDK must refuse to submit any tx whose
// compute_unit_price exceeds the on-chain ceiling even when the
// operator passes a bigger fee explicitly).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import {
  computeOperationalMaxLamportsPerCu,
  buildPriorityFeePolicy,
  shouldRejectFee,
  DEFAULT_MARGIN_RATIO,
} from "../src/index.js";

describe("computeOperationalMaxLamportsPerCu", () => {
  test("returns the scaled profit when below the ceiling", () => {
    const out = computeOperationalMaxLamportsPerCu(
      new BN(1_000_000),
      new BN(1_000_000_000),
      0.25,
    );
    // 1_000_000 * 0.25 = 250_000 < 1_000_000_000 ceiling
    assert.equal(out.toString(10), "250000");
  });

  test("caps at the Charter ceiling when scaled profit exceeds it", () => {
    const out = computeOperationalMaxLamportsPerCu(
      new BN(10_000_000_000), // 10 SOL expected profit
      new BN(1_000_000_000), // 1 SOL ceiling
      0.25,
    );
    assert.equal(out.toString(10), "1000000000"); // ceiling, not 2.5 SOL
  });

  test("marginRatio=0 yields 0", () => {
    const out = computeOperationalMaxLamportsPerCu(
      new BN(1_000_000),
      new BN(1_000_000_000),
      0,
    );
    assert.equal(out.toString(10), "0");
  });

  test("marginRatio=1 yields the full profit (capped at ceiling)", () => {
    const out = computeOperationalMaxLamportsPerCu(
      new BN(500_000_000),
      new BN(1_000_000_000),
      1.0,
    );
    assert.equal(out.toString(10), "500000000");
  });

  test("marginRatio out of [0,1] throws", () => {
    assert.throws(
      () => computeOperationalMaxLamportsPerCu(new BN(1), new BN(1), -0.1),
      /marginRatio/,
    );
    assert.throws(
      () => computeOperationalMaxLamportsPerCu(new BN(1), new BN(1), 1.5),
      /marginRatio/,
    );
    assert.throws(
      () => computeOperationalMaxLamportsPerCu(new BN(1), new BN(1), NaN),
      /marginRatio/,
    );
  });

  test("negative expectedProfitLamports throws", () => {
    assert.throws(
      () => computeOperationalMaxLamportsPerCu(new BN(-1), new BN(1_000_000), 0.25),
      /expectedProfitLamports/,
    );
  });

  test("BN overflow domain — large u64-sized amounts round-trip without throwing", () => {
    // The classic JS-number precision cliff: Number.MAX_SAFE_INTEGER
    // is ~9.0e15, reachable for real Solana lamport amounts. BN math
    // must not lose precision here.
    const large = new BN("9007199254740992"); // 2^53
    const ceiling = new BN("18446744073709551615"); // u64::MAX
    const out = computeOperationalMaxLamportsPerCu(large, ceiling, 0.25);
    // 9007199254740992 / 4 = 2251799813685248 (exact in bps math:
    // large * 2500 / 10000 = large / 4 — the bps quantization is lossless here)
    assert.equal(out.toString(10), "2251799813685248");
  });

  test("DEFAULT_MARGIN_RATIO is 0.25", () => {
    assert.equal(DEFAULT_MARGIN_RATIO, 0.25);
  });
});

describe("buildPriorityFeePolicy", () => {
  test("returns ceiling + operational max + margin ratio", () => {
    const policy = buildPriorityFeePolicy({
      expectedProfitLamports: new BN(1_000_000),
      protocolCeilingLamportsPerCu: new BN(1_000_000_000),
      marginRatio: 0.1,
    });
    assert.equal(policy.protocolCeilingLamportsPerCu.toString(10), "1000000000");
    assert.equal(policy.operationalMaxLamportsPerCu.toString(10), "100000");
    assert.equal(policy.marginRatio, 0.1);
  });

  test("defaults marginRatio to 0.25 when omitted", () => {
    const policy = buildPriorityFeePolicy({
      expectedProfitLamports: new BN(1_000_000),
      protocolCeilingLamportsPerCu: new BN(1_000_000_000),
    });
    assert.equal(policy.marginRatio, 0.25);
    assert.equal(policy.operationalMaxLamportsPerCu.toString(10), "250000");
  });
});

describe("shouldRejectFee", () => {
  const policy = {
    protocolCeilingLamportsPerCu: new BN(1_000_000_000),
    operationalMaxLamportsPerCu: new BN(250_000),
    marginRatio: 0.25,
  };

  test("accepts a fee at or below the operational max", () => {
    assert.equal(shouldRejectFee(new BN(100_000), policy), false);
    assert.equal(shouldRejectFee(new BN(250_000), policy), false);
  });

  test("rejects a fee above operational max but below ceiling", () => {
    assert.equal(shouldRejectFee(new BN(500_000), policy), true);
  });

  test("rejects a fee above the Charter ceiling", () => {
    assert.equal(shouldRejectFee(new BN(2_000_000_000), policy), true);
  });

  test("rejects a fee exactly at the ceiling (ceiling is exclusive for non-default ratios)", () => {
    // The operational max is 250_000; the ceiling is 1_000_000_000.
    // A fee at the ceiling exceeds the operational max → rejected.
    assert.equal(shouldRejectFee(new BN(1_000_000_000), policy), true);
  });
});

describe("Charter guard semantics (end-to-end)", () => {
  // Mirrors the README contract: "the SDK refuses to submit any tx whose
  // compute_unit_price would exceed the on-chain max_priority_fee_ceiling_lamports".
  test("a fee below the ceiling is accepted", () => {
    const ceiling = new BN(1_000_000_000);
    const policy = buildPriorityFeePolicy({
      expectedProfitLamports: ceiling,
      protocolCeilingLamportsPerCu: ceiling,
      marginRatio: 1.0, // operational == ceiling
    });
    assert.equal(shouldRejectFee(new BN(999_999_999), policy), false);
    assert.equal(shouldRejectFee(ceiling, policy), false);
  });

  test("a fee above the ceiling is rejected even when the operator explicitly raises it", () => {
    const ceiling = new BN(1_000_000_000);
    const policy = buildPriorityFeePolicy({
      expectedProfitLamports: ceiling,
      protocolCeilingLamportsPerCu: ceiling,
      marginRatio: 1.0,
    });
    // Operator tries to slip a 2 SOL/CU fee past the Charter — must reject.
    const overCeiling = new BN(2_000_000_000);
    assert.equal(shouldRejectFee(overCeiling, policy), true);
  });
});
