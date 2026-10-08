#!/usr/bin/env bash
# local_rehearsal.sh — full devnet-deployment REHEARSAL against a local
# solana-test-validator, using the EXACT production scripts:
#
#   deploy_devnet.sh  → builds both ELFs, deploys under the devnet program IDs
#   protocol_admin.mjs → initializes both ProtocolConfig PDAs, then runs the
#                        emergency-control drill (pause / intruder-reject /
#                        unpause) on both programs.
#
# This is the pre-handover proof for roadmap Phase 11 (Protocol scope): the
# devnet execution is a funded-wallet step of an already-proven sequence. The
# rehearsal runs everything the devnet run will run, minus the network.
#
# The deployer + intruder keypairs are minted into a mktemp dir and discarded;
# nothing here touches the real devnet keys outside this repo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
DEVNET_DIR="$REPO_ROOT/scripts/devnet"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/share/solana/bin:$PATH"
command -v solana-test-validator >/dev/null || { echo "solana-test-validator not on PATH" >&2; exit 2; }

TMP="$(mktemp -d /tmp/gy-rehearsal.XXXXXX)"
VALIDATOR_PID=""
cleanup() {
  if [[ -n "$VALIDATOR_PID" ]]; then kill "$VALIDATOR_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== [1/5] mint rehearsal keys =="
solana-keygen new --no-bip39-passphrase -s -o "$TMP/deployer.json" -f >/dev/null
solana-keygen new --no-bip39-passphrase -s -o "$TMP/intruder.json" -f >/dev/null
DEPLOYER="$TMP/deployer.json"
INTRUDER="$TMP/intruder.json"
# Program keypairs: reuse the canonical devnet ones if present next to the
# repo (gitignored world), else mint throwaways for this rehearsal.
KEYS_SRC="${GY_DEVNET_KEYS:-$HOME/my-project/devnet-keys}"
if [[ -f "$KEYS_SRC/grave_scanner-devnet.json" && -f "$KEYS_SRC/grave_vault-devnet.json" ]]; then
  SCANNER_KP="$KEYS_SRC/grave_scanner-devnet.json"
  VAULT_KP="$KEYS_SRC/grave_vault-devnet.json"
else
  solana-keygen new --no-bip39-passphrase -s -o "$TMP/scanner.json" -f >/dev/null
  solana-keygen new --no-bip39-passphrase -s -o "$TMP/vault.json" -f >/dev/null
  SCANNER_KP="$TMP/scanner.json"
  VAULT_KP="$TMP/vault.json"
  # The ELF embeds the devnet declare_id — a throwaway keypair would not
  # match, so the identity check in deploy_devnet.sh would (correctly) abort.
  # Mirror the canonical pubkeys into throwaway keypair files is impossible;
  # therefore the canonical keypairs are REQUIRED for a rehearsal whose ELFs
  # match the repo's declare_id.
  echo "canonical devnet keypairs not found at $KEYS_SRC — cannot rehearse with matching declare_id" >&2
  exit 2
fi
echo "deployer: $(solana-keygen pubkey "$DEPLOYER")"
echo "intruder: $(solana-keygen pubkey "$INTRUDER")"

echo "== [2/5] start solana-test-validator =="
solana-test-validator --reset --quiet --warp-slot 1 >"$TMP/validator.log" 2>&1 &
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
solana --url "$URL" airdrop 10 "$(solana-keygen pubkey "$INTRUDER")" >/dev/null

echo "== [3/5] deploy both programs via production deploy script =="
bash "$DEVNET_DIR/deploy_devnet.sh" \
  --url "$URL" \
  --scanner-keypair "$SCANNER_KP" \
  --vault-keypair "$VAULT_KP" \
  --deployer "$DEPLOYER"

echo "== [4/5] initialize both ProtocolConfigs =="
node "$DEVNET_DIR/protocol_admin.mjs" init-all --url "$URL" --deployer "$DEPLOYER"

echo "== [5/5] emergency-control drills =="
node "$DEVNET_DIR/protocol_admin.mjs" drill --url "$URL" --program scanner \
  --authority "$DEPLOYER" --intruder "$INTRUDER"
node "$DEVNET_DIR/protocol_admin.mjs" drill --url "$URL" --program vault \
  --authority "$DEPLOYER" --intruder "$INTRUDER"

echo ""
echo "REHEARSAL COMPLETE — deploy, initialize, pause, intruder-reject, and unpause all behaved per spec on both programs."
