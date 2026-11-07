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
//   ✔ extended section numbering, FULL VALID RANGE: a spec-valid ELF with
//     MORE than 65,535 sections (e_shnum=0, real count in SH0.sh_size,
//     e_shstrndx=SHN_XINDEX with the real index in SH0.sh_link) parses
//     exactly; the identity gate scans sections beyond the 16-bit index
//     space; truncated tables, zero counts, safe-integer-hostile counts,
//     and arithmetic-overflow counts all FAIL CLOSED before iteration
//   ✔ regression: the SHN_XINDEX escape resolves on ordinary-count tables
//   ✔ RESERVED section-numbering values (ELF gABI): direct e_shnum in
//     [0xff00, 0xffff] and direct e_shstrndx in [0xff00, 0xfffe] FAIL
//     CLOSED even when the declared table is complete and in range (the
//     rejection is the reserved value itself, never truncation); the
//     largest legal direct values (0xfeff both fields) still parse; the
//     escapes (e_shnum=0 / e_shstrndx=0xffff) still resolve; reserved
//     rejection is a DISTINCT, field-specific error — never normalized
//     into an escape, never reported as a plain out-of-range

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { PublicKey } from "@solana/web3.js";
import { parseElf64Sections, verifyElfIdentity, NS3_LEGACY_IDS } from "../ns3_verify_elf.mjs";
import { NS3 } from "../ns3_identities.mjs";
import {
  buildDirectShnumElf,
  buildExtendedCountElf,
  buildSbfElf,
} from "./helpers/provenance_fixtures.mjs";

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

describe("extended section numbering — full valid range (> 65,535 sections)", () => {
  // The gABI extended-numbering escape (e_shnum = 0; real count in
  // SH0.sh_size, a u64 field) exists precisely so the count can exceed the
  // 16-bit e_shnum space — a 65,535 ceiling would reject SPEC-VALID
  // binaries. These tests pin: valid large counts parse exactly (and the
  // identity gate scans sections beyond the 16-bit index space), while
  // truncated tables, zero counts, safe-integer-hostile counts, and
  // arithmetic-overflow counts fail closed BEFORE any allocation or
  // iteration.

  test("A: a valid 70,000-section ELF parses exactly — count, SHN_XINDEX-resolved names, and the high-index section all resolve", () => {
    const elf = buildExtendedCountElf({ idBase58: NS3_SCANNER });
    assert.equal(elf.readUInt16LE(60), 0); // e_shnum = 0 (extended numbering)
    assert.equal(elf.readUInt16LE(62), 0xffff); // e_shstrndx = SHN_XINDEX
    const sections = parseElf64Sections(elf);
    assert.equal(sections.length, 70000); // real count from SH0.sh_size — no 65,535 ceiling
    assert.equal(sections[0].name, ""); // NULL carrier
    assert.equal(sections[1].name, ".text");
    assert.equal(sections[2].name, ".shstrtab"); // resolved THROUGH SHN_XINDEX → SH0.sh_link
    const high = sections[66000];
    assert.equal(high.name, ".rodata");
    assert.equal(high.flags & SHF_ALLOC, SHF_ALLOC);
    // The ID bytes really sit in the high-index section's data range:
    assert.ok(elf.subarray(high.offset, high.offset + high.size).includes(idBytes(NS3_SCANNER)));
  });

  test("A(2): identity verification scans the >0xffff-index section — the ID is found there, verdict structural", () => {
    const elf = buildExtendedCountElf({ idBase58: NS3_SCANNER });
    const r = verifyElfIdentity(elf, NS3_SCANNER, NS3_LEGACY_IDS);
    assert.equal(r.verdict, "structural");
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].section, ".rodata");
    // The hit points at the ID inside the high-index section (32 B into it):
    const high = parseElf64Sections(elf)[66000];
    assert.equal(r.hits[0].offset, high.offset + 32);
  });

  test("C: an extended count whose section-header table extends beyond the file FAILS CLOSED — rejected before iteration (no partial parse, no overrun)", () => {
    // Declares 70,000 sections, physically holds only SH0: the declared
    // table end (shoff + 70000·64) lies far beyond the buffer. A parser
    // that iterated anyway would fault on entry 1 — the pinned error is
    // the pre-iteration range check with the exact declared count.
    const elf = buildExtendedCountElf({ idBase58: NS3_SCANNER, physicalShnum: 1 });
    assert.throws(
      () => parseElf64Sections(elf),
      new RegExp(`section header table out of range.*e_shnum=70000.*file=${elf.length} B`, "s"),
    );
  });

  test("D: a zero extended count FAILS CLOSED", () => {
    const elf = buildExtendedCountElf({
      idBase58: NS3_SCANNER,
      physicalShnum: 1,
      countOverride: 0n,
    });
    assert.throws(() => parseElf64Sections(elf), /zero extended section count/);
  });

  test("E: a count beyond the JavaScript safe-integer bound FAILS CLOSED before any arithmetic", () => {
    // SH0.sh_size is u64; a hostile 2^63 must be refused as a Number
    // conversion hazard BEFORE the table-end arithmetic runs.
    const elf = buildExtendedCountElf({
      idBase58: NS3_SCANNER,
      physicalShnum: 1,
      countOverride: 2n ** 63n,
    });
    assert.throws(() => parseElf64Sections(elf), /exceeds the JavaScript safe-integer bound/);
  });

  test("E(2): a count whose table-end arithmetic overflows the safe-integer range FAILS CLOSED", () => {
    // 2^52 is itself safe, but 2^52 · 64 = 2^58 is not: the exact-integer
    // table-end check must reject it (never round, never iterate).
    const elf = buildExtendedCountElf({
      idBase58: NS3_SCANNER,
      physicalShnum: 1,
      countOverride: 2n ** 52n,
    });
    assert.throws(() => parseElf64Sections(elf), /exceeds the safe-integer bound/);
  });

  test("regression: the direct (non-escaped) e_shstrndx form still works alongside a >65,535 count", () => {
    const elf = buildExtendedCountElf({ idBase58: NS3_SCANNER, directShstrndx: true });
    const sections = parseElf64Sections(elf);
    assert.equal(sections.length, 70000);
    assert.equal(sections[2].name, ".shstrtab");
    assert.equal(sections[66000].name, ".rodata");
  });

  test("regression: the SHN_XINDEX escape resolves on an ordinary-count table (e_shstrndx=0xffff, real index in SH0.sh_link)", () => {
    const elf = buildElf64({ idPlacements: [{ section: ".rodata", id: NS3_SCANNER }] });
    elf.writeUInt16LE(0xffff, 62); // e_shstrndx = SHN_XINDEX
    const eShoff = Number(elf.readBigUInt64LE(40));
    elf.writeUInt32LE(4, eShoff + 40); // SH0.sh_link → .shstrtab (section 4)
    const sections = parseElf64Sections(elf);
    assert.deepEqual(
      sections.map((s) => s.name),
      ["", ".text", ".rodata", ".debug_info", ".shstrtab"],
    );
    const r = verifyElfIdentity(elf, NS3_SCANNER, NS3_LEGACY_IDS);
    assert.equal(r.verdict, "structural");
  });
});

describe("reserved section-numbering values — strict fail-closed (ELF gABI)", () => {
  // The ELF gABI gives the 16-bit header fields exactly two legal shapes
  // each. e_shnum: a direct count in [1, 0xfeff] or the escape 0 (real
  // count in SH0.sh_size) — every value in [SHN_LORESERVE, 0xffff] is
  // RESERVED and must fail closed. e_shstrndx: a direct index in
  // [0, 0xfeff] or the SHN_XINDEX (0xffff) escape (real index in
  // SH0.sh_link) — every value in [0xff00, 0xfffe] is RESERVED. These
  // tests pin: the largest valid direct values are accepted (their tables
  // are COMPLETE, so no rejection can be blamed on truncation), the
  // reserved ranges are rejected on the field itself, the escapes still
  // resolve, and a reserved-value rejection is a DISTINCT failure from an
  // ordinary out-of-range index.

  // ---------------------------------------------------- A: e_shnum
  describe("A — e_shnum", () => {
    test("0xfeff is a VALID direct count — the largest one (complete declared table, full parse, structural identity)", () => {
      const elf = buildDirectShnumElf({ eShnum: 0xfeff, idBase58: NS3_SCANNER });
      // The declared table really is complete and in range — the fixture
      // cannot be rejected for truncation:
      const eShoff = Number(elf.readBigUInt64LE(40));
      assert.ok(eShoff + 0xfeff * 64 <= elf.length);
      const sections = parseElf64Sections(elf);
      assert.equal(sections.length, 0xfeff); // exactly the direct count
      assert.equal(sections[1].name, ".text");
      assert.equal(sections[2].name, ".shstrtab");
      assert.equal(sections[3].name, ".rodata");
      const r = verifyElfIdentity(elf, NS3_SCANNER, NS3_LEGACY_IDS);
      assert.equal(r.verdict, "structural");
    });

    test("0xff00, 0xff01, 0xffff are RESERVED and fail closed even with a COMPLETE, in-range declared table", () => {
      for (const reserved of [0xff00, 0xff01, 0xffff]) {
        const elf = buildDirectShnumElf({ eShnum: reserved, idBase58: NS3_SCANNER });
        // Sanity: the table the header declares is fully present — the
        // only reason to reject is the reserved value itself.
        const eShoff = Number(elf.readBigUInt64LE(40));
        assert.ok(
          eShoff + reserved * 64 <= elf.length,
          `table fits for 0x${reserved.toString(16)}`,
        );
        assert.throws(
          () => parseElf64Sections(elf),
          new RegExp(`reserved e_shnum value ${reserved} \\(0x${reserved.toString(16)}\\)`),
          `0x${reserved.toString(16)} must be rejected as reserved`,
        );
      }
    });

    test("0 remains the valid extended-numbering escape; a zero SH0.sh_size count still fails closed", () => {
      // The escape boundary is untouched by the reserved-value gates:
      const valid = buildExtendedCountElf({ idBase58: NS3_SCANNER });
      assert.equal(valid.readUInt16LE(60), 0); // e_shnum = 0 (escape)
      assert.equal(parseElf64Sections(valid).length, 70000);
      // ... and the malformed zero count still fails closed:
      const zero = buildExtendedCountElf({
        idBase58: NS3_SCANNER,
        physicalShnum: 1,
        countOverride: 0n,
      });
      assert.throws(() => parseElf64Sections(zero), /zero extended section count/);
    });
  });

  // ------------------------------------------------ B: e_shstrndx
  describe("B — e_shstrndx", () => {
    test("0xfeff is a VALID direct index when the RESOLVED count covers it and the section is a real string table", () => {
      // A direct index of 0xfeff can never be valid under a DIRECT count
      // (direct counts stop at 0xfeff, so the max valid index is 0xfefe):
      // it is reachable only over an EXTENDED count — exactly the
      // specification's structure. The fixture resolves the count to
      // 70,000 through the escape and places the REAL .shstrtab at index
      // 0xfeff; names must resolve through it.
      const elf = buildExtendedCountElf({
        idBase58: NS3_SCANNER,
        strtabIndex: 0xfeff,
        directShstrndx: 0xfeff,
      });
      assert.equal(elf.readUInt16LE(60), 0); // count via the escape
      assert.equal(elf.readUInt16LE(62), 0xfeff); // direct index, NOT reserved
      const sections = parseElf64Sections(elf);
      assert.equal(sections.length, 70000);
      assert.equal(sections[0xfeff].name, ".shstrtab"); // the real table
      assert.equal(sections[1].name, ".text");
      assert.equal(sections[66000].name, ".rodata");
      const r = verifyElfIdentity(elf, NS3_SCANNER, NS3_LEGACY_IDS);
      assert.equal(r.verdict, "structural");
    });

    test("0xff00, 0xff01, 0xfffe are RESERVED and fail closed — field-specific error, not an out-of-range report", () => {
      for (const reserved of [0xff00, 0xff01, 0xfffe]) {
        const elf = buildSbfElf({ idBase58: NS3_SCANNER });
        elf.writeUInt16LE(reserved, 62);
        assert.throws(
          () => parseElf64Sections(elf),
          (err) => {
            assert.match(err.message, new RegExp(`reserved e_shstrndx value ${reserved}`));
            // DISTINCT from the ordinary bounds failure:
            assert.doesNotMatch(err.message, /out of range/);
            return true;
          },
          `0x${reserved.toString(16)} must be rejected as reserved`,
        );
      }
    });

    test("0xffff remains the SHN_XINDEX escape; an out-of-range RESOLVED index fails with the bounds error, not the reserved error", () => {
      // Valid escape (resolved index in range):
      const valid = buildExtendedCountElf({ idBase58: NS3_SCANNER });
      assert.equal(valid.readUInt16LE(62), 0xffff); // SHN_XINDEX
      assert.equal(parseElf64Sections(valid)[2].name, ".shstrtab");
      // Escape with an out-of-range resolved index (SH0.sh_link >= count):
      const bad = buildExtendedCountElf({ idBase58: NS3_SCANNER });
      const eShoff = Number(bad.readBigUInt64LE(40));
      bad.writeUInt32LE(70000, eShoff + 40); // sh_link = 70000 >= count
      assert.throws(
        () => parseElf64Sections(bad),
        (err) => {
          assert.match(err.message, /out of range/);
          assert.doesNotMatch(err.message, /reserved/);
          return true;
        },
      );
    });

    test("distinction: a plain out-of-range direct index (5 on a 4-section table) reports the BOUNDS error — reserved rejection is a different failure", () => {
      const elf = buildSbfElf({ idBase58: NS3_SCANNER }); // 4 sections
      elf.writeUInt16LE(5, 62); // direct, in-range of nothing
      assert.throws(
        () => parseElf64Sections(elf),
        (err) => {
          assert.match(err.message, /out of range/);
          assert.doesNotMatch(err.message, /reserved/);
          return true;
        },
      );
    });
  });
});
