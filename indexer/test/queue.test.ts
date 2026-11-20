// SPDX-License-Identifier: Apache-2.0
//
// Candidate queue tests — pin the priority queue's enqueue/drain/peek/
// deduplicate semantics. The queue orders scored candidates by score
// descending so the indexer submits the highest-priority candidates
// first.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import { CandidateQueue } from "../src/index.js";
import { WSOL_MINT } from "@graveyield/sdk";
import type { ScoredCandidate, Candidate } from "../src/index.js";

function makeCandidate(poolByte: number): Candidate {
  const pool = new PublicKey(new Uint8Array(32).fill(poolByte));
  return {
    poolAddress: pool,
    ammProgramId: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    discovery: {
      poolAddress: pool,
      pool: {
        coinVault: PublicKey.default,
        pcVault: PublicKey.default,
        // M1-eligible orientation (D-01): coin_mint non-WSOL, pc_mint WSOL.
        baseMint: new PublicKey(new Uint8Array(32).fill(0x13)),
        quoteMint: WSOL_MINT,
        lpMint: PublicKey.default,
      },
      fetchedAtSlot: 0,
    },
    activity: {
      poolAddress: pool,
      lastSwapUnixTs: 0,
      lastSwapSlot: 0,
      lastSwapSignature: "",
      noSwapFound: false,
      unresolved: false,
    },
    reserves: {
      poolAddress: pool,
      coinReserve: 0n,
      pcReserve: 0n,
      lpSupply: 0n,
      wsolSideIdentified: true,
      tvlLamports: 0n,
    },
    metadata: {
      poolAddress: pool,
      baseMint: PublicKey.default,
      baseDecimals: 0,
      baseSupply: 0n,
      quoteMint: PublicKey.default,
      quoteDecimals: 0,
      quoteSupply: 0n,
      lpMint: PublicKey.default,
      lpDecimals: 0,
      lpSupply: 0n,
    },
    preFilter: { poolAddress: pool, passed: true, failedCriteria: [], criteriaBitmap: 0x3f },
  };
}

function makeScored(poolByte: number, score: number): ScoredCandidate {
  return {
    candidate: makeCandidate(poolByte),
    score,
    scoreBreakdown: { inactivityMargin: 1, tvlMargin: 1, priceCollapseMargin: 1 },
  };
}

describe("CandidateQueue", () => {
  test("empty queue drains to empty array", () => {
    const q = new CandidateQueue();
    assert.deepEqual(q.drain(5), []);
    assert.equal(q.size(), 0);
  });

  test("enqueue + drain returns by score descending", () => {
    const q = new CandidateQueue();
    q.enqueue(makeScored(0x10, 1.0));
    q.enqueue(makeScored(0x20, 3.0));
    q.enqueue(makeScored(0x30, 2.0));
    const drained = q.drain(3);
    assert.equal(
      drained[0]!.candidate.poolAddress.toBase58(),
      new PublicKey(new Uint8Array(32).fill(0x20)).toBase58(),
    );
    assert.equal(
      drained[1]!.candidate.poolAddress.toBase58(),
      new PublicKey(new Uint8Array(32).fill(0x30)).toBase58(),
    );
    assert.equal(
      drained[2]!.candidate.poolAddress.toBase58(),
      new PublicKey(new Uint8Array(32).fill(0x10)).toBase58(),
    );
    assert.equal(q.size(), 0);
  });

  test("drain(n) returns only top N and leaves the rest", () => {
    const q = new CandidateQueue();
    q.enqueue(makeScored(0x10, 1.0));
    q.enqueue(makeScored(0x20, 3.0));
    q.enqueue(makeScored(0x30, 2.0));
    const drained = q.drain(2);
    assert.equal(drained.length, 2);
    assert.equal(q.size(), 1);
    assert.equal(q.drain(1)[0]!.score, 1.0);
  });

  test("duplicate pool address — higher score wins", () => {
    const q = new CandidateQueue();
    q.enqueue(makeScored(0x10, 1.0));
    q.enqueue(makeScored(0x10, 5.0)); // same pool, higher score
    q.enqueue(makeScored(0x10, 2.0)); // same pool, lower score (should not replace)
    assert.equal(q.size(), 1);
    const drained = q.drain(1);
    assert.equal(drained[0]!.score, 5.0);
  });

  test("peek does not remove from queue", () => {
    const q = new CandidateQueue();
    q.enqueue(makeScored(0x10, 1.0));
    q.enqueue(makeScored(0x20, 2.0));
    const peeked = q.peek(2);
    assert.equal(peeked.length, 2);
    assert.equal(q.size(), 2);
  });

  test("remove a specific pool", () => {
    const q = new CandidateQueue();
    const key = new PublicKey(new Uint8Array(32).fill(0x10)).toBase58();
    q.enqueue(makeScored(0x10, 1.0));
    q.enqueue(makeScored(0x20, 2.0));
    assert.equal(q.remove(key), true);
    assert.equal(q.size(), 1);
    assert.equal(q.has(key), false);
    assert.equal(q.remove("nonexistent"), false);
  });

  test("clear empties the queue", () => {
    const q = new CandidateQueue();
    q.enqueue(makeScored(0x10, 1.0));
    q.enqueue(makeScored(0x20, 2.0));
    q.clear();
    assert.equal(q.size(), 0);
  });
});

describe("CandidateQueue trust boundary — metadata screening only", () => {
  test("forged metadata claiming the M1-eligible orientation is ADMITTED (no on-chain verification here)", () => {
    // Honest boundary pin: CandidateQueue holds no RPC connection —
    // enqueue screens the discovery record's mint metadata only, so a
    // record forged to CLAIM the M1-eligible orientation (coin_mint
    // non-WSOL, pc_mint WSOL) while the actual on-chain account is
    // oriented differently IS admitted and occupies queue capacity.
    // The authoritative on-chain check is the submission gate
    // (submit.ts: fetchV4Pool + the shared predicate on the decoded
    // account); the end-to-end forged-metadata → submission-rejection
    // case is pinned in m1Sourcing.test.ts.
    const q = new CandidateQueue();
    // makeCandidate builds the CLAIMED M1-eligible orientation
    // (baseMint=0x13 non-WSOL, quoteMint=WSOL) — the forged shape.
    const admission = q.enqueue(makeScored(0x99, 9));
    assert.deepEqual(admission, { admitted: true });
    assert.equal(q.size(), 1);
    assert.equal(q.has(new PublicKey(new Uint8Array(32).fill(0x99)).toBase58()), true);
  });
});
