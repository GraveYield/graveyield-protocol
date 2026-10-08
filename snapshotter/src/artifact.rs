// SPDX-License-Identifier: Apache-2.0
//
// The sealed snapshot artifact (Phase 5.2 persistence layer).
//
// `SnapshotBuilder` produces the canonical leaf set; `SnapshotMerkleTree`
// seals it into a root. This module persists the result as the artifact a
// claims service publishes and LP holders consume: pool/mint/slot/supply
// metadata, the Merkle root, and — per holder — the owner, balance, leaf,
// and sorted-pair proof ready for `claim_lp_proceeds`'s
// `merkle_proof: Vec<[u8; 32]>` parameter.
//
// DETERMINISTIC SERIALIZATION (roadmap 5.2: "persist snapshot metadata" +
// "verify root determinism")
//
// The artifact's JSON is a pure function of its data: structs serialize
// fields in declaration order, entries are the snapshot's canonical
// ascending-owner order, proofs are tree order, hashes are lowercase hex,
// pubkeys are canonical base58, and no map with iteration-order freedom
// appears anywhere. Sealing the same snapshot twice therefore yields
// byte-identical JSON, and a third party can recompute the artifact
// bit-for-bit from the same snapshot (spec D12). Readers get the mirror
// check: `verify_integrity` rebuilds the tree from the persisted entries
// and fails closed unless every leaf, every proof, the root, the depth,
// and the closing reconciliation identity all re-derive exactly.
//
// TRUST BOUNDARY (spec §6.3)
//
// The artifact is the published claim of an honest snapshot; the on-chain
// verifier remains the final gate (`verify_proof` + the supply pin at
// salvage). What this module adds is auditability: any published artifact
// can be checked against its own entries without re-running an RPC
// enumeration, and any Drift between the two is loud.

use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;

use crate::error::SnapshotError;
use crate::model::{HolderEntry, LpSnapshot, Reconciliation};
use crate::tree::SnapshotMerkleTree;

/// Current artifact format version. Bumped on any breaking layout change;
/// `verify_integrity` refuses other versions (fail-closed on a format it
/// cannot fully re-derive).
pub const ARTIFACT_FORMAT_VERSION: u32 = 1;

/// One claimant in the published artifact: the holder, its balance, its
/// leaf hash, and its ready-to-submit Merkle proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactEntry {
    #[serde(with = "base58_pubkey")]
    pub owner: Pubkey,
    pub lp_balance: u64,
    /// SHA256(pubkey || balance_le) — `grave_vault::merkle::compute_leaf`
    /// format (hex-encoded in JSON).
    #[serde(with = "hex32")]
    pub leaf: [u8; 32],
    /// Sorted-pair siblings, leaf→root order, ready for
    /// `claim_lp_proceeds` (hex-encoded in JSON). Promotion levels
    /// contribute no element (see `tree.rs`).
    #[serde(with = "vec_hex32")]
    pub proof: Vec<[u8; 32]>,
}

/// The sealed, publishable snapshot artifact. Deterministic end to end:
/// the same snapshot always seals to a byte-identical JSON document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotArtifact {
    pub format_version: u32,
    #[serde(with = "base58_pubkey")]
    pub pool_address: Pubkey,
    #[serde(with = "base58_pubkey")]
    pub amm_program_id: Pubkey,
    #[serde(with = "base58_pubkey")]
    pub lp_mint: Pubkey,
    /// Slot the source served the enumeration at (carried from the
    /// snapshot; the on-chain supply pin at salvage is the final anchor).
    pub snapshot_slot: u64,
    /// The pre-salvage LP supply — the value `salvage_pool` pins against
    /// the live mint and the claims denominator.
    pub lp_total_supply_at_snapshot: u64,
    /// The Merkle root to seal into `PoolRegistry` (hex in JSON).
    #[serde(with = "hex32")]
    pub merkle_root: [u8; 32],
    /// Canonical holders in the leaf set.
    pub leaf_count: usize,
    /// Hashing levels above the leaves (0 = single leaf is the root).
    pub tree_depth: usize,
    /// One entry per claimant, canonical ascending-owner order, proofs
    /// index-aligned with the tree.
    pub entries: Vec<ArtifactEntry>,
    /// Closing token-ledger identity from the snapshot
    /// (`entries_total + sink_exclusions_total == enumerated_total ==
    /// lp_total_supply_at_snapshot`), carried so a reader can audit the
    /// conservation without re-enumerating.
    pub reconciliation: Reconciliation,
}

impl SnapshotArtifact {
    /// Seal a snapshot + tree into the publishable artifact.
    ///
    /// Fail-closed against mixed-up handles: the tree is re-derived from
    /// the snapshot's leaf set and must equal the supplied tree
    /// (`ArtifactMismatch` otherwise). There is no path to publish an
    /// artifact whose root does not derive from its own entries.
    pub fn seal(snapshot: &LpSnapshot, tree: &SnapshotMerkleTree) -> Result<Self, SnapshotError> {
        let rebuilt = SnapshotMerkleTree::from_snapshot(snapshot)?;
        if rebuilt != *tree {
            return Err(SnapshotError::ArtifactMismatch(
                "the supplied tree does not match the snapshot's leaf set".to_string(),
            ));
        }
        let entries = snapshot
            .entries
            .iter()
            .enumerate()
            .map(|(i, e)| ArtifactEntry {
                owner: e.owner,
                lp_balance: e.lp_balance,
                leaf: tree.leaf(i).expect("tree indexes mirror the snapshot"),
                proof: tree.proof(i).expect("tree indexes mirror the snapshot"),
            })
            .collect();
        Ok(Self {
            format_version: ARTIFACT_FORMAT_VERSION,
            pool_address: snapshot.pool_address,
            amm_program_id: snapshot.amm_program_id,
            lp_mint: snapshot.lp_mint,
            snapshot_slot: snapshot.snapshot_slot,
            lp_total_supply_at_snapshot: snapshot.lp_total_supply_at_snapshot,
            merkle_root: tree.root(),
            leaf_count: tree.leaf_count(),
            tree_depth: tree.tree_depth(),
            entries,
            reconciliation: snapshot.reconciliation,
        })
    }

    /// The sealed Merkle root.
    pub fn root(&self) -> [u8; 32] {
        self.merkle_root
    }

    /// The artifact entry for `owner`, if present. Linear scan — no
    /// sortedness precondition, correct on any loaded artifact.
    pub fn proof_for(&self, owner: &Pubkey) -> Option<&ArtifactEntry> {
        self.entries.iter().find(|e| &e.owner == owner)
    }

    /// Full self-check of a (loaded or sealed) artifact: the tree rebuilt
    /// from the persisted entries must re-derive every leaf, every proof,
    /// the root, the depth, the count, and the reconciliation identity
    /// exactly. Any drift is `ArtifactMismatch`; structurally impossible
    /// entry sets (non-canonical, empty, zero balances) are the tree
    /// builder's fail-closed errors.
    pub fn verify_integrity(&self) -> Result<(), SnapshotError> {
        if self.format_version != ARTIFACT_FORMAT_VERSION {
            return Err(SnapshotError::ArtifactMismatch(format!(
                "unsupported artifact format_version {} (expected {})",
                self.format_version, ARTIFACT_FORMAT_VERSION
            )));
        }
        let entries: Vec<HolderEntry> = self
            .entries
            .iter()
            .map(|e| HolderEntry {
                owner: e.owner,
                lp_balance: e.lp_balance,
            })
            .collect();
        let tree = SnapshotMerkleTree::from_entries(&entries)?;
        if tree.root() != self.merkle_root {
            return Err(SnapshotError::ArtifactMismatch(
                "root does not derive from the persisted entries".to_string(),
            ));
        }
        if self.leaf_count != entries.len() || self.leaf_count != tree.leaf_count() {
            return Err(SnapshotError::ArtifactMismatch(
                "leaf_count disagrees with the persisted entries".to_string(),
            ));
        }
        if self.tree_depth != tree.tree_depth() {
            return Err(SnapshotError::ArtifactMismatch(
                "tree_depth disagrees with the persisted entries".to_string(),
            ));
        }
        for (i, entry) in self.entries.iter().enumerate() {
            if tree.leaf(i) != Some(entry.leaf) {
                return Err(SnapshotError::ArtifactMismatch(format!(
                    "leaf mismatch at entry {i} (owner {})",
                    entry.owner
                )));
            }
            if tree.proof(i).as_ref() != Some(&entry.proof) {
                return Err(SnapshotError::ArtifactMismatch(format!(
                    "proof mismatch at entry {i} (owner {})",
                    entry.owner
                )));
            }
        }
        // Closing identity, re-checked from the persisted fields alone.
        let mut total: u128 = 0;
        for entry in &self.entries {
            total = total
                .checked_add(entry.lp_balance as u128)
                .ok_or(SnapshotError::Overflow)?;
        }
        let reconciliation = &self.reconciliation;
        if total != reconciliation.entries_total as u128 {
            return Err(SnapshotError::ArtifactMismatch(format!(
                "Σ persisted balances ({total}) != reconciliation.entries_total ({})",
                reconciliation.entries_total
            )));
        }
        if reconciliation.entries_total + reconciliation.sink_exclusions_total
            != reconciliation.enumerated_total
        {
            return Err(SnapshotError::ArtifactMismatch(
                "reconciliation identity entries + sinks != enumerated broken".to_string(),
            ));
        }
        if reconciliation.enumerated_total != self.lp_total_supply_at_snapshot {
            return Err(SnapshotError::ArtifactMismatch(
                "reconciliation.enumerated_total != lp_total_supply_at_snapshot".to_string(),
            ));
        }
        Ok(())
    }

    /// Canonical published form: pretty JSON, deterministic bytes.
    pub fn to_json_pretty(&self) -> Result<String, SnapshotError> {
        serde_json::to_string_pretty(self).map_err(|e| SnapshotError::Serialization(e.to_string()))
    }

    /// Compact JSON (same canonical field/data ordering).
    pub fn to_json(&self) -> Result<String, SnapshotError> {
        serde_json::to_string(self).map_err(|e| SnapshotError::Serialization(e.to_string()))
    }

    /// Load an artifact from JSON. Structural only — run
    /// [`Self::verify_integrity`] on the result before trusting it.
    pub fn from_json(json: &str) -> Result<Self, SnapshotError> {
        serde_json::from_str(json).map_err(|e| SnapshotError::Serialization(e.to_string()))
    }
}

// ---------------------------------------------------------------------
// Hex codec for 32-byte hashes (lowercase; readers accept either case).
// Kept dependency-free on purpose: the artifact format is normative, and
// a two-function codec is easier to audit than a transitive dependency.
// ---------------------------------------------------------------------

pub(crate) mod hex32 {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub(crate) fn serialize<S: Serializer>(
        value: &[u8; 32],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&super::encode_hex(value))
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(deserializer)?;
        super::decode_hex32(&s).map_err(de::Error::custom)
    }
}

// Pubkeys serialize as canonical base58 STRINGS, not the byte arrays
// solana-sdk 2.x's default serde impls produce — the artifact is published
// for LP holders who must be able to find their own wallet in it. Decode
// goes through `Pubkey::from_str` (strict base58 + length check), so no
// extra dependency is pulled in.
pub(crate) mod base58_pubkey {
    use serde::{de, Deserialize, Deserializer, Serializer};
    use solana_sdk::pubkey::Pubkey;
    use std::str::FromStr;

    pub(crate) fn serialize<S: Serializer>(
        value: &Pubkey,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Pubkey, D::Error> {
        let s = String::deserialize(deserializer)?;
        Pubkey::from_str(&s).map_err(|e| de::Error::custom(format!("invalid base58 pubkey: {e}")))
    }
}

pub(crate) mod vec_hex32 {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub(crate) fn serialize<S: Serializer>(
        value: &[[u8; 32]],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(value.iter().map(|h| super::encode_hex(h)))
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<[u8; 32]>, D::Error> {
        let items = Vec::<String>::deserialize(deserializer)?;
        items
            .iter()
            .map(|s| super::decode_hex32(s).map_err(de::Error::custom))
            .collect()
    }
}

pub(crate) fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub(crate) fn decode_hex32(s: &str) -> Result<[u8; 32], String> {
    let bytes = s.as_bytes();
    if bytes.len() != 64 {
        return Err(format!(
            "expected 64 hex characters for a 32-byte hash, got {}",
            bytes.len()
        ));
    }
    let mut out = [0u8; 32];
    for (i, pair) in bytes.chunks(2).enumerate() {
        let hi =
            hex_val(pair[0]).ok_or_else(|| format!("invalid hex character at offset {}", i * 2))?;
        let lo = hex_val(pair[1])
            .ok_or_else(|| format!("invalid hex character at offset {}", i * 2 + 1))?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locked::{InMemoryLocks, TokenLockRecord};
    use crate::model::TokenAccountSnapshot;
    use crate::source::InMemorySource;
    use crate::{SnapshotBuilder, SnapshotRequest};

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

    /// A small but production-shaped snapshot: 3 claimants, one sink, one
    /// custody account, one lock. Supply 8_000 = 4_000 + 2_500 + 500(sink)
    /// + 1_000(custody, locked for 0x60).
    fn sealed_artifact() -> (LpSnapshot, SnapshotArtifact) {
        let lp_mint = key(0x01);
        let source = InMemorySource::new(
            lp_mint,
            123,
            8_000,
            vec![
                acct(1, 0x10, 4_000),
                acct(2, 0x20, 2_500),
                acct(3, 0x50, 500),   // sink
                acct(4, 0x40, 1_000), // custody
            ],
        );
        let locks =
            InMemoryLocks::from_records(&key(0xAA), &lp_mint, vec![lock(0x71, 1, 0x60, 1_000)]);
        let mut request = SnapshotRequest {
            pool_address: key(0xAA),
            amm_program_id: key(0xAB),
            lp_mint,
            sink_exclusions: vec![key(0x50)],
            custody_owner_overrides: vec![],
        };
        request.sink_exclusions = vec![key(0x50)];
        let snapshot = SnapshotBuilder::new(request)
            .build(&source, &locks)
            .unwrap();
        let tree = SnapshotMerkleTree::from_snapshot(&snapshot).unwrap();
        let artifact = SnapshotArtifact::seal(&snapshot, &tree).unwrap();
        (snapshot, artifact)
    }

    #[test]
    fn seal_is_byte_deterministic_across_rebuilds() {
        let (_, a) = sealed_artifact();
        let (_, b) = sealed_artifact();
        let json_a = a.to_json_pretty().unwrap();
        let json_b = b.to_json_pretty().unwrap();
        assert_eq!(json_a, json_b, "the same snapshot must seal byte-for-byte");
        // Compact form is deterministic too.
        assert_eq!(a.to_json().unwrap(), b.to_json().unwrap());
        // And the round trip preserves the structure exactly.
        let loaded = SnapshotArtifact::from_json(&json_a).unwrap();
        assert_eq!(loaded, a);
        assert_eq!(loaded.to_json_pretty().unwrap(), json_a);
    }

    #[test]
    fn sealed_artifact_passes_verify_integrity() {
        let (_, artifact) = sealed_artifact();
        artifact
            .verify_integrity()
            .expect("a sealed artifact is sound");
    }

    #[test]
    fn seal_rejects_a_foreign_tree() {
        let (snapshot, _) = sealed_artifact();
        // A tree over a DIFFERENT leaf set must not seal this snapshot.
        let other_entries = vec![
            HolderEntry {
                owner: key(0x90),
                lp_balance: 1_111,
            },
            HolderEntry {
                owner: key(0x91),
                lp_balance: 2_222,
            },
        ];
        let foreign_tree = SnapshotMerkleTree::from_entries(&other_entries).unwrap();
        let err = SnapshotArtifact::seal(&snapshot, &foreign_tree).unwrap_err();
        assert!(matches!(err, SnapshotError::ArtifactMismatch(_)));
    }

    #[test]
    fn proof_lookup_finds_the_right_claimant() {
        let (_, artifact) = sealed_artifact();
        // 0x60 holds 1_000 locked LP re-attributed to it.
        let entry = artifact.proof_for(&key(0x60)).expect("claimant present");
        assert_eq!(entry.lp_balance, 1_000);
        assert_eq!(
            artifact.proof_for(&key(0x99)),
            None,
            "non-holders have no proof"
        );
        // Every stored proof is non-trivially shaped for this 3-leaf tree:
        // 3 leaves -> depth 2; the promoted leaf's proof is 1 element.
        assert_eq!(artifact.tree_depth, 2);
        assert!(artifact.entries.iter().all(|e| !e.proof.is_empty()));
        assert!(artifact
            .entries
            .iter()
            .any(|e| e.proof.len() < artifact.tree_depth));
    }

    #[test]
    fn verify_integrity_catches_a_tampered_balance() {
        let (_, artifact) = sealed_artifact();
        let mut json = artifact.to_json_pretty().unwrap();
        // Bump the first entry's balance through raw JSON surgery (the
        // attacker's edit), then reload.
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let owner = artifact.entries[0].owner.to_string();
        let found = value["entries"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|e| e["owner"] == serde_json::Value::String(owner.clone()))
            .unwrap();
        found["lp_balance"] = serde_json::Value::from(artifact.entries[0].lp_balance + 1);
        json = serde_json::to_string_pretty(&value).unwrap();
        let tampered = SnapshotArtifact::from_json(&json).unwrap();
        // The persisted balance now disagrees with the persisted leaf /
        // proof / root / reconciliation — integrity must fail closed.
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn verify_integrity_catches_a_tampered_root() {
        let (_, artifact) = sealed_artifact();
        let json = artifact.to_json_pretty().unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        value["merkle_root"] = serde_json::Value::String(encode_hex(&[0u8; 32]));
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn verify_integrity_catches_an_unsupported_format_version() {
        let (_, artifact) = sealed_artifact();
        let json = artifact.to_json_pretty().unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        value["format_version"] = serde_json::Value::from(99);
        let tampered =
            SnapshotArtifact::from_json(&serde_json::to_string(&value).unwrap()).unwrap();
        assert!(matches!(
            tampered.verify_integrity(),
            Err(SnapshotError::ArtifactMismatch(_))
        ));
    }

    #[test]
    fn hex_codec_round_trips_and_is_strict() {
        let bytes = [
            0x00, 0x01, 0x0a, 0x0f, 0xa0, 0xff, 0x7f, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01,
        ];
        let encoded = encode_hex(&bytes);
        assert_eq!(encoded.len(), 64);
        assert!(!encoded.contains(|c: char| c.is_ascii_uppercase()));
        assert_eq!(decode_hex32(&encoded).unwrap(), bytes);
        // Uppercase is accepted on read (output is always lowercase).
        let upper = encoded.to_uppercase();
        assert_eq!(decode_hex32(&upper).unwrap(), bytes);
        // Wrong length, bad characters — all refused.
        assert!(decode_hex32("").is_err());
        assert!(decode_hex32(&encoded[..63]).is_err());
        assert!(decode_hex32(&format!("{encoded}0")).is_err());
        assert!(decode_hex32(&format!("{}g", &encoded[..63])).is_err());
    }
}
