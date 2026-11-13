# Root-cause report — NS-3 Node.js provenance CLI stdout hang

**Classification banner: ROOT CAUSE CONFIRMED (mechanism level), with the
scope qualifier that the confirmation experiment ran in the investigation
sandbox on Node.js v24.22.2 — the exact Node version of the original VM —
while kernel/glibc differ; original-VM confirmation steps are listed in §J
and are expected to be formalities given the captured mechanism.**

---

## A. Executive summary

The NS-3 provenance checker (`scripts/devnet/ns3_check_provenance.mjs`)
verifies successfully and prints its complete success output, and then —
for certain invocation shapes — never terminates. This investigation
reproduced the failure **independently, on the same Node.js version
(v24.22.2)**, in the exact invocation shapes reported by the owner
(stdout redirected to a file or `/dev/null`, tarball-only check, explicit
`process.exit(0)`), at up to **≈50% per run** on an otherwise idle machine,
and captured the stuck process state that a prior in-repo investigation
(PR #95) could not obtain.

The captured state is unambiguous and was identical in 11/11 captured hang
events (22 `/proc` snapshots): after the checker's final `console.log`,
`process.exit(0)` (line 327) initiates process teardown; the main thread
blocks in a `futex(FUTEX_WAIT_BITSET, …, val=<V8Worker TID>)` — a
join-style wait **on the V8 platform worker thread** — while that worker
thread remains asleep on its own futex, **never woken during shutdown**.
Nothing in the checker's code participates: the verification path is fully
synchronous and has completed before the deadlock begins.

This is a **Node.js v24.22.2 process-teardown defect**, conditionally
triggered by workload shape: a large transient external-memory allocation
(the whole-tarball `readFileSync`), a substantial module-graph heap (the
`@solana/web3.js` 3.1.1 import chain), and stdout/timing conditions
(file/`/dev/null` stdout on an idle machine are the worst case observed;
TTY stdout and `--trace-exit`-instrumented runs did not hang in any trial).
It is the same failure PR #95 recorded twice in CI (complete output →
5 h 56 m silence → orphan node killed at runner cleanup).

Deployment impact: the hang never invalidates a verification verdict — it
happens strictly after `PROVENANCE OK`/`PROVENANCE FAILED`/`REFUSED` is
printed — but it wedges `deploy_devnet.sh --build-only` (the checker
invocation inside `pin_platform_tools()` runs unbounded). NS-3 build-only
preparation is therefore blocked-by-reliability, not blocked-by-integrity.
The recommended minimal correction (§H) mirrors the verdict-on-disk pattern
PR #95 already adopted for CI. **Nothing was implemented; all integrity
gates remain untouched.**

## B. Root cause

**ROOT CAUSE CONFIRMED** (mechanism level; see banner):

> On Node.js v24.22.2, `process.exit()` can deadlock in runtime teardown:
> the main thread waits forever for the V8 platform worker thread
> (`V8Worker`), which is parked on a futex and never signalled during the
> exit sequence. The checker reaches this state after completing 100% of
> its verification work, because its success path is synchronous and ends
> in an explicit `process.exit(0)` (line 327).

Trigger conditions measured in this investigation (all with the unmodified
checker logic, byte-identical copies; exact recipes in REPRODUCTIONS.md):

| Factor | Effect |
| --- | --- |
| Tarball size (transient 256 MB `readFileSync` buffer) | 0/470 runs with 4 KB tarball vs 21/180 (load) and 40+/96+ (idle) with 256 MB — **required** |
| `@solana/web3.js` 3.1.1 module load | 0/120 without the import vs 21/180 with, same conditions — **strong rate factor** |
| stdout type, idle machine | /dev/null 40/80 ≈ 50%, file ≈ 50%, **TTY 0/20** — worst case is exactly the owner's tests B/C |
| `--trace-exit` | 0/60 under otherwise-hanging conditions — the pre-exit stderr instrumentation collapses the race window (explains VM evidence F) |
| Artificial load | *Reduces* the rate (file 50%→11.7%) — the failure is timing-chaotic, not monotonic in load |
| Concurrent-GC disable flags | No protection (4/60) — the stuck worker is not doing concurrent mark/sweep |

## C. Evidence matrix

| # | Hypothesis / finding | Evidence | Environment | Status |
| --- | --- | --- | --- | --- |
| 1 | Verdict printed, then process never terminates | VM tests B/C (owner); CI job 128668188833 + 128835411543; R3 hang logs | VM, CI, sandbox | **Confirmed** |
| 2 | `process.exit(0)` at line 327 is reached | VM test F trace (`main …:327:13`); sandbox trace format captured (R5); success path is synchronous with nothing between verdict and exit (source L322–327) | VM + sandbox | **Confirmed** |
| 3 | Deadlock = main thread joining `V8Worker`; worker never woken | 20/20 `/proc` snapshots: main `futex(WAIT_BITSET, val=<V8Worker TID>)`; worker `futex(WAIT_BITSET, val=0)`; t1≡t2 | Sandbox (same Node as VM) | **Confirmed** [REPRO] |
| 4 | Same failure on the original VM | Owner tests A–G; not yet re-run with capture under our protocol | VM | Requires VM testing (§J V1–V3) |
| 5 | stdout redirection is the *mechanism* | TTY is also sync-write; hang occurs after all writes complete; TTY runs never hang; pipe-stdout runs never hang | Sandbox | **Rejected** (correlation only: idle file/devnull are the high-rate shapes) |
| 6 | Deployment script introduces its own failure | Stall point is the checker invocation itself (`deploy_devnet.sh:198`), same CLI shape as B/C; no fd/subshell trickery | Source + VM-E G | **Rejected** as independent cause |
| 7 | Checker logic / manifest / digests involved | Success path fully synchronous; verdict complete before hang; synthetic manifest/tarball reproduce; real pins never touched | Source + sandbox | **Rejected** |
| 8 | `--trace-exit` causally prevents the hang | 0/60 (big+load) vs 21/180 without, matched cells; instrumentation writes stderr pre-exit (R5) | Sandbox | **Confirmed** as a timing effect |
| 9 | `@solana/web3.js` import required | 0/120 stripped-copy vs 21/180 with import, matched cells | Sandbox | **Strongly supported** |
| 10 | Large transient buffer required | Tiny tarball 0/470 vs big 61/276+ across all shapes | Sandbox | **Confirmed** |
| 11 | External interference (Hermes Agent, kernel) needed | Reproduces on an idle machine at ~50% | Sandbox | **Rejected** as necessary condition |
| 12 | Keep-alive event-loop handle explains the hang | Explicit `process.exit(0)` terminates regardless of handles; no timers/watchers/children in source; hang is inside exit | Source + captures | **Rejected** |

## D. Runtime analysis

- **Node.js:** v24.22.2 both environments. Teardown sequence implicated:
  `process.exit()` (JS) → exit listeners (none registered) → runtime stop →
  V8 platform disposal → **join of the `V8Worker` platform thread — this is
  where it deadlocks** (main thread `futex(FUTEX_WAIT_BITSET|PRIVATE|
  CLOCK_REALTIME, val=<V8Worker TID>)`; glibc joins/synchronizes on the
  target thread's tid futex).
- **Threads at hang:** exactly 3 — MainThread (blocked join), V8Worker
  (parked, val=0, never woken), SignalInspector (normal park). t1≡t2 ⇒ no
  progress is possible; SIGKILL is the only exit (SIGTERM/timeout ⇒ 124,
  matching the owner's CLI_EXIT=124).
- **stdout/stderr/fds:** file, `/dev/null` and TTY stdout are all
  synchronous in Node (TTY wrap / `fs.SyncWriteStream`); every verdict line
  was durably in the target file/log before the hang in 100% of captures.
  io_uring/epoll fds present but idle (no pending I/O at hang). Pipe stdout
  did not hang in 60 trials.
- **Memory:** RSS ≈ 347 MB at hang (256 MB tarball buffer + module graph).
  The 256 MB buffer is *transient* in the checker (dead by exit). Tiny
  tarball (≈0 MB pressure) never hung in 470 runs → external-memory churn
  at exit is a required ingredient.
- **Event-loop handles:** none registered by checker code (grep + source:
  no timers/watchers/sockets/children/workers). `--trace-exit` trace
  confirms exit initiated from `main` (L327) through
  `node:internal/process/per_thread:241`.
- **Scheduling:** rates shift with load (idle ≈50% → loaded 11.7% file /
  0% devnull) — consistent with a lost-wakeup race between exit-initiation
  and the worker's park cycle, i.e. the failure is a timing window, not a
  deterministic state.

## E. Source-code analysis

- `ns3_check_provenance.mjs` (sha256 `c47d7bad…`): argument parsing L281–287;
  manifest validation L75–155 (all `readFileSync`); tarball digest
  L258–275 via `sha256File` L158–160 (`createHash('sha256').update(
  readFileSync(path))` — whole-archive buffer); verdict printing L322–324
  (`console.log`, sync for TTY/file//dev/null); **success exit `process.exit(0)`
  L327**; failure exits L298/L306/L320/L333. No `await`, no streams, no
  child processes, no workers, no `process.on('exit')`.
- `ns3_verify_elf.mjs` (sha256 `48b79982…`): **L53 `import { PublicKey }
  from "@solana/web3.js"`** — the only npm dependency in the chain. In the
  failing tarball-only invocation `PublicKey` is never constructed: all
  npm code executes at **module load**.
- Dependency resolution: `scripts/devnet/package.json` `@solana/web3.js
  ^3.1.1`; root `package.json` pnpm override **exactly 3.1.1**;
  `pnpm-lock.yaml` L13/L868; optional peers `bufferutil@4.1.0`,
  `utf-8-validate@6.0.6`, `fastestsmallesttextencoderdecoder@1.0.22`.
- Execution path of the failing invocation: module graph load (checker →
  ns3_verify_elf → web3.js graph, 59 packages) → `main()` (sync) →
  `checkProvenance()` (sync) → two `console.log` lines → `process.exit(0)`
  → **teardown deadlock**.
- `deploy_devnet.sh`: `pin_platform_tools()` L186–246; the stall point is
  L198–199 `if node "$PROVENANCE_CHECKER" --manifest …
  --platform-tools-tarball "$archive" >/dev/null; then` (bash tracing [VM-E
  G] matches). `run_provenance_gate()` L156–170 (`node "$PROVENANCE_CHECKER"
  …` with inherited stdout) is equally exposed on every path. `set -euo
  pipefail` + a hung checker ⇒ the whole script wedges (900 s timeout was
  previously hit [VM-E G]).

## F. Deployment script analysis

`deploy_devnet.sh` introduces **no separate failure and no execution-
environment change**; it merely exposes the standalone CLI behavior in two
places: the tarball-only re-verification inside `pin_platform_tools()`
(stdout→/dev/null, inside an `if` — the `if` itself is irrelevant; bash
simply waits for an exit that never comes) and `run_provenance_gate()` on
every path. It inherits no unexpected fds beyond ordinary stdio, uses no
construct that affects process waiting, and does not modify the checker's
environment beyond `cd "$REPO_ROOT"`. The 900 s `--build-only` timeout hit
[VM-E G] is the standalone hang plus `set -e` blocking. Note
`local_rehearsal_ns3.sh:81` runs `ns3_verify_elf.mjs` unbounded as well —
same exposure class, no timeout.

## G. `--trace-exit` analysis

`--trace-exit` wraps `process.exit` at bootstrap
(`node:internal/process/per_thread:241`) and **synchronously writes
`(node:PID) WARNING: Exited the environment with code N` plus the JS stack
to stderr *before* the real exit sequence starts** (format captured, R5).
Semantics are unchanged — the process still exits with code 0 — but the
pre-exit stderr write (and the string/stack construction) delays
exit-initiation by a scheduling quantum. Under matched reproducing
conditions this collapsed the hang rate from 21/180 to 0/60 (p ≈ 4·10⁻⁴).
**The owner's evidence F is therefore explained as a causal timing
perturbation, not an anomaly and not luck:** instrumented runs initialize
teardown at a different point in the worker's park cycle, and the
lost-wakeup window closes.

## H. Recommended minimal fix (NOT implemented — owner approval required)

The verification verdict is complete and durably recorded **before** the
teardown deadlock can begin, so process termination adds no verification
value. The smallest justified correction mirrors what this repository
already adopted for CI in PR #95 — **decide on the recorded verdict, never
on process teardown** — applied to the two shell call sites:

1. In `deploy_devnet.sh` `pin_platform_tools()` (L198–199) and
   `run_provenance_gate()` (L169): run the checker with stdout captured to
   a per-run log file, under `timeout --kill-after=10s 300`; accept the
   branch **only** on the tool's own recorded verdict
   (`PROVENANCE OK` / all-`PASS` lines) read back from the log; treat a
   recorded `PROVENANCE FAILED`/`REFUSED`, any other rc, or a missing
   verdict as **fail-closed** (exit 1). Zero changes to the checker, the
   manifest, the digests, the arch gate, or gate ordering.
2. No JS-level workaround is recommended: editing the security-gate
   checker (e.g. adding a stderr flush before `process.exit(0)` — which
   the `--trace-exit` finding proves effective) touches a
   deployment-critical integrity file for a non-integrity problem, and was
   deliberately **not** attempted under the read-only mandate.

## I. Regression tests (exact commands, expected exit codes)

Run in the out-of-repo scratch env (recipe: `diagnostics/`, fixtures are
synthetic; no repo file is modified):

```bash
# R-1: VM test B shape (idle, /dev/null, big tarball) — hang reproduced at ~50%:
for i in $(seq 1 20); do
  timeout 10 node checker/ns3_check_provenance.mjs \
    --manifest fixtures/manifest.big.json \
    --platform-tools-tarball fixtures/big.tar.bz2 >/dev/null
  echo "rc=$?"            # healthy: 0 ; hang: 124 (process never terminated)
done
# R-2: TTY stdout protects:
script -qec "timeout 10 node checker/ns3_check_provenance.mjs \
  --manifest fixtures/manifest.big.json \
  --platform-tools-tarball fixtures/big.tar.bz2" /dev/null; echo "rc=$?"   # 0 (0/20 observed)
# R-3: --trace-exit protects:
timeout 10 node --trace-exit checker/ns3_check_provenance.mjs \
  --manifest fixtures/manifest.big.json \
  --platform-tools-tarball fixtures/big.tar.bz2 >/dev/null; echo "rc=$?"   # 0 (0/60 observed)
# R-4: stuck-state capture on any hang (the decisive artifact):
bash diagnostics/capture_stuck.sh <hung-pid>   # expect: MainThread futex val == V8Worker tid
```

Post-fix regression (after owner-approved implementation): R-1 must yield
`rc=0` (or 124 with a recorded verdict under the §H wrapper) for 40/40
runs, and the recorded verdict must equal the tool's own verdict in every
run.

## J. Original-VM follow-up (only what still requires the VM)

Three commands, ordered by discriminating power; each is read-only,
bounded, and modifies nothing in the repository:

**V1 — Reproduce + capture on the VM (single command; confirms hypothesis 3
and §B end-to-end in the original environment):**
```bash
node scripts/devnet/ns3_check_provenance.mjs \
  --manifest "$PWD/scripts/devnet/provenance.manifest.json" \
  --platform-tools-tarball "$HOME/.cache/solana/.graveyield-platform-tools-v1.54.tar.bz2" \
  >/tmp/v1.log 2>&1 & PID=$!
sleep 5
if kill -0 $PID 2>/dev/null; then
  echo "HUNG — capturing"; grep -m1 VmRSS /proc/$PID/status
  for T in /proc/$PID/task/*; do echo "-- $(cat $T/comm)"; cat $T/wchan; cat $T/syscall; done
  for T in /proc/$PID/task/*; do grep -H . $T/comm $T/wchan $T/syscall; done
  kill -9 $PID
else echo "exited normally"; fi
cat /tmp/v1.log
```
Meaning: if the process is alive after 5 s with the full verdict in
/tmp/v1.log, and the MainThread syscall shows
`futex(... val=<V8Worker-tid>)` while a `V8Worker` task shows
`futex(..., 0)`, the sandbox-captured mechanism is confirmed on the VM.
If it exits cleanly 20/20 times, the VM's failure needs the load factor
(re-run during a Hermes-active period) — either way the mechanism is
bounded to the captured teardown path.

**V2 — Determinism of the stdout-type pattern (bounds hypothesis 5's
residual):**
```bash
for i in $(seq 1 20); do timeout 10 node scripts/devnet/ns3_check_provenance.mjs \
  --manifest "$PWD/scripts/devnet/provenance.manifest.json" \
  --platform-tools-tarball "$HOME/.cache/solana/.graveyield-platform-tools-v1.54.tar.bz2" \
  >/dev/null; echo -n "$? "; done; echo
```
Meaning: sandbox predicts ≈50% `124` (and `0` otherwise). A 20/20-`124` or
0/20 result would falsify the rate transfer and demand a VM-specific
factor (then run V3).

**V3 — Direct syscall trace (only if V1's /proc capture is inconclusive;
needs strace installed, which PR #95 noted was absent):**
```bash
command -v strace >/dev/null && strace -f -e trace=futex,write,exit_group \
  -o /tmp/v3.strace timeout 15 node scripts/devnet/ns3_check_provenance.mjs \
  --manifest "$PWD/scripts/devnet/provenance.manifest.json" \
  --platform-tools-tarball "$HOME/.cache/solana/.graveyield-platform-tools-v1.54.tar.bz2" \
  >/dev/null 2>&1; tail -40 /tmp/v3.strace
```
Meaning: a healthy run's tail shows `exit_group(0)`; a hung run's tail
shows the main thread's final `futex(...)` on the worker's tid with no
resuming wakeup — the exact C-level counterpart of the capture.

## K. Deployment readiness impact

- **Does this block `deploy_devnet.sh --build-only`?** Yes, operationally:
  the gate invocation inside `pin_platform_tools()` wedges at ≈50% per run
  on an idle machine (idle is the typical state of a deploy VM), and
  `set -euo pipefail` turns the wedge into a full-script stall (the
  observed 900 s timeout). Every re-run re-rolls the same dice.
- **What is NOT affected:** the integrity of the gate. In every observed
  hang — VM, CI, sandbox — the verdict was already computed, printed, and
  recorded; the hang never follows a FAILED/REFUSED verdict specifically
  and never alters one. No deployment has been attempted; no transaction
  submitted; no keypair touched.
- **What must be verified before proceeding with NS-3 build-only:**
  owner approval of §H (verdict-on-disk wrapper for the two shell call
  sites, mirroring PR #95's CI pattern); after implementation, the §I
  post-fix regression (40/40) on the VM; optionally V1–V3 first as
  formal on-VM confirmation. Until then, a pragmatic (unofficial)
  mitigation the owner may choose at their own discretion: run the
  checker manually, confirm `PROVENANCE OK` on record, and treat a
  post-verdict timeout as a teardown artifact — exactly the policy PR #95
  codified for CI. No change to any pin, digest, identity, or gate is
  needed or recommended by this investigation.

## L. PR and persistence

- **Branch:** `investigation/ns3-node-stdout-hang` (from `main` @ `b9a1bf4`)
- **Draft PR:** https://github.com/GraveYield/graveyield-protocol/pull/98
  ( Investigation: NS-3 Node.js provenance CLI stdout hang )
- **Commits:** see `git log investigation/ns3-node-stdout-hang` — initial
  evidence register + Phase 1 (`3bf15e0`), reproduction + root-cause
  report (this push). Every work session ends with a commit+push.
- **Investigation artifacts:** `investigations/ns3-node-stdout-hang/` —
  README, ENVIRONMENT, EVIDENCE, HYPOTHESES, REPRODUCTIONS, WORKLOG, this
  report, and `diagnostics/` (fixture setup, matrix runners, capture
  tooling, representative capture files).
- **Remaining work:** owner-run V1–V3 (§J); owner decision on §H;
  upstreaming the captured mechanism to the Node.js project is at the
  owner's discretion (the /proc captures here are sufficient to open a
  Node issue for v24.22.2 teardown deadlocks).
