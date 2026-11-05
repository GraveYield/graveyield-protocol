// pin_elfs_gate.test.mjs — W1 regression: the pin step's approved-digest gate.
//
// W1 §7 makes the rehearsal pin LOCALLY BUILT ELFs only after they pass the
// shared fail-closed provenance gate (provenance.manifest.json: approved
// sha256 digests + SBPF v0 + structural NS-3 identity). These tests pin the
// refusal behavior so the gate cannot be silently weakened:
//   1. fake (non-ELF) --local-so bytes → exit 1, "REFUSING to pin", no pin
//      table written, no fixture fetch attempted (offline-safe: the gate
//      runs BEFORE the fixture fetcher);
//   2. a REAL SBF-shaped ELF whose bytes are not the approved digests →
//      exit 1 with a digest MISMATCH (the identity check alone must not
//      satisfy the gate);
//   3. no --local-so and no --rpc → usage exit 2 (the devnet-dump path is
//      no longer the default and requires an explicit --rpc).
// All cases are subprocess runs of the CLI script, mirroring how the
// orchestrator invokes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PIN_ELFS = join(HERE, "..", "lifecycle_rehearsal", "pin_elfs.mjs");

// A minimal SBF-shaped buffer: valid ELF64 LSB header with e_machine 263 /
// e_flags 0, then junk. It passes the header acceptance but NOT the digest
// pin — exactly the case the gate must refuse.
function fakeSbfElf() {
  const buf = Buffer.alloc(512, 0);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46; // \x7fELF
  buf[4] = 2; // EI_CLASS = ELFCLASS64
  buf[5] = 1; // EI_DATA = LSB
  buf.writeUInt16LE(263, 18); // e_machine = EM_SBF
  buf.writeUInt32LE(0, 36); // e_flags = 0 (SBPF v0)
  return buf;
}

function runPinElfFs(args) {
  return spawnSync(process.execPath, [PIN_ELFS, ...args], { encoding: "utf8" });
}

test("pin_elfs: fake --local-so bytes are refused (exit 1, no pin table, no fetch)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-pin-gate-"));
  try {
    const scan = join(dir, "grave_scanner.so");
    const vault = join(dir, "grave_vault.so");
    writeFileSync(scan, "not an elf");
    writeFileSync(vault, "not an elf");
    const artifacts = join(dir, "artifacts");
    const fixtures = join(dir, "fixtures");
    const r = runPinElfFs([
      "--artifacts",
      artifacts,
      "--fixtures",
      fixtures,
      "--local-so",
      `${scan} ${vault}`,
    ]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /REFUSING to pin/);
    assert.match(r.stderr, /provenance\.manifest\.json/);
    // The refusal happens BEFORE the fixture fetch and BEFORE any pin table.
    assert.equal(existsSync(join(artifacts, "sha256.txt")), false, "pin table must not exist");
    assert.equal(existsSync(join(fixtures, "manifest.json")), false, "fixture fetch must not run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pin_elfs: an SBF-shaped ELF with the WRONG digest is refused with a digest mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-pin-gate-"));
  try {
    const scan = join(dir, "grave_scanner.so");
    const vault = join(dir, "grave_vault.so");
    writeFileSync(scan, fakeSbfElf());
    writeFileSync(vault, fakeSbfElf());
    const r = runPinElfFs([
      "--artifacts",
      join(dir, "artifacts"),
      "--fixtures",
      join(dir, "fixtures"),
      "--local-so",
      `${scan} ${vault}`,
    ]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
    // Both layers must fire: the digest pin AND (for real ELFs) the
    // structural identity check.
    assert.match(r.stdout, /digest-scanner.*MISMATCH|sha256 MISMATCH/);
    assert.match(r.stderr, /REFUSING to pin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pin_elfs: without --local-so the devnet-dump path needs an explicit --rpc (usage exit 2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-pin-gate-"));
  try {
    const r = runPinElfFs([
      "--artifacts",
      join(dir, "artifacts"),
      "--fixtures",
      join(dir, "fixtures"),
    ]);
    assert.equal(r.status, 2, `expected usage exit 2, got ${r.status}`);
    assert.match(r.stderr, /missing --rpc/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pin_elfs: --local-so with the wrong arity is a usage error (exit 2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-pin-gate-"));
  try {
    const one = join(dir, "only_scanner.so");
    writeFileSync(one, "x");
    const r = runPinElfFs([
      "--artifacts",
      join(dir, "artifacts"),
      "--fixtures",
      join(dir, "fixtures"),
      "--local-so",
      one,
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /exactly two paths/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
