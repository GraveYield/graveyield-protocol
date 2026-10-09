# Charter invariants — what governance cannot change

The prohibition layer of the GraveYield Protocol: commitments that are
either enforced by program bytecode or fixed by the Charter as process law
that governance operates under, never above.

> **Scope.** This is the full list with rationale. The short version in the
> root README and the normative text in
> [`../PROTOCOL_SPEC.md`](../PROTOCOL_SPEC.md) defer to the Rust sources for
> what is bytecode-enforced; [`../error_codes.md`](../error_codes.md) maps
> the tripwires. Related deep-dives:
> [`eligibility-anchors.md`](eligibility-anchors.md),
> [`priority-fee-policy.md`](priority-fee-policy.md).

## 1. The invariants

| # | Invariant | Enforcement | Tripwire / mechanism |
|---|-----------|-------------|----------------------|
| 1 | **The 20% protocol share is a ceiling, not a target.** Governance may lower it (72h timelock, multisig-enforced) but can never raise it. | Bytecode | `update_protocol_config` rejects any `protocol_share_bps` above 2,000 — `ProtocolShareExceedsCeiling` (7005). The share is also computed as the settlement remainder, so it cannot quietly exceed its configured value. |
| 2 | **`lp_holder_pool_vault` is unsweepable by any admin key, ever.** Emergency pause does not affect this. | Bytecode (structural) | No instruction path other than Merkle-verified `claim_lp_proceeds` can debit the bucket. The dedicated error `LpHolderPoolUnsweepable` (7006) is a reserved tripwire: v1.0 contains no sweep call site at all, so the invariant is enforced by absence of code, not by a check that could be removed. |
| 3 | **`claim_lp_proceeds` stays live during emergency pause.** Original LPs can always withdraw their settled share. | Bytecode | The claim path does not read the pause flag; `emergency_pause` gates only new `salvage_pool` calls. Restitution is therefore never hostage to governance. |
| 4 | **No token, NFT, points programme, airdrop, or staking at any layer.** | Charter / design | Nothing to enforce in bytecode: no mint authority exists, no token program is invoked, no staking state exists. Adding one would require a program upgrade, which runs into invariant 5. |
| 5 | **Standard upgrades require 7-day public notice + 72h timelock.** | Charter (process) | Multisig-operated commitment (Squads v4 transaction buffers); not program-enforced in v1.0 (GOV-001 tracks the on-chain timelock option). |
| 6 | **Emergency upgrades require 24h timelock + 5-day public post-mortem.** | Charter (process) | As above — a governance commitment, documented rather than hidden. |
| 7 | **72-hour timelock on all parameter changes.** | Charter (process) + bounded on-chain config | `update_protocol_config` bounds every parameter (invariant-violating updates revert with `InvariantViolation`, 6006 / `CertTtlBelowMinimum`, 6019); the *delay* itself is multisig scheduling in v1.0. |
| 8 | **Multisig custody: 3-of-5 at launch, scaling to 4-of-7 post-audit.** | Charter (process) | Devnet currently runs a single deployer keypair by testnet-agility design; the mainnet transition is tracked as KEYS-003. No devnet artifact is a proxy for mainnet custody. |
| 9 | **One settlement per pool, ever.** | Bytecode | Init-once PoolRegistry and SalvageReceipt PDAs; a second successful salvage reverts before any lamports move. |
| 10 | **Restitution is structural, not discretionary.** | Bytecode | The 40% LP-holder share is a default split parameter that can be lowered by governance within bounded ranges — but the bucket it funds is unsweepable (invariant 2) and claims never expire (invariant 3), so the value can only ever reach snapshot-verified holders. |

## 2. Why these ten

Each invariant blocks a specific failure mode that permissionless salvage
infrastructure would otherwise be exposed to:

- **Invariants 1, 10** — the protocol's own economics. A salvage protocol
  that could raise its own fee, or reroute restitution, would be an
  expropriation machine with extra steps. The ceiling converts the
  protocol's take from a governance question into a constant.
- **Invariants 2, 3** — the restitution guarantee. The LP-holder bucket is
  the structural commitment that makes the protocol
  *restitution-preserving* rather than autonomous harvesting (see the
  research paper, [`../ghostpools-research.md`](../ghostpools-research.md)
  §13.1, on the salvage permission spectrum). Admin-sweepable restitution
  is no restitution.
- **Invariants 5, 6, 7, 8** — governance capture resistance. Timelocks,
  notice periods and multisig scaling give LP holders and salvors time to
  react to any proposed change before it lands.
- **Invariants 4, 9** — scope honesty. No token keeps the protocol out of
  securities/utility-token ambiguity; one-settlement-per-pool keeps the
  protocol a terminal-state settler rather than a liquidity manager.

## 3. What a PR touching any of this means

Per [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md): a PR that touches a
Charter invariant is automatically out-of-scope for normal review and must
be flagged for governance discussion **before any code is written**.
Concretely:

- Changing `protocol_share_bps` bounds, the unsweepability of
  `lp_holder_pool_vault`, the claim-during-pause property, or the
  one-settlement guarantee → governance escalation, not review.
- Adding any token/NFT/points/airdrop/staking surface → rejected at
  triage; there is no governance path for it in v1.0.
- Changing process commitments (timelocks, notice, multisig policy) → a
  Charter revision, which requires the same public-notice machinery the
  Charter itself mandates.

## 4. Bytecode-enforced vs process-enforced: the honest split

The protocol's documentation deliberately distinguishes the two enforcement
layers, because conflating them would overstate guarantees:

| Layer | Invariants | Failure mode if governance defects |
|-------|------------|------------------------------------|
| Bytecode | 1, 2, 3, 9 (+ bounded config in 7) | Requires a program upgrade — which is itself gated by 5/6/8. Defense in depth. |
| Process | 4 (design absence), 5, 6, 7 (delay), 8 | No runtime tripwire; the multisig and public record are the enforcement. Auditors and LP holders should verify multisig membership and Squads configuration directly. |

The 72-hour timelock deserves its own note: on-chain fields for a timelock
are reserved but write-only in v1.0, and the `TimelockNotElapsed` error
(7014) is reserved, never raised. Until an on-chain timelock ships (GOV-001),
the delay is real only as long as the multisig scheduling discipline holds —
and the documentation says so everywhere it mentions the timelock.
