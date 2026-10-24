// SPDX-License-Identifier: Apache-2.0
//
// Snapshot canonical-order regression test (FLEET-M0 audit F7).
//
// `snapshotLpHolders` used to sort owner keys by base58 STRING, while
// `SnapshotMerkleTree.fromEntries` (mirroring the Rust BTreeMap<Pubkey>
// reference) requires ascending owner BYTES. The two orders diverge for
// key pairs whose base58 encodings differ in length — a few-percent
// probability per random pair — so snapshots intermittently threw
// "SnapshotMerkleTree: entries not sorted".
//
// This test pins the byte-order contract with a PROVABLY divergent pair.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";

import {
  snapshotLpHolders,
  SPL_TOKEN_PROGRAM_ID,
  RAYDIUM_V4_PROGRAM_ID,
} from "../src/index.js";
import { encodeMint, encodeTokenAccount, encodeAmmInfo } from "./fakeRpc.js";

/** Byte comparison — mirrors SnapshotMerkleTree's canonical order. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Search for a pair whose base58-string order OPPOSES byte order. */
function findDivergentPair(): { smallByBytes: PublicKey; largeByBytes: PublicKey } {
  for (let attempt = 0; attempt < 200_000; attempt++) {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const bytesCmp = compareBytes(a.toBytes(), b.toBytes());
    if (bytesCmp === 0) continue;
    const strCmp = a.toBase58() < b.toBase58() ? -1 : 1;
    if (Math.sign(bytesCmp) !== strCmp) {
      return bytesCmp < 0
        ? { smallByBytes: a, largeByBytes: b }
        : { smallByBytes: b, largeByBytes: a };
    }
  }
  throw new Error("no divergent pair found in budget — alphabet assumption changed?");
}

/** Minimal in-memory connection for the snapshot pipeline. */
class SnapshotFakeRpc {
  readonly accounts = new Map<string, AccountInfo<Uint8Array>>();
  setAccount(address: PublicKey, data: Uint8Array, owner: PublicKey): void {
    this.accounts.set(address.toBase58(), {
      lamports: 1_000_000,
      data: Buffer.from(data),
      owner,
      executable: false,
      rentEpoch: 0n,
    } as AccountInfo<Uint8Array>);
  }
  asConnection(): Connection {
    return this as unknown as Connection;
  }
  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    return this.accounts.get(address.toBase58()) ?? null;
  }
  async getProgramAccounts(
    programId: PublicKey,
    opts?: { filters?: Array<{ dataSize?: number; memcmp?: { offset: number; bytes: string } }> },
  ): Promise<Array<{ pubkey: PublicKey; account: AccountInfo<Uint8Array> }>> {
    const out: Array<{ pubkey: PublicKey; account: AccountInfo<Uint8Array> }> = [];
    const dataSize = opts?.filters?.find((f) => f.dataSize !== undefined)?.dataSize;
    const memcmp = opts?.filters?.find((f) => f.memcmp !== undefined)?.memcmp;
    const expectMint = memcmp ? new PublicKey(memcmp.bytes) : null;
    for (const [addr, account] of this.accounts) {
      if (!account.owner.equals(programId)) continue;
      if (dataSize !== undefined && account.data.length !== dataSize) continue;
      if (expectMint) {
        const mint = new PublicKey(account.data.subarray(0, 32));
        if (!mint.equals(expectMint)) continue;
      }
      out.push({ pubkey: new PublicKey(addr), account });
    }
    return out;
  }
  async getSlot(): Promise<number> {
    return 1;
  }
}

describe("snapshotLpHolders canonical ordering (F7 regression)", () => {
  test("provably divergent pair: snapshot sorts by BYTES, tree accepts", async () => {
    const { smallByBytes, largeByBytes } = findDivergentPair();
    // Sanity: this pair REALLY diverges (string order opposite to bytes).
    assert.ok(smallByBytes.toBase58() > largeByBytes.toBase58());

    const rpc = new SnapshotFakeRpc();
    const poolAddress = Keypair.generate().publicKey;
    const lpMint = Keypair.generate().publicKey;
    const coinVault = Keypair.generate().publicKey;
    const pcVault = Keypair.generate().publicKey;
    const coinMint = Keypair.generate().publicKey;
    const pcMint = Keypair.generate().publicKey;

    rpc.setAccount(
      poolAddress,
      encodeAmmInfo({ coinVault, pcVault, baseMint: coinMint, quoteMint: pcMint, lpMint }),
      RAYDIUM_V4_PROGRAM_ID,
    );
    rpc.setAccount(lpMint, encodeMint(9, 1000n), SPL_TOKEN_PROGRAM_ID);
    // Holder token accounts (keyed at fresh pubkeys, owner fields = the holders).
    const acctFor = (owner: PublicKey, amount: bigint): Uint8Array => {
      const buf = new Uint8Array(165);
      buf.set(lpMint.toBytes(), 0);
      buf.set(owner.toBytes(), 32);
      const view = new DataView(buf.buffer);
      view.setBigUint64(64, amount, true);
      view.setUint8(108, 1);
      return buf;
    };
    rpc.setAccount(Keypair.generate().publicKey, acctFor(smallByBytes, 300n), SPL_TOKEN_PROGRAM_ID);
    rpc.setAccount(Keypair.generate().publicKey, acctFor(largeByBytes, 700n), SPL_TOKEN_PROGRAM_ID);

    const result = await snapshotLpHolders(rpc.asConnection(), poolAddress);
    // Canonical (byte) order — smallByBytes first even though its base58
    // string sorts second.
    assert.equal(result.snapshot.holders[0]?.holder.toBase58(), smallByBytes.toBase58());
    assert.equal(result.snapshot.holders[1]?.holder.toBase58(), largeByBytes.toBase58());
    // The tree accepted the ordering (no throw), Σ == supply, root is 32 bytes.
    assert.equal(result.snapshot.holders.length, 2);
    assert.equal(result.snapshot.totalSupply.toString(10), "1000");
    assert.equal(result.tree.root().length, 32);
  });
});
