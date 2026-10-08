// SPDX-License-Identifier: Apache-2.0
//
// Enumeration sources for the LP-holder snapshot.
//
// The trait boundary is the seam between deterministic snapshot mechanics
// (this crate, fully host-tested) and ledger I/O (the RPC implementation in
// `rpc`, or any future indexing source). The `InMemorySource` keeps the
// whole builder testable without a network.

use solana_sdk::pubkey::Pubkey;

use crate::error::SnapshotError;
use crate::model::{MintSupply, TokenAccountSnapshot};

/// Source of the two facts a snapshot needs: the LP mint's supply (with the
/// slot it was served at) and every SPL token account holding the mint.
///
/// Implementations MUST serve a consistent view: the supply and the account
/// set must come from the same ledger state. The builder detects an
/// inconsistent view via the `Σ balances == supply` gate, but that gate is
/// a backstop, not a substitute for a coherent read.
pub trait LpAccountSource {
    /// The LP mint's total supply at the source's served slot.
    fn lp_mint_supply(&self, lp_mint: &Pubkey) -> Result<MintSupply, SnapshotError>;

    /// Every token account holding `lp_mint`. A complete enumeration is
    /// required — the builder's supply invariant assumes it.
    fn token_accounts(&self, lp_mint: &Pubkey) -> Result<Vec<TokenAccountSnapshot>, SnapshotError>;
}

/// In-memory source for tests and offline replay. Serves exactly one mint;
/// queries for any other mint fail loudly rather than silently returning
/// the wrong pool's data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InMemorySource {
    mint: Pubkey,
    slot: u64,
    supply: u64,
    accounts: Vec<TokenAccountSnapshot>,
}

impl InMemorySource {
    /// Build a source serving `mint` at `slot`. `supply` SHOULD equal the
    /// sum of the supplied account amounts — a mismatch is a legitimate
    /// test fixture for the `SupplyMismatch` gate.
    pub fn new(mint: Pubkey, slot: u64, supply: u64, accounts: Vec<TokenAccountSnapshot>) -> Self {
        Self {
            mint,
            slot,
            supply,
            accounts,
        }
    }
}

impl LpAccountSource for InMemorySource {
    fn lp_mint_supply(&self, lp_mint: &Pubkey) -> Result<MintSupply, SnapshotError> {
        if lp_mint != &self.mint {
            return Err(SnapshotError::Source(format!(
                "in-memory source serves mint {}, not {lp_mint}",
                self.mint
            )));
        }
        Ok(MintSupply {
            amount: self.supply,
            slot: self.slot,
        })
    }

    fn token_accounts(&self, lp_mint: &Pubkey) -> Result<Vec<TokenAccountSnapshot>, SnapshotError> {
        if lp_mint != &self.mint {
            return Err(SnapshotError::Source(format!(
                "in-memory source serves mint {}, not {lp_mint}",
                self.mint
            )));
        }
        Ok(self.accounts.clone())
    }
}
