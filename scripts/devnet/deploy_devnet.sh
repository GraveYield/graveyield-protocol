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
#       # NO keypairs required (repository preparation / rehearsal setup);
#       # deploys nothing, submits nothing.
#
# Safety properties:
#   * PROVENANCE GATE (fail-closed, EVERY path): before any deployment
#     transaction can be submitted, scripts/devnet/ns3_check_provenance.mjs
#     must pass against scripts/devnet/provenance.manifest.json — the shared
#     manifest pinning the recorded deployment digests (PR #82 provenance):
#       - SHA-256 of both ELFs must equal the manifest digests;
#       - both ELFs must be SBPF v0 (e_machine 263 / e_flags 0) — an ELF
#         built for any other sbpf version is refused;
#       - structural NS-3 identity (embedded declare_id! in an allocated
#         section, no NS-1/NS-2 legacy ID bytes anywhere);
#       - when building: the platform-tools ARCHIVE is re-verified against
#         the manifest and the cargo-build-sbf cache is re-seeded from the
#         VERIFIED archive (fix B: a plaintext cache stamp is never trusted).
#     The gate applies to the normal build+deploy flow, --build-only,
#     --skip-build (pre-placed or CI-produced artifacts), and every
#     re-run/retry: there is no flag, path, or environment that skips it.
#     If the digests differ, the gate stays closed — re-pin only after an
#     independently reviewed rebuild (docs/DEVNET.md), never to go green.
#   * DEPLOYMENT-CLI IDENTITY (fix D): `solana --version` and
#     `solana-keygen --version` are verified against the manifest pin on
#     EVERY deploy path (normal, --skip-build, retries) BEFORE any owner
#     keypair path is touched (existence checks included) — the CLI that
#     reads owner keys and submits transactions is a separate trust
#     surface from the build toolchain, and its identity is proven first.
#   * BUILD-TOOLCHAIN IDENTITY (fix D, build paths only): cargo-build-sbf
#     and the platform-tools cache are verified BEFORE the owner keypairs
#     are seeded into target/ (a toolchain refusal must never leave owner
#     key material copied into the build tree).
#   * ANCHOR IS NOT ON THE DEPLOY PATH (fix D finding, verified): this
#     script builds with cargo-build-sbf (pinned agave 3.0.10 toolchain)
#     and deploys with `solana program deploy`; anchor 1.2.2 is used only
#     by the CI `anchor build` flow and is NOT required at deployment
#     time. The v1.57 platform-tools cache (anchor 1.2.2's resolution) is
#     still seeded — from the hash-verified archive only — so that an
#     accidental anchor invocation can never resolve unverified bytes.
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

# The shared provenance gate + manifest (single source of the digests, also
# consumed by CI — never keep a second copy of the hashes here).
PROVENANCE_MANIFEST="$DEVNET_DIR/provenance.manifest.json"
PROVENANCE_CHECKER="$DEVNET_DIR/ns3_check_provenance.mjs"

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

require_node() {
  if ! command -v node >/dev/null; then
    echo "REFUSING: node is not on PATH — the fail-closed provenance gate cannot run." >&2
    echo "Install Node >= 24 and re-run. There is no bypass for this check." >&2
    exit 2
  fi
}

# Read a field out of the shared manifest without a second copy of the data.
manifest_field() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const [path] = process.argv.slice(2);
    let v = m;
    for (const k of path.split(".")) v = v?.[k];
    if (v === undefined || typeof v !== "string") {
      console.error(`manifest field ${path} missing or not a string`);
      process.exit(2);
    }
    process.stdout.write(String(v));
  ' "$PROVENANCE_MANIFEST" "$1"
}

# The fail-closed provenance gate. Runs on EVERY execution path before any
# deployment transaction; a non-zero exit aborts the whole script (set -e).
run_provenance_gate() {
  require_node
  local gate_args=(
    --manifest "$PROVENANCE_MANIFEST"
    --scanner-so target/deploy/grave_scanner.so
    --vault-so target/deploy/grave_vault.so
    --scanner-id "$EXPECTED_SCANNER"
    --vault-id "$EXPECTED_VAULT"
  )
  if [[ -n "${PLATFORM_TOOLS_TARBALL:-}" ]]; then
    gate_args+=(--platform-tools-tarball "$PLATFORM_TOOLS_TARBALL")
  fi
  echo "== provenance gate (scripts/devnet/provenance.manifest.json) =="
  node "$PROVENANCE_CHECKER" "${gate_args[@]}"
}

# Pin platform-tools (build paths only) — THE ARCHIVE IS THE ONLY TRUST
# ANCHOR (fix B). A pre-seeded cache directory carries a plaintext stamp
# that anyone (or any corrupted tool) can write, so the stamp is NEVER
# trusted as evidence of the directory's contents. Instead, every run:
#   1. obtains the archive — reusing the local archive copy ONLY after its
#      SHA-256 re-verifies against the shared manifest, otherwise
#      downloading it fresh; a download whose digest mismatches the pin
#      aborts the run BEFORE anything is extracted (fail closed);
#   2. re-seeds EVERY cache directory this flow may resolve (v1.51 =
#      cargo-build-sbf 3.0.10's default; v1.57 = anchor 1.2.2's override —
#      anchor itself is NOT required on the deploy path, but the cache is
#      seeded so an accidental resolution can never pick unverified bytes)
#      from the VERIFIED archive, overwriting whatever was there before;
#   3. writes the stamp last — informational, never load-bearing.
pin_platform_tools() {
  require_node
  local pt_sha pt_ver pt_url
  pt_sha="$(manifest_field toolchain.platform_tools.sha256)"
  pt_ver="$(manifest_field toolchain.platform_tools.version)"
  pt_url="$(manifest_field toolchain.platform_tools.url)"
  local cache_root="$HOME/.cache/solana"
  local archive="$cache_root/.graveyield-platform-tools-v$pt_ver.tar.bz2"

  # Pass 1 — a hash-verified archive, one way or another.
  if [[ -f "$archive" ]]; then
    echo "== platform-tools archive re-verification: $archive =="
    if node "$PROVENANCE_CHECKER" --manifest "$PROVENANCE_MANIFEST" \
      --platform-tools-tarball "$archive" >/dev/null; then
      echo "platform-tools v$pt_ver archive OK (sha256 $pt_sha)"
    else
      echo "cached platform-tools archive does NOT match the manifest pin - deleting and re-downloading" >&2
      rm -f "$archive"
    fi
  fi
  if [[ ! -f "$archive" ]]; then
    command -v curl >/dev/null || {
      echo "REFUSING: curl not on PATH - cannot fetch the pinned platform-tools tarball." >&2
      exit 2
    }
    local tmp
    tmp="$(mktemp /tmp/platform-tools.XXXXXX.tar.bz2)"
    echo "downloading platform-tools v$pt_ver -> $tmp"
    curl -sSL --fail -o "$tmp" "$pt_url" || {
      echo "REFUSING: platform-tools v$pt_ver download failed - build toolchain unproven." >&2
      rm -f "$tmp"
      exit 1
    }
    echo "== platform-tools archive verification (against the shared manifest) =="
    if ! node "$PROVENANCE_CHECKER" --manifest "$PROVENANCE_MANIFEST" \
      --platform-tools-tarball "$tmp"; then
      echo "REFUSING: platform-tools tarball failed the manifest digest check - NOTHING was" >&2
      echo "extracted and nothing will be built; the build toolchain is unproven." >&2
      rm -f "$tmp"
      exit 1
    fi
    mkdir -p "$cache_root"
    mv -f "$tmp" "$archive"
  fi

  # Pass 2 — seed every resolvable version dir FROM THE VERIFIED ARCHIVE
  # ONLY (the rm -rf means a foreign or tampered cache cannot survive).
  local v dest
  for v in v1.51 v1.57; do
    dest="$cache_root/$v/platform-tools"
    rm -rf "$dest"
    mkdir -p "$dest"
    tar xjf "$archive" -C "$dest"
    printf '%s\n' "$pt_sha" > "$dest/.graveyield-pinned-sha256"
    echo "platform-tools v$pt_ver cache seeded from the verified archive: $dest"
  done
  # The verified archive is kept (not deleted) so the provenance gate below
  # can verify it a second time alongside the ELFs, and so the next run's
  # re-verification works offline.
  PLATFORM_TOOLS_TARBALL="$archive"
}

# The build toolchain must be the pinned one (manifest toolchain.solana_cli).
check_build_toolchain_version() {
  local want got
  want="$(manifest_field toolchain.solana_cli)"
  got="$(cargo-build-sbf --version 2>/dev/null || true)"
  if [[ "$got" != *"$want"* ]]; then
    echo "REFUSING: cargo-build-sbf version '$got' does not match the pinned Solana toolchain $want." >&2
    echo "Install agave/Solana CLI $want (the toolchain that produced the recorded digests)." >&2
    exit 1
  fi
  echo "cargo-build-sbf version OK: $got"
}

# Deployment-CLI identity (fix D) — a trust surface DISTINCT from the
# build toolchain: this is the binary that reads the owner keypair files
# and submits the deploy transactions, so its identity is verified
# against the shared manifest pin BEFORE any owner keypair path is
# touched (existence checks included), on EVERY deploy path (normal,
# --skip-build, and every retry/re-run — nothing caches this verdict).
check_deploy_cli() {
  require_node
  local want got
  want="$(manifest_field toolchain.solana_cli)"
  command -v solana >/dev/null || {
    echo "REFUSING: solana CLI not on PATH - the deployment CLI identity cannot be verified." >&2
    exit 2
  }
  command -v solana-keygen >/dev/null || {
    echo "REFUSING: solana-keygen not on PATH - the deployment CLI identity cannot be verified." >&2
    exit 2
  }
  got="$(solana --version 2>/dev/null || true)"
  if [[ "$got" != *"$want"* ]]; then
    echo "REFUSING: solana --version '$got' does not match the pinned deployment CLI $want." >&2
    echo "The deployment CLI reads the owner keypairs and submits the deploy transactions;" >&2
    echo "its identity is verified first, before any keypair path is touched (docs/DEVNET.md)." >&2
    exit 1
  fi
  got="$(solana-keygen --version 2>/dev/null || true)"
  if [[ "$got" != *"$want"* ]]; then
    echo "REFUSING: solana-keygen --version '$got' does not match the pinned deployment CLI $want." >&2
    exit 1
  fi
  echo "deployment CLI identity OK: solana + solana-keygen $want"
}

if (( BUILD_ONLY == 1 )); then
  # Build-only preparation path: no keypairs, no RPC, no transactions.
  # No deployment-CLI identity check here by design: this path never
  # touches a keypair and never submits a transaction (fix D scopes the
  # CLI check to deploy paths).
  require_node
  command -v cargo-build-sbf >/dev/null || { echo "cargo-build-sbf not on PATH" >&2; exit 2; }
  pin_platform_tools
  check_build_toolchain_version
  mkdir -p target/deploy
  echo "== build-only: cargo build-sbf (scanner, vault) — no keypairs needed =="
  (cd programs/grave-scanner && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
  (cd programs/grave-vault  && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
  # Fail-closed provenance gate: build-only produces no deployment, but it
  # must NOT mark bytes "ready" that are not exactly the recorded digests.
  run_provenance_gate
  # NOTE: the verified platform-tools archive is intentionally KEPT (no
  # rm): the next run re-verifies the very same bytes instead of
  # re-downloading (fix B).
  echo "== build-only complete — ELFs in target/deploy/ are provenance-verified (gitignored). Nothing was deployed. =="
  exit 0
fi

# ------------------------------------------------------------------
# DEPLOY PATH — order is security-mandated (fixes B + D):
#   [0] deployment-CLI identity   (BEFORE any owner keypair path is touched)
#   [1] keypair existence + identity (the verified CLI reads the pubkeys)
#   [2] deployer funding
#   [3] build-toolchain identity + platform-tools archive (BEFORE seeding)
#   [4] seed owner keypairs into target/deploy
#   [5] cargo build / --skip-build
#   [6] fail-closed provenance gate
#   [7] solana program deploy
# ------------------------------------------------------------------

for req in SCANNER_KP VAULT_KP DEPLOYER_KP; do
  if [[ -z "${!req}" ]]; then
    echo "missing --${req,,} (see header usage)" >&2
    exit 2
  fi
done

echo "== [0/7] deployment-CLI identity (before any keypair path is touched) =="
check_deploy_cli

for kp in "$SCANNER_KP" "$VAULT_KP" "$DEPLOYER_KP"; do
  [[ -f "$kp" ]] || { echo "keypair not found: $kp" >&2; exit 2; }
done

echo "== [1/7] keypair identity checks =="
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

echo "== [2/7] deployer funding =="
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

echo "== [3/7] build-toolchain identity + platform-tools archive (before owner keypairs are seeded) =="
if (( SKIP_BUILD == 0 )); then
  # The SBF toolchain is only required when this script builds; --skip-build
  # runs against pre-built (e.g. CI-produced) ELFs on toolchain-less hosts.
  # Both build paths pin platform-tools v1.54 (archive hash-verified EVERY
  # run) so the bytes are reproducible against the recorded digests. This
  # verification deliberately runs BEFORE step [4] seeds the owner
  # keypairs: a toolchain refusal must never leave owner key material
  # copied into the build tree (fix B).
  command -v cargo-build-sbf >/dev/null || { echo "cargo-build-sbf not on PATH" >&2; exit 2; }
  pin_platform_tools
  check_build_toolchain_version
else
  echo "--skip-build set: no build toolchain resolution (the deployment-CLI identity above still applies in full)"
fi

echo "== [4/7] seed build keypairs (target/deploy, gitignored) =="
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

echo "== [5/7] cargo build-sbf (scanner, vault) =="
if (( SKIP_BUILD == 0 )); then
  # Build per package directory (the repo's canonical SBF build pattern,
  # mirroring scripts/build_fork_harness.sh): agave 3.0.10's
  # cargo-build-sbf rejects `-p` in its own parser, and cargo passthrough
  # of `-p` makes its post-processing step fail on the .so files of the
  # workspace members that the selection skipped (fatal, exit 1).
  (cd programs/grave-scanner && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
  (cd programs/grave-vault  && cargo build-sbf --sbf-out-dir "$REPO_ROOT/target/deploy")
else
  echo "--skip-build set: reusing existing ELFs (the provenance gate below still applies in full)"
fi

echo "== [6/7] fail-closed provenance gate (digests + SBPF v0 + structural identity) =="
# This gate is the deployment precondition: no `solana program deploy` below
# runs unless both ELFs match scripts/devnet/provenance.manifest.json byte
# for byte, are SBPF v0, and carry the NS-3 identities structurally. It
# covers the build path AND --skip-build (pre-placed/CI artifacts), and
# therefore every retry/recovery re-run of this script.
run_provenance_gate
# NOTE: the verified platform-tools archive is intentionally KEPT (no rm)
# so the next run re-verifies the same bytes offline (fix B).

echo "== [7/7] artifact summary + solana program deploy =="
ls -la target/deploy/grave_scanner.so target/deploy/grave_vault.so

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

# Read-only post-deployment acceptance (no keypairs, no transactions):
node scripts/devnet/verify_ns3_deployment.mjs --url "$URL"
EOF
