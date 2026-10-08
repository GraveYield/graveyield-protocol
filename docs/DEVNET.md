# Devnet Runbook — GraveYield Protocol

> **Status (this commit):** deployment tooling shipped; the full sequence —
> build → deploy → initialize → emergency-control drill — is **rehearsed
> end-to-end on `solana-test-validator`** via the exact production scripts
> (`scripts/devnet/local_rehearsal.sh`). The devnet execution itself is a
> funded-wallet step of an already-proven sequence: the sandbox that produced
> this runbook is faucet-rate-limited, so the deploy commands below must be
> executed from any funded devnet keypair (CI cannot and should not hold
> keys). Roadmap Phase 11 "Infrastructure" and "Observability" sections
> (indexer, SDK publication, first Salvor, Merkle service, event indexing,
> alerting) are deliberately NOT in this phase — they depend on Phases 8–10
> and remain sequenced per the shipping roadmap.

## Network facts

| Item | Value |
|------|-------|
| Cluster | Solana devnet — `https://api.devnet.solana.com` |
| GraveScanner program ID | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` |
| GraveVault program ID | `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` |
| ProtocolConfig PDA (both) | `["protocol_config"]` under each program's ID |
| Upgrade authority (devnet) | the deployer keypair (single key — see custody note) |
| Config authority at initialize | the deployer keypair; `activity_oracle` and `launch_price_oracle` both start at the same key and rotate independently via `update_protocol_config` |

The program IDs above are real keypairs (the old SHA-256-derived placeholders
were keyless and undeployable). They are mirrored in both `declare_id!`
calls, every `Anchor.toml` section, and the six fork suites that derive
scanner PDAs.

**Key custody (devnet):** the devnet keypairs are throwaways. They live
OUTSIDE the repository (`devnet-keys/` in the operator workspace, never in
git; `target/deploy/` copies are gitignored). NEVER reuse them for mainnet —
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
2. **Funding check** — deployer balance ≥ 2 SOL.
3. **Artifact seeding** — copies the keypairs into the gitignored
   `target/deploy/` for `cargo build-sbf`; refuses if that directory already
   holds a DIFFERENT keypair (stale artifacts would silently deploy under
   the wrong address).
4. **Build** — `cargo build-sbf -p grave-scanner` then `-p grave-vault`.
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
