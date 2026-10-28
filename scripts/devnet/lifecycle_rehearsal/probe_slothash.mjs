#!/usr/bin/env node
// probe_slothash.mjs — F1 evidence probe.
// Establishes, against a live local validator, that SDK.fetchSlotHash's
// getBlock(slot).blockhash NEVER equals the SlotHashes sysvar entry on
// agave 3.0.10 — which is why the harness reads canonical (slot,hash) pairs
// from the sysvar itself (lib.readSlotHashesEntry) and feeds those to the
// 112B C1 attestation. An SDK-sourced hash reverts 6030 on phase_1.
import { readFileSync } from "node:fs";
import { initWeb3, getWeb3, importSdk, readSlotHashesEntry } from "./lib.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[++i];
}
const url = args.url ?? "http://127.0.0.1:8899";
const salvorBots = args.salvorBots ?? process.env.SALVOR_BOTS;
if (!salvorBots) {
  console.error("missing --salvorBots (or SALVOR_BOTS env)");
  process.exit(2);
}
await initWeb3(salvorBots);
const W3 = getWeb3();
const SDK = await importSdk();
const connection = new W3.Connection(url, "confirmed");

const tip = Number(await connection.getSlot());
const slot = Math.max(1, tip - 4);
const sdkHash = await SDK.fetchSlotHash(connection, slot);
const sysvarHash = await readSlotHashesEntry(connection, slot);
const sdkHex = sdkHash ? Buffer.from(sdkHash).toString("hex") : null;
const sysHex = sysvarHash ? Buffer.from(sysvarHash).toString("hex") : null;
const verdict = {
  slot,
  sdk_fetchSlotHash_hex: sdkHex,
  sysvar_SlotHashes_hex: sysHex,
  equal: sdkHex !== null && sdkHex === sysHex,
  finding: "F1: getBlock(slot).blockhash never equals the SlotHashes sysvar entry on agave 3.0.10 — the attestation must anchor to the SYSVAR pair (6030 otherwise)",
};
console.log(JSON.stringify(verdict, null, 2));
if (args.out) {
  const fs = await import("node:fs");
  fs.writeFileSync(args.out, JSON.stringify(verdict, null, 2) + "\n");
}
