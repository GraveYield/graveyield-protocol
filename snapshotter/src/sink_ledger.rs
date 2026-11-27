// SPDX-License-Identifier: Apache-2.0
//
// Governed sink-exclusion ledger input (WD-07 / D-04-C+D).
//
// Owner decision D-04-D (`docs/decisions/GY-M1-OWNER-DECISIONS-001.md`
// §5.4): a sink may never be declared by an operator acting alone. Every
// declaration requires objective evidence and an explicit classification
// rationale, owner approval, independent review, publication in a
// per-pool exclusion ledger, the exact address / token account / LP mint /
// raw balance with evidence references, approval identities and
// timestamp, and a reconciliation proving
// `claimable entries + explicitly excluded balances == enumerated
// balances == LP mint supply`.
//
// WHAT THIS MODULE IMPLEMENTS
//
// The versioned wire format (`gy.sink-ledger.v1`) carrying exactly the
// fields D-04-D requires, strict structural validation (unknown fields,
// missing fields, invalid pubkeys, zero balances, empty rationale /
// evidence / approvals, duplicate owners or token accounts — all
// rejected), pool/mint identity binding, and full balance reconciliation
// against the enumerated holder set (enforced in `SnapshotBuilder`).
//
// WHAT THIS MODULE DELIBERATELY DOES NOT IMPLEMENT
//
// Owner-approval AUTHORITY. A file's presence and a valid schema are NOT
// proof that its contents were owner-approved: this code cannot verify
// the authenticity of `approval_identities`, `independent_reviewer`, the
// evidence references, or the act of publication — those are D-04-D
// process controls exercised by the owner and the independent reviewer
// outside this binary. The ledger records them for audit; it does not
// vouch for them. No governance rule beyond the recorded fields is
// invented here: if the owner later adds an approval mechanism (e.g.
// signed ledgers, an approval registry), that is a new schema version.
//
// Provenance: the CLI hashes the EXACT input bytes (SHA-256) and seals
// the digest, the schema version, and the ledger id into the artifact
// (`SinkLedgerProvenance`), so an independent reviewer can establish
// which ledger produced an artifact.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_sdk::pubkey::Pubkey;

use crate::artifact::base58_pubkey;
use crate::error::SnapshotError;

/// The snapshotter's sink-ledger schema id (naming follows the ratified
/// `gy.locker-inventory.v1` / `gy.locker-screening.v1` convention).
pub const SINK_LEDGER_SCHEMA_ID: &str = "gy.sink-ledger.v1";

/// The only schema version this build accepts. Anything else is rejected
/// fail-closed — no silent interpretation of future formats.
pub const SINK_LEDGER_SCHEMA_VERSION: u32 = 1;

/// One governed sink declaration: the exact D-04-D fields for a single
/// sink owner whose balance must leave the claimable leaf set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SinkLedgerEntry {
    /// The sink owner (the account that can never sign a claim).
    #[serde(with = "base58_pubkey")]
    pub owner: Pubkey,
    /// The exact token account where the sink balance is held. Must be
    /// present in the enumeration, owned by `owner`, and carry the full
    /// declared balance — a sink owner whose balance is spread over
    /// several accounts is ambiguous and rejected (fail-closed).
    #[serde(with = "base58_pubkey")]
    pub token_account: Pubkey,
    /// The LP mint the excluded balance is denominated in. Must equal the
    /// ledger's and the request's LP mint.
    #[serde(with = "base58_pubkey")]
    pub lp_mint: Pubkey,
    /// Raw LP amount excluded (no decimal scaling anywhere in the claims
    /// path). Must equal the owner's total enumerated balance.
    pub raw_balance: u64,
    /// Explicit classification rationale (D-04-D item 1).
    pub rationale: String,
    /// Objective supporting evidence references (D-04-D item 1). At least
    /// one required; recorded for audit, not verified for authenticity.
    pub evidence_references: Vec<String>,
    /// Owner approval identities (D-04-D item 2). At least one required;
    /// authenticity is a process control, NOT verified by code.
    pub approval_identities: Vec<String>,
    /// Independent reviewer identity (D-04-D item 3).
    pub independent_reviewer: String,
    /// Approval/publication timestamp (D-04-D item 5).
    pub approved_at: String,
}

/// The versioned, per-pool governed sink-exclusion ledger
/// (`gy.sink-ledger.v1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SinkLedger {
    /// Supported value: [`SINK_LEDGER_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Per-pool ledger identity (the published exclusion ledger's id).
    pub ledger_id: String,
    /// The pool the ledger is scoped to — must equal the snapshot request.
    #[serde(with = "base58_pubkey")]
    pub pool_address: Pubkey,
    /// The AMM program of that pool — must equal the snapshot request.
    #[serde(with = "base58_pubkey")]
    pub amm_program_id: Pubkey,
    /// The LP mint every entry is denominated in.
    #[serde(with = "base58_pubkey")]
    pub lp_mint: Pubkey,
    /// The governed sink declarations. MAY be empty: an explicit,
    /// schema-valid empty ledger records "no exclusions approved for this
    /// pool" and is distinct from a MISSING ledger (which produces an
    /// artifact with no sink-ledger provenance at all).
    pub entries: Vec<SinkLedgerEntry>,
}

impl SinkLedger {
    /// Parse and strictly validate a governed sink ledger from its exact
    /// input bytes. Malformed, unsupported, ambiguous, or self-mismatched
    /// ledgers are rejected — never partially accepted, never silently
    /// reduced to an empty ledger.
    pub fn parse(input: &[u8]) -> Result<Self, SnapshotError> {
        let ledger: SinkLedger = serde_json::from_slice(input)
            .map_err(|e| SnapshotError::SinkLedgerInvalid(format!("malformed sink ledger: {e}")))?;
        if ledger.schema_version != SINK_LEDGER_SCHEMA_VERSION {
            return Err(SnapshotError::SinkLedgerUnsupportedVersion {
                found: ledger.schema_version,
                expected: SINK_LEDGER_SCHEMA_VERSION,
            });
        }
        if ledger.ledger_id.trim().is_empty() {
            return Err(SnapshotError::SinkLedgerInvalid(
                "ledger_id is required (the published per-pool ledger identity)".to_string(),
            ));
        }
        let mut owners = std::collections::BTreeSet::new();
        let mut token_accounts = std::collections::BTreeSet::new();
        for entry in &ledger.entries {
            if entry.lp_mint != ledger.lp_mint {
                return Err(SnapshotError::SinkLedgerIdentityMismatch(format!(
                    "entry owner {}: declared lp_mint {} does not match the ledger's lp_mint {}",
                    entry.owner, entry.lp_mint, ledger.lp_mint
                )));
            }
            if entry.raw_balance == 0 {
                return Err(SnapshotError::SinkLedgerInvalid(format!(
                    "entry owner {}: zero-balance sink declarations are ambiguous; \
                     zero-balance owners are ledgered automatically by the builder",
                    entry.owner
                )));
            }
            if entry.rationale.trim().is_empty() {
                return Err(SnapshotError::SinkLedgerInvalid(format!(
                    "entry owner {}: rationale is required (D-04-D)",
                    entry.owner
                )));
            }
            if entry.evidence_references.is_empty()
                || entry
                    .evidence_references
                    .iter()
                    .any(|r| r.trim().is_empty())
            {
                return Err(SnapshotError::SinkLedgerInvalid(format!(
                    "entry owner {}: at least one non-empty evidence reference is required (D-04-D)",
                    entry.owner
                )));
            }
            if entry.approval_identities.is_empty()
                || entry
                    .approval_identities
                    .iter()
                    .any(|a| a.trim().is_empty())
            {
                return Err(SnapshotError::SinkLedgerInvalid(format!(
                    "entry owner {}: at least one owner approval identity is required (D-04-D); \
                     note the code cannot verify approval authenticity",
                    entry.owner
                )));
            }
            if entry.independent_reviewer.trim().is_empty() {
                return Err(SnapshotError::SinkLedgerInvalid(format!(
                    "entry owner {}: independent_reviewer is required (D-04-D)",
                    entry.owner
                )));
            }
            if entry.approved_at.trim().is_empty() {
                return Err(SnapshotError::SinkLedgerInvalid(format!(
                    "entry owner {}: approved_at is required (D-04-D)",
                    entry.owner
                )));
            }
            if !owners.insert(entry.owner) {
                return Err(SnapshotError::SinkLedgerDuplicateEntry(format!(
                    "owner {} declared more than once; conflicting sink declarations are rejected",
                    entry.owner
                )));
            }
            if !token_accounts.insert(entry.token_account) {
                return Err(SnapshotError::SinkLedgerDuplicateEntry(format!(
                    "token account {} declared by more than one entry",
                    entry.token_account
                )));
            }
            if entry.token_account == entry.owner {
                return Err(SnapshotError::SinkLedgerInvalid(format!(
                    "entry owner {}: token account must be a distinct token-account address, \
                     not the owner itself",
                    entry.owner
                )));
            }
        }
        Ok(ledger)
    }

    /// SHA-256 (lowercase hex) of the exact ledger input bytes — sealed
    /// into the artifact so a reviewer can bind an artifact to the exact
    /// ledger input that produced it.
    pub fn input_digest_hex(input: &[u8]) -> String {
        let digest = Sha256::digest(input);
        let mut out = String::with_capacity(64);
        for b in digest {
            out.push_str(&format!("{b:02x}"));
        }
        out
    }

    /// Bind the ledger to the snapshot request: pool, AMM program, and LP
    /// mint must match exactly — a ledger produced for another pool (or a
    /// stale mint identity) is rejected, never applied.
    pub fn validate_identity(
        &self,
        pool_address: &Pubkey,
        amm_program_id: &Pubkey,
        lp_mint: &Pubkey,
    ) -> Result<(), SnapshotError> {
        if self.pool_address != *pool_address {
            return Err(SnapshotError::SinkLedgerIdentityMismatch(format!(
                "ledger pool_address {} != request pool_address {}",
                self.pool_address, pool_address
            )));
        }
        if self.amm_program_id != *amm_program_id {
            return Err(SnapshotError::SinkLedgerIdentityMismatch(format!(
                "ledger amm_program_id {} != request amm_program_id {}",
                self.amm_program_id, amm_program_id
            )));
        }
        if self.lp_mint != *lp_mint {
            return Err(SnapshotError::SinkLedgerIdentityMismatch(format!(
                "ledger lp_mint {} != request lp_mint {}",
                self.lp_mint, lp_mint
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    fn entry_json(owner_seed: u8, token_seed: u8, balance: u64) -> String {
        format!(
            r#"{{
                "owner": "{}",
                "token_account": "{}",
                "lp_mint": "{}",
                "raw_balance": {balance},
                "rationale": "incinerator address, funds provably unrecoverable",
                "evidence_references": ["gy-evidence-001"],
                "approval_identities": ["owner-identity-1"],
                "independent_reviewer": "reviewer-identity-1",
                "approved_at": "2026-11-27T00:00:00Z"
            }}"#,
            key(owner_seed),
            key(token_seed),
            key(0x01),
        )
    }

    fn ledger_json(entries: &[String]) -> String {
        format!(
            r#"{{
                "schema_version": 1,
                "ledger_id": "GY-SINK-TEST-001",
                "pool_address": "{}",
                "amm_program_id": "{}",
                "lp_mint": "{}",
                "entries": [{}]
            }}"#,
            key(0xAA),
            key(0xAB),
            key(0x01),
            entries.join(","),
        )
    }

    fn valid_ledger() -> Vec<u8> {
        ledger_json(&[entry_json(0x20, 0x21, 1_000)]).into_bytes()
    }

    #[test]
    fn valid_ledger_parses() {
        let ledger = SinkLedger::parse(&valid_ledger()).unwrap();
        assert_eq!(ledger.schema_version, 1);
        assert_eq!(ledger.ledger_id, "GY-SINK-TEST-001");
        assert_eq!(ledger.entries.len(), 1);
        assert_eq!(ledger.entries[0].owner, key(0x20));
        assert_eq!(ledger.entries[0].raw_balance, 1_000);
    }

    #[test]
    fn empty_entry_list_is_a_valid_explicit_empty_ledger() {
        let ledger = SinkLedger::parse(ledger_json(&[]).as_bytes()).unwrap();
        assert!(ledger.entries.is_empty());
    }

    #[test]
    fn unsupported_schema_version_is_rejected() {
        let json = ledger_json(&[]).replace("\"schema_version\": 1", "\"schema_version\": 2");
        let err = SinkLedger::parse(json.as_bytes()).unwrap_err();
        assert_eq!(
            err,
            SnapshotError::SinkLedgerUnsupportedVersion {
                found: 2,
                expected: 1
            }
        );
    }

    #[test]
    fn malformed_ledgers_are_rejected() {
        // Not JSON at all.
        assert!(matches!(
            SinkLedger::parse(b"not json"),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
        // Missing required top-level field.
        let json = ledger_json(&[]).replace("\"ledger_id\": \"GY-SINK-TEST-001\",", "");
        assert!(matches!(
            SinkLedger::parse(json.as_bytes()),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
        // Unknown field — fail closed on anything the schema does not define.
        let json = ledger_json(&[]).replace(
            "\"schema_version\": 1,",
            "\"schema_version\": 1, \"extra_field\": true,",
        );
        assert!(matches!(
            SinkLedger::parse(json.as_bytes()),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
        // Invalid base58 pubkey.
        let json = ledger_json(&[]).replace(&key(0x01).to_string(), "0OIl-not-base58!");
        assert!(matches!(
            SinkLedger::parse(json.as_bytes()),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
        // Empty required strings.
        let bad = ledger_json(&[entry_json(0x20, 0x21, 500)])
            .replace("incinerator address, funds provably unrecoverable", "  ");
        assert!(matches!(
            SinkLedger::parse(bad.as_bytes()),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
        // Zero-balance sink entry.
        let zero = ledger_json(&[entry_json(0x20, 0x21, 0)])
            .as_bytes()
            .to_vec();
        assert!(matches!(
            SinkLedger::parse(&zero),
            Err(SnapshotError::SinkLedgerInvalid(_))
        ));
    }

    #[test]
    fn duplicate_and_conflicting_entries_are_rejected() {
        // Same owner twice (even with different token accounts) — the
        // builder excludes per owner, so conflicting declarations for one
        // owner are ambiguous and rejected.
        let json = ledger_json(&[entry_json(0x20, 0x21, 500), entry_json(0x20, 0x22, 300)]);
        assert!(matches!(
            SinkLedger::parse(json.as_bytes()),
            Err(SnapshotError::SinkLedgerDuplicateEntry(_))
        ));
        // Same token account under two owners.
        let json = ledger_json(&[entry_json(0x20, 0x21, 500), entry_json(0x30, 0x21, 300)]);
        assert!(matches!(
            SinkLedger::parse(json.as_bytes()),
            Err(SnapshotError::SinkLedgerDuplicateEntry(_))
        ));
    }

    #[test]
    fn entry_mint_must_match_the_ledger_mint() {
        // Build the mismatch explicitly (a blanket replace would also hit
        // the ledger-level mint).
        let entry = entry_json(0x20, 0x21, 1_000).replace(
            &format!("\"lp_mint\": \"{}\"", key(0x01)),
            &format!("\"lp_mint\": \"{}\"", key(0x02)),
        );
        let json = ledger_json(&[entry]);
        assert!(matches!(
            SinkLedger::parse(json.as_bytes()),
            Err(SnapshotError::SinkLedgerIdentityMismatch(_))
        ));
    }

    #[test]
    fn identity_binding_rejects_foreign_pool_amm_or_mint() {
        let ledger = SinkLedger::parse(&valid_ledger()).unwrap();
        // Wrong pool.
        assert!(matches!(
            ledger.validate_identity(&key(0xBB), &key(0xAB), &key(0x01)),
            Err(SnapshotError::SinkLedgerIdentityMismatch(_))
        ));
        // Wrong AMM program.
        assert!(matches!(
            ledger.validate_identity(&key(0xAA), &key(0xAC), &key(0x01)),
            Err(SnapshotError::SinkLedgerIdentityMismatch(_))
        ));
        // Wrong LP mint.
        assert!(matches!(
            ledger.validate_identity(&key(0xAA), &key(0xAB), &key(0x02)),
            Err(SnapshotError::SinkLedgerIdentityMismatch(_))
        ));
        // Exact match is accepted.
        ledger
            .validate_identity(&key(0xAA), &key(0xAB), &key(0x01))
            .unwrap();
    }

    #[test]
    fn input_digest_binds_the_exact_bytes() {
        let a = SinkLedger::input_digest_hex(b"ledger-bytes-a");
        let b = SinkLedger::input_digest_hex(b"ledger-bytes-b");
        let a_again = SinkLedger::input_digest_hex(b"ledger-bytes-a");
        assert_ne!(a, b, "different inputs must produce different digests");
        assert_eq!(a, a_again, "the digest is a pure function of the input");
        assert_eq!(a.len(), 64);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        // One-bit change in input changes the digest (spot check).
        let c = SinkLedger::input_digest_hex(b"ledger-bytes-A");
        assert_ne!(a, c);
    }
}
