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

## Live checklist (v0.1.0)

Status legend: 🟥 blocking · 🟧 high-priority · 🟡 medium · ⬜ tracking only.

### LOCKER

| ID | File | Status | Description |
| --- | --- | --- | --- |
| LOCKER-001 | `programs/grave-scanner/src/adapters/locker.rs` | 🟥 | UNCX / PinkSale / Team Finance locker program IDs + account layout introspection. Reverts with `LockerAdapterUnimplemented` until wired. Verify: public docs and on-chain artifacts; cross-check against `adapters/locker_release_*.rs` (GraveVault) once those land. |

### ORACLE

| ID | File | Status | Description |
| --- | --- | --- | --- |
| ORACLE-001 | `programs/grave-scanner/src/instructions/record_launch_price.rs` | 🟧 | Cross-check `launch_price_q64x64` against on-chain pool reserves at the supplied `first_swap_slot` rather than trusting the caller. Reverts with `PoolDataParseError` on mismatch. Verify against AMM transaction history at the recorded slot. |
| ORACLE-002 | `programs/grave-scanner/src/instructions/evaluate_pool_phase1.rs` (also Phase 2) | 🟥 | Cryptographic proof of last-swap timestamp. Currently passed as a parameter and trusted; production handler must verify via adapter-provided last-swap proof or signed indexer attestation. Raydium V4 adapter (m4) returns `0` as a sentinel since AmmInfo doesn't carry a last-swap timestamp — handler still reads the param until this row retires. |

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
| CPI-009 | `programs/grave-vault/src/cpi/raydium_v4.rs` | 🟥 | Verify Raydium V4 withdraw account ordering against a live mainnet pool (e.g. `9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2`) via `solana-program-test` fork test before mainnet. The `amm_authority` constant check catches an obviously-wrong layout but not subtle swaps. |

### KEYS

| ID | File | Status | Description |
| --- | --- | --- | --- |
| KEYS-001 | `programs/grave-scanner/src/adapters/meteora.rs` | 🟧 | Confirm Meteora DLMM mainnet program ID and add a Dynamic AMM variant. Reverts with `UnsupportedAmm` if pool owner mismatches the placeholder ID. |
| KEYS-002 | `programs/grave-scanner/src/constants.rs` | 🟡 | Replace the flat `lp_burn_dust_threshold` with a percent-of-original-supply or incinerator-balance check. The flat threshold is a safe pre-mainnet floor but lets some semi-burned pools through. |
| KEYS-003 | `programs/grave-scanner/src/lib.rs` and `Anchor.toml` | 🟥 | Replace deterministic SHA-256-derived placeholder program IDs (`grave_scanner=7ZZ78chnUh5iipPgwR4L8fT8wKFmUM7kauRzjaYARr9m`, `grave_vault=FZbMHXKRsgXXoEGfSPF5gw74ThKBauThDfpCPt1MvKfw`) by running `anchor keys list && anchor keys sync` after generating real keypairs. |

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

## Audit handoff

When handing this checklist to OtterSec / Neodyme, run
`scripts/list-pre-mainnet-todos.sh > pre-mainnet-todos.txt` and attach
it alongside this file. Auditors should treat any 🟥 row as a hard
blocker for the audit's "Production Readiness" section.
