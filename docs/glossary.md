# GraveYield glossary

Canonical v4.0 vocabulary. This file is the authoritative reference for the
terminology lint enforced by CI (`scripts/terminology-lint.sh`).

## Required terms

| Term | Meaning |
|------|---------|
| **salvage** (n., v.) | The act of permissionlessly settling a derelict pool: removing LP, swapping the recovered tokens, and distributing proceeds 40 / 40 / 20. |
| **salvor** | The actor performing a salvage. **A finder under maritime salvage law** — not a savior, not a rescuer. |
| **derelict pool** | An AMM liquidity pool that meets all six eligibility criteria (long inactivity, ≥99% price collapse, low TVL, no LP burn, no LP lock, multi-epoch confirmation). |
| **EligibilityAnchor** | On-chain PDA written by Phase 1 of `evaluate_pool` recording `first_eligible_epoch`. |
| **EligibilityCert** | On-chain PDA written by Phase 2 of `evaluate_pool` after multi-epoch confirmation. TTL = 1 hour. Consumed by `salvage_pool`. |
| **SalvageReceipt** | On-chain PDA issued at the end of a successful `salvage_pool` recording the 40/40/20 distribution. |
| **`salvage_pool`** | The GraveVault instruction that executes a salvage. |
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
