#!/usr/bin/env bash
# classify_fork_changes.sh — fail-closed PR path classification for the
# fork-harness workflow (P5-04 closeout correction, 2026-11-02).
#
# Replaces the inline filter whose decision step was
#     CHANGED="$(git diff --name-only "$BASE...HEAD" || true)"
# The `|| true` made the gate FAIL-OPEN: a failed diff produced empty
# output, which the old logic read as "no fork-relevant changes" and used
# to skip all seven fork suites on a code PR.
#
# Usage: classify_fork_changes.sh <event_name> <base_sha> <head_sha>
# Prints exactly one word on stdout: "run" or "skip". ALWAYS exits 0 —
# every unexpected or unrecoverable condition classifies as "run", so the
# heavy fork job executes (fail-closed). The workflow additionally treats
# any non-"skip" classification (including a missing one) as "run"; see
# .github/workflows/fork-harness.yml.
#
# Policy: the path set below is UNCHANGED from the Stage B inline filter,
# except that this classifier script itself is now part of the gate, so
# edits to it also trigger a fork run.
set -uo pipefail
# Deliberately NOT `set -e`: every failure mode is handled explicitly and
# must classify as "run" instead of aborting the classification.

event="${1:-}"
base="${2:-}"
head="${3:-}"

readonly FORK_PATH_REGEX='(^programs/|^snapshotter/|^sdk/|(^|/)Cargo\.(toml|lock)$|^rust-toolchain\.toml$|^Anchor\.toml$|^scripts/build_fork_harness\.sh$|^scripts/fetch_v4_fork_fixtures\.mjs$|^scripts/classify_fork_changes\.sh$|^\.github/workflows/fork-harness\.yml$)'

run()  { echo "run";  exit 0; }
skip() { echo "skip"; exit 0; }

# Nightly cron and manual dispatch bypass PR classification entirely and
# always run the full harness (unchanged Stage B behavior).
if [[ "$event" != "pull_request" ]]; then
  run
fi

# Missing shas cannot be classified -> run.
if [[ -z "$base" || -z "$head" ]]; then
  run
fi

# A base or head that does not resolve to a commit cannot be classified
# (covers a missing base reference after force-push/rewrite) -> run.
if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  run
fi
if ! git cat-file -e "${head}^{commit}" 2>/dev/null; then
  run
fi

# A failed diff classifies as run. This is the exact defect the closeout
# audit flagged: no "|| true", no swallowed status — the exit code is
# checked and a failure fails CLOSED.
changed="$(git diff --name-only "${base}...${head}" 2>/dev/null)"
diff_status=$?
if [[ $diff_status -ne 0 ]]; then
  run
fi

# An empty but successful diff cannot be classified reliably -> run.
if [[ -z "$changed" ]]; then
  run
fi

if printf '%s\n' "$changed" | grep -qE "$FORK_PATH_REGEX"; then
  run
fi

skip
