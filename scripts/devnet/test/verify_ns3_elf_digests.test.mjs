// SPDX-License-Identifier: Apache-2.0
//
// verify_ns3_elf_digests.test.mjs — offline tests for the read-only
// deployed-ELF digest verifier.
//
// EVERY test runs fully offline: the cluster is a local JSON-RPC mock
// (node:http) serving getAccountInfo / getEpochInfo / getGenesisHash
// responses built from the real byte layouts (provenance_fixtures.mjs),
// and the expected digests come from a temp-file provenance manifest that
// passes the REAL loadProvenanceManifest validation. Nothing contacts a
// public cluster, no keypair material exists anywhere, and no account is
// ever initialized: absence and malformation are exercised as they must
// be judged on-chain — as definitive FAILs.
//
// What the suite pins (mapped to the required coverage list):
//   ✔ correct Scanner / Vault program + ProgramData accounts → overall PASS
//   ✔ metadata parsing, payload extraction, 45/13 B structural boundary
//   ✔ the digest covers the ENTIRE extracted payload — no structure-implied
//     truncation and no tail exclusion: genuine trailing zero AND nonzero
//     artifact bytes are hashed (whole-artifact pins match); undeclared
//     extra account capacity is DISCLOSED (count + all-zero flag) but
//     NEVER excluded — the full-payload digest must equal the approved
//     whole-artifact pin or the verdict FAILS (fail closed; the verifier
//     never guesses which trailing bytes are loader padding)
//   ✔ the structure-implied extent (structural gate + diagnostic) INCLUDES
//     the program-header TABLE's own byte extent — a table beyond the SHT
//     end and beyond all section/segment extents is validated AND counted,
//     never omitted; malformed/out-of-range tables fail closed before
//     anything is hashed
//   ✔ extended section numbering (e_shnum=0 / SHN_XINDEX / PN_XNUM) is
//     supported on the FULL path (structure + identity + digest) — one
//     rule, JSON and human output agree
//   ✔ structure_valid reflects the stages that ACTUALLY ran (no
//     contradictory fields on any evidence path — regression battery)
//   ✔ genesis gate order: failed genesis SHORT-CIRCUITS the run (the RPC
//     call history — not just the classification — pins that not one
//     getAccountInfo is issued); foreign genesis is a deterministic FAIL
//   ✔ successful Scanner and Vault digest matches (observed == pin)
//   ✖ digest mismatch → FAIL with observed vs expected
//   ✖ missing program account / missing ProgramData → FAIL (never a
//     digest match, never a pass)
//   ✖ wrong program owner / wrong ProgramData owner / wrong embedded
//     pointer / malformed accounts → FAIL cascades
//   ✖ missing or malformed upgrade authority → distinct FAIL conditions
//   ✖ invalid / truncated ELF, unsupported SBPF architecture → FAIL
//   ✖ RPC transport failure → UNVERIFIED → overall INCOMPLETE (and FAIL
//     precedence over INCOMPLETE)
//   ✔ JSON and human output shapes are consistent across evidence paths
//   ✔ no false PASS when parsing fails (digest_match stays null)
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PublicKey } from "@solana/web3.js";

const execFileP = promisify(execFile);

import { BPF_LOADER_UPGRADEABLE, DEVNET_GENESIS_HASH } from "../verify_ns3_deployment.mjs";
import {
  PROGRAMDATA_METADATA_LEN,
  TOOL_NAME,
  elfDeclaredSpan,
  extractElfPayload,
  runElfDigestVerification,
} from "../verify_ns3_elf_digests.mjs";
import { parseElf64Sections } from "../ns3_verify_elf.mjs";
import { DEFAULT_MANIFEST_PATH, loadProvenanceManifest } from "../ns3_check_provenance.mjs";
import { NS3, programDataPda } from "../ns3_identities.mjs";
import {
  buildSbfElf,
  encodeProgramAccount,
  encodeProgramDataAccount,
  rpcAccount,
  sha256,
} from "./helpers/provenance_fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "..", "verify_ns3_elf_digests.mjs");

const LOADER = new PublicKey(BPF_LOADER_UPGRADEABLE);
const SLOT = 519_265_000;
// The W2 evidence (docs/w2-ns3-acceptance/elf_digest_check.json) recorded
// these derived ProgramData addresses — pinned here as cross-check vectors
// for the identity module's derivation (Suite B).
const W2_RECORDED_PD = {
  scanner: "FxYDhTruh16EoKBgiJaWZCQ9QojWQZGS8J1dXyfSt9dG",
  vault: "9wyRhAC8Sasb46bhWW4jxsK6rGKpEGXf6Riz2ibKZgC4",
};
// The approved digests (docs/DEVNET.md § provenance; the handoff pins).
const APPROVED_DIGESTS = {
  grave_scanner: "e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98",
  grave_vault: "8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83",
};

// ------------------------------------------------------------ fixtures

const PD_SCANNER = programDataPda(new PublicKey(NS3.scannerProgramId)).toBase58();
const PD_VAULT = programDataPda(new PublicKey(NS3.vaultProgramId)).toBase58();

function pdB58(programIdB58) {
  return programDataPda(new PublicKey(programIdB58)).toBase58();
}

/** A structurally valid SBPF v0 ELF carrying the program's own ID. */
function goodElf(programIdB58) {
  return buildSbfElf({ idBase58: programIdB58 });
}

/** ProgramData bytes as current agave writes them: 45 B metadata + ELF. */
function programDataWithAuthority(authorityB58, elf) {
  return Buffer.concat([
    encodeProgramDataAccount({ slot: BigInt(SLOT), authority: authorityB58 }),
    elf,
  ]);
}

/** Authority-None ProgramData: 13 B metadata (no authority bytes) + ELF. */
function programDataWithoutAuthority(elf) {
  return Buffer.concat([
    encodeProgramDataAccount({ slot: BigInt(SLOT), authority: null }).subarray(0, 13),
    elf,
  ]);
}

// ------------------------------------------------- adversarial ELF builders
//
// These builders exist to prove the hash-span methodology against layouts
// a structure-implied-span (or table-position) assumption gets WRONG:
//   * a section whose CONTENT lives AFTER the section header table (a
//     valid ELF — linkers may append; an "SHT end = ELF end" rule would
//     truncate or refuse it);
//   * a program header whose extent covers bytes beyond the SHT end;
//   * a program-header TABLE placed beyond the SHT end and beyond every
//     section-content and segment file extent (Finding A — the table's
//     own bytes must never be omitted from the artifact digest);
//   * extended section numbering (e_shnum = 0, real count in SH0.sh_size)
//     and the PN_XNUM program-count escape (real count in SH0.sh_info).
// The whole-artifact SHA-256 is pinned in the injected manifest exactly
// the way real build artifacts are pinned — the approved-digest
// comparison is never weakened to let a synthetic layout pass.

const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const PT_LOAD = 1;
const PHENTSIZE = 56;

/**
 * Build an ELF64 with full layout control. opts:
 *   idBase58        — program ID bytes embedded in the allocated .text
 *   eMachine/eFlags — ELF header identity (default SBPF v0: 263 / 0)
 *   tailSection     — { type, flags, data }: a section whose CONTENT is
 *                     written AFTER the section header table
 *   programHeader   — { offset, filesz }: one PT_LOAD program header
 *   extendedShnum   — e_shnum = 0; real count in SH0.sh_size
 *   extendedPhnum   — e_phnum = PN_XNUM; real count in SH0.sh_info
 *   phdrAfterSht    — place the program-header TABLE beyond the SHT end
 *                     AND beyond every section-content and segment file
 *                     extent (Finding A fixture; the default segment then
 *                     covers .text + .shstrtab only, so the table is the
 *                     sole span-setting structure)
 *   extraZeroTail   — zero bytes appended beyond every declared structure
 */
function buildLayoutedElf({
  idBase58,
  eMachine = 263,
  eFlags = 0,
  tailSection = null,
  programHeader = null,
  extendedShnum = false,
  extendedPhnum = false,
  phdrAfterSht = false,
  extraZeroTail = 0,
}) {
  const idBytes = Buffer.from(new PublicKey(idBase58).toBytes());
  const textData = Buffer.concat([Buffer.alloc(64, 0), idBytes, Buffer.alloc(32, 0)]);
  const strtab = Buffer.from("\0.text\0.shstrtab\0.tail\0", "utf8");

  const hasPhdr = programHeader !== null || extendedPhnum || phdrAfterSht;
  const ehsz = 64;
  const shentsz = 64;
  const shnum = 4; // NULL, .text, .shstrtab, .tail
  const textOff = hasPhdr && !phdrAfterSht ? ehsz + PHENTSIZE : ehsz;
  const strtabOff = textOff + textData.length;
  const shoff = strtabOff + strtab.length;
  const tailOff = shoff + shnum * shentsz; // AFTER the section header table
  const tailData = tailSection ? tailSection.data : null;
  const tailEnd = tailOff + (tailData ? tailData.length : 0);
  // phdrAfterSht: the TABLE is the last declared structure — beyond the
  // SHT end, beyond every section-content extent and every segment file
  // extent (the Finding A adversarial layout).
  const phoff = !hasPhdr ? 0 : phdrAfterSht ? tailEnd : ehsz;
  const total =
    hasPhdr && phdrAfterSht ? tailEnd + PHENTSIZE + extraZeroTail : tailEnd + extraZeroTail;

  const buf = Buffer.alloc(total);
  // ---- ELF header
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 2; // EI_CLASS ELFCLASS64
  buf[5] = 1; // EI_DATA LSB
  buf[6] = 1; // EI_VERSION
  buf.writeUInt16LE(2, 16); // e_type EXEC
  buf.writeUInt16LE(eMachine, 18);
  buf.writeUInt32LE(1, 20); // e_version
  buf.writeBigUInt64LE(0x1000n, 24); // e_entry
  buf.writeBigUInt64LE(BigInt(phoff), 32); // e_phoff
  buf.writeUInt32LE(eFlags, 36);
  buf.writeBigUInt64LE(BigInt(shoff), 40); // e_shoff
  buf.writeUInt16LE(ehsz, 52); // e_ehsize
  buf.writeUInt16LE(hasPhdr ? PHENTSIZE : 0, 54); // e_phentsize
  buf.writeUInt16LE(extendedPhnum ? 0xffff : hasPhdr ? 1 : 0, 56); // e_phnum
  buf.writeUInt16LE(shentsz, 58);
  buf.writeUInt16LE(extendedShnum ? 0 : shnum, 60); // e_shnum
  buf.writeUInt16LE(2, 62); // e_shstrndx → .shstrtab

  if (tailData) tailData.copy(buf, tailOff);
  textData.copy(buf, textOff);
  strtab.copy(buf, strtabOff);
  if (hasPhdr) {
    buf.writeUInt32LE(PT_LOAD, phoff); // p_type
    buf.writeUInt32LE(5, phoff + 4); // p_flags R+X
    buf.writeBigUInt64LE(BigInt(programHeader?.offset ?? textOff), phoff + 8); // p_offset
    // Default extent: to EOF — EXCEPT phdrAfterSht, where the segment must
    // end BEFORE the SHT so the TABLE itself is the only structure beyond
    // every other extent (Finding A).
    const defaultFilesz = phdrAfterSht ? shoff - textOff : total - textOff;
    buf.writeBigUInt64LE(BigInt(programHeader?.filesz ?? defaultFilesz), phoff + 32); // p_filesz
  }

  // ---- section headers (SH0 doubles as the extended-numbering carrier)
  const offs = { 1: textOff, 2: strtabOff, 3: tailOff };
  const nameOffs = { 1: 1, 2: 7, 3: 17 }; // .text / .shstrtab / .tail
  for (let i = 0; i < shnum; i++) {
    const base = shoff + i * shentsz;
    if (i === 0) {
      if (extendedShnum) buf.writeBigUInt64LE(BigInt(shnum), base + 32); // sh_size
      if (extendedPhnum) buf.writeUInt32LE(1, base + 44); // sh_info
      continue;
    }
    buf.writeUInt32LE(nameOffs[i], base);
    if (i === 1) {
      buf.writeUInt32LE(SHT_PROGBITS, base + 4);
      buf.writeBigUInt64LE(BigInt(SHF_ALLOC | SHF_EXECINSTR), base + 8);
    } else if (i === 2) {
      buf.writeUInt32LE(SHT_STRTAB, base + 4);
    } else if (i === 3 && tailSection) {
      buf.writeUInt32LE(tailSection.type, base + 4);
      buf.writeBigUInt64LE(BigInt(tailSection.flags ?? 0), base + 8);
    }
    buf.writeBigUInt64LE(BigInt(offs[i] ?? 0), base + 24); // sh_offset
    buf.writeBigUInt64LE(
      BigInt(
        i === 1
          ? textData.length
          : i === 2
            ? strtab.length
            : i === 3 && tailSection
              ? tailData.length
              : 0,
      ),
      base + 32,
    ); // sh_size
  }
  return buf;
}

/** The legacy bincode layout (u32 authority tag → 48 B metadata) + ELF. */
function legacyLayoutProgramData(authorityB58, elf) {
  const legacy = Buffer.alloc(48);
  legacy.writeUInt32LE(3, 0);
  legacy.writeBigUInt64LE(BigInt(SLOT), 4);
  legacy.writeUInt32LE(1, 12); // legacy u32 Option tag
  Buffer.from(new PublicKey(authorityB58).toBytes()).copy(legacy, 16);
  return Buffer.concat([legacy, elf]);
}

/** A full temp-file manifest that passes the REAL manifest validation. */
function writeTempManifest({ scannerSha, vaultSha }) {
  const dir = mkdtempSync(path.join(tmpdir(), "gy-elf-digest-test-"));
  const manifestPath = path.join(dir, "provenance.manifest.json");
  const manifest = {
    schema: "graveyield.provenance/1",
    note: ["test-injected provenance manifest (temp file); digests = fixture digests"],
    programs: {
      grave_scanner: { artifact: "target/deploy/grave_scanner.so", sha256: scannerSha },
      grave_vault: { artifact: "target/deploy/grave_vault.so", sha256: vaultSha },
    },
    toolchain: {
      sbpf_arch: "v0",
      elf: { e_machine: 263, e_flags: 0 },
      solana_cli: "3.0.10",
      platform_tools: {
        version: "1.54",
        sha256: "f".repeat(64),
        url: "https://example.invalid/platform-tools-linux-x86_64.tar.bz2",
      },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build the mock-cluster state for a scenario. Default: both programs
 * deployed exactly as approved (45 B metadata, deployer authority, SBPF v0
 * ELFs carrying their own IDs).
 */
function fullState(overrides = {}) {
  const scannerElf = overrides.scannerElf ?? goodElf(NS3.scannerProgramId);
  const vaultElf = overrides.vaultElf ?? goodElf(NS3.vaultProgramId);
  const accounts = {
    [NS3.scannerProgramId]: rpcAccount(encodeProgramAccount(PD_SCANNER), {
      owner: LOADER,
      executable: true,
      lamports: 833_120,
    }),
    [PD_SCANNER]: rpcAccount(
      overrides.scannerProgramData ?? programDataWithAuthority(NS3.deployer, scannerElf),
      { owner: LOADER, lamports: 1_869_627_960 },
    ),
    [NS3.vaultProgramId]: rpcAccount(encodeProgramAccount(PD_VAULT), {
      owner: LOADER,
      executable: true,
      lamports: 833_120,
    }),
    [PD_VAULT]: rpcAccount(
      overrides.vaultProgramData ?? programDataWithAuthority(NS3.deployer, vaultElf),
      { owner: LOADER, lamports: 2_069_373_560 },
    ),
  };
  return {
    accounts: overrides.delete ? omitKeys(accounts, overrides.delete) : accounts,
    genesisHash: overrides.genesisHash ?? DEVNET_GENESIS_HASH,
    failWhere: overrides.failWhere ?? null, // (method, params) => true destroys the connection
    fixtureDigests: { scanner: sha256(scannerElf), vault: sha256(vaultElf) },
  };
}

function omitKeys(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

// --------------------------------------------------- mock RPC harness

function handleRpc(req, state) {
  const value = state.accounts[req.params?.[0]] ?? null;
  switch (req.method) {
    case "getAccountInfo":
      return { jsonrpc: "2.0", id: req.id, result: { context: { slot: SLOT }, value } };
    case "getEpochInfo":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: { absoluteSlot: SLOT, blockHeight: SLOT - 200, epoch: 1202, slotIndex: 345 },
      };
    case "getGenesisHash":
      return { jsonrpc: "2.0", id: req.id, result: state.genesisHash };
    case "getVersion":
      return { jsonrpc: "2.0", id: req.id, result: { "solana-core": "3.0.10" } };
    default:
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `method not found: ${req.method}` },
      };
  }
}

/** Start the mock RPC, run fn(url), then clean up server + temp manifest. */
async function withVerification(state, fn) {
  state.rpcCalls = []; // every request that REACHES the endpoint, in order
  const { manifestPath, cleanup } = writeTempManifest({
    scannerSha: state.fixtureDigests.scanner,
    vaultSha: state.fixtureDigests.vault,
  });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.destroy();
        return;
      }
      const batch = Array.isArray(payload) ? payload : [payload];
      // RPC CALL HISTORY: every arriving request is recorded (method +
      // params) in arrival order — including requests the harness then
      // destroys. The genesis-gate tests assert on this history (the
      // actual call sequence), not just on the final classification.
      for (const r of batch) state.rpcCalls.push({ method: r.method, params: r.params });
      if (state.failWhere && batch.some((r) => state.failWhere(r.method, r.params))) {
        res.destroy(); // transport failure for the matching request ONLY
        return;
      }
      const results = batch.map((r) => handleRpc(r, state));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ url, manifestPath });
  } finally {
    server.close();
    cleanup();
  }
}

function run(state, overrides = {}) {
  return withVerification(state, ({ url, manifestPath }) =>
    runElfDigestVerification({
      url,
      manifestPath,
      manifestLabel: "test-injected provenance manifest",
      ...overrides,
    }),
  );
}

async function runCli(url, args = []) {
  try {
    const { stdout } = await execFileP("node", [TOOL, "--url", url, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.status ?? err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err),
    };
  }
}

const checkOf = (result, idPrefix) => result.checks.filter((c) => c.id.startsWith(idPrefix));

/**
 * Regression invariants (Finding: structure_valid must reflect the stages
 * that ACTUALLY ran — the field may never contradict the evidence).
 * Applied to every program report on every evidence path in test 21z.
 */
function assertNoFieldContradictions(p, scenario) {
  const e = p.elf;
  const ctx = `[${scenario}] ${p.label}`;
  if (e.structure_valid === true) {
    // Every structural stage ran and passed:
    assert.equal(e.extraction, "OK", ctx);
    assert.notEqual(e.declared_elf_size, null, ctx);
    assert.notEqual(e.span_basis, null, ctx);
    assert.equal(e.sbpf_valid, true, ctx);
    assert.notEqual(e.observed_sha256, null, ctx); // digest computed over the established span
    assert.notEqual(e.identity_verdict, null, ctx);
    assert.notEqual(e.identity_verdict, "unparseable", ctx); // section table WAS validated
  }
  if (e.structure_valid === false) {
    // The ELF bytes existed and were assessed; at least one structural
    // stage failed — the architecture stage can not have passed.
    assert.equal(e.extraction, "OK", ctx);
    assert.notEqual(e.sbpf_valid, true, ctx);
  }
  if (e.observed_sha256 !== null) {
    // Hashing implies an established structure (never a guessed boundary)
    // AND the hash span is the ENTIRE extracted payload — no truncation:
    assert.equal(e.extraction, "OK", ctx);
    assert.notEqual(e.declared_elf_size, null, ctx);
    assert.notEqual(e.span_basis, null, ctx);
    assert.notEqual(e.structure_valid, null, ctx); // structure was judged true or false
    assert.equal(e.hash_span_bytes, e.payload_size, ctx); // the FULL payload is hashed
    assert.ok(e.trailing_bytes_beyond_declared_structure >= 0, ctx);
  }
  if (e.digest_match !== null) {
    assert.notEqual(e.observed_sha256, null, ctx);
  }
  if (e.digest_match === true) {
    assert.equal(e.observed_sha256, e.expected_sha256, ctx);
  }
  if (e.extraction !== "OK") {
    // No ELF bytes were ever assessed — structure must never be judged.
    assert.equal(e.structure_valid, null, ctx);
    assert.equal(e.observed_sha256, null, ctx);
  }
}

// -------------------------------------------------------------- suites

describe("ELF payload extraction (structural boundary, never a blind offset)", () => {
  test("authority present → 45 B metadata boundary; metadata never enters the payload", () => {
    const elf = goodElf(NS3.scannerProgramId);
    const data = programDataWithAuthority(NS3.deployer, elf);
    const x = extractElfPayload(data);
    assert.equal(x.authoritySet, true);
    assert.equal(x.authority.toBase58(), NS3.deployer);
    assert.equal(x.metadataLen, PROGRAMDATA_METADATA_LEN.withAuthority);
    assert.equal(x.metadataLen, 45);
    assert.equal(x.payload.length, data.length - 45);
    assert.deepEqual(Buffer.from(x.payload), elf);
    assert.equal(x.payload[0], 0x7f);
  });

  test("authority None → 13 B metadata boundary (payload starts immediately after)", () => {
    const elf = goodElf(NS3.vaultProgramId);
    const data = programDataWithoutAuthority(elf);
    const x = extractElfPayload(data);
    assert.equal(x.authoritySet, false);
    assert.equal(x.metadataLen, PROGRAMDATA_METADATA_LEN.withoutAuthority);
    assert.equal(x.metadataLen, 13);
    assert.deepEqual(Buffer.from(x.payload), elf);
  });

  test("legacy bincode layout (48 B, u32 authority tag) → FAILS CLOSED with a precise report, boundary NOT shifted", () => {
    const elf = goodElf(NS3.scannerProgramId);
    const data = legacyLayoutProgramData(NS3.deployer, elf);
    assert.throws(
      () => extractElfPayload(data),
      (err) => {
        assert.match(err.message, /no ELF magic at the structural payload boundary \(offset 45/);
        assert.match(err.message, /LEGACY bincode ProgramData layout/);
        assert.match(err.message, /NOT shifted/);
        return true;
      },
    );
  });

  test("junk payload (no ELF magic anywhere) → FAILS CLOSED, no legacy hint", () => {
    const junk = Buffer.alloc(64, 0x41);
    const data = programDataWithAuthority(NS3.deployer, junk);
    assert.throws(() => extractElfPayload(data), /no ELF magic at the structural payload boundary/);
    try {
      extractElfPayload(data);
    } catch (err) {
      assert.doesNotMatch(err.message, /LEGACY bincode/);
    }
  });

  test("empty payload after metadata → FAILS CLOSED", () => {
    const bare = encodeProgramDataAccount({ slot: 1n, authority: NS3.deployer });
    assert.throws(() => extractElfPayload(bare), /no ELF payload to hash/);
  });
});

describe("ELF byte span (max structure-implied extent — never a SHT-position assumption)", () => {
  test("exact fit: span == payload length for a well-formed ELF; basis names the SHT end", () => {
    const elf = goodElf(NS3.scannerProgramId);
    const s = elfDeclaredSpan(elf);
    assert.equal(s.span, elf.length);
    assert.equal(s.shtEnd, elf.length);
    assert.equal(s.basis, "section header table end");
    assert.equal(s.extendedSectionNumbering, false);
  });

  test("zero loader padding beyond the span is tolerated (span excludes it)", () => {
    const elf = goodElf(NS3.vaultProgramId);
    const padded = Buffer.concat([elf, Buffer.alloc(512, 0)]);
    const s = elfDeclaredSpan(padded);
    assert.equal(s.span, elf.length); // the padding stays OUTSIDE the span
    assert.ok(s.sectionMax <= s.span);
  });

  test("ADVERSARIAL: section content beyond the SHT end is INSIDE the span — never truncated by a table-position assumption", () => {
    const elf = buildLayoutedElf({
      idBase58: NS3.scannerProgramId,
      tailSection: {
        type: SHT_PROGBITS,
        flags: 0,
        data: Buffer.from("section content placed AFTER the section header table", "utf8"),
      },
    });
    const s = elfDeclaredSpan(elf);
    assert.ok(s.sectionMax > s.shtEnd); // the tail section lives beyond the SHT
    assert.equal(s.span, elf.length); // the span covers the WHOLE file
    assert.match(s.basis, /section extents/);
    // The identity gate parses the SAME layout (same parse, full-path
    // agreement — Option A: no partial extended/odd-layout support).
    assert.equal(parseElf64Sections(elf).length, 4);
  });

  test("ADVERSARIAL: a program header extent beyond the SHT end sets the span", () => {
    const elf = buildLayoutedElf({
      idBase58: NS3.scannerProgramId,
      extraZeroTail: 128,
      programHeader: { offset: 64, filesz: Number.MAX_SAFE_INTEGER }, // fixed below to the full file
    });
    const ePhoff = Number(elf.readBigUInt64LE(32));
    elf.writeBigUInt64LE(BigInt(elf.length - 64), ePhoff + 32); // p_filesz covers to EOF
    const s = elfDeclaredSpan(elf);
    assert.ok(s.segmentMax > s.shtEnd);
    assert.equal(s.span, elf.length);
    assert.match(s.basis, /program header extents/);
  });

  test("extended section numbering (e_shnum=0, real count in SH0.sh_size) — SAME rule as the identity gate", () => {
    const elf = buildLayoutedElf({ idBase58: NS3.scannerProgramId, extendedShnum: true });
    assert.equal(parseElf64Sections(elf).length, 4); // identity path parses it
    const s = elfDeclaredSpan(elf);
    assert.equal(s.extendedSectionNumbering, true);
    assert.equal(s.span, elf.length);
    assert.equal(s.shtEnd, elf.length); // real count resolved → correct table end
    assert.match(s.basis, /extended numbering/);
  });

  test("PN_XNUM (e_phnum=0xffff, real count in SH0.sh_info) — program-header extents resolved", () => {
    const elf = buildLayoutedElf({ idBase58: NS3.scannerProgramId, extendedPhnum: true });
    const s = elfDeclaredSpan(elf);
    assert.equal(s.extendedProgramHeaderCount, true);
    assert.equal(s.span, elf.length);
    assert.match(s.basis, /program header extents/);
  });

  test("truncated payload (span beyond available bytes) → FAILS CLOSED", () => {
    const elf = goodElf(NS3.scannerProgramId);
    const cut = elf.subarray(0, elf.length - 40);
    assert.throws(() => elfDeclaredSpan(cut), /truncated payload/);
  });

  test("stripped section table (e_shoff=0) → span undeterminable → FAILS CLOSED", () => {
    const elf = goodElf(NS3.scannerProgramId);
    elf.writeBigUInt64LE(0n, 40);
    assert.throws(() => elfDeclaredSpan(elf), /section header table/);
  });

  test("header not a valid 64-bit LSB SBF ELF (e_machine 99) → FAILS CLOSED before any extent is read", () => {
    const elf = buildLayoutedElf({ idBase58: NS3.scannerProgramId, eMachine: 99 });
    assert.throws(() => elfDeclaredSpan(elf), /e_machine 99 not in/);
  });

  test("section extent beyond the payload → FAILS CLOSED (truncated account)", () => {
    const elf = buildLayoutedElf({
      idBase58: NS3.scannerProgramId,
      tailSection: { type: SHT_PROGBITS, flags: 0, data: Buffer.alloc(64, 7) },
    });
    const shoff = Number(elf.readBigUInt64LE(40));
    elf.writeBigUInt64LE(BigInt(elf.length + 4096), shoff + 3 * 64 + 32); // .tail size beyond EOF
    assert.throws(() => elfDeclaredSpan(elf), /out of range|beyond the payload/);
  });

  test("ADVERSARIAL (Finding A): a program-header TABLE beyond the SHT end and beyond ALL section/segment extents sets the span", () => {
    const elf = buildLayoutedElf({
      idBase58: NS3.scannerProgramId,
      phdrAfterSht: true,
      tailSection: { type: SHT_PROGBITS, flags: 0, data: Buffer.alloc(32, 0x5a) },
    });
    const s = elfDeclaredSpan(elf);
    // The table is beyond EVERY other declared extent…
    assert.ok(s.shtEnd < s.phEnd, "table must sit beyond the SHT end");
    assert.ok(s.sectionMax < s.phEnd, "table must sit beyond all section extents");
    assert.ok(s.segmentMax < s.phEnd, "table must sit beyond all segment extents");
    assert.equal(s.phEnd, elf.length); // table ends at EOF
    // …and the span MUST include it (the table's own bytes count).
    assert.equal(s.span, elf.length);
    assert.match(s.basis, /program header table/);
    // The table bytes are nontrivial, so the pre-fix calculation (which
    // validated but excluded phEnd) hashed a DIFFERENT byte set:
    const oldBugSpan = Math.max(s.shtEnd, s.sectionMax, s.segmentMax, 64);
    assert.ok(oldBugSpan < s.span);
    assert.notEqual(sha256(elf.subarray(0, oldBugSpan)), sha256(elf));
  });

  test("program-header TABLE beyond the payload (truncated table) → FAILS CLOSED", () => {
    const elf = buildLayoutedElf({ idBase58: NS3.scannerProgramId });
    elf.writeUInt16LE(56, 54); // e_phentsize
    elf.writeBigUInt64LE(BigInt(elf.length - 30), 32); // e_phoff near EOF
    elf.writeUInt16LE(1, 56); // e_phnum=1 → table end beyond EOF
    assert.throws(() => elfDeclaredSpan(elf), /program header table out of range/);
  });

  test("e_phnum > 0 with e_phoff = 0 → inconsistent program header table → FAILS CLOSED", () => {
    const elf = buildLayoutedElf({ idBase58: NS3.scannerProgramId });
    elf.writeUInt16LE(56, 54);
    elf.writeUInt16LE(1, 56);
    assert.throws(() => elfDeclaredSpan(elf), /inconsistent program header table/);
  });

  test("e_phentsize != 56 → FAILS CLOSED", () => {
    const elf = buildLayoutedElf({
      idBase58: NS3.scannerProgramId,
      programHeader: { offset: 64, filesz: 8 },
    });
    elf.writeUInt16LE(40, 54);
    assert.throws(() => elfDeclaredSpan(elf), /unexpected program header entry size 40/);
  });

  test("program header extent beyond the payload → FAILS CLOSED", () => {
    const elf = buildLayoutedElf({
      idBase58: NS3.scannerProgramId,
      programHeader: { offset: 64, filesz: 10_000_000 },
    });
    assert.throws(() => elfDeclaredSpan(elf), /extends beyond the payload/);
  });
});

describe("Suite B — repository-constant cross-checks", () => {
  test("loader-derived ProgramData addresses reproduce the W2-recorded derivations", () => {
    assert.equal(pdB58(NS3.scannerProgramId), W2_RECORDED_PD.scanner);
    assert.equal(pdB58(NS3.vaultProgramId), W2_RECORDED_PD.vault);
  });

  test("the committed provenance manifest loads and pins EXACTLY the approved digests + SBPF v0", () => {
    const m = loadProvenanceManifest(DEFAULT_MANIFEST_PATH);
    assert.equal(m.schema, "graveyield.provenance/1");
    assert.equal(m.programs.grave_scanner.sha256, APPROVED_DIGESTS.grave_scanner);
    assert.equal(m.programs.grave_vault.sha256, APPROVED_DIGESTS.grave_vault);
    assert.equal(m.toolchain.sbpf_arch, "v0");
    assert.deepEqual(m.toolchain.elf, { e_machine: 263, e_flags: 0 });
  });
});

describe("deployed-ELF digest verification — mock RPC battery", () => {
  test("1. all-good chain state → overall PASS; both digests match; boundary + arch + identity all PASS", async () => {
    const state = fullState();
    const r = await run(state);
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    assert.equal(r.counts.fail, 0);
    assert.equal(r.counts.unverified, 0);
    assert.equal(r.context.genesisHash, DEVNET_GENESIS_HASH);
    for (const p of r.programs) {
      assert.equal(p.program_account.exists, true);
      assert.equal(p.program_account.executable, true);
      assert.equal(p.program_account.owner, BPF_LOADER_UPGRADEABLE);
      assert.equal(p.pointer_match, true);
      assert.equal(p.programdata.exists, true);
      assert.equal(p.programdata.state_valid, true);
      assert.equal(p.programdata.upgrade_authority.status, "MATCH");
      assert.equal(p.programdata.upgrade_authority.address, NS3.deployer);
      assert.equal(p.elf.extraction, "OK");
      assert.equal(p.elf.payload_offset, 45);
      assert.equal(p.elf.declared_elf_size, p.elf.payload_size);
      assert.equal(p.elf.structure_valid, true);
      assert.match(p.elf.sbpf_arch, /v0/);
      assert.equal(p.elf.sbpf_valid, true);
      assert.equal(p.elf.identity_verdict, "structural");
      assert.equal(p.elf.digest_match, true);
    }
    const scanner = r.programs[0];
    const vault = r.programs[1];
    assert.equal(scanner.elf.observed_sha256, state.fixtureDigests.scanner);
    assert.equal(vault.elf.observed_sha256, state.fixtureDigests.vault);
    assert.equal(scanner.elf.expected_sha256, state.fixtureDigests.scanner);
    assert.equal(vault.elf.expected_sha256, state.fixtureDigests.vault);
    assert.equal(scanner.elf.span_basis, "section header table end");
    assert.equal(vault.elf.span_basis, "section header table end");
    // Every check ran and passed: 1 genesis + 13 per program.
    assert.equal(r.checks.length, 27);
    assert.equal(r.counts.pass, 27);
    // RPC call history: the genesis gate ran BEFORE any account fetch, and
    // exactly the four distinct accounts were fetched (cache dedupes).
    const genesisIdx = state.rpcCalls.findIndex((c) => c.method === "getGenesisHash");
    assert.ok(genesisIdx !== -1);
    const firstAccount = state.rpcCalls.findIndex((c) => c.method === "getAccountInfo");
    assert.ok(firstAccount === -1 || firstAccount > genesisIdx);
    assert.equal(state.rpcCalls.filter((c) => c.method === "getGenesisHash").length, 1);
    assert.equal(state.rpcCalls.filter((c) => c.method === "getAccountInfo").length, 4);
  });

  test("2. digest mismatch (on-chain bytes differ from the manifest pin) → FAIL with observed vs expected", async () => {
    // fullState() serves the ORIGINAL scanner ELF on chain; the injected
    // manifest pins a DIFFERENT valid ELF's digest → observed != expected.
    const state = fullState();
    const other = goodElf(NS3.scannerProgramId);
    other.writeUInt32LE(0xdeadbeef, 96); // changes bytes AND the digest
    state.fixtureDigests.scanner = sha256(other);
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const digestChecks = checkOf(r, "C3 scanner");
    assert.equal(digestChecks.length, 1);
    assert.equal(digestChecks[0].status, "FAIL");
    assert.match(digestChecks[0].detail, /MISMATCH/);
    assert.match(digestChecks[0].detail, /manifest pins/);
    const scanner = r.programs[0];
    assert.equal(scanner.elf.digest_match, false);
    assert.notEqual(scanner.elf.observed_sha256, scanner.elf.expected_sha256);
    // The mismatch is about scanner only; vault still verifies.
    assert.equal(r.programs[1].elf.digest_match, true);
  });

  test("3. missing program account → FAIL cascade; NO digest match is ever claimed", async () => {
    const state = fullState({ delete: [NS3.scannerProgramId] });
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const exists = checkOf(r, "A1 scanner");
    assert.equal(exists[0].status, "FAIL");
    assert.match(exists[0].detail, /NOT deployed/);
    const scanner = r.programs[0];
    assert.equal(scanner.program_account.exists, false);
    assert.equal(scanner.elf.extraction, "NOT_ATTEMPTED");
    assert.equal(scanner.elf.observed_sha256, null);
    assert.equal(scanner.elf.digest_match, null);
    // All 13 scanner checks ran as FAILs — none skipped, none verified.
    for (const id of [
      "A1",
      "A2",
      "A3",
      "A4",
      "B1",
      "B2",
      "B3",
      "B4",
      "C1",
      "C2",
      "C3",
      "C4",
      "C5",
    ]) {
      const c = checkOf(r, `${id} scanner`);
      assert.equal(c.length, 1, `missing check ${id} scanner`);
      assert.equal(c[0].status, "FAIL", `${id} scanner should FAIL on a missing program account`);
    }
  });

  test("4. missing ProgramData account (derived address, nothing deployed) → FAIL, never a digest match", async () => {
    const state = fullState({ delete: [PD_SCANNER] });
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const b1 = checkOf(r, "B1 scanner");
    assert.equal(b1[0].status, "FAIL");
    assert.match(b1[0].detail, /does NOT exist/);
    const scanner = r.programs[0];
    assert.equal(scanner.programdata.exists, false);
    assert.equal(scanner.pointer_match, true); // pointer math still proven
    assert.equal(scanner.elf.observed_sha256, null);
    assert.equal(scanner.elf.digest_match, null);
    assert.match(checkOf(r, "C3 scanner")[0].detail, /ProgramData account absent/);
  });

  test("5. wrong program-account owner → FAIL cascade", async () => {
    const state = fullState();
    state.accounts[NS3.scannerProgramId].owner = NS3.vaultProgramId;
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "A2 scanner")[0].status, "FAIL");
    assert.equal(checkOf(r, "C3 scanner")[0].status, "FAIL");
  });

  test("6. wrong ProgramData owner → FAIL cascade", async () => {
    const state = fullState();
    state.accounts[PD_SCANNER].owner = NS3.scannerProgramId;
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "B2 scanner")[0].status, "FAIL");
    assert.equal(checkOf(r, "C3 scanner")[0].status, "FAIL");
    assert.equal(r.programs[0].elf.extraction, "NOT_ATTEMPTED");
  });

  test("7. foreign embedded ProgramData pointer → FAIL cascade (derived address is normative)", async () => {
    const state = fullState();
    const foreign = programDataPda(new PublicKey(NS3.vaultProgramId)); // a valid-but-wrong PDA
    state.accounts[NS3.scannerProgramId] = rpcAccount(encodeProgramAccount(foreign.toBase58()), {
      owner: LOADER,
      executable: true,
    });
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const a4 = checkOf(r, "A4 scanner");
    assert.equal(a4[0].status, "FAIL");
    assert.match(a4[0].detail, /is NOT the loader-derived ProgramData address/);
    assert.equal(r.programs[0].pointer_match, false);
  });

  test("8. malformed program account data (truncated, wrong tag) → FAIL, no false PASS", async () => {
    for (const bad of [Buffer.alloc(20, 1), Buffer.alloc(36, 0)]) {
      const state = fullState();
      state.accounts[NS3.scannerProgramId] = rpcAccount(bad, { owner: LOADER, executable: true });
      const r = await run(state);
      assert.equal(r.overall, "FAIL", `data length ${bad.length}`);
      const a4 = checkOf(r, "A4 scanner");
      assert.equal(a4[0].status, "FAIL");
      assert.match(a4[0].detail, /malformed program account data/);
      assert.equal(r.programs[0].elf.digest_match, null);
    }
  });

  test("9. malformed ProgramData metadata (tag 2, bad flag byte) → extraction FAILED, no false PASS", async () => {
    for (const [desc, data] of [
      ["tag=2 (not a ProgramData account)", encodeProgramAccount(PD_VAULT)],
      [
        "tag=3 but authority flag=7",
        (() => {
          const b = encodeProgramDataAccount({ slot: 1n, authority: NS3.deployer });
          b.writeUInt8(7, 12);
          return b;
        })(),
      ],
    ]) {
      const state = fullState();
      state.accounts[PD_SCANNER] = rpcAccount(data, { owner: LOADER });
      const r = await run(state);
      assert.equal(r.overall, "FAIL", desc);
      const b3 = checkOf(r, "B3 scanner");
      assert.equal(b3[0].status, "FAIL", desc);
      assert.equal(r.programs[0].programdata.state_valid, false);
      assert.equal(r.programs[0].programdata.upgrade_authority.status, "MALFORMED");
      assert.equal(r.programs[0].elf.extraction, "FAILED");
      assert.equal(r.programs[0].elf.observed_sha256, null);
      assert.equal(r.programs[0].elf.digest_match, null);
    }
  });

  test("10. absent upgrade authority → distinct FAIL (ABSENT); extraction and digest still reported", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithoutAuthority(elf), { owner: LOADER });
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "FAIL"); // authority absence is a definitive FAIL
    const b4 = checkOf(r, "B4 scanner");
    assert.equal(b4[0].status, "FAIL");
    assert.match(b4[0].detail, /NO upgrade authority/);
    assert.equal(r.programs[0].programdata.upgrade_authority.status, "ABSENT");
    assert.equal(r.programs[0].programdata.upgrade_authority.present, false);
    // The 13 B boundary was still derived structurally and the payload hashed:
    assert.equal(r.programs[0].elf.payload_offset, 13);
    assert.equal(r.programs[0].elf.digest_match, true);
  });

  test("11. unexpected upgrade authority → distinct FAIL (MISMATCH)", async () => {
    const state = fullState();
    const intruder = "11111111111111111111111111111111";
    const elf = goodElf(NS3.scannerProgramId);
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(intruder, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const b4 = checkOf(r, "B4 scanner");
    assert.equal(b4[0].status, "FAIL");
    assert.match(b4[0].detail, /expected/);
    assert.equal(r.programs[0].programdata.upgrade_authority.status, "MISMATCH");
    assert.equal(r.programs[0].programdata.upgrade_authority.address, intruder);
  });

  test("12. invalid ELF payload (magic destroyed) → extraction FAILED, digest never claimed", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    elf[0] = 0x00; // destroy the ELF magic
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const c1 = checkOf(r, "C1 scanner");
    assert.equal(c1[0].status, "FAIL");
    assert.match(c1[0].detail, /no ELF magic/);
    assert.equal(r.programs[0].elf.extraction, "FAILED");
    assert.equal(r.programs[0].elf.digest_match, null);
  });

  test("13. truncated ELF payload (declared size > payload) → span FAIL, digest cascade FAIL", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    const cut = elf.subarray(0, elf.length - 64); // section table half-gone
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, cut), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf); // pin the FULL elf — observed must not match
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const c2 = checkOf(r, "C2 scanner");
    assert.equal(c2[0].status, "FAIL");
    assert.equal(r.programs[0].elf.observed_sha256, null);
    assert.equal(r.programs[0].elf.digest_match, null);
  });

  test("14. unsupported SBPF architecture (v3: e_machine 247 / e_flags 3) → arch FAIL even with a matching digest", async () => {
    const state = fullState();
    const v3elf = buildSbfElf({ idBase58: NS3.scannerProgramId, eMachine: 247, eFlags: 3 });
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, v3elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(v3elf); // digest pin matches the v3 bytes
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const c4 = checkOf(r, "C4 scanner");
    assert.equal(c4[0].status, "FAIL");
    assert.match(c4[0].detail, /NOT the SBPF v0 deployment target/);
    assert.equal(r.programs[0].elf.sbpf_valid, false);
    // The digest itself matched the (test) pin — the ARCH gate is independent:
    assert.equal(r.programs[0].elf.digest_match, true);
    // The arch stage is one of the structural stages: with the v0
    // requirement failed, structure_valid=false even though the ELF was
    // extracted, hashed, and its section table parsed fine.
    assert.equal(r.programs[0].elf.structure_valid, false);
    assert.equal(r.programs[0].elf.observed_sha256 !== null, true);
  });

  test("15. RPC transport failure on EVERY account request (genesis intact) → every program check UNVERIFIED, overall INCOMPLETE", async () => {
    // NOTE: a FULL transport failure (genesis included) short-circuits at
    // the cluster-identity gate — that ordering is pinned by test 19.
    // This scenario keeps the genesis gate alive and destroys every
    // account fetch, so the UNVERIFIED cascade across all program checks
    // is what is under test.
    const state = fullState({ failWhere: (method) => method !== "getGenesisHash" });
    const r = await run(state);
    assert.equal(r.overall, "INCOMPLETE");
    assert.equal(r.counts.unverified, 26); // 13 per program — genesis PASSED
    assert.equal(r.counts.fail, 0);
    for (const c of r.checks) {
      if (c.id === "G1 devnet") continue; // the genesis gate itself succeeded
      assert.equal(c.status, "UNVERIFIED", `${c.id} should be UNVERIFIED on transport failure`);
      assert.match(c.detail, /RPC failure|RPC transport/);
    }
    for (const p of r.programs) {
      assert.equal(p.program_account.exists, null); // NOT false — absence is not proven by an RPC failure
      assert.equal(p.elf.digest_match, null);
    }
  });

  test("16. RPC failure on the ProgramData request ONLY → scanner dependent checks UNVERIFIED, vault PASS", async () => {
    const state = fullState({
      failWhere: (method, params) => method === "getAccountInfo" && params?.[0] === PD_SCANNER,
    });
    const r = await run(state);
    assert.equal(r.overall, "INCOMPLETE"); // no FAIL anywhere, but a check could not run
    assert.equal(checkOf(r, "A1 scanner")[0].status, "PASS");
    assert.equal(checkOf(r, "B1 scanner")[0].status, "UNVERIFIED");
    assert.equal(checkOf(r, "C3 scanner")[0].status, "UNVERIFIED");
    assert.equal(r.programs[0].programdata.exists, null);
    assert.equal(r.programs[1].elf.digest_match, true);
  });

  test("17. FAIL takes precedence over INCOMPLETE (vault digest FAIL + scanner RPC failure)", async () => {
    const state = fullState({
      failWhere: (method, params) => method === "getAccountInfo" && params?.[0] === PD_SCANNER,
    });
    // Corrupt the vault ELF on chain so its digest definitively mismatches.
    const velf = goodElf(NS3.vaultProgramId);
    velf[200] ^= 0xff;
    state.accounts[PD_VAULT] = rpcAccount(programDataWithAuthority(NS3.deployer, velf), {
      owner: LOADER,
    });
    const r = await run(state);
    assert.equal(r.overall, "FAIL"); // definitive FAIL wins over the UNVERIFIED scanner section
    assert.equal(r.counts.fail > 0, true);
    assert.equal(r.counts.unverified > 0, true);
    assert.equal(checkOf(r, "C8 vault")[0].status, "FAIL");
    assert.equal(checkOf(r, "C3 scanner")[0].status, "UNVERIFIED");
  });

  test("18. genesis mismatch → immediate FAIL; no deployed bytes are interpreted (RPC call history pinned)", async () => {
    const state = fullState({ genesisHash: "Testwa1v1qqeHqS1rSMHEquSQZ8hk4XCvL4xJLbBNo" });
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    assert.equal(r.checks.length, 1); // ONLY the cluster-identity check ran
    assert.equal(r.checks[0].id, "G1 devnet");
    assert.equal(r.checks[0].status, "FAIL");
    assert.match(r.checks[0].detail, /NOT the approved cluster/);
    assert.equal(r.programs[0].program_account.exists, null);
    assert.equal(r.programs[0].elf.digest_match, null);
    // RPC CALL HISTORY: a foreign cluster is refused deterministically —
    // the endpoint never received a single getAccountInfo call.
    assert.equal(state.rpcCalls.filter((c) => c.method === "getAccountInfo").length, 0);
    assert.equal(state.rpcCalls.filter((c) => c.method === "getGenesisHash").length, 1);
  });

  test("19. genesis RPC failure → UNVERIFIED cluster identity → SHORT-CIRCUIT: not one account is fetched, overall INCOMPLETE", async () => {
    const state = fullState({ failWhere: (method) => method === "getGenesisHash" });
    const r = await run(state);
    assert.equal(r.overall, "INCOMPLETE");
    assert.equal(r.counts.fail, 0);
    assert.equal(r.counts.unverified, 1);
    assert.equal(r.checks.length, 1); // ONLY the cluster-identity check exists
    const g1 = checkOf(r, "G1 devnet");
    assert.equal(g1[0].status, "UNVERIFIED");
    assert.match(g1[0].detail, /cluster identity could NOT be established/);
    // RPC CALL HISTORY (the actual call sequence, not just the final
    // classification): the genesis request arrived and failed, and the
    // endpoint received NO getAccountInfo call at all — deployed bytes
    // are never fetched or interpreted on a cluster whose identity
    // could not be established.
    assert.equal(state.rpcCalls.filter((c) => c.method === "getGenesisHash").length, 1);
    assert.equal(state.rpcCalls.filter((c) => c.method === "getAccountInfo").length, 0);
    for (const p of r.programs) {
      assert.equal(p.program_account.exists, null); // NOT false — nothing was fetched
      assert.equal(p.programdata.exists, null);
      assert.equal(p.elf.extraction, "UNVERIFIED");
      assert.equal(p.elf.observed_sha256, null);
      assert.equal(p.elf.digest_match, null);
      assert.equal(p.elf.structure_valid, null); // no ELF bytes were ever assessed
    }
  });

  test("20. Case 5 + Case 1 — genuine trailing ZERO bytes that are PART of the original artifact are hashed, never stripped", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    // The original artifact itself ended in 1024 zero bytes (a valid ELF —
    // ELF structures do not necessarily encode the file length, so those
    // zeros are unreferenced by any section or segment).
    const artifact = Buffer.concat([elf, Buffer.alloc(1024, 0)]);
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, artifact), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(artifact); // pin over the WHOLE original artifact
    const r = await run(state);
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    const scanner = r.programs[0];
    assert.equal(scanner.elf.hash_span_bytes, artifact.length); // the FULL payload is hashed
    assert.equal(scanner.elf.observed_sha256, sha256(artifact)); // the zeros are INCLUDED
    assert.notEqual(scanner.elf.observed_sha256, sha256(elf)); // the old strip-the-tail rule would differ
    assert.equal(scanner.elf.digest_match, true);
    assert.equal(scanner.elf.payload_size, artifact.length);
    assert.equal(scanner.elf.trailing_bytes_beyond_declared_structure, 1024);
    assert.equal(scanner.elf.trailing_bytes_all_zero, true); // disclosed — but NOT excluded
    assert.equal(scanner.elf.declared_elf_size, elf.length);
    assert.equal(scanner.elf.structure_valid, true);
    assert.match(checkOf(r, "C2 scanner")[0].detail, /disclosed, NOT excluded/);
  });

  test("20b. Case 2 — genuine trailing NONZERO bytes unreferenced by any section or segment are hashed, never truncated or rejected", async () => {
    const state = fullState();
    const elf = goodElf(NS3.vaultProgramId);
    const artifact = Buffer.concat([elf, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01])]);
    state.accounts[PD_VAULT] = rpcAccount(programDataWithAuthority(NS3.deployer, artifact), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(goodElf(NS3.scannerProgramId));
    state.fixtureDigests.vault = sha256(artifact); // pin over the WHOLE original artifact
    const r = await run(state);
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    const vault = r.programs[1];
    assert.equal(vault.elf.hash_span_bytes, artifact.length);
    assert.equal(vault.elf.observed_sha256, sha256(artifact)); // unreferenced bytes INCLUDED
    assert.equal(vault.elf.digest_match, true);
    assert.equal(vault.elf.trailing_bytes_beyond_declared_structure, 5);
    assert.equal(vault.elf.trailing_bytes_all_zero, false); // disclosed — but NOT a failure
    assert.equal(vault.elf.structure_valid, true); // disclosure is a diagnostic, not a structural stage
    assert.equal(vault.elf.identity_verdict, "structural");
    assert.match(checkOf(r, "C7 vault")[0].detail, /all zero: NO/);
  });

  test("20c. Case 3 — extra zero-filled account capacity with NO independent length evidence → FAIL CLOSED (the zero tail is NOT assumed to be padding)", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    // Payload = artifact + allocation capacity (e.g. an explicit larger
    // --max-len). The pin covers the TRUE artifact only; nothing in the
    // payload establishes where the artifact ends, so NOTHING may be
    // excluded — the full payload must match the pin and does not.
    state.accounts[PD_SCANNER] = rpcAccount(
      programDataWithAuthority(NS3.deployer, Buffer.concat([elf, Buffer.alloc(1024, 0)])),
      { owner: LOADER },
    );
    state.fixtureDigests.scanner = sha256(elf); // the true artifact digest
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const scanner = r.programs[0];
    assert.equal(scanner.elf.structure_valid, true); // structure is fine — the CONTENT cannot be verified
    assert.equal(scanner.elf.trailing_bytes_beyond_declared_structure, 1024);
    assert.equal(scanner.elf.trailing_bytes_all_zero, true);
    assert.equal(scanner.elf.hash_span_bytes, elf.length + 1024); // every byte hashed — nothing excluded
    assert.equal(scanner.elf.observed_sha256, sha256(Buffer.concat([elf, Buffer.alloc(1024, 0)])));
    assert.notEqual(scanner.elf.observed_sha256, sha256(elf)); // a stripped-tail hash is NOT what was reported
    assert.equal(scanner.elf.digest_match, false);
    const c3 = checkOf(r, "C3 scanner");
    assert.equal(c3[0].status, "FAIL");
    assert.match(c3[0].detail, /MISMATCH/);
    // The disclosure names the ambiguity explicitly (JSON + human output).
    assert.match(checkOf(r, "C2 scanner")[0].detail, /cannot be distinguished/);
  });

  test("20d. Case 6 — one-byte alteration in the region the previous implementation EXCLUDED (undeclared tail) changes the digest → FAIL", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    const artifact = Buffer.concat([elf, Buffer.alloc(512, 0)]);
    const altered = Buffer.from(artifact);
    altered[artifact.length - 1] ^= 0x01; // flip ONE byte inside the undeclared tail
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, altered), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(artifact); // pin over the intact artifact
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const scanner = r.programs[0];
    assert.equal(scanner.elf.observed_sha256, sha256(altered)); // the altered byte WAS hashed
    assert.equal(scanner.elf.digest_match, false); // the old exclude-the-tail rule would report a false match
    assert.equal(checkOf(r, "C3 scanner")[0].status, "FAIL");
  });

  test("20e. Case 4 (Finding A, end-to-end) — a program-header TABLE beyond the SHT end and beyond all section/segment extents is hashed IN FULL", async () => {
    const state = fullState();
    const elf = buildLayoutedElf({
      idBase58: NS3.scannerProgramId,
      phdrAfterSht: true,
      tailSection: { type: SHT_PROGBITS, flags: 0, data: Buffer.alloc(32, 0x5a) },
    });
    // Structural gate: the table is the span-setting structure and the
    // pre-fix calculation (validate phEnd but exclude it from the max)
    // would have hashed a DIFFERENT byte set.
    const spanInfo = elfDeclaredSpan(elf);
    assert.ok(spanInfo.shtEnd < spanInfo.phEnd);
    assert.equal(spanInfo.span, elf.length);
    assert.match(spanInfo.basis, /program header table/);
    const oldBugSpan = Math.max(spanInfo.shtEnd, spanInfo.sectionMax, spanInfo.segmentMax, 64);
    assert.ok(oldBugSpan < elf.length);
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf); // whole-artifact pin (table bytes included)
    const r = await run(state);
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    const scanner = r.programs[0];
    assert.equal(scanner.elf.hash_span_bytes, elf.length);
    assert.equal(scanner.elf.observed_sha256, sha256(elf)); // table bytes INCLUDED in the digest
    assert.notEqual(scanner.elf.observed_sha256, sha256(elf.subarray(0, oldBugSpan))); // pre-fix digest ≠ reported digest
    assert.equal(scanner.elf.digest_match, true);
    assert.equal(scanner.elf.declared_elf_size, elf.length);
    assert.match(scanner.elf.span_basis, /program header table/);
    assert.equal(scanner.elf.identity_verdict, "structural");
    assert.equal(scanner.elf.structure_valid, true);
  });

  test("21. non-zero bytes beyond the declared ELF end with a prefix-only pin → digest FAIL (a content-integrity failure, structure still valid)", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    state.accounts[PD_SCANNER] = rpcAccount(
      programDataWithAuthority(NS3.deployer, Buffer.concat([elf, Buffer.from([1, 2, 3, 4])])),
      { owner: LOADER },
    );
    state.fixtureDigests.scanner = sha256(elf); // pin over the prefix only
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const scanner = r.programs[0];
    // The tail is DISCLOSED (count + all-zero flag), never a structural
    // stage: the structure passed, the CONTENT (full-payload digest) failed.
    assert.equal(scanner.elf.structure_valid, true);
    assert.equal(scanner.elf.trailing_bytes_beyond_declared_structure, 4);
    assert.equal(scanner.elf.trailing_bytes_all_zero, false);
    assert.equal(scanner.elf.hash_span_bytes, elf.length + 4); // FULL payload hashed
    assert.equal(
      scanner.elf.observed_sha256,
      sha256(Buffer.concat([elf, Buffer.from([1, 2, 3, 4])])),
    );
    assert.equal(scanner.elf.digest_match, false);
    assert.equal(checkOf(r, "C2 scanner")[0].status, "PASS"); // disclosure, not a structural failure
    assert.equal(checkOf(r, "C3 scanner")[0].status, "FAIL");
  });

  test("21h. malformed program-header TABLE beyond the payload → structural FAIL, nothing hashed, structure_valid=false", async () => {
    const state = fullState();
    const elf = buildLayoutedElf({ idBase58: NS3.scannerProgramId });
    elf.writeUInt16LE(56, 54);
    elf.writeBigUInt64LE(BigInt(elf.length - 30), 32); // e_phoff near EOF
    elf.writeUInt16LE(1, 56); // table end beyond the payload
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const c2 = checkOf(r, "C2 scanner");
    assert.equal(c2[0].status, "FAIL");
    assert.match(c2[0].detail, /program header table out of range/);
    assert.equal(r.programs[0].elf.observed_sha256, null); // refused to hash
    assert.equal(r.programs[0].elf.digest_match, null);
    assert.equal(r.programs[0].elf.structure_valid, false);
  });

  test("21a. ADVERSARIAL: section content beyond the section header table is hashed IN FULL — the whole-file pin matches (no truncation, no weakened comparison)", async () => {
    const state = fullState();
    const elf = buildLayoutedElf({
      idBase58: NS3.scannerProgramId,
      tailSection: {
        type: SHT_PROGBITS,
        flags: 0,
        data: Buffer.from("NS3 tail section content placed AFTER the SHT end", "utf8"),
      },
    });
    // Sanity: the SHT-end rule would truncate here; the max-extent rule covers the file.
    const spanInfo = elfDeclaredSpan(elf);
    assert.ok(spanInfo.shtEnd < elf.length);
    assert.equal(spanInfo.span, elf.length);
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf); // pin = WHOLE-FILE digest, exactly how real artifacts are pinned
    const r = await run(state);
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    const scanner = r.programs[0];
    assert.equal(scanner.elf.declared_elf_size, elf.length);
    assert.equal(scanner.elf.trailing_bytes_beyond_declared_structure, 0);
    assert.equal(scanner.elf.observed_sha256, sha256(elf)); // full file hashed
    assert.equal(scanner.elf.digest_match, true);
    assert.equal(scanner.elf.identity_verdict, "structural"); // the identity gate parsed the same layout
    assert.equal(scanner.elf.structure_valid, true);
  });

  test("21b. ADVERSARIAL: all-zero section content beyond the SHT end is ELF-DECLARED content — INCLUDED in the digest (the old SHT-end rule silently truncated it)", async () => {
    const state = fullState();
    const elf = buildLayoutedElf({
      idBase58: NS3.scannerProgramId,
      tailSection: { type: SHT_PROGBITS, flags: 0, data: Buffer.alloc(512, 0) },
    });
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf); // whole-file pin (zeros included)
    const r = await run(state);
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    const scanner = r.programs[0];
    // Contrast with test 20c: those zeros are a DECLARED section, so the
    // structure-implied extent INCLUDES them (no trailing bytes) and the
    // whole-file digest matches. Undeclared zero tails are disclosed and
    // hashed like every other byte (test 20) — never excluded (test 20c).
    assert.equal(scanner.elf.trailing_bytes_beyond_declared_structure, 0);
    assert.equal(scanner.elf.declared_elf_size, elf.length);
    assert.equal(scanner.elf.observed_sha256, sha256(elf));
    assert.equal(scanner.elf.digest_match, true);
    assert.match(scanner.elf.span_basis, /section extents/);
  });

  test("21c. ADVERSARIAL: a program header extent beyond the SHT end sets the span — hashed in full", async () => {
    const state = fullState();
    const elf = buildLayoutedElf({
      idBase58: NS3.scannerProgramId,
      extraZeroTail: 128, // payload extends beyond the SHT (undeclared by any section)
      programHeader: { offset: 64, filesz: 0 },
    });
    const ePhoff = Number(elf.readBigUInt64LE(32));
    // Extend the segment to cover the whole file (beyond the SHT end): the
    // program header DECLARES those bytes as loaded content.
    elf.writeBigUInt64LE(BigInt(elf.length - 64), ePhoff + 32);
    const spanInfo = elfDeclaredSpan(elf);
    assert.ok(spanInfo.segmentMax > spanInfo.shtEnd);
    assert.equal(spanInfo.span, elf.length);
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    assert.equal(r.programs[0].elf.observed_sha256, sha256(elf));
    assert.match(r.programs[0].elf.span_basis, /program header extents/);
  });

  test("21d. extended section numbering (e_shnum=0) verifies END-TO-END — span, identity and digest agree; JSON + human output report it identically", async () => {
    const state = fullState({
      scannerElf: buildLayoutedElf({ idBase58: NS3.scannerProgramId, extendedShnum: true }),
    });
    const elf = buildLayoutedElf({ idBase58: NS3.scannerProgramId, extendedShnum: true });
    // Full-path consistency (Finding: no partial extended-numbering support):
    // the SAME parse serves the identity gate and the span derivation.
    assert.equal(parseElf64Sections(elf).length, 4);
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    const scanner = r.programs[0];
    assert.equal(scanner.elf.declared_elf_size, elf.length);
    assert.match(scanner.elf.span_basis, /extended numbering/);
    assert.equal(scanner.elf.observed_sha256, sha256(elf));
    assert.equal(scanner.elf.digest_match, true);
    assert.equal(scanner.elf.identity_verdict, "structural");
    assert.equal(scanner.elf.structure_valid, true);
  });

  test("21e. PN_XNUM program-count escape (e_phnum=0xffff, real count in SH0.sh_info) — end-to-end", async () => {
    const state = fullState();
    const elf = buildLayoutedElf({ idBase58: NS3.scannerProgramId, extendedPhnum: true });
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    assert.equal(r.programs[0].elf.observed_sha256, sha256(elf));
    assert.equal(r.programs[0].elf.digest_match, true);
    assert.match(r.programs[0].elf.span_basis, /program header extents/);
  });

  test("21f. section extent beyond the PAYLOAD → span FAILS CLOSED, nothing hashed, structure_valid=false", async () => {
    const state = fullState();
    const elf = buildLayoutedElf({
      idBase58: NS3.scannerProgramId,
      tailSection: { type: SHT_PROGBITS, flags: 0, data: Buffer.alloc(64, 7) },
    });
    const shoff = Number(elf.readBigUInt64LE(40));
    elf.writeBigUInt64LE(BigInt(elf.length + 4096), shoff + 3 * 64 + 32); // .tail claims bytes the account does not hold
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const c2 = checkOf(r, "C2 scanner");
    assert.equal(c2[0].status, "FAIL");
    assert.match(c2[0].detail, /out of range|beyond the payload/);
    assert.equal(r.programs[0].elf.observed_sha256, null); // refused to hash
    assert.equal(r.programs[0].elf.digest_match, null);
    assert.equal(r.programs[0].elf.structure_valid, false);
  });

  test("21g. ELF header invalid (e_machine 99) → header validation FAILS CLOSED before any extent is read", async () => {
    const state = fullState();
    const elf = buildLayoutedElf({ idBase58: NS3.scannerProgramId, eMachine: 99 });
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const c2 = checkOf(r, "C2 scanner");
    assert.equal(c2[0].status, "FAIL");
    assert.match(c2[0].detail, /e_machine 99 not in/);
    assert.equal(r.programs[0].elf.observed_sha256, null);
    assert.equal(r.programs[0].elf.structure_valid, false);
  });

  test("21z. regression: structure_valid never contradicts the evidence — the invariants hold on EVERY evidence path", async () => {
    const scenarios = [
      ["all-good", fullState()],
      [
        "digest mismatch",
        (() => {
          const s = fullState();
          const o = goodElf(NS3.scannerProgramId);
          o.writeUInt32LE(0xdeadbeef, 96);
          s.fixtureDigests.scanner = sha256(o);
          return s;
        })(),
      ],
      ["missing program", fullState({ delete: [NS3.scannerProgramId] })],
      ["missing ProgramData", fullState({ delete: [PD_SCANNER] })],
      ["RPC transport failure", fullState({ failWhere: () => true })],
      ["genesis failure", fullState({ failWhere: (m) => m === "getGenesisHash" })],
      ["foreign genesis", fullState({ genesisHash: "Testwa1v1qqeHqS1rSMHEquSQZ8hk4XCvL4xJLbBNo" })],
      [
        "truncated ELF",
        (() => {
          const s = fullState();
          const elf = goodElf(NS3.scannerProgramId);
          s.accounts[PD_SCANNER] = rpcAccount(
            programDataWithAuthority(NS3.deployer, elf.subarray(0, elf.length - 64)),
            { owner: LOADER },
          );
          return s;
        })(),
      ],
      [
        "v3 architecture",
        (() => {
          const s = fullState();
          const v3 = buildSbfElf({ idBase58: NS3.scannerProgramId, eMachine: 247, eFlags: 3 });
          s.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, v3), {
            owner: LOADER,
          });
          s.fixtureDigests.scanner = sha256(v3);
          return s;
        })(),
      ],
      [
        "non-zero tail",
        (() => {
          const s = fullState();
          const elf = goodElf(NS3.scannerProgramId);
          s.accounts[PD_SCANNER] = rpcAccount(
            programDataWithAuthority(NS3.deployer, Buffer.concat([elf, Buffer.from([1, 2, 3, 4])])),
            { owner: LOADER },
          );
          s.fixtureDigests.scanner = sha256(elf);
          return s;
        })(),
      ],
      [
        "zero padding",
        (() => {
          const s = fullState();
          const elf = goodElf(NS3.scannerProgramId);
          s.accounts[PD_SCANNER] = rpcAccount(
            programDataWithAuthority(NS3.deployer, Buffer.concat([elf, Buffer.alloc(256, 0)])),
            { owner: LOADER },
          );
          s.fixtureDigests.scanner = sha256(elf);
          return s;
        })(),
      ],
      [
        "section beyond payload",
        (() => {
          const s = fullState();
          const elf = buildLayoutedElf({
            idBase58: NS3.scannerProgramId,
            tailSection: { type: SHT_PROGBITS, flags: 0, data: Buffer.alloc(64, 7) },
          });
          const shoff = Number(elf.readBigUInt64LE(40));
          elf.writeBigUInt64LE(BigInt(elf.length + 4096), shoff + 3 * 64 + 32);
          s.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
            owner: LOADER,
          });
          return s;
        })(),
      ],
      [
        "invalid header",
        (() => {
          const s = fullState();
          const elf = buildLayoutedElf({ idBase58: NS3.scannerProgramId, eMachine: 99 });
          s.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
            owner: LOADER,
          });
          return s;
        })(),
      ],
      [
        "extended numbering",
        (() => {
          const s = fullState({
            scannerElf: buildLayoutedElf({ idBase58: NS3.scannerProgramId, extendedShnum: true }),
          });
          return s;
        })(),
      ],
      [
        "adversarial tail section",
        (() => {
          const s = fullState();
          const elf = buildLayoutedElf({
            idBase58: NS3.scannerProgramId,
            tailSection: { type: SHT_PROGBITS, flags: 0, data: Buffer.from("tail-beyond-sht") },
          });
          s.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
            owner: LOADER,
          });
          s.fixtureDigests.scanner = sha256(elf);
          return s;
        })(),
      ],
      [
        "genuine zero tail (whole-artifact pin)",
        (() => {
          const s = fullState();
          const elf = goodElf(NS3.scannerProgramId);
          const artifact = Buffer.concat([elf, Buffer.alloc(128, 0)]);
          s.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, artifact), {
            owner: LOADER,
          });
          s.fixtureDigests.scanner = sha256(artifact);
          return s;
        })(),
      ],
      [
        "program-header table beyond all extents (Finding A)",
        (() => {
          const s = fullState();
          const elf = buildLayoutedElf({
            idBase58: NS3.scannerProgramId,
            phdrAfterSht: true,
            tailSection: { type: SHT_PROGBITS, flags: 0, data: Buffer.alloc(32, 0x5a) },
          });
          s.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
            owner: LOADER,
          });
          s.fixtureDigests.scanner = sha256(elf);
          return s;
        })(),
      ],
      [
        "malformed program-header table (beyond payload)",
        (() => {
          const s = fullState();
          const elf = buildLayoutedElf({ idBase58: NS3.scannerProgramId });
          elf.writeUInt16LE(56, 54);
          elf.writeBigUInt64LE(BigInt(elf.length - 30), 32);
          elf.writeUInt16LE(1, 56);
          s.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
            owner: LOADER,
          });
          s.fixtureDigests.scanner = sha256(elf);
          return s;
        })(),
      ],
    ];
    for (const [name, state] of scenarios) {
      const r = await run(state);
      assert.ok(r.programs.length === 2, name);
      for (const p of r.programs) assertNoFieldContradictions(p, name);
    }
  });
});

describe("CLI behavior — output shape consistency, exit codes, refusal of overrides", () => {
  // NOTE: the CLI verifies against the COMMITTED provenance manifest (it has
  // no manifest flag — that is the point), and the committed pins are the
  // approved NS-3 digests. Synthetic fixture ELFs can never reproduce those
  // digests (SHA-256 preimage), so an offline CLI run is ALWAYS a FAIL —
  // which is itself a property worth pinning: the CLI cannot be coaxed into
  // a PASS by mock bytes. PASS verdicts and exit code 0 are pinned by the
  // API-level tests above, where the manifest is injected through the same
  // validated loading path.
  test("22. --json: identical key sets for both programs; required fields present; exit 1 on offline FAIL", async () => {
    const state = fullState();
    let out;
    await withVerification(state, async ({ url }) => {
      // The CLI has no manifest flag — the committed manifest is used. For
      // the shape/exit-code assertions the fixture digests do not need to
      // match the committed pins; only the SHAPE is pinned here.
      out = await runCli(url, ["--json"]);
    });
    assert.equal(out.code, 1, out.stderr || out.stdout);
    const j = JSON.parse(out.stdout);
    assert.equal(j.tool, TOOL_NAME);
    assert.equal(j.read_only, true);
    assert.equal(j.overall, "FAIL"); // committed manifest pins ≠ fixture digests → digest FAILs
    assert.equal(j.programs.length, 2);
    const [scanner, vault] = j.programs;
    assert.deepEqual(Object.keys(scanner).sort(), Object.keys(vault).sort());
    assert.deepEqual(
      Object.keys(scanner.program_account).sort(),
      Object.keys(vault.program_account).sort(),
    );
    assert.deepEqual(
      Object.keys(scanner.programdata).sort(),
      Object.keys(vault.programdata).sort(),
    );
    assert.deepEqual(
      Object.keys(scanner.programdata.upgrade_authority).sort(),
      Object.keys(vault.programdata.upgrade_authority).sort(),
    );
    assert.deepEqual(Object.keys(scanner.elf).sort(), Object.keys(vault.elf).sort());
    // Required fields (handoff § structured output) exist in BOTH programs:
    const required = [
      ["program_account", "exists"],
      ["program_account", "executable"],
      ["program_account", "owner"],
      ["programdata", "exists"],
      ["programdata", "owner"],
      ["programdata", "state_valid"],
      ["programdata", "slot"],
      ["elf", "extraction"],
      ["elf", "payload_offset"],
      ["elf", "payload_size"],
      ["elf", "declared_elf_size"],
      ["elf", "structure_valid"],
      ["elf", "sbpf_arch"],
      ["elf", "sbpf_valid"],
      ["elf", "observed_sha256"],
      ["elf", "expected_sha256"],
      ["elf", "digest_match"],
    ];
    for (const p of [scanner, vault]) {
      assert.equal(typeof p.program_id, "string");
      assert.ok(
        typeof p.programdata_embedded_address === "string" ||
          p.programdata_embedded_address === null,
      );
      assert.ok(typeof p.programdata_derived_address === "string");
      assert.ok(typeof p.pointer_match === "boolean" || p.pointer_match === null);
      for (const [section, field] of required) {
        assert.ok(field in p[section], `${section}.${field} missing`);
      }
      assert.ok("present" in p.programdata.upgrade_authority);
      assert.ok("address" in p.programdata.upgrade_authority);
      assert.ok("status" in p.programdata.upgrade_authority);
    }
  });

  test("23. --json shape stays identical on a divergent evidence path (one program absent, one digest FAIL)", async () => {
    const state = fullState({ delete: [PD_VAULT] });
    let out;
    await withVerification(state, async ({ url }) => {
      out = await runCli(url, ["--json"]);
    });
    assert.equal(out.code, 1, out.stderr || out.stdout);
    const j = JSON.parse(out.stdout);
    const [scanner, vault] = j.programs;
    assert.deepEqual(Object.keys(scanner).sort(), Object.keys(vault).sort());
    assert.deepEqual(Object.keys(scanner.elf).sort(), Object.keys(vault.elf).sort());
    assert.equal(vault.programdata.exists, false);
    assert.equal(vault.elf.digest_match, null);
    assert.equal(vault.elf.observed_sha256, null);
  });

  test("24. human output: structural lines, per-program sections, OVERALL RESULT, exit codes 1/3", async () => {
    // FAIL path (see the suite note — offline CLI runs cannot PASS):
    const state = fullState();
    let failOut, incompleteOut;
    await withVerification(state, async ({ url }) => {
      failOut = await runCli(url, []);
    });
    assert.equal(failOut.code, 1, failOut.stderr || failOut.stdout);
    assert.match(
      failOut.stdout,
      /=== NS-3 deployed-ELF digest verification — STRICTLY READ-ONLY ===/,
    );
    assert.match(failOut.stdout, /overall: FAIL \(pass 25 \/ fail 2 \/ unverified 0 \/ info 0\)/);
    assert.match(failOut.stdout, /manifest: scripts\/devnet\/provenance\.manifest\.json/);
    assert.match(failOut.stdout, /Section A GraveScanner — program account & ProgramData pointer/);
    assert.match(
      failOut.stdout,
      /Section C GraveVault — deployed ELF payload, SBPF v0 architecture & digest provenance/,
    );
    assert.match(failOut.stdout, /OVERALL RESULT: FAIL/);

    // INCOMPLETE path (every RPC request destroyed): exit 3, guidance printed.
    const broken = fullState({ failWhere: () => true });
    await withVerification(broken, async ({ url }) => {
      incompleteOut = await runCli(url, []);
    });
    assert.equal(incompleteOut.code, 3);
    assert.match(incompleteOut.stdout, /overall: INCOMPLETE/);
    assert.match(incompleteOut.stdout, /OVERALL RESULT: INCOMPLETE/);
    assert.match(incompleteOut.stdout, /re-run against a healthy RPC/);
  });

  test("25. usage errors: missing --url and override flags are refused with exit 2", async () => {
    const missing = await execFileCatch(TOOL, []);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--url is REQUIRED/);
    for (const flag of [
      "--manifest",
      "--manifest-path /tmp/x",
      "--scanner-id EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL",
      "--keypair /tmp/x",
      "--deployer cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831",
    ]) {
      const [f, v] = flag.split(" ");
      const r = await execFileCatch(TOOL, ["--url", "http://127.0.0.1:1", f, ...(v ? [v] : [])]);
      assert.equal(r.code, 2, `flag ${f} must be refused`);
      assert.match(r.stderr, /not accepted/);
    }
  });

  test("26. usage error: invalid --commitment value → exit 2", async () => {
    const r = await execFileCatch(TOOL, [
      "--url",
      "http://127.0.0.1:1",
      "--commitment",
      "processed",
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--commitment/);
  });

  test("27. extended section numbering: JSON and human output agree on the span (basis reported in both; digest still fails against the committed pins)", async () => {
    const state = fullState({
      scannerElf: buildLayoutedElf({ idBase58: NS3.scannerProgramId, extendedShnum: true }),
    });
    let jsonOut, humanOut;
    await withVerification(state, async ({ url }) => {
      jsonOut = await runCli(url, ["--json"]);
      humanOut = await runCli(url, []);
    });
    assert.equal(jsonOut.code, 1); // committed pins ≠ fixture digest (expected offline)
    const j = JSON.parse(jsonOut.stdout);
    const scanner = j.programs[0];
    assert.match(scanner.elf.span_basis, /extended numbering/);
    assert.equal(scanner.elf.structure_valid, true); // structure fine; the digest mismatch is separate
    assert.equal(scanner.elf.digest_match, false);
    // The human-readable report carries the SAME span basis — no output
    // path claims something the other contradicts.
    assert.match(humanOut.stdout, /span basis: section header table end \(extended numbering\)/);
    assert.match(humanOut.stdout, /\[C2 scanner\]/);
    assert.equal(humanOut.code, 1);
  });

  test("28. genesis RPC failure at the CLI → exit 3 with exactly one UNVERIFIED check and zero account fetches", async () => {
    const state = fullState({ failWhere: (method) => method === "getGenesisHash" });
    let out;
    await withVerification(state, async ({ url }) => {
      out = await runCli(url, []);
    });
    assert.equal(out.code, 3);
    assert.match(out.stdout, /overall: INCOMPLETE \(pass 0 \/ fail 0 \/ unverified 1 \/ info 0\)/);
    assert.match(out.stdout, /OVERALL RESULT: INCOMPLETE/);
    assert.match(out.stdout, /cluster identity could NOT be established/);
    // RPC CALL HISTORY: the short-circuit held at the CLI boundary too.
    assert.equal(state.rpcCalls.filter((c) => c.method === "getGenesisHash").length, 1);
    assert.equal(state.rpcCalls.filter((c) => c.method === "getAccountInfo").length, 0);
  });
});

async function execFileCatch(file, args) {
  try {
    const { stdout } = await execFileP("node", [file, ...args], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.status ?? err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err),
    };
  }
}
