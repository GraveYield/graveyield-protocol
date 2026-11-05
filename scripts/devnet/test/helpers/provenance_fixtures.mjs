// SPDX-License-Identifier: Apache-2.0
//
// provenance_fixtures.mjs — test-only fixture builders for the provenance
// gate and acceptance-verifier suites. NOT a test file (the runner's glob
// is 'test/**/*.test.mjs').
//
// buildSbfElf() fabricates a minimal but structurally valid ELF64 that
// passes/fails ns3_verify_elf's structural checks exactly as instructed:
// the expected 32-byte program ID is placed INSIDE a SHF_ALLOC|SHF_EXECINSTR
// section, optional legacy ID bytes can be injected anywhere, and the
// e_machine/e_flags pair controls the SBPF architecture verdict.
//
// The account encoders mirror the byte layouts documented (and on-chain
// verified) in docs/LEGACY_DEPLOYMENTS.md §3 and the Rust state structs.
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

/**
 * Build a minimal ELF64.
 * opts:
 *   idBase58    — program ID whose 32 bytes are embedded in .text
 *   eMachine    — default 263 (SBPF v0)
 *   eFlags      — default 0 (SBPF v0)
 *   injectBytes — [{ bytes, alloc: true|false }] extra byte runs appended
 *                 to .text (alloc) or to a non-allocated .note section
 *   padTo       — pad the tail with zeros to reach a minimum size
 */
export function buildSbfElf({ idBase58, eMachine = 263, eFlags = 0, injectBytes = [], padTo = 0 }) {
  const idBytes = Buffer.from(new PublicKey(idBase58).toBytes());
  const textData = Buffer.concat([
    Buffer.alloc(64, 0),
    idBytes,
    Buffer.alloc(32, 0),
    ...injectBytes.filter((x) => x.alloc).map((x) => x.bytes),
  ]);
  const noteData = Buffer.concat(injectBytes.filter((x) => !x.alloc).map((x) => x.bytes));

  const strtab = Buffer.from("\0.text\0.shstrtab\0.note\0", "utf8");
  // Section name offsets within .shstrtab: .text=1, .shstrtab=7, .note=17
  const sections = [
    { nameOff: 0, type: 0, flags: 0 }, // NULL
    { nameOff: 1, type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, size: textData.length },
    { nameOff: 7, type: SHT_STRTAB, flags: 0, size: strtab.length },
    { nameOff: 17, type: SHT_PROGBITS, flags: 0, size: noteData.length }, // .note (NOT allocated)
  ];
  const ehsz = 64;
  const shentsz = 64;
  const shnum = sections.length;
  const textOff = ehsz;
  const noteOff = textOff + textData.length;
  const strtabOff = noteOff + noteData.length;
  const shoff = strtabOff + strtab.length;
  const total = shoff + shnum * shentsz;

  const buf = Buffer.alloc(total);
  // ---- ELF header
  ELF_MAGIC.copy(buf, 0);
  buf[4] = 2; // EI_CLASS ELFCLASS64
  buf[5] = 1; // EI_DATA LSB
  buf[6] = 1; // EI_VERSION
  buf.writeUInt16LE(2, 16); // e_type EXEC
  buf.writeUInt16LE(eMachine, 18);
  buf.writeUInt32LE(1, 20); // e_version
  buf.writeBigUInt64LE(0x1000n, 24); // e_entry
  buf.writeBigUInt64LE(0n, 32); // e_phoff
  buf.writeUInt32LE(eFlags, 36);
  buf.writeBigUInt64LE(BigInt(shoff), 40); // e_shoff
  buf.writeUInt16LE(ehsz, 52); // e_ehsize
  buf.writeUInt16LE(0, 54); // e_phentsize
  buf.writeUInt16LE(0, 56); // e_phnum
  buf.writeUInt16LE(shentsz, 58);
  buf.writeUInt16LE(shnum, 60);
  buf.writeUInt16LE(2, 62); // e_shstrndx
  textData.copy(buf, textOff);
  noteData.copy(buf, noteOff);
  strtab.copy(buf, strtabOff);
  // ---- section headers
  const offs = { 1: textOff, 2: strtabOff, 3: noteOff };
  sections.forEach((s, i) => {
    const base = shoff + i * shentsz;
    buf.writeUInt32LE(s.nameOff, base);
    buf.writeUInt32LE(s.type, base + 4);
    buf.writeBigUInt64LE(BigInt(s.flags), base + 8);
    buf.writeBigUInt64LE(0n, base + 16); // sh_addr (unused by the verifier)
    buf.writeBigUInt64LE(BigInt(offs[i] ?? 0), base + 24);
    buf.writeBigUInt64LE(BigInt(s.size ?? 0), base + 32);
  });
  if (padTo && buf.length < padTo) {
    return Buffer.concat([buf, Buffer.alloc(padTo - buf.length, 0)]);
  }
  return buf;
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ------------------------------------------------- loader account encoders

/** BPF-upgradeable PROGRAM account: u32 tag=2 + 32-byte ProgramData pointer. */
export function encodeProgramAccount(programdataBase58) {
  const buf = Buffer.alloc(36);
  buf.writeUInt32LE(2, 0);
  Buffer.from(new PublicKey(programdataBase58).toBytes()).copy(buf, 4);
  return buf;
}

/**
 * BPF-upgradeable PROGRAMDATA account: u32 tag=3 + u64 slot + 1-byte
 * authority-set flag + optional 32-byte upgrade authority (offset 13).
 *
 * Tag values are the UpgradeableLoaderState bincode enum ordinals (u32
 * LE) — 0=Uninitialized, 1=Buffer, 2=Program, 3=ProgramData — verified
 * independently against the anza-xyz/solana-sdk loader-v3-interface
 * sources (size_of_program()=36, size_of_programdata_metadata()=45) and
 * live on-chain bytes (see verify_ns3_deployment.mjs header). Tests
 * additionally pin the literal bytes so an encoder/decoder drift cannot
 * self-certify.
 */
export function encodeProgramDataAccount({ slot = 1_000n, authority = null }) {
  const body = Buffer.alloc(45);
  body.writeUInt32LE(3, 0);
  body.writeBigUInt64LE(slot, 4);
  if (authority) {
    body.writeUInt8(1, 12);
    Buffer.from(new PublicKey(authority).toBytes()).copy(body, 13);
  } else {
    body.writeUInt8(0, 12);
  }
  return body;
}

// -------------------------------------------------- ProtocolConfig encoders

function disc() {
  return createHash("sha256").update("account:ProtocolConfig").digest().subarray(0, 8);
}

/** GraveScanner ProtocolConfig (252 B) — offsets mirror the Rust struct. */
export function encodeScannerConfig({
  authority,
  pendingAuthority = "11111111111111111111111111111111",
  pendingAuthorityEta = 0n,
  inactivitySeconds = 7_776_000n,
  priceCollapseBps = 9_900,
  minTvlLamports = 500_000_000n,
  anchorStalenessSeconds = 1_209_600n,
  lpBurnDustThreshold = 1_000n,
  certTtlSeconds = 3_600n,
  paused = false,
  activityOracle,
  launchPriceOracle,
  bump = 255,
}) {
  const buf = Buffer.alloc(252);
  disc().copy(buf, 0);
  Buffer.from(new PublicKey(authority).toBytes()).copy(buf, 8);
  Buffer.from(new PublicKey(pendingAuthority).toBytes()).copy(buf, 40);
  const v = new DataView(buf.buffer);
  v.setBigInt64(72, pendingAuthorityEta, true);
  v.setBigUint64(80, inactivitySeconds, true);
  v.setUint16(88, priceCollapseBps, true);
  v.setBigUint64(90, minTvlLamports, true);
  v.setBigUint64(98, anchorStalenessSeconds, true);
  v.setBigUint64(106, lpBurnDustThreshold, true);
  v.setBigInt64(114, certTtlSeconds, true);
  buf.writeUInt8(paused ? 1 : 0, 122);
  Buffer.from(new PublicKey(activityOracle).toBytes()).copy(buf, 123);
  Buffer.from(new PublicKey(launchPriceOracle).toBytes()).copy(buf, 155);
  buf.writeUInt8(bump, 187);
  return buf;
}

/** GraveVault ProtocolConfig (210 B) — offsets mirror the Rust struct. */
export function encodeVaultConfig({
  authority,
  pendingAuthority = "11111111111111111111111111111111",
  pendingAuthorityEta = 0n,
  lpHolderShareBps = 4_000,
  salvorShareBps = 4_000,
  protocolShareBps = 2_000,
  maxPriorityFeeCeilingLamports = 1_000_000_000n,
  maxSlippageBps = 300,
  jupiterDustThresholdLamports = 666_666n,
  timelockSeconds = 259_200n,
  emergencyPaused = false,
  bump = 255,
}) {
  const buf = Buffer.alloc(210);
  disc().copy(buf, 0);
  Buffer.from(new PublicKey(authority).toBytes()).copy(buf, 8);
  Buffer.from(new PublicKey(pendingAuthority).toBytes()).copy(buf, 40);
  const v = new DataView(buf.buffer);
  v.setBigInt64(72, pendingAuthorityEta, true);
  v.setUint16(80, lpHolderShareBps, true);
  v.setUint16(82, salvorShareBps, true);
  v.setUint16(84, protocolShareBps, true);
  v.setBigUint64(86, maxPriorityFeeCeilingLamports, true);
  v.setUint16(94, maxSlippageBps, true);
  v.setBigUint64(96, jupiterDustThresholdLamports, true);
  v.setBigInt64(104, timelockSeconds, true);
  buf.writeUInt8(emergencyPaused ? 1 : 0, 112);
  buf.writeUInt8(bump, 113);
  return buf;
}

/** Minimal JSON-RPC account-info value for the mock RPC. */
export function rpcAccount(dataBuf, { owner, executable = false, lamports = 1_000_000 }) {
  return {
    data: [dataBuf.toString("base64"), "base64"],
    executable,
    lamports,
    owner: typeof owner === "string" ? owner : owner.toBase58(),
    rentEpoch: 18446744073709551615,
  };
}
