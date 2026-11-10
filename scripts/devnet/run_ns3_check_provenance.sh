#!/usr/bin/env bash
# run_ns3_check_provenance.sh — bounded, fail-closed shell execution wrapper
# for scripts/devnet/ns3_check_provenance.mjs (the NS-3 deployment
# provenance gate).
#
# WHY THIS EXISTS (PR #95 RCA; investigation PR #98 — root cause confirmed):
#   On Node.js v24.22.2 the checker can deadlock in runtime teardown AFTER
#   it has printed its complete verdict: the main thread waits forever on
#   the V8 platform worker thread in futex_wait, which is never signalled
#   during exit. The hang is intermittent (measured up to ~50% of runs with
#   redirected stdout on an idle machine), happens strictly AFTER
#   "PROVENANCE OK" / "PROVENANCE FAILED" / "REFUSED" is printed, and never
#   invalidates a recorded verdict. It is a process-exit reliability defect,
#   NOT a provenance-integrity failure. CI has bounded the same checker
#   since PR #95 (timeout --kill-after=10s 300 + verdict re-check); this
#   wrapper gives the deployment and rehearsal shells the same protection
#   with an explicit termination grace period, captured logs, and cleanup
#   that also runs on interruption.
#
# CONTRACT
#   run_ns3_check_provenance.sh [--timeout SEC] [--kill-grace SEC] \
#     -- <checker command and arguments...>
#
#   --timeout SEC     Max seconds the checker may run before bounded
#                     termination starts (default 300 — the same bound the
#                     CI gate has used since PR #95).
#   --kill-grace SEC  Seconds between SIGTERM and SIGKILL escalation
#                     (default 10 — the same grace CI uses via
#                     --kill-after=10s). A checker that exits on SIGTERM
#                     needs less; one that ignores SIGTERM is SIGKILLed
#                     when the grace expires, so termination is ALWAYS
#                     bounded.
#   --                Everything after it is executed DIRECTLY (argv array,
#                     no shell re-parse), typically:
#                     run_ns3_check_provenance.sh -- \
#                       node scripts/devnet/ns3_check_provenance.mjs \
#                         --manifest ... [--platform-tools-tarball ...]
#
# SUCCESS/FAILURE DECISION (fail closed; extends the reviewed CI rule to
# every deployment/rehearsal path):
#   The verdict text is authoritative: the checker prints it only after ALL
#   verification work has completed, and the known hang begins only after
#   that point.
#   1. Explicit failure reported (stdout lines matching '^FAIL \[', or
#      '^PROVENANCE FAILED' on either stream)            -> exit 1
#      (checked FIRST — failure markers beat any success verdict).
#   2. Complete success verdict ('^PROVENANCE OK' at the start of a stdout
#      line) NOT recorded:
#        - bounded termination fired (timeout)           -> exit 124
#        - checker exited any other way                  -> exit 1
#   3. Verdict recorded AND no failure markers:
#        - checker exited 0                              -> exit 0
#        - bounded termination fired (the teardown hang
#          is contained; the recorded verdict stands)    -> exit 0
#        - any other exit status (anomalous kill, 126,
#          127, ...)                                     -> exit 1
#   4. Wrapper-internal errors (invalid arguments, non-executable command,
#      temp-dir creation failure)                        -> exit 2, nothing run.
#
#   "Bounded termination" = the watchdog reached its --timeout deadline,
#   SIGTERM'd the checker's process group, waited --kill-grace seconds, and
#   SIGKILLed anything still alive. The checker under it exits 124, or
#   143/137 if the SIGTERM/SIGKILL lands on it; all three statuses with a
#   recorded verdict map to exit 0 (mirrors CI's "verdict stands" rule).
#   A timeout WITHOUT the verdict is exit 124 (GNU timeout convention) and
#   always fails the caller.
#
# OUTPUT
#   The checker's captured stdout/stderr are re-printed on the wrapper's
#   stdout/stderr after the run (success or failure), so the deployment
#   transcript always carries the PASS/FAIL evidence. On any failure the
#   captured stdout is additionally re-echoed to stderr so callers that
#   redirect only the wrapper's stdout (deploy_devnet.sh's cached-archive
#   re-verification) never lose the evidence either. The wrapper adds one
#   decision banner per line on stderr, prefixed "bounded-provenance-check:".
#
# LOGS
#   Captured in a private mktemp -d directory (mode 0700, TMPDIR-aware,
#   name prefix "ns3-check-"). Removed on EVERY exit path — success,
#   failure, and SIGINT/SIGTERM/SIGHUP interruption alike — because the
#   evidence is already re-printed into the transcript (see OUTPUT).
#   The one case no process can clean up after is a SIGKILL of this
#   wrapper; even then the detached watchdog still terminates the checker
#   at the deadline.
set -uo pipefail

TIMEOUT_SECS=300
KILL_GRACE_SECS=10

banner() { echo "bounded-provenance-check: $*" >&2; }

usage_error() {
  banner "REFUSING: $*"
  banner "usage: run_ns3_check_provenance.sh [--timeout SEC] [--kill-grace SEC] -- <command...>"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)
      [[ $# -ge 2 ]] || usage_error "--timeout requires a value"
      [[ "$2" =~ ^[1-9][0-9]*$ ]] || usage_error "--timeout must be a positive integer (got '$2')"
      TIMEOUT_SECS="$2"; shift 2 ;;
    --kill-grace)
      [[ $# -ge 2 ]] || usage_error "--kill-grace requires a value"
      [[ "$2" =~ ^[1-9][0-9]*$ ]] || usage_error "--kill-grace must be a positive integer (got '$2')"
      KILL_GRACE_SECS="$2"; shift 2 ;;
    --)
      shift; break ;;
    *)
      usage_error "unknown wrapper argument '$1' (wrapper options must precede --)" ;;
  esac
done

CHECKER_CMD=("$@")
if (( ${#CHECKER_CMD[@]} == 0 )); then
  usage_error "no checker command given after --"
fi
if ! command -v "${CHECKER_CMD[0]}" >/dev/null 2>&1; then
  usage_error "checker command is not executable: '${CHECKER_CMD[0]}'"
fi

# Private log directory, removed on EVERY exit path (EXIT trap + interrupt
# handler). Name prefix "ns3-check-" is asserted by the cleanup tests.
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ns3-check-XXXXXXXXXX")" || {
  banner "REFUSING: cannot create the temp log directory — failing closed"
  exit 2
}
chmod 700 "$LOG_DIR"
OUT_LOG="$LOG_DIR/stdout.log"
ERR_LOG="$LOG_DIR/stderr.log"

# (SC2317: shellcheck cannot see that this is invoked via the EXIT trap.)
# shellcheck disable=SC2317
cleanup_logs() { rm -rf -- "$LOG_DIR" 2>/dev/null || true; }
trap cleanup_logs EXIT

# Job control ON: every background job (checker, watchdog) gets its OWN
# process group, so termination reaches the whole child tree — the checker
# today spawns no children, but the wrapper must not depend on that.
set -m

CHECKER_PID=""
WATCHDOG_PID=""

# TERM the checker's process group, wait the FULL grace, then KILL anything
# still alive. Termination is therefore always bounded, even for a checker
# that ignores SIGTERM.
# (SC2317: shellcheck cannot see that this is invoked via the signal traps.)
# shellcheck disable=SC2317
terminate_checker() {
  [[ -n "$CHECKER_PID" ]] || return 0
  kill -TERM -- "-$CHECKER_PID" 2>/dev/null || kill -TERM "$CHECKER_PID" 2>/dev/null || true
  sleep "$KILL_GRACE_SECS"
  if kill -0 "$CHECKER_PID" 2>/dev/null; then
    kill -KILL -- "-$CHECKER_PID" 2>/dev/null || kill -KILL "$CHECKER_PID" 2>/dev/null || true
  fi
}

# Interrupt (SIGINT/SIGTERM/SIGHUP): terminate the checker, reap it, remove
# the temp logs, leave with the conventional 130/143 status. Traps are
# disabled first so a signal burst cannot re-enter the handler.
# (SC2317: shellcheck cannot see that this is invoked via the signal traps.)
# shellcheck disable=SC2317
on_signal() {
  local sig="$1"
  trap '' INT TERM HUP
  terminate_checker
  if [[ -n "$WATCHDOG_PID" ]]; then
    kill -KILL -- "-$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
  fi
  wait "$CHECKER_PID" 2>/dev/null || true
  banner "interrupted by SIG$sig — checker terminated (bounded), temp logs removed"
  cleanup_logs
  trap cleanup_logs EXIT
  if [[ "$sig" == "TERM" ]]; then exit 143; else exit 130; fi
}
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

"${CHECKER_CMD[@]}" >"$OUT_LOG" 2>"$ERR_LOG" &
CHECKER_PID=$!

# The watchdog is the ONLY thing that fires bounded termination in normal
# operation. It is a background subshell in its own process group: it sleeps
# to the deadline, TERMs the checker group, waits the grace, KILLs survivors.
# It MUST be spawned AFTER the checker so its environment snapshot carries
# the real CHECKER_PID (a subshell sees the parent's variables as of its
# fork, not later assignments). If the checker finishes first, the parent
# kills the watchdog before it can fire — the checker is never interrupted
# early.
(
  sleep "$TIMEOUT_SECS"
  kill -TERM -- "-$CHECKER_PID" 2>/dev/null || true
  sleep "$KILL_GRACE_SECS"
  if kill -0 "$CHECKER_PID" 2>/dev/null; then
    kill -KILL -- "-$CHECKER_PID" 2>/dev/null || true
  fi
) &
WATCHDOG_PID=$!

# Single blocking reap — returns the moment the checker exits, so a fast
# run is never delayed by the poll granularity, and SIGINT/SIGTERM break
# out of wait() immediately into on_signal.
checker_rc=0
wait "$CHECKER_PID" 2>/dev/null || checker_rc=$?

# Watchdog still alive after the checker exited -> it never fired; kill it
# before it can. Watchdog gone -> it fired: the checker was terminated by
# bounded teardown after the deadline.
timed_out=0
if [[ -n "$WATCHDOG_PID" ]]; then
  if kill -0 "$WATCHDOG_PID" 2>/dev/null; then
    kill -KILL -- "-$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
  else
    timed_out=1
    wait "$WATCHDOG_PID" 2>/dev/null || true
  fi
  WATCHDOG_PID=""
fi

# Evidence first, decision second: the transcript always carries the
# checker's captured output (success AND failure).
cat "$OUT_LOG"
cat "$ERR_LOG" >&2

if grep -q '^FAIL \[' "$OUT_LOG" \
   || grep -q '^PROVENANCE FAILED' "$OUT_LOG" \
   || grep -q '^PROVENANCE FAILED' "$ERR_LOG"; then
  banner "FAILURE — the checker reported an explicit verification failure; the gate stays CLOSED (exit 1)"
  echo "---- captured checker stdout (failure evidence) ----" >&2
  cat "$OUT_LOG" >&2
  exit 1
fi

if ! grep -q '^PROVENANCE OK' "$OUT_LOG"; then
  if [[ "$timed_out" == 1 || "$checker_rc" == 124 || "$checker_rc" == 143 || "$checker_rc" == 137 ]]; then
    banner "FAILURE — bounded termination fired after ${TIMEOUT_SECS}s but NO success verdict was recorded — failing closed (exit 124)"
    exit 124
  fi
  banner "FAILURE — the complete 'PROVENANCE OK' verdict was NOT recorded (checker rc=$checker_rc) — failing closed (exit 1)"
  echo "---- captured checker stdout (failure evidence) ----" >&2
  cat "$OUT_LOG" >&2
  exit 1
fi

# Verdict recorded and no failure markers — the verification itself is done
# and authoritative.
if [[ "$timed_out" == 1 ]]; then
  banner "checker rc=$checker_rc after bounded teardown termination — 'PROVENANCE OK' verdict was recorded and stands (known Node v24.22.2 teardown hang; PR #95 RCA, PR #98) — exit 0"
  exit 0
fi
if [[ "$checker_rc" == 0 ]]; then
  banner "checker exited 0 with the recorded 'PROVENANCE OK' verdict — exit 0"
  exit 0
fi
if [[ "$checker_rc" == 124 || "$checker_rc" == 143 || "$checker_rc" == 137 ]]; then
  banner "checker rc=$checker_rc after termination, 'PROVENANCE OK' verdict was recorded and stands (CI parity, PR #95) — exit 0"
  exit 0
fi
banner "FAILURE — verdict recorded but the checker exited abnormally (rc=$checker_rc) — failing closed (exit 1)"
exit 1
