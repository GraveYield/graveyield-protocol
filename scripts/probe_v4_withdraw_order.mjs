#!/usr/bin/env node
// Probe real mainnet Raydium V4 withdraw transactions for the SOL/USDC pool
// to extract the exact account ordering accepted by the DEPLOYED program.
import { writeFileSync } from "node:fs";
const RPC = "https://api.mainnet-beta.solana.com";
const POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
async function rpc(method, params) {
  for (let a = 1; a <= 4; a++) {
    const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * a)); continue; }
    const j = await res.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result;
  }
  throw new Error("rpc retries exhausted");
}

const sigs = await rpc("getSignaturesForAddress", [POOL, { limit: 100 }]);
console.log("signatures fetched:", sigs.length);
let found = 0;
for (const s of sigs) {
  if (found >= 3) break;
  if (s.err) continue;
  let tx;
  try { tx = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]); } catch (e) { continue; }
  if (!tx) continue;
  const logs = tx.meta.logMessages || [];
  // Raydium V4 withdraw emits ray_log with log_type=2 as the FIRST byte of the decoded payload.
  const isWithdraw = logs.some(l => {
    if (!l.startsWith("Program log: ray_log: ")) return false;
    try {
      const b = Buffer.from(l.slice("Program log: ray_log: ".length), "base64");
      return b[0] === 2;
    } catch { return false; }
  });
  if (!isWithdraw) continue;
  found++;
  console.log("\n=== WITHDRAW TX", s.signature.slice(0, 16), "===");
  const keys = tx.transaction.message.accountKeys.map(k => k.pubkey);
  const v4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
  for (const ix of tx.transaction.message.instructions) {
    const progId = ix.programId ?? keys[ix.programIdIndex];
    if (progId !== v4) continue;
    const accs = (ix.accounts ?? []).map(a => typeof a === "number" ? keys[a] : a);
    console.log("OUTER V4 ix data:", Buffer.from(ix.data, "base64").toString("hex"), "accounts:", accs.length);
    accs.forEach((k, i) => console.log(`  [${i}] ${k}`));
  }
  for (const g of (tx.meta.innerInstructions || [])) {
    for (const i2 of g.instructions) {
      const pid = i2.programId ?? keys[i2.programIdIndex];
      if (pid !== v4) continue;
      const accs2 = (i2.accounts ?? []).map(a => typeof a === "number" ? keys[a] : a);
      console.log("INNER V4 ix data:", Buffer.from(i2.data, "base64").toString("hex"), "accounts:", accs2.length);
      accs2.forEach((k, i) => console.log(`  [${i}] ${k}`));
    }
  }
  await new Promise(r => setTimeout(r, 400));
}
console.log("\ndone, withdrawals found:", found);
