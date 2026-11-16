// SPDX-License-Identifier: Apache-2.0
//
// ns3_check_provenance.test.mjs — unit tests for the shared fail-closed
// provenance checker (manifest validation, digest pinning, SBPF v0 arch
// invariant, structural identity reuse, platform-tools tarball integrity).
// Fully offline: fixture ELFs are fabricated, nothing is downloaded.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  loadProvenanceManifest,
  checkProvenance,
  REQUIRED_SBPF,
  DEFAULT_MANIFEST_PATH,
} from "../ns3_check_provenance.mjs";
import { NS3 } from "../ns3_identities.mjs";
import { buildSbfElf, sha256 } from "./helpers/provenance_fixtures.mjs";

let TMP;
function tmpRoot() {
  TMP = mkdtempSync(path.join(tmpdir(), "gy-provenance-"));
  return TMP;
}

function writeManifest(dir, mutate = (m) => m) {
  const m = mutate({
    schema: "graveyield.provenance/1",
    programs: {
      grave_scanner: { artifact: "target/deploy/grave_scanner.so", sha256: "0".repeat(64) },
      grave_vault: { artifact: "target/deploy/grave_vault.so", sha256: "1".repeat(64) },
    },
    toolchain: {
      sbpf_arch: "v0",
      elf: { e_machine: 263, e_flags: 0 },
      solana_cli: "3.0.10",
      platform_tools: {
        version: "1.54",
        sha256: "2".repeat(64),
        url: "https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-linux-x86_64.tar.bz2",
      },
    },
  });
  const p = path.join(dir, "provenance.manifest.json");
  writeFileSync(p, JSON.stringify(m, null, 2));
  return p;
}

describe("provenance manifest validation (fail-closed)", () => {
  test("the committed manifest validates", () => {
    const m = loadProvenanceManifest(DEFAULT_MANIFEST_PATH);
    assert.equal(m.toolchain.sbpf_arch, "v0");
    assert.equal(m.toolchain.platform_tools.version, "1.54");
    assert.equal(
      m.programs.grave_scanner.sha256,
      "e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98",
    );
    assert.equal(
      m.programs.grave_vault.sha256,
      "8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83",
    );
    assert.equal(
      m.toolchain.platform_tools.sha256,
      "fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e",
    );
  });

  test("wrong schema refuses", () => {
    const p = writeManifest(tmpRoot(), (m) => ({ ...m, schema: "graveyield.provenance/999" }));
    assert.throws(() => loadProvenanceManifest(p), /schema/);
  });

  test("missing vault digest refuses", () => {
    const p = writeManifest(tmpRoot(), (m) => {
      delete m.programs.grave_vault.sha256;
      return m;
    });
    assert.throws(() => loadProvenanceManifest(p), /grave_vault\.sha256/);
  });

  test("uppercase or short digest refuses", () => {
    const p = writeManifest(tmpRoot(), (m) => {
      m.programs.grave_scanner.sha256 = "E".repeat(64); // uppercase hex
      return m;
    });
    assert.throws(() => loadProvenanceManifest(p), /lowercase 64-hex/);
  });

  test("artifact path escaping the build tree refuses", () => {
    const p = writeManifest(tmpRoot(), (m) => {
      m.programs.grave_scanner.artifact = "../../etc/passwd.so";
      return m;
    });
    assert.throws(() => loadProvenanceManifest(p), /inside the build tree/);
  });

  test("manifest arch drift refuses (the invariant cannot be re-pinned)", () => {
    const p = writeManifest(tmpRoot(), (m) => {
      m.toolchain.elf = { e_machine: 247, e_flags: 3 };
      return m;
    });
    assert.throws(() => loadProvenanceManifest(p), /invariant/);
  });

  test("REQUIRED_SBPF is the v0 target", () => {
    assert.deepEqual(REQUIRED_SBPF, { arch: "v0", e_machine: 263, e_flags: 0 });
  });
});

describe("checkProvenance (offline fixture ELFs)", () => {
  test("matching digests + v0 arch + embedded IDs pass", () => {
    const root = tmpRoot();
    const scanner = buildSbfElf({ idBase58: NS3.scannerProgramId, padTo: 400 });
    const vault = buildSbfElf({ idBase58: NS3.vaultProgramId, padTo: 400 });
    writeFileSync(path.join(root, "grave_scanner.so"), scanner);
    writeFileSync(path.join(root, "grave_vault.so"), vault);
    const p = writeManifest(root, (m) => {
      m.programs.grave_scanner.sha256 = sha256(scanner);
      m.programs.grave_vault.sha256 = sha256(vault);
      return m;
    });
    const r = checkProvenance({
      manifestPath: p,
      scannerSo: path.join(root, "grave_scanner.so"),
      vaultSo: path.join(root, "grave_vault.so"),
      scannerId: NS3.scannerProgramId,
      vaultId: NS3.vaultProgramId,
    });
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 2));
    for (const id of [
      "digest-scanner",
      "arch-scanner",
      "identity-scanner",
      "digest-vault",
      "arch-vault",
      "identity-vault",
    ]) {
      assert.ok(r.checks.find((c) => c.id === id)?.ok, id);
    }
  });

  test("one flipped byte fails the digest check", () => {
    const root = tmpRoot();
    const scanner = buildSbfElf({ idBase58: NS3.scannerProgramId });
    writeFileSync(path.join(root, "grave_scanner.so"), scanner);
    const vault = buildSbfElf({ idBase58: NS3.vaultProgramId });
    writeFileSync(path.join(root, "grave_vault.so"), vault);
    const p = writeManifest(root, (m) => {
      m.programs.grave_scanner.sha256 = sha256(scanner);
      m.programs.grave_vault.sha256 = sha256(vault);
      return m;
    });
    const mutated = Buffer.from(scanner);
    mutated[70] ^= 0x01;
    writeFileSync(path.join(root, "grave_scanner.so"), mutated);
    const r = checkProvenance({
      manifestPath: p,
      scannerSo: path.join(root, "grave_scanner.so"),
      vaultSo: path.join(root, "grave_vault.so"),
      scannerId: NS3.scannerProgramId,
      vaultId: NS3.vaultProgramId,
    });
    assert.equal(r.ok, false);
    assert.match(r.checks.find((c) => c.id === "digest-scanner").detail, /sha256 MISMATCH/);
  });

  test("v3-arch ELF fails even with matching digest and identity", () => {
    const root = tmpRoot();
    const scanner = buildSbfElf({ idBase58: NS3.scannerProgramId, eMachine: 247, eFlags: 3 });
    const vault = buildSbfElf({ idBase58: NS3.vaultProgramId });
    const p = writeManifest(root, (m) => {
      m.programs.grave_scanner.sha256 = sha256(scanner);
      m.programs.grave_vault.sha256 = sha256(vault);
      return m;
    });
    writeFileSync(path.join(root, "grave_scanner.so"), scanner);
    writeFileSync(path.join(root, "grave_vault.so"), vault);
    const r = checkProvenance({
      manifestPath: p,
      scannerSo: path.join(root, "grave_scanner.so"),
      vaultSo: path.join(root, "grave_vault.so"),
      scannerId: NS3.scannerProgramId,
      vaultId: NS3.vaultProgramId,
    });
    assert.equal(r.ok, false);
    assert.match(r.checks.find((c) => c.id === "arch-scanner").detail, /architecture MISMATCH/);
  });

  test("legacy NS-2 bytes anywhere in the ELF fail the identity check", () => {
    const root = tmpRoot();
    const LEGACY = "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54";
    const scanner = buildSbfElf({
      idBase58: NS3.scannerProgramId,
      injectBytes: [{ bytes: Buffer.from(new PublicKey(LEGACY).toBytes()), alloc: false }],
    });
    const vault = buildSbfElf({ idBase58: NS3.vaultProgramId });
    const p = writeManifest(root, (m) => {
      m.programs.grave_scanner.sha256 = sha256(scanner);
      m.programs.grave_vault.sha256 = sha256(vault);
      return m;
    });
    writeFileSync(path.join(root, "grave_scanner.so"), scanner);
    writeFileSync(path.join(root, "grave_vault.so"), vault);
    const r = checkProvenance({
      manifestPath: p,
      scannerSo: path.join(root, "grave_scanner.so"),
      vaultSo: path.join(root, "grave_vault.so"),
      scannerId: NS3.scannerProgramId,
      vaultId: NS3.vaultProgramId,
    });
    assert.equal(r.ok, false);
    assert.match(r.checks.find((c) => c.id === "identity-scanner").detail, /legacy-present/);
  });

  test("missing artifact fails closed", () => {
    const p = writeManifest(tmpRoot());
    const r = checkProvenance({
      manifestPath: p,
      scannerSo: path.join(TMP, "nope.so"),
      vaultSo: path.join(TMP, "nope2.so"),
      scannerId: NS3.scannerProgramId,
      vaultId: NS3.vaultProgramId,
    });
    assert.equal(r.ok, false);
    assert.match(
      r.checks.find((c) => c.id === "artifact-scanner").detail,
      /no artifact, no deploy/,
    );
  });

  test("platform-tools tarball digest is verified against the manifest", () => {
    const root = tmpRoot();
    const tarball = Buffer.from("fake platform-tools tarball bytes");
    writeFileSync(path.join(root, "pt.tar.bz2"), tarball);
    const p = writeManifest(root, (m) => {
      m.toolchain.platform_tools.sha256 = sha256(tarball);
      return m;
    });
    const good = checkProvenance({
      manifestPath: p,
      platformToolsTarball: path.join(root, "pt.tar.bz2"),
    });
    assert.equal(good.ok, true);
    assert.match(
      good.checks.find((c) => c.id === "platform-tools").detail,
      /matches the manifest pin/,
    );
    const p2 = writeManifest(tmpRoot());
    const bad = checkProvenance({
      manifestPath: p2,
      platformToolsTarball: path.join(root, "pt.tar.bz2"),
    });
    assert.equal(bad.ok, false);
    assert.match(bad.checks.find((c) => c.id === "platform-tools").detail, /sha256 MISMATCH/);
  });

  test("mixed input (wrong tarball + good ELFs) fails as a whole", () => {
    const root = tmpRoot();
    const scanner = buildSbfElf({ idBase58: NS3.scannerProgramId });
    const vault = buildSbfElf({ idBase58: NS3.vaultProgramId });
    const p = writeManifest(root, (m) => {
      m.programs.grave_scanner.sha256 = sha256(scanner);
      m.programs.grave_vault.sha256 = sha256(vault);
      return m;
    });
    writeFileSync(path.join(root, "grave_scanner.so"), scanner);
    writeFileSync(path.join(root, "grave_vault.so"), vault);
    writeFileSync(path.join(root, "evil.tar.bz2"), "evil toolchain bytes");
    const r = checkProvenance({
      manifestPath: p,
      scannerSo: path.join(root, "grave_scanner.so"),
      vaultSo: path.join(root, "grave_vault.so"),
      scannerId: NS3.scannerProgramId,
      vaultId: NS3.vaultProgramId,
      platformToolsTarball: path.join(root, "evil.tar.bz2"),
    });
    assert.equal(r.ok, false);
    assert.equal(r.checks.filter((c) => c.ok).length >= 6, true);
    assert.equal(r.checks.find((c) => c.id === "platform-tools").ok, false);
  });
});
