# Investigation: NS-3 Node.js provenance CLI stdout hang

**Branch:** `investigation/ns3-node-stdout-hang` (from `main` @ `b9a1bf4`)
**Status:** ACTIVE — read-only investigation, no implementation authorized.
**Mode:** Autonomous investigation with GitHub persistence. Draft PR tracks this directory.

## Objective

Establish the exact root cause of the reproducible process-termination failure
affecting the standalone NS-3 provenance checker
(`scripts/devnet/ns3_check_provenance.mjs`) and, through it,
`bash scripts/devnet/deploy_devnet.sh --build-only`.

Observed signature (owner-supplied, original VM): the checker prints its full
success output (`PASS [platform-tools] …`, `PROVENANCE OK …`) and then, when
stdout is redirected, the process does not terminate (CLI_EXIT=124 under
`timeout 10`). Interactively it exits 0. The same command exits 0 under
`--trace-exit`.

## Hard boundaries (from the assignment — restated so they survive session resets)

- READ-ONLY with respect to all existing project code. No fixes implemented.
- No modification of: deploy scripts, checker, ELF verification, manifest,
  pinned digests, dependencies, toolchains, identities, CI.
- No deployment commands, no transactions, no keypair/credential access.
- No force-push, no history rewrite, no merging, no unrelated branches.
- Nothing here authorizes implementation. Fixes are recommendations only,
  gated on owner approval.

## Evidence categories (kept strictly separated everywhere in this directory)

| Tag | Meaning |
| --- | --- |
| **[VM-E]** | Confirmed from the original VM's supplied evidence (assignment §3, tests A–G) |
| **[CI-E]** | Confirmed from CI run evidence already on record (PR #95, jobs 128668188833 / 128835411543) |
| **[REPRO]** | Independently reproduced in the investigation sandbox (Node v24.22.2 — same as VM) |
| **[SRC]** | Inferred from source-code analysis (file:line references given) |
| **[VM-TODO]** | Still requiring execution on the original VM |

## Artifact map

| File | Contents |
| --- | --- |
| `ENVIRONMENT.md` | Sandbox vs original-VM environment + equivalence statement |
| `EVIDENCE.md` | Owner evidence A–G, PR #95 CI evidence, classification |
| `HYPOTHESES.md` | Hypothesis register with status + minimum confirming evidence |
| `REPRODUCTIONS.md` | Reproduction experiments: commands, results, statistics |
| `ROOT_CAUSE_REPORT.md` | Final root-cause assessment (written when evidence suffices) |
| `WORKLOG.md` | Chronological session log (every session ends with a commit) |
| `diagnostics/` | Reproduction & capture scripts (all run OUTSIDE the repo tree; they never modify repo files) |

## Non-goals

General GraveYield audit, dependency upgrades, toolchain changes, deployment.
