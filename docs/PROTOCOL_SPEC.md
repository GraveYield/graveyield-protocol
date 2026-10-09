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
> **Revisions:** rev 1.10.0 — Phase 6: the first COMPLETE lifecycle
> integration test ships (`programs/grave-vault/tests/
> full_lifecycle_fork.rs`: candidate pool → GraveScanner certify →
> salvage → snapshot → claims — one test, every state transition asserted,
> on the real mainnet bytecode), and running it CORRECTED the C1/C2
> attestation precompile contract: the `ed25519_program` verify
> instruction that precedes `evaluate_pool_phase_1` / `_2` and
> `record_launch_price` must use the runtime's own wire format — 1-byte
> signature count (`data[0]`, exactly 1), 1 ignored padding byte, the
> 7-field `Ed25519SignatureOffsets` struct at byte 2 (signature_offset,
> signature_instruction_index, public_key_offset,
> public_key_instruction_index, message_data_offset, message_data_size,
> message_instruction_index — all u16 LE), then the covered public key
> (32 B) and the signature (64 B) at the pinned canonical placements 16 /
> 48 — with `message_data_size` pinning the attestation span (112 B at
> offset 72 for C1; 168 B at offset 152 for C2). The previously shipped
> 14-byte header (signature count as the 5th u16, no message-size field,
> sig at 14 / pk at 78) is not a format any Solana runtime accepts: the
> precompile reads the count from `data[0]`, so such instructions die in
> precompile verification before the scanner ever executes. The on-chain
> checks are unchanged in intent and now pin every field of the runtime
> layout fail-closed; the SDK's attestation builders
> (`sdk/src/lastSwapAttestation.ts`, `sdk/src/launchPriceAttestation.ts`)
> were corrected to the same layout. No error codes, instruction data, or
> account layouts change. rev 1.9.0 — Phase 5.2: the Merkle tree builder, proof
> generator, and sealed snapshot artifact ship (`snapshotter/`, modules
> `tree` / `artifact`), completing the off-chain claims machinery.
> Tree convention pinned as D12: leaves are the D11 entries hashed as
> `SHA256(pubkey || balance_le_u64)` (40-byte preimage, byte-locked to
> `grave_vault::merkle::compute_leaf`), parents are sorted-pair SHA-256
> (`min || max`, the OZ/Uniswap convention), and an odd node at any level
> promotes unchanged — the exact convention the Phase 4 fork harness
> proved end-to-end (`settlement_economics_fork.rs::
> build_three_leaf_tree`), now bit-locked between the shipped builder and
> the fork suite; a promotion contributes no proof element, and the
> on-chain `verify_proof` folds only the siblings the proof carries. The
> sealed artifact (`SnapshotArtifact`) persists the publishable claims
> metadata (pool/mint/slot/supply, root, per-holder balance + leaf +
> ready-to-submit proof) as deterministic JSON — base58 pubkeys, lowercase
> hex hashes, canonical field and entry order; sealing the same snapshot
> twice is byte-identical, and `verify_integrity` refuses any artifact
> whose root, leaves, proofs, depth, count, format version, or closing
> reconciliation identity does not rebuild exactly from its persisted
> entries. SNAPSHOT-001 retired.
> rev 1.8.0 — Phase 5.1: the off-chain LP-holder
> snapshotter ships (`snapshotter/`, crate `grave-snapshotter`):
> deterministic, invariant-checked enumeration of the LP-holder set that
> feeds the claim-side Merkle root. Snapshot policies pinned as D11:
> pre-salvage snapshot point (the on-chain supply pin is the integrity
> anchor), the salvor's pre-burn balance is an ordinary leaf, burned LP
> needs no exclusion (it never enumerates; `Σ enumerated balances ==
> lp_mint.supply` is a hard completeness gate), locked LP is attributed to
> the beneficial `TokenLock.lock_owner` with fail-closed custody
> reconciliation, and every excluded token is ledgered. The Merkle tree
> builder / proof generator remains Phase 5.2 (SNAPSHOT-001).
> rev 1.7.0 — Phase 4: settlement economics proven and the
> D6 dust policy implemented. `salvage_pool` records `memecoin_mint` and
> the retained memecoin amount (`dust_memecoin_lamports`) on the receipt
> (below-threshold dust AND swap-leg route residual; existing receipt byte
> offsets stable, pinned by a layout unit test); the new permissionless
> one-shot `sweep_dust` instruction recovers the retained memecoin to the
> protocol treasury's ATA, closes the vault ATA (rent to the caller), and
> stamps `dust_swept_at_ts` (D6 retired — `DustNothingToSweep` 7020 /
> `DustAlreadySwept` 7021). The D7 invariant is proven end-to-end in the
> new `settlement_economics_fork.rs` (default AND custom share configs;
> exact conservation; rounding remainder accrues to protocol by
> construction) together with the claims-side economics (real Merkle
> tree, exact pro-rata floors, no-overclaim, claims live during pause).
> rev 1.6.0 — Phase 3: the Jupiter conversion pipeline proven
> end-to-end in the fork harness (real withdraw + real V4 swapBaseIn against
> byte-for-byte mainnet state of BOTH orientations — SOL/USDC coin=WSOL and
> RAY/WSOL pc=WSOL — through a documented test-only stand-in deployed at the
> pinned Jupiter v6 program id; the vault forwards routes verbatim and
> assumes nothing about route internals). `salvage_pool` changes: base
> orientation is DERIVED from the pool's on-chain AmmInfo mints
> (`UnsupportedBaseToken` 7019 before any CPI for no-WSOL pools — CPI-010
> retired) and the submitted `lp_mint`/`memecoin_mint` are bound to the
> pool's own bytes; the protocol slippage ceiling is live (SLIP-001
> retired): `config.max_slippage_bps`, `HARD_MAX_SLIPPAGE_BPS` and
> `max_slippage_bps_override` are read, and the submitted floor must cover
> the pool-implied conversion minus the effective cap BEFORE the swap CPI;
> route-account vetting (D4 amendment): no route account may reference a
> vault custody/state account and the vault's WSOL destination must be
> present (N1 closed). No instruction-data shape change (the
> `max_slippage_bps_override` parameter gained semantics; the wire layout
> is unchanged). rev 1.5.0 — Phase 2.1: Raydium V4 withdraw CPI proven and
> fixed against the deployed mainnet bytecode (CPI-009 retired). Breaking
> changes to `salvage_pool`: the LP is now burned **in place** in the
> salvor's token account (the salvor signs the salvage transaction and acts
> as the withdraw's `user_owner`); the vault LP ATA and the deposit step are
> removed; the withdraw CPI carries 13 `remaining_accounts` (amm_authority,
> open orders, target orders, both AMM vaults, market program, market, both
> market vaults, market vault signer, event queue, bids, asks) plus two new
> named accounts (`amm_program`, `jupiter_program`); the CPI's account list
> must contain the callee program. Verified end-to-end (real LP burn + real
> reserve transfers + real 40/40/20 settlement) against real mainnet
> Raydium V4 / OpenBook / SPL-token bytecode in the
> `solana-program-test` fork harness (§3, §6.1, §8 row 10, §9).
> rev 1.4.0 — Phase 1.4: EligibilityCert lifecycle fixed
> (B4): the Phase 2 cert PDA is expiry-gated reissuable in place
> (`init_if_needed` + `CertStillValid` gate, new `reissue_generation`
> counter, new error 6034; §2, §2.1, §3, §6.1/6.4, §7 D10, §8 row 9
> updated; no instruction-data or account-size change). rev 1.3.0 —
> Phase 1.3: C2 evidence implemented (oracle-signed 168-byte Ed25519
> launch-price attestation, ORACLE-001 retired; new `launch_price_oracle`
> config field; launch price defined as the pre-first-swap reserve ratio;
> §2.1, §4 C2, §5, §6.1/6.3/6.4, §7 D9, §8 row 12, §9 updated; breaking
> change to the `record_launch_price` instruction data). rev 1.2.0 —
> Phase 1.2: C1 evidence implemented (indexer-signed Ed25519 last-swap
> attestation, ORACLE-002 retired; new `activity_oracle` config field;
> §4 C1, §5, §6.1/6.3, §7 D8, §8 row 11, §9 updated; breaking change to
> the `evaluate_pool_*` instruction data). rev 1.1.0 — Phase 1.1: C5
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
- **salvage** — the act of settling a derelict pool: burn LP in place in the
  salvor's account,
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
| `evaluate_pool_phase_2` | Re-evaluates all six criteria after the epoch gap; requires bitmap equality with the anchor; issues the `EligibilityCert` — or reissues it in place once expired (`CertStillValid` on a live cert; D10). |
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
| `EligibilityCert` | scanner | `["eligibility_cert", amm_program_id, pool]` | expiry-gated reissuance in place (D10) |
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
- **LP snapshotter** (`snapshotter/`, crate `grave-snapshotter`):
  **shipped** (Phase 5.1) — deterministic enumeration + locked-LP
  attribution, fully host-tested (D11).
- **Merkle tree builder / proof generator / snapshot persistence**:
  **shipped** (Phase 5.2) — `tree::SnapshotMerkleTree` +
  `artifact::SnapshotArtifact`, proofs tested against the on-chain
  `verify_proof` (D12).
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
        |                            AND cert expired-or-absent (D10)   (expires_at = now + cert_ttl_seconds,
        |                                                                reissue_generation += 1)
        x (reject / EpochConfirmationPending / CriteriaBitmapMismatch /
           CertStillValid — live cert may not be overwritten)
                                                       |
          cert expires ────────────────────────────────<
          (re-run Phase 2: full re-verification, in-place reissue)
                                                       |
                                                       v  (before expires_at)
salvage_pool:
  pre-flight: !paused; cert fresh; cert bitmap == 0x3F;
              cert binds (amm_program_id, pool_address); pool key matches
  execute:   lazy-init system PDAs -> derive base orientation from the
             pool's own mints (7019 if neither/both side is WSOL) + bind
             submitted lp_mint/memecoin_mint to the pool bytes ->
             Raydium V4 withdraw (burns the salvor's LP in place) ->
             [memecoin >= dust threshold ? route-account vetting +
              slippage ceiling on the submitted floor + Jupiter v6 swap
              memecoin->WSOL + swap-leg floor check : skip and log] ->
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

**Cert lifecycle (D10, Phase 1.4).** A cert PDA is issued by Phase 2,
stays valid until `expires_at`, and is reissued **in place** by a later
Phase 2 run once — and only once — it has expired: the PDA is created
with `init_if_needed` and the handler reverts `CertStillValid`
(6034) while a live cert exists, so two live certs for one pool are
structurally impossible and a reissue always re-runs the full
verification stack (fresh C1 attestation, six criteria, locker
evidence, mint-pair check, bitmap equality). A fresh (zeroed) PDA reads
as expired (`expires_at == 0`), which is why one gate governs first
issue and every reissue. `reissue_generation` counts issues (1 = first
issue). A **failed salvage** needs no extra state: the transaction
reverts atomically (the cert is untouched — retry within the TTL
works), the init-once registry/receipt PDAs permanently settle a
salvaged pool, and a drained pool fails re-certification at Criterion 3
(minimum TVL) regardless.

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
the pool. Locked LP cannot be withdrawn by the salvor (the withdraw burns
the salvor's own LP balance in place), so any
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
  message embedded in the instruction data (canonical offsets — the
  runtime `ed25519_program` wire format, byte-locked in the module
  header of `grave-scanner/src/attestation.rs`), to the `(amm_program_id,
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
  (canonical offsets — the runtime `ed25519_program` wire format — in
  `grave-scanner/src/attestation.rs`), to the
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
| Expired certs never brick a pool; two live certs per pool are impossible | Phase 2 reissues the cert PDA in place once `expires_at` has passed (`init_if_needed`); a live cert cannot be overwritten (`CertStillValid`, 6034); `reissue_generation` counts issues (D10). |
| Cert freshness and binding | `salvage_pool` rejects expired certs, foreign pools, foreign AMM IDs, non-`0x3F` bitmaps. |
| One salvage per pool, ever | `PoolRegistry` + `SalvageReceipt` init-on-PDA. |
| LP is burned in place in the salvor's account | The withdraw CPI burns `salvor_lp_amount` from the salvor's LP account (the salvor signs the salvage transaction and is the withdraw's `user_owner`); the deployed Raydium V4 program enforces the burn amount against the signer's balance. Proven end-to-end against real mainnet V4 bytecode by the fork harness (CPI-009 retired). |
| Vault-side CPI authority | `vault_authority` singleton PDA signs the Jupiter swap and every distribution; no caller key can move pool assets. (The V4 withdraw needs no vault signature: it burns the salvor's own LP and pays into vault-owned accounts.) |
| Raydium V4 withdraw wire format is correct | 22-account ordering + 9-byte data proven against the deployed mainnet V4 bytecode: the fork harness executes a real LP burn and real reserve transfers end-to-end, and scrambled/malicious account submissions are rejected by the real program (CPI-009 retired). |
| WSOL-only base token | `wsol_mint` address-pinned to the network constant. |
| Snapshot consistency | `lp_total_supply_at_snapshot` must equal the live LP mint supply (`InvalidSnapshotData`). |
| 40/40/20 shares sum to 10_000 bps; protocol share ≤ 20% | Re-checked in `salvage_pool` and in `update_protocol_config`; ceiling is a `const`. |
| Settlement conservation | Protocol share is computed as the remainder (`total − salvor − lp`), so the three transfers exactly exhaust the recovered lamports; no dust or remainder is dropped from accounting. |
| D7 invariant proven on real fixtures | `settlement_economics_fork.rs` (Phase 4): exact conservation for the default 40/40/20 AND a custom asymmetric config (4001/4000/1999); floor roundings accrue to the protocol share; host unit tests pin `split_proceeds` for the rounding edges the fixtures cannot reach. |
| Retained memecoin is recorded, never silently lost | The receipt carries `memecoin_mint` + `dust_memecoin_lamports` (below-threshold dust and route residual alike); the settlement splits only the WSOL side. |
| Dust recovery is permissionless, one-shot, and unpinnable | `sweep_dust` moves the vault memecoin ATA balance to the treasury ATA (destination pinned by derivation), closes the ATA (rent to the caller), stamps the receipt; foreign mint 7013, empty ATA 7020, second sweep 7021; a hijacked destination fails with zero state movement (fork-proven). |
| Claims economics hold to the lamport | Fork-proven with a real 3-holder Merkle tree: exact `floor(lp_share × balance / supply)` payouts, cumulative-claimed tracking, claim-side rounding remainder stays in the bucket, double claims fail, claims live during pause. |
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
| Jupiter route integrity | Salvor builds the route from Jupiter's quote API and supplies `min_quote_output_lamports` | **On-chain (Phase 3):** the route is forwarded verbatim (no route-plan parsing), but every route account is vetted — none may reference a vault custody/state account — and the vault's WSOL destination must be present; the submitted floor must cover the pool-implied conversion minus the protocol slippage ceiling (SLIP-001 retired, D4); the swap-leg floor re-checks the delivered amount post-CPI. Proven against real bytecode for both orientations by the Phase 3 fork harness. |
| Honest snapshot and Merkle tree construction | Off-chain snapshotter (`grave-snapshotter`, Phases 5.1 + 5.2) | The on-chain verifier rejects bad proofs; it cannot detect a faithfully-verified-but-wrong root supply chain. The shipped snapshotter is deterministic and re-runnable (same ledger state → bit-identical snapshot), enforces `Σ enumerated balances == lp_mint.supply` as a completeness gate, attributes locked LP to beneficial `TokenLock.lock_owner`s with fail-closed custody reconciliation, and ledgers every excluded token (D11). The tree/proof builder and sealed artifact now ship (Phase 5.2, D12): the root is built under the fork-proven promote-unchanged convention, every generated proof is tested against the on-chain `verify_proof`, and the persisted artifact re-derives its own integrity from its entries. |
| Locker evidence completeness (C5) | Off-chain TokenLock enumeration (discriminator + `memcmp` on `lp_mint`) and cross-checks of all known lockers before certification | On-chain validation is sound but cannot prove that the supplied TokenLock set is exhaustive (ids are sequential-global, not mint-derivable), nor introspect lockers outside UNCX v4 (LOCKER-002). |
| Activity-oracle honesty and availability (C1) | Off-chain indexer derives the last-swap time from Raydium V4 transaction history (`sdk/src/lastSwapAttestation.ts::deriveLastSwapV4`) and signs attestations with `activity_oracle` | On-chain verification is cryptographic but cannot re-derive swap history itself (Raydium V4 `AmmInfo` stores no last-swap field; `SlotHashes` spans ≈ 512 slots). A buggy or colluding oracle could attest a wrong timestamp; the oracle key is governance-held and rotatable. Oracle downtime blocks new evaluations (availability, not integrity). ORACLE-003 in the checklist tracks the operational runbook. |
| Launch-price oracle honesty and archive availability (C2) | Off-chain indexer derives the pre-first-swap reserve ratio from full-history Raydium V4 transaction data (`sdk/src/launchPriceAttestation.ts::deriveLaunchPriceV4`, fail-closed on incomplete history) and signs attestations with `launch_price_oracle` | On-chain verification cannot re-derive historical vault balances (Solana programs cannot read past account state). A buggy or colluding oracle could attest a wrong baseline; because the `LaunchPrice` PDA is init-once, a wrong record is permanent — mitigated by key separation from the activity oracle, governance rotation, and the ORACLE-003 runbook (shared with C1). |
| Transaction construction quality | SDK transaction builders (Phase 8) | Account ordering, compute limits, retries (locker introspection costs one PDA re-derivation per supplied TokenLock). |

### 6.4 Explicitly NOT guaranteed in v1.0

- No protocol-enforced ceiling on how much BELOW the pool-implied price a
  submitted conversion floor may sit relative to off-chain venues — the
  ceiling is anchored to the salvaged pool's own post-withdraw reserve
  ratio (see D4). Pools where a better route exists off-pool are
  unaffected (better routes pass).
- No on-chain timelock on config changes (see D2).
- Memecoin retained below the Jupiter dust threshold (or as route
  residual) stays OUT of the settlement until someone calls
  `sweep_dust`: it is recorded on the receipt and recoverable
  permissionlessly to the treasury ATA (D6/Phase 4), but it is never
  converted within the same salvage and never distributed as proceeds.
- No protection against a front-run salvage race between competing
  salvors beyond first-transaction-wins (single `PoolRegistry` slot).
- No on-chain revocation of a **live** cert: `invalidate_anchor`
  censors the certification path upstream, but a cert already issued
  remains salvageable until `expires_at` (governance revocation of live
  certs is reserved for a future revision; see D10).
- No rent-recovery path for cert PDAs after a successful salvage (the
  cert PDA persists; reissue overwrites it in place). Reserved for a
  future close instruction.
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

**D4 — Slippage model.** On-chain enforcement is the Jupiter leg, in two
layers. (1) **Ceiling on the submitted floor (Phase 3, SLIP-001):** when
the swap leg is active, `min_quote_output_lamports` must be at least the
pool-implied conversion of the received memecoin — computed from the
POST-withdraw reserve ratio of the pool itself, so no oracle or caller
input is trusted — minus the effective cap
`min(config.max_slippage_bps, HARD_MAX_SLIPPAGE_BPS)` further tightened
by `max_slippage_bps_override` (tighten-only). A floor below that bound
reverts `SlippageExceeded` BEFORE the swap CPI: a losing route can never
execute. (2) **Floor on the delivered output (unchanged):** the actual
swap-leg output must meet `min_quote_output_lamports`
(`SlippageExceeded`). Because the reference price is the salvaged pool's
own state, a route that finds a BETTER price elsewhere always passes;
only worse-than-cap conversions are blocked. The salvor must set the
route's own Jupiter slippage plus fees inside the cap (documented
interaction: route slippage + AMM fees ≤ protocol cap, or the salvage
reverts safely and can be resubmitted with a tighter route).

**D5 — Base-token orientation.** Orientation is **derived from the
pool's own on-chain mints** (AmmInfo `coin_mint`@400 / `pc_mint`@432,
Phase 3): exactly one side must be the address-pinned WSOL mint —
coin = WSOL sets `base_is_coin_side = true`, pc = WSOL sets it false,
and any other shape (USDC/USDT-style pairs — a v1.1 deliverable — or
WSOL on both sides) reverts `UnsupportedBaseToken` (7019) BEFORE any
CPI (CPI-010 retired). The submitted `lp_mint` and `memecoin_mint` are
bound to the pool's own bytes (`PreflightFailed` 7013 otherwise),
closing the desynchronisation path where the SPL token program
would not catch a mismatched destination on Raydium's plain transfers.
Both WSOL orientations are proven end-to-end by the Phase 3 fork
harness (SOL/USDC and RAY/WSOL fixtures).

**D6 — Dust policy (Phase 4).** Memecoin output below
`jupiter_dust_threshold_lamports` (default 666_666 lamports-equivalent)
is **not** swapped: the skip is logged, the tokens remain in the vault
memecoin ATA, and the settlement covers only the WSOL side. The retained
amount is RECORDED on the receipt (`dust_memecoin_lamports`, alongside
`memecoin_mint`) and is never counted as distributed proceeds —
"retained, unconverted". The recovery path is the permissionless one-shot
`sweep_dust`: it transfers the vault memecoin ATA's ENTIRE balance
(covering the skip path and any swap-leg route residual alike) to the
protocol treasury's ATA for the same mint — destination pinned by ATA
derivation, so no caller can redirect value — closes the vault ATA
(rent reclaimed by the caller), stamps `dust_swept_at_ts`, and emits
`DustSwept`. Reverts: foreign mint (`PreflightFailed` 7013), empty ATA
(`DustNothingToSweep` 7020), second sweep (`DustAlreadySwept` 7021).
`lp_holder_pool_vault` is untouched (Charter). Fork-proven by
`settlement_economics_fork.rs` (record/sweep/adversarial matrix).

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

**D10 — Cert lifecycle: expiry-gated in-place reissuance (Phase 1.4).**
The `EligibilityCert` PDA — the only artifact whose expiry previously
permanently bricked a pool's salvage path (B4) — is now **reissued in
place by Phase 2 itself** once it has expired. The account is created
with `init_if_needed`; the handler reverts `CertStillValid` (6034)
while the existing cert is live, so a live cert can never be
overwritten and two live certs for one pool are structurally
impossible (one PDA per pool + this gate). A fresh (zeroed) PDA reads
as expired (`expires_at == 0`), which lets a single `is_expired` gate
govern first issue and every reissue; the handler then rewrites every
field unconditionally (no stale data survives). Reissuance is
**deliberately not a separate instruction**: a `reissue_cert` entry
point would duplicate the entire Phase 2 verification stack
(attestation offsets, six criteria, locker evidence, mint-pair check,
bitmap equality) and drift over time — running Phase 2 again *is* the
reissue, and it re-enforces every freshness invariant for free
(including a fresh C1 attestation, whose Phase 1 copy has necessarily
aged out of `SlotHashes`). The reinitialization-attack surface of
`init_if_needed` is closed by the expiry gate + full-field rewrite;
the account layout is unchanged (`reissue_generation` was carved out
of `_reserved`, 64 → 56 bytes). Failed salvage requires no new state:
salvage reverts atomically (cert untouched, retry within TTL works),
the vault's init-once `PoolRegistry`/`SalvageReceipt` permanently
settle a salvaged pool, and a drained pool fails re-certification at
Criterion 3 regardless. Explicitly out of scope (§6.4): on-chain
revocation of a live cert (an anchor invalidated after issuance does
not retract the already-issued cert) and post-salvage cert rent
recovery; both are reserved for future revisions. This is a
**behavioral** change to `evaluate_pool_phase_2` (second call now
succeeds on an expired cert instead of reverting
`AccountAlreadyInitialized`); no instruction data or account size
changed.

**D11 — LP-holder snapshot policy (Phase 5.1).** The claims-side root is
only as honest as its supply chain, so the snapshotter (`snapshotter/`,
crate `grave-snapshotter`) is built to be recomputed and audited rather
than trusted. Normative decisions: (1) the snapshot point is
**pre-salvage** — `salvage_pool` pins `lp_total_supply_at_snapshot`
against the live `lp_mint.supply` (`InvalidSnapshotData`), so the
snapshot must capture the full pre-burn supply; (2) the **salvor's
pre-burn balance is an ordinary leaf** — the on-chain denominator
includes it, and omitting it would permanently strand that fraction of
the LP bucket (nobody could ever claim it); (3) **burned LP needs no
exclusion** — burned tokens are gone from circulation and never
enumerate — and the snapshotter enforces `Σ enumerated balances ==
lp_mint.supply` as a hard completeness gate (`SupplyMismatch` aborts the
snapshot on an inconsistent view); (4) **locked LP (UNCX v4) is
attributed to the beneficial `TokenLock.lock_owner`**, never to the
custody account that physically holds the tokens (a program-derived
custody PDA cannot sign a claim, so attributing to it would strand the
locked share); the custody account is identified by exact-balance
reconciliation — its balance must equal `Σ current_locked_amount`, the
reconciliation identity verified 74/74 against live mainnet during
LOCKER-001 — and the snapshot **fails closed** on ambiguity or a missing
custody account (`CustodyAmbiguous` with a `custody_owner_overrides`
escape hatch, `CustodyNotFound`); every TokenLock is validated off-chain
with the scanner adapter's exact on-chain checks (size, discriminator,
PDA re-derivation from its own declared id, (amm_id, lp_mint) binding);
(5) **zero-balance accounts and operator-declared sink owners** are
excluded from the leaf set but recorded in an explicit ledger, closing
the identity `entries_total + sink_exclusions_total == enumerated_total
== supply`; (6) **determinism is part of the contract** — same ledger
state in, bit-identical snapshot out (per-owner aggregation over
ascending pubkey bytes via `BTreeMap`, lock records sorted by address,
no timestamps or ambient state in the output). The on-chain verifier
remains the final gate: it cannot detect a wrong-but-self-consistent
root (§6.3), which is precisely why the producer is deterministic,
ledger-complete, and re-runnable.

**D12 — Merkle tree and sealed-artifact policy (Phase 5.2).** The
off-chain builder (`snapshotter/`, `tree::SnapshotMerkleTree`) is the
reference producer of the root that `salvage_pool` seals into
`PoolRegistry` and that `claim_lp_proceeds` verifies. Normative
decisions: (1) **leaves** are the D11 canonical entries hashed as
`SHA256(pubkey || lp_balance_le_u64)` (40-byte preimage), byte-identical
to `grave_vault::merkle::compute_leaf` — the equality is locked by tests
in both directions (the builder's leaf against the vault function, and
the preimage shape against independent SHA-256); (2) **parents** are
sorted-pair SHA-256 (`SHA256(min || max)`, the OZ/Uniswap convention), so
neither builder nor verifier tracks which side of the pair a node is on;
(3) **an odd node at any level promotes unchanged** — it is never
duplicated — and a promotion contributes NO proof element, because the
on-chain verifier folds only the siblings the proof carries; this is the
convention the Phase 4 fork harness sealed real claims through
(`settlement_economics_fork.rs::build_three_leaf_tree`), and the shipped
builder's 3-leaf root AND proofs are bit-locked to that recipe by test;
(4) **the tree input must be canonical** (ascending owner bytes, unique
owners, strictly positive balances — the same validator the snapshot
enforces), so the root is a pure function of the leaf set and misuse is
loud, not silently re-paired; (5) **persistence is deterministic** —
`SnapshotArtifact` publishes pool/mint/slot/supply metadata, the root,
and per-holder (balance, leaf, ready-to-submit proof) as JSON with fixed
field order, base58 pubkeys, and lowercase hex hashes; sealing the same
snapshot twice yields byte-identical JSON; (6) **the artifact re-derives
its own integrity** — `verify_integrity` rebuilds the tree from the
persisted entries and refuses any drift in root, leaves, proofs, depth,
count, format version, or the closing reconciliation identity
(`ArtifactMismatch`); and (7) **sealing is fail-closed against mixed-up
handles** — `SnapshotArtifact::seal` re-derives the tree from the
snapshot and rejects a foreign tree, so no artifact can be published
whose root does not derive from its own entries. The on-chain verifier
remains the final gate (§6.3): the artifact is the audit story, not the
trust anchor.

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
| 8 | `docs/README.md` canonical set references five living files that do not exist (`technical-documentation.md`, `grave-scanner-grave-vault-combined.md`, `legal-documentation.md`, `ghostpools-research.md`, `architecture/*.md`) and `published/` snapshots | Only `whitepaper.md`, `glossary.md`, `error_codes.md`, `PRE_MAINNET_CHECKLIST.md`, `PROTOCOL_SPEC.md` exist | **Fixed (docs, October 2026)** — all listed living sources are now committed: `technical-documentation.md` (v4.0 living markdown), `grave-scanner-grave-vault-combined.md`, `ghostpools-research.md` (WP-2026-001r4 cover), `legal-documentation.md` (already on main), and the three `architecture/` deep-dives; the two PDF artifacts live under `docs/published/` (Technical Documentation v4.0, GhostPools Research WP-2026-001r4). Remaining `.docx` snapshots stay external publishing artifacts re-rendered at release. |
| 9 | EligibilityCert lifecycle: cert PDA is init-once | An expired cert permanently bricks that pool's salvage path (B4) | **Fixed (Phase 1.4)** — expiry-gated in-place reissuance in Phase 2 (D10): `init_if_needed` + `CertStillValid` (6034) gate on a live cert, `reissue_generation` audit counter; two live certs structurally impossible; failed-salvage retry semantics documented in §3. |
| 10 | Locker check semantics ("LP not locked") | Adapter unimplemented; no pool passes Phase 1 (B1) | **Fixed (Phase 1.1)** — UNCX Raydium V4 adapter implemented and mainnet-verified; residual scope in §6.3/LOCKER-002. |
| 11 | `evaluate_pool_*` docs/comments: "last swap timestamp supplied by the salvor SDK and cross-checked by the indexer… taken at face value" (ORACLE-002) | Param was a plain `i64` — C1 was forgeable by any caller | **Fixed (Phase 1.2)** — replaced by the D8 attestation flow; adapter `0` sentinel and dead `PoolData.last_swap_unix_ts` field removed; errors 6024–6031 added; checklist ORACLE-002 retired, ORACLE-003 opened for the operational runbook. |
| 12 | `record_launch_price` doc-comment: "cross-check launch_price_q64x64 against on-chain pool reserves at the supplied first_swap_slot rather than trusting the caller" (ORACLE-001) | Param was a caller-supplied `u128` written init-once with zero checks — fake-high baselines forged C2 collapses and fake-low baselines permanently denied salvage | **Fixed (Phase 1.3)** — replaced by the D9 attestation flow (168-byte oracle-signed message, mint-pair re-check at evaluation); errors 6032/6033 added; `LaunchPrice` gained attested `first_swap_slot`/`first_swap_unix_ts` provenance; checklist ORACLE-001 retired. |
| 13 | `salvage_pool`: "Determine base orientation … Revert UnsupportedBaseToken otherwise" (B5/CPI-010) | `base_is_coin_side = true` hardcoded; the 7019 error was declared but never raised; a no-WSOL pool failed inside the Raydium CPI as `AmmRedemptionFailed` | **Fixed (Phase 3)** — orientation derived from the pool's own AmmInfo mints; 7019 raised pre-CPI; submitted `lp_mint`/`memecoin_mint` bound to the pool bytes; both orientations proven by the fork harness (SOL/USDC + RAY/WSOL); checklist CPI-010 retired. |
| 14 | `salvage_pool` / spec: "effective slippage cap is min(override, config.max_slippage_bps)" (B6/SLIP-001) | `max_slippage_bps_override`, `config.max_slippage_bps` and `HARD_MAX_SLIPPAGE_BPS` were declared but never read; a salvor could submit `min_quote_output_lamports = 0` | **Fixed (Phase 3)** — the protocol slippage ceiling is live: the floor must cover the pool-implied conversion (post-withdraw reserve ratio) minus `min(config, hard ceiling, override)`; enforced before the swap CPI; checklist SLIP-001 retired; D4 amended. |
| 15 | Spec §6.3: "A route whose internal destination is not the vault WSOL ATA … not rejected by v1.0 code" (N1) | The Jupiter route was forwarded with no account vetting and no destination binding beyond the post-swap floor; with floor `0` the gap was total | **Fixed (Phase 3)** — route-account vetting (no vault custody/state account may appear; the vault WSOL destination must be present) + the ceiling makes `floor = 0` impossible; the floor still re-checks the delivered amount. N1 closed; the checklist reference (CPI-011) is recorded as retired. |

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

