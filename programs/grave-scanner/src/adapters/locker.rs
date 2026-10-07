// SPDX-License-Identifier: Apache-2.0
//
// Locker introspection adapter — Criterion 5 ("no LP tokens locked").
//
// v1.0 production support: UNCX Network Raydium AMM V4 LP locker
// (program `GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo`, official
// source: github.com/uncx-network/raydium-amm-lp-locker). Additional
// lockers (PinkSale, Team Finance, …) are added as separate modules and
// dispatched from `locked_lp_amount` below — never as extra args of the
// same parser.
//
// Evidence model (LOCKER-001 resolution):
//
//   1. The caller MUST always supply the UNCX per-pool marker PDA
//      `["global_lp_tracker", amm_id]`. The marker is created
//      `init_if_needed` on the pool's first lock and never deleted, so:
//        - marker account absent on chain  => no lock was EVER created
//          for this pool by this locker program => locked amount 0,
//          proven without enumeration.
//        - marker account present on chain => at least one TokenLock
//          exists and the caller MUST supply it (or them) as evidence.
//   2. TokenLock PDAs are `["uncx_locker", lock_global_id.to_le_bytes()]`
//      — sequential global ids, NOT derivable from the LP mint alone.
//      The locked set for a mint is therefore determined off-chain by
//      `getProgramAccounts` enumeration (discriminator filter +
//      memcmp on `lp_mint` @41) and supplied via `remaining_accounts`.
//      On-chain, EVERY supplied TokenLock is strictly validated
//      (ownership, discriminator, size, PDA re-derivation from its own
//      id, (pool, mint) binding) and its live amount summed — so the
//      on-chain layer is sound even though completeness of the supplied
//      set is SDK/operator-enforced (see PROTOCOL_SPEC.md §6).
//   3. A silently opt-out-able slice is forbidden: omitting the marker
//      reverts `LockerMarkerAccountRequired`; a present marker with no
//      TokenLock evidence reverts `LockerLockEvidenceRequired`.
//
// Layouts below were verified against live mainnet accounts (125 locks,
// 74 pools): per-mint custody balance == Σ current_locked_amount for
// 74/74 mints. See the `#[cfg(test)]` vectors, which pin real mainnet
// PDA derivations and the Anchor discriminators.
//
// Compute note: each supplied TokenLock costs one
// `find_program_address` re-derivation (usually 1-2 sha256 rounds —
// observed mainnet bumps are 255/254). Pools with many locks need a
// raised compute-budget instruction in the SDK transaction builder.

use anchor_lang::prelude::*;

use crate::errors::GraveScannerError;

/// Sum LP tokens currently locked across all supported lockers for the
/// supplied LP mint of the supplied Raydium V4 pool.
///
/// `pool_address` is the AmmInfo account the evaluation targets; it is
/// required because UNCX binds every TokenLock to `(amm_id, lp_mint)`
/// and because the marker PDA is derived from the pool address.
pub fn locked_lp_amount(
    lp_mint: &Pubkey,
    pool_address: &Pubkey,
    remaining_accounts: &[AccountInfo],
) -> Result<u64> {
    // v1.0: one production locker. Later lockers append their own
    // marker requirement + validation pass here and sum into the total.
    uncx_v4::locked_lp_amount(lp_mint, pool_address, remaining_accounts)
}

// =====================================================================
// UNCX Raydium AMM V4 locker adapter.
// =====================================================================

pub mod uncx_v4 {
    use super::*;

    /// Mainnet UNCX Raydium AMM V4 LP locker program (official repo:
    /// uncx-network/raydium-amm-lp-locker, `declare_id!` matches).
    pub const PROGRAM_ID: Pubkey = pubkey!("GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo");

    /// Anchor discriminator of the `TokenLock` account:
    /// sha256("account:TokenLock")[..8] = 49e490f19a2c5dee.
    pub const TOKEN_LOCK_DISC: [u8; 8] = [0x49, 0xe4, 0x90, 0xf1, 0x9a, 0x2c, 0x5d, 0xee];
    /// Anchor discriminator of the `GlobalLpMintMarker` account:
    /// sha256("account:GlobalLpMintMarker")[..8] = c2d588e24a7e7bb2.
    pub const MARKER_DISC: [u8; 8] = [0xc2, 0xd5, 0x88, 0xe2, 0x4a, 0x7e, 0x7b, 0xb2];

    /// PDA seed prefixes (from the official source: `accounts_ix/lock_lp.rs`).
    pub const TOKEN_LOCK_SEED: &[u8] = b"uncx_locker";
    pub const MARKER_SEED: &[u8] = b"global_lp_tracker";

    /// TokenLock: 8 disc + bump(1) + amm_id(32) + lp_mint(32)
    ///            + lock_global_id(8) + lock_date(8) + unlock_date(8)
    ///            + country_code(1) + initial_lock_amount(8)
    ///            + current_locked_amount(8) + lock_owner(32) = 146.
    pub const TOKEN_LOCK_SIZE: usize = 146;
    /// GlobalLpMintMarker: 8 disc + bump(1) = 9.
    pub const MARKER_SIZE: usize = 9;

    // Byte offsets into TokenLock.
    mod offsets {
        pub const AMM_ID: usize = 9;
        pub const LP_MINT: usize = 41;
        pub const LOCK_GLOBAL_ID: usize = 73;
        pub const CURRENT_LOCKED_AMOUNT: usize = 106;
    }

    /// Derive the expected TokenLock PDA for a global lock id.
    pub fn token_lock_address(lock_global_id: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[TOKEN_LOCK_SEED, &lock_global_id.to_le_bytes()],
            &PROGRAM_ID,
        )
        .0
    }

    /// Derive the expected per-pool lock marker PDA.
    pub fn marker_address(amm_id: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[MARKER_SEED, amm_id.as_ref()], &PROGRAM_ID).0
    }

    pub fn locked_lp_amount(
        lp_mint: &Pubkey,
        pool_address: &Pubkey,
        remaining_accounts: &[AccountInfo],
    ) -> Result<u64> {
        let expected_marker = marker_address(pool_address);
        // True once the supplied marker account is a real, program-owned
        // account (i.e. the pool was locked at least once).
        let mut marker_present_on_chain = false;
        let mut marker_supplied = false;
        let mut locks_seen: u32 = 0;
        let mut total_locked: u64 = 0;

        for account in remaining_accounts {
            // Non-existent accounts come in with no owner data and zero
            // lamports. Supplying them is allowed for deterministically
            // derived addresses (the SDK derives-before-it-checks); they
            // carry no evidence.
            if account.data_len() == 0 && account.lamports() == 0 {
                if *account.key == expected_marker {
                    marker_supplied = true;
                }
                continue;
            }
            if account.owner != &PROGRAM_ID {
                continue; // not a locker account (AMM accounts, vaults, …)
            }

            let data = account
                .data
                .try_borrow()
                .map_err(|_| GraveScannerError::InvalidLockerAccount)?;

            if *account.key == expected_marker {
                // Marker: exactly discriminator + bump, nothing else.
                require!(
                    data.len() == MARKER_SIZE,
                    GraveScannerError::InvalidLockerAccount
                );
                require!(
                    data[..8] == MARKER_DISC[..],
                    GraveScannerError::InvalidLockerAccount
                );
                marker_supplied = true;
                marker_present_on_chain = true;
                continue;
            }

            // Anything else owned by the locker program must be a
            // TokenLock bound to THIS pool and THIS LP mint.
            require!(
                data.len() == TOKEN_LOCK_SIZE,
                GraveScannerError::InvalidLockerAccount
            );
            require!(
                data[..8] == TOKEN_LOCK_DISC[..],
                GraveScannerError::InvalidLockerAccount
            );

            // Anti-forgery pin: the account key must be the canonical
            // PDA for the lock id it declares.
            let lock_global_id = u64::from_le_bytes(
                data[offsets::LOCK_GLOBAL_ID..offsets::LOCK_GLOBAL_ID + 8]
                    .try_into()
                    .map_err(|_| GraveScannerError::InvalidLockerAccount)?,
            );
            require!(
                *account.key == token_lock_address(lock_global_id),
                GraveScannerError::InvalidLockerAccount
            );

            // (pool, mint) binding.
            require!(
                data[offsets::AMM_ID..offsets::AMM_ID + 32] == pool_address.as_ref()[..],
                GraveScannerError::LockerAccountMismatch
            );
            require!(
                data[offsets::LP_MINT..offsets::LP_MINT + 32] == lp_mint.as_ref()[..],
                GraveScannerError::LockerAccountMismatch
            );

            let current_locked = u64::from_le_bytes(
                data[offsets::CURRENT_LOCKED_AMOUNT..offsets::CURRENT_LOCKED_AMOUNT + 8]
                    .try_into()
                    .map_err(|_| GraveScannerError::InvalidLockerAccount)?,
            );
            total_locked = total_locked
                .checked_add(current_locked)
                .ok_or(GraveScannerError::MathOverflow)?;
            locks_seen = locks_seen
                .checked_add(1)
                .ok_or(GraveScannerError::MathOverflow)?;
        }

        require!(
            marker_supplied,
            GraveScannerError::LockerMarkerAccountRequired
        );

        if marker_present_on_chain {
            // A present marker implies at least one TokenLock exists on
            // chain for this pool. Zero supplied evidence means the
            // enumeration was skipped — refuse rather than certify.
            require!(
                locks_seen > 0,
                GraveScannerError::LockerLockEvidenceRequired
            );
        } else {
            // Marker never created => no lock ever created for this
            // pool by this program. Any supplied TokenLock claiming
            // this (pool, mint) would contradict the locker program's
            // own invariants — fail closed.
            require!(locks_seen == 0, GraveScannerError::InvalidLockerAccount);
        }

        Ok(total_locked)
    }

    // =================================================================
    // Unit tests. Host-side only: they build synthetic AccountInfo
    // buffers byte-for-byte and pin real mainnet PDA derivations.
    // =================================================================

    #[cfg(test)]
    mod tests {
        use super::*;
        use solana_sha256_hasher::hashv;

        // ---- real mainnet vectors (verified 2026-10 against mainnet) ----

        /// UNCX TokenLock #114 on mainnet.
        const MAINNET_LOCK_ID: u64 = 114;
        const MAINNET_LOCK_KEY: &str = "UUn9vAq45fNqCyU9sdUcXPjQWetd6eC6CEwsnFBFTim";
        const MAINNET_AMM: &str = "7sF2Drsnq3XGdUGDaRF1hKox59hfp5w98UGoqjgqtCsu";
        const MAINNET_LP_MINT: &str = "66HgdKb9swcu7o8acpuk9m64Q9EDwUY8ivb7TVt9CBFb";
        const MAINNET_LOCK_CURRENT: u64 = 419;
        const MAINNET_LOCK_INITIAL: u64 = 2_360_835_469_419;
        const MAINNET_LOCK_DATE: i64 = 1_747_133_716;
        const MAINNET_UNLOCK_DATE: i64 = 1_778_669_685;
        const MAINNET_LOCK_OWNER: &str = "GaW1AH9XntATuiME3wCjHbrDqqAD4c24XTKZj9aDjATy";
        /// The per-pool marker PDA for MAINNET_AMM, observed on mainnet.
        const MAINNET_MARKER: &str = "FeckXtFruWKBS8bPJCAE7JQzUq8hvo44E4qHPaLXpTpG";
        /// Raydium AMM V4 program id (for foreign-owner test accounts).
        const RAYDIUM_V4: &str = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

        fn pk(s: &str) -> Pubkey {
            s.parse().unwrap()
        }

        /// Test account that OWNS its key/owner/data so the returned
        /// `AccountInfo` borrows stay valid for the whole test. The
        /// `&mut`-based `info()` matches the solana-account-info 2.x
        /// constructor, which wraps the slices in `RefCell`s internally.
        struct TestAccount {
            key: Pubkey,
            owner: Pubkey,
            data: Vec<u8>,
            lamports: u64,
        }

        impl TestAccount {
            /// A real, program-owned locker account (marker or TokenLock).
            fn locker(key: Pubkey, data: Vec<u8>) -> Self {
                Self::new(key, PROGRAM_ID, data, 1_000_000)
            }

            /// An account owned by the locker program with arbitrary junk.
            fn locker_junk(data: Vec<u8>) -> Self {
                Self::new(Pubkey::new_unique(), PROGRAM_ID, data, 1_000_000)
            }

            /// A nonexistent (empty, unfunded) account — the on-chain
            /// shape of a derived-but-never-created PDA.
            fn nonexistent(key: Pubkey) -> Self {
                Self::new(
                    key,
                    anchor_lang::solana_program::system_program::ID,
                    Vec::new(),
                    0,
                )
            }

            /// An account owned by a program other than the locker.
            fn foreign(key: Pubkey, owner: Pubkey, data: Vec<u8>, lamports: u64) -> Self {
                Self::new(key, owner, data, lamports)
            }

            fn new(key: Pubkey, owner: Pubkey, data: Vec<u8>, lamports: u64) -> Self {
                Self {
                    key,
                    owner,
                    data,
                    lamports,
                }
            }

            fn info(&mut self) -> AccountInfo<'_> {
                AccountInfo::new(
                    &self.key,
                    false,
                    true,
                    &mut self.lamports,
                    &mut self.data[..],
                    &self.owner,
                    false,
                    0,
                )
            }
        }

        /// Byte-exact TokenLock buffer (layout per the official UNCX source).
        #[allow(clippy::too_many_arguments)]
        fn build_token_lock(
            lock_global_id: u64,
            amm_id: &Pubkey,
            lp_mint: &Pubkey,
            initial: u64,
            current: u64,
            lock_date: i64,
            unlock_date: i64,
            owner: &Pubkey,
        ) -> Vec<u8> {
            let mut b = Vec::with_capacity(TOKEN_LOCK_SIZE);
            b.extend_from_slice(&TOKEN_LOCK_DISC); // 0..8
            b.push(255u8); // bump
            b.extend_from_slice(amm_id.as_ref()); // 9..41
            b.extend_from_slice(lp_mint.as_ref()); // 41..73
            b.extend_from_slice(&lock_global_id.to_le_bytes()); // 73..81
            b.extend_from_slice(&lock_date.to_le_bytes()); // 81..89
            b.extend_from_slice(&unlock_date.to_le_bytes()); // 89..97
            b.push(1u8); // country_code
            b.extend_from_slice(&initial.to_le_bytes()); // 98..106
            b.extend_from_slice(&current.to_le_bytes()); // 106..114
            b.extend_from_slice(owner.as_ref()); // 114..146
            assert_eq!(b.len(), TOKEN_LOCK_SIZE);
            b
        }

        fn build_marker() -> Vec<u8> {
            let mut b = Vec::with_capacity(MARKER_SIZE);
            b.extend_from_slice(&MARKER_DISC);
            b.push(255u8); // bump
            b
        }

        fn assert_err(err: anchor_lang::error::Error, expected: GraveScannerError) {
            match err {
                anchor_lang::error::Error::AnchorError(e) => {
                    let expected_code: u32 = expected.into();
                    assert_eq!(
                        e.error_code_number, expected_code,
                        "got error {} ({}), expected {}",
                        e.error_code_number, e.error_name, expected_code
                    );
                }
                other => panic!("expected AnchorError, got {other:?}"),
            }
        }

        // ---- crypto pins ----

        #[test]
        fn anchor_discriminators_match_anchor_spec() {
            let lock = hashv(&[b"account:TokenLock"]).to_bytes();
            let marker = hashv(&[b"account:GlobalLpMintMarker"]).to_bytes();
            assert_eq!(&lock[..8], &TOKEN_LOCK_DISC[..]);
            assert_eq!(&marker[..8], &MARKER_DISC[..]);
        }

        #[test]
        fn mainnet_vector_token_lock_pda_derivation() {
            assert_eq!(
                token_lock_address(MAINNET_LOCK_ID).to_string(),
                MAINNET_LOCK_KEY
            );
        }

        #[test]
        fn mainnet_vector_marker_pda_derivation() {
            assert_eq!(marker_address(&pk(MAINNET_AMM)).to_string(), MAINNET_MARKER);
        }

        // ---- happy paths ----

        #[test]
        fn unlocked_pool_with_no_marker_ever_returns_zero() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            // SDK supplies the derived marker even though it does not
            // exist on chain (empty, unfunded).
            let mut marker = TestAccount::nonexistent(marker_address(&amm));
            let total = locked_lp_amount(&mint, &amm, &[marker.info()]).unwrap();
            assert_eq!(total, 0);
        }

        #[test]
        fn mainnet_vector_single_live_lock_returns_current_amount() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut lock = TestAccount::locker(
                token_lock_address(MAINNET_LOCK_ID),
                build_token_lock(
                    MAINNET_LOCK_ID,
                    &amm,
                    &mint,
                    MAINNET_LOCK_INITIAL,
                    MAINNET_LOCK_CURRENT,
                    MAINNET_LOCK_DATE,
                    MAINNET_UNLOCK_DATE,
                    &pk(MAINNET_LOCK_OWNER),
                ),
            );
            let total = locked_lp_amount(&mint, &amm, &[marker.info(), lock.info()]).unwrap();
            assert_eq!(total, MAINNET_LOCK_CURRENT);
        }

        #[test]
        fn multiple_locks_are_summed() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut lock_a = TestAccount::locker(
                token_lock_address(114),
                build_token_lock(114, &amm, &mint, 100, 40, 0, 0, &Pubkey::default()),
            );
            let mut lock_b = TestAccount::locker(
                token_lock_address(115),
                build_token_lock(115, &amm, &mint, 500, 60, 0, 0, &Pubkey::default()),
            );
            let total =
                locked_lp_amount(&mint, &amm, &[marker.info(), lock_a.info(), lock_b.info()])
                    .unwrap();
            assert_eq!(total, 100);
        }

        #[test]
        fn fully_withdrawn_lock_contributes_zero() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut lock = TestAccount::locker(
                token_lock_address(30),
                build_token_lock(30, &amm, &mint, 100, 0, 0, 0, &Pubkey::default()),
            );
            // Lock still exists on chain (amount zeroed by withdraw_lp):
            // evidence is present, C5 passes with 0.
            let total = locked_lp_amount(&mint, &amm, &[marker.info(), lock.info()]).unwrap();
            assert_eq!(total, 0);
        }

        #[test]
        fn non_locker_accounts_are_ignored() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut lock = TestAccount::locker(
                token_lock_address(114),
                build_token_lock(114, &amm, &mint, 100, 42, 0, 0, &Pubkey::default()),
            );
            let mut amm_pool = TestAccount::foreign(amm, pk(RAYDIUM_V4), vec![0u8; 752], 1);
            let mut vault = TestAccount::foreign(
                Pubkey::new_unique(),
                anchor_lang::solana_program::system_program::ID,
                Vec::new(),
                5,
            );
            let total = locked_lp_amount(
                &mint,
                &amm,
                &[amm_pool.info(), vault.info(), marker.info(), lock.info()],
            )
            .unwrap();
            assert_eq!(total, 42);
        }

        #[test]
        fn empty_nonexistent_lock_accounts_are_skipped() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut lock = TestAccount::locker(
                token_lock_address(114),
                build_token_lock(114, &amm, &mint, 100, 7, 0, 0, &Pubkey::default()),
            );
            // SDK derives a candidate id that does not exist on chain.
            let mut ghost = TestAccount::nonexistent(token_lock_address(9_999_999));
            let total =
                locked_lp_amount(&mint, &amm, &[marker.info(), ghost.info(), lock.info()]).unwrap();
            assert_eq!(total, 7);
        }

        // ---- negative paths (fail closed) ----

        #[test]
        fn missing_marker_account_reverts() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let err = locked_lp_amount(&mint, &amm, &[]).unwrap_err();
            assert_err(err, GraveScannerError::LockerMarkerAccountRequired);
        }

        #[test]
        fn marker_without_lock_evidence_reverts() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let err = locked_lp_amount(&mint, &amm, &[marker.info()]).unwrap_err();
            assert_err(err, GraveScannerError::LockerLockEvidenceRequired);
        }

        #[test]
        fn token_lock_bound_to_other_pool_reverts() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let other_pool = Pubkey::new_unique();
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut lock = TestAccount::locker(
                token_lock_address(114),
                build_token_lock(114, &other_pool, &mint, 100, 5, 0, 0, &Pubkey::default()),
            );
            let err = locked_lp_amount(&mint, &amm, &[marker.info(), lock.info()]).unwrap_err();
            assert_err(err, GraveScannerError::LockerAccountMismatch);
        }

        #[test]
        fn token_lock_bound_to_other_mint_reverts() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut lock = TestAccount::locker(
                token_lock_address(114),
                build_token_lock(
                    114,
                    &amm,
                    &Pubkey::new_unique(),
                    100,
                    5,
                    0,
                    0,
                    &Pubkey::default(),
                ),
            );
            let err = locked_lp_amount(&mint, &amm, &[marker.info(), lock.info()]).unwrap_err();
            assert_err(err, GraveScannerError::LockerAccountMismatch);
        }

        #[test]
        fn forged_lock_id_reverts() {
            // Buffer claims id 114 but is supplied under a different key.
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut lock = TestAccount::locker(
                Pubkey::new_unique(),
                build_token_lock(114, &amm, &mint, 100, 5, 0, 0, &Pubkey::default()),
            );
            let err = locked_lp_amount(&mint, &amm, &[marker.info(), lock.info()]).unwrap_err();
            assert_err(err, GraveScannerError::InvalidLockerAccount);
        }

        #[test]
        fn wrong_discriminator_reverts() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut bad = build_token_lock(114, &amm, &mint, 100, 5, 0, 0, &Pubkey::default());
            bad[0] ^= 0xff;
            let mut lock = TestAccount::locker(token_lock_address(114), bad);
            let err = locked_lp_amount(&mint, &amm, &[marker.info(), lock.info()]).unwrap_err();
            assert_err(err, GraveScannerError::InvalidLockerAccount);
        }

        #[test]
        fn wrong_account_size_reverts() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut bad = build_token_lock(114, &amm, &mint, 100, 5, 0, 0, &Pubkey::default());
            bad.truncate(145);
            let mut lock = TestAccount::locker(token_lock_address(114), bad);
            let err = locked_lp_amount(&mint, &amm, &[marker.info(), lock.info()]).unwrap_err();
            assert_err(err, GraveScannerError::InvalidLockerAccount);
        }

        #[test]
        fn malformed_marker_reverts() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut bad_marker = build_marker();
            bad_marker.push(0u8); // 10 bytes — not the 9-byte marker shape
            let mut marker = TestAccount::locker(marker_address(&amm), bad_marker);
            let err = locked_lp_amount(&mint, &amm, &[marker.info()]).unwrap_err();
            assert_err(err, GraveScannerError::InvalidLockerAccount);
        }

        #[test]
        fn locker_owned_unknown_account_reverts() {
            // UNCX-owned account that is neither the marker nor a
            // TokenLock for this pool (e.g. a UserInfoAccount) must be
            // rejected, not skipped.
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut junk = TestAccount::locker_junk(vec![1u8; 81]); // UserInfoAccount shape
            let err = locked_lp_amount(&mint, &amm, &[marker.info(), junk.info()]).unwrap_err();
            assert_err(err, GraveScannerError::InvalidLockerAccount);
        }

        #[test]
        fn contradictory_evidence_empty_marker_with_lock_reverts() {
            // A TokenLock cannot exist for a pool whose marker was never
            // created; supplying both is contradictory evidence.
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::nonexistent(marker_address(&amm));
            let mut lock = TestAccount::locker(
                token_lock_address(114),
                build_token_lock(114, &amm, &mint, 100, 5, 0, 0, &Pubkey::default()),
            );
            let err = locked_lp_amount(&mint, &amm, &[marker.info(), lock.info()]).unwrap_err();
            assert_err(err, GraveScannerError::InvalidLockerAccount);
        }

        #[test]
        fn lock_amount_overflow_reverts() {
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut marker = TestAccount::locker(marker_address(&amm), build_marker());
            let mut lock_a = TestAccount::locker(
                token_lock_address(114),
                build_token_lock(
                    114,
                    &amm,
                    &mint,
                    u64::MAX,
                    u64::MAX - 1,
                    0,
                    0,
                    &Pubkey::default(),
                ),
            );
            let mut lock_b = TestAccount::locker(
                token_lock_address(115),
                build_token_lock(115, &amm, &mint, u64::MAX, 10, 0, 0, &Pubkey::default()),
            );
            let err = locked_lp_amount(&mint, &amm, &[marker.info(), lock_a.info(), lock_b.info()])
                .unwrap_err();
            assert_err(err, GraveScannerError::MathOverflow);
        }

        #[test]
        fn ghost_marker_key_mismatch_is_ignored_then_required_fires() {
            // An empty account at a NON-marker key is simply not the
            // marker; the requirement check must still fire.
            let amm = pk(MAINNET_AMM);
            let mint = pk(MAINNET_LP_MINT);
            let mut not_marker = TestAccount::nonexistent(Pubkey::new_unique());
            let err = locked_lp_amount(&mint, &amm, &[not_marker.info()]).unwrap_err();
            assert_err(err, GraveScannerError::LockerMarkerAccountRequired);
        }
    }
}
