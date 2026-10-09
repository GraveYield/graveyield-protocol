#!/usr/bin/env bash
# Markdown relative-link integrity check for GraveYield.
#
# Fails if any relative link in a committed .markdown/.md file points at a
# path that does not exist. This is the guardrail for the docs/README.md
# canonical-set indexes: the two historical incidents (a docs/-prefixed
# path referenced from inside docs/, and a stale version label) were both
# dead relative links that this check rejects.
#
# Skipped targets: http(s), mailto, pure anchors (#...), and links inside
# fenced code blocks. Fragment suffixes (#section) are stripped before the
# existence check; percent-encoded spaces are decoded.
#
# See CONTRIBUTING.md and docs/README.md. Enforced by CI (doc-links job).
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0
checked=0

while IFS= read -r -d '' md; do
    dir=$(dirname "$md")
    # Strip fenced code blocks so documentation examples are not parsed,
    # then pull the parenthesized targets of markdown links.
    targets=$(sed '/^```/,/^```$/d' "$md" \
        | grep -oE '\]\(([^)]+)\)' \
        | sed -E 's/^\]\(//; s/\)$//' || true)
    if [ -z "$targets" ]; then
        continue
    fi
    while IFS= read -r link; do
        [ -z "$link" ] && continue
        case "$link" in
            http://*|https://*|mailto:*|mailto:*|\#*) continue ;;
        esac
        # Strip fragment, decode %20.
        target="${link%%#*}"
        target=$(printf '%b' "${target//%20/ }")
        [ -z "$target" ] && continue
        case "$target" in
            /*) continue ;;  # repo-root-absolute: not resolvable from a raw clone; flag manually if ever used
        esac
        checked=$((checked + 1))
        if [ ! -e "$dir/$target" ]; then
            fail=1
            echo "BROKEN LINK: $md -> $link (resolved: $dir/$target)"
        fi
    done <<EOF
$targets
EOF
done < <(find . \
    \( -path ./.git -o -path ./node_modules -o -path ./target -o -path ./dist -o -path ./build \) -prune \
    -o \( -name '*.md' -o -name '*.markdown' \) -type f -print0)

echo "checked $checked relative link target(s)"
if [ "$fail" -ne 0 ]; then
    echo "FAILED: broken relative markdown links detected (see above)." >&2
    exit 1
fi
echo "ok: all relative markdown links resolve"
