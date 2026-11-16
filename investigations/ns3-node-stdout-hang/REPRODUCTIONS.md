# Reproductions — commands, rates, captured state

**Sandbox:** Node **v24.22.2** (byte-identical to the VM), Linux 5.10 x86_64,
2 vCPU / 4 GB. Checker copies are byte-identical to the repo files (sha256
`c47d7bad…` / `48b79982…` recorded in `setup_fixtures.sh` output). The
repository tree itself was never modified and never npm-installed into; the
dependency (`@solana/web3.js@3.1.1` + optional peers, mirroring the pnpm
lockfile) lives in an out-of-repo scratch dir and resolves via normal parent
directory traversal.

**Fixtures (synthetic — no real pins touched):** `fixtures/tiny.tar.bz2`
(4 KB) and `fixtures/big.tar.bz2` (256 MB of random bytes — approximating the
real platform-tools archive scale), each with a schema-valid synthetic
manifest pinning its own digest.

**Hang definition:** process alive ≥1.5 s after its verdict appeared (under
load) or alive ≥3 s after start / rc=124 under `timeout` (idle). Every
"hang" was confirmed to follow the **complete success output**.

## R1 — Baseline matrix, sequential, tiny tarball (`matrix_sequential.sh`)

| stdout | n | hangs |
| --- | --- | --- |
| TTY (PTY via `script`) | 20 | 0 |
| /dev/null | 20 | 0 |
| regular file | 20 | 0 |
| /dev/null + `--trace-exit` | 20 | 0 |
| file + `--trace-exit` | 20 | 0 |

Matches PR #95's sequential baseline (0/~430). Tiny-tarball runs do not
reproduce. (100/100 exit 0, ~140 ms each.)

## R2 — Under artificial load, PR #95 recipe
(`load_repro.sh`: 6 parallel workers each spawning fresh `node
--input-type=module -e 'await import("@solana/web3.js")'` processes in a
loop — full 59-package module graph re-load per iteration — plus a file
churn process; ~load-1.6 on 2 vCPU)

| Variant | stdout | n | hangs | rate |
| --- | --- | --- | --- | --- |
| checker, tiny | file | 190 | 0 | 0% |
| checker, tiny | /dev/null | 30 | 0 | 0% |
| checker, tiny | pipe (`| cat`) | 60 | 0 | 0% |
| checker, tiny + `--trace-exit` | file | 60 | 0 | 0% |
| trivial control (`node -e "console.log('TRIVIAL-OK');process.exit(0)"`) | file | 60 | 0 | 0% |
| **checker, big (256 MB)** | **file** | **180** | **21** | **11.7%** |
| checker, big | /dev/null | 60 | 0 | 0% |
| checker, big + `--trace-exit` | file | 60 | **0** | **0%** |
| checker, big, web3.js import stripped | file | 120 | 0 | 0% |
| checker, big + `--no-concurrent-marking --no-concurrent-sweeping` | file | 60 | 4 | 6.7% |

## R3 — Idle factorial (NO artificial load — the exact VM invocation shape)
(`idle_matrix.sh`, big tarball, single sequential runs, `timeout 10`)

| stdout | n | hangs | rate |
| --- | --- | --- | --- |
| **/dev/null** (exact VM test B shape) | 80 | **40** | **50.0%** |
| **regular file** (exact VM test C shape) | ≥16 iter completed at kill | **15** | **≈50%+** |
| **TTY** (exact VM test A shape) | 20 | **0** | **0%** |

Every captured idle hang log contains the complete verdict lines — the exact
signature of VM tests B/C and both CI occurrences.

## R4 — Minimal-form bisection (under load, all 0/60)

| Script | web3.js | 256 MB buffer lifetime | hangs |
| --- | --- | --- | --- |
| `min-big.mjs` | no | referenced until exit | 0 |
| `min-big-web3.mjs` | yes | referenced until exit | 0 |
| `min-big-dead.mjs` | yes | dead (out of scope) before exit | 0 |
| `min-big-dead-noweb3.mjs` | no | dead (out of scope) before exit | 0 |

→ None of the two-ingredient minimal forms reproduces. The **full checker**
(manifest parse + verdict printing + web3.js graph + big transient buffer +
explicit `process.exit(0)`) is the smallest reproducer found. The boundary
is graded (timing-sensitive), not a clean predicate.

## R5 — Captured stuck state (the artifact PR #95 could not obtain)

11 hang events captured (10 under load, 1 idle), 22 `/proc` snapshots
(`capture_stuck.sh`), **100% consistent**:

```
Threads: 3   (MainThread, V8Worker, SignalInspector)
RSS ≈ 347 MB  (the 256 MB readFileSync buffer + web3.js heap)

MainThread:      State S  wchan=futex_wait_queue_me
  syscall futex(uaddr, 0x109 = FUTEX_WAIT_BITSET|PRIVATE|CLOCK_REALTIME,
                val=<V8Worker TID>)          ← join/semaphore wait ON V8Worker
V8Worker:        State S  wchan=futex_wait_queue_me
  syscall futex(uaddr2, 0x189, val=0)      ← asleep, NEVER WOKEN
SignalInspector: State S  wchan=futex_wait_queue_me (normal idle park)
```

**In 20/20 snapshots the main thread's futex wait value equals the
V8Worker thread's TID exactly** (e.g. capture-idle.txt: val 28791 = tid
28791). t1 vs t2 snapshots (1 s apart) are identical → the deadlock is
permanent (CI hang persisted 5 h 56 m [CI-E]). All verdict lines are
present in every hang log → the deadlock begins after `process.exit(0)` is
initiated.

`--trace-exit` output format (Node 24.22.2), captured on a healthy run:
```
(node:2432) WARNING: Exited the environment with code 0
    at exit (node:internal/process/per_thread:241:13)
    at main (file:///…/ns3_check_provenance.mjs:327:13)
```
→ `--trace-exit` wraps `process.exit` and **synchronously writes to stderr
BEFORE the real exit sequence starts** — pure instrumentation + timing
perturbation; semantics unchanged.

## R6 — Interpretation

- The hang is a **Node.js v24.22.2 process-teardown deadlock**: during
  `process.exit(0)` the runtime blocks joining the V8 platform worker
  thread, which remains parked on a futex it is never woken from.
- Required context factors (measured): a **large transient external-memory
  allocation** (256 MB `readFileSync` of the tarball — tiny tarball never
  hangs), the **web3.js module-graph heap** (0/120 without the import vs
  21/180 with, same conditions), and **stdout/timing conditions** (idle +
  file//dev/null ≈ 50%; TTY 0%; `--trace-exit` 0%). Concurrent-GC flags did
  NOT protect (4/60), so the worker is not doing concurrent mark/sweep.
- The checker's own logic is synchronous, correct, and completes before the
  deadlock; stdout redirection is correlated with, but not the mechanism
  of, the failure.
