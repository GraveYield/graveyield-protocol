// SPDX-License-Identifier: Apache-2.0
//
// Each instruction module exports its `Accounts` context struct, `Params`
// struct, any `#[event]` it emits, and a `handler` function invoked by
// lib.rs's `#[program]` block. The glob re-exports below are required by
// Anchor 0.32.x's `#[program]` macro, which expects each instruction's
// auto-generated `__cpi_client_accounts_*` / `__client_accounts_*` helper
// modules to be in scope at the parent namespace. The `handler` symbol
// duplicates across modules, but that ambiguity is harmless: lib.rs only
// ever invokes `handler` via the fully-qualified path
// `instructions::<module>::handler(...)`, never through the glob.
//
// That ambiguity is intentional and accepted, so it is suppressed exactly
// once, module-wide, by the inner attribute below — instead of repeating
// `#[allow(ambiguous_glob_reexports)]` on all eight `pub use` items. If a
// future Anchor version removes the duplicate-symbol expectation, delete
// the attribute AND collapse the globs into explicit re-exports.
#![allow(ambiguous_glob_reexports)]

pub use emergency_pause::*;
pub use evaluate_pool_phase1::*;
pub use evaluate_pool_phase2::*;
pub use initialize::*;
pub use invalidate_anchor::*;
pub use record_launch_price::*;
pub use sweep_stale_anchor::*;
pub use update_protocol_config::*;

pub mod emergency_pause;
pub mod evaluate_pool_phase1;
pub mod evaluate_pool_phase2;
pub mod initialize;
pub mod invalidate_anchor;
pub mod record_launch_price;
pub mod sweep_stale_anchor;
pub mod update_protocol_config;
