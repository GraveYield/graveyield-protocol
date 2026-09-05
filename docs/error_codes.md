# GraveYield error codes

> **Status**: living source of truth. Mirrors `programs/grave-scanner/src/errors.rs`
> and `programs/grave-vault/src/errors.rs` exactly. If they disagree, the
> Rust sources win — always.
>
> Last verified against on-main: May 2026.

This file is the authoritative table of on-chain error codes returned by
the two GraveYield programs. Auditors, indexer authors, SDK consumers,
and front-end error handlers should map codes against this file. The
`published/` `.docx` snapshots are intentionally frozen between minor
revisions and may lag behind; this markdown wins per the contract in
[`README.md`](README.md).

## Sync convention

Any change to either program's `errors.rs` **MUST** land alongside an
update to this file in the same PR. Spec drift on this surface is
treated as a bug.

Anchor's `#[error_code]` macro automatically offsets each enum variant's
Rust discriminant by 6000. The **Code** column below is the on-chain
emitted value (= Rust discriminant + 6000). Do not confuse the two.

## GraveScanner — 6000-6019

Source: [`../programs/grave-scanner/src/errors.rs`](../programs/grave-scanner/src/errors.rs).
Discriminants 12-14 (codes 6012-6014) are intentionally reserved for
future v4.x additions to the pre-anchor error space.

| Code | Name | Condition |
|------|------|-----------|
| 6000 | `Unauthorized` | Caller lacks the multisig authority required. |
| 6001 | `PoolNotEligible` | Pool does not satisfy all six derelict-pool criteria. |
| 6002 | `LaunchPriceNotFound` | `LaunchPrice` PDA missing for this pool. |
| 6003 | `UnsupportedAmm` | AMM program mismatch or unsupported pool layout. |
| 6004 | `MathOverflow` | Arithmetic overflow during eligibility computation. |
| 6005 | `InvalidClock` | Clock sysvar unavailable or returned invalid data. |
| 6006 | `InvariantViolation` | `ProtocolConfig` update violates a locked invariant. |
| 6007 | `AmmAdapterUnimplemented` | AMM adapter registered but parser is a pre-mainnet stub. Live list in [`PRE_MAINNET_CHECKLIST.md`](PRE_MAINNET_CHECKLIST.md). |
| 6008 | `LockerAdapterUnimplemented` | Locker adapter registered but not implemented. Returning `Err` rather than zero prevents silent certification of pools whose LP is locked. |
| 6009 | `PoolDataParseError` | Pool account data did not match the expected layout. |
| 6010 | `ProtocolPaused` | GraveScanner is paused; `evaluate_pool_*` reverts. No effect on rent reclaim or the GraveVault claim path. |
| 6011 | `CriteriaBitmapMismatch` | Phase 2 produced a bitmap that disagrees with the originating `EligibilityAnchor`. |
| 6015 | `AnchorNotFound` | Phase 2 attempted without an `EligibilityAnchor` PDA. |
| 6016 | `EpochConfirmationPending` | Phase 2 attempted before `anchor.first_eligible_epoch + MIN_EPOCH_CONFIRMATION`. |
| 6017 | `AnchorInvalidated` | `EligibilityAnchor` was invalidated by multisig. |
| 6018 | `AnchorNotStale` | `sweep_stale_anchor` called before the staleness window elapsed. |
| 6019 | `CertTtlBelowMinimum` | `update_protocol_config` rejected a `cert_ttl_seconds` value below `MIN_CERT_TTL_SECONDS` (600s = 10 min). |

## GraveVault — 7000-7019

Source: [`../programs/grave-vault/src/errors.rs`](../programs/grave-vault/src/errors.rs).
Codes 7015-7019 added by m5 (salvage_pool execution path). Future m6/m7
additions append at 7020+ and must land in lock-step with the Rust
source per the sync convention.

| Code | Name | Condition |
|------|------|-----------|
| 7000 | `Unauthorized` | Caller lacks the multisig authority required for this instruction. |
| 7001 | `InvalidEligibilityCert` | `EligibilityCert` PDA missing, expired, or owned by the wrong program. |
| 7002 | `EligibilityCertExpired` | `EligibilityCert` TTL has passed. Re-run Phase 2 to mint a fresh cert. |
| 7003 | `ProtocolPaused` | Protocol is paused — only `claim_lp_proceeds` is callable. |
| 7004 | `InvalidShareSplit` | Distribution shares (LP / salvor / protocol) did not sum to 10_000 bps. |
| 7005 | `ProtocolShareExceedsCeiling` | Attempted to raise `protocol_share_bps` above the Charter ceiling. |
| 7006 | `LpHolderPoolUnsweepable` | Attempted to sweep, close, or otherwise drain `lp_holder_pool_vault`. This account is unsweepable by any admin key, ever — Charter invariant. |
| 7007 | `SlippageExceeded` | Slippage on the Jupiter swap leg exceeded the configured maximum. |
| 7008 | `PriorityFeeExceedsCeiling` | Transaction priority fee exceeds the Charter ceiling. |
| 7009 | `MathOverflow` | Arithmetic overflow during distribution math. |
| 7010 | `InvalidClaimProof` | LP holder is not in the snapshot Merkle tree, or proof is invalid. |
| 7011 | `ClaimAlreadyProcessed` | Claim has already been processed for this `(pool, lp_holder)` pair. |
| 7012 | `BelowDustThreshold` | Quote output below the Jupiter dust threshold; salvage skipped or aborted. |
| 7013 | `PreflightFailed` | Pre-flight check against the on-chain pool failed. |
| 7014 | `TimelockNotElapsed` | Timelock window has not yet elapsed for a queued parameter change. |
| 7015 | `AmmRedemptionFailed` | AMM `remove_liquidity` CPI returned an error or zero output. |
| 7016 | `JupiterSwapFailed` | Jupiter v6 swap CPI returned an error or zero output. |
| 7017 | `AmmCpiUnimplemented` | AMM CPI adapter is a pre-mainnet stub (CLMM / Orca Whirlpool / PumpSwap). Pool owner is not the Raydium V4 program. See [`PRE_MAINNET_CHECKLIST.md`](PRE_MAINNET_CHECKLIST.md). |
| 7018 | `InvalidSnapshotData` | Salvor's `lp_total_supply_at_snapshot` does not match the on-chain LP mint supply at salvage time. |
| 7019 | `UnsupportedBaseToken` | Pool base token is not WSOL. USDC/USDT base support is a v1.1 deliverable. |

## Drift from the v3.0 .docx snapshot

The Combined Tech Doc v3.0 `.docx` snapshot referenced in
[`README.md`](README.md) §"Canonical spec set" lists a different
GraveVault error scheme in its §4.2 — 7000-7018 with names including
`AMMRedemptionFailed`, `JupiterSwapFailed`, `InvalidMerkleProof`,
`InvalidSnapshotData`, and `ComputeBudgetTooLow`. That scheme was
authored before the on-main numbering was locked and has since drifted.

Per [`README.md`](README.md), when a markdown source-of-truth and a
`.docx` snapshot disagree, the markdown wins. This file is the markdown
source-of-truth for the error tables, so the v3.0 `.docx` scheme is
**superseded** and will be re-rendered at the next minor revision.

The full Combined Tech Doc markdown
(`grave-scanner-grave-vault-combined.md`) is not yet committed to the
repo. When it lands, its error-code section MUST reference this file
rather than re-tabulating the codes.

---

*Mirrored from `errors.rs` files on 2026-05-16. Last verified at PR m5 (GraveVault 7000-7019, GraveScanner 6000-6019).*
