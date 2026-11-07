// SPDX-License-Identifier: Apache-2.0
//
// ns3_verify_elf.mjs — ELF embedded-identity verification (risk R-1).
//
// WHY: deploy_devnet.sh runs this after the keypair gate to close the
// partial-sync window where the deploy keypair matches the constant but
// the ELF was compiled from a stale tree (the program would deploy at the
// right address while every Anchor owner check fails at runtime).
//
// VERIFICATION SEMANTICS — read this before trusting the output:
//
//   * This script performs a STRUCTURAL pre-deployment check, in two
//     tiers, on a valid 64-bit LSB SBF ELF (magic + class + e_machine
//     247/263, same acceptance the agave loader itself enforces):
//
//       Tier 1 (structural): the 32-byte big-endian expected program ID
//       must occur INSIDE at least one SHF_ALLOC (allocated, i.e. loaded
//     into the program image) section of the parsed ELF64 section table.
//       Occurrences in non-allocated regions (e.g. .debug_*) do NOT
//       count — raw whole-file byte presence is exactly what this check
//     refuses to accept as sufficient.
//
//       Tier 2 (canary): NONE of the legacy NS-1/NS-2 ID byte sequences
//       may appear ANYWHERE in the file.
//
//   * WHAT THIS IS NOT — do not over-claim, here or downstream:
//       - The structural hit proves the bytes live in a loaded section;
//         it does NOT prove those bytes are THE Anchor `declare_id!`
//         constant that the loader sees at runtime (a compiled binary
//         could theoretically embed the same 32 bytes elsewhere in an
//         allocated section).
//       - It is NOT a substitute for on-chain verification: the
//         DEFINITIVE program-ID proof is post-deployment — the program
//         account exists, is owned by the BPF upgradeable loader, is
//         executable, and its ProgramData upgrade authority readback
//         matches (docs/DEVNET.md steps 5 and 9).
//       - This is deliberately NOT a full ELF "parser" of program
//         semantics: only the fixed-layout ELF64 file/section headers
//         (IEEE Std 1003.1) are read — no symbol tables, no relocations,
//         no Anchor runtime structures. Anything less reliable than a
//         header walk is not claimed.
//
//   * Failure policy: fail-closed. A missing or truncated section table
//     CANNOT be structurally verified and FAILS even if the raw bytes
//     are present (an honest "cannot verify" beats a false pass).
//
// Zero npm dependencies (node:crypto / node:fs / @solana/web3.js for
// base58 decoding only). CLI (unchanged, consumed by deploy_devnet.sh +
// local_rehearsal_ns3.sh):
//   node ns3_verify_elf.mjs --scanner-so <path.so> --vault-so <path.so> \
//        --scanner-id <PK> --vault-id <PK>
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------- core

/** e_machine values the agave bpf_loader accepts for Solana programs. */
export const SBF_E_MACHINES = [247, 263];
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

// ----------------------------------------------------- reserved index values

/** SHN_LORESERVE (ELF gABI): lower bound of the reserved index range. */
export const SHN_LORESERVE = 0xff00;

/** SHN_XINDEX (ELF gABI): e_shstrndx escape — real index in SH0.sh_link. */
export const SHN_XINDEX = 0xffff;

/**
 * Reserved e_shnum values — strict fail-closed gate (ELF gABI).
 *
 * The 16-bit e_shnum header field has exactly two legal shapes:
 *   - 0 (with a nonzero e_shoff): the EXTENDED-NUMBERING ESCAPE — the real
 *     section count lives in the u64 sh_size field of section header 0
 *     (resolved by the parser that owns that resolution); and
 *   - a DIRECT count in [1, SHN_LORESERVE): subject to the ordinary
 *     structural validation (safe-integer table arithmetic, payload fit).
 * Every value in [SHN_LORESERVE, 0xffff] is RESERVED by the specification
 * and is NOT a valid direct section count — a real count >= SHN_LORESERVE
 * MUST be expressed through the escape instead. Accepting a reserved value
 * as a "direct count" would silently reinterpret a malformed header, so
 * this gate throws BEFORE any escape handling, table arithmetic, or
 * iteration; reserved values are never normalized into escapes.
 *
 * Passes 0 (the caller resolves the escape) and direct counts below
 * SHN_LORESERVE; throws for [0xff00, 0xffff] with the offending field
 * name, its value (decimal + hex), and the reason.
 */
export function assertShnumNotReserved(eShnum) {
  if (eShnum >= SHN_LORESERVE) {
    throw new Error(
      `reserved e_shnum value ${eShnum} (0x${eShnum.toString(16)}) — values in ` +
        `[0x${SHN_LORESERVE.toString(16)}, 0xffff] are reserved by the ELF specification and are not ` +
        "valid direct section counts; a real count >= 0xff00 must use extended numbering " +
        "(e_shnum = 0 with the real count in the sh_size field of section header 0)",
    );
  }
}

/**
 * Reserved e_shstrndx values — strict fail-closed gate (ELF gABI).
 *
 * The 16-bit e_shstrndx header field has exactly two legal shapes:
 *   - a DIRECT string-table index in [0, SHN_LORESERVE): subject to the
 *     ordinary bounds validation against the resolved section count; and
 *   - SHN_XINDEX (0xffff): the EXTENDED-INDEX ESCAPE — the real index
 *     lives in the u32 sh_link field of section header 0 (resolved by the
 *     parser that owns that resolution).
 * Every value in [SHN_LORESERVE, SHN_XINDEX) — [0xff00, 0xfffe] — is
 * RESERVED by the specification and is NOT a valid direct index. Note the
 * asymmetry with e_shnum: the e_shstrndx escape is 0xffff, NOT 0, so the
 * two fields need separate gates — conflating them would either reject the
 * valid SHN_XINDEX escape or accept the reserved [0xff00, 0xfffe] range.
 * This gate throws BEFORE any escape handling or bounds arithmetic;
 * reserved values are never normalized into escapes.
 *
 * Passes [0, 0xfeff] and 0xffff (the caller resolves the escape); throws
 * for [0xff00, 0xfffe] with the offending field name, its value
 * (decimal + hex), and the reason.
 */
export function assertShstrndxNotReserved(eShstrndx) {
  if (eShstrndx >= SHN_LORESERVE && eShstrndx !== SHN_XINDEX) {
    throw new Error(
      `reserved e_shstrndx value ${eShstrndx} (0x${eShstrndx.toString(16)}) — values in ` +
        `[0x${SHN_LORESERVE.toString(16)}, 0xfffe] are reserved by the ELF specification and are not ` +
        "valid direct string-table indices; only SHN_XINDEX (0xffff) invokes extended " +
        "resolution (the real index in the sh_link field of section header 0)",
    );
  }
}

/** Validate the fixed ELF header as a 64-bit LSB SBF ELF. Throws with a
 *  precise message on any mismatch (mirrors elf_dump.mjs acceptance). */
export function validateSbfElfHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) {
    throw new Error(`too small to be an ELF64 (${buf ? buf.length : 0} B; header alone is 64 B)`);
  }
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error("missing ELF magic (0x7f 'E' 'L' 'F')");
  }
  if (buf[4] !== 2 || buf[5] !== 1) {
    throw new Error(`not a 64-bit little-endian ELF (EI_CLASS=${buf[4]} EI_DATA=${buf[5]})`);
  }
  const eMachine = buf.readUInt16LE(18);
  if (!SBF_E_MACHINES.includes(eMachine)) {
    throw new Error(`e_machine ${eMachine} not in {${SBF_E_MACHINES.join(", ")}} (EM_BPF/EM_SBF)`);
  }
  return true;
}

/**
 * Parse the ELF64 section header table (fixed-layout header walk per the
 * ELF spec). Returns [{ name, type, flags, offset, size }] and THROWS on
 * any structural problem (no section table, bad entry size, out-of-range
 * offsets/indices) — the caller fails closed on parse errors.
 *
 * RESERVED SECTION-NUMBERING VALUES (ELF gABI): only two shapes of the
 * 16-bit header fields are legal. e_shnum is either a direct count in
 * [1, 0xfeff] or the escape 0 (real count in SH0.sh_size); every value in
 * [SHN_LORESERVE, 0xffff] is RESERVED and fails closed — a reserved value
 * is never normalized into an escape and never accepted as a direct
 * count. e_shstrndx is either a direct index in [0, 0xfeff] or the escape
 * SHN_XINDEX (0xffff) (real index in SH0.sh_link); every value in
 * [0xff00, 0xfffe] is RESERVED and fails closed. The gates (shared with
 * elfDeclaredSpan via the exported assertShnumNotReserved /
 * assertShstrndxNotReserved validators, so the two parsing paths cannot
 * drift) run BEFORE escape resolution, table arithmetic, and iteration.
 *
 * EXTENDED SECTION NUMBERING (ELF spec §1.7 / System V ABI): when the
 * file declares e_shnum = 0 (with e_shoff != 0), the real section count
 * lives in sh_size of section header 0; when e_shstrndx = SHN_XINDEX
 * (0xffff), the real string-table index lives in sh_link of section
 * header 0. Both are resolved here — the SAME rule every other reader in
 * this repository applies — so a section table is either fully supported
 * across the full verification path (span derivation, structural
 * identity, provenance) or explicitly refused; there is no partial
 * support. The RESERVED values above are the exact boundary of these
 * escapes: the escapes are 0 (e_shnum) and 0xffff (e_shstrndx), nothing
 * else in the reserved range.
 *
 * FULL VALID RANGE: the extended-numbering escape exists precisely so the
 * count can exceed the 16-bit e_shnum field (counts >= SHN_LORESERVE
 * REQUIRE it), and SH0.sh_size is a u64 — so there is NO 65,535 ceiling
 * here. The enforced bounds are the real ones:
 *   - the resolved count must be nonzero (zero = malformed table);
 *   - the count must be a JavaScript safe integer (a u64 count beyond
 *     Number.MAX_SAFE_INTEGER is refused before any arithmetic);
 *   - e_shoff + count*64 (the complete section-header table) must be an
 *     exact safe integer AND fit inside the buffer — so no declared table
 *     can exceed the actual bytes, and nothing is allocated or iterated
 *     before those checks pass (a hostile count fails closed in O(1));
 *   - the string-table index (direct or SHN_XINDEX-resolved) must be
 *     inside the resolved count.
 * A spec-valid ELF with more than 65,535 sections parses; a malformed or
 * impossible count fails closed.
 */
export function parseElf64Sections(buf) {
  validateSbfElfHeader(buf);
  const eShoff = Number(buf.readBigUInt64LE(40));
  const eShentsize = buf.readUInt16LE(58);
  const eShnumRaw = buf.readUInt16LE(60);
  const eShstrndxRaw = buf.readUInt16LE(62);
  if (eShoff === 0) {
    throw new Error("no section header table (stripped) — structural identity check impossible");
  }
  if (eShentsize !== 64) {
    throw new Error(
      `unexpected section header entry size ${eShentsize} (ELF64 fixed layout is 64)`,
    );
  }
  // Reserved section-numbering values (ELF gABI) fail closed BEFORE the
  // escapes are considered and before any arithmetic or iteration — a
  // reserved value is never treated as a direct count/index and never
  // normalized into an extended-numbering escape (see the validators
  // above for the exact spec rules and the error contract).
  assertShnumNotReserved(eShnumRaw);
  assertShstrndxNotReserved(eShstrndxRaw);
  // Extended numbering: e_shnum = 0 ⇒ real count in sh_size of SH0;
  // e_shstrndx = SHN_XINDEX ⇒ real index in sh_link of SH0. Both reads
  // require section header 0 itself to be in range.
  const readSh0Field = (byteOffset, reader, what) => {
    if (buf.length < eShoff + 64) {
      throw new Error(
        `section header table out of range (e_shoff=${eShoff}, extended ${what} unreadable, file=${buf.length} B)`,
      );
    }
    return reader.call(buf, eShoff + byteOffset);
  };
  let shnum = eShnumRaw;
  let shstrndx = eShstrndxRaw;
  if (shnum === 0) {
    const shnumBig = readSh0Field(32, buf.readBigUInt64LE, "section count");
    if (shnumBig === 0n) {
      throw new Error("e_shnum = 0 with a zero extended section count — malformed section table");
    }
    // Extended numbering exists precisely so the count can exceed the
    // 16-bit e_shnum field — SH0.sh_size is u64 and there is NO 65,535
    // ceiling. The real bounds: the count must be a JS safe integer (a
    // hostile u64 is refused BEFORE any arithmetic), and the complete
    // 64-byte-per-entry table must fit inside the buffer (checked below
    // with exact-integer arithmetic) — so no count can trigger an
    // unreasonable allocation or iteration.
    if (shnumBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `extended section count ${shnumBig} exceeds the JavaScript safe-integer bound — malformed section table`,
      );
    }
    shnum = Number(shnumBig);
  }
  if (shstrndx === 0xffff) {
    // SH0.sh_link is a u32 field — read it with readUInt32LE (a Number).
    // (readBigUInt32LE does not exist: the Big* Buffer readers are 64-bit
    // only. The previous reader reference here was undefined, so a
    // spec-valid SHN_XINDEX escape crashed with a TypeError instead of
    // resolving — exposed by the >65,535-section fixtures and fixed.)
    shstrndx = readSh0Field(40, buf.readUInt32LE, "string table index");
  }
  const need = eShoff + shnum * eShentsize;
  if (!Number.isSafeInteger(need)) {
    throw new Error(
      `section header table end ${need} (e_shoff=${eShoff}, e_shnum=${shnum}) exceeds the safe-integer bound — impossible section table`,
    );
  }
  if (buf.length < need) {
    throw new Error(
      `section header table out of range (e_shoff=${eShoff}, e_shnum=${shnum}, file=${buf.length} B)`,
    );
  }
  if (shstrndx >= shnum) {
    throw new Error(`section name string table index ${shstrndx} out of range (e_shnum=${shnum})`);
  }
  const readSh = (i) => {
    const base = eShoff + i * eShentsize;
    return {
      nameOff: buf.readUInt32LE(base),
      type: buf.readUInt32LE(base + 4),
      flags: Number(buf.readBigUInt64LE(base + 8)),
      offset: Number(buf.readBigUInt64LE(base + 24)),
      size: Number(buf.readBigUInt64LE(base + 32)),
    };
  };
  const raw = [];
  for (let i = 0; i < shnum; i++) raw.push(readSh(i));
  // Names come from the linked string table.
  const strtab = raw[shstrndx];
  if (strtab.offset + strtab.size > buf.length) {
    throw new Error("section name string table out of range");
  }
  const cstr = (off) => {
    if (off >= strtab.size) return "";
    const end = buf.indexOf(0x00, strtab.offset + off);
    return buf
      .subarray(strtab.offset + off, end === -1 ? strtab.offset + strtab.size : end)
      .toString("utf8");
  };
  const out = [];
  for (const s of raw) {
    if (s.type !== 8 && s.offset + s.size > buf.length) {
      // NOBITS (8) occupies no file bytes; everything else must fit.
      throw new Error(`section out of range: offset=${s.offset} size=${s.size} file=${buf.length}`);
    }
    out.push({
      name: cstr(s.nameOff),
      type: s.type,
      flags: s.flags,
      offset: s.offset,
      size: s.size,
    });
  }
  return out;
}

function indexOfBytes(haystack, needle, from = 0) {
  return haystack.indexOf(needle, from);
}

/**
 * Verify one ELF buffer against one expected program ID.
 * Returns a structured verdict (never throws):
 *   verdict: "structural" | "absent" | "non-alloc-only" | "legacy-present"
 *          | "not-elf" | "unparseable"
 *   detail:  human-exact explanation for the report lines.
 */
export function verifyElfIdentity(buf, expectedIdBase58, legacyIds = []) {
  const expected = Buffer.from(new PublicKey(expectedIdBase58).toBytes());
  try {
    validateSbfElfHeader(buf);
  } catch (err) {
    return {
      verdict: "not-elf",
      sections: [],
      hits: [],
      legacyHits: [],
      detail: String(err.message ?? err),
    };
  }
  let sections;
  try {
    sections = parseElf64Sections(buf);
  } catch (err) {
    return {
      verdict: "unparseable",
      sections: [],
      hits: [],
      legacyHits: [],
      detail: String(err.message ?? err),
    };
  }
  // Tier 2 canary FIRST: any legacy ID anywhere in the file is a failure
  // regardless of the structural result.
  const legacyHits = [];
  for (const [name, legacyId] of legacyIds) {
    if (indexOfBytes(buf, Buffer.from(new PublicKey(legacyId).toBytes())) !== -1) {
      legacyHits.push(name);
    }
  }
  if (legacyHits.length > 0) {
    return {
      verdict: "legacy-present",
      sections,
      hits: [],
      legacyHits,
      detail: `legacy ID bytes present: ${legacyHits.join(", ")}`,
    };
  }
  // Tier 1: the ID must occur inside at least one SHF_ALLOC section.
  const hits = [];
  for (const s of sections) {
    if ((s.flags & SHF_ALLOC) === 0 || s.type === 8) continue; // not loaded / NOBITS
    const region = buf.subarray(s.offset, s.offset + s.size);
    let at = indexOfBytes(region, expected);
    while (at !== -1) {
      hits.push({
        section: s.name,
        offset: s.offset + at,
        alloc: true,
        exec: (s.flags & SHF_EXECINSTR) !== 0,
      });
      at = indexOfBytes(region, expected, at + 1);
    }
  }
  if (hits.length > 0) {
    return {
      verdict: "structural",
      sections,
      hits,
      legacyHits,
      detail: `${hits.length} occurrence(s) inside allocated sections`,
    };
  }
  // Not in any allocated section — but is it in the file at all? That
  // distinction is the whole point of the structural upgrade.
  const rawAt = indexOfBytes(buf, expected);
  if (rawAt !== -1) {
    return {
      verdict: "non-alloc-only",
      sections,
      hits: [],
      legacyHits,
      detail: `ID bytes present only OUTSIDE allocated sections (first raw occurrence at 0x${rawAt.toString(16)}) — byte presence alone is NOT accepted`,
    };
  }
  return {
    verdict: "absent",
    sections,
    hits: [],
    legacyHits,
    detail: "expected program ID bytes not found anywhere in the file",
  };
}

// ---------------------------------------------------------------- CLI

export const NS3_LEGACY_IDS = [
  ["NS-1 scanner", "5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF"],
  ["NS-1 vault", "HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6"],
  ["NS-2 scanner", "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54"],
  ["NS-2 vault", "Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg"],
];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const targets = [
    { label: "scanner", so: args["scanner-so"], id: args["scanner-id"] },
    { label: "vault", so: args["vault-so"], id: args["vault-id"] },
  ];
  for (const t of targets) {
    if (!t.so || !t.id) {
      console.error("missing --scanner-so/--vault-so/--scanner-id/--vault-id");
      process.exit(2);
    }
  }

  let failed = false;
  for (const t of targets) {
    let buf;
    try {
      buf = readFileSync(t.so);
    } catch (err) {
      console.error(`FAIL ${t.label}: cannot read ${t.so} (${err.code ?? err.message})`);
      failed = true;
      continue;
    }
    const r = verifyElfIdentity(buf, t.id, NS3_LEGACY_IDS);
    switch (r.verdict) {
      case "structural": {
        const where = r.hits.map((h) => `${h.section}@0x${h.offset.toString(16)}`).join(", ");
        console.log(
          `OK ${t.label}: STRUCTURAL — expected ID ${t.id} occurs inside allocated section(s): ${where}. ` +
            `No legacy NS-1/NS-2 ID bytes anywhere. (Pre-deployment safeguard only — definitive identity is the post-deployment on-chain readback, docs/DEVNET.md.)`,
        );
        break;
      }
      case "absent":
        console.error(
          `FAIL ${t.label}: embedded program ID ${t.id} NOT found in ${t.so} — stale ELF (built from a tree with different IDs?) or wrong file. (${r.detail})`,
        );
        failed = true;
        break;
      case "non-alloc-only":
        console.error(
          `FAIL ${t.label}: ID bytes appear in ${t.so} but ONLY outside allocated (loaded) sections — ` +
            `this is exactly the byte-presence false-positive the structural check refuses. (${r.detail})`,
        );
        failed = true;
        break;
      case "legacy-present":
        console.error(
          `FAIL ${t.label}: legacy identity bytes present in ${t.so}: ${r.legacyHits.join(", ")}`,
        );
        failed = true;
        break;
      case "not-elf":
        console.error(`FAIL ${t.label}: ${t.so} is not a valid SBF ELF (${r.detail})`);
        failed = true;
        break;
      case "unparseable":
        console.error(
          `FAIL ${t.label}: ${t.so} cannot be structurally verified (${r.detail}) — refusing to pass on byte presence alone (fail-closed).`,
        );
        failed = true;
        break;
      default:
        console.error(`FAIL ${t.label}: unknown verdict ${r.verdict}`);
        failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

// CLI entry only — the module is also imported by the test suite.
if (process.argv[1] && process.argv[1].endsWith("ns3_verify_elf.mjs")) {
  main();
}
