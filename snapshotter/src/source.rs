// SPDX-License-Identifier: Apache-2.0
//
// Enumeration sources for the LP-holder snapshot.
//
// The trait boundary is the seam between deterministic snapshot mechanics
// (this crate, fully host-tested) and ledger I/O (the RPC implementation in
// `rpc`, or any future indexing source). The `InMemorySource` keeps the
// whole builder testable without a network.
//
// CONSISTENT-STATE CONTRACT (WD-02 fix)
//
// A snapshot is only as good as the chain state it represents, so the
// source protocol is a three-step pinned read driven by the builder:
//
//   1. `initial_supply` — the supply read whose served context slot
//      becomes the snapshot's STATE ANCHOR. A source that cannot supply a
//      real context slot (slot 0 / no context metadata) must fail rather
//      than fabricate one; the builder rejects slot 0 outright
//      (`MissingStateContext`).
//   2. `token_accounts(min_context_slot)` — the full enumeration, which
//      MUST be served from a state no older than the anchor slot. The RPC
//      implementation forwards the anchor as the `getProgramAccounts`
//      `minContextSlot` parameter, so a node that cannot reach the pinned
//      state errors out instead of silently serving older data.
//   3. `final_supply(min_context_slot)` — a post-enumeration supply
//      re-read under the same lower-bound rule. The builder requires it
//      to equal the initial supply and fails closed otherwise
//      (`SupplyDrift`).
//
// The builder detects an inconsistent view via the `Σ balances == supply`
// gate, but that gate is a backstop, not a substitute for a coherent read.
// It also cannot detect a same-total holder transfer between the anchor
// and the enumeration: supply equality proves the TOTAL did not drift, but
// NOT that the per-holder attribution matches the anchor slot's state.
// Holder-level revalidation is a separate control (D-06 P2) and no part of
// this trait claims it.

use solana_sdk::pubkey::Pubkey;

use crate::error::SnapshotError;
use crate::model::{MintSupply, TokenAccountSnapshot};

/// Source of the facts a snapshot needs: the LP mint's supply before and
/// after the enumeration (each with the slot it was served at) and every
/// SPL token account holding the mint, pinned to the anchored state.
pub trait LpAccountSource {
    /// The LP mint's total supply at the source's served slot. The served
    /// context slot becomes the snapshot's state anchor.
    fn initial_supply(&self, lp_mint: &Pubkey) -> Result<MintSupply, SnapshotError>;

    /// Every token account holding `lp_mint`, served from a state no
    /// older than `min_context_slot` (the anchor slot from
    /// `initial_supply`). A complete enumeration is required — the
    /// builder's supply invariant assumes it. A source that cannot
    /// establish the pinned state must fail, not serve older data.
    fn token_accounts(
        &self,
        lp_mint: &Pubkey,
        min_context_slot: u64,
    ) -> Result<Vec<TokenAccountSnapshot>, SnapshotError>;

    /// The LP mint's total supply re-read AFTER the enumeration, served
    /// from a state no older than `min_context_slot`. The builder compares
    /// this against `initial_supply` and fails closed on drift.
    fn final_supply(
        &self,
        lp_mint: &Pubkey,
        min_context_slot: u64,
    ) -> Result<MintSupply, SnapshotError>;
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
    /// Optional distinct post-enumeration supply read. `None` (the
    /// default) serves the same state for every read, which is the honest
    /// mirror of a source holding one coherent snapshot. The override
    /// exists so tests can simulate supply drift and stale contexts
    /// deterministically without a network.
    final_override: Option<MintSupply>,
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
            final_override: None,
        }
    }

    /// Simulate a post-enumeration supply re-read that observes a
    /// different slot/supply than the initial read (drift or staleness
    /// fixture). The override is validated against the requested
    /// `min_context_slot` exactly like the RPC implementation.
    pub fn with_final_supply(mut self, slot: u64, supply: u64) -> Self {
        self.final_override = Some(MintSupply {
            amount: supply,
            slot,
        });
        self
    }

    fn check_pinned(&self, min_context_slot: u64) -> Result<(), SnapshotError> {
        if min_context_slot > self.slot {
            return Err(SnapshotError::StaleState {
                anchor_slot: min_context_slot,
                served_slot: self.slot,
            });
        }
        Ok(())
    }
}

impl LpAccountSource for InMemorySource {
    fn initial_supply(&self, lp_mint: &Pubkey) -> Result<MintSupply, SnapshotError> {
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

    fn token_accounts(
        &self,
        lp_mint: &Pubkey,
        min_context_slot: u64,
    ) -> Result<Vec<TokenAccountSnapshot>, SnapshotError> {
        if lp_mint != &self.mint {
            return Err(SnapshotError::Source(format!(
                "in-memory source serves mint {}, not {lp_mint}",
                self.mint
            )));
        }
        self.check_pinned(min_context_slot)?;
        Ok(self.accounts.clone())
    }

    fn final_supply(
        &self,
        lp_mint: &Pubkey,
        min_context_slot: u64,
    ) -> Result<MintSupply, SnapshotError> {
        if lp_mint != &self.mint {
            return Err(SnapshotError::Source(format!(
                "in-memory source serves mint {}, not {lp_mint}",
                self.mint
            )));
        }
        self.check_pinned(min_context_slot)?;
        Ok(self.final_override.unwrap_or(MintSupply {
            amount: self.supply,
            slot: self.slot,
        }))
    }
}
