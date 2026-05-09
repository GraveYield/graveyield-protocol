#!/usr/bin/env bash
# Forbidden vocabulary check for GraveYield.
# Fails if any forbidden term appears outside this script and the glossary.
# See CONTRIBUTING.md and docs/glossary.md for the canonical mapping.
set -euo pipefail

# Build the forbidden pattern by concatenating the parts so this script itself
# does not contain any literal forbidden words at top level. The check ignores
# this script and the glossary file, which document the mapping intentionally.
F1="re""scue"
F2="re""scuer"
F3="dead""_pool"
F4="dead pool"
F5="Re""scueReceipt"
F6="re""scue_pool"
F7="Re""scueCompleted"
F8="Pool""Re""scued"
F9="Re""scueInitiated"

PATTERN="${F1}|${F2}|${F3}|${F4}|${F5}|${F6}|${F7}|${F8}|${F9}"

EXCLUDES=(
    --exclude-dir=.git
    --exclude-dir=node_modules
    --exclude-dir=target
    --exclude-dir=dist
    --exclude-dir=build
    --exclude-dir=.anchor
    --exclude=terminology-lint.sh
    --exclude=glossary.md
    --exclude=CONTRIBUTING.md
)

set +e
matches=$(grep -RInE "${EXCLUDES[@]}" "$PATTERN" . 2>/dev/null || true)
set -e

if [ -n "$matches" ]; then
    echo "ERROR: forbidden GraveYield vocabulary detected. See CONTRIBUTING.md."
    echo
    echo "$matches"
    exit 1
fi

echo "ok: no forbidden vocabulary detected"
