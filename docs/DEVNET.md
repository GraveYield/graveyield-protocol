# Devnet Runbook — GraveYield Protocol

> **Status: EXECUTED (refresh).** The current devnet deployment is the
> DR-001 refresh executed on **2026-10-25** (epoch 1191): both programs
> live under the new program IDs below, both ProtocolConfigs initialized
> at spec defaults, and the emergency-control drill passed on both
> programs (authority pause, intruder rejection — GraveScanner 6000 /
> GraveVault 7000 — authority unpause, readback-verified at every step),
> and the SDK's read-only devnet smoke suite passes against the new
> deployment. The sequence was first rehearsed end-to-end on
> `solana-test-validator` via the exact production scripts
> (`scripts/devnet/local_rehearsal.sh`), then executed on devnet:
>
> | Step | Program | Transaction (finalized) |
> |---|---|---|
> | Deploy | GraveScanner `CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54` | `46kHBf1CNaTnNQUCXGuAyJetzDn5GgKrkK745MtUSdBhuEeqiK3DuB1GnN34GizCkYvQQMYnxByJSWRL6JD3hYPM` (slot 514 928 681) |
> | Deploy | GraveVault `Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg` | `5F7RYuP9aXsFjH2fv78ATDG86bPtMUGL6ua2S8aMP6DzrqhnT4DKx73GiHX24K4258QMPv2RspsMBVYYqw8Ly9YS` (slot 514 928 725) |
> | Initialize | scanner ProtocolConfig `Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD` | `64nYNYuud68irZpi5jgKL5CQNWRMH8jcXGRYiACoVhBRtvsqLCHCCitXeuKMjUTvzdSu6Syab2XKnEbaNMDT7wki` (slot 514 928 823) |
> | Initialize | vault ProtocolConfig `hyKk983fguE2CGA5Dx5TLKfBft1AJrm7CHoe1PTUipS` | `2venFHC3K7JWKWT61H735uK7Yi38fHvz8EnDTpKmAgSj3P8z5tRuaxQ9g1DBSHTxD4BNiuzXf3auv5M3mrNgbLKf` (slot 514 928 827) |
>
> Deployed bytes: the CI-built ELFs from run 40178764437 (commit `d4661b4`,
> the program-ID sync commit) via `deploy_devnet.sh --skip-build`;
> sha256 `2e367ea0…cf232` (scanner, 367 864 B) and `cbbe3b0f…98518`
> (vault, 407 184 B). Both config PDAs landed at bump 255 — byte-exact
> matches of the pre-deployment derivation (`scripts/pda_derive.py`).
>
> **Frozen static reference (DR-001):** the original 2026-10-09
> deployment — GraveScanner `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF`,
> GraveVault `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6`, configs
> `GcdZJhCpg7sjgEEHTsoSkT2Pi83d8kP3NrTqdvMm2Bhu` /
> `2SCqqpEwKMuWnJWe7UQJTzFeDPif4jUPUspWKZdZ5vaU`, deploy txs
> `PUXKJWGY…36N12ww` / `5gEVQfsd…vrq55HgN6`, init txs
> `5boq7igX…TTh` / `2psMkdru…Tty9H` — is retained on-chain but its
> upgrade-authority key is dead (DR-001: `recoverable = no`). It is a
> historical artifact: not upgraded, not maintained, and no consumer
> points at it.
>
> Upgrade authority for both CURRENT programs: the refresh deployer
> keypair (single key — see the custody note below). The drill's
> pause/unpause transactions are reproducible via `protocol_admin.mjs
> drill`; the intruder key is a throwaway holding fee dust only.
> Roadmap Phase 11 "Infrastructure" and "Observability" sections
> (indexer, SDK publication, first Salvor, Merkle service, event
> indexing, alerting) are deliberately NOT in this phase — they depend
> on Phases 8–10 and remain sequenced per the shipping roadmap.

## Network facts

| Item | Value |
|------|-------|
| Cluster | Solana devnet — `https://api.devnet.solana.com` |
| GraveScanner program ID (current) | `CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54` |
| GraveVault program ID (current) | `Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg` |
| Frozen static reference (DR-001) | scanner `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF`, vault `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` — authority key dead, historical only |
| ProtocolConfig PDA (both) | `["protocol_config"]` under each program's ID |
| Upgrade authority (devnet) | the refresh deployer keypair (single key — see custody note) |
| Config authority at initialize | the deployer keypair; `activity_oracle` and `launch_price_oracle` both start at the same key and rotate independently via `update_protocol_config` |

The current program IDs above are real keypairs. They are mirrored in both
`declare_id!` calls, every `Anchor.toml` section, and the six fork suites
that derive scanner PDAs.

**Key custody (devnet):** the devnet keypairs are throwaways. They live
OUTSIDE the repository (custody handoff directory in the operator
workspace, never in git; `target/deploy/` copies are gitignored). The
DR-001 refresh minted a fresh key generation (program, vault, deployer,
intruder throwaway) after the original deployer key proved unrecoverable.
The intruder keypair intentionally holds only fee dust (0.01 SOL) — it
must be able to pay its own probe fee for the drill's rejection step to
reach the program check (see §3). NEVER reuse any of them for mainnet —
KEYS-003 requires fresh custody-generated keypairs for mainnet.

## Prerequisites

- Solana CLI 3.0.10 (`solana`, `solana-keygen`, `cargo-build-sbf`,
  `solana-test-validator`) — matches `Anchor.toml` and CI.
- Node ≥ 24 and pnpm 9 (workspace package `@graveyield/devnet-tools`).
- Three keypairs: scanner program, vault program, deployer/authority.
- Deployer funded with ≥ 6 SOL on devnet. Cost drivers: rent-exempt storage
  of the two ELF binaries (~366 KB and ~405 KB → ≈ 2.7 SOL each), two
  ProtocolConfig accounts, and transaction fees. The deploy script refuses
  to run below 6 SOL and prints the shortfall.

## 1. Build + deploy

```bash
scripts/devnet/deploy_devnet.sh \
  --url https://api.devnet.solana.com \
  --scanner-keypair /path/to/grave_scanner-devnet.json \
  --vault-keypair   /path/to/grave_vault-devnet.json \
  --deployer        /path/to/deployer-authority-devnet.json
```

Stages, each with a hard refusal on mismatch:

1. **Identity check** — each keypair's pubkey must equal the compiled
   `declare_id!` value. An ELF deployed under an address different from its
   declared ID would fail every Anchor owner check at runtime; the script
   refuses instead of shipping a broken program.
2. **Funding check** — deployer balance ≥ 6 SOL, compared lamport-exact
   against 6 000 000 000 (never by digit-stripping the human SOL display,
   which mis-reads decimals).
3. **Artifact seeding** — copies the keypairs into the gitignored
   `target/deploy/` for `cargo build-sbf`; refuses if that directory already
   holds a DIFFERENT keypair (stale artifacts would silently deploy under
   the wrong address).
4. **Build** — per package directory: `cargo build-sbf` in
   `programs/grave-scanner` then `programs/grave-vault` (agave 3.0.10's
   `cargo-build-sbf` rejects workspace `-p` selection). Skipped entirely
   with `--skip-build`, which deploys pre-built (e.g. CI-produced) ELFs
   and does not require the SBF toolchain.
5. **Deploy** — `solana program deploy` with the matching
   `--program-id` keypair; the deployer becomes the upgrade authority.

Redeploys after the first deployment are UPGRADES (same address, same
authority) and follow the normal `solana program deploy` re-run; the
identity and artifact-refusal checks still apply.

## 2. Initialize both ProtocolConfigs

```bash
node scripts/devnet/protocol_admin.mjs init-all \
  --url https://api.devnet.solana.com \
  --deployer /path/to/deployer-authority-devnet.json
# add --authority <PUBKEY> to set a different config authority than the payer
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

`init-all` reads back both configs and verifies the authority landed. A
second `init-*` on an initialized config fails at the Anchor `init`
constraint — ProtocolConfig is init-once by design.

## 3. Emergency-control drill (Phase 11: "emergency controls tested")

```bash
node scripts/devnet/protocol_admin.mjs drill \
  --url https://api.devnet.solana.com \
  --program scanner \
  --authority /path/to/deployer-authority-devnet.json \
  --intruder  /path/to/any-other-keypair.json

node scripts/devnet/protocol_admin.mjs drill \
  --url https://api.devnet.solana.com \
  --program vault \
  --authority /path/to/deployer-authority-devnet.json \
  --intruder  /path/to/any-other-keypair.json
```

Per program, the drill asserts the full spec behavior:

1. Freshly initialized config readback — authority, all defaults, unpaused
   (account discriminator verified, not just fields).
2. Authority pauses (`paused` on scanner / `emergency_paused` on vault).
3. Readback asserts the flag flipped.
4. An intruder keypair attempts pause — the transaction MUST revert with
   the program's `Unauthorized` (GraveScanner 6000 / GraveVault 7000). Any
   other outcome (including a silent land) fails the drill.
5. Authority unpauses; readback asserts restoration.

The intruder keypair must hold fee dust (0.01 SOL is plenty): the probe
transaction is signed by the intruder alone, so the intruder pays its own
fee. An unfunded intruder fails at the system level ("Attempt to debit an
account but found no record of a prior credit") before the program's
authority check runs — the drill treats that as a failure, as well it
should, because the assertion is specifically that the PROGRAM reverts
with `Unauthorized`.

Stand-alone primitives: `pause --state true|false`, `check` (full config
dump). Custom program errors are decoded against the compact table in
`protocol_admin.mjs`, mirroring `docs/error_codes.md`.

## 4. Full rehearsal (no devnet needed)

```bash
scripts/devnet/local_rehearsal.sh
```

Starts a bare `solana-test-validator`, then drives the EXACT production
scripts: `deploy_devnet.sh` (build + identity-gated deploy), `init-all`,
and both drills. Deployer and intruder keys are minted into a `mktemp` dir
and discarded; the program keypairs must be the canonical devnet ones so the
ELF `declare_id!` matches (the script refuses otherwise). Success line:

```
REHEARSAL COMPLETE — deploy, initialize, pause, intruder-reject, and unpause all behaved per spec on both programs.
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

## 5. Deliberately out of scope here

- **Indexer / SDK publication / first Salvor / Merkle service** — roadmap
  Phases 8–10; the Phase 11 Infrastructure rows light up after those ship.
- **Controlled salvage scenarios** — require a funded Salvor with LP in a
  genuinely derelict devnet pool and the SDK's instruction builders; the
  fork harness already proves the settlement mechanics against mainnet
  bytecode (`tests/` suites).
- **Multisig authority** — devnet runs a single-key authority for
  operability. Mainnet launches multisig-only (Squads v4 3-of-5) per the
  Charter and `initialize` documentation; KEYS-003 and GOV-001 track the
  mainnet custody and timelock wiring.
