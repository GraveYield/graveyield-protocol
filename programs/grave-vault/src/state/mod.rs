// SPDX-License-Identifier: Apache-2.0
//
// GraveVault on-chain state. Every PDA in this module is a settlement-
// lifecycle record for the salvage execution path. Two of them
// (`PoolRegistry`, `SalvageReceipt`) custody value implicitly via the
// lamports they track; the Charter invariant that
// `lp_holder_pool_vault` is unsweepable by any admin key is enforced
// at the instruction layer, not by these account structs themselves.
//
// PDA family at a glance (seeds in `crate::constants`):
//
//   ProtocolConfig  ["protocol_config"]
//     Singleton config. Multisig-controlled, 72h-timelocked (timelock
//     is governance-enforced via Squads, not program-enforced in v1.0
//     — see PROTOCOL_SPEC.md D2). Holds the 40/40/20 share split, the
//     Charter protocol-share ceiling, slippage/priority-fee rails, and
//     the emergency pause flag.
//
//   PoolRegistry    ["pool_registry", pool_address]
//     Created by `salvage_pool`. One-per-pool idempotency record: a
//     second salvage against the same pool fails at `init` because this
//     PDA already exists. Seals the LP-holder Merkle root and the
//     pro-rata denominator at snapshot time; tracks cumulative claimed
//     lamports so conservation can be re-checked on every claim.
//
//   SalvageReceipt  ["salvage_receipt", pool_address]
//     Issued at the end of a successful salvage. Records the 40/40/20
//     distribution amounts and (Phase 4) the retained-memecoin dust
//     state for `sweep_dust` to consume. Read-only after issuance —
//     `sweep_dust` is the only post-issuance writer, and only to stamp
//     `dust_swept_at_ts`. Fork harnesses and the indexer read fields at
//     raw offsets; the layout-stability test in `salvage_receipt.rs`
//     pins those offsets byte-for-byte.
//
//   ClaimRecord     ["claim_record", pool_address, lp_holder]
//     Created by `claim_lp_proceeds`. Init-on-PDA is the canonical
//     double-claim defense: a second claim by the same (pool, holder)
//     pair fails at the `init` constraint before any lamports move.
//
// All four state types derive `InitSpace` and use `#[account]`, so the
// 8-byte Anchor discriminator plus `INIT_SPACE` is the canonical
// allocation size. Layout-stability tests in `salvage_receipt.rs`,
// `pool_registry.rs`, `claim_record.rs`, and `protocol_config.rs` pin
// the serialized footprints against drift.

pub mod claim_record;
pub mod pool_registry;
pub mod protocol_config;
pub mod salvage_receipt;

pub use claim_record::*;
pub use pool_registry::*;
pub use protocol_config::*;
pub use salvage_receipt::*;
