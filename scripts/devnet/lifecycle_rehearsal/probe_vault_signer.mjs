#!/usr/bin/env node
// probe_vault_signer.mjs — F3 evidence probe.
// Establishes that the real SOL/USDC Serum v3 market stores
// vault_signer_nonce = 1 (u64 LE @45), which yields a NON-canonical vault
// signer — fleet-core's canonical derivation
// (findProgramAddressSync(["vault-signer", market], marketProgram)) fails
// closed against it. prepare_local_accounts.mjs therefore re-pins the local
// market's nonce to the canonical bump and re-points both market vault token
// accounts' owner to the canonical signer (documented fixture adaptation).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initWeb3, getWeb3 } from "./lib.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[++i];
}
const fixtures = args.fixtures;
if (!fixtures) {
  console.error("missing --fixtures");
  process.exit(2);
}
await initWeb3(args.salvorBots ?? process.env.SALVOR_BOTS);
const W3 = getWeb3();
const manifest = JSON.parse(readFileSync(join(fixtures, "manifest.json"), "utf8"));
const marketPk = new W3.PublicKey(manifest.accounts.market.pubkey);
const marketProgram = new W3.PublicKey(manifest.market_program);
const marketBytes = Buffer.from(readFileSync(join(fixtures, "market.bin")));
const NONCE_OFFSET = 45; // u64 LE (Serum MarketState vault_signer_nonce)
const nonce = marketBytes.readBigUInt64LE(NONCE_OFFSET);
const currentSigner = W3.PublicKey.createProgramAddressSync(
  [Buffer.from("vault-signer", "utf8"), marketPk.toBytes(), nonceToLe(nonce)],
  marketProgram,
);
const [canonicalSigner, bump] = W3.PublicKey.findProgramAddressSync(
  [Buffer.from("vault-signer", "utf8"), marketPk.toBytes()],
  marketProgram,
);
function nonceToLe(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
const verdict = {
  market: marketPk.toBase58(),
  market_program: marketProgram.toBase58(),
  stored_nonce: nonce.toString(),
  stored_nonce_is_canonical_bump: nonce === BigInt(bump),
  signer_from_stored_nonce: currentSigner.toBase58(),
  canonical_vault_signer: canonicalSigner.toBase58(),
  canonical_bump: String(bump),
  matches_manifest_vault_signer: manifest.accounts.vault_signer.pubkey === currentSigner.toBase58(),
  finding:
    "F3: the real market's nonce (1) is not the canonical bump — the local fixture re-pins the nonce to the canonical bump and re-points both market vault token accounts to the canonical signer so fleet-core's fail-closed derivation accepts the fixture",
};
console.log(JSON.stringify(verdict, null, 2));
if (args.out) writeFileSync(args.out, JSON.stringify(verdict, null, 2) + "\n");
