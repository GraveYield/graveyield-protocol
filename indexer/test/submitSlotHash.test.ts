// SPDX-License-Identifier: Apache-2.0
//
// C1 attestation pairing regression tests for `submit.ts` (finding F1).
//
// Pins the indexer-side contract of the SlotHashes fix: the attestation
// submitted to GraveScanner phase 1 must embed EXACTLY the (slot, hash)
// pair returned by the SDK's canonical SlotHashes reader — the slot is the
// real sysvar entry's slot (never `getSlot()` arithmetic, never a
// manufactured slot) and the hash is that entry's hash (never
// `getBlock(slot).blockhash`). When no valid sysvar entry can be read,
// the submission must FAIL CLOSED — no fabricated or fallback attestation
// may be assembled or sent.
//
// The connection fake exposes ONLY `getAccountInfo` (the sysvar read) and
// throwing traps for `getBlock` / `getSlot`; the send path is captured via
// the `sendOverride` test seam, so nothing touches a network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_SLOT_HASHES_PUBKEY,
  TransactionInstruction,
  type AccountInfo,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { buildAttestationMessage, parseAttestationMessage } from "@graveyield/sdk";

import { type Candidate } from "../src/index.js";
import { submitCandidate } from "../src/submit.js";
import { DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID } from "../src/config.js";
import type { IndexerConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RAYDIUM_V4_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
/** Wrong owner — a real program id that is NOT the Sysvar program. */
const WRONG_OWNER = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function hashFor(slot: number, fill: number): Uint8Array {
  const hash = new Uint8Array(32).fill(fill);
  new DataView(hash.buffer).setBigUint64(0, BigInt(slot), true);
  return hash;
}

/** Encode a SlotHashes sysvar account from (slot, fill) pairs, newest-first. */
function encodeSlotHashes(entries: ReadonlyArray<readonly [number, number]>): Buffer {
  const buf = Buffer.alloc(8 + entries.length * 40);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setBigUint64(0, BigInt(entries.length), true);
  entries.forEach(([slot, fill], i) => {
    view.setBigUint64(8 + i * 40, BigInt(slot), true);
    buf.set(hashFor(slot, fill), 8 + i * 40 + 8);
  });
  return buf;
}

class SubmitFakeRpc {
  sysvarData: Buffer | null = encodeSlotHashes([
    [300_000_004, 0xd4],
    [300_000_002, 0xd2],
    [300_000_001, 0xd1],
  ]);
  sysvarOwner: PublicKey = new PublicKey("Sysvar1111111111111111111111111111111111111");
  readonly getAccountInfoCalls: Array<{ address: string; commitment: string | undefined }> = [];

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  async getAccountInfo(address: PublicKey, commitment?: string) {
    this.getAccountInfoCalls.push({ address: address.toBase58(), commitment });
    if (!address.equals(SYSVAR_SLOT_HASHES_PUBKEY) || this.sysvarData === null) return null;
    return {
      lamports: 1_000_000,
      data: Buffer.from(this.sysvarData),
      owner: this.sysvarOwner,
      executable: false,
      rentEpoch: 0n,
    } as AccountInfo<Uint8Array>;
  }

  async getBlock(_slot: number, _opts?: unknown): Promise<never> {
    throw new Error("SubmitFakeRpc: getBlock MUST NOT be called (F1 regression)");
  }

  async getSlot(_commitment?: string): Promise<never> {
    throw new Error("SubmitFakeRpc: getSlot MUST NOT be called (no slot arithmetic)");
  }
}

function makeConfig(): IndexerConfig {
  return {
    rpcUrl: "http://127.0.0.1:8899",
    cluster: "devnet",
    scannerProgramId: DEVNET_SCANNER_PROGRAM_ID,
    vaultProgramId: DEVNET_VAULT_PROGRAM_ID,
    activityOracleSecretKey: null, // oracle keypair is passed via opts
    activityOraclePublicKey: PublicKey.default,
    minTvlLamports: 500_000_000n,
    inactivitySeconds: 7_776_000n,
    priceCollapseBps: 9_900,
    lpBurnDustThreshold: 1_000n,
    maxCandidatesPerCycle: 10,
    pollIntervalMs: 1_000,
    maxPoolsPerScan: 100,
    signatureScanLimit: 1000,
  };
}

function makeCandidate(): Candidate {
  const pool = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  return {
    poolAddress: pool,
    ammProgramId: RAYDIUM_V4_PROGRAM_ID,
    discovery: {
      poolAddress: pool,
      pool: {
        coinVault: PublicKey.default,
        pcVault: PublicKey.default,
        baseMint: PublicKey.default,
        quoteMint: PublicKey.default,
        lpMint: PublicKey.default,
      },
      fetchedAtSlot: 0,
    },
    activity: {
      poolAddress: pool,
      lastSwapUnixTs: 1_700_000_000,
      lastSwapSlot: 299_999_900,
      lastSwapSignature: "5FakesigNatureForTheLastSwapDerivationProvenanceOnlyxxxxxxxxxxx",
      noSwapFound: false,
      unresolved: false,
    },
    reserves: {
      poolAddress: pool,
      coinReserve: 0n,
      pcReserve: 0n,
      lpSupply: 0n,
      wsolSideIdentified: true,
      tvlLamports: 600_000_000n,
    },
    metadata: {
      poolAddress: pool,
      baseMint: PublicKey.default,
      baseDecimals: 9,
      baseSupply: 0n,
      quoteMint: PublicKey.default,
      quoteDecimals: 6,
      quoteSupply: 0n,
      lpMint: PublicKey.default,
      lpDecimals: 2,
      lpSupply: 0n,
    },
    preFilter: { poolAddress: pool, passed: true, failedCriteria: [], criteriaBitmap: 0x3f },
  };
}

/** Capture the assembled transaction instead of sending it. */
function captureSend(): {
  send: (connection: unknown, tx: unknown, signers: unknown[]) => Promise<string>;
  transactions: Array<{ instructions: TransactionInstruction[]; signers: unknown[] }>;
} {
  const transactions: Array<{ instructions: TransactionInstruction[]; signers: unknown[] }> = [];
  const send = async (
    _connection: unknown,
    tx: { instructions: TransactionInstruction[] },
    signers: unknown[],
  ) => {
    transactions.push({ instructions: tx.instructions, signers });
    return "captured-signature";
  };
  return { send: send as never, transactions };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("submitCandidate C1 (slot, hash) pairing (F1 regression)", () => {
  test("attestation embeds the exact SlotHashes pair, signed by the oracle", async () => {
    const rpc = new SubmitFakeRpc();
    const config = makeConfig();
    const oracleKeypair = await Keypair.generate();
    const writer = await Keypair.generate();
    const { send, transactions } = captureSend();

    const result = await submitCandidate(rpc.asConnection(), config, makeCandidate(), {
      writer,
      oracleKeypair,
      sendOverride: send,
    });

    assert.equal(result.status, "confirmed");
    assert.equal(transactions.length, 1);
    const ixs = transactions[0].instructions;
    assert.equal(ixs.length, 2);
    // 0: ed25519 precompile verify — 1: GraveScanner phase 1.
    assert.ok(String(ixs[0].programId.toBase58()).startsWith("Ed25519SigVerify"));
    assert.ok(ixs[1].programId.equals(DEVNET_SCANNER_PROGRAM_ID));

    // The 112-byte attestation lives at offset 72 in the phase 1 ix data
    // (8B discriminator + 32B amm + 32B pool).
    const phase1Data = ixs[1].data;
    assert.ok(phase1Data.length >= 184);
    const msg = Uint8Array.prototype.slice.call(phase1Data, 72, 184);
    const att = parseAttestationMessage(msg);

    // The attested pair is EXACTLY the sysvar snapshot's newest entry.
    assert.equal(att.issuedSlot, 300_000_004);
    assert.deepEqual(Buffer.from(att.slotHash), Buffer.from(hashFor(300_000_004, 0xd4)));
    assert.ok(att.ammProgramId.equals(RAYDIUM_V4_PROGRAM_ID));
    assert.ok(att.poolAddress.equals(makeCandidate().poolAddress));
    assert.equal(att.lastSwapUnixTs, 1_700_000_000);

    // The hash is that slot's sysvar hash — not `getBlock().blockhash`
    // (the fake's getBlock trap throws; reaching here proves it never ran)
    // and not another entry's hash.
    assert.notDeepEqual(Buffer.from(att.slotHash), Buffer.from(hashFor(300_000_002, 0xd2)));

    // The oracle signature covers exactly the embedded message bytes.
    const sig = Uint8Array.prototype.slice.call(ixs[0].data, 48, 112);
    assert.ok(
      nacl.sign.detached.verify(msg, sig, oracleKeypair.publicKey.toBytes()),
      "the oracle signature must verify over the embedded 112-byte message",
    );

    // One canonical finalized sysvar read, nothing else on the connection.
    assert.equal(rpc.getAccountInfoCalls.length, 1);
    assert.equal(rpc.getAccountInfoCalls[0].address, SYSVAR_SLOT_HASHES_PUBKEY.toBase58());
    assert.equal(rpc.getAccountInfoCalls[0].commitment, "finalized");
  });

  test("the message the SDK builds from the pair matches the signed message", async () => {
    // Cross-check: rebuild the attestation from an independent
    // fetchRecentSlotHash-style read of the same fixture bytes and confirm
    // the embedded message equals the canonical `buildAttestationMessage`.
    const rpc = new SubmitFakeRpc();
    const config = makeConfig();
    const oracleKeypair = await Keypair.generate();
    const writer = await Keypair.generate();
    const { send, transactions } = captureSend();
    await submitCandidate(rpc.asConnection(), config, makeCandidate(), {
      writer,
      oracleKeypair,
      sendOverride: send,
    });
    const ixs = transactions[0].instructions;
    const embedded = Uint8Array.prototype.slice.call(ixs[1].data, 72, 184);
    const rebuilt = buildAttestationMessage({
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: makeCandidate().poolAddress,
      lastSwapUnixTs: 1_700_000_000,
      issuedSlot: 300_000_004,
      slotHash: hashFor(300_000_004, 0xd4),
    });
    assert.deepEqual(Buffer.from(embedded), Buffer.from(rebuilt));
  });

  test("sysvar account missing → failed, no transaction sent (fail closed)", async () => {
    const rpc = new SubmitFakeRpc();
    rpc.sysvarData = null;
    const { send, transactions } = captureSend();
    const result = await submitCandidate(rpc.asConnection(), makeConfig(), makeCandidate(), {
      writer: await Keypair.generate(),
      oracleKeypair: await Keypair.generate(),
      sendOverride: send,
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /SlotHashes/);
    assert.equal(transactions.length, 0, "no fabricated or fallback attestation may be sent");
  });

  test("malformed sysvar (wrong owner) → failed, no transaction sent", async () => {
    const rpc = new SubmitFakeRpc();
    rpc.sysvarOwner = WRONG_OWNER;
    const { send, transactions } = captureSend();
    const result = await submitCandidate(rpc.asConnection(), makeConfig(), makeCandidate(), {
      writer: await Keypair.generate(),
      oracleKeypair: await Keypair.generate(),
      sendOverride: send,
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /SlotHashes/);
    assert.equal(transactions.length, 0);
  });

  test("no oracle key → skipped (unchanged discovery-only behavior)", async () => {
    const rpc = new SubmitFakeRpc();
    const config = makeConfig();
    const { send, transactions } = captureSend();
    const result = await submitCandidate(rpc.asConnection(), config, makeCandidate(), {
      writer: await Keypair.generate(),
      sendOverride: send,
    });
    assert.equal(result.status, "skipped");
    assert.equal(transactions.length, 0);
    assert.equal(rpc.getAccountInfoCalls.length, 0, "no sysvar read before the oracle check");
  });
});
