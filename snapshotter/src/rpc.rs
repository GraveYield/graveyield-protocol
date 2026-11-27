// SPDX-License-Identifier: Apache-2.0
//
// RPC-backed enumeration sources (blocking `solana-client`).
//
// Everything versionable lives in pure helpers (filter construction,
// account-data parsing, request-parameter shaping); the client calls
// themselves are thin wrappers. The unit tests below pin the wire-level
// filter shapes, the SPL account layouts, and the consistent-state request
// parameters without touching a network.
//
// CONSISTENT-STATE PINNING (WD-02 fix)
//
// Every read this source performs is pinned to one explicitly configured
// commitment and one anchored context slot:
//
//   * `initial_supply` reads the mint at the configured commitment and
//     returns the RPC context slot — the snapshot's state anchor. No
//     implicit client default participates: the commitment is a
//     constructor argument and speculative (processed) state is rejected
//     outright, because rolled-back state must never anchor a claims
//     snapshot.
//   * `token_accounts` issues `getProgramAccounts` at the SAME commitment
//     with `minContextSlot` set to the anchor slot, so a node that cannot
//     serve at least the anchored state fails the request instead of
//     silently enumerating older data.
//   * `final_supply` re-reads the mint through a raw `getAccountInfo`
//     carrying the same commitment AND `minContextSlot` (the stock
//     `get_account_with_commitment` helper cannot express a minimum
//     context slot), and refuses a served slot older than the anchor.
//
// KNOWN LIMITATION (documented trust boundary, D-06 P2)
//
// The initial/final supply equality check detects SUPPLY drift between the
// two anchored reads. It cannot detect a same-total holder transfer that
// happened between the anchor slot and the enumeration: the total is
// unchanged, the gate passes, and the per-holder attribution is the
// enumeration's state — which is bounded below by the anchor but not
// provably equal to it. Holder-level revalidation is the separate P2
// control and is NOT claimed here.

use serde_json::json;
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_client::rpc_client::RpcClient;
use solana_client::rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use solana_client::rpc_filter::{Memcmp, RpcFilterType};
use solana_client::rpc_request::RpcRequest;
use solana_client::rpc_response::Response;
use solana_commitment_config::{CommitmentConfig, CommitmentLevel};
use solana_sdk::account::Account;
use solana_sdk::pubkey::Pubkey;

use crate::error::SnapshotError;
use crate::locked::{uncx, LockedLpEvidence, TokenLockRecord};
use crate::model::{MintSupply, TokenAccountSnapshot};
use crate::source::LpAccountSource;

/// Classic SPL Token Program — Raydium V4 LP mints are classic SPL tokens.
/// Overridable via [`RpcLpAccountSource::with_token_program`] for a future
/// Token-2022 pool (not a v1.0 venue).
pub const SPL_TOKEN_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// Classic SPL token account layout (165 bytes).
mod spl_layout {
    pub const ACCOUNT_SIZE: u64 = 165;
    pub const MINT_OFFSET: usize = 0;
    pub const OWNER_OFFSET: usize = 32;
    pub const AMOUNT_OFFSET: usize = 64;
    pub const MINT_SIZE: usize = 82;
    pub const MINT_SUPPLY_OFFSET: usize = 36;
}

/// Commitment levels acceptable for a claims-grade snapshot.
///
/// `processed` is rejected because speculative state can be rolled back —
/// a snapshot anchored to it could describe state that never happened.
/// `confirmed` and `finalized` are accepted; the caller MUST choose
/// explicitly (there is no default) and use the SAME level for every read
/// of one snapshot run.
fn ensure_claims_commitment(commitment: CommitmentConfig) -> Result<(), SnapshotError> {
    if commitment.commitment == CommitmentLevel::Processed {
        return Err(SnapshotError::Source(
            "commitment `processed` is not acceptable for a claims snapshot: speculative \
             state can be rolled back; use `confirmed` or `finalized` and pass the same \
             level to every read of the run"
                .to_string(),
        ));
    }
    Ok(())
}

/// Parse a CLI commitment flag. Unknown names are rejected rather than
/// silently falling back to a client default.
pub fn parse_commitment(name: &str) -> Result<CommitmentConfig, SnapshotError> {
    let level = match name {
        "confirmed" => CommitmentLevel::Confirmed,
        "finalized" => CommitmentLevel::Finalized,
        other => {
            return Err(SnapshotError::Source(format!(
                "unsupported commitment `{other}`; supported values: confirmed, finalized"
            )))
        }
    };
    let commitment = CommitmentConfig { commitment: level };
    ensure_claims_commitment(commitment)?;
    Ok(commitment)
}

/// `getProgramAccounts` configs are served in unspecified order; the
/// snapshot mechanics re-establish determinism downstream (BTreeMap
/// aggregation), but a stable server-side sort is requested where the RPC
/// supports it.
///
/// The config is pinned: the caller's commitment and `min_context_slot`
/// (the anchored supply-read slot) ride on every enumeration request, so a
/// node that cannot serve at least the anchored state fails the request
/// instead of silently returning older accounts.
fn gpa_config(
    filters: Vec<RpcFilterType>,
    commitment: CommitmentConfig,
    min_context_slot: u64,
) -> RpcProgramAccountsConfig {
    RpcProgramAccountsConfig {
        filters: Some(filters),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            data_slice: None,
            commitment: Some(commitment),
            min_context_slot: Some(min_context_slot),
        },
        with_context: None,
        sort_results: Some(true),
    }
}

/// Raw `getAccountInfo` parameters carrying the configured commitment and
/// the pinned `minContextSlot` — the post-enumeration supply re-read. The
/// stock `get_account_with_commitment` helper cannot express a minimum
/// context slot, so the request is issued through the client's raw `send`
/// with exactly these parameters (shape pinned by test).
fn account_info_params(
    lp_mint: &Pubkey,
    commitment: CommitmentConfig,
    min_context_slot: u64,
) -> serde_json::Value {
    json!([
        lp_mint.to_string(),
        {
            "encoding": "base64",
            "commitment": commitment.commitment.to_string(),
            "minContextSlot": min_context_slot,
        }
    ])
}

/// Filters selecting every classic SPL token account of `lp_mint`:
/// exact account size + `memcmp` on the mint field.
fn token_account_filters(lp_mint: &Pubkey) -> Vec<RpcFilterType> {
    vec![
        RpcFilterType::DataSize(spl_layout::ACCOUNT_SIZE),
        RpcFilterType::Memcmp(Memcmp::new_raw_bytes(
            spl_layout::MINT_OFFSET,
            lp_mint.to_bytes().to_vec(),
        )),
    ]
}

/// Filters selecting every UNCX `TokenLock` bound to `(amm_id, lp_mint)`:
/// exact size + discriminator + both binding fields.
fn token_lock_filters(amm_id: &Pubkey, lp_mint: &Pubkey) -> Vec<RpcFilterType> {
    vec![
        RpcFilterType::DataSize(uncx::TOKEN_LOCK_SIZE as u64),
        RpcFilterType::Memcmp(Memcmp::new_raw_bytes(0, uncx::TOKEN_LOCK_DISC.to_vec())),
        RpcFilterType::Memcmp(Memcmp::new_raw_bytes(
            uncx::offsets::AMM_ID,
            amm_id.to_bytes().to_vec(),
        )),
        RpcFilterType::Memcmp(Memcmp::new_raw_bytes(
            uncx::offsets::LP_MINT,
            lp_mint.to_bytes().to_vec(),
        )),
    ]
}

/// Parse and validate a raw classic SPL token account against the expected
/// LP mint. The mint check is defense-in-depth (the RPC filter already
/// scopes by mint) — a violating response means the node served garbage
/// and the snapshot aborts.
fn parse_spl_token_account(
    address: Pubkey,
    data: &[u8],
    lp_mint: &Pubkey,
) -> Result<TokenAccountSnapshot, SnapshotError> {
    if data.len() != spl_layout::ACCOUNT_SIZE as usize {
        return Err(SnapshotError::Source(format!(
            "token account {address}: expected {} bytes, got {}",
            spl_layout::ACCOUNT_SIZE,
            data.len()
        )));
    }
    if data[spl_layout::MINT_OFFSET..spl_layout::MINT_OFFSET + 32] != lp_mint.as_ref()[..] {
        return Err(SnapshotError::Source(format!(
            "token account {address}: mint field does not match the queried LP mint"
        )));
    }
    let owner = Pubkey::new_from_array(
        data[spl_layout::OWNER_OFFSET..spl_layout::OWNER_OFFSET + 32]
            .try_into()
            .map_err(|_| SnapshotError::Source(format!("token account {address}: owner slice")))?,
    );
    let amount = u64::from_le_bytes(
        data[spl_layout::AMOUNT_OFFSET..spl_layout::AMOUNT_OFFSET + 8]
            .try_into()
            .map_err(|_| SnapshotError::Source(format!("token account {address}: amount slice")))?,
    );
    Ok(TokenAccountSnapshot {
        address,
        owner,
        amount,
    })
}

/// Parse and validate a raw SPL Mint account, returning the supply.
fn parse_spl_mint_supply(
    address: &Pubkey,
    account: &Account,
    token_program_id: &Pubkey,
) -> Result<u64, SnapshotError> {
    if account.owner != *token_program_id {
        return Err(SnapshotError::Source(format!(
            "mint {address}: owner {} is not the token program",
            account.owner
        )));
    }
    if account.data.len() != spl_layout::MINT_SIZE {
        return Err(SnapshotError::Source(format!(
            "mint {address}: expected {} bytes, got {}",
            spl_layout::MINT_SIZE,
            account.data.len()
        )));
    }
    Ok(u64::from_le_bytes(
        account.data[spl_layout::MINT_SUPPLY_OFFSET..spl_layout::MINT_SUPPLY_OFFSET + 8]
            .try_into()
            .map_err(|_| SnapshotError::Source(format!("mint {address}: supply slice")))?,
    ))
}

/// RPC-backed [`LpAccountSource`] for the LP-holder enumeration.
///
/// The commitment is explicit and validated at construction: there is no
/// path that silently defers to the `RpcClient`'s configured default.
pub struct RpcLpAccountSource {
    client: RpcClient,
    token_program_id: Pubkey,
    commitment: CommitmentConfig,
}

impl RpcLpAccountSource {
    /// Source over the classic SPL Token Program at an explicit
    /// commitment (speculative `processed` is rejected).
    pub fn new(client: RpcClient, commitment: CommitmentConfig) -> Result<Self, SnapshotError> {
        ensure_claims_commitment(commitment)?;
        Ok(Self {
            client,
            token_program_id: SPL_TOKEN_PROGRAM_ID,
            commitment,
        })
    }

    /// Source over an explicit token program (Token-2022 future) at an
    /// explicit commitment (speculative `processed` is rejected).
    pub fn with_token_program(
        client: RpcClient,
        token_program_id: Pubkey,
        commitment: CommitmentConfig,
    ) -> Result<Self, SnapshotError> {
        ensure_claims_commitment(commitment)?;
        Ok(Self {
            client,
            token_program_id,
            commitment,
        })
    }
}

impl LpAccountSource for RpcLpAccountSource {
    fn initial_supply(&self, lp_mint: &Pubkey) -> Result<MintSupply, SnapshotError> {
        let response = self
            .client
            .get_account_with_commitment(lp_mint, self.commitment)
            .map_err(|e| SnapshotError::Source(e.to_string()))?;
        let account = response
            .value
            .ok_or_else(|| SnapshotError::Source(format!("mint {lp_mint} not found")))?;
        let amount = parse_spl_mint_supply(lp_mint, &account, &self.token_program_id)?;
        Ok(MintSupply {
            amount,
            slot: response.context.slot,
        })
    }

    fn token_accounts(
        &self,
        lp_mint: &Pubkey,
        min_context_slot: u64,
    ) -> Result<Vec<TokenAccountSnapshot>, SnapshotError> {
        // getProgramAccounts returns raw account bytes (parsed below by
        // parse_spl_token_account); the suggested get_program_ui_accounts_
        // with_config migration returns UI-encoded accounts — a behavioral
        // migration deliberately deferred out of the dependency-bump PR.
        #[allow(deprecated)]
        let accounts = self
            .client
            .get_program_accounts_with_config(
                &self.token_program_id,
                gpa_config(
                    token_account_filters(lp_mint),
                    self.commitment,
                    min_context_slot,
                ),
            )
            .map_err(|e| SnapshotError::Source(e.to_string()))?;
        accounts
            .iter()
            .map(|(address, account)| parse_spl_token_account(*address, &account.data, lp_mint))
            .collect()
    }

    fn final_supply(
        &self,
        lp_mint: &Pubkey,
        min_context_slot: u64,
    ) -> Result<MintSupply, SnapshotError> {
        let response: Response<Option<Account>> = self
            .client
            .send(
                RpcRequest::Custom {
                    method: "getAccountInfo",
                },
                account_info_params(lp_mint, self.commitment, min_context_slot),
            )
            .map_err(|e| SnapshotError::Source(e.to_string()))?;
        if response.context.slot < min_context_slot {
            return Err(SnapshotError::StaleState {
                anchor_slot: min_context_slot,
                served_slot: response.context.slot,
            });
        }
        let account = response
            .value
            .ok_or_else(|| SnapshotError::Source(format!("mint {lp_mint} not found")))?;
        let amount = parse_spl_mint_supply(lp_mint, &account, &self.token_program_id)?;
        Ok(MintSupply {
            amount,
            slot: response.context.slot,
        })
    }
}

/// RPC-backed [`LockedLpEvidence`] for the UNCX Raydium V4 locker:
/// `getProgramAccounts` on the locker program with size + discriminator +
/// binding filters, every record routed through the strict
/// [`TokenLockRecord::parse`] validation. The query is pinned to the same
/// commitment and anchored context slot as the holder enumeration, so
/// lock evidence and token-account enumeration describe one state.
pub struct RpcLockedLpEvidence {
    client: RpcClient,
    commitment: CommitmentConfig,
}

impl RpcLockedLpEvidence {
    /// Evidence source at an explicit commitment (speculative `processed`
    /// is rejected).
    pub fn new(client: RpcClient, commitment: CommitmentConfig) -> Result<Self, SnapshotError> {
        ensure_claims_commitment(commitment)?;
        Ok(Self { client, commitment })
    }
}

impl LockedLpEvidence for RpcLockedLpEvidence {
    fn token_locks(
        &self,
        amm_id: &Pubkey,
        lp_mint: &Pubkey,
        min_context_slot: u64,
    ) -> Result<Vec<TokenLockRecord>, SnapshotError> {
        // See token_accounts: raw-bytes gPA kept deliberately (UI-account
        // migration deferred out of the dependency-bump PR).
        #[allow(deprecated)]
        let accounts = self
            .client
            .get_program_accounts_with_config(
                &uncx::PROGRAM_ID,
                gpa_config(
                    token_lock_filters(amm_id, lp_mint),
                    self.commitment,
                    min_context_slot,
                ),
            )
            .map_err(|e| SnapshotError::Source(e.to_string()))?;
        let mut records = accounts
            .iter()
            .map(|(address, account)| {
                TokenLockRecord::parse(*address, &account.data, amm_id, lp_mint)
            })
            .collect::<Result<Vec<_>, SnapshotError>>()?;
        // The RPC may serve accounts in any order; canonicalize here so the
        // evidence list itself is deterministic (the builder re-sorts anyway).
        records.sort();
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::pubkey::Pubkey;

    fn mint() -> Pubkey {
        Pubkey::new_from_array([5u8; 32])
    }
    fn amm() -> Pubkey {
        Pubkey::new_from_array([6u8; 32])
    }

    /// The client's 2.3.x wire shape for a raw-byte memcmp: the bytes ride
    /// as a JSON array with `"encoding":"bytes"` (agave convention), not
    /// base58.
    fn bytes_json(bytes: &[u8]) -> String {
        let items: Vec<String> = bytes.iter().map(u8::to_string).collect();
        format!("[{}]", items.join(","))
    }

    #[test]
    fn token_account_filters_have_the_documented_wire_shape() {
        let filters = token_account_filters(&mint());
        assert_eq!(filters.len(), 2);
        let json = serde_json::to_string(&filters).unwrap();
        // dataSize 165 + memcmp(mint @ 0) — the standard SPL enumeration.
        let expected = format!(
            r#"[{{"dataSize":165}},{{"memcmp":{{"offset":0,"encoding":"bytes","bytes":{}}}}}]"#,
            bytes_json(&mint().to_bytes())
        );
        assert_eq!(json, expected);
    }

    #[test]
    fn token_lock_filters_pin_all_four_constraints() {
        let filters = token_lock_filters(&amm(), &mint());
        assert_eq!(filters.len(), 4);
        let json = serde_json::to_string(&filters).unwrap();
        let expected = format!(
            r#"[{{"dataSize":146}},{{"memcmp":{{"offset":0,"encoding":"bytes","bytes":{}}}}},{{"memcmp":{{"offset":{},"encoding":"bytes","bytes":{}}}}},{{"memcmp":{{"offset":{},"encoding":"bytes","bytes":{}}}}}]"#,
            bytes_json(&uncx::TOKEN_LOCK_DISC),
            uncx::offsets::AMM_ID,
            bytes_json(&amm().to_bytes()),
            uncx::offsets::LP_MINT,
            bytes_json(&mint().to_bytes())
        );
        assert_eq!(json, expected);
    }

    #[test]
    fn gpa_config_pins_commitment_and_min_context_slot() {
        // The enumeration request MUST carry the caller's commitment and
        // the anchored supply-read slot as minContextSlot — this is the
        // WD-02 fix at the wire level (previously both were `None`, so the
        // client default commitment and unpinned state were used).
        let config = gpa_config(
            token_account_filters(&mint()),
            parse_commitment("confirmed").unwrap(),
            123_456,
        );
        let json = serde_json::to_value(&config).unwrap();
        // RpcProgramAccountsConfig flattens the account config into the
        // top-level config object (camelCase keys) — exactly the wire
        // shape the node receives.
        assert_eq!(json["commitment"], json!("confirmed"));
        assert_eq!(json["minContextSlot"], json!(123_456));
        assert_eq!(json["encoding"], json!("base64"));
        // sort_results is requested (server-side stability where supported).
        assert_eq!(json["sortResults"], json!(true));

        // The same pin applies to the lock-evidence query — both reads of
        // one run describe one state.
        let locks = gpa_config(
            token_lock_filters(&amm(), &mint()),
            parse_commitment("finalized").unwrap(),
            77,
        );
        let json = serde_json::to_value(&locks).unwrap();
        assert_eq!(json["commitment"], json!("finalized"));
        assert_eq!(json["minContextSlot"], json!(77));
    }

    #[test]
    fn account_info_params_pin_commitment_and_min_context_slot() {
        // The post-enumeration re-read rides a raw getAccountInfo with the
        // same commitment and minContextSlot the enumeration used.
        let params = account_info_params(&mint(), parse_commitment("confirmed").unwrap(), 123_456);
        assert_eq!(params[0], json!(mint().to_string()));
        assert_eq!(params[1]["commitment"], json!("confirmed"));
        assert_eq!(params[1]["minContextSlot"], json!(123_456));
        assert_eq!(params[1]["encoding"], json!("base64"));

        let params = account_info_params(&mint(), parse_commitment("finalized").unwrap(), 9);
        assert_eq!(params[1]["commitment"], json!("finalized"));
        assert_eq!(params[1]["minContextSlot"], json!(9));
    }

    #[test]
    fn commitment_parsing_accepts_only_claims_grade_levels() {
        assert_eq!(
            parse_commitment("confirmed").unwrap().commitment,
            CommitmentLevel::Confirmed
        );
        assert_eq!(
            parse_commitment("finalized").unwrap().commitment,
            CommitmentLevel::Finalized
        );
        // Speculative state is refused, not silently downgraded.
        assert!(parse_commitment("processed").is_err());
        // Unknown names are refused, not mapped to a default.
        assert!(parse_commitment("recent").is_err());
        assert!(parse_commitment("").is_err());
        assert!(parse_commitment("CONFIRMED").is_err());
        // The constructor-level guard matches.
        assert!(RpcLpAccountSource::new(
            RpcClient::new("http://localhost:8899".to_string()),
            CommitmentConfig::processed(),
        )
        .is_err());
        assert!(RpcLockedLpEvidence::new(
            RpcClient::new("http://localhost:8899".to_string()),
            CommitmentConfig::processed(),
        )
        .is_err());
    }

    #[test]
    fn parses_a_valid_spl_token_account() {
        let owner = Pubkey::new_from_array([9u8; 32]);
        let mut data = vec![0u8; 165];
        data[..32].copy_from_slice(mint().as_ref());
        data[32..64].copy_from_slice(owner.as_ref());
        data[64..72].copy_from_slice(&777u64.to_le_bytes());
        let parsed =
            parse_spl_token_account(Pubkey::new_from_array([1u8; 32]), &data, &mint()).unwrap();
        assert_eq!(parsed.owner, owner);
        assert_eq!(parsed.amount, 777);
    }

    #[test]
    fn rejects_truncated_and_foreign_mint_token_accounts() {
        let truncated = vec![0u8; 164];
        let err = parse_spl_token_account(Pubkey::new_from_array([1u8; 32]), &truncated, &mint())
            .unwrap_err();
        assert!(matches!(err, SnapshotError::Source(_)));

        let mut foreign = vec![0u8; 165];
        foreign[..32].copy_from_slice(Pubkey::new_from_array([2u8; 32]).as_ref());
        let err = parse_spl_token_account(Pubkey::new_from_array([1u8; 32]), &foreign, &mint())
            .unwrap_err();
        assert!(matches!(err, SnapshotError::Source(_)));
    }

    #[test]
    fn parses_mint_supply_and_rejects_bad_owners() {
        let mut mint_acct = Account {
            lamports: 1,
            data: vec![0u8; 82],
            owner: SPL_TOKEN_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        };
        mint_acct.data[36..44].copy_from_slice(&9_999u64.to_le_bytes());
        let supply = parse_spl_mint_supply(&mint(), &mint_acct, &SPL_TOKEN_PROGRAM_ID).unwrap();
        assert_eq!(supply, 9_999);

        mint_acct.owner = Pubkey::new_from_array([3u8; 32]);
        let err = parse_spl_mint_supply(&mint(), &mint_acct, &SPL_TOKEN_PROGRAM_ID).unwrap_err();
        assert!(matches!(err, SnapshotError::Source(_)));
    }

    #[test]
    fn spl_token_program_id_is_the_canonical_one() {
        // Pinned against the spl-token crate's own declare_id (spl-token 8.0.0).
        assert_eq!(
            SPL_TOKEN_PROGRAM_ID.to_string(),
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        );
    }
}
