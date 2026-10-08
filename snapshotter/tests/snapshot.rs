// SPDX-License-Identifier: Apache-2.0
//
// Phase 5.1 integration tests — the snapshotter's contract with the rest
// of the protocol. All tests are host-only (no network, no fixtures).

use solana_sdk::pubkey::Pubkey;

use grave_snapshotter::{
    ExcludedBalance, ExclusionReason, HolderEntry, InMemoryLocks, InMemorySource, SnapshotBuilder,
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

fn request(lp_mint: Pubkey) -> SnapshotRequest {
    SnapshotRequest {
        pool_address: key(0xAA),
        amm_program_id: key(0xAB),
        lp_mint,
        sink_exclusions: vec![],
        custody_owner_overrides: vec![],
    }
}

/// A "production-shaped" fixture: 5 holders (one of them the salvor), a
/// sink, a custody account, two locks. Supply 20_000 =
/// 8_000 + 4_500 + 3_000 + 1_500 + 1_000(sink) + 2_000(custody). The
/// custody account's balance is the ONLY one equal to the locked total —
/// the exact-balance reconciliation requires a unique match.
struct Fixture {
    lp_mint: Pubkey,
}

fn fixture() -> Fixture {
    Fixture { lp_mint: key(0x01) }
}

impl Fixture {
    fn source(&self, shuffle: bool) -> InMemorySource {
        let mut accounts = vec![
            acct(1, 0x10, 8_000),
            acct(2, 0x20, 4_500),
            acct(3, 0x30, 3_000),
            acct(4, 0x40, 1_500),
            acct(5, 0x50, 1_000), // sink
            acct(6, 0x60, 2_000), // custody
        ];
        if shuffle {
            accounts.reverse();
        }
        InMemorySource::new(self.lp_mint, 123, 20_000, accounts)
    }

    fn locks(&self) -> InMemoryLocks {
        InMemoryLocks::from_records(
            &key(0xAA),
            &self.lp_mint,
            vec![lock(0x71, 1, 0x70, 1_200), lock(0x72, 2, 0x80, 800)],
        )
    }

    fn request_with_sink(&self) -> SnapshotRequest {
        let mut request = request(self.lp_mint);
        request.sink_exclusions = vec![key(0x50)];
        request
    }
}

#[test]
fn snapshot_is_deterministic_across_rebuilds_and_input_orderings() {
    let f = fixture();
    let builder = SnapshotBuilder::new(f.request_with_sink());
    let a = builder.build(&f.source(false), &f.locks()).unwrap();
    let b = builder.build(&f.source(false), &f.locks()).unwrap();
    let shuffled = builder.build(&f.source(true), &f.locks()).unwrap();
    assert_eq!(a, b, "same inputs must produce a bit-identical snapshot");
    assert_eq!(a, shuffled, "input ordering must not leak into the output");
    // Canonical ordering is observable, not just structural equality.
    let owners: Vec<Pubkey> = a.entries.iter().map(|e| e.owner).collect();
    let mut sorted = owners.clone();
    sorted.sort();
    assert_eq!(owners, sorted);
}

#[test]
fn full_ledger_covers_every_token_of_supply() {
    let f = fixture();
    let snapshot = SnapshotBuilder::new(f.request_with_sink())
        .build(&f.source(false), &f.locks())
        .unwrap();
    // Every token accounted: entries + declared sinks == enumerated == supply.
    assert_eq!(snapshot.lp_total_supply_at_snapshot, 20_000);
    assert_eq!(snapshot.reconciliation.enumerated_total, 20_000);
    assert_eq!(snapshot.reconciliation.entries_total, 19_000);
    assert_eq!(snapshot.reconciliation.sink_exclusions_total, 1_000);
    // Leaf set: 0x10 8_000 + 0x20 4_500 + 0x30 3_000 + 0x40 1_500 + locked
    // re-attributions (0x70 1_200 + 0x80 800), ascending owner bytes.
    assert_eq!(
        snapshot.entries,
        vec![
            HolderEntry {
                owner: key(0x10),
                lp_balance: 8_000
            },
            HolderEntry {
                owner: key(0x20),
                lp_balance: 4_500
            },
            HolderEntry {
                owner: key(0x30),
                lp_balance: 3_000
            },
            HolderEntry {
                owner: key(0x40),
                lp_balance: 1_500
            },
            HolderEntry {
                owner: key(0x70),
                lp_balance: 1_200
            },
            HolderEntry {
                owner: key(0x80),
                lp_balance: 800
            },
        ]
    );
    // Locked LP re-entered the leaf set via its beneficial owners.
    assert_eq!(snapshot.locked.total_locked, 2_000);
    assert_eq!(snapshot.locked.lock_records_seen, 2);
    assert_eq!(
        snapshot.locked.attributions,
        vec![
            HolderEntry {
                owner: key(0x70),
                lp_balance: 1_200
            },
            HolderEntry {
                owner: key(0x80),
                lp_balance: 800
            },
        ]
    );
    // Custody balance left the leaf set exactly once (no double count).
    let custody = snapshot.locked.custody.as_ref().unwrap();
    assert_eq!(custody.balance, 2_000);
    assert_eq!(custody.owner, key(0x60));
    assert!(!snapshot.entries.iter().any(|e| e.owner == key(0x60)));
    // Exclusion ledger records the sink with its balance.
    assert_eq!(
        snapshot.exclusions,
        vec![ExcludedBalance {
            owner: key(0x50),
            lp_balance: 1_000,
            reason: ExclusionReason::ExplicitSink,
        }]
    );
}

#[test]
fn salvor_preburn_balance_is_an_ordinary_entry() {
    // Policy D11: the salvor's pre-burn LP stays in the leaf set — the
    // on-chain denominator is the full pre-burn supply, and omitting the
    // salvor's share would strand that fraction of the LP bucket forever.
    // The builder has no special case for any key: the "salvor" below is
    // just another holder.
    let f = fixture();
    let snapshot = SnapshotBuilder::new(f.request_with_sink())
        .build(&f.source(false), &f.locks())
        .unwrap();
    // Let 0x30 stand in for the salvor (any key behaves identically).
    let salvor_entry = snapshot
        .entries
        .iter()
        .find(|e| e.owner == key(0x30))
        .unwrap();
    assert_eq!(salvor_entry.lp_balance, 3_000);
    assert_eq!(
        snapshot.entries.iter().map(|e| e.lp_balance).sum::<u64>(),
        snapshot.reconciliation.entries_total
    );
}

#[test]
fn burned_lp_needs_no_exclusion_entry() {
    // Burned tokens are gone from circulation: they never enumerate, so no
    // ledger entry is needed. The supply gate proves the enumeration is
    // complete regardless.
    let lp_mint = key(0x02);
    let source = InMemorySource::new(
        lp_mint,
        9,
        7_000, // supply excludes the 3_000 that was burned historically
        vec![acct(1, 0x10, 4_000), acct(2, 0x20, 3_000)],
    );
    let locks = InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![]);
    let snapshot = SnapshotBuilder::new(request(lp_mint))
        .build(&source, &locks)
        .unwrap();
    assert_eq!(snapshot.reconciliation.enumerated_total, 7_000);
    assert_eq!(snapshot.reconciliation.entries_total, 7_000);
    assert!(snapshot.exclusions.is_empty());
    assert_eq!(snapshot.locked.total_locked, 0);
    assert!(snapshot.locked.custody.is_none());
}

#[test]
fn zero_balance_accounts_are_ledgered_but_never_claimable() {
    let lp_mint = key(0x03);
    let source = InMemorySource::new(
        lp_mint,
        9,
        1_000,
        vec![acct(1, 0x10, 1_000), acct(2, 0x20, 0)],
    );
    let locks = InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![]);
    let snapshot = SnapshotBuilder::new(request(lp_mint))
        .build(&source, &locks)
        .unwrap();
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.exclusions.len(), 1);
    assert_eq!(snapshot.exclusions[0].reason, ExclusionReason::ZeroBalance);
    assert_eq!(snapshot.exclusions[0].lp_balance, 0);
}

#[test]
fn snapshot_slot_is_carried_from_the_source() {
    let f = fixture();
    let snapshot = SnapshotBuilder::new(f.request_with_sink())
        .build(&f.source(false), &f.locks())
        .unwrap();
    assert_eq!(snapshot.snapshot_slot, 123);
}

// =====================================================================
// Compatibility locks with the on-chain world.
// =====================================================================

/// The snapshot's (holder, balance) entries must feed the vault's leaf
/// function byte-for-byte: leaf = SHA256(pubkey || balance_le_u64) over
/// exactly 40 preimage bytes. `compute_leaf` comes from `grave-vault`
/// (anchor world) while the entries come from `grave-snapshotter`
/// (solana-sdk world) — this test proving type identity AND hash equality
/// is the Phase 5.1 → 5.2 seam.
#[test]
fn entries_feed_grave_vault_compute_leaf_byte_for_byte() {
    use sha2::{Digest, Sha256};

    let f = fixture();
    let snapshot = SnapshotBuilder::new(f.request_with_sink())
        .build(&f.source(false), &f.locks())
        .unwrap();
    for entry in &snapshot.entries {
        let leaf = grave_vault::merkle::compute_leaf(&entry.owner, entry.lp_balance);
        let mut preimage = Vec::with_capacity(40);
        preimage.extend_from_slice(entry.owner.as_ref());
        preimage.extend_from_slice(&entry.lp_balance.to_le_bytes());
        let independent = Sha256::digest(&preimage);
        assert_eq!(leaf, independent.as_slice(), "leaf preimage drifted");
    }
}

/// The snapshotter's UNCX facts must stay in lockstep with the on-chain
/// scanner adapter — these constants gate C5 evidence on the salvage path
/// and locked-LP attribution on the snapshot path; a silent divergence
/// would make the two sides disagree about what is locked.
#[test]
fn uncx_constants_match_the_scanner_adapter() {
    use grave_scanner::adapters::locker::uncx_v4;
    use grave_snapshotter::locked::uncx;

    assert_eq!(uncx::PROGRAM_ID, uncx_v4::PROGRAM_ID);
    assert_eq!(uncx::TOKEN_LOCK_DISC, uncx_v4::TOKEN_LOCK_DISC);
    assert_eq!(uncx::TOKEN_LOCK_SEED, uncx_v4::TOKEN_LOCK_SEED);
    assert_eq!(uncx::TOKEN_LOCK_SIZE, uncx_v4::TOKEN_LOCK_SIZE);
}
