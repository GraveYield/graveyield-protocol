// SPDX-License-Identifier: Apache-2.0
//
// Phase 5.2 integration tests — the Merkle tree / sealed artifact's
// contract with the on-chain verifier. Everything here is host-only (no
// network, no fixtures). The load-bearing direction: the ROOT AND PROOFS
// this crate produces must be accepted by `grave_vault::merkle::
// verify_proof` — the exact function `claim_lp_proceeds` gates claims
// with — and the tree shape must match the convention the Phase 4 fork
// harness sealed real claims through (`build_three_leaf_tree`: sorted
// pairs, odd node promotes unchanged).

use solana_sdk::pubkey::Pubkey;

use grave_snapshotter::{
    InMemoryLocks, InMemorySource, SnapshotArtifact, SnapshotBuilder, SnapshotMerkleTree,
    SnapshotRequest, TokenAccountSnapshot, TokenLockRecord,
};

fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

fn acct(address: u8, owner: u8, amount: u64) -> TokenAccountSnapshot {
    TokenAccountSnapshot {
        address: key(address),
        owner: key(owner),
        amount,
    }
}

fn lock(address_seed: u8, global_id: u64, owner: u8, amount: u64) -> TokenLockRecord {
    TokenLockRecord {
        address: key(address_seed),
        lock_global_id: global_id,
        current_locked_amount: amount,
        lock_owner: key(owner),
    }
}

/// Deterministic sorted key for index i (ascending bytes → canonical
/// entry order, unique for i ≤ 255).
fn key_i(i: usize) -> Pubkey {
    let mut bytes = [0u8; 32];
    bytes[0] = i as u8;
    bytes[31] = i as u8;
    Pubkey::new_from_array(bytes)
}

/// Deterministic nonzero balance for index i.
fn bal_i(i: usize) -> u64 {
    1_000 + (i as u64) * 137
}

fn tree_of_size(n: usize) -> (Vec<Pubkey>, Vec<u64>, SnapshotMerkleTree) {
    let owners: Vec<Pubkey> = (0..n).map(key_i).collect();
    let balances: Vec<u64> = (0..n).map(bal_i).collect();
    let entries: Vec<grave_snapshotter::HolderEntry> = owners
        .iter()
        .zip(&balances)
        .map(|(owner, lp_balance)| grave_snapshotter::HolderEntry {
            owner: *owner,
            lp_balance: *lp_balance,
        })
        .collect();
    let tree = SnapshotMerkleTree::from_entries(&entries).unwrap();
    (owners, balances, tree)
}

/// The production-shaped Phase 5.1 fixture (sink + custody + locks) run
/// through the complete 5.2 pipeline.
fn sealed_production_artifact() -> SnapshotArtifact {
    let lp_mint = key(0x01);
    let source = InMemorySource::new(
        lp_mint,
        123,
        20_000,
        vec![
            acct(1, 0x10, 8_000),
            acct(2, 0x20, 4_500),
            acct(3, 0x30, 3_000),
            acct(4, 0x40, 1_500),
            acct(5, 0x50, 1_000), // sink
            acct(6, 0x60, 2_000), // custody
        ],
    );
    let locks = InMemoryLocks::from_records(
        &key(0xAA),
        &lp_mint,
        vec![lock(0x71, 1, 0x70, 1_200), lock(0x72, 2, 0x80, 800)],
    );
    let mut request = SnapshotRequest {
        pool_address: key(0xAA),
        amm_program_id: key(0xAB),
        lp_mint,
        sink_exclusions: vec![],
        custody_owner_overrides: vec![],
    };
    request.sink_exclusions = vec![key(0x50)];
    let snapshot = SnapshotBuilder::new(request)
        .build(&source, &locks)
        .unwrap();
    let tree = SnapshotMerkleTree::from_snapshot(&snapshot).unwrap();
    SnapshotArtifact::seal(&snapshot, &tree).unwrap()
}

// =====================================================================
// Byte-format compatibility with the on-chain verifier.
// =====================================================================

/// Every leaf the builder computes is byte-identical to the leaf function
/// the on-chain verifier derives leaves from in `claim_lp_proceeds`.
#[test]
fn leaves_match_grave_vault_compute_leaf() {
    for n in [1usize, 2, 3, 4, 5, 7, 8, 9, 16, 17, 32, 33] {
        let (owners, balances, tree) = tree_of_size(n);
        for (i, (owner, balance)) in owners.iter().zip(&balances).enumerate() {
            assert_eq!(
                tree.leaf(i).unwrap(),
                grave_vault::merkle::compute_leaf(owner, *balance),
                "leaf drifted at n={n} idx={i}"
            );
        }
    }
}

/// THE load-bearing lock: every proof this crate generates must verify
/// against the root under the exact on-chain verifier function, across
/// tree sizes that exercise every promotion shape (odd counts at every
/// level, single-leaf tree, powers of two).
#[test]
fn every_proof_verifies_against_the_on_chain_verifier() {
    for n in [1usize, 2, 3, 4, 5, 7, 8, 9, 16, 17, 32, 33] {
        let (owners, balances, tree) = tree_of_size(n);
        let root = tree.root();
        for i in 0..n {
            let leaf = grave_vault::merkle::compute_leaf(&owners[i], balances[i]);
            assert_eq!(
                leaf,
                tree.leaf(i).unwrap(),
                "on-chain leaf != builder leaf at n={n} idx={i}"
            );
            let proof = tree.proof(i).unwrap();
            assert!(
                grave_vault::merkle::verify_proof(root, leaf, &proof),
                "on-chain verifier rejected proof n={n} idx={i}"
            );
        }
    }
}

/// Negative lock: a tampered balance is rejected by the on-chain
/// verifier — the artifact cannot be mutated into a false claim.
#[test]
fn tampered_balance_is_rejected_by_the_on_chain_verifier() {
    let (owners, balances, tree) = tree_of_size(5);
    let root = tree.root();
    // Honest proof verifies...
    let leaf = grave_vault::merkle::compute_leaf(&owners[2], balances[2]);
    assert!(grave_vault::merkle::verify_proof(
        root,
        leaf,
        &tree.proof(2).unwrap()
    ));
    // ...but the same proof against a falsified balance's leaf does not.
    let forged = grave_vault::merkle::compute_leaf(&owners[2], balances[2] + 1);
    assert!(!grave_vault::merkle::verify_proof(
        root,
        forged,
        &tree.proof(2).unwrap()
    ));
    // And a forged (owner, balance) pair with a DIFFERENT holder's proof
    // does not magically verify either.
    let forged_owner = grave_vault::merkle::compute_leaf(&owners[3], balances[2]);
    assert!(!grave_vault::merkle::verify_proof(
        root,
        forged_owner,
        &tree.proof(2).unwrap()
    ));
}

// =====================================================================
// Convention lock with the Phase 4 fork harness.
// =====================================================================

/// Replicates `settlement_economics_fork.rs::build_three_leaf_tree` — the
/// construction that sealed REAL claims through `claim_lp_proceeds` on
/// real mainnet bytecode — and requires bit-identical root AND proofs.
/// If this test ever fails, the off-chain builder and the fork-proven
/// convention have diverged.
#[test]
fn root_and_proofs_match_the_fork_suite_three_leaf_recipe() {
    use sha2::{Digest, Sha256};

    // The fork recipe's own primitives (mirrored here from
    // settlement_economics_fork.rs: compute_leaf + sorted-pair hash_pair).
    let holders = [key(0x21), key(0x22), key(0x23)];
    let balances = [700u64, 300u64, 100u64];
    let leaves: Vec<[u8; 32]> = holders
        .iter()
        .zip(balances)
        .map(|(h, b)| grave_vault::merkle::compute_leaf(h, b))
        .collect();
    let hash_pair = |a: &[u8; 32], b: &[u8; 32]| -> [u8; 32] {
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(lo);
        buf[32..].copy_from_slice(hi);
        Sha256::digest(buf).into()
    };
    let p01 = hash_pair(&leaves[0], &leaves[1]);
    let fork_root = hash_pair(&p01, &leaves[2]);
    let fork_proofs = vec![
        vec![leaves[1], leaves[2]], // A
        vec![leaves[0], leaves[2]], // B
        vec![p01],                  // C (odd leaf promotes)
    ];

    // The shipped builder must reproduce it exactly.
    let entries: Vec<grave_snapshotter::HolderEntry> = holders
        .iter()
        .zip(balances)
        .map(|(owner, lp_balance)| grave_snapshotter::HolderEntry {
            owner: *owner,
            lp_balance,
        })
        .collect();
    let tree = SnapshotMerkleTree::from_entries(&entries).unwrap();
    assert_eq!(tree.root(), fork_root, "root diverged from the fork recipe");
    assert_eq!(
        tree.proofs(),
        fork_proofs,
        "proofs diverged from the fork recipe"
    );
}

// =====================================================================
// Production fixture end-to-end: snapshot → tree → artifact → verifier.
// =====================================================================

#[test]
fn production_fixture_seals_into_a_verifiable_artifact() {
    let artifact = sealed_production_artifact();
    // The artifact's own integrity gate passes.
    artifact
        .verify_integrity()
        .expect("sealed artifact is sound");
    // Metadata carried through: 5 leaf entries (0x10/0x20/0x30/0x40 +
    // re-attributed 0x70/0x80... no — 0x30 is an ordinary holder; the
    // leaf set is 0x10, 0x20, 0x30, 0x40, 0x70, 0x80), supply 20_000.
    assert_eq!(artifact.leaf_count, 6);
    assert_eq!(artifact.lp_total_supply_at_snapshot, 20_000);
    assert_eq!(artifact.entries.len(), 6);
    // Every entry's proof verifies on-chain against the sealed root.
    for entry in &artifact.entries {
        assert!(grave_vault::merkle::verify_proof(
            artifact.root(),
            entry.leaf,
            &entry.proof
        ));
    }
    // Root determinism: seal the same fixture again → byte-identical JSON.
    let again = sealed_production_artifact();
    assert_eq!(
        artifact.to_json_pretty().unwrap(),
        again.to_json_pretty().unwrap()
    );
}

#[test]
fn artifact_json_round_trip_stays_verifiable() {
    let artifact = sealed_production_artifact();
    let json = artifact.to_json_pretty().unwrap();
    let loaded = SnapshotArtifact::from_json(&json).unwrap();
    assert_eq!(loaded, artifact);
    loaded.verify_integrity().expect("loaded artifact is sound");
    // Re-serialization is byte-stable (canonical form, not just equal
    // structure).
    assert_eq!(loaded.to_json_pretty().unwrap(), json);
}

#[test]
fn json_tampering_is_caught_by_integrity_and_by_the_chain() {
    let artifact = sealed_production_artifact();
    // Bump a holder's balance in the published JSON.
    let mut value: serde_json::Value =
        serde_json::from_str(&artifact.to_json_pretty().unwrap()).unwrap();
    let victim = artifact.entries[0].owner.to_string();
    let entry = value["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["owner"] == serde_json::Value::String(victim.clone()))
        .unwrap()
        .as_object_mut()
        .unwrap();
    let honest_balance = artifact.entries[0].lp_balance;
    entry["lp_balance"] = serde_json::Value::from(honest_balance + 1);
    let tampered = SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();

    // The artifact layer refuses it...
    assert!(tampered.verify_integrity().is_err());
    // ...and even bypassing the artifact layer, the on-chain verifier
    // rejects the honest proof against the forged leaf.
    let forged_leaf =
        grave_vault::merkle::compute_leaf(&artifact.entries[0].owner, honest_balance + 1);
    assert!(!grave_vault::merkle::verify_proof(
        artifact.root(),
        forged_leaf,
        &artifact.entries[0].proof
    ));
}
