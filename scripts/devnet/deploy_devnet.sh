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
#   * FAIL-CLOSED PROVENANCE GATE (PR #82 parity at deploy time): EVERY path
#     that can reach `solana program deploy` — normal build, --skip-build
#     (CI-artifact / resume / retry), and re-runs after a failed deploy —
#     first passes scripts/devnet/ns3_verify_provenance.mjs against the
#     shared manifest (scripts/devnet/provenance.manifest.json): the ELFs
#     must be byte-identical (SHA-256) to the approved NS-3 deployment
#     provenance, structurally embed the NS-3 program IDs in allocated
#     sections, carry NO legacy NS-1/NS-2 ID bytes, and match the SBPF v0
#     architecture record (e_machine 263 / e_flags 0 — anchor 1.2.2's
#     default v3 output is refused). A missing, malformed, or mismatched
#     ELF aborts BEFORE any deployment transaction can be submitted. There
#     is no flag that skips this gate. A digest is never bumped to make a
#     failing check pass — new bytes need independent review and deliberate
#     re-approval in a reviewed PR.
#   * Build paths verify the platform-tools provenance too: the pinned
#     v1.54 cache directory (the toolchain that produced the approved
#     bytes) must exist before cargo-build-sbf runs, and — when the tarball
#     is available (GRAVEYIELD_PLATFORM_TOOLS_TARBALL) — the tarball is
#     SHA-256-verified against the manifest. The byte-identity of the BUILD
#     RESULT is then still enforced by the digest gate above (a build with
#     any other toolchain shifts the digests and refuses).
#   * Keypairs never enter git: they live outside the repo (or in an
#     ignored path) and are seeded into target/ (gitignored) for the build.
#   * The deployer must be funded; deploy cost ≈ rent-exempt storage of the
#     two ELFs. The script checks the balance and prints the shortfall.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEVNET_DIR="$REPO_ROOT/scripts/devnet"
MANIFEST="$DEVNET_DIR/provenance.manifest.json"
PROV_CHECKER="$DEVNET_DIR/ns3_verify_provenance.mjs"
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

# Fail-closed provenance gate — shared by EVERY path below. Refuses unless
# node can run the checker and the manifest + both ELFs verify completely.
# No flag reaches this function's refusal: it is the last word before any
# deploy transaction.
verify_provenance() {
  if ! command -v node >/dev/null; then
    echo "REFUSING: node is not on PATH — the deployment-provenance gate cannot run." >&2
    echo "Install Node >= 24 (the initialization step needs it anyway) and re-run." >&2
    exit 2
  fi
  local extra=()
  if [[ -n "${GRAVEYIELD_PLATFORM_TOOLS_TARBALL:-}" ]]; then
    extra+=(--platform-tools-tarball "$GRAVEYIELD_PLATFORM_TOOLS_TARBALL")
  fi
  echo "== provenance gate: ns3_verify_provenance.mjs (manifest: $MANIFEST) =="
  node "$PROV_CHECKER" --manifest "$MANIFEST" \
    --scanner-so target/deploy/grave_scanner.so \
    --vault-so target/deploy/grave_vault.so \
    "${extra[@]+"${extra[@]}"}"
}

# Build-path platform-tools provenance: cargo-build-sbf must use the pinned
# v1.54 toolchain (the one that produced the approved bytes). On a bare host
# its 3.0.10 default is v1.51, which builds DIFFERENT bytes — refused here
# before any compile, and the digest gate still catches the result either
# way. GRAVEYIELD_PLATFORM_TOOLS_DIR may relocate the directory probe
# (nonstandard HOME / CI layout); it does NOT relax the digest gate.
require_platform_tools() {
  local pt_version pt_dir
  pt_version="$(node -e "const m=require('$MANIFEST'); if(m.platformTools?.version!=='v1.54')process.exit(1); process.stdout.write(m.platformTools.version)")" || {
    echo "REFUSING: manifest platformTools.version is not the pinned v1.54 record." >&2
    exit 1
  }
  pt_dir="${GRAVEYIELD_PLATFORM_TOOLS_DIR:-$HOME/.cache/solana/$pt_version/platform-tools}"
  if [[ ! -d "$pt_dir" ]]; then
    echo "REFUSING: platform-tools $pt_version not found at $pt_dir." >&2
    echo "The approved ELFs are built with the pinned v1.54 toolchain; a default" >&2
    echo "cargo-build-sbf install resolves v1.51 and produces DIFFERENT bytes." >&2
    echo "Seed the cache from the hash-verified tarball (see docs/DEVNET.md §provenance):" >&2
    echo "  curl -sSL -o platform-tools.tar.bz2 \\" >&2
    echo "    https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-linux-x86_64.tar.bz2" >&2
    echo "  echo fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e  platform-tools.tar.bz2 | sha256sum -c -" >&2
    echo "  mkdir -p $pt_dir && tar xjf platform-tools.tar.bz2 -C $pt_dir" >&2
    exit 1
  fi
  if [[ -x "$pt_dir/rust/bin/rustc" ]]; then
    echo "platform-tools $pt_version present at $pt_dir ($( "$pt_dir/rust/bin/rustc" --version 2>/dev/null || echo 'rustc version unreadable' ))"
  else
    echo "platform-tools $pt_version present at $pt_dir"
  fi
}

if (( BUILD_ONLY == 1 )); then
  # Build-only preparation path: no keypairs, no RPC, no transactions.
  command -v cargo-build-sbf >/dev/null || { echo "cargo-build-sbf not on PATH" >&2; exit 2; }
  if ! command -v node >/dev/null; then
    # Fail-closed (was a soft warning before the provenance gate existed):
    # the artifacts this path produces are the CI/deployment inputs, so the
    # provenance gate MUST be able to run over them.
    echo "REFUSING: node is not on PATH — the deployment-provenance gate cannot run." >&2
    echo "Install Node >= 24 and re-run (the gate verifies what CI publishes and" >&2
    echo "what --skip-build deploys; an unverifiable build output is refused)." >&2
    exit 2
  fi
  require_platform_tools
  mkdir -p target/deploy
  echo "== build-only: cargo build-sbf (scanner, vault) — no keypairs needed =="
  (cd programs/grave-scanner && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
  (cd programs/grave-vault  && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
  verify_provenance
  echo "== build-only complete — ELFs verified against the approved NS-3 deployment"
  echo "   provenance in target/deploy/ (gitignored). Nothing was deployed. =="
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

echo "== [0/5] identity checks =="
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

echo "== [1/5] deployer funding =="
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

echo "== [2/5] seed build keypairs (target/deploy, gitignored) =="
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

echo "== [3/5] cargo build-sbf (scanner, vault) =="
if (( SKIP_BUILD == 0 )); then
  # The SBF toolchain is only required when this script builds; --skip-build
  # runs against pre-built (e.g. CI-produced) ELFs on toolchain-less hosts.
  command -v cargo-build-sbf >/dev/null || { echo "cargo-build-sbf not on PATH" >&2; exit 2; }
  require_platform_tools
  # Build per package directory (the repo's canonical SBF build pattern,
  # mirroring scripts/build_fork_harness.sh): agave 3.0.10's
  # cargo-build-sbf rejects `-p` in its own parser, and cargo passthrough
  # of `-p` makes its post-processing step fail on the .so files of the
  # workspace members that the selection skipped (fatal, exit 1).
  (cd programs/grave-scanner && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
  (cd programs/grave-vault  && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
else
  echo "--skip-build set: reusing existing ELFs (the provenance gate below still"
  echo "verifies their full SHA-256 against the shared manifest — reuse is NOT a bypass)"
fi
ls -la target/deploy/grave_scanner.so target/deploy/grave_vault.so

echo "== [3b/5] ELF deployment-provenance gate (digest + identity + legacy + arch) =="
# Fail-closed, on EVERY path that reaches [4/5]: normal build, --skip-build,
# and any resume/retry re-run. Verifies SHA-256 against the shared manifest
# (the same approved digests CI's anchor-build job publishes), structural
# embedding of the NS-3 IDs in allocated sections, absence of legacy
# NS-1/NS-2 ID bytes, and the SBPF v0 (e_machine 263 / e_flags 0) record.
# The previous keypair gate proves the KEYPAIR matches EXPECTED_*; this gate
# proves the BYTES are the approved deployment provenance. Both must hold
# before a deploy. (The manifest consumed here is the same one CI consumes;
# the standalone ns3_verify_elf.mjs structural check remains available and
# is subsumed by this gate.)
verify_provenance

echo "== [4/5] solana program deploy =="
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

# Read-only acceptance verification (no keys, no transactions — safe to run
# from any machine; RPC failures block PASS rather than faking it):
node scripts/devnet/verify_ns3_deployment.mjs --url "$URL"
EOF
