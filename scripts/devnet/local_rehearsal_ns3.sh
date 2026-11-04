#!/usr/bin/env bash
# local_rehearsal_ns3.sh — NS-3 deployment REHEARSAL on a local
# solana-test-validator using TEST IDENTITIES and LOCAL ARTIFACTS ONLY.
#
# This is the NS-3 preparation path (DR-002): it exercises the EXACT
# production initialization sequence the owner will run on devnet —
#
#   deploy (ELFs loaded at the NS-3 program IDs) →
#   init-scanner/init-vault with the GOVERNANCE authority (fee payer =
#   deployer, roles separate) →
#   emergency-control drill (governance pauses / intruder rejected) →
#   register-oracle (governance signs, deployer pays the fee —
#   dedicated activity + launch-price oracle keys) →
#   config readback.
#
# …without touching any owner keypair:
#   * program keypairs are NEVER needed — the validator loads the locally
#     built ELFs directly at the NS-3 declare_id! addresses
#     (`solana-test-validator --bpf-program <ID> <so>`, upgrades disabled);
#   * deployer / governance / intruder / oracle keys are minted into a
#     mktemp dir and discarded with it;
#   * everything targets http://127.0.0.1:8899; nothing leaves the machine;
#     no devnet/mainnet RPC is contacted; no transaction is submitted to
#     any public cluster.
#
# Prerequisites: solana CLI (agave 3.0.x) on PATH; the two ELFs built into
# target/deploy/ (via `deploy_devnet.sh --build-only` or CI artifacts);
# Node >= 24; `pnpm install` completed (scripts/devnet workspace deps).
#
# The production-keypair variant (owner custody keys) remains
# scripts/devnet/local_rehearsal.sh — unchanged.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
DEVNET_DIR="$REPO_ROOT/scripts/devnet"

EXPECTED_SCANNER="EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL"
EXPECTED_VAULT="7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya"
GOVERNANCE_PUBKEY="BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5"
ACTIVITY_ORACLE_PUBKEY="2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o"
LAUNCH_PRICE_ORACLE_PUBKEY="97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/share/solana/bin:$PATH"
command -v solana-test-validator >/dev/null || { echo "solana-test-validator not on PATH" >&2; exit 2; }
command -v node >/dev/null || { echo "node not on PATH (>= 24 required)" >&2; exit 2; }
[[ -f "$REPO_ROOT/scripts/devnet/node_modules/@solana/web3.js/package.json" ]] || {
  echo "scripts/devnet dependencies missing — run 'pnpm install' at the repo root first" >&2
  exit 2
}

SCANNER_SO="$REPO_ROOT/target/deploy/grave_scanner.so"
VAULT_SO="$REPO_ROOT/target/deploy/grave_vault.so"
if [[ ! -f "$SCANNER_SO" || ! -f "$VAULT_SO" ]]; then
  echo "ELFs not found: $SCANNER_SO / $VAULT_SO" >&2
  echo "Build them first (no keypairs needed): scripts/devnet/deploy_devnet.sh --build-only" >&2
  exit 2
fi
if command -v node >/dev/null; then
  node "$DEVNET_DIR/ns3_verify_elf.mjs" --scanner-so "$SCANNER_SO" --vault-so "$VAULT_SO" \
    --scanner-id "$EXPECTED_SCANNER" --vault-id "$EXPECTED_VAULT"
fi

TMP="$(mktemp -d /tmp/gy-ns3-rehearsal.XXXXXX)"
VALIDATOR_PID=""
cleanup() {
  if [[ -n "$VALIDATOR_PID" ]]; then kill "$VALIDATOR_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== [1/6] mint rehearsal TEST identities (discarded with the temp dir) =="
solana-keygen new --no-bip39-passphrase -s -o "$TMP/deployer.json" -f >/dev/null
solana-keygen new --no-bip39-passphrase -s -o "$TMP/governance.json" -f >/dev/null
solana-keygen new --no-bip39-passphrase -s -o "$TMP/intruder.json" -f >/dev/null
solana-keygen new --no-bip39-passphrase -s -o "$TMP/activity_oracle.json" -f >/dev/null
solana-keygen new --no-bip39-passphrase -s -o "$TMP/launch_price_oracle.json" -f >/dev/null
DEPLOYER="$TMP/deployer.json"
GOVERNANCE="$TMP/governance.json"
INTRUDER="$TMP/intruder.json"
echo "NOTE: the rehearsal's governance/oracle keys are THROWAWAYS. On devnet the"
echo "owner uses the real custody keys whose public keys are pinned above:"
echo "  governance        $GOVERNANCE_PUBKEY"
echo "  activity oracle   $ACTIVITY_ORACLE_PUBKEY"
echo "  launch-price oracle $LAUNCH_PRICE_ORACLE_PUBKEY"
echo "deployer:   $(solana-keygen pubkey "$DEPLOYER")"
echo "governance: $(solana-keygen pubkey "$GOVERNANCE") (throwaway)"

echo "== [2/6] start solana-test-validator (localnet only) =="
solana-test-validator --reset --quiet --warp-slot 1 \
  --bpf-program "$EXPECTED_SCANNER" "$SCANNER_SO" \
  --bpf-program "$EXPECTED_VAULT" "$VAULT_SO" \
  >"$TMP/validator.log" 2>&1 &
VALIDATOR_PID=$!
URL="http://127.0.0.1:8899"
for i in $(seq 1 60); do
  if solana --url "$URL" cluster-version >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ "$i" == 60 ]]; then
    echo "validator failed to become healthy" >&2
    tail -20 "$TMP/validator.log" >&2
    exit 1
  fi
done
echo "validator healthy (pid $VALIDATOR_PID)"
solana --url "$URL" airdrop 10 "$(solana-keygen pubkey "$DEPLOYER")" >/dev/null
solana --url "$URL" airdrop 2 "$(solana-keygen pubkey "$GOVERNANCE")" >/dev/null
solana --url "$URL" airdrop 1 "$(solana-keygen pubkey "$INTRUDER")" >/dev/null

echo "== [3/6] programs loaded at the NS-3 IDs — verify on-chain identity =="
solana --url "$URL" program show "$EXPECTED_SCANNER"
solana --url "$URL" program show "$EXPECTED_VAULT"

echo "== [4/6] initialize with the GOVERNANCE authority (deployer pays fees) =="
node "$DEVNET_DIR/protocol_admin.mjs" init-scanner --url "$URL" --deployer "$DEPLOYER" --authority "$GOVERNANCE_PUBKEY"
node "$DEVNET_DIR/protocol_admin.mjs" init-vault   --url "$URL" --deployer "$DEPLOYER" --authority "$GOVERNANCE_PUBKEY"

echo "== [5/6] emergency-control drills (governance is the authority) =="
node "$DEVNET_DIR/protocol_admin.mjs" drill --url "$URL" --program scanner \
  --authority "$GOVERNANCE" --intruder "$INTRUDER"
node "$DEVNET_DIR/protocol_admin.mjs" drill --url "$URL" --program vault \
  --authority "$GOVERNANCE" --intruder "$INTRUDER"

echo "== [6/6] register the dedicated oracle signers (governance signs, deployer pays) =="
node "$DEVNET_DIR/protocol_admin.mjs" register-oracle --url "$URL" \
  --authority "$GOVERNANCE" --fee-payer "$DEPLOYER" \
  --activity-oracle "$(solana-keygen pubkey "$TMP/activity_oracle.json")" \
  --launch-price-oracle "$(solana-keygen pubkey "$TMP/launch_price_oracle.json")"

echo ""
echo "NS-3 LOCAL REHEARSAL COMPLETE — deploy-at-declare_id, governance-authority"
echo "initialization, both drills, and separate-signer oracle registration all"
echo "behaved per the NS-3 authority arrangement on both programs. All identities"
echo "used were throwaways (discarded); no owner keypair was touched; nothing was"
echo "submitted to any public cluster."
