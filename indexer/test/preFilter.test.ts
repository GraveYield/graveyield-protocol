// SPDX-License-Identifier: Apache-2.0
//
// Pre-filter tests — pin the six-criterion pre-filter against hand-derived
// vectors. The pre-filter is the indexer's wide funnel: it eliminates
// pools that obviously don't meet the criteria so the on-chain scanner
// (the narrow authority) only processes genuine candidates.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  preFilterPool,
  CRITERION_INACTIVITY,
  CRITERION_PRICE_COLLAPSE,
  CRITERION_MIN_TVL,
  CRITERION_LP_NOT_BURNED,
  CRITERION_NO_LOCK,
  CRITERION_EPOCH_CONFIRMED,
  ALL_CRITERIA_MASK,
  type PreFilterThresholds,
} from "../src/index.js";
import type { ActivityRecord, ReserveRecord, TokenMetadata } from "../src/index.js";

const POOL = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const BASE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const QUOTE_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const LP_MINT = new PublicKey("11111111111111111111111111111111");

const DEFAULT_THRESHOLDS: PreFilterThresholds = {
  inactivitySeconds: 7_776_000n, // 90 days
  priceCollapseBps: 9_900,
  minTvlLamports: 500_000_000n, // 0.5 SOL
  lpBurnDustThreshold: 1_000n,
};

function makeActivity(opts: { lastSwapUnixTs?: number; noSwapFound?: boolean }): ActivityRecord {
  return {
    poolAddress: POOL,
    lastSwapUnixTs: opts.lastSwapUnixTs ?? 0,
    lastSwapSlot: 0,
    lastSwapSignature: "",
    noSwapFound: opts.noSwapFound ?? false,
  };
}

function makeReserves(opts: { tvlLamports?: bigint; lpSupply?: bigint; wsolSide?: boolean }): ReserveRecord {
  return {
    poolAddress: POOL,
    coinReserve: opts.tvlLamports ?? 1_000_000_000n,
    pcReserve: opts.tvlLamports ?? 1_000_000_000n,
    lpSupply: opts.lpSupply ?? 1_000_000n,
    wsolSideIdentified: opts.wsolSide ?? true,
    tvlLamports: opts.tvlLamports ?? 1_000_000_000n,
  };
}

function makeMetadata(): TokenMetadata {
  return {
    poolAddress: POOL,
    baseMint: BASE_MINT,
    baseDecimals: 9,
    baseSupply: 1_000_000_000n,
    quoteMint: QUOTE_MINT,
    quoteDecimals: 6,
    quoteSupply: 1_000_000_000n,
    lpMint: LP_MINT,
    lpDecimals: 6,
    lpSupply: 1_000_000n,
  };
}

describe("preFilterPool — six criteria", () => {
  const ninetyDays = 7_776_000;
  const now = Math.floor(Date.now() / 1000);

  test("all six criteria pass → eligible (bitmap 0x3F)", () => {
    const activity = makeActivity({ lastSwapUnixTs: now - ninetyDays - 1 });
    const reserves = makeReserves({ tvlLamports: 1_000_000_000n, lpSupply: 1_000_000n, wsolSide: true });
    const metadata = makeMetadata();
    const result = preFilterPool(activity, reserves, metadata, DEFAULT_THRESHOLDS);
    assert.equal(result.passed, true);
    assert.equal(result.criteriaBitmap, ALL_CRITERIA_MASK);
    assert.equal(result.criteriaBitmap, 0x3f);
    assert.deepEqual(result.failedCriteria, []);
  });

  test("C1 inactivity fails when pool swapped recently", () => {
    const activity = makeActivity({ lastSwapUnixTs: now - 1000 }); // 1000s ago, not 90d
    const reserves = makeReserves({ tvlLamports: 1_000_000_000n, lpSupply: 1_000_000n });
    const result = preFilterPool(activity, reserves, makeMetadata(), DEFAULT_THRESHOLDS);
    assert.equal(result.passed, false);
    assert.ok(result.failedCriteria.includes("C1-inactivity"));
    assert.equal(result.criteriaBitmap & CRITERION_INACTIVITY, 0);
  });

  test("C1 inactivity passes when no swap found (treated as very old)", () => {
    const activity = makeActivity({ noSwapFound: true });
    const reserves = makeReserves({ tvlLamports: 1_000_000_000n, lpSupply: 1_000_000n });
    const result = preFilterPool(activity, reserves, makeMetadata(), DEFAULT_THRESHOLDS);
    assert.ok(result.criteriaBitmap & CRITERION_INACTIVITY);
  });

  test("C2 price collapse fails when no WSOL side", () => {
    const activity = makeActivity({ lastSwapUnixTs: now - ninetyDays - 1 });
    const reserves = makeReserves({ tvlLamports: 1_000_000_000n, lpSupply: 1_000_000n, wsolSide: false });
    const result = preFilterPool(activity, reserves, makeMetadata(), DEFAULT_THRESHOLDS);
    assert.equal(result.passed, false);
    assert.ok(result.failedCriteria.includes("C2-price-collapse"));
    assert.equal(result.criteriaBitmap & CRITERION_PRICE_COLLAPSE, 0);
  });

  test("C3 min TVL fails below threshold", () => {
    const activity = makeActivity({ lastSwapUnixTs: now - ninetyDays - 1 });
    const reserves = makeReserves({ tvlLamports: 100_000_000n, lpSupply: 1_000_000n }); // 0.1 SOL < 0.5 SOL
    const result = preFilterPool(activity, reserves, makeMetadata(), DEFAULT_THRESHOLDS);
    assert.equal(result.passed, false);
    assert.ok(result.failedCriteria.includes("C3-min-tvl"));
    assert.equal(result.criteriaBitmap & CRITERION_MIN_TVL, 0);
  });

  test("C3 min TVL passes at threshold", () => {
    const activity = makeActivity({ lastSwapUnixTs: now - ninetyDays - 1 });
    const reserves = makeReserves({ tvlLamports: 500_000_000n, lpSupply: 1_000_000n }); // exactly 0.5 SOL
    const result = preFilterPool(activity, reserves, makeMetadata(), DEFAULT_THRESHOLDS);
    assert.ok(result.criteriaBitmap & CRITERION_MIN_TVL);
  });

  test("C4 LP burned fails when supply <= dust threshold", () => {
    const activity = makeActivity({ lastSwapUnixTs: now - ninetyDays - 1 });
    const reserves = makeReserves({ tvlLamports: 1_000_000_000n, lpSupply: 500n }); // < 1000
    const result = preFilterPool(activity, reserves, makeMetadata(), DEFAULT_THRESHOLDS);
    assert.equal(result.passed, false);
    assert.ok(result.failedCriteria.includes("C4-lp-not-burned"));
    assert.equal(result.criteriaBitmap & CRITERION_LP_NOT_BURNED, 0);
  });

  test("C4 LP burned passes when supply > dust threshold", () => {
    const activity = makeActivity({ lastSwapUnixTs: now - ninetyDays - 1 });
    const reserves = makeReserves({ tvlLamports: 1_000_000_000n, lpSupply: 1_001n }); // > 1000
    const result = preFilterPool(activity, reserves, makeMetadata(), DEFAULT_THRESHOLDS);
    assert.ok(result.criteriaBitmap & CRITERION_LP_NOT_BURNED);
  });

  test("C5 no lock always passes in v1 (UNCX marker is a flag)", () => {
    const activity = makeActivity({ lastSwapUnixTs: now - ninetyDays - 1 });
    const reserves = makeReserves({ tvlLamports: 1_000_000_000n, lpSupply: 1_000_000n });
    const result = preFilterPool(activity, reserves, makeMetadata(), DEFAULT_THRESHOLDS);
    assert.ok(result.criteriaBitmap & CRITERION_NO_LOCK);
  });

  test("C6 epoch confirmed always passes in pre-filter (on-chain at Phase 2)", () => {
    const activity = makeActivity({ lastSwapUnixTs: now - ninetyDays - 1 });
    const reserves = makeReserves({ tvlLamports: 1_000_000_000n, lpSupply: 1_000_000n });
    const result = preFilterPool(activity, reserves, makeMetadata(), DEFAULT_THRESHOLDS);
    assert.ok(result.criteriaBitmap & CRITERION_EPOCH_CONFIRMED);
  });

  test("multiple criteria fail → all failures listed", () => {
    const activity = makeActivity({ lastSwapUnixTs: now - 100 }); // C1 fails
    const reserves = makeReserves({ tvlLamports: 100_000_000n, lpSupply: 500n, wsolSide: false }); // C2, C3, C4 fail
    const result = preFilterPool(activity, reserves, makeMetadata(), DEFAULT_THRESHOLDS);
    assert.equal(result.passed, false);
    assert.ok(result.failedCriteria.includes("C1-inactivity"));
    assert.ok(result.failedCriteria.includes("C2-price-collapse"));
    assert.ok(result.failedCriteria.includes("C3-min-tvl"));
    assert.ok(result.failedCriteria.includes("C4-lp-not-burned"));
  });
});
