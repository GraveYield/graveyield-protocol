// SPDX-License-Identifier: Apache-2.0
//
// Locked-LP evidence: attribution of locker-held LP to beneficial owners.
//
// v1.0 production support: UNCX Network Raydium AMM V4 LP locker
// (program `GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo`), mirroring the
// on-chain scanner adapter (`programs/grave-scanner/src/adapters/locker.rs`,
// LOCKER-001) — same program id, same TokenLock layout, same strict
// validation. Additional lockers (PinkSale, Team Finance, Streamflow …) are
// appended as separate resolvers — never as extra arms of the same parser
// (LOCKER-002 tracks the expansion).
//
// ATTRIBUTION POLICY (spec rev 1.8.0, D11)
//
// Locked LP is attributed to the beneficial owner recorded in each
// `TokenLock.lock_owner`, NOT to the custody account that physically holds
// the tokens: a program-derived custody account can never sign a
// `claim_lp_proceeds` transaction, so attributing to it would strand that
// fraction of the LP bucket forever. The custody account is identified by
// exact-balance reconciliation — its balance must equal
// `Σ current_locked_amount`, the reconciliation pattern verified 74/74
// against live mainnet during LOCKER-001 — and the builder fails closed on
// ambiguity (see `SnapshotBuilder`).

use solana_sdk::pubkey::Pubkey;

use crate::error::SnapshotError;

// =====================================================================
// UNCX Raydium AMM V4 locker adapter (off-chain mirror of the scanner's).
// =====================================================================

/// UNCX Raydium AMM V4 LP locker facts. Kept in lockstep with
/// `programs/grave-scanner/src/adapters/locker.rs`; the dev-test
/// `uncx_constants_match_the_scanner_adapter` asserts byte-equality of the
/// published constants so the two implementations cannot drift apart.
pub mod uncx {
    use super::Pubkey;

    /// Mainnet UNCX Raydium AMM V4 LP locker program (official repo:
    /// uncx-network/raydium-amm-lp-locker, `declare_id!` matches).
    pub const PROGRAM_ID: Pubkey =
        solana_sdk::pubkey!("GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo");

    /// Anchor discriminator of the `TokenLock` account:
    /// sha256("account:TokenLock")[..8] = 49e490f19a2c5dee.
    pub const TOKEN_LOCK_DISC: [u8; 8] = [0x49, 0xe4, 0x90, 0xf1, 0x9a, 0x2c, 0x5d, 0xee];

    /// PDA seed prefix (from the official source: `accounts_ix/lock_lp.rs`).
    pub const TOKEN_LOCK_SEED: &[u8] = b"uncx_locker";

    /// TokenLock: 8 disc + bump(1) + amm_id(32) + lp_mint(32)
    ///            + lock_global_id(8) + lock_date(8) + unlock_date(8)
    ///            + country_code(1) + initial_lock_amount(8)
    ///            + current_locked_amount(8) + lock_owner(32) = 146.
    pub const TOKEN_LOCK_SIZE: usize = 146;

    /// Byte offsets into the TokenLock account data.
    pub mod offsets {
        pub const AMM_ID: usize = 9;
        pub const LP_MINT: usize = 41;
        pub const LOCK_GLOBAL_ID: usize = 73;
        pub const CURRENT_LOCKED_AMOUNT: usize = 106;
        pub const LOCK_OWNER: usize = 114;
    }

    /// Derive the expected TokenLock PDA for a global lock id (same
    /// derivation as the on-chain validator).
    pub fn token_lock_address(lock_global_id: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[TOKEN_LOCK_SEED, &lock_global_id.to_le_bytes()],
            &PROGRAM_ID,
        )
        .0
    }

    /// Derive the per-pool lock marker PDA (evidence gate on the scanner
    /// side; the snapshotter does not need the marker — its TokenLock
    /// enumeration is bounded by the (amm_id, lp_mint) filters — but the
    /// derivation is published for tooling parity).
    pub fn marker_address(amm_id: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"global_lp_tracker", amm_id.as_ref()], &PROGRAM_ID).0
    }
}

/// One strictly validated UNCX `TokenLock` record.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct TokenLockRecord {
    /// The TokenLock PDA this record was parsed from.
    pub address: Pubkey,
    /// The lock's sequential global id (declared in the data and pinned by
    /// the PDA re-derivation check).
    pub lock_global_id: u64,
    /// Tokens currently locked by this record.
    pub current_locked_amount: u64,
    /// The beneficial owner who will (eventually) control the unlocked
    /// tokens — the attribution target.
    pub lock_owner: Pubkey,
}

impl TokenLockRecord {
    /// Strictly validate and parse raw TokenLock account data — the
    /// off-chain mirror of the scanner adapter's on-chain checks: exact
    /// size, exact discriminator, anti-forgery PDA re-derivation from the
    /// record's own declared id, and the (amm_id, lp_mint) binding.
    pub fn parse(
        address: Pubkey,
        data: &[u8],
        amm_id: &Pubkey,
        lp_mint: &Pubkey,
    ) -> Result<Self, SnapshotError> {
        let invalid = |reason: &str| {
            Err(SnapshotError::LockRecordInvalid {
                address: address.to_string(),
                reason: reason.to_string(),
            })
        };
        if data.len() != uncx::TOKEN_LOCK_SIZE {
            return invalid("size");
        }
        if data[..8] != uncx::TOKEN_LOCK_DISC[..] {
            return invalid("discriminator");
        }
        let lock_global_id = u64::from_le_bytes(
            data[uncx::offsets::LOCK_GLOBAL_ID..uncx::offsets::LOCK_GLOBAL_ID + 8]
                .try_into()
                .map_err(|_| SnapshotError::LockRecordInvalid {
                    address: address.to_string(),
                    reason: "lock_global_id slice".to_string(),
                })?,
        );
        if address != uncx::token_lock_address(lock_global_id) {
            return invalid("pda re-derivation");
        }
        if data[uncx::offsets::AMM_ID..uncx::offsets::AMM_ID + 32] != amm_id.as_ref()[..] {
            return invalid("amm_id binding");
        }
        if data[uncx::offsets::LP_MINT..uncx::offsets::LP_MINT + 32] != lp_mint.as_ref()[..] {
            return invalid("lp_mint binding");
        }
        let current_locked_amount = u64::from_le_bytes(
            data[uncx::offsets::CURRENT_LOCKED_AMOUNT..uncx::offsets::CURRENT_LOCKED_AMOUNT + 8]
                .try_into()
                .map_err(|_| SnapshotError::LockRecordInvalid {
                    address: address.to_string(),
                    reason: "current_locked_amount slice".to_string(),
                })?,
        );
        let lock_owner = Pubkey::new_from_array(
            data[uncx::offsets::LOCK_OWNER..uncx::offsets::LOCK_OWNER + 32]
                .try_into()
                .map_err(|_| SnapshotError::LockRecordInvalid {
                    address: address.to_string(),
                    reason: "lock_owner slice".to_string(),
                })?,
        );
        Ok(Self {
            address,
            lock_global_id,
            current_locked_amount,
            lock_owner,
        })
    }
}

/// Source of validated lock records for the snapshot's `(amm_id, lp_mint)`.
pub trait LockedLpEvidence {
    /// Every locked-LP record binding this pool and LP mint. Implementations
    /// MUST validate each record (the RPC implementation routes through
    /// `TokenLockRecord::parse`) and SHOULD return them in a deterministic
    /// order; the builder additionally sorts by address before aggregating.
    fn token_locks(
        &self,
        amm_id: &Pubkey,
        lp_mint: &Pubkey,
    ) -> Result<Vec<TokenLockRecord>, SnapshotError>;
}

/// In-memory lock evidence for tests and offline replay. Records are
/// validated at construction (`from_raw`) or accepted pre-validated
/// (`from_records`) and served sorted by address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InMemoryLocks {
    amm_id: Pubkey,
    lp_mint: Pubkey,
    records: Vec<TokenLockRecord>,
}

impl InMemoryLocks {
    /// Validate raw `(address, data)` pairs against `(amm_id, lp_mint)` and
    /// store the parsed records. This is the test-fixture mirror of what the
    /// RPC source does with `getProgramAccounts` results.
    pub fn from_raw(
        amm_id: &Pubkey,
        lp_mint: &Pubkey,
        raw: Vec<(Pubkey, Vec<u8>)>,
    ) -> Result<Self, SnapshotError> {
        let mut records = Vec::with_capacity(raw.len());
        for (address, data) in raw {
            records.push(TokenLockRecord::parse(address, &data, amm_id, lp_mint)?);
        }
        Ok(Self {
            amm_id: *amm_id,
            lp_mint: *lp_mint,
            records,
        })
    }

    /// Store pre-validated records as-is.
    pub fn from_records(amm_id: &Pubkey, lp_mint: &Pubkey, records: Vec<TokenLockRecord>) -> Self {
        Self {
            amm_id: *amm_id,
            lp_mint: *lp_mint,
            records,
        }
    }

    fn sorted_records(&self) -> Vec<TokenLockRecord> {
        let mut records = self.records.clone();
        records.sort();
        records
    }
}

impl LockedLpEvidence for InMemoryLocks {
    fn token_locks(
        &self,
        amm_id: &Pubkey,
        lp_mint: &Pubkey,
    ) -> Result<Vec<TokenLockRecord>, SnapshotError> {
        if amm_id != &self.amm_id || lp_mint != &self.lp_mint {
            return Err(SnapshotError::Source(format!(
                "in-memory lock evidence serves ({}, {}), not ({amm_id}, {lp_mint})",
                self.amm_id, self.lp_mint
            )));
        }
        Ok(self.sorted_records())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn amm() -> Pubkey {
        Pubkey::new_from_array([7u8; 32])
    }
    fn mint() -> Pubkey {
        Pubkey::new_from_array([8u8; 32])
    }
    fn owner(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    /// Build a well-formed TokenLock payload for the given fields.
    fn encode_lock(lock_global_id: u64, locked: u64, lock_owner: &Pubkey) -> Vec<u8> {
        let mut data = vec![0u8; uncx::TOKEN_LOCK_SIZE];
        data[..8].copy_from_slice(&uncx::TOKEN_LOCK_DISC);
        data[8] = 255; // bump
        data[uncx::offsets::AMM_ID..uncx::offsets::AMM_ID + 32].copy_from_slice(amm().as_ref());
        data[uncx::offsets::LP_MINT..uncx::offsets::LP_MINT + 32].copy_from_slice(mint().as_ref());
        data[uncx::offsets::LOCK_GLOBAL_ID..uncx::offsets::LOCK_GLOBAL_ID + 8]
            .copy_from_slice(&lock_global_id.to_le_bytes());
        // lock_date/unlock_date/country_code/initial_lock_amount: filler.
        data[uncx::offsets::CURRENT_LOCKED_AMOUNT..uncx::offsets::CURRENT_LOCKED_AMOUNT + 8]
            .copy_from_slice(&locked.to_le_bytes());
        data[uncx::offsets::LOCK_OWNER..uncx::offsets::LOCK_OWNER + 32]
            .copy_from_slice(lock_owner.as_ref());
        data
    }

    #[test]
    fn parses_a_wellformed_record_and_pins_offsets() {
        let id = 4242u64;
        let address = uncx::token_lock_address(id);
        let data = encode_lock(id, 123_456, &owner(1));
        let rec = TokenLockRecord::parse(address, &data, &amm(), &mint()).unwrap();
        assert_eq!(rec.address, address);
        assert_eq!(rec.lock_global_id, id);
        assert_eq!(rec.current_locked_amount, 123_456);
        assert_eq!(rec.lock_owner, owner(1));
        // Layout arithmetic pin: the owner field ends exactly at the
        // documented account size.
        assert_eq!(uncx::offsets::LOCK_OWNER + 32, uncx::TOKEN_LOCK_SIZE);
        assert_eq!(
            uncx::offsets::CURRENT_LOCKED_AMOUNT + 8,
            uncx::offsets::LOCK_OWNER
        );
    }

    #[test]
    fn rejects_bad_size() {
        let data = vec![0u8; uncx::TOKEN_LOCK_SIZE - 1];
        let err = TokenLockRecord::parse(uncx::token_lock_address(1), &data, &amm(), &mint())
            .unwrap_err();
        assert!(
            matches!(err, SnapshotError::LockRecordInvalid { ref reason, .. } if reason == "size")
        );
    }

    #[test]
    fn rejects_bad_discriminator() {
        let mut data = encode_lock(1, 10, &owner(2));
        data[0] ^= 0xFF;
        let err = TokenLockRecord::parse(uncx::token_lock_address(1), &data, &amm(), &mint())
            .unwrap_err();
        assert!(
            matches!(err, SnapshotError::LockRecordInvalid { ref reason, .. } if reason == "discriminator")
        );
    }

    #[test]
    fn rejects_forged_pda_address() {
        let data = encode_lock(1, 10, &owner(2));
        // Right data, wrong address: the anti-forgery pin must catch it.
        let forged = Pubkey::new_from_array([0xEE; 32]);
        let err = TokenLockRecord::parse(forged, &data, &amm(), &mint()).unwrap_err();
        assert!(
            matches!(err, SnapshotError::LockRecordInvalid { ref reason, .. } if reason == "pda re-derivation")
        );
    }

    #[test]
    fn rejects_foreign_amm_binding() {
        let data = encode_lock(1, 10, &owner(2));
        let foreign_amm = Pubkey::new_from_array([0x77; 32]);
        let err = TokenLockRecord::parse(uncx::token_lock_address(1), &data, &foreign_amm, &mint())
            .unwrap_err();
        assert!(
            matches!(err, SnapshotError::LockRecordInvalid { ref reason, .. } if reason == "amm_id binding")
        );
    }

    #[test]
    fn rejects_foreign_mint_binding() {
        let data = encode_lock(1, 10, &owner(2));
        let foreign_mint = Pubkey::new_from_array([0x88; 32]);
        let err = TokenLockRecord::parse(uncx::token_lock_address(1), &data, &amm(), &foreign_mint)
            .unwrap_err();
        assert!(
            matches!(err, SnapshotError::LockRecordInvalid { ref reason, .. } if reason == "lp_mint binding")
        );
    }

    #[test]
    fn pda_derivation_matches_explicit_find_program_address() {
        // Pin the derivation shape (seed prefix + LE u64) so a refactor of
        // `token_lock_address` cannot silently change the wire contract.
        let (expected, _bump) =
            Pubkey::find_program_address(&[b"uncx_locker", &7u64.to_le_bytes()], &uncx::PROGRAM_ID);
        assert_eq!(uncx::token_lock_address(7), expected);
    }
}
