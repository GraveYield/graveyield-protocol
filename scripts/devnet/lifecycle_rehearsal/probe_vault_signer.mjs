#!/usr/bin/env node
// probe_vault_signer.mjs — F3 evidence probe (Finding E remediation).
//
// Establishes, against the REAL fixture bytes, which vault-signer
// derivation rule the OpenBook v1 market program actually uses — and
// records the (retired) W1 fixture-adaptation history.
//
// VERIFIED FACTS (re-proven on every run of this probe):
//   * The OpenBook v1 (Serum v3) rule is
//       create_program_address([market_bytes, vault_signer_nonce_le], market_program)
//     — re-derived here and required to equal the REAL vault signer that
//     fetch_v4_fork_fixtures.mjs read from the Raydium pool's own bytes
//     (and cross-checked against both market vault token accounts' owner
//     fields). The real SOL/USDC market stores nonce = 1 (u64 LE @45) and
//     that nonce IS canonical under the program's own rule.
//   * fleet-core's account-discovery pipeline (salvor-bots
//     fleet-core/src/raydiumAccounts.ts) derives the vault signer with that
//     SAME real rule since the salvor-side Finding E remediation
//     (ns3/devnet-preparation): the fail-closed discovery validates the
//     stored nonce, the derived signer, and the vault owners. The historical
//     string-seed PDA scheme (findProgramAddress(["vault-signer", market]))
//     is recorded here for contrast only — it matches NO real OpenBook
//     market and is no longer used by fleet-core.
//   * CONSEQUENCE FOR THE W1 FIXTURE: the local market loads UNMODIFIED —
//     the October-era re-pin adaptation (stored nonce → string-seed bump +
//     re-pointed market vault owners) is RETIRED. prepare_local_accounts.mjs
//     hard-asserts the real-rule derivation on every run.
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
// Scheme B — HISTORICAL (retired) fleet-core string-seed PDA: ["vault-signer", market].
// Recorded for contrast only — fleet-core no longer derives with it.
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
    ? "the real market's stored nonce IS canonical under the real OpenBook rule, and fleet-core (since the salvor-side Finding E remediation) derives with that same rule — the W1 local market loads UNMODIFIED; the October-era string-seed re-pin adaptation is retired"
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
