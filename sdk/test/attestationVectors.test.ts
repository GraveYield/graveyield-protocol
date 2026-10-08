// SPDX-License-Identifier: Apache-2.0
//
// Attestation message build/parse + precompile instruction wire format
// tests. Pins the canonical 112-byte C1 message and the 168-byte C2
// message against the on-chain `attestation.rs` byte layout. Drift here
// would surface as `InvalidAttestationOffsets` (6025) or
// `AttestationBindingMismatch` (6027) on chain.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  ATTESTATION_MSG_LEN,
  IX_DATA_MSG_OFFSET,
  buildAttestationMessage,
  parseAttestationMessage,
  buildEd25519VerifyInstruction,
  ED25519_PROGRAM_ID,
  PRECOMPILE_MIN_LEN,
  PRECOMPILE_PK_OFFSET,
  PRECOMPILE_SIG_OFFSET,
} from "../src/index.js";

import {
  LAUNCH_PRICE_MSG_LEN,
  LAUNCH_PRICE_MSG_OFFSET,
  buildLaunchPriceMessage,
  parseLaunchPriceMessage,
  buildLaunchPriceEd25519VerifyInstruction,
} from "../src/index.js";

const amm = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const pool = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const baseMint = new PublicKey("So11111111111111111111111111111111111111112");
const quoteMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const oracle = new PublicKey("11111111111111111111111111111111");
const slotHash = new Uint8Array(32).fill(0xab);

describe("C1 last-swap attestation message", () => {
  test("builds a 112-byte message with the canonical layout", () => {
    const att = {
      ammProgramId: amm,
      poolAddress: pool,
      lastSwapUnixTs: 1_700_000_000,
      issuedSlot: 200_000_000,
      slotHash,
    };
    const msg = buildAttestationMessage(att);
    assert.equal(msg.length, ATTESTATION_MSG_LEN);

    // Byte layout:
    //   0..32   = amm
    //   32..64  = pool
    //   64..72  = lastSwapUnixTs (i64 LE)
    //   72..80  = issuedSlot (u64 LE)
    //   80..112 = slotHash (32 bytes)
    assert.deepEqual(Buffer.from(msg.slice(0, 32)), Buffer.from(amm.toBytes()));
    assert.deepEqual(Buffer.from(msg.slice(32, 64)), Buffer.from(pool.toBytes()));
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    assert.equal(view.getBigInt64(64, true), 1_700_000_000n);
    assert.equal(view.getBigUint64(72, true), 200_000_000n);
    assert.deepEqual(Buffer.from(msg.slice(80, 112)), Buffer.from(slotHash));
  });

  test("parseAttestationMessage round-trips the same values", () => {
    const att = {
      ammProgramId: amm,
      poolAddress: pool,
      lastSwapUnixTs: 1_700_000_000,
      issuedSlot: 200_000_000,
      slotHash,
    };
    const msg = buildAttestationMessage(att);
    const parsed = parseAttestationMessage(msg);
    assert.equal(parsed.ammProgramId.toBase58(), amm.toBase58());
    assert.equal(parsed.poolAddress.toBase58(), pool.toBase58());
    assert.equal(parsed.lastSwapUnixTs, att.lastSwapUnixTs);
    assert.equal(parsed.issuedSlot, att.issuedSlot);
    assert.deepEqual(Buffer.from(parsed.slotHash), Buffer.from(slotHash));
  });

  test("wrong-length message throws", () => {
    assert.throws(
      () => parseAttestationMessage(new Uint8Array(111)),
      /attestation message must be 112 bytes/,
    );
  });
});

describe("C1 ed25519 precompile instruction", () => {
  test("produces a 112-byte instruction data with the canonical wire layout", () => {
    const msg = new Uint8Array(ATTESTATION_MSG_LEN).fill(0);
    const sig = new Uint8Array(64).fill(0xcd);
    const ix = buildEd25519VerifyInstruction({
      signature: sig,
      oraclePublicKey: oracle,
      message: msg,
      scannerInstructionIndex: 1,
    });
    assert.equal(ix.programId.toBase58(), ED25519_PROGRAM_ID.toBase58());
    assert.ok(ix.data instanceof Uint8Array || ix.data instanceof Buffer);
    const data = Buffer.isBuffer(ix.data) ? ix.data : Buffer.from(ix.data);
    assert.equal(data.length, PRECOMPILE_MIN_LEN); // 112 bytes

    // data[0] = signature count = 1
    assert.equal(data[0], 1);
    // data[1] = padding = 0
    assert.equal(data[1], 0);
    // Offsets struct at byte 2: 7 × u16 LE
    assert.equal(data.readUInt16LE(2), PRECOMPILE_SIG_OFFSET); // sig_offset
    assert.equal(data.readUInt16LE(4), 0xffff); // sig_instruction_index = cur
    assert.equal(data.readUInt16LE(6), PRECOMPILE_PK_OFFSET); // pk_offset
    assert.equal(data.readUInt16LE(8), 0xffff); // pk_instruction_index = cur
    assert.equal(data.readUInt16LE(10), IX_DATA_MSG_OFFSET); // message_data_offset = 72
    assert.equal(data.readUInt16LE(12), ATTESTATION_MSG_LEN); // message_data_size = 112
    assert.equal(data.readUInt16LE(14), 1); // message_instruction_index = scanner ix idx

    // pk@16, sig@48
    assert.deepEqual(data.slice(PRECOMPILE_PK_OFFSET, PRECOMPILE_PK_OFFSET + 32), Buffer.from(oracle.toBytes()));
    assert.deepEqual(data.slice(PRECOMPILE_SIG_OFFSET, PRECOMPILE_SIG_OFFSET + 64), Buffer.from(sig));
  });

  test("rejects a non-canonical (offset, length) pair", () => {
    // A 100-byte message at offset 72 is not the canonical C1 (72, 112) or C2 (152, 168) span.
    assert.throws(
      () =>
        buildEd25519VerifyInstruction({
          signature: new Uint8Array(64),
          oraclePublicKey: oracle,
          message: new Uint8Array(100),
          scannerInstructionIndex: 1,
        }),
      /canonical span/,
    );
  });

  test("rejects a 65-byte signature", () => {
    assert.throws(
      () =>
        buildEd25519VerifyInstruction({
          signature: new Uint8Array(65),
          oraclePublicKey: oracle,
          message: new Uint8Array(ATTESTATION_MSG_LEN),
          scannerInstructionIndex: 1,
        }),
      /signature must be exactly 64 bytes/,
    );
  });
});

describe("C2 launch-price attestation message", () => {
  test("builds a 168-byte message with the canonical layout", () => {
    const att = {
      ammProgramId: amm,
      poolAddress: pool,
      baseMint,
      quoteMint,
      firstSwapSlot: 100_000_000,
      firstSwapUnixTs: 1_700_000_000,
      launchPriceQ64x64: 1n << 64n, // 1.0 in Q64.64
      issuedSlot: 200_000_000,
    };
    const msg = buildLaunchPriceMessage(att);
    assert.equal(msg.length, LAUNCH_PRICE_MSG_LEN);

    // Byte layout:
    //   0..32   = amm
    //   32..64  = pool
    //   64..96  = baseMint
    //   96..128 = quoteMint
    //   128..136 = firstSwapSlot (u64 LE)
    //   136..144 = firstSwapUnixTs (i64 LE)
    //   144..160 = launchPriceQ64x64 (u128 LE)
    //   160..168 = issuedSlot (u64 LE)
    assert.deepEqual(Buffer.from(msg.slice(0, 32)), Buffer.from(amm.toBytes()));
    assert.deepEqual(Buffer.from(msg.slice(32, 64)), Buffer.from(pool.toBytes()));
    assert.deepEqual(Buffer.from(msg.slice(64, 96)), Buffer.from(baseMint.toBytes()));
    assert.deepEqual(Buffer.from(msg.slice(96, 128)), Buffer.from(quoteMint.toBytes()));
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    assert.equal(view.getBigUint64(128, true), 100_000_000n);
    assert.equal(view.getBigInt64(136, true), 1_700_000_000n);
    // u128 at offset 144 — read 16 bytes LE
    let u128 = 0n;
    for (let i = 15; i >= 0; i--) u128 = (u128 << 8n) | BigInt(msg[144 + i]!);
    assert.equal(u128, 1n << 64n);
    assert.equal(view.getBigUint64(160, true), 200_000_000n);
  });

  test("parseLaunchPriceMessage round-trips the same values", () => {
    const att = {
      ammProgramId: amm,
      poolAddress: pool,
      baseMint,
      quoteMint,
      firstSwapSlot: 100_000_000,
      firstSwapUnixTs: 1_700_000_000,
      launchPriceQ64x64: 0xdead_beefn,
      issuedSlot: 200_000_000,
    };
    const msg = buildLaunchPriceMessage(att);
    const parsed = parseLaunchPriceMessage(msg);
    assert.equal(parsed.ammProgramId.toBase58(), amm.toBase58());
    assert.equal(parsed.poolAddress.toBase58(), pool.toBase58());
    assert.equal(parsed.baseMint.toBase58(), baseMint.toBase58());
    assert.equal(parsed.quoteMint.toBase58(), quoteMint.toBase58());
    assert.equal(parsed.firstSwapSlot, att.firstSwapSlot);
    assert.equal(parsed.firstSwapUnixTs, att.firstSwapUnixTs);
    assert.equal(parsed.launchPriceQ64x64, att.launchPriceQ64x64);
    assert.equal(parsed.issuedSlot, att.issuedSlot);
  });

  test("wrong-length message throws", () => {
    assert.throws(
      () => parseLaunchPriceMessage(new Uint8Array(167)),
      /launch-price attestation message must be 168 bytes/,
    );
  });

  test("u128 out of range throws", () => {
    assert.throws(
      () =>
        buildLaunchPriceMessage({
          ammProgramId: amm,
          poolAddress: pool,
          baseMint,
          quoteMint,
          firstSwapSlot: 1,
          firstSwapUnixTs: 1,
          launchPriceQ64x64: 1n << 128n, // out of range
          issuedSlot: 1,
        }),
      /launch price must fit in an unsigned 128-bit integer/,
    );
  });
});

describe("C2 ed25519 precompile instruction (uses 168-byte message at offset 152)", () => {
  test("uses LAUNCH_PRICE_MSG_OFFSET (152) for the message_data_offset", () => {
    const sig = new Uint8Array(64).fill(0xee);
    const ix = buildLaunchPriceEd25519VerifyInstruction({
      signature: sig,
      oraclePublicKey: oracle,
      recordInstructionIndex: 1,
    });
    const data = Buffer.isBuffer(ix.data) ? ix.data : Buffer.from(ix.data);
    assert.equal(data.length, PRECOMPILE_MIN_LEN);
    assert.equal(data[0], 1); // num_signatures
    assert.equal(data.readUInt16LE(10), LAUNCH_PRICE_MSG_OFFSET); // message_data_offset
    assert.equal(data.readUInt16LE(12), LAUNCH_PRICE_MSG_LEN); // message_data_size = 168
    assert.equal(data.readUInt16LE(14), 1); // record_instruction_index = 1
  });
});
