// SPDX-License-Identifier: Apache-2.0
//
// SlotHashes sysvar retrieval tests (C1 slot/hash pairing — the fix for
// lifecycle-rehearsal finding F1: `getBlock(slot).blockhash` is NOT the
// `(slot, hash)` entry GraveScanner resolves on-chain). Pins the canonical
// reader against the sysvar layout the on-chain `attestation.rs`
// `slot_hash_lookup` consumes: 8-byte u64 LE entry count, then 40-byte
// `(u64 LE slot, [u8;32] hash)` entries, newest-first, ≤ 512 entries.
//
// All RPC surface is mocked in-memory (mirrors fakeRpc.ts conventions):
// the fake records every `getAccountInfo` call (address + commitment) and
// THROWS on `getBlock` / `getSlot` — so any regression back to the
// blockhash-based lookup or to `getSlot()` arithmetic fails loudly.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  PublicKey,
  SYSVAR_SLOT_HASHES_PUBKEY,
  type AccountInfo,
  type Connection,
} from "@solana/web3.js";

import {
  SLOT_HASHES_ENTRY_LEN,
  SLOT_HASHES_HEADER_LEN,
  SLOT_HASHES_MAX_ENTRIES,
  SYSVAR_PROGRAM_ID,
  SlotHashesAccountInvalidError,
  buildAttestationMessage,
  fetchRecentSlotHash,
  fetchSlotHash,
  fetchSlotHashesSnapshot,
  parseAttestationMessage,
  parseSlotHashesAccount,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Byte-exact sysvar encoder + recording fake RPC
// ---------------------------------------------------------------------------

/** Deterministic 32-byte hash fixture: `fill` byte, first 8 bytes carry the slot LE. */
function hashFor(slot: number, fill: number): Uint8Array {
  const hash = new Uint8Array(32).fill(fill);
  const view = new DataView(hash.buffer);
  view.setBigUint64(0, BigInt(slot), true);
  return hash;
}

/** Byte offset of entry `i`'s 32-byte hash inside the encoded sysvar data. */
function hashByteOffset(i: number): number {
  return SLOT_HASHES_HEADER_LEN + i * SLOT_HASHES_ENTRY_LEN + 8;
}

/** Encode a SlotHashes sysvar account from (slot, fill) pairs, newest-first. */
function encodeSlotHashes(entries: ReadonlyArray<readonly [number, number]>): Buffer {
  const buf = Buffer.alloc(SLOT_HASHES_HEADER_LEN + entries.length * SLOT_HASHES_ENTRY_LEN);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setBigUint64(0, BigInt(entries.length), true);
  entries.forEach(([slot, fill], i) => {
    const base = SLOT_HASHES_HEADER_LEN + i * SLOT_HASHES_ENTRY_LEN;
    view.setBigUint64(base, BigInt(slot), true);
    buf.set(hashFor(slot, fill), base + 8);
  });
  return buf;
}

/** Wrong owner — a real program id that is NOT the Sysvar program. */
const WRONG_OWNER = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

interface SysvarCall {
  address: string;
  commitment: string | undefined;
}

/**
 * In-memory Connection covering the SlotHashes reader's surface. Methods
 * the retrieval path must NEVER use (`getBlock`, `getSlot`) are present
 * as throwing traps on purpose: any call fails the test loudly.
 */
class SlotHashesFakeRpc {
  readonly accounts = new Map<string, AccountInfo<Uint8Array>>();
  readonly getAccountInfoCalls: SysvarCall[] = [];

  setSysvar(data: Uint8Array | null, opts?: { owner?: PublicKey; executable?: boolean }): void {
    if (data === null) {
      this.accounts.delete(SYSVAR_SLOT_HASHES_PUBKEY.toBase58());
      return;
    }
    this.accounts.set(SYSVAR_SLOT_HASHES_PUBKEY.toBase58(), {
      lamports: 1_000_000,
      data: Buffer.from(data),
      owner: opts?.owner ?? SYSVAR_PROGRAM_ID,
      executable: opts?.executable ?? false,
      rentEpoch: 0n,
    } as AccountInfo<Uint8Array>);
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  async getAccountInfo(
    address: PublicKey,
    commitment?: string,
  ): Promise<AccountInfo<Uint8Array> | null> {
    this.getAccountInfoCalls.push({ address: address.toBase58(), commitment });
    return this.accounts.get(address.toBase58()) ?? null;
  }

  async getBlock(_slot: number, _opts?: unknown): Promise<never> {
    throw new Error("SlotHashesFakeRpc: getBlock MUST NOT be called (F1 regression)");
  }

  async getSlot(_commitment?: string): Promise<never> {
    throw new Error("SlotHashesFakeRpc: getSlot MUST NOT be called (no slot arithmetic)");
  }
}

// A real, valid snapshot: three entries, newest-first, strictly descending.
const SNAPSHOT: ReadonlyArray<readonly [number, number]> = [
  [300_000_004, 0xd4],
  [300_000_002, 0xd2],
  [300_000_001, 0xd1],
];

describe("parseSlotHashesAccount (canonical sysvar parser)", () => {
  test("parses multiple entries strictly descending, hashes copied", () => {
    const data = encodeSlotHashes(SNAPSHOT);
    const entries = parseSlotHashesAccount(data);
    assert.equal(entries.length, 3);
    SNAPSHOT.forEach(([slot, fill], i) => {
      const entry = entries[i];
      assert.ok(entry);
      assert.equal(entry.slot, slot);
      assert.deepEqual(Buffer.from(entry.hash), Buffer.from(hashFor(slot, fill)));
    });
    // Newest-first order preserved.
    const first = entries[0];
    const second = entries[1];
    const third = entries[2];
    assert.ok(first && second && third);
    assert.ok(first.slot > second.slot && second.slot > third.slot);
  });

  test("accepts exactly 512 entries (the protocol freshness window)", () => {
    const many: Array<readonly [number, number]> = [];
    for (let i = 0; i < SLOT_HASHES_MAX_ENTRIES; i++) {
      many.push([10_000_000 - i * 2, (i * 7 + 1) % 256]);
    }
    const entries = parseSlotHashesAccount(encodeSlotHashes(many));
    assert.equal(entries.length, SLOT_HASHES_MAX_ENTRIES);
    const head = entries[0];
    const tail = entries[SLOT_HASHES_MAX_ENTRIES - 1];
    assert.ok(head && tail);
    assert.equal(head.slot, 10_000_000);
    assert.equal(tail.slot, 10_000_000 - (SLOT_HASHES_MAX_ENTRIES - 1) * 2);
  });

  test("parses an empty sysvar (count 0) to no entries", () => {
    const entries = parseSlotHashesAccount(Buffer.alloc(SLOT_HASHES_HEADER_LEN));
    assert.deepEqual(entries, []);
  });

  test("throws on a truncated header", () => {
    assert.throws(
      () => parseSlotHashesAccount(Buffer.alloc(SLOT_HASHES_HEADER_LEN - 1)),
      SlotHashesErrorMatcher("truncated header"),
    );
    assert.throws(
      () => parseSlotHashesAccount(new Uint8Array(0)),
      SlotHashesErrorMatcher("truncated header"),
    );
  });

  test("throws on a truncated entry", () => {
    const data = encodeSlotHashes(SNAPSHOT);
    const truncated = data.subarray(0, data.length - 1); // last hash byte missing
    assert.throws(
      () => parseSlotHashesAccount(truncated),
      SlotHashesErrorMatcher("serialized length"),
    );
  });

  test("throws on an entry count above the 512-entry window", () => {
    const data = encodeSlotHashes(SNAPSHOT);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setBigUint64(0, BigInt(SLOT_HASHES_MAX_ENTRIES + 1), true);
    assert.throws(
      () => parseSlotHashesAccount(data),
      SlotHashesErrorMatcher("exceeds the 512-entry window"),
    );
  });

  test("throws on an absurd u64 entry count (no length overflow)", () => {
    const data = encodeSlotHashes(SNAPSHOT);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setBigUint64(0, 1n << 40n);
    assert.throws(
      () => parseSlotHashesAccount(data),
      SlotHashesErrorMatcher("exceeds the 512-entry window"),
    );
  });

  test("throws on unexpected trailing bytes", () => {
    const data = encodeSlotHashes(SNAPSHOT);
    const withTrailing = Buffer.concat([data, Buffer.from([0x00])]);
    assert.throws(
      () => parseSlotHashesAccount(withTrailing),
      SlotHashesErrorMatcher("serialized length"),
    );
  });

  test("throws on duplicate slots", () => {
    const data = encodeSlotHashes([
      [300_000_002, 0xa1],
      [300_000_002, 0xa2],
      [300_000_001, 0xa3],
    ]);
    assert.throws(
      () => parseSlotHashesAccount(data),
      SlotHashesErrorMatcher("not strictly descending"),
    );
  });

  test("throws on ascending (wrong) ordering", () => {
    const data = encodeSlotHashes([
      [300_000_001, 0xb1],
      [300_000_002, 0xb2],
    ]);
    assert.throws(
      () => parseSlotHashesAccount(data),
      SlotHashesErrorMatcher("not strictly descending"),
    );
  });

  test("throws on a slot at or above 2^53 (unrepresentable in the wire format)", () => {
    const buf = Buffer.alloc(SLOT_HASHES_HEADER_LEN + SLOT_HASHES_ENTRY_LEN);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setBigUint64(0, 1n, true);
    view.setBigUint64(SLOT_HASHES_HEADER_LEN, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
    assert.throws(() => parseSlotHashesAccount(buf), SlotHashesErrorMatcher("safe-integer"));
  });

  test("throws on a non-positive slot entry", () => {
    const data = encodeSlotHashes([[0, 0xc1]]);
    assert.throws(
      () => parseSlotHashesAccount(data),
      SlotHashesErrorMatcher("not a positive slot"),
    );
  });

  test("typed error class: exported, named, instance-checkable", () => {
    try {
      parseSlotHashesAccount(new Uint8Array(3));
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof SlotHashesAccountInvalidError);
      assert.equal(err.name, "SlotHashesAccountInvalidError");
    }
  });
});

describe("fetchSlotHash (exact-slot sysvar lookup)", () => {
  test("returns the correct 32-byte hash for an exactly-present slot", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT));
    const hash = await fetchSlotHash(rpc.asConnection(), 300_000_002);
    assert.ok(hash, "hash for a present slot must resolve");
    assert.equal(hash.length, 32);
    assert.deepEqual(Buffer.from(hash), Buffer.from(hashFor(300_000_002, 0xd2)));
  });

  test("parses every entry of a multi-entry snapshot correctly", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT));
    for (const [slot, fill] of SNAPSHOT) {
      const hash = await fetchSlotHash(rpc.asConnection(), slot);
      assert.ok(hash);
      assert.deepEqual(Buffer.from(hash), Buffer.from(hashFor(slot, fill)));
    }
  });

  test("queries the canonical sysvar address at finalized commitment", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT));
    await fetchSlotHash(rpc.asConnection(), 300_000_001);
    assert.equal(rpc.getAccountInfoCalls.length, 1);
    const call = rpc.getAccountInfoCalls[0];
    assert.ok(call);
    assert.equal(call.address, SYSVAR_SLOT_HASHES_PUBKEY.toBase58());
    assert.equal(call.address, "SysvarS1otHashes111111111111111111111111111");
    assert.equal(call.commitment, "finalized");
  });

  test("returns a copy, not a mutable view into the account buffer", async () => {
    const rpc = new SlotHashesFakeRpc();
    const data = encodeSlotHashes(SNAPSHOT);
    rpc.setSysvar(data);
    // Slot 300_000_002 is entry index 1: fill byte at hashByteOffset(1)+8.
    const hash = await fetchSlotHash(rpc.asConnection(), 300_000_002);
    assert.ok(hash);
    hash[0] = 0xff; // mutate the returned hash
    const fillByteOffset = hashByteOffset(1) + 8;
    assert.equal(data[fillByteOffset], 0xd2); // source buffer untouched
    // A fresh fetch still reflects the serialized bytes.
    const fresh = await fetchSlotHash(rpc.asConnection(), 300_000_002);
    assert.ok(fresh);
    assert.equal(fresh[0], hashFor(300_000_002, 0xd2)[0]);
    assert.equal(fresh[fillByteOffset - hashByteOffset(1)], 0xd2);
  });

  test("account missing → null (no fabrication)", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(null);
    assert.equal(await fetchSlotHash(rpc.asConnection(), 300_000_002), null);
  });

  test("requested slot absent → null, never a nearby slot's hash", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT));
    const absent = await fetchSlotHash(rpc.asConnection(), 300_000_003); // skipped slot
    assert.equal(absent, null);
    // And the aged-out slot below the oldest entry is also null.
    assert.equal(await fetchSlotHash(rpc.asConnection(), 300_000_000), null);
  });

  test("slot aged out of the 512-entry window → null", async () => {
    const rpc = new SlotHashesFakeRpc();
    // Window holds [300_000_004 .. 300_000_001]; anything older is gone.
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT));
    assert.equal(await fetchSlotHash(rpc.asConnection(), 299_999_999), null);
  });

  test("invalid slot argument → TypeError (fail closed before any RPC)", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT));
    for (const bad of [0, -1, -1_000_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(() => fetchSlotHash(rpc.asConnection(), bad as number), TypeError);
    }
    assert.equal(rpc.getAccountInfoCalls.length, 0, "no RPC before argument validation");
  });

  test("wrong owner → null from the reader; typed error from the snapshot", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT), { owner: WRONG_OWNER });
    assert.equal(await fetchSlotHash(rpc.asConnection(), 300_000_002), null);
    await assert.rejects(
      () => fetchSlotHashesSnapshot(rpc.asConnection()),
      SlotHashesErrorMatcher("is not the Sysvar program"),
    );
  });

  test("executable account → null from the reader; typed error from the snapshot", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT), { executable: true });
    assert.equal(await fetchSlotHash(rpc.asConnection(), 300_000_002), null);
    await assert.rejects(
      () => fetchSlotHashesSnapshot(rpc.asConnection()),
      SlotHashesErrorMatcher("executable"),
    );
  });

  test("malformed serialized data → null from the reader", async () => {
    const rpc = new SlotHashesFakeRpc();
    const bads = [
      Buffer.alloc(SLOT_HASHES_HEADER_LEN - 1), // truncated header
      encodeSlotHashes(SNAPSHOT).subarray(0, 8 + 3 * SLOT_HASHES_ENTRY_LEN - 1), // truncated entry
      Buffer.concat([encodeSlotHashes(SNAPSHOT), Buffer.from([0x00])]), // trailing byte
      encodeSlotHashes([
        [300_000_002, 0x01],
        [300_000_002, 0x02],
      ]), // duplicate slot
      encodeSlotHashes([
        [1, 0x01],
        [2, 0x02],
      ]), // ascending order
    ];
    for (const bad of bads) {
      rpc.setSysvar(bad);
      assert.equal(await fetchSlotHash(rpc.asConnection(), 300_000_002), null);
    }
  });

  test("genuine RPC failure propagates (never swallowed into null)", async () => {
    const sentinel = new Error("rpc transport down");
    const failing = {
      async getAccountInfo(): Promise<never> {
        throw sentinel;
      },
    } as unknown as Connection;
    await assert.rejects(
      () => fetchSlotHash(failing, 300_000_002),
      (err) => err === sentinel,
    );
    await assert.rejects(
      () => fetchRecentSlotHash(failing),
      (err) => err === sentinel,
    );
    await assert.rejects(
      () => fetchSlotHashesSnapshot(failing),
      (err) => err === sentinel,
    );
  });
});

describe("fetchRecentSlotHash (real recent (slot, hash) pair)", () => {
  test("returns the newest entry's slot AND hash together", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT));
    const recent = await fetchRecentSlotHash(rpc.asConnection());
    assert.ok(recent);
    assert.equal(recent.slot, 300_000_004); // the newest entry
    assert.deepEqual(Buffer.from(recent.hash), Buffer.from(hashFor(300_000_004, 0xd4)));
    // And the hash belongs to THAT slot and no other entry.
    for (const [slot, fill] of SNAPSHOT) {
      if (slot === recent.slot) continue;
      assert.notDeepEqual(Buffer.from(recent.hash), Buffer.from(hashFor(slot, fill)));
    }
  });

  test("queries the canonical sysvar address at finalized commitment", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT));
    await fetchRecentSlotHash(rpc.asConnection());
    const call = rpc.getAccountInfoCalls[0];
    assert.ok(call);
    assert.equal(call.address, SYSVAR_SLOT_HASHES_PUBKEY.toBase58());
    assert.equal(call.commitment, "finalized");
  });

  test("account missing → null", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(null);
    assert.equal(await fetchRecentSlotHash(rpc.asConnection()), null);
  });

  test("empty sysvar → null", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(Buffer.alloc(SLOT_HASHES_HEADER_LEN));
    assert.equal(await fetchRecentSlotHash(rpc.asConnection()), null);
  });

  test("malformed data → null (typed error from the snapshot path)", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(Buffer.alloc(4)); // truncated header
    assert.equal(await fetchRecentSlotHash(rpc.asConnection()), null);
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT), { owner: WRONG_OWNER });
    assert.equal(await fetchRecentSlotHash(rpc.asConnection()), null);
  });

  test("returned hash is a copy", async () => {
    const rpc = new SlotHashesFakeRpc();
    const data = encodeSlotHashes(SNAPSHOT);
    rpc.setSysvar(data);
    const recent = await fetchRecentSlotHash(rpc.asConnection());
    assert.ok(recent);
    recent.hash.fill(0x11);
    const fillByteOffset = hashByteOffset(0) + 8;
    assert.equal(data[fillByteOffset], 0xd4); // serialized byte untouched
    const again = await fetchRecentSlotHash(rpc.asConnection());
    assert.ok(again);
    assert.equal(again.hash[fillByteOffset - hashByteOffset(0)], 0xd4);
  });
});

describe("SlotHashes regressions (F1)", () => {
  test("getBlock() is never called by the retrieval implementation", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT));
    const conn = rpc.asConnection();
    // All three readers succeed — the fake's getBlock/getSlot traps throw on any use.
    assert.ok(await fetchSlotHash(conn, 300_000_002));
    assert.ok(await fetchRecentSlotHash(conn));
    assert.ok(await fetchSlotHashesSnapshot(conn));
    assert.equal(rpc.getAccountInfoCalls.length, 3);
  });

  test("the SDK never returns a hash belonging to a different slot", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT));
    const conn = rpc.asConnection();
    for (const [slot, fill] of SNAPSHOT) {
      const hash = await fetchSlotHash(conn, slot);
      assert.ok(hash);
      // Byte-exact against an independently computed expectation...
      assert.deepEqual(Buffer.from(hash), Buffer.from(hashFor(slot, fill)));
      // ...and distinct from every OTHER entry's hash.
      for (const [otherSlot, otherFill] of SNAPSHOT) {
        if (otherSlot === slot) continue;
        assert.notDeepEqual(Buffer.from(hash), Buffer.from(hashFor(otherSlot, otherFill)));
      }
    }
    for (const absent of [300_000_003, 300_000_005, 299_999_999]) {
      assert.equal(await fetchSlotHash(conn, absent), null);
    }
  });

  test("an attestation built from a reader pair embeds exactly that pair", async () => {
    const rpc = new SlotHashesFakeRpc();
    rpc.setSysvar(encodeSlotHashes(SNAPSHOT));
    const recent = await fetchRecentSlotHash(rpc.asConnection());
    assert.ok(recent);
    const msg = buildAttestationMessage({
      ammProgramId: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
      poolAddress: new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
      lastSwapUnixTs: 1_700_000_000,
      issuedSlot: recent.slot,
      slotHash: recent.hash,
    });
    const parsed = parseAttestationMessage(msg);
    assert.equal(parsed.issuedSlot, recent.slot);
    assert.deepEqual(Buffer.from(parsed.slotHash), Buffer.from(recent.hash));
  });
});

/** assert.throws matcher for `SlotHashesAccountInvalidError` with a reason fragment. */
function SlotHashesErrorMatcher(fragment: string) {
  return (err: unknown): boolean => {
    return err instanceof SlotHashesAccountInvalidError && err.message.includes(fragment);
  };
}
