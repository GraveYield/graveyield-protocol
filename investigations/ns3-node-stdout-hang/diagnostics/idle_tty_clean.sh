#!/usr/bin/env bash
# diagnostics/idle_tty_clean.sh — tty cell, per-iteration result log.
set -u
ENV=/home/z/my-project/repro-env
N=${1:-20}
LOG=$ENV/idle-tty-results.txt
: > "$LOG"
ok=0; hang=0; other=0
for i in $(seq 1 "$N"); do
  script -qec "timeout 8 node $ENV/checker/ns3_check_provenance.mjs --manifest $ENV/fixtures/manifest.big.json --platform-tools-tarball $ENV/fixtures/big.tar.bz2" /dev/null > "$ENV/tty-$i.log" 2>&1
  rc=$?
  echo "$i rc=$rc" >> "$LOG"
  case $rc in 0) ok=$((ok+1));; 124|137) hang=$((hang+1));; *) other=$((other+1));; esac
done
echo "IDLE-TTY n=$N ok=$ok hang=$hang other=$other"
cat "$LOG" | awk '{print $2}' | sort | uniq -c
