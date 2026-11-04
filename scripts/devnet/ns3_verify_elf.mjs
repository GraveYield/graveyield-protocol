// SPDX-License-Identifier: Apache-2.0
//
// ns3_verify_elf.mjs — ELF embedded-identity verification (risk R-1).
//
// A compiled SBF ELF embeds the program's `declare_id!` value as its
// 32-byte Anchor `id` constant. This script proves that an ELF was built
// from a tree whose declared identity equals the expected program ID —
// the check deploy_devnet.sh runs after the keypair gate, closing the
// partial-sync window where the keypair matches the constant but the ELF
// was compiled from a stale tree (the program would deploy at the right
// address while every Anchor owner check fails at runtime).
//
// Method: search the ELF bytes for the 32-byte big-endian pubkey (raw
// binary, NOT base58 — the base58 text never appears in the binary).
// Presence of the expected ID plus ABSENCE of the legacy NS-1/NS-2 IDs is
// asserted. Zero npm dependencies (node:crypto / node:fs only).
//
// Usage:
//   node ns3_verify_elf.mjs --scanner-so <path.so> --vault-so <path.so> \
//        --scanner-id <PK> --vault-id <PK>
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

function idBytes(base58) {
  return Buffer.from(new PublicKey(base58).toBytes());
}

function contains(buf, needle) {
  return buf.indexOf(needle) !== -1;
}

const args = parseArgs(process.argv);
const targets = [
  { label: "scanner", so: args["scanner-so"], id: args["scanner-id"] },
  { label: "vault", so: args["vault-so"], id: args["vault-id"] },
];
for (const t of targets) {
  if (!t.so || !t.id) {
    console.error("missing --scanner-so/--vault-so/--scanner-id/--vault-id");
    process.exit(2);
  }
}

// Legacy identities that must NOT appear in an NS-3 build (NS-1 + NS-2).
const LEGACY = [
  ["NS-1 scanner", "5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF"],
  ["NS-1 vault", "HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6"],
  ["NS-2 scanner", "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54"],
  ["NS-2 vault", "Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg"],
];

let failed = false;
for (const t of targets) {
  let buf;
  try {
    buf = readFileSync(t.so);
  } catch (err) {
    console.error(`FAIL ${t.label}: cannot read ${t.so} (${err.code ?? err.message})`);
    failed = true;
    continue;
  }
  const want = idBytes(t.id);
  const has = contains(buf, want);
  if (!has) {
    console.error(
      `FAIL ${t.label}: embedded declare_id! ${t.id} NOT found in ${t.so} — ` +
        `stale ELF (built from a tree with different IDs?) or wrong file.`,
    );
    failed = true;
    continue;
  }
  const legacyHits = [];
  for (const [name, legacyId] of LEGACY) {
    if (contains(buf, idBytes(legacyId))) legacyHits.push(`${name} ${legacyId}`);
  }
  if (legacyHits.length > 0) {
    console.error(
      `FAIL ${t.label}: legacy identity bytes present in ${t.so}: ${legacyHits.join(", ")}`,
    );
    failed = true;
    continue;
  }
  console.log(`OK ${t.label}: embedded declare_id! ${t.id} present; no legacy NS-1/NS-2 ID bytes`);
}

process.exit(failed ? 1 : 0);
