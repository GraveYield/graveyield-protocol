// SPDX-License-Identifier: Apache-2.0
//
// Finding A regression tests — a failed `solana program dump` can never
// leave a stale (or partial, or foreign) binary behind that the harness
// accepts. Covers: destination isolation, subprocess result checking
// (spawn error / signal / exit status), SBF ELF header validation, size
// gates, and byte-identity provenance against fresh on-chain program data.
//
// The on-chain cross-check here uses the loader-v2 shape (ELF stored
// directly in the program account) so no CLI/RPC is needed offline; the
// loader-v3 ProgramData path is exercised live by every rehearsal run
// (the devnet scanner/vault programs are upgradeable).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
  dumpAndVerifyElf,
  validateSbfElfBytes,
  matchOnChainProgramData,
} from "../lifecycle_rehearsal/elf_dump.mjs";

function sbfElf(size = 64) {
  const b = Buffer.alloc(size, 0);
  b[0] = 0x7f;
  b[1] = 0x45; // 'E'
  b[2] = 0x4c; // 'L'
  b[3] = 0x46; // 'F'
  b[4] = 2; // 64-bit
  b[5] = 1; // LSB
  b.writeUInt16LE(247, 18); // e_machine = EM_BPF/EM_SBF
  return b;
}

const BPF_LOADER_V2 = "BPFLoader21111111111111111111111111111111111111";

function tmpFile(name) {
  const dir = mkdtempSync(join(tmpdir(), "elf-dump-test-"));
  return { dir, path: join(dir, name) };
}

describe("validateSbfElfBytes", () => {
  test("accepts a real SBF ELF header (EM_BPF 247)", () => {
    assert.equal(validateSbfElfBytes(sbfElf(), "x"), true);
  });
  test("accepts EM_SBF 263 (SBF-spec value emitted by newer toolchains — real devnet dumps)", () => {
    const b = sbfElf();
    b.writeUInt16LE(263, 18);
    assert.equal(validateSbfElfBytes(b, "x"), true);
  });
  test("rejects non-ELF bytes", () => {
    assert.throws(
      () => validateSbfElfBytes(Buffer.from("definitely not an elf"), "x"),
      /ELF magic/,
    );
  });
  test("rejects wrong e_machine", () => {
    const b = sbfElf();
    b.writeUInt16LE(3, 18); // EM_386
    assert.throws(() => validateSbfElfBytes(b, "x"), /e_machine/);
  });
  test("rejects tiny buffers", () => {
    assert.throws(() => validateSbfElfBytes(Buffer.from([0x7f, 0x45]), "x"), /too small/);
  });
});

describe("matchOnChainProgramData", () => {
  test("loader-v2: ELF equals the whole program account", () => {
    const elf = sbfElf(48);
    const m = matchOnChainProgramData(elf, Buffer.from(elf));
    assert.equal(m.match, true);
    assert.equal(m.headerLen, 0);
  });
  test("loader-v3: ELF equals programdata payload after a 48 B header", () => {
    const elf = sbfElf(48);
    const acct = Buffer.concat([Buffer.alloc(48, 0xab), Buffer.from(elf)]);
    const m = matchOnChainProgramData(elf, acct);
    assert.equal(m.match, true);
    assert.equal(m.headerLen, 48);
  });
  test("loader-v3: 16 B header variant", () => {
    const elf = sbfElf(48);
    const acct = Buffer.concat([Buffer.alloc(16, 0xcd), Buffer.from(elf)]);
    const m = matchOnChainProgramData(elf, acct);
    assert.equal(m.match, true);
    assert.equal(m.headerLen, 16);
  });
  test("loader-v3: 45 B packed header (current agave layout — verified against live devnet ProgramData)", () => {
    const elf = sbfElf(48);
    const acct = Buffer.concat([Buffer.alloc(45, 0x11), Buffer.from(elf)]);
    const m = matchOnChainProgramData(elf, acct);
    assert.equal(m.match, true);
    assert.equal(m.headerLen, 45);
  });
  test("loader-v3: 13 B packed header (authority None)", () => {
    const elf = sbfElf(48);
    const acct = Buffer.concat([Buffer.alloc(13, 0x22), Buffer.from(elf)]);
    const m = matchOnChainProgramData(elf, acct);
    assert.equal(m.match, true);
    assert.equal(m.headerLen, 13);
  });
  test("dump NOT running to the exact account end → no match (extra trailing bytes)", () => {
    const elf = sbfElf(48);
    const acct = Buffer.concat([Buffer.alloc(48, 0xab), Buffer.from(elf), Buffer.alloc(7, 0x00)]);
    assert.equal(matchOnChainProgramData(elf, acct).match, false);
  });
  test("same length, different bytes → no match", () => {
    const elf = sbfElf(48);
    const other = sbfElf(48);
    other[32] ^= 0xff;
    assert.equal(matchOnChainProgramData(elf, other).match, false);
  });
  test("no length relationship → no match", () => {
    assert.equal(matchOnChainProgramData(sbfElf(64), Buffer.alloc(100, 1)).match, false);
  });
});

describe("dumpAndVerifyElf", () => {
  test("FAILED DUMP WITH STALE PRE-EXISTING OUTPUT: fails and removes the stale artifact", async () => {
    const { dir, path } = tmpFile("grave_scanner.so");
    // A stale artifact from a previous run that would pass the old
    // existence+size check (a VALID SBF ELF header, ≥ minBytes here).
    writeFileSync(path, sbfElf(120));
    const runDump = () => ({
      error: null,
      signal: null,
      status: 1,
      stdout: null,
      stderr: Buffer.from("RPC error: rate limited"),
    });
    await assert.rejects(
      dumpAndVerifyElf({
        programId: "Prog1111",
        outPath: path,
        rpcUrl: "http://x",
        minBytes: 100,
        runDump,
        fetchAccountData: async () => {
          throw new Error("should not be called");
        },
      }),
      /exit 1.*rate limited/s,
    );
    // The stale artifact is gone — it can never be accepted.
    assert.equal(existsSync(path), false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("STALE ARTIFACT SMALLER THAN minBytes would also be rejected", async () => {
    const { dir, path } = tmpFile("grave_vault.so");
    writeFileSync(path, sbfElf(50));
    const runDump = () => ({ error: null, signal: null, status: 1, stdout: null, stderr: null });
    await assert.rejects(
      dumpAndVerifyElf({
        programId: "Prog1111",
        outPath: path,
        rpcUrl: "http://x",
        minBytes: 100,
        runDump,
      }),
      /exit 1/,
    );
    assert.equal(existsSync(path), false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("spawn error (e.g. solana missing) → throws", async () => {
    const { dir, path } = tmpFile("x.so");
    await assert.rejects(
      dumpAndVerifyElf({
        programId: "P",
        outPath: path,
        rpcUrl: "http://x",
        minBytes: 10,
        runDump: () => ({ error: "spawn ENOENT", signal: null, status: null }),
      }),
      /spawn error: spawn ENOENT/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("terminated by signal → throws", async () => {
    const { dir, path } = tmpFile("x.so");
    await assert.rejects(
      dumpAndVerifyElf({
        programId: "P",
        outPath: path,
        rpcUrl: "http://x",
        minBytes: 10,
        runDump: () => ({ error: null, signal: "SIGKILL", status: null }),
      }),
      /SIGKILL/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("exit 0 but junk output → throws (ELF magic)", async () => {
    const { dir, path } = tmpFile("x.so");
    const runDump = ({ outPath }) => {
      writeFileSync(outPath, Buffer.from("cargo says ok but this is not an elf"));
      return { error: null, signal: null, status: 0, stdout: null, stderr: null };
    };
    await assert.rejects(
      dumpAndVerifyElf({
        programId: "P",
        outPath: path,
        rpcUrl: "http://x",
        minBytes: 10,
        runDump,
        fetchAccountData: async () => ({ owner: BPF_LOADER_V2, data: Buffer.alloc(0) }),
      }),
      /ELF magic/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty output → throws", async () => {
    const { dir, path } = tmpFile("x.so");
    const runDump = ({ outPath }) => {
      writeFileSync(outPath, Buffer.alloc(0));
      return { error: null, signal: null, status: 0, stdout: null, stderr: null };
    };
    await assert.rejects(
      dumpAndVerifyElf({
        programId: "P",
        outPath: path,
        rpcUrl: "http://x",
        minBytes: 10,
        runDump,
      }),
      /empty/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("output below minBytes → throws", async () => {
    const { dir, path } = tmpFile("x.so");
    const runDump = ({ outPath }) => {
      writeFileSync(outPath, sbfElf(30));
      return { error: null, signal: null, status: 0, stdout: null, stderr: null };
    };
    await assert.rejects(
      dumpAndVerifyElf({
        programId: "P",
        outPath: path,
        rpcUrl: "http://x",
        minBytes: 100,
        runDump,
      }),
      /minimum 100 B/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("HAPPY PATH: valid dump byte-identical to on-chain data → verified pin with provenance", async () => {
    const { dir, path } = tmpFile("grave_scanner.so");
    const elf = sbfElf(300);
    const runDump = ({ outPath }) => {
      writeFileSync(outPath, elf);
      return { error: null, signal: null, status: 0, stdout: null, stderr: null };
    };
    const fetchAccountData = async () => ({ owner: BPF_LOADER_V2, data: Buffer.from(elf) });
    const pin = await dumpAndVerifyElf({
      programId: "ScannerID",
      outPath: path,
      rpcUrl: "https://api.devnet.solana.com",
      minBytes: 100,
      runDump,
      fetchAccountData,
    });
    assert.equal(pin.on_chain_match, true);
    assert.equal(pin.bytes, 300);
    assert.equal(pin.sha256, createHash("sha256").update(elf).digest("hex"));
    assert.match(pin.provenance, /byte-identical to on-chain program data/);
    assert.equal(readFileSync(path).equals(elf), true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("byte-IDENTITY failure: same length, different on-chain bytes → refuses to pin", async () => {
    const { dir, path } = tmpFile("x.so");
    const elf = sbfElf(300);
    const onChain = sbfElf(300);
    onChain[40] ^= 0xff; // one flipped byte
    const runDump = ({ outPath }) => {
      writeFileSync(outPath, elf);
      return { error: null, signal: null, status: 0, stdout: null, stderr: null };
    };
    await assert.rejects(
      dumpAndVerifyElf({
        programId: "P",
        outPath: path,
        rpcUrl: "http://x",
        minBytes: 100,
        runDump,
        fetchAccountData: async () => ({ owner: BPF_LOADER_V2, data: onChain }),
      }),
      /NOT byte-identical.*refusing to pin/s,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing on-chain account → provenance cannot be established → throws", async () => {
    const { dir, path } = tmpFile("x.so");
    const runDump = ({ outPath }) => {
      writeFileSync(outPath, sbfElf(300));
      return { error: null, signal: null, status: 0, stdout: null, stderr: null };
    };
    await assert.rejects(
      dumpAndVerifyElf({
        programId: "P",
        outPath: path,
        rpcUrl: "http://x",
        minBytes: 100,
        runDump,
        fetchAccountData: async () => {
          throw new Error("on-chain account P not found — provenance cannot be established");
        },
      }),
      /provenance cannot be established/,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
