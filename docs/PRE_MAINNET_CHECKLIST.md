# Pre-Mainnet Checklist

This file is the human-curated source of truth for every placeholder that
must be resolved before GraveYield can ship to mainnet. Each row maps to
one or more `PRE-MAINNET-TODO` markers in source.

**Auditor's one-liner:**

```
grep -rn "PRE-MAINNET-TODO" programs/ adapters/
```

`scripts/list-pre-mainnet-todos.sh` runs this grep and pretty-prints the
results grouped by scope.

## Marker convention

Every `PRE-MAINNET-TODO` marker in source uses this shape:

```rust
// PRE-MAINNET-TODO(<SCOPE>): <description> | reverts: <ErrorName> | verify: <auditor check>
```

Scopes:

| Scope | Meaning |
| --- | --- |
| `LOCKER` | Locker program IDs / introspection (UNCX, PinkSale, Team Finance) |
| `ORACLE` | Off-chain data with cryptographic proof requirement (Pyth, last-swap proofs) |
| `CPI` | AMM-specific layout parsing or cross-program invocation |
| `KEYS` | Mainnet program IDs / pubkeys not yet finalised |
| `IDL` | IDL-level shape changes pending downstream consumer updates |
| `RENT` | Rent-related accounting that needs reconciling pre-deploy |
| `SLIP` | Slippage policy fields or enforcement gaps |
| `DUST` | Below-threshold token accounting / recovery policy |
| `GOV` | Governance / timelock enforcement boundaries |

## Live checklist (v0.1.0)

Status legend: 🟥 blocking · 🟧 high-priority · 🟡 medium · ⬜ tracking only.

### LOCKER

| ID | File | Status | Description |
| --- | --- | --- | --- |
| LOCKER-001 | `programs/grave-scanner/src/adapters/locker.rs` | ✅ | **Retired (Phase 1.1).** UNCX Raydium AMM V4 locker introspection implemented: per-pool marker PDA `["global_lp_tracker", amm_id]` gates the check (absent = provably never locked), TokenLock PDAs `["uncx_locker", id]` are strictly validated on-chain (ownership, discriminator, size, PDA re-derivation, `(amm_id, lp_mint)` binding) and `current_locked_amount` summed. Verified against live mainnet state (125 locks / 74 pools; per-mint custody reconciliation 74/74). Evidence-completeness for pools with lock history is SDK/operator-enforced (see spec §6). |

### ORACLE

| ID | File | Status | Description |
| --- | --- | --- | --- |
| ORACLE-001 | `programs/grave-scanner/src/instructions/record_launch_price.rs` | ✅ | **Retired (Phase 1.3).** C2's launch-price baseline is now an oracle-signed 168-byte Ed25519 attestation (`amm_program_id ‖ pool_address ‖ base_mint ‖ quote_mint ‖ first_swap_slot ‖ first_swap_unix_ts ‖ launch_price_q64x64 ‖ issued_slot`) signed by the dedicated `ProtocolConfig.launch_price_oracle` key and verified in-transaction via the `ed25519_program` precompile: signature bound to exactly the embedded message, pool/mint/price echo binding, strictly positive price, first-swap timestamp/slot and issuance-slot sanity (errors 6024–6027, 6032). Both evaluation handlers re-check the recorded mint pair against the live pool's parsed mints (6033). No SlotHashes freshness check by design — the baseline is a historical fact and the PDA is init-once, so replay is structurally impossible (spec D9). `LaunchPrice` gained attested `first_swap_slot` / `first_swap_unix_ts` provenance fields. Caller-supplied prices are no longer accepted (breaking instruction-data change). |
| ORACLE-002 | `programs/grave-scanner/src/attestation.rs` (also Phase 1/2 handlers) | ✅ | **Retired (Phase 1.2).** C1 inactivity evidence is now an indexer-signed 112-byte Ed25519 attestation (`amm_program_id ‖ pool_address ‖ last_swap_unix_ts ‖ issued_slot ‖ slot_hash`) verified in-transaction via the `ed25519_program` precompile: signature bound to exactly the embedded message with `ProtocolConfig.activity_oracle` as key, pool/AMM binding, zero/future timestamp and slot rejection, and `issued_slot` re-anchored against `SlotHashes` (replay window ≈ 512 slots). Caller-supplied `last_swap_unix_ts` parameter removed (breaking instruction-data change); V4 adapter `0` sentinel and dead `PoolData.last_swap_unix_ts` field removed. Errors 6024–6031. Spec §5/D8. |
| ORACLE-003 | `sdk/src/lastSwapAttestation.ts`, `sdk/src/launchPriceAttestation.ts` (indexer service, not yet built) | 🟥 | Oracle operational runbook covering BOTH oracle flows: the on-chain verification is sound, but mainnet needs (a) a hosted indexer deriving last-swap times (`deriveLastSwapV4`) and launch-price baselines (`deriveLaunchPriceV4` — full-archive RPC required) from Raydium V4 transaction history, signing with the separate `activity_oracle` and `launch_price_oracle` keys, (b) documented key custody + rotation for both keys (multisig or isolated hot keys) and rotation drills via `update_protocol_config`, (c) freshness monitoring for C1 attestations (issuance must land within the ~512-slot `SlotHashes` window; C2 attestations have no freshness window), and (d) a documented oracle-downtime policy (evaluations stall; integrity unaffected). |

### CPI

| ID | File | Status | Description |
| --- | --- | --- | --- |
| CPI-002 | `programs/grave-scanner/src/adapters/raydium_clmm.rs` | 🟧 | Raydium CLMM pool layout parsing + tick-range reserve calculation. v1.1 milestone. |
| CPI-003 | `programs/grave-scanner/src/adapters/orca_whirlpool.rs` | 🟧 | Orca Whirlpool layout + token-vault reserve aggregation. |
| CPI-004 | `programs/grave-scanner/src/adapters/pumpswap.rs` | 🟧 | PumpSwap pool layout parsing. |
| CPI-005 | `programs/grave-scanner/src/adapters/meteora.rs` | 🟡 | Meteora DLMM / Dynamic AMM pool layout parsing. v1.1 milestone. |
| CPI-006 | `programs/grave-vault/src/cpi/raydium_clmm.rs` | 🟧 | Raydium CLMM (concentrated liquidity) `remove_liquidity` CPI for GraveVault. v1.1 milestone. Reverts with `AmmCpiUnimplemented`. |
| CPI-007 | `programs/grave-vault/src/cpi/orca_whirlpool.rs` | 🟧 | Orca Whirlpool position-burn CPI for GraveVault. v1.1 milestone. Reverts with `AmmCpiUnimplemented`. |
| CPI-008 | `programs/grave-vault/src/cpi/pump_swap.rs` | 🟧 | PumpSwap `remove_liquidity` CPI for GraveVault. v1.1 milestone. Reverts with `AmmCpiUnimplemented`. |
| CPI-010 | `programs/grave-vault/src/instructions/salvage_pool.rs` | ✅ | **Retired (Phase 3).** Base-token orientation is derived from the pool's OWN on-chain AmmInfo mints (`coin_mint`@400 / `pc_mint`@432 — offsets proven by the GraveScanner adapter and byte-verified fixtures): exactly one side must be WSOL; `base_is_coin_side` follows, and any other shape reverts `UnsupportedBaseToken` (7019) BEFORE any CPI. The submitted `lp_mint` and `memecoin_mint` are additionally bound to the pool's own bytes (`PreflightFailed` 7013). Both orientations (coin=WSOL and pc=WSOL) are proven end-to-end by the Phase 3 fork harness against real mainnet pool state (SOL/USDC `58oQCh…` and RAY/WSOL `AVs9TA…`). Spec D5 rewritten. |

### LOCKER (additional lockers)

| ID | File | Status | Description |
| --- | --- | --- | --- |
| LOCKER-002 | `programs/grave-scanner/src/adapters/locker.rs` | ⬜ | v1.0 introspects only the UNCX Raydium V4 locker (LOCKER-001). LP locked in PinkSale, Team Finance, Streamflow, or any other locker is invisible to on-chain C5 — such pools are treated as unlocked. Mitigations: the SDK must cross-check all known lockers off-chain before submitting a certification (operator-enforced); additional locker adapters are added as separate verified modules (roadmap Phase 15). |

### KEYS

| ID | File | Status | Description |
| --- | --- | --- | --- |
| KEYS-001 | `programs/grave-scanner/src/adapters/meteora.rs` | 🟧 | Confirm Meteora DLMM mainnet program ID and add a Dynamic AMM variant. Reverts with `UnsupportedAmm` if pool owner mismatches the placeholder ID. |
| KEYS-002 | `programs/grave-scanner/src/constants.rs` | 🟡 | Replace the flat `lp_burn_dust_threshold` with a percent-of-original-supply or incinerator-balance check. The flat threshold is a safe pre-mainnet floor but lets some semi-burned pools through. |
| KEYS-003 | `programs/grave-scanner/src/lib.rs` and `Anchor.toml` | 🟥 | Replace deterministic SHA-256-derived placeholder program IDs (`grave_scanner=7ZZ78chnUh5iipPgwR4L8fT8wKFmUM7kauRzjaYARr9m`, `grave_vault=FZbMHXKRsgXXoEGfSPF5gw74ThKBauThDfpCPt1MvKfw`) by running `anchor keys list && anchor keys sync` after generating real keypairs. |

### SLIP

| ID | File | Status | Description |
| --- | --- | --- | --- |
| SLIP-001 | `programs/grave-vault/src/instructions/salvage_pool.rs` | ✅ | **Retired (Phase 3).** The protocol slippage ceiling is live: when the conversion leg is active, the submitted floor `min_quote_output_lamports` must be at least the pool-implied conversion — `memecoin_received × wsol_reserve / memecoin_reserve` at the POST-withdraw reserve ratio, computable on-chain with no oracle — minus the effective cap `min(config.max_slippage_bps, HARD_MAX_SLIPPAGE_BPS, max_slippage_bps_override)` (the override can only tighten). Enforced BEFORE the swap CPI (`SlippageExceeded` 7007): a zero or otherwise losing floor can never execute. The swap-leg output floor remains as the post-CPI check. Host unit tests pin the cap derivation; fork tests prove the ceiling, the override tightening, and the atomic revert. Spec D4 amended. The route-destination integrity gap tracked alongside this row ("CPI-011" / N1) is closed by the same phase: route accounts may not reference vault custody/state accounts and the vault's WSOL destination must be present (spec §8 row 15). |

### DUST

| ID | File | Status | Description |
| --- | --- | --- | --- |
| DUST-001 | `programs/grave-vault/src/instructions/salvage_pool.rs` | 🟡 | Memecoin output below `jupiter_dust_threshold_lamports` is logged and skipped; tokens remain in the vault memecoin ATA with no closure, sweep, or recovery path, and `SalvageReceipt` carries no field for the retained amount (spec D6). Define the dust policy (Phase 4) before mainnet. |

### GOV

| ID | File | Status | Description |
| --- | --- | --- | --- |
| GOV-001 | `programs/grave-vault/src/instructions/update_protocol_config.rs` (and both `state/protocol_config.rs`) | 🟡 | The 72h parameter-change timelock is multisig-enforced (Squads transaction-buffer scheduling) only. `pending_authority`, `pending_authority_eta`, `timelock_seconds` are write-only reserved state; error 7014 `TimelockNotElapsed` is never raised (spec D2). Either wire an on-chain timelock or document the fields as explicitly reserved before mainnet. |

## How to retire a row

1. Implement the change. Replace the `PRE-MAINNET-TODO(...)` marker with
   either a `// TODO(post-launch): ...` if there is residual cleanup, or
   delete it entirely if the resolution is complete.
2. Move the row in this file under the `## Retired` section with a SHA
   reference to the implementing PR.
3. CI's pre-mainnet-todo audit (added in a follow-up PR) cross-checks
   that every grep'd marker has a matching live row in this file and
   vice versa.

## Retired

Rows retired by shipped implementations. Each entry references the
implementing PR; the merge SHA is filled in by a tiny follow-up commit
after the PR lands so the row can be tagged to its exact post-merge SHA.

| ID | File | Retired by | Merge SHA |
| --- | --- | --- | --- |
| CPI-001 | `programs/grave-scanner/src/adapters/raydium_v4.rs` | PR #13 (m4: Raydium V4 layout adapter) | `<filled by post-merge fix-up commit>` |
| CPI-009 | `programs/grave-vault/src/cpi/raydium_v4.rs` | Phase 2.1 fork harness (`programs/grave-vault/tests/raydium_v4_fork.rs`). The Raydium V4 withdraw is proven against the real mainnet bytecode: real LP burn + real reserve transfers execute end-to-end through `salvage_pool`, and scrambled / forged / malicious account submissions are rejected by the deployed V4 program. Three latent defects were found and fixed by this work: the CPI sent 18 accounts where the deployed withdraw requires 22 (padding slots at positions 8/9, filled with the pool account — live traffic verified via `scripts/probe_v4_withdraw_order.mjs`); `pool` and `lp_mint` were passed read-only while the withdraw mutates them (PrivilegeEscalationAttempt); the CPI account list lacked the callee program account (MissingAccount). Note: the original example address `9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2` is a Raydium **CLMM** pool, not V4; the harness uses the canonical V4 SOL/USDC pool `58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2`. The withdraw also burns the salvor's LP in place (salvor = `user_owner`) instead of the removed vault-LP deposit step. | `<filled by post-merge fix-up commit>` |
| CPI-010 | `programs/grave-vault/src/instructions/salvage_pool.rs` | Phase 3 (`programs/grave-vault/tests/jupiter_conversion_fork.rs`): base orientation derived from the pool's on-chain mints, `UnsupportedBaseToken` (7019) raised before any CPI, submitted mints bound to the pool bytes, both WSOL orientations proven against real mainnet pool state (SOL/USDC coin=WSOL; RAY/WSOL pc=WSOL). | `<filled by post-merge fix-up commit>` |
| CPI-011 | `programs/grave-vault/src/cpi/jupiter.rs`, `programs/grave-vault/src/instructions/salvage_pool.rs` | Phase 3 (referenced by spec rev 1.5.0 §6.3 before this row existed — the route-destination integrity gap, N1): route-account vetting (no vault custody/state account may appear in a route) + the vault's WSOL destination must be present among route accounts + the slippage ceiling forbids `floor = 0`; the delivered amount is re-checked post-CPI. Proven by the hijack / protected-account / zero-floor fork tests. | `<filled by post-merge fix-up commit>` |
| SLIP-001 | `programs/grave-vault/src/instructions/salvage_pool.rs` | Phase 3: protocol slippage ceiling wired (`config.max_slippage_bps` + `HARD_MAX_SLIPPAGE_BPS` + tighten-only `max_slippage_bps_override` all read); the submitted floor must cover the pool-implied conversion minus the cap BEFORE the swap CPI. Spec D4 amended. | `<filled by post-merge fix-up commit>` |

## Audit handoff

When handing this checklist to OtterSec / Neodyme, run
`scripts/list-pre-mainnet-todos.sh > pre-mainnet-todos.txt` and attach
it alongside this file. Auditors should treat any 🟥 row as a hard
blocker for the audit's "Production Readiness" section.
