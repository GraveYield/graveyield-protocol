#!/usr/bin/env bash
# lifecycle_rehearsal.sh — W1 Lifecycle Rehearsal Harness: ONE COMMAND for the
# full local end-to-end pass (16 stages + adversarial battery).
#
#   bash scripts/devnet/lifecycle_rehearsal.sh [--url http://127.0.0.1:8899] [--keep]
#
# Pipeline: keygen → ELF pinning (devnet dumps + mainnet fixtures) → local
# account prep (C6 re-pin, F3 market re-pin, holder ATAs) → snapshotter build
# → validator boot (no_uring wrapper, word-split loader flags — run-1 fix)
# → drive_lifecycle.mjs → run report JSON at target/lifecycle-rehearsal/.
#
# Prerequisites (checked, not installed): agave CLI 3.0.10, rust 1.91.1,
# node ≥ 24, pnpm 9 with BOTH workspaces installed and built
# (graveyield-protocol AND salvor-bots: `pnpm install && pnpm -r build`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/share/solana/bin:$HOME/.cargo/bin:$PATH"

URL="http://127.0.0.1:8899"
KEEP=0
SALVOR_BOTS="${SALVOR_BOTS:-$REPO_ROOT/../salvor-bots}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --salvor-bots) SALVOR_BOTS="$2"; shift 2 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done

ARTIFACTS="$REPO_ROOT/target/lifecycle-rehearsal"
FIXTURES="$ARTIFACTS/fixtures"
KEYS="$ARTIFACTS/keys"
HR_DIR="scripts/devnet/lifecycle_rehearsal"
mkdir -p "$ARTIFACTS" "$FIXTURES" "$KEYS"

echo "== [0/7] toolchain sanity =="
for t in solana-test-validator solana-keygen node pnpm cargo gcc; do
  command -v "$t" >/dev/null || { echo "MISSING tool: $t"; exit 2; }
done
[[ -d "$SALVOR_BOTS/fleet-core" ]] || { echo "salvor-bots checkout not found at $SALVOR_BOTS (pass --salvor-bots or set SALVOR_BOTS)"; exit 2; }
[[ -f "$SALVOR_BOTS/fleet-core/dist/index.js" ]] || { echo "salvor-bots not built: pnpm install && pnpm -r build in $SALVOR_BOTS"; exit 2; }
[[ -f "$REPO_ROOT/sdk/dist/index.js" ]] || { echo "protocol sdk not built: pnpm install && pnpm -r build in $REPO_ROOT"; exit 2; }
echo "toolchain OK (salvor-bots: $SALVOR_BOTS)"

echo "== [1/7] keygen (fresh local keys; devnet payer custody NOT involved) =="
for k in authority intruder activity_oracle launch_oracle salvor claimant_a claimant_b; do
  [[ -f "$KEYS/$k.json" ]] || solana-keygen new --no-bip39-passphrase --silent -o "$KEYS/$k.json"
done
echo "keys at $KEYS"

echo "== [2/7] ELF pinning (devnet program dumps + real mainnet fixtures) =="
node "$HR_DIR/pin_elfs.mjs" --artifacts "$ARTIFACTS" --fixtures "$FIXTURES" --rpc "https://api.devnet.solana.com"

echo "== [3/7] local account prep (C6 supply re-pin, F3 market re-pin, holder ATAs) =="
node "$HR_DIR/prepare_local_accounts.mjs" --artifacts "$ARTIFACTS" --fixtures "$FIXTURES" --keys "$KEYS" --salvorBots "$SALVOR_BOTS"

echo "== [4/7] snapshotter build (real Rust bin) =="
(cd snapshotter && cargo build --quiet --bin grave-snapshotter-cli)
[[ -f "$REPO_ROOT/target/debug/grave-snapshotter-cli" ]] || { echo "snapshotter bin missing after build"; exit 2; }
echo "target/debug/grave-snapshotter-cli ready"

echo "== [5/7] validator boot (no_uring seccomp wrapper; word-split loader flags) =="
if [[ ! -x scripts/no_uring ]]; then
  gcc -O2 -o scripts/no_uring scripts/no_uring.c
  echo "compiled scripts/no_uring"
fi
# Run-1 fix: the validator rejects FUSED --account arguments — every flag line
# must be word-split into separate argv entries.
VAL_ARGS=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  read -ra PARTS <<< "$line"
  VAL_ARGS+=("${PARTS[@]}")
done < "$ARTIFACTS/loader_account_flags.txt"
echo "validator flags: ${#VAL_ARGS[@]} argv entries"

VAL_LOG="$ARTIFACTS/validator.log"
PIDS=()
cleanup() {
  if [[ "$KEEP" == "1" ]]; then echo "keeping validator(s) running: ${PIDS[*]:-none}"; return; fi
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

scripts/no_uring solana-test-validator \
  --reset --quiet --warp-slot 1 --slots-per-epoch 32 \
  --url "$URL" \
  "${VAL_ARGS[@]}" >"$VAL_LOG" 2>&1 &
PIDS+=($!)

for i in $(seq 1 90); do
  if solana --url "$URL" cluster-version >/dev/null 2>&1; then break; fi
  if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then echo "validator died — tail of $VAL_LOG:"; tail -20 "$VAL_LOG"; exit 1; fi
  sleep 1
done
solana --url "$URL" cluster-version >/dev/null || { echo "validator did not come up"; tail -20 "$VAL_LOG"; exit 1; }
echo "validator up at $URL"

echo "== [6/7] funding (local airdrops — local keys only) =="
for k in authority intruder salvor claimant_a claimant_b; do
  solana --url "$URL" airdrop 50 "$KEYS/$k.json" >/dev/null 2>&1 || \
    solana --url "$URL" airdrop 10 "$KEYS/$k.json" >/dev/null
done
echo "funded"

echo "== [7/7] lifecycle driver (16 stages + adversarial battery) =="
DRIVER_EXIT=0
node "$HR_DIR/drive_lifecycle.mjs" \
  --url "$URL" \
  --artifacts "$ARTIFACTS" \
  --fixtures "$FIXTURES" \
  --keys "$KEYS" \
  --salvorBots "$SALVOR_BOTS" || DRIVER_EXIT=$?

REPORT=$(ls -t "$ARTIFACTS"/run-report-*.json 2>/dev/null | head -1 || true)
echo
echo "run report: $REPORT"
if [[ "$DRIVER_EXIT" == "0" ]]; then
  echo "LIFECYCLE REHEARSAL COMPLETE — 16 stages + adversarial battery all green"
else
  echo "LIFECYCLE REHEARSAL FAILED — inspect the report above"
fi
exit "$DRIVER_EXIT"
