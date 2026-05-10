// SPDX-License-Identifier: Apache-2.0
//
// Each instruction module exports its `Accounts` context struct, `Params`
// struct, any `#[event]` it emits, and a `handler` function invoked by
// lib.rs's `#[program]` block. The glob re-exports below are required by
// Anchor 0.31.x's `#[program]` macro, which expects each instruction's
// auto-generated `__cpi_client_accounts_*` / `__client_accounts_*` helper
// modules to be in scope at the parent namespace. The `handler` symbol
// duplicates across modules, but that ambiguity is harmless: lib.rs only
// ever invokes `handler` via the fully-qualified path
// `instructions::<module>::handler(...)`, never through the glob.

#[allow(ambiguous_glob_reexports)]
pub use evaluate_pool_phase1::*;
#[allow(ambiguous_glob_reexports)]
pub use evaluate_pool_phase2::*;
#[allow(ambiguous_glob_reexports)]
pub use initialize::*;
#[allow(ambiguous_glob_reexports)]
pub use invalidate_anchor::*;
#[allow(ambiguous_glob_reexports)]
pub use record_launch_price::*;
#[allow(ambiguous_glob_reexports)]
pub use sweep_stale_anchor::*;
#[allow(ambiguous_glob_reexports)]
pub use update_protocol_config::*;

pub mod evaluate_pool_phase1;
pub mod evaluate_pool_phase2;
pub mod initialize;
pub mod invalidate_anchor;
pub mod record_launch_price;
pub mod sweep_stale_anchor;
pub mod update_protocol_config;
