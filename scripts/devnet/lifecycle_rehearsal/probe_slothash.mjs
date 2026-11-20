#!/usr/bin/env node
// probe_slothash.mjs — F1 regression probe (was: F1 evidence probe).
// F1 REMEDIATED SDK-side (fetchSlotHash/fetchRecentSlotHash now read the
// canonical SlotHashes sysvar — see sdk/src/lastSwapAttestation.ts). This
// probe now proves the fix against a live validator, with an INDEPENDENT
// raw read: it fetches the sysvar account bytes itself (canonical address,
// finalized commitment), parses them with the canonical SDK parser
// (parseSlotHashesAccount), and checks that:
//   1. SDK.fetchSlotHash(slot) returns byte-exactly the serialized entry
//      for that slot — for the newest entry AND an older entry;
//   2. SDK.fetchRecentSlotHash() returns the newest entry's slot and hash
//      together as one pair (no slot manufacture, no hash substitution);
//   3. a slot absent from the sysvar resolves to null (no nearby-slot
//      substitution).
// Any mismatch here reverts 6030 (AttestationSlotHashMismatch) on phase_1.
// Exit code 0 = regression gate passed; 1 = mismatch/absence; 2 = usage.
import { initWeb3, getWeb3, importSdk } from "./lib.mjs";

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

// Independent raw read of the canonical sysvar, finalized commitment.
const info = await connection.getAccountInfo(
  SDK.SYSVAR_SLOT_HASHES_PUBKEY ?? new W3.PublicKey("SysvarS1otHashes111111111111111111111111111"),
  "finalized",
);
if (!info) {
  console.error("SlotHashes sysvar account absent — cannot probe");
  process.exit(1);
}
const entries = SDK.parseSlotHashesAccount(info.data);
if (entries.length === 0) {
  console.error("SlotHashes sysvar has no entries — cannot probe");
  process.exit(1);
}
const hex = (u8) => Buffer.from(u8).toString("hex");
const newest = entries[0];
const oldest = entries[entries.length - 1];

const sdkNewest = await SDK.fetchSlotHash(connection, newest.slot);
const sdkOldest = entries.length > 1 ? await SDK.fetchSlotHash(connection, oldest.slot) : sdkNewest;
const recent = await SDK.fetchRecentSlotHash(connection);
const absent = await SDK.fetchSlotHash(connection, newest.slot + 1);

const verdict = {
  probed_entries: entries.length,
  newest: { slot: newest.slot, sysvar_hash_hex: hex(newest.hash) },
  oldest: { slot: oldest.slot, sysvar_hash_hex: hex(oldest.hash) },
  sdk_fetchSlotHash_newest_hex: sdkNewest ? hex(sdkNewest) : null,
  sdk_fetchSlotHash_oldest_hex: sdkOldest ? hex(sdkOldest) : null,
  sdk_fetchRecentSlotHash: recent ? { slot: recent.slot, hash_hex: hex(recent.hash) } : null,
  sdk_absent_slot: newest.slot + 1,
  sdk_absent_slot_result: absent === null ? "null (correct)" : hex(absent),
  exact_pair_binding:
    recent !== null && recent.slot === newest.slot && hex(recent.hash) === hex(newest.hash),
  newest_equal: sdkNewest !== null && hex(sdkNewest) === hex(newest.hash),
  oldest_equal: sdkOldest !== null && hex(sdkOldest) === hex(oldest.hash),
  absent_null: absent === null,
  verdict_text:
    "PASS: SDK.fetchSlotHash equals the serialized SlotHashes entry for every probed slot, " +
    "SDK.fetchRecentSlotHash returns the newest (slot, hash) pair exactly, and an absent slot resolves null — " +
    "the SDK-sourced attestation anchors to the SYSVAR pair (6030 impossible unless the entry ages out first)",
};
const pass =
  verdict.exact_pair_binding && verdict.newest_equal && verdict.oldest_equal && verdict.absent_null;
verdict.verdict_text = pass
  ? verdict.verdict_text
  : "FAIL: SDK SlotHashes retrieval diverges from the serialized sysvar entries — do not submit attestations";
console.log(JSON.stringify(verdict, null, 2));
if (args.out) {
  const fs = await import("node:fs");
  fs.writeFileSync(args.out, JSON.stringify(verdict, null, 2) + "\n");
}
process.exit(pass ? 0 : 1);
