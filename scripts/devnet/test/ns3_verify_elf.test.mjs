// SPDX-License-Identifier: Apache-2.0
//
// ns3_verify_elf tests (NS-3 review, protocol PR finding B) — positive and
// negative cases for the STRUCTURAL ELF identity verifier, run against
// synthetic ELF64 fixtures built in-memory here (no anchor toolchain, no
// real .so needed).
//
// The fixtures are honest minimal ELF64 binaries: 64-byte header, a
// section-name string table, and three sections:
//   .rodata  — SHF_ALLOC            (where Anchor's id! constant lives)
//   .text    — SHF_ALLOC|EXECINSTR  (code)
//   .debug_x — no SHF_ALLOC         (debug info; present in the file,
//                                   NOT loaded into the program image)
// plus a NULL section 0 per the ELF spec. The verifier under test parses
// this exact fixed layout.
//
// What the suite pins:
//   ✔ positive: ID inside .rodata (allocated) → structural OK
//   ✔ positive: ID inside .text as well → multiple hits reported
//   ✖ negative: ID ONLY in the non-allocated .debug section → REJECTED
//     (the exact byte-presence false-positive the review forbids)
//   ✖ negative: ID absent entirely → REJECTED
//   ✖ negative: legacy NS-1/NS-2 ID bytes anywhere → REJECTED
//   ✖ negative: not an ELF (bad magic / truncated) → REJECTED
//   ✖ negative: stripped section table (e_shoff=0) → FAIL-CLOSED even
//     though raw bytes are present
//   ✖ negative: corrupt section table (out-of-range) → FAIL-CLOSED

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { PublicKey } from "@solana/web3.js";
import { parseElf64Sections, verifyElfIdentity, NS3_LEGACY_IDS } from "../ns3_verify_elf.mjs";
import { NS3 } from "../ns3_identities.mjs";

const NS3_SCANNER = NS3.scannerProgramId;
const NS3_VAULT = NS3.vaultProgramId;
const NS2_SCANNER = "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54";

// ------------------------------------------------------------ fixtures

const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;

function idBytes(base58) {
  return Buffer.from(new PublicKey(base58).toBytes());
}

/**
 * Build a minimal but spec-honest ELF64 LSB file.
 * `idPlacements`: [{ section: "rodata"|"text"|"debug", id: base58 }] —
 * the 32-byte ID is embedded at the END of the named section's payload.
 */
function buildElf64({ idPlacements = [] }) {
  const junk = (n, fill) => Buffer.alloc(n, fill);
  const sections = [
    { name: "", type: SHT_NULL, flags: 0, data: Buffer.alloc(0) }, // NULL section
    { name: ".text", type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, data: junk(96, 0x90) },
    { name: ".rodata", type: SHT_PROGBITS, flags: SHF_ALLOC, data: junk(64, 0x42) },
    { name: ".debug_info", type: SHT_PROGBITS, flags: 0, data: junk(80, 0x77) },
    { name: ".shstrtab", type: SHT_STRTAB, flags: 0, data: null }, // filled below
  ];

  // Embed requested IDs at the tail of their section payloads.
  for (const p of idPlacements) {
    const sec = sections.find((s) => s.name === p.section);
    if (!sec) throw new Error(`fixture section ${p.section} not defined`);
    sec.data = Buffer.concat([sec.data, idBytes(p.id)]);
  }

  // Build the section-name string table.
  const nameOffs = new Map();
  let strtab = Buffer.from([0x00]);
  for (const s of sections) {
    if (s.name === "") {
      nameOffs.set("", 0);
      continue;
    }
    nameOffs.set(s.name, strtab.length);
    strtab = Buffer.concat([strtab, Buffer.from(`${s.name}\0`, "utf8")]);
  }
  sections[sections.length - 1].data = strtab;

  // Lay out the file: ELF header | section payloads (in order) | section headers.
  const ehsize = 64;
  const shentsize = 64;
  let cursor = ehsize;
  for (const s of sections) {
    s.offset = cursor;
    cursor += s.data.length;
  }
  const eShoff = cursor;
  const shnum = sections.length;
  const fileSize = eShoff + shnum * shentsize;
  const buf = Buffer.alloc(fileSize);

  // --- ELF header
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46; // magic
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // LSB
  buf[6] = 1; // EV_CURRENT
  buf.writeUInt16LE(2, 16); // e_type = EXEC
  buf.writeUInt16LE(247, 18); // e_machine = EM_BPF
  buf.writeUInt32LE(1, 20); // e_version
  buf.writeBigUInt64LE(0n, 24); // e_entry
  buf.writeBigUInt64LE(0n, 32); // e_phoff
  buf.writeBigUInt64LE(BigInt(eShoff), 40);
  buf.writeUInt32LE(0, 48); // e_flags
  buf.writeUInt16LE(64, 52); // e_ehsize
  buf.writeUInt16LE(0, 54); // e_phentsize
  buf.writeUInt16LE(0, 56); // e_phnum
  buf.writeUInt16LE(64, 58); // e_shentsize
  buf.writeUInt16LE(shnum, 60);
  buf.writeUInt16LE(sections.length - 1, 62); // e_shstrndx

  // --- section payloads
  for (const s of sections) s.data.copy(buf, s.offset);

  // --- section headers
  const shBase = eShoff;
  sections.forEach((s, i) => {
    const b = shBase + i * shentsize;
    buf.writeUInt32LE(nameOffs.get(s.name), b);
    buf.writeUInt32LE(s.type, b + 4);
    buf.writeBigUInt64LE(BigInt(s.flags), b + 8);
    buf.writeBigUInt64LE(BigInt(s.offset), b + 16);
    buf.writeBigUInt64LE(BigInt(s.offset), b + 24); // sh_offset
    buf.writeBigUInt64LE(BigInt(s.data.length), b + 32); // sh_size
    buf.writeUInt32LE(0, b + 40);
    buf.writeUInt32LE(0, b + 44);
    buf.writeBigUInt64LE(1n, b + 48);
    buf.writeBigUInt64LE(0n, b + 56);
  });
  return buf;
}

// -------------------------------------------------------------- tests

describe("ELF structural identity verifier", () => {
  test("positive: ID inside an allocated section (.rodata) → structural OK with named hit", () => {
    const elf = buildElf64({ idPlacements: [{ section: ".rodata", id: NS3_SCANNER }] });
    const r = verifyElfIdentity(elf, NS3_SCANNER, NS3_LEGACY_IDS);
    assert.equal(r.verdict, "structural");
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].section, ".rodata");
    assert.equal(r.legacyHits.length, 0);
    // The hit offset must actually point at the ID bytes.
    assert.deepEqual(
      Buffer.from(elf.subarray(r.hits[0].offset, r.hits[0].offset + 32)),
      idBytes(NS3_SCANNER),
    );
  });

  test("positive: ID in .text too → multiple allocated hits reported", () => {
    const elf = buildElf64({
      idPlacements: [
        { section: ".rodata", id: NS3_VAULT },
        { section: ".text", id: NS3_VAULT },
      ],
    });
    const r = verifyElfIdentity(elf, NS3_VAULT, NS3_LEGACY_IDS);
    assert.equal(r.verdict, "structural");
    assert.equal(r.hits.length, 2);
    assert.deepEqual(r.hits.map((h) => h.section).sort(), [".rodata", ".text"]);
  });

  test("negative: ID only in a NON-allocated section (.debug_info) → REJECTED", () => {
    // The exact false-positive the review forbids: byte presence in the
    // raw file, but the bytes are NOT part of the loaded program image.
    const elf = buildElf64({ idPlacements: [{ section: ".debug_info", id: NS3_SCANNER }] });
    const r = verifyElfIdentity(elf, NS3_SCANNER, NS3_LEGACY_IDS);
    assert.equal(r.verdict, "non-alloc-only");
    assert.match(r.detail, /OUTSIDE allocated sections/);
  });

  test("negative: ID absent entirely → REJECTED", () => {
    const elf = buildElf64({});
    const r = verifyElfIdentity(elf, NS3_SCANNER, NS3_LEGACY_IDS);
    assert.equal(r.verdict, "absent");
  });

  test("negative: legacy NS-2 ID bytes anywhere in the file → REJECTED", () => {
    const elf = buildElf64({ idPlacements: [{ section: ".debug_info", id: NS2_SCANNER }] });
    const r = verifyElfIdentity(elf, NS3_SCANNER, NS3_LEGACY_IDS);
    assert.equal(r.verdict, "legacy-present");
    assert.ok(r.legacyHits.includes("NS-2 scanner"));
  });

  test("negative: not an ELF (bad magic) → REJECTED", () => {
    const junk = Buffer.alloc(200, 0x41);
    const r = verifyElfIdentity(junk, NS3_SCANNER, NS3_LEGACY_IDS);
    assert.equal(r.verdict, "not-elf");
    assert.match(r.detail, /magic/);
  });

  test("fail-closed: stripped section table (e_shoff=0) with raw ID present → REJECTED", () => {
    const elf = buildElf64({ idPlacements: [{ section: ".rodata", id: NS3_SCANNER }] });
    elf.writeBigUInt64LE(0n, 40); // e_shoff = 0 (stripped)
    const r = verifyElfIdentity(elf, NS3_SCANNER, NS3_LEGACY_IDS);
    assert.equal(r.verdict, "unparseable");
    assert.match(r.detail, /stripped/);
  });

  test("fail-closed: truncated section table → REJECTED", () => {
    const elf = buildElf64({ idPlacements: [{ section: ".rodata", id: NS3_SCANNER }] });
    // Lie about the file being shorter than the section table needs.
    const cut = elf.subarray(0, elf.length - 40);
    const r = verifyElfIdentity(cut, NS3_SCANNER, NS3_LEGACY_IDS);
    assert.equal(r.verdict, "unparseable");
  });

  test("section parser: names, flags, and offsets round-trip on a valid fixture", () => {
    const elf = buildElf64({ idPlacements: [{ section: ".rodata", id: NS3_SCANNER }] });
    const sections = parseElf64Sections(elf);
    const names = sections.map((s) => s.name);
    assert.deepEqual(names, ["", ".text", ".rodata", ".debug_info", ".shstrtab"]);
    const rodata = sections.find((s) => s.name === ".rodata");
    assert.equal(rodata.flags & SHF_ALLOC, SHF_ALLOC);
    const debug = sections.find((s) => s.name === ".debug_info");
    assert.equal(debug.flags & SHF_ALLOC, 0, "debug section is not allocated");
  });
});
