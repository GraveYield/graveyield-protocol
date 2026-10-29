// SPDX-License-Identifier: Apache-2.0
//
// Finding B regression tests — lib.evaluateZeroMovement (the pure
// zero-movement evaluator behind expectRevert). Proves the invariant the
// driver claims: the fee payer is debited EXACTLY the transaction's fee,
// every other tracked wallet / token account / existing account is
// bit-identical, and listed PDAs remain absent. The load-bearing case:
// a small EXTRA debit can no longer hide inside the old "≤10 000 lamports"
// fee budget.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { evaluateZeroMovement } from "../lifecycle_rehearsal/lib.mjs";

const FEE = 5000n;

function base(over = {}) {
  return {
    feeDelta: FEE,
    expectedFeeLamports: FEE,
    feeBudgetLamports: 10_000n,
    solBefore: { authority: 42n, treasury_pda: 7n },
    solAfter: { authority: 42n, treasury_pda: 7n },
    tokensBefore: { vault_wsol: "1000", treasury_memecoin: "5" },
    tokensAfter: { vault_wsol: "1000", treasury_memecoin: "5" },
    absentChecks: [{ label: "salvage_receipt", absent: true }],
    unchangedBefore: { claim_record_a: { lamports: 1, dataB64: "AAA=" } },
    unchangedAfter: { claim_record_a: { lamports: 1, dataB64: "AAA=" } },
    ...over,
  };
}

describe("evaluateZeroMovement", () => {
  test("all-unchanged + exact fee → proved", () => {
    const z = evaluateZeroMovement(base());
    assert.equal(z.proved, true);
    assert.equal(z.fee_ok, true);
    assert.equal(z.fee_payer_delta_lamports, "5000");
  });

  test("EXTRA DEBIT hidden in the fee: feeDelta = fee + 100 → NOT proved", () => {
    // The old implementation (feeDelta ≤ 10 000) accepted this.
    const z = evaluateZeroMovement(base({ feeDelta: FEE + 100n }));
    assert.equal(z.fee_ok, false);
    assert.equal(z.proved, false);
  });

  test("fee under-charged (delta 0, e.g. someone else paid) → NOT proved", () => {
    const z = evaluateZeroMovement(base({ feeDelta: 0n }));
    assert.equal(z.fee_ok, false);
    assert.equal(z.proved, false);
  });

  test("exact fee but above budget → fee_ok false (belt and braces)", () => {
    const z = evaluateZeroMovement(base({ expectedFeeLamports: 20_000n, feeDelta: 20_000n }));
    assert.equal(z.fee_ok, false);
    assert.equal(z.proved, false);
  });

  test("another tracked wallet's SOL moved → NOT proved, label recorded", () => {
    const z = evaluateZeroMovement(base({ solAfter: { authority: 42n, treasury_pda: 8n } }));
    assert.equal(z.proved, false);
    assert.equal(z.sol_unchanged.treasury_pda, false);
    assert.equal(z.sol_unchanged.authority, true);
  });

  test("a token account moved → NOT proved", () => {
    const z = evaluateZeroMovement(
      base({ tokensAfter: { vault_wsol: "999", treasury_memecoin: "5" } }),
    );
    assert.equal(z.tokens_unchanged, false);
    assert.equal(z.proved, false);
  });

  test("a token account appeared (null → value) → NOT proved", () => {
    const z = evaluateZeroMovement(
      base({
        tokensBefore: { vault_wsol: "1000", treasury_memecoin: null },
        tokensAfter: { vault_wsol: "1000", treasury_memecoin: "1" },
      }),
    );
    assert.equal(z.proved, false);
  });

  test("a PDA that must stay absent exists → NOT proved", () => {
    const z = evaluateZeroMovement(
      base({ absentChecks: [{ label: "salvage_receipt", absent: false }] }),
    );
    assert.equal(z.pdas_absent.salvage_receipt, false);
    assert.equal(z.proved, false);
  });

  test("an existing account's data changed → NOT proved", () => {
    const z = evaluateZeroMovement(
      base({ unchangedAfter: { claim_record_a: { lamports: 1, dataB64: "AAB=" } } }),
    );
    assert.equal(z.accounts_unchanged.claim_record_a, false);
    assert.equal(z.proved, false);
  });

  test("an existing account appeared (null → value) → NOT proved", () => {
    const z = evaluateZeroMovement(
      base({
        unchangedBefore: { claim_record_intruder: null },
        unchangedAfter: { claim_record_intruder: { lamports: 1, dataB64: "AAA=" } },
      }),
    );
    assert.equal(z.proved, false);
  });

  test("an existing account vanished → NOT proved", () => {
    const z = evaluateZeroMovement(
      base({
        unchangedBefore: { claim_record_a: { lamports: 1, dataB64: "AAA=" } },
        unchangedAfter: { claim_record_a: null },
      }),
    );
    assert.equal(z.proved, false);
  });

  test("empty watch sets with exact fee → proved", () => {
    const z = evaluateZeroMovement({
      feeDelta: FEE,
      expectedFeeLamports: FEE,
      feeBudgetLamports: 10_000n,
      solBefore: {},
      solAfter: {},
      tokensBefore: {},
      tokensAfter: {},
      absentChecks: [],
      unchangedBefore: {},
      unchangedAfter: {},
    });
    assert.equal(z.proved, true);
  });
});
