// SPDX-License-Identifier: Apache-2.0
//
// Canonical Raydium V4 last-swap evidence tests (IMPL-001, spec D4/D5 —
// Deliverable 3 §6-§8). Real mainnet fixtures + labeled synthetic
// mutations (see fixtures/lastSwap/PROVENANCE.md).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { PublicKey } from "@solana/web3.js";

import {
  RAYDIUM_V4_PROGRAM_ID,
  decodeBase58,
  decodeInstructionData,
  encodeBase58,
  deriveLastSwapEvidenceV4,
  deriveLastSwapV4,
} from "../src/index.js";

import {
  COIN_VAULT,
  LastSwapFakeRpc,
  PC_VAULT,
  POOL,
  loadPoolAccountBytes,
  loadTxFixture,
  withMetaRemoved,
  withOobProgramIdIndex,
  withSwapAccountsInLoadedKeys,
  withTokenBalancesRemoved,
  withV4InstructionData,
  withV4ProgramReplaced,
  withVaultDeltasZeroed,
  withVaultsRemovedFromAccounts,
  v4TagData,
} from "./lastSwapEvidenceFakeRpc.js";

// Real fixtures (fetched 2026-11-14 — see PROVENANCE.md).
const swapV2Outer = loadTxFixture("tx_swap_base_in_v2_outer_legacy");
const swapV1Inner = loadTxFixture("tx_swap_base_in_inner_v1");
const swapV2InnerV1 = loadTxFixture("tx_swap_base_in_v2_inner_v1");
const failedSwap = loadTxFixture("tx_failed_swap_inner_v1");
const swapV0Alt = loadTxFixture("tx_swap_v0_alt_lookup");

const CAND = (tx: ReturnType<typeof loadTxFixture>, overrides = {}) => ({
  signature: tx.signature,
  response: tx.response,
  ...overrides,
});

describe("base58 codec (instruction-data surface)", () => {
  test("round-trips bytes through encode/decode", () => {
    const bytes = new Uint8Array([9, 0, 0, 0, 255, 1, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0]);
    assert.deepEqual(Array.from(decodeBase58(encodeBase58(bytes))), Array.from(bytes));
  });

  test("decodes leading zeros ('1' padding)", () => {
    const bytes = new Uint8Array([0, 0, 5]);
    const encoded = encodeBase58(bytes);
    assert.ok(encoded.startsWith("11"));
    assert.deepEqual(Array.from(decodeBase58(encoded)), Array.from(bytes));
  });

  test("decodes the REAL inner-instruction payload of the v1 swap fixture to tag 9", () => {
    const fx = swapV1Inner.response as {
      meta: {
        innerInstructions: Array<{ instructions: Array<{ programIdIndex: number; data: string }> }>;
      };
    };
    const innerData = fx.meta.innerInstructions
      .flatMap((set) => set.instructions)
      .filter((ix) => swapV1Inner.accountKeys[ix.programIdIndex]?.equals(RAYDIUM_V4_PROGRAM_ID))
      .map((ix) => ix.data)[0];
    assert.equal(typeof innerData, "string");
    const decoded = decodeInstructionData(innerData);
    assert.equal(decoded[0], 9);
    assert.equal(decoded.length, 17);
  });
});

describe("D4 classification — verified economic swaps (real fixtures)", () => {
  test("direct SwapBaseInV2 (tag 16, legacy transaction) verifies", async () => {
    const rpc = new LastSwapFakeRpc([CAND(swapV2Outer)]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL, {
      coinVault: COIN_VAULT,
      pcVault: PC_VAULT,
    });
    assert.equal(result.status, "verified");
    assert.equal(result.definitive, true);
    assert.equal(result.lastSwap?.signature, swapV2Outer.signature);
    assert.equal(result.lastSwap?.lastSwapUnixTs, swapV2Outer.blockTime);
    assert.equal(result.candidates[0]?.outcome.kind, "verified_swap");
    assert.equal(
      result.candidates[0]?.outcome.kind === "verified_swap"
        ? result.candidates[0].outcome.tag
        : null,
      "swapBaseInV2",
    );
    assert.equal(
      result.candidates[0]?.outcome.kind === "verified_swap"
        ? result.candidates[0].outcome.routedViaInnerInstruction
        : null,
      false,
    );
  });

  test("SwapBaseIn (tag 9) routed as an inner CPI inside a version-1 transaction verifies", async () => {
    const rpc = new LastSwapFakeRpc([CAND(swapV1Inner)]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.status, "verified");
    assert.equal(result.lastSwap?.lastSwapUnixTs, swapV1Inner.blockTime);
    const outcome = result.candidates[0]?.outcome;
    assert.equal(outcome?.kind, "verified_swap");
    assert.equal(outcome?.kind === "verified_swap" ? outcome.tag : "", "swapBaseIn");
    assert.equal(
      outcome?.kind === "verified_swap" ? outcome.routedViaInnerInstruction : null,
      true,
    );
  });

  test("version-1 transaction with an inner SwapBaseInV2 verifies", async () => {
    const rpc = new LastSwapFakeRpc([CAND(swapV2InnerV1)]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.status, "verified");
  });

  test("ALT-loaded account keys resolve through accountKeysFromLookups (labeled synthetic v0 view)", async () => {
    // The real swap's accounts re-mapped into the ALT-loaded segment; the
    // old implementation (getAccountKeys() without lookups) misresolved
    // exactly this shape. See PROVENANCE.md "synthetic cases".
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { response: withSwapAccountsInLoadedKeys(swapV2Outer) }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.status, "verified", "pool + vaults in the loaded segment must resolve");
    assert.equal(result.candidates[0]?.outcome.kind, "verified_swap");
  });

  test("REAL version-0 + ALT transaction touching the pool via a non-AMM program is not a swap", async () => {
    // tx_swap_v0_alt_lookup: genuine mainnet v0 transaction with 1 ALT lookup
    // (6 writable + 13 readonly loaded keys) whose pool reference belongs to
    // program 6Vo3245e... — the AMM program never invokes this pool.
    const rpc = new LastSwapFakeRpc([CAND(swapV0Alt)]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.status, "no_swap_in_scan");
    assert.equal(
      result.candidates[0]?.outcome.kind === "not_economic_swap"
        ? result.candidates[0].outcome.reason
        : "",
      "pool_not_invoked_by_amm_program",
    );
  });

  test("deriveLastSwapV4 keeps its contract: derivation for verified, null otherwise", async () => {
    const ok = new LastSwapFakeRpc([CAND(swapV2Outer)]);
    const derivation = await deriveLastSwapV4(ok.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(derivation?.lastSwapUnixTs, swapV2Outer.blockTime);
    assert.equal(derivation?.signature, swapV2Outer.signature);

    const blocked = new LastSwapFakeRpc([CAND(swapV2Outer, { confirmationStatus: "confirmed" })]);
    assert.equal(await deriveLastSwapV4(blocked.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL), null);
  });
});

describe("D4 classification — non-economic V4 interactions must not reset inactivity", () => {
  // Synthetic mutations of the real swap fixture: same accounts, different
  // canonical instruction tag (PROVENANCE.md "synthetic cases").
  const liquidityCases: Array<[number, string]> = [
    [3, "liquidity_addition"],
    [4, "liquidity_removal"],
  ];
  for (const [tag, reason] of liquidityCases) {
    test(`tag ${tag} classifies as ${reason} (never a swap)`, async () => {
      const rpc = new LastSwapFakeRpc([
        CAND(swapV2Outer, { response: withV4InstructionData(swapV2Outer, v4TagData(tag)) }),
      ]);
      const result = await deriveLastSwapEvidenceV4(
        rpc.asConnection(),
        RAYDIUM_V4_PROGRAM_ID,
        POOL,
      );
      assert.equal(result.lastSwap, null);
      assert.equal(result.status, "no_swap_in_scan");
      assert.equal(result.definitive, true);
      assert.equal(result.candidates[0]?.outcome.kind, "not_economic_swap");
      assert.equal(
        result.candidates[0]?.outcome.kind === "not_economic_swap"
          ? result.candidates[0].outcome.reason
          : "",
        reason,
      );
    });
  }

  const adminCases: Array<[number, string]> = [
    [6, "administrative_operation"], // SetParams
    [7, "administrative_operation"], // WithdrawPnl
    [14, "administrative_operation"], // CreateConfigAccount
    [15, "administrative_operation"], // UpdateConfigAccount
    [18, "administrative_operation"], // WithdrawExcessLamports
  ];
  for (const [tag, reason] of adminCases) {
    test(`admin/upkeep tag ${tag} classifies as ${reason}`, async () => {
      const rpc = new LastSwapFakeRpc([
        CAND(swapV2Outer, { response: withV4InstructionData(swapV2Outer, v4TagData(tag)) }),
      ]);
      const result = await deriveLastSwapEvidenceV4(
        rpc.asConnection(),
        RAYDIUM_V4_PROGRAM_ID,
        POOL,
      );
      assert.equal(result.candidates[0]?.outcome.kind, "not_economic_swap");
      assert.equal(
        result.candidates[0]?.outcome.kind === "not_economic_swap"
          ? result.candidates[0].outcome.reason
          : "",
        reason,
      );
    });
  }

  test("pool initialization (Initialize2, tag 1) does not reset inactivity", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { response: withV4InstructionData(swapV2Outer, v4TagData(1)) }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "not_economic_swap"
        ? result.candidates[0].outcome.reason
        : "",
      "pool_initialization",
    );
    assert.equal(result.lastSwap, null);
  });

  test("a transaction that does not invoke the AMM program on this pool is not a swap", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { response: withV4ProgramReplaced(swapV2Outer) }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "not_economic_swap"
        ? result.candidates[0].outcome.reason
        : "",
      "pool_not_invoked_by_amm_program",
    );
    assert.equal(result.status, "no_swap_in_scan");
  });

  test("a REAL failed transaction (meta.err != null) never resets inactivity", async () => {
    assert.notEqual(failedSwap.err, null, "fixture must be a genuinely failed transaction");
    const rpc = new LastSwapFakeRpc([CAND(failedSwap)]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.lastSwap, null);
    assert.equal(
      result.candidates[0]?.outcome.kind === "not_economic_swap"
        ? result.candidates[0].outcome.reason
        : "",
      "failed_transaction",
    );
  });
});

describe("D5 finalized-only evidence", () => {
  test("a non-finalized signature is excluded and recorded, not treated as a swap or as inactivity", async () => {
    const rpc = new LastSwapFakeRpc([CAND(swapV2Outer, { confirmationStatus: "confirmed" })]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.lastSwap, null);
    assert.equal(result.status, "incomplete");
    assert.equal(result.definitive, false);
    assert.equal(result.candidates[0]?.confirmationStatus, "confirmed");
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "signature_not_finalized",
    );
  });

  test("the optional finalized depth margin excludes candidates inside the margin", async () => {
    const slot = 900_000;
    const rpc = new LastSwapFakeRpc([CAND(swapV2Outer, { slot })]);
    // Inside the margin: slot > finalizedSlot - depth (900000 > 900008 - 32).
    rpc.finalizedSlot = slot + 8;
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL, {
      finalizedDepthSlots: 32,
    });
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "signature_not_finalized",
    );
    // Outside the margin the same candidate verifies.
    rpc.finalizedSlot = slot + 64;
    const ok = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL, {
      finalizedDepthSlots: 32,
    });
    assert.equal(ok.status, "verified");
  });

  test("missing transaction data stays unresolved", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { response: null, blockTime: swapV2Outer.blockTime }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "transaction_data_missing",
    );
    assert.equal(result.status, "incomplete");
  });

  test("missing block time stays unresolved (never silently skipped)", async () => {
    const rpc = new LastSwapFakeRpc([CAND(swapV2Outer, { blockTime: null })]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "block_time_missing",
    );
    assert.equal(result.status, "incomplete");
    assert.equal(result.candidates[0]?.blockTime, null);
  });

  test("invalid block time (far future) stays unresolved", async () => {
    const future = Math.floor(Date.now() / 1000) + 100_000;
    const rpc = new LastSwapFakeRpc([CAND(swapV2Outer, { blockTime: future })]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "block_time_invalid",
    );
  });

  test("missing transaction metadata stays unresolved", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { response: withMetaRemoved(swapV2Outer) }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "transaction_meta_missing",
    );
  });
});

describe("D4 fail-closed evidence (ambiguous, conflicting, incomplete, malformed)", () => {
  test("unknown AMM instruction tag is ambiguous evidence (fail-closed)", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { response: withV4InstructionData(swapV2Outer, v4TagData(200)) }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "ambiguous_evidence",
    );
    assert.equal(result.status, "incomplete");
  });

  test("a removed tag (MonitorStep, 2) inside a successful tx is contradictory evidence", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { response: withV4InstructionData(swapV2Outer, v4TagData(2)) }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "ambiguous_evidence",
    );
  });

  test("swap-tagged instruction without opposite-direction vault movement conflicts", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { response: withVaultDeltasZeroed(swapV2Outer) }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "conflicting_evidence",
    );
  });

  test("swap-tagged instruction that does not reference the pool vaults conflicts", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { response: withVaultsRemovedFromAccounts(swapV2Outer) }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "conflicting_evidence",
    );
  });

  test("missing token balance data is an incomplete RPC response (never a swap)", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { response: withTokenBalancesRemoved(swapV2Outer) }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "incomplete_rpc_response",
    );
  });

  test("out-of-bounds program-id index is malformed metadata (fail-closed)", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { response: withOobProgramIdIndex(swapV2Outer) }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "malformed_transaction_metadata",
    );
  });

  test("unavailable pool AmmInfo fails swap corroboration closed", async () => {
    const rpc = new LastSwapFakeRpc([CAND(swapV2Outer)], { poolAccountData: null });
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.lastSwap, null);
    assert.equal(result.status, "incomplete");
    assert.equal(
      result.candidates[0]?.outcome.kind === "unresolved"
        ? result.candidates[0].outcome.reason
        : "",
      "pool_vaults_unavailable",
    );
  });

  test("explicit vault overrides work without a pool-account fetch", async () => {
    const rpc = new LastSwapFakeRpc([CAND(swapV2Outer)], { poolAccountData: null });
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL, {
      coinVault: COIN_VAULT,
      pcVault: PC_VAULT,
    });
    assert.equal(result.status, "verified");
  });
});

describe("candidate selection and completeness", () => {
  const depositTx = { response: withV4InstructionData(swapV2Outer, v4TagData(3)) };

  test("selects the newest verified economic swap among multiple candidates", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV1Inner), // newest — verified swap (tag 9)
      CAND(swapV2Outer), // older — verified swap (tag 16)
      CAND(failedSwap), // oldest — failed
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.status, "verified");
    assert.equal(result.lastSwap?.signature, swapV1Inner.signature);
    assert.equal(result.candidates.length, 3);
  });

  test("a newer liquidity operation does not hide an older verified swap", async () => {
    const rpc = new LastSwapFakeRpc([
      { signature: swapV2Outer.signature, response: depositTx.response },
      CAND(swapV1Inner),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.status, "verified");
    assert.equal(result.lastSwap?.signature, swapV1Inner.signature);
  });

  test("an unresolved candidate NEWER than the verified swap makes the result incomplete", async () => {
    const rpc = new LastSwapFakeRpc([
      CAND(swapV2Outer, { confirmationStatus: "confirmed" }), // newest — unresolved
      CAND(swapV1Inner), // verified swap, but not provably the newest
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.status, "incomplete");
    assert.equal(result.lastSwap, null, "no inactivity claim may rest on blocked evidence");
    assert.equal(result.definitive, false);
  });

  test("a bounded scan that did not reach history end is incomplete, never 'no swap'", async () => {
    const rpc = new LastSwapFakeRpc([
      { signature: swapV2Outer.signature, response: depositTx.response },
      CAND(swapV1Inner, { response: withV4InstructionData(swapV1Inner, v4TagData(4)) }), // withdraw, older
      CAND(swapV2InnerV1, { response: withV4InstructionData(swapV2InnerV1, v4TagData(6)) }), // admin, oldest
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL, {
      scanLimit: 2,
    });
    assert.equal(rpc.scanLimits[0], 2, "bounded-scan limit must be passed through unchanged");
    assert.equal(result.scan.requestedLimit, 2);
    assert.equal(result.scan.signaturesReturned, 2);
    assert.equal(result.scan.reachedHistoryEnd, false);
    assert.equal(result.status, "incomplete");
    assert.equal(result.definitive, false);
    assert.equal(result.lastSwap, null);
  });

  test("full-history coverage with only provable non-swaps is an explicit no_swap_in_scan", async () => {
    const rpc = new LastSwapFakeRpc([
      { signature: swapV2Outer.signature, response: depositTx.response },
      CAND(swapV1Inner, { response: withV4InstructionData(swapV1Inner, v4TagData(4)) }),
    ]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL, {
      scanLimit: 1000,
    });
    assert.equal(result.scan.reachedHistoryEnd, true);
    assert.equal(result.status, "no_swap_in_scan");
    assert.equal(result.definitive, true);
    assert.equal(result.lastSwap, null);
  });

  test("an empty signature response is incomplete (pruned RPC indistinguishable from a dead pool)", async () => {
    const rpc = new LastSwapFakeRpc([]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.status, "incomplete");
    assert.equal(result.definitive, false);
    assert.equal(result.candidates.length, 0);
  });

  test("duplicate signatures are deduplicated", async () => {
    const rpc = new LastSwapFakeRpc([CAND(swapV2Outer), CAND(swapV2Outer)]);
    const result = await deriveLastSwapEvidenceV4(rpc.asConnection(), RAYDIUM_V4_PROGRAM_ID, POOL);
    assert.equal(result.candidates.length, 1);
  });
});

describe("pool account binding", () => {
  test("the pool account fixture carries the authoritative vault addresses", () => {
    const bytes = loadPoolAccountBytes();
    assert.ok(bytes && bytes.length === 752);
    assert.deepEqual(Buffer.from(bytes.slice(336, 368)), Buffer.from(COIN_VAULT.toBytes()));
    assert.deepEqual(Buffer.from(bytes.slice(368, 400)), Buffer.from(PC_VAULT.toBytes()));
  });

  test("the AmmInfo owner is the Raydium V4 program", () => {
    const bytes = loadPoolAccountBytes();
    assert.ok(bytes);
    assert.equal(new PublicKey(POOL).equals(POOL), true);
  });
});
