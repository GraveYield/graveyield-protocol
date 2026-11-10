#!/usr/bin/env bash
# local_rehearsal_ns3.sh — NS-3 deployment REHEARSAL on a local
# solana-test-validator using TEST IDENTITIES and LOCAL ARTIFACTS ONLY.
#
# This is the NS-3 preparation path (DR-002): it exercises the production
# initialization sequence in its exact SHAPE —
#
#   deploy (ELFs loaded at the NS-3 program IDs) →
#   init-scanner/init-vault with the GOVERNANCE authority (fee payer =
#   deployer, roles separate) →
#   emergency-control drill (governance pauses / intruder rejected) →
#   register-oracle (governance signs, deployer pays the fee —
#   dedicated activity + launch-price oracle keys) →
#   config readback.
#
# LOCAL AUTHORITY CORRECTION (fix/ns3-local-rehearsal-governance-authority):
# the governance authority used throughout THIS rehearsal is a single
# TEMPORARY keypair — the same throwaway key initializes both
# ProtocolConfigs, runs the emergency-control drills, and registers the
# oracles, so the authority stored in the temporary ProtocolConfig
# accounts always equals the key that later signs administrative
# operations. The permanent NS-3 governance public key is printed for
# contrast but NEVER enters the local validator state. Production devnet
# behavior is unchanged: deploy_devnet.sh + docs/DEVNET.md still
# initialize with the owner's permanent governance key
# (BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5) there.
#
# …without touching any owner keypair:
#   * program keypairs are NEVER needed — the validator loads the locally
#     built ELFs directly at the NS-3 declare_id! addresses
#     (`solana-test-validator --bpf-program <ID> <so>`, upgrades disabled);
#   * deployer / governance / intruder / oracle keys are minted into a
#     mktemp dir and discarded with it (the temporary governance key is
#     the ONE authority for the rehearsal's whole lifecycle);
#   * everything targets http://127.0.0.1:8899; nothing leaves the machine;
#     no devnet/mainnet RPC is contacted; no transaction is submitted to
#     any public cluster. protocol_admin.mjs is invoked with
#     --allow-local-validator — the CLI's explicit, narrowly scoped local
#     rehearsal opt-in (loopback endpoints ONLY; still requires a live
#     genesis answer; never a bypass for remote RPC endpoints). On any
#     other cluster — including Devnet — the CLI requires the pinned
#     Devnet genesis and refuses otherwise.
#
# Prerequisites: solana CLI (agave 3.0.x) on PATH; the two ELFs built into
# target/deploy/ (via `deploy_devnet.sh --build-only` or CI artifacts);
# Node >= 24; `pnpm install` completed (scripts/devnet workspace deps).
#
# The legacy NS-2-era full-deployment rehearsal (scripts/devnet/
# local_rehearsal.sh) is SUPERSEDED by this script and now REFUSES to
# run: deploy_devnet.sh is Devnet-only by design (pinned genesis guard)
# and protocol_admin.mjs rejects the retired deployer-as-authority
# arrangement. This NS-3 rehearsal is the only local-validator workflow.
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
# The rehearsal's ONE governance authority for its whole lifecycle: this
# TEMPORARY keypair's public key is what both ProtocolConfigs store at
# initialize, and the same keypair signs every later administrative
# operation (drills, oracle registration). A collision with the permanent
# NS-3 governance key is refused loudly — that key must never enter the
# local validator state.
REHEARSAL_GOVERNANCE_PK="$(solana-keygen pubkey "$GOVERNANCE")"
if [[ "$REHEARSAL_GOVERNANCE_PK" == "$GOVERNANCE_PUBKEY" ]]; then
  echo "REFUSING: the freshly minted rehearsal governance key collided with the" >&2
  echo "permanent NS-3 governance pubkey ($GOVERNANCE_PUBKEY) — regenerate and re-run." >&2
  exit 1
fi
echo "NOTE: the rehearsal's governance/oracle keys are THROWAWAYS. On devnet the"
echo "owner uses the real custody keys whose public keys are pinned above:"
echo "  governance        $GOVERNANCE_PUBKEY"
echo "  activity oracle   $ACTIVITY_ORACLE_PUBKEY"
echo "  launch-price oracle $LAUNCH_PRICE_ORACLE_PUBKEY"
echo "deployer:   $(solana-keygen pubkey "$DEPLOYER")"
echo "governance: $REHEARSAL_GOVERNANCE_PK (throwaway — the rehearsal's ONLY authority)"

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
# --keypair "$DEPLOYER" (the throwaway rehearsal deployer) keeps these
# READ-ONLY show commands independent of any global default Solana
# signer: without it the CLI would demand ~/.config/solana/id.json and
# fail on machines with no default wallet — and no command in this
# script may ever depend on a key outside the rehearsal's temp dir.
solana --url "$URL" --keypair "$DEPLOYER" program show "$EXPECTED_SCANNER"
solana --url "$URL" --keypair "$DEPLOYER" program show "$EXPECTED_VAULT"

echo "== [4/6] initialize with the TEMPORARY governance authority (deployer pays fees) =="
# The ProtocolConfig authority stored on-chain is the TEMPORARY governance
# PUBLIC key (the deployer keypair only signs the fee). protocol_admin.mjs
# reads both configs back right after each initialize and fails unless the
# stored authority equals this key — the same key the drills below sign
# with. On devnet the owner passes the PERMANENT governance pubkey here
# instead (docs/DEVNET.md) — this script must not change that.
# --allow-local-validator: protocol_admin.mjs's explicit local rehearsal
# opt-in. It is accepted ONLY because $URL is the loopback validator
# (http://127.0.0.1:8899) and the endpoint answers the genesis RPC; the
# CLI still verifies the temporary authority on every governance call.
node "$DEVNET_DIR/protocol_admin.mjs" init-scanner --allow-local-validator --url "$URL" --deployer "$DEPLOYER" --authority "$REHEARSAL_GOVERNANCE_PK"
node "$DEVNET_DIR/protocol_admin.mjs" init-vault   --allow-local-validator --url "$URL" --deployer "$DEPLOYER" --authority "$REHEARSAL_GOVERNANCE_PK"

echo "== [5/6] emergency-control drills (governance is the authority) =="
node "$DEVNET_DIR/protocol_admin.mjs" drill --allow-local-validator --url "$URL" --program scanner \
  --authority "$GOVERNANCE" --intruder "$INTRUDER"
node "$DEVNET_DIR/protocol_admin.mjs" drill --allow-local-validator --url "$URL" --program vault \
  --authority "$GOVERNANCE" --intruder "$INTRUDER"

echo "== [6/6] register the dedicated oracle signers (governance signs, deployer pays) =="
node "$DEVNET_DIR/protocol_admin.mjs" register-oracle --allow-local-validator --url "$URL" \
  --authority "$GOVERNANCE" --fee-payer "$DEPLOYER" \
  --activity-oracle "$(solana-keygen pubkey "$TMP/activity_oracle.json")" \
  --launch-price-oracle "$(solana-keygen pubkey "$TMP/launch_price_oracle.json")"

echo ""
echo "NS-3 LOCAL REHEARSAL COMPLETE — deploy-at-declare_id, temporary-governance-"
echo "authority initialization (the SAME key signed init, both drills, and oracle"
echo "registration), and separate-signer oracle registration all behaved per the"
echo "NS-3 authority arrangement on both programs. All identities used were"
echo "throwaways (discarded); no owner keypair was touched; nothing was submitted"
echo "to any public cluster."
