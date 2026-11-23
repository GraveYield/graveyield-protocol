#!/usr/bin/env bash
# diagnostics/idle_matrix.sh — clean idle factorial: stdout mode × big tarball,
# NO artificial load. Exact VM invocation shape (single sequential runs).
# Usage: idle_matrix.sh <devnull|file|tty> <N>
set -u
ENV=/home/z/my-project/repro-env
MODE=$1; N=${2:-40}
ok=0; hang=0; other=0
for i in $(seq 1 "$N"); do
  case $MODE in
    tty)     script -qec "timeout 10 node $ENV/checker/ns3_check_provenance.mjs --manifest $ENV/fixtures/manifest.big.json --platform-tools-tarball $ENV/fixtures/big.tar.bz2" /dev/null > "$ENV/out.idle.log" 2>&1 ;;
    devnull) timeout 10 node $ENV/checker/ns3_check_provenance.mjs --manifest $ENV/fixtures/manifest.big.json --platform-tools-tarball $ENV/fixtures/big.tar.bz2 > /dev/null 2> "$ENV/err.idle.log" ;;
    file)    timeout 10 node $ENV/checker/ns3_check_provenance.mjs --manifest $ENV/fixtures/manifest.big.json --platform-tools-tarball $ENV/fixtures/big.tar.bz2 > "$ENV/out.idle.log" 2> "$ENV/err.idle.log" ;;
  esac
  rc=$?
  case $rc in
    0) ok=$((ok+1)) ;;
    124|137) hang=$((hang+1)); ts=$(date +%s%N); cp "$ENV/out.idle.log" "$ENV/hang-idle-$MODE-$ts.log" 2>/dev/null; cp "$ENV/err.idle.log" "$ENV/hang-idle-$MODE-$ts.err" 2>/dev/null ;;
    *) other=$((other+1)); echo "iter $i rc=$rc" ;;
  esac
done
echo "IDLE mode=$MODE n=$N: ok=$ok hang=$hang other=$other $(date -u +%FT%TZ)"
