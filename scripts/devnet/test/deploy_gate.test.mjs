// SPDX-License-Identifier: Apache-2.0
//
// deploy_devnet.sh provenance-gate integration battery.
//
// Drives the REAL deploy script in a throwaway clone of this repository
// with mocked `solana` / `solana-keygen` / `cargo` / `cargo-build-sbf`
// shims on PATH and synthetic ELF fixtures whose digests are written into
// the CLONE's copy of the shared provenance manifest. No keypair material
// exists anywhere (the shims ignore keypair file contents), nothing ever
// touches a public cluster (the mock `solana program deploy` only appends
// to a log file), and no SBF toolchain is needed.
//
// What the suite pins (assignment test list ≥13):
//   ✔ correct digests + identities → deploy runs, AFTER the gate passed
//   ✖ scanner / vault wrong digest → REFUSED, zero deploy invocations
//   ✖ missing ELF → REFUSED
//   ✖ malformed ELF → REFUSED
//   ✖ wrong/legacy embedded program ID (digest crafted to match) → REFUSED
//   ✖ legacy NS-2 ID bytes in the ELF → REFUSED
//   ✖ wrong arch (v3-family header, digest crafted to match) → REFUSED
//   ✖ --skip-build cannot bypass the digest check
//   ✖ build path cannot bypass either (tampered build output refused)
//   ✖ build path with pinned platform-tools absent → refused BEFORE build
//   ✖ resume/retry: tampered target/deploy on re-run → REFUSED
//   ✔ --build-only: verifies + never deploys; tampered build-only → REFUSED
//   ✖ node absent → gate refuses (fail-closed) on every path
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { NS3 } from "../ns3_identities.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const DEPLOY = "scripts/devnet/deploy_devnet.sh";

// ------------------------------------------------------------ ELF fixtures

const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

function idBytes(base58) {
  return Buffer.from(new PublicKey(base58).toBytes());
}

function buildElf64({ ids = [], eMachine = 263, eFlags = 0 } = {}) {
  const sections = [
    { name: "", type: 0, flags: 0, data: Buffer.alloc(0) },
    { name: ".text", type: 1, flags: SHF_ALLOC | SHF_EXECINSTR, data: Buffer.alloc(96, 0x90) },
    { name: ".rodata", type: 1, flags: SHF_ALLOC, data: Buffer.alloc(64, 0x42) },
    { name: ".shstrtab", type: 3, flags: 0, data: null },
  ];
  for (const id of ids) sections[2].data = Buffer.concat([sections[2].data, idBytes(id)]);
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
  let cursor = 64;
  for (const s of sections) {
    s.offset = cursor;
    cursor += s.data.length;
  }
  const eShoff = cursor;
  const buf = Buffer.alloc(eShoff + sections.length * 64);
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
  buf.writeUInt16LE(sections.length, 60);
  buf.writeUInt16LE(sections.length - 1, 62);
  let at = 64;
  for (const s of sections) {
    s.data.copy(buf, at);
    at += s.data.length;
  }
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const base = eShoff + i * 64;
    buf.writeUInt32LE(nameOffs.get(s.name) ?? 0, base);
    buf.writeUInt32LE(s.type, base + 4);
    buf.writeBigUInt64LE(BigInt(s.flags), base + 8);
    buf.writeBigUInt64LE(BigInt(s.offset), base + 24);
    buf.writeBigUInt64LE(BigInt(s.data.length), base + 32);
  }
  return buf;
}

const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
const NS2_SCANNER = "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54";

// ------------------------------------------------------------ harness

function writeMockBin(dir) {
  mkdirSync(dir, { recursive: true });
  const shim = (name, body) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    execFileSync("chmod", ["+x", p]);
  };
  shim(
    "solana-keygen",
    `case "$*" in
  *scanner*) echo "\${GY_SCANNER_PK:?}" ;;
  *vault*) echo "\${GY_VAULT_PK:?}" ;;
  *) echo "\${GY_OTHER_PK:-11111111111111111111111111111111}" ;;
esac`,
  );
  shim(
    "solana",
    `log="\${GY_MOCK_LOG:?}"
case "$*" in
  *balance*) echo "\${GY_MOCK_BALANCE:-10000000000}" ;;
  *"program deploy"*) echo "deploy" >> "$log"; echo '{"programId":"mocked"}' ;;
  *cluster-version*) echo "agave 3.0.10 (mock)" ;;
  *) echo "mock-solana: unhandled invocation: $*" >&2; exit 1 ;;
esac`,
  );
  shim(
    "cargo",
    `[ "$1" = "build-sbf" ] && { shift; exec cargo-build-sbf "$@"; }
echo "mock-cargo: unhandled: $*" >&2
exit 1`,
  );
  shim(
    "cargo-build-sbf",
    `log="\${GY_MOCK_LOG:?}"
echo "sbf-build" >> "$log"
out=""
prev=""
for a in "$@"; do
  if [ "\$prev" = "--sbf-out-dir" ]; then out="\$a"; fi
  prev="\$a"
done
[ -n "\$out" ] || { echo "mock cargo-build-sbf: no --sbf-out-dir" >&2; exit 1; }
cp "\${GY_MOCK_SBF_SOURCE:?}"/*.so "\$out"/`,
  );
  return dir;
}

/** A throwaway clone of the WORKING TREE (git clone would only carry the
 *  committed state — the harness must test the code as it stands on disk).
 *  Tracked files only (no node_modules, no target) with node_modules
 *  symlinked from the real workspace so the checker resolves
 *  @solana/web3.js. */
function cloneRepo() {
  const base = mkdtempSync(join(tmpdir(), "gy-deploy-gate-"));
  const clone = join(base, "clone");
  mkdirSync(clone, { recursive: true });
  // `git ls-files` + tar: copies tracked paths AS THEY ARE ON DISK
  // (uncommitted edits included), which is exactly what CI would check out
  // plus the working-tree state under test.
  const tracked = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], { maxBuffer: 1 << 26 });
  const tgz = execFileSync("tar", ["--null", "-T", "-", "-cf", "-"], {
    input: tracked,
    cwd: REPO_ROOT,
    maxBuffer: 1 << 28,
    encoding: "buffer",
  });
  execFileSync("tar", ["-xf", "-", "-C", clone], { input: tgz });
  // Overlay the working-tree scripts/devnet (new/untracked files included),
  // then point node_modules at the REAL workspace store: the overlay copy
  // carries pnpm's inner symlinks, which resolve outside the clone.
  // NOTE: the "/." suffix is load-bearing (copy CONTENTS, do not nest) and
  // must be a raw string — path.join() would normalize it away.
  execFileSync("cp", ["-a", `${REPO_ROOT}/scripts/devnet/.`, join(clone, "scripts", "devnet")]);
  rmSync(join(clone, "scripts", "devnet", "node_modules"), { recursive: true, force: true });
  symlinkSync(
    join(REPO_ROOT, "scripts", "devnet", "node_modules"),
    join(clone, "scripts", "devnet", "node_modules"),
  );
  return { base, clone };
}

/** Manifest for the CLONE: schema-valid, program IDs canonical, digests =
 *  the fixture buffers (or explicit overrides for negative cases). */
function writeCloneManifest(clone, { scannerSha, vaultSha }) {
  const manifest = {
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
        sha256: scannerSha,
      },
      vault: { artifact: "grave_vault.so", programId: NS3.vaultProgramId, sha256: vaultSha },
    },
  };
  writeFileSync(
    join(clone, "scripts", "devnet", "provenance.manifest.json"),
    JSON.stringify(manifest),
  );
}

function setupWorkspace({ scannerBuf, vaultBuf, scannerSha, vaultSha } = {}) {
  const { base, clone } = cloneRepo();
  const mockBin = writeMockBin(join(base, "bin"));
  const log = join(base, "mock.log");
  writeFileSync(log, "");
  const sbfSource = join(base, "sbf-source");
  mkdirSync(sbfSource, { recursive: true });
  if (scannerBuf) writeFileSync(join(sbfSource, "grave_scanner.so"), scannerBuf);
  if (vaultBuf) writeFileSync(join(sbfSource, "grave_vault.so"), vaultBuf);
  const toolsDir = join(base, "platform-tools-v1.54");
  mkdirSync(toolsDir, { recursive: true });
  // keypair dummies — shims never read contents; no key material exists here
  for (const kp of ["scanner-kp.json", "vault-kp.json", "deployer-kp.json"]) {
    writeFileSync(join(base, kp), "[1,2,3]");
  }
  if (scannerBuf) {
    mkdirSync(join(clone, "target", "deploy"), { recursive: true });
    writeFileSync(join(clone, "target", "deploy", "grave_scanner.so"), scannerBuf);
  }
  if (vaultBuf) {
    mkdirSync(join(clone, "target", "deploy"), { recursive: true });
    writeFileSync(join(clone, "target", "deploy", "grave_vault.so"), vaultBuf);
  }
  writeCloneManifest(clone, {
    scannerSha: scannerSha ?? (scannerBuf ? sha256Hex(scannerBuf) : "b".repeat(64)),
    vaultSha: vaultSha ?? (vaultBuf ? sha256Hex(vaultBuf) : "c".repeat(64)),
  });
  const env = {
    ...process.env,
    PATH: `${mockBin}:${process.env.PATH}`,
    GY_MOCK_LOG: log,
    GY_MOCK_SBF_SOURCE: sbfSource,
    GY_SCANNER_PK: NS3.scannerProgramId,
    GY_VAULT_PK: NS3.vaultProgramId,
    GRAVEYIELD_PLATFORM_TOOLS_DIR: toolsDir,
  };
  return {
    base,
    clone,
    log,
    env,
    deployArgs: (extra) => [
      join(clone, DEPLOY),
      "--url",
      "http://127.0.0.1:8899",
      "--scanner-keypair",
      join(base, "scanner-kp.json"),
      "--vault-keypair",
      join(base, "vault-kp.json"),
      "--deployer",
      join(base, "deployer-kp.json"),
      ...extra,
    ],
  };
}

function run(env, args) {
  // Absolute bash path: the child env may deliberately have a stripped PATH
  // (the node-absent cases) — Node resolves the executable via the CHILD's
  // PATH on Linux, so a bare "bash" would ENOENT there.
  const r = spawnSync("/bin/bash", args, { env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function deployCount(logPath) {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l === "deploy").length;
}

/** A PATH that has the coreutils the deploy script needs but NO node:
 *  the "node absent" scenarios must reach the gate's refusal, not die on
 *  a missing `dirname`/`tr`. Builds a directory of copies of the required
 *  system binaries (node itself is deliberately NOT copied). */
function coreutilsOnlyBin(base) {
  const dir = join(base, "coreutils");
  mkdirSync(dir, { recursive: true });
  for (const tool of ["dirname", "tr", "ls", "cp", "mkdir", "cat", "sha256sum"]) {
    execFileSync("cp", ["/usr/bin/" + tool, join(dir, tool)]);
  }
  return dir;
}

const GOOD_SCANNER = buildElf64({ ids: [NS3.scannerProgramId] });
const GOOD_VAULT = buildElf64({ ids: [NS3.vaultProgramId] });

// ------------------------------------------------------------ tests

describe("deploy_devnet.sh — fail-closed provenance gate on every deploy-reaching path", () => {
  test("correct digests + identities: build path deploys BOTH programs, only AFTER the gate passed", () => {
    const ws = setupWorkspace({ scannerBuf: GOOD_SCANNER, vaultBuf: GOOD_VAULT });
    const r = run(ws.env, ws.deployArgs([]));
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /PROVENANCE VERIFIED/);
    assert.equal(deployCount(ws.log), 2, "scanner + vault deploy must run exactly once each");
    const logLines = readFileSync(ws.log, "utf8").split("\n").filter(Boolean);
    assert.equal(logLines[0], "sbf-build", "build must happen first");
    assert.equal(
      logLines[logLines.length - 1],
      "deploy",
      "the deploy invocation must be the LAST mocked action (gate before deploy)",
    );
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("--skip-build with approved bytes deploys (CI-artifact path works)", () => {
    const ws = setupWorkspace({ scannerBuf: GOOD_SCANNER, vaultBuf: GOOD_VAULT });
    const r = run(ws.env, ws.deployArgs(["--skip-build"]));
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /PROVENANCE VERIFIED/);
    assert.equal(deployCount(ws.log), 2);
    assert.doesNotMatch(r.stdout, /sbf-build/);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("--skip-build CANNOT bypass the digest check: tampered scanner ELF refuses with zero deploys", () => {
    const tampered = Buffer.from(GOOD_SCANNER);
    tampered[70] ^= 0x01;
    // Manifest keeps the ORIGINAL approved digest — the on-disk bytes changed.
    const ws = setupWorkspace({
      scannerBuf: tampered,
      vaultBuf: GOOD_VAULT,
      scannerSha: sha256Hex(GOOD_SCANNER),
    });
    const r = run(ws.env, ws.deployArgs(["--skip-build"]));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /PROVENANCE GATE REFUSED/);
    assert.match(r.stderr, /digest/);
    assert.equal(
      deployCount(ws.log),
      0,
      "no deployment transaction may run when the digest gate fails",
    );
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("tampered vault ELF → refused, zero deploys", () => {
    const tampered = Buffer.from(GOOD_VAULT);
    tampered[70] ^= 0x01;
    const ws = setupWorkspace({
      scannerBuf: GOOD_SCANNER,
      vaultBuf: tampered,
      vaultSha: sha256Hex(GOOD_VAULT),
    });
    const r = run(ws.env, ws.deployArgs(["--skip-build"]));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /vault:digest/);
    assert.equal(deployCount(ws.log), 0);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("missing scanner ELF → refused, zero deploys", () => {
    const ws = setupWorkspace({ scannerBuf: null, vaultBuf: GOOD_VAULT });
    const r = run(ws.env, ws.deployArgs(["--skip-build"]));
    assert.notEqual(r.status, 0);
    assert.equal(deployCount(ws.log), 0);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("malformed scanner ELF (plain text, digest matches the bytes) → identity refuses", () => {
    const garbage = Buffer.from("an ELF that is actually a README in disguise".repeat(4));
    const ws = setupWorkspace({ scannerBuf: garbage, vaultBuf: GOOD_VAULT });
    const r = run(ws.env, ws.deployArgs(["--skip-build"]));
    assert.notEqual(r.status, 0);
    assert.equal(deployCount(ws.log), 0);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("wrong embedded program ID (NS-2 scanner) with digest crafted to match → identity refuses (digest alone is not acceptance)", () => {
    const wrongId = buildElf64({ ids: [NS2_SCANNER] });
    const ws = setupWorkspace({ scannerBuf: wrongId, vaultBuf: GOOD_VAULT });
    const r = run(ws.env, ws.deployArgs(["--skip-build"]));
    assert.notEqual(r.status, 0);
    assert.equal(deployCount(ws.log), 0);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("legacy NS-2 ID bytes anywhere in the ELF → legacy canary refuses", () => {
    const polluted = Buffer.concat([
      buildElf64({ ids: [NS3.scannerProgramId] }),
      idBytes(NS2_SCANNER),
    ]);
    const ws = setupWorkspace({ scannerBuf: polluted, vaultBuf: GOOD_VAULT });
    const r = run(ws.env, ws.deployArgs(["--skip-build"]));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /legacy/);
    assert.equal(deployCount(ws.log), 0);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("v3-family ELF header (anchor 1.2.2 default) with digest crafted to match → arch check refuses", () => {
    const v3 = buildElf64({ ids: [NS3.scannerProgramId], eMachine: 247, eFlags: 3 });
    const ws = setupWorkspace({ scannerBuf: v3, vaultBuf: GOOD_VAULT });
    const r = run(ws.env, ws.deployArgs(["--skip-build"]));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /arch/);
    assert.equal(deployCount(ws.log), 0);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("build path cannot bypass either: tampered BUILD OUTPUT (mock sbf emits tampered bytes) → refused, zero deploys", () => {
    const tampered = Buffer.from(GOOD_SCANNER);
    tampered[70] ^= 0x02;
    const ws = setupWorkspace({
      scannerBuf: tampered,
      vaultBuf: GOOD_VAULT,
      scannerSha: sha256Hex(GOOD_SCANNER),
    });
    const r = run(ws.env, ws.deployArgs([]));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /PROVENANCE GATE REFUSED/);
    assert.equal(deployCount(ws.log), 0);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("build path with the pinned platform-tools directory ABSENT → refused BEFORE any build or deploy", () => {
    const ws = setupWorkspace({ scannerBuf: GOOD_SCANNER, vaultBuf: GOOD_VAULT });
    ws.env.GRAVEYIELD_PLATFORM_TOOLS_DIR = join(ws.base, "does-not-exist");
    const r = run(ws.env, ws.deployArgs([]));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /platform-tools v1\.54 not found/);
    assert.doesNotMatch(
      readFileSync(ws.log, "utf8"),
      /sbf-build/,
      "no build may run without the pinned toolchain",
    );
    assert.equal(deployCount(ws.log), 0);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("resume/retry path: re-run after a FAILED deploy picks up tampered target/deploy → REFUSED", () => {
    const ws = setupWorkspace({ scannerBuf: GOOD_SCANNER, vaultBuf: GOOD_VAULT });
    const first = run(ws.env, ws.deployArgs(["--skip-build"]));
    assert.equal(first.status, 0);
    const soPath = join(ws.clone, "target", "deploy", "grave_scanner.so");
    const bytes = Buffer.from(readFileSync(soPath));
    bytes[70] ^= 0x04;
    writeFileSync(soPath, bytes);
    const second = run(ws.env, ws.deployArgs(["--skip-build"]));
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /PROVENANCE GATE REFUSED/);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("--build-only verifies provenance and NEVER deploys (repository preparation path)", () => {
    const ws = setupWorkspace({ scannerBuf: GOOD_SCANNER, vaultBuf: GOOD_VAULT });
    const r = run(ws.env, [join(ws.clone, DEPLOY), "--build-only"]);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /PROVENANCE VERIFIED/);
    assert.match(r.stdout, /build-only complete/);
    assert.equal(deployCount(ws.log), 0, "build-only must not submit anything");
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("--build-only with tampered build output → REFUSED (the old soft warning is gone)", () => {
    const tampered = Buffer.from(GOOD_VAULT);
    tampered[70] ^= 0x08;
    const ws = setupWorkspace({
      scannerBuf: GOOD_SCANNER,
      vaultBuf: tampered,
      vaultSha: sha256Hex(GOOD_VAULT),
    });
    const r = run(ws.env, [join(ws.clone, DEPLOY), "--build-only"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /PROVENANCE GATE REFUSED/);
    assert.equal(deployCount(ws.log), 0);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("node ABSENT on the build-only path → the gate refuses (fail-closed, was a soft warning before)", () => {
    const { base, clone } = cloneRepo();
    const mockBin = writeMockBin(join(base, "bin"));
    const log = join(base, "mock.log");
    writeFileSync(log, "");
    const sbfSource = join(base, "sbf-source");
    mkdirSync(sbfSource, { recursive: true });
    writeFileSync(join(sbfSource, "grave_scanner.so"), GOOD_SCANNER);
    writeFileSync(join(sbfSource, "grave_vault.so"), GOOD_VAULT);
    const toolsDir = join(base, "pt");
    mkdirSync(toolsDir, { recursive: true });
    // PATH WITHOUT node but WITH coreutils: the script must reach the
    // gate's refusal, not die earlier on a missing `dirname`.
    const env = {
      ...process.env,
      PATH: `${mockBin}:${coreutilsOnlyBin(base)}`,
      GY_MOCK_LOG: log,
      GY_MOCK_SBF_SOURCE: sbfSource,
      GRAVEYIELD_PLATFORM_TOOLS_DIR: toolsDir,
    };
    const r = run(env, [join(clone, DEPLOY), "--build-only"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /REFUSING: node is not on PATH/);
    assert.doesNotMatch(readFileSync(log, "utf8"), /sbf-build/);
    rmSync(base, { recursive: true, force: true });
  });

  test("node ABSENT on the main path (--skip-build) → the gate refuses, zero deploys", () => {
    const { base, clone } = cloneRepo();
    const mockBin = writeMockBin(join(base, "bin"));
    const log = join(base, "mock.log");
    writeFileSync(log, "");
    const toolsDir = join(base, "pt");
    mkdirSync(toolsDir, { recursive: true });
    mkdirSync(join(clone, "target", "deploy"), { recursive: true });
    writeFileSync(join(clone, "target", "deploy", "grave_scanner.so"), GOOD_SCANNER);
    writeFileSync(join(clone, "target", "deploy", "grave_vault.so"), GOOD_VAULT);
    for (const kp of ["scanner-kp.json", "vault-kp.json", "deployer-kp.json"]) {
      writeFileSync(join(base, kp), "[1,2,3]");
    }
    writeCloneManifest(clone, {
      scannerSha: sha256Hex(GOOD_SCANNER),
      vaultSha: sha256Hex(GOOD_VAULT),
    });
    const env = {
      ...process.env,
      PATH: `${mockBin}:${coreutilsOnlyBin(base)}`,
      GY_MOCK_LOG: log,
      GY_SCANNER_PK: NS3.scannerProgramId,
      GY_VAULT_PK: NS3.vaultProgramId,
      GRAVEYIELD_PLATFORM_TOOLS_DIR: toolsDir,
    };
    const args = [
      join(clone, DEPLOY),
      "--url",
      "http://127.0.0.1:8899",
      "--scanner-keypair",
      join(base, "scanner-kp.json"),
      "--vault-keypair",
      join(base, "vault-kp.json"),
      "--deployer",
      join(base, "deployer-kp.json"),
      "--skip-build",
    ];
    const r = run(env, args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /REFUSING: node is not on PATH/);
    assert.equal(deployCount(log), 0);
    rmSync(base, { recursive: true, force: true });
  });

  test("funding gate still enforced: sub-6-SOL deployer refuses before any deploy", () => {
    const ws = setupWorkspace({ scannerBuf: GOOD_SCANNER, vaultBuf: GOOD_VAULT });
    const r = run({ ...ws.env, GY_MOCK_BALANCE: "5000000000" }, ws.deployArgs(["--skip-build"]));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /deployer needs >= 6 SOL/);
    assert.equal(deployCount(ws.log), 0);
    rmSync(ws.base, { recursive: true, force: true });
  });

  test("program-identity gate still enforced: a non-NS-3 scanner keypair pubkey refuses (pre-existing behavior preserved)", () => {
    const ws = setupWorkspace({ scannerBuf: GOOD_SCANNER, vaultBuf: GOOD_VAULT });
    const r = run({ ...ws.env, GY_SCANNER_PK: NS2_SCANNER }, ws.deployArgs(["--skip-build"]));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /scanner keypair pubkey .* != compiled declare_id/);
    assert.equal(deployCount(ws.log), 0);
    rmSync(ws.base, { recursive: true, force: true });
  });
});
