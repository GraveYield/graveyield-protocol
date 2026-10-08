// SPDX-License-Identifier: Apache-2.0
//
// SHA-256 sorted-pair Merkle proof verifier for the LP-holder snapshot.
//
// Matches the OpenZeppelin / Uniswap `MerkleProof.verify` convention:
//   * Leaf = SHA256(pubkey || balance_le_u64)        (40 bytes)
//   * Parent = SHA256(min(a, b) || max(a, b))        (64 bytes)
//   * Odd node at a tree level promotes UNCHANGED to the next level (the
//     fork-proven convention — `settlement_economics_fork.rs::
//     build_three_leaf_tree` sealed real claims through `claim_lp_proceeds`
//     this way; the reference off-chain builder is `snapshotter/`, crate
//     `grave-snapshotter`, `tree::SnapshotMerkleTree`). A promotion
//     contributes NO proof element, which this verifier handles
//     implicitly: it folds only the siblings the proof carries.
//
// The off-chain producers (the Phase 5.2 snapshotter today; the
// GraveScanner v2 indexer / SDK later) build the tree using the same
// rules and submit proofs that this function verifies. The Merkle root
// is recorded in `PoolRegistry.lp_snapshot_merkle_root` by salvage_pool
// at salvage time and is immutable thereafter.

use anchor_lang::prelude::Pubkey;
use solana_sha256_hasher::hash;

/// Compute the canonical leaf hash for an LP-holder snapshot entry.
///
/// Leaf bytes = `pubkey (32 bytes) || lp_balance.to_le_bytes() (8 bytes)`.
/// Returned hash is `sha256` of those 40 bytes.
pub fn compute_leaf(holder: &Pubkey, lp_balance: u64) -> [u8; 32] {
    let mut buf = [0u8; 40];
    buf[..32].copy_from_slice(&holder.to_bytes());
    buf[32..].copy_from_slice(&lp_balance.to_le_bytes());
    hash(&buf).to_bytes()
}

/// Verify a Merkle proof of `leaf` against `root`, using sorted-pair hashing
/// (OZ/Uniswap convention). At each level the proof element is hashed with
/// the running `current` value in canonical (min, max) byte order so the
/// off-chain builder doesn't need to track which side of the tree a leaf is on.
///
/// Returns `true` iff the proof is valid. Constant-time-ish in proof length;
/// short-circuiting reveals length only, which the proof itself reveals.
pub fn verify_proof(root: [u8; 32], leaf: [u8; 32], proof: &[[u8; 32]]) -> bool {
    let mut current = leaf;
    for sibling in proof {
        let (lo, hi) = if current <= *sibling {
            (current, *sibling)
        } else {
            (*sibling, current)
        };
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(&lo);
        buf[32..].copy_from_slice(&hi);
        current = hash(&buf).to_bytes();
    }
    current == root
}

#[cfg(test)]
mod tests {
    use super::*;

    // Two distinct, deterministic pubkeys for test purposes.
    fn alice() -> Pubkey {
        Pubkey::new_from_array([1u8; 32])
    }
    fn bob() -> Pubkey {
        Pubkey::new_from_array([2u8; 32])
    }
    fn carol() -> Pubkey {
        Pubkey::new_from_array([3u8; 32])
    }
    fn dave() -> Pubkey {
        Pubkey::new_from_array([4u8; 32])
    }

    /// Helper that hashes two 32-byte nodes in sorted order (matches the
    /// verifier's internal step). Used to construct expected roots in tests.
    fn sorted_pair_hash(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(&lo);
        buf[32..].copy_from_slice(&hi);
        hash(&buf).to_bytes()
    }

    #[test]
    fn leaf_is_deterministic() {
        let a = compute_leaf(&alice(), 100);
        let b = compute_leaf(&alice(), 100);
        assert_eq!(a, b);
    }

    #[test]
    fn leaf_differs_when_balance_differs() {
        let a = compute_leaf(&alice(), 100);
        let b = compute_leaf(&alice(), 101);
        assert_ne!(a, b);
    }

    #[test]
    fn leaf_differs_when_pubkey_differs() {
        let a = compute_leaf(&alice(), 100);
        let b = compute_leaf(&bob(), 100);
        assert_ne!(a, b);
    }

    #[test]
    fn verify_two_leaf_tree() {
        // Two-leaf tree: root = H(min(la, lb) || max(la, lb))
        let la = compute_leaf(&alice(), 100);
        let lb = compute_leaf(&bob(), 200);
        let root = sorted_pair_hash(la, lb);

        // Proof for alice: just [lb]
        assert!(verify_proof(root, la, &[lb]));
        // Proof for bob: just [la]
        assert!(verify_proof(root, lb, &[la]));
        // Wrong leaf fails
        let lc = compute_leaf(&carol(), 50);
        assert!(!verify_proof(root, lc, &[lb]));
        // Wrong proof fails
        assert!(!verify_proof(root, la, &[lc]));
    }

    #[test]
    fn verify_four_leaf_tree() {
        // Four-leaf balanced tree:
        //
        //              root
        //            /      \
        //           n01      n23
        //          /   \    /   \
        //        la    lb  lc    ld
        //
        let la = compute_leaf(&alice(), 100);
        let lb = compute_leaf(&bob(), 200);
        let lc = compute_leaf(&carol(), 300);
        let ld = compute_leaf(&dave(), 400);

        let n01 = sorted_pair_hash(la, lb);
        let n23 = sorted_pair_hash(lc, ld);
        let root = sorted_pair_hash(n01, n23);

        // Alice's proof: [lb, n23]
        assert!(verify_proof(root, la, &[lb, n23]));
        // Bob's proof: [la, n23]
        assert!(verify_proof(root, lb, &[la, n23]));
        // Carol's proof: [ld, n01]
        assert!(verify_proof(root, lc, &[ld, n01]));
        // Dave's proof: [lc, n01]
        assert!(verify_proof(root, ld, &[lc, n01]));

        // Wrong proof order fails (because pair hashing is sorted, but
        // the sibling at the wrong tree level still won't match).
        assert!(!verify_proof(root, la, &[n23, lb]));

        // Tampered leaf fails.
        let fake = compute_leaf(&alice(), 999);
        assert!(!verify_proof(root, fake, &[lb, n23]));

        // Empty proof against a non-leaf root fails.
        assert!(!verify_proof(root, la, &[]));
    }

    #[test]
    fn empty_proof_verifies_leaf_as_root() {
        // Edge case: a single-element "tree" where the leaf IS the root.
        // verify_proof with empty proof returns leaf == root.
        let la = compute_leaf(&alice(), 100);
        assert!(verify_proof(la, la, &[]));
        let lb = compute_leaf(&bob(), 200);
        assert!(!verify_proof(la, lb, &[]));
    }

    #[test]
    fn sorted_pair_order_invariant() {
        // verify_proof must produce the same result regardless of the
        // off-chain builder's choice of left/right at each level — the
        // sibling can be on either side and we sort canonically.
        let la = compute_leaf(&alice(), 100);
        let lb = compute_leaf(&bob(), 200);
        let root = sorted_pair_hash(la, lb);
        // Proving alice with sibling lb works the same as proving bob with
        // sibling la — both arrive at the same root after one sorted-pair step.
        assert!(verify_proof(root, la, &[lb]));
        assert!(verify_proof(root, lb, &[la]));
    }
}

// =====================================================================
// Phase 7 property tests (proptest, host-only): the verifier's security
// properties against the REAL off-chain producer. `grave-snapshotter` is
// a dev-dependency, so these prove the producer↔verifier contract, not
// a hand-rolled tree.
// =====================================================================
#[cfg(test)]
mod proptests {
    use super::*;
    use grave_snapshotter::{HolderEntry, SnapshotMerkleTree};
    use proptest::prelude::*;

    /// Deterministic pseudo-random pubkey from a u64 seed (proptest
    /// strategies cannot construct `Pubkey` directly).
    fn seed_pubkey(seed: u64) -> Pubkey {
        let mut bytes = [0u8; 32];
        bytes[..8].copy_from_slice(&seed.to_le_bytes());
        bytes[8..16].copy_from_slice(&seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).to_le_bytes());
        bytes[16..].copy_from_slice(&seed.to_le_bytes().repeat(2)[..16]);
        Pubkey::new_from_array(bytes)
    }

    /// A random holder set: n ∈ [1, 48], unique pubkeys, balances ≥ 1.
    fn holder_set_strategy() -> impl Strategy<Value = Vec<HolderEntry>> {
        proptest::collection::vec((0u64..1 << 48, 1u64..=u64::MAX / 2), 1..=48).prop_map(|seeds| {
            let mut entries: Vec<HolderEntry> = seeds
                .into_iter()
                .map(|(seed, balance)| HolderEntry {
                    owner: seed_pubkey(seed),
                    lp_balance: balance,
                })
                .collect();
            entries.sort_by(|a, b| a.owner.as_ref().cmp(b.owner.as_ref()));
            entries.dedup_by(|a, b| a.owner == b.owner);
            if entries.is_empty() {
                entries.push(HolderEntry {
                    owner: seed_pubkey(42),
                    lp_balance: 1,
                });
            }
            entries
        })
    }

    proptest! {
        // ------------------------------------------------------------
        // Soundness: every entry of a random producer-built tree has a
        // proof that the on-chain algorithm accepts against the sealed
        // root — across 1..=48 leaves (odd shapes, promotions, depth 0..6).
        // ------------------------------------------------------------
        #[test]
        fn honest_proofs_always_verify(entries in holder_set_strategy()) {
            let tree = SnapshotMerkleTree::from_entries(&entries)
                .expect("producer must build a tree for any valid entry set");
            let root = tree.root();
            let leaves: Vec<[u8; 32]> = entries
                .iter()
                .map(|e| compute_leaf(&e.owner, e.lp_balance))
                .collect();
            // Producer leaves and verifier leaves must agree bit-for-bit.
            for (i, leaf) in leaves.iter().enumerate() {
                prop_assert_eq!(tree.leaf(i), Some(*leaf));
            }
            for (i, leaf) in leaves.iter().enumerate() {
                let proof = tree.proof(i).expect("proof must exist for every index");
                prop_assert!(verify_proof(root, *leaf, &proof),
                    "honest proof rejected: n={} idx={}", entries.len(), i);
            }
        }

        // ------------------------------------------------------------
        // Tamper detection: flipping ANY single bit of the root, the
        // leaf, or any single proof element must invalidate the proof
        // (avalanche / second-preimage resistance of SHA-256 under the
        // sorted-pair convention).
        // ------------------------------------------------------------
        #[test]
        fn any_single_bit_flip_invalidates(
            entries in holder_set_strategy(),
            flip_target in 0u8..3,
            byte_idx in 0usize..32,
            bit_idx in 0u8..8,
        ) {
            let tree = SnapshotMerkleTree::from_entries(&entries).unwrap();
            let root = tree.root();
            // Deterministic entry under test (index 0); flip_target drives
            // which artifact is tampered with. A single-entry tree has an
            // empty proof, so the proof-element case is skipped there.
            let i = 0usize;
            let leaf = compute_leaf(&entries[i].owner, entries[i].lp_balance);
            let proof = tree.proof(i).unwrap();

            let flip = |bytes: &mut [u8; 32]| bytes[byte_idx] ^= 1 << bit_idx;

            let mut bad_root = root;
            if flip_target == 0 {
                flip(&mut bad_root);
                prop_assert!(!verify_proof(bad_root, leaf, &proof));
            } else if flip_target == 1 {
                let mut bad_leaf = leaf;
                flip(&mut bad_leaf);
                prop_assert!(!verify_proof(root, bad_leaf, &proof));
            } else if !proof.is_empty() {
                let mut bad_proof = proof.clone();
                flip(&mut bad_proof[0]);
                prop_assert!(!verify_proof(root, leaf, &bad_proof));
            }
        }

        // ------------------------------------------------------------
        // Cross-holder replay: a proof minted for holder A must never
        // verify holder B's leaf in the same tree — the leaf binds the
        // holder pubkey AND the balance, so stealing someone's proof
        // buys nothing.
        // ------------------------------------------------------------
        #[test]
        fn foreign_leaf_never_verifies_with_anothers_proof(entries in holder_set_strategy()) {
            prop_assume!(entries.len() >= 2, "need at least two holders");
            let tree = SnapshotMerkleTree::from_entries(&entries).unwrap();
            let root = tree.root();
            for i in 0..entries.len() {
                let proof_i = tree.proof(i).unwrap();
                for (j, entry_j) in entries.iter().enumerate() {
                    if i == j {
                        continue;
                    }
                    let leaf_j = compute_leaf(&entry_j.owner, entry_j.lp_balance);
                    prop_assert!(!verify_proof(root, leaf_j, &proof_i),
                        "holder {}'s proof validated holder {}'s leaf", i, j);
                }
            }
        }

        // ------------------------------------------------------------
        // Proof-length bound: no proof is longer than the tree depth —
        // an extended proof is a different hash chain and cannot reach
        // the root, and bounded length bounds the verifier's compute.
        // (NOTE: lengths are NOT uniform and have NO log2 floor under
        // the promotion convention — a node promoted past an odd level
        // carries one fewer element per promotion, cascading down to a
        // single element. The fuzzer caught both wrong assumptions; the
        // upper bound is the real invariant, and
        // `honest_proofs_always_verify` proves the varying shapes sound.)
        // ------------------------------------------------------------
        #[test]
        fn proof_lengths_bounded_by_tree_depth(entries in holder_set_strategy()) {
            let tree = SnapshotMerkleTree::from_entries(&entries).unwrap();
            let depth = tree.tree_depth();
            for p in tree.proofs() {
                prop_assert!(p.len() <= depth, "proof longer than tree depth");
            }
        }

        // ------------------------------------------------------------
        // Single-entry boundary: the minimal snapshot is its own root;
        // the empty proof accepts exactly that leaf and nothing else.
        // ------------------------------------------------------------
        #[test]
        fn single_leaf_tree_empty_proof(seed in 0u64..1 << 48, balance in 1u64..=u64::MAX) {
            let owner = seed_pubkey(seed);
            let leaf = compute_leaf(&owner, balance);
            prop_assert!(verify_proof(leaf, leaf, &[]));
            let other = compute_leaf(&owner, balance.wrapping_add(1));
            prop_assert!(!verify_proof(leaf, other, &[]));
        }
    }
}
