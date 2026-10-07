# GraveYield Protocol Specification — v1.0.0 (Phase 0 freeze)

> **Status:** frozen specification. This file is the single written
> specification required by the Phase 0 exit condition. When any other
> document disagrees with this file, **this file wins** until a spec PR
> revises both.
>
> **Baseline:** `main @ 4b8e0b1`. Scope: Solana, Raydium V4 only.
> Precedence order: this file → `docs/whitepaper.md` → `README.md` →
> everything else.
>
> **Revisions:** rev 1.3.0 — Phase 1.3: C2 evidence implemented
> (oracle-signed 168-byte Ed25519 launch-price attestation, ORACLE-001
> retired; new `launch_price_oracle` config field; launch price defined
> as the pre-first-swap reserve ratio; §2.1, §4 C2, §5, §6.1/6.3/6.4,
> §7 D9, §8 row 12, §9 updated; breaking change to the
> `record_launch_price` instruction data). rev 1.2.0 — Phase 1.2: C1
> evidence implemented (indexer-signed Ed25519 last-swap attestation,
> ORACLE-002 retired; new `activity_oracle` config field; §4 C1, §5,
> §6.1/6.3, §7 D8, §8 row 11, §9 updated; breaking change to the
> `evaluate_pool_*` instruction data). rev 1.1.0 — Phase 1.1: C5
> evidence implemented (UNCX Raydium AMM V4 locker adapter, LOCKER-001
> retired; §4 C5, §5, §6, §8 row 10 updated). All other sections
> unchanged from the Phase 0 freeze.

## 0. Purpose

This specification answers exactly three questions:

1. **What makes a pool derelict** (§4 — the six criteria, exact semantics).
2. **Who proves it** (§5 — authoritative evidence sources, per criterion).
3. **What the protocol guarantees** (§6 — enforcement matrix: what is
   on-chain-enforced, governance-enforced, and SDK/operator-enforced).

Phase 0 rule: **no new protocol features** until every open item in §7
(Resolved decisions) and §8 (Discrepancy ledger) is settled. Engineering
work proceeds against the blockers referenced in
`docs/PRE_MAINNET_CHECKLIST.md` only.

## 1. Terminology

Canonical vocabulary lives in `docs/glossary.md` and is CI-enforced. The
terms used normatively in this file:

- **salvor** — the permissionless actor submitting evaluation and salvage
  transactions. A finder under maritime salvage law, compensated by
  formula, with no discretion.
- **derelict pool** — an AMM liquidity pool for which all six criteria in
  §4 hold simultaneously.
- **salvage** — the act of settling a derelict pool: deposit-and-burn LP,
  withdraw underlying tokens, convert to WSOL/SOL, distribute 40/40/20.
- **EligibilityAnchor** — Phase 1 PDA recording `first_eligible_epoch`.
- **EligibilityCert** — Phase 2 PDA authorising one salvage window.
- **residual TVL** — the pool's quote-side vault balance in lamports
  (v1.0: WSOL quote side only). See decision D1.

## 2. Frozen architecture

The following is the complete v1.0 architecture. It is **frozen**: any PR
that adds an instruction, PDA, adapter, or config field without a spec
revision is out of scope.

### 2.1 On-chain programs

**GraveScanner** (`programs/grave-scanner`) — eligibility state machine.

| Instruction | Effect |
|---|---|
| `initialize` | Creates `ProtocolConfig` (thresholds, cert TTL, pause flag). |
| `record_launch_price` | Creates the init-once `LaunchPrice` PDA (Criterion 2 baseline) — only from an oracle-signed Ed25519 attestation (D9). |
| `evaluate_pool_phase_1` | Evaluates all six criteria; writes `EligibilityAnchor` stamped with `first_eligible_epoch`. |
| `evaluate_pool_phase_2` | Re-evaluates all six criteria after the epoch gap; requires bitmap equality with the anchor; issues `EligibilityCert`. |
| `invalidate_anchor` | Multisig-only: marks an anchor `invalidated` (censors a wrong Phase 1 pass). |
| `sweep_stale_anchor` | Permissionless rent reclaim for uncertified anchors older than `anchor_staleness_seconds` (default 14 days). |
| `update_protocol_config` | Multisig-only threshold updates, bounded (cert TTL floor 600s; collapse bps ≤ 10_000). |
| `emergency_pause` | Multisig-only pause flag; gates `evaluate_pool_*` only. |

**GraveVault** (`programs/grave-vault`) — settlement.

| Instruction | Effect |
|---|---|
| `initialize` | Creates `ProtocolConfig` (40/40/20 shares, fee/slippage/dust params, pause flag). |
| `salvage_pool` | The settlement instruction (§3). One salvage per pool, ever (init-on-PDA defenses). |
| `claim_lp_proceeds` | Merkle-verified pro-rata withdrawal from `lp_holder_pool_vault`. Live during pause. |
| `update_protocol_config` | Multisig-only share/parameter updates (protocol share ceiling 20% enforced on-chain). |
| `emergency_pause` | Multisig-only pause flag; gates `salvage_pool` only. |

### 2.2 PDA map

| PDA | Program | Seeds | Mutability |
|---|---|---|---|
| `ProtocolConfig` | both | `["protocol_config"]` | governance-writable |
| `LaunchPrice` | scanner | `["launch_price", amm_program_id, pool]` | init-once |
| `EligibilityAnchor` | scanner | `["eligibility_anchor", amm_program_id, pool]` | once per anchor epoch; sweepable when stale |
| `EligibilityCert` | scanner | `["eligibility_cert", amm_program_id, pool]` | init-once (lifecycle defect B4 — see §8) |
| `PoolRegistry` | vault | `["pool_registry", pool]` | init-once at salvage |
| `SalvageReceipt` | vault | `["salvage_receipt", pool]` | init-once at salvage |
| `lp_holder_pool_vault` | vault | `["lp_holder_pool", pool]` | system-owned; only `claim_lp_proceeds` debits |
| `vault_sol_holding` | vault | `["vault_sol_holding", pool]` | transient per-salgae holding; drained to zero by distribution |
| `vault_authority` | vault | `["vault_authority"]` | signer-only PDA (CPIs, WSOL close, distributions) |
| `protocol_treasury` | vault | `["protocol_treasury"]` | receives protocol share |
| `ClaimRecord` | vault | `["claim_record", pool, holder]` | init-once; double-claim defense |

### 2.3 Off-chain components (status, not scope)

- **SDK** (`sdk/`): priority-fee policy implemented; `evaluatePool`,
  `snapshotLpHolders`, `buildCertifyAndSalvage` are stubs.
- **Indexer** (`indexer/`): scaffold only (Phase 9 scope).
- **LP snapshotter / Merkle tree builder / proof generator**: missing
  (Phase 5 scope).
- **Salvor bot**: does not exist yet (Phase 10 scope).

## 3. Lifecycle (normative)

```
record_launch_price (once per pool)
        |
        v
evaluate_pool_phase_1 ── all six criteria pass? ──> EligibilityAnchor
        |                                              (first_eligible_epoch = E0)
        x (reject: no state written)
                                                       |
                                  >= MIN_EPOCH_CONFIRMATION (2) epochs
                                                       |
                                                       v
evaluate_pool_phase_2 ── six criteria re-pass AND bitmap == anchor? ──> EligibilityCert
        |                                                                (expires_at = now + cert_ttl_seconds)
        x (reject / EpochConfirmationPending / CriteriaBitmapMismatch)
                                                       |
                                                       v  (before expires_at)
salvage_pool:
  pre-flight: !paused; cert fresh; cert bitmap == 0x3F;
              cert binds (amm_program_id, pool_address); pool key matches
  execute:   lazy-init system PDAs -> LP transfer salvor -> vault ->
             Raydium V4 withdraw (full vault LP balance) ->
             [memecoin >= dust threshold ? Jupiter v6 swap memecoin->WSOL
              + swap-leg floor check : skip and log] ->
             close vault WSOL ATA -> lamports into vault_sol_holding ->
             40/40/20 distribution (remainder -> protocol) ->
             PoolRegistry + SalvageReceipt + events
                                                       |
                                                       v
claim_lp_proceeds: Merkle proof (holder, balance_at_snapshot) against
  registry root -> pro-rata lamports -> ClaimRecord (once per holder)
```

A pool is settled **at most once**: `PoolRegistry` and `SalvageReceipt`
are `init`-constrained to the same pool PDA, so a second `salvage_pool`
reverts before any lamports move.

## 4. What makes a pool derelict — the six criteria

All six criteria are evaluated by one pure function
(`grave-scanner/src/criteria.rs`) at both phases. Thresholds come from
`ProtocolConfig`; defaults below are the launch values. The evaluator is
all-or-nothing: the first failed criterion aborts evaluation
(`PoolNotEligible` or a more specific error), and a passing evaluation
returns the full bitmap `0x3F`.

**C1 — Trading inactivity.**
`current_unix_ts − last_swap_unix_ts ≥ inactivity_seconds`.
Default: 90 days (`7_776_000`s). Equality passes. `current_unix_ts` is
`Clock::unix_timestamp`; a clock earlier than the last swap reverts
`InvalidClock`.

*Evidence (Phase 1.2, decision D8):* `last_swap_unix_ts` is carried by a
**112-byte Ed25519-signed attestation** issued by the protocol activity
oracle (`ProtocolConfig.activity_oracle`) and verified on chain inside
the evaluation instruction via the `ed25519_program` precompile —
see §5. A caller-supplied integer is no longer an accepted input.
Related reverts: `AttestationMissing` (6024),
`InvalidAttestationOffsets` (6025), `AttestationOracleMismatch` (6026),
`AttestationBindingMismatch` (6027), `AttestationTimestampInvalid`
(6028), `AttestationStale` (6029), `AttestationSlotHashMismatch`
(6030), `AttestationSlotInvalid` (6031).

**C2 — Price collapse from launch.**
Requires a recorded launch price (`launch_price_q64x64 > 0`, else
`LaunchPriceNotFound`). Drop is
`floor((launch − current) × 10_000 / launch)` in Q64.64, clamped to
[0, 10_000]. Passes iff `drop_bps ≥ price_collapse_bps`. Default:
9_900 bps (99%). A pool that re-floated (current ≥ launch) yields 0 bps
and fails. `current = 0` yields 10_000 bps and passes.

*Definition of "launch price" (D9):* the quote-per-base price formed by
the pool's vault balances **immediately before the pool's first
successful swap** — the deployer-seeded initial market price. Recorded
once per pool into the init-once `LaunchPrice` PDA, and only from an
oracle-signed attestation (see §5). The evaluation handlers additionally
re-check that the recorded `(base_mint, quote_mint)` pair equals the
live pool's parsed mints (`LaunchPriceMintMismatch`, 6033) before the
price may feed the collapse math.

*Evidence (Phase 1.3, decision D9):* `launch_price_q64x64` is carried by
a **168-byte Ed25519-signed attestation** issued by the protocol
launch-price oracle (`ProtocolConfig.launch_price_oracle`) and verified
on chain inside `record_launch_price` via the `ed25519_program`
precompile — see §5. A caller-supplied price is accepted only when it
byte-exactly echoes the attested price. Related reverts:
`AttestationMissing` (6024), `InvalidAttestationOffsets` (6025),
`AttestationOracleMismatch` (6026), `AttestationBindingMismatch`
(6027), `InvalidLaunchPrice` (6032), `LaunchPriceMintMismatch` (6033).
Unlike C1 there is no SlotHashes freshness check: the launch price is a
time-invariant historical fact and the PDA is init-once, so replaying an
old-but-valid attestation cannot overwrite anything (the second `init`
fails).

**C3 — Minimum residual TVL.**
`current_tvl_lamports ≥ min_tvl_lamports`. Default: 0.5 SOL
(`500_000_000` lamports). **Direction is normative and was previously
stated inverted in the whitepaper and glossary** — see D1. A derelict
pool must still hold value worth settling; pools below the floor are out
of scope because the 40/40/20 proceeds cannot justify settlement costs.

**C4 — LP supply not burned.**
`lp_supply > lp_burn_dust_threshold` (strict `>`). Default threshold:
1_000 raw LP tokens. A supply equal to or below the threshold is treated
as fully burned (nothing left to withdraw). `lp_supply` is read from the
LP mint's SPL supply field.

**C5 — LP not locked.**
`lp_locked_amount == 0` — exactly zero. One locked smallest unit fails
the pool. Locked LP cannot be deposited and burned by the salvor, so any
lock makes settlement impossible. Evidence status: implemented in Phase
1.1 for the UNCX Raydium V4 locker (see §5); other lockers are out of
v1.0 scope (LOCKER-002).

**C6 — Multi-epoch confirmation.**
Phase 1 stamps `first_eligible_epoch = current_epoch` into the anchor.
Phase 2 requires `current_epoch − first_eligible_epoch ≥
MIN_EPOCH_CONFIRMATION` (2 epochs, ~4–6 days) and additionally requires
the Phase 2 bitmap to equal the Phase 1 bitmap
(`CriteriaBitmapMismatch` otherwise — a parameter change or adapter drift
between phases forbids certification). Phase 2 without an anchor reverts
`AnchorNotFound`; an invalidated anchor reverts `AnchorInvalidated`.

## 5. Who proves it — authoritative evidence sources

For each criterion input: the source today, and the frozen requirement it
must satisfy before mainnet.

| # | Input | Source today | Status |
|---|---|---|---|
| C1 | `last_swap_unix_ts` | **Indexer-signed Ed25519 attestation** (Phase 1.2): 112-byte message `amm_program_id ‖ pool_address ‖ last_swap_unix_ts ‖ issued_slot ‖ slot_hash`, signed by `ProtocolConfig.activity_oracle`, verified in-transaction through the `ed25519_program` precompile; `issued_slot` must resolve in `SlotHashes` with a byte-exact hash match. | **On-chain cryptographic (ORACLE-002 resolved).** Residual trust (documented, §6.3): the oracle's honesty about the derivation and the indexer's availability. |
| C2 | `launch_price_q64x64` | **Oracle-signed Ed25519 attestation** (Phase 1.3): 168-byte message `amm_program_id ‖ pool_address ‖ base_mint ‖ quote_mint ‖ first_swap_slot ‖ first_swap_unix_ts ‖ launch_price_q64x64 ‖ issued_slot`, signed by `ProtocolConfig.launch_price_oracle`, verified in-transaction through the `ed25519_program` precompile at `record_launch_price`; the params echo of the attested price is mandatory. | **On-chain cryptographic (ORACLE-001 resolved).** Residual trust (documented, §6.3): the oracle's honesty about the historical derivation, the indexer's archive availability, and the init-once semantics (a mis-recorded baseline is permanent). |
| C2 | `current_price_q64x64` | Derived on-chain: `(quote_reserve << 64) / base_reserve` from the pool's vault balances, after adapter validation (vault ownership = SPL Token program; vault mint == pool-declared mint). | Authoritative (spot price; manipulation analysis below). |
| C3 | `current_tvl_lamports` | Quote-side vault balance, read on-chain from the SPL token account located by the pool's own `pc_vault` pointer. | Authoritative. |
| C4 | `lp_supply` | LP mint SPL supply, read on-chain from the account located by the pool's own `lp_mint` pointer. | Authoritative. |
| C5 | `lp_locked_amount` | UNCX Raydium V4 locker adapter (Phase 1.1): per-pool marker PDA `\["global_lp_tracker", amm_id\]` + strictly validated `TokenLock` PDAs; live amount = Σ `current_locked_amount`. | **On-chain sound; completeness SDK/operator-enforced — see frozen requirement below.** |
| C6 | epochs + anchor | `Clock::epoch` + `EligibilityAnchor` PDA state. | Authoritative. |

**Adapter trust boundary (frozen).** The pool account must equal
`params.pool_address`, must be exactly 752 bytes, and must be owned by
the Raydium V4 program. Vaults and the LP mint are located by public keys
read from the pool account itself (not by caller order), validated for
SPL ownership and mint consistency. `remaining_accounts` may be supplied
in any order; missing accounts revert.

**Price manipulation analysis (accepted residual risk).** Spot price is
manipulable only by moving real reserves. Making a derelict pool look
alive (blocking salvage) requires buying into it — capital the manipulator
loses to the eventual salvage. Deepening the drop does not help an
attacker (it only makes C2 easier). C2 therefore has no profitable attack
path; the residual risk is griefing, accepted for v1.0.

**Frozen requirements for the trusted inputs:**

- **C1 (ORACLE-002, resolved in Phase 1.2):** the frozen requirement
  "never a signer-supplied integer" is implemented as an Ed25519
  attestation whose signing key is protocol-registered
  (`ProtocolConfig.activity_oracle`, rotatable via
  `update_protocol_config`, initialised to the protocol authority).
  The on-chain check binds the signature to exactly the 112-byte
  message embedded in the instruction data (canonical offsets in
  `grave-scanner/src/attestation.rs`), to the `(amm_program_id,
  pool_address)` pair, to a non-future timestamp, and to a slot still
  present in `SlotHashes` (replay window ≈ 512 slots ≈ 3.4 min). The
  derivation itself (Raydium V4 transaction history via RPC,
  `sdk/src/lastSwapAttestation.ts::deriveLastSwapV4`) and the oracle's
  operational availability remain SDK/operator-enforced (§6.3).
  *Breaking change:* `evaluate_pool_phase_1` / `_2` instruction data
  replaced the `last_swap_unix_ts: i64` parameter with
  `msg: [u8; 112]` and gained `instruction_sysvar` + `slot_hashes`
  accounts.
- **C2 (ORACLE-001, resolved in Phase 1.3):** the frozen requirement
  "no writer class may set the baseline without an on-chain check" is
  implemented as an Ed25519 attestation whose signing key is
  protocol-registered (`ProtocolConfig.launch_price_oracle`, rotatable
  via `update_protocol_config`, initialised to the protocol authority,
  deliberately separate from the hotter `activity_oracle` key). The
  on-chain check binds the signature to exactly the 168-byte message
  embedded at the end of the `record_launch_price` instruction data
  (canonical offsets in `grave-scanner/src/attestation.rs`), to the
  `(amm_program_id, pool_address, base_mint, quote_mint,
  launch_price_q64x64)` echo, to a strictly positive price, and to sane
  first-swap timestamp/slot and issuance-slot values. There is no
  SlotHashes freshness check by design (historical fact + init-once PDA
  ⇒ replay is structurally impossible). Both evaluation handlers
  re-check the recorded mint pair against the live pool before C2 can
  consume the price. The derivation itself (Raydium V4 transaction
  history via a full-archive RPC,
  `sdk/src/launchPriceAttestation.ts::deriveLaunchPriceV4`) and the
  oracle's operational availability remain SDK/operator-enforced
  (§6.3). Pools that never swapped are outside the v1.0 domain (C1
  cannot attest them either — see D8). *Breaking change:*
  `record_launch_price` instruction data gained the `msg: [u8; 168]`
  parameter and the `protocol_config` + `instruction_sysvar` accounts.
- **C5 (LOCKER-001, resolved in Phase 1.1):** v1.0 introspects exactly
  one locker — UNCX Raydium AMM V4
  (`GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo`, official source
  `uncx-network/raydium-amm-lp-locker`). Design:
  * *Marker gate (deterministic, on-chain):* the caller must always
    supply the per-pool marker PDA `["global_lp_tracker", amm_id]`,
    created init-if-needed on the pool's first lock and never deleted.
    Marker absent on chain ⇒ no lock was ever created ⇒ locked amount 0
    is **proven**, not assumed. Omitting the marker reverts 6020.
  * *TokenLock evidence:* lock PDAs are `["uncx_locker", id]`
    (sequential global ids — not mint-derivable), so the id set comes
    from off-chain enumeration (discriminator filter + `memcmp` on
    `lp_mint`). Every supplied TokenLock is validated on-chain —
    ownership, discriminator, 146-byte layout, PDA re-derivation from
    its own `lock_global_id`, `(amm_id, lp_mint)` binding — and its
    live `current_locked_amount` summed. A marker present on chain with
    no TokenLock evidence reverts 6021; any validation failure reverts
    6022/6023. The silently opt-out-able pattern forbidden by this
    section cannot occur: omission is never accepted as zero when a
    lock ever existed.
  * *Residual trust (documented):* completeness of the enumerated
    TokenLock set, and coverage of lockers other than UNCX
    (LOCKER-002), are SDK/operator-enforced (§6.3). Verified against
    live mainnet: 125 locks / 74 pools, per-mint custody reconciliation
    74/74.

## 6. What the protocol guarantees — enforcement matrix

Every guarantee below is classified as **on-chain enforced** (program
code rejects violations), **governance enforced** (multisig process;
violations require governance misbehaviour, not code), or
**SDK/operator enforced** (client-side policy; a non-SDK operator can
violate it).

### 6.1 On-chain enforced (v1.0 code, today)

| Guarantee | Mechanism |
|---|---|
| All six criteria hold at Phase 1 and again at Phase 2 | Single pure evaluator; bitmap `0x3F` required. |
| No silent downgrade between phases | Phase 2 bitmap must equal anchor bitmap (`CriteriaBitmapMismatch`). |
| Multi-epoch cooling-off | `MIN_EPOCH_CONFIRMATION = 2` between anchor and cert. |
| Cert freshness and binding | `salvage_pool` rejects expired certs, foreign pools, foreign AMM IDs, non-`0x3F` bitmaps. |
| One salvage per pool, ever | `PoolRegistry` + `SalvageReceipt` init-on-PDA. |
| LP is deposited before it is burned | Salvor-signed SPL transfer into the vault LP ATA; withdraw burns the full vault balance. |
| Vault-side CPI authority | `vault_authority` singleton PDA signs every CPI and distribution; no caller key can move pool assets. |
| WSOL-only base token | `wsol_mint` address-pinned to the network constant. |
| Snapshot consistency | `lp_total_supply_at_snapshot` must equal the live LP mint supply (`InvalidSnapshotData`). |
| 40/40/20 shares sum to 10_000 bps; protocol share ≤ 20% | Re-checked in `salvage_pool` and in `update_protocol_config`; ceiling is a `const`. |
| Settlement conservation | Protocol share is computed as the remainder (`total − salvor − lp`), so the three transfers exactly exhaust the recovered lamports; no dust or remainder is dropped from accounting. |
| `lp_holder_pool_vault` cannot be swept by any key | No instruction path other than `claim_lp_proceeds` debits it. |
| One claim per (pool, holder); no overclaim | `ClaimRecord` init-on-PDA + Merkle proof + cumulative-claimed cap (`ClaimAlreadyProcessed`, `InvalidClaimProof`). |
| Claims survive pause | `claim_lp_proceeds` does not read the pause flag. |
| Pause halts new activity | Scanner pause gates `evaluate_pool_*`; vault pause gates `salvage_pool`; neither gates governance or rent-reclaim paths. |
| Cert TTL cannot be configured below 10 minutes | `MIN_CERT_TTL_SECONDS` floor in `initialize` and `update_protocol_config`. |
| C1 inactivity evidence is oracle-signed | 112-byte Ed25519 attestation verified in-transaction via the `ed25519_program` precompile: signature bound to exactly the embedded message, oracle key = `ProtocolConfig.activity_oracle`, pool/AMM binding, non-future timestamp, `issued_slot` re-anchored in `SlotHashes` (errors 6024–6031). A caller-supplied timestamp is no longer an accepted input. |
| C2 launch-price baseline is oracle-signed | 168-byte Ed25519 attestation verified in-transaction at `record_launch_price`: signature bound to exactly the embedded message, oracle key = `ProtocolConfig.launch_price_oracle`, pool/mint/price echo binding, positive price, first-swap timestamp/slot sanity (errors 6024–6027, 6032). Both evaluation handlers additionally reject a baseline whose recorded mint pair differs from the live pool's parsed mints (6033). A caller-supplied price is no longer an accepted input. |
| Locker evidence is sound (UNCX v4) | Every supplied TokenLock is ownership-, discriminator-, size-, PDA-re-derivation- and binding-checked before its amount is summed; marker gate forbids silent omission (errors 6020–6023). |

### 6.2 Governance enforced (multisig process, not program code)

| Guarantee | Mechanism | Notes |
|---|---|---|
| 72h timelock on parameter changes | Squads v4 transaction-buffer scheduling | **Not program-enforced.** On-chain `timelock_seconds` / `pending_authority` fields exist but are currently write-only reserved state (D2). |
| 7-day public notice on standard upgrades; 24h timelock + 5-day post-mortem on emergency upgrades | Charter process | Pure process commitments; no code artifact. |
| Multisig membership and threshold | Squads 3-of-5 at launch → 4-of-7 post-audit | Off-chain. |
| Program upgrade authority custody | Upgrade key held by multisig | All "unsweepable / cannot change" guarantees are ultimately bounded by upgrade authority governance. |
| Threshold tuning within spirit | `update_protocol_config` bounds | The programs bound individual values; the multisig is trusted to choose sane values within them (e.g. inactivity cannot be tuned to 0 — there is no lower bound; accepted and documented here). |

### 6.3 SDK/operator enforced (cannot be on-chain enforced)

| Guarantee | Mechanism | Notes |
|---|---|---|
| Priority-fee ceiling | SDK `shouldRejectFee` + operational max `min(margin-ratio × expected profit, ceiling)` (default margin 25%) | A callee program cannot enforce a compute-unit price; the fee is paid by the transaction payer before program execution. `ProtocolConfig.max_priority_fee_ceiling_lamports` (default 1 SOL lamports/CU) is **advisory** config consumed by SDKs (D3). |
| Jupiter route integrity | Salvor builds the route from Jupiter's quote API and supplies `min_quote_output_lamports` | On-chain, only the swap-leg floor is enforced. A route whose internal destination is not the vault WSOL ATA, and a floor of `0`, are **not** rejected by v1.0 code — tracked as SLIP-001/CPI-011 in the checklist (D4). |
| Honest snapshot and Merkle tree construction | Off-chain snapshotter (Phase 5) | The on-chain verifier rejects bad proofs; it cannot detect a faithfully-verified-but-wrong root supply chain. |
| Locker evidence completeness (C5) | Off-chain TokenLock enumeration (discriminator + `memcmp` on `lp_mint`) and cross-checks of all known lockers before certification | On-chain validation is sound but cannot prove that the supplied TokenLock set is exhaustive (ids are sequential-global, not mint-derivable), nor introspect lockers outside UNCX v4 (LOCKER-002). |
| Activity-oracle honesty and availability (C1) | Off-chain indexer derives the last-swap time from Raydium V4 transaction history (`sdk/src/lastSwapAttestation.ts::deriveLastSwapV4`) and signs attestations with `activity_oracle` | On-chain verification is cryptographic but cannot re-derive swap history itself (Raydium V4 `AmmInfo` stores no last-swap field; `SlotHashes` spans ≈ 512 slots). A buggy or colluding oracle could attest a wrong timestamp; the oracle key is governance-held and rotatable. Oracle downtime blocks new evaluations (availability, not integrity). ORACLE-003 in the checklist tracks the operational runbook. |
| Launch-price oracle honesty and archive availability (C2) | Off-chain indexer derives the pre-first-swap reserve ratio from full-history Raydium V4 transaction data (`sdk/src/launchPriceAttestation.ts::deriveLaunchPriceV4`, fail-closed on incomplete history) and signs attestations with `launch_price_oracle` | On-chain verification cannot re-derive historical vault balances (Solana programs cannot read past account state). A buggy or colluding oracle could attest a wrong baseline; because the `LaunchPrice` PDA is init-once, a wrong record is permanent — mitigated by key separation from the activity oracle, governance rotation, and the ORACLE-003 runbook (shared with C1). |
| Transaction construction quality | SDK transaction builders (Phase 8) | Account ordering, compute limits, retries (locker introspection costs one PDA re-derivation per supplied TokenLock). |

### 6.4 Explicitly NOT guaranteed in v1.0

- No global protocol-enforced slippage ceiling across both legs (only
  the Jupiter-leg floor; see D4).
- No on-chain timelock on config changes (see D2).
- No recovery path for memecoin dust below the Jupiter dust threshold
  within the same salvage (retained in the vault memecoin ATA, logged;
  policy = D6/Phase 4).
- No protection against a front-run salvage race between competing
  salvors beyond first-transaction-wins (single `PoolRegistry` slot).
- No non-WSOL quote/base support (see D5).
- No C2 evaluation for pools launched above a ~2^114.6 Q64.64
  quote-per-base ratio: the `drop × 10_000` intermediate overflows u128
  and the evaluation fails closed with `MathOverflow` (uncertifiable,
  never mis-certifiable). Pinned by the
  `compute_drop_bps_beyond_real_reserve_scale_fails_closed` test.
- No locker introspection beyond the UNCX Raydium V4 locker — LP locked
  in PinkSale / Team Finance / Streamflow / others is invisible to
  on-chain C5 in v1.0 (LOCKER-002; mitigated SDK-side).

## 7. Resolved decisions (Phase 0 settlements)

**D1 — TVL threshold terminology.** The canonical term is **minimum
residual TVL** and the criterion direction is `≥`
(`current_tvl_lamports ≥ min_tvl_lamports`): a derelict pool must retain
at least the floor (default 0.5 SOL quote-side) to be in scope. The
whitepaper's "residual TVL below threshold" / "< 0.5 SOL" and the
glossary's "low TVL" were **inverted** and are corrected alongside this
spec. The code (`criteria.rs`, `min_tvl_lamports`) was authoritative and
is unchanged.

**D2 — Timelock model.** v1.0 enforces the 72h parameter-change
timelock **at the governance layer only** (Squads v4 transaction
buffers). The on-chain `pending_authority`, `pending_authority_eta`, and
`timelock_seconds` fields are **reserved and non-functional** — declared,
written, never read. Docs claiming program-level enforcement are
corrected. Wiring an on-chain timelock (and consuming the dead fields or
removing them) is an explicit future decision, not a silent assumption.

**D3 — Priority-fee model.** The ceiling is **SDK/operator-enforced**.
On-chain config stores an advisory Charter ceiling
(`max_priority_fee_ceiling_lamports`, default 1_000_000_000
lamports/CU) that programs never read; SDKs must reject submissions
above `min(ceiling, margin-ratio × expected profit)`. Error 7008
(`PriorityFeeExceedsCeiling`) is reserved for a future design that can
actually observe fees (it is never raised today).

**D4 — Slippage model.** v1.0 on-chain enforcement is exactly one check:
the Jupiter-leg floor `swap_output − raydium_base_received ≥
min_quote_output_lamports` (`SlippageExceeded`). The config field
`max_slippage_bps`, the constant `HARD_MAX_SLIPPAGE_BPS`, and the
parameter `max_slippage_bps_override` are **declared but never read**
(dead code). Decision: they are marked reserved for the Phase 3
slippage rework (which must also pin the Jupiter route destination and
set a floor on `min_quote_output_lamports`); until then no document may
claim a protocol-enforced global slippage ceiling.

**D5 — Base-token orientation.** v1.0 is frozen as **WSOL-base pools
only**, with `base_is_coin_side = true` hardcoded (`salvage_pool.rs`).
The declared error `UnsupportedBaseToken` (7019) is not yet raised; a
non-WSOL-base pool fails inside the Raydium CPI as
`AmmRedemptionFailed`. Deriving orientation from on-chain mints is
checklist item CPI-010; USDC/USDT-style settlement is a v1.1 deliverable.

**D6 — Dust policy.** Memecoin output below
`jupiter_dust_threshold_lamports` (default 666_666 lamports-equivalent)
is **not** swapped: the skip is logged, the tokens remain in the vault
memecoin ATA, and the receipt records SOL amounts only. A complete dust
policy (ATA closure, sweep destination, receipt field for dust amount)
is a Phase 4 deliverable; until then the protocol accounts for dust as
"retained, unconverted" rather than pretending it was distributed.

**D7 — Settlement invariant (normative).** For every successful
salvage:

```
total_recovered_wsol  =  salvor_share + lp_holder_share + protocol_share
protocol_share        =  total − floor(total × salvor_bps / 10_000)
                          − floor(total × lp_bps / 10_000)   (the remainder)
```

Rounding losses from the two floors accrue to the protocol share by
construction. This matches the Phase 4 invariant form: recovered SOL =
LP allocation + salvor allocation + protocol allocation + explicitly
accounted remainder (here: inside `protocol_share`).

**D8 — Inactivity-evidence oracle model (Phase 1.2).** C1's last-swap
timestamp is carried by a **112-byte Ed25519 attestation** signed by a
governance-controlled activity oracle and verified on chain through the
`ed25519_program` precompile inside the evaluation instruction.
Rationale: Raydium V4's `AmmInfo` stores no last-swap field, and
on-chain state cannot prove the *absence* of swaps over a 90-day window
(`SlotHashes` covers ≈ 512 slots), so a pure on-chain derivation is
impossible; the alternatives (caller-supplied integers, or a program-
observed activity log with no writer incentive structure) are strictly
weaker. The message layout is `amm_program_id ‖ pool_address ‖
last_swap_unix_ts ‖ issued_slot ‖ slot_hash` (fixed offsets, mirrored
byte-for-byte by the SDK); the on-chain check requires the precompile
signature to cover exactly those 112 bytes as embedded in the
instruction data, binds them to the instruction params, rejects
zero/future timestamps and zero/future slots, and re-anchors
`issued_slot` against `SlotHashes` so a replayed attestation fails
closed once the slot ages out. The oracle key
(`ProtocolConfig.activity_oracle`) is initialised to the protocol
authority and rotatable by `update_protocol_config`. What remains
operator-enforced is documented in §6.3 (oracle honesty + availability).
This is a **breaking change** to the `evaluate_pool_phase_1` /
`evaluate_pool_phase_2` instruction data (`last_swap_unix_ts: i64` →
`msg: [u8; 112]` + two sysvar accounts), accepted pre-mainnet.

**D9 — Launch-price evidence model (Phase 1.3).** C2's baseline is
carried by a **168-byte Ed25519 attestation** signed by a
`launch_price_oracle` key (separate from `activity_oracle` — the
baseline is init-once and permanently binding, so its signing key is
isolated from the hotter activity-attestation key) and verified on chain
through the `ed25519_program` precompile inside `record_launch_price`.
"Launch price" is hereby **defined** as the quote-per-base price formed
by the pool's vault balances immediately before the pool's first
successful swap (the deployer-seeded initial market price); pools that
never swapped are outside the v1.0 domain because C1 cannot attest them
either. Rationale: Solana programs cannot read historical account state,
so no on-chain derivation of a launch-time price exists; the previous
state (any caller could write any baseline into the init-once PDA) had
two live attack vectors — a fake-high baseline (false C2 collapse) and a
fake-low baseline (permanent C2 denial-of-service on the pool's salvage
path). The message layout is `amm_program_id ‖ pool_address ‖ base_mint
‖ quote_mint ‖ first_swap_slot ‖ first_swap_unix_ts ‖
launch_price_q64x64 ‖ issued_slot` (fixed offsets, mirrored byte-for-
byte by the SDK); the on-chain check requires the precompile signature
to cover exactly those 168 bytes, binds the instruction params as an
echo of the attested fields, rejects zero prices and
zero/future first-swap timestamps and slots, and deliberately applies no
SlotHashes freshness check (a launch price is a time-invariant
historical fact and the init-once PDA makes replay structurally
impossible). Both evaluation handlers re-check the recorded mint pair
against the live pool's parsed mints before C2 consumes the price. What
remains operator-enforced is documented in §6.3 (derivation honesty,
archive availability) and the init-once permanence is an accepted
boundary. This is a **breaking change** to the `record_launch_price`
instruction data (added `msg: [u8; 168]` + `protocol_config` +
`instruction_sysvar` accounts), accepted pre-mainnet.

## 8. Documentation / code discrepancy ledger

| # | Document claim | Reality (code) | Resolution |
|---|---|---|---|
| 1 | Whitepaper §1 "residual TVL below threshold"; §3 "< 0.5 SOL"; glossary "low TVL" | `current_tvl_lamports ≥ min_tvl_lamports` (minimum, not maximum) | **Fixed** — docs corrected; D1. |
| 2 | Whitepaper §3 "Criteria 1-5 are evaluated against on-chain pool state" | C1 and C2 consume caller-supplied inputs today (ORACLE-001/002) | **Fixed** — whitepaper now points to §5 evidence status. |
| 3 | Glossary "EligibilityCert … TTL = 1 hour"; cert doc-comment "issued_at + 3600" | TTL = `ProtocolConfig.cert_ttl_seconds`: governance-configurable, default 3_600s, floored at 600s | **Fixed** — glossary wording updated. |
| 4 | README/CONTRIBUTING/whitepaper "72h timelock on all parameter changes" (stated as program-level) | Timelock enforced by Squads scheduling only; on-chain fields dead | **Fixed** — docs now say "multisig-enforced"; D2. |
| 5 | `docs/error_codes.md` lists 7008/7014 alongside live errors | Both variants exist but are never raised | **Fixed** — error_codes.md now marks them reserved. |
| 6 | PRE_MAINNET_CHECKLIST ORACLE-001 refers to a `first_swap_slot` parameter | `RecordLaunchPriceParams` carries no slot reference; `recorded_slot` is write-time clock | **Fixed** — checklist row amended. |
| 7 | `tests/README.md` implies on-chain priority-fee ceiling enforcement tests | Enforcement is SDK-only (D3) | **Fixed** — wording updated. |
| 8 | `docs/README.md` canonical set references five living files that do not exist (`technical-documentation.md`, `grave-scanner-grave-vault-combined.md`, `legal-documentation.md`, `ghostpools-research.md`, `architecture/*.md`) and `published/` snapshots | Only `whitepaper.md`, `glossary.md`, `error_codes.md`, `PRE_MAINNET_CHECKLIST.md`, `PROTOCOL_SPEC.md` exist | **Tracked** — pre-existing doc rot; not Phase 0 scope to author five documents. This spec is the governing document meanwhile. |
| 9 | EligibilityCert lifecycle: cert PDA is init-once | An expired cert permanently bricks that pool's salvage path (B4) | **Tracked** — Phase 1.4 engineering blocker. |
| 10 | Locker check semantics ("LP not locked") | Adapter unimplemented; no pool passes Phase 1 (B1) | **Fixed (Phase 1.1)** — UNCX Raydium V4 adapter implemented and mainnet-verified; residual scope in §6.3/LOCKER-002. |
| 11 | `evaluate_pool_*` docs/comments: "last swap timestamp supplied by the salvor SDK and cross-checked by the indexer… taken at face value" (ORACLE-002) | Param was a plain `i64` — C1 was forgeable by any caller | **Fixed (Phase 1.2)** — replaced by the D8 attestation flow; adapter `0` sentinel and dead `PoolData.last_swap_unix_ts` field removed; errors 6024–6031 added; checklist ORACLE-002 retired, ORACLE-003 opened for the operational runbook. |
| 12 | `record_launch_price` doc-comment: "cross-check launch_price_q64x64 against on-chain pool reserves at the supplied first_swap_slot rather than trusting the caller" (ORACLE-001) | Param was a caller-supplied `u128` written init-once with zero checks — fake-high baselines forged C2 collapses and fake-low baselines permanently denied salvage | **Fixed (Phase 1.3)** — replaced by the D9 attestation flow (168-byte oracle-signed message, mint-pair re-check at evaluation); errors 6032/6033 added; `LaunchPrice` gained attested `first_swap_slot`/`first_swap_unix_ts` provenance; checklist ORACLE-001 retired. |

## 9. Exit condition — the three answers

- **What makes a pool derelict?** All six §4 criteria hold
  simultaneously, evaluated twice across at least two epoch boundaries
  with identical bitmaps.
- **Who proves it?** Whoever submits the transactions — but every input
  must ultimately trace to on-chain state verifiable inside the
  instruction (§5). C1 is carried by a governance-oracle-signed
  attestation verified in-transaction (D8, Phase 1.2); C2's baseline is
  carried by a dedicated-oracle-signed attestation verified
  in-transaction (D9, Phase 1.3); C5 is implemented for the UNCX
  Raydium V4 locker with its completeness boundary documented in §6.3.
  Every criterion input now has an on-chain cryptographic evidence path;
  the residual trust is exactly the §6.3 oracle-honesty/availability
  boundary (shared runbook, ORACLE-003) plus the C5 enumeration
  completeness boundary.
- **What does the protocol guarantee?** Exactly the §6 matrix — no more,
  no less. Anything not listed there is not guaranteed, and §6.4 lists
  the sharpest edges explicitly.

