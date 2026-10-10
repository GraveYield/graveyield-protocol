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
// Raydium V4's AmmInfo does NOT store a last-swap-timestamp field, so
// Criterion 1 inactivity evidence cannot come from pool bytes at all: it
// is carried by the indexer-signed Ed25519 attestation verified in
// `crate::attestation` (ORACLE-002, Phase 1.2 — spec §5 / decision D8).

use anchor_lang::prelude::*;

use super::PoolData;
use crate::errors::GraveScannerError;

/// Mainnet Raydium V4 program ID.
pub const PROGRAM_ID: Pubkey = pubkey!("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

/// SPL Token Program ID — both the vault SPL token accounts and the LP
/// mint are owned by this program. We verify ownership explicitly rather
/// than relying on `anchor_spl::Account<T>::try_from`, which was tripping
/// the BPF compile under Anchor 0.31.x / 0.32.x.
const SPL_TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// Canonical AmmInfo account size on Raydium V4. Pool accounts that
/// don't match this size are rejected as the wrong shape.
pub const AMM_INFO_SIZE: usize = 752;

/// SPL Token Account size (the layout begins with mint + owner + amount).
const TOKEN_ACCOUNT_SIZE: usize = 165;
/// SPL Mint account size.
const MINT_ACCOUNT_SIZE: usize = 82;

/// Byte offsets into AmmInfo for the Pubkey fields we read. Verified
/// against the Raydium open-source AMM source-of-truth and the canonical
/// 752-byte layout: 16 u64 prefix (128) + Fees (64) + StateData (144)
/// + 9 Pubkeys (288) + 8 u64 padding (64) + amm_owner (32) + 2 u64 (16)
/// + 2 u64 padding (16) = 752.
mod offsets {
    // AmmInfo (Raydium V4 pool account).
    pub const COIN_VAULT: usize = 336;
    pub const PC_VAULT: usize = 368;
    pub const COIN_VAULT_MINT: usize = 400;
    pub const PC_VAULT_MINT: usize = 432;
    pub const LP_MINT: usize = 464;

    // SPL Token Account layout. See
    // https://github.com/solana-program/token/blob/main/program/src/state.rs
    pub const TOKEN_ACCOUNT_MINT: usize = 0;
    pub const TOKEN_ACCOUNT_AMOUNT: usize = 64;

    // SPL Mint layout: mint_authority option (4 + 32) precedes supply.
    pub const MINT_SUPPLY: usize = 36;
}

/// Parse a Raydium V4 AMM pool account into `PoolData`.
///
/// Caller must include the pool's `coin_vault`, `pc_vault`, and
/// `lp_mint` accounts in `remaining_accounts` (any order — looked up by
/// Pubkey). Reserves and LP supply are read from those SPL accounts.
///
/// Defense in depth:
///   1. Pool size MUST equal 752 (`AMM_INFO_SIZE`), else PoolDataParseError.
///   2. coin_vault / pc_vault / lp_mint accounts MUST be owned by the SPL
///      Token Program, else PoolDataParseError. (This replaces the implicit
///      owner check that `anchor_spl::Account<T>::try_from` provided.)
///   3. The actual `mint` field inside each vault SPL Token Account MUST
///      equal the AmmInfo's claimed `coin_vault_mint` / `pc_vault_mint`.
///
/// Note: this adapter avoids `anchor_spl::token::{Mint, TokenAccount}`
/// deserialization AND the `find_account_by_key` helper. Everything is
/// inlined inside this function so no cross-function lifetime constraint
/// requires explicit `'info` threading on the calling handler — the
/// `#[program]` macro under Anchor 0.31.x / 0.32.x rejects generic-lifetime
/// instruction handlers at BPF compile time.
pub fn parse(
    pool_account_info: &AccountInfo,
    remaining_accounts: &[AccountInfo],
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

    // Inline account lookup — no helper function = no return-by-reference
    // = no lifetime parameter to thread through the call stack.
    let find = |key: &Pubkey| -> Result<&AccountInfo<'_>> {
        remaining_accounts
            .iter()
            .find(|i| i.key == key)
            .ok_or_else(|| GraveScannerError::PoolDataParseError.into())
    };
    let coin_vault_info = find(&coin_vault)?;
    let pc_vault_info = find(&pc_vault)?;
    let lp_mint_info = find(&lp_mint)?;

    // Explicit owner-validation.
    require_keys_eq!(
        *coin_vault_info.owner,
        SPL_TOKEN_PROGRAM_ID,
        GraveScannerError::PoolDataParseError
    );
    require_keys_eq!(
        *pc_vault_info.owner,
        SPL_TOKEN_PROGRAM_ID,
        GraveScannerError::PoolDataParseError
    );
    require_keys_eq!(
        *lp_mint_info.owner,
        SPL_TOKEN_PROGRAM_ID,
        GraveScannerError::PoolDataParseError
    );

    // Inline SPL account-data reads — each borrow is scoped to its block,
    // never crosses a function boundary.
    let (coin_actual_mint, coin_amount) = {
        let data = coin_vault_info
            .try_borrow_data()
            .map_err(|_| GraveScannerError::PoolDataParseError)?;
        require!(
            data.len() >= TOKEN_ACCOUNT_SIZE,
            GraveScannerError::PoolDataParseError
        );
        (
            read_pubkey(&data, offsets::TOKEN_ACCOUNT_MINT)?,
            read_u64_le(&data, offsets::TOKEN_ACCOUNT_AMOUNT)?,
        )
    };
    let (pc_actual_mint, pc_amount) = {
        let data = pc_vault_info
            .try_borrow_data()
            .map_err(|_| GraveScannerError::PoolDataParseError)?;
        require!(
            data.len() >= TOKEN_ACCOUNT_SIZE,
            GraveScannerError::PoolDataParseError
        );
        (
            read_pubkey(&data, offsets::TOKEN_ACCOUNT_MINT)?,
            read_u64_le(&data, offsets::TOKEN_ACCOUNT_AMOUNT)?,
        )
    };
    let lp_supply = {
        let data = lp_mint_info
            .try_borrow_data()
            .map_err(|_| GraveScannerError::PoolDataParseError)?;
        require!(
            data.len() >= MINT_ACCOUNT_SIZE,
            GraveScannerError::PoolDataParseError
        );
        read_u64_le(&data, offsets::MINT_SUPPLY)?
    };

    require_keys_eq!(
        coin_actual_mint,
        coin_vault_mint,
        GraveScannerError::PoolDataParseError
    );
    require_keys_eq!(
        pc_actual_mint,
        pc_vault_mint,
        GraveScannerError::PoolDataParseError
    );

    Ok(PoolData {
        base_reserve: coin_amount,
        quote_reserve: pc_amount,
        lp_supply,
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

fn read_u64_le(data: &[u8], offset: usize) -> Result<u64> {
    require!(
        data.len() >= offset + 8,
        GraveScannerError::PoolDataParseError
    );
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[offset..offset + 8]);
    Ok(u64::from_le_bytes(buf))
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

// =====================================================================
// Phase 12 adversary tests (host-only) — malicious LP/vault account
// shapes against the Raydium V4 parser (ADV-LP-* in docs/ADVERSARY.md).
// The parser is the trust boundary between arbitrary chain bytes and
// the eligibility evaluator: every malformed shape must revert 6009
// before any number reaches the criteria.
// =====================================================================
#[cfg(test)]
mod adversary_tests {
    use super::*;

    fn synth_pool(
        coin_vault: &Pubkey,
        pc_vault: &Pubkey,
        coin_mint: &Pubkey,
        pc_mint: &Pubkey,
        lp_mint: &Pubkey,
    ) -> Vec<u8> {
        let mut buf = vec![0u8; AMM_INFO_SIZE];
        buf[offsets::COIN_VAULT..offsets::COIN_VAULT + 32].copy_from_slice(coin_vault.as_ref());
        buf[offsets::PC_VAULT..offsets::PC_VAULT + 32].copy_from_slice(pc_vault.as_ref());
        buf[offsets::COIN_VAULT_MINT..offsets::COIN_VAULT_MINT + 32]
            .copy_from_slice(coin_mint.as_ref());
        buf[offsets::PC_VAULT_MINT..offsets::PC_VAULT_MINT + 32].copy_from_slice(pc_mint.as_ref());
        buf[offsets::LP_MINT..offsets::LP_MINT + 32].copy_from_slice(lp_mint.as_ref());
        buf
    }

    fn token_account(mint: &Pubkey, amount: u64) -> Vec<u8> {
        let mut buf = vec![0u8; TOKEN_ACCOUNT_SIZE];
        buf[0..32].copy_from_slice(mint.as_ref());
        buf[offsets::TOKEN_ACCOUNT_AMOUNT..offsets::TOKEN_ACCOUNT_AMOUNT + 8]
            .copy_from_slice(&amount.to_le_bytes());
        buf
    }

    fn mint_account(supply: u64) -> Vec<u8> {
        let mut buf = vec![0u8; MINT_ACCOUNT_SIZE];
        buf[offsets::MINT_SUPPLY..offsets::MINT_SUPPLY + 8].copy_from_slice(&supply.to_le_bytes());
        buf
    }

    /// Leak-backed AccountInfo (test-only 'static plumbing).
    fn info(key: Pubkey, owner: &Pubkey, data: Vec<u8>) -> AccountInfo<'static> {
        let data = Box::leak(data.into_boxed_slice());
        let key = Box::leak(Box::new(key));
        let owner = Box::leak(Box::new(*owner));
        let lamports = Box::leak(Box::new(1_000_000u64));
        AccountInfo {
            key,
            lamports: std::rc::Rc::new(std::cell::RefCell::new(lamports as &mut u64)),
            data: std::rc::Rc::new(std::cell::RefCell::new(&mut data[..])),
            owner,
            rent_epoch: 0,
            is_signer: false,
            is_writable: false,
            executable: false,
        }
    }

    /// A fully honest fixture — proves the negatives below are the
    /// parser refusing MALICE, not a broken fixture.
    #[test]
    fn adv_lp00_honest_fixture_parses() {
        let coin_vault = Pubkey::new_unique();
        let pc_vault = Pubkey::new_unique();
        let coin_mint = Pubkey::new_unique();
        let pc_mint = Pubkey::new_unique();
        let lp_mint = Pubkey::new_unique();
        let pool = info(
            Pubkey::new_unique(),
            &PROGRAM_ID,
            synth_pool(&coin_vault, &pc_vault, &coin_mint, &pc_mint, &lp_mint),
        );
        let remaining = [
            info(
                coin_vault,
                &SPL_TOKEN_PROGRAM_ID,
                token_account(&coin_mint, 1_000),
            ),
            info(
                pc_vault,
                &SPL_TOKEN_PROGRAM_ID,
                token_account(&pc_mint, 2_000),
            ),
            info(lp_mint, &SPL_TOKEN_PROGRAM_ID, mint_account(10_000)),
        ];
        let parsed = parse(&pool, &remaining).unwrap();
        assert_eq!(parsed.base_reserve, 1_000);
        assert_eq!(parsed.quote_reserve, 2_000);
        assert_eq!(parsed.lp_supply, 10_000);
    }

    /// ADV-LP-01: a required vault/mint account missing from
    /// remaining_accounts is refused — the parser never invents state.
    #[test]
    fn adv_lp01_missing_remaining_accounts_refused() {
        let coin_vault = Pubkey::new_unique();
        let pc_vault = Pubkey::new_unique();
        let coin_mint = Pubkey::new_unique();
        let pc_mint = Pubkey::new_unique();
        let lp_mint = Pubkey::new_unique();
        let pool = info(
            Pubkey::new_unique(),
            &PROGRAM_ID,
            synth_pool(&coin_vault, &pc_vault, &coin_mint, &pc_mint, &lp_mint),
        );
        let err = parse(&pool, &[]).unwrap_err();
        assert_eq!(err, GraveScannerError::PoolDataParseError.into());
    }

    /// ADV-LP-02: a vault account NOT owned by the SPL Token program
    /// (attacker-owned lookalike) is refused before any read.
    #[test]
    fn adv_lp02_foreign_vault_owner_refused() {
        let coin_vault = Pubkey::new_unique();
        let pc_vault = Pubkey::new_unique();
        let coin_mint = Pubkey::new_unique();
        let pc_mint = Pubkey::new_unique();
        let lp_mint = Pubkey::new_unique();
        let pool = info(
            Pubkey::new_unique(),
            &PROGRAM_ID,
            synth_pool(&coin_vault, &pc_vault, &coin_mint, &pc_mint, &lp_mint),
        );
        let attacker_program = Pubkey::new_unique();
        let remaining = [
            info(
                coin_vault,
                &attacker_program,
                token_account(&coin_mint, 1_000),
            ),
            info(
                pc_vault,
                &SPL_TOKEN_PROGRAM_ID,
                token_account(&pc_mint, 2_000),
            ),
            info(lp_mint, &SPL_TOKEN_PROGRAM_ID, mint_account(10_000)),
        ];
        let err = parse(&pool, &remaining).unwrap_err();
        assert_eq!(err, GraveScannerError::PoolDataParseError.into());
    }

    /// ADV-LP-03: the mint embedded INSIDE the vault token account must
    /// equal the mint the pool account claims — a swapped/forged vault
    /// cannot re-label the pool's base or quote token.
    #[test]
    fn adv_lp03_vault_mint_crosscheck_refused() {
        let coin_vault = Pubkey::new_unique();
        let pc_vault = Pubkey::new_unique();
        let coin_mint = Pubkey::new_unique();
        let pc_mint = Pubkey::new_unique();
        let lp_mint = Pubkey::new_unique();
        let pool = info(
            Pubkey::new_unique(),
            &PROGRAM_ID,
            synth_pool(&coin_vault, &pc_vault, &coin_mint, &pc_mint, &lp_mint),
        );
        let forged_mint = Pubkey::new_unique();
        let remaining = [
            // Vault claims to hold coin_mint, but its embedded mint is
            // an attacker mint — the reserves it reports are not the
            // pool's reserves.
            info(
                coin_vault,
                &SPL_TOKEN_PROGRAM_ID,
                token_account(&forged_mint, 1_000),
            ),
            info(
                pc_vault,
                &SPL_TOKEN_PROGRAM_ID,
                token_account(&pc_mint, 2_000),
            ),
            info(lp_mint, &SPL_TOKEN_PROGRAM_ID, mint_account(10_000)),
        ];
        let err = parse(&pool, &remaining).unwrap_err();
        assert_eq!(err, GraveScannerError::PoolDataParseError.into());
    }

    /// ADV-LP-04: the LP mint owned by the wrong program is refused —
    /// supply cannot be read from attacker bytes.
    #[test]
    fn adv_lp04_foreign_lp_mint_owner_refused() {
        let coin_vault = Pubkey::new_unique();
        let pc_vault = Pubkey::new_unique();
        let coin_mint = Pubkey::new_unique();
        let pc_mint = Pubkey::new_unique();
        let lp_mint = Pubkey::new_unique();
        let pool = info(
            Pubkey::new_unique(),
            &PROGRAM_ID,
            synth_pool(&coin_vault, &pc_vault, &coin_mint, &pc_mint, &lp_mint),
        );
        let attacker_program = Pubkey::new_unique();
        let remaining = [
            info(
                coin_vault,
                &SPL_TOKEN_PROGRAM_ID,
                token_account(&coin_mint, 1_000),
            ),
            info(
                pc_vault,
                &SPL_TOKEN_PROGRAM_ID,
                token_account(&pc_mint, 2_000),
            ),
            info(lp_mint, &attacker_program, mint_account(10_000)),
        ];
        let err = parse(&pool, &remaining).unwrap_err();
        assert_eq!(err, GraveScannerError::PoolDataParseError.into());
    }

    /// ADV-LP-05: wrong pool size (751 bytes) is refused — the layout
    /// contract is exact, not "at least".
    #[test]
    fn adv_lp05_wrong_pool_size_refused() {
        let short = info(Pubkey::new_unique(), &PROGRAM_ID, vec![0u8; 751]);
        let err = parse(&short, &[]).unwrap_err();
        assert_eq!(err, GraveScannerError::PoolDataParseError.into());
    }
}
