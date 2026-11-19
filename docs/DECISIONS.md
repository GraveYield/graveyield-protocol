# GraveYield — Decision Records

> Append-only register of binding decisions that gate or resolve items in
> `docs/BASELINE_REPORT.md` (blocker register B1–B9, next steps NS-1–NS-9)
> and `docs/PRE_MAINNET_CHECKLIST.md`. New decisions are appended; existing
> entries are not rewritten except by explicit owner direction (DR-002
> wording cleanup, 2026-11-04). Each entry states the decision, the evidence
> basis, and the consequence surface so a future reader can reconstruct why
> the tree looks the way it does without replaying the original discussion.

## Register

| ID | Date (UTC) | Decision | Resolves |
|---|---|---|---|
| DR-001 | 2026-10-25 | NS-1: deployer key custody resolved — dead key; path B (fresh devnet deployment); current deployment retained as frozen static reference | B1, NS-1 (gates NS-2) |
| DR-002 | 2026-11-03 | NS-2 authority key lost (forensics 2026-11-03; owner-side search empty); NS-2 deployments preserved untouched as historical evidence; NS-3 approved with fresh deployment identities — keys generated and held by the owner, deployment executed manually by the owner | phase-4 assessment B1, decision D1 (branch b) |
| DR-003 | 2026-11-19 | M1 owner decision package: D-04 acquisition/P2/register/sinks; D-05/Q-04; D-09/Q-05; D-02 governance trust; dedicated fork keys; D-06 P1–P7; D-16/G-18b unavailable; GY-M1-CR-001 cluster ruling; authorize M1 execution specification | M1 specification and owner-decision provenance |

---

## DR-001 — NS-1: deployer key custody resolved — dead key; path B (fresh devnet deployment) — 2026-10-25

**Decision.** The devnet deployer keypair is **not recoverable**. The
custody answer demanded by the baseline report's NS-1 ("key recoverable:
yes/no") is **NO**. Consequently the baseline's path A (NS-3,
upgrade-in-place under key recovery) is closed, and path B (NS-2, fresh
devnet deployment with new program keypairs) is the selected and sole
remediation path.

**Custody answer:** `recoverable = no`.

**Evidence basis.**

1. `docs/OPS.md` §7 (custody note): "deployer keys were throwaways, wiped
   per custody policy." This is the project's own operational record and
   the primary evidence.
2. `docs/DEVNET.md` (key custody note): the devnet keypairs "are
   throwaways. They live OUTSIDE the repository … NEVER reuse them for
   mainnet" — consistent with a custody policy that treats devnet keys as
   disposable.
3. `docs/BASELINE_REPORT.md` §1.4/§6 on-chain verification: a single key
   (`GCCuhCXd…68yk`) is simultaneously upgrade authority, config authority,
   and both oracle authorities; the report judged the custody claim
   "consistent with evidence" (frozen ~5.97 SOL balance, zero program
   upgrades since deploy, config init-once semantics that even a recovered
   *different* key cannot undo).

Because the three sources agree and the owner has directed execution of
the NS-1 work item as framed by this session (2026-10-25: "Proceed to
NS-1"), the long-standing "unknown" is hereby resolved on the written
record. No attempt is made to contact, reconstruct, or brute-force any
key material — the decision is administrative, not a recovery exercise.

**Consequences.**

1. **B1 reclassified**: Critical / "unknown" → **resolved (dead key
   confirmed)**. B2's upgrade-in-place resolution branch is closed; B2 is
   resolved exclusively by fresh deployment (NS-2).
2. **Path B selected (NS-2)**: generate fresh scanner / vault / deployer
   keypairs (custody handoff outside git), fund the deployer ≥ 6 SOL,
   `scripts/devnet/deploy_devnet.sh`, `protocol_admin.mjs init-all`, run
   both drills, and sync every program-ID reference (list below).
3. **The current deployment becomes a frozen static reference.** Programs
   `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` (GraveScanner) and
   `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` (GraveVault), deployed
   2026-10-09 at slots 508888241/508888318, are retained untouched as
   permanent, verifiable proof of the Phase 11 drill and the spec-default
   configs. Their transaction signatures stay recorded in `docs/DEVNET.md`
   (moved to a historical-record section). Nothing is closed, drained, or
   otherwise mutated on-chain — the old deployment is documentation
   evidence, not an active system.
4. **Active-code ID surface (KEYS-003-style sync, devnet edition):**
   `declare_id!` ×2 (`programs/grave-scanner/src/lib.rs`,
   `programs/grave-vault/src/lib.rs`), `Anchor.toml` `[programs.*]`,
   `scripts/devnet/deploy_devnet.sh` expected IDs,
   `scripts/devnet/protocol_admin.mjs` constants, SDK constants in
   `sdk/src/client.ts` (single source of truth, byte-equal mirrored into
   `salvor-bots/src`), `indexer/src/config.ts`, `ops/src/config.ts`,
   `console` (`data.ts`), and the pinned PDA vectors in tests
   (`sdk/test/pdas.test.ts`, `adversary/test/replay.adversary.test.ts`,
   `ops/test/*`, six `grave-vault` fork suites). Old IDs must remain only
   as historical/appendix mentions in active code paths
   (NS-2 acceptance check).
5. **No protocol change.** This decision alters key material and deployed
   addresses only. Wire formats, instruction layouts, PDA seeds, economics
   constants, and all behavioral code are untouched; the fresh deployment
   runs the current `main` ELFs built by the CI-pinned toolchain.

**Verification hook.** NS-2 acceptance criteria (baseline §7) apply
unchanged: both configs decode at spec defaults, both drills pass
(pause → intruder-reject → unpause), `getProgramAccounts` shows exactly 2
program-owned accounts, zero references to the old IDs remain in active
code paths, and `docs/DEVNET.md` carries the new signature table with
correct UTC dates.

---

## DR-002 — NS-2 authority key lost; NS-3 fresh deployment (owner-held keys, owner-executed) — 2026-11-03

**Decision.** The NS-2 (DR-001 refresh) authority keypairs were lost
with the recorded 2026-10-26 operator-workspace reset; the shared
authority key (`AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa`) is
**permanently unrecoverable**. That one key held every privileged role
of the NS-2 deployment — ProgramData upgrade authority for both
programs, ProtocolConfig authority for both, and both scanner oracle
signers (role verification: `docs/LEGACY_DEPLOYMENTS.md` §2–§3) — so
no authority-dependent action on NS-2 can be signed anymore. The NS-2
programs remain deployed on devnet and are preserved untouched as a
historical record; they are not the active deployment target. The next
supported devnet deployment will be **NS-3**, using fresh program IDs
and owner-controlled keypairs. The redeployment will be executed
manually by the owner with their own assistant, one verified step at a
time; agents may assist with preparation and verification but must not
handle private keys or independently execute deployment transactions.

**Custody answer:** `recoverable = no` (owner-side search 2026-11-03:
empty; closes decision D1 → branch (b)).

**Evidence basis.**

1. Forensic report 2026-11-03
   (`GraveYield_DR-001_Keypair_Custody_Forensics_2026-11-03`, owner's
   copy): keypairs minted 2026-10-25 in the operator-workspace custody
   directory, consumed by the deployment + drills, destroyed by the
   recorded 2026-10-26 workspace reset; export to owner recorded as
   "unverified"; zero keypair files ever committed to any repository.
2. Read-only RPC verification 2026-11-03: all four accounts live;
   authority embedding unchanged since the deploy slots
   (`docs/LEGACY_DEPLOYMENTS.md` §3).
3. Owner confirmation 2026-11-03: no custody keypairs found in any
   handed-over artifact or personal storage.

**Consequences.**

1. `docs/LEGACY_DEPLOYMENTS.md` is the canonical historical record for
   NS-1 and NS-2 (lineage, full addresses, on-chain state,
   legacy-vs-active guidance).
2. `docs/DEVNET.md` carries a supersession notice; its body below the
   notice is the preserved NS-2 execution record.
3. The active-code ID surface (DR-001 consequence 4 catalogue) keeps the
   NS-2 IDs until the owner-approved NS-3 sync; those constants are
   inert legacy references in the meantime. Development and testing
   continue against localnet until NS-3 is deployed.
4. A Redeployment Readiness Report (2026-11-03, owner's copy) lists the
   prerequisites and verification steps for NS-3.

**Verification hook.** NS-3 acceptance mirrors NS-2's (baseline §7):
both configs decode at spec defaults on the NEW IDs, both drills pass,
zero references to the NS-2 IDs remain in active code paths (legacy
mentions allowed only in `docs/LEGACY_DEPLOYMENTS.md`,
`docs/DECISIONS.md`, the historical sections of `docs/DEVNET.md`, and
historical evidence artifacts), and `docs/DEVNET.md` carries the new
signature table with correct UTC dates.

---

## DR-003 — M1 owner decision package and execution-spec authorization — 2026-11-19

**Owner decision bundle:** `GY-M1-ODR-001`
**Related cluster ruling:** `GY-M1-CR-001`
**Approval:** Owner approved all ten decision items on 2026-11-19 with no amendments.

**Decision.** The owner approves:
1. D-04-A: voluntary OTC acquisition from consenting LP holders.
2. D-04-B: P2 Salvor operational renunciation of its LP-holder claim; direct 40% Salvor allocation remains.
3. D-04-C: mandatory per-pool acquisition and restitution register.
4. D-04-D: owner approval, independent review, and published exclusion ledger for sink declarations.
5. D-05: ratify `GY-OPS-RB-05` and Q-04 with protocol-wide scope and best-effort limitations.
6. D-09: canonical `grave-indexer` → protocol evaluation/queue → Salvor execution architecture; wire Q-05.
7. D-16 and G-18b: record as unavailable, with no operative M1 effect until original definitions are recovered.
8. D-02: documented governance-trust posture for M1; program-level threshold floors and multisig/timelock controls are required before Mainnet.
9. KEYS: owner-controlled dedicated local-fork keys, separate deployment and oracle identities, and no Mainnet key reuse.
10. D-06: ratify P1–P7 and define “match” as snapshot-time ownership.

The complete terms, limitations, and evidence requirements are in [`decisions/GY-M1-OWNER-DECISIONS-001.md`](decisions/GY-M1-OWNER-DECISIONS-001.md).

**Cluster ruling.** `GY-M1-CR-001` selects a local Solana Mainnet-fork validator with genuine Mainnet fixtures, actual elapsed time, actual local-validator epoch transitions, Mainnet-compatible Jupiter integration confined to the fork, and dedicated fork keys. It amends the D-03 execution environment and D-08 cluster wording. It does not prove Jupiter compatibility or authorize key generation, deployment, or transactions.

**D-01 and D-08 formalization.** The M1 sourcing predicate requires exactly one WSOL side, with WSOL as Raydium `pc_mint` / quote side; C3 remains 500,000,000 raw quote-side units. This is an M1 sourcing restriction only. The owner-approved 15-stage lifecycle supersedes the older roadmap scope-freeze definition in substance. M1 completion is not Mainnet readiness. Synthetic/backdated eligibility evidence remains prohibited.

**D-02 transparency.** The six eligibility criteria remain unchanged. The current program does not enforce lower bounds for C1/C3/C4 and permits C2=0 within its upper bound. The no-relaxation posture is a governance trust assumption for M1, not a bytecode guarantee. Program-level floors and multisig/timelock controls are pre-Mainnet requirements.

**D-04 P2 enforcement boundary.** P2 is operational renunciation. The Salvor-controlled leaf remains in the distribution and is not claimed; its amount is not redistributed. Current claim code does not enforce this rule. A project-wallet watchlist and monitoring are required. Sink declarations require owner approval, independent review, and a published per-pool exclusion ledger. Unsupported nonzero exclusions fail closed until the live Rust producer/CLI path supports them.

**D-05 limitation.** Q-04 is protocol-wide. Confirmed non-UNCX locks and unknown custodians disqualify. Only UNCX is verified in-repository at ratification; other candidate lockers require independent program/layout validation before reliance. Mandatory wording: “Best-effort screening against a ratified inventory — not universal detection.”

**D-06 trust boundary.** P1–P7 are ratified as an M1 operational procedure. Holder-level re-enumeration, drift invalidation, and atomic binding are not implemented at the assessed baseline. The specification must not claim cryptographic holder-level guarantees.

**D-09 and Q-05.** `grave-indexer` is canonical for discovery and C1 evidence; protocol handles candidate evaluation, scoring, queueing, and submission scheduling; GraveScanner is the on-chain eligibility authority; GraveVault is settlement; SDK is canonical for wire/PDA/instruction construction; Salvor bots consume one designated path; `ops/` supervises. Q-05 is resolved by wiring this canonical path. D-09 is distinct from the in-spec launch-price D9.

**D-16 / G-18b.** Both identifiers are recorded as `UNAVAILABLE — original owner definition not supplied`. No meaning is inferred and neither has operative M1 effect until original definitions are recovered and explicitly adopted. This does not retire G-18 / ORACLE-003.

**Key custody.** M1 uses dedicated owner-controlled local-fork keys, separate deployment and oracle identities, no Mainnet key reuse, and no repository storage of key material. The exact custodian/storage/rotation/funded-payer record remains an execution prerequisite. No key generation or transfer is authorized here.

**Authorization.** The owner authorizes preparation and commitment of the M1 execution specification and associated governance/operations documentation. This is documentation authorization only. It does not authorize code implementation, broad refactoring, key generation or transfer, deployment, program upgrades, live transactions, pool operations, real-user funds, or Mainnet production activity.

**Verification and remaining gates.** M1 execution remains gated by the engineering and operational prerequisites in `docs/M1_EXECUTION_SPEC.md`, including the SlotHashes fix and regression test, D-01 sourcing predicate, canonical indexer wiring, Rust snapshotter sole-producer wiring, independent snapshot validation, sink CLI support, Jupiter fork validation, cluster plumbing, P2 no-claim monitoring, locker-screening execution, and oracle custody/funded-payer records. OWN-13 remains open. OWN-14 remains open beyond the key-custody policy stated above.
