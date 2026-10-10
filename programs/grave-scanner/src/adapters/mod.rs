// SPDX-License-Identifier: Apache-2.0
//
// AMM-pool and locker adapters. Each adapter parses a vendor-specific
// account layout into the universal `PoolData` struct consumed by the
// `criteria` evaluator. New AMM support is added by implementing a new
// adapter module here.
//
// Convention since m4 (Raydium V4 layout adapter): each adapter takes
// both the pool account AND the `remaining_accounts` slice. Reserves and
// LP supply for the pool live on separate SPL token accounts (the pool's
// coin_vault, pc_vault, lp_mint) — these MUST be included in
// `remaining_accounts` by the caller. Adapters look them up by Pubkey.
// Adapters whose layout parsing isn't yet implemented continue to revert
// `AmmAdapterUnimplemented`.
//
// Locker adapter (`locker.rs`) follows the same `remaining_accounts`
// convention for UNCX / PinkSale / Team Finance locker container accounts.
//
// Auditor's one-liner: `grep -rn "PRE-MAINNET-TODO" programs/`.

use anchor_lang::prelude::*;

use crate::errors::GraveScannerError;

pub mod locker;
pub mod meteora;
pub mod orca_whirlpool;
pub mod pumpswap;
pub mod raydium_clmm;
pub mod raydium_v4;

// =====================================================================
// Universal pool data shape.
// =====================================================================

/// AMM-agnostic snapshot of a pool's state at the moment of evaluation.
/// Produced by `extract_pool_data` and fed into the `criteria` module.
///
/// C1 inactivity evidence deliberately lives OUTSIDE this struct: no AMM
/// layout GraveScanner supports stores a last-swap timestamp, so the
/// value is taken from the indexer-signed Ed25519 attestation verified in
/// `attestation.rs` (ORACLE-002, spec §5 / D8) — never from pool bytes or
/// instruction params.
#[derive(Clone, Copy, Debug)]
pub struct PoolData {
    /// Base-side reserves (the memecoin / measured token).
    pub base_reserve: u64,
    /// Quote-side reserves (typically lamports of SOL or base units of USDC).
    pub quote_reserve: u64,
    /// Outstanding LP token supply. Used for Criterion 4.
    pub lp_supply: u64,
    /// Mint of the base token.
    pub base_mint: Pubkey,
    /// Mint of the quote token.
    pub quote_mint: Pubkey,
    /// LP mint — needed for the Criterion 5 locker check.
    pub lp_mint: Pubkey,
}

impl PoolData {
    /// Compute the current price as quote-per-base in Q64.64 fixed-point.
    /// Returns `Err(MathOverflow)` on degenerate inputs (zero base reserves).
    pub fn current_price_q64x64(&self) -> Result<u128> {
        require!(self.base_reserve > 0, GraveScannerError::PoolDataParseError);
        let scaled = (self.quote_reserve as u128)
            .checked_shl(64)
            .ok_or(GraveScannerError::MathOverflow)?;
        scaled
            .checked_div(self.base_reserve as u128)
            .ok_or_else(|| GraveScannerError::MathOverflow.into())
    }
}

// =====================================================================
// Top-level dispatch by AMM program ID.
// =====================================================================

/// Parse a pool account into `PoolData` based on its owning program.
///
/// `pool_account_info.owner` is matched against the known AMM program
/// IDs declared in each adapter module. Mismatches return
/// `UnsupportedAmm`; supported AMMs whose parser is not yet implemented
/// return `AmmAdapterUnimplemented`.
///
/// `remaining_accounts` is the full instruction `remaining_accounts`
/// slice. Adapters look up the pool's vault and lp_mint accounts here
/// (via inline iteration — no helper function carries a reference
/// across a call boundary, so no `'info` lifetime parameter is required
/// on this dispatch or its callers).
pub fn extract_pool_data(
    pool_account_info: &AccountInfo,
    expected_pool_address: &Pubkey,
    remaining_accounts: &[AccountInfo],
) -> Result<PoolData> {
    require_keys_eq!(
        *pool_account_info.key,
        *expected_pool_address,
        GraveScannerError::UnsupportedAmm
    );

    let owner = pool_account_info.owner;
    if owner == &raydium_v4::PROGRAM_ID {
        raydium_v4::parse(pool_account_info, remaining_accounts)
    } else if owner == &raydium_clmm::PROGRAM_ID {
        raydium_clmm::parse(pool_account_info, remaining_accounts)
    } else if owner == &orca_whirlpool::PROGRAM_ID {
        orca_whirlpool::parse(pool_account_info, remaining_accounts)
    } else if owner == &pumpswap::PROGRAM_ID {
        pumpswap::parse(pool_account_info, remaining_accounts)
    } else if owner == &meteora::PROGRAM_ID {
        meteora::parse(pool_account_info, remaining_accounts)
    } else {
        err!(GraveScannerError::UnsupportedAmm)
    }
}

// =====================================================================
// Phase 12 adversary tests (host-only) — malicious CPI / AMM-dispatch
// attacks (ADV-CPI-* in docs/ADVERSARY.md): the dispatch must refuse
// every account shape that is not exactly the expected Raydium V4 pool.
// =====================================================================
#[cfg(test)]
mod adversary_tests {
    use super::*;

    /// Test-only `'static` AccountInfo (Box::leak plumbing, mirroring the
    /// locker tests' style).
    fn account_at(key: Pubkey, owner: &Pubkey, data: Vec<u8>) -> AccountInfo<'static> {
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

    /// ADV-CPI-01: the submitted pool account is not the pool named in
    /// the instruction params — the dispatch must refuse before parsing
    /// anything (binding, not content, is the first gate).
    #[test]
    fn adv_cpi01_pool_key_mismatch_refused() {
        let pool = account_at(
            Pubkey::new_unique(),
            &raydium_v4::PROGRAM_ID,
            vec![0u8; 752],
        );
        let other = Pubkey::new_unique();
        let err = extract_pool_data(&pool, &other, &[]).unwrap_err();
        assert_eq!(err, GraveScannerError::UnsupportedAmm.into());
    }

    /// ADV-CPI-02: a pool account owned by an UNKNOWN program (attacker
    /// PDA, random program) is refused — no parse, no partial reads.
    #[test]
    fn adv_cpi02_unknown_amm_owner_refused() {
        let attacker_program = Pubkey::new_unique();
        let pool = account_at(Pubkey::new_unique(), &attacker_program, vec![0u8; 752]);
        let err = extract_pool_data(&pool, pool.key, &[]).unwrap_err();
        assert_eq!(err, GraveScannerError::UnsupportedAmm.into());
    }

    /// ADV-CPI-03: every registered-but-unimplemented AMM stub reverts
    /// the dedicated honest-stub code (6007) — an attacker cannot get
    /// Raydium V4 parsing semantics applied to another AMM's bytes.
    #[test]
    fn adv_cpi03_registered_stubs_refuse_with_6007() {
        let stubs = [
            raydium_clmm::PROGRAM_ID,
            orca_whirlpool::PROGRAM_ID,
            pumpswap::PROGRAM_ID,
            meteora::PROGRAM_ID,
        ];
        for owner in stubs {
            let pool = account_at(Pubkey::new_unique(), &owner, vec![0u8; 300]);
            let err = extract_pool_data(&pool, pool.key, &[]).unwrap_err();
            assert_eq!(
                err,
                GraveScannerError::AmmAdapterUnimplemented.into(),
                "owner {owner} must revert 6007"
            );
        }
    }

    /// ADV-CPI-04: the Raydium V4 adapter itself refuses degenerate
    /// current-price inputs — zero base reserves can never define a
    /// price (fail-closed, 6009), and the u128 scaling of a maximal
    /// quote reserve stays exact.
    #[test]
    fn adv_cpi04_price_math_fails_closed_on_zero_base() {
        let data = PoolData {
            base_reserve: 0,
            quote_reserve: u64::MAX,
            lp_supply: 1,
            base_mint: Pubkey::default(),
            quote_mint: Pubkey::default(),
            lp_mint: Pubkey::default(),
        };
        let err = data.current_price_q64x64().unwrap_err();
        assert_eq!(err, GraveScannerError::PoolDataParseError.into());

        let data = PoolData {
            base_reserve: 1,
            quote_reserve: u64::MAX,
            ..data
        };
        let price = data.current_price_q64x64().unwrap();
        assert_eq!(price, (u64::MAX as u128) << 64);
    }
}
