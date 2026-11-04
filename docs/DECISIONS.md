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
historical record; they are not the active deployment target. All
future work targets a fresh **NS-3** deployment with newly generated
deployment identities (fresh program IDs and keys). The owner controls
key generation, custody, and deployment: the NS-3 keys will be
generated and held by the owner, and the redeployment will be executed
manually by the owner with their own assistant, one verified step at a
time.

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
