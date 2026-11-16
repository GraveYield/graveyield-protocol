# Evidence register

Status tags: **[VM-E]** owner VM evidence · **[CI-E]** CI/PR-recorded evidence ·
**[SRC]** source-code inference · **[REPRO]** sandbox reproduction ·
**[VM-TODO]** needs original VM.

## 1. Owner-supplied VM evidence (assignment §3) — verbatim classification

| # | Test | Command shape | Result | Classification |
| --- | --- | --- | --- | --- |
| A | Interactive standalone run | `timeout 10 node ns3_check_provenance.mjs --manifest … --platform-tools-tarball …` (stdout = TTY) | `PASS [platform-tools]…` + `PROVENANCE OK…`, **CLI_EXIT=0** | [VM-E] |
| B | stdout → /dev/null | same + `>/dev/null` | output file n/a, **CLI_EXIT=124** | [VM-E] |
| C | stdout → regular file | same + `>/tmp/ns3-cli-output.log` | **CLI_EXIT=124**, but the log **contains the complete success output** (both verdict lines) | [VM-E] |
| D | direct module import | import `ns3_verify_elf.mjs`, stdout+stderr redirected | **IMPORT_EXIT=0** | [VM-E] |
| E | direct function call | call `checkProvenance()` directly, redirected | **CHECK_EXIT=0** | [VM-E] |
| F | CLI + `--trace-exit`, stdout redirected | `node --trace-exit … >/dev/null` | **CLI_EXIT=0**, trace shows `process.exit` reached at `main (…/ns3_check_provenance.mjs:327:13)` | [VM-E] |
| G | deployment script | `deploy_devnet.sh --build-only` stalls at the `pin_platform_tools()` gate `if node "$PROVENANCE_CHECKER" … >/dev/null; then` (bash -x trace); 900 s timeout previously hit | [VM-E] |

**Sample-size caveat (recorded deliberately):** tests A–F are n=1 each on the
VM. The apparent determinism ("TTY exits; redirect hangs; --trace-exit fixes")
is a *pattern in four single runs*, not a demonstrated rate. PR #95 [CI-E]
already demonstrated the failure is **intermittent and load-dependent**.

## 2. CI evidence already on record (PR #95, merged 2026-11-09)

Facts established by PR #95 (read from the merged PR body and the current
`.github/workflows/ci.yml` comments — both part of repo history):

- **[CI-E]** Run 42460376811 / job 128668188833 (baseline `01005fe`):
  checker printed all 7 `PASS` lines + `PROVENANCE OK` at 07:54:03.75, then
  **zero log lines for 5 h 56 m**; 360-min job window cancelled the run;
  runner cleanup reported **exactly one orphan process** (the checker node
  process).
- **[CI-E]** Healthy adjacent runs on the *same Node version* (24.22.2)
  completed the same step in ~2 s (verdict → sha256sum gap ≈ 41 ms).
- **[CI-E]** Second independent occurrence on this PR's own first CI run
  (commit `16070b6`, job 128835411543): full success output recorded, then
  hang; the 300 s bound fired (exit 124).
- **[CI-E]** PR #95's local reproduction at the same Node major: **0 hangs /
  ~430 sequential runs** (incl. 200 with pipe stdout) vs **3 hangs / 120 runs
  under concurrent Node load** (6 parallel `@solana/web3.js` import loops +
  file churn). Every captured hang showed the complete success output as its
  last lines; process stayed alive until SIGKILL.
- **[CI-E]** PR #95 could NOT capture the stuck state (no strace; the
  /proc snapshot window closed). Root cause was explicitly left at
  "process-teardown failure of the Node runtime — mechanism unknown".
- **[CI-E]** PR #95's trivial control (`node -e "console.log();process.exit(0)"`)
  did not hang in 200 runs → the bare runtime teardown is not sufficient;
  whatever makes THIS process hang requires more (imports / state / load).

## 3. Source-code facts (Phase 1 analysis) [SRC]

Checked against main @ `b9a1bf4`:

1. `scripts/devnet/ns3_check_provenance.mjs` is **fully synchronous**:
   argument parsing (L281–287), manifest load via `readFileSync`
   (L75–155), artifact/tarball hashing via `readFileSync` + `createHash`
   (L158–160, L237–275), verdict printing (L322–324), success exit
   `process.exit(0)` at **L327**. No `await`, no streams, no timers, no
   children, no workers, no watchers anywhere in the file.
2. In tarball-only mode (the failing invocation) the manifest+tarball path
   never constructs a `PublicKey`; the **only npm code executed is the
   module-load of `@solana/web3.js`** imported at
   `ns3_verify_elf.mjs:53` (chain: checker → ns3_verify_elf.mjs →
   `@solana/web3.js` 3.1.1). All of its work happens at import time.
3. Entry guard L337: `if (process.argv[1] && process.argv[1].endsWith("ns3_check_provenance.mjs")) main();`
   — plain synchronous call; nothing after `main()` returns.
4. Exit codes 0/1/2 are all explicit `process.exit()` calls (L298, L306,
   L320, L327, L333); there is no natural-termination path in CLI mode.
   → A keep-alive event-loop handle **cannot by itself** explain the hang
   while `process.exit(0)` is reached, because `process.exit` terminates
   regardless of live handles. (If exit at L327 is reached, only the
   *exit/teardown path itself* can hang.)
5. `deploy_devnet.sh` `pin_platform_tools()` L196–199: the stall point is
   the checker run **tarball-only with `>/dev/null` inside an `if`
   condition** — the exact shape of VM tests B/C [SRC, consistent with
   VM-E G]. The script runs `set -euo pipefail`, `cd $REPO_ROOT` first;
   the checker inherits the script's stdin/stderr; stdout→/dev/null.
   No fd games, no subshell weirdness beyond the ordinary `if` wait.
6. `local_rehearsal_ns3.sh` L81 runs `ns3_verify_elf.mjs` with inherited
   stdout, no timeout — same exposure class (side finding, unbounded).
7. No `process.on('exit')`, no `setInterval`, no `setTimeout`, no
   `createReadStream`, no `spawn/exec` in any devnet script on the
   checker's import path (grep sweep, Phase 1).

## 4. Immediately implied by 3.4 + PR #95 [SRC + CI-E]

The hang happens **after** `process.exit(0)` at L327 is (or should be)
executing — i.e., in Node's exit/teardown sequence (exit listeners →
runtime teardown → libc `exit()`/atexit + thread teardown) — or the
`--trace-exit` VM result is a sampling accident. Both are testable.

## 5. Sandbox reproduction results (Phase 2/3 — added at investigation close)

Full command records, rates and captures: REPRODUCTIONS.md. Headlines:

- **[REPRO]** The unmodified checker (byte-identical copy, same Node
  v24.22.2) hangs after printing its complete success verdict — at
  **≈50%/run idle** with stdout→/dev/null (40/80) or →file (≥15/~30) and a
  256 MB synthetic tarball; **0%** with TTY stdout (0/20) or
  `--trace-exit` (0/60); 11.7% under load with file stdout (21/180).
- **[REPRO]** 4 KB tarball: 0/470 runs (tiny never hangs) → the large
  transient `readFileSync` buffer is a required ingredient.
- **[REPRO]** web3.js-import-stripped copy: 0/120 under matched conditions
  → the web3.js module-graph load is a strong rate factor.
- **[REPRO]** Minimal two-ingredient scripts (buffer ± web3.js ± dead
  lifetime): 0/240 — the full checker is the smallest reproducer found.
- **[REPRO]** Captured stuck state (11 events / 22 snapshots, 100%
  consistent): MainThread `futex(FUTEX_WAIT_BITSET, val=<V8Worker TID>)`
  join-wait; `V8Worker` parked on `futex(..., val=0)` never woken; 3
  threads; RSS ≈ 347 MB; t1≡t2 permanent. This is the artifact PR #95
  could not obtain.
- **[REPRO]** `--trace-exit` output format captured; instrumentation
  writes stderr pre-exit and collapses the hang rate 21/180 → 0/60 — the
  owner's evidence F is a causal timing effect, now explained.
