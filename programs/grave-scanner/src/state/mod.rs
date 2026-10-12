// SPDX-License-Identifier: Apache-2.0
//
// GraveScanner on-chain state. Every PDA in this module is a lifecycle
// record for the two-phase derelict-pool certification flow — none of
// them custody value, and none of them convey salvage authority on
// their own (that lives in GraveVault's `SalvageReceipt`).
//
// PDA family at a glance (seeds in `crate::constants`):
//
//   ProtocolConfig     ["protocol_config"]
//     Singletons the protocol. Multisig-controlled, 72h-timelocked
//     (governance-enforced via Squads, not program-enforced in v1.0).
//     Holds the six derelict-pool thresholds, cert TTL, staleness
//     window, and the two oracle pubkeys.
//
//   EligibilityAnchor  ["eligibility_anchor", amm_program_id, pool_address]
//     Written by Phase 1 of `evaluate_pool`. Stamps
//     `first_eligible_epoch` and the six-criterion bitmap. Lives until
//     Phase 2 certifies, multisig invalidates, or the staleness window
//     elapses (sweep_stale_anchor reclaims rent). Staging record only.
//
//   EligibilityCert    ["eligibility_cert", amm_program_id, pool_address]
//     Written by Phase 2 of `evaluate_pool`. Carries the TTL that
//     GraveVault checks before authorising a `salvage_pool`. One cert
//     per pool at a time; reissuance overwrites in place once the
//     prior cert has expired (spec D10).
//
//   LaunchPrice        ["launch_price", amm_program_id, pool_address]
//     Baseline price (Q64.64) used by Criterion 2 (price collapse).
//     Written by `record_launch_price` under oracle attestation
//     (ORACLE-001, spec D9). Immutable once written.
//
// All four state types derive `InitSpace` and use `#[account]`, so the
// 8-byte Anchor discriminator plus `INIT_SPACE` is the canonical
// allocation size. Layout-stability tests in `eligibility_cert.rs` and
// `eligibility_anchor.rs` pin the serialized footprint against drift.

pub mod eligibility_anchor;
pub mod eligibility_cert;
pub mod launch_price;
pub mod protocol_config;

pub use eligibility_anchor::*;
pub use eligibility_cert::*;
pub use launch_price::*;
pub use protocol_config::*;
