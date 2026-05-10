// SPDX-License-Identifier: Apache-2.0
//
// See programs/grave-scanner/src/instructions/mod.rs for the rationale on
// `#[allow(ambiguous_glob_reexports)]`. Anchor 0.31.x's `#[program]` macro
// requires the glob form to bring each instruction's auto-generated
// `__cpi_client_accounts_*` / `__client_accounts_*` modules into scope.

#[allow(ambiguous_glob_reexports)]
pub use claim_lp_proceeds::*;
#[allow(ambiguous_glob_reexports)]
pub use emergency_pause::*;
#[allow(ambiguous_glob_reexports)]
pub use initialize::*;
#[allow(ambiguous_glob_reexports)]
pub use salvage_pool::*;
#[allow(ambiguous_glob_reexports)]
pub use update_protocol_config::*;

pub mod claim_lp_proceeds;
pub mod emergency_pause;
pub mod initialize;
pub mod salvage_pool;
pub mod update_protocol_config;
