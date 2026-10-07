#!/usr/bin/env node
// scripts/fetch_v4_fork_fixtures.mjs — Phase 2.1 fork-harness fixture fetcher.
//
// Pulls REAL mainnet Raydium V4 state + program ELFs for the
// solana-program-test fork harness (programs/grave-vault/tests/raydium_v4_fork.rs).
// Every account is cross-validated against the authoritative layouts before it
// is written; the script fails loudly on any mismatch:
//
//   - AmmInfo (752 bytes, raydium-amm program/src/state.rs):
//       coin_vault@336 pc_vault@368 coin_mint@400 pc_mint@432 lp_mint@464
//       open_orders@496 market@528 market_program@560 target_orders@592
//       padding1@624 amm_owner@688 lp_amount@720
//     (336..464 are the scanner-proven offsets; 496..592 match the raydium-amm
//     `AmmInfo` struct field order and are cross-proved below)
//   - Serum MarketState (5-byte "serum" head padding, project-serum/serum-dex
//     dex/src/state.rs): coin_mint@53 pc_mint@85 coin_vault@117 pc_vault@165
//     event_q@253 bids@285 asks@317 (absolute offsets in account data)
//   - open_orders / market / bids / asks / event queue are owned by the
//     market program; target_orders is owned by the Raydium V4 program
//   - both serum vault token accounts share one owner == the market vault
//     signer PDA (no on-chain account — recorded in the manifest only)
//
// Usage:  node scripts/fetch_v4_fork_fixtures.mjs
// Env:    RPC_URL (default https://api.mainnet-beta.solana.com)
// Output: programs/grave-vault/tests/fixtures/{*.bin, manifest.json}
//
// Fixtures are intentionally gitignored (several MB of program ELFs); the
// fork tests skip with a clear message when they are absent.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "programs", "grave-vault", "tests", "fixtures");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const RAYDIUM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

// CPI-009's named example pool is a CLMM account (owner LBUZKh...), not V4;
// the canonical Raydium SOL/USDC V4 pool is used instead and the checklist
// example is corrected in the CPI-009 retirement entry.
const POOL_CANDIDATES = [
  "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
];

// ---------------------------------------------------------------- base58
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes) {
  if (bytes.length === 0) return "";
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (let i = 0; bytes[i] === 0 && i < bytes.length - 1; i++) digits.push(0);
  return digits.reverse().map((d) => B58[d]).join("");
}
function b58decode(s) {
  const bytes = [];
  let zeros = 0;
  for (let i = 0; i < s.length && s[i] === "1"; i++) zeros++;
  for (const ch of s) {
    const val = B58.indexOf(ch);
    if (val < 0) throw new Error(`bad base58 char ${ch}`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < zeros; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

// ---------------------------------------------------------------- rpc
let callCount = 0;
async function rpc(method, params) {
  callCount++;
  if (callCount > 1) await new Promise((r) => setTimeout(r, 350));
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res;
    try {
      res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (e) {
      if (attempt === 4) throw new Error(`RPC fetch failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 4) throw new Error(`RPC ${method} HTTP ${res.status} after retries`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    const json = await res.json();
    if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
    return json.result;
  }
}

async function getAccount(addr) {
  const r = await rpc("getAccountInfo", [addr, { encoding: "base64" }]);
  if (!r || !r.value) return null;
  return {
    pubkey: addr,
    lamports: r.value.lamports,
    owner: r.value.owner,
    data: Buffer.from(r.value.data[0], "base64"),
  };
}

// ---------------------------------------------------------------- readers
function u64le(buf, off) {
  return BigInt.asUintN(64, buf.readBigUInt64LE(off));
}
function pk(buf, off) {
  return b58encode(buf.subarray(off, off + 32));
}
function locate(hay, pubkeyStr) {
  return hay.indexOf(b58decode(pubkeyStr));
}

// ---------------------------------------------------------------- program ELF
async function getProgramElf(programId, label) {
  const prog = await getAccount(programId);
  if (!prog) throw new Error(`${label} program ${programId} not found`);
  if (prog.data.length > 1024 && prog.data[0] === 0x7f) {
    console.log(`  ${label}: direct ELF ${prog.data.length} bytes`);
    return prog.data;
  }
  if (prog.data.length < 36) throw new Error(`${label}: program account too small (${prog.data.length})`);
  // Upgradeable loader Program layout: [u32 variant][programdata pubkey] = 36 bytes.
  const dataAddr = pk(prog.data, 4);
  const dataAcct = await getAccount(dataAddr);
  if (!dataAcct) throw new Error(`${label}: programdata ${dataAddr} not found`);
  let off = -1;
  for (let i = 0; i < 256; i++) {
    if (dataAcct.data[i] === 0x7f && dataAcct.data[i + 1] === 0x45 && dataAcct.data[i + 2] === 0x4c && dataAcct.data[i + 3] === 0x46) { off = i; break; }
  }
  if (off < 0) throw new Error(`${label}: no ELF magic in programdata`);
  console.log(`  ${label}: ELF @ programdata+${off} (${dataAcct.data.length - off} bytes, programdata ${dataAddr})`);
  return dataAcct.data.subarray(off);
}

// ---------------------------------------------------------------- AmmInfo
const AMM = {
  STATUS: 0, STATE: 48, LP_AMOUNT: 720,
  COIN_VAULT: 336, PC_VAULT: 368, COIN_MINT: 400, PC_MINT: 432, LP_MINT: 464,
  OPEN_ORDERS: 496, MARKET: 528, MARKET_PROGRAM: 560, TARGET_ORDERS: 592,
};

async function loadPool(poolAddr) {
  console.log(`\n=== candidate pool ${poolAddr} ===`);
  const pool = await getAccount(poolAddr);
  if (!pool) throw new Error("pool account not found");
  if (pool.owner !== RAYDIUM_V4) throw new Error(`pool owner ${pool.owner} != Raydium V4`);
  if (pool.data.length !== 752) throw new Error(`pool size ${pool.data.length} != 752`);

  const status = u64le(pool.data, AMM.STATUS);
  const state = u64le(pool.data, AMM.STATE);
  const lpAmount = u64le(pool.data, AMM.LP_AMOUNT);
  const coinVault = pk(pool.data, AMM.COIN_VAULT);
  const pcVault = pk(pool.data, AMM.PC_VAULT);
  const coinMint = pk(pool.data, AMM.COIN_MINT);
  const pcMint = pk(pool.data, AMM.PC_MINT);
  const lpMint = pk(pool.data, AMM.LP_MINT);
  const openOrders = pk(pool.data, AMM.OPEN_ORDERS);
  const market = pk(pool.data, AMM.MARKET);
  const marketProgram = pk(pool.data, AMM.MARKET_PROGRAM);
  const targetOrders = pk(pool.data, AMM.TARGET_ORDERS);
  console.log(`  status=${status} state=${state} lpAmount=${lpAmount}`);
  console.log(`  coinVault=${coinVault}\n  pcVault=${pcVault}\n  coinMint=${coinMint}\n  pcMint=${pcMint}\n  lpMint=${lpMint}`);
  console.log(`  openOrders=${openOrders}\n  market=${market}\n  marketProgram=${marketProgram}\n  targetOrders=${targetOrders}`);

  const [coinVaultA, pcVaultA, coinMintA, pcMintA, lpMintA, openOrdersA, marketA, targetOrdersA] =
    await Promise.all([coinVault, pcVault, coinMint, pcMint, lpMint, openOrders, market, targetOrders].map(getAccount));

  // ---- AmmInfo cross-proofs
  if (coinVaultA.owner !== TOKEN_PROGRAM || pcVaultA.owner !== TOKEN_PROGRAM)
    throw new Error("pool vaults not owned by SPL token program (offsets 336/368 wrong?)");
  if (pk(coinVaultA.data, 0) !== coinMint) throw new Error("coinVault.mint != pool.coinMint");
  if (pk(pcVaultA.data, 0) !== pcMint) throw new Error("pcVault.mint != pool.pcMint");
  for (const [n, a] of [["coinMint", coinMintA], ["pcMint", pcMintA], ["lpMint", lpMintA]]) {
    if (a.owner !== TOKEN_PROGRAM) throw new Error(`${n} not owned by SPL token program`);
  }
  if (lpMintA.data.length !== 82) throw new Error(`lpMint size ${lpMintA.data.length} != 82`);

  let baseIsCoinSide;
  if (coinMint === WSOL && pcMint !== WSOL) baseIsCoinSide = true;
  else if (pcMint === WSOL && coinMint !== WSOL) baseIsCoinSide = false;
  else throw new Error(`neither/both side is WSOL: coin=${coinMint} pc=${pcMint}`);

  // ---- serum market cross-proofs (market_program stored in AmmInfo@560 must
  // own the market account; open orders + target orders owners follow suit)
  if (marketA.owner !== marketProgram) throw new Error(`market.owner ${marketA.owner} != pool.marketProgram (offset 528/560 wrong?)`);
  if (openOrdersA.owner !== marketProgram) throw new Error(`openOrders.owner != marketProgram (offset 496 wrong?)`);
  if (targetOrdersA.owner !== RAYDIUM_V4) throw new Error(`targetOrders.owner ${targetOrdersA.owner} != Raydium V4 (offset 592 wrong?)`);

  // ---- Serum MarketState parse (5-byte "serum" head padding)
  if (marketA.data.subarray(0, 5).toString() !== "serum") throw new Error("market account missing 'serum' head padding");
  const M = { COIN_MINT: 53, PC_MINT: 85, COIN_VAULT: 117, PC_VAULT: 165, EVENT_Q: 253, BIDS: 285, ASKS: 317 };
  const mCoinMint = pk(marketA.data, M.COIN_MINT);
  const mPcMint = pk(marketA.data, M.PC_MINT);
  const mCoinVault = pk(marketA.data, M.COIN_VAULT);
  const mPcVault = pk(marketA.data, M.PC_VAULT);
  const eventQueue = pk(marketA.data, M.EVENT_Q);
  const bids = pk(marketA.data, M.BIDS);
  const asks = pk(marketA.data, M.ASKS);
  console.log(`  serum market: coinMint=${mCoinMint} pcMint=${mPcMint}\n  serum coinVault=${mCoinVault} pcVault=${mPcVault}\n  eventQ=${eventQueue} bids=${bids} asks=${asks}`);
  const mintsSet = new Set([coinMint, pcMint]);
  if (!mintsSet.has(mCoinMint) || !mintsSet.has(mPcMint)) throw new Error("serum market mints != pool mints (market layout wrong?)");

  const [mCoinVaultA, mPcVaultA, eventQueueA, bidsA, asksA] = await Promise.all(
    [mCoinVault, mPcVault, eventQueue, bids, asks].map(getAccount));
  for (const [n, a] of [["serum coinVault", mCoinVaultA], ["serum pcVault", mPcVaultA]]) {
    if (a.owner !== TOKEN_PROGRAM) throw new Error(`${n} not a token account`);
  }
  if (pk(mCoinVaultA.data, 0) !== mCoinMint) throw new Error("serum coinVault.mint mismatch");
  if (pk(mPcVaultA.data, 0) !== mPcMint) throw new Error("serum pcVault.mint mismatch");
  const vaultSigner = pk(mCoinVaultA.data, 32);
  if (pk(mPcVaultA.data, 32) !== vaultSigner) throw new Error("serum vault owners disagree (vault signer derivation failed)");
  console.log(`  marketVaultSigner=${vaultSigner} (read from vault owner fields)`);
  for (const [n, a] of [["eventQueue", eventQueueA], ["bids", bidsA], ["asks", asksA]]) {
    if (a.owner !== marketProgram) throw new Error(`${n}.owner != marketProgram (serum layout wrong?)`);
  }

  // CPI mapping by mint (orientation-agnostic): the vault's remaining
  // accounts 7/8 must carry the serum vaults matching the AMM's coin/pc
  // mints respectively.
  const marketCoinVault = mCoinMint === coinMint ? mCoinVault : mPcVault;
  const marketPcVault = mCoinMint === coinMint ? mPcVault : mCoinVault;

  // ---- reserves / supply
  const coinReserve = u64le(coinVaultA.data, 64);
  const pcReserve = u64le(pcVaultA.data, 64);
  const lpSupply = u64le(lpMintA.data, 36);
  console.log(`  coinReserve=${coinReserve} pcReserve=${pcReserve} lpSupply=${lpSupply}`);
  if (lpSupply === 0n) throw new Error("lpSupply == 0");
  // NOTE: amm.lp_amount can legitimately exceed mint supply — direct holder
  // burns decrement supply but not the pool's tracked amount (this is exactly
  // the LP-incineration scenario GraveYield targets). Only zero is invalid;
  // withdraw additionally requires amount < amm.lp_amount (enforced on-chain).
  if (lpAmount === 0n) throw new Error("amm.lp_amount == 0");

  const lpAmountPlan = lpSupply / 10_000n; // 0.01% of supply
  const coinOut = (coinReserve * lpAmountPlan) / lpSupply;
  const pcOut = (pcReserve * lpAmountPlan) / lpSupply;
  console.log(`  planned LP burn = ${lpAmountPlan}; expected coinOut=${coinOut} pcOut=${pcOut}`);
  const baseOut = baseIsCoinSide ? coinOut : pcOut;
  const memecoinOut = baseIsCoinSide ? pcOut : coinOut;
  if (baseOut === 0n || memecoinOut === 0n) throw new Error("expected withdraw rounds to 0 on one side — V4 rejects zero outputs");

  return {
    pool, coinVaultA, pcVaultA, coinMintA, pcMintA, lpMintA, openOrdersA, marketA,
    targetOrdersA, mCoinVaultA, mPcVaultA, eventQueueA, bidsA, asksA,
    parsed: {
      status: status.toString(), state: state.toString(), amm_lp_amount: lpAmount.toString(),
      coinVault, pcVault, coinMint, pcMint, lpMint, openOrders, market, marketProgram,
      targetOrders, marketCoinVault, marketPcVault, vaultSigner, eventQueue, bids, asks,
      baseIsCoinSide, coinReserve: coinReserve.toString(), pcReserve: pcReserve.toString(),
      lpSupply: lpSupply.toString(), coinDecimals: coinMintA.data[44], pcDecimals: pcMintA.data[44],
      lpDecimals: lpMintA.data[44], lpAmountPlan: lpAmountPlan.toString(),
      expectedCoinOut: coinOut.toString(), expectedPcOut: pcOut.toString(),
    },
  };
}

// ---------------------------------------------------------------- main
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  let loaded = null;
  const tried = [];
  for (const candidate of POOL_CANDIDATES) {
    try {
      loaded = await loadPool(candidate);
      tried.push({ pool: candidate, ok: true });
      break;
    } catch (e) {
      console.log(`  REJECT: ${e.message}`);
      tried.push({ pool: candidate, ok: false, reason: e.message });
    }
  }
  if (!loaded) throw new Error("no candidate pool passed validation");
  const {
    pool, coinVaultA, pcVaultA, coinMintA, pcMintA, lpMintA, openOrdersA, marketA,
    targetOrdersA, mCoinVaultA, mPcVaultA, eventQueueA, bidsA, asksA, parsed,
  } = loaded;

  console.log("\n=== fetching program ELFs ===");
  const v4Elf = await getProgramElf(RAYDIUM_V4, "raydium_v4");
  const serumElf = await getProgramElf(parsed.marketProgram, "serum_dex");
  const tokenElf = await getProgramElf(TOKEN_PROGRAM, "spl_token");
  const ataElf = await getProgramElf(ATA_PROGRAM, "spl_ata");
  const wsolMintA = await getAccount(WSOL);
  if (!wsolMintA) throw new Error("WSOL mint not found");
  // The market vault-signer PDA holds a real (system-owned, 0-data) account
  // on mainnet — the withdraw tx passes it, so it must exist in the VM.
  const vaultSignerA = await getAccount(parsed.vaultSigner);
  if (!vaultSignerA) throw new Error("market vault signer account not found on mainnet");

  const files = {
    "raydium_v4.so": v4Elf, "serum_dex.so": serumElf, "spl_token.so": tokenElf, "spl_ata.so": ataElf,
    "pool.bin": pool.data, "coin_vault.bin": coinVaultA.data, "pc_vault.bin": pcVaultA.data,
    "coin_mint.bin": coinMintA.data, "pc_mint.bin": pcMintA.data, "lp_mint.bin": lpMintA.data,
    "wsol_mint.bin": wsolMintA.data, "open_orders.bin": openOrdersA.data, "market.bin": marketA.data,
    "target_orders.bin": targetOrdersA.data, "market_coin_vault.bin": mCoinVaultA.data,
    "market_pc_vault.bin": mPcVaultA.data, "event_queue.bin": eventQueueA.data,
    "bids.bin": bidsA.data, "asks.bin": asksA.data, "vault_signer.bin": vaultSignerA.data,
  };

  const manifest = {
    _fetched_at: new Date().toISOString(),
    _rpc: RPC,
    _pools_tried: tried,
    pool_address: pool.pubkey,
    amm_program: RAYDIUM_V4,
    market_program: parsed.marketProgram,
    base_is_coin_side: parsed.baseIsCoinSide,
    wsol_mint: WSOL,
    accounts: {
      pool: { pubkey: pool.pubkey, lamports: pool.lamports, owner: pool.owner, file: "pool.bin" },
      coin_vault: { pubkey: parsed.coinVault, lamports: coinVaultA.lamports, owner: coinVaultA.owner, file: "coin_vault.bin" },
      pc_vault: { pubkey: parsed.pcVault, lamports: pcVaultA.lamports, owner: pcVaultA.owner, file: "pc_vault.bin" },
      coin_mint: { pubkey: parsed.coinMint, lamports: coinMintA.lamports, owner: coinMintA.owner, file: "coin_mint.bin" },
      pc_mint: { pubkey: parsed.pcMint, lamports: pcMintA.lamports, owner: pcMintA.owner, file: "pc_mint.bin" },
      lp_mint: { pubkey: parsed.lpMint, lamports: lpMintA.lamports, owner: lpMintA.owner, file: "lp_mint.bin" },
      wsol_mint: { pubkey: WSOL, lamports: wsolMintA.lamports, owner: wsolMintA.owner, file: "wsol_mint.bin" },
      open_orders: { pubkey: parsed.openOrders, lamports: openOrdersA.lamports, owner: openOrdersA.owner, file: "open_orders.bin" },
      market: { pubkey: parsed.market, lamports: marketA.lamports, owner: marketA.owner, file: "market.bin" },
      target_orders: { pubkey: parsed.targetOrders, lamports: targetOrdersA.lamports, owner: targetOrdersA.owner, file: "target_orders.bin" },
      market_coin_vault: { pubkey: parsed.marketCoinVault, lamports: mCoinVaultA.lamports, owner: mCoinVaultA.owner, file: "market_coin_vault.bin" },
      market_pc_vault: { pubkey: parsed.marketPcVault, lamports: mPcVaultA.lamports, owner: mPcVaultA.owner, file: "market_pc_vault.bin" },
      event_queue: { pubkey: parsed.eventQueue, lamports: eventQueueA.lamports, owner: eventQueueA.owner, file: "event_queue.bin" },
      bids: { pubkey: parsed.bids, lamports: bidsA.lamports, owner: bidsA.owner, file: "bids.bin" },
      asks: { pubkey: parsed.asks, lamports: asksA.lamports, owner: asksA.owner, file: "asks.bin" },
      vault_signer: { pubkey: parsed.vaultSigner, lamports: vaultSignerA.lamports, owner: vaultSignerA.owner, file: "vault_signer.bin" },
    },
    parsed,
    // The 12 pool-derived remaining accounts in vault CPI order (ra_idx 1..12).
    // Index 0 (amm_authority) is the hardcoded constant, not fetched.
    v4_remaining_accounts: [
      parsed.openOrders, parsed.targetOrders, parsed.coinVault, parsed.pcVault,
      parsed.marketProgram, parsed.market, parsed.marketCoinVault, parsed.marketPcVault,
      parsed.vaultSigner, parsed.eventQueue, parsed.bids, parsed.asks,
    ],
  };

  for (const [name, data] of Object.entries(files)) {
    writeFileSync(join(OUT_DIR, name), data);
    console.log(`  wrote ${name} (${data.length} bytes)`);
  }
  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nmanifest.json written — ${callCount} RPC calls total`);
  console.log(`POOL USED: ${pool.pubkey} (baseIsCoinSide=${parsed.baseIsCoinSide})`);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
