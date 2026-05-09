# scripts/

Operational and development scripts for GraveYield Protocol.

| Script | Purpose |
|--------|---------|
| `check-toolchain.sh` | Verify pinned versions of solana, anchor, rust, node, pnpm. |
| `terminology-lint.sh` | Enforce GraveYield's canonical v4.0 vocabulary across the repo. Runs in CI. |

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
