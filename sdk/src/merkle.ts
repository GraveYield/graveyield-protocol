// SPDX-License-Identifier: Apache-2.0
//
// Snapshot Merkle tree — TypeScript port of `snapshotter/src/tree.rs`
// (`SnapshotMerkleTree`). Byte-locked against the on-chain verifier
// `grave_vault::merkle::verify_proof` and the canonical 40-byte leaf
// preimage `grave_vault::merkle::compute_leaf`.
//
// Convention (mirrored verbatim from the Rust reference):
//
//   * Leaf   = SHA256(holder_pubkey (32B) || lp_balance_le_u64 (8B))   (40-byte preimage)
//   * Parent = SHA256(min(a, b) || max(a, b))                          (sorted pair, 64 bytes)
//   * Odd node at a tree level PROMOTES UNCHANGED to the next level.
//     A promotion contributes NO proof element — the on-chain verifier
//     folds only the siblings the proof carries.
//
// The fork-proven 3-leaf shape is the test vector at
// `settlement_economics_fork.rs::build_three_leaf_tree`: for 3 leaves,
// the root is `H(H(l0,l1), l2)` and the promoted leaf l2's proof is the
// single element `[H(l0,l1)]`. The TS port reproduces the same root and
// the same proofs bit-for-bit.

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

/** A holder entry — the canonical input shape the builder consumes. */
export interface HolderEntry {
  /** Beneficial owner (NOT the custody account for locked LP — see snapshotter). */
  owner: PublicKey;
  /** Raw LP token balance (base units). Must be strictly positive. */
  lpBalance: bigint;
}

/**
 * The canonical leaf hash — byte-identical to
 * `grave_vault::merkle::compute_leaf` (40-byte preimage:
 * `pubkey (32B) || lp_balance_le_u64 (8B)`).
 */
export function computeLeaf(holder: PublicKey, lpBalance: bigint): Uint8Array {
  if (lpBalance < 0n) {
    throw new RangeError("lpBalance must be non-negative");
  }
  const buf = new Uint8Array(40);
  buf.set(holder.toBytes(), 0);
  const view = new DataView(buf.buffer);
  view.setBigUint64(32, lpBalance, true);
  return createHash("sha256").update(buf).digest();
}

/** Sorted-pair SHA-256 — the parent hash step. */
function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const le = compareBytes(a, b) <= 0 ? a : b;
  const hi = compareBytes(a, b) <= 0 ? b : a;
  const buf = new Uint8Array(64);
  buf.set(le, 0);
  buf.set(hi, 32);
  return createHash("sha256").update(buf).digest();
}

/** Lexicographic byte comparison — matches Rust `[u8]::cmp`. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined || bi === undefined) {
      throw new Error("compareBytes: undefined byte (noUncheckedIndexedAccess)");
    }
    const d = ai - bi;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** A built Merkle tree over a canonical leaf set. */
export class SnapshotMerkleTree {
  /** Level 0 is the leaf level; the last level holds exactly the root. */
  private readonly levels: Uint8Array[][];

  private constructor(levels: Uint8Array[][]) {
    this.levels = levels;
  }

  /**
   * Build the tree over a canonical entry set.
   *
   * Entries MUST be sorted by ascending owner bytes, with unique owners
   * and strictly positive balances — the same invariants `SnapshotBuilder`
   * upholds. The builder fails closed on any violation (unsorted, dup,
   * zero balance, or empty set), exactly mirroring the Rust reference.
   */
  static fromEntries(entries: ReadonlyArray<HolderEntry>): SnapshotMerkleTree {
    if (entries.length === 0) {
      throw new Error("SnapshotMerkleTree: empty entry set — no legitimate empty root");
    }
    // Validate canonical ordering + uniqueness + positivity.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      if (e.lpBalance <= 0n) {
        throw new Error(`SnapshotMerkleTree: entry ${i} has non-positive balance ${e.lpBalance}`);
      }
      if (i > 0) {
        const prev = entries[i - 1];
        if (!prev) continue;
        const cmp = compareBytes(prev.owner.toBytes(), e.owner.toBytes());
        if (cmp === 0) {
          throw new Error(`SnapshotMerkleTree: duplicate owner at index ${i}`);
        }
        if (cmp > 0) {
          throw new Error(`SnapshotMerkleTree: entries not sorted at index ${i}`);
        }
      }
    }
    const leaves: Uint8Array[] = entries.map((e) => computeLeaf(e.owner, e.lpBalance));
    const levels: Uint8Array[][] = [leaves];
    while (true) {
      const last = levels[levels.length - 1];
      if (!last || last.length <= 1) break;
      const next: Uint8Array[] = [];
      for (let i = 0; i < last.length; i += 2) {
        const a = last[i]!;
        const b = i + 1 < last.length ? last[i + 1] : null;
        if (b) {
          next.push(hashPair(a, b));
        } else {
          // Odd node promotes unchanged — no sibling contributed.
          next.push(a);
        }
      }
      levels.push(next);
    }
    return new SnapshotMerkleTree(levels);
  }

  /** The Merkle root — the 32-byte value submitted to `salvage_pool`. */
  root(): Uint8Array {
    const last = this.levels[this.levels.length - 1];
    if (!last || last.length === 0) {
      throw new Error("SnapshotMerkleTree: no root (empty tree)");
    }
    return last[0]!;
  }

  /** Number of leaves (canonical holders in the snapshot). */
  leafCount(): number {
    const first = this.levels[0];
    return first ? first.length : 0;
  }

  /** Number of hashing levels above the leaves (0 for a single-leaf tree). */
  treeDepth(): number {
    return this.levels.length - 1;
  }

  /** The leaf hash at `index` (canonical entry order), if in range. */
  leaf(index: number): Uint8Array | undefined {
    const first = this.levels[0];
    return first ? first[index] : undefined;
  }

  /**
   * The sorted-pair Merkle proof for the leaf at `index`, if in range.
   *
   * Proof elements appear in leaf→root order; each element is the
   * sibling at that level. A promotion level contributes no element —
   * the on-chain `verify_proof` folds only the siblings supplied, so
   * the proof length equals the number of hashing steps on the path,
   * which is `<= treeDepth`.
   */
  proof(index: number): Uint8Array[] | undefined {
    if (index < 0 || index >= this.leafCount()) return undefined;
    const proof: Uint8Array[] = [];
    let idx = index;
    for (let lvl = 0; lvl < this.levels.length - 1; lvl++) {
      const level = this.levels[lvl]!;
      if (idx % 2 === 0) {
        if (idx + 1 < level.length) {
          proof.push(level[idx + 1]!);
        }
        // else: trailing odd node — promoted unchanged, no sibling.
      } else {
        proof.push(level[idx - 1]!);
      }
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  /** All proofs in canonical entry order (index-aligned with the snapshot's entries). */
  proofs(): Uint8Array[][] {
    const out: Uint8Array[][] = [];
    for (let i = 0; i < this.leafCount(); i++) {
      const p = this.proof(i);
      if (!p) throw new Error(`SnapshotMerkleTree: proof missing for index ${i}`);
      out.push(p);
    }
    return out;
  }
}

/**
 * Verify a sorted-pair Merkle proof against a root — byte-identical to
 * `grave_vault::merkle::verify_proof`. At each level the proof element
 * is hashed with the running `current` value in canonical (min, max)
 * byte order, so the off-chain builder doesn't need to track which side
 * of the tree a leaf is on.
 */
export function verifyMerkleProof(root: Uint8Array, leaf: Uint8Array, proof: ReadonlyArray<Uint8Array>): boolean {
  let current = leaf;
  for (const sibling of proof) {
    current = hashPair(current, sibling);
  }
  return compareBytes(current, root) === 0;
}
