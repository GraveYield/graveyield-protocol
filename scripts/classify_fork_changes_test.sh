#!/usr/bin/env bash
# classify_fork_changes_test.sh — fixture tests for the fail-closed
# fork-path classifier (P5-04 closeout correction, 2026-11-02).
#
# Builds a throwaway git repository and exercises the REAL
# scripts/classify_fork_changes.sh against controlled diffs, including
# the failure modes the old inline filter got wrong. Run from anywhere:
#
#     bash scripts/classify_fork_changes_test.sh
#
# Exits non-zero if any scenario fails. git + bash only — no new deps.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/classify_fork_changes.sh"
if [[ ! -f "$SCRIPT" ]]; then
  echo "FATAL: classifier not found at $SCRIPT" >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

git init -q -b main .
git config user.email "ci-test@example.invalid"
git config user.name "classifier-fixture"
mkdir -p docs programs/grave-scanner/src programs/grave-vault/tests scripts .github/workflows snapshotter/src
echo base > docs/a.md
echo base > programs/grave-scanner/src/lib.rs
echo base > Cargo.toml
git add -A
git commit -qm base
BASE="$(git rev-parse HEAD)"

pass=0
fail=0

check() { # <name> <expected> <event> <base> <head>
  local name="$1" expected="$2" event="$3" b="$4" h="$5" got
  got="$(bash "$SCRIPT" "$event" "$b" "$h" 2>/dev/null)"
  if [[ "$got" == "$expected" ]]; then
    echo "PASS  $name  (event=$event -> $got)"
    pass=$((pass + 1))
  else
    echo "FAIL  $name  expected '$expected', got '${got:-<empty>}'  (event=$event)"
    fail=$((fail + 1))
  fi
}

pr_commit() { # <file> <content> — commit a one-file change on branch pr
  # git prunes directories that become empty on checkout -B, so every
  # scenario must (re-)create its parent dir before writing the file.
  git checkout -q -B pr main
  mkdir -p "$(dirname "$1")"
  echo "$2" > "$1"
  git add -A
  git commit -qm "change $1"
  git rev-parse HEAD
}

# --- Scenario 1: documentation-only PR is classified skip -----------------
H=$(pr_commit docs/note.md "docs")
check "1. docs-only PR is skipped" skip pull_request "$BASE" "$H"

# --- Scenario 2: fork-relevant source change runs --------------------------
H=$(pr_commit programs/grave-scanner/src/lib.rs "src")
check "2a. program source change runs" run pull_request "$BASE" "$H"
H=$(pr_commit snapshotter/src/lib.rs "snap")
check "2b. snapshotter change runs" run pull_request "$BASE" "$H"
H=$(pr_commit sdk/src/lib.rs "sdk")
check "2c. sdk change runs" run pull_request "$BASE" "$H"

# --- Scenario 3: test-suite / harness change runs --------------------------
H=$(pr_commit programs/grave-vault/tests/new_fork.rs "test")
check "3a. fork test-suite change runs" run pull_request "$BASE" "$H"
H=$(pr_commit scripts/build_fork_harness.sh "harness")
check "3b. harness script change runs" run pull_request "$BASE" "$H"
H=$(pr_commit scripts/classify_fork_changes.sh "classifier")
check "3c. classifier script change runs" run pull_request "$BASE" "$H"
H=$(pr_commit scripts/fetch_v4_fork_fixtures.mjs "fixtures")
check "3d. fixture fetcher change runs" run pull_request "$BASE" "$H"
H=$(pr_commit .github/workflows/fork-harness.yml "wf")
check "3e. workflow change runs" run pull_request "$BASE" "$H"

# --- Scenario 4: dependency / manifest change runs -------------------------
H=$(pr_commit Cargo.toml "manifest")
check "4a. workspace manifest change runs" run pull_request "$BASE" "$H"
H=$(pr_commit Cargo.lock "lock")
check "4b. lockfile change runs" run pull_request "$BASE" "$H"
H=$(pr_commit rust-toolchain.toml "toolchain")
check "4c. toolchain pin change runs" run pull_request "$BASE" "$H"
H=$(pr_commit Anchor.toml "anchor")
check "4d. Anchor.toml change runs" run pull_request "$BASE" "$H"

# --- Scenario 5: failed diff command fails closed --------------------------
# Orphan branch: no merge base with main, so the three-dot diff fails.
git checkout -q --orphan orphan
echo orphan > orphan.txt
git add -A
git commit -qm orphan
ORPHAN="$(git rev-parse HEAD)"
check "5. failed diff (no merge base) fails closed" run pull_request "$BASE" "$ORPHAN"

# --- Scenario 6: missing base / head reference fails closed ----------------
check "6a. missing base sha fails closed" run pull_request "0000000000000000000000000000000000000000" "$ORPHAN"
check "6b. missing head sha fails closed" run pull_request "$BASE" "0000000000000000000000000000000000000000"
check "6c. empty base argument fails closed" run pull_request "" "$ORPHAN"

# --- Empty-but-successful diff cannot be classified -> run -----------------
check "6d. empty diff (base == head) fails closed" run pull_request "$BASE" "$BASE"

# --- Scenario 7: scheduled execution bypasses PR classification ------------
check "7. scheduled run bypasses classification" run schedule "$BASE" "$ORPHAN"

# --- Scenario 8: manual execution bypasses PR classification ---------------
check "8. manual dispatch bypasses classification" run workflow_dispatch "$BASE" "$ORPHAN"

echo
echo "classifier fixture tests: $pass passed, $fail failed"
if [[ $fail -ne 0 ]]; then
  exit 1
fi
