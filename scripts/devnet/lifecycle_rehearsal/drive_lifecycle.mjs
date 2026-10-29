#!/usr/bin/env node
// drive_lifecycle.mjs — W1 Lifecycle Rehearsal Harness: the lifecycle +
// adversarial battery driver (stages 2–16 of Handoff Vol IV §10, final
// matrix in worklog Task W1-1).
//
// REAL-EXECUTION DISCIPLINE:
//   - every stage sends REAL transactions to the local validator through the
//     REAL TypeScript SDK client paths (GraveYieldClient + instruction
//     builders) — never in-process program invocations;
//   - the salvage executes through salvor-bots fleet-core ExecutionPipeline
//     in mode:"live" (first-ever real submit-path execution), with at-most-
//     once admission via InMemoryFleetStore;
//   - the snapshot is produced by the REAL Rust snapshotter bin
//     (target/debug/grave-snapshotter-cli) and cross-checked against the
//     SDK snapshot fleet-core feeds into the salvage;
//   - reconciliation runs salvor-bots monitor (file-path import);
//   - every adversarial case asserts the EXACT program error code (or a
//     classified family for non-custom failures, mirroring the
//     grave-indexer verify-path precedent) plus a before/after zero-movement
//     invariant (Finding B fix): the failed transaction's fee payer is
//     debited EXACTLY the on-chain meta.fee — recorded, never normalized
//     away — while every other tracked wallet, every tracked token account,
//     and every tracked existing account must be bit-identical, and every
//     listed PDA must remain absent.
//
// Boundaries (labeled in the report): synthetic C1 timestamps
// (fork-precedented), synthetic-collapse launch price ×200 (fork-precedented),
// LP mint supply re-pinned to the local holder set (C6), conversion leg
// config-skipped (u64::MAX dust — canonical full_lifecycle_fork shape; C3),
// route-account shim for fleet-core's destination validation (unused by the
// skipped leg), fork-covered negatives (7002 expired-cert — in-VM clock
// control only; see README).
//
// Rebuilt 2026-10-28 from the worklog record with all 13 runtime fixes applied:
//  1 --salvorBots arg spelling;  2 lib REPO_ROOT x3 dirname;  3 web3.js 3.x
//  async-ification;  4 BigInt-safe JSON;  5 error-family classifier;  6 A5
//  signs the 111-byte message;  7 A10 expects 3012 (observed; Anchor
//  AccountNotInitialized precedes the handler's 6015);  8 scanner remaining
//  accounts include the UNCX marker PDA (6020 otherwise);  9 loader flags
//  written after holder dumps;  10 SLOT-HASH from the sysvar (F1);  11 v0/ALT
//  salvage tx (F2);  12 market nonce re-pin (F3, in prepare_local_accounts);
//  13 single web3 instance from the salvor checkout + 3.x simulate adapter.
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import nacl from "tweetnacl";
import {
  initWeb3,
  initIds,
  getWeb3,
  importSdk,
  importFleetCore,
  importMonitor,
  loadKeypair,
  pk,
  IDS,
  RunReport,
  sendTx,
  confirmSig,
  customCodeFromErr,
  errFamilyFromErr,
  eventsFromLogs,
  snapshotTokenAccounts,
  evaluateZeroMovement,
  solBalance,
  readSlotHashesEntry,
  createAndFillAlt,
  applySimCompat,
  uncxMarkerPda,
  jsonSafe,
  join as pjoin,
} from "./lib.mjs";
import { registerOracles, readbackAssertOracles } from "./register_oracle.mjs";
import { classifyReconciliation } from "./monitor_gate.mjs";

// --- args --------------------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[++i];
}
const { url, artifacts, fixtures, keys, salvorBots } = args;
for (const [k, v] of Object.entries({ url, artifacts, fixtures, keys, salvorBots })) {
  if (!v) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

const U64_MAX = 18_446_744_073_709_551_615n;
await initWeb3(salvorBots); // fix 13: ALL web3 identities come from the salvor checkout
initIds();
const W3 = getWeb3();
const { Connection, PublicKey, TransactionInstruction, SystemProgram } = W3;

const DRIVER_DIR = dirname(new URL(import.meta.url).pathname);
// lifecycle_rehearsal -> scripts/devnet -> scripts -> REPO ROOT (fix 2: three dirnames)
const REPO_ROOT = dirname(dirname(dirname(DRIVER_DIR)));
const connection = applySimCompat(new Connection(url, "confirmed"), () => ALT_ADDRESS);
const SDK = await importSdk();
const FC = await importFleetCore(salvorBots);
const MON = await importMonitor(salvorBots);

const manifest = JSON.parse(readFileSync(pjoin(fixtures, "manifest.json"), "utf8"));
const localPlan = JSON.parse(readFileSync(pjoin(artifacts, "local_plan.json"), "utf8"));
const elfPins = JSON.parse(readFileSync(pjoin(artifacts, "sha256.txt"), "utf8"));

const POOL = pk(manifest.pool_address);
const AMM = pk(manifest.amm_program);
const LP_MINT = pk(localPlan.lp_mint);
const MEMECOIN = pk(localPlan.memecoin_mint);
const COIN_VAULT = pk(manifest.accounts.coin_vault.pubkey);
const PC_VAULT = pk(manifest.accounts.pc_vault.pubkey);

const K = {
  authority: await loadKeypair(pjoin(keys, "authority.json")),
  intruder: await loadKeypair(pjoin(keys, "intruder.json")),
  activityOracle: await loadKeypair(pjoin(keys, "activity_oracle.json")),
  launchOracle: await loadKeypair(pjoin(keys, "launch_oracle.json")),
  salvor: await loadKeypair(pjoin(keys, "salvor.json")),
  claimantA: await loadKeypair(pjoin(keys, "claimant_a.json")),
  claimantB: await loadKeypair(pjoin(keys, "claimant_b.json")),
};

const client = new SDK.GraveYieldClient({
  connection,
  cluster: "localnet",
  graveScannerProgramId: IDS.scanner,
  graveVaultProgramId: IDS.vault,
});
// Structural client for the monitor (it only reads .connection + program ids).
const monitorClient = {
  connection,
  graveScannerProgramId: IDS.scanner,
  graveVaultProgramId: IDS.vault,
};

const SALVOR_LP_ATA = pk(localPlan.holders.salvor.lp_ata);
const [VAULT_AUTHORITY] = [SDK.vaultAuthorityPda(IDS.vault)];
const [TREASURY] = [SDK.protocolTreasuryPda(IDS.vault)];
const [POOL_REGISTRY] = [SDK.poolRegistryPda(IDS.vault, POOL)];
const [SALVAGE_RECEIPT] = [SDK.salvageReceiptPda(IDS.vault, POOL)];
const [LP_HOLDER_POOL] = [SDK.lpHolderPoolVaultPda(IDS.vault, POOL)];
const [SCANNER_CFG] = [SDK.scannerProtocolConfigPda(IDS.scanner)];
const [VAULT_CFG] = [SDK.vaultProtocolConfigPda(IDS.vault)];
const [ANCHOR_PDA] = [SDK.eligibilityAnchorPda(IDS.scanner, IDS.raydiumV4, POOL)];
const [CERT_PDA] = [SDK.eligibilityCertPda(IDS.scanner, IDS.raydiumV4, POOL)];
const [LAUNCH_PRICE_PDA] = [SDK.launchPricePda(IDS.scanner, IDS.raydiumV4, POOL)];
// Explicit canonical program ids — the protocol SDK's exported
// ASSOCIATED_TOKEN_PROGRAM_ID proved unreliable for derivation (run-27 finding:
// the vault WSOL ATA derived with it did not match fleet-core's expectation).
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const VAULT_WSOL_ATA = PublicKey.findProgramAddressSync(
  [VAULT_AUTHORITY.toBytes(), TOKEN_PROGRAM.toBytes(), IDS.wsolMint.toBytes()],
  ATA_PROGRAM,
)[0];
const VAULT_MEMECOIN_ATA = PublicKey.findProgramAddressSync(
  [VAULT_AUTHORITY.toBytes(), TOKEN_PROGRAM.toBytes(), MEMECOIN.toBytes()],
  ATA_PROGRAM,
)[0];
const TREASURY_MEMECOIN_ATA = PublicKey.findProgramAddressSync(
  [TREASURY.toBytes(), TOKEN_PROGRAM.toBytes(), MEMECOIN.toBytes()],
  ATA_PROGRAM,
)[0];
const UNCX_MARKER = uncxMarkerPda(POOL);

// Finding B fix: the default SOL watch set for adversarial zero-movement
// windows — every keypair wallet plus the settlement PDAs. expectRevert
// excludes the fee payer from this set (its debit is pinned to the exact
// on-chain transaction fee instead of a bitwise comparison).
const SOL_WATCH = () => ({
  authority: K.authority.publicKey,
  activity_oracle: K.activityOracle.publicKey,
  launch_oracle: K.launchOracle.publicKey,
  intruder: K.intruder.publicKey,
  claimant_a: K.claimantA.publicKey,
  claimant_b: K.claimantB.publicKey,
  treasury_pda: TREASURY,
  vault_authority_pda: VAULT_AUTHORITY,
  lp_holder_pool_pda: LP_HOLDER_POOL,
});

// --- report ---------------------------------------------------------------------
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const report = new RunReport(pjoin(artifacts, `run-report-${ts}.json`), {
  authorization:
    "W1 Lifecycle Rehearsal Harness — owner authorization, Handoff Vol IV §8 (verbatim)",
  cluster: "solana-test-validator (local, --slots-per-epoch 32)",
  url,
  program_ids: {
    scanner: IDS.scanner.toBase58(),
    vault: IDS.vault.toBase58(),
    raydium_v4: IDS.raydiumV4.toBase58(),
  },
  elf_pins: elfPins,
  local_plan: localPlan,
  fixture_manifest: {
    pool: manifest.pool_address,
    base_is_coin_side: manifest.base_is_coin_side,
    fetched_at: manifest._fetched_at,
    rpc: manifest._rpc,
  },
  keys_root: keys,
  boundaries_note: "see 'boundaries' — every mocked/stubbed/compressed edge is labeled here",
});

function failFast(msg) {
  report.finish({});
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

// --- shared helpers ---------------------------------------------------------------
async function stage(id, name, fn) {
  try {
    const entry = (await fn()) ?? {};
    report.stage({ id, name, pass: true, ...entry });
    return entry;
  } catch (e) {
    report.stage({ id, name, pass: false, reason: String(e?.stack ?? e) });
    failFast(`stage ${id} (${name}) failed: ${e?.message ?? e}`);
  }
}

// A failed transaction still pays the real signature fee to its fee payer —
// that is the ONLY movement a revert is allowed to produce (Finding B fix:
// the debit is pinned to the transaction's EXACT on-chain meta.fee, not
// merely "within a budget", so a small protocol-state debit can never be
// normalized away as fee). Everything else must be bit-identical: every
// wallet in solWallets (default SOL_WATCH(), fee payer excluded), every
// token account in tokenAccounts, every existing account in
// accountsUnchanged; every PDA in pdaMustStayAbsent must remain absent.
const MAX_FAILED_TX_FEE_LAMPORTS = 10_000n;

async function accountSnapshot(pubkey) {
  const info = await connection.getAccountInfo(pubkey);
  return info
    ? { lamports: info.lamports, dataB64: Buffer.from(info.data).toString("base64") }
    : null;
}

async function expectRevert({
  id,
  name,
  ixs,
  signers,
  expectCode,
  expectFamily,
  feePayerBudgetLamports = MAX_FAILED_TX_FEE_LAMPORTS,
  pdaMustStayAbsent = [],
  tokenAccounts = {},
  solWallets = SOL_WATCH(),
  accountsUnchanged = [],
  viaAlt = false,
  altAddress = null,
  note = null,
}) {
  const feePayer = signers[0].publicKey;
  // Other tracked wallets — the fee payer is excluded here and checked by
  // exact-fee comparison below (no double counting).
  const otherWallets = Object.entries(solWallets).filter(([, p]) => !p.equals(feePayer));
  const beforeFee = await solBalance(connection, feePayer);
  const solBefore = {};
  for (const [label, p] of otherWallets) solBefore[label] = await solBalance(connection, p);
  const tokensBefore = await snapshotTokenAccounts(connection, tokenAccounts);
  const unchangedBefore = {};
  for (const [label, p] of accountsUnchanged) unchangedBefore[label] = await accountSnapshot(p);
  const res = await sendTx(connection, ixs, signers, viaAlt ? { viaAlt: true, altAddress } : {});
  const afterFee = await solBalance(connection, feePayer);
  const solAfter = {};
  for (const [label, p] of otherWallets) solAfter[label] = await solBalance(connection, p);
  const tokensAfter = await snapshotTokenAccounts(connection, tokenAccounts);
  const unchangedAfter = {};
  for (const [label, p] of accountsUnchanged) unchangedAfter[label] = await accountSnapshot(p);
  const code = customCodeFromErr(res.err);
  // Classify the family for EVERY failure: foreign custom codes (e.g. the
  // ed25519 precompile's own Custom(2)) must classify to their ix's family.
  const family = res.err ? errFamilyFromErr(res.err, res.logs, ixs) : null;
  const pass =
    expectCode !== undefined ? code === expectCode : family === expectFamily && res.err != null;
  const feeDelta = beforeFee - afterFee;
  // Pin the permitted debit to the network's own accounting (meta.fee);
  // fall back to 5000 lamports × held signers only if the RPC omits it.
  const expectedFeeLamports = BigInt(res.fee ?? 5_000n * BigInt(Math.max(signers.length, 1)));
  const zeroMovement = evaluateZeroMovement({
    feeDelta,
    expectedFeeLamports,
    feeBudgetLamports: feePayerBudgetLamports,
    solBefore,
    solAfter,
    tokensBefore,
    tokensAfter,
    absentChecks: await Promise.all(
      pdaMustStayAbsent.map(async ([label, pda]) => ({
        label,
        absent: (await connection.getAccountInfo(pda)) === null,
      })),
    ),
    unchangedBefore,
    unchangedAfter,
  });
  report.adversarial({
    id,
    name,
    expected: expectCode !== undefined ? { code: expectCode } : { family: expectFamily },
    observed: { code, family, err: res.err ?? null },
    pass,
    tx: res.sig,
    slot: res.slot,
    logs_tail: (res.logs ?? []).slice(-6),
    zero_movement: zeroMovement,
    ...(note ? { boundary_note: note } : {}),
  });
  if (!pass) {
    failFast(
      `adversarial ${id} (${name}) did not revert as expected: err=${jsonSafe(res.err)} logs=${(res.logs ?? []).slice(-4)}`,
    );
  }
  if (!zeroMovement.proved) {
    failFast(`adversarial ${id} (${name}) reverted but the zero-state-movement invariant failed`);
  }
  return { code, family, res };
}

// C1 attestation: real local slot anchor + fork-precedented synthetic
// last-swap timestamp (documented boundary). issuedSlot points a few slots
// back so the (slot,hash) pair is in the SlotHashes sysvar window.
// FIX 10 (F1): the hash comes from the SYSVAR, never SDK.fetchSlotHash.
async function buildC1Attestation({ oracleKeypair, lastSwapUnixTs }) {
  const tip = Number(await connection.getSlot());
  const issuedSlot = Math.max(1, tip - 4);
  const slotHash = await readSlotHashesEntry(connection, issuedSlot);
  if (!slotHash) throw new Error(`no slot hash in sysvar for slot ${issuedSlot}`);
  const msg = SDK.buildAttestationMessage({
    ammProgramId: IDS.raydiumV4,
    poolAddress: POOL,
    lastSwapUnixTs: BigInt(lastSwapUnixTs),
    issuedSlot: BigInt(issuedSlot),
    slotHash,
  });
  if (msg.length !== 112) throw new Error(`C1 msg must be 112B, got ${msg.length}`);
  const signature = nacl.sign.detached(msg, oracleKeypair.secretKey);
  return { msg, signature, issuedSlot, slotHash };
}

// The 13 V4 remaining accounts from the cross-validated manifest.
function v4RemainingAccounts() {
  return SDK.raydiumV4RemainingAccounts(
    { coinVault: COIN_VAULT, pcVault: PC_VAULT },
    {
      ammOpenOrders: pk(manifest.accounts.open_orders.pubkey),
      ammTargetOrders: pk(manifest.accounts.target_orders.pubkey),
      marketProgram: pk(manifest.market_program),
      market: pk(manifest.accounts.market.pubkey),
      marketCoinVault: pk(manifest.accounts.market_coin_vault.pubkey),
      marketPcVault: pk(manifest.accounts.market_pc_vault.pubkey),
      marketVaultSigner: pk(manifest.accounts.vault_signer.pubkey),
      marketEventQueue: pk(manifest.accounts.event_queue.pubkey),
      marketBids: pk(manifest.accounts.bids.pubkey),
      marketAsks: pk(manifest.accounts.asks.pubkey),
    },
  );
}

// Scanner remaining accounts: [coin_vault, pc_vault, lp_mint] (any order —
// the adapter looks accounts up by pubkey and validates ownership/mints)
// PLUS the UNCX per-pool lock marker PDA (fix 8 — 6020 otherwise; locally
// absent = the proven-unlocked path, fork layout PoolEnv::scanner_remaining).
function scannerRemainingAccounts() {
  return [COIN_VAULT, PC_VAULT, LP_MINT, UNCX_MARKER].map((p) => ({
    pubkey: p,
    isSigner: false,
    isWritable: false,
  }));
}

function salvageIxInput({
  merkleRoot,
  supply,
  salvorLpAmount,
  minQuoteOutputLamports = 0n,
  routeData = new Uint8Array(0),
  routeAccounts = [],
}) {
  return {
    vaultProgramId: IDS.vault,
    scannerProgramId: IDS.scanner,
    ammProgramId: AMM,
    poolAddress: POOL,
    salvor: K.salvor.publicKey,
    salvorLpTokenAccount: SALVOR_LP_ATA,
    lpMint: LP_MINT,
    memecoinMint: MEMECOIN,
    lpSnapshotMerkleRoot: merkleRoot,
    lpTotalSupplyAtSnapshot: supply,
    salvorLpAmount,
    minQuoteOutputLamports,
    maxSlippageBpsOverride: null,
    jupiterRouteData: routeData,
    jupiterRouteAccountsLen: routeAccounts.length,
    raydiumV4RemainingAccounts: v4RemainingAccounts(),
    jupiterRouteAccounts: routeAccounts,
  };
}

async function readReserves() {
  return {
    coin: await SDK.readVaultReserve(connection, COIN_VAULT),
    pc: await SDK.readVaultReserve(connection, PC_VAULT),
  };
}

async function waitUntilEpoch(targetEpoch, label) {
  const deadline = Date.now() + 600_000;
  for (;;) {
    const info = await connection.getEpochInfo();
    if (Number(info.epoch) >= targetEpoch) return Number(info.epoch);
    if (Date.now() > deadline) {
      failFast(`timed out waiting for epoch ≥ ${targetEpoch} (${label}); at ${info.epoch}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Non-canonical ed25519 precompile: runtime-valid (signature verifies) but
// sig offset 56 instead of the canonical 48 — the scanner's offset pin
// (ORACLE_PIPELINE.md §2.3 check order) reverts 6025.
function shiftedPrecompileIx({ signature, oraclePublicKey, message, scannerInstructionIndex }) {
  const data = Buffer.alloc(120); // header 16 + pk 32 (@16) + sig 64 (@56)
  data[0] = 1;
  const wr = (off, v) => data.writeUInt16LE(v, off);
  wr(2, 56); // signature_offset — SHIFTED (canonical pin is 48)
  wr(4, 0xffff); // signature_instruction_index
  wr(6, 16); // public_key_offset
  wr(8, 0xffff); // public_key_instruction_index
  wr(10, 72); // message_data_offset (scanner ix data @72)
  wr(12, message.length);
  wr(14, scannerInstructionIndex);
  Buffer.from(oraclePublicKey.toBytes()).copy(data, 16);
  Buffer.from(signature).copy(data, 56);
  return new TransactionInstruction({
    programId:
      SDK.ED25519_PROGRAM_ID ?? new PublicKey("Ed25519SigVerify111111111111111111111111111"),
    keys: [],
    data,
  });
}

// Canonical precompile over an arbitrary message (used by A5's 111-byte case).
function canonicalPrecompileIx({ signature, oraclePublicKey, message, scannerInstructionIndex }) {
  const data = Buffer.alloc(16 + 32 + 64);
  data[0] = 1;
  const wr = (off, v) => data.writeUInt16LE(v, off);
  wr(2, 48);
  wr(4, 0xffff);
  wr(6, 16);
  wr(8, 0xffff);
  wr(10, 72);
  wr(12, message.length);
  wr(14, scannerInstructionIndex);
  Buffer.from(oraclePublicKey.toBytes()).copy(data, 16);
  Buffer.from(signature).copy(data, 48);
  return new TransactionInstruction({
    programId:
      SDK.ED25519_PROGRAM_ID ?? new PublicKey("Ed25519SigVerify111111111111111111111111111"),
    keys: [],
    data,
  });
}

// Malformed-message phase_1 ix: hand-rolled 111-byte msg (canonical is 112)
// so the runtime precompile verifies fine but Anchor's [u8; 112] decode dies.
function malformedPhase1Ix({ ammProgramId, poolAddress, shortMsg, writer }) {
  const disc =
    SDK.ScannerIx?.evaluatePoolPhase1 ??
    createHash("sha256").update("global:evaluate_pool_phase_1").digest().subarray(0, 8);
  const data = Buffer.concat([
    Buffer.from(disc),
    Buffer.from(ammProgramId.toBytes()),
    Buffer.from(poolAddress.toBytes()),
    Buffer.from(shortMsg),
  ]);
  return new TransactionInstruction({
    programId: IDS.scanner,
    keys: [
      { pubkey: SCANNER_CFG, isSigner: false, isWritable: false },
      { pubkey: ANCHOR_PDA, isSigner: false, isWritable: true },
      { pubkey: LAUNCH_PRICE_PDA, isSigner: false, isWritable: false },
      { pubkey: POOL, isSigner: false, isWritable: true },
      {
        pubkey: new PublicKey("Sysvar1nstructions1111111111111111111111111"),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: new PublicKey("SysvarS1otHashes111111111111111111111111111"),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: writer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...scannerRemainingAccounts(),
    ],
    data,
  });
}

// --- [stage 1] validator + ELF provenance ---------------------------------------------
await stage(1, "validator boot + ELF load at NS-2 IDs (sha256 pins)", async () => {
  const checks = [];
  for (const [label, id] of [
    ["scanner", IDS.scanner],
    ["vault", IDS.vault],
    ["raydium_v4", IDS.raydiumV4],
  ]) {
    const info = await connection.getAccountInfo(id);
    if (!info || !info.executable)
      throw new Error(`${label} program not loaded/executable at ${id.toBase58()}`);
    checks.push({ label, loaded: true, bytes: info.data.length });
  }
  const serumProgram = pk(manifest.market_program);
  const serumInfo = await connection.getAccountInfo(serumProgram);
  if (!serumInfo || !serumInfo.executable) throw new Error("serum_dex program not loaded");
  // pool accounts present with real mainnet bytes (spot-check pool + lp_mint)
  if (!(await connection.getAccountInfo(POOL))) throw new Error("pool account missing");
  const mintInfo = await connection.getAccountInfo(LP_MINT);
  if (!mintInfo) throw new Error("lp_mint account missing");
  return {
    detail:
      "all programs executable at the NS-2 IDs; pool + re-pinned lp_mint loaded from real mainnet bytes",
    programs: checks,
    pins: elfPins,
  };
});

// --- [stage 2] ProtocolConfig initialize (real SDK builders) ------------------------
await stage(2, "ProtocolConfig initialize (SDK builders; vault dust = u64::MAX)", async () => {
  const scannerCfgBefore = await connection.getAccountInfo(SCANNER_CFG);
  if (scannerCfgBefore) throw new Error("scanner config already exists — validator must be fresh");
  const initScanner = SDK.buildScannerInitializeIx({
    scannerProgramId: IDS.scanner,
    authority: K.authority.publicKey,
    payer: K.authority.publicKey,
  });
  const initVault = SDK.buildVaultInitializeIx({
    vaultProgramId: IDS.vault,
    authority: K.authority.publicKey,
    payer: K.authority.publicKey,
    // Conversion-leg skip per canonical full_lifecycle_fork shape (C3):
    jupiterDustThresholdLamports: U64_MAX,
  });
  const r1 = await sendTx(connection, [initScanner], [K.authority]);
  if (r1.err) throw new Error(`scanner init failed: ${jsonSafe(r1.err)}`);
  const r2 = await sendTx(connection, [initVault], [K.authority]);
  if (r2.err) throw new Error(`vault init failed: ${jsonSafe(r2.err)}`);
  await client.ensureConfigs();
  const sc = await SDK.fetchScannerProtocolConfig(connection, SCANNER_CFG);
  const vc = await SDK.fetchVaultProtocolConfig(connection, VAULT_CFG);
  const defaultsOk =
    sc.inactivitySeconds === 7_776_000n &&
    sc.priceCollapseBps === 9_900 &&
    vc.lpHolderShareBps === 4000 &&
    vc.salvorShareBps === 4000 &&
    vc.protocolShareBps === 2000 &&
    vc.jupiterDustThresholdLamports === U64_MAX;
  if (!defaultsOk)
    throw new Error(`config defaults mismatch: scanner=${jsonSafe(sc)} vault=${jsonSafe(vc)}`);
  return {
    tx: r1.sig,
    tx2: r2.sig,
    detail:
      "scanner at spec defaults; vault at spec defaults with jupiter_dust_threshold = u64::MAX (conversion leg skipped by config — labeled boundary C3)",
  };
});

// --- [stage 3] oracle registration (80-byte governance action) -----------------------
await stage(
  3,
  "oracle registration via 80-byte update_protocol_config (ORACLE_CUSTODY.md steps 1–2)",
  async () => {
    const sig = await registerOracles({
      connection,
      authorityKeypair: K.authority,
      activityOracle: K.activityOracle.publicKey,
      launchPriceOracle: K.launchOracle.publicKey,
    });
    const cfg = await readbackAssertOracles({
      connection,
      SDK,
      activityOracle: K.activityOracle.publicKey,
      launchPriceOracle: K.launchOracle.publicKey,
    });
    return {
      tx: sig,
      detail: `activity_oracle=${cfg.activityOracle.toBase58()} launch_price_oracle=${cfg.launchPriceOracle.toBase58()} — local runbook validation (fresh local keys), NOT the devnet custody situation`,
    };
  },
);

// --- [stage 4] discovery wiring smoke (SDK evaluatePool, tolerant) --------------------
await stage(4, "discovery/evaluation wiring smoke (SDK evaluatePool — C5 label)", async () => {
  let outcome = null;
  let err = null;
  try {
    outcome = await client.evaluatePool(POOL, { ammProgramId: IDS.raydiumV4 });
  } catch (e) {
    err = String(e?.message ?? e);
  }
  // Tolerant per devnetSmoke precedent: the wiring must respond (result or a
  // known wiring error) — the C1/C5 derivation yield gap is a labeled boundary.
  const wired =
    outcome !== null ||
    /not found|not a canonical|owned by|No Signers|Raydium V4|signature|history/i.test(err ?? "");
  if (!wired) throw new Error(`evaluatePool wiring smoke failed unexpectedly: ${err}`);
  return {
    detail:
      "evaluatePool against the local fixture pool responded (wiring proven; last-swap history is intentionally absent — C5/C6 boundary)",
    outcome: outcome ? "derived" : `tolerant-error: ${err}`,
  };
});

// --- [stage 5] record_launch_price (168B C2, real precompile) -------------------------
await stage(
  5,
  "record_launch_price (168B C2 attestation; launch price = current × 200)",
  async () => {
    const pool = await SDK.fetchV4Pool(connection, POOL);
    const reserves = await readReserves();
    // The on-chain Raydium V4 adapter maps base = coin, quote = pc
    // unconditionally; SDK quotePerBaseQ64x64 mirrors that mapping.
    const currentPrice = SDK.quotePerBaseQ64x64(reserves.coin, reserves.pc);
    const launchPrice = currentPrice * 200n; // 99.5% collapse — fork-precedented
    const firstSwapSlot = 1; // deterministic synthetic reference (labeled boundary)
    const firstSwapUnixTs = BigInt(Math.floor(Date.now() / 1000) - 91 * 86400);
    const issuedSlot = Math.max(1, Number(await connection.getSlot()) - 4);
    const msg = SDK.buildLaunchPriceMessage({
      ammProgramId: IDS.raydiumV4,
      poolAddress: POOL,
      baseMint: pool.baseMint,
      quoteMint: pool.quoteMint,
      firstSwapSlot: BigInt(firstSwapSlot),
      firstSwapUnixTs,
      launchPriceQ64x64: launchPrice,
      issuedSlot: BigInt(issuedSlot),
    });
    if (msg.length !== 168) throw new Error(`C2 msg must be 168B, got ${msg.length}`);
    const signature = nacl.sign.detached(msg, K.launchOracle.secretKey);
    const { precompileIx, recordIx } = client.buildRecordLaunchPriceIx({
      ammProgramId: IDS.raydiumV4,
      poolAddress: POOL,
      derivation: {
        launchPriceQ64x64: launchPrice,
        firstSwapSlot: BigInt(firstSwapSlot),
        firstSwapUnixTs,
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        signature: "",
      },
      issuedSlot,
      signature,
      oraclePublicKey: K.launchOracle.publicKey,
      msg,
      payer: K.authority.publicKey,
    });
    const r = await sendTx(connection, [precompileIx, recordIx], [K.authority]);
    if (r.err)
      throw new Error(
        `record_launch_price failed: ${jsonSafe(r.err)} logs: ${(r.logs ?? []).slice(-5)}`,
      );
    const lp = await SDK.fetchLaunchPrice(connection, LAUNCH_PRICE_PDA);
    if (!lp || lp.launchPriceQ64x64 !== launchPrice)
      throw new Error("LaunchPrice PDA readback mismatch");
    return {
      tx: r.sig,
      detail: `launch price pinned at ${launchPrice} q64x64 (current × 200 → 99.5% collapse vs real fixture reserves)`,
    };
  },
);

// --- [adversarial A1–A5] attestation prologue battery (program-live, phase_1) --------
// Per ORACLE_PIPELINE.md §2.3 the scanner's as-implemented check order is
// 6024 (precompile presence) → 6025 (canonical offsets) → 6026 (oracle
// binding); the runtime precompile itself rejects tampered signatures, and
// a malformed msg length dies in Anchor decode. Every case must revert
// with zero state movement (the anchor PDA Anchor init creates is rolled
// back atomically — asserted via pdaMustStayAbsent).
{
  const lastSwapTs = BigInt(Math.floor(Date.now() / 1000) - 91 * 86400);

  // A1: missing precompile → 6024 (AttestationMissing)
  {
    const att = await buildC1Attestation({
      oracleKeypair: K.activityOracle,
      lastSwapUnixTs: lastSwapTs,
    });
    const { phase1Ix } = client.buildPhase1Ix({
      ammProgramId: IDS.raydiumV4,
      poolAddress: POOL,
      derivation: { lastSwapUnixTs: Number(lastSwapTs), slot: att.issuedSlot, signature: "" },
      slotHash: att.slotHash,
      signature: att.signature,
      oraclePublicKey: K.activityOracle.publicKey,
      writer: K.salvor.publicKey,
      remainingAccounts: scannerRemainingAccounts(),
    });
    await expectRevert({
      id: "A1",
      name: "evaluate_pool_phase_1 without the ed25519 precompile instruction",
      ixs: [phase1Ix],
      signers: [K.salvor],
      expectCode: 6024,
      pdaMustStayAbsent: [["eligibility_anchor", ANCHOR_PDA]],
    });
  }

  // A2: tampered signature → the ed25519 precompile itself rejects
  //     (no GraveYield custom code can be reached — verify-path precedent).
  {
    const att = await buildC1Attestation({
      oracleKeypair: K.activityOracle,
      lastSwapUnixTs: lastSwapTs,
    });
    const badSig = Uint8Array.from(att.signature);
    badSig[0] ^= 0x01;
    const { precompileIx, phase1Ix } = client.buildPhase1Ix({
      ammProgramId: IDS.raydiumV4,
      poolAddress: POOL,
      derivation: { lastSwapUnixTs: Number(lastSwapTs), slot: att.issuedSlot, signature: "" },
      slotHash: att.slotHash,
      signature: badSig,
      oraclePublicKey: K.activityOracle.publicKey,
      writer: K.salvor.publicKey,
      remainingAccounts: scannerRemainingAccounts(),
    });
    await expectRevert({
      id: "A2",
      name: "evaluate_pool_phase_1 with a tampered oracle signature",
      ixs: [precompileIx, phase1Ix],
      signers: [K.salvor],
      expectFamily: "precompile",
      pdaMustStayAbsent: [["eligibility_anchor", ANCHOR_PDA]],
    });
  }

  // A3: non-canonical precompile offsets (sig@56 ≠ 48) → 6025
  {
    const att = await buildC1Attestation({
      oracleKeypair: K.activityOracle,
      lastSwapUnixTs: lastSwapTs,
    });
    const { phase1Ix } = client.buildPhase1Ix({
      ammProgramId: IDS.raydiumV4,
      poolAddress: POOL,
      derivation: { lastSwapUnixTs: Number(lastSwapTs), slot: att.issuedSlot, signature: "" },
      slotHash: att.slotHash,
      signature: att.signature,
      oraclePublicKey: K.activityOracle.publicKey,
      writer: K.salvor.publicKey,
      remainingAccounts: scannerRemainingAccounts(),
    });
    const shifted = shiftedPrecompileIx({
      signature: att.signature,
      oraclePublicKey: K.activityOracle.publicKey,
      message: att.msg,
      scannerInstructionIndex: 1,
    });
    await expectRevert({
      id: "A3",
      name: "evaluate_pool_phase_1 with non-canonical precompile offsets (sig@56)",
      ixs: [shifted, phase1Ix],
      signers: [K.salvor],
      expectCode: 6025,
      pdaMustStayAbsent: [["eligibility_anchor", ANCHOR_PDA]],
    });
  }

  // A4: signature by a key that is NOT the registered activity oracle → 6026
  {
    const att = await buildC1Attestation({ oracleKeypair: K.intruder, lastSwapUnixTs: lastSwapTs });
    const { precompileIx, phase1Ix } = client.buildPhase1Ix({
      ammProgramId: IDS.raydiumV4,
      poolAddress: POOL,
      derivation: { lastSwapUnixTs: Number(lastSwapTs), slot: att.issuedSlot, signature: "" },
      slotHash: att.slotHash,
      signature: att.signature,
      oraclePublicKey: K.intruder.publicKey,
      writer: K.salvor.publicKey,
      remainingAccounts: scannerRemainingAccounts(),
    });
    await expectRevert({
      id: "A4",
      name: "evaluate_pool_phase_1 signed by an unauthorized oracle key",
      ixs: [precompileIx, phase1Ix],
      signers: [K.salvor],
      expectCode: 6026,
      pdaMustStayAbsent: [["eligibility_anchor", ANCHOR_PDA]],
    });
  }

  // A5: malformed attestation message length (111 ≠ 112) → anchor-decode
  // FIX 6: the precompile must VERIFY (canonical offsets over the 111-byte
  // truncated message — so the signature MUST be over the 111-byte msg),
  // then Anchor's [u8; 112] decode dies on the scanner ix.
  {
    const att = await buildC1Attestation({
      oracleKeypair: K.activityOracle,
      lastSwapUnixTs: lastSwapTs,
    });
    const shortMsg = att.msg.slice(0, 111);
    const shortSig = nacl.sign.detached(shortMsg, K.activityOracle.secretKey); // fix 6
    const pre111 = canonicalPrecompileIx({
      signature: shortSig,
      oraclePublicKey: K.activityOracle.publicKey,
      message: shortMsg,
      scannerInstructionIndex: 1,
    });
    const malformed = malformedPhase1Ix({
      ammProgramId: IDS.raydiumV4,
      poolAddress: POOL,
      shortMsg,
      writer: K.salvor.publicKey,
    });
    await expectRevert({
      id: "A5",
      name: "evaluate_pool_phase_1 with a malformed (111-byte) attestation message",
      ixs: [pre111, malformed],
      signers: [K.salvor],
      expectFamily: "anchor-decode",
      pdaMustStayAbsent: [["eligibility_anchor", ANCHOR_PDA]],
    });
  }
}

// --- [ALT pre-warm] (fix 11 / finding F2) ---------------------------------------------
// The salvage ix (21 named + 13 V4 remaining ≈ 1.4 kB) cannot fit the legacy
// 1232-byte packet. The SAME instructions compile into v0 over this REAL local
// address lookup table. Created + filled NOW — before the adversarial battery —
// so creation costs never enter a zero-movement window.
const ALT_ADDRESS = await createAndFillAlt(connection, K.authority, [
  POOL,
  COIN_VAULT,
  PC_VAULT,
  LP_MINT,
  MEMECOIN,
  IDS.wsolMint,
  VAULT_AUTHORITY,
  TREASURY,
  POOL_REGISTRY,
  SALVAGE_RECEIPT,
  LP_HOLDER_POOL,
  CERT_PDA,
  ANCHOR_PDA,
  LAUNCH_PRICE_PDA,
  SCANNER_CFG,
  VAULT_CFG,
  VAULT_WSOL_ATA,
  VAULT_MEMECOIN_ATA,
  TREASURY_MEMECOIN_ATA,
  SALVOR_LP_ATA,
  pk(manifest.accounts.open_orders.pubkey),
  pk(manifest.accounts.target_orders.pubkey),
  pk(manifest.accounts.market.pubkey),
  pk(manifest.accounts.market_coin_vault.pubkey),
  pk(manifest.accounts.market_pc_vault.pubkey),
  pk(manifest.accounts.vault_signer.pubkey),
  pk(manifest.accounts.event_queue.pubkey),
  pk(manifest.accounts.bids.pubkey),
  pk(manifest.accounts.asks.pubkey),
  IDS.scanner,
  IDS.vault,
  IDS.raydiumV4,
  AMM,
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  ATA_PROGRAM,
  SystemProgram.programId,
  new PublicKey("Ed25519SigVerify111111111111111111111111111"),
  new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
  K.salvor.publicKey,
  K.authority.publicKey,
]);
report.event(`ALT pre-warmed at ${ALT_ADDRESS.toBase58()} (fix 11 / F2)`);

// --- [adversarial A10] phase2 before anchor (fix 7: observed 3012) ----------------------
{
  const att = await buildC1Attestation({
    oracleKeypair: K.activityOracle,
    lastSwapUnixTs: BigInt(Math.floor(Date.now() / 1000) - 91 * 86400),
  });
  const { precompileIx, phase2Ix } = client.buildPhase2Ix({
    ammProgramId: IDS.raydiumV4,
    poolAddress: POOL,
    derivation: {
      lastSwapUnixTs: Number(Math.floor(Date.now() / 1000) - 91 * 86400),
      slot: att.issuedSlot,
      signature: "",
    },
    slotHash: att.slotHash,
    signature: att.signature,
    oraclePublicKey: K.activityOracle.publicKey,
    writer: K.salvor.publicKey,
    remainingAccounts: scannerRemainingAccounts(),
  });
  // FIX 7 (recorded per red line 5): phase_2 without an anchor reverts
  // 3012 (Anchor AccountNotInitialized) BEFORE the handler's 6015 —
  // the anchor PDA decode precedes the transition check. Semantics unchanged.
  await expectRevert({
    id: "A10",
    name: "illegal transition: evaluate_pool_phase_2 before any anchor exists",
    ixs: [precompileIx, phase2Ix],
    signers: [K.salvor],
    expectCode: 3012,
    pdaMustStayAbsent: [
      ["eligibility_anchor", ANCHOR_PDA],
      ["eligibility_cert", CERT_PDA],
    ],
  });
}

// --- [stage 6] evaluate_pool_phase_1 → EligibilityAnchorWritten -------------------------
let ANCHOR_FIRST_EPOCH = null;
await stage(
  6,
  "evaluate_pool_phase_1 via SDK (112B attestation) → EligibilityAnchorWritten",
  async () => {
    const lastSwapTs = BigInt(Math.floor(Date.now() / 1000) - 91 * 86400); // synthetic-old (fork-precedented)
    const att = await buildC1Attestation({
      oracleKeypair: K.activityOracle,
      lastSwapUnixTs: lastSwapTs,
    });
    const { precompileIx, phase1Ix } = client.buildPhase1Ix({
      ammProgramId: IDS.raydiumV4,
      poolAddress: POOL,
      derivation: { lastSwapUnixTs: Number(lastSwapTs), slot: att.issuedSlot, signature: "" },
      slotHash: att.slotHash,
      signature: att.signature,
      oraclePublicKey: K.activityOracle.publicKey,
      writer: K.salvor.publicKey,
      remainingAccounts: scannerRemainingAccounts(),
    });
    const r = await sendTx(connection, [precompileIx, phase1Ix], [K.salvor]);
    if (r.err)
      throw new Error(`phase_1 failed: ${jsonSafe(r.err)} logs=${(r.logs ?? []).slice(-6)}`);
    const anchor = await SDK.fetchEligibilityAnchor(connection, ANCHOR_PDA);
    if (!anchor) throw new Error("EligibilityAnchor PDA not found after phase_1");
    ANCHOR_FIRST_EPOCH = anchor.firstEligibleEpoch ?? null;
    const events = eventsFromLogs(r.logs, ["EligibilityAnchorWritten"]);
    return {
      tx: r.sig,
      events: events,
      anchor_epoch: ANCHOR_FIRST_EPOCH === null ? null : ANCHOR_FIRST_EPOCH.toString(),
      detail:
        "C1 anchor written from a real local-slot-anchored 112B attestation (slot hash read from the sysvar — F1)",
    };
  },
);

// --- [stage 7] compressed 2-epoch confirmation + 6016-at-gap-1 --------------------------
await stage(
  7,
  "compressed 2-epoch confirmation (--slots-per-epoch 32) + 6016-at-gap-1",
  async () => {
    // The cert gate is CURRENT ≥ anchor.firstEligibleEpoch + 2 — not absolute
    // epoch 2 (run-18 finding: the anchor can land at epoch 1 under the
    // compressed clock).
    const targetEpoch = (ANCHOR_FIRST_EPOCH !== null ? Number(ANCHOR_FIRST_EPOCH) : 0) + 2;
    const info = await connection.getEpochInfo();
    const currentEpoch = Number(info.epoch);
    let gapCase = null;
    if (currentEpoch < targetEpoch) {
      // We are in the gap (epoch 0 or 1): phase_2 MUST revert 6016 EpochConfirmationPending.
      const att = await buildC1Attestation({
        oracleKeypair: K.activityOracle,
        lastSwapUnixTs: BigInt(Math.floor(Date.now() / 1000) - 91 * 86400),
      });
      const { precompileIx, phase2Ix } = client.buildPhase2Ix({
        ammProgramId: IDS.raydiumV4,
        poolAddress: POOL,
        derivation: {
          lastSwapUnixTs: Number(Math.floor(Date.now() / 1000) - 91 * 86400),
          slot: att.issuedSlot,
          signature: "",
        },
        slotHash: att.slotHash,
        signature: att.signature,
        oraclePublicKey: K.activityOracle.publicKey,
        writer: K.salvor.publicKey,
        remainingAccounts: scannerRemainingAccounts(),
      });
      const res = await expectRevert({
        id: "S7-gap1",
        name: "evaluate_pool_phase_2 inside the 2-epoch confirmation gap → 6016",
        ixs: [precompileIx, phase2Ix],
        signers: [K.salvor],
        expectCode: 6016,
        pdaMustStayAbsent: [["eligibility_cert", CERT_PDA]],
        // The in-gap phase_2 must not touch the existing anchor either.
        accountsUnchanged: [["eligibility_anchor", ANCHOR_PDA]],
      });
      gapCase = { asserted: true, code: res.code };
    } else {
      gapCase = {
        asserted: false,
        note: "already past the gap when stage 7 ran (fork-covered timing boundary — the 6016 negative is asserted in-VM by scanner_windows_fork)",
      };
    }
    const epoch = await waitUntilEpoch(targetEpoch, "2-epoch confirmation from the anchor");
    return {
      detail: `confirmed to epoch ${epoch} with --slots-per-epoch 32 (compressed clock — labeled boundary)`,
      gap_case: gapCase,
      epoch,
    };
  },
);

// --- [stage 8] evaluate_pool_phase_2 → EligibilityCertIssued ----------------------------
await stage(8, "evaluate_pool_phase_2 via SDK (112B) → EligibilityCertIssued", async () => {
  const lastSwapTs = BigInt(Math.floor(Date.now() / 1000) - 91 * 86400);
  const att = await buildC1Attestation({
    oracleKeypair: K.activityOracle,
    lastSwapUnixTs: lastSwapTs,
  });
  const { precompileIx, phase2Ix } = client.buildPhase2Ix({
    ammProgramId: IDS.raydiumV4,
    poolAddress: POOL,
    derivation: { lastSwapUnixTs: Number(lastSwapTs), slot: att.issuedSlot, signature: "" },
    slotHash: att.slotHash,
    signature: att.signature,
    oraclePublicKey: K.activityOracle.publicKey,
    writer: K.salvor.publicKey,
    remainingAccounts: scannerRemainingAccounts(),
  });
  const r = await sendTx(connection, [precompileIx, phase2Ix], [K.salvor]);
  if (r.err) throw new Error(`phase_2 failed: ${jsonSafe(r.err)} logs=${(r.logs ?? []).slice(-6)}`);
  const cert = await SDK.fetchEligibilityCert(connection, CERT_PDA);
  if (!cert) throw new Error("EligibilityCert PDA not found after phase_2");
  const events = eventsFromLogs(r.logs, ["EligibilityCertIssued"]);
  return {
    tx: r.sig,
    events,
    cert_expires_at: cert.expiresAt?.toString?.() ?? cert.certExpiresAt?.toString?.() ?? null,
    detail: "eligibility cert issued after the compressed 2-epoch confirmation",
  };
});

// --- [stage 9] REAL snapshotter (Rust bin) + SDK root-equality --------------------------
let ARTIFACT = null;
await stage(9, "REAL snapshotter (Rust bin) + SDK snapshot root-equality", async () => {
  const bin = pjoin(REPO_ROOT, "target", "debug", "grave-snapshotter-cli");
  if (!existsSync(bin)) throw new Error(`snapshotter bin missing at ${bin} (cargo build first)`);
  const outPath = pjoin(artifacts, "snapshot-artifact.json");
  const res = spawnSync(
    bin,
    [
      "--url",
      url,
      "--pool",
      POOL.toBase58(),
      "--amm",
      IDS.raydiumV4.toBase58(),
      "--lp-mint",
      LP_MINT.toBase58(),
      "--out",
      outPath,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`grave-snapshotter-cli failed: ${res.stderr?.slice(-800)}`);
  ARTIFACT = JSON.parse(readFileSync(outPath, "utf8"));
  const sdkSnap = await client.snapshotLpHolders(POOL);
  const sdkRootHex = Buffer.from(sdkSnap.snapshot.merkleRoot).toString("hex");
  if (sdkRootHex !== ARTIFACT.merkle_root) {
    throw new Error(`merkle root mismatch: rust=${ARTIFACT.merkle_root} sdk=${sdkRootHex}`);
  }
  const rustSupply = BigInt(ARTIFACT.lp_total_supply_at_snapshot);
  const sdkSupply = BigInt(
    sdkSnap.snapshot.totalSupply.toString?.() ?? sdkSnap.snapshot.totalSupply,
  );
  if (rustSupply !== sdkSupply) {
    throw new Error(`supply mismatch: rust=${rustSupply} sdk=${sdkSupply}`);
  }
  return {
    rust_bin: bin,
    artifact: outPath,
    merkle_root: ARTIFACT.merkle_root,
    leaf_count: ARTIFACT.leaf_count,
    tree_depth: ARTIFACT.tree_depth,
    supply: ARTIFACT.lp_total_supply_at_snapshot,
    detail:
      "Rust SnapshotBuilder+SnapshotArtifact::seal output equals the SDK snapshot fleet-core feeds into salvage (root + supply + holders)",
  };
});

// --- [adversarial A6] paused-salvage → 7003 (BEFORE the real salvage) -------------------
// Proves the vault refuses to salvage while paused, atomically (no PDA survives).
async function currentSalvageInput() {
  const rootHex = ARTIFACT.merkle_root;
  const root = new Uint8Array(Buffer.from(rootHex, "hex"));
  const supply = BigInt(ARTIFACT.lp_total_supply_at_snapshot);
  const salvorLpAmount = BigInt(localPlan.burn_amount);
  // Route-account shim (labeled boundary): the conversion leg is config-skipped
  // (dust = u64::MAX), but fleet-core's destination validation still requires a
  // Jupiter-shaped route carrying the vault WSOL ATA as a writable entry. The
  // on-chain program parses but never executes the route on this path.
  const shimQuote = (req) => {
    console.error(
      `[shim] expect vault WSOL ATA=${VAULT_WSOL_ATA.toBase58()} req.dest=${String(req.destinationTokenAccount?.toBase58?.() ?? req.destinationTokenAccount)} amt=${req.amount}`,
    );
    return {
      inputMint: req.inputMint?.toBase58?.() ?? String(req.inputMint),
      outputMint: req.outputMint?.toBase58?.() ?? String(req.outputMint),
      inAmount: req.amount,
      // Positive on both legs (estimator gate); the conversion leg is
      // config-skipped on-chain (dust = u64::MAX) so this number is never
      // executed — fleet-core-side validation shim only (labeled boundary).
      outAmount: req.amount,
      slippageBps: req.slippageBps,
      routeData: new Uint8Array([0x00]),
      routeAccounts: [{ pubkey: VAULT_WSOL_ATA, isSigner: false, isWritable: true }],
      quotedAtMs: Date.now(),
      adapter: "w1-route-shim",
    };
  };
  return {
    root,
    supply,
    salvorLpAmount,
    routeAdapter: { name: "w1-route-shim", quote: shimQuote },
  };
}

function buildSalvageIx(input) {
  return SDK.buildSalvagePoolIx(
    salvageIxInput({
      merkleRoot: input.root,
      supply: input.supply,
      salvorLpAmount: input.salvorLpAmount,
    }),
  );
}

const SALVAGE_TOKEN_WATCH = () => ({
  salvor_lp: SALVOR_LP_ATA,
  vault_wsol: VAULT_WSOL_ATA,
  vault_memecoin: VAULT_MEMECOIN_ATA,
  treasury_memecoin: TREASURY_MEMECOIN_ATA,
});

{
  const { root, supply, salvorLpAmount } = await currentSalvageInput();
  const pauseIx = SDK.buildVaultEmergencyPauseIx({
    vaultProgramId: IDS.vault,
    authority: K.authority.publicKey,
    paused: true,
  });
  const rp = await sendTx(connection, [pauseIx], [K.authority]);
  if (rp.err) throw new Error(`vault pause failed: ${jsonSafe(rp.err)}`);
  try {
    await expectRevert({
      id: "A6",
      name: "salvage_pool while the vault is paused → 7003",
      ixs: [buildSalvageIx({ root, supply, salvorLpAmount })],
      signers: [K.salvor],
      expectCode: 7003,
      pdaMustStayAbsent: [
        ["salvage_receipt", SALVAGE_RECEIPT],
        ["pool_registry", POOL_REGISTRY],
        ["lp_holder_pool", LP_HOLDER_POOL],
      ],
      tokenAccounts: SALVAGE_TOKEN_WATCH(),
      viaAlt: true, // F2: the salvage ix exceeds the 1232-byte legacy packet
      altAddress: ALT_ADDRESS,
    });
  } finally {
    const unpauseIx = SDK.buildVaultEmergencyPauseIx({
      vaultProgramId: IDS.vault,
      authority: K.authority.publicKey,
      paused: false,
    });
    const ru = await sendTx(connection, [unpauseIx], [K.authority]);
    if (ru.err) throw new Error(`vault unpause failed: ${jsonSafe(ru.err)}`);
  }
}

// --- [adversarial A7] tampered snapshot supply → 7018 (BEFORE the real salvage) ---------
{
  const { root, supply, salvorLpAmount } = await currentSalvageInput();
  await expectRevert({
    id: "A7",
    name: "salvage_pool with a tampered lp_total_supply_at_snapshot → 7018",
    ixs: [buildSalvageIx({ root, supply: supply + 1n, salvorLpAmount })],
    signers: [K.salvor],
    expectCode: 7018,
    pdaMustStayAbsent: [
      ["salvage_receipt", SALVAGE_RECEIPT],
      ["pool_registry", POOL_REGISTRY],
      ["lp_holder_pool", LP_HOLDER_POOL],
    ],
    tokenAccounts: SALVAGE_TOKEN_WATCH(),
    viaAlt: true, // F2
    altAddress: ALT_ADDRESS,
  });
}

// --- [stages 10+11] salvage via fleet-core mode:"live" salvage-only ----------------------
const FLEET_EVENTS_PATH = pjoin(artifacts, "fleet-events.jsonl");
const fleetEvents = [];
const eventSink = {
  emit(event) {
    fleetEvents.push(event);
    try {
      appendFileSync(FLEET_EVENTS_PATH, jsonSafe(event) + "\n");
    } catch {}
  },
};

// REAL submit path over the pre-warmed ALT (fix 11 / F2): compile the SAME
// instructions into a v0 message; the legacy packet could not carry them.
const altTxSender = async (conn, tx, signers) => {
  const payer = tx.feePayer ?? signers[0].publicKey;
  const recentBlockhash = tx.recentBlockhash ?? (await conn.getLatestBlockhash()).blockhash;
  // compileToV0Message needs fetched {key, state} tables (run-24 finding)
  const altFetched = await conn.getAddressLookupTable(ALT_ADDRESS);
  if (!altFetched?.value) throw new Error(`ALT ${ALT_ADDRESS.toBase58()} not resolvable`);
  const msg = new W3.TransactionMessage({
    payerKey: payer,
    recentBlockhash,
    instructions: tx.instructions,
  }).compileToV0Message([altFetched.value]);
  const vtx = new W3.VersionedTransaction(msg);
  await vtx.sign(signers);
  const sig = await conn.sendRawTransaction(vtx.serialize(), {
    skipPreflight: true,
    maxRetries: 0,
  });
  await confirmSig(conn, sig);
  return sig;
};

let PIPELINE = null;
let FLEET_SIGNATURE = null;
let FLEET_IDENTITY = null;

await stage(
  10,
  'fleet-core salvage-only prepare + simulate (mode:"live", real pipeline)',
  async () => {
    const { routeAdapter } = await currentSalvageInput();
    FLEET_IDENTITY = {
      cluster: "localnet",
      ammProgramId: IDS.raydiumV4.toBase58(),
      poolAddress: POOL.toBase58(),
    };
    const cert = await SDK.fetchEligibilityCert(connection, CERT_PDA);
    const env = FC.buildEnvelope({
      identity: FLEET_IDENTITY,
      kind: "salvageable",
      sourceBot: "w1-rehearsal",
      detectedAtMs: Date.now(),
      score: null,
      firstEligibleEpoch: null,
      certExpiresAt: cert?.expiresAt != null ? BigInt(cert.expiresAt) : null,
    });
    FC.validateEnvelope(env);
    const store = new FC.InMemoryFleetStore();
    const admitted = await FC.admitDelivery(store, "w1-rehearsal", env);
    if (!admitted)
      throw new Error(
        "envelope admission returned duplicate — at-most-once gate tripped unexpectedly",
      );

    const policy = {
      botId: "w1-rehearsal",
      cluster: "localnet",
      mode: "live",
      accepts: { kinds: ["salvageable"] },
      retryBackoffMs: 1000,
      minNetProfitLamports: 0n,
      feeMarginRatio: 0.25,
      computeUnitLimit: 1_400_000,
      slippageBpsOverride: null,
      maxSubmitAttempts: 3,
      leaseTtlMs: 120_000,
      quoteMaxAgeMs: 15_000,
      minCertRemainingMs: 120_000,
      maxOpportunityAgeMs: 21_600_000,
    };
    PIPELINE = new FC.ExecutionPipeline({
      client,
      policy,
      liveEnablement: {
        enabled: true,
        acknowledgedBy: "owner authorization — W1 rehearsal, Handoff Vol IV §8 (verbatim)",
      },
      routeAdapter,
      eventSink,
      txSender: altTxSender,
    });
    const preparedOutcome = await PIPELINE.prepare({ envelope: env, salvor: K.salvor.publicKey });
    if (!preparedOutcome.ok || !preparedOutcome.prepared) {
      throw new Error(
        `fleet-core prepare failed: stage=${preparedOutcome.stage} class=${preparedOutcome.failureClass} reason=${preparedOutcome.reason}`,
      );
    }
    const simulated = await PIPELINE.simulate(preparedOutcome.prepared, FLEET_IDENTITY);
    if (!simulated.ok) {
      throw new Error(
        `fleet-core simulate failed: stage=${simulated.stage} class=${simulated.failureClass} reason=${simulated.reason} logs=${jsonSafe(simulated.simulation?.logs?.slice?.(-4) ?? null)}`,
      );
    }
    globalThis.__fleetPrepared = preparedOutcome.prepared; // stash for stage 11
    return {
      kind: preparedOutcome.prepared.kind,
      snapshot_summary: {
        merkle_root: Buffer.from(preparedOutcome.prepared.snapshotSummary.merkleRoot).toString(
          "hex",
        ),
        total_supply: preparedOutcome.prepared.snapshotSummary.totalSupply.toString(),
        salvor_lp_amount: preparedOutcome.prepared.snapshotSummary.salvorLpAmount.toString(),
        holder_count: preparedOutcome.prepared.snapshotSummary.holderCount,
      },
      fee_micro_lamports_per_cu:
        preparedOutcome.prepared.feeMicroLamportsPerCu?.toString?.() ?? null,
      detail:
        "revalidate → 13-account V4 derivation → LP snapshot → estimator → route validation → assemble; simulated through the salvor SDK path",
    };
  },
);

await stage(
  11,
  "fleet-core salvage submit through the REAL live submit path (v0/ALT)",
  async () => {
    const prepared = fleetPrepared();
    const submitted = await PIPELINE.submit({
      prepared,
      signer: K.salvor,
      identity: FLEET_IDENTITY,
    });
    if (!submitted.ok || !submitted.signature) {
      throw new Error(
        `fleet-core submit failed: stage=${submitted.stage} class=${submitted.failureClass} reason=${submitted.reason}`,
      );
    }
    FLEET_SIGNATURE = submitted.signature;
    const logs = (await txLogs(FLEET_SIGNATURE)) ?? [];
    const receipt = await SDK.fetchSalvageReceipt(connection, SALVAGE_RECEIPT);
    if (!receipt) throw new Error("SalvageReceipt PDA missing after the live salvage submit");
    const events = eventsFromLogs(logs, ["PoolSalvaged", "SalvageCompleted"]);
    return {
      signature: FLEET_SIGNATURE,
      receipt: {
        total: receipt.totalProceedsLamports?.toString?.(),
        salvor: receipt.salvorAmountLamports?.toString?.(),
        lp_holders: receipt.lpHolderAmountLamports?.toString?.(),
        protocol: receipt.protocolAmountLamports?.toString?.(),
        dust_memecoin: receipt.dustMemecoinLamports?.toString?.(),
        slot: receipt.issuedAtSlot?.toString?.(),
      },
      events,
      detail:
        'first-ever real submit-path execution: prepare→simulate→submit through fleet-core mode:"live" with at-most-once admission; conversion leg skipped by config (C3), dust recorded for sweep_dust',
    };
  },
);
function fleetPrepared() {
  // stage 11 re-fetches the prepared tx from the stage-10 closure via the report
  // pipeline — kept simple: the pipeline object holds no state we need beyond
  // what submit takes, so stage 10 stashed it here.
  return globalThis.__fleetPrepared;
}
function txLogs(sig) {
  return connection
    .getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
    .then((r) => r?.meta?.logMessages ?? null);
}

// stage 10 must stash the prepared tx for stage 11 (submit mutates blockhash)
const _origStage10 = true;

// --- [stage 12] settlement 40/40/20 ±1 ----------------------------------------------------
await stage(12, "settlement shares 40/40/20 ±1 lamport (receipt)", async () => {
  const receipt = await SDK.fetchSalvageReceipt(connection, SALVAGE_RECEIPT);
  if (!receipt) throw new Error("receipt missing");
  const total = BigInt(receipt.totalProceedsLamports);
  const legs = {
    lpHolder: BigInt(receipt.lpHolderAmountLamports),
    salvor: BigInt(receipt.salvorAmountLamports),
    protocol: BigInt(receipt.protocolAmountLamports),
  };
  if (legs.lpHolder + legs.salvor + legs.protocol !== total)
    throw new Error("settlement legs do not sum to total");
  // The program's split: LP and salvor legs are FLOORS of 40% each; the
  // protocol leg takes the exact remainder (run-36 finding: the 20% leg can
  // deviate from floor(20%) by up to +2 lamports — the rounding remainder).
  const floorLeg = (total * 4000n) / 10_000n;
  const protocolRemainder = total - floorLeg - floorLeg;
  const ok =
    legs.lpHolder === floorLeg && legs.salvor === floorLeg && legs.protocol === protocolRemainder;
  if (!ok)
    throw new Error(
      `shares out of tolerance: ${jsonSafe({ total: total.toString(), expected: { lp: floorLeg.toString(), salvor: floorLeg.toString(), protocol: protocolRemainder.toString() }, ...Object.fromEntries(Object.entries(legs).map(([k, v]) => [k, v.toString()])) })}`,
    );
  const poolInfo = await connection.getAccountInfo(LP_HOLDER_POOL);
  const poolBal = BigInt(await connection.getBalance(LP_HOLDER_POOL));
  // The salvage tx CREATES the lp_holder_pool PDA — its balance is the LP
  // leg plus the account's own rent-exempt reserve (run-33 finding).
  const rent = poolInfo
    ? BigInt(await connection.getMinimumBalanceForRentExemption(poolInfo.data.length))
    : 0n;
  if (poolBal !== legs.lpHolder + rent) {
    throw new Error(
      `lp_holder_pool balance ${poolBal} != lpHolder leg ${legs.lpHolder} + rent ${rent}`,
    );
  }
  return {
    total_lamports: total.toString(),
    legs_lamports: Object.fromEntries(Object.entries(legs).map(([k, v]) => [k, v.toString()])),
    lp_holder_pool_balance: poolBal.toString(),
    lp_holder_pool_rent: rent.toString(),
    detail: "40/40/20 bps settlement verified against the on-chain receipt AND the PDA balance",
  };
});

// --- [stage 13] monitor.reconcile → receipt-verified ---------------------------------------
await stage(13, "salvor-bots monitor reconcile (file: import @graveyield/monitor)", async () => {
  const monitor = new MON.FleetMonitor({
    client: monitorClient,
    config: {
      botId: "w1-rehearsal-monitor",
      staleAfterMs: 86_400_000,
      verificationGraceMs: 600_000,
      maxAttemptsPerIdentity: 5,
    },
    sink: eventSink,
  });
  const identityKey = `${FLEET_IDENTITY.cluster}|${FLEET_IDENTITY.ammProgramId}|${FLEET_IDENTITY.poolAddress}`;
  const rec = await monitor.reconcile(identityKey, "w1-rehearsal", FLEET_SIGNATURE);
  // Finding D fix: accepted outcomes are EXPLICIT (monitor_gate.mjs). The
  // shipped monitor verifies within a ±1-lamport share tolerance; the program
  // allocates the PROTOCOL leg as the exact remainder, which can deviate from
  // floor(20%) by up to +2 lamports (run-40 finding). A "receipt-verified"
  // status is accepted as verified; a "receipt-anomaly" is accepted ONLY when
  // it is exactly the known rounding remainder (sums + reported figures agree
  // and every leg equals its exact program allocation) — the discrepancy's
  // magnitude and reason are recorded in the stage output and run report.
  // Any genuinely unexpected anomaly is rejected and fails the stage. The
  // anomaly is never relabeled as verified.
  const verdict = classifyReconciliation(rec);
  if (!verdict.accepted) {
    throw new Error(
      `monitor status=${rec.status} verdict=${verdict.kind} reason=${verdict.reason} detail=${jsonSafe(rec.detail)} receipt=${jsonSafe(rec.receipt)}`,
    );
  }
  return {
    status: rec.status,
    accepted_kind: verdict.kind,
    protocol_delta_lamports:
      verdict.protocolDeltaLamports === null ? null : verdict.protocolDeltaLamports.toString(),
    verdict_reason: verdict.reason,
    detail: rec.detail,
    receipt: rec.receipt,
    identity_key: identityKey,
  };
});

// --- [adversarial A8] replayed salvage → registry init failure (AFTER the real salvage) ----
{
  const { root, supply, salvorLpAmount } = await currentSalvageInput();
  // FIX (recorded per red line 5): the replay dies in the Anchor init of the
  // already-existing pool_registry (AccountAlreadyInitialized family) —
  // classified "anchor-decode" (foreign custom code on a GraveYield program ix).
  await expectRevert({
    id: "A8",
    name: "replayed salvage_pool after a completed salvage → registry init failure",
    ixs: [buildSalvageIx({ root, supply, salvorLpAmount })],
    signers: [K.salvor],
    expectFamily: "anchor-decode",
    tokenAccounts: SALVAGE_TOKEN_WATCH(),
    // The replay must not touch the completed receipt, the pool registry,
    // or the LP-holder pool PDA either.
    accountsUnchanged: [
      ["salvage_receipt", SALVAGE_RECEIPT],
      ["pool_registry", POOL_REGISTRY],
      ["lp_holder_pool", LP_HOLDER_POOL],
    ],
    viaAlt: true, // F2
    altAddress: ALT_ADDRESS,
    note: "exact code pinned by observation: Anchor account-already-initialized precedes any handler logic",
  });
}

// --- [stage 14] claim_lp_proceeds ×N from the Rust artifact proofs -------------------------
await stage(
  14,
  "claim_lp_proceeds ×N from Rust artifact proofs (+ dup/7010 negatives)",
  async () => {
    const supply = BigInt(ARTIFACT.lp_total_supply_at_snapshot);
    const entriesByOwner = new Map((ARTIFACT.entries ?? []).map((e) => [String(e.owner), e]));
    const claimants = [
      { name: "claimant_a", kp: K.claimantA },
      { name: "claimant_b", kp: K.claimantB },
      { name: "salvor", kp: K.salvor },
    ];
    const claims = [];
    // Each claim is computed against the RECEIPT's recorded LP leg (fixed at
    // salvage time), NOT the running PDA balance — run-35 finding, verified
    // numerically against both paid claims.
    const receiptForClaims = await SDK.fetchSalvageReceipt(connection, SALVAGE_RECEIPT);
    if (!receiptForClaims) throw new Error("receipt missing before claims");
    const lpLeg = BigInt(receiptForClaims.lpHolderAmountLamports);
    for (const c of claimants) {
      const entry = entriesByOwner.get(c.kp.publicKey.toBase58());
      if (!entry) throw new Error(`snapshot artifact has no entry for ${c.name}`);
      const proof = (entry.proof ?? []).map((h) => new Uint8Array(Buffer.from(h, "hex")));
      const poolBefore = BigInt(await connection.getBalance(LP_HOLDER_POOL));
      const ix = SDK.buildClaimLpProceedsIx({
        vaultProgramId: IDS.vault,
        poolAddress: POOL,
        lpHolder: c.kp.publicKey,
        lpBalanceAtSnapshot: BigInt(entry.lp_balance),
        merkleProof: proof,
      });
      const r = await sendTx(connection, [ix], [c.kp]);
      if (r.err)
        throw new Error(
          `claim ${c.name} failed: ${jsonSafe(r.err)} logs=${(r.logs ?? []).slice(-5)}`,
        );
      const poolAfter = BigInt(await connection.getBalance(LP_HOLDER_POOL));
      const expected = (lpLeg * BigInt(entry.lp_balance)) / supply;
      if (poolBefore - poolAfter !== expected) {
        throw new Error(`claim ${c.name}: paid ${poolBefore - poolAfter} expected ${expected}`);
      }
      claims.push({
        holder: c.name,
        paid: (poolBefore - poolAfter).toString(),
        expected: expected.toString(),
      });
    }
    if (
      !(await SDK.fetchClaimRecord(
        connection,
        SDK.claimRecordPda(IDS.vault, POOL, K.claimantA.publicKey),
      ))
    ) {
      throw new Error("ClaimRecord for claimant_a missing after claim");
    }
    return {
      claims,
      detail:
        "every holder paid exactly floor(pool × balance / supply) per the Rust artifact proofs; ClaimRecords initialized",
    };
  },
);

// --- [adversarial A9] claim battery: duplicate / bad proof / inflated -----------------------
{
  const entriesByOwner = new Map((ARTIFACT.entries ?? []).map((e) => [String(e.owner), e]));
  const entryA = entriesByOwner.get(K.claimantA.publicKey.toBase58());
  const entryB = entriesByOwner.get(K.claimantB.publicKey.toBase58());
  const proofA = (entryA.proof ?? []).map((h) => new Uint8Array(Buffer.from(h, "hex")));
  const proofB = (entryB.proof ?? []).map((h) => new Uint8Array(Buffer.from(h, "hex")));

  // A9a: duplicate claim — ClaimRecord already initialized → Anchor init failure
  const dupIx = SDK.buildClaimLpProceedsIx({
    vaultProgramId: IDS.vault,
    poolAddress: POOL,
    lpHolder: K.claimantA.publicKey,
    lpBalanceAtSnapshot: BigInt(entryA.lp_balance),
    merkleProof: proofA,
  });
  await expectRevert({
    id: "A9a",
    name: "duplicate claim_lp_proceeds → ClaimRecord init failure",
    ixs: [dupIx],
    signers: [K.claimantA],
    expectFamily: "anchor-decode",
    tokenAccounts: SALVAGE_TOKEN_WATCH(),
    // The duplicate must not alter claimant A's existing ClaimRecord.
    accountsUnchanged: [
      ["claim_record_a", SDK.claimRecordPda(IDS.vault, POOL, K.claimantA.publicKey)],
    ],
    note: "exact code pinned by observation: AccountAlreadyInitialized on the claim_record init (fork precedent lp_claim_fork L1569-1589)",
  });

  // A9b: tampered merkle proof → 7010.
  // The negatives are driven by the INTRUDER wallet: every legitimate holder's
  // ClaimRecord already exists after stage 14, and Anchor's `init` runs BEFORE
  // the handler — an already-in-use allocate (custom 0) would mask the proof
  // check (run-37 finding). With the intruder the record init succeeds and
  // rolls back atomically on the 7010 revert (zero movement, fee only).
  const badProof = proofB.map((p) => new Uint8Array(p));
  if (badProof.length === 0) throw new Error("artifact proof empty — cannot tamper");
  badProof[0][0] ^= 0x01;
  const badIx = SDK.buildClaimLpProceedsIx({
    vaultProgramId: IDS.vault,
    poolAddress: POOL,
    lpHolder: K.intruder.publicKey,
    lpBalanceAtSnapshot: BigInt(entryB.lp_balance),
    merkleProof: badProof,
  });
  await expectRevert({
    id: "A9b",
    name: "claim with a tampered merkle proof → 7010 (proof does not bind (holder, amount))",
    ixs: [badIx],
    signers: [K.intruder],
    expectCode: 7010,
    tokenAccounts: SALVAGE_TOKEN_WATCH(),
    // The intruder's rolled-back record init must leave no PDA behind.
    pdaMustStayAbsent: [
      ["claim_record_intruder", SDK.claimRecordPda(IDS.vault, POOL, K.intruder.publicKey)],
    ],
  });

  // A9c: inflated payout — balance inflated past the proof binding → 7010
  // (the proof binds (holder, balance); the fork's 7009 in-VM path is the
  // supply-math overflow which a bound proof cannot reach — labeled boundary).
  const inflatedIx = SDK.buildClaimLpProceedsIx({
    vaultProgramId: IDS.vault,
    poolAddress: POOL,
    lpHolder: K.intruder.publicKey,
    lpBalanceAtSnapshot: BigInt(entryA.lp_balance) * 2n,
    merkleProof: proofA,
  });
  await expectRevert({
    id: "A9c",
    name: "claim with an inflated lp_balance_at_snapshot → proof binding rejects (7010)",
    ixs: [inflatedIx],
    signers: [K.intruder],
    expectCode: 7010,
    tokenAccounts: SALVAGE_TOKEN_WATCH(),
    pdaMustStayAbsent: [
      ["claim_record_intruder", SDK.claimRecordPda(IDS.vault, POOL, K.intruder.publicKey)],
    ],
    note: "fork-covered boundary: the fork's 7009 math-overflow needs in-VM registry control; on a live validator the proof binding rejects first with 7010",
  });
}

// --- [stage 15] sweep_dust positive + re-sweep negative (observed 3012) ----------------------
await stage(15, "sweep_dust (permissionless) positive + re-sweep negative", async () => {
  let dust = 0n;
  try {
    dust = BigInt((await connection.getTokenAccountBalance(VAULT_MEMECOIN_ATA)).value.amount);
  } catch {
    throw new Error("vault memecoin ATA missing before sweep — no dust to sweep?");
  }
  // The treasury ATA is created BY the sweep (init_if_needed) — absent before it.
  let treasuryBefore = 0n;
  try {
    treasuryBefore = BigInt(
      (await connection.getTokenAccountBalance(TREASURY_MEMECOIN_ATA)).value.amount,
    );
  } catch {
    treasuryBefore = 0n;
  }
  const ix = SDK.buildSweepDustIx({
    vaultProgramId: IDS.vault,
    poolAddress: POOL,
    memecoinMint: MEMECOIN,
    sweeper: K.salvor.publicKey,
  });
  const r = await sendTx(connection, [ix], [K.salvor]);
  if (r.err)
    throw new Error(`sweep_dust failed: ${jsonSafe(r.err)} logs=${(r.logs ?? []).slice(-5)}`);
  const treasuryAfter = BigInt(
    (await connection.getTokenAccountBalance(TREASURY_MEMECOIN_ATA)).value.amount,
  );
  if (treasuryAfter - treasuryBefore !== dust)
    throw new Error(`treasury delta ${treasuryAfter - treasuryBefore} != dust ${dust}`);
  let vaultAtaGone = false;
  try {
    await connection.getTokenAccountBalance(VAULT_MEMECOIN_ATA);
  } catch {
    vaultAtaGone = true;
  }
  if (!vaultAtaGone)
    throw new Error("vault memecoin ATA still exists after sweep (should be closed)");
  // negative: second sweep. FIX (recorded per red line 5, run-39 finding):
  // the first sweep CLOSED the vault memecoin ATA, so the re-sweep's Anchor
  // TokenAccount decode dies with 3012 (AccountNotInitialized) BEFORE the
  // handler's 7021 DustAlreadySwept — the one-shot guard is provably intact
  // either way (the account cannot be swept twice; the state is destroyed).
  // Finding B/C fix: asserted through expectRevert so the zero-movement
  // evidence is MEASURED (fee pinned to meta.fee, treasury ATA + receipt
  // byte-identical), and the stage text names the OBSERVED code (3012), not
  // the handler's unreachable 7021 (fork-covered).
  await expectRevert({
    id: "S15-resweep",
    name: "second sweep_dust → 3012 (closed vault ATA decode; one-shot guard intact — 7021 unreachable on a live validator)",
    ixs: [
      SDK.buildSweepDustIx({
        vaultProgramId: IDS.vault,
        poolAddress: POOL,
        memecoinMint: MEMECOIN,
        sweeper: K.salvor.publicKey,
      }),
    ],
    signers: [K.salvor],
    expectCode: 3012,
    tokenAccounts: SALVAGE_TOKEN_WATCH(),
    accountsUnchanged: [
      ["salvage_receipt", SALVAGE_RECEIPT],
      ["pool_registry", POOL_REGISTRY],
    ],
    note: "fork-covered: the fork suites assert 7021 in-VM where the ATA can be re-funded; on a live validator the closed account decode precedes the handler",
  });
  return {
    dust_memecoin_lamports: dust.toString(),
    treasury_delta: (treasuryAfter - treasuryBefore).toString(),
    detail:
      "dust swept to the protocol treasury ATA; vault ATA closed; re-sweep reverted 3012 (closed-ATA Anchor decode precedes the handler's 7021 — fork-covered)",
  };
});

// --- [stage 16] pause / intruder / unpause drills (protocol_admin.mjs, reused verbatim) ------
await stage(16, "emergency-control drills via protocol_admin.mjs (scanner + vault)", async () => {
  const adminScript = pjoin(REPO_ROOT, "scripts", "devnet", "protocol_admin.mjs");
  const results = [];
  for (const program of ["scanner", "vault"]) {
    const res = spawnSync(
      "node",
      [
        adminScript,
        "drill",
        "--url",
        url,
        "--authority",
        pjoin(keys, "authority.json"),
        "--intruder",
        pjoin(keys, "intruder.json"),
        "--program",
        program,
        // C3: the vault was initialized with dust = u64::MAX (conversion leg
        // config-skipped) — tell the drill what the honest expected value is.
        ...(program === "vault" ? ["--expect-vault-dust", U64_MAX.toString()] : []),
      ],
      { encoding: "utf8" },
    );
    if (res.status !== 0) {
      throw new Error(
        `drill ${program} exited ${res.status}: ${(res.stderr || res.stdout || "").slice(-600)}`,
      );
    }
    results.push({ program, ok: true });
  }
  return {
    drills: results,
    detail:
      "production emergency-control drill green on both programs: init-assert → pause → assert → intruder-must-revert (6000/7000) → unpause",
  };
});

// --- finish ------------------------------------------------------------------------------------
const boundaries = [
  "synthetic C1 lastSwap timestamps (fork-precedented)",
  "synthetic-collapse launch price ×200 (fork-precedented)",
  "LP mint supply re-pinned to the local holder set; economics grounded in manifest amm_lp_amount (C6)",
  "conversion leg config-skipped via u64::MAX dust — canonical full_lifecycle_fork shape (C3)",
  "route-account shim satisfies fleet-core destination validation; never executed on-chain (skipped leg)",
  "7002 expired-cert negative fork-covered (no wall-clock fast-forward on a live validator)",
  "A9c inflated-payout binds to 7010 on a live validator (fork's 7009 needs in-VM registry control)",
  "7002/6016 gap-1 timing may land fork-covered if the compressed clock passes the gap before stage 7",
  "stage-13 monitor tolerance: a receipt-anomaly that is EXACTLY the program's protocol-leg rounding remainder is accepted and recorded with its magnitude (Finding D) — never relabeled as receipt-verified",
  "stage-15 re-sweep reverts 3012 (closed-ATA Anchor decode) on a live validator; the handler's 7021 is fork-covered (Finding C)",
  "market fixture adaptation (F3): the local market's nonce + market-vault owners are re-pointed to fleet-core's string-seed vault-signer PDA — a fleet-core-compatibility adaptation that deviates from the real OpenBook derivation ([market, nonce]); see local_plan.market + probe_vault_signer.mjs (Finding E)",
];
const doc = report.finish({
  boundaries,
  alt_address: ALT_ADDRESS.toBase58(),
  fleet_signature: FLEET_SIGNATURE,
  fleet_events: fleetEvents.length,
});
if (!doc.all_pass) process.exit(1);
console.log(
  `W1 LIFECYCLE REHEARSAL COMPLETE — 16 stages + adversarial battery all green (ALT ${ALT_ADDRESS.toBase58()}, salvage ${FLEET_SIGNATURE})`,
);
