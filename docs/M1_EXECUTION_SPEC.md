# GraveYield M1 Execution Specification

**Document ID:** `GY-M1-SPEC-001`
**Version:** 1.0.0
**Status:** OWNER-AUTHORIZED SPECIFICATION — NOT EXECUTION AUTHORIZATION
**Date:** 2026-11-19 (UTC+8)
**Decision basis:** `DR-003`, `GY-M1-ODR-001`, `GY-M1-CR-001`

## 0. Purpose and authority

This document defines the owner-approved M1 lifecycle, its environment, evidence requirements, gates, and completion criteria. It is a separate M1 execution specification. It does not replace or silently revise the frozen `docs/PROTOCOL_SPEC.md` v1.0.0.

M1 is a complete, evidenced lifecycle on a **local Solana Mainnet-fork validator using genuine Mainnet fixtures**. M1 completion demonstrates lifecycle machinery under the specified fork conditions. It does not establish Mainnet production readiness, security-audit completion, production custody readiness, or permission to operate on Mainnet.

Normative owner decisions are recorded in `docs/DECISIONS.md` under DR-003 and in `docs/decisions/GY-M1-OWNER-DECISIONS-001.md`.

## 1. Environment

### 1.1 Selected cluster

- Local Solana validator forked from Mainnet state.
- Genuine Mainnet Raydium AMM V4 program and relevant OpenBook market dependencies at the required addresses.
- Jupiter integration must be Mainnet-compatible but execute against the local fork.
- All transaction state changes remain on the local validator.
- No real user funds are used.
- All evidence labels the environment exactly as a local Mainnet fork.

The existence of a policy selection does not prove that the selected Jupiter integration works. Before lifecycle execution, validate quote construction, program availability, account dependencies, transaction simulation, and a successful fork-only swap.

### 1.2 Time policy

- C1 requires at least 7,776,000 seconds of actual elapsed time since the last genuine swap.
- C6 requires at least two actual local-validator epoch transitions between Phase 1 and Phase 2.
- No clock acceleration, timestamp manipulation, epoch skipping, backdating, or synthetic inactivity evidence.
- Record validator start/stop events, restarts, epoch values, observed timestamps, and interruptions.
- Persist validator state and evidence so elapsed time and epoch transitions can be independently audited.
- A restart or loss of state does not permit an operator to claim unobserved time or transitions.

### 1.3 Keys

Use dedicated owner-controlled local-fork keys, isolated from Mainnet production keys. Deployment and C1/C2 oracle identities must be separate. No private key material may enter Git, evidence bundles, or agent context. Before live stages, record the custodian, storage, access controls, cluster guard, rotation/recovery procedure, and funded payer. This specification does not generate or authorize keys.

## 2. Preserved protocol rules

### 2.1 Six eligibility criteria

| Criterion | Exact condition |
|---|---|
| C1 | `now - last_swap_unix_ts >= 7,776,000` seconds |
| C2 | Price collapse `>= 9,900` bps |
| C3 | WSOL quote-side raw balance `>= 500,000,000` |
| C4 | LP mint supply `> 1,000` raw units |
| C5 | Locked LP amount `== 0` |
| C6 | `current_epoch - first_eligible_epoch >= 2` |

C3 M1 sourcing restriction: the Raydium `pc_mint` is WSOL and the other mint is non-WSOL. Exactly one WSOL side is required. This is an M1 discovery/sourcing predicate, not a permanent restriction on the protocol's settlement orientation logic.

No manual override, weakened threshold, or incomplete-evidence pass is allowed.

### 2.2 Settlement economics

Preserve exact 40/40/20:
- 40% direct Salvor allocation;
- 40% LP-holder allocation;
- 20% protocol allocation ceiling/share under the current configuration and rounding rules.

The P2 policy does not change the allocation percentages. It means the Salvor does not claim the LP-holder leaf attributable to Salvor-controlled wallets. That leaf remains in the distribution and unclaimed; it is not redistributed. The current claim program does not enforce this renunciation on-chain. A project-wallet watchlist and monitoring are required.

### 2.3 Other invariants

- Original LP-holder entitlements may not be silently removed, diluted, or reassigned.
- Critical settlement operations remain atomic.
- Duplicate claims fail.
- The LP-holder bucket remains unsweepable under the current design.
- No real user funds are used for M1.
- One successful settlement per pool.

## 3. Canonical architecture

- `grave-indexer`: canonical discovery and C1 evidence pipeline.
- `graveyield-protocol`: candidate scoring, queue orchestration, submission scheduling, and GraveScanner integration.
- GraveScanner: sole on-chain eligibility authority.
- GraveVault: settlement and LP restitution.
- SDK: canonical wire formats, PDA derivation, and instruction construction.
- `salvor-bots`: execution agents using one designated path; queueing prevents competing bots from submitting against the same candidate.
- `ops/`: operational supervision, evidence monitoring, and artifact retention.

No independent duplicate discovery/signing path may bypass canonical C1 evidence. Q-05 is resolved by wiring the canonical indexer evidence into the protocol evaluation and execution path. This is an engineering prerequisite, not a claim that the wiring already exists.

## 4. Fifteen-stage M1 lifecycle

Each stage requires a dated evidence record. The stage order below preserves the owner-approved lifecycle. A dependency may be performed earlier when required for correctness; in particular, snapshot capture is necessarily pre-salvage because the registry seals the root during salvage. Stage 10 is the final artifact publication/integrity checkpoint.

### Stage 1 — Fork deployment and configuration

- Start the approved local Mainnet-fork validator from a recorded Mainnet fork point.
- Verify cluster identity and fixture program/account availability.
- Deploy the approved GraveScanner and GraveVault builds to the local fork.
- Initialize configuration with the six approved criteria, share configuration, oracle public keys, and required parameters.
- Verify program IDs, account owners, config bytes, and ELF/build digests.

**Evidence:** fork provenance, validator identity, deployment signatures, program/account readbacks, config decode, ELF digests, toolchain versions.

### Stage 2 — Oracle setup

- Register separate C1 activity-oracle and C2 launch-price-oracle identities.
- Verify key separation and custody.
- Verify the funded payer and G-12 → G-16 → G-17 transaction path.
- Verify the SlotHashes fetch implementation against actual SlotHashes sysvar entries; do not rely on `getBlock(slot).blockhash` as a substitute.
- Demonstrate signing, freshness, replay protection, and submission on the local fork.

**Gate:** no lifecycle progression until the fetchSlotHash fix and regression test pass, oracle custody is recorded, and the live fork submission path is demonstrated.

### Stage 3 — Genuine launch-price attestation

- Use genuine pool history and the actual first-swap baseline.
- Record the first-swap signature, slot, timestamp, mint orientation, reserve values, derived price, oracle message, and signature verification.
- Preserve the source history and reproducible derivation.

**Prohibited:** fabricated launch price, artificial oracle attestation, backdated first-swap evidence, or synthetic history represented as genuine.

### Stage 4 — Phase 1 evaluation

- Submit a genuine C1 attestation and Phase 1 evaluation.
- Verify the on-chain `EligibilityAnchor` and recorded `first_eligible_epoch`.
- Verify the C1 inactivity threshold using actual elapsed time.
- Preserve transaction signature, account state, oracle evidence, and verifier output.

### Stage 5 — Two actual epoch transitions

- Observe at least two actual local-validator epoch transitions after Phase 1.
- Record epoch values and timestamps independently.
- Do not accelerate time or manipulate epoch state.
- Record any validator restart or interruption and re-establish the evidence chain if continuity cannot be proven.

### Stage 6 — Phase 2 evaluation

- Obtain a fresh C1 attestation within the valid SlotHashes window.
- Re-run the identical evaluator.
- Verify C1–C6 bitmap equality and successful Phase 2 certification.
- Preserve signatures, account state, attestation bytes, epoch evidence, and verifier output.

### Stage 7 — Six-criteria certification

- Independently verify each criterion and its source.
- Complete the protocol-wide manual locker screening in `docs/ops/GY-OPS-RB-05.md`.
- Confirm no detected non-UNCX lock and no unknown custodian.
- Confirm D-01 M1 sourcing predicate.
- Confirm no missing, synthetic, stale, or contradictory evidence.

**Gate:** a qualified locker-screening PASS and complete certification evidence are required. The screening result must carry the mandatory best-effort limitation.

### Stage 8 — Snapshot validation and authorized salvage

**Pre-salvage dependency:** before the salvage transaction, run the Rust `grave-snapshotter` as the sole production snapshot/Merkle producer. Revalidate through an independent endpoint and compare the complete holder set, balances, total supply, and derived root at a consistent state. Apply only owner-approved sink exclusions with a complete ledger and reconciliation.

- Record snapshot slot, commitment, endpoints, supply, holder balances, root, artifact hash, and sink ledger.
- Confirm the full Salvor-controlled wallet set is included.
- Confirm the Salvor P2 no-claim watchlist.
- Publish the validated artifact before salvage.
- Verify the root submitted to salvage is exactly the root derived from the validated artifact.
- Simulate and submit one authorized salvage attempt.

**Gate:** no salvage if producer unification, independent revalidation, sink reconciliation, locker screening, or root equality is incomplete. Current code does not atomically compare every holder balance; this remains an accepted off-chain trust boundary, not a cryptographic guarantee.

### Stage 9 — 40/40/20 settlement reconciliation

- Verify the receipt and all three allocation legs.
- Verify exact conservation, including floor/rounding behavior.
- Verify protocol share does not exceed the 20% ceiling.
- Verify LP-holder bucket is intact and unsweepable.
- Verify Salvor receives the direct 40% leg.
- Verify no Salvor-controlled wallet claims its LP-holder leaf under P2.
- Record any unclaimed Salvor leaf as stranded; do not redistribute it.

**Evidence:** receipt bytes, account balances, transaction signature, reconciliation calculation, project-wallet watchlist results.

### Stage 10 — Snapshot/Merkle artifact publication and verification

- Publish the pre-salvage Rust snapshot artifact and manifest.
- Re-derive the Merkle root, leaves, and proofs.
- Verify artifact root equals the on-chain `PoolRegistry` root.
- Verify supply, enumeration, sink ledger, custody reconciliation, and hash manifest.
- Ensure the claims console consumes the same Rust artifact and cannot silently substitute an SDK-produced root.

This stage is the final artifact-integrity and claims-readiness checkpoint. Snapshot capture itself must already have occurred before Stage 8 salvage.

### Stage 11 — At least one legitimate LP-holder claim

- Select a legitimate non-Salvor LP holder with a valid leaf and proof.
- Verify the wallet owns the relevant claim and signs its claim transaction.
- Verify the on-chain claim amount against the sealed root and exact floor arithmetic.
- Confirm claims remain available under the approved pause semantics.

### Stage 12 — Duplicate claim rejection

- Attempt a second claim for the same `(pool, holder)` identity in a controlled test.
- Verify it fails without a second payout or state corruption.
- Preserve the failed transaction signature/error and before/after account states.

### Stage 13 — Dust accounting

- Verify retained dust fields on the receipt.
- Execute the one-shot `sweep_dust` path where applicable.
- Verify the destination is the protocol treasury ATA, the vault ATA closes as specified, and the receipt records the sweep.
- Verify the LP-holder bucket is untouched.

### Stage 14 — Failure and pause scenarios

Exercise the approved negative scenarios on the local fork:
- paused salvage rejection;
- invalid/missing/expired certification;
- stale or invalid oracle evidence;
- wrong pool/mint orientation;
- insufficient LP or supply drift;
- invalid Jupiter route/account dependencies;
- settlement CPI failure and atomic rollback;
- locker-screening disqualification;
- snapshot/root mismatch;
- duplicate claim;
- terminal retry/restart discipline.

Record each scenario, transaction signature where submitted, expected error, actual error, and before/after state. No scenario may use real user funds.

### Stage 15 — Evidence retention and final acceptance

Retain a complete evidence bundle:
- per-stage transaction signatures;
- account states and decoded values;
- RPC endpoint, commitment, slots, timestamps, epoch transitions;
- oracle messages/signatures and source history;
- snapshot artifacts, Merkle proofs, hashes, and sink ledger;
- locker-screening artifact and independent countersignature;
- ELF digests, source commit SHAs, toolchain versions;
- simulation/verifier outputs;
- settlement and claim reconciliation;
- failure/pause reports;
- validator restart/continuity log.

A stage is complete only when its required evidence is present, independently checkable, and correctly labelled as local Mainnet-fork evidence.

## 5. Snapshot trust boundary — explicit statement

The approved P1–P7 procedure is operationally binding. At the assessed code baseline:
- total LP supply is pinned on-chain at salvage;
- Merkle proofs are checked against the sealed registry root;
- the root itself is supplied at salvage and is not on-chain proven to derive from a complete holder enumeration;
- holder-level re-enumeration and drift invalidation are not implemented;
- the live SDK producer and Rust claims artifact path are asymmetric;
- sink exclusion support in the live CLI/SDK path is incomplete.

Therefore M1 may claim operational checks and evidence, but may not claim cryptographic proof of complete holder enumeration or holder-level ownership invariance. P1 producer unification and the other P1–P7 prerequisites are execution gates.

## 6. Locker-screening trust boundary

C5's on-chain adapter verifies UNCX only. The manual procedure expands screening to a ratified inventory plus generic custody enumeration. It is best-effort and cannot prove universal detection. Only program IDs/layouts independently confirmed and versioned in the inventory may be relied upon. Unknown custodians fail closed.

## 7. Engineering prerequisites before lifecycle execution

At minimum:
1. Fix `fetchSlotHash` to read the relevant SlotHashes sysvar `(slot, hash)` pair and add a regression test.
2. Implement D-01 M1 sourcing predicate in discovery/pre-filter, SDK M1-mode guard, and ops assertion.
3. Wire `grave-indexer` as canonical C1 evidence source and wire Q-05.
4. Wire Rust `grave-snapshotter` as sole production producer through the live pipeline and claims artifact path.
5. Implement independent endpoint revalidation, common commitment/slot handling, holder/balance comparison, and evidence outputs required by P1–P7.
6. Implement sink-ledger input and reconciliation in the Rust CLI path; fail closed on unsupported nonzero exclusions.
7. Validate Mainnet-compatible Jupiter quote/route and successful fork-only execution.
8. Implement cluster identity plumbing and fail-closed fork guards across deploy, SDK, bots, and console.
9. Implement Salvor project-wallet watchlist and no-claim monitoring for P2.
10. Execute GY-OPS-RB-05 with operator and independent reviewer.
11. Record key custody, oracle rotation, funded payer, and live submission path.
12. Complete all tests and preserve CI evidence.

This list is a specification gate, not a claim that these changes have landed.

## 8. M1 completion criteria

M1 is complete only when all fifteen stages pass with retained, independently verifiable evidence and the owner signs the final acceptance record.

M1 completion does **not** mean:
- Mainnet readiness;
- production key readiness;
- universal locker detection;
- cryptographic proof of holder-level snapshot invariance;
- completion of independent security audit;
- activation of all AMM adapters;
- permission to use real user funds or conduct Mainnet production operations.

## 9. Open items not silently resolved

- D-16 and G-18b remain unavailable identifiers with no operative M1 effect until original definitions are recovered.
- G-18 / ORACLE-003 remains a separate oracle-service operational gate.
- OWN-13 console O7 and PR #13/#14 dispositions remain open.
- OWN-14 operational oracle custodian, rotation, and funded payer remain to be recorded before live oracle stages.
- Mainnet program-level threshold floors and multisig/timelock activation remain pre-Mainnet requirements.
- Independent audit and other pre-Mainnet gates remain separate from M1.

## 10. Change control

Any change to eligibility thresholds, allocation percentages, snapshot policy, Salvor P2 renunciation, sink governance, cluster/time policy, or evidence requirements requires an explicit owner decision and a versioned specification update. Engineering must not infer policy from implementation convenience.
