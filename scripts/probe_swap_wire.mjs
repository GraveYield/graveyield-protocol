#!/usr/bin/env node
// Phase 3 wire probe: capture the REAL mainnet Raydium V4 swapBaseIn
// (tag 11, 17-byte data) account ordering + writability flags so the
// jupiter_v6_stub fork program can replicate the exact CPI the deployed
// V4 program accepts (mirrors the 2.1 withdraw-probe methodology).
import { writeFileSync } from "node:fs";

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const RAYDIUM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const POOLS = [
  "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", // SOL/USDC (coin=WSOL)
  "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA", // RAY/WSOL (pc=WSOL)
  "HVNwzt7Pxfu76KHCMQPTLuTCLTm6WnQ1esLv4eizseSv", // BONK/WSOL (pc=WSOL)
];
let calls = 0;
async function rpc(method, params) {
  calls++;
  if (calls > 1) await new Promise((r) => setTimeout(r, 120));
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (e) {
      if (attempt === 5) throw new Error(`RPC fetch failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 5) throw new Error(`RPC ${method}: HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    const json = await res.json();
    if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  }
}

for (const POOL of POOLS) {
  console.log(`\n=== pool ${POOL} ===`);
  const sigs = await rpc("getSignaturesForAddress", [POOL, { limit: 80 }]);
  console.log(`  sigs: ${sigs.length}`);
  const tagStats = new Map();
  let found = false;
  for (const s of sigs) {
    if (s.err || found) continue;
    let tx;
    try {
      tx = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 255 }]);
    } catch { continue; }
    if (!tx) continue;
    const keys = [
      ...tx.transaction.message.accountKeys.map((k) => k.pubkey),
      ...(tx.meta?.loadedAddresses?.writable ?? []),
      ...(tx.meta?.loadedAddresses?.readonly ?? []),
    ];
    const scan = (ix, where) => {
      const progId = ix.programIdIndex != null ? keys[ix.programIdIndex] : ix.programId;
      if (progId !== RAYDIUM_V4) return null;
      const data = Buffer.from(ix.data, "base64");
      const t = data[0];
      tagStats.set(t, (tagStats.get(t) ?? 0) + 1);
      if ((t !== 9 && t !== 11) || data.length !== 17) return null;
      return { where, accIdxs: ix.accounts, data, signature: s.signature };
    };
    let hit = null;
    const outer = tx.transaction.message.instructions;
    for (let i = 0; i < outer.length && !hit; i++) hit = scan(outer[i], `outer#${i}`);
    for (const g of (tx.meta?.innerInstructions ?? [])) {
      for (let i = 0; i < g.instructions.length && !hit; i++) hit = scan(g.instructions[i], `outer#${g.index} inner#${i}`);
    }
    if (!hit) continue;
    found = true;
    console.log(`  FOUND swap ${hit.where} in ${hit.signature}`);
    const h = tx.transaction.message.header;
    const numSigned = h.numRequiredSignatures;
    const numRoSigned = h.numReadonlySignedAccounts;
    const firstRo = keys.length - h.numReadonlyUnsignedAccounts;
    hit.accIdxs.forEach((ai, j) => {
      const signer = ai < numSigned;
      const writable = ai < numSigned - numRoSigned || (ai >= numSigned && ai < firstRo);
      console.log(`    ${j}: ${keys[ai]} signer=${signer} writable=${writable}`);
    });
    console.log(`  data: tag=${hit.data[0]} amountIn=${BigInt.asUintN(64, hit.data.readBigUInt64LE(1))} minOut=${BigInt.asUintN(64, hit.data.readBigUInt64LE(9))}`);
    writeFileSync("/tmp/phase3_swap_wire.json", JSON.stringify({
      signature: hit.signature, where: hit.where, pool: POOL, keys, accIdxs: hit.accIdxs,
      tag: hit.data[0], amountIn: BigInt.asUintN(64, hit.data.readBigUInt64LE(1)).toString(),
      minOut: BigInt.asUintN(64, hit.data.readBigUInt64LE(9)).toString(),
    }, null, 2));
  }
  console.log(`  V4 tags seen: ${[...tagStats.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}x${n}`).join(", ") || "none"}`);
}
console.log(`\ndone (${calls} RPC calls)`);
