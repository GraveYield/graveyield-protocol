#!/usr/bin/env bash
# diagnostics/load_repro.sh — Phase 2/3 key experiment.
# Replicates PR #95's load recipe (6 parallel @solana/web3.js import loops +
# file churn) while running the checker CLI repeatedly, capturing the FULL
# /proc state of any process that fails to terminate after its verdict.
# Usage: load_repro.sh <N_iterations> <checker|trace-exit|trivial>
set -u
ENV=/home/z/my-project/repro-env
N=${1:-40}
VARIANT=${2:-checker}
CAP=$ENV/captures-$VARIANT
mkdir -p "$CAP"; rm -f "$CAP"/capture-* 2>/dev/null
echo "=== load_repro variant=$VARIANT n=$N node=$(node --version) nproc=$(nproc) $(date -u +%FT%TZ) ==="

# ---- background load: 6 parallel @solana/web3.js import loops.
# Each iteration spawns a FRESH node process so the full web3.js module
# graph (59 packages) is re-loaded from disk every time — process, module
# factory, allocator and fd churn combined. Workers run with cwd=repro-env
# so the bare specifier resolves against the out-of-repo node_modules.
pids=()
for w in 1 2 3 4 5 6; do
  ( cd "$ENV" && while :; do node --input-type=module -e 'await import("@solana/web3.js");' >/dev/null 2>&1 || true; done ) &
  pids+=($!)
done
# ---- file churn
node -e '
  const fs = require("fs"), d = "/tmp/ns3-churn-" + process.pid;
  fs.mkdirSync(d, { recursive: true });
  for (let i = 0;; i++) {
    const f = d + "/f" + (i % 64);
    fs.writeFileSync(f, Buffer.alloc(1024, i & 255));
    if (i % 8 === 0) { try { fs.unlinkSync(f); } catch {} }
  }
' >/dev/null 2>&1 &
CHURN=$!
cleanup(){ kill "${pids[@]}" "$CHURN" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT

hangs=0
for i in $(seq 1 "$N"); do
  rm -f "$ENV/out.load.log"
  case $VARIANT in
    checker)
      node "$ENV/checker/ns3_check_provenance.mjs" \
        --manifest "$ENV/fixtures/manifest.tiny.json" \
        --platform-tools-tarball "$ENV/fixtures/tiny.tar.bz2" \
        > "$ENV/out.load.log" 2>>"$ENV/err.load.log" & PID=$! ;;
    trace-exit)
      node --trace-exit "$ENV/checker/ns3_check_provenance.mjs" \
        --manifest "$ENV/fixtures/manifest.tiny.json" \
        --platform-tools-tarball "$ENV/fixtures/tiny.tar.bz2" \
        > "$ENV/out.load.log" 2>>"$ENV/err.load.log" & PID=$! ;;
    trivial)
      node -e "console.log('TRIVIAL-OK'); process.exit(0)" \
        > "$ENV/out.load.log" 2>>"$ENV/err.load.log" & PID=$! ;;
    big)
      node "$ENV/checker/ns3_check_provenance.mjs" \
        --manifest "$ENV/fixtures/manifest.big.json" \
        --platform-tools-tarball "$ENV/fixtures/big.tar.bz2" \
        > "$ENV/out.load.log" 2>>"$ENV/err.load.log" & PID=$! ;;
    pipe)
      node "$ENV/checker/ns3_check_provenance.mjs" \
        --manifest "$ENV/fixtures/manifest.tiny.json" \
        --platform-tools-tarball "$ENV/fixtures/tiny.tar.bz2" \
        2>>"$ENV/err.load.log" | cat > "$ENV/out.load.log" & PID=$! ;;
    noweb3-big)
      node "$ENV/checker-noweb3/ns3_check_provenance.mjs" \
        --manifest "$ENV/fixtures/manifest.big.json" \
        --platform-tools-tarball "$ENV/fixtures/big.tar.bz2" \
        > "$ENV/out.load.log" 2>>"$ENV/err.load.log" & PID=$! ;;
    min-big)
      node "$ENV/min-big.mjs" > "$ENV/out.load.log" 2>>"$ENV/err.load.log" & PID=$! ;;
    min-big-web3)
      node "$ENV/min-big-web3.mjs" > "$ENV/out.load.log" 2>>"$ENV/err.load.log" & PID=$! ;;
    gc-off-big)
      node --no-concurrent-marking --no-concurrent-sweeping \
        "$ENV/checker/ns3_check_provenance.mjs" \
        --manifest "$ENV/fixtures/manifest.big.json" \
        --platform-tools-tarball "$ENV/fixtures/big.tar.bz2" \
        > "$ENV/out.load.log" 2>>"$ENV/err.load.log" & PID=$! ;;
    min-big-dead)
      node "$ENV/min-big-dead.mjs" > "$ENV/out.load.log" 2>>"$ENV/err.load.log" & PID=$! ;;
    min-big-dead-noweb3)
      node "$ENV/min-big-dead-noweb3.mjs" > "$ENV/out.load.log" 2>>"$ENV/err.load.log" & PID=$! ;;
    big-trace)
      node --trace-exit "$ENV/checker/ns3_check_provenance.mjs" \
        --manifest "$ENV/fixtures/manifest.big.json" \
        --platform-tools-tarball "$ENV/fixtures/big.tar.bz2" \
        > "$ENV/out.load.log" 2>>"$ENV/err.load.log" & PID=$! ;;
    big-devnull)
      node "$ENV/checker/ns3_check_provenance.mjs" \
        --manifest "$ENV/fixtures/manifest.big.json" \
        --platform-tools-tarball "$ENV/fixtures/big.tar.bz2" \
        > /dev/null 2>>"$ENV/err.load.log" & PID=$! ;;
  esac
  # In the pipe variant $! is cat's pid; the node process is the one we need.
  if [[ $VARIANT == pipe ]]; then
    sleep 0.05
    PID=$(pgrep -n -f "ns3_check_provenance.mjs --manifest" 2>/dev/null || echo "$PID")
  fi
  # watcher: wait for the verdict line, then check termination after grace
  seen=0
  for t in $(seq 1 1000); do
    grep -q "OK" "$ENV/out.load.log" 2>/dev/null && { seen=1; break; }
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.02
  done
  verdict_at=$(date +%s%N)
  if [[ $seen -eq 1 ]]; then
    hung=0
    for t in $(seq 1 150); do   # 1.5 s grace — healthy exits take <0.6 s
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.01; [[ $t -eq 150 ]] && hung=1
    done
    if [[ $hung -eq 1 ]]; then
      hangs=$((hangs+1))
      ts=$(date +%s%N)
      cp "$ENV/out.load.log" "$CAP/out-hang-$ts.log"
      bash /home/z/my-project/scripts/capture_stuck.sh "$PID" > "$CAP/capture-$ts.txt" 2>&1
      echo "HANG #$hangs at iter $i — captured to capture-$ts.txt"
      sleep 1
      bash /home/z/my-project/scripts/capture_stuck.sh "$PID" > "$CAP/capture-$ts-t2.txt" 2>&1
      kill -9 "$PID" 2>/dev/null
    else
      echo "ok  (iter $i)"
    fi
  else
    # no verdict within 20 s — hang BEFORE verdict (different beast)
    if kill -0 "$PID" 2>/dev/null; then
      hangs=$((hangs+1))
      ts=$(date +%s%N)
      echo "HANG-NOVERDICT #$hangs at iter $i (no verdict after 20 s)"
      bash /home/z/my-project/scripts/capture_stuck.sh "$PID" > "$CAP/capture-noverdict-$ts.txt" 2>&1
      kill -9 "$PID" 2>/dev/null
    else
      echo "no-verdict-dead (iter $i)"
    fi
  fi
  wait "$PID" 2>/dev/null
done
echo "=== RESULT variant=$VARIANT: $hangs hangs / $N runs $(date -u +%FT%TZ) ==="
