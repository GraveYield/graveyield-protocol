# W1 Workrun Recovery — 2026-10-28

This branch preserves the **recovered evidence and record artifacts** of the W1
Lifecycle Rehearsal workrun after the engineering workspace was destroyed by its
third hard reset on 2026-10-28. It exists so the workrun record survives outside
any sandbox.

**`main` is untouched. Do not merge this branch as-is.**

## What this branch is

Evidence-only preservation: the shared worklog, the rehearsal-run logs, the
push-runbook scripts, and the mid-session source caches that survived the reset.

## What was lost (NOT on this branch)

The two verified local commits were destroyed by the reset before they could be
pushed and exist nowhere:

- `graveyield-protocol` `fcb543c` — "feat(w1): Lifecycle Rehearsal Harness —
  one-command local end-to-end pass with adversarial battery" (13 files, +3102/−10:
  `scripts/devnet/lifecycle_rehearsal.sh`, `scripts/devnet/lifecycle_rehearsal/{lib,
  pin_elfs,prepare_local_accounts,register_oracle,drive_lifecycle}.mjs`, harness
  README, 2 evidence probes, SDK ESM-require fix, snapshotter CLI bin, devnet pkg
  tweetnacl)
- `salvor-bots` `0ec8f1c` — "fix(sdk-mirror): buildSweepDustIx ESM require crash —
  sync with protocol sdk"

The final harness code in those commits passed the full 16-stage lifecycle +
adversarial battery (run 3, `logs/rehearsal-run3.log` here) and is NOT recoverable
from the surviving caches.

## Directory map

| Path | Contents |
|---|---|
| `worklog.md` | Full W1 session record: stage matrix, constraint resolutions, the 13 runtime fixes of run 3, commit staging (§W1-6a) |
| `logs/` | `rehearsal-run1..16.log` (run 3 = the all-green run; runs 4–16 = in-place relaunches), build/pnpm/cargo logs |
| `recovered-sources/` | Mid-session file caches. **All are EARLY, PRE-FIX copies** — e.g. `drive_lifecycle.early.mjs.txt` predates the 13 runtime fixes (ALT v0 tx path, SLOT-HASH sysvar reading, market-nonce re-pin, web3.js 3.x async-ification). They document design intent; they are NOT the verified final code |
| `scripts/` | PAT push runbook (`push_w1_2026-10-28.sh`), `secret_scan_diff.sh`, token-free `git-askpass.sh`, toolchain `env.sh`, `probe_tx_wire.mjs` |
| `GraveYield_Engineering_Handoff_PreW1_2026-10-28_Volume_IV.md` | The authoritative pre-W1 handoff (state freeze, W1 recon, execution plan) |

## Rebuild path

Rebuilding the verified harness requires redoing W1 per Handoff Vol IV §10 with
the recovery anchors above (worklog + logs + Vol IV + the base repositories) —
the exact recovery design the engagement planned for: re-install toolchain
(agave 3.0.10, rust 1.91.1), re-clone, re-fetch fixtures, re-apply the harness,
re-run to 16-stage + adversarial green, then commit and push to `main` through
the PAT runbook gates.

## Provenance

Recovered and pushed 2026-10-28 by the W1 engineering session (sethoshi.eth
engagement) at the owner's direct instruction, via the §5.1 PAT runbook
(env-only token, identity gate, three-way head gate). Secret-scanned before
push: no token material, no keypair material; long base58 strings in logs are
public local-validator transaction signatures.
