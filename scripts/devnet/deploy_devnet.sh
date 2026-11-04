#!/usr/bin/env bash
# deploy_devnet.sh — build and deploy both GraveYield programs to devnet.
#
# NS-3 (DR-002): the EXPECTED_* constants below are the owner-generated,
# owner-held NS-3 program IDs. The owner executes deployment manually; this
# script is the documented procedure (docs/DEVNET.md), never an agent action.
#
# Usage:
#   scripts/devnet/deploy_devnet.sh --url https://api.devnet.solana.com \
#       --scanner-keypair <KP> --vault-keypair <KP> --deployer <KP> [--skip-build]
#   scripts/devnet/deploy_devnet.sh --build-only          # build ELFs only —
#       # NO keypairs required (repository preparation / CI); refuses nothing,
#       # deploys nothing, submits nothing.
#
# Safety properties:
#   * The program keypairs determine the on-chain addresses; the ELF's
#     declare_id! (NS-3: EFJpKt… / 7VxUGJ…) must match them. The script refuses
#     to build if target/deploy already holds a DIFFERENT keypair (stale build
#     artifacts would silently deploy under the wrong address).
#   * The compiled ELF's embedded declare_id! is byte-checked against the
#     EXPECTED_* constants before any deploy (closes the partial-sync window
#     where keypair == constant but the ELF was built from a stale tree).
#   * Keypairs never enter git: they live outside the repo (or in an
#     ignored path) and are seeded into target/ (gitignored) for the build.
#   * The deployer must be funded; deploy cost ≈ rent-exempt storage of the
#     two ELFs. The script checks the balance and prints the shortfall.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEVNET_DIR="$REPO_ROOT/scripts/devnet"
cd "$REPO_ROOT"

EXPECTED_SCANNER="EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL"
EXPECTED_VAULT="7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya"

URL="https://api.devnet.solana.com"
SCANNER_KP=""
VAULT_KP=""
DEPLOYER_KP=""
SKIP_BUILD=0
BUILD_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --scanner-keypair) SCANNER_KP="$2"; shift 2 ;;
    --vault-keypair) VAULT_KP="$2"; shift 2 ;;
    --deployer) DEPLOYER_KP="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --build-only) BUILD_ONLY=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if (( BUILD_ONLY == 1 )); then
  # Build-only preparation path: no keypairs, no RPC, no transactions.
  command -v cargo-build-sbf >/dev/null || { echo "cargo-build-sbf not on PATH" >&2; exit 2; }
  mkdir -p target/deploy
  echo "== build-only: cargo build-sbf (scanner, vault) — no keypairs needed =="
  (cd programs/grave-scanner && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
  (cd programs/grave-vault  && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
  if command -v node >/dev/null; then
    node "$DEVNET_DIR/ns3_verify_elf.mjs" --scanner-so target/deploy/grave_scanner.so \
      --vault-so target/deploy/grave_vault.so \
      --scanner-id "$EXPECTED_SCANNER" --vault-id "$EXPECTED_VAULT"
  else
    echo "WARNING: node not on PATH — ELF embedded-ID check skipped; run" >&2
    echo "scripts/devnet/ns3_verify_elf.mjs manually before deploying (R-1)." >&2
  fi
  echo "== build-only complete — ELFs in target/deploy/ (gitignored). Nothing was deployed. =="
  exit 0
fi

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
# Lamport-exact check: digit-stripping the human SOL display mis-reads
# decimals ("0.5" -> "05"; "5.9" -> "59" would PASS a >= 6 test).
BAL_LAMPORTS="$(solana --url "$URL" balance --lamports "$DEPLOYER_KP" | tr -dc '0-9')"
echo "balance: $BAL_LAMPORTS lamports"
MIN_DEPLOY_LAMPORTS=6000000000  # 6 SOL: two ~400KB ELFs at ~2.7 SOL rent each + fees
if (( BAL_LAMPORTS < MIN_DEPLOY_LAMPORTS )); then
  echo "REFUSING: deployer needs >= 6 SOL for program rent (two ~400KB ELFs at ~2.7 SOL each) + fees; got $BAL_LAMPORTS lamports ($(( BAL_LAMPORTS / 1000000000 )) SOL and change)." >&2
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
  # The SBF toolchain is only required when this script builds; --skip-build
  # runs against pre-built (e.g. CI-produced) ELFs on toolchain-less hosts.
  command -v cargo-build-sbf >/dev/null || { echo "cargo-build-sbf not on PATH" >&2; exit 2; }
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

echo "== [3b/4] ELF embedded-identity check (R-1) =="
# The keypair gate above proves the KEYPAIR matches EXPECTED_*; this check
# proves the ELF was BUILT from the synchronized tree (embedded declare_id!).
# Both must hold before a deploy: a partially-synced tree otherwise deploys
# an ELF whose runtime owner checks can never pass at its deployed address.
if command -v node >/dev/null; then
  node "$DEVNET_DIR/ns3_verify_elf.mjs" --scanner-so target/deploy/grave_scanner.so \
    --vault-so target/deploy/grave_vault.so \
    --scanner-id "$EXPECTED_SCANNER" --vault-id "$EXPECTED_VAULT"
else
  echo "REFUSING: node is not on PATH — the ELF embedded-ID check cannot run." >&2
  echo "Install Node >= 24 (the initialization step needs it anyway) and re-run." >&2
  exit 2
fi

echo "== [4/4] solana program deploy =="
solana --url "$URL" program deploy target/deploy/grave_scanner.so \
  --program-id "$SCANNER_KP" --keypair "$DEPLOYER_KP" --output json
solana --url "$URL" program deploy target/deploy/grave_vault.so \
  --program-id "$VAULT_KP" --keypair "$DEPLOYER_KP" --output json

echo "== deployed — next steps (docs/DEVNET.md; NS-3 authority arrangement) =="
cat <<EOF
# Initialize both ProtocolConfig PDAs with the NS-3 governance authority
# (NOT the deployer — separate roles per the NS-3 authority arrangement):
node scripts/devnet/protocol_admin.mjs init-scanner --url "$URL" --deployer "$DEPLOYER_KP" --authority <GOVERNANCE_PUBKEY>
node scripts/devnet/protocol_admin.mjs init-vault   --url "$URL" --deployer "$DEPLOYER_KP" --authority <GOVERNANCE_PUBKEY>

# Emergency-control drill per program — the GOVERNANCE keypair is the
# authority (fee dust needed); intruder is a throwaway:
node scripts/devnet/protocol_admin.mjs drill --url "$URL" --program scanner \\
  --authority <GOVERNANCE_KEYPAIR> --intruder <ANOTHER_KEYPAIR>
node scripts/devnet/protocol_admin.mjs drill --url "$URL" --program vault \\
  --authority <GOVERNANCE_KEYPAIR> --intruder <ANOTHER_KEYPAIR>

# Register the dedicated NS-3 oracle signers (governance signs; deployer
# pays the fee):
node scripts/devnet/protocol_admin.mjs register-oracle --url "$URL" \\
  --authority <GOVERNANCE_KEYPAIR> --fee-payer "$DEPLOYER_KP" \\
  --activity-oracle <ACTIVITY_ORACLE_PUBKEY> --launch-price-oracle <LAUNCH_PRICE_ORACLE_PUBKEY>
EOF
