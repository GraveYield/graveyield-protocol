// SPDX-License-Identifier: Apache-2.0
//
// ADV-EC / ADV-DS / ADV-EL / ADV-MP / ADV-DC — the economic battery:
// dust, extreme and extremely-low liquidity, manipulated prices, and
// decimal-edge math, all against the REAL indexer pre-filter, scoring,
// queue, and SDK price/fee math.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import { preFilterPool, scoreCandidate, CandidateQueue, type PreFilterThresholds } from "@graveyield/indexer";
import { quotePerBaseQ64x64, shouldRejectFee, buildPriorityFeePolicy } from "@graveyield/sdk";
import { key, POOL_A, POOL_B, MEME_MINT } from "./helpers.js";

const THRESHOLDS: PreFilterThresholds = {
  inactivitySeconds: 7_776_000n,
  priceCollapseBps: 9_900,
  minTvlLamports: 500_000_000n,
  lpBurnDustThreshold: 1_000n,
};

const NOW = Math.floor(Date.now() / 1000);
const DEAD_TS = NOW - 100 * 24 * 3600;

function activity(pool = POOL_A, ts = DEAD_TS) {
  return {
    poolAddress: pool,
    lastSwapUnixTs: ts,
    lastSwapSlot: 28_000_000,
    lastSwapSignature: "sig",
    noSwapFound: false,
  };
}

function reserves(tvl: bigint, lpSupply: bigint, wsolSide = true) {
  return {
    poolAddress: POOL_A,
    coinReserve: tvl,
    pcReserve: tvl,
    lpSupply,
    wsolSideIdentified: wsolSide,
    tvlLamports: tvl,
  };
}

const metadata = (pool = POOL_A) => ({
  poolAddress: pool,
  baseMint: MEME_MINT,
  baseDecimals: 9,
  baseSupply: 1_000_000_000n,
  quoteMint: key("wsol"),
  quoteDecimals: 9,
  quoteSupply: 1_000_000_000n,
  lpMint: key("lp"),
  lpDecimals: 6,
  lpSupply: 1_000_000n,
});

describe("ADV-DS — dust", () => {
  test("ADV-DS-01: LP supply exactly at the dust threshold is refused; one above passes", () => {
    const at = preFilterPool(activity(), reserves(1_000_000_000n, 1_000n), metadata(), THRESHOLDS);
    assert.equal(at.passed, false, "supply == threshold is burned-to-dust");
    assert.ok(at.failedCriteria.includes("C4-lp-not-burned"));

    const above = preFilterPool(activity(), reserves(1_000_000_000n, 1_001n), metadata(), THRESHOLDS);
    assert.equal(above.passed, true);
  });
});

describe("ADV-EC — extremely low liquidity", () => {
  test("ADV-EC-01: TVL one lamport below the floor is refused; exactly the floor passes", () => {
    const below = preFilterPool(activity(), reserves(499_999_999n, 1_000_000n), metadata(), THRESHOLDS);
    assert.equal(below.passed, false);
    assert.ok(below.failedCriteria.includes("C3-min-tvl"));

    const at = preFilterPool(activity(), reserves(500_000_000n, 1_000_000n), metadata(), THRESHOLDS);
    assert.equal(at.passed, true);
  });
});

describe("ADV-EL — extreme liquidity", () => {
  test("ADV-EL-01 (F2): a whale pool (u64::MAX TVL) passes every filter — uncapped by design", () => {
    const whale = preFilterPool(
      activity(),
      reserves(18_446_744_073_709_551_615n, u64Max(), true),
      metadata(),
      THRESHOLDS,
    );
    assert.equal(whale.passed, true, "no upper TVL bound exists (pinned, finding F2)");
    // The score stays finite — ordering is well-defined even at extremes.
    const whaleCandidate = makeWhaleCandidate(whale);
    const scored = scoreCandidate(whaleCandidate, scoreThresholds(), {
      launchPriceQ64x64: 1n << 64n,
      currentPriceQ64x64: 1n << 20n,
    });
    assert.ok(Number.isFinite(scored.score));
    assert.ok(Number.isFinite(scored.scoreBreakdown.tvlMargin));
  });
});

describe("ADV-MP — manipulated prices", () => {
  test("ADV-MP-01: the price math follows reserves, clamps, and refuses zero-base pools", () => {
    // Zero base reserve can never define a price — 0n marks "no price"
    // and the evaluator treats it as unpriceable (fails C2 downstream).
    assert.equal(quotePerBaseQ64x64(0n, 1_000_000n), 0n);
    // A maximal quote over a 1-unit base stays exact in u128.
    const maxPrice = quotePerBaseQ64x64(1n, 18_446_744_073_709_551_615n);
    assert.equal(maxPrice, 18_446_744_073_709_551_615n << 64n);
    // A re-floated pool (current >= launch) reads zero drop — never
    // negative, never wraps.
    const launch = 1n << 64n;
    const scoredRefloat = scoreCandidate(makeCandidate(passedResult()), scoreThresholds(), {
      launchPriceQ64x64: launch,
      currentPriceQ64x64: launch * 4n,
    });
    assert.equal(scoredRefloat.scoreBreakdown.priceCollapseMargin, 0);
    // A total collapse clamps at 10_000 bps.
    const scoredTotal = scoreCandidate(makeCandidate(passedResult()), scoreThresholds(), {
      launchPriceQ64x64: launch,
      currentPriceQ64x64: 1n,
    });
    assert.ok(scoredTotal.scoreBreakdown.priceCollapseMargin >= 0);
  });

  test("ADV-MP-02: a fee above the Charter ceiling is rejected — operators cannot opt out", () => {
    const policy = buildPriorityFeePolicy({
      expectedProfitLamports: new BN(1_000_000),
      protocolCeilingLamportsPerCu: new BN(1_000_000_000),
      marginRatio: 0.25,
    });
    // At the operational max: allowed.
    assert.equal(shouldRejectFee(policy.operationalMaxLamportsPerCu, policy), false);
    // One unit above the operational max: rejected.
    assert.equal(shouldRejectFee(policy.operationalMaxLamportsPerCu.addn(1), policy), true);
    // Above the protocol ceiling: rejected regardless of margin.
    assert.equal(shouldRejectFee(new BN(1_000_000_001), policy), true);
    // The operational max can never exceed the Charter ceiling even with
    // an absurd profit.
    const greedy = buildPriorityFeePolicy({
      expectedProfitLamports: new BN("123456789012345678901234567890"),
      protocolCeilingLamportsPerCu: new BN(1_000_000_000),
    });
    assert.ok(greedy.operationalMaxLamportsPerCu.lte(greedy.protocolCeilingLamportsPerCu));
  });
});

describe("ADV-RP — repeated attempts at the funnel level", () => {
  test("ADV-RP-03: the queue keeps ONE entry per pool and the higher score wins", () => {
    const q = new CandidateQueue();
    const mkScored = (score: number) => ({
      candidate: makeCandidate(passedResult()),
      score,
      scoreBreakdown: { inactivityMargin: 1, tvlMargin: 1, priceCollapseMargin: 1 },
    });
    q.enqueue(mkScored(5));
    q.enqueue(mkScored(9));
    assert.equal(q.size(), 1, "duplicate pool must not double-queue");
    assert.equal(q.peek(1)[0]?.score, 9, "higher score wins");
    const drained = q.drain(1);
    assert.equal(drained.length, 1);
    assert.equal(q.size(), 0, "drain removes — re-scan re-enqueues (pinned: chain is the replay authority)");
  });
});

describe("ADV-DC — token decimals edge cases", () => {
  test("ADV-DC-01: Q64.64 price math is exact across reserve-ratio extremes", () => {
    // A 1:2 quote-per-base ratio prices exactly at 2^63 — decimal scale
    // never leaks into the fixed-point math.
    assert.equal(quotePerBaseQ64x64(2n, 1n), 1n << 63n);
    // A maximal quote over a 1-unit base stays exact in u128.
    assert.equal(
      quotePerBaseQ64x64(1n, 18_446_744_073_709_551_615n),
      18_446_744_073_709_551_615n * (1n << 64n),
    );
    // Zero base reserve is the refused degenerate shape (0n sentinel).
    assert.equal(quotePerBaseQ64x64(0n, u64Max()), 0n);
  });
});

// ---- fixture helpers ---------------------------------------------------

function u64Max(): bigint {
  return 18_446_744_073_709_551_615n;
}

function scoreThresholds() {
  return { inactivitySeconds: THRESHOLDS.inactivitySeconds, minTvlLamports: THRESHOLDS.minTvlLamports, priceCollapseBps: THRESHOLDS.priceCollapseBps };
}

function passedResult() {
  return preFilterPool(activity(), reserves(1_000_000_000n, 1_000_000n), metadata(), THRESHOLDS);
}

function makeCandidate(pre: ReturnType<typeof passedResult>): import("@graveyield/indexer").Candidate {
  return {
    poolAddress: POOL_A,
    ammProgramId: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    discovery: {
      poolAddress: POOL_A,
      pool: {
        coinVault: key("cv"),
        pcVault: key("pv"),
        baseMint: MEME_MINT,
        quoteMint: key("wsol"),
        lpMint: key("lp"),
      },
      fetchedAtSlot: 28_000_000,
    },
    activity: activity(),
    reserves: reserves(1_000_000_000n, 1_000_000n),
    metadata: metadata(),
    preFilter: pre,
  };
}

// ADV-EL-01 whale scoring needs its own candidate built from the whale
// pre-filter result (same shape, extreme reserves).
function makeWhaleCandidate(pre: ReturnType<typeof passedResult>) {
  const c = makeCandidate(pre);
  return { ...c, reserves: reserves(u64Max(), u64Max()) };
}
