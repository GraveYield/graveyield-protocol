#!/usr/bin/env node
// probe_vault_signer.mjs — F3 evidence probe (Finding E remediation).
//
// Establishes, against the REAL fixture bytes, which vault-signer
// derivation rule the OpenBook v1 market program actually uses — and
// documents the exact fixture adaptation the W1 harness makes for
// fleet-core compatibility.
//
// VERIFIED FACTS (re-proven on every run of this probe):
//   * The OpenBook v1 (Serum v3) rule is
//       create_program_address([market_bytes, vault_signer_nonce_le], market_program)
//     — re-derived here and required to equal the REAL vault signer that
//     fetch_v4_fork_fixtures.mjs read from the Raydium pool's own bytes
//     (and cross-checked against both market vault token accounts' owner
//     fields). The real SOL/USDC market stores nonce = 1 (u64 LE @45) and
//     that nonce IS canonical under the program's own rule.
//   * fleet-core's account-discovery pipeline derives the vault signer as
//       findProgramAddress([\"vault-signer\", market], market_program)
//     (salvor-bots fleet-core/src/raydiumAccounts.ts) — a string-seed PDA
//     scheme that matches NO real OpenBook market (the real market's vault
//     token account owners fail its fail-closed owner check).
//   * The W1 local fixture is therefore ADAPTED to fleet-core's scheme:
//     prepare_local_accounts.mjs re-pins the market's stored nonce to the
//     string-seed PDA's bump and re-points both market vault token
//     accounts' owner to that PDA. This is a fleet-core-compatibility
//     adaptation — NOT a canonicalization — and it makes the local market
//     deviate from what the real OpenBook program would validate. The
//     modified market relationship is never exercised on-chain by the W1
//     salvage (the vault's Raydium withdraw CPI marks the market vault
//     signer ignored — programs/grave-vault/src/cpi/raydium_v4.rs — and no
//     Serum CPI runs in the W1 path); the faithful CPI evidence lives in
//     the fork suite (programs/grave-vault/tests/raydium_v4_fork.rs),
//     which uses the UNMODIFIED mainnet fixture.
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
const NONCE_OFFSET = 45; // u64 LE vault_signer_nonce (5-byte "serum" head + MarketState layout)
const nonce = marketBytes.readBigUInt64LE(NONCE_OFFSET);

function nonceToLe(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

// Scheme A — the REAL OpenBook v1 rule: [market, nonce_le].
const realSchemeSigner = W3.PublicKey.createProgramAddressSync(
  [marketPk.toBytes(), nonceToLe(nonce)],
  marketProgram,
);
// Scheme B — fleet-core's string-seed PDA: ["vault-signer", market].
const [fleetCoreSigner, fleetCoreBump] = W3.PublicKey.findProgramAddressSync(
  [Buffer.from("vault-signer", "utf8"), marketPk.toBytes()],
  marketProgram,
);

const realSignerMatchesManifest =
  manifest.accounts.vault_signer.pubkey === realSchemeSigner.toBase58();
const verdict = {
  market: marketPk.toBase58(),
  market_program: marketProgram.toBase58(),
  stored_nonce: nonce.toString(),
  real_program_rule: {
    derivation: "create_program_address([market, nonce_le], market_program)",
    signer_from_stored_nonce: realSchemeSigner.toBase58(),
    matches_manifest_vault_signer: realSignerMatchesManifest,
  },
  fleet_core_rule: {
    derivation: 'find_program_address(["vault-signer", market], market_program)',
    signer: fleetCoreSigner.toBase58(),
    bump: fleetCoreBump,
    matches_manifest_vault_signer:
      manifest.accounts.vault_signer.pubkey === fleetCoreSigner.toBase58(),
  },
  finding: realSignerMatchesManifest
    ? "the real market's stored nonce IS canonical under the real OpenBook rule; fleet-core's string-seed derivation is the mismatch — the W1 fixture re-pin is a fleet-core-compatibility adaptation (documented deviation), not a canonicalization"
    : "UNEXPECTED: the real-program derivation did not reproduce the manifest vault signer — investigate before trusting the fixture",
};

console.log(JSON.stringify(verdict, null, 2));
if (args.out) writeFileSync(args.out, JSON.stringify(verdict, null, 2) + "\n");
// Hard gate: the real program's rule must reproduce the manifest signer.
// (The fetcher already cross-proved the manifest signer against the
// Raydium pool bytes AND both market vault owners' owner fields.)
if (!realSignerMatchesManifest) {
  console.error("probe_vault_signer: REAL-SCHEME DERIVATION MISMATCH — fixture provenance broken");
  process.exit(1);
}
