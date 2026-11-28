# claims-snapshot.yml — the D3→D4 claims-artifact producer workflow

Status: **prepared, not operational** — the workflow is implemented and
structurally validated (`sdk/test/claimsSnapshotWorkflow.test.ts`), and
its fail-closed gate has been demonstrated on a real controlled dispatch
WITHOUT the RPC secret (the run aborts at the secret gate before any
network call). The positive path — a real governed-input run followed by
a genuine cross-repository artifact retrieval by the indexer — has NOT
been demonstrated yet; until it is, this workflow must not be treated as
operational.

## What it is

`grave-snapshotter-cli` (`.github/workflows/claims-snapshot.yml`) is the
companion D4 producer workflow (workstream D, I-06): it runs the REAL
Rust claims producer (`snapshotter/src/bin/grave-snapshotter-cli.rs`)
against an RPC endpoint and uploads the sealed claims artifact as a
GitHub Actions **run artifact**, so the indexer's publication pipeline
(`GraveYield/grave-indexer` → `publish-claims-artifact.yml`) can
retrieve the EXACT artifact by producer-run identity and fully
re-verify it (digest, byte length, CRC32, claims-grade schema,
provenance, Merkle integrity, pool identity) before any publication
side effect.

## Identity lock-step

The indexer pins the producer identity in
`publish-claims-artifact.yml`:

```yaml
GY_CLAIMS_PRODUCER_WORKFLOW: grave-snapshotter-cli
GY_CLAIMS_ARTIFACT_NAME: claims-artifact.json
```

Both values MUST stay in lock-step with this workflow:

* this workflow's top-level `name:` is exactly `grave-snapshotter-cli`
  (the handoff compares the run's workflow identity against it and
  fails closed on any mismatch);
* the upload step names the artifact exactly `claims-artifact.json`
  (the handoff retrieves exactly one artifact by that name from the
  specified run — ambiguity fails closed).

Both sides are enforced by tests: `sdk/test/claimsSnapshotWorkflow.test.ts`
here, `test/claimsReview.test.ts` in grave-indexer.

## Inputs (workflow_dispatch, ALL required)

| Input | Meaning | Failure behavior |
| --- | --- | --- |
| `pool` | Pool public key (base58) | empty ⇒ run aborts at the gate |
| `amm` | AMM program id (base58) | empty ⇒ run aborts at the gate |
| `lp_mint` | LP mint (base58) | empty ⇒ run aborts at the gate |
| `commitment` | `confirmed` or `finalized` (choice; never defaulted) | other value ⇒ run aborts at the gate |
| `sink_ledger` | The full governed `gy.sink-ledger.v1` document | empty/whitespace ⇒ run aborts at the gate; malformed/unsupported/duplicate/ambiguous/pool-mismatched ⇒ the CLI aborts |

The CLI additionally REQUIRES `--lock-evidence rpc` (real UNCX Raydium
AMM V4 locker evidence via `getProgramAccounts`); an empty lock list is
never substituted (WD-07). A schema-valid sink ledger is NOT proof of
owner approval — that remains a D-04-D process control.

## Secret

* `SNAPSHOTTER_RPC_URL` — the RPC endpoint used for holder enumeration
  and locker evidence. It may be credential-bearing (provider API keys
  in the URL). It enters the workflow ONLY through the secret, is
  checked for presence WITHOUT being printed, and is consumed only as a
  quoted `"$SNAP_RPC_URL"`. The CLI's logging path is structurally
  unable to log the URL (D1-01). A missing secret fails closed at the
  first step — before checkout, build, or any network call.

## Provenance

The run's `head_sha` is the dispatch commit (`github.sha`); the artifact
is therefore bound to that exact commit, and the indexer verifies the
run's `head_sha` against the publication's `source_commit`. A
`claims-artifact-provenance` artifact additionally records:

* `producer_commit_sha`, `run_id`, `run_attempt` (exact run identity),
* `toolchain` and build flags (`--release --locked` against the
  committed `Cargo.lock`),
* `sink_ledger_input_sha256` (the exact governed input),
* `artifact_sha256` + `artifact_byte_length`,
* `grade: validation-only — NEVER a production claims release`.

## Failure behavior (fail closed)

| Situation | Behavior |
| --- | --- |
| Missing/empty pool, amm, lp_mint, commitment outside the choice, or empty sink ledger | run aborts at step 1 (before checkout/build) |
| `SNAPSHOTTER_RPC_URL` secret unset | run aborts at step 1 |
| Malformed/unsupported/duplicate/ambiguous/mismatched sink ledger | `grave-snapshotter-cli` aborts; no artifact is uploaded |
| Locker evidence unavailable/malformed/unsupported | `grave-snapshotter-cli` aborts (never degrades to an empty lock list) |
| Artifact missing/empty/not format-v2 | run aborts before upload |
| Artifact upload incomplete | `if-no-files-found: error` — the run fails |

An unsuccessful run can never reach the indexer: the handoff verifies
`status == completed && conclusion == success` and refuses anything
else.

## Required GitHub permissions

* This workflow: `contents: read` ONLY (plus the default
  `actions: read`-equivalent needed to write its own run artifacts).
* The indexer side (`GraveYield/grave-indexer`): the automatic
  `GITHUB_TOKEN` cannot read another repository's Actions runs or
  artifacts, so the handoff authenticates with a dedicated
  `GY_CLAIMS_PRODUCER_TOKEN` secret scoped to **actions:read on
  `GraveYield/graveyield-protocol`, nothing more**.

## Safety envelope

* READ-ONLY on-chain access (JSON-RPC reads only). The workflow never
  signs, never submits a transaction, never runs salvage.
* ARTIFACT-ONLY: no release, no git ref/tag, no stable pointer. The
  production stable pointer `claims-artifact-prod` lives exclusively in
  the indexer repository and is moved only by the indexer's own
  publication workflow, as a separately-authorized dispatch.
* The artifact is validation-grade: it must never be treated as a
  production claims release.
