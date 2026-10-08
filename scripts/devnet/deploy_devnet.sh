#!/usr/bin/env bash
# deploy_devnet.sh — build and deploy both GraveYield programs to devnet.
#
# Roadmap Phase 11 (Protocol scope): scanner deployed, vault deployed, real
# program IDs. Full runbook: docs/DEVNET.md.
#
# Usage:
#   scripts/devnet/deploy_devnet.sh --url https://api.devnet.solana.com \
#       --scanner-keypair <KP> --vault-keypair <KP> --deployer <KP> [--skip-build]
#
# Safety properties:
#   * The program keypairs determine the on-chain addresses; the ELF's
#     declare_id! (5JiCV… / HUyoG…) must match them. The script refuses to
#     build if target/deploy already holds a DIFFERENT keypair (stale build
#     artifacts would silently deploy under the wrong address).
#   * Keypairs never enter git: they live outside the repo (or in an
#     ignored path) and are seeded into target/ (gitignored) for the build.
#   * The deployer must be funded; deploy cost ≈ rent-exempt storage of the
#     two ELFs. The script checks the balance and prints the shortfall.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

EXPECTED_SCANNER="5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF"
EXPECTED_VAULT="HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6"

URL="https://api.devnet.solana.com"
SCANNER_KP=""
VAULT_KP=""
DEPLOYER_KP=""
SKIP_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --scanner-keypair) SCANNER_KP="$2"; shift 2 ;;
    --vault-keypair) VAULT_KP="$2"; shift 2 ;;
    --deployer) DEPLOYER_KP="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

for req in SCANNER_KP VAULT_KP DEPLOYER_KP; do
  if [[ -z "${!req}" ]]; then
    echo "missing --${req,,} (see header usage)" >&2
    exit 2
  fi
done

for kp in "$SCANNER_KP" "$VAULT_KP" "$DEPLOYER_KP"; do
  [[ -f "$kp" ]] || { echo "keypair not found: $kp" >&2; exit 2; }
done

command -v solana >/dev/null || { echo "solana CLI not on PATH" >&2; exit 2; }
command -v cargo-build-sbf >/dev/null || { echo "cargo-build-sbf not on PATH" >&2; exit 2; }

echo "== [0/4] identity checks =="
SCANNER_ID="$(solana-keygen pubkey "$SCANNER_KP")"
VAULT_ID="$(solana-keygen pubkey "$VAULT_KP")"
DEPLOYER="$(solana-keygen pubkey "$DEPLOYER_KP")"
[[ "$SCANNER_ID" == "$EXPECTED_SCANNER" ]] || {
  echo "REFUSING: scanner keypair pubkey $SCANNER_ID != compiled declare_id $EXPECTED_SCANNER" >&2
  echo "The ELF's declare_id! and the deploy keypair MUST match." >&2
  exit 1
}
[[ "$VAULT_ID" == "$EXPECTED_VAULT" ]] || {
  echo "REFUSING: vault keypair pubkey $VAULT_ID != compiled declare_id $EXPECTED_VAULT" >&2
  exit 1
}
echo "scanner: $SCANNER_ID"
echo "vault:   $VAULT_ID"
echo "deployer: $DEPLOYER"

echo "== [1/4] deployer funding =="
BAL="$(solana --url "$URL" balance "$DEPLOYER_KP" | tr -dc '0-9')"
echo "balance: $BAL SOL"
if (( BAL < 6 )); then
  echo "REFUSING: deployer needs >= 6 SOL for program rent (two ~400KB ELFs at ~2.7 SOL each) + fees; got $BAL SOL." >&2
  echo "Fund the deployer first (devnet faucet or your own transfer) and re-run." >&2
  exit 1
fi

echo "== [2/4] seed build keypairs (target/deploy, gitignored) =="
mkdir -p target/deploy
for pair in "grave_scanner:$SCANNER_KP:$EXPECTED_SCANNER" "grave_vault:$VAULT_KP:$EXPECTED_VAULT"; do
  name="${pair%%:*}"; rest="${pair#*:}"; kp="${rest%%:*}"; want="${rest##*:}"
  dest="target/deploy/${name}-keypair.json"
  if [[ -f "$dest" ]]; then
    have="$(solana-keygen pubkey "$dest")"
    if [[ "$have" != "$want" ]]; then
      echo "REFUSING: $dest exists with a different pubkey ($have != $want)." >&2
      echo "Remove it or reconcile the keypairs; a stale artifact would deploy under the wrong address." >&2
      exit 1
    fi
  else
    cp "$kp" "$dest"
  fi
  echo "seeded $dest"
done

echo "== [3/4] cargo build-sbf (scanner, vault) =="
if (( SKIP_BUILD == 0 )); then
  # Build per package directory (the repo's canonical SBF build pattern,
  # mirroring scripts/build_fork_harness.sh): agave 3.0.10's
  # cargo-build-sbf rejects `-p` in its own parser, and cargo passthrough
  # of `-p` makes its post-processing step fail on the .so files of the
  # workspace members that the selection skipped (fatal, exit 1).
  (cd programs/grave-scanner && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
  (cd programs/grave-vault  && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
else
  echo "--skip-build set: reusing existing ELFs"
fi
ls -la target/deploy/grave_scanner.so target/deploy/grave_vault.so

echo "== [4/4] solana program deploy =="
solana --url "$URL" program deploy target/deploy/grave_scanner.so \
  --program-id "$SCANNER_KP" --keypair "$DEPLOYER_KP" --output json
solana --url "$URL" program deploy target/deploy/grave_vault.so \
  --program-id "$VAULT_KP" --keypair "$DEPLOYER_KP" --output json

echo "== deployed — next steps (docs/DEVNET.md) =="
cat <<EOF
# Initialize both ProtocolConfig PDAs (authority = deployer by default):
node scripts/devnet/protocol_admin.mjs init-all --url "$URL" --deployer "$DEPLOYER_KP"

# Emergency-control drill per program (pause / intruder-reject / unpause):
node scripts/devnet/protocol_admin.mjs drill --url "$URL" --program scanner \\
  --authority "$DEPLOYER_KP" --intruder <ANOTHER_KEYPAIR>
node scripts/devnet/protocol_admin.mjs drill --url "$URL" --program vault \\
  --authority "$DEPLOYER_KP" --intruder <ANOTHER_KEYPAIR>
EOF
