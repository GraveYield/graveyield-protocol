#!/usr/bin/env bash
# secret_scan_diff.sh — scan every pending file (tracked diff + untracked)
# in a repo for token/key/seed material. Exit 1 on any HARD hit.
# Public program IDs / sysvar addresses (base58 advisory pattern) are listed
# for manual review but do not fail the scan.
set -euo pipefail
REPO="$1"
cd "$REPO"
FILES=$( { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u )
hits=0
advisory=0
scan_one() { # $1=file $2=kind(hard|advisory) $3=pattern
  local f="$1" kind="$2" p="$3"
  [[ -f "$f" ]] || return 0
  if grep -InE "$p" "$f" > /tmp/scan_hits.txt 2>/dev/null; then
    echo "== $f ($kind: $p) =="
    head -4 /tmp/scan_hits.txt
    if [[ "$kind" == "hard" ]]; then hits=$((hits+1)); else advisory=$((advisory+1)); fi
  fi
}
for f in $FILES; do
  scan_one "$f" hard   'github_pat_[A-Za-z0-9_]+'
  scan_one "$f" hard   'ghp_[A-Za-z0-9]{20,}'
  scan_one "$f" hard   'gho_[A-Za-z0-9]{20,}'
  scan_one "$f" hard   'github_pat_'
  scan_one "$f" hard   'xox[bap]-[A-Za-z0-9-]{10,}'
  scan_one "$f" hard   'sk-[A-Za-z0-9]{20,}'
  scan_one "$f" hard   'AKIA[0-9A-Z]{16}'
  scan_one "$f" hard   '\[[0-9]{2,3},\s*[0-9]{2,3},\s*[0-9]{2,3}'        # keypair JSON arrays
  scan_one "$f" hard   '"seed_base58"|secretKey|PRIVATE KEY'             # seed material markers (code refs are fine — manual review)
  scan_one "$f" advisory '[1-9A-HJ-NP-Za-km-z]{32,44}'                   # base58 blobs: public IDs live here too
done
echo "SECRET SCAN: hard-hits=$hits advisory-files=$advisory"
if [[ "$hits" -gt 0 ]]; then echo "SECRET SCAN: ABORT"; exit 1; fi
echo "SECRET SCAN: PASS (verify any listed base58 lines are public addresses)"
