// SPDX-License-Identifier: Apache-2.0
//
// ADV-ID — fake-derelict pools & active pools. The "dead" verdict is only
// as good as the binding between evidence and pool: these attacks try
// to make one pool's death certificate vouch for another, and to make
// an active pool read as dead. On-chain refusals (6027/6033/6001) are
// fork/host-proven; here the byte-level contract is pinned so the
// client cannot even assemble a mislabeled submission.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  buildAttestationMessage,
  parseAttestationMessage,
  buildLaunchPriceMessage,
  parseLaunchPriceMessage,
  ATTESTATION_MSG_LEN,
  LAUNCH_PRICE_MSG_LEN,
} from "@graveyield/sdk";
import { preFilterPool, type PreFilterThresholds } from "@graveyield/indexer";
import { key, synthAmmInfo, readPubkeyAt, POOL_A, POOL_B, MEME_MINT, SLOT_HASH, NOW } from "./helpers.js";

const THRESHOLDS: PreFilterThresholds = {
  inactivitySeconds: 7_776_000n,
  priceCollapseBps: 9_900,
  minTvlLamports: 500_000_000n,
  lpBurnDustThreshold: 1_000n,
};

describe("ADV-ID — fake-derelict pools", () => {
  test("ADV-ID-01: the 112-byte C1 message is immutably bound to (amm, pool)", () => {
    const ammA = key("amm-A");
    const msg = buildAttestationMessage({
      ammProgramId: ammA,
      poolAddress: POOL_A,
      lastSwapUnixTs: NOW - 100 * 24 * 3600,
      issuedSlot: 28_000_000,
      slotHash: SLOT_HASH,
    });
    assert.equal(msg.length, ATTESTATION_MSG_LEN);

    const parsed = parseAttestationMessage(msg);
    assert.ok(parsed.poolAddress.equals(POOL_A), "binding survives the round-trip");

    // The attack: re-label the message for pool B. Byte-level, this is a
    // DIFFERENT message — the oracle's signature no longer covers it, and
    // the on-chain binding check (params vs signed message) reverts 6027.
    const forged = Uint8Array.from(msg);
    forged.set(POOL_B.toBytes(), 32);
    const parsedForged = parseAttestationMessage(forged);
    assert.ok(parsedForged.poolAddress.equals(POOL_B));
    assert.ok(!parsedForged.poolAddress.equals(POOL_A));
    // The two messages are distinct at byte level — there is no way to
    // make one signature vouch for both pools.
    assert.notDeepEqual(Buffer.from(msg), Buffer.from(forged));
  });

  test("ADV-ID-02: C2 message mints are detectable against the live pool's own mints", () => {
    const amm = key("amm-id02");
    const pool = key("pool-id02");
    // The live pool (synthetic bytes) says: base = MEME, quote = WSOL-shape.
    const wsolShape = key("wsol-shape");
    const poolBytes = synthAmmInfo({
      coinVault: key("cv"),
      pcVault: key("pv"),
      coinMint: MEME_MINT,
      pcMint: wsolShape,
      lpMint: key("lp"),
    });
    // The pool's own mints, straight from its bytes (what the chain will
    // compare against — 6033 on-chain, byte-exact).
    const liveBase = readPubkeyAt(poolBytes, 400);
    const liveQuote = readPubkeyAt(poolBytes, 432);
    assert.ok(liveBase.equals(MEME_MINT));

    // The attack: a C2 message minted for a DIFFERENT token pair.
    const foreignMsg = buildLaunchPriceMessage({
      ammProgramId: amm,
      poolAddress: pool,
      baseMint: key("other-base"),
      quoteMint: key("other-quote"),
      firstSwapSlot: 27_000_000,
      firstSwapUnixTs: NOW - 120 * 24 * 3600,
      launchPriceQ64x64: 1n << 64n,
      issuedSlot: 28_000_000,
    });
    assert.equal(foreignMsg.length, LAUNCH_PRICE_MSG_LEN);
    const parsedForeign = parseLaunchPriceMessage(foreignMsg);
    // A client-side pre-submit check can detect the mismatch BEFORE the
    // chain does — the mints simply do not agree.
    assert.ok(!parsedForeign.baseMint.equals(liveBase));
    assert.ok(!parsedForeign.quoteMint.equals(liveQuote));
  });

  test("ADV-ID-03: a never-swapped pool passes the wide funnel but is pinned (chain refuses via C2)", () => {
    // noSwapFound = "no swap in the scan window" — the pre-filter treats
    // it as maximally dead (10x inactivity margin). This is PINNED: the
    // funnel is wide on purpose; the chain is the narrow authority.
    const activity = {
      poolAddress: POOL_A,
      lastSwapUnixTs: 0,
      lastSwapSlot: 0,
      lastSwapSignature: "",
      noSwapFound: true,
    };
    const reserves = {
      poolAddress: POOL_A,
      coinReserve: 5_000_000_000n,
      pcReserve: 5_000_000_000n,
      lpSupply: 1_000_000n,
      wsolSideIdentified: true,
      tvlLamports: 5_000_000_000n,
    };
    const metadata = {
      poolAddress: POOL_A,
      baseMint: MEME_MINT,
      baseDecimals: 9,
      baseSupply: 1_000_000_000n,
      quoteMint: key("wsol"),
      quoteDecimals: 9,
      quoteSupply: 1_000_000_000n,
      lpMint: key("lp"),
      lpDecimals: 6,
      lpSupply: 1_000_000n,
    };
    const result = preFilterPool(activity, reserves, metadata, THRESHOLDS);
    assert.equal(result.passed, true, "funnel passes a no-swap pool (pinned)");
    // The narrow authority: a pool that never swapped has NO launch price
    // record, so on-chain C2 refuses with 6002 LaunchPriceNotFound —
    // pinned by Rust ADV-FD-03. Nothing here can fake the missing price.
  });
});

describe("ADV-ID — active pools", () => {
  test("ADV-ID-04: a recently active pool fails the pre-filter with C1-inactivity", () => {
    const now = Math.floor(Date.now() / 1000);
    const activity = {
      poolAddress: POOL_B,
      lastSwapUnixTs: now - 3_600, // swapped 1h ago — very alive
      lastSwapSlot: 28_000_001,
      lastSwapSignature: "sig",
      noSwapFound: false,
    };
    const reserves = {
      poolAddress: POOL_B,
      coinReserve: 50_000_000_000n,
      pcReserve: 50_000_000_000n,
      lpSupply: 1_000_000n,
      wsolSideIdentified: true,
      tvlLamports: 50_000_000_000n,
    };
    const metadata = {
      poolAddress: POOL_B,
      baseMint: MEME_MINT,
      baseDecimals: 9,
      baseSupply: 1_000_000_000n,
      quoteMint: key("wsol"),
      quoteDecimals: 9,
      quoteSupply: 1_000_000_000n,
      lpMint: key("lp"),
      lpDecimals: 6,
      lpSupply: 1_000_000n,
    };
    const result = preFilterPool(activity, reserves, metadata, THRESHOLDS);
    assert.equal(result.passed, false);
    assert.ok(result.failedCriteria.includes("C1-inactivity"));
    // The pool is not queued: the bitmap is not the full mask.
    assert.notEqual(result.criteriaBitmap, 0x3f);
  });
});
