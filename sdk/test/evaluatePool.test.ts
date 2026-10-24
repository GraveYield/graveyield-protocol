// SPDX-License-Identifier: Apache-2.0
//
// evaluatePool offline regression tests (FLEET-M0 audit F5).
//
// Pins the C2 price-collapse comparison to the on-chain orientation:
// base_reserve = coin_amount, quote_reserve = pc_amount UNCONDITIONALLY
// (programs/grave-scanner/src/adapters/raydium_v4.rs), so the current
// price is ALWAYS quotePerBaseQ64x64(coinReserve, pcReserve) — the same
// ratio `deriveLaunchPriceV4` records at the first swap.
//
// The pre-fix implementation picked the base reserve by comparing the
// two mints' base58 string order, which inverted the price for every
// pool whose coin-side mint sorts AFTER its pc-side mint — silently
// flipping the collapse decision (a collapsed pool looked like it
// APPRECIATED, and vice versa).
//
// Everything runs against an in-memory account map; no network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  GraveYieldClient,
  DEVNET_SCANNER_PROGRAM_ID,
  DEVNET_VAULT_PROGRAM_ID,
  RAYDIUM_V4_PROGRAM_ID,
  WSOL_MINT,
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
  launchPricePda,
} from "../src/index.js";
import {
  EvaluatePoolFakeRpc,
  TOKEN_PROGRAM,
  encodeScannerConfig,
  encodeVaultConfig,
  encodeAmmInfo,
  encodeTokenAccount,
  encodeMint,
  encodeLaunchPriceAccount,
} from "./fakeRpc.js";

const AUTHORITY = PublicKey.unique();
const SCANNER_ID = new PublicKey(DEVNET_SCANNER_PROGRAM_ID);
const VAULT_ID = new PublicKey(DEVNET_VAULT_PROGRAM_ID);

/** A deterministic non-WSOL mint sorting strictly before WSOL_MINT. */
function memecoinSortedBeforeWsol(): PublicKey {
  for (let i = 1; i < 5000; i++) {
    const candidate = new PublicKey(
      Uint8Array.from({ length: 32 }, (_, j) => (i * 7 + j) % 200),
    );
    if (candidate.toBase58() < WSOL_MINT.toBase58()) return candidate;
  }
  throw new Error("no candidate mint found");
}

/** A deterministic non-WSOL mint sorting strictly after WSOL_MINT. */
function memecoinSortedAfterWsol(): PublicKey {
  for (let i = 1; i < 5000; i++) {
    const candidate = new PublicKey(
      Uint8Array.from({ length: 32 }, (_, j) => 1 + ((i * 11 + j) % 54)),
    );
    if (candidate.toBase58() > WSOL_MINT.toBase58()) return candidate;
  }
  throw new Error("no candidate mint found");
}

/**
 * Build a pool whose launch price was 1000 pc-per-coin and whose current
 * price is `currentPriceInt` pc-per-coin (integer parts suffice: with
 * coin = 1e6 base units the Q64.64 ratio is currentPriceInt × 2^64).
 */
function buildPool(opts: {
  coinMint: PublicKey;
  pcMint: PublicKey;
  currentPriceInt: number;
}) {
  const rpc = new EvaluatePoolFakeRpc();
  const poolAddress = PublicKey.unique();
  const coinVault = PublicKey.unique();
  const pcVault = PublicKey.unique();
  const lpMint = PublicKey.unique();
  const coinReserve = 1_000_000n;
  const pcReserve = BigInt(opts.currentPriceInt) * 1_000_000n;

  rpc.setAccount(
    poolAddress,
    encodeAmmInfo({
      coinVault,
      pcVault,
      baseMint: opts.coinMint,
      quoteMint: opts.pcMint,
      lpMint,
    }),
    RAYDIUM_V4_PROGRAM_ID,
  );
  rpc.setAccount(coinVault, encodeTokenAccount(opts.coinMint, coinReserve), TOKEN_PROGRAM);
  rpc.setAccount(pcVault, encodeTokenAccount(opts.pcMint, pcReserve), TOKEN_PROGRAM);
  rpc.setAccount(lpMint, encodeMint(9, 1_000_000n), TOKEN_PROGRAM);
  rpc.setAccount(
    scannerProtocolConfigPda(SCANNER_ID),
    encodeScannerConfig({ authority: AUTHORITY, activityOracle: AUTHORITY, launchPriceOracle: AUTHORITY }),
    SCANNER_ID,
  );
  rpc.setAccount(
    vaultProtocolConfigPda(VAULT_ID),
    encodeVaultConfig({ authority: AUTHORITY }),
    VAULT_ID,
  );
  rpc.setAccount(
    launchPricePda(SCANNER_ID, RAYDIUM_V4_PROGRAM_ID, poolAddress),
    encodeLaunchPriceAccount({
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress,
      baseMint: opts.coinMint, // the derivation records the coin-side mint
      quoteMint: opts.pcMint,
      launchPriceQ64x64: 1000n << 64n, // launch = 1000 pc-per-coin
    }),
    SCANNER_ID,
  );

  const client = new GraveYieldClient({
    connection: rpc.asConnection(),
    cluster: "localnet",
    graveScannerProgramId: SCANNER_ID,
    graveVaultProgramId: VAULT_ID,
  });
  return { client, poolAddress };
}

describe("evaluatePool C2 orientation (F5 regression)", () => {
  test("99% collapse detected when the coin mint sorts AFTER the pc mint", async () => {
    const { client, poolAddress } = buildPool({
      coinMint: memecoinSortedAfterWsol(),
      pcMint: WSOL_MINT,
      currentPriceInt: 10, // (1000 − 10)/1000 = 99% = 9900 bps ≥ threshold
    });
    const outcome = await client.evaluatePool(poolAddress);
    assert.equal(outcome.criteria.c2PriceCollapse, true);
  });

  test("99% collapse detected when the coin mint sorts BEFORE the pc mint (pre-fix inverted leg)", async () => {
    const { client, poolAddress } = buildPool({
      coinMint: memecoinSortedBeforeWsol(),
      pcMint: WSOL_MINT,
      currentPriceInt: 10,
    });
    const outcome = await client.evaluatePool(poolAddress);
    assert.equal(outcome.criteria.c2PriceCollapse, true);
  });

  test("mirror orientation (WSOL on the coin side) compares the same coin/pc ratio", async () => {
    const { client, poolAddress } = buildPool({
      coinMint: WSOL_MINT,
      pcMint: memecoinSortedAfterWsol(),
      currentPriceInt: 10,
    });
    const outcome = await client.evaluatePool(poolAddress);
    assert.equal(outcome.criteria.c2PriceCollapse, true);
  });

  test("appreciated pool (price above launch) does NOT pass C2", async () => {
    const { client, poolAddress } = buildPool({
      coinMint: memecoinSortedAfterWsol(),
      pcMint: WSOL_MINT,
      currentPriceInt: 5000, // price ROSE above the 1000 launch price
    });
    const outcome = await client.evaluatePool(poolAddress);
    assert.equal(outcome.criteria.c2PriceCollapse, false);
    assert.ok(outcome.failedCriteria.includes("C2-price-collapse"));
  });

  test("sub-threshold collapse (98%) does not pass C2", async () => {
    const { client, poolAddress } = buildPool({
      coinMint: memecoinSortedAfterWsol(),
      pcMint: WSOL_MINT,
      currentPriceInt: 20, // (1000 − 20)/1000 = 98% < 99%
    });
    const outcome = await client.evaluatePool(poolAddress);
    assert.equal(outcome.criteria.c2PriceCollapse, false);
    assert.ok(outcome.failedCriteria.includes("C2-price-collapse"));
  });
});
