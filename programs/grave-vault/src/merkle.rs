// SPDX-License-Identifier: Apache-2.0
//
// SHA-256 sorted-pair Merkle proof verifier for the LP-holder snapshot.
//
// Matches the OpenZeppelin / Uniswap `MerkleProof.verify` convention:
//   * Leaf = SHA256(pubkey || balance_le_u64)        (40 bytes)
//   * Parent = SHA256(min(a, b) || max(a, b))        (64 bytes)
//   * Odd leaf-out at a tree level promotes unchanged (handled implicitly:
//     the off-chain builder pads odd levels by duplicating; we don't need
//     special on-chain logic — the proof itself reflects the structure).
//
// The off-chain GraveScanner v2 indexer builds the tree using the same
// rules and submits proofs that this function verifies. The Merkle root
// is recorded in `PoolRegistry.lp_snapshot_merkle_root` by salvage_pool
// at salvage time and is immutable thereafter.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::hash::hash;

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
