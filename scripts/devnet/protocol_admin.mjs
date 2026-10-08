// SPDX-License-Identifier: Apache-2.0
//
// protocol_admin.mjs — GraveYield devnet/rehearsal administration tool.
//
// Constructs the two programs' Anchor instructions directly (no IDL files in
// this repo — `anchor build` is CI-only) and drives the deployment sequence
// documented in docs/DEVNET.md:
//
//   node protocol_admin.mjs init-scanner --url <U> --deployer <KP> [--authority <PK>]
//   node protocol_admin.mjs init-vault   --url <U> --deployer <KP> [--authority <PK>]
//   node protocol_admin.mjs init-all     --url <U> --deployer <KP> [--authority <PK>]
//   node protocol_admin.mjs pause        --url <U> --authority <KP> --program scanner|vault --state true|false
//   node protocol_admin.mjs check        --url <U> --program scanner|vault
//   node protocol_admin.mjs drill        --url <U> --authority <KP> --intruder <KP> --program scanner|vault
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

// ---------------------------------------------------------------- constants

/** Devnet program IDs — mirrored in Anchor.toml and both declare_id! calls. */
export const SCANNER_PROGRAM_ID = new PublicKey(
  "5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF",
);
export const VAULT_PROGRAM_ID = new PublicKey(
  "HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6",
);

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

/** ['protocol_config'] PDA under a program ID. */
export function configPda(programId) {
  const [pda] = PublicKey.findProgramAddressSync(
    [PROTOCOL_CONFIG_SEED],
    programId,
  );
  return pda;
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
  const view = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );
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

function loadKeypair(path) {
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
      throw new Error(
        `FAIL: ${program}.${field} = ${gotStr}, expected ${wantStr}`,
      );
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

async function cmdInit(args, programs) {
  const url = requireOpt(args, "url");
  const deployer = loadKeypair(requireOpt(args, "deployer"));
  const authority =
    args.authority !== undefined
      ? new PublicKey(args.authority)
      : deployer.publicKey;
  const connection = new Connection(url, "confirmed");
  for (const program of programs) {
    console.log(`[${program}] initialize — payer ${deployer.publicKey.toBase58()}, authority ${authority.toBase58()}`);
    const sig = await sendInitTx(connection, program, deployer, authority);
    console.log(`  tx ${sig}`);
    const cfg = await readConfig(connection, program);
    if (!cfg || !cfg.authority.equals(authority)) {
      throw new Error(`FAIL: ${program} config readback after initialize`);
    }
    console.log(`  OK ${program} ProtocolConfig live at ${configPda(programIdFor(program)).toBase58()}`);
  }
}

async function cmdPause(args) {
  const url = requireOpt(args, "url");
  const authority = loadKeypair(requireOpt(args, "authority"));
  const program = requireOpt(args, "program");
  const state = requireOpt(args, "state") === "true";
  const connection = new Connection(url, "confirmed");
  const ix = buildPauseIx(programIdFor(program), authority.publicKey, state);
  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(ix),
    [authority],
  );
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

async function cmdDrill(args) {
  const url = requireOpt(args, "url");
  const authority = loadKeypair(requireOpt(args, "authority"));
  const intruder = loadKeypair(requireOpt(args, "intruder"));
  const program = requireOpt(args, "program");
  const pausedField = program === "scanner" ? "paused" : "emergencyPaused";
  const unauthorizedCode = program === "scanner" ? 6000 : 7000;
  const connection = new Connection(url, "confirmed");
  const programId = programIdFor(program);

  console.log(`[${program}] emergency-control drill`);
  // 1. Freshly initialized config: authority set, defaults, not paused.
  const defaults = program === "scanner" ? SCANNER_DEFAULTS : VAULT_DEFAULTS;
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
    throw new Error(
      `FAIL: intruder pause LANDED — ${program} accepted a non-authority signer`,
    );
  } catch (err) {
    const decoded = decodeProgramError(err);
    if (!decoded || decoded.code !== unauthorizedCode) {
      throw err;
    }
    console.log(`  OK intruder rejected: ${decoded.name} (${decoded.hex})`);
  }
  // 5. Authority unpauses; readback restored.
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(buildPauseIx(programId, authority.publicKey, false)),
    [authority],
  );
  await assertConfig(connection, program, { [pausedField]: false });
  console.log(`  OK authority unpaused — drill complete for ${program}`);
  void programId;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "init-scanner":
      return cmdInit(args, ["scanner"]);
    case "init-vault":
      return cmdInit(args, ["vault"]);
    case "init-all":
      return cmdInit(args, ["scanner", "vault"]);
    case "pause":
      return cmdPause(args);
    case "check":
      return cmdCheck(args);
    case "drill":
      return cmdDrill(args);
    default:
      console.error(
        "usage: protocol_admin.mjs <init-scanner|init-vault|init-all|pause|check|drill> --url <U> ... (see header comment)",
      );
      process.exitCode = 2;
  }
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
