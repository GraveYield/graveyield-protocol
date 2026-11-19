# GraveYield M1 Owner Decision Record

- **Decision ID:** `DR-003`
- **Owner decision bundle:** `GY-M1-ODR-001`
- **Related cluster ruling:** `GY-M1-CR-001`
- **Date:** 2026-11-19 (UTC+8)
- **Status:** OWNER-APPROVED — documentation formalization authorized
- **Amendments:** None

## 1. Approval provenance and scope

The project owner explicitly approved all ten items in the M1 decision package on 2026-11-19, with no amendments:

- D-04-A — voluntary OTC acquisition from consenting LP holders.
- D-04-B — P2: Salvor renounces its LP-holder claim; the direct 40% Salvor allocation remains.
- D-04-C — adopt a per-pool acquisition and restitution register.
- D-04-D — sink declarations require owner approval, independent review, and a published exclusion ledger.
- D-05 — ratify `GY-OPS-RB-05` and Q-04 with protocol-wide scope and best-effort limitations.
- D-09 — adopt the canonical `grave-indexer` → protocol evaluation/queue → Salvor execution architecture and wire Q-05.
- D-16 / G-18b — record as unavailable, with no operative M1 effect until original definitions are recovered.
- D-02 — documented governance-trust posture for M1; program-level floors and multisig/timelock controls are required before Mainnet.
- KEYS — owner-controlled, dedicated local-fork keys; separate deployment and oracle identities; no Mainnet key reuse.
- D-06 — ratify P1–P7 and define “match” as snapshot-time ownership.

This record formalizes owner policy. It does not certify that the approved controls have been implemented, tested, or executed.

## 2. GY-M1-CR-001 — execution cluster ruling

The owner selected:

- **Cluster:** local Solana Mainnet-fork validator using genuine Mainnet program fixtures.
- **Time policy:** actual elapsed time; no artificial clock acceleration or fabricated history.
- **Jupiter gateway:** Mainnet-compatible Jupiter integration against the local fork; all state changes and swaps remain on the local validator.
- **Key custody:** dedicated local-fork keys, isolated from Mainnet production keys.
- **Additional instructions:** none.

The local fork must be labelled as a **local Mainnet fork**, never as Solana Mainnet or Solana Testnet.

The 90-day C1 requirement must be supported by actual elapsed time and genuine pool history. C6 requires at least two actual local-validator epoch transitions between Phase 1 and Phase 2. Validator restarts, interruptions, and evidence gaps must be recorded. No timestamp manipulation, epoch skipping, or synthetic inactivity evidence is permitted.

Jupiter selection is a policy decision, not proof of technical compatibility. Before lifecycle reliance, engineering must verify quote construction, program availability, account dependencies, and a successful swap whose effects are confined to the local fork.

No real user funds may be used for M1.

## 3. D-01 — M1 WSOL sourcing restriction

The previously approved D-01 correction is reaffirmed:

- Exactly one pool mint must be WSOL.
- WSOL must be the Raydium `pc_mint` / quote side for M1 sourcing.
- The other mint must be non-WSOL.
- C3 remains `500,000,000` raw quote-side units.
- This is an M1 sourcing restriction, not a permanent protocol-wide orientation restriction.
- Implement this as a separate discovery/pre-filter predicate and M1-mode guard. Do not tighten the settlement-adjacent orientation logic.

The predicate is a required engineering change; it is not represented as already implemented.

## 4. D-02 — eligibility criteria and governance posture

The six approved criteria remain unchanged:

| Criterion | Required condition |
|---|---|
| C1 | At least `7,776,000` seconds (90 days) since last swap |
| C2 | Price collapse of at least `9,900` bps (99%) |
| C3 | At least `500,000,000` raw units on the WSOL quote side |
| C4 | LP supply strictly greater than `1,000` raw units |
| C5 | Zero locked LP |
| C6 | At least two epochs between Phase 1 and Phase 2 |

No manual eligibility override, incomplete-evidence pass, or weakening of these values is authorized.

**M1 governance posture:** documented governance trust. Current program configuration does not enforce immutable lower bounds for C1/C3/C4 and permits C2 to be set to zero within its upper bound. The project must not describe the thresholds as bytecode-immutable. M1 relies on owner-controlled governance authority and documented operating discipline.

**Before Mainnet:** add program-level threshold floors and activate the required multisig/timelock governance controls. This decision does not authorize a protocol upgrade now.

## 5. D-04 — acquisition, Salvor restitution, register, and sinks

### 5.1 Acquisition mechanism

M1 LP acquisition uses voluntary OTC acquisition from consenting LP holders. No forced transfer, confiscation, or unilateral reassignment is permitted.

Each acquisition must preserve:
- source wallet and counterparty identity;
- counterparty-acknowledged agreement or equivalent transaction-linked evidence;
- funding wallet and funding trail;
- LP mint and raw quantity;
- transaction signature and acquisition slot;
- pre/post token-account balances;
- relationship to the authoritative snapshot slot.

Acquisition should occur before the authoritative snapshot if the acquired LP is intended to appear as Salvor-held LP in that snapshot. An acquisition after the snapshot does not transfer the seller’s already-established snapshot claim to the buyer. The acquisition agreement must disclose this timing rule.

### 5.2 Salvor entitlement — P2 renunciation

The approved policy is **P2 — operational renunciation**:

- Salvor retains the direct 40% allocation.
- Salvor does not submit or receive a claim from the 40% LP-holder bucket for LP attributed to Salvor-controlled wallets at the authoritative snapshot.
- The Salvor’s snapshot leaf remains in the Merkle distribution unless a separately approved, technically valid exclusion is used.
- An unclaimed Salvor leaf is not redistributed. It remains unclaimed/stranded under the current unsweepable LP-holder-bucket design.
- The project must enumerate the full set of Salvor-controlled wallets and sub-wallets and maintain a no-claim watchlist.

**Enforcement boundary:** current claim code does not prohibit the Salvor from claiming its LP-holder leaf. P2 is therefore an operational policy with monitoring, not an on-chain restriction. No M1 document may claim otherwise. A future on-chain enforcement change requires a separate specification and owner approval.

### 5.3 Per-pool acquisition and restitution register

Adopt a mandatory per-pool register. Minimum record structure:

- `record_id`
- `pool`: cluster, AMM program, pool address, LP mint, quote mint, base mint
- `policy`: decision ID, P2 policy version, sink policy version
- `acquisition[]`: counterparty, source wallet, funding wallet, funding trail, transaction signature, slot, raw quantity, pre/post balances, agreement evidence hash
- `snapshot`: producer/version, RPC endpoints, commitment, snapshot slot, supply, holder enumeration hash, Merkle root, artifact path/hash, sink ledger, reconciliation result
- `salvage`: transaction signature, slot, receipt, burned LP, gross proceeds, exact 40/40/20 amounts, reconciliation result
- `claim.subwallets[]`: project/Salvor wallet inventory, claim signatures, claim status, P2 no-claim attestations and observer results
- `audit[]`: timestamp, actor, reviewer, event, artifact hashes, correction/supersession references

The register is updated at acquisition, snapshot, salvage, and claim events. It must be complete before salvage submission. No missing source, quantity, slot-ordering, or artifact linkage may be silently inferred.

### 5.4 Sink governance

A sink may not be declared by an operator acting alone.

Every sink declaration requires:
1. objective supporting evidence and an explicit classification rationale;
2. owner approval;
3. independent review;
4. publication in a per-pool exclusion ledger;
5. exact address, token account, LP mint, raw balance, evidence references, approval identities, and timestamp;
6. reconciliation proving `claimable entries + explicitly excluded balances == enumerated balances == LP mint supply`.

Unknown or disputed custody is not a sink and must fail closed. A sink declaration must never silently remove an LP-holder entitlement.

The live SDK producer and CLI currently have sink-exclusion limitations. Until the Rust producer/CLI path accepts and validates the governed ledger and passes reconciliation tests, any nonzero proposed exclusion must block M1 salvage. Operators must not manually delete holders from an artifact.

## 6. D-05 — GY-OPS-RB-05 and Q-04

Ratify `docs/ops/GY-OPS-RB-05.md` as the M1 manual locker-screening procedure.

Q-04 is resolved as **protocol-wide locker screening scope**, not UNCX-only scope. The rule applies to all LP locking/custody arrangements covered by the ratified inventory and generic custody enumeration.

- UNCX on-chain verification is mandatory.
- Confirmed non-UNCX locks disqualify the candidate.
- Unknown custodians disqualify the candidate.
- Incomplete inventory, failed queries, or incomplete custody enumeration cannot produce an unqualified PASS.
- Only UNCX is verified against the current in-repository adapter. Streamflow, Team Finance, PinkSale, and other candidate entries must not be relied upon until their program IDs, account layouts, and query filters are independently confirmed and added to a versioned inventory.
- An operator performs the check; an independent reviewer re-executes the UNCX check, samples other queries and custody enumeration, verifies hashes, and countersigns.
- The screening artifact is retained for the certification lifetime plus at least two years.
- Screening is completed before Phase 2 certification and re-verified within the certification TTL before salvage when it is not bundled into the same evidence window.

Mandatory qualification:

> Best-effort screening against a ratified inventory — not universal detection.

This procedure cannot establish detection of every possible locker, off-chain contractual lock, transient lock between checks, or custody pattern invisible to the queried account model.

## 7. D-06 — P1–P7 snapshot-integrity procedure

Ratify the following M1 off-chain control regime:

- **P1 — Sole producer:** Rust `grave-snapshotter` is the sole production snapshot and Merkle artifact producer. The SDK producer must not independently produce the root used for salvage.
- **P2 — Independent revalidation:** repeat the Rust snapshot process through an independent RPC endpoint and compare holder set, balances, supply, and derived root at a consistent commitment/state.
- **P3 — Immediate sequencing:** minimize the interval between final snapshot validation, salvage preparation, simulation, and submission. Record all slots and timestamps.
- **P4 — Artifact publication:** publish and hash the validated artifact and evidence before salvage submission; the root must match the root sealed by the on-chain registry.
- **P5 — Sink and locker gate:** require the governed sink ledger, custody reconciliation, and completed GY-OPS-RB-05 screening.
- **P6 — One-attempt discipline:** one authorized salvage attempt per validated evidence package. A terminal state-change or snapshot-integrity failure requires a restart from snapshot validation; do not reuse stale prepared transactions or artifacts.
- **P7 — Claims gate:** verify artifact/root equality, proof derivation, at least one legitimate LP-holder claim, duplicate-claim rejection, and claim accounting.

“Match” means **snapshot-time ownership**.

**Accepted trust boundary:** the owner accepts P1–P7 as the M1 operational procedure while acknowledging that current code does not cryptographically enforce every step. Holder-level re-enumeration, holder-level drift comparison, snapshot invalidation/rebuild, and atomic binding are not implemented at the assessed repository baseline. The on-chain salvage path pins total LP supply, not every holder’s balance. No stronger guarantee may be claimed.

## 8. D-09 — canonical indexer architecture and Q-05

Adopt the canonical architecture for M1:

| Component | Canonical responsibility |
|---|---|
| `grave-indexer` | Canonical pool discovery and C1 evidence pipeline: provenance, activity derivation, validation, issuance/signing, freshness/replay protection, health |
| `graveyield-protocol` | Candidate scoring/prioritization, queue orchestration, submission scheduling, GraveScanner integration; consumes canonical evidence |
| GraveScanner | Sole on-chain eligibility authority |
| GraveVault | Settlement and LP restitution |
| SDK | Canonical wire formats, PDA derivation, instruction construction |
| `salvor-bots` | Salvor execution agents consuming the designated canonical path; queue prevents competing bots |
| `ops/` | Operational supervision, monitoring, and evidence retention |

Q-05 is resolved by wiring canonical `grave-indexer` evidence into the protocol evaluation/queue/submission path and progressively isolating or retiring duplicate discovery/signing paths. The M1 path must have one designated source of C1 evidence and one designated signer custody path.

No repository merge, deletion, broad rewrite, deployment, live transaction, or key generation is authorized by this architecture decision. Wiring is an engineering task to be implemented and reviewed separately.

This D-09 is the **canonical indexer architecture** decision and is distinct from the existing in-spec `D9` launch-price evidence decision.

## 9. D-16 and G-18b provenance disposition

Stage 1.1 found no authoritative definition for D-16 or G-18b in the available repositories or owner-side source documents.

Disposition:
- retain both identifiers in the decision register;
- record each as `UNAVAILABLE — original owner definition not supplied`;
- assign no operative M1 effect and do not infer or invent a meaning;
- if an original owner record is later recovered, review it and issue an explicit superseding decision before relying on it.

This disposition does not retire or redefine G-18 / ORACLE-003, which remains a separate operational oracle-readiness item.

## 10. Key custody

For M1 local-fork operations:
- keys are dedicated to the local Mainnet fork and isolated from all Mainnet production keys;
- deployment and C1/C2 oracle identities are separate;
- custody remains owner-controlled;
- key material must never be committed to a repository, included in evidence artifacts, or supplied to an agent;
- cluster identity must be checked before any signing or transaction submission;
- no Mainnet key may be reused;
- key generation, storage location, access controls, rotation, recovery, and funded payer must be documented in a separate owner-controlled ceremony record before the corresponding live stage.

This approval does not itself generate keys, transfer custody, or authorize a transaction. OWN-14 operational details remain an execution prerequisite until the exact custodian, rotation plan, and funded-payer arrangement are recorded.

## 11. D-08 — M1 lifecycle and roadmap reconciliation

The owner-approved 15-stage lifecycle governs M1. The older roadmap description of M1 as a scope-freeze/planning-only milestone is superseded in substance for this project milestone.

M1 completion is **not Mainnet readiness**.

The execution environment is amended from Testnet to the local Mainnet-fork validator under GY-M1-CR-001. Every evidence artifact must state its actual cluster identity and must not label fork evidence as Testnet or Mainnet production evidence.

The fifteen lifecycle stages are defined in `docs/M1_EXECUTION_SPEC.md`. Snapshot capture remains a pre-salvage dependency because the on-chain registry seals the Merkle root during salvage; the later snapshot/Merkle stage is the artifact publication, integrity, and claims-readiness checkpoint.

## 12. Attestation and evidence honesty

M1 prohibits:
- fabricated history;
- backdated evidence;
- artificial oracle attestations;
- weakened eligibility criteria;
- synthetic evidence represented as genuine lifecycle evidence.

Genuine launch-swap transaction signatures and pool-history evidence must be archived. Any fixtures or synthetic values used in unit/fork tests must be clearly labelled as test fixtures and may not be submitted as genuine lifecycle evidence.

## 13. Preserved invariants and boundaries

The following remain unchanged:
- all six D-02 eligibility criteria and comparison operators;
- exact 40/40/20 allocation;
- original LP-holder entitlement protection;
- atomicity of critical salvage/settlement transaction boundaries;
- no use of real user funds in M1;
- one settlement per pool;
- no unauthorized redistribution of unclaimed LP-holder allocations.

The whole 15-stage lifecycle is not one transaction. Atomicity applies to critical on-chain transaction boundaries; multi-stage waits, attestations, certification, and claims remain separately evidenced.

## 14. Authorization and exclusions

**Authorized now:**
- formalize this decision record;
- create and commit the M1 execution specification;
- create and commit the manual locker-screening runbook and inventory schema;
- update the decision register and related documentation.

**Not authorized by this record:**
- code implementation or broad refactors;
- key generation, export, transfer, or rotation;
- deployment or program upgrades;
- live-chain transactions or pool operations;
- use of real user funds;
- Mainnet production activity.

OWN-13 console dispositions remain open. OWN-14 oracle operations remain open beyond the key-custody policy above. Engineering and operational prerequisites may be specified, tracked, and reviewed, but not represented as completed.
