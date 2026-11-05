# Devnet Runbook — GraveYield Protocol

> **NS-3 PREPARATION RECORD (assigned, NOT yet deployed — 2026-11-04).**
> The NS-3 identities below are owner-generated, owner-held public keys
> (DR-002); the repository synchronization is complete and the deployment
> itself is **PENDING** — nothing on devnet answers at these addresses
> until the owner executes the deployment. Do not treat any
> NS-3 address as live until this file records the deployment signatures.
>
> | NS-3 role | Public key |
> |---|---|
> | GraveScanner program ID (owner-held keypair, NOT an authority) | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` |
> | GraveVault program ID (owner-held keypair, NOT an authority) | `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya` |
> | Deployer / fee payer / initial upgrade authority | `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` |
> | Governance authority (ProtocolConfig, both programs) | `BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5` |
> | Activity oracle (dedicated, C1) | `2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o` |
> | Launch-price oracle (dedicated, C2) | `97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee` |
>
> Pre-deployment derivations (byte-exact, locally computed — must match
> the on-chain readbacks): scanner ProtocolConfig PDA
> `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe`, vault ProtocolConfig
> PDA `5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda` (both
> `['protocol_config']`, bump 255; reproduce with
> `node scripts/devnet/ns3_derive_pdas.mjs`). ProgramData addresses stay
> PENDING until they are read from the deployed program accounts — they
> are NOT derivable offline; the acceptance verifier reads them from the
> deployed program accounts at acceptance time.
>
> **Authority arrangement (NS-3, honest form).** The deployer pays fees
> and is the initial upgrade authority of both programs (decoded from
> each ProgramData account at acceptance). The governance authority is
> the initial and permanent ProtocolConfig authority of both programs,
> and `register-oracle` re-points the two scanner oracle signer fields
> from the initialization authority to the dedicated keys above. The
> `pending_authority` / `pending_authority_eta` / `timelock_seconds`
> fields are **reserved write-only state — not an enforced authority
> transfer and not an enforced timelock**: no on-chain instruction
> reads them, no upgrade is delayed by them, and the upgrade authority
> remains the single deployer key until the owner separately rotates
> it. Anything this document says about a "72h timelock" refers to the
> Squads governance flow around protocol-config changes, never to
> on-chain enforcement by these programs.
>
> **History.** NS-1 (2026-10-09) and NS-2 (2026-10-25) are retired
> deployments preserved as historical records — including their lost
> authority keys and their (superseded) single-key arrangement — in
> [`docs/LEGACY_DEPLOYMENTS.md`](LEGACY_DEPLOYMENTS.md). That file is
> the ONLY home of NS-1/NS-2 execution records; everything below is the
> NS-3 runbook. Decision records: [`docs/DECISIONS.md`](DECISIONS.md)
> (DR-001, DR-002).

## The three execution modes

Every NS-3 deployment activity falls into exactly one of these modes.
Cross-mode drift (an agent "helpfully" executing an owner step, or the
owner rehearsing with custody keys) is the failure pattern DR-002 exists
to prevent.

| Mode | Who executes | Keys touched | Cluster | Entry point |
|---|---|---|---|---|
| **1. Agent-assisted local rehearsal** | agent, with owner review | throwaway keys minted into a `mktemp` dir and discarded | `solana-test-validator` on 127.0.0.1 only | `scripts/devnet/local_rehearsal_ns3.sh` |
| **2. Owner-executed devnet deployment** | the owner, manually, step by step | owner custody keypairs only (never agents, never git) | devnet via explicit `--url` | `scripts/devnet/deploy_devnet.sh` |
| **3. Agent-assisted read-only verification** | agent, read-only | none — public keys only | any explicitly named RPC endpoint | `scripts/devnet/verify_ns3_deployment.mjs` |

Hard rules that hold in ALL modes:

- No agent ever requests, receives, stores, or handles a private key or
  keypair file. Mode 1 mints its own throwaways; mode 2 is the owner's
  hands only; mode 3 accepts public keys and **refuses a flag value that
  resolves to an existing file path** (so nobody points the verifier at
  a keypair file by accident).
- No transaction is ever submitted to a public cluster from any path
  other than mode 2. Mode 1 targets `http://127.0.0.1:8899` only; mode
  3 performs read-only RPC (`getAccountInfo` / `getEpochInfo` /
  `getGenesisHash`) and cannot sign or send anything by construction.
- Agents may prepare, build, verify, and report — the deployment
  transactions themselves are the owner's.

## Network facts (NS-3 targets)

| Item | Value |
|------|-------|
| Cluster | Solana devnet — `https://api.devnet.solana.com` (always passed explicitly) |
| Devnet genesis hash (pinned) | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` — verified independently (live RPC + Anza cluster docs); the acceptance verifier refuses a different cluster |
| GraveScanner program ID | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` |
| GraveVault program ID | `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya` |
| ProtocolConfig PDA seeds | `["protocol_config"]` under each program's ID, bump 255 |
| Initial upgrade authority | the deployer keypair (owner custody; see the honest-form note above) |
| Config authority at initialize | the GOVERNANCE public key — not the deployer (NS-3 arrangement; the NS-2 single-key arrangement is retired) |
| Legacy (NS-1/NS-2) programs | preserved on-chain as historical records — see `docs/LEGACY_DEPLOYMENTS.md` §3; never deployment targets |

The NS-3 program IDs are mirrored in both `declare_id!` calls, every
`Anchor.toml` section, and the fork suites that derive scanner PDAs;
consistency is asserted by `scripts/devnet/test/ns3_sync.test.mjs`.

## Prerequisites

- Solana CLI 3.0.10 (`solana`, `solana-keygen`, `cargo-build-sbf`,
  `solana-test-validator`) — matches `Anchor.toml`, the provenance
  manifest, and CI.
- Node ≥ 24 and pnpm 9 (workspace package `@graveyield/devnet-tools`).
- For mode 2 only: the three owner-custody keypairs (scanner program,
  vault program, deployer) and a funded deployer (≥ 6 SOL on devnet;
  cost drivers: rent-exempt storage of the two ELF binaries at ≈ 2.7
  SOL each, two ProtocolConfig accounts, transaction fees). The deploy
  script refuses to run below 6 SOL and prints the shortfall.
- Key custody: keypairs live OUTSIDE the repository (owner custody
  directory, never in git; `target/deploy/` copies are gitignored).

## 1. Deployment provenance (fail-closed, all modes)

The bytes that reach the chain are pinned by
[`scripts/devnet/provenance.manifest.json`](../scripts/devnet/provenance.manifest.json)
— the SINGLE source of the approved digests, shared by the deployment
script and CI (PR #82 provenance, values recorded verbatim):

| Artifact | SHA-256 |
|---|---|
| `target/deploy/grave_scanner.so` | `e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98` |
| `target/deploy/grave_vault.so` | `8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83` |
| platform-tools v1.54 tarball (linux-x86_64) | `fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e` |

`scripts/devnet/ns3_check_provenance.mjs` enforces, fail-closed:

1. **Digest match** — each ELF's SHA-256 equals the manifest pin.
2. **SBPF v0 architecture** — ELF header `e_machine 263 / e_flags 0`.
   An ELF built for any other sbpf version (e.g. anchor 1.2.2's default
   v3, `e_machine 247`) is refused even if its digest and embedded ID
   match. This invariant is hardcoded in the checker and cross-checked
   against the manifest — the manifest cannot relax it.
3. **Structural identity** — the expected program ID occurs inside an
   allocated ELF section and no NS-1/NS-2 legacy ID bytes appear
   anywhere (`ns3_verify_elf.mjs`, reused, not duplicated).
4. **Toolchain integrity** — when building, the platform-tools v1.54
   ARCHIVE is hash-verified against the manifest on every run, and every
   `cargo-build-sbf` cache directory the flow may resolve is re-seeded
   from the VERIFIED archive (overwriting whatever was there). A
   pre-existing cache is never trusted on the basis of its plaintext
   stamp — the stamp is informational; the archive digest is the only
   trust anchor. A download whose digest mismatches the pin aborts the
   run before anything is extracted.

`deploy_devnet.sh` runs this gate on EVERY path — the normal build+deploy
flow, `--build-only`, `--skip-build`, custom/pre-placed artifacts in
`target/deploy/`, and every retry/re-run — before any deployment
transaction is submitted. Node is mandatory on every path (a missing
node is a refusal, not a skipped check). CI runs the same checker over
the same manifest in the `anchor build` job. There is no flag, path, or
environment that bypasses the gate.

**Digest re-pin procedure (deliberate, reviewed).** If a legitimate
source, dependency, or toolchain change shifts the ELF bytes, the gate
stays closed and `--build-only` refuses to mark the new bytes ready.
To re-pin: rebuild via the deploy flow (`--build-only`) with the pinned
toolchain, record the new digests in the manifest, and land that change
in a reviewed PR — with the review covering WHY the bytes changed. Never
update a digest merely to make a red build green.

## 2. Mode 1 — agent-assisted local rehearsal

```bash
bash scripts/check-toolchain.sh                # (informational) toolchain pins
scripts/devnet/deploy_devnet.sh --build-only   # build + provenance gate, no keypairs
scripts/devnet/local_rehearsal_ns3.sh          # local validator lifecycle drill
```

`--build-only` builds both ELFs (pinned platform-tools, no keypairs, no
RPC) and runs the full provenance gate. `local_rehearsal_ns3.sh` then
exercises the production initialization SHAPE on a local validator with
throwaway identities: deploy-at-`declare_id!` (upgrades disabled),
initialize with a TEMPORARY governance authority (deployer pays fees),
emergency-control drills, register-oracle with separate signer and fee
payer. The temporary governance key is the ONE authority for the whole
rehearsal; the permanent NS-3 keys never enter local validator state.

> **Constrained containers (memlock):** agave 3.0.x probes io_uring and
> may fail fatally on `RLIMIT_MEMLOCK` in restricted containers
> ("unable to set memory lock limit"). Denying the `io_uring_setup`
> syscall (a seccomp filter inherited by the validator process) routes
> agave onto its plain sync file-creator path, which needs no memlock.

## 3. Mode 2 — owner-executed devnet deployment

The owner runs, one verified step at a time:

```bash
scripts/devnet/deploy_devnet.sh \
  --url https://api.devnet.solana.com \
  --scanner-keypair /path/to/scanner-keypair.json \
  --vault-keypair   /path/to/vault-keypair.json \
  --deployer        /path/to/deployer-keypair.json
```

Stages, each with a hard refusal on mismatch:

0. **Deployment-CLI identity** — `solana --version` and
   `solana-keygen --version` must match the manifest pin
   (`toolchain.solana_cli`) — verified on EVERY deploy path (normal,
   `--skip-build`, retries) BEFORE any owner keypair path is touched
   (existence checks included). The deployment CLI is the binary that
   reads the owner keys and submits the transactions; its identity is
   proven first, and it is a separate trust surface from the build
   toolchain.
1. **Identity check** — each keypair's pubkey must equal the compiled
   `declare_id!` value. An ELF deployed under an address different from
   its declared ID would fail every Anchor owner check at runtime; the
   script refuses instead of shipping a broken program.
2. **Funding check** — deployer balance ≥ 6 SOL, compared lamport-exact
   against 6 000 000 000 (never by digit-stripping the human SOL display,
   which mis-reads decimals).
3. **Build-toolchain identity** (build paths only) — `cargo-build-sbf --version`
   must match the manifest pin and the platform-tools archive is
   re-verified and re-seeded (see §1 check 4). This runs BEFORE the
   owner keypairs are seeded into `target/`: a toolchain refusal must
   never leave owner key material copied into the build tree.
4. **Artifact seeding** — copies the keypairs into the gitignored
   `target/deploy/` for `cargo build-sbf`; refuses if that directory
   already holds a DIFFERENT keypair (stale artifacts would silently
   deploy under the wrong address).
5. **Build** — per package directory: `cargo build-sbf` in
   `programs/grave-scanner` then `programs/grave-vault` (agave 3.0.10's
   `cargo-build-sbf` rejects workspace `-p` selection), with
   platform-tools v1.54 pinned and hash-verified. Skipped entirely with
   `--skip-build` (CI-produced artifacts), which does not require the
   SBF toolchain — the provenance gate still applies IN FULL, so
   `--skip-build` cannot smuggle in bytes the manifest does not pin.
6. **Provenance gate** — digests + SBPF v0 + structural identity, from
   the shared manifest. No deploy command runs unless it passes.
7. **Deploy** — `solana program deploy` with the matching
   `--program-id` keypair; the deployer becomes the upgrade authority.

> **Anchor is not on the deploy path (verified):** this flow builds with
> `cargo build-sbf` and deploys with `solana program deploy`; anchor
> 1.2.2 is used only by the CI `anchor build` job and is NOT required at
> deployment time. The v1.57 platform-tools cache (anchor 1.2.2's
> resolution) is still seeded — from the hash-verified archive only — so
> an accidental anchor invocation can never resolve unverified bytes.

Redeploys after the first deployment are UPGRADES (same address, same
upgrade authority) and follow the normal `solana program deploy` re-run;
the identity, artifact-refusal, and provenance checks all still apply —
there is no upgrade path that skips the gate.

## 4. Initialize, drill, register oracles (owner, governance authority)

```bash
node scripts/devnet/protocol_admin.mjs init-scanner \
  --url https://api.devnet.solana.com \
  --deployer /path/to/deployer-keypair.json \
  --authority BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5
node scripts/devnet/protocol_admin.mjs init-vault \
  --url https://api.devnet.solana.com \
  --deployer /path/to/deployer-keypair.json \
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

A second `init-*` on an initialized config fails at the Anchor `init`
constraint — ProtocolConfig is init-once by design. Both `authority`
fields land on the GOVERNANCE key (the deployer keypair only pays the
fee), and both oracle signer fields START at that same governance key —
which is exactly why the acceptance verifier refuses to PASS until they
have been rotated to the dedicated keys:

```bash
node scripts/devnet/protocol_admin.mjs drill --url https://api.devnet.solana.com \
  --program scanner --authority /path/to/governance-keypair.json \
  --intruder /path/to/throwaway-keypair.json
node scripts/devnet/protocol_admin.mjs drill --url https://api.devnet.solana.com \
  --program vault --authority /path/to/governance-keypair.json \
  --intruder /path/to/throwaway-keypair.json

node scripts/devnet/protocol_admin.mjs register-oracle --url https://api.devnet.solana.com \
  --authority /path/to/governance-keypair.json --fee-payer /path/to/deployer-keypair.json \
  --activity-oracle 2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o \
  --launch-price-oracle 97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee
```

Per program, the drill asserts: fresh-config readback (authority,
defaults, unpaused) → authority pauses → readback asserts the flip → an
intruder keypair attempts pause and the transaction MUST revert with the
program's `Unauthorized` (GraveScanner 6000 / GraveVault 7000) →
authority unpauses → readback asserts restoration. The intruder keypair
needs fee dust (0.01 SOL) so its probe reaches the program check rather
than dying at the system layer.

## 5. Mode 3 — agent-assisted read-only acceptance verification

After deploy + initialize + drill + register-oracle, acceptance is
verified INDEPENDENTLY (no keypairs, no transactions — read-only RPC
only):

```bash
node scripts/devnet/verify_ns3_deployment.mjs --url https://api.devnet.solana.com
# machine-readable: add --json. The acceptance default is commitment
# FINALIZED; pass --commitment confirmed ONLY as a diagnostic for a
# just-submitted deployment. Identity flags were removed: the verifier
# always checks the 8 pinned NS-3 identities.
```

The verifier derives everything from the pinned NS-3 identities and
reports six sections, each item PASS / FAIL / UNVERIFIED:

- **G — cluster identity (runs FIRST)**: the endpoint's `getGenesisHash`
  must equal the pinned, independently verified Solana Devnet genesis
  hash (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`) before any
  deployment state is interpreted. A different cluster is an immediate
  `FAIL` (no deployment check is evaluated on foreign bytes); a failed
  genesis request is `UNVERIFIED`, which forces `INCOMPLETE`.

- **A — program accounts**: both programs exist, are executable, are
  owned by the BPF upgradeable loader, and their REAL ProgramData
  account — decoded from the program account's embedded pointer, not
  inferred from any config — exists, is loader-owned, and names the
  deployer as upgrade authority. The embedded pointer must ALSO equal
  the independently derived ProgramData address
  (`PDA([program_id], BPFLoaderUpgradeable)` — the
  `get_program_data_address` convention); a foreign pointer is a FAIL.
  Loader-account layout (u32 tags 2/3) verified against the
  anza-xyz/solana-sdk loader-v3-interface sources and live on-chain
  bytes.
- **B — ProtocolConfig**: the `['protocol_config']` PDA is derived
  independently and must equal the pinned derivation (bump 255); the
  account exists, is owned by its program, carries a valid
  `account:ProtocolConfig` discriminator, decodes per the current
  schema, has authority = governance, and matches the approved defaults
  above (plus the stored bump).
- **C — dedicated oracles**: the scanner's activity and launch-price
  oracle fields are the DEDICATED NS-3 keys — if either still equals the
  initialization authority, that is a FAIL ("register-oracle not yet
  run").
- **D — emergency state**: the actual `paused` / `emergency_paused`
  flags are reported verbatim; acceptance requires both unpaused.
- **E — legacy residuals**: the four NS-1/NS-2 program IDs are probed
  and REPORTED (present/absent, owner, ProgramData upgrade authority
  status). Report-only: historical residue never flips the NS-3 verdict.

Overall result:

- `PASS` (exit 0) — every check ran and the chain matches the approved
  arrangement.
- `FAIL` (exit 1) — at least one check ran and mismatched. The
  deployment is not acceptable as-is; investigate every FAIL.
- `INCOMPLETE` (exit 3) — at least one check could not run (RPC
  transport failure or unreadable response). An RPC failure is NOT
  evidence that the deployment is invalid — but it blocks acceptance:
  re-run against a healthy RPC. The gate never passes on partial
  evidence.

A PASS proves: the pinned program bytes are live at the NS-3 addresses
under the pinned authority arrangement, with governance-controlled
spec-default configs and dedicated oracle signers. A PASS does NOT
prove: that the pending-authority/timelock fields enforce anything (they
do not — see the honest-form note), that future upgrades are safe (the
upgrade authority remains the deployer key), or anything about programs
other than the two NS-3 addresses.

## 6. Deliberately out of scope here

- **Indexer / SDK publication / first Salvor / Merkle service** — roadmap
  Phases 8–10; the Phase 11 Infrastructure rows light up after those ship.
- **Controlled salvage scenarios** — require a funded Salvor with LP in a
  genuinely derelict devnet pool and the SDK's instruction builders; the
  fork harness already proves the settlement mechanics against mainnet
  bytecode (`tests/` suites).
- **Multisig authority / on-chain timelock** — devnet NS-3 runs the
  single deployer key as upgrade authority and governance as config
  authority, with the timelock fields as reserved state. Mainnet ships
  multisig-only (Squads v4 3-of-5) per the Charter and `initialize`
  documentation; KEYS-003 and GOV-001 track the mainnet custody and
  timelock wiring.
