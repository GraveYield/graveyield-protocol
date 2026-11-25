// SPDX-License-Identifier: Apache-2.0
//
// Early-exit tests for `deriveLastSwapEvidenceV4` (Task: SDK last-swap
// early exit). Every scenario is run through BOTH `earlyExit: true`
// (default behavior) and `earlyExit: false` (exhaustive scan) and the
// evidence-bearing fields are asserted identical (parity):
//
//   status, lastSwap (deep), definitive, scan.reachedHistoryEnd,
//   scan.signaturesReturned, and the first N candidate records
//   (N = the truncated true-run's candidate count).
//
// The exhaustive mode is the reference implementation (byte-identical to
// the pre-early-exit scan); the true-run may only truncate `candidates`
// at the early-exit point — records that were never examined are "not
// examined", never "not swaps".

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  RAYDIUM_V4_PROGRAM_ID,
  deriveLastSwapEvidenceV4,
  type LastSwapEvidenceResult,
} from "../src/index.js";

import {
  COIN_VAULT,
  PC_VAULT,
  POOL,
  LastSwapFakeRpc,
  loadTxFixture,
  withV4InstructionData,
  v4TagData,
  type FakeCandidate,
} from "./lastSwapEvidenceFakeRpc.js";

// Real fixtures (fetched 2026-11-14 — see fixtures/lastSwap/PROVENANCE.md).
const swapV2Outer = loadTxFixture("tx_swap_base_in_v2_outer_legacy");
const swapV1Inner = loadTxFixture("tx_swap_base_in_inner_v1");

/** Real fixture response with its V4 instruction re-tagged as a deposit
 *  (tag 3) — provably NOT an economic swap (recorded inner instructions
 *  show no swap on this pool). */
function depositResponse(): Record<string, unknown> {
  return withV4InstructionData(swapV2Outer, v4TagData(3));
}

/** Real fixture response with its V4 instruction re-tagged as a withdraw
 *  (tag 4) — also provably not an economic swap. */
function withdrawResponse(): Record<string, unknown> {
  return withV4InstructionData(swapV1Inner, v4TagData(4));
}

/** SYNTHETIC (labeled): a well-formed response whose account-key
 *  resolution throws INSIDE classification — normalizeSwapCandidateTx
 *  calls `message.getAccountKeys({ accountKeysFromLookups })`, so a
 *  throwing resolution surfaces as the fail-closed
 *  `malformed_transaction_metadata` outcome (never a swap, never a
 *  non-swap). */
function accountKeyResolutionFailureResponse(): Record<string, unknown> {
  return {
    slot: BigInt(swapV2Outer.slot),
    blockTime: BigInt(swapV2Outer.blockTime),
    transaction: {
      message: {
        getAccountKeys: () => {
          throw new Error("simulated account-key resolution failure");
        },
        compiledInstructions: [],
      },
    },
    meta: {
      err: null,
      innerInstructions: [],
      loadedAddresses: null,
      preTokenBalances: null,
      postTokenBalances: null,
    },
  };
}

/** A unique-signature non-economic pad candidate sharing a deposit
 *  response (fake RPC keys candidates by signature string). */
function padCandidate(index: number, response: Record<string, unknown>): FakeCandidate {
  return { signature: `${swapV2Outer.signature}~pad${index}`, response };
}

/** The verified swap candidate (real fixture signature + response). */
function swapCandidate(): FakeCandidate {
  return { signature: swapV2Outer.signature, response: swapV2Outer.response };
}

/** Fake RPC that records the fetch attempt and then throws for the given
 *  signatures (the transaction cannot be fetched at all — the candidate
 *  must stay unresolved, never silently skipped). */
class FetchThrowingRpc extends LastSwapFakeRpc {
  constructor(
    candidates: FakeCandidate[],
    private readonly throwSignatures: ReadonlySet<string>,
  ) {
    super(candidates);
  }

  override async getTransaction(
    signature: string,
    opts?: { maxSupportedTransactionVersion?: number; commitment?: string },
  ): Promise<Record<string, unknown> | null> {
    if (this.throwSignatures.has(signature)) {
      // Record the failed fetch attempt, then simulate the RPC error.
      this.txFetches.push({
        signature,
        maxSupportedTransactionVersion: opts?.maxSupportedTransactionVersion,
        commitment: opts?.commitment,
      });
      throw new Error(`simulated RPC failure fetching ${signature}`);
    }
    return super.getTransaction(signature, opts);
  }
}

const VAULTS = { coinVault: COIN_VAULT, pcVault: PC_VAULT } as const;

interface RunResult {
  result: LastSwapEvidenceResult;
  rpc: LastSwapFakeRpc;
}

async function run(
  buildCandidates: () => FakeCandidate[],
  earlyExit: boolean,
  opts: { scanLimit?: number } = {},
): Promise<RunResult> {
  const rpc = new LastSwapFakeRpc(buildCandidates());
  const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL, {
    ...VAULTS,
    ...opts,
    earlyExit,
  });
  return { result, rpc };
}

/** Run one scenario in BOTH modes and assert the documented parity
 *  invariants. Returns both runs for scenario-specific assertions. */
async function runParity(
  buildCandidates: () => FakeCandidate[],
  opts: { scanLimit?: number } = {},
): Promise<{ early: RunResult; full: RunResult }> {
  const early = await run(buildCandidates, true, opts);
  const full = await run(buildCandidates, false, opts);

  assert.equal(early.result.status, full.result.status, "status must match across modes");
  assert.deepEqual(early.result.lastSwap, full.result.lastSwap, "lastSwap must match");
  assert.equal(early.result.definitive, full.result.definitive, "definitive must match");
  assert.equal(
    early.result.scan.reachedHistoryEnd,
    full.result.scan.reachedHistoryEnd,
    "reachedHistoryEnd must match",
  );
  assert.equal(
    early.result.scan.signaturesReturned,
    full.result.scan.signaturesReturned,
    "signaturesReturned must match",
  );
  // The true-run's candidates must be a prefix of the false-run's: the
  // first N records (N = truncated count) are identical — no record is
  // fabricated or reordered by early exit.
  const n = early.result.candidates.length;
  assert.deepEqual(
    early.result.candidates,
    full.result.candidates.slice(0, n),
    "examined candidate records must match the exhaustive scan's prefix",
  );
  return { early, full };
}

describe("last-swap evidence early exit (scan.stop-on-newest-verified)", () => {
  test("verified swap at the newest signature: exactly one transaction fetched, older candidates never examined", async () => {
    const build = () => [
      swapCandidate(), // index 0 — newest signature: verified swap
      padCandidate(1, depositResponse()),
      padCandidate(2, depositResponse()),
    ];
    const { early, full } = await runParity(build);

    assert.equal(early.result.status, "verified");
    assert.equal(early.result.definitive, true);
    assert.equal(early.result.scan.earlyExit, true, "the scan stopped at the verified swap");
    assert.equal(early.result.scan.candidatesExamined, 1);
    assert.equal(early.result.candidates.length, 1);
    assert.equal(early.rpc.txFetches.length, 1, "only the newest signature is fetched");
    assert.equal(early.rpc.txFetches[0]?.signature, swapV2Outer.signature);
    // Identical anchor in both modes.
    assert.deepEqual(early.result.lastSwap, full.result.lastSwap);
    assert.equal(full.result.lastSwap?.lastSwapUnixTs, swapV2Outer.blockTime);
    assert.equal(full.result.lastSwap?.signature, swapV2Outer.signature);
    // The exhaustive scan fetched everything (proves the savings).
    assert.equal(full.rpc.txFetches.length, 3);
    assert.equal(full.result.scan.earlyExit, false);
    assert.equal(full.result.scan.candidatesExamined, 3);
  });

  test("verified swap after several newer non-economic candidates: exits at the swap index (candidatesExamined = swapIndex + 1)", async () => {
    const NEWER_NON_ECONOMIC = 3;
    const build = () => [
      padCandidate(0, depositResponse()),
      padCandidate(1, depositResponse()),
      padCandidate(2, withdrawResponse()),
      swapCandidate(), // index 3 — the newest verified economic swap
      padCandidate(4, depositResponse()), // older — must never be fetched
      padCandidate(5, depositResponse()),
    ];
    const { early, full } = await runParity(build);

    assert.equal(early.result.status, "verified");
    assert.equal(early.result.scan.earlyExit, true);
    assert.equal(early.result.scan.candidatesExamined, NEWER_NON_ECONOMIC + 1);
    assert.equal(early.result.candidates.length, NEWER_NON_ECONOMIC + 1);
    assert.equal(early.rpc.txFetches.length, NEWER_NON_ECONOMIC + 1);
    // The older candidates were never fetched.
    const fetchedSigs = early.rpc.txFetches.map((f) => f.signature);
    assert.ok(!fetchedSigs.includes(`${swapV2Outer.signature}~pad4`));
    assert.ok(!fetchedSigs.includes(`${swapV2Outer.signature}~pad5`));
    assert.equal(full.rpc.txFetches.length, 6);
    // Verified anchor identical in both modes; parity asserted by runParity.
    assert.equal(early.result.lastSwap?.signature, swapV2Outer.signature);
    assert.equal(early.result.lastSwap?.lastSwapUnixTs, swapV2Outer.blockTime);
  });

  test("inactive pool whose last verified swap lies INSIDE the examined window (swap at index 20 of 100): fetches stop after the swap", async () => {
    const SWAP_INDEX = 20;
    const TOTAL = 100;
    const build = () =>
      Array.from({ length: TOTAL }, (_, i) =>
        i === SWAP_INDEX ? swapCandidate() : padCandidate(i, depositResponse()),
      );
    const { early, full } = await runParity(build);

    assert.equal(early.result.status, "verified");
    assert.equal(early.result.scan.earlyExit, true);
    assert.equal(early.result.scan.candidatesExamined, SWAP_INDEX + 1);
    assert.equal(early.rpc.txFetches.length, SWAP_INDEX + 1, "fetches stop after the swap");
    assert.equal(full.rpc.txFetches.length, TOTAL, "the exhaustive scan fetches all 100");
    assert.equal(early.result.lastSwap?.signature, swapV2Outer.signature);
    assert.deepEqual(early.result.lastSwap, full.result.lastSwap);
    assert.equal(full.result.scan.candidatesExamined, TOTAL);
    // reachedHistoryEnd is derived from the RPC response (identical in both).
    assert.equal(early.result.scan.reachedHistoryEnd, true);
  });

  test("an UNRESOLVED newer candidate (missing transaction data) BLOCKS the early exit: full scan runs, result incomplete in both modes", async () => {
    const build = () => [
      // Newest candidate: getTransaction misses → unresolved
      // transaction_data_missing. The stop rule must never fire.
      { signature: `${swapV2Outer.signature}~missing`, response: null, blockTime: 1_700_000_000 },
      swapCandidate(), // verified swap — but not provably the newest
      padCandidate(2, depositResponse()),
      padCandidate(3, depositResponse()),
    ];
    const { early, full } = await runParity(build);

    // Parity: incomplete + non-definitive in BOTH modes.
    assert.equal(early.result.status, "incomplete");
    assert.equal(full.result.status, "incomplete");
    assert.equal(early.result.definitive, false);
    assert.equal(full.result.definitive, false);
    assert.equal(early.result.lastSwap, null);
    // No early stop: every returned signature was examined.
    assert.equal(early.result.scan.earlyExit, false);
    assert.equal(early.result.scan.candidatesExamined, full.result.scan.signaturesReturned);
    assert.equal(early.rpc.txFetches.length, full.rpc.txFetches.length);
    // The blocking outcome itself.
    const first = early.result.candidates[0]?.outcome;
    assert.equal(first?.kind === "unresolved" ? first.reason : "", "transaction_data_missing");
  });

  test("a transaction-fetch FAILURE on a newer candidate is unresolved (transaction_data_missing-class), blocks, no early stop", async () => {
    const build = () => [
      padCandidate(0, depositResponse()), // fetch throws for this signature
      swapCandidate(),
      padCandidate(2, depositResponse()),
    ];
    const throwingRpc = (): FetchThrowingRpc =>
      new FetchThrowingRpc(build(), new Set([`${swapV2Outer.signature}~pad0`]));

    const earlyRpc = throwingRpc();
    const earlyResult = await deriveLastSwapEvidenceV4(
      earlyRpc.asConnection(),
      RAYDIUM_V4_PROGRAM_ID,
      POOL,
      { ...VAULTS, earlyExit: true },
    );
    const fullRpc = throwingRpc(false);
    const fullResult = await deriveLastSwapEvidenceV4(
      fullRpc.asConnection(),
      RAYDIUM_V4_PROGRAM_ID,
      POOL,
      { ...VAULTS, earlyExit: false },
    );

    // Parity.
    assert.equal(earlyResult.status, fullResult.status);
    assert.equal(earlyResult.status, "incomplete");
    assert.deepEqual(earlyResult.lastSwap, fullResult.lastSwap);
    assert.equal(earlyResult.definitive, false);
    assert.equal(fullResult.definitive, false);
    assert.equal(earlyResult.scan.reachedHistoryEnd, fullResult.scan.reachedHistoryEnd);
    assert.equal(earlyResult.scan.signaturesReturned, fullResult.scan.signaturesReturned);
    assert.deepEqual(earlyResult.candidates, fullResult.candidates);
    // No early stop; the failed fetch is recorded as unresolved evidence.
    assert.equal(earlyResult.scan.earlyExit, false);
    assert.equal(earlyResult.scan.candidatesExamined, earlyResult.scan.signaturesReturned);
    const first = earlyResult.candidates[0]?.outcome;
    assert.equal(first?.kind === "unresolved" ? first.reason : "", "transaction_data_missing");
    assert.equal(earlyRpc.txFetches.length, 3);
    assert.equal(fullRpc.txFetches.length, 3);
  });

  test("a MALFORMED newer candidate (account-key resolution throws inside classification) is unresolved and blocks the early exit", async () => {
    const build = () => [
      {
        signature: `${swapV2Outer.signature}~malformed`,
        response: accountKeyResolutionFailureResponse(),
      },
      swapCandidate(),
      padCandidate(2, depositResponse()),
    ];
    const { early, full } = await runParity(build);

    const first = early.result.candidates[0]?.outcome;
    assert.equal(first?.kind === "unresolved" ? first.reason : "", "malformed_transaction_metadata");
    // Newer unresolved candidate ⇒ incomplete in BOTH modes (parity is
    // asserted by runParity before these scenario-specific checks).
    assert.equal(early.result.status, "incomplete");
    assert.equal(full.result.status, "incomplete");
    assert.equal(early.result.definitive, false);
    assert.equal(full.result.definitive, false);
    assert.equal(early.result.scan.earlyExit, false, "no early stop while a newer candidate is unresolved");
    assert.equal(early.result.scan.candidatesExamined, early.result.scan.signaturesReturned);
    assert.equal(early.rpc.txFetches.length, full.rpc.txFetches.length);
  });

  test("no verified swap in the window: no early exit, identical fetch counts (no savings when nothing is verified), no_swap_in_scan", async () => {
    const build = () => [
      padCandidate(0, depositResponse()),
      padCandidate(1, withdrawResponse()),
      padCandidate(2, depositResponse()),
      padCandidate(3, depositResponse()),
    ];
    const { early, full } = await runParity(build);

    assert.equal(early.result.status, "no_swap_in_scan");
    assert.equal(full.result.status, "no_swap_in_scan");
    assert.equal(early.result.definitive, true);
    assert.equal(early.result.scan.earlyExit, false, "the loop ran fully — nothing to stop at");
    assert.equal(early.result.scan.candidatesExamined, 4);
    assert.equal(
      early.rpc.txFetches.length,
      full.rpc.txFetches.length,
      "identical fetch counts prove early exit never saves work without a verified swap",
    );
    assert.equal(early.result.scan.reachedHistoryEnd, true);
  });

  test("bounded scan not reaching history end with no verified swap: incomplete in both modes, no early exit", async () => {
    const build = () => [
      padCandidate(0, depositResponse()),
      padCandidate(1, depositResponse()),
      padCandidate(2, depositResponse()),
      padCandidate(3, depositResponse()),
      padCandidate(4, depositResponse()),
    ];
    const { early, full } = await runParity(build, { scanLimit: 3 });

    assert.equal(early.result.scan.signaturesReturned, 3);
    assert.equal(early.result.scan.reachedHistoryEnd, false);
    assert.equal(early.result.status, "incomplete");
    assert.equal(full.result.status, "incomplete");
    assert.equal(early.result.definitive, false);
    assert.equal(full.result.definitive, false);
    assert.equal(early.result.scan.earlyExit, false);
    assert.equal(early.result.scan.candidatesExamined, 3);
    assert.equal(early.rpc.txFetches.length, full.rpc.txFetches.length);
  });

  test("candidate ordering after early exit: strictly newest-first, verified swap is the LAST record of the truncated array", async () => {
    const build = () => [
      padCandidate(0, depositResponse()),
      padCandidate(1, withdrawResponse()),
      padCandidate(2, depositResponse()),
      swapCandidate(), // index 3
      padCandidate(4, depositResponse()),
      padCandidate(5, depositResponse()),
    ];
    const { early } = await runParity(build);

    assert.equal(early.result.scan.earlyExit, true);
    assert.equal(early.result.candidates.length, 4);
    // RPC order preserved: the examined prefix is exactly the newest-first
    // signature list's first four entries.
    const expectedSigs = [
      `${swapV2Outer.signature}~pad0`,
      `${swapV2Outer.signature}~pad1`,
      `${swapV2Outer.signature}~pad2`,
      swapV2Outer.signature,
    ];
    assert.deepEqual(
      early.result.candidates.map((c) => c.signature),
      expectedSigs,
    );
    // The verified candidate is the last record of the truncated array.
    const last = early.result.candidates[3]?.outcome;
    assert.equal(last?.kind, "verified_swap");
    assert.equal(early.result.lastSwap?.signature, early.result.candidates[3]?.signature);
  });

  test("default options early-exit: calling WITHOUT opts stops at the verified swap (fetch-count savings visible vs earlyExit: false)", async () => {
    const build = () => [
      padCandidate(0, depositResponse()),
      padCandidate(1, depositResponse()),
      swapCandidate(), // index 2
      padCandidate(3, depositResponse()),
      padCandidate(4, depositResponse()),
    ];

    // NO opts at all — early exit must be the default. The pool AmmInfo is
    // fetched from the fake's pool-account fixture (no vault overrides).
    const defaultRpc = new LastSwapFakeRpc(build());
    const defaultResult = await deriveLastSwapEvidenceV4(
      defaultRpc.asConnection(),
      RAYDIUM_V4_PROGRAM_ID,
      POOL,
    );
    const fullRpc = new LastSwapFakeRpc(build());
    const fullResult = await deriveLastSwapEvidenceV4(
      fullRpc.asConnection(),
      RAYDIUM_V4_PROGRAM_ID,
      POOL,
      { ...VAULTS, earlyExit: false },
    );

    assert.equal(defaultResult.status, "verified");
    assert.equal(defaultResult.scan.earlyExit, true, "early exit is the default behavior");
    assert.equal(defaultResult.scan.candidatesExamined, 3);
    assert.equal(defaultRpc.txFetches.length, 3);
    assert.equal(fullRpc.txFetches.length, 5, "the exhaustive scan fetches all five");
    assert.equal(fullResult.scan.earlyExit, false);
    // Evidence parity: the default run's verified anchor matches the
    // exhaustive scan's.
    assert.deepEqual(defaultResult.lastSwap, fullResult.lastSwap);
    assert.equal(defaultResult.definitive, fullResult.definitive);
    assert.deepEqual(
      defaultResult.candidates,
      fullResult.candidates.slice(0, defaultResult.candidates.length),
    );
  });
});
