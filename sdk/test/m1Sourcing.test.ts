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
  DEVNET_SCANNER_PROGRAM_ID,
  DEVNET_VAULT_PROGRAM_ID,
  evaluateM1Sourcing,
  fetchV4Pool,
  GraveYieldClient,
  identifyBaseToken,
  M1SourcingError,
  RAYDIUM_V4_PROGRAM_ID,
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
  WSOL_MINT,
  type M1SourcingRejected,
  type M1SourcingVerdict,
} from "../src/index.js";
import {
  encodeAmmInfo,
  encodeMint,
  encodeScannerConfig,
  encodeTokenAccount,
  encodeVaultConfig,
  EvaluatePoolFakeRpc,
  TOKEN_PROGRAM,
} from "./fakeRpc.js";

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

// ---------------------------------------------------------------------------
// GraveYieldClient.evaluatePool — the production M1 candidate acceptance /
// evaluation path. The guard runs INSIDE evaluatePool on the freshly
// fetched + decoded AmmInfo account (owner + canonical 752-byte layout
// validated by fetchV4Pool; coin_mint @400 / pc_mint @432 decoded by
// parseV4AmmInfo), so direct invocation cannot bypass the D-01 predicate
// and candidate-supplied metadata is never consulted.
// ---------------------------------------------------------------------------

const SCANNER_ID = new PublicKey(DEVNET_SCANNER_PROGRAM_ID);
const VAULT_ID = new PublicKey(DEVNET_VAULT_PROGRAM_ID);
const FIXTURE_COIN_VAULT = new PublicKey(new Uint8Array(32).fill(0x51));
const FIXTURE_PC_VAULT = new PublicKey(new Uint8Array(32).fill(0x52));
const FIXTURE_LP_MINT = new PublicKey(new Uint8Array(32).fill(0x53));

/** Full evaluatePool surface: pool + vaults + LP mint + both ProtocolConfigs. */
function evaluatePoolFixture(opts: { baseMint: PublicKey; quoteMint: PublicKey }): {
  client: GraveYieldClient;
  poolAddress: PublicKey;
  rpc: EvaluatePoolFakeRpc;
} {
  const rpc = new EvaluatePoolFakeRpc();
  rpc.setAccount(
    POOL,
    encodeAmmInfo({
      coinVault: FIXTURE_COIN_VAULT,
      pcVault: FIXTURE_PC_VAULT,
      baseMint: opts.baseMint,
      quoteMint: opts.quoteMint,
      lpMint: FIXTURE_LP_MINT,
    }),
    RAYDIUM_V4_PROGRAM_ID,
  );
  rpc.setAccount(FIXTURE_COIN_VAULT, encodeTokenAccount(opts.baseMint, 1_000_000n), TOKEN_PROGRAM);
  rpc.setAccount(FIXTURE_PC_VAULT, encodeTokenAccount(opts.quoteMint, 600_000_000n), TOKEN_PROGRAM);
  rpc.setAccount(FIXTURE_LP_MINT, encodeMint(2, 10_000_000n), TOKEN_PROGRAM);
  rpc.setAccount(
    scannerProtocolConfigPda(SCANNER_ID),
    encodeScannerConfig({
      authority: SCANNER_ID,
      activityOracle: SCANNER_ID,
      launchPriceOracle: SCANNER_ID,
    }),
    SCANNER_ID,
  );
  rpc.setAccount(
    vaultProtocolConfigPda(VAULT_ID),
    encodeVaultConfig({ authority: SCANNER_ID }),
    VAULT_ID,
  );
  const client = new GraveYieldClient({
    connection: rpc.asConnection(),
    cluster: "localnet",
    graveScannerProgramId: SCANNER_ID,
    graveVaultProgramId: VAULT_ID,
  });
  return { client, poolAddress: POOL, rpc };
}

describe("evaluatePool — the production M1 acceptance path enforces D-01 on the decoded pool account", () => {
  test("PASS: direct invocation (default M1 mode) accepts a decoded pool with WSOL as pc_mint", async () => {
    const { client, poolAddress } = evaluatePoolFixture({
      baseMint: MEMECOIN,
      quoteMint: WSOL_MINT,
    });
    const outcome = await client.evaluatePool(poolAddress);
    // The guard passed: the six-criteria evaluation ran and the decoded
    // orientation is carried through untouched.
    assert.ok(outcome.pool.baseMint.equals(MEMECOIN));
    assert.ok(outcome.pool.quoteMint.equals(WSOL_MINT));
    assert.ok(
      outcome.failedCriteria.every((c) => !c.startsWith("m1")),
      "a correctly oriented pool must not be M1-rejected",
    );
  });

  test("REJECT: direct invocation cannot bypass — WSOL on coin_mint throws M1SourcingError", async () => {
    const { client, poolAddress } = evaluatePoolFixture({
      baseMint: WSOL_MINT,
      quoteMint: MEMECOIN,
    });
    await assert.rejects(
      client.evaluatePool(poolAddress),
      (err: unknown) => err instanceof M1SourcingError && err.reason === "wsol-on-coin-side",
    );
  });

  test("REJECT: neither mint is WSOL", async () => {
    const { client, poolAddress } = evaluatePoolFixture({ baseMint: MEMECOIN, quoteMint: OTHER });
    await assert.rejects(
      client.evaluatePool(poolAddress),
      (err: unknown) => err instanceof M1SourcingError && err.reason === "no-wsol-side",
    );
  });

  test("REJECT: both mints are WSOL", async () => {
    const { client, poolAddress } = evaluatePoolFixture({
      baseMint: WSOL_MINT,
      quoteMint: WSOL_MINT,
    });
    await assert.rejects(
      client.evaluatePool(poolAddress),
      (err: unknown) => err instanceof M1SourcingError && err.reason === "both-sides-wsol",
    );
  });

  test("REJECT: missing pool account — fail-closed fetch", async () => {
    const { client, poolAddress, rpc } = evaluatePoolFixture({
      baseMint: MEMECOIN,
      quoteMint: WSOL_MINT,
    });
    rpc.accounts.delete(poolAddress.toBase58());
    await assert.rejects(client.evaluatePool(poolAddress), /not found/);
  });

  test("REJECT: malformed pool account (non-canonical 752-byte layout)", async () => {
    const { client, poolAddress, rpc } = evaluatePoolFixture({
      baseMint: MEMECOIN,
      quoteMint: WSOL_MINT,
    });
    rpc.setAccount(poolAddress, new Uint8Array(700), RAYDIUM_V4_PROGRAM_ID);
    await assert.rejects(client.evaluatePool(poolAddress), /not a canonical 752-byte/);
  });

  test("REJECT: non-Raydium owner (layout cannot be validated)", async () => {
    const { client, poolAddress, rpc } = evaluatePoolFixture({
      baseMint: MEMECOIN,
      quoteMint: WSOL_MINT,
    });
    rpc.setAccount(
      poolAddress,
      encodeAmmInfo({
        coinVault: FIXTURE_COIN_VAULT,
        pcVault: FIXTURE_PC_VAULT,
        baseMint: MEMECOIN,
        quoteMint: WSOL_MINT,
        lpMint: FIXTURE_LP_MINT,
      }),
      PublicKey.default, // wrong owner
    );
    await assert.rejects(client.evaluatePool(poolAddress), /not Raydium V4/);
  });

  test("explicit non-M1 opt-out preserves the legacy either-orientation evaluation", async () => {
    // The same coin-side-WSOL pool that the default mode rejects is
    // evaluable again with m1SourcingEnforced: false — non-M1 operation
    // keeps the pre-D-01 behavior (C2/C3 math handles either orientation).
    const { client, poolAddress } = evaluatePoolFixture({
      baseMint: WSOL_MINT,
      quoteMint: MEMECOIN,
    });
    const outcome = await client.evaluatePool(poolAddress, { m1SourcingEnforced: false });
    assert.ok(outcome.pool.baseMint.equals(WSOL_MINT));
    assert.ok(outcome.pool.quoteMint.equals(MEMECOIN));
  });
});
