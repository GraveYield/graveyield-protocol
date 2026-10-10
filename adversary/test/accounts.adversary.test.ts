// SPDX-License-Identifier: Apache-2.0
//
// ADV-LP / ADV-FT — hostile account bytes and the error-code mirror.
// The account decoders are the trust boundary between arbitrary chain
// bytes and every downstream decision; the error table is the contract
// that makes failed transactions diagnosable. Both are pinned here
// against the REAL SDK code (no mocks).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AccountDisc,
  decodePoolRegistry,
  decodeSalvageReceipt,
  decodeClaimRecord,
  decodeVaultProtocolConfig,
  decodeScannerProtocolConfig,
  decodeEligibilityCert,
  decodeLaunchPrice,
  decodeGraveYieldErrorCode,
  decodeGraveYieldError,
  assertNotGraveYieldError,
  WSOL_MINT,
} from "@graveyield/sdk";
import { ByteWriter, key, MEME_MINT } from "./helpers.js";

/** Prefix a body with the account's real 8-byte discriminator. */
function withDisc(disc: readonly number[], body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  out.set(disc, 0);
  out.set(body, 8);
  return out;
}

/** A valid, R1-consistent SalvageReceipt body in the exact decoder layout. */
function receiptBody(): Uint8Array {
  return new ByteWriter()
    .pubkey(key("pool")) //    poolAddress
    .pubkey(key("salvor")) //  salvor
    .u64(4_000n) //            lpHolderAmountLamports
    .u64(4_000n) //            salvorAmountLamports
    .u64(2_000n) //            protocolAmountLamports
    .u64(10_000n) //           totalProceedsLamports (4k+4k+2k)
    .u64(28_000_000n) //       issuedAtSlot
    .i64(1_700_000_000n) //    issuedAtTs
    .pubkey(MEME_MINT) //      memecoinMint
    .u64(0n) //                dustMemecoinLamports
    .i64(0n) //                dustSweptAtTs
    .u8(255) //                bump
    .done();
}

describe("ADV-LP — hostile account bytes fail closed", () => {
  test("ADV-LP-01a: a wrong discriminator is refused (spoofed account type)", () => {
    // Build a receipt body, but label it as a PoolRegistry.
    const body = receiptBody();
    const hostile = withDisc(AccountDisc.PoolRegistry, body);
    // Decoding it as a receipt must throw — the discriminant does not lie.
    assert.throws(() => decodeSalvageReceipt(hostile), /discriminator/i);
  });

  test("ADV-LP-01b: truncated account bodies are refused (reader underflow)", () => {
    const short = withDisc(AccountDisc.PoolRegistry, new ByteWriter().pubkey(key("p")).done());
    assert.throws(() => decodePoolRegistry(short), /|/);
    // Fewer than 8 bytes cannot even carry a discriminant.
    assert.throws(() => decodePoolRegistry(new Uint8Array(4)));
  });

  test("ADV-LP-01c: every decoder refuses garbage (no silent zero-defaults)", () => {
    const garbage = new Uint8Array(64).fill(0xab);
    assert.throws(() => decodeSalvageReceipt(garbage));
    assert.throws(() => decodeClaimRecord(garbage));
    assert.throws(() => decodeVaultProtocolConfig(garbage));
    assert.throws(() => decodeScannerProtocolConfig(garbage));
    assert.throws(() => decodeEligibilityCert(garbage));
    assert.throws(() => decodeLaunchPrice(garbage));
    assert.throws(() => decodePoolRegistry(garbage));
  });

  test("ADV-LP-02 (F8): trailing bytes after a valid body are tolerated — pinned as intended", () => {
    const body = receiptBody();
    // Correct disc prefix + 16 bytes of trailing junk after the body.
    const padded = new Uint8Array(8 + body.length + 16);
    padded.set(AccountDisc.SalvageReceipt, 0);
    padded.set(body, 8);
    const receipt = decodeSalvageReceipt(padded);
    assert.ok(receipt.poolAddress.equals(key("pool")), "decode succeeds with trailing bytes");
    // R1 still checks out on the decoded values (books sum to the total).
    assert.equal(
      receipt.lpHolderAmountLamports + receipt.salvorAmountLamports + receipt.protocolAmountLamports,
      receipt.totalProceedsLamports,
    );
    // FLAGGED as finding F8: Anchor accounts may gain reserved space in
    // upgrades; the decoders deliberately read the fixed prefix. The
    // audit should confirm this is the intended trade-off.
  });
});

describe("ADV-FT — failed transactions are diagnosable", () => {
  test("ADV-FT-01: the full error table decodes with stable names (6000-6034, 7000-7021)", () => {
    const scannerCodes: Array<[number, string]> = [
      [6000, "Unauthorized"],
      [6001, "PoolNotEligible"],
      [6002, "LaunchPriceNotFound"],
      [6003, "UnsupportedAmm"],
      [6004, "MathOverflow"],
      [6005, "InvalidClock"],
      [6006, "InvariantViolation"],
      [6007, "AmmAdapterUnimplemented"],
      [6009, "PoolDataParseError"],
      [6010, "ProtocolPaused"],
      [6011, "CriteriaBitmapMismatch"],
      [6015, "AnchorNotFound"],
      [6016, "EpochConfirmationPending"],
      [6017, "AnchorInvalidated"],
      [6018, "AnchorNotStale"],
      [6019, "CertTtlBelowMinimum"],
      [6024, "AttestationMissing"],
      [6025, "InvalidAttestationOffsets"],
      [6026, "AttestationOracleMismatch"],
      [6027, "AttestationBindingMismatch"],
      [6028, "AttestationTimestampInvalid"],
      [6029, "AttestationStale"],
      [6030, "AttestationSlotHashMismatch"],
      [6031, "AttestationSlotInvalid"],
      [6032, "InvalidLaunchPrice"],
      [6033, "LaunchPriceMintMismatch"],
      [6034, "CertStillValid"],
    ];
    for (const [code, name] of scannerCodes) {
      const d = decodeGraveYieldErrorCode(code);
      assert.ok(d, `code ${code} must decode`);
      assert.equal(d.program, "GraveScanner");
      assert.equal(d.name, name);
      assert.equal(d.hex, `0x${code.toString(16)}`);
    }
    const vaultCodes: Array<[number, string]> = [
      [7000, "Unauthorized"],
      [7001, "InvalidEligibilityCert"],
      [7002, "EligibilityCertExpired"],
      [7003, "ProtocolPaused"],
      [7004, "InvalidShareSplit"],
      [7005, "ProtocolShareExceedsCeiling"],
      [7006, "LpHolderPoolUnsweepable"],
      [7007, "SlippageExceeded"],
      [7008, "PriorityFeeExceedsCeiling"],
      [7009, "MathOverflow"],
      [7010, "InvalidClaimProof"],
      [7011, "ClaimAlreadyProcessed"],
      [7012, "BelowDustThreshold"],
      [7013, "PreflightFailed"],
      [7014, "TimelockNotElapsed"],
      [7015, "AmmRedemptionFailed"],
      [7016, "JupiterSwapFailed"],
      [7017, "AmmCpiUnimplemented"],
      [7018, "InvalidSnapshotData"],
      [7019, "UnsupportedBaseToken"],
      [7020, "DustNothingToSweep"],
      [7021, "DustAlreadySwept"],
    ];
    for (const [code, name] of vaultCodes) {
      const d = decodeGraveYieldErrorCode(code);
      assert.ok(d, `code ${code} must decode`);
      assert.equal(d.program, "GraveVault");
      assert.equal(d.name, name);
    }
  });

  test("ADV-FT-01b: log-shaped errors decode through the hex path", () => {
    const err = new Error("custom program error: 0x1b66"); // 7014
    const d = decodeGraveYieldError(err);
    assert.ok(d);
    assert.equal(d.code, 7014);
    assert.equal(d.name, "TimelockNotElapsed");
  });

  test("ADV-FT-02 (F9): unknown codes decode to undefined — consumers must not auto-retry", () => {
    assert.equal(decodeGraveYieldErrorCode(6123), undefined);
    assert.equal(decodeGraveYieldErrorCode(7999), undefined);
    assert.equal(decodeGraveYieldError(new Error("some other failure")), undefined);
    // assertNotGraveYieldError rethrows matching codes with a diagnosable
    // message and otherwise rethrows the ORIGINAL error unchanged.
    assert.throws(
      () => assertNotGraveYieldError(new Error("custom program error: 0x1770"), 6000),
      /unexpected GraveYield error GraveScanner::Unauthorized \(0x1770\)/,
    );
    const passthrough = new Error("boom");
    assert.throws(
      () => assertNotGraveYieldError(passthrough, 6000),
      (e: unknown) => e === passthrough,
    );
  });
});

describe("ADV-LP — WSOL constant pin", () => {
  test("the WSOL mint constant matches the canonical address", () => {
    assert.equal(
      WSOL_MINT.toBase58(),
      "So11111111111111111111111111111111111111112",
      "orientation checks are only as good as the pinned WSOL address",
    );
  });
});
