// SPDX-License-Identifier: Apache-2.0
//
// protocol_admin.mjs — GraveYield devnet/rehearsal administration tool.
//
// Constructs the two programs' Anchor instructions directly (no IDL files in
// this repo — `anchor build` is CI-only) and drives the deployment sequence
// documented in docs/DEVNET.md:
//
//   node protocol_admin.mjs init-scanner --url <U> --deployer <KP> --authority <PK>
//   node protocol_admin.mjs init-vault   --url <U> --deployer <KP> --authority <PK>
//   node protocol_admin.mjs init-all     --url <U> --deployer <KP> --authority <PK>
//   node protocol_admin.mjs pause        --url <U> --authority <KP> --program scanner|vault --state true|false
//   node protocol_admin.mjs check        --url <U> --program scanner|vault
//   node protocol_admin.mjs drill        --url <U> --authority <KP> --intruder <KP> --program scanner|vault
//   node protocol_admin.mjs register-oracle --url <U> --authority <KP>
//        [--fee-payer <KP>] [--activity-oracle <PK>] [--launch-price-oracle <PK>]
//
// CLUSTER IDENTITY (fail closed): every command — including read-only
// `check` — first verifies the target cluster's genesis hash BEFORE any
// signer file is loaded or any transaction is constructed. Public-cluster
// operations require the exact pinned Devnet genesis (ns3_identities.mjs,
// the same single source the deploy script and acceptance verifier use);
// an unavailable or foreign genesis refuses the command outright. The
// ONLY exception is the local rehearsal: `--allow-local-validator` is
// accepted ONLY for loopback endpoints (127.0.0.1 / localhost / ::1) and
// still requires a live, STRUCTURALLY VALID genesis answer (canonical
// Base58 of exactly 32 bytes) — it is never a bypass for remote RPC
// endpoints, and no other bypass exists.
//
// GOVERNANCE AUTHORITY (explicit, mandatory): the ProtocolConfig
// authority is a one-time, permanent choice, so it is NEVER defaulted —
// not even to the deployer. `init-*` require `--authority <PUBKEY>` and
// refuse a missing or malformed value before any signer file is loaded.
// On Devnet every governance operation (init-*, pause, register-oracle,
// drill) must use the pinned NS-3 governance authority; the deployer is
// the fee payer / upgrade authority and the oracles are dedicated
// signers — roles are never silently substituted for one another. The
// loopback rehearsal exception accepts the rehearsal's TEMPORARY
// governance keypair (generated per run; never hardcoded here).
//
// NS-3 authority arrangement (DR-002): the deployer keypair pays fees and
// holds the initial upgrade authority; the GOVERNANCE authority is the
// ProtocolConfig authority for both programs; the activity and launch-price
// oracles are dedicated keys registered post-initialization via
// `register-oracle` (update_protocol_config). `--fee-payer` on
// register-oracle keeps the governance key OFF the fee-paying path: the
// instruction is signed by the governance authority, the transaction fee
// is paid by the separate fee-payer keypair.
//
// `drill` is the Phase 11 "emergency controls tested" exercise, executed
// against devnet (or a local solana-test-validator rehearsal — see
// local_rehearsal.sh):
//
//   1. readback asserts the freshly initialized config (authority, defaults,
//      unpaused),
//   2. authority pauses,
//   3. readback asserts the flag flipped,
//   4. an intruder keypair attempts pause and the transaction MUST revert
//      with the program's Unauthorized error (6000 scanner / 7000 vault),
//   5. authority unpauses, readback asserts restored.
//
// Byte-layout sources (normative, do not drift):
//   - programs/grave-scanner/src/instructions/initialize.rs     (params)
//   - programs/grave-vault/src/instructions/initialize.rs       (params)
//   - programs/grave-scanner/src/instructions/emergency_pause.rs (accounts)
//   - programs/grave-vault/src/instructions/emergency_pause.rs   (accounts)
//   - programs/grave-scanner/src/state/protocol_config.rs       (readback)
//   - programs/grave-vault/src/state/protocol_config.rs         (readback)
//   - programs/*/src/constants.rs                               (PDA seeds)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { NS3, DEVNET_GENESIS_HASH } from "./ns3_identities.mjs";

// ---------------------------------------------------------------- constants

/**
 * NS-3 devnet program IDs (owner-generated, owner-held keypairs; DR-002) —
 * mirrored in Anchor.toml and both declare_id! calls. Deployment and
 * on-chain acceptance are PENDING: until the owner executes the NS-3
 * deployment (docs/DEVNET.md), these addresses answer nothing on devnet.
 * NS-2 (CuQZes…/Bd5smh…) and NS-1 (5JiCVx…/HUyoG5…) are preserved as legacy
 * records in docs/LEGACY_DEPLOYMENTS.md.
 */
export const SCANNER_PROGRAM_ID = new PublicKey("EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL");
export const VAULT_PROGRAM_ID = new PublicKey("7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya");

const PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config", "utf8");

/** Anchor discriminator = first 8 bytes of sha256("global:<snake_name>"). */
function globalDiscriminator(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/** Anchor account discriminator = first 8 bytes of sha256("account:<Name>"). */
function accountDiscriminator(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

// ------------------------------------------------------------ borsh writers

function writer(size) {
  const buf = Buffer.alloc(size);
  let at = 0;
  return {
    bytes(b) {
      b.copy(buf, at);
      at += b.length;
      return this;
    },
    u16(v) {
      buf.writeUInt16LE(v, at);
      at += 2;
      return this;
    },
    u64(v) {
      buf.writeBigUInt64LE(BigInt(v), at);
      at += 8;
      return this;
    },
    i64(v) {
      buf.writeBigInt64LE(BigInt(v), at);
      at += 8;
      return this;
    },
    done() {
      if (at !== buf.length) {
        throw new Error(`borsh writer filled ${at}/${buf.length} bytes`);
      }
      return buf;
    },
  };
}

/** PublicKey as raw 32-byte buffer. */
function pk(pubkey) {
  return Buffer.from(pubkey.toBytes());
}

// ------------------------------------------------------- instruction builders

/**
 * GraveScanner::initialize
 * params: authority(32) u64 u16 u64 u64 u64 i64 = 74 bytes
 * accounts: protocol_config(mut) payer(mut+signer) system_program
 */
export function buildScannerInitializeIx({ programId, authority, payer }) {
  const data = writer(8 + 74)
    .bytes(globalDiscriminator("initialize"))
    .bytes(pk(authority))
    .u64(0) // inactivity_seconds          0 = default 90d
    .u16(0) // price_collapse_bps          0 = default 9_900
    .u64(0) // min_tvl_lamports            0 = default 0.5 SOL
    .u64(0) // anchor_staleness_seconds    0 = default 14d
    .u64(0) // lp_burn_dust_threshold      0 = default 1_000
    .i64(0) // cert_ttl_seconds            0 = default 3_600 (floor 600)
    .done();
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * GraveVault::initialize
 * params: authority(32) u16 u16 u16 u64 u16 u64 i64 = 64 bytes
 * accounts: protocol_config(mut) payer(mut+signer) system_program
 */
export function buildVaultInitializeIx({ programId, authority, payer }) {
  const data = writer(8 + 64)
    .bytes(globalDiscriminator("initialize"))
    .bytes(pk(authority))
    .u16(0) // lp_holder_share_bps              0 = default 4_000
    .u16(0) // salvor_share_bps                 0 = default 4_000
    .u16(0) // protocol_share_bps               0 = default 2_000 (Charter ceiling)
    .u64(0) // max_priority_fee_ceiling_lamports 0 = default 1 SOL per CU
    .u16(0) // max_slippage_bps                 0 = default 300
    .u64(0) // jupiter_dust_threshold_lamports  0 = default 666_666
    .i64(0) // timelock_seconds                 0 = default 72h
    .done();
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * emergency_pause (both programs, identical shape):
 * params: bool (1 byte); accounts: protocol_config(mut) authority(signer).
 */
export function buildEmergencyPauseIx({ programId, authority, paused }) {
  return buildPauseIx(programId, authority, paused);
}

function buildPauseIx(programId, authority, paused) {
  const buf = Buffer.alloc(9);
  globalDiscriminator("emergency_pause").copy(buf, 0);
  buf.writeUInt8(paused ? 1 : 0, 8);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: buf,
  });
}

/**
 * GraveScanner::update_protocol_config — variable-length borsh params
 * (8×Option fields). Used by `register-oracle` to set the dedicated
 * activity / launch-price oracle signers. Layout (normative):
 * programs/grave-scanner/src/instructions/update_protocol_config.rs
 *   Option<u64>, Option<u16>, Option<u64>, Option<u64>, Option<u64>,
 *   Option<i64>, Option<Pubkey>, Option<Pubkey>
 * None = 0x00; Some = 0x01 + LE value. Oracle-only update (both oracles,
 * scalars None) = 8(disc) + 6 + 33 + 33 = 80 bytes — the same shape the
 * lifecycle harness's register_oracle.mjs pins.
 * accounts: [protocol_config PDA (mut), authority (signer)]
 */
export function buildScannerUpdateProtocolConfigIx({
  programId,
  authority,
  activityOracle = null,
  launchPriceOracle = null,
  inactivitySeconds = null,
  priceCollapseBps = null,
  minTvlLamports = null,
  anchorStalenessSeconds = null,
  lpBurnDustThreshold = null,
  certTtlSeconds = null,
}) {
  const optU64 = (v) =>
    v === null
      ? Buffer.from([0x00])
      : Buffer.concat([
          Buffer.from([0x01]),
          (() => {
            const b = Buffer.alloc(8);
            b.writeBigUInt64LE(BigInt(v));
            return b;
          })(),
        ]);
  const optI64 = (v) =>
    v === null
      ? Buffer.from([0x00])
      : Buffer.concat([
          Buffer.from([0x01]),
          (() => {
            const b = Buffer.alloc(8);
            b.writeBigInt64LE(BigInt(v));
            return b;
          })(),
        ]);
  const optU16 = (v) =>
    v === null
      ? Buffer.from([0x00])
      : Buffer.concat([
          Buffer.from([0x01]),
          (() => {
            const b = Buffer.alloc(2);
            b.writeUInt16LE(v);
            return b;
          })(),
        ]);
  const optPk = (v) =>
    v === null ? Buffer.from([0x00]) : Buffer.concat([Buffer.from([0x01]), pk(new PublicKey(v))]);
  const data = Buffer.concat([
    globalDiscriminator("update_protocol_config"),
    optU64(inactivitySeconds),
    optU16(priceCollapseBps),
    optU64(minTvlLamports),
    optU64(anchorStalenessSeconds),
    optU64(lpBurnDustThreshold),
    optI64(certTtlSeconds),
    optPk(activityOracle),
    optPk(launchPriceOracle),
  ]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** ['protocol_config'] PDA under a program ID. */
export function configPda(programId) {
  const [pda] = findProgramAddressSync([PROTOCOL_CONFIG_SEED], programId);
  return pda;
}

/**
 * Assemble the register-oracle TRANSACTION (pure, no RPC): the instruction
 * plus the fee-payer wiring. The GOVERNANCE authority is the ONLY
 * instruction-level signer; the fee payer (deployer under the NS-3
 * arrangement) is the transaction-level fee payer and, when different
 * from the authority, an additional transaction-level signature. Exported
 * for offline tests — the fee-payer/authority separation is a wire
 * property the review pins.
 */
export function assembleOracleUpdateTransaction({ instruction, authorityPubkey, feePayerPubkey }) {
  const tx = new Transaction().add(instruction);
  tx.feePayer = feePayerPubkey;
  const instructionSignerCount = feePayerPubkey.equals(authorityPubkey) ? 1 : 2;
  return { tx, instructionSignerCount };
}

/**
 * Byte-exact sync PDA derivation — web3.js 3.x removed the 1.x
 * `PublicKey.findProgramAddressSync` static, and this script derives PDAs
 * in synchronous instruction-builder contexts. Mirrors the algorithm in
 * `sdk/src/web3compat.ts` (normative, do not drift): hash preimage
 * `seeds || bump || program_id || "ProgramDerivedAddress"`, on-curve
 * rejection via the 3.x public `PublicKey.isOnCurve`, bump searched
 * 255→0.
 */
function findProgramAddressSync(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const digest = createHash("sha256")
      .update(
        Buffer.concat([
          ...seeds,
          Buffer.from([bump]),
          programId.toBytes(),
          Buffer.from("ProgramDerivedAddress", "utf8"),
        ]),
      )
      .digest();
    if (!PublicKey.isOnCurve(digest)) {
      return [new PublicKey(digest), bump];
    }
  }
  throw new Error("unable to find program address: no off-curve bump found");
}

// ------------------------------------------------------------- readback map
//
// Borsh field offsets inside the 8-byte-discriminated ProtocolConfig
// accounts, hand-derived from the state structs. asserted by the drill.

const SCANNER_DEFAULTS = {
  inactivitySeconds: 90n * 24n * 60n * 60n, // 7_776_000
  priceCollapseBps: 9_900,
  minTvlLamports: 500_000_000n,
  anchorStalenessSeconds: 14n * 24n * 60n * 60n, // 1_209_600
  lpBurnDustThreshold: 1_000n,
  certTtlSeconds: 3_600n,
};

const VAULT_DEFAULTS = {
  lpHolderShareBps: 4_000,
  salvorShareBps: 4_000,
  protocolShareBps: 2_000,
  maxPriorityFeeCeilingLamports: 1_000_000_000n,
  maxSlippageBps: 300,
  jupiterDustThresholdLamports: 666_666n,
  timelockSeconds: 72n * 60n * 60n, // 259_200
};

/**
 * Decode a ProtocolConfig account. Returns plain field names per program.
 * Offsets (after the 8-byte account discriminator):
 *   scanner: authority@8 pending@40 eta@72 inactivity@80 collapse(u16)@88
 *            minTvl@90 staleness@98 burnDust@106 certTtl(i64)@114
 *            paused(u8)@122 activityOracle@123 launchPriceOracle@155 bump@187
 *   vault:   authority@8 pending@40 eta@72 lpBps(u16)@80 salvorBps@82
 *            protoBps@84 prioFee@86 slipBps(u16)@94 dust@96 timelock@104
 *            emergencyPaused(u8)@112 bump@113
 */
export function decodeProtocolConfig(program, data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pkAt = (off) => new PublicKey(data.subarray(off, off + 32));
  const u64At = (off) => view.getBigUint64(off, true);
  const i64At = (off) => view.getBigInt64(off, true);
  const u16At = (off) => view.getUint16(off, true);
  if (program === "scanner") {
    return {
      program,
      accountDiscriminator: Buffer.from(data.subarray(0, 8)),
      authority: pkAt(8),
      pendingAuthority: pkAt(40),
      inactivitySeconds: u64At(80),
      priceCollapseBps: u16At(88),
      minTvlLamports: u64At(90),
      anchorStalenessSeconds: u64At(98),
      lpBurnDustThreshold: u64At(106),
      certTtlSeconds: i64At(114),
      paused: view.getUint8(122) === 1,
      activityOracle: pkAt(123),
      launchPriceOracle: pkAt(155),
      bump: view.getUint8(187),
    };
  }
  return {
    program,
    accountDiscriminator: Buffer.from(data.subarray(0, 8)),
    authority: pkAt(8),
    pendingAuthority: pkAt(40),
    lpHolderShareBps: u16At(80),
    salvorShareBps: u16At(82),
    protocolShareBps: u16At(84),
    maxPriorityFeeCeilingLamports: u64At(86),
    maxSlippageBps: u16At(94),
    jupiterDustThresholdLamports: u64At(96),
    timelockSeconds: i64At(104),
    emergencyPaused: view.getUint8(112) === 1,
    bump: view.getUint8(113),
  };
}

// --------------------------------------------------------------- errors map
//
// Compact mirror of docs/error_codes.md — only the codes the drill can hit.
// Anchor custom errors surface as: custom program error: 0x<code hex>.

const ERROR_NAMES = {
  6000: "GraveScanner::Unauthorized",
  6001: "GraveScanner::PoolNotEligible",
  6010: "GraveScanner::ProtocolPaused",
  6015: "GraveScanner::AnchorNotFound",
  6016: "GraveScanner::EpochConfirmationPending",
  6034: "GraveScanner::CertStillValid",
  7000: "GraveVault::Unauthorized",
  7003: "GraveVault::ProtocolPaused",
  7001: "GraveVault::InvalidEligibilityCert",
  7002: "GraveVault::EligibilityCertExpired",
};

export function decodeProgramError(err) {
  const m = /custom program error: 0x([0-9a-fA-F]+)/.exec(String(err));
  if (!m) return undefined;
  const code = parseInt(m[1], 16);
  return { code, hex: `0x${m[1]}`, name: ERROR_NAMES[code] ?? `code ${code}` };
}

// ------------------------------------------------------------------ actions

async function loadKeypair(path) {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
}

function programIdFor(program) {
  if (program === "scanner") return SCANNER_PROGRAM_ID;
  if (program === "vault") return VAULT_PROGRAM_ID;
  throw new Error(`unknown program '${program}' (expected scanner|vault)`);
}

async function readConfig(connection, program) {
  const programId = programIdFor(program);
  const info = await connection.getAccountInfo(configPda(programId));
  if (!info) return null;
  return decodeProtocolConfig(program, Buffer.from(info.data));
}

async function assertConfig(connection, program, expect) {
  const cfg = await readConfig(connection, program);
  if (!cfg) throw new Error(`FAIL: ${program} ProtocolConfig PDA does not exist`);
  const acctDisc = accountDiscriminator("ProtocolConfig");
  if (!cfg.accountDiscriminator.equals(acctDisc)) {
    throw new Error(
      `FAIL: ${program} account discriminator mismatch — not a ProtocolConfig account`,
    );
  }
  for (const [field, want] of Object.entries(expect)) {
    const got = cfg[field];
    const gotStr = typeof got === "bigint" ? got.toString() : String(got);
    const wantStr = typeof want === "bigint" ? want.toString() : String(want);
    if (gotStr !== wantStr) {
      throw new Error(`FAIL: ${program}.${field} = ${gotStr}, expected ${wantStr}`);
    }
  }
  console.log(`  OK ${program} config: ${Object.keys(expect).join(", ")} as expected`);
  return cfg;
}

async function sendInitTx(connection, program, payer, authority) {
  const programId = programIdFor(program);
  const ix =
    program === "scanner"
      ? buildScannerInitializeIx({ programId, authority, payer: payer.publicKey })
      : buildVaultInitializeIx({ programId, authority, payer: payer.publicKey });
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(connection, tx, [payer]);
}

// ------------------------------------------------------ cluster identity
//
// The CLI performs STATE-CHANGING operations (initialization, pause/
// unpause, oracle registration). It must never act on an unintended
// cluster, so EVERY command — including the read-only `check` — verifies
// the target's cluster identity BEFORE any signer file is loaded, any
// keypair is parsed, or any transaction is constructed (single guarded
// entry point in main()). The pinned Devnet genesis hash is the same
// single-source constant the deployment script and the acceptance
// verifier use (ns3_identities.mjs) — there is no second copy to drift.
//
// The ONLY exception is the local rehearsal against a solana-test-
// validator: it is explicit (--allow-local-validator), restricted to
// loopback endpoints by strict hostname equality, and still requires the
// endpoint to PROVE it is a live Solana cluster by answering the read-
// only genesis RPC. A remote endpoint is never "local", the opt-in is
// refused for any non-loopback URL, and no generic bypass flag exists.

// WHATWG URL.hostname keeps IPv6 brackets ("[::1]"), so both spellings
// are listed — the comparison is exact host equality either way.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const GENESIS_RPC_TIMEOUT_MS = 30_000;

/**
 * True ONLY for http(s) URLs whose HOST is a loopback address. Strict
 * equality on the parsed hostname: "localhost.evil.com" is not local,
 * and neither is any DNS name that merely resolves to 127.0.0.1 — the
 * URL itself must name the loopback host.
 */
export function isLoopbackUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
}

/** Race a promise against a timeout; the timer is unref'd so a fast
 *  success never keeps the process alive for the full timeout window.
 *  Exported ONLY so regression tests can pin the timeout contract on the
 *  isolated helper; production callers always go through
 *  rpcGetGenesisHash with the production duration below. */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The real genesis fetch — a READ-ONLY RPC call (getGenesisHash) raced
 * against a timeout so a silent endpoint fails closed instead of hanging
 * the guard. Exported for regression tests, which may inject a SHORTER
 * duration to make the timeout deterministic without waiting out the
 * production 30s; the production default is unchanged and there is no
 * environment override.
 */
export async function rpcGetGenesisHash(url, timeoutMs = GENESIS_RPC_TIMEOUT_MS) {
  const connection = new Connection(url, "confirmed");
  return withTimeout(connection.getGenesisHash(), timeoutMs, "getGenesisHash");
}

/**
 * Structural validation of a genesis hash ANSWER: it must be the canonical
 * Base58 encoding of exactly 32 bytes (a genesis hash is the same shape as
 * an ed25519 public key). The PublicKey constructor enforces Base58
 * decodability and the decoded 32-byte length; the round-trip `toBase58()`
 * comparison additionally rejects non-canonical spellings. This is what
 * the local-validator exception checks — it has no pinnable value to
 * compare against (a local validator mints a fresh genesis per run), so a
 * structurally impossible answer (empty, non-Base58, wrong length) must
 * still fail closed. The Devnet path does not need this: its exact
 * pinned-hash comparison already refuses anything malformed.
 */
export function isCanonicalBase58Genesis32(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

/**
 * Cluster-identity guard — FAILS CLOSED. Returns { mode, genesisHash }
 * where mode is "devnet" (exact pinned genesis matched) or "local"
 * (explicit loopback rehearsal opt-in with a live genesis answer).
 * Any RPC failure, timeout, empty or malformed answer, or foreign
 * genesis throws — an un-verifiable cluster is never a license to
 * continue, and nothing has been signed or submitted at this point.
 *
 * `getGenesisHash` is injectable for tests; the default performs the
 * real read-only RPC. Tests that inject a fake are unit tests and are
 * labeled as such — they never stand in for the real rehearsal.
 */
export async function assertClusterIdentity(args, { getGenesisHash = rpcGetGenesisHash } = {}) {
  const url = requireOpt(args, "url");
  const localOptIn = args["allow-local-validator"] === true;

  if (localOptIn) {
    if (!isLoopbackUrl(url)) {
      throw new Error(
        `REFUSING: --allow-local-validator was passed for '${url}', which is NOT a loopback endpoint. ` +
          "The local-validator exception exists only for the local rehearsal " +
          "(http://127.0.0.1:8899 or http://localhost:8899) and is never a cluster-identity " +
          "bypass for remote RPC endpoints.",
      );
    }
    // Even in rehearsal mode the endpoint must prove it is a live Solana
    // cluster: a local validator mints a fresh genesis per run, so there
    // is no pinnable value — but the answer must still be STRUCTURALLY
    // possible (canonical Base58, exactly 32 bytes). Silence, garbage
    // ("not-a-genesis-hash"), a wrong-length Base58 value, or a non-string
    // response is a refusal, exactly like an unreachable endpoint.
    let localGenesis;
    try {
      localGenesis = await getGenesisHash(url);
    } catch (err) {
      throw new Error(
        `REFUSING: the local validator at ${url} could not be reached for a genesis hash ` +
          `(${err.message ?? err}) — cluster identity could not be established. ` +
          "Failing closed; nothing was signed or submitted.",
      );
    }
    if (!isCanonicalBase58Genesis32(localGenesis)) {
      const shown =
        typeof localGenesis === "string"
          ? JSON.stringify(localGenesis.slice(0, 64))
          : typeof localGenesis;
      throw new Error(
        `REFUSING: the local validator at ${url} reported a malformed genesis hash ` +
          `(expected the canonical Base58 encoding of exactly 32 bytes, got ${shown}) — ` +
          "cluster identity could not be established. Failing closed; " +
          "nothing was signed or submitted.",
      );
    }
    console.log(
      `cluster identity: LOCAL REHEARSAL validator at ${url} (loopback opt-in; genesis ${localGenesis})`,
    );
    return { mode: "local", genesisHash: localGenesis };
  }

  let genesis;
  try {
    genesis = await getGenesisHash(url);
  } catch (err) {
    throw new Error(
      `REFUSING: ${url} did not report a genesis hash — cluster identity could NOT be ` +
        `verified (RPC failure: ${err.message ?? err}; pinned Devnet genesis: ` +
        `${DEVNET_GENESIS_HASH}). Failing closed; nothing was signed or submitted.`,
    );
  }
  if (typeof genesis !== "string" || genesis.length === 0) {
    throw new Error(
      `REFUSING: ${url} did not report a genesis hash — cluster identity could NOT be ` +
        `verified (pinned Devnet genesis: ${DEVNET_GENESIS_HASH}). Failing closed; ` +
        "nothing was signed or submitted.",
    );
  }
  if (genesis !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `REFUSING: the cluster at ${url} is NOT Solana Devnet — reported genesis ${genesis}, ` +
        `pinned Devnet genesis ${DEVNET_GENESIS_HASH}. Failing closed; ` +
        "nothing was signed or submitted.",
    );
  }
  console.log(`cluster identity: Solana Devnet verified (genesis ${DEVNET_GENESIS_HASH})`);
  return { mode: "devnet", genesisHash: genesis };
}

// ---------------------------------------------------- governance authority
//
// The ProtocolConfig authority is a ONE-TIME, PERMANENT configuration
// choice: whichever key initializes becomes the only key that can later
// rotate config fields through the governance flow. The CLI therefore
// never defaults it (not even to the deployer), never silently
// substitutes one role for another, and — outside the explicit loopback
// rehearsal exception — accepts only the pinned NS-3 governance public
// key for Devnet operations. Roles stay separate: the GOVERNANCE
// authority signs governance instructions; the DEPLOYER is the fee
// payer / initial upgrade authority; the two oracles are dedicated
// signers.

/**
 * Parse the MANDATORY --authority PUBLIC-key argument (init-* commands).
 * A missing or malformed authority is a refusal BEFORE any signer file
 * is loaded — there is no deployer fallback (removed deliberately:
 * silently initializing with the deployer as authority would break the
 * NS-3 role separation permanently).
 */
export function parseExplicitAuthority(args) {
  const raw = args.authority;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(
      "missing required --authority <PUBKEY> — the ProtocolConfig authority is a one-time, " +
        "permanent choice and is NEVER defaulted (not even to the deployer). Pass the " +
        "governance authority explicitly.",
    );
  }
  try {
    const pk = new PublicKey(raw);
    if (pk.toBase58() !== raw) {
      throw new Error("not canonical base58");
    }
    return pk;
  } catch {
    throw new Error(
      `malformed --authority '${raw}' is not a valid base58 public key — ` +
        "refusing before any signer file is loaded",
    );
  }
}

/**
 * Governance-authority pin for public-cluster operations: on Devnet the
 * authority must be EXACTLY the pinned NS-3 governance key
 * (ns3_identities.mjs NS3.governanceAuthority). The loopback rehearsal
 * exception (cluster.mode === "local") accepts the rehearsal's TEMPORARY
 * governance keypair — generated fresh per rehearsal run, never
 * hardcoded here, and never valid outside local mode.
 */
export function assertGovernanceAuthority(
  cluster,
  authorityPubkey,
  { label = "--authority" } = {},
) {
  if (cluster.mode === "local") return;
  const want = NS3.governanceAuthority;
  const got = authorityPubkey.toBase58();
  if (got !== want) {
    throw new Error(
      `REFUSING: ${label} ${got} is not the pinned NS-3 governance authority ${want}. ` +
        "On Devnet, governance operations must use the governance key — the deployer " +
        "(fee payer / upgrade authority) and the oracles are separate roles and are never " +
        "substituted for it.",
    );
  }
}

// --------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) {
        out[k] = v;
      } else {
        // `--key value` (space-separated): consume the next argv element as
        // the value unless it is itself another flag.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out[k] = next;
          i++;
        } else {
          out[k] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function requireOpt(args, name) {
  const v = args[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required --${name}`);
  }
  return v;
}

async function cmdInit(args, programs, cluster) {
  const url = requireOpt(args, "url");
  // AUTHORITY FIRST — before any signer file is touched: initialization is
  // one-time, so a wrong authority must fail before anything is loaded,
  // let alone signed. (The old deployer fallback is removed deliberately.)
  const authority = parseExplicitAuthority(args);
  assertGovernanceAuthority(cluster, authority, { label: "--authority" });
  const deployer = await loadKeypair(requireOpt(args, "deployer"));
  const connection = new Connection(url, "confirmed");
  for (const program of programs) {
    console.log(
      `[${program}] initialize — payer ${deployer.publicKey.toBase58()}, authority ${authority.toBase58()}`,
    );
    const sig = await sendInitTx(connection, program, deployer, authority);
    console.log(`  tx ${sig}`);
    const cfg = await readConfig(connection, program);
    if (!cfg || !cfg.authority.equals(authority)) {
      throw new Error(`FAIL: ${program} config readback after initialize`);
    }
    console.log(
      `  OK ${program} ProtocolConfig live at ${configPda(programIdFor(program)).toBase58()}`,
    );
  }
}

async function cmdPause(args, cluster) {
  const url = requireOpt(args, "url");
  // Cluster identity was already verified in main() BEFORE this signer
  // load; on Devnet the loaded authority must be the pinned governance key.
  const authority = await loadKeypair(requireOpt(args, "authority"));
  assertGovernanceAuthority(cluster, authority.publicKey, { label: "--authority keypair" });
  const program = requireOpt(args, "program");
  const state = requireOpt(args, "state") === "true";
  const connection = new Connection(url, "confirmed");
  const ix = buildPauseIx(programIdFor(program), authority.publicKey, state);
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
  console.log(`[${program}] paused=${state} — tx ${sig}`);
  await assertConfig(connection, program, {
    [program === "scanner" ? "paused" : "emergencyPaused"]: state,
  });
}

async function cmdCheck(args) {
  const url = requireOpt(args, "url");
  const program = requireOpt(args, "program");
  const connection = new Connection(url, "confirmed");
  const cfg = await readConfig(connection, program);
  if (!cfg) {
    console.log(`[${program}] ProtocolConfig not initialized`);
    return;
  }
  const clean = { ...cfg, accountDiscriminator: cfg.accountDiscriminator.toString("hex") };
  for (const [k, v] of Object.entries(clean)) {
    const s = typeof v === "bigint" ? `${v}` : String(v);
    console.log(`[${program}] ${k} = ${s}`);
  }
}

async function cmdRegisterOracle(args, cluster) {
  const url = requireOpt(args, "url");
  // Cluster identity was already verified in main() BEFORE this signer
  // load; on Devnet the loaded authority must be the pinned governance key.
  // --fee-payer stays INDEPENDENT (defaults to the authority when omitted,
  // per docs/DEVNET.md §4); it never changes who the authority is.
  const authority = await loadKeypair(requireOpt(args, "authority"));
  assertGovernanceAuthority(cluster, authority.publicKey, { label: "--authority keypair" });
  const feePayer =
    args["fee-payer"] !== undefined ? await loadKeypair(args["fee-payer"]) : authority;
  const program = "scanner"; // update_protocol_config is a GraveScanner instruction
  const activity =
    args["activity-oracle"] !== undefined ? new PublicKey(args["activity-oracle"]) : null;
  const launch =
    args["launch-price-oracle"] !== undefined ? new PublicKey(args["launch-price-oracle"]) : null;
  if (!activity && !launch) {
    throw new Error(
      "nothing to update: pass --activity-oracle <PK> and/or --launch-price-oracle <PK>",
    );
  }
  const connection = new Connection(url, "confirmed");
  const ix = buildScannerUpdateProtocolConfigIx({
    programId: programIdFor(program),
    authority: authority.publicKey,
    activityOracle: activity,
    launchPriceOracle: launch,
  });
  const { tx, instructionSignerCount } = assembleOracleUpdateTransaction({
    instruction: ix,
    authorityPubkey: authority.publicKey,
    feePayerPubkey: feePayer.publicKey,
  });
  // The instruction is signed by the governance authority; the transaction
  // FEE is paid by the separate fee payer (deployer). Both must sign the
  // transaction; only the authority is an instruction-level signer.
  const signers = feePayer.publicKey.equals(authority.publicKey)
    ? [authority]
    : [feePayer, authority];
  if (signers.length !== instructionSignerCount) {
    throw new Error(
      `signer wiring invariant broken: transaction carries ${signers.length} signers ` +
        `but the instruction set requires ${instructionSignerCount}`,
    );
  }
  console.log(
    `[scanner] update_protocol_config — authority ${authority.publicKey.toBase58()}, fee payer ${feePayer.publicKey.toBase58()}` +
      `${activity ? `, activity_oracle → ${activity.toBase58()}` : ""}${launch ? `, launch_price_oracle → ${launch.toBase58()}` : ""}`,
  );
  const sig = await sendAndConfirmTransaction(connection, tx, signers);
  console.log(`  tx ${sig}`);
  const expect = {};
  if (activity) expect.activityOracle = activity.toBase58();
  if (launch) expect.launchPriceOracle = launch.toBase58();
  await assertConfig(connection, program, expect);
}

async function cmdDrill(args, cluster) {
  const url = requireOpt(args, "url");
  // Cluster identity was already verified in main() BEFORE these signer
  // loads; on Devnet the authority must be the pinned governance key. The
  // intruder is deliberately NEVER pinned — it exists to be rejected.
  const authority = await loadKeypair(requireOpt(args, "authority"));
  assertGovernanceAuthority(cluster, authority.publicKey, { label: "--authority keypair" });
  const intruder = await loadKeypair(requireOpt(args, "intruder"));
  const program = requireOpt(args, "program");
  const pausedField = program === "scanner" ? "paused" : "emergencyPaused";
  const unauthorizedCode = program === "scanner" ? 6000 : 7000;
  const connection = new Connection(url, "confirmed");
  const programId = programIdFor(program);

  console.log(`[${program}] emergency-control drill`);
  // 1. Freshly initialized config: authority set, defaults, not paused.
  // --expect-vault-dust: optional override for rehearsal harnesses that
  // initialize the vault with a non-default jupiter_dust_threshold
  // (e.g. the W1 lifecycle rehearsal's u64::MAX conversion-leg skip, C3).
  // Default stays the spec value — CI and manual drills are unaffected.
  const defaults = { ...(program === "scanner" ? SCANNER_DEFAULTS : VAULT_DEFAULTS) };
  if (program === "vault" && args["expect-vault-dust"] !== undefined) {
    defaults.jupiterDustThresholdLamports = BigInt(args["expect-vault-dust"]);
  }
  await assertConfig(connection, program, {
    authority: authority.publicKey.toBase58(),
    ...defaults,
    [pausedField]: false,
  });
  // 2. Authority pauses.
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(buildPauseIx(programId, authority.publicKey, true)),
    [authority],
  );
  console.log(`  OK authority paused`);
  // 3. Readback: flag flipped.
  await assertConfig(connection, program, { [pausedField]: true });
  // 4. Intruder pause MUST revert with the program's Unauthorized.
  try {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildPauseIx(programId, intruder.publicKey, true)),
      [intruder],
    );
    throw new Error(`FAIL: intruder pause LANDED — ${program} accepted a non-authority signer`);
  } catch (err) {
    const decoded = decodeProgramError(err);
    if (!decoded || decoded.code !== unauthorizedCode) {
      throw err;
    }
    console.log(`  OK intruder rejected: ${decoded.name} (${decoded.hex})`);
  }
  // 5. Post-intruder readback: the rejected unauthorized attempt must NOT
  // have changed the pause state. The authority paused in step 2 and nothing
  // unpaused it since, so the correct post-intruder expected state is TRUE —
  // the protocol is STILL paused here, for both programs. This independent
  // readback pins that the intruder rejection left the pause intact and that
  // only the authority's own unpause in step 6 restores false.
  await assertConfig(connection, program, { [pausedField]: true });
  // 6. Authority unpauses; readback restored.
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(buildPauseIx(programId, authority.publicKey, false)),
    [authority],
  );
  await assertConfig(connection, program, { [pausedField]: false });
  console.log(`  OK authority unpaused — drill complete for ${program}`);
  void programId;
}

const COMMANDS = {
  "init-scanner": (args, cluster) => cmdInit(args, ["scanner"], cluster),
  "init-vault": (args, cluster) => cmdInit(args, ["vault"], cluster),
  "init-all": (args, cluster) => cmdInit(args, ["scanner", "vault"], cluster),
  pause: (args, cluster) => cmdPause(args, cluster),
  // `check` is read-only and load-free: cluster identity is already proven
  // in main() for every command, and it touches no signer — it takes no
  // cluster (a superfluous one only invites drift).
  check: (args) => cmdCheck(args),
  "register-oracle": (args, cluster) => cmdRegisterOracle(args, cluster),
  drill: (args, cluster) => cmdDrill(args, cluster),
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(
      "usage: protocol_admin.mjs <init-scanner|init-vault|init-all|pause|check|register-oracle|drill> --url <U> ... (see header comment)",
    );
    process.exitCode = 2;
    return;
  }
  // CLUSTER IDENTITY FIRST — the single guarded entry point: this runs
  // BEFORE any command handler, therefore before any signer file is
  // loaded or any transaction is constructed, for every command
  // (including the read-only `check`). A missing --url fails here too —
  // a command without a named target has no verified cluster to run on.
  const cluster = await assertClusterIdentity(args);
  await handler(args, cluster);
}

// Run the CLI only when this file is the entry point — the module is also
// imported (e.g. golden-vector generation against the Rust tests).
import { pathToFileURL } from "node:url";
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(String(err.message ?? err));
    process.exit(1);
  });
}
