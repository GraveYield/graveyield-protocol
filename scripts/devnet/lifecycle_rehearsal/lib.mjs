// lib.mjs — shared harness plumbing for the W1 Lifecycle Rehearsal.
// Rebuilt 2026-10-28 from the worklog record (Task W1-2..W1-6 fixes 1–13).
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
// scripts/devnet/lifecycle_rehearsal -> scripts/devnet -> scripts -> REPO ROOT
// (fix 2: the off-by-one resolved REPO_ROOT to scripts/ — three dirnames, not two)
export const REPO_ROOT = dirname(dirname(dirname(LIB_DIR)));

// The SDK's buildSweepDustIx lazily require()s @solana/spl-token (instructions.ts
// requireAssociatedToken) which throws "require is not defined" under ESM —
// provide the shim before any SDK import touches it (W1 fix, sdk-sync precedent).
if (typeof globalThis.require === "undefined") {
  globalThis.require = createRequire(import.meta.url);
}

// --- program ids (NS-2 identity — local ELFs are devnet dumps) -------------------
let W3M = null; // the salvor-checkout web3.js module (single instance — fix 13)

export async function initWeb3(salvorBotsPath) {
  if (W3M) return W3M;
  // Resolve web3.js exactly as the salvor workspace resolves it so PublicKey /
  // Transaction classes are the SAME identities fleet-core's instanceof checks
  // use (fix 13: dual web3.js instances broke instanceof inside the salvor SDK).
  const spec = pathToFileURL(join(salvorBotsPath, "package.json")).href;
  const resolved = import.meta.resolve("@solana/web3.js", spec);
  W3M = await import(resolved);
  return W3M;
}

function w() {
  if (!W3M) throw new Error("lib.initWeb3() not called yet");
  return W3M;
}
export const getWeb3 = w;

export function pk(s) {
  return new w().PublicKey(s);
}

export let IDS = null;
export function initIds() {
  IDS = {
    scanner: pk("CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54"),
    vault: pk("Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg"),
    raydiumV4: pk("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    uncxLocker: pk("GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo"),
    wsolMint: pk("So11111111111111111111111111111111111111112"),
  };
  return IDS;
}
export const UNCX_MARKER_SEED = Buffer.from("global_lp_tracker", "utf8");
export function uncxMarkerPda(pool) {
  return new w().PublicKey.findProgramAddressSync(
    [UNCX_MARKER_SEED, pool.toBytes()],
    IDS.uncxLocker,
  )[0];
}

// --- dynamic module loading -------------------------------------------------------
export async function importSdk() {
  return await import(pathToFileURL(join(REPO_ROOT, "sdk", "dist", "index.js")).href);
}
export async function importFleetCore(salvorBotsPath) {
  return await import(pathToFileURL(join(salvorBotsPath, "fleet-core", "dist", "index.js")).href);
}
export async function importMonitor(salvorBotsPath) {
  return await import(pathToFileURL(join(salvorBotsPath, "monitor", "dist", "index.js")).href);
}

export async function loadKeypair(path) {
  return w().Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

// --- BigInt-safe JSON (fix 4) -------------------------------------------------------
export function bigIntSafeReplacer(_k, v) {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return v;
}
export function jsonSafe(obj) {
  return JSON.stringify(obj, bigIntSafeReplacer, 2);
}
export function bigIntSafe(v) {
  return JSON.parse(JSON.stringify(v, bigIntSafeReplacer));
}

// --- run report ---------------------------------------------------------------------
export class RunReport {
  constructor(outPath, meta) {
    this.outPath = outPath;
    this.meta = meta;
    this.stages = [];
    this.adversarialCases = [];
    this.startedAt = new Date().toISOString();
    mkdirSync(dirname(outPath), { recursive: true });
  }
  stage(entry) {
    this.stages.push({ ...entry, at: new Date().toISOString() });
    this._flushLine(`stage ${entry.id} ${entry.name} → ${entry.pass ? "PASS" : "FAIL"}`);
  }
  adversarial(entry) {
    this.adversarialCases.push({ ...entry, at: new Date().toISOString() });
    this._flushLine(`adversarial ${entry.id} ${entry.name} → ${entry.pass ? "PASS" : "FAIL"}`);
  }
  event(line) {
    this._flushLine(line);
  }
  _flushLine(line) {
    console.log(line);
    try {
      appendFileSync(this.outPath.replace(/\.json$/, ".log"), line + "\n");
    } catch {}
  }
  allPass() {
    return this.stages.every((s) => s.pass) && this.adversarialCases.every((c) => c.pass);
  }
  finish(extra) {
    const doc = {
      meta: this.meta,
      started_at: this.startedAt,
      finished_at: new Date().toISOString(),
      all_pass: this.allPass(),
      stages: this.stages,
      adversarial: this.adversarialCases,
      ...extra,
    };
    writeFileSync(this.outPath, jsonSafe(doc) + "\n");
    this._flushLine(`DRIVER COMPLETE — all_pass=${doc.all_pass}`);
    return doc;
  }
}

// --- tx helpers (fixes 3, 11) ---------------------------------------------------------
// web3.js 3.x: partialSign/serialize/sign are async; createLookupTable is async
// and returns [instruction, address]. sendTx sends with skipPreflight and reads
// the confirmed transaction so FAILURES surface as {err, logs} instead of throws.
export async function sendTx(connection, ixs, signers, opts = {}) {
  const w3 = w();
  const payer = signers[0].publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  let sig;
  if (opts.viaAlt) {
    const msg = new w3.TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message([opts.altAddress]);
    const vtx = new w3.VersionedTransaction(msg);
    await vtx.sign([signers[0]]);
    sig = await connection.sendRawTransaction(vtx.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
    });
  } else {
    const tx = new w3.Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
    for (const ix of ixs) tx.add(ix);
    await tx.partialSign(...signers); // async in 3.x (fix 3)
    const raw = await tx.serialize();
    sig = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  }
  const status = await confirmSig(connection, sig, lastValidBlockHeight);
  const res = await connection.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  return {
    sig,
    slot: status.slot,
    err: (res && res.meta && res.meta.err) ?? null,
    logs: (res && res.meta && res.meta.logMessages) ?? [],
  };
}

export async function confirmSig(connection, sig, lastValidBlockHeight) {
  for (let i = 0; i < 240; i++) {
    const r = await connection.getSignatureStatuses([sig]);
    const v = r && r.value && r.value[0];
    if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) {
      if (v.err) throw new Error(`tx ${sig} failed on chain: ${JSON.stringify(bigIntSafe(v.err))}`);
      return { slot: v.slot };
    }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  throw new Error(`tx ${sig} confirmation timed out`);
}

// --- error classification (fix 5, mirrors grave-indexer classifySim) ------------------
// GraveYield custom table 6000–6034 / 7000–7021 = "custom". A foreign custom code
// on the ed25519 precompile ix = "precompile"; on a GraveYield program ix =
// "anchor-decode" (Anchor account/decoder failures like 3012 AccountNotInitialized).
const IN_TABLE = (c) => (c >= 6000 && c <= 6034) || (c >= 7000 && c <= 7021);

export function customCodeFromErr(err) {
  if (!err) return null;
  let found = null;
  const dfs = (node) => {
    if (found !== null || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(dfs);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if ((k === "Custom" || k === "custom") && v !== undefined) {
        found = Number(v);
        return;
      }
      dfs(v);
    }
  };
  dfs(err);
  return found;
}

function failingIxIndex(err) {
  if (!err || typeof err !== "object") return null;
  const ie = err.InstructionError ?? err.instructionError;
  if (Array.isArray(ie) && typeof Number(ie[0]) === "number") return Number(ie[0]);
  return null;
}

export function errFamilyFromErr(err, logs = [], ixs = null) {
  if (!err) return null;
  const code = customCodeFromErr(err);
  if (code !== null && IN_TABLE(code)) return "custom";
  const idx = failingIxIndex(err);
  if (ixs && idx !== null && ixs[idx]) {
    const pid = String(ixs[idx].programId ?? "");
    if (pid.startsWith("Ed25519SigVerify")) return "precompile";
    return "anchor-decode";
  }
  const blob = JSON.stringify(bigIntSafe(err)) + "\n" + (logs ?? []).join("\n");
  if (/ed25519|precompile|sigverify/i.test(blob)) return "precompile";
  return "anchor-decode";
}

// --- events from program logs ----------------------------------------------------------
export function eventsFromLogs(logs, names) {
  const out = {};
  for (const n of names) out[n] = (logs ?? []).some((l) => String(l).includes(n));
  return out;
}

// --- balance snapshots (zero-movement invariant) -----------------------------------------
export async function solBalance(connection, pubkey) {
  return BigInt(await connection.getBalance(pubkey));
}

export async function snapshotTokenAccounts(connection, tokenAccounts) {
  const out = {};
  for (const [label, p] of Object.entries(tokenAccounts)) {
    try {
      const b = await connection.getTokenAccountBalance(p);
      out[label] = b.value.amount;
    } catch {
      out[label] = null; // account absent
    }
  }
  return out;
}

export function snapshotDiffZero(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

// --- SLOT-HASH from the sysvar itself (fix 10 / finding F1) --------------------------------
// SDK.fetchSlotHash uses getBlock(slot).blockhash which NEVER equals the
// SlotHashes sysvar entry on agave 3.0.10 → 6030 on every SDK-sourced hash.
// The canonical (slot,hash) pairs must be read from the sysvar account.
export const SLOT_HASHES_SYSVAR = "SysvarS1otHashes111111111111111111111111111";
export async function readSlotHashesEntry(connection, slot) {
  const info = await connection.getAccountInfo(new w().PublicKey(SLOT_HASHES_SYSVAR));
  if (!info) return null;
  const data = Buffer.from(info.data);
  const target = BigInt(slot);
  for (let off = 0; off + 40 <= data.length; off += 40) {
    if (data.readBigUInt64LE(off) === target) {
      return new Uint8Array(data.subarray(off + 8, off + 40));
    }
  }
  return null;
}

// --- address lookup table (fix 11 / finding F2) ----------------------------------------------
// The salvage ix (21 named + 13 V4 remaining ≈ 1.4 kB) cannot fit the legacy
// 1232-byte packet — the SAME instructions must compile into a v0 message over a
// REAL local ALT. Created + pre-warmed once, before any zero-movement window.
export async function createAndFillAlt(connection, payer, addresses) {
  const w3 = w();
  const slot = Number(await connection.getSlot());
  let createIx, alt;
  const ret = await w3.AddressLookupTableProgram.createLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    slot,
  });
  if (Array.isArray(ret)) {
    [createIx, alt] = ret; // 3.x: async + [instruction, address] tuple (fix 3)
  } else {
    ({ instruction: createIx, address: alt } = ret);
  }
  const r = await sendTx(connection, [createIx], [payer]);
  if (r.err) throw new Error(`ALT create failed: ${JSON.stringify(bigIntSafe(r.err))}`);
  for (let i = 0; i < 60; i++) {
    const s = Number(await connection.getSlot());
    if (s > slot + 1) break;
    await new Promise((r2) => setTimeout(r2, 250));
  }
  for (let off = 0; off < addresses.length; off += 20) {
    const chunk = addresses.slice(off, off + 20);
    const ext = w3.AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: alt,
      addresses: chunk,
    });
    const r2 = await sendTx(connection, ext, [payer]);
    if (r2.err) throw new Error(`ALT extend failed: ${JSON.stringify(bigIntSafe(r2.err))}`);
  }
  return alt;
}

export { readFileSync, writeFileSync, mkdirSync, join, dirname };
