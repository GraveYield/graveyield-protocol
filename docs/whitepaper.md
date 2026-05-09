# GraveYield Whitepaper v4.0

> **Status**: living source of truth. Snapshot in `published/GraveYield_Whitepaper_v4_0.docx`.
> Last canon-locked: May 2026.

This file mirrors and supersedes the v4.0 .docx snapshot. When this file and
the .docx disagree, this file wins; the .docx will be re-rendered at the
next minor revision.

## 1. Premise

GraveYield is the settlement layer for **derelict liquidity** on Solana.
It is settlement infrastructure under maritime salvage framing — not a
discretionary intervention. When an AMM liquidity pool crosses all six
derelict-pool criteria — long inactivity, ≥99% price collapse from
launch, residual TVL below threshold, LP not burned, LP not locked, and
multi-epoch confirmation — anyone may permissionlessly settle the pool by
removing the LP, swapping the recovered tokens, and distributing the
proceeds 40 / 40 / 20 to the original LP holders, the salvor, and the
protocol.

The actor performing the salvage is a **salvor** — a finder under maritime
salvage law (1989 International Convention on Salvage). The framing is
deliberate. A salvor takes no discretion: eligibility is on-chain,
distribution is on-chain, and compensation is by formula.

## 2. What GraveYield is not

- Not a yield-farming protocol.
- Not a liquidity-management or rebalancing tool.
- Not a token: there is no GRAVE, GY, or any token at any layer.
- Not a points programme, NFT, airdrop, or staking layer.
- Not discretionary: the protocol takes no governance over which pools
  qualify; the six criteria are objective on-chain conditions.
- Not a discretionary actor: original LPs do not require GraveYield's
  mercy. They retain their pro-rata claim on the post-salvage proceeds
  via `claim_lp_proceeds`, which stays live even during emergency pause.

## 3. Eligibility — the six derelict-pool criteria

| # | Criterion | Default threshold |
|---|-----------|-------------------|
| 1 | Trading inactivity | ≥ 90 days since last swap |
| 2 | Price collapse from launch | ≥ 99% in basis points (9_900 bps) |
| 3 | Residual TVL | < 0.5 SOL |
| 4 | LP not burned | (boolean) |
| 5 | LP not locked | (boolean) |
| 6 | Multi-epoch confirmation | ≥ 2 consecutive Solana epochs |

Criteria 1-5 are evaluated against on-chain pool state. Criterion 6 is the
v4.0 addition: a Phase 1 `EligibilityAnchor` PDA records the first epoch
in which all five other criteria pass; a Phase 2 `EligibilityCert` PDA can
only be issued ≥ 2 epochs later, after re-verification. This forecloses a
salvor from racing flicker conditions.

See [`architecture/eligibility-anchors.md`](architecture/eligibility-anchors.md)
for the full two-phase flow.

## 4. Distribution — 40 / 40 / 20

Proceeds from a successful `salvage_pool` are split:

- **40%** → `lp_holder_pool_vault` PDA, claimable pro-rata by original LP
  holders against the snapshot Merkle root.
- **40%** → the salvor (the signer who submitted `salvage_pool`).
- **20%** → the protocol treasury PDA, governed by the multisig.

The 20% protocol share is a **Charter ceiling**, not a target. Governance
may lower it, but `update_protocol_config` rejects any attempt to raise it.

## 5. Charter invariants

These are protocol-level prohibitions, encoded as `const` in code and
asserted at every relevant code path:

- 20% protocol share is a ceiling, not a target.
- `lp_holder_pool_vault` is unsweepable by any admin key, ever.
- 72h timelock on all parameter changes.
- 7-day public notice on standard upgrades.
- 24h timelock + 5-day public post-mortem on emergency upgrades.
- `claim_lp_proceeds` stays live during emergency pause.
- Squads v4 multisig 3-of-5 at launch, 4-of-7 post-audit.
- No token, NFT, points, airdrop, or staking — at any layer.

The full set lives in [`architecture/charter-invariants.md`](architecture/charter-invariants.md).

## 6. Why this exists

> See [`ghostpools-research.md`](ghostpools-research.md) and the WP-2026-001r3
> research paper for the empirical analysis. Briefly: a non-trivial fraction
> of LP value sits in pools that meet every objective definition of
> "derelict," and currently has no settlement path that preserves the
> original LP holder's claim. GraveYield provides one.

## 7. Roadmap

The build sequence is broken into ten milestones (m1-m10). The first eight
deliver mainnet salvage on Raydium V4. m9 is the off-chain indexer; m10 is
locker adapters for UNCX, PinkSale, and Team Finance. See
[`grave-scanner-grave-vault-combined.md`](grave-scanner-grave-vault-combined.md)
for the per-milestone breakdown.

---

*This document is the canonical Whitepaper v4.0 living source. The
matching .docx snapshot is in `published/GraveYield_Whitepaper_v4_0.docx`.*
