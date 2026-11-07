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
// buildExtendedCountElf() fabricates a spec-honest ELF64 whose section
// count exceeds the 16-bit e_shnum space (extended section numbering:
// e_shnum = 0, real count in SH0.sh_size, e_shstrndx = SHN_XINDEX with
// the real index in SH0.sh_link), for the full-valid-range parser and
// deployed-digest-verifier tests.
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

// ------------------------------------------------ extended-count ELF builder

/**
 * Build a spec-honest ELF64 whose section count exceeds the ordinary
 * 16-bit e_shnum space, exercising the EXTENDED SECTION NUMBERING escapes
 * (System V ABI / ELF gABI §1.7): e_shnum = 0 with the real count in
 * SH0.sh_size (u64), and (by default) e_shstrndx = SHN_XINDEX (0xffff)
 * with the real string-table index in SH0.sh_link (u32).
 *
 * Layout (payload-relative, exact fit — the section header table is the
 * last structure, so the structure-implied extent equals the file size):
 *   ELF header | .text (SHF_ALLOC|EXECINSTR, no ID) |
 *   .rodata (SHF_ALLOC, the 32-byte program ID INSIDE it) | .shstrtab |
 *   section header table (realShnum × 64 B)
 *
 * The program ID is placed ONLY in the section at `highIndex` (> 0xffff
 * by default): a parser that mishandles section iteration beyond the
 * 16-bit index space will not scan that section and the identity verdict
 * degrades to "absent" — the fixture therefore discriminates real
 * full-range support from a merely-accepted header.
 *
 * opts:
 *   idBase58        — program ID embedded in the high-index section
 *   realShnum       — section count written to SH0.sh_size (default 70000)
 *   highIndex       — index of the allocated .rodata (default 66000);
 *                     must be > 0xffff and < realShnum for the fixture to
 *                     exercise the extended index space
 *   physicalShnum   — entries the buffer ACTUALLY holds (default =
 *                     realShnum). A value < realShnum fabricates a
 *                     TRUNCATED extended table (declared table larger
 *                     than the available bytes) for fail-closed tests;
 *                     keep ≥ 1 so SH0 itself stays readable.
 *   countOverride   — writes this exact u64 into SH0.sh_size instead of
 *                     realShnum (0 / 2n**63n / 2n**52n fabricate invalid,
 *                     safe-integer-hostile, and arithmetic-overflow
 *                     counts respectively)
 *   directShstrndx  — write the string-table index directly into
 *                     e_shstrndx instead of the SHN_XINDEX escape
 *                     (default false — the escape is the interesting
 *                     case). `true` writes the .shstrtab section's own
 *                     index (strtabIndex); a NUMBER writes that exact raw
 *                     16-bit value — the reserved-value boundary family
 *                     (0xfeff valid / 0xff00..0xfffe reserved) is built
 *                     this way.
 *   strtabIndex     — section index the .shstrtab header is placed at
 *                     (default 2). A value deep in the index space (e.g.
 *                     0xfeff) lets a DIRECT e_shstrndx point at a real
 *                     string table while the count resolves through the
 *                     extended escape — the direct indices near
 *                     SHN_LORESERVE are only reachable over an extended
 *                     count. SH0.sh_link carries the same index so the
 *                     SHN_XINDEX escape resolves to it too.
 */
export function buildExtendedCountElf({
  idBase58,
  realShnum = 70000,
  highIndex = 66000,
  physicalShnum,
  countOverride,
  directShstrndx = false,
  strtabIndex = 2,
}) {
  if (highIndex <= 0xffff || highIndex >= realShnum) {
    throw new Error("buildExtendedCountElf: highIndex must be > 0xffff and < realShnum");
  }
  if (!Number.isInteger(strtabIndex) || strtabIndex < 1 || strtabIndex >= realShnum) {
    throw new Error("buildExtendedCountElf: strtabIndex must be >= 1 and < realShnum");
  }
  if (strtabIndex === highIndex) {
    throw new Error("buildExtendedCountElf: strtabIndex must not collide with highIndex");
  }
  const phys = physicalShnum ?? realShnum;
  if (phys < 1) throw new Error("buildExtendedCountElf: physicalShnum must be >= 1 (SH0 readable)");

  const idBytes = Buffer.from(new PublicKey(idBase58).toBytes());
  const textData = Buffer.alloc(96, 0);
  const rodataData = Buffer.concat([Buffer.alloc(32, 0), idBytes]);
  // name offsets within .shstrtab: .text=1, .shstrtab=7, .rodata=17
  const strtab = Buffer.from("\0.text\0.shstrtab\0.rodata\0", "utf8");

  const ehsz = 64;
  const shentsz = 64;
  const textOff = ehsz;
  const rodataOff = textOff + textData.length;
  const strtabOff = rodataOff + rodataData.length;
  const shoff = strtabOff + strtab.length;
  // The buffer holds only `phys` entries; the DECLARED count may be larger.
  const total = shoff + phys * shentsz;

  const buf = Buffer.alloc(total);
  // ---- ELF header
  ELF_MAGIC.copy(buf, 0);
  buf[4] = 2; // EI_CLASS ELFCLASS64
  buf[5] = 1; // EI_DATA LSB
  buf[6] = 1; // EI_VERSION
  buf.writeUInt16LE(2, 16); // e_type EXEC
  buf.writeUInt16LE(263, 18); // e_machine EM_SBF (SBPF v0)
  buf.writeUInt32LE(1, 20); // e_version
  buf.writeBigUInt64LE(0x1000n, 24); // e_entry
  buf.writeBigUInt64LE(0n, 32); // e_phoff
  buf.writeUInt32LE(0, 36); // e_flags (SBPF v0)
  buf.writeBigUInt64LE(BigInt(shoff), 40); // e_shoff
  buf.writeUInt16LE(ehsz, 52); // e_ehsize
  buf.writeUInt16LE(0, 54); // e_phentsize
  buf.writeUInt16LE(0, 56); // e_phnum
  buf.writeUInt16LE(shentsz, 58); // e_shentsize
  buf.writeUInt16LE(0, 60); // e_shnum = 0 → extended numbering
  // e_shstrndx resolution: number → that exact raw value (adversarial
  // boundaries); true → the .shstrtab index (direct); false → SHN_XINDEX.
  buf.writeUInt16LE(
    typeof directShstrndx === "number" ? directShstrndx : directShstrndx ? strtabIndex : 0xffff,
    62,
  );

  textData.copy(buf, textOff);
  rodataData.copy(buf, rodataOff);
  strtab.copy(buf, strtabOff);

  // ---- section header 0: the extended-numbering carrier (always present:
  // physicalShnum >= 1 is enforced so the declared count stays readable)
  buf.writeBigUInt64LE(countOverride ?? BigInt(realShnum), shoff + 32); // sh_size = real count
  buf.writeUInt32LE(strtabIndex, shoff + 40); // sh_link = .shstrtab index (u32)

  // ---- section 1: .text (allocated, executable, NO ID inside)
  if (phys > 1) {
    buf.writeUInt32LE(1, shoff + 1 * shentsz); // sh_name → ".text"
    buf.writeUInt32LE(SHT_PROGBITS, shoff + 1 * shentsz + 4);
    buf.writeBigUInt64LE(BigInt(SHF_ALLOC | SHF_EXECINSTR), shoff + 1 * shentsz + 8);
    buf.writeBigUInt64LE(BigInt(textOff), shoff + 1 * shentsz + 24);
    buf.writeBigUInt64LE(BigInt(textData.length), shoff + 1 * shentsz + 32);
  }

  // ---- the .shstrtab section (at strtabIndex — deep in the index space
  // when a direct e_shstrndx near SHN_LORESERVE is being exercised)
  if (phys > strtabIndex) {
    const sb = shoff + strtabIndex * shentsz;
    buf.writeUInt32LE(7, sb); // sh_name → ".shstrtab"
    buf.writeUInt32LE(SHT_STRTAB, sb + 4);
    buf.writeBigUInt64LE(BigInt(strtabOff), sb + 24);
    buf.writeBigUInt64LE(BigInt(strtab.length), sb + 32);
  }

  // ---- the high-index allocated section carrying the ID (only when the
  // entry physically exists; truncated fixtures shrink `phys`)
  if (phys > highIndex) {
    const hb = shoff + highIndex * shentsz;
    buf.writeUInt32LE(17, hb); // sh_name → ".rodata"
    buf.writeUInt32LE(SHT_PROGBITS, hb + 4);
    buf.writeBigUInt64LE(BigInt(SHF_ALLOC), hb + 8);
    buf.writeBigUInt64LE(BigInt(rodataOff), hb + 24);
    buf.writeBigUInt64LE(BigInt(rodataData.length), hb + 32);
  }
  // All other entries stay zeroed: type 0 (NULL), offset 0, size 0 — the
  // same shape linkers emit for reserved-but-empty section slots.

  return buf;
}

/**
 * Build a minimal ELF64 carrying a DIRECT (non-escaped) e_shnum value —
 * the reserved-count boundary fixture family (ELF gABI: [1, 0xfeff] are
 * direct counts; [0xff00, 0xffff] are reserved and must fail closed).
 *
 * The physical section-header table ALWAYS holds exactly `eShnum`
 * complete, in-range entries (the declared table is never truncated), so
 * a rejection of the reserved values can never be blamed on a truncated
 * table — the fixture is rejected because the value is reserved, and
 * nothing else. Layout (payload-relative, exact fit — the section header
 * table is the last structure, so the structure-implied extent equals the
 * file size):
 *   ELF header | .text (SHF_ALLOC|EXECINSTR, no ID) |
 *   .rodata (SHF_ALLOC, the 32-byte program ID INSIDE it) | .shstrtab |
 *   section header table (eShnum × 64 B; entries ≥ 4 zeroed NULL)
 * Entries: 0 = NULL, 1 = .text, 2 = .shstrtab, 3 = .rodata (with the ID).
 * e_shstrndx is the direct .shstrtab index (2) — this family isolates the
 * e_shnum field; the escape forms are buildExtendedCountElf's territory.
 *
 * opts:
 *   eShnum   — the raw direct 16-bit e_shnum value written to the header
 *              (boundary values: 0xfeff valid; 0xff00 / 0xff01 / 0xffff
 *              reserved)
 *   idBase58 — program ID embedded in the allocated .rodata (optional:
 *              omit for a fixture that is structurally valid but carries
 *              no identity — reserved-value rejection must not depend on
 *              identity anyway, since it fires before any scan)
 */
export function buildDirectShnumElf({ eShnum, idBase58 = null }) {
  if (!Number.isInteger(eShnum) || eShnum < 1 || eShnum > 0xffff) {
    throw new Error("buildDirectShnumElf: eShnum must be a direct 16-bit count >= 1");
  }
  const idBytes = idBase58 ? Buffer.from(new PublicKey(idBase58).toBytes()) : null;
  const textData = Buffer.alloc(96, 0);
  const rodataData = idBytes ? Buffer.concat([Buffer.alloc(32, 0), idBytes]) : Buffer.alloc(0);
  // name offsets within .shstrtab: .text=1, .shstrtab=7, .rodata=17
  const strtab = Buffer.from("\0.text\0.shstrtab\0.rodata\0", "utf8");

  const ehsz = 64;
  const shentsz = 64;
  const textOff = ehsz;
  const rodataOff = textOff + textData.length;
  const strtabOff = rodataOff + rodataData.length;
  const shoff = strtabOff + strtab.length;
  // The declared table is COMPLETE: exactly eShnum physical entries.
  const total = shoff + eShnum * shentsz;

  const buf = Buffer.alloc(total);
  // ---- ELF header (SBPF v0 — the same acceptance the parsers enforce)
  ELF_MAGIC.copy(buf, 0);
  buf[4] = 2; // EI_CLASS ELFCLASS64
  buf[5] = 1; // EI_DATA LSB
  buf[6] = 1; // EI_VERSION
  buf.writeUInt16LE(2, 16); // e_type EXEC
  buf.writeUInt16LE(263, 18); // e_machine EM_SBF (SBPF v0)
  buf.writeUInt32LE(1, 20); // e_version
  buf.writeBigUInt64LE(0x1000n, 24); // e_entry
  buf.writeBigUInt64LE(0n, 32); // e_phoff
  buf.writeUInt32LE(0, 36); // e_flags (SBPF v0)
  buf.writeBigUInt64LE(BigInt(shoff), 40); // e_shoff
  buf.writeUInt16LE(ehsz, 52); // e_ehsize
  buf.writeUInt16LE(0, 54); // e_phentsize
  buf.writeUInt16LE(0, 56); // e_phnum
  buf.writeUInt16LE(shentsz, 58); // e_shentsize
  buf.writeUInt16LE(eShnum, 60); // DIRECT count — no escape
  buf.writeUInt16LE(2, 62); // direct .shstrtab index

  textData.copy(buf, textOff);
  rodataData.copy(buf, rodataOff);
  strtab.copy(buf, strtabOff);

  // ---- section headers 0..3 (the rest stay zeroed NULL entries)
  const offs = { 1: textOff, 2: strtabOff, 3: rodataOff };
  const sizes = { 1: textData.length, 2: strtab.length, 3: rodataData.length };
  const nameOffs = { 1: 1, 2: 7, 3: 17 }; // .text / .shstrtab / .rodata
  for (let i = 1; i < Math.min(eShnum, 4); i++) {
    const base = shoff + i * shentsz;
    buf.writeUInt32LE(nameOffs[i], base);
    buf.writeUInt32LE(i === 2 ? SHT_STRTAB : SHT_PROGBITS, base + 4);
    buf.writeBigUInt64LE(
      BigInt(i === 1 ? SHF_ALLOC | SHF_EXECINSTR : i === 3 ? SHF_ALLOC : 0),
      base + 8,
    );
    buf.writeBigUInt64LE(BigInt(offs[i]), base + 24);
    buf.writeBigUInt64LE(BigInt(sizes[i]), base + 32);
  }
  return buf;
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
