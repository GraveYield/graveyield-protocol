#!/usr/bin/env bash
# diagnostics/matrix_sequential.sh — Phase 2 baseline matrix (sequential).
# Measures exit-code distribution of the checker CLI per stdout mode and
# --trace-exit variant, under NO artificial load. All runs bounded by timeout.
# Usage: matrix_sequential.sh <N_per_cell> <tiny|big>
set -u
ENV=/home/z/my-project/repro-env
N=${1:-20}
SIZE=${2:-tiny}
NODE_BIN=$(command -v node)
echo "node $($NODE_BIN --version), mode=$SIZE, n=$N per cell, $(date -u +%FT%TZ)"

run_one() { # $1=stdout-mode $2=extra-flags $3=logfile
  local mode=$1 flags=$2 log=$3 rc
  case $mode in
    tty)     script -qec "timeout 10 node $flags $ENV/checker/ns3_check_provenance.mjs --manifest $ENV/fixtures/manifest.$SIZE.json --platform-tools-tarball $ENV/fixtures/$SIZE.tar.bz2" /dev/null > "$log" 2>&1 ;;
    devnull) timeout 10 node $flags $ENV/checker/ns3_check_provenance.mjs --manifest $ENV/fixtures/manifest.$SIZE.json --platform-tools-tarball $ENV/fixtures/$SIZE.tar.bz2 > /dev/null 2> "$log" ;;
    file)    timeout 10 node $flags $ENV/checker/ns3_check_provenance.mjs --manifest $ENV/fixtures/manifest.$SIZE.json --platform-tools-tarball $ENV/fixtures/$SIZE.tar.bz2 > "$ENV/out-$SIZE.log" 2> "$log" ;;
  esac
  rc=$?
  echo "$rc" >> "$ENV/results-$SIZE-$mode${flags:+-trace}.txt"
  if [[ $rc -ne 0 ]]; then
    cp "$ENV/out-$SIZE.log" "$ENV/hang-artifact-$SIZE-$mode-${flags:+trace}-$(date +%s%N).log" 2>/dev/null || true
  fi
}

for mode in tty devnull file; do
  rm -f "$ENV/results-$SIZE-$mode.txt"
  for i in $(seq 1 "$N"); do run_one "$mode" "" "$ENV/err.log"; done
  echo "mode=$mode plain     : $(sort "$ENV/results-$SIZE-$mode.txt" | uniq -c | tr '\n' ' ')"
done
for mode in devnull file; do
  rm -f "$ENV/results-$SIZE-$mode-trace.txt"
  for i in $(seq 1 "$N"); do run_one "$mode" "--trace-exit" "$ENV/err.log"; done
  echo "mode=$mode trace-exit: $(sort "$ENV/results-$SIZE-$mode-trace.txt" | uniq -c | tr '\n' ' ')"
done
echo "done $(date -u +%FT%TZ)"
