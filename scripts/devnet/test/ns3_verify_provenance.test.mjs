// SPDX-License-Identifier: Apache-2.0
//
// ns3_verify_provenance tests — positive and negative cases for the
// fail-closed ELF deployment-provenance gate, run against synthetic ELF64
// fixtures built in-memory (no anchor toolchain, no real .so needed).
//
// What the suite pins:
//   ✔ positive: manifest + both ELFs fully valid → every check passes
//   ✖ digest: scanner / vault one-byte tamper → REFUSED (the load-bearing gate)
//   ✖ missing ELF (null bytes) → REFUSED on all four checks
//   ✖ malformed ELF (not an ELF at all) → REFUSED
//   ✖ wrong embedded program ID (identity) even when the digest matches → REFUSED
//   ✖ legacy NS-1/NS-2 ID bytes anywhere in the file → REFUSED
//   ✖ wrong SBPF arch: e_machine 247 (anchor v3 default family) → REFUSED
//   ✖ wrong SBPF arch: e_flags 3 → REFUSED
//   ✖ manifest tamper: wrong program ID / bad digest format / wrong chain
//   ✔ optional platform-tools tarball verify: matching/wrong digest
//   ✔ CLI end-to-end: exit 0 on approved bytes, exit 1 on any failure
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import {
  checkManifestSchema,
  readElfArch,
  sha256Hex,
  verifyProvenanceBuffers,
} from "../ns3_verify_provenance.mjs";
import { NS3 } from "../ns3_identities.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------ fixtures

const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;

function idBytes(base58) {
  return Buffer.from(new PublicKey(base58).toBytes());
}

/** Minimal but spec-honest ELF64 LSB SBF file with the NS-3 scanner/vault
 *  IDs embedded in .rodata (allocated). e_machine/e_flags configurable so
 *  the arch-negative cases can build v3-family headers. */
function buildElf64({ ids = [], eMachine = 263, eFlags = 0 } = {}) {
  const sections = [
    { name: "", type: SHT_NULL, flags: 0, data: Buffer.alloc(0) },
    {
      name: ".text",
      type: SHT_PROGBITS,
      flags: SHF_ALLOC | SHF_EXECINSTR,
      data: Buffer.alloc(96, 0x90),
    },
    { name: ".rodata", type: SHT_PROGBITS, flags: SHF_ALLOC, data: Buffer.alloc(64, 0x42) },
    { name: ".shstrtab", type: SHT_STRTAB, flags: 0, data: null },
  ];
  for (const id of ids) {
    sections[2].data = Buffer.concat([sections[2].data, idBytes(id)]);
  }
  let strtab = Buffer.from([0x00]);
  const nameOffs = new Map();
  for (const s of sections) {
    if (s.name === "") {
      nameOffs.set("", 0);
      continue;
    }
    nameOffs.set(s.name, strtab.length);
    strtab = Buffer.concat([strtab, Buffer.from(`${s.name}\0`, "utf8")]);
  }
  sections[sections.length - 1].data = strtab;
  const ehsize = 64;
  const shentsize = 64;
  let cursor = ehsize;
  for (const s of sections) {
    s.offset = cursor;
    cursor += s.data.length;
  }
  const eShoff = cursor;
  const shnum = sections.length;
  const buf = Buffer.alloc(eShoff + shnum * shentsize);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 2;
  buf[5] = 1;
  buf[6] = 1;
  buf.writeUInt16LE(2, 16);
  buf.writeUInt16LE(eMachine, 18);
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(BigInt(eShoff), 40);
  buf.writeUInt32LE(eFlags, 48);
  buf.writeUInt16LE(64, 52);
  buf.writeUInt16LE(64, 58);
  buf.writeUInt16LE(shnum, 60);
  buf.writeUInt16LE(shnum - 1, 62);
  let at = ehsize;
  for (const s of sections) {
    s.data.copy(buf, at);
    at += s.data.length;
  }
  for (let i = 0; i < shnum; i++) {
    const s = sections[i];
    const base = eShoff + i * shentsize;
    buf.writeUInt32LE(nameOffs.get(s.name) ?? 0, base);
    buf.writeUInt32LE(s.type, base + 4);
    buf.writeBigUInt64LE(BigInt(s.flags), base + 8);
    buf.writeBigUInt64LE(BigInt(s.offset), base + 24);
    buf.writeBigUInt64LE(BigInt(s.data.length), base + 32);
  }
  return buf;
}

const NS2_SCANNER = "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54";

/** A manifest fixture whose digests match the given buffers (so digest and
 *  identity failures can be isolated from each other). */
function makeManifest({ scannerBuf, vaultBuf, overrides = {} }) {
  const base = {
    schema: "graveyield.devnet.provenance/1",
    chain: "devnet",
    generation: "NS-3",
    sbpf: { arch: "v0", eMachine: 263, eFlags: 0 },
    platformTools: {
      version: "v1.54",
      tarballSha256: "a".repeat(64),
      tarballUrl:
        "https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-linux-x86_64.tar.bz2",
    },
    toolchain: { solanaCli: "3.0.10", anchorCli: "1.2.2" },
    elfs: {
      scanner: {
        artifact: "grave_scanner.so",
        programId: NS3.scannerProgramId,
        sha256: scannerBuf ? sha256Hex(scannerBuf) : "b".repeat(64),
      },
      vault: {
        artifact: "grave_vault.so",
        programId: NS3.vaultProgramId,
        sha256: vaultBuf ? sha256Hex(vaultBuf) : "c".repeat(64),
      },
    },
  };
  return structuredClone({ ...base, ...overrides });
}

const GOOD_SCANNER = buildElf64({ ids: [NS3.scannerProgramId] });
const GOOD_VAULT = buildElf64({ ids: [NS3.vaultProgramId] });
const GOOD_MANIFEST = makeManifest({ scannerBuf: GOOD_SCANNER, vaultBuf: GOOD_VAULT });

function checkOf(result, label, id) {
  const elf = result.elfs.find((e) => e.label === label);
  return elf.checks.find((c) => c.id === `${label}:${id}`);
}

// ------------------------------------------------------------- tests

describe("ns3_verify_provenance — fail-closed ELF deployment provenance gate", () => {
  test("approved bytes + valid manifest → every check passes", () => {
    const r = verifyProvenanceBuffers({
      manifest: GOOD_MANIFEST,
      scannerBuf: GOOD_SCANNER,
      vaultBuf: GOOD_VAULT,
    });
    assert.equal(r.manifestProblems.length, 0);
    assert.equal(r.ok, true);
    for (const elf of r.elfs) {
      assert.deepEqual(
        elf.checks.filter((c) => !c.ok).map((c) => c.id),
        [],
        `${elf.label} must be fully green`,
      );
    }
  });

  test("one-byte tamper in the scanner ELF → digest check refuses the whole run", () => {
    const tampered = Buffer.from(GOOD_SCANNER);
    tampered[70] ^= 0x01; // inside .text junk, identity untouched
    const r = verifyProvenanceBuffers({
      manifest: GOOD_MANIFEST,
      scannerBuf: tampered,
      vaultBuf: GOOD_VAULT,
    });
    assert.equal(r.ok, false);
    assert.equal(checkOf(r, "scanner", "digest").ok, false);
    assert.equal(
      checkOf(r, "scanner", "identity").ok,
      true,
      "identity alone must NOT be sufficient",
    );
  });

  test("one-byte tamper in the vault ELF → refused", () => {
    const tampered = Buffer.from(GOOD_VAULT);
    tampered[70] ^= 0x01;
    const r = verifyProvenanceBuffers({
      manifest: GOOD_MANIFEST,
      scannerBuf: GOOD_SCANNER,
      vaultBuf: tampered,
    });
    assert.equal(r.ok, false);
    assert.equal(checkOf(r, "vault", "digest").ok, false);
  });

  test("missing scanner ELF (null) → refused on all four checks", () => {
    const r = verifyProvenanceBuffers({
      manifest: GOOD_MANIFEST,
      scannerBuf: null,
      vaultBuf: GOOD_VAULT,
    });
    assert.equal(r.ok, false);
    for (const id of ["digest", "identity", "legacy", "arch"]) {
      assert.equal(checkOf(r, "scanner", id).ok, false, `missing ELF must fail ${id}`);
    }
  });

  test("malformed ELF (plain text with matching digest) → identity refuses (fail-closed)", () => {
    const garbage = Buffer.from("this is definitely not an ELF binary, just text");
    const m = makeManifest({ scannerBuf: garbage, vaultBuf: GOOD_VAULT });
    const r = verifyProvenanceBuffers({ manifest: m, scannerBuf: garbage, vaultBuf: GOOD_VAULT });
    assert.equal(r.ok, false);
    assert.equal(checkOf(r, "scanner", "identity").ok, false);
  });

  test("wrong embedded program ID (NS-2 scanner bytes instead of NS-3) with a matching digest → identity refuses", () => {
    const wrong = buildElf64({ ids: [NS2_SCANNER] });
    const m = makeManifest({ scannerBuf: wrong, vaultBuf: GOOD_VAULT });
    const r = verifyProvenanceBuffers({ manifest: m, scannerBuf: wrong, vaultBuf: GOOD_VAULT });
    assert.equal(r.ok, false);
    assert.equal(
      checkOf(r, "scanner", "digest").ok,
      true,
      "digest was crafted to isolate the identity failure",
    );
    assert.equal(checkOf(r, "scanner", "identity").ok, false);
  });

  test("legacy NS-1/NS-2 ID bytes anywhere in the file → legacy canary refuses", () => {
    const polluted = Buffer.concat([
      buildElf64({ ids: [NS3.scannerProgramId] }),
      idBytes(NS2_SCANNER),
    ]);
    const m = makeManifest({ scannerBuf: polluted, vaultBuf: GOOD_VAULT });
    const r = verifyProvenanceBuffers({ manifest: m, scannerBuf: polluted, vaultBuf: GOOD_VAULT });
    assert.equal(r.ok, false);
    assert.equal(checkOf(r, "scanner", "legacy").ok, false);
    assert.match(checkOf(r, "scanner", "legacy").detail, /legacy ID bytes present/);
  });

  test("v3-family header (e_machine 247, anchor 1.2.2's default family) → arch check refuses", () => {
    const v3ish = buildElf64({ ids: [NS3.scannerProgramId], eMachine: 247, eFlags: 0 });
    const m = makeManifest({ scannerBuf: v3ish, vaultBuf: GOOD_VAULT });
    const r = verifyProvenanceBuffers({ manifest: m, scannerBuf: v3ish, vaultBuf: GOOD_VAULT });
    assert.equal(r.ok, false);
    assert.equal(checkOf(r, "scanner", "arch").ok, false);
  });

  test("v3 e_flags (3) with the right machine → arch check refuses", () => {
    const flag3 = buildElf64({ ids: [NS3.scannerProgramId], eMachine: 263, eFlags: 3 });
    const m = makeManifest({ scannerBuf: flag3, vaultBuf: GOOD_VAULT });
    const r = verifyProvenanceBuffers({ manifest: m, scannerBuf: flag3, vaultBuf: GOOD_VAULT });
    assert.equal(r.ok, false);
    assert.equal(checkOf(r, "scanner", "arch").ok, false);
    assert.match(checkOf(r, "scanner", "arch").detail, /e_flags=3/);
  });

  test("manifest tamper — a non-NS-3 program ID fails the schema check and blocks everything", () => {
    const m = makeManifest({ scannerBuf: GOOD_SCANNER, vaultBuf: GOOD_VAULT });
    m.elfs.scanner.programId = NS2_SCANNER;
    const r = verifyProvenanceBuffers({
      manifest: m,
      scannerBuf: GOOD_SCANNER,
      vaultBuf: GOOD_VAULT,
    });
    assert.equal(r.ok, false);
    assert.ok(r.manifestProblems.some((p) => p.includes("canonical NS-3 identity")));
    assert.equal(r.elfs.length, 0, "no ELF verification may run on a broken manifest");
  });

  test("manifest tamper — malformed digest / wrong chain / wrong arch record are schema failures", () => {
    const bad = [
      [
        "scanner digest not hex",
        (m) => {
          m.elfs.scanner.sha256 = "zz";
        },
      ],
      [
        "chain mainnet",
        (m) => {
          m.chain = "mainnet";
        },
      ],
      [
        "arch v3",
        (m) => {
          m.sbpf = { arch: "v3", eMachine: 247, eFlags: 3 };
        },
      ],
      [
        "platform-tools wrong version",
        (m) => {
          m.platformTools.version = "v1.51";
        },
      ],
      [
        "toolchain drift",
        (m) => {
          m.toolchain.solanaCli = "3.0.9";
        },
      ],
    ];
    for (const [name, mutate] of bad) {
      const m = makeManifest({ scannerBuf: GOOD_SCANNER, vaultBuf: GOOD_VAULT });
      mutate(m);
      const { ok, problems } = checkManifestSchema(m);
      assert.equal(ok, false, `${name} must be a schema failure`);
      assert.ok(problems.length > 0, name);
    }
  });

  test("optional platform-tools tarball — matching digest verifies, wrong digest refuses", () => {
    const tarball = Buffer.from("platform-tools v1.54 tarball bytes");
    const m = makeManifest({ scannerBuf: GOOD_SCANNER, vaultBuf: GOOD_VAULT });
    m.platformTools.tarballSha256 = sha256Hex(tarball);
    const good = verifyProvenanceBuffers({
      manifest: m,
      scannerBuf: GOOD_SCANNER,
      vaultBuf: GOOD_VAULT,
      tarballBuf: tarball,
    });
    assert.equal(good.tarball.ok, true);
    assert.equal(good.ok, true);
    const bad = verifyProvenanceBuffers({
      manifest: m,
      scannerBuf: GOOD_SCANNER,
      vaultBuf: GOOD_VAULT,
      tarballBuf: Buffer.from("tampered"),
    });
    assert.equal(bad.tarball.ok, false);
    assert.equal(bad.ok, false);
  });

  test("readElfArch reads e_machine/e_flags and rejects non-ELF buffers", () => {
    assert.deepEqual(readElfArch(GOOD_SCANNER), { eMachine: 263, eFlags: 0 });
    assert.throws(() => readElfArch(Buffer.alloc(100, 0x41)), /ELF magic/);
    assert.throws(() => readElfArch(Buffer.alloc(10)), /too small/);
  });

  test("CLI end-to-end — exit 0 on approved bytes, exit 1 on tampered bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-prov-"));
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(GOOD_MANIFEST));
    const scannerPath = join(dir, "grave_scanner.so");
    const vaultPath = join(dir, "grave_vault.so");
    writeFileSync(scannerPath, GOOD_SCANNER);
    writeFileSync(vaultPath, GOOD_VAULT);
    const cli = join(HERE, "..", "ns3_verify_provenance.mjs");
    const okRun = execFileSync(
      process.execPath,
      [cli, "--manifest", manifestPath, "--scanner-so", scannerPath, "--vault-so", vaultPath],
      { encoding: "utf8" },
    );
    assert.match(okRun, /PROVENANCE VERIFIED/);

    const tampered = Buffer.from(GOOD_SCANNER);
    tampered[70] ^= 0x02;
    writeFileSync(scannerPath, tampered);
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [cli, "--manifest", manifestPath, "--scanner-so", scannerPath, "--vault-so", vaultPath],
        { encoding: "utf8", stdio: "pipe" },
      );
    } catch (err) {
      failed = true;
      assert.equal(err.status, 1);
      assert.match(String(err.stderr), /PROVENANCE GATE REFUSED/);
      assert.match(
        String(err.stderr),
        /never bumped to make a failing check pass|independently reviewed/,
      );
    }
    assert.equal(failed, true, "tampered bytes must exit non-zero");
  });

  test("CLI usage error — missing --manifest exits 2", () => {
    const cli = join(HERE, "..", "ns3_verify_provenance.mjs");
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [cli, "--scanner-so", "/dev/null", "--vault-so", "/dev/null"],
        {
          encoding: "utf8",
          stdio: "pipe",
        },
      );
    } catch (err) {
      failed = true;
      assert.equal(err.status, 2);
    }
    assert.equal(failed, true);
  });
});
