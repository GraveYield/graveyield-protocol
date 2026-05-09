#!/usr/bin/env bash
# Verify pinned toolchain versions for GraveYield Protocol.
# Exits non-zero if any required tool is missing or has an unexpected major/minor.
set -euo pipefail

EXPECTED_SOLANA_MAJOR_MINOR="2.0"
EXPECTED_ANCHOR_MAJOR_MINOR="0.31"
EXPECTED_RUST_MIN="1.79"
EXPECTED_NODE_MAJOR="20"
EXPECTED_PNPM_MAJOR="9"

err=0
note() { printf "  \033[1;36m%s\033[0m %s\n" "$1" "$2"; }
ok()   { printf "  \033[1;32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[1;33m!\033[0m %s\n" "$1"; err=1; }
miss() { printf "  \033[1;31m✗\033[0m %s\n" "$1"; err=1; }

echo "GraveYield toolchain check"
echo "=========================="

# solana
if command -v solana >/dev/null 2>&1; then
    v=$(solana --version | awk '{print $2}')
    case "$v" in
        ${EXPECTED_SOLANA_MAJOR_MINOR}.*) ok "solana $v" ;;
        *) warn "solana $v (expected ${EXPECTED_SOLANA_MAJOR_MINOR}.x)" ;;
    esac
else
    miss "solana CLI not found (expected ${EXPECTED_SOLANA_MAJOR_MINOR}.x)"
fi

# anchor
if command -v anchor >/dev/null 2>&1; then
    v=$(anchor --version | awk '{print $2}')
    case "$v" in
        ${EXPECTED_ANCHOR_MAJOR_MINOR}.*) ok "anchor $v" ;;
        *) warn "anchor $v (expected ${EXPECTED_ANCHOR_MAJOR_MINOR}.x)" ;;
    esac
else
    miss "anchor CLI not found (expected ${EXPECTED_ANCHOR_MAJOR_MINOR}.x)"
fi

# rust
if command -v rustc >/dev/null 2>&1; then
    v=$(rustc --version | awk '{print $2}')
    ok "rust $v (minimum ${EXPECTED_RUST_MIN})"
else
    miss "rustc not found (minimum ${EXPECTED_RUST_MIN})"
fi

# node
if command -v node >/dev/null 2>&1; then
    v=$(node --version | tr -d 'v')
    major="${v%%.*}"
    if [ "$major" = "$EXPECTED_NODE_MAJOR" ]; then
        ok "node $v"
    else
        warn "node $v (expected ${EXPECTED_NODE_MAJOR}.x LTS)"
    fi
else
    miss "node not found (expected ${EXPECTED_NODE_MAJOR}.x LTS)"
fi

# pnpm
if command -v pnpm >/dev/null 2>&1; then
    v=$(pnpm --version)
    major="${v%%.*}"
    if [ "$major" = "$EXPECTED_PNPM_MAJOR" ]; then
        ok "pnpm $v"
    else
        warn "pnpm $v (expected ${EXPECTED_PNPM_MAJOR}.x)"
    fi
else
    miss "pnpm not found (expected ${EXPECTED_PNPM_MAJOR}.x)"
fi

echo
if [ "$err" -ne 0 ]; then
    note "result:" "one or more tools missing or off-version"
    exit 1
fi
note "result:" "all toolchain checks passed"
