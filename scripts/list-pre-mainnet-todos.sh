#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# List every `PRE-MAINNET-TODO(<SCOPE>)` marker in the repo grouped by
# scope. Cross-check this output against `docs/PRE_MAINNET_CHECKLIST.md`
# during audit handoff.
#
# Usage:
#   ./scripts/list-pre-mainnet-todos.sh
#   ./scripts/list-pre-mainnet-todos.sh --check    # exit 1 if any markers remain
#
# CI uses --check after a `grep` to ensure that any `PRE-MAINNET-TODO`
# added in a PR is matched by an entry in PRE_MAINNET_CHECKLIST.md
# (cross-check enforcement lands in a follow-up PR).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECK_MODE=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=1
fi

# Search paths. Add new top-level Rust source dirs as the protocol grows.
PATHS=(
  programs
  adapters
  sdk
  indexer
)

# Filter scopes (alphabetical for stable output).
SCOPES=(CPI IDL KEYS LOCKER ORACLE RENT)

# Use ripgrep if available, otherwise grep -rn.
if command -v rg >/dev/null 2>&1; then
  GREP_CMD=(rg --no-heading --line-number -e)
else
  GREP_CMD=(grep -rn -E)
fi

total=0
declare -A by_scope=()

# Collect all markers.
for scope in "${SCOPES[@]}"; do
  pattern="PRE-MAINNET-TODO\($scope\)"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    by_scope[$scope]+="$line"$'\n'
    total=$((total + 1))
  done < <("${GREP_CMD[@]}" "$pattern" "${PATHS[@]}" 2>/dev/null || true)
done

# Pretty-print grouped by scope.
if [[ $total -eq 0 ]]; then
  echo "No PRE-MAINNET-TODO markers found."
  exit 0
fi

echo "PRE-MAINNET-TODO inventory ($total total)"
echo "============================================"
for scope in "${SCOPES[@]}"; do
  if [[ -n "${by_scope[$scope]:-}" ]]; then
    count=$(printf '%s' "${by_scope[$scope]}" | grep -c . || true)
    echo
    echo "[$scope] ($count)"
    echo "${by_scope[$scope]}" | sed -e 's/^/  /'
  fi
done
echo
echo "Cross-check live rows against docs/PRE_MAINNET_CHECKLIST.md."

# In --check mode, exit non-zero so CI can fail until all markers are
# retired. This is a release-time gate, not a per-PR gate.
if [[ $CHECK_MODE -eq 1 && $total -gt 0 ]]; then
  echo
  echo "ERROR: --check mode and $total marker(s) remaining. Retire before mainnet release."
  exit 1
fi
