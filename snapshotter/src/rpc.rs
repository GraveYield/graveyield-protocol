// SPDX-License-Identifier: Apache-2.0
//
// RPC-backed enumeration sources (blocking `solana-client`).
//
// Everything versionable lives in pure helpers (filter construction,
// account-data parsing); the client calls themselves are thin wrappers.
// The unit tests below pin the wire-level filter shapes and the SPL
// account layouts without touching a network.

use solana_account_decoder_client_types::UiAccountEncoding;
use solana_client::rpc_client::RpcClient;
use solana_client::rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use solana_client::rpc_filter::{Memcmp, RpcFilterType};
use solana_sdk::account::Account;
use solana_sdk::commitment_config::CommitmentConfig;
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

/// `getProgramAccounts` configs are served in unspecified order; the
/// snapshot mechanics re-establish determinism downstream (BTreeMap
/// aggregation), but a stable server-side sort is requested where the RPC
/// supports it.
fn gpa_config(filters: Vec<RpcFilterType>) -> RpcProgramAccountsConfig {
    RpcProgramAccountsConfig {
        filters: Some(filters),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            data_slice: None,
            commitment: None,
            min_context_slot: None,
        },
        with_context: None,
        sort_results: Some(true),
    }
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
pub struct RpcLpAccountSource {
    client: RpcClient,
    token_program_id: Pubkey,
}

impl RpcLpAccountSource {
    /// Source over the classic SPL Token Program.
    pub fn new(client: RpcClient) -> Self {
        Self {
            client,
            token_program_id: SPL_TOKEN_PROGRAM_ID,
        }
    }

    /// Source over an explicit token program (Token-2022 future).
    pub fn with_token_program(client: RpcClient, token_program_id: Pubkey) -> Self {
        Self {
            client,
            token_program_id,
        }
    }
}

impl LpAccountSource for RpcLpAccountSource {
    fn lp_mint_supply(&self, lp_mint: &Pubkey) -> Result<MintSupply, SnapshotError> {
        let response = self
            .client
            .get_account_with_commitment(lp_mint, CommitmentConfig::confirmed())
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

    fn token_accounts(&self, lp_mint: &Pubkey) -> Result<Vec<TokenAccountSnapshot>, SnapshotError> {
        let accounts = self
            .client
            .get_program_accounts_with_config(
                &self.token_program_id,
                gpa_config(token_account_filters(lp_mint)),
            )
            .map_err(|e| SnapshotError::Source(e.to_string()))?;
        accounts
            .iter()
            .map(|(address, account)| parse_spl_token_account(*address, &account.data, lp_mint))
            .collect()
    }
}

/// RPC-backed [`LockedLpEvidence`] for the UNCX Raydium V4 locker:
/// `getProgramAccounts` on the locker program with size + discriminator +
/// binding filters, every record routed through the strict
/// [`TokenLockRecord::parse`] validation.
pub struct RpcLockedLpEvidence {
    client: RpcClient,
}

impl RpcLockedLpEvidence {
    pub fn new(client: RpcClient) -> Self {
        Self { client }
    }
}

impl LockedLpEvidence for RpcLockedLpEvidence {
    fn token_locks(
        &self,
        amm_id: &Pubkey,
        lp_mint: &Pubkey,
    ) -> Result<Vec<TokenLockRecord>, SnapshotError> {
        let accounts = self
            .client
            .get_program_accounts_with_config(
                &uncx::PROGRAM_ID,
                gpa_config(token_lock_filters(amm_id, lp_mint)),
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
