// SPDX-License-Identifier: Apache-2.0
//
// Activity-indexer tests — Correction 001 §1: the legacy indexer must
// never convert incomplete last-swap evidence into `noSwapFound: true`
// (and the pre-filter must never pass C1 from an unresolved record).
//
// The fake connection serves the minimal surface `deriveLastSwapV4`
// touches (bounded signature scans, per-candidate transaction fetches,
// the pool AmmInfo) with the SDK's CANONICAL evidence requirements:
// SwapBaseIn tag (9), pool + both authoritative vaults in the instruction
// accounts, opposite nonzero vault movement, explicit `meta.err`, recorded
// inner instructions, `confirmationStatus: "finalized"`. Synthetic test
// fixtures only — the SDK's real-evidence fixtures (with documented
// provenance) live in graveyield-protocol sdk/test/fixtures/lastSwap.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";

import { RAYDIUM_V4_PROGRAM_ID, encodeBase58 } from "@graveyield/sdk";

import { ActivityIndexer, preFilterPool, type DiscoveredPool } from "../src/index.js";
import type { ActivityRecord } from "../src/index.js";

/** Canonical 752-byte AmmInfo size (SDK `RAYDIUM_V4_AMM_INFO_SIZE`). */
const AMM_INFO_SIZE = 752;

const POOL = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const AMM = RAYDIUM_V4_PROGRAM_ID;
const COIN_VAULT = new PublicKey(new Uint8Array(32).fill(0xc1));
const PC_VAULT = new PublicKey(new Uint8Array(32).fill(0xc2));
const NOW_SEC = Math.floor(Date.now() / 1000);

/** Canonical 752-byte AmmInfo skeleton with the authoritative vaults. */
function ammInfoBytes(): Uint8Array {
  const buf = new Uint8Array(AMM_INFO_SIZE);
  buf.set(COIN_VAULT.toBytes(), 336);
  buf.set(PC_VAULT.toBytes(), 368);
  return buf;
}

/** Raydium V4 instruction data for `tag` + 16 zero arg bytes. */
function v4TagData(tag: number): string {
  const data = new Uint8Array(17);
  data[0] = tag;
  return encodeBase58(data);
}

/** A getTransaction() response satisfying the canonical D4 classifier. */
function swapResponse(opts?: {
  tag?: number;
  err?: unknown;
  innerInstructions?: unknown;
}): unknown {
  return {
    slot: 900_000n,
    blockTime: BigInt(NOW_SEC - 100 * 86_400),
    transaction: {
      message: {
        getAccountKeys: () => ({
          keySegments: () => [[AMM, POOL, COIN_VAULT, PC_VAULT]],
        }),
        compiledInstructions: [
          {
            programIdIndex: 0,
            accountKeyIndexes: [1, 2, 3],
            data: v4TagData(opts?.tag ?? 9),
          },
        ],
      },
    },
    meta: {
      err: opts?.err ?? null,
      innerInstructions: opts?.innerInstructions ?? [],
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [
        { accountIndex: 2, uiTokenAmount: { amount: "1000000" } },
        { accountIndex: 3, uiTokenAmount: { amount: "100000" } },
      ],
      postTokenBalances: [
        { accountIndex: 2, uiTokenAmount: { amount: "1100000" } },
        { accountIndex: 3, uiTokenAmount: { amount: "90000" } },
      ],
    },
  };
}

interface FakeSig {
  signature: string;
  confirmationStatus?: string | null;
  blockTime?: number | null;
}

class FakeActivityRpc {
  scanCount = 0;
  constructor(private readonly sigs: FakeSig[]) {}
  asConnection(): Connection {
    return this as unknown as Connection;
  }
  async getSignaturesForAddress(
    _address: PublicKey,
    opts?: { limit?: number },
  ): Promise<
    Array<{
      signature: string;
      slot: bigint;
      blockTime: bigint | null;
      err: null;
      confirmationStatus: string | null;
    }>
  > {
    this.scanCount += 1;
    const limit = opts?.limit ?? this.sigs.length;
    return this.sigs.slice(0, limit).map((s, i) => ({
      signature: s.signature,
      slot: BigInt(900_000 - i),
      blockTime:
        s.blockTime === undefined
          ? BigInt(NOW_SEC - 100 * 86_400)
          : s.blockTime === null
            ? null
            : BigInt(s.blockTime),
      err: null,
      confirmationStatus: s.confirmationStatus ?? "finalized",
    }));
  }
  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    if (address.equals(POOL)) {
      return {
        lamports: 1_000_000,
        data: Buffer.from(ammInfoBytes()),
        owner: AMM,
        executable: false,
        rentEpoch: 0n,
      } as unknown as AccountInfo<Uint8Array>;
    }
    return null;
  }
}

/** Fake whose getTransaction serves responses per signature. */
class FakeRpcWithTx extends FakeActivityRpc {
  constructor(
    sigs: FakeSig[],
    private readonly responses: Map<string, unknown>,
  ) {
    super(sigs);
  }
  override async getTransaction(signature: string): Promise<unknown> {
    return this.responses.get(signature) ?? null;
  }
}

function discoveredPool(): DiscoveredPool {
  return {
    poolAddress: POOL,
    pool: {
      coinVault: COIN_VAULT,
      pcVault: PC_VAULT,
      baseMint: COIN_VAULT,
      quoteMint: PC_VAULT,
      lpMint: COIN_VAULT,
    },
    fetchedAtSlot: 0,
  };
}

const THRESHOLDS = {
  inactivitySeconds: 7_776_000n, // 90 days
  priceCollapseBps: 9_900,
  minTvlLamports: 500_000_000n,
  lpBurnDustThreshold: 1_000n,
};

describe("ActivityIndexer — Correction 001 §1 legacy contract", () => {
  test("verified swap → resolved record with the swap fields", async () => {
    const rpc = new FakeRpcWithTx(
      [{ signature: "SIG_VERIFIED" }],
      new Map([["SIG_VERIFIED", swapResponse()]]),
    );
    const indexer = new ActivityIndexer();
    const record = await indexer.indexActivity(rpc.asConnection(), discoveredPool());
    assert.equal(record.noSwapFound, false);
    assert.equal(record.unresolved, false);
    assert.equal(record.lastSwapSignature, "SIG_VERIFIED");
    assert.equal(record.lastSwapUnixTs, NOW_SEC - 100 * 86_400);
    assert.equal(indexer.size(), 1, "resolved evidence is cached");
  });

  test("definitive no_swap_in_scan → noSwapFound=true, unresolved=false", async () => {
    // Complete scan (1 < 1000 signatures), the only candidate is a deposit
    // (tag 3) with a RECORDED empty inner list → provably not a swap.
    const rpc = new FakeRpcWithTx(
      [{ signature: "SIG_DEPOSIT" }],
      new Map([["SIG_DEPOSIT", swapResponse({ tag: 3 })]]),
    );
    const indexer = new ActivityIndexer();
    const record = await indexer.indexActivity(rpc.asConnection(), discoveredPool());
    assert.equal(record.noSwapFound, true);
    assert.equal(record.unresolved, false);
  });

  test("incomplete evidence → unresolved record; NEVER noSwapFound:true", async () => {
    // SYNTHETIC (labeled): the newest candidate is non-finalized — the
    // scan cannot establish activity either way. Before Correction 001
    // this returned null and the legacy indexer set noSwapFound: true.
    const rpc = new FakeRpcWithTx(
      [{ signature: "SIG_CONFIRMED", confirmationStatus: "confirmed" }],
      new Map([["SIG_CONFIRMED", swapResponse()]]),
    );
    const indexer = new ActivityIndexer();
    const record = await indexer.indexActivity(rpc.asConnection(), discoveredPool());
    assert.equal(record.noSwapFound, false, "incomplete evidence is NOT a no-swap finding");
    assert.equal(record.unresolved, true);
    assert.equal(indexer.size(), 0, "unresolved evidence is not cached — the next cycle re-scans");
  });

  test("incomplete evidence cannot pass C1 in the eligibility pre-filter", async () => {
    const unresolved: ActivityRecord = {
      poolAddress: POOL,
      lastSwapUnixTs: 0,
      lastSwapSlot: 0,
      lastSwapSignature: "",
      noSwapFound: false,
      unresolved: true,
    };
    const result = preFilterPool(
      unresolved,
      {
        poolAddress: POOL,
        coinReserve: 1_000_000_000n,
        pcReserve: 1_000_000_000n,
        lpSupply: 1_000_000n,
        wsolSideIdentified: true,
        tvlLamports: 1_000_000_000n,
      },
      {
        poolAddress: POOL,
        baseMint: COIN_VAULT,
        baseDecimals: 9,
        baseSupply: 1_000_000n,
        quoteMint: PC_VAULT,
        quoteDecimals: 6,
        quoteSupply: 1_000_000n,
        lpMint: COIN_VAULT,
        lpSupply: 1_000_000n,
      },
      THRESHOLDS,
    );
    assert.equal(result.passed, false, "C1 must fail for unresolved evidence");
    assert.equal(result.criteriaBitmap & 0x01, 0, "C1 bit must not be set");
    assert.ok(result.failedCriteria.includes("C1-evidence-unresolved"));
  });

  test("non-evidence RPC failures propagate (they are not evidence states)", async () => {
    class ThrowingRpc extends FakeActivityRpc {
      override async getSignaturesForAddress(): Promise<never> {
        throw new Error("boom: RPC unreachable");
      }
    }
    const indexer = new ActivityIndexer();
    await assert.rejects(
      indexer.indexActivity(new ThrowingRpc([]).asConnection(), discoveredPool()),
      /boom/,
    );
  });
});
