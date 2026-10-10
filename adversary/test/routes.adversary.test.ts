// SPDX-License-Identifier: Apache-2.0
//
// ADV-RT — malformed Jupiter routes & CPI account contracts, enforced by
// the SDK's instruction builders (the last client-side gate). Every
// attack here is refused BEFORE bytes reach the wire: the builders'
// guards are byte-locked, so the assertions also pin the wire layout.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, type AccountMeta } from "@solana/web3.js";

import {
  buildSalvagePoolIx,
  buildClaimLpProceedsIx,
  buildEvaluatePoolPhase1Ix,
  buildRecordLaunchPriceIx,
  raydiumV4RemainingAccounts,
  JUPITER_V6_PROGRAM_ID,
  RAYDIUM_V4_AMM_AUTHORITY,
} from "@graveyield/sdk";
import { key } from "./helpers.js";

const fakeAccounts = (n: number, writable = true): AccountMeta[] =>
  Array.from({ length: n }, (_, i) => ({
    pubkey: key(`ra-${i}-${n}`),
    isSigner: false,
    isWritable: writable,
  }));

const baseSalvageOpts = () => ({
  vaultProgramId: key("vault-program"),
  scannerProgramId: key("scanner-program"),
  ammProgramId: key("amm-program"),
  poolAddress: key("pool"),
  salvor: key("salvor"),
  salvorLpTokenAccount: key("lp-ata"),
  lpMint: key("lp-mint"),
  memecoinMint: key("meme-mint"),
  lpSnapshotMerkleRoot: new Uint8Array(32).fill(7),
  lpTotalSupplyAtSnapshot: 1_000_000n,
  salvorLpAmount: 1_000n,
  minQuoteOutputLamports: 0n,
  jupiterRouteData: new Uint8Array(0),
  jupiterRouteAccountsLen: 0,
  raydiumV4RemainingAccounts: fakeAccounts(13),
  jupiterRouteAccounts: [] as AccountMeta[],
});

describe("ADV-RT — malformed routes & CPI contracts", () => {
  test("ADV-RT-01: a non-32-byte Merkle root is refused", () => {
    const opts = baseSalvageOpts();
    assert.throws(
      () => buildSalvagePoolIx({ ...opts, lpSnapshotMerkleRoot: new Uint8Array(31) }),
      /lpSnapshotMerkleRoot must be 32 bytes/,
      "truncated root must not reach the wire",
    );
    assert.throws(
      () => buildSalvagePoolIx({ ...opts, lpSnapshotMerkleRoot: new Uint8Array(33) }),
      /lpSnapshotMerkleRoot must be 32 bytes/,
    );
  });

  test("ADV-RT-02: Raydium remaining_accounts must be exactly 13", () => {
    const opts = baseSalvageOpts();
    assert.throws(
      () => buildSalvagePoolIx({ ...opts, raydiumV4RemainingAccounts: fakeAccounts(12) }),
      /exactly 13/,
    );
    assert.throws(
      () => buildSalvagePoolIx({ ...opts, raydiumV4RemainingAccounts: fakeAccounts(14) }),
      /exactly 13/,
      "an extra CPI account is as hostile as a missing one",
    );
    // The honest shape builds.
    const ix = buildSalvagePoolIx(opts);
    assert.equal(ix.keys.length, 21 + 13); // 21 named accounts + 13 remaining
  });

  test("ADV-RT-03: a truncated Jupiter route account list is refused", () => {
    const opts = baseSalvageOpts();
    assert.throws(
      () =>
        buildSalvagePoolIx({
          ...opts,
          jupiterRouteData: new Uint8Array(64),
          jupiterRouteAccountsLen: 3,
          jupiterRouteAccounts: fakeAccounts(2),
        }),
      /jupiterRouteAccounts\[2\] missing/,
      "a route that declares 3 accounts cannot ship with 2",
    );
    // Declared-zero routes with no accounts are the honest no-swap shape.
    const ix = buildSalvagePoolIx(opts);
    assert.equal(ix.keys.length, 34);
  });

  test("ADV-CPI-05: the CPI targets are pinned in the wire format itself", () => {
    // Build the 13 remaining accounts with the CANONICAL helper, then
    // assert the pins. Named-account layout (salvagePool.ts): slot 8 =
    // amm program, slot 9 = Jupiter v6 program, slots 21..33 = the 13
    // Raydium accounts, of which slot 21 (ra_idx 0) is the AMM authority.
    const canon13 = raydiumV4RemainingAccounts(
      { coinVault: key("cv"), pcVault: key("pv") },
      {
        ammOpenOrders: key("oo"),
        ammTargetOrders: key("to"),
        marketProgram: key("mp"),
        market: key("mk"),
        marketCoinVault: key("mcv"),
        marketPcVault: key("mpv"),
        marketVaultSigner: key("mvs"),
        marketEventQueue: key("meq"),
        marketBids: key("mb"),
        marketAsks: key("ma"),
      },
    );
    const ix = buildSalvagePoolIx({ ...baseSalvageOpts(), raydiumV4RemainingAccounts: canon13 });
    assert.ok(
      ix.keys[9]?.pubkey.equals(JUPITER_V6_PROGRAM_ID),
      "the swap leg's program account is the pinned Jupiter v6 address",
    );
    assert.ok(
      ix.keys[21]?.pubkey.equals(RAYDIUM_V4_AMM_AUTHORITY),
      "CPI remaining_accounts[0] is the real Raydium V4 AMM authority",
    );
    // The named slots are structurally immune to caller input: even a
    // hostile 13-account array cannot displace the pinned program
    // accounts (it lands after them), and the on-chain preflight (7013,
    // fork-proven) independently re-verifies the authority constant.
    const hostileIx = buildSalvagePoolIx(baseSalvageOpts());
    assert.ok(hostileIx.keys[9]?.pubkey.equals(JUPITER_V6_PROGRAM_ID));
  });

  test("ADV-RT-05: claim proofs and phase-1 messages are length-locked", () => {
    // A 31-byte Merkle proof element is refused.
    assert.throws(
      () =>
        buildClaimLpProceedsIx({
          vaultProgramId: key("vault-program"),
          poolAddress: key("pool"),
          lpHolder: key("holder"),
          lpBalanceAtSnapshot: 1n,
          merkleProof: [new Uint8Array(31)],
        }),
      /merkle proof element must be 32 bytes/,
    );
    // A 111-byte C1 message is refused at build time.
    assert.throws(
      () =>
        buildEvaluatePoolPhase1Ix({
          scannerProgramId: key("scanner-program"),
          ammProgramId: key("amm"),
          poolAddress: key("pool"),
          msg: new Uint8Array(111),
          writer: key("writer"),
        }),
      /must be 112 bytes/,
    );
    // A 167-byte C2 message is refused at build time.
    assert.throws(
      () =>
        buildRecordLaunchPriceIx({
          scannerProgramId: key("scanner-program"),
          ammProgramId: key("amm"),
          poolAddress: key("pool"),
          baseMint: key("base"),
          quoteMint: key("quote"),
          launchPriceQ64x64: 1n << 64n,
          msg: new Uint8Array(167),
          payer: key("payer"),
        }),
      /must be 168 bytes/,
    );
  });
});
