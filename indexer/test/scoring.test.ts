// SPDX-License-Identifier: Apache-2.0
//
// Scoring tests — pin the candidate scoring formula. The score is the
// product of the three quantitative margins (C1 inactivity, C3 TVL, C2
// price collapse). Higher score = higher priority for submission.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import { scoreCandidate } from "../src/index.js";
import type { Candidate } from "../src/index.js";

function makeCandidate(opts: {
  lastSwapUnixTs?: number;
  noSwapFound?: boolean;
  tvlLamports?: bigint;
  coinReserve?: bigint;
  pcReserve?: bigint;
}): Candidate {
  const pool = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  return {
    poolAddress: pool,
    ammProgramId: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    discovery: {
      poolAddress: pool,
      pool: {
        coinVault: PublicKey.default,
        pcVault: PublicKey.default,
        baseMint: PublicKey.default,
        quoteMint: PublicKey.default,
        lpMint: PublicKey.default,
      },
      fetchedAtSlot: 0,
    },
    activity: {
      poolAddress: pool,
      lastSwapUnixTs: opts.lastSwapUnixTs ?? 0,
      lastSwapSlot: 0,
      lastSwapSignature: "",
      noSwapFound: opts.noSwapFound ?? false,
    },
    reserves: {
      poolAddress: pool,
      coinReserve: opts.coinReserve ?? 1_000_000_000n,
      pcReserve: opts.pcReserve ?? 1_000_000_000n,
      lpSupply: 1_000_000n,
      wsolSideIdentified: true,
      tvlLamports: opts.tvlLamports ?? 1_000_000_000n,
    },
    metadata: {
      poolAddress: pool,
      baseMint: PublicKey.default, baseDecimals: 9, baseSupply: 1_000_000_000n,
      quoteMint: PublicKey.default, quoteDecimals: 6, quoteSupply: 1_000_000_000n,
      lpMint: PublicKey.default, lpDecimals: 6, lpSupply: 1_000_000n,
    },
    preFilter: { poolAddress: pool, passed: true, failedCriteria: [], criteriaBitmap: 0x3f },
  };
}

describe("scoreCandidate", () => {
  const thresholds = {
    inactivitySeconds: 7_776_000n, // 90 days
    minTvlLamports: 500_000_000n,
    priceCollapseBps: 9_900,
  };

  test("returns a score >= 0", () => {
    const c = makeCandidate({ lastSwapUnixTs: 0, tvlLamports: 1_000_000_000n });
    const scored = scoreCandidate(c, thresholds);
    assert.ok(scored.score >= 0);
    assert.ok(scored.scoreBreakdown.inactivityMargin > 0);
    assert.ok(scored.scoreBreakdown.tvlMargin > 0);
  });

  test("inactivity margin scales with elapsed time", () => {
    const now = Math.floor(Date.now() / 1000);
    const c90d = makeCandidate({ lastSwapUnixTs: now - 7_776_000 });
    const c180d = makeCandidate({ lastSwapUnixTs: now - 15_552_000 });
    const s90 = scoreCandidate(c90d, thresholds);
    const s180 = scoreCandidate(c180d, thresholds);
    assert.ok(s180.scoreBreakdown.inactivityMargin > s90.scoreBreakdown.inactivityMargin);
  });

  test("TVL margin scales with TVL", () => {
    const c = (tvl: bigint) => makeCandidate({ tvlLamports: tvl });
    const sLow = scoreCandidate(c(500_000_000n), thresholds); // exactly at threshold
    const sHigh = scoreCandidate(c(5_000_000_000n), thresholds); // 10x threshold
    assert.ok(sHigh.scoreBreakdown.tvlMargin > sLow.scoreBreakdown.tvlMargin);
    assert.equal(sLow.scoreBreakdown.tvlMargin, 1.0);
    assert.ok(sHigh.scoreBreakdown.tvlMargin > 1.0);
  });

  test("noSwapFound yields a very high inactivity margin", () => {
    const c = makeCandidate({ noSwapFound: true });
    const s = scoreCandidate(c, thresholds);
    assert.ok(s.scoreBreakdown.inactivityMargin >= 10); // 10x threshold
  });

  test("score is the product of the three margins", () => {
    const c = makeCandidate({ lastSwapUnixTs: 0, tvlLamports: 1_000_000_000n });
    const s = scoreCandidate(c, thresholds);
    const product =
      s.scoreBreakdown.inactivityMargin *
      s.scoreBreakdown.tvlMargin *
      s.scoreBreakdown.priceCollapseMargin;
    assert.ok(Math.abs(s.score - product) < 0.001);
  });
});
