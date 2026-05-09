# GraveYield Protocol

> Settlement infrastructure for economic finality on-chain.

[![CI](https://github.com/graveyieldprotocol/protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/graveyieldprotocol/protocol/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Solana 2.0](https://img.shields.io/badge/solana-2.0.x-14F195.svg)](https://docs.solanalabs.com/)
[![Anchor 0.31](https://img.shields.io/badge/anchor-0.31.x-512DA8.svg)](https://www.anchor-lang.com/)

GraveYield is the **settlement layer for derelict liquidity** on Solana. When AMM pools cross all
six derelict-pool criteria — long inactivity, ≥99% price collapse, low TVL, no LP burn or lock,
and multi-epoch confirmation — anyone (the **salvor**) can permissionlessly settle the position:
remove the LP, swap the recovered tokens, and distribute the proceeds 40/40/20 to original LP
holders, the salvor, and the protocol.

GraveYield is **deterministic**, **non-custodial**, and **takes no discretion**. The salvor is a
finder under maritime salvage law, not a savior. There is no token, NFT, points programme,
airdrop, or staking layer.

## Repository layout

```
protocol/
├── programs/
│   ├── grave-scanner/      # Anchor: eligibility evaluation, two-phase certification
│   └── grave-vault/        # Anchor: salvage execution, settlement, claims
├── sdk/                    # TypeScript salvor SDK
├── indexer/                # Off-chain GraveScanner v2 (TypeScript)
├── adapters/               # Locker adapters (UNCX, PinkSale, TeamFinance) — future
├── docs/                   # Canonical specifications (living markdown source of truth)
│   └── published/          # Original .docx / .pdf snapshots
├── scripts/                # Toolchain checks, deployment helpers
└── tests/                  # Anchor + SDK integration tests
```

## Toolchain

Pinned defaults:

| Tool       | Version    |
|------------|------------|
| Solana CLI | 2.0.x      |
| Anchor     | 0.31.x     |
| Rust       | 1.79+ (stable) |
| Node       | 20 LTS     |
| pnpm       | 9          |

Run `./scripts/check-toolchain.sh` to verify your local installation.

## Quickstart

```bash
# Install JS workspace deps
pnpm install

# Build Anchor programs (requires Solana 2.0.x + Anchor 0.31.x)
anchor build

# Run TypeScript typecheck across all packages
pnpm -r typecheck

# Run Rust formatting + lint checks
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings

# Run Anchor tests (devnet localnet)
anchor test
```

## Canonical specifications

All design intent lives in [`docs/`](docs/) as markdown — this is the **living source of truth**.
The original `.docx` deliverables and the `.pdf` research paper are preserved in
[`docs/published/`](docs/published/) as immutable references for the v4.0 / v3.0 / WP-2026-001r3
publishing snapshot.

| Document | Living source | Published snapshot |
|----------|---------------|--------------------|
| Whitepaper v4.0 | [`docs/whitepaper.md`](docs/whitepaper.md) | `docs/published/GraveYield_Whitepaper_v4_0.docx` |
| Technical Documentation v3.0 | [`docs/technical-documentation.md`](docs/technical-documentation.md) | `docs/published/GraveYield_TechnicalDocumentation_v3_0.docx` |
| GraveScanner × GraveVault Combined v3.0 | [`docs/grave-scanner-grave-vault-combined.md`](docs/grave-scanner-grave-vault-combined.md) | `docs/published/GraveScanner_GraveVault_CombinedTechnicalDocumentation_v3_0.docx` |
| Legal Documentation v3.0 | [`docs/legal-documentation.md`](docs/legal-documentation.md) | `docs/published/GraveYield_LegalDocumentation_v3_0.docx` |
| Liquidity Salvage Visual Deck | — | `docs/published/GraveYield_Liquidity_Salvage.pdf` |
| GhostPools Research WP-2026-001r3 | [`docs/ghostpools-research.md`](docs/ghostpools-research.md) (cover) | `docs/published/GhostPools_Research_Paper_WP-2026-001r3.docx` |

## Locked invariants

These are **Charter-level prohibitions** — governance cannot raise or remove them.

- **20% protocol share is a ceiling**, not a target. Cannot be increased.
- **`lp_holder_pool_vault` is unsweepable** by any admin key, ever.
- **72h timelock** on all parameter changes; **7-day public notice** on standard upgrades.
- **Emergency upgrades** require 24h timelock and a 5-day post-mortem.
- **Squads v4 multisig** 3-of-5 at launch, scaling to 4-of-7 post-audit.
- **No token, NFT, points, airdrop, or staking** at any layer.

See [`docs/architecture/charter-invariants.md`](docs/architecture/charter-invariants.md) for the
full set.

## Terminology

GraveYield uses **maritime salvage** vocabulary deliberately. The protocol settles — it does
not save. Use these terms exclusively in code, comments, docs, PRs, commit messages, and
conversation:

- **salvage** (noun, verb) — the act of permissionlessly settling a derelict pool
- **salvor** — the actor performing the salvage (a finder under maritime law)
- **derelict pool** — an AMM pool meeting all six eligibility criteria
- `salvage_pool`, `SalvageReceipt`, `SalvageCompleted`, `PoolSalvaged`

See [`docs/glossary.md`](docs/glossary.md) for the canonical mapping.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). All commits must be signed; `main` is protected and
requires one approving review.

## Security

See [`SECURITY.md`](SECURITY.md) for responsible disclosure. Phase 2 audit + Immunefi bug bounty
will activate at devnet release.

## License

[Apache License 2.0](LICENSE) — open-infrastructure framing required by the maritime salvage
positioning, the Solana Foundation grant programme, and Colosseum.
