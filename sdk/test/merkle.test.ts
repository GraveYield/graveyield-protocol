// SPDX-License-Identifier: Apache-2.0
//
// SnapshotMerkleTree tests — byte-locked against the on-chain verifier
// `grave_vault::merkle::verify_proof` and the fork-proven 3-leaf vector
// from `settlement_economics_fork.rs::build_three_leaf_tree`.
//
// Convention under test (the Phase 4 / Phase 5.2 fork-proven contract):
//
//   * Leaf   = SHA256(pubkey (32B) || lp_balance_le_u64 (8B))   (40-byte preimage)
//   * Parent = SHA256(min(a, b) || max(a, b))                   (sorted pair, 64 bytes)
//   * Odd node at a tree level PROMOTES UNCHANGED to the next level.
//     A promotion contributes NO proof element — the on-chain verifier
//     folds only the siblings the proof carries.
//
// The 3-leaf shape is the canonical fork-test vector:
//
//   leaves [l0, l1, l2] → level 1 [H(l0, l1), l2 (promoted)] → root
//   proof for l0  = [l1, l2]            (2 elements)
//   proof for l1  = [l0, l2]            (2 elements)
//   proof for l2  = [H(l0, l1)]         (1 element — promoted past level 0)
//
// The TS port must reproduce the Rust reference's roots, proofs, and
// the verifier's accept/reject decisions bit-for-bit.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

import {
  SnapshotMerkleTree,
  HolderEntry,
  computeLeaf,
  verifyMerkleProof,
} from "../src/index.js";

// ----------------------------------------------------------- helpers

/** Deterministic pubkey from a single byte — matches the Rust `key(n)` helper. */
function pk(n: number): PublicKey {
  const buf = new Uint8Array(32);
  buf[0] = n;
  return new PublicKey(buf);
}

/** Holder entry — `(owner_byte, balance)`. */
function entry(ownerByte: number, balance: bigint): HolderEntry {
  return { owner: pk(ownerByte), lpBalance: balance };
}

/** Independent SHA-256 helper for cross-checking the SDK's hashes. */
function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

/** Sorted-pair parent hash — independent of the SDK's internal `hashPair`. */
function sortedPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const le = Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? a : b;
  const hi = Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? b : a;
  const buf = new Uint8Array(64);
  buf.set(le, 0);
  buf.set(hi, 32);
  return sha256(buf);
}

// ----------------------------------------------------------- leaf shape

describe("SnapshotMerkleTree.leaf", () => {
  test("leaf preimage is the canonical 40 bytes (pubkey || balance_le_u64)", () => {
    const owner = pk(0x01);
    const balance = 0x0102_0304_0506_0708n;
    const leaf = computeLeaf(owner, balance);

    const preimage = new Uint8Array(40);
    preimage.set(owner.toBytes(), 0);
    const view = new DataView(preimage.buffer);
    view.setBigUint64(32, balance, true);

    assert.deepEqual(Buffer.from(leaf), Buffer.from(sha256(preimage)));
  });

  test("balance endianness matters — BE-encoded balance does not match", () => {
    const owner = pk(0x01);
    const balance = 0x0102_0304_0506_0708n;

    const be = new Uint8Array(40);
    be.set(owner.toBytes(), 0);
    const view = new DataView(be.buffer);
    view.setBigUint64(32, balance, false); // big-endian

    const leaf = computeLeaf(owner, balance);
    assert.notDeepEqual(Buffer.from(leaf), Buffer.from(sha256(be)));
  });

  test("leaf differs when balance differs", () => {
    const a = computeLeaf(pk(0x01), 100n);
    const b = computeLeaf(pk(0x01), 101n);
    assert.notDeepEqual(Buffer.from(a), Buffer.from(b));
  });

  test("leaf differs when pubkey differs", () => {
    const a = computeLeaf(pk(0x01), 100n);
    const b = computeLeaf(pk(0x02), 100n);
    assert.notDeepEqual(Buffer.from(a), Buffer.from(b));
  });
});

// ----------------------------------------------------------- single leaf

describe("SnapshotMerkleTree — single leaf", () => {
  test("root == leaf for a 1-element tree", () => {
    const tree = SnapshotMerkleTree.fromEntries([entry(0x10, 5_000n)]);
    const leaf = computeLeaf(pk(0x10), 5_000n);
    assert.deepEqual(Buffer.from(tree.root()), Buffer.from(leaf));
    assert.equal(tree.leafCount(), 1);
    assert.equal(tree.treeDepth(), 0);
    assert.deepEqual(tree.proof(0), []);
    assert.equal(tree.proof(1), undefined);
  });

  test("verifyMerkleProof accepts the empty proof against the leaf-as-root", () => {
    const tree = SnapshotMerkleTree.fromEntries([entry(0x10, 5_000n)]);
    const leaf = computeLeaf(pk(0x10), 5_000n);
    assert.ok(verifyMerkleProof(tree.root(), leaf, []));
    // Foreign leaf fails
    const foreign = computeLeaf(pk(0x10), 6_000n);
    assert.ok(!verifyMerkleProof(tree.root(), foreign, []));
  });
});

// ----------------------------------------------------------- two leaves

describe("SnapshotMerkleTree — two leaves", () => {
  test("root is the sorted-pair hash of the two leaves", () => {
    const tree = SnapshotMerkleTree.fromEntries([
      entry(0x10, 5_000n),
      entry(0x20, 7_000n),
    ]);
    const la = computeLeaf(pk(0x10), 5_000n);
    const lb = computeLeaf(pk(0x20), 7_000n);
    assert.deepEqual(Buffer.from(tree.root()), Buffer.from(sortedPair(la, lb)));
    assert.equal(tree.treeDepth(), 1);
    assert.deepEqual(tree.proof(0), [lb]);
    assert.deepEqual(tree.proof(1), [la]);
  });
});

// ----------------------------------------------------------- three leaves (fork-proven)

describe("SnapshotMerkleTree — three leaves (fork-proven vector)", () => {
  test("matches settlement_economics_fork.rs::build_three_leaf_tree", () => {
    const tree = SnapshotMerkleTree.fromEntries([
      entry(0x10, 1_000n),
      entry(0x20, 2_000n),
      entry(0x30, 3_000n),
    ]);
    const l0 = computeLeaf(pk(0x10), 1_000n);
    const l1 = computeLeaf(pk(0x20), 2_000n);
    const l2 = computeLeaf(pk(0x30), 3_000n);
    const p01 = sortedPair(l0, l1);

    // Tree shape: level0 [l0, l1, l2] -> level1 [p01, l2 (promoted)] -> root
    assert.equal(tree.treeDepth(), 2);
    assert.deepEqual(Buffer.from(tree.proof(0)![0]!), Buffer.from(l1));
    assert.deepEqual(Buffer.from(tree.proof(0)![1]!), Buffer.from(l2));
    assert.deepEqual(Buffer.from(tree.proof(1)![0]!), Buffer.from(l0));
    assert.deepEqual(Buffer.from(tree.proof(1)![1]!), Buffer.from(l2));
    // The promoted leaf has only 1 proof element — the fork-proven shape.
    assert.equal(tree.proof(2)!.length, 1);
    assert.deepEqual(Buffer.from(tree.proof(2)![0]!), Buffer.from(p01));

    // Root = sorted_pair(p01, l2)
    assert.deepEqual(Buffer.from(tree.root()), Buffer.from(sortedPair(p01, l2)));

    // All three proofs verify against the root (convert Buffer↔Uint8Array
    // explicitly because `assert.deepEqual` is strict about prototypes and
    // `computeLeaf` returns a Buffer, while `tree.proof(i)` may return a
    // mix of Buffer and Uint8Array depending on which hash chain step built it).
    assert.ok(verifyMerkleProof(tree.root(), l0, tree.proof(0)!), "l0 proof");
    assert.ok(verifyMerkleProof(tree.root(), l1, tree.proof(1)!), "l1 proof");
    assert.ok(verifyMerkleProof(tree.root(), l2, tree.proof(2)!), "l2 proof");

    // Tampered proof fails
    const tampered = [Buffer.from(p01).map((b, i) => (i === 0 ? b ^ 1 : b))];
    assert.ok(!verifyMerkleProof(tree.root(), l2, tampered));
  });
});

// ----------------------------------------------------------- four leaves

describe("SnapshotMerkleTree — four leaves (balanced)", () => {
  test("every honest proof verifies; tampering fails", () => {
    const entries = [
      entry(0x10, 100n),
      entry(0x20, 200n),
      entry(0x30, 300n),
      entry(0x40, 400n),
    ];
    const tree = SnapshotMerkleTree.fromEntries(entries);
    const leaves = entries.map((e) => computeLeaf(e.owner, e.lpBalance));
    for (let i = 0; i < 4; i++) {
      const proof = tree.proof(i)!;
      assert.ok(verifyMerkleProof(tree.root(), leaves[i]!, proof), `idx ${i} proof failed`);
    }

    // Wrong leaf fails
    const fakeLeaf = computeLeaf(pk(0x10), 999n);
    assert.ok(!verifyMerkleProof(tree.root(), fakeLeaf, tree.proof(0)!));

    // Empty proof against a non-leaf root fails
    assert.ok(!verifyMerkleProof(tree.root(), leaves[0]!, []));
  });
});

// ----------------------------------------------------------- depth & length bound

describe("SnapshotMerkleTree — depth + proof length bound", () => {
  // (n, expected_depth) pairs — mirrors snapshotter/src/tree.rs::depth_is_the_level_count_above_the_leaves
  const cases: Array<[number, number]> = [
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
    [7, 3],
    [8, 3],
    [9, 4],
    [16, 4],
    [17, 5],
  ];
  for (const [n, expectedDepth] of cases) {
    test(`n=${n} → depth=${expectedDepth}`, () => {
      const entries: HolderEntry[] = [];
      for (let i = 1; i <= n; i++) {
        entries.push(entry(i * 8, BigInt(1_000 + i)));
      }
      const tree = SnapshotMerkleTree.fromEntries(entries);
      assert.equal(tree.treeDepth(), expectedDepth);
      assert.equal(tree.leafCount(), n);
      for (let i = 0; i < n; i++) {
        const proof = tree.proof(i)!;
        assert.ok(proof.length <= tree.treeDepth(), `n=${n} idx=${i}: proof length ${proof.length} > depth ${tree.treeDepth()}`);
      }
    });
  }
});

// ----------------------------------------------------------- canonical ordering

describe("SnapshotMerkleTree — canonical ordering enforcement", () => {
  test("rejects unsorted input", () => {
    assert.throws(
      () => SnapshotMerkleTree.fromEntries([entry(0x20, 1n), entry(0x10, 2n)]),
      /not sorted/,
    );
  });
  test("rejects duplicate owner", () => {
    assert.throws(
      () => SnapshotMerkleTree.fromEntries([entry(0x10, 1n), entry(0x10, 2n)]),
      /duplicate owner/,
    );
  });
  test("rejects zero balance", () => {
    assert.throws(
      () => SnapshotMerkleTree.fromEntries([entry(0x10, 0n), entry(0x20, 2n)]),
      /non-positive balance/,
    );
  });
  test("rejects empty set", () => {
    assert.throws(
      () => SnapshotMerkleTree.fromEntries([]),
      /empty entry set/,
    );
  });
});

// ----------------------------------------------------------- determinism

describe("SnapshotMerkleTree — determinism", () => {
  test("the same entry set yields a bit-identical tree (root + proofs)", () => {
    const make = () =>
      SnapshotMerkleTree.fromEntries([
        entry(0x10, 1_000n),
        entry(0x20, 2_000n),
        entry(0x30, 3_000n),
        entry(0x40, 4_000n),
      ]);
    const a = make();
    const b = make();
    assert.deepEqual(Buffer.from(a.root()), Buffer.from(b.root()));
    assert.deepEqual(a.proofs(), b.proofs());
  });
});

// ----------------------------------------------------------- 5 leaves (odd, depth-3)

describe("SnapshotMerkleTree — five leaves (odd shape, depth 3)", () => {
  test("every honest proof verifies", () => {
    const entries: HolderEntry[] = [0x10, 0x20, 0x30, 0x40, 0x50].map((b) =>
      entry(b, BigInt(b * 1000)),
    );
    const tree = SnapshotMerkleTree.fromEntries(entries);
    assert.equal(tree.treeDepth(), 3);
    for (let i = 0; i < entries.length; i++) {
      const leaf = computeLeaf(entries[i]!.owner, entries[i]!.lpBalance);
      const proof = tree.proof(i)!;
      assert.ok(verifyMerkleProof(tree.root(), leaf, proof), `idx ${i} failed`);
      assert.ok(proof.length <= tree.treeDepth());
    }
  });
});

// ----------------------------------------------------------- foreign proof never verifies another leaf

describe("SnapshotMerkleTree — foreign leaf never verifies with another's proof", () => {
  test("holder i's proof never validates holder j's leaf", () => {
    const entries: HolderEntry[] = [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70].map((b) =>
      entry(b, BigInt(b * 1000)),
    );
    const tree = SnapshotMerkleTree.fromEntries(entries);
    const root = tree.root();
    for (let i = 0; i < entries.length; i++) {
      const proofI = tree.proof(i)!;
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        const leafJ = computeLeaf(entries[j]!.owner, entries[j]!.lpBalance);
        assert.ok(!verifyMerkleProof(root, leafJ, proofI), `proof ${i} validated leaf ${j}`);
      }
    }
  });
});
