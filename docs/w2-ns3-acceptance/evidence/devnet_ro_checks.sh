#!/usr/bin/env bash
# Read-only Devnet RPC identity checks for the W2 preflight.
# JSON-RPC POSTs only (getGenesisHash / getAccountInfo / getBalance).
# No transactions, no key material, no config mutation; the endpoint is
# passed explicitly on every call.
set -uo pipefail
RPC="https://api.devnet.solana.com"
SCANNER="EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL"
VAULT="7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya"
SCANNER_PDA="5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe"
VAULT_PDA="5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda"
DEPLOYER="cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831"
GOVERNANCE="BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5"

rpc() {
  local method="$1"; shift
  local params="$1"
  curl -sS --max-time 30 -X POST "$RPC" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
}

echo "timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "== G: getGenesisHash =="
rpc getGenesisHash "[]"
echo ""
echo "== program account existence (getAccountInfo, base64) =="
for label in SCANNER VAULT SCANNER_PDA VAULT_PDA; do
  ADDR=$(eval echo "\$$label")
  echo "-- $label $ADDR"
  rpc getAccountInfo "[\"$ADDR\",{\"encoding\":\"base64\"}]"
  echo ""
done
echo "== balances (lamports) =="
for label in DEPLOYER GOVERNANCE; do
  ADDR=$(eval echo "\$$label")
  echo "-- $label $ADDR"
  rpc getBalance "[\"$ADDR\"]"
  echo ""
done
