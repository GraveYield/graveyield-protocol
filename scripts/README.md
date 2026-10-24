# scripts/

Operational and development scripts for GraveYield Protocol.

| Script | Purpose |
|--------|---------|
| `check-toolchain.sh` | Verify pinned versions of solana, anchor, rust, node, pnpm. |
| `terminology-lint.sh` | Enforce GraveYield's canonical v4.0 vocabulary across the repo. Runs in CI. |
| `build_fork_harness.sh` | Build both programs + Jupiter stub with `cargo build-sbf`, fetch real mainnet fixtures, run all seven fork suites. Nightly in CI (`.github/workflows/fork-harness.yml`) and via the `fork-harness` PR label. |
| `fetch_v4_fork_fixtures.mjs` | Fetch + cross-validate the mainnet Raydium V4 state and program ELFs the fork suites fork against. Invoked by `build_fork_harness.sh`. |
| `devnet/deploy_devnet.sh` | Build both programs with `cargo build-sbf` and deploy them to devnet under the devnet program IDs (identity + funding gated). Runbook: [`../docs/DEVNET.md`](../docs/DEVNET.md). |
| `devnet/protocol_admin.mjs` | Devnet/rehearsal administration: ProtocolConfig initialization, emergency pause/unpause, config readback, and the full emergency-control drill (including the intruder-rejection assertion). |
| `devnet/local_rehearsal.sh` | Rehearse the entire devnet sequence (deploy → initialize → drills) against a local `solana-test-validator` using the production scripts. |

## Usage

```bash
# Manual toolchain check (run locally before opening a PR).
bash ./scripts/check-toolchain.sh

# Manual terminology lint.
bash ./scripts/terminology-lint.sh
```

Both scripts are also invoked by `.github/workflows/ci.yml`.

## Adding new scripts

Keep scripts:

- POSIX-compatible bash (`#!/usr/bin/env bash`) with `set -euo pipefail` at the top.
- Self-contained — no implicit dependencies on the developer's local config.
- Documented in this README with a one-line purpose.
