// SPDX-License-Identifier: Apache-2.0
//
// The Merkle tree builder + proof generator (Phase 5.2).
//
// This module is the REFERENCE off-chain builder for the root that
// `salvage_pool` seals into `PoolRegistry.lp_snapshot_merkle_root` and
// that `claim_lp_proceeds` verifies against. The on-chain contract it must
// satisfy byte-for-byte is `grave_vault::merkle`:
//
//   * Leaf   = SHA256(pubkey || lp_balance_le_u64)   (40-byte preimage)
//   * Parent = SHA256(min(a, b) || max(a, b))        (sorted pair, 64 bytes)
//   * Odd node at a tree level PROMOTES UNCHANGED to the next level
//
// The promotion convention is the one the Phase 4 fork harness proved
// end-to-end against real mainnet state
// (`settlement_economics_fork.rs::build_three_leaf_tree`: for 3 leaves,
// root = H(H(l0, l1), l2) and the promoted leaf's proof is the single
// element `[H(l0, l1)]`). Because the on-chain verifier folds whatever
// siblings the proof carries, a promotion simply contributes NO proof
// element at that level — which is exactly how this builder emits proofs.
//
// DETERMINISM CONTRACT (extends the crate root contract to the tree)
//
// The root is a pure function of the canonical entry set: entries must
// arrive sorted by ascending owner bytes with unique owners and strictly
// positive balances (the same invariants `SnapshotBuilder` upholds —
// enforced here via the shared validator, fail-closed on any violation).
// Pairing is positional within each level, hashing is order-insensitive
// per pair (sorted), and no ambient state participates. The same entry set
// therefore always yields the same root, and the tests pin that root's
// byte-compatibility with `grave_vault::merkle::compute_leaf` /
// `verify_proof` so a drift between producer and verifier fails CI, not a
// claimant.

use sha2::{Digest, Sha256};
use solana_sdk::pubkey::Pubkey;

use crate::error::SnapshotError;
use crate::model::{HolderEntry, LpSnapshot};

/// A built Merkle tree over a canonical leaf set: exposes the root, the
/// per-index leaves, and the per-index sorted-pair proofs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotMerkleTree {
    /// Level 0 is the leaf level; the last level holds exactly the root.
    levels: Vec<Vec<[u8; 32]>>,
}

impl SnapshotMerkleTree {
    /// Build the tree over a canonical entry set.
    ///
    /// Entries must be sorted by ascending owner bytes, unique, and
    /// strictly positive — the canonical form every `SnapshotBuilder`
    /// output already satisfies. An empty entry set is refused
    /// (`EmptySnapshot`: the on-chain side rejects zero-supply snapshots,
    /// so there is no legitimate empty root).
    pub fn from_entries(entries: &[HolderEntry]) -> Result<Self, SnapshotError> {
        LpSnapshot::validate_entries(entries)?;
        let leaves: Vec<[u8; 32]> = entries
            .iter()
            .map(|e| compute_leaf(&e.owner, e.lp_balance))
            .collect();
        let mut levels = Vec::new();
        levels.push(leaves);
        while levels.last().is_some_and(|level| level.len() > 1) {
            let current = levels.last().expect("just checked: non-empty");
            let mut next = Vec::with_capacity(current.len().div_ceil(2));
            for pair in current.chunks(2) {
                match pair {
                    [a, b] => next.push(hash_pair(a, b)),
                    [a] => next.push(*a), // odd node promotes unchanged
                    _ => unreachable!("chunks(2) yields slices of 1 or 2"),
                }
            }
            levels.push(next);
        }
        Ok(Self { levels })
    }

    /// Build the tree over a snapshot's leaf set. Convenience for the
    /// seal path (`SnapshotArtifact::seal`); the snapshot's canonical
    /// ordering is reused as-is.
    pub fn from_snapshot(snapshot: &LpSnapshot) -> Result<Self, SnapshotError> {
        Self::from_entries(&snapshot.entries)
    }

    /// The Merkle root — the value submitted to `salvage_pool`.
    pub fn root(&self) -> [u8; 32] {
        self.levels
            .last()
            .and_then(|level| level.first())
            .copied()
            .expect("a built tree always has a single root node")
    }

    /// Number of leaves (canonical holders in the snapshot).
    pub fn leaf_count(&self) -> usize {
        self.levels
            .first()
            .map_or(0, |level: &Vec<[u8; 32]>| level.len())
    }

    /// Number of hashing levels above the leaves (0 for a single-leaf
    /// tree, where the leaf itself is the root).
    pub fn tree_depth(&self) -> usize {
        self.levels.len() - 1
    }

    /// The leaf hash at `index` (canonical entry order), if in range.
    pub fn leaf(&self, index: usize) -> Option<[u8; 32]> {
        self.levels
            .first()
            .and_then(|level| level.get(index))
            .copied()
    }

    /// The sorted-pair Merkle proof for the leaf at `index`, if in range.
    ///
    /// Proof elements appear in leaf→root order; each element is the
    /// sibling at that level. A promotion level contributes no element —
    /// the on-chain `verify_proof` folds only the siblings supplied, so
    /// the proof length equals the number of hashing steps on the path,
    /// which is `<= tree_depth`.
    pub fn proof(&self, index: usize) -> Option<Vec<[u8; 32]>> {
        if index >= self.leaf_count() {
            return None;
        }
        let mut proof = Vec::new();
        let mut idx = index;
        // Walk every level except the root level (the root has no sibling).
        for level in &self.levels[..self.levels.len() - 1] {
            match idx % 2 {
                0 if idx + 1 < level.len() => proof.push(level[idx + 1]),
                0 => {} // trailing odd node: promoted unchanged, no sibling
                _ => proof.push(level[idx - 1]),
            }
            idx /= 2;
        }
        Some(proof)
    }

    /// All proofs in canonical entry order (index-aligned with the
    /// snapshot's entries). Used by the artifact seal path.
    pub fn proofs(&self) -> Vec<Vec<[u8; 32]>> {
        (0..self.leaf_count())
            .map(|i| self.proof(i).expect("index in range"))
            .collect()
    }
}

/// The canonical leaf hash — byte-identical to
/// `grave_vault::merkle::compute_leaf` (proven by test, both here via the
/// 40-byte preimage shape and in the integration suite against the vault
/// function itself).
pub fn compute_leaf(holder: &Pubkey, lp_balance: u64) -> [u8; 32] {
    let mut buf = [0u8; 40];
    buf[..32].copy_from_slice(holder.as_ref());
    buf[32..].copy_from_slice(&lp_balance.to_le_bytes());
    Sha256::digest(buf).into()
}

/// The canonical parent hash — sorted-pair SHA-256 over 64 bytes,
/// identical to the on-chain verifier's folding step (which sorts per
/// step, so either side of the pair may carry the sibling).
fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(lo);
    buf[32..].copy_from_slice(hi);
    Sha256::digest(buf).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::SnapshotError;

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    fn entry(owner: u8, balance: u64) -> HolderEntry {
        HolderEntry {
            owner: key(owner),
            lp_balance: balance,
        }
    }

    fn entries(balances: &[(u8, u64)]) -> Vec<HolderEntry> {
        balances.iter().map(|(o, b)| entry(*o, *b)).collect()
    }

    #[test]
    fn leaf_preimage_is_40_bytes_sha256() {
        // Pins the leaf preimage shape: pubkey (32) || balance_le (8).
        let leaf = compute_leaf(&key(0x01), 0x0102_0304_0506_0708);
        let mut preimage = Vec::with_capacity(40);
        preimage.extend_from_slice(key(0x01).as_ref());
        preimage.extend_from_slice(&0x0102_0304_0506_0708u64.to_le_bytes());
        let independent = Sha256::digest(preimage);
        assert_eq!(leaf, independent.as_slice());
        // Balance endianness matters: a BE-encoded balance must not match.
        let mut be = Vec::with_capacity(40);
        be.extend_from_slice(key(0x01).as_ref());
        be.extend_from_slice(&0x0102_0304_0506_0708u64.to_be_bytes());
        let be_digest = Sha256::digest(be);
        assert_ne!(leaf, be_digest.as_slice());
    }

    #[test]
    fn single_leaf_tree_root_is_the_leaf() {
        let tree = SnapshotMerkleTree::from_entries(&entries(&[(0x10, 5_000)])).unwrap();
        let leaf = compute_leaf(&key(0x10), 5_000);
        assert_eq!(tree.root(), leaf, "a single leaf IS the root");
        assert_eq!(tree.leaf_count(), 1);
        assert_eq!(tree.tree_depth(), 0);
        assert_eq!(tree.proof(0), Some(vec![]), "empty proof folds to the root");
        assert!(tree.proof(1).is_none());
    }

    #[test]
    fn two_leaf_tree_root_is_the_sorted_pair_hash() {
        let tree =
            SnapshotMerkleTree::from_entries(&entries(&[(0x10, 5_000), (0x20, 7_000)])).unwrap();
        let la = compute_leaf(&key(0x10), 5_000);
        let lb = compute_leaf(&key(0x20), 7_000);
        assert_eq!(tree.root(), hash_pair(&la, &lb));
        assert_eq!(tree.tree_depth(), 1);
        assert_eq!(tree.proof(0), Some(vec![lb]));
        assert_eq!(tree.proof(1), Some(vec![la]));
    }

    #[test]
    fn promoted_leaf_has_a_shorter_proof() {
        // 3 leaves: level0 = [l0, l1, l2] -> level1 = [p01, l2] -> root.
        // The promoted leaf l2 skips level 0 hashing entirely: its proof
        // is the single element [p01], exactly the fork-suite shape
        // (settlement_economics_fork.rs::build_three_leaf_tree).
        let tree = SnapshotMerkleTree::from_entries(&entries(&[
            (0x10, 1_000),
            (0x20, 2_000),
            (0x30, 3_000),
        ]))
        .unwrap();
        let l0 = compute_leaf(&key(0x10), 1_000);
        let l1 = compute_leaf(&key(0x20), 2_000);
        let l2 = compute_leaf(&key(0x30), 3_000);
        let p01 = hash_pair(&l0, &l1);
        assert_eq!(tree.tree_depth(), 2);
        assert_eq!(tree.proof(0), Some(vec![l1, l2]));
        assert_eq!(tree.proof(1), Some(vec![l0, l2]));
        assert_eq!(tree.proof(2), Some(vec![p01]), "promoted leaf: 1 element");
        assert_eq!(tree.root(), hash_pair(&p01, &l2));
    }

    #[test]
    fn proof_lengths_never_exceed_depth() {
        for n in 1..=17usize {
            let balances: Vec<(u8, u64)> =
                (1..=n as u8).map(|i| (i * 8, 1_000 + i as u64)).collect();
            let tree = SnapshotMerkleTree::from_entries(&entries(&balances)).unwrap();
            for i in 0..n {
                let proof = tree.proof(i).unwrap();
                assert!(
                    proof.len() <= tree.tree_depth(),
                    "n={n} idx={i}: proof len {} > depth {}",
                    proof.len(),
                    tree.tree_depth()
                );
                assert!(!proof.is_empty() || tree.tree_depth() == 0);
            }
        }
    }

    #[test]
    fn depth_is_the_level_count_above_the_leaves() {
        for (n, expected_depth) in [
            (1usize, 0),
            (2, 1),
            (3, 2),
            (4, 2),
            (5, 3),
            (7, 3),
            (8, 3),
            (9, 4),
            (16, 4),
            (17, 5),
        ] {
            let balances: Vec<(u8, u64)> =
                (1..=n as u8).map(|i| (i * 8, 1_000 + i as u64)).collect();
            let tree = SnapshotMerkleTree::from_entries(&entries(&balances)).unwrap();
            assert_eq!(tree.tree_depth(), expected_depth, "n={n}");
            assert_eq!(tree.leaf_count(), n);
        }
    }

    #[test]
    fn canonical_ordering_is_enforced_fail_closed() {
        // Unsorted input.
        let unsorted = entries(&[(0x20, 1_000), (0x10, 2_000)]);
        assert!(matches!(
            SnapshotMerkleTree::from_entries(&unsorted),
            Err(SnapshotError::InvariantViolated(_))
        ));
        // Duplicate owner.
        let dup = entries(&[(0x10, 1_000), (0x10, 2_000)]);
        assert!(matches!(
            SnapshotMerkleTree::from_entries(&dup),
            Err(SnapshotError::InvariantViolated(_))
        ));
        // Zero balance.
        let zero = entries(&[(0x10, 0), (0x20, 2_000)]);
        assert!(matches!(
            SnapshotMerkleTree::from_entries(&zero),
            Err(SnapshotError::InvariantViolated(_))
        ));
        // Empty set.
        assert_eq!(
            SnapshotMerkleTree::from_entries(&[]),
            Err(SnapshotError::EmptySnapshot)
        );
    }

    #[test]
    fn root_is_a_pure_function_of_the_canonical_set() {
        // Two independently constructed-but-identical entry sets must
        // yield bit-identical trees (root AND all proofs).
        let a = SnapshotMerkleTree::from_entries(&entries(&[
            (0x10, 1_000),
            (0x20, 2_000),
            (0x30, 3_000),
            (0x40, 4_000),
        ]))
        .unwrap();
        let b = SnapshotMerkleTree::from_entries(&entries(&[
            (0x10, 1_000),
            (0x20, 2_000),
            (0x30, 3_000),
            (0x40, 4_000),
        ]))
        .unwrap();
        assert_eq!(a, b);
        assert_eq!(a.proofs(), b.proofs());
    }
}
