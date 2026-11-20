// SPDX-License-Identifier: Apache-2.0
//
// D-01 M1 WSOL quote-side sourcing guard tests (GY-M1-ODR-001 §3).
//
// Pins the canonical SDK predicate: exactly one WSOL mint, WSOL on
// pc_mint (quote side), coin_mint non-WSOL; missing, malformed and
// ambiguous orientation data fails closed; the fetch-based candidate
// acceptance path re-validates layout/owner from chain state before the
// orientation predicate; and the settlement-adjacent 7019 orientation
// logic is NOT tightened (non-M1 behavior preserved).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PublicKey } from "@solana/web3.js";
import {
  assertM1Sourcing,
  assertM1SourcingForPool,
  evaluateM1Sourcing,
  fetchV4Pool,
  GraveYieldClient,
  identifyBaseToken,
  M1SourcingError,
  RAYDIUM_V4_PROGRAM_ID,
  WSOL_MINT,
  type M1SourcingRejected,
  type M1SourcingVerdict,
} from "../src/index.js";
import { encodeAmmInfo, EvaluatePoolFakeRpc } from "./fakeRpc.js";

const MEMECOIN = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const OTHER = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
/** Deterministic synthetic pool address (all bytes = 0x42). */
const POOL = new PublicKey(new Uint8Array(32).fill(0x42));

function expectRejected(
  verdict: M1SourcingVerdict,
  reason: M1SourcingRejected["reason"],
): M1SourcingRejected {
  assert.equal(verdict.accepted, false, `expected rejection (${reason})`);
  assert.equal((verdict as M1SourcingRejected).reason, reason);
  return verdict as M1SourcingRejected;
}

describe("evaluateM1Sourcing — D-01 predicate vectors", () => {
  test("PASS: WSOL is pc_mint and coin_mint is non-WSOL", () => {
    const verdict = evaluateM1Sourcing({ coinMint: MEMECOIN, pcMint: WSOL_MINT });
    assert.equal(verdict.accepted, true);
    if (verdict.accepted) {
      assert.ok(verdict.wsolMint.equals(WSOL_MINT));
      assert.ok(verdict.memecoinMint.equals(MEMECOIN));
    }
  });

  test("REJECT: WSOL is coin_mint (base side), not pc_mint", () => {
    const verdict = expectRejected(
      evaluateM1Sourcing({ coinMint: WSOL_MINT, pcMint: MEMECOIN }),
      "wsol-on-coin-side",
    );
    assert.ok(verdict.detail.includes("quote side"));
  });

  test("REJECT: neither mint is WSOL", () => {
    expectRejected(evaluateM1Sourcing({ coinMint: MEMECOIN, pcMint: OTHER }), "no-wsol-side");
  });

  test("REJECT: both mints are WSOL", () => {
    expectRejected(
      evaluateM1Sourcing({ coinMint: WSOL_MINT, pcMint: WSOL_MINT }),
      "both-sides-wsol",
    );
  });

  test("REJECT: missing pc_mint", () => {
    expectRejected(
      evaluateM1Sourcing({ coinMint: MEMECOIN, pcMint: undefined }),
      "missing-pc-mint",
    );
    expectRejected(evaluateM1Sourcing({ coinMint: MEMECOIN, pcMint: null }), "missing-pc-mint");
  });

  test("REJECT: missing coin_mint", () => {
    expectRejected(
      evaluateM1Sourcing({ coinMint: undefined, pcMint: WSOL_MINT }),
      "missing-coin-mint",
    );
    expectRejected(evaluateM1Sourcing({ coinMint: null, pcMint: WSOL_MINT }), "missing-coin-mint");
  });

  test("REJECT: malformed / unverifiable mint data (never reinterpreted)", () => {
    // Not PublicKeys — a base58 string must never be silently coerced.
    expectRejected(
      evaluateM1Sourcing({
        coinMint: WSOL_MINT.toBase58() as unknown as PublicKey,
        pcMint: MEMECOIN,
      }),
      "unverifiable-orientation",
    );
    expectRejected(
      evaluateM1Sourcing({
        coinMint: MEMECOIN,
        pcMint: {} as unknown as PublicKey,
      }),
      "unverifiable-orientation",
    );
  });

  test("V4PoolAccount form maps baseMint→coin_mint, quoteMint→pc_mint (parser offsets 400/432)", () => {
    const pool = {
      poolAddress: POOL,
      coinVault: PublicKey.default,
      pcVault: PublicKey.default,
      baseMint: MEMECOIN, // coin_mint
      quoteMint: WSOL_MINT, // pc_mint
      lpMint: PublicKey.default,
    };
    assert.equal(evaluateM1Sourcing(pool).accepted, true);
    // Same pool, flipped orientation → rejected as wsol-on-coin-side.
    expectRejected(
      evaluateM1Sourcing({ ...pool, baseMint: WSOL_MINT, quoteMint: MEMECOIN }),
      "wsol-on-coin-side",
    );
  });
});

describe("assertM1Sourcing — throwing guard", () => {
  test("returns the acceptance with canonical mints", () => {
    const ok = assertM1Sourcing({ coinMint: MEMECOIN, pcMint: WSOL_MINT });
    assert.ok(ok.wsolMint.equals(WSOL_MINT));
    assert.ok(ok.memecoinMint.equals(MEMECOIN));
  });

  test("throws M1SourcingError with the machine-checkable reason + verdict", () => {
    try {
      assertM1Sourcing({ coinMint: WSOL_MINT, pcMint: MEMECOIN });
      assert.fail("expected M1SourcingError");
    } catch (err) {
      assert.ok(err instanceof M1SourcingError);
      const e = err as M1SourcingError;
      assert.equal(e.reason, "wsol-on-coin-side");
      assert.equal(e.verdict.accepted, false);
      assert.equal(e.verdict.coinMint, WSOL_MINT.toBase58());
      assert.equal(e.verdict.pcMint, MEMECOIN.toBase58());
    }
  });
});

describe("assertM1SourcingForPool — fetch-based candidate acceptance (fail-closed layout/owner)", () => {
  function fakeWithPool(opts: {
    owner?: PublicKey;
    data?: Uint8Array;
    include?: boolean;
    baseMint?: PublicKey;
    quoteMint?: PublicKey;
  }): EvaluatePoolFakeRpc {
    const rpc = new EvaluatePoolFakeRpc();
    if (opts.include ?? true) {
      rpc.setAccount(
        POOL,
        opts.data ??
          encodeAmmInfo({
            coinVault: PublicKey.default,
            pcVault: PublicKey.default,
            baseMint: opts.baseMint ?? MEMECOIN,
            quoteMint: opts.quoteMint ?? WSOL_MINT,
            lpMint: PublicKey.default,
          }),
        opts.owner ?? RAYDIUM_V4_PROGRAM_ID,
      );
    }
    return rpc;
  }

  test("PASS: canonical 752-byte pool with WSOL on pc side", async () => {
    const ok = await assertM1SourcingForPool(fakeWithPool({}).asConnection(), POOL);
    assert.ok(ok.wsolMint.equals(WSOL_MINT));
    assert.ok(ok.memecoinMint.equals(MEMECOIN));
  });

  test("REJECT: same canonical pool with WSOL on coin side", async () => {
    const rpc = fakeWithPool({ baseMint: WSOL_MINT, quoteMint: MEMECOIN });
    await assert.rejects(
      assertM1SourcingForPool(rpc.asConnection(), POOL),
      (err: unknown) => err instanceof M1SourcingError && err.reason === "wsol-on-coin-side",
    );
  });

  test("REJECT: non-Raydium owner (layout cannot be validated)", async () => {
    const rpc = fakeWithPool({ owner: PublicKey.default });
    await assert.rejects(fetchV4Pool(rpc.asConnection(), POOL), /not Raydium V4/);
    // The M1 guard must fail closed on the same error (no swallowing).
    await assert.rejects(assertM1SourcingForPool(rpc.asConnection(), POOL), /not Raydium V4/);
  });

  test("REJECT: invalid/unsupported pool layout (non-canonical size)", async () => {
    const rpc = fakeWithPool({ data: new Uint8Array(700) });
    await assert.rejects(
      assertM1SourcingForPool(rpc.asConnection(), POOL),
      /not a canonical 752-byte/,
    );
  });

  test("REJECT: missing pool account", async () => {
    const rpc = fakeWithPool({ include: false });
    await assert.rejects(assertM1SourcingForPool(rpc.asConnection(), POOL), /not found/);
  });
});

describe("GraveYieldClient.assertM1CandidateSourcing — SDK candidate-acceptance guard", () => {
  function client(rpc: EvaluatePoolFakeRpc): GraveYieldClient {
    return new GraveYieldClient({
      connection: rpc.asConnection(),
      cluster: "devnet",
      graveScannerProgramId: RAYDIUM_V4_PROGRAM_ID,
      graveVaultProgramId: RAYDIUM_V4_PROGRAM_ID,
    });
  }

  test("accepts a correctly oriented pool", async () => {
    const rpc = new EvaluatePoolFakeRpc();
    rpc.setAccount(
      POOL,
      encodeAmmInfo({
        coinVault: PublicKey.default,
        pcVault: PublicKey.default,
        baseMint: MEMECOIN,
        quoteMint: WSOL_MINT,
        lpMint: PublicKey.default,
      }),
      RAYDIUM_V4_PROGRAM_ID,
    );
    const ok = await client(rpc).assertM1CandidateSourcing(POOL);
    assert.ok(ok.wsolMint.equals(WSOL_MINT));
  });

  test("rejects an incorrectly oriented pool that 'passed discovery'", async () => {
    const rpc = new EvaluatePoolFakeRpc();
    rpc.setAccount(
      POOL,
      encodeAmmInfo({
        coinVault: PublicKey.default,
        pcVault: PublicKey.default,
        baseMint: WSOL_MINT, // WSOL on the BASE (coin) side — not M1-eligible
        quoteMint: MEMECOIN,
        lpMint: PublicKey.default,
      }),
      RAYDIUM_V4_PROGRAM_ID,
    );
    await assert.rejects(
      client(rpc).assertM1CandidateSourcing(POOL),
      (err: unknown) => err instanceof M1SourcingError && err.reason === "wsol-on-coin-side",
    );
  });
});

describe("non-M1 orientation behavior is preserved (settlement-adjacent logic untouched)", () => {
  test("identifyBaseToken (7019 guard) still accepts a coin-side-WSOL pool", () => {
    // D-01 is an M1 SOURCING restriction only — the settlement-adjacent
    // orientation logic must keep accepting either single-WSOL
    // orientation for non-M1 protocol behavior.
    const coinWsolPool = {
      poolAddress: POOL,
      coinVault: PublicKey.default,
      pcVault: PublicKey.default,
      baseMint: WSOL_MINT,
      quoteMint: MEMECOIN,
      lpMint: PublicKey.default,
    };
    const identified = identifyBaseToken(coinWsolPool);
    assert.equal(identified.coinIsWsol, true);
    assert.ok(identified.memecoinMint.equals(MEMECOIN));
  });

  test("identifyBaseToken still rejects zero/two WSOL sides (7019 unchanged)", () => {
    const bothWsol = {
      poolAddress: POOL,
      coinVault: PublicKey.default,
      pcVault: PublicKey.default,
      baseMint: WSOL_MINT,
      quoteMint: WSOL_MINT,
      lpMint: PublicKey.default,
    };
    assert.throws(() => identifyBaseToken(bothWsol), /7019/);
  });
});
