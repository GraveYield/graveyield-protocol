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
> `node scripts/devnet/ns3_derive_pdas.mjs`). ProgramData addresses ARE
> derivable offline from each program ID via the upgradeable BPF loader
> convention (`PDA([program_id], BPFLoaderUpgradeable)` — the
> `get_program_data_address` convention; implemented as `programDataPda()`
> in `scripts/devnet/ns3_identities.mjs` and printed as derived
> expectations by that same script), but deriving the expected address
> does NOT establish that the account exists. At acceptance time the
> actual program account must still be read from the approved cluster,
> its embedded ProgramData pointer must match the independently derived
> address, and the ProgramData account itself must exist with the
> expected loader ownership and valid structure and name the expected
> upgrade authority. The deployed ELF must also be retrieved (read-only)
> and checked against the approved SHA-256 digest pinned in
> `scripts/devnet/provenance.manifest.json`. If a ProgramData account is
> absent, the dependent acceptance checks FAIL. If RPC retrieval fails,
> the dependent checks are recorded as UNVERIFIED; the overall verifier
> result is INCOMPLETE only when no other FAIL exists. Absence is never
> initialized around and never recorded as a pass.
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
- For mode 2 only, the owner-custody keypairs: the scanner program and
  vault program keypairs, the deployer keypair, AND the governance
  authority keypair (it signs — and pays — the drill's authority
  transactions and signs `register-oracle`), plus the two dedicated
  oracle keys, whose PUBLIC keys are consumed by `register-oracle`.
  Deriving each pubkey with `solana-keygen pubkey` is a LOCAL-ONLY,
  owner-executed operation (no network access, no key content leaves
  the machine).
- Mode 2 funding — three SEPARATE balances. Funding itself is an
  OWNER-EXECUTED ON-CHAIN WRITE (a real transfer transaction), never a
  read-only step; only the balance CHECKS are read-only:
  - **Deployer** — ≥ 6 SOL on devnet; cost drivers: rent-exempt storage
    of the two ELF binaries at ≈ 2.7 SOL each, two ProtocolConfig
    accounts, transaction fees. The deploy script refuses to run below
    6 SOL, compared lamport-exact against 6 000 000 000, and prints the
    shortfall. That 6 SOL figure is a PRE-deployment gate only — no
    post-deployment balance floor is enforced — while the estimated
    deployment expenditure is ≈ 5.7–6.0 SOL and the deployer also pays
    the two `init-*` fees and (when `--fee-payer` is supplied) the
    `register-oracle` fee afterwards. Recheck the live balance
    immediately before executing: a previously recorded balance is not
    a guarantee — and passing this gate is not a guarantee that the rest
    of the sequence can finish (deployer funding sequence in §3).
  - **Governance authority** — needs its OWN devnet SOL: each drill's
    authority pause/unpause transactions are signed AND paid by the
    governance keypair (two landed transactions per program drill). No
    balance gate exists for governance; fund it before the drills.
  - **Throwaway intruder** — needs its OWN fee dust (0.01 SOL): the
    rejected unauthorized attempt is still a submitted transaction and
    still incurs its transaction fee.
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

0. **Deployment-CLI version compatibility** — `solana --version` and
   `solana-keygen --version` must match the manifest pin
   (`toolchain.solana_cli`) — checked on EVERY deploy path (normal,
   `--skip-build`, retries) BEFORE any owner keypair path is touched
   (existence checks included). The deployment CLI is the binary that
   reads the owner keys and submits the transactions, so its version is
   pinned first: a wrong-version CLI never touches owner keys. SCOPE —
   this is a version-COMPATIBILITY check, not binary authentication:
   `--version` output is an unauthenticated string, and matching it does
   not prove what the executables contain. No binary-attestation
   mechanism is introduced for this; the assurance the version string
   cannot provide comes from the deployment environment, which must be
   trusted (owner-controlled host and PATH).
1. **Identity check** — each keypair's pubkey must equal the compiled
   `declare_id!` value. An ELF deployed under an address different from
   its declared ID would fail every Anchor owner check at runtime; the
   script refuses instead of shipping a broken program.
2. **Funding check** — deployer balance ≥ 6 SOL, compared lamport-exact
   against 6 000 000 000 (never by digit-stripping the human SOL display,
   which mis-reads decimals).
3. **Build-toolchain version compatibility** (build paths only) — `cargo-build-sbf --version`
   must match the manifest pin (same version-string limits as stage 0)
   and the platform-tools archive is
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

**Deployer funding sequence (OPERATIONAL, owner-executed — the balance
checks themselves are READ-ONLY).** The stage [2/7] threshold is a
PRE-deployment gate only — passing it is NOT a guarantee that the
subsequent operations are funded. The owner executes ONE sequence, in
this order:

1. **Verify ≥ 6 SOL immediately before deployment** — the stage [2/7]
   gate (`MIN_DEPLOY_LAMPORTS = 6 000 000 000`, lamport-exact) refuses
   to run below it and prints the shortfall; re-read the LIVE balance
   rather than trusting any previously recorded figure.
2. **Deploy GraveScanner and GraveVault** — the two `solana program
   deploy` transactions above; the deployer signs and pays both. The
   estimated expenditure is ≈ 5.7–6.0 SOL against the 6 SOL gate, so a
   deployer funded near the minimum can land near zero.
3. **Recheck the deployer's remaining SOL balance** after BOTH deploy
   transactions confirm and BEFORE initialization, with the same
   lamport-exact read the funding gate uses:

   ```bash
   solana --url https://api.devnet.solana.com balance --lamports /path/to/deployer-keypair.json
   ```

4. **Confirm the remaining funds cover BOTH `init-*` transactions and
   any planned `register-oracle` fee** — the deployer always pays the
   two initialization fees, and pays the oracle-registration fee when
   `--fee-payer` is supplied (§4).
5. **If the balance is insufficient, STOP** — do not run `init-*` or
   `register-oracle` — and request additional owner funding before
   proceeding. The re-funding transfer is an OWNER-EXECUTED ON-CHAIN
   WRITE, exactly like every other funding operation in this runbook;
   only the owner executes it.

There is NO protocol-enforced post-deployment minimum — this is a
sequence-completion concern, not a rule the chain enforces, and nothing
on-chain checks it. Do not extrapolate from a previously recorded
balance: balances move, and only the live lamport read is evidence.

Mode 2 action classification (binding): balance checks and every
verifier invocation are READ-ONLY; `solana-keygen pubkey` identity
comparisons, local builds, and the provenance gate are LOCAL-ONLY; and
ONLY the owner, manually, executes the on-chain writes — the two
`solana program deploy` transactions, any funding transfer (deployer,
governance authority, or throwaway intruder), both `init-*`
transactions, both drills' authority and intruder transactions, and
`register-oracle`.

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

`--authority` MUST be passed explicitly on every `init-*` invocation:
the CLI silently falls back to the deployer pubkey when the flag is
omitted (`cmdInit` in `protocol_admin.mjs`), which would store the
DEPLOYER as the ProtocolConfig authority and break the NS-3 role
separation. In every `init-*` transaction the deployer keypair is the
transaction's signer and fee payer; the governance public key is only
written into the config's `authority` field.

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

`register-oracle` wires two distinct roles into one transaction: the
GOVERNANCE authority is the only instruction-level signer, while the
transaction fee is paid by the deployer keypair supplied through
`--fee-payer` (if the flag is omitted, the governance key pays). When
the fee payer differs from the authority, BOTH sign the transaction —
the fee payer as the transaction-level signer, governance as the
instruction-level signer.

Per program, the drill asserts: fresh-config readback (authority,
defaults, unpaused) → authority pauses → readback asserts the flip → an
intruder keypair attempts pause and the transaction MUST revert with the
program's `Unauthorized` (GraveScanner 6000 / GraveVault 7000) →
authority unpauses → readback asserts restoration. The intruder keypair
needs fee dust (0.01 SOL) so its probe reaches the program check rather
than dying at the system layer. Fee responsibility in the drill: the
GOVERNANCE keypair signs and pays the authority pause/unpause
transactions; the intruder keypair pays for its own rejected attempt —
a reverted transaction still charges its fee, which is why the intruder
needs its own funded keypair.

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

### 5.1 Deployed-ELF digest verification (`verify_ns3_elf_digests.mjs`)

The acceptance verifier above proves the deployment ARRANGEMENT but does
not hash deployed bytes (the W2 report §5 records this gap explicitly).
The deployed-ELF digest proof is a separate, standalone, strictly
READ-ONLY utility next to it — `getGenesisHash` / `getEpochInfo` /
`getAccountInfo` only; no signer dependency, no keypair argument, no
transaction capability, and no override flags (the verified program IDs
and the expected digests are the pinned repository constants, never
options):

```bash
node scripts/devnet/verify_ns3_elf_digests.mjs --url https://api.devnet.solana.com
# machine-readable: add --json. Commitment defaults to FINALIZED;
# --commitment confirmed is a diagnostic override, recorded verbatim.
```

Per program (scanner A1–A4 / B1–B4 / C1–C5; vault A6–A9 / B6–B9 /
C6–C10), plus the cluster-identity gate first:

- **G — cluster identity (runs FIRST, strict short-circuit)**: the
  endpoint must report the pinned Devnet genesis before any deployed
  bytes are interpreted. A foreign cluster is an immediate FAIL; a
  FAILED genesis request is UNVERIFIED and SHORT-CIRCUITS the whole
  run — the tool returns INCOMPLETE (exit 3) having issued NOT ONE
  `getAccountInfo` call. On a cluster whose identity could not be
  established, no deployed byte is fetched or interpreted at all. The
  test suite pins this against the recorded RPC call history, not just
  the final classification.
- **A — program account**: exists, loader-owned, executable, and its
  embedded ProgramData pointer equals the INDEPENDENTLY derived loader
  PDA (`PDA([program_id], BPFLoaderUpgradeable)`).
- **B — ProgramData**: the REAL account is fetched at that address
  (deriving the address does not prove existence — an absent ProgramData
  is a FAIL, never a digest match), loader-owned, structurally decoded
  (u32 tag=3 + u64 slot + u8 authority flag), and the upgrade-authority
  metadata must name the deployer (absent / malformed / unexpected
  authorities are reported as DISTINCT conditions and FAIL).
- **C — deployed ELF**: the payload is extracted at the STRUCTURAL
  metadata boundary (45 B when an authority is present, 13 B with
  authority = None — the packed layout current agave writes, verified
  byte-for-byte against devnet ProgramData accounts and the
  loader-v3-interface sources; a legacy 48/16 B bincode-layout account
  is reported precisely and REFUSED — the extraction boundary is never
  silently shifted).

  **Hash-span methodology (what exactly enters the SHA-256).** Five
  different "ELF length" notions exist:
  1. the ProgramData PAYLOAD length (account bytes after the loader
     metadata) — what is on the wire;
  2. the section-header-table end (`e_shoff + e_shnum·e_shentsize`) —
     a common but NOT universal ELF end;
  3. the MAX byte extent the ELF's own structures imply — the SHT end,
     the program-header TABLE end (`e_phoff + e_phnum·56`), every
     non-NOBITS section extent (`sh_offset + sh_size`), and every
     program-header extent (`p_offset + p_filesz`);
  4. the uploaded `.so` file length — the span the approved manifest
     digests were computed over;
  5. the loader-interpreted span — the whole payload.

  **The digest covers the ENTIRE extracted payload (concepts 1 and 5):
  every byte the account holds after the derived metadata boundary
  enters the SHA-256.** There is no structure-implied truncation and no
  tail exclusion — genuine trailing artifact bytes are never silently
  stripped, and a one-byte alteration anywhere in the payload (including
  bytes beyond every structure the ELF declares) changes the digest.

  Evidence basis (all in-repository): the documented NS-3 deploy path
  (`deploy_devnet.sh`) runs `solana program deploy` and never passes
  `--max-len`, so no extra account capacity is reserved; the W1
  byte-verification (`lifecycle_rehearsal/elf_dump.mjs`,
  `matchOnChainProgramData`, byte-verified against devnet ProgramData
  accounts on 2026-10-29) proves the upgradeable loader stores the ELF
  so it "runs to the EXACT END of the account"; and the W1/W1.1
  lifecycle rehearsal REFUSES to run unless the loaded ProgramData
  payload byte-matches the pinned ELF exactly (the same exact-length
  helper) — and passed, with digests equal to the approved pins. On the
  documented path the payload therefore IS the artifact, and the
  full-payload digest IS the approved whole-artifact digest.

  The structure-implied extent (concept 3 — INCLUDING the
  program-header table's own extent, so a table positioned beyond the
  SHT end and beyond all section/segment extents is validated AND
  counted, never omitted) is still computed — as the STRUCTURAL GATE
  and an honest diagnostic, never as the hash boundary: the ELF64
  header, the section table, every section extent, the program-header
  table and every segment extent must fit inside the payload, and a
  payload that cannot be structurally established FAILS CLOSED before
  anything is hashed. When the payload is longer than the extent, the
  excess is DISCLOSED in both outputs (`trailing_bytes_beyond_declared_structure`
  plus the all-zero flag) but NOT excluded — extra allocation capacity
  (e.g. an explicit larger `--max-len`, which the documented deploy
  path never uses) cannot be distinguished from genuine artifact bytes
  without independent, trustworthy length evidence, so the verifier
  does not guess which trailing bytes are loader padding: it excludes
  nothing, and if the full-payload digest does not match the approved
  whole-artifact pin the verdict is FAIL. The approved-digest
  comparison is never weakened to accommodate synthetic layouts.

  **Structural validity vs digest match.** `structure_valid` reflects
  only the structural stages that actually ran: `null` — no ELF payload
  was assessed; `false` — a payload was assessed and at least one
  structural stage failed (ELF64 header validation, structure-implied
  extent establishment, in-range section/program-header tables, SBPF v0
  architecture); `true` — all structural stages ran and passed. A
  digest mismatch is a CONTENT-integrity failure (`digest_match=false`
  with `structure_valid=true` — "right shape, wrong bytes"), never a
  structural contradiction, and the JSON and human-readable outputs
  carry the same information.

  **Extended section numbering over the FULL valid range** (ELF spec:
  `e_shnum = 0` with the real count in the u64 `sh_size` field of section
  header 0; `e_shstrndx = SHN_XINDEX` with the real index in the u32
  `sh_link` field of section header 0; `e_phnum = PN_XNUM` with the real
  count in `sh_info` of section header 0) is supported on the FULL path —
  structure establishment, structural identity, and digest all resolve it
  with the same rule; there is no partial support. Because the escape
  exists precisely so the count can exceed the 16-bit `e_shnum` field,
  there is NO 65,535 ceiling: a spec-valid ELF with any section count
  whose 64-byte-per-entry section-header table fits inside the extracted
  payload is parsed — the accepted range is bounded only by the real
  format limits (exact safe-integer arithmetic and payload fit), not by
  an artificial constant. The bounds that ARE enforced — each failing
  closed before anything is hashed or iterated — are: a zero extended
  count is malformed; a count beyond the JavaScript safe-integer bound is
  refused before any arithmetic; `e_shoff + count·64` must be an exact
  safe integer AND fit inside the payload (a truncated or impossible
  table is rejected before any allocation or iteration); and the
  string-table index (direct or `SHN_XINDEX`-resolved) must be inside the
  resolved count. The JSON and human-readable outputs report the same
  resolution (the `span_basis` field names which structure set the
  maximum, including "extended numbering").

  **Reserved section-numbering values fail closed** (ELF gABI). The two
  16-bit header fields each have exactly two legal shapes, and everything
  else in their range is RESERVED — never accepted as a direct value and
  never normalized into an escape:
  - `e_shnum`: a DIRECT count in `[1, 0xfeff]` (the largest legal direct
    count), or the extended-count escape `0` (real count in SH0
    `sh_size`). Every value in `[0xff00, 0xffff]` is RESERVED and is
    rejected — a real count >= 0xff00 MUST be expressed through the
    escape.
  - `e_shstrndx`: a DIRECT index in `[0, 0xfeff]` (bounds-validated
    against the resolved count), or the `SHN_XINDEX` escape `0xffff`
    (real index in SH0 `sh_link`). Every value in `[0xff00, 0xfffe]` is
    RESERVED and is rejected. Note the asymmetry: the `e_shstrndx` escape
    is `0xffff`, not `0`.
  Both parsing paths — `parseElf64Sections()` (the one section parser
  every consumer shares: the pre-deployment identity gate, the provenance
  gate, and the digest verifier) and `elfDeclaredSpan()` — enforce the
  same rules through one shared validator, BEFORE any escape resolution,
  table arithmetic, iteration, or hashing; the failure names the
  offending field, its value, and the reason, and a reserved-value
  rejection is a distinct failure class from the ordinary out-of-range
  bounds error. The `PN_XNUM` program-count escape (`e_phnum = 0xffff`)
  is unaffected. Adversarial fixtures prove the reserved values fail
  closed even when the declared table is complete and in range (the
  rejection is the value itself, never truncation), and that the largest
  legal direct values (`0xfeff`) verify end-to-end on the full path.

  The repository's own provenance gate (`ns3_check_provenance.mjs`)
  then runs over the EXACT full extracted payload — the very bytes whose
  digest was taken: SHA-256 against the
  [`../scripts/devnet/provenance.manifest.json`](../scripts/devnet/provenance.manifest.json)
  pin, the SBPF v0 architecture (e_machine 263 / e_flags 0), and the
  structural NS-3 identity (embedded program ID inside allocated
  sections; no NS-1/NS-2 legacy ID bytes).

Result classifications — identical semantics to the acceptance verifier:
`PASS` (exit 0) — both programs satisfy every required check; `FAIL`
(exit 1) — a definitive mismatch, absent required account, malformed
account, unexpected identity, invalid loader structure, or digest
mismatch is established (an RPC timeout is never misreported as an
absent account, and a malformed account can never produce a PASS);
`INCOMPLETE` (exit 3) — RPC transport or retrieval failures prevented a
definitive determination, only when no FAIL exists. A definitive FAIL
takes precedence over INCOMPLETE. `--json` emits the context, a manifest
summary, and one record per program with identical key sets on every
evidence path: existence/owner/executable fields, embedded vs derived
pointer comparison, loader state, upgrade-authority metadata, payload
offset / payload size / hash span (`hash_span_bytes` — always the full
payload) / declared ELF size (structure-implied extent, program-header
table included) / span basis / trailing bytes beyond the declared
structure with the all-zero flag, observed vs expected SHA-256, digest
match, SBPF validity, and the structural identity verdict.

The `structure_valid` field reflects the structural stages that
ACTUALLY ran, and never contradicts the evidence: `null` — no ELF
payload was ever assessed (extraction failed or was never reached:
absent accounts, malformed loader metadata, RPC-UNVERIFIED paths);
`false` — ELF bytes existed and were assessed and at least one
structural stage FAILED (ELF64 header validation, structure-implied
extent establishment from the ELF's own metadata, in-range section
table, in-range program-header table, or the SBPF v0 architecture
requirement);
`true` — all of those stages actually ran and passed. Trailing payload
bytes beyond the structure-implied extent are a disclosed diagnostic,
never a structural stage. Digest stages are
content, not structure: a digest mismatch on a structurally valid ELF
reports `digest_match: false` with `structure_valid: true` ("right
shape, wrong bytes") — that is the intended, non-contradictory outcome,
and a regression test asserts these invariants across every evidence
path.

Relationship to the acceptance verifier: deployment acceptance requires
BOTH verifiers to pass on the same cluster — §5 proves the approved
arrangement (identity, authorities, configs, oracles, pause state);
§5.1 proves the deployed bytes are exactly the approved provenance.
Neither substitutes for the other, and neither is modified by the
other's presence. Historical note: the W2 exercise performed the same
loaded-byte procedure with a one-off supplemental collector that was
NOT committed ([`W2_ACCEPTANCE_REPORT.md`](w2-ns3-acceptance/W2_ACCEPTANCE_REPORT.md)
§5); this utility is the reproducible replacement. It was NOT part of
the W2 run — the W2 REJECTED classification stands exactly as recorded.

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
