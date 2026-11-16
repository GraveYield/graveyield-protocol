#!/usr/bin/env bash
# diagnostics/setup_fixtures.sh — prepare OUT-OF-REPO reproduction fixtures.
# Runs entirely outside the repository tree; never modifies repo files.
set -euo pipefail
REPO=/home/z/my-project/repo
ENV=/home/z/my-project/repro-env
mkdir -p "$ENV/checker" "$ENV/fixtures"

# 1. Byte-identical copies of the checker chain (sha256 recorded for evidence).
cp "$REPO/scripts/devnet/ns3_check_provenance.mjs" "$ENV/checker/"
cp "$REPO/scripts/devnet/ns3_verify_elf.mjs"       "$ENV/checker/"
echo "=== sha256 repo originals vs copies ==="
sha256sum "$REPO/scripts/devnet/ns3_check_provenance.mjs" "$ENV/checker/ns3_check_provenance.mjs"
sha256sum "$REPO/scripts/devnet/ns3_verify_elf.mjs"       "$ENV/checker/ns3_verify_elf.mjs"

# 2. Synthetic platform-tools tarballs (content irrelevant — only the digest
#    comparison is exercised; sizes chosen to span memory-pressure regimes).
if [[ ! -f "$ENV/fixtures/tiny.tar.bz2" ]]; then
  head -c 4096 /dev/urandom > "$ENV/fixtures/tiny.tar.bz2"
fi
if [[ ! -f "$ENV/fixtures/big.tar.bz2" ]]; then
  head -c 268435456 /dev/urandom > "$ENV/fixtures/big.tar.bz2"   # 256 MB
fi

# 3. Synthetic manifests pinning the synthetic tarball digests.
for size in tiny big; do
  SHA=$(sha256sum "$ENV/fixtures/$size.tar.bz2" | cut -d' ' -f1)
  cat > "$ENV/fixtures/manifest.$size.json" <<EOF
{
  "schema": "graveyield.provenance/1",
  "programs": {
    "grave_scanner": { "artifact": "target/deploy/grave_scanner.so", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
    "grave_vault":   { "artifact": "target/deploy/grave_vault.so",   "sha256": "0000000000000000000000000000000000000000000000000000000000000000" }
  },
  "toolchain": {
    "sbpf_arch": "v0",
    "elf": { "e_machine": 263, "e_flags": 0 },
    "solana_cli": "3.0.10",
    "platform_tools": { "version": "1.54-synth-$size", "sha256": "$SHA", "url": "https://example.invalid/synth.tar.bz2" }
  }
}
EOF
done
echo "=== fixtures ready ==="; ls -la "$ENV/fixtures"
