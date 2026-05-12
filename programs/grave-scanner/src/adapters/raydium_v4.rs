// SPDX-License-Identifier: Apache-2.0
//
// Raydium V4 (legacy AMM v4) pool adapter — m4 implementation.
//
// Mainnet program ID: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
//
// The Raydium V4 AMM pool account ("AmmInfo") is a 752-byte struct
// documented at:
//   https://github.com/raydium-io/raydium-amm/blob/master/program/src/state.rs
//
// Fields GraveScanner reads from AmmInfo:
//   - coin_vault, pc_vault             (Pubkey) — vault SPL token accounts
//                                                 (reserves live here, NOT on
//                                                 the pool account itself)
//   - coin_vault_mint, pc_vault_mint   (Pubkey) — base/quote mint addresses
//   - lp_mint                          (Pubkey) — LP token mint
//
// The caller MUST pass `coin_vault`, `pc_vault`, and `lp_mint` accounts
// via `remaining_accounts` (any order — looked up by Pubkey). Reserve and
// LP-supply values are read from those SPL accounts.
//
// Raydium V4's AmmInfo does NOT store a last-swap-timestamp field. The
// adapter returns 0 as a sentinel; the criteria evaluator currently
// takes `last_swap_unix_ts` from the instruction param (tagged
// ORACLE-002 in docs/PRE_MAINNET_CHECKLIST.md until indexer-signed
// attestation lands).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;
use anchor_spl::token::{Mint, TokenAccount};

use super::{find_account_by_key, PoolData};
use crate::errors::GraveScannerError;

/// Mainnet Raydium V4 program ID.
pub const PROGRAM_ID: Pubkey = pubkey!("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

/// Canonical AmmInfo account size on Raydium V4. Pool accounts that
/// don't match this size are rejected as the wrong shape.
pub const AMM_INFO_SIZE: usize = 752;

/// Byte offsets into AmmInfo for the Pubkey fields we read. Verified
/// against the Raydium open-source AMM source-of-truth and the canonical
/// 752-byte layout: 16 u64 prefix (128) + Fees (64) + StateData (144)
/// + 9 Pubkeys (288) + 8 u64 padding (64) + amm_owner (32) + 2 u64 (16)
/// + 2 u64 padding (16) = 752.
mod offsets {
    pub const COIN_VAULT: usize = 336;
    pub const PC_VAULT: usize = 368;
    pub const COIN_VAULT_MINT: usize = 400;
    pub const PC_VAULT_MINT: usize = 432;
    pub const LP_MINT: usize = 464;
}

/// Parse a Raydium V4 AMM pool account into `PoolData`.
///
/// Caller must include the pool's `coin_vault`, `pc_vault`, and
/// `lp_mint` accounts in `remaining_accounts` (any order — looked up by
/// Pubkey). Reserves and LP supply are read from those SPL accounts.
///
/// Defense in depth: the vault token accounts' `mint` fields are
/// verified against AmmInfo's claimed `coin_vault_mint` /
/// `pc_vault_mint`, so an attacker who supplies the genuine pool account
/// but forged vault accounts (e.g. vaults pointing to a different mint)
/// is rejected with `PoolDataParseError`.
pub fn parse<'info>(
    pool_account_info: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<PoolData> {
    let (coin_vault, pc_vault, coin_vault_mint, pc_vault_mint, lp_mint) = {
        let data = pool_account_info
            .try_borrow_data()
            .map_err(|_| GraveScannerError::PoolDataParseError)?;
        require!(
            data.len() == AMM_INFO_SIZE,
            GraveScannerError::PoolDataParseError
        );
        (
            read_pubkey(&data, offsets::COIN_VAULT)?,
            read_pubkey(&data, offsets::PC_VAULT)?,
            read_pubkey(&data, offsets::COIN_VAULT_MINT)?,
            read_pubkey(&data, offsets::PC_VAULT_MINT)?,
            read_pubkey(&data, offsets::LP_MINT)?,
        )
    };

    let coin_vault_info = find_account_by_key(remaining_accounts, &coin_vault)?;
    let pc_vault_info = find_account_by_key(remaining_accounts, &pc_vault)?;
    let lp_mint_info = find_account_by_key(remaining_accounts, &lp_mint)?;

    // `Account::<T>::try_from` validates account ownership against the SPL
    // Token Program ID. A non-token account passed in remaining_accounts is
    // rejected here regardless of its data layout.
    let coin_account: Account<TokenAccount> = Account::try_from(coin_vault_info)
        .map_err(|_| GraveScannerError::PoolDataParseError)?;
    let pc_account: Account<TokenAccount> = Account::try_from(pc_vault_info)
        .map_err(|_| GraveScannerError::PoolDataParseError)?;
    let lp_mint_account: Account<Mint> = Account::try_from(lp_mint_info)
        .map_err(|_| GraveScannerError::PoolDataParseError)?;

    require_keys_eq!(
        coin_account.mint,
        coin_vault_mint,
        GraveScannerError::PoolDataParseError
    );
    require_keys_eq!(
        pc_account.mint,
        pc_vault_mint,
        GraveScannerError::PoolDataParseError
    );

    Ok(PoolData {
        last_swap_unix_ts: 0,
        base_reserve: coin_account.amount,
        quote_reserve: pc_account.amount,
        lp_supply: lp_mint_account.supply,
        base_mint: coin_vault_mint,
        quote_mint: pc_vault_mint,
        lp_mint,
    })
}

fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    require!(
        data.len() >= offset + 32,
        GraveScannerError::PoolDataParseError
    );
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&data[offset..offset + 32]);
    Ok(Pubkey::new_from_array(buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic AmmInfo byte fixture with known Pubkeys at the
    /// documented offsets. The remaining bytes are zeroed — sufficient
    /// for layout/offset roundtrip testing without solana-test-validator.
    fn build_synthetic_amm_info(
        coin_vault: &Pubkey,
        pc_vault: &Pubkey,
        coin_vault_mint: &Pubkey,
        pc_vault_mint: &Pubkey,
        lp_mint: &Pubkey,
    ) -> Vec<u8> {
        let mut buf = vec![0u8; AMM_INFO_SIZE];
        buf[offsets::COIN_VAULT..offsets::COIN_VAULT + 32].copy_from_slice(coin_vault.as_ref());
        buf[offsets::PC_VAULT..offsets::PC_VAULT + 32].copy_from_slice(pc_vault.as_ref());
        buf[offsets::COIN_VAULT_MINT..offsets::COIN_VAULT_MINT + 32]
            .copy_from_slice(coin_vault_mint.as_ref());
        buf[offsets::PC_VAULT_MINT..offsets::PC_VAULT_MINT + 32]
            .copy_from_slice(pc_vault_mint.as_ref());
        buf[offsets::LP_MINT..offsets::LP_MINT + 32].copy_from_slice(lp_mint.as_ref());
        buf
    }

    #[test]
    fn amm_info_size_matches_raydium_v4_canonical_752() {
        assert_eq!(AMM_INFO_SIZE, 752);
    }

    #[test]
    fn read_pubkey_extracts_value_at_offset() {
        let key = Pubkey::new_unique();
        let mut data = vec![0u8; 200];
        data[100..132].copy_from_slice(key.as_ref());
        assert_eq!(read_pubkey(&data, 100).unwrap(), key);
    }

    #[test]
    fn read_pubkey_rejects_out_of_bounds_read() {
        let data = vec![0u8; 10];
        assert!(read_pubkey(&data, 5).is_err());
    }

    #[test]
    fn synthetic_fixture_roundtrips_all_five_pubkey_fields() {
        let coin_vault = Pubkey::new_unique();
        let pc_vault = Pubkey::new_unique();
        let coin_vault_mint = Pubkey::new_unique();
        let pc_vault_mint = Pubkey::new_unique();
        let lp_mint = Pubkey::new_unique();
        let buf = build_synthetic_amm_info(
            &coin_vault,
            &pc_vault,
            &coin_vault_mint,
            &pc_vault_mint,
            &lp_mint,
        );

        assert_eq!(buf.len(), AMM_INFO_SIZE);
        assert_eq!(read_pubkey(&buf, offsets::COIN_VAULT).unwrap(), coin_vault);
        assert_eq!(read_pubkey(&buf, offsets::PC_VAULT).unwrap(), pc_vault);
        assert_eq!(
            read_pubkey(&buf, offsets::COIN_VAULT_MINT).unwrap(),
            coin_vault_mint
        );
        assert_eq!(
            read_pubkey(&buf, offsets::PC_VAULT_MINT).unwrap(),
            pc_vault_mint
        );
        assert_eq!(read_pubkey(&buf, offsets::LP_MINT).unwrap(), lp_mint);
    }
}
