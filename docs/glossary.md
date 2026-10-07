# GraveYield glossary

Canonical v4.0 vocabulary. This file is the authoritative reference for the
terminology lint enforced by CI (`scripts/terminology-lint.sh`).

## Required terms

| Term | Meaning |
|------|---------|
| **salvage** (n., v.) | The act of permissionlessly settling a derelict pool: removing LP, swapping the recovered tokens, and distributing proceeds 40 / 40 / 20. |
| **salvor** | The actor performing a salvage. **A finder under maritime salvage law** — not a savior, not a rescuer. |
| **derelict pool** | An AMM liquidity pool that meets all six eligibility criteria (long inactivity, ≥99% price collapse, minimum residual TVL at or above the floor, no LP burn, no LP lock, multi-epoch confirmation). |
| **EligibilityAnchor** | On-chain PDA written by Phase 1 of `evaluate_pool` recording `first_eligible_epoch`. |
| **EligibilityCert** | On-chain PDA written by Phase 2 of `evaluate_pool` after multi-epoch confirmation. TTL = `ProtocolConfig.cert_ttl_seconds` (default 1 hour; governance-configurable, floored at 10 minutes). Consumed by `salvage_pool`. |
| **SalvageReceipt** | On-chain PDA issued at the end of a successful `salvage_pool` recording the 40/40/20 distribution. |
| **`salvage_pool`** | The GraveVault instruction that executes a salvage. |
| **activity oracle** | The governance-controlled public key (`ProtocolConfig.activity_oracle`) whose Ed25519 signatures authorize Criterion 1 last-swap attestations. Initialised to the protocol authority; rotatable via `update_protocol_config`. Derivation honesty and service availability are operator-enforced (spec §6.3 / D8). |
| **launch-price oracle** | The governance-controlled public key (`ProtocolConfig.launch_price_oracle`) whose Ed25519 signatures authorize Criterion 2 launch-price attestations. Deliberately separate from the activity oracle: the init-once baseline is permanently binding, so its signing key is isolated from the hotter activity key. Initialised to the protocol authority; rotatable independently (spec §6.3 / D9). |
| **launch price** | The quote-per-base price formed by a pool's vault balances immediately before the pool's first successful swap — the deployer-seeded initial market price. Stored init-once in the `LaunchPrice` PDA; only oracle-signed values are accepted (spec D9). |
| **last-swap attestation** | The 112-byte signed message (`amm_program_id ‖ pool_address ‖ last_swap_unix_ts ‖ issued_slot ‖ slot_hash`) verified in-transaction via the `ed25519_program` precompile; the sole accepted C1 inactivity evidence. |
| **launch-price attestation** | The 168-byte signed message (`amm_program_id ‖ pool_address ‖ base_mint ‖ quote_mint ‖ first_swap_slot ‖ first_swap_unix_ts ‖ launch_price_q64x64 ‖ issued_slot`) verified in-transaction via the `ed25519_program` precompile at `record_launch_price`; the sole accepted C2 baseline evidence. Carries no SlotHashes freshness check (historical fact + init-once PDA ⇒ replay is structurally impossible). |
| **`SalvageCompleted`** | The Anchor event emitted on the final state transition of `salvage_pool`. |
| **`PoolSalvaged`** | The Anchor event mirroring the pool-level outcome of a successful salvage. |

## Forbidden terms

The following words are **never** acceptable in code, comments, doc-strings,
markdown, PR titles, PR bodies, commit messages, issue titles, or UI copy:

| ❌ Forbidden | ✅ Use instead |
|--------------|----------------|
| `rescue` | `salvage` |
| `rescuer` | `salvor` |
| `dead pool` / `dead_pool` | `derelict pool` |
| `RescueReceipt` | `SalvageReceipt` |
| `rescue_pool` | `salvage_pool` |
| `RescueCompleted` | `SalvageCompleted` |
| `PoolRescued` | `PoolSalvaged` |
| `RescueInitiated` | (deprecated event; replaced by Phase 2 cert + `PoolSalvaged`) |

The forbidden list above is normative. CI fails any PR containing any of
these tokens (case-sensitive).

## Why this matters

GraveYield is **settlement infrastructure**, not a rescue programme. The
"salvor" framing is borrowed deliberately from the 1989 International
Convention on Salvage (maritime salvage law): a finder that recovers
derelict property and is compensated by formula, not a benevolent actor
acting at their discretion.

This positioning matters legally (restitution-preserving permissionless
salvage is distinguishable from autonomous harvesting), commercially
(auditors, grant reviewers, and partners read the framing), and culturally
(the protocol takes no discretion; the salvor takes none either). The
vocabulary is the shortest possible expression of that.

See [`legal-documentation.md`](legal-documentation.md) for the full legal
anchor and [`whitepaper.md`](whitepaper.md) §1 for the framing.
