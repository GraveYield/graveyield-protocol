# Ops Runbook — GraveYield Protocol (Phase 11)

> **Status:** EXECUTED as of October 2026. This runbook covers the
> roadmap Phase 11 **Infrastructure & Observability** rows: the indexer
> running as a service, the SDK published, the first Salvor running, the
> Merkle service running, event/receipt/claim indexing, failed-
> transaction monitoring, alerting — and the controlled salvage
> scenarios. The Phase 11 *Protocol* rows (program deploys, config
> finalization, the emergency-control drill) were executed earlier and
> live in [`DEVNET.md`](DEVNET.md).
>
> The services live in [`ops/`](../ops/README.md) (`@graveyield/ops`).
> The fleet-side runner (Scout + Monitor as one process) lives in the
> [salvor-bots](https://github.com/GraveYield/salvor-bots) repo
> (`@graveyield/fleet-ops`, `graveyield-fleet run`).

## 1. Service inventory

| Service | Command | Schedule | State written |
|---|---|---|---|
| Indexer (GraveScanner v2) | `graveyield-ops indexer --loop` | `INDEXER_POLL_MS` (default 5 min) | console + health counters |
| Vault observer | `graveyield-ops vault-observer --loop` | `OBSERVER_POLL_MS` (default 1 min) | `ops-state/alerts.jsonl` |
| Merkle service | `graveyield-ops all` (with `MERKLE_INTERVAL_MS > 0`) | `MERKLE_INTERVAL_MS` | `ops-state/merkle/*.json` |
| Fleet runner (salvor-bots) | `graveyield-fleet run` | `FLEET_SCOUT_POLL_MS` / `FLEET_MONITOR_POLL_MS` | `fleet-state/*.jsonl` |
| Scenarios | `graveyield-ops scenario sc-01|sc-02|sc-03` | on demand | `ops-state/scenario-*.json` |

Everything defaults to the live devnet cluster
(`https://api.devnet.solana.com`) and read-only mode. No command in this
runbook spends SOL.

## 2. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | devnet | Solana RPC endpoint (shared by indexer + observer + merkle) |
| `CLUSTER` | `devnet` | `devnet` / `mainnet-beta` / `localnet` (informational in reports) |
| `SCANNER_PROGRAM_ID` | devnet GraveScanner | override for test clusters |
| `VAULT_PROGRAM_ID` | devnet GraveVault | override for test clusters |
| `OPS_STATE_DIR` | `ops-state` | JSONL trails, artifacts, scenario reports |
| `INDEXER_POLL_MS` | `300000` | indexer cycle interval |
| `OBSERVER_POLL_MS` | `60000` | vault observer sweep interval |
| `MERKLE_INTERVAL_MS` | `0` (off) | merkle schedule; `all` runs it when > 0 |
| `MERKLE_MAX_POOLS_PER_CYCLE` | `0` | pools per merkle cycle |
| `FAILED_TX_SWEEP_LIMIT` | `50` | signature depth of the failed-tx sweep |
| `ALERT_DEDUP_MS` | `1800000` | same-code suppression window |
| `ALERT_WEBHOOK_URL` | *(empty = off)* | POST endpoint for alerts |
| `ACTIVITY_ORACLE_KEY` | *(empty = discovery-only)* | indexer Phase-1 submission signing (Phase 9 contract) |

The indexer additionally consumes its own Phase 9 variables
(`MAX_CANDIDATES_PER_CYCLE`, `MIN_TVL_LAMPORTS`, …). The fleet runner
consumes the Scout's variables (`SCOUT_DRY_RUN`, `SALVOR_KEYPAIR`, …)
plus `FLEET_STATE_DIR`, `FLEET_SCOUT_POLL_MS`, `FLEET_MONITOR_POLL_MS`,
`FLEET_ALERT_DEDUP_MS`.

## 3. Running as a service

### tmux / screen (devnet operator box)

```bash
tmux new -s graveyield-ops
OPS_STATE_DIR=/var/lib/graveyield/ops \
ALERT_WEBHOOK_URL=https://hooks.example/graveyield \
  graveyield-ops all
# Ctrl-B D to detach
```

### systemd (unit sketch)

```ini
[Unit]
Description=GraveYield ops (indexer + vault observer + merkle)
After=network-online.target

[Service]
User=graveyield
Environment=RPC_URL=https://api.devnet.solana.com
Environment=OPS_STATE_DIR=/var/lib/graveyield/ops
Environment=ALERT_WEBHOOK_URL=https://hooks.example/graveyield
ExecStart=/usr/bin/env graveyield-ops all
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

`graveyield-ops all` installs SIGINT/SIGTERM handlers, so
`systemctl stop` drains cleanly. The health summary prints to stdout
every 60 s — journalctl-friendly.

### The fleet runner

```bash
FLEET_STATE_DIR=/var/lib/graveyield/fleet graveyield-fleet run
```

One process: Scout cycles every `FLEET_SCOUT_POLL_MS`, Monitor sweeps
every `FLEET_MONITOR_POLL_MS`. Scout events bridge into the Monitor
in-process (no second feed to drift). JSONL trails:
`fleet-state/monitor-events.jsonl`, `fleet-state/alerts.jsonl`.

## 4. Health + alerting

- `graveyield-ops health` prints the JSON snapshot: per-component
  status (`ok` / `degraded` / `down` / `stale` / `never-reported`),
  monotonic counters, overall status. Wire an uptime probe to it.
- Staleness is **derived**: a component that has not heartbeated within
  3× its poll interval reports `stale` even if its last cycle passed.
- Alerts carry stable codes — page on the code, not the message:
  `vault-accounts-unavailable` (critical), `receipt-sum-mismatch`
  (critical), `claim-accounting-anomaly` (critical),
  `vault-tx-failed` (warn), `indexer-cycle-failed` (critical),
  `merkle-snapshot-failed` (warn), `uncx-marker-present` (warn),
  `scout-cycle-failed` (critical), `monitor-*` (mapped per diagnostic).
- The JSONL sink (`ops-state/alerts.jsonl`) is the persistent audit
  trail; suppressed repeats carry `suppressed: true`.

## 5. Controlled salvage scenarios

The roadmap's closing Phase 11 row. Run after the services are up:

```bash
graveyield-ops scenario sc-01   # lifecycle sweep (read-only, live)
graveyield-ops scenario sc-02   # vault audit (read-only, live)
graveyield-ops scenario sc-03   # local deploy + drill rehearsal
```

- **SC-01 lifecycle-sweep** — one indexer cycle + one observer sweep +
  health snapshot. Proves the funnel end-to-end on the live cluster
  without keys. Fails if the vault books are inconsistent or a service
  is stalled.
- **SC-02 vault-audit** — the deep audit: R1/R2 receipt invariants,
  C1–C3 claim accounting, failed-tx sweep, ProtocolConfig readback.
  This is the standing answer to "is settlement accounting healthy?"
- **SC-03 local-rehearsal** — re-runs the executed devnet rehearsal
  (deploy → init → pause drill) on `solana-test-validator` via
  `scripts/devnet/local_rehearsal.sh`. This is the **funded** salvage
  path: controlled salvage scenarios with real pool state run here
  while the devnet oracle keys remain de-pointed (see the custody note
  in `DEVNET.md`). Prerequisites: Solana CLI 3.0.10 and the io_uring
  seccomp wrapper (`gcc -O2 -o scripts/no_uring scripts/no_uring.c`);
  the scenario checks both and never auto-installs.

Reports persist to `ops-state/scenario-<id>-<ts>.json` and exit `0`/`1`,
so cron/CI can gate on them.

## 6. SDK publication

The SDK is publish-ready: `npm publish --dry-run` passes (dist + README
only) and a prebuilt tarball ships alongside each release. The publish
itself is a custodial owner action (npm automation token) — the
checklist is [`sdk/PUBLISH.md`](../sdk/PUBLISH.md). Operators can always
install from GitHub (`npm install github:GraveYield/salvor-bots#<tag>`)
or the packed tarball.

## 7. Known limits (flagged, by design)

- Devnet attestation-signed submissions remain unverifiable until the
  owner re-points the oracles (deployer keys were throwaways, wiped per
  custody policy). Every devnet run is effectively read-only — which
  SC-01/SC-02 are built for; funded salvage scenarios run on SC-03.
- The Merkle service schedules by pool list; `all` wires an empty list
  until discovery populates it. Use `graveyield-ops merkle --pool P`
  for explicit pool snapshots.
- `getProgramAccounts` over the vault program is unfiltered (the
  program owns few accounts on devnet). Before mainnet, switch the
  observer to per-discriminator memcmp filters if the account count
  grows.
