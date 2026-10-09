# GraveYield Protocol — Technical Documentation

System architecture · On-chain programs · SDK and indexer · Security boundaries · Deployment status

| | |
|---|---|
| **Version** | 4.0 · 9 October 2026 (living markdown) |
| **Repository baseline** | main @ `5cc46cdce13e` |
| **Current deployment** | Solana devnet; not mainnet |
| **V1 AMM scope** | Raydium AMM V4 only |
| **License** | Apache License 2.0 |
| **Status** | Implementation snapshot · **not** a security audit or mainnet release approval |

> **Living source.** This markdown is the living source of truth for the
> published snapshot [`published/GraveYield_TechnicalDocumentation_v4_0.pdf`](published/GraveYield_TechnicalDocumentation_v4_0.pdf).
> When the two disagree, this file wins per the contract in
> [`README.md`](README.md) — the PDF is a frozen reference. Revise this
> file when code, AMM scope, oracle operations, settlement logic or
> deployment status changes.

## Revision basis

Public repository main at `5cc46cdce13e259b45fb0ffb4d88224fe56c06ca`. The
implementation status below is based on source code, repository
documentation and the latest listed CI results reviewed on 9 October 2026.

## Document purpose and status

This document describes the current implementation in the GraveYield
Protocol repository, not only the intended end-state design. Its baseline
is the public main branch at the commit named above, last inspected for
this revision on 9 October 2026.

GraveYield is being built as Solana infrastructure for a deterministic
lifecycle for abandoned or derelict AMM liquidity. The v1 implementation
target is deliberately narrow: Raydium AMM V4 pools with wrapped SOL
(WSOL) as one pool side. This is not a claim that every AMM, every locker,
or every abandoned pool can currently be processed.

**Implementation-status convention.** "Implemented" means code exists in
the repository. "Tested" identifies the kind of test evidence available.
"Deployed on devnet" means the program and configuration were deployed
there; it does not mean the whole production operating service exists or
that a full salvage was exercised against live devnet liquidity.
"Pre-mainnet blocker" identifies work that the repository itself still
marks unresolved.

## Executive summary

| Area | Current state | Boundary to keep visible |
|------|---------------|--------------------------|
| GraveScanner on-chain program | Implemented: signed evidence checks, six-criterion evaluator, two-phase eligibility anchor/certificate lifecycle, pause/config operations, stale-anchor cleanup. | Pool extraction is implemented for Raydium V4 only; other named AMM adapters are stubs. |
| GraveVault on-chain program | Implemented: Raydium V4 liquidity withdrawal, route checks, slippage guards, 40/40/20 settlement, receipts, claims, dust recovery. | The salvor's LP tokens are burned from the salvor's own token account. Do not imply arbitrary LP tokens can be withdrawn from non-participating wallets. |
| Off-chain SDK | Implemented as a workspace package: instruction builders, PDA/account helpers, attestation builders, snapshot/Merkle helpers, simulation/fee utilities. | SDK is not a substitute for an operated oracle service, production key custody, or a published end-user application. |
| Off-chain indexer | Implemented for Raydium V4 discovery, activity derivation, reserves/metadata, pre-filter/scoring, queue, optional Phase 1 submission and tracking. | Production oracle operations, reliable historical archive access, key custody/rotation and service monitoring remain unresolved. |
| LP snapshotter | Rust grave-snapshotter builds deterministic LP-holder snapshots, Merkle trees and sealed JSON artifacts; completeness/reconciliation checks are included. | The chain verifies the Merkle proof and pins total LP supply, but does not independently enumerate every holder or prove that holder balances have not changed since the off-chain snapshot. |
| Deployment and CI | Both programs are deployed to devnet; configs initialized; pause / unauthorized-pause rejection / unpause drill passed 9 October 2026. Latest listed CI and CodeQL runs passed. | Devnet uses a single deployer authority. Fresh mainnet program keys, mainnet authority custody, production oracle operations and pre-mainnet checklist closure are still required. |

## 1. System scope and architecture

### 1.1 Implemented v1 scope

- Chain: Solana. Program framework: Anchor 0.32.1.
- AMM withdrawal adapter: Raydium AMM V4 only. A pool must be parsed as the
  expected Raydium V4 AmmInfo account and meet the protocol's on-chain checks.
- Salvage conversion: WSOL-side recovery and an opaque Jupiter v6 route
  payload supplied by the salvor client. The vault validates route-account
  boundaries and slippage, then forwards route data to the configured
  Jupiter program.
- Eligibility requires all six configured criteria. A pool failing any one
  criterion fails eligibility; this is not a weighted score on-chain.
- No protocol token, NFT, points programme, airdrop, or staking layer is
  included in the current design.

### 1.2 Main components

| Component | Responsibility | Code location |
|-----------|----------------|---------------|
| GraveScanner | On-chain source of truth for eligibility; records launch-price evidence; evaluates Phase 1 and Phase 2; issues eligibility PDAs. | `programs/grave-scanner/` |
| GraveVault | Consumes a fresh Scanner certificate; withdraws liquidity through the Raydium V4 CPI; converts eligible recovered tokens; distributes SOL; records receipt and claim state. | `programs/grave-vault/` |
| Salvor SDK | IDL-free TypeScript builders and helpers for evaluating, recording signed evidence, creating scanner instructions, preparing snapshots/proofs, building salvage instructions and claims. | `sdk/` |
| GraveScanner v2 indexer | Off-chain candidate discovery and ranking; can work in discovery-only mode or sign/submit C1 activity evidence when configured. | `indexer/` |
| Snapshotter | Deterministically enumerates LP balances, reconciles supported UNCX locked LP and emits a sealed snapshot/Merkle artifact for claims. | `snapshotter/` |
| Deployment and operator tooling | Toolchain checks, deploy/config scripts and devnet control drill. | `scripts/`, [`DEVNET.md`](DEVNET.md) |

### 1.3 Lifecycle overview

```
Raydium V4 pool discovery
  |
  v
Off-chain history/reserve analysis and signed C1/C2 evidence
  |
  v
GraveScanner: record launch price -> Phase 1 -> wait >= 2 epochs -> Phase 2
  |                         |
  |                         v
  |            EligibilityCert PDA (time-limited)
  |                         |
  v                         v
LP-holder snapshot -> Merkle tree/artifact -> GraveVault salvage_pool
  |
  v
Raydium V4 withdraw -> optional Jupiter route
  |
  v
SOL proceeds settled 40 / 40 / 20
  |
  v
LP holders claim pro-rata from Merkle proofs
  |
  v
retained memecoin -> sweep_dust
```

The SDK can construct the attestations and instructions, but the actual
historical derivation and signing services still require production
operation. The on-chain Scanner — not an indexer score or an SDK response —
is the authority that can produce the certificate the Vault accepts.

## 2. Derelict-pool eligibility criteria

The same on-chain evaluator is called in Phase 1 and Phase 2. The six
criteria must all pass and the resulting criterion bitmap is `0x3F`.
Default values below reflect the initialized devnet configuration and
constants in the current repository; governance configuration can change
some thresholds within program bounds.

| ID | Criterion | Default / rule | Evidence and caveat |
|----|-----------|----------------|---------------------|
| C1 | Trading inactivity | At least 90 days: `current_time - last_swap_time >= 7,776,000` seconds. | 112-byte Ed25519 activity-oracle attestation. The signature binds AMM program, pool, last-swap timestamp, issued slot and slot hash. The issued slot must still be present and hash-matched in SlotHashes (roughly 512 slots). |
| C2 | Price collapse from launch | Price decline of at least 99% (9,900 bps). Launch price is fixed at the pool reserve ratio immediately before its first successful swap. | 168-byte Ed25519 launch-price-oracle attestation, stored once per pool. The evaluator recomputes current spot price from validated reserves and checks that the stored base/quote mints match the pool. No SlotHashes freshness window is used for this historical baseline. |
| C3 | Minimum residual TVL | Configured floor: 500,000,000 raw units from the Raydium `pc_vault` / quote-side reserve. | The code reads the raw PC-side token amount; it does not normalize every quote mint to USD or a common decimal scale. That equals 0.5 SOL only when the PC mint is WSOL; with USDC it is 500 USDC raw units at 6 decimals. Confirm unit parity between the indexer pre-filter and on-chain criterion for both pool orientations. |
| C4 | LP supply not burned | LP mint supply must be strictly greater than 1,000 raw LP units. | Read from the LP mint's SPL supply. The fixed raw-unit threshold is a known limitation; a small residual supply relative to original supply can still pass. |
| C5 | No LP lock | The detected locked LP amount must equal zero. | On-chain introspection covers the UNCX Raydium AMM V4 locker. PinkSale, Team Finance, Streamflow and other lockers are not comprehensively detected by the on-chain v1 adapter. Operators must do out-of-band checks; this is a material coverage limitation. |
| C6 | Multi-epoch confirmation | Phase 2 must occur at least 2 Solana epochs after Phase 1, approximately 4–6 days, and repeat the same criterion bitmap. | On-chain epoch/anchor state. Phase 2 requires a fresh C1 attestation. An invalidated anchor cannot be certified; a live certificate cannot be overwritten, while an expired certificate can be reissued in place. |

**Oracle distinction.** The code uses protocol-configured Ed25519 signing
keys for activity (C1) and launch-price (C2) attestations. It does not
currently use Pyth as the price-collapse oracle described in the old
technical document. On-chain signature validation is implemented; hosting,
archival history derivation, key custody/rotation and downtime response
remain operational requirements.

## 3. GraveScanner program

### 3.1 Responsibilities

GraveScanner validates pool identity and supported AMM account layouts,
verifies signed C1/C2 evidence, evaluates all six criteria, and writes
state used by GraveVault. It does not withdraw liquidity or distribute
proceeds.

### 3.2 Public instructions

| Instruction | Purpose | Access / important behavior |
|-------------|---------|------------------------------|
| `initialize` | Creates the singleton ProtocolConfig PDA with initial thresholds and oracle keys. | One-time configuration initialization. |
| `record_launch_price` | Stores the first-swap launch-price baseline for a pool. | Requires the 168-byte launch-price Ed25519 attestation; init-once per pool. |
| `evaluate_pool_phase_1` | Evaluates C1–C6 and creates EligibilityAnchor with `first_eligible_epoch` and the bitmap. | Requires the 112-byte C1 attestation and supported Raydium V4 account evidence. |
| `evaluate_pool_phase_2` | Re-evaluates all six criteria after the epoch gap and creates or reissues EligibilityCert. | Requires a fresh C1 attestation; bitmap must match the anchor; certificate TTL defaults to one hour, with a 10-minute minimum. |
| `invalidate_anchor` | Invalidates an anchor before Phase 2. | Authority-gated; an anchor invalidated this way cannot lead to a certificate. |
| `sweep_stale_anchor` | Closes a stale, uncertified anchor after its configured staleness window. | Permissionless; rent returns to the original anchor writer. Does not confer salvage rights. |
| `update_protocol_config` | Updates bounded thresholds and oracle/authority settings. | Authority-gated. The 72-hour parameter-change delay is enforced by the intended multisig scheduling process, not by an on-chain timelock implementation. |
| `emergency_pause` | Sets or clears the Scanner pause flag. | Authority-gated; gates Phase 1 and Phase 2. Cleanup and governance paths remain available. |

### 3.3 Scanner state

| Account / PDA | Seeds | Purpose |
|---------------|-------|---------|
| ProtocolConfig | `["protocol_config"]` | Thresholds, authority, activity/launch-price oracle keys, pause status and bounded configuration. |
| LaunchPrice | `["launch_price", amm_program_id, pool_address]` | One-time launch-price provenance for a pool, including its mint pair and first-swap evidence fields. |
| EligibilityAnchor | `["eligibility_anchor", amm_program_id, pool_address]` | Phase 1 result, first eligible epoch, bitmap, writer and invalidation state. |
| EligibilityCert | `["eligibility_cert", amm_program_id, pool_address]` | Phase 2 certification, expiry, criterion bitmap and reissue generation counter. Consumed by GraveVault. |

## 4. GraveVault settlement program

### 4.1 Preflight and execution

1. Check the Vault is not paused and the supplied EligibilityCert is
   correctly derived under the GraveScanner program, fresh, bound to the
   submitted pool/AMM and has bitmap `0x3F`.
2. Initialize the per-pool registry and receipt PDAs. These init-once PDAs
   prevent a second successful salvage for the same pool.
3. Parse the pool's own Raydium V4 mint fields and derive the base
   orientation. Exactly one pool side must be WSOL; no-WSOL pools fail
   before any CPI. Submitted LP/memecoin mints are checked against the pool
   data.
4. Validate snapshot supply against the current LP mint supply and validate
   the expected Raydium V4 CPI accounts. The salvor signs the transaction;
   the V4 withdrawal burns the configured LP amount from the salvor's own
   LP token account in place. Recovered tokens are received by
   Vault-controlled token accounts.
5. Validate Jupiter route accounts: they may not reference Vault
   custody/state accounts, and the Vault WSOL destination must be present.
   Route instruction data itself is forwarded as an opaque Jupiter v6
   payload.
6. When the swap leg is active, enforce a pre-CPI floor based on the
   pool-implied conversion and the effective slippage cap. The default
   configured slippage cap is 300 bps; a per-transaction override can only
   tighten it, and a hard maximum is also applied. Enforce the delivered
   swap-leg output floor after the CPI.
7. If the amount eligible for conversion is below the configured dust
   threshold (default 666,666 raw units), the swap can be skipped. Retained
   memecoin and mint are recorded in the receipt rather than silently
   counted as settled proceeds.
8. Convert recovered WSOL to native SOL, distribute the proceeds, populate
   PoolRegistry and SalvageReceipt, and emit settlement events. Rounding
   remainder is allocated to the protocol share so the distribution
   accounts for all recovered lamports.

### 4.2 Settlement allocation

| Recipient / bucket | Default share | Mechanism |
|--------------------|---------------|-----------|
| Snapshot LP-holder bucket | 40% | Deposited into the per-pool `lp_holder_pool_vault`. Addresses/balances in the sealed snapshot claim pro-rata by Merkle proof; this is not independent proof of launch-time historical ownership. |
| Salvor | 40% | Paid to the transaction's salvor as settlement compensation. |
| Protocol treasury | 20% maximum; default 20% | Calculated as the remaining share after LP-holder and salvor portions. On-chain configuration prevents the protocol share from exceeding 20%; rounding remainder accrues here. |

The allocation is a split of recovered SOL proceeds. Retained memecoin dust
or route residual is accounted for separately on the receipt and
recoverable through `sweep_dust`; it is not silently added to the SOL
distribution amounts.

### 4.3 Vault instructions

| Instruction | Purpose | Access / important behavior |
|-------------|---------|------------------------------|
| `initialize` | Creates the Vault singleton ProtocolConfig. | One-time config initialization. |
| `update_protocol_config` | Updates allowed settlement/fee/slippage parameters and authority. | Authority-gated; protocol share ceiling is enforced on-chain. Parameter timelock remains multisig-process enforced. |
| `emergency_pause` | Sets or clears the Vault pause flag. | Authority-gated. Pauses new `salvage_pool` calls but leaves LP claims enabled. |
| `salvage_pool` | Executes withdrawal, optional swap, 40/40/20 settlement and receipt/registry creation. | Permissionless entry point subject to all on-chain certificate and account checks. The salvor supplies their own LP amount. |
| `claim_lp_proceeds` | Pays a holder their pro-rata portion of the LP bucket after Merkle proof verification. | Permissionless per holder; remains callable during emergency pause; duplicate claim is rejected by a ClaimRecord PDA. |
| `sweep_dust` | Transfers retained memecoin from the Vault ATA to the protocol treasury ATA and closes the Vault token account. | Permissionless, mint-bound and one-shot. The account-close rent goes to the sweeper; LP-holder SOL proceeds are not affected. |

### 4.4 Vault state

| Account / PDA | Seeds | Purpose |
|---------------|-------|---------|
| ProtocolConfig | `["protocol_config"]` | Authority, split parameters, slippage/dust/fee policy values and pause flag. |
| PoolRegistry | `["pool_registry", pool_address]` | Immutable per-pool salvage record including snapshot root/supply, LP bucket totals, claimed amount and timestamps. |
| `lp_holder_pool_vault` | `["lp_holder_pool", pool_address]` | System-owned PDA bucket containing the LP-holder SOL share. Only `claim_lp_proceeds` has a code path to debit it. |
| SalvageReceipt | `["salvage_receipt", pool_address]` | Settlement amounts and times, associated memecoin mint, retained memecoin amount and dust sweep timestamp. |
| ClaimRecord | `["claim_record", pool_address, holder]` | One-time record preventing repeated claim by the same holder for a pool. |
| Vault singleton authority | `["vault_authority"]` | PDA authority for required token transfers and distributions. |

## 5. LP snapshot, Merkle proof and claims

### 5.1 Snapshot producer

The Rust crate `grave-snapshotter` produces the off-chain snapshot used to
build the LP-holder Merkle root. It enumerates SPL token accounts for the
LP mint and enforces a hard completeness condition: the sum of enumerated
LP balances must equal the LP mint supply. It aggregates accounts by owner
in deterministic public-key order, records sink/exclusion balances, and
attributes detected UNCX locked LP to the beneficial `TokenLock.lock_owner`
after custody reconciliation. Ambiguous locked-LP custody must fail closed
rather than guess.

### 5.2 Merkle convention

```
Leaf   = SHA256(holder_pubkey_32_bytes || balance_u64_little_endian)
Parent = SHA256(min(child_a, child_b) || max(child_a, child_b))
Odd node at a level = promote unchanged (no proof element is added)
```

The same convention is implemented in the Rust snapshotter, TypeScript SDK
and on-chain verifier. The snapshotter can persist the root,
pool/mint/slot/supply metadata, entries, leaves and proofs in deterministic
JSON and verify that the artifact rebuilds from its persisted entries.

### 5.3 Claim calculation

```
claim_amount = floor(lp_holder_pool_total_lamports
                     * lp_balance_at_snapshot
                     / lp_total_supply_at_snapshot)
```

- The claim instruction verifies the holder/balance leaf against the
  immutable root stored in PoolRegistry.
- A ClaimRecord PDA prevents a second claim by the same (pool, holder)
  pair. Cumulative claims are capped against the total LP-holder bucket.
- The claim operation does not check the emergency pause flag, so claims
  remain available while new salvages are paused.
- The on-chain program checks the snapshot supply against live LP mint
  supply at salvage time, but does not independently reproduce the
  off-chain enumeration. Supply equality alone does not prove that
  per-holder balances have not changed since the snapshot; snapshot
  freshness, timing and artifact handling remain important operational
  controls.
- "Original LP holder" should not be read as a cryptographically
  established launch-time identity: the current artifact is based on LP
  token ownership/balances in the snapshot. An address holding LP at
  snapshot time can appear regardless of when it acquired those tokens; a
  historic participant with no balance represented in the artifact has no
  claim leaf.

## 6. TypeScript SDK and indexer

### 6.1 SDK

The `@graveyield/sdk` workspace package uses an IDL-free
instruction-builder pattern. The current source provides utilities for
config/PDA reads, evaluation and per-criterion reporting, C1/C2
attestation message construction, Phase 1/Phase 2 instruction builders, LP
snapshotting, Merkle tree construction, combined Phase-2-plus-salvage
instruction assembly, claims, account decoding, simulation and priority-fee
policy.

The bundle helper assembles the C1 verification precompile, Phase 2
certification and `salvage_pool` instructions for a single atomic
transaction; the caller remains responsible for assembling/signing/sending
the transaction with the right accounts and route data. SDK code is present
and tested as a workspace package; this document does not claim it is
published as a general-purpose npm package.

### 6.2 GraveScanner v2 indexer

The indexer is an off-chain wide funnel, not the eligibility authority. It
targets Raydium V4 only and includes the following implemented stages:

1. Enumerate Raydium V4 AmmInfo accounts (752-byte account size filter).
2. Derive last activity from RPC signature history and cache results.
3. Read vault reserves, identify the WSOL side, obtain LP mint supply and
   apply TVL/reserve filters.
4. Read token metadata such as mint supply and decimals.
5. Score likely candidates using inactivity, TVL and price-collapse margins.
6. Deduplicate and queue candidates by score.
7. Optionally sign and submit C1 Phase 1 transactions when the activity
   oracle key is configured; otherwise run discovery-only.
8. Track the on-chain EligibilityAnchor and later EligibilityCert PDAs.

The current environment-based configuration includes `RPC_URL`, `CLUSTER`,
`SCANNER_PROGRAM_ID`, `ACTIVITY_ORACLE_KEY`, eligibility thresholds,
candidate batch size, polling interval and activity-history scan limit.
The checked-in README defaults to devnet and discovery-only mode unless the
oracle key is supplied. Production use needs stronger service operations
than the existence of this pipeline alone provides.

### 6.3 Oracle operations remain separate work

The current code implements on-chain verification of signed evidence and
includes indexer/SDK-side derivation helpers, but the pre-mainnet checklist
still identifies production oracle operations as unresolved. A mainnet
service must derive reliable historical values (the launch-price baseline
needs full-history/archive access), protect and rotate the separate
activity and launch-price keys, monitor the short C1 freshness window,
define oracle downtime behavior and maintain reproducible evidence. Do not
interpret "oracle attestation verifies on-chain" as "production oracle
operations are complete."

## 7. Security model and trust boundaries

| Control / claim | Enforcement layer | Practical meaning |
|-----------------|-------------------|-------------------|
| Six eligibility criteria and matching Phase 1/2 bitmap | On-chain | Scanner rejects failed criteria and Phase 2 cannot silently downgrade a Phase 1 pass. |
| C1/C2 signed evidence binding | On-chain cryptographic validation + off-chain derivation | Signatures and payload binding are checked by the runtime precompile/on-chain handler. The trusted key and honesty/completeness of the historical derivation remain operational trust boundaries. |
| UNCX lock evidence | On-chain checks for supplied evidence; broader completeness is off-chain | Supplied UNCX marker/lock accounts are strictly validated. Other locker contracts are not detected comprehensively in v1. |
| One successful salvage per pool | On-chain | Init-once registry and receipt PDAs block a second successful salvage using the same pool registry/receipt derivation. |
| Vault custody and claim bucket | On-chain PDA/account constraints | The Vault authority signs its required transfers; the LP-holder SOL bucket has no admin sweep instruction and claims remain available during pause. |
| Share ceiling and settlement conservation | On-chain | Protocol share cannot exceed 20%; rounding remainder is assigned to protocol share. |
| Slippage and route boundary checks | On-chain | The submitted floor must cover pool-implied conversion under the cap before Jupiter CPI; actual output must also clear the floor. Route account list is screened against Vault accounts. |
| Priority-fee ceiling | SDK/operator | A client-side rejection/policy only. The on-chain program cannot observe transaction priority fees and does not enforce this ceiling. |
| 72-hour config timelock | Governance process | Intended to be enforced by Squads v4 transaction-buffer scheduling; it is not a program-enforced delay in the current code. |
| Upgrade notice, emergency upgrade delay and multisig membership | Charter / operational governance | These are governance commitments, not automatic enforcement by the program bytecode. |

### 7.1 Test evidence and its limits

The repository contains host unit tests, TypeScript SDK and indexer tests,
snapshotter tests, and Solana program-test fork suites. The current
full-lifecycle fork suite runs Scanner certification and attestation checks
along with the Vault settlement path using real mainnet Raydium
V4/OpenBook/SPL-token bytecode and real runtime Ed25519 verification. The
Jupiter v6 path in the fork environment uses a documented test-only
stand-in at the Jupiter program ID that invokes a real Raydium swap; this
is not proof that the real Jupiter aggregator binary was exercised in the
test harness.

The latest listed GitHub main-branch CI run on commit
`5cc46cdce13e259b45fb0ffb4d88224fe56c06ca` passed its named jobs:
`cargo fmt --check`, `cargo clippy`, `anchor build`, `pnpm typecheck`, and
terminology lint. The matching CodeQL run also passed. CI runs
`anchor build --no-idl`; this status should not be described as proof of
successful Anchor IDL generation, a full `anchor test`, a formal
independent audit, or mainnet readiness.

## 8. Toolchain, build and testing

### 8.1 Pinned toolchain

| Tool | Repository pin / requirement |
|------|-------------------------------|
| Solana CLI | 3.0.10 |
| Anchor CLI / framework | 0.32.1 |
| Rust host toolchain | 1.91.1 stable (rustfmt and clippy components) |
| Node.js | 24 or later |
| pnpm | 9.x; root package manager field pins pnpm 9.12.0 |

### 8.2 Repository quickstart

```bash
pnpm install
anchor build
pnpm -r typecheck
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
anchor test
```

`anchor test` is part of the documented developer quickstart; do not infer
it ran in the latest CI workflow from the listed successful jobs. In
current CI the Anchor build job uses `anchor build --no-idl`; IDL
generation is a separate follow-up because of the nightly-toolchain
requirement in the current build notes.

### 8.3 Additional tests

- SDK tests: 108 tests reported in the repository test documentation,
  covering binary serialization, instruction discriminators, PDA
  derivation, Merkle vectors, priority-fee policy and attestation wire
  formats. Read-only devnet smoke tests are skipped when `DEVNET_RPC_URL`
  is unset.
- Indexer tests: 29 tests reported for the six-criterion pre-filter,
  priority queue, scoring and config loading.
- Snapshotter: 53 host tests reported in `tests/README.md`, including
  supply/accounting invariants, Merkle agreement and locker attribution.
- Fork suites cover Scanner windows, Raydium V4 withdrawal, Jupiter
  conversion wrapper path, settlement economics, LP claims,
  security-negative cases and the integrated lifecycle. Test harnesses and
  fixtures must be reviewed when making claims about which external
  programs were executed as real bytecode.

## 9. Devnet deployment status

As recorded in [`DEVNET.md`](DEVNET.md), both programs are deployed on
Solana devnet, both ProtocolConfig PDAs are initialized, and the
emergency-control drill was executed on 9 October 2026. The drill verified
authority pause, readback, rejection of an intruder pause attempt,
authority unpause, and state readback on both programs.

| Program | Devnet program ID |
|---------|-------------------|
| GraveScanner | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` |
| GraveVault | `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` |

**Deployment qualification.** Devnet is not mainnet. The current devnet
upgrade authority is the deployer keypair, not the intended production
multisig. The devnet keypairs are disposable and must never be reused for
mainnet. The current runbook does not claim a controlled real-pool salvage
has been completed on devnet; the settlement evidence comes from the local
Solana program-test fork harness.

### 9.1 Initialized default values

| GraveScanner setting | Default | GraveVault setting | Default |
|----------------------|---------|--------------------|---------|
| `inactivity_seconds` | 7,776,000 (90 days) | `lp_holder_share_bps` | 4,000 (40%) |
| `price_collapse_bps` | 9,900 (99%) | `salvor_share_bps` | 4,000 (40%) |
| `min_tvl_lamports` | 500,000,000 raw PC-side units | `protocol_share_bps` | 2,000 (20% ceiling/default) |
| `anchor_staleness_seconds` | 1,209,600 (14 days) | `max_priority_fee_ceiling_lamports` | 1,000,000,000 (SDK advisory policy value) |
| `lp_burn_dust_threshold` | 1,000 raw LP units | `max_slippage_bps` | 300 (3%) |
| `cert_ttl_seconds` | 3,600 (1 hour; 600-second minimum) | `jupiter_dust_threshold_lamports` | 666,666 raw units |
| `timelock_seconds` | 259,200 (72 hours; process enforced) | | |

## 10. Pre-mainnet blockers and unresolved design questions

The current repository's pre-mainnet checklist
([`PRE_MAINNET_CHECKLIST.md`](PRE_MAINNET_CHECKLIST.md)) is the operational
list for closure. Items below are the most material implementation or
deployment gaps surfaced by the current source and runbooks, rather than a
promise that this list is exhaustive.

| Item | Status / issue | Required before mainnet or broader claims |
|------|----------------|--------------------------------------------|
| Mainnet keys and custody (KEYS-003) | Open / marked critical. | Generate fresh program keypairs under production custody, update `declare_id!` and Anchor configuration consistently, and place upgrade authority under the intended multisig. Never promote the disposable devnet keys. |
| Oracle operations (ORACLE-003) | Open / marked critical. | Run or provision reliable C1 last-swap and C2 launch-price derivation services, full-history/archive RPC for the launch baseline, separate key custody and rotation drills, C1 freshness monitoring, and documented outage response. |
| Other lockers (LOCKER-002) | Open. | Document and enforce an external locker-screening process or implement and verify additional locker adapters. In the current implementation, non-UNCX locks can be missed by on-chain C5. |
| LP-supply dust threshold (KEYS-002) | Open / marked warning. | Revisit the fixed 1,000 raw-token threshold. The current comparison does not express LP supply as a fraction of original supply and may not distinguish all semi-burned cases. |
| Governance timelock (GOV-001) | Open / marked warning. | Either implement a true on-chain timelock or keep documentation and governance operations explicit that the 72-hour delay depends on multisig scheduling. Current on-chain fields are reserved/write-only. |
| Additional AMM adapters | Not implemented for v1; marked as future work in code/checklist. | Raydium CLMM, Orca Whirlpool, PumpSwap and Meteora code paths are not operational: Scanner parsers and/or Vault withdrawal CPIs revert as unimplemented. Scope claims should remain Raydium V4 only unless those adapters are completed and tested. |
| Jupiter aggregator integration test coverage | Partial test substitute. | The fork suite uses a test-only stand-in at the Jupiter v6 program ID. A release review should add a separate test/verification plan for the deployed aggregator behavior and route compatibility. |
| C3 TVL unit consistency | Needs explicit invariant/review before broad pool processing. | The on-chain evaluator reads the raw Raydium PC-vault token amount against a setting named `min_tvl_lamports`; the indexer describes computing TVL using the WSOL side. Verify both paths compare the same denomination for coin=WSOL and PC=WSOL orientations, and specify decimals/value normalization before broadening pool support. |
| Snapshot timing / holder balances | Important operational correctness boundary. | The off-chain snapshot must be generated from the right ledger point and kept consistent through salvage. LP transfers can change holder balances without changing supply. The snapshot represents current LP-token ownership at snapshot time; it does not establish who provided liquidity at launch or otherwise prove historic "original LP" identity. |
| Who can supply the LP being withdrawn? | Core product/economic model question to resolve explicitly. | `salvage_pool` burns the salvor's LP tokens in the salvor's account. The reviewed code does not demonstrate a mechanism that forcibly redeems LP tokens still held by non-participating historical holders. Specify how the salvor obtains/owns the LP amount and how the LP-holder snapshot and settlement split account for that reality before describing this as a general whole-pool settlement. |
| Published docs drift | Resolved for the canonical set. | Root README and docs/README.md previously linked Markdown/DOCX/PDF/architecture files that were not present on main. The living markdown sources (this file, the combined GraveScanner × GraveVault doc, the GhostPools research cover and the three architecture deep-dives) are now committed, and the two PDF artifacts live under `docs/published/`. Remaining `.docx` snapshots stay external publishing artifacts. |

## 11. Canonical sources and document precedence

For protocol semantics, [`PROTOCOL_SPEC.md`](PROTOCOL_SPEC.md) declares
itself the governing specification and says it wins over the whitepaper and
README when they disagree. The specification's introductory baseline SHA
(main @ `4b8e0b1`) is older than the repository commit reviewed for this
document; review status/version notes before treating every status
statement inside the specification as current. The current code, current
pre-mainnet checklist and current test documentation were cross-checked for
implementation status.

| Source | Purpose |
|--------|---------|
| [`PROTOCOL_SPEC.md`](PROTOCOL_SPEC.md) | Normative criteria, evidence model, on-chain guarantees, resolved protocol decisions and discrepancy ledger. |
| [`PRE_MAINNET_CHECKLIST.md`](PRE_MAINNET_CHECKLIST.md) | Tracked pre-mainnet implementation and operations blockers, with retirement status for resolved items. |
| [`DEVNET.md`](DEVNET.md) | Actual devnet program IDs, deployment and configuration details, emergency-control drill evidence and limitations. |
| [`error_codes.md`](error_codes.md) | Authoritative on-chain error-code tables for both programs. |
| `sdk/README.md`, `indexer/README.md`, `tests/README.md` | Current off-chain package capabilities and the stated test strategy/coverage. |
| Program source under `programs/` and `snapshotter/` | Implementation authority for instruction behavior, account checks, settlement, claims and snapshot conventions. |

## 12. Revision history

| Version | Date | Change |
|---------|------|--------|
| 3.0 | May 2026 | Previous technical overview. It predated the current implementation and contained stale version, AMM-support, oracle, governance and deployment claims. |
| 4.0 | 9 October 2026 | Rewritten against current main: Raydium V4-only scope; signed C1/C2 evidence; two-phase Scanner; Vault withdrawal/conversion/distribution/claims/dust handling; SDK, indexer and snapshotter; actual devnet status; CI status; trust boundaries and pre-mainnet blockers. Published as `published/GraveYield_TechnicalDocumentation_v4_0.pdf`; this living markdown established alongside it. |

This is an implementation snapshot, not an independent audit or mainnet
approval. Revise it when code, AMM scope, oracle operations, settlement
logic or deployment status changes.
