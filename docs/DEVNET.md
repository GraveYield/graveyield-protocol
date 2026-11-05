# Devnet Runbook — GraveYield Protocol

> **THIS FILE IS THE NS-3 RUNBOOK.** Everything in the body below is the
> single, active devnet deployment procedure. The NS-2 (DR-001 refresh)
> execution record is preserved as **Appendix A (historical, superseded)**
> at the bottom of this file; the canonical lineage and on-chain evidence
> for NS-1/NS-2 live in
> [`docs/LEGACY_DEPLOYMENTS.md`](LEGACY_DEPLOYMENTS.md). Do not follow the
> appendix for new work.

> **NS-3 PREPARATION RECORD (assigned, NOT yet deployed — 2026-11-04).**
> The NS-3 identities below are owner-generated, owner-held public keys
> (DR-002); the repository synchronization is complete and the deployment
> itself is **PENDING** — nothing on devnet answers at these addresses
> until the owner executes the deployment. Do not treat any NS-3 address
> as live until this file records the deployment signatures.

> **Notice (DR-002, 2026-11-03).** The NS-2 (DR-001 refresh) deployment is
> **superseded**: its shared authority key (`AsB5uPtT…EWXa`) was
> permanently lost (forensics 2026-11-03), so NS-2 is retained as a
> historical record and is not a deployment target. **NS-3 is the next
> and only supported devnet deployment** — fresh program IDs, keys
> generated and held by the owner, executed manually by the owner and
> documented here once deployed. Full record:
> [`docs/LEGACY_DEPLOYMENTS.md`](LEGACY_DEPLOYMENTS.md).

## NS-3 identities (owner-generated, owner-held — DR-002)

| NS-3 role | Public key |
|---|---|
| GraveScanner program ID (owner-held keypair, NOT an authority) | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` |
| GraveVault program ID (owner-held keypair, NOT an authority) | `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya` |
| Deployer / fee payer / initial upgrade authority | `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` |
| Governance authority (ProtocolConfig, both programs) | `BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5` |
| Activity oracle (dedicated, C1) | `2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o` |
| Launch-price oracle (dedicated, C2) | `97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee` |

Pre-deployment derivations (byte-exact, locally computed — must match the
on-chain readbacks): scanner ProtocolConfig PDA
`5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe`, vault ProtocolConfig PDA
`5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda` (both
`['protocol_config']`, bump 255; reproduce with
`node scripts/devnet/ns3_derive_pdas.mjs`). ProgramData addresses stay
PENDING until they are read from the deployed program accounts
(`scripts/devnet/verify_ns3_deployment.mjs` reads them back post-deployment).

## 1. Authority arrangement (NS-3) — what is and is NOT enforced on-chain

| Role | Key | Enforced by |
|---|---|---|
| Fee payer | deployer `cfJKAz…4831` | the transaction layer (pays rent + fees) |
| Program upgrade authority (both programs) | deployer `cfJKAz…4831` (initial) | the BPF upgradeable loader — every `Upgrade`/`SetAuthority`/`Close` needs its signature; read back from the REAL ProgramData accounts, never inferred |
| ProtocolConfig authority (both programs) | governance `BMnrpx…Uwf5` | the programs themselves — `update_protocol_config` / `emergency_pause` verify the signer |
| Activity oracle (C1 attestation signing) | dedicated `2Zygw…Zqf8o` | the program verifies Ed25519 attestations against this field |
| Launch-price oracle (C2 attestation signing) | dedicated `97JVK…Bcee` | the program verifies Ed25519 attestations against this field |

**Honest limitation — the pending-authority/timelock fields are NOT
enforced mechanisms.** `pending_authority`, `pending_authority_eta`, and
`timelock_seconds` are reserved write-only state. They do NOT implement a
real authority transfer, a real timelock, or any delayed execution: no
program logic gates an operation on them. Treat any claim of an
"on-chain 72h timelock" or an "in-flight authority rotation" as
documentation-level intent only (the intended flow is Squads multisig
governance, deferred per spec D2). What IS enforced by the programs today:
the ProtocolConfig authority check, the Charter share-sum and 20%
protocol-share ceiling at every write path, init-once semantics, and the
emergency-pause authorization. `docs/DEVNET.md` and the acceptance
verifier report these fields as observed values, nothing more.

## 2. The three execution modes (who may do what — DR-002)

| Mode | Script | Keys involved | Who runs it |
|---|---|---|---|
| **Agent-assisted local rehearsal** | `scripts/devnet/local_rehearsal_ns3.sh` | TEST identities only, minted into a `mktemp` dir and discarded; program ELFs loaded at the NS-3 IDs with upgrades disabled on a loopback `solana-test-validator` | agents may execute end to end; no owner keypair is ever touched; nothing leaves the machine |
| **Owner-executed Devnet deployment** | `scripts/devnet/deploy_devnet.sh` (this runbook, §5–§8) | the owner's custody keypairs (program, deployer) | the OWNER only, manually, one verified step at a time. Agents must NOT execute, must not request, read, copy, or handle any private key, and must not submit anything to a public cluster |
| **Agent-assisted read-only verification** | `scripts/devnet/verify_ns3_deployment.mjs` (§9) | none — no signers, no keypairs, no wallets, no transactions (`getAccountInfo`/`getSlot` only) | agents may run freely, before and after the deployment; RPC failures block PASS rather than faking it |

Key custody: all NS-3 keypairs live OUTSIDE the repository (owner custody;
`target/deploy/` copies used by the build are gitignored). Keypair files
never enter git, logs, or agent output. The repository holds public keys
only (`scripts/devnet/ns3_identities.mjs` is the single identity module).

## 3. Deployment provenance — the fail-closed ELF gate

The approved NS-3 deployment bytes are pinned in ONE shared manifest,
[`scripts/devnet/provenance.manifest.json`](../scripts/devnet/provenance.manifest.json):

- GraveScanner `grave_scanner.so` — sha256
  `e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98`
- GraveVault `grave_vault.so` — sha256
  `8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83`
- SBPF v0 target record (e_machine 263 / e_flags 0 — the deploy-flow arch;
  anchor 1.2.2's own default v3 output is refused)
- platform-tools v1.54 with the hash-pinned tarball
  (`fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e`),
  Solana CLI 3.0.10, Anchor CLI 1.2.2

Both consumers verify against this same manifest — CI's `anchor build`
provenance gate (`.github/workflows/ci.yml`) before publishing the
deployment artifacts, and `scripts/devnet/deploy_devnet.sh` via
`scripts/devnet/ns3_verify_provenance.mjs` before ANY deployment
transaction. Every deploy-reaching path is gated — normal build,
`--skip-build` (CI-artifact / resume / retry), re-runs after a failed
deploy, and `--build-only`. There is no flag that skips the gate: a
missing, malformed, mismatched, or wrongly-architected ELF aborts the run
before `solana program deploy` can be reached.

Build paths additionally require the pinned platform-tools v1.54 cache
directory (the toolchain that produced the approved bytes); the byte
identity of the build RESULT is enforced by the digest gate either way.

**Digest-change policy:** a digest is NEVER bumped to make a failing
check pass. Any source, dependency, toolchain, or arch change shifts the
ELF digests; the new bytes must be independently reviewed and deliberately
re-pinned in the manifest (and in
`scripts/devnet/test/provenance_manifest.test.mjs`, which pins the
approved constants) in a reviewed PR before anything deploys.

## 4. Prerequisites

- Solana CLI 3.0.10 (`solana`, `solana-keygen`, `cargo-build-sbf`,
  `solana-test-validator`) — matches `Anchor.toml` and CI.
- Node ≥ 24 and pnpm 9 (workspace package `@graveyield/devnet-tools`).
- The pinned platform-tools v1.54 toolchain for any local build (CI
  pre-seeds it; a local host seeds it once):

  ```bash
  curl -sSL -o platform-tools.tar.bz2 \
    https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-linux-x86_64.tar.bz2
  echo fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e  platform-tools.tar.bz2 | sha256sum -c -
  mkdir -p ~/.cache/solana/v1.54/platform-tools
  tar xjf platform-tools.tar.bz2 -C ~/.cache/solana/v1.54/platform-tools
  ```

- Three owner custody keypairs: scanner program, vault program,
  deployer/fee-payer (and the governance key's signing capability for
  §6–§8, held by whoever operates governance).
- Deployer funded with ≥ 6 SOL on devnet. Cost drivers: rent-exempt
  storage of the two ELF binaries (~400 KB each → ≈ 2.7 SOL each), two
  ProtocolConfig accounts, and transaction fees. The deploy script refuses
  to run below 6 SOL and prints the shortfall (lamport-exact, never by
  digit-stripping the human SOL display).

## 5. Owner procedure: build + deploy (NS-3)

```bash
scripts/devnet/deploy_devnet.sh \
  --url https://api.devnet.solana.com \
  --scanner-keypair /path/to/grave_scanner-devnet.json \
  --vault-keypair   /path/to/grave_vault-devnet.json \
  --deployer        /path/to/deployer-authority-devnet.json
```

Stages, each with a hard refusal on mismatch:

1. **Identity check** — each keypair's pubkey must equal the compiled
   `declare_id!` value. An ELF deployed under an address different from
   its declared ID would fail every Anchor owner check at runtime.
2. **Funding check** — deployer balance ≥ 6 SOL, compared lamport-exact
   against 6 000 000 000.
3. **Artifact seeding** — copies the keypairs into the gitignored
   `target/deploy/` for `cargo build-sbf`; refuses if that directory
   already holds a DIFFERENT keypair (stale artifacts would silently
   deploy under the wrong address).
4. **Build** — per package directory (`programs/grave-scanner`, then
   `programs/grave-vault`; agave 3.0.10's `cargo-build-sbf` rejects
   workspace `-p` selection), with the pinned platform-tools v1.54
   required first. `--skip-build` reuses pre-built (e.g. CI-produced)
   ELFs on toolchain-less hosts and does not require the SBF toolchain —
   but is NOT a bypass (see stage 5).
5. **Provenance gate** — `ns3_verify_provenance.mjs` verifies, fail-closed
   and on EVERY path: SHA-256 of both ELFs against the shared manifest,
   structural embedding of the NS-3 program IDs in allocated sections,
   zero legacy NS-1/NS-2 ID bytes, and the SBPF v0 header record.
6. **Deploy** — `solana program deploy` with the matching `--program-id`
   keypair; the deployer becomes the initial upgrade authority.

Redeploys after the first deployment are UPGRADES (same address, same
upgrade authority) and follow the normal `solana program deploy` re-run;
the identity and provenance checks still apply. A failed deploy followed
by a re-run re-enters the same gate — stale or tampered `target/deploy`
artifacts are refused, not silently reused.

## 6. Initialize both ProtocolConfigs (governance authority, deployer pays)

```bash
node scripts/devnet/protocol_admin.mjs init-scanner \
  --url https://api.devnet.solana.com \
  --deployer /path/to/deployer-authority-devnet.json \
  --authority BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5
node scripts/devnet/protocol_admin.mjs init-vault \
  --url https://api.devnet.solana.com \
  --deployer /path/to/deployer-authority-devnet.json \
  --authority BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5
```

With all-zero params the on-chain defaults land (mirroring
`constants.rs` in both programs):

| GraveScanner | Value | GraveVault | Value |
|---|---|---|---|
| `inactivity_seconds` | 7 776 000 (90 d) | `lp_holder_share_bps` | 4 000 |
| `price_collapse_bps` | 9 900 | `salvor_share_bps` | 4 000 |
| `min_tvl_lamports` | 500 000 000 | `protocol_share_bps` | 2 000 (Charter ceiling) |
| `anchor_staleness_seconds` | 1 209 600 (14 d) | `max_priority_fee_ceiling_lamports` | 1 000 000 000 |
| `lp_burn_dust_threshold` | 1 000 | `max_slippage_bps` | 300 |
| `cert_ttl_seconds` | 3 600 | `jupiter_dust_threshold_lamports` | 666 666 |
| | | `timelock_seconds` | 259 200 (72 h) |

The authority STORED in both configs is the governance key — NOT the
deployer (separate roles per §1). `init-all` reads back both configs and
verifies the authority landed. A second `init-*` on an initialized config
fails at the Anchor `init` constraint — ProtocolConfig is init-once by
design. (The stored `timelock_seconds` value is a reserved field, not an
enforced delay — see §1.)

## 7. Emergency-control drill (governance signs; the deployer never does)

```bash
node scripts/devnet/protocol_admin.mjs drill \
  --url https://api.devnet.solana.com \
  --program scanner \
  --authority /path/to/governance-keypair.json \
  --intruder  /path/to/any-other-keypair.json

node scripts/devnet/protocol_admin.mjs drill \
  --url https://api.devnet.solana.com \
  --program vault \
  --authority /path/to/governance-keypair.json \
  --intruder  /path/to/any-other-keypair.json
```

Per program, the drill asserts the full spec behavior:

1. Freshly initialized config readback — governance authority, all
   defaults, unpaused (account discriminator verified, not just fields).
2. Governance pauses (`paused` on scanner / `emergency_paused` on vault).
3. Readback asserts the flag flipped.
4. An intruder keypair attempts pause — the transaction MUST revert with
   the program's `Unauthorized` (GraveScanner 6000 / GraveVault 7000).
   Any other outcome (including a silent land) fails the drill; the
   post-intruder readback asserts the pause SURVIVED the rejected attempt.
5. Governance unpauses; readback asserts restoration.

The intruder keypair must hold fee dust (0.01 SOL is plenty): the probe
transaction is signed by the intruder alone. An unfunded intruder fails
at the system level before the program's authority check runs — the drill
treats that as a failure, as well it should, because the assertion is
specifically that the PROGRAM reverts with `Unauthorized`.

Stand-alone primitives: `pause --state true|false`, `check` (full config
dump). Custom program errors are decoded against the compact table in
`protocol_admin.mjs`, mirroring `docs/error_codes.md`.

## 8. Register the dedicated oracle signers (governance signs, deployer pays)

```bash
node scripts/devnet/protocol_admin.mjs register-oracle \
  --url https://api.devnet.solana.com \
  --authority /path/to/governance-keypair.json \
  --fee-payer /path/to/deployer-authority-devnet.json \
  --activity-oracle 2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o \
  --launch-price-oracle 97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee
```

`initialize` starts both oracle fields at the initialization authority;
this step re-points them to the DEDICATED NS-3 oracle keys (§1). The
`--fee-payer` flag keeps the governance key off the fee-paying path: the
instruction is signed by governance, the fee is paid by the deployer.

## 9. Read-only acceptance verification (post-deployment)

```bash
node scripts/devnet/verify_ns3_deployment.mjs --url https://api.devnet.solana.com
# add --json for the machine-readable report
```

The verifier is STRICTLY read-only: no signers, no keypairs, no wallets,
no transactions — `getAccountInfo`/`getSlot` only. It independently
establishes, per program:

- **A — program accounts**: present, executable, owned by the BPF
  upgradeable loader, embedding their ProgramData accounts; the upgrade
  authority is decoded from the REAL ProgramData accounts and must equal
  the NS-3 deployer (never inferred from a config account).
- **B — ProtocolConfig**: the PDA is independently re-derived from the
  program ID and must equal the expected NS-3 PDA; the account exists
  there, is owned by its program, carries a valid Anchor discriminator;
  the authority must be the governance key; every governed value must
  equal the approved initialization defaults (§6); `pending_authority`
  must be zeroed (and is reported honestly as reserved state, §1).
- **C — dedicated oracles**: `activity_oracle` and
  `launch_price_oracle` equal the dedicated NS-3 keys — NOT the
  initialization authority they start at (catches a skipped §8 or a
  role-confusion mistake).
- **D — emergency state**: the ACTUAL decoded pause flags are reported
  for both programs; acceptance requires both unpaused.
- **E — deployment identity consistency**: the deployed ELF bytes (read
  from each ProgramData account) must hash to the manifest digests
  (deployed bytes == approved provenance), and NO NS-1/NS-2 program-ID
  byte residue may appear anywhere in the deployed bytes. (Repo-side
  legacy-ID sync is a separate offline check:
  `scripts/devnet/ns3_verify_sync.mjs`.)

Results are three-state and fail-closed: **PASS**, **FAIL** (observed
chain state contradicts acceptance — real deployment evidence), and
**UNVERIFIED** (the check could not run: RPC transport failure, RPC error
response, unreadable manifest). An RPC failure is NOT evidence that the
deployment is invalid — but it is also never a pass: ANY UNVERIFIED
blocks the OVERALL PASS. Exit codes: 0 all-PASS, 1 any-FAIL, 2
any-UNVERIFIED. The report lists every observed public key, address, and
the RPC slot/context, so the acceptance evidence is independently
re-derivable.

After a successful run, record here: deploy/initialize/register tx
signatures with slots, both ProgramData addresses, and the verifier's
OVERALL line — completing the NS-3 record the banner above awaits.

## 10. Full local rehearsal (no devnet, no owner keys)

```bash
scripts/devnet/local_rehearsal_ns3.sh
```

Starts a bare `solana-test-validator` on loopback, loads the locally
built ELFs directly at the NS-3 `declare_id!` addresses (upgrades
disabled — no program keypairs needed), then drives the production
sequence in its exact NS-3 SHAPE: initialize with a TEMPORARY governance
authority (deployer pays fees), both emergency-control drills signed by
that same temporary key, and separate-signer oracle registration. All
rehearsal identities are throwaways minted into a `mktemp` dir and
discarded; the permanent NS-3 keys are printed for contrast but never
enter the validator state. The production-keypair variant for owner-side
dry runs remains `scripts/devnet/local_rehearsal.sh`. Build the ELFs
first with `scripts/devnet/deploy_devnet.sh --build-only` (which itself
passes the provenance gate) or take the CI `program-elfs` artifact.
Success line:

```
NS-3 LOCAL REHEARSAL COMPLETE — deploy-at-declare_id, temporary-governance-
authority initialization (the SAME key signed init, both drills, and oracle
registration), and separate-signer oracle registration all behaved per the
NS-3 authority arrangement on both programs.
```

> **Constrained containers (memlock):** agave 3.0.x probes io_uring and,
> when the kernel supports it, writes all genesis/ledger files through an
> io_uring file creator that must raise `RLIMIT_MEMLOCK` to 2 GB — in
> containers where the hard limit is 64 KB and `setrlimit` is not
> permitted this fails fatally ("unable to set memory lock limit") before
> the ledger exists. Denying the `io_uring_setup` syscall (a seccomp
> filter inherited by the validator process) makes the probe fail and
> routes agave onto its plain sync file-creator path, which needs no
> memlock. The rehearsal behind this runbook was produced exactly that
> way; on an unconstrained host no wrapper is needed.

## 11. Deliberately out of scope here

- **Indexer / SDK publication / first Salvor / Merkle service** — roadmap
  Phases 8–10; the Phase 11 Infrastructure rows light up after those ship.
- **Controlled salvage scenarios** — require a funded Salvor with LP in a
  genuinely derelict devnet pool and the SDK's instruction builders; the
  fork harness already proves the settlement mechanics against mainnet
  bytecode (`tests/` suites).
- **Multisig authority / enforced timelock** — devnet NS-3 runs a single
  deployer upgrade authority and a single governance config authority per
  §1. Mainnet launches multisig-only (Squads v4 3-of-5) per the Charter;
  KEYS-003 and GOV-001 track the mainnet custody and timelock wiring.

---

## Appendix A — Preserved NS-2 execution record (HISTORICAL — superseded by NS-3)

> Everything below this line documents the DR-001 refresh executed on
> 2026-10-25 under program IDs `CuQZes…Ao54` / `Bd5smh…s7rg`. Its
> authority key is permanently lost (DR-002) and NS-2 is NOT a deployment
> target. Kept verbatim as the execution-record reference
> ([`docs/LEGACY_DEPLOYMENTS.md`](LEGACY_DEPLOYMENTS.md) is canonical).
> Every NS-2-specific ID, address, and configuration value below is
> historical.

**Status: EXECUTED (refresh).** The then-current devnet deployment was
the DR-001 refresh executed on **2026-10-25** (epoch 1191): both programs
live under the new program IDs below, both ProtocolConfigs initialized
at spec defaults, and the emergency-control drill passed on both
programs (authority pause, intruder rejection — GraveScanner 6000 /
GraveVault 7000 — authority unpause, readback-verified at every step),
and the SDK's read-only devnet smoke suite passes against the deployment.
The sequence was first rehearsed end-to-end on `solana-test-validator`
via the exact production scripts (`scripts/devnet/local_rehearsal.sh`),
then executed on devnet:

| Step | Program | Transaction (finalized) |
|---|---|---|
| Deploy | GraveScanner `CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54` | `46kHBf1CNaTnNQUCXGuAyJetzDn5GgKrkK745MtUSdBhuEeqiK3DuB1GnN34GizCkYvQQMYnxByJSWRL6JD3hYPM` (slot 514 928 681) |
| Deploy | GraveVault `Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg` | `5F7RYuP9aXsFjH2fv78ATDG86bPtMUGL6ua2S8aMP6DzrqhnT4DKx73GiHX24K4258QMPv2RspsMBVYYqw8Ly9YS` (slot 514 928 725) |
| Initialize | scanner ProtocolConfig `Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD` | `64nYNYuud68irZpi5jgKL5CQNWRMH8jcXGRYiACoVhBRtvsqLCHCCitXeuKMjUTvzdSu6Syab2XKnEbaNMDT7wki` (slot 514 928 823) |
| Initialize | vault ProtocolConfig `hyKk983fguE2CGA5Dx5TLKfBft1AJrm7CHoe1PTUipS` | `2venFHC3K7JWKWT61H735uK7Yi38fHvz8EnDTpKmAgSj3P8z5tRuaxQ9g1DBSHTxD4BNiuzXf3auv5M3mrNgbLKf` (slot 514 928 827) |

Deployed bytes: the CI-built ELFs from run 40178764437 (commit
`d4661b4`, the program-ID sync commit) via `deploy_devnet.sh
--skip-build`; sha256 `2e367ea0…cf232` (scanner, 367 864 B) and
`cbbe3b0f…98518` (vault, 407 184 B). Both config PDAs landed at bump 255
— byte-exact matches of the pre-deployment derivation
(`scripts/pda_derive.py`).

**Frozen static reference (DR-001):** the original 2026-10-09 deployment
— GraveScanner
`5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF`, GraveVault
`HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6`, configs
`GcdZJhCpg7sjgEEHTsoSkT2Pi83d8kP3NrTqdvMm2Bhu` /
`2SCqqpEwKMuWnJWe7UQJTzFeDPif4jUPUspWKZdZ5vaU`, deploy txs
`PUXKJWGY…36N12ww` / `5gEVQfsd…vrq55HgN6`, init txs `5boq7igX…TTh` /
`2psMkdru…Tty9H` — is retained on-chain but its upgrade-authority key is
dead (DR-001: `recoverable = no`). It is a historical artifact: not
upgraded, not maintained, and no consumer points at it.

**NS-2 network facts (historical).** Cluster `https://api.devnet.solana.com`;
upgrade authority for both then-current programs: the refresh deployer
keypair (single key — also the config authority and both oracle signers
at initialize; roles were NOT separated under NS-2). The drill's
pause/unpause transactions are reproducible via `protocol_admin.mjs
drill`; the intruder key is a throwaway holding fee dust only.

**NS-2 key custody (historical).** The NS-2 devnet keypairs were
throwaways living OUTSIDE the repository (custody handoff directory in
the operator workspace, never in git; `target/deploy/` copies were
gitignored). The DR-001 refresh minted a fresh key generation (program,
vault, deployer, intruder throwaway) after the original deployer key
proved unrecoverable; that generation was then lost with the recorded
2026-10-26 workspace reset (DR-002). NEVER reuse any devnet keypair for
mainnet — KEYS-003 requires fresh custody-generated keypairs for mainnet.
