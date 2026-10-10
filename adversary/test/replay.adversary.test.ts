// SPDX-License-Identifier: Apache-2.0
//
// ADV-RP — repeated salvage attempts & replayed evidence. The replay
// defenses live on-chain (init-once PDAs, fork-proven); this suite pins
// the OFF-CHAIN half of the same wall: snapshot artifacts fail closed
// under tampering, and the standing observer flags manipulated books.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  SnapshotMerkleTree,
  verifyMerkleProof,
  computeLeaf,
  decodeGraveYieldErrorCode,
} from "@graveyield/sdk";
import { VaultObserver, HealthRegistry, AlertManager, type ChainView, type OwnedAccount } from "@graveyield/ops";
import { ByteWriter, key, MEME_MINT } from "./helpers.js";

describe("ADV-RP — Merkle artifacts fail closed", () => {
  const holders = [
    { holder: key("holder-1"), lpBalance: 6_000n },
    { holder: key("holder-2"), lpBalance: 3_000n },
    { holder: key("holder-3"), lpBalance: 1_000n },
  ];

  /** HolderEntry[] in the canonical ascending-owner-byte order the tree demands. */
  function canonical(): Array<{ owner: PublicKey; lpBalance: bigint }> {
    return holders
      .map((h) => ({ owner: h.holder, lpBalance: h.lpBalance }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.owner.toBytes()), Buffer.from(b.owner.toBytes())));
  }

  function buildTree() {
    return SnapshotMerkleTree.fromEntries(canonical());
  }

  test("ADV-RP-01a: an honest proof verifies; a forged balance does not", () => {
    const tree = buildTree();
    const root = tree.root();
    const idx = tree.proof(0) === undefined ? -1 : 0;
    assert.ok(idx >= 0, "proof must exist for the first canonical holder");
    const proof = tree.proof(0)!;
    const leaf = computeLeaf(canonical()[0]!.owner, canonical()[0]!.lpBalance);
    assert.equal(verifyMerkleProof(root, leaf, proof), true);

    // The attack: claim with a different (larger) balance under the same
    // identity — the leaf hash no longer verifies.
    assert.equal(verifyMerkleProof(root, computeLeaf(canonical()[0]!.owner, 9_000n), proof), false);
    // A foreign identity has no leaf in the tree at all.
    assert.equal(verifyMerkleProof(root, computeLeaf(key("attacker"), 6_000n), proof), false);
  });

  test("ADV-RP-01b: unsorted or duplicate entries are refused at build time", () => {
    const unsorted = [...canonical()].reverse();
    assert.throws(() => SnapshotMerkleTree.fromEntries(unsorted), /not sorted/);
    const duplicated = [...canonical(), canonical()[0]!].sort((a, b) =>
      Buffer.compare(Buffer.from(a.owner.toBytes()), Buffer.from(b.owner.toBytes())),
    );
    assert.throws(() => SnapshotMerkleTree.fromEntries(duplicated), /duplicate owner/);
    // A zero balance is equally refused — dead holders cannot claim.
    const zeroed = canonical().map((e, i) => (i === 0 ? { ...e, lpBalance: 0n } : e));
    assert.throws(() => SnapshotMerkleTree.fromEntries(zeroed), /non-positive balance/);
  });

  test("ADV-RP-01c: order cannot move the root; a doctored balance does", () => {
    const t1 = buildTree();
    // Canonical means order-independent: any permutation of the same
    // entries yields the same root, because unsorted input is refused
    // (ADV-RP-01b). Rebuilding is deterministic — bit for bit.
    const t2 = SnapshotMerkleTree.fromEntries(canonical());
    assert.deepEqual(Buffer.from(t1.root()), Buffer.from(t2.root()));
    // A doctored balance moves the root...
    const doctored = SnapshotMerkleTree.fromEntries(
      canonical().map((e, i) => (i === 0 ? { ...e, lpBalance: e.lpBalance * 3n } : e)),
    );
    assert.notDeepEqual(Buffer.from(t1.root()), Buffer.from(doctored.root()));
    // ...and the honest proof no longer verifies against it.
    const proof = t1.proof(0)!;
    assert.equal(verifyMerkleProof(doctored.root(), computeLeaf(canonical()[0]!.owner, canonical()[0]!.lpBalance), proof), false);
  });
});

describe("ADV-RP — the observer flags manipulated books", () => {
  const VAULT = new PublicKey("HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6");

  function encReceipt(f: {
    pool: PublicKey;
    salvor: PublicKey;
    lpAmt: bigint;
    salvorAmt: bigint;
    protocolAmt: bigint;
    total: bigint;
  }): Uint8Array {
    return prefixDisc(AccountDiscBytes.SalvageReceipt, new ByteWriter()
      .pubkey(f.pool).pubkey(f.salvor)
      .u64(f.lpAmt).u64(f.salvorAmt).u64(f.protocolAmt).u64(f.total)
      .u64(28_000_000n).i64(1_700_000_000n)
      .pubkey(MEME_MINT).u64(0n).i64(0n).u8(254)
      .done());
  }

  function encRegistry(f: { pool: PublicKey; total: bigint; claimed: bigint }): Uint8Array {
    return prefixDisc(AccountDiscBytes.PoolRegistry, new ByteWriter()
      .pubkey(new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"))
      .pubkey(f.pool).pubkey(key("salvor"))
      .bytes(new Uint8Array(32).fill(0x11))
      .u64(1_000_000n)
      .u64(f.total).u64(f.claimed)
      .u64(300n).i64(3_000n).u8(252)
      .done());
  }

  function encClaim(f: { pool: PublicKey; holder: PublicKey; amount: bigint }): Uint8Array {
    return prefixDisc(AccountDiscBytes.ClaimRecord, new ByteWriter()
      .pubkey(f.pool).pubkey(f.holder)
      .u64(f.amount).u64(5_000n)
      .u64(200n).i64(2_000n).u8(253)
      .done());
  }

  function makeObserver(accounts: OwnedAccount[]) {
    const alertLog: Array<{ code: string; severity: string }> = [];
    const chain: ChainView = {
      async getProgramAccountsOwned() {
        return accounts;
      },
      async getRecentSignatures() {
        return [];
      },
      async getSlot() {
        return 424_242;
      },
      async getAccountInfo() {
        return null;
      },
    };
    const observer = new VaultObserver({
      vaultProgramId: VAULT,
      chain,
      health: new HealthRegistry("adversary", () => 0),
      alerts: new AlertManager(
        { deliver: (a) => alertLog.push({ code: a.code, severity: a.severity }) },
        30 * 60 * 1000,
        () => 0,
      ),
      pollIntervalMs: 60_000,
    });
    return { observer, alertLog };
  }

  test("ADV-LP-03: claims exceeding the receipt's LP share raise the accounting anomaly (C2)", async () => {
    const pool = key("pool-c2");
    const total = 10_000n;
    const accounts = [
      { pubkey: key("acct-receipt"), owner: VAULT, lamports: 1n, data: encReceipt({ pool, salvor: key("s"), lpAmt: 4_000n, salvorAmt: 4_000n, protocolAmt: 2_000n, total }) },
      { pubkey: key("acct-registry"), owner: VAULT, lamports: 1n, data: encRegistry({ pool, total: 4_000n, claimed: 4_001n }) },
      { pubkey: key("acct-claim"), owner: VAULT, lamports: 1n, data: encClaim({ pool, holder: key("h"), amount: 4_001n }) },
    ];
    const { observer, alertLog } = makeObserver(accounts);
    const observation = await observer.runOnce();
    assert.equal(observation.anomalousReceipts + observation.anomalousRollups > 0, true);
    assert.ok(
      alertLog.some((a) => a.code === "receipt-sum-mismatch" || a.code === "claim-accounting-anomaly"),
      "manipulated books must page the operator",
    );
  });

  test("ADV-RP-02b: clean books page nobody (positive control)", async () => {
    const pool = key("pool-ok");
    const accounts = [
      { pubkey: key("acct-receipt"), owner: VAULT, lamports: 1n, data: encReceipt({ pool, salvor: key("s"), lpAmt: 4_000n, salvorAmt: 4_000n, protocolAmt: 2_000n, total: 10_000n }) },
      { pubkey: key("acct-registry"), owner: VAULT, lamports: 1n, data: encRegistry({ pool, total: 4_000n, claimed: 0n }) },
    ];
    const { observer, alertLog } = makeObserver(accounts);
    const observation = await observer.runOnce();
    assert.equal(observation.anomalousReceipts, 0);
    assert.equal(observation.anomalousRollups, 0);
    assert.equal(alertLog.length, 0);
  });
});

describe("ADV-RP — the replay refusal family has stable codes", () => {
  test("ADV-RP-01: 6034 / 7002 / 7011 / 7021 decode to their guard names", () => {
    assert.equal(decodeGraveYieldErrorCode(6034)?.name, "CertStillValid");
    assert.equal(decodeGraveYieldErrorCode(7002)?.name, "EligibilityCertExpired");
    assert.equal(decodeGraveYieldErrorCode(7011)?.name, "ClaimAlreadyProcessed");
    assert.equal(decodeGraveYieldErrorCode(7021)?.name, "DustAlreadySwept");
  });
});

// ---- local account-prefix helpers (AccountDisc lives in the SDK) ------

import { AccountDisc as AccountDiscSdk } from "@graveyield/sdk";
const AccountDiscBytes = {
  get SalvageReceipt() {
    return AccountDiscSdk.SalvageReceipt;
  },
  get PoolRegistry() {
    return AccountDiscSdk.PoolRegistry;
  },
  get ClaimRecord() {
    return AccountDiscSdk.ClaimRecord;
  },
};

function prefixDisc(disc: readonly number[], body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  out.set(disc, 0);
  out.set(body, 8);
  return out;
}
