# Hypothesis register

Statuses: CONFIRMED / STRONGLY-SUPPORTED / PLAUSIBLE / REJECTED / REQUIRES-VM.
Minimum confirming evidence is stated for every non-confirmed hypothesis.
This file is updated as evidence lands; superseded hypotheses stay listed
(rejected ones with the reason).

---

## H1 — "stdout redirection causes the hang" (the assignment's implied frame)

**Status: REJECTED as a *mechanism*, DOWNGRADED to *correlation at best*.**

- Node writes stdout to files/`/dev/null`/TTY **synchronously** (TTY wrap /
  `fs.SyncWriteStream`); `console.log` on those fd types blocks until the
  bytes are handed to the kernel. VM test C shows the complete output in the
  file → the writes completed before the hang [VM-E].
- PR #95 [CI-E]: 200 sequential runs with pipe stdout → 0 hangs; both CI
  hang occurrences happened with **file-redirected** stdout *and* two other
  CI runs on the same Node with the same redirection did not hang.
- Redirection cannot change anything in the exit path: by the time the
  verdict is printed, the stdout fd type is irrelevant to teardown.
- The VM's A/B/C/F pattern (n=1 each) is consistent with sampling a
  low-probability intermittent failure (see H2) — with the caveat that
  B+C both hanging in two adjacent runs would be a ~p² event unless the VM
  raises p (e.g., Hermes Agent load → H2/H3) or redirection genuinely
  correlates with higher p on that VM. **Minimum confirming evidence for
  any residual redirect effect:** VM follow-up V2 (n≥20 per stdout mode,
  same load) — see ROOT_CAUSE_REPORT.md §J.

## H2 — Intermittent Node.js process-teardown hang after `process.exit(0)`
        (race between exit sequence and live runtime threads)

**Status: STRONGLY-SUPPORTED at the Node level; mechanism unidentified — this
investigation's primary target.**

- Supported by [CI-E] (PR #95): complete output → no termination → orphan
  node killed by runner; intermittent (≈2.5% under load); same Node version
  healthy in adjacent runs; trivial `-e` script does not hang.
- Supported by [SRC]: the checker's success path is synchronous and ends in
  an explicit `process.exit(0)` (L327), so no event-loop handle can keep it
  alive; only the teardown path itself can stall.
- **Mechanistic sub-hypotheses to discriminate (all testable in sandbox):
  H2a** libc `exit()`/atexit-stage deadlock (e.g., OpenSSL `OPENSSL_cleanup`
  or malloc/NSS atexit racing a still-running libuv threadpool / V8 platform
  thread — a classic "rare hang at exit under load" shape);
  **H2b** a thread created during the `@solana/web3.js` import chain is
  mid-syscall at `process.exit()` time and teardown joins it under a lock;
  **H2c** V8 platform worker task in flight at exit.
  Minimum confirming evidence: a captured stuck-process state — per-thread
  kernel stacks (`/proc/PID/task/*/stack`), `wchan`, `syscall`, `status`,
  fds — plus a reproduction recipe with a usable hang rate. PR #95 lacked
  exactly this capture.

## H3 — The `@solana/web3.js` 3.1.1 import chain is a required ingredient

**Status: PLAUSIBLE, test prioritized.**

- Rationale: it is the only npm code the failing invocation executes [SRC],
  and PR #95's load generator happened to be web3.js import loops [CI-E].
  The trivial non-web3 control never hung [CI-E].
- Test: baseline matrix with/without the web3.js import in the process
  (checker as-is vs import-stripped *copy* — never the repo file), plus a
  bare `await import("@solana/web3.js")` + `process.exit(0)` loop.
- Minimum confirming evidence: hang-rate difference attributable to the
  import under the same load, or a captured stack naming a web3.js-loaded
  module/thread.

## H4 — `--trace-exit` causally "fixes" the hang

**Status: PLAUSIBLE-BUT-UNVERIFIED; single n=1 VM observation [VM-E].**

- No mechanism is known by which `--trace-exit` (which only prints a stack
  trace when `process.exit` is invoked) would prevent a teardown race; a
  one-off success is fully consistent with intermittency (H2).
- Minimum confirming evidence: VM or sandbox A/B at n≥20 each under the
  same load showing a significant rate difference. Until then H4 must not
  be used in any explanation.

## H5 — The deployment script introduces its own failure

**Status: REJECTED as an independent cause; the script *exposes* the CLI
hang.**

- The stall point [VM-E G] is the checker invocation itself, in the exact
  CLI shape that hangs standalone [VM-E B/C]. The script's constructs at
  that point are ordinary (`if node …; then`, stdout→/dev/null, inherited
  stderr/stdin, `set -euo pipefail`, cwd = repo root). No fd inheritance,
  no subshell plumbing that changes node's teardown. 900 s ≫ 0.5 s runtime.

## H6 — Manifest/tarball content or hashing of the large tarball is causal

**Status: REJECTED for *hang location* (it happens after hashing completes —
verdict lines are printed [VM-E B/C]), UNVERIFIED for *hang probability*.**
The sandbox matrix uses a synthetic tarball of realistic size to check
whether pre-exit memory pressure (e.g., the ~hundreds-of-MB `readFileSync`
buffer + GC) modulates the rate (folds into H2 testing).

## H7 — Environment-level external interference on the VM (Hermes Agent,
        rlimit, cgroup, watchdog, kernel)

**Status: REQUIRES-VM.** Cannot be evaluated from here. V2/V5 follow-up
tests (ROOT_CAUSE_REPORT.md §J) bound this.
