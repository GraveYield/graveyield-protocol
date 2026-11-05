// SPDX-License-Identifier: Apache-2.0
//
// deploy_gate.test.mjs — end-to-end tests for the fail-closed provenance
// gate in deploy_devnet.sh.
//
// EVERY test runs fully offline: the SBF toolchain (solana, solana-keygen,
// cargo-build-sbf) is stubbed with shell shims that record invocations,
// and the deploy "RPC" is the stub's own log. Nothing here ever contacts a
// public cluster, and no keypair material is real — the stub keygen prints
// public keys only. The script under test is copied into a sandbox repo
// tree together with a scenario-specific provenance manifest whose digests
// match the fabricated fixture ELFs.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { buildSbfElf, sha256 } from "./helpers/provenance_fixtures.mjs";
import { NS3 } from "../ns3_identities.mjs";

const DEVNET_DIR = path.dirname(fileURLToPath(import.meta.url)); // scripts/devnet/test
const SCRIPTS_DEVNET = path.dirname(DEVNET_DIR); // scripts/devnet
const PLATFORM_TOOLS_SHA = "fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e";

// Binaries the deploy script may exec besides the stubbed toolchain; the
// nodeless PATH exposes ONLY these (no node) to prove fail-closed behavior.
const NEEDED_BINS = [
  "bash",
  "sh",
  "dirname",
  "mkdir",
  "cp",
  "rm",
  "ls",
  "cat",
  "mktemp",
  "tar",
  "curl",
  "tr",
  "sed",
  "grep",
  "env",
  "uname",
  "readlink",
  "basename",
  "stat",
  "chmod",
  "sleep",
  "head",
  "tail",
  "wc",
  "sort",
  "touch",
  "date",
  "true",
  "false",
];

let SBX;

function sandboxRoot() {
  return mkdtempSync(path.join(tmpdir(), "gy-deploy-gate-"));
}

function writeFile(p, data, mode) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, data, mode !== undefined ? { mode } : undefined);
}

function stubShims(sbx) {
  const stub = path.join(sbx, "stub");
  mkdirSync(stub, { recursive: true });
  const log = path.join(sbx, "log", "invocations.log");
  mkdirSync(path.join(sbx, "log"), { recursive: true });
  // solana-keygen: prints the pinned PUBLIC keys for the recognized fixture
  // keypair basenames (public-key simulation only — no key material).
  writeFileSync(
    path.join(stub, "solana-keygen"),
    `#!/usr/bin/env bash
# invocation form: solana-keygen pubkey <file> — the file is \$2
kp="\${2:-\$1}"
case "$(basename "$kp")" in
  scanner-keypair.json|grave_scanner-keypair.json) echo "${NS3.scannerProgramId}" ;;
  vault-keypair.json|grave_vault-keypair.json) echo "${NS3.vaultProgramId}" ;;
  deployer-keypair.json) echo "${NS3.deployer}" ;;
  wrong-scanner-keypair.json) echo "BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5" ;;
  *) echo "stub keygen: unknown keypair $kp" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFile(
    path.join(stub, "solana"),
    `#!/usr/bin/env bash
echo "solana $*" >> "$SBX_LOG"
case "$1" in
  --url)
    sub="$3"
    case "$sub" in
      balance) echo "9000000000" ;;
      program)
        if [[ "$4" == "deploy" ]]; then
          echo "DEPLOY $*" >> "$SBX_LOG"
          echo '{"programId":"stub","signature":"stubsig"}'
        fi
        ;;
      cluster-version) echo "3.0.10" ;;
    esac
    ;;
  --version) echo "solana-cli 3.0.10 (src:devbuild)" ;;
  *) echo "stub solana: unsupported invocation $*" >&2; exit 1 ;;
esac
`,
    0o755,
  );
  // cargo-build-sbf: --version reports the pinned toolchain; a build copies
  // the scenario fixture ELFs into --sbf-out-dir and logs BUILD lines.
  writeFile(
    path.join(stub, "cargo-build-sbf"),
    `#!/usr/bin/env bash
echo "cargo-build-sbf $*" >> "$SBX_LOG"
if [[ "$1" == "--version" ]]; then echo "cargo-build-sbf 3.0.10"; exit 0; fi
out=""; prev=""
for a in "$@"; do [[ "$prev" == "--sbf-out-dir" ]] && out="$a"; prev="$a"; done
pwd_now="$(pwd)"
case "$pwd_now" in
  *grave-scanner*) cp "$FIXTURES/grave_scanner.so" "$out/grave_scanner.so" ;;
  *grave-vault*)   cp "$FIXTURES/grave_vault.so" "$out/grave_vault.so" ;;
  *) echo "stub cargo-build-sbf: unknown cwd $pwd_now" >&2; exit 1 ;;
esac
exit 0
`,
    0o755,
  );
  // cargo: the script runs `cargo build-sbf` (cargo's subcommand delegation
  // to cargo-build-sbf on PATH) — delegate to the stub; refuse everything else.
  writeFile(
    path.join(stub, "cargo"),
    `#!/usr/bin/env bash
if [[ "$1" == "build-sbf" ]]; then shift; exec cargo-build-sbf "$@"; fi
echo "stub cargo: unsupported invocation $*" >&2; exit 1
`,
    0o755,
  );
  return { stub, log };
}

function minimalBinDir(sbx) {
  const bin = path.join(sbx, "bin");
  mkdirSync(bin, { recursive: true });
  for (const b of NEEDED_BINS) {
    const resolved = execFileSync("which", [b], { encoding: "utf8" }).trim();
    if (resolved) symlinkSync(resolved, path.join(bin, b));
  }
  return bin;
}

/** Write the sandbox's scenario manifest around the given fixture digests. */
function writeManifest(sbx, { scannerSha, vaultSha, omit = null }) {
  const manifest = {
    schema: "graveyield.provenance/1",
    programs: {
      grave_scanner: {
        artifact: "target/deploy/grave_scanner.so",
        ...(omit === "scanner" ? {} : { sha256: scannerSha }),
      },
      grave_vault: {
        artifact: "target/deploy/grave_vault.so",
        ...(omit === "vault" ? {} : { sha256: vaultSha }),
      },
    },
    toolchain: {
      sbpf_arch: "v0",
      elf: { e_machine: 263, e_flags: 0 },
      solana_cli: "3.0.10",
      platform_tools: {
        version: "1.54",
        sha256: PLATFORM_TOOLS_SHA,
        url: "https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-linux-x86_64.tar.bz2",
      },
    },
  };
  writeFileSync(
    path.join(sbx, "repo", "scripts", "devnet", "provenance.manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

/** Pre-seed the platform-tools cache with a matching (or wrong) stamp. */
function seedCache(sbx, stampSha) {
  for (const v of ["v1.51", "v1.57"]) {
    const dest = path.join(sbx, "home", ".cache", "solana", v, "platform-tools");
    mkdirSync(path.join(dest, "rust", "bin"), { recursive: true });
    writeFileSync(path.join(dest, "rust", "bin", "cargo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(dest, ".graveyield-pinned-sha256"), `${stampSha}\n`);
  }
}

function makeRepo(sbx) {
  const repo = path.join(sbx, "repo");
  for (const f of [
    "deploy_devnet.sh",
    "ns3_check_provenance.mjs",
    "ns3_verify_elf.mjs",
    "ns3_identities.mjs",
    "package.json",
  ]) {
    const dest = path.join(repo, "scripts", "devnet", f);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(SCRIPTS_DEVNET, f), dest);
  }
  symlinkSync(
    path.join(SCRIPTS_DEVNET, "node_modules"),
    path.join(repo, "scripts", "devnet", "node_modules"),
  );
  mkdirSync(path.join(repo, "programs", "grave-scanner"), { recursive: true });
  mkdirSync(path.join(repo, "programs", "grave-vault"), { recursive: true });
  mkdirSync(path.join(repo, "target", "deploy"), { recursive: true });
  // dummy custody keypair files (existence only; stubs print the pubkeys)
  for (const f of [
    "scanner-keypair.json",
    "vault-keypair.json",
    "deployer-keypair.json",
    "wrong-scanner-keypair.json",
  ]) {
    writeFile(path.join(sbx, "keys", f), "[1,2,3]");
  }
  return repo;
}

/**
 * Scenario setup: fixture ELFs + matching manifest + stamped cache.
 * Returns { run } — run(args, { withNode }) executes the script.
 */
function setupScenario({
  scannerElf,
  vaultElf,
  stampSha = PLATFORM_TOOLS_SHA,
  omitManifestField = null,
  prePlace = false,
} = {}) {
  const fixtures = path.join(SBX, "fixtures");
  mkdirSync(fixtures, { recursive: true });
  const scanner = scannerElf ?? buildSbfElf({ idBase58: NS3.scannerProgramId });
  const vault = vaultElf ?? buildSbfElf({ idBase58: NS3.vaultProgramId });
  writeFileSync(path.join(fixtures, "grave_scanner.so"), scanner);
  writeFileSync(path.join(fixtures, "grave_vault.so"), vault);
  writeManifest(SBX, {
    scannerSha: sha256(scanner),
    vaultSha: sha256(vault),
    omit: omitManifestField,
  });
  seedCache(SBX, stampSha);
  if (prePlace) {
    // "custom artifact path" scenario: bytes placed directly into target/deploy
    writeFileSync(path.join(SBX, "repo", "target", "deploy", "grave_scanner.so"), scanner);
    writeFileSync(path.join(SBX, "repo", "target", "deploy", "grave_vault.so"), vault);
  }
  const repo = path.join(SBX, "repo");
  const log = path.join(SBX, "log", "invocations.log");
  const keypaths = path.join(SBX, "keys");
  const deployArgs = [
    "--url",
    "http://127.0.0.1:8899",
    "--scanner-keypair",
    path.join(keypaths, "scanner-keypair.json"),
    "--vault-keypair",
    path.join(keypaths, "vault-keypair.json"),
    "--deployer",
    path.join(keypaths, "deployer-keypair.json"),
  ];
  const run = ({ withNode = true, args = deployArgs } = {}) => {
    const origPath = process.env.PATH ?? "/usr/bin:/bin";
    const stubDir = path.join(SBX, "stub");
    const binDir = path.join(SBX, "bin");
    const childPath = withNode ? `${stubDir}:${origPath}` : `${stubDir}:${binDir}`;
    try {
      const stdout = execFileSync(
        "bash",
        [path.join(repo, "scripts", "devnet", "deploy_devnet.sh"), ...args],
        {
          cwd: repo,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: childPath,
            HOME: path.join(SBX, "home"),
            SBX_LOG: log,
            FIXTURES: fixtures,
          },
        },
      );
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) };
    }
  };
  return { run, log };
}

function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

function deploysInLog(logPath) {
  return readLog(logPath).filter((l) => l.startsWith("DEPLOY"));
}

function buildsInLog(logPath) {
  return readLog(logPath).filter((l) => l.startsWith("cargo-build-sbf --sbf-out-dir"));
}

describe("deploy_devnet.sh fail-closed provenance gate", () => {
  beforeEach(() => {
    SBX = sandboxRoot();
    stubShims(SBX);
    minimalBinDir(SBX);
    makeRepo(SBX);
  });
  afterEach(() => {
    rmSync(SBX, { recursive: true, force: true });
    SBX = undefined;
  });

  test("1+2. happy path: build → gate passes → exactly two deploys, scanner first, correct args", () => {
    const { run, log } = setupScenario();
    const r = run();
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const deploys = deploysInLog(log);
    assert.equal(deploys.length, 2, `expected 2 deploys, log:\n${readLog(log).join("\n")}`);
    assert.match(deploys[0], /grave_scanner\.so/);
    assert.match(deploys[1], /grave_vault\.so/);
    assert.match(deploys[0], new RegExp(`--program-id .*scanner-keypair.json`));
    assert.match(deploys[0], new RegExp(`--keypair .*deployer-keypair.json`));
    assert.match(deploys[0], /--url http:\/\/127\.0\.0\.1:8899/);
    assert.match(r.stdout, /PROVENANCE OK/);
    // the stamped cache means NO platform-tools download happened
    assert.doesNotMatch(r.stdout, /downloading platform-tools/);
  });

  test("3. scanner ELF digest mismatch aborts before any deploy", () => {
    const { run, log } = setupScenario();
    // corrupt the built artifact AFTER manifest/fixture pairing: make the
    // stub copy a mutated scanner fixture instead
    const scanner = buildSbfElf({ idBase58: NS3.scannerProgramId });
    scanner[100] ^= 0xff;
    writeFileSync(path.join(SBX, "fixtures", "grave_scanner.so"), scanner);
    const r = run();
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /sha256 MISMATCH/);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("4. vault ELF digest mismatch aborts before any deploy", () => {
    const { run, log } = setupScenario();
    const vault = buildSbfElf({ idBase58: NS3.vaultProgramId });
    vault[100] ^= 0xff;
    writeFileSync(path.join(SBX, "fixtures", "grave_vault.so"), vault);
    const r = run();
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /sha256 MISMATCH/);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("5. --skip-build cannot bypass: pre-placed wrong bytes are refused", () => {
    const { run, log } = setupScenario({ prePlace: true });
    // overwrite the placed scanner with different-but-structurally-fine bytes
    const other = buildSbfElf({ idBase58: NS3.scannerProgramId, padTo: 900 });
    writeFileSync(path.join(SBX, "repo", "target", "deploy", "grave_scanner.so"), other);
    const r = run({
      args: [
        "--url",
        "http://127.0.0.1:8899",
        "--scanner-keypair",
        path.join(SBX, "keys", "scanner-keypair.json"),
        "--vault-keypair",
        path.join(SBX, "keys", "vault-keypair.json"),
        "--deployer",
        path.join(SBX, "keys", "deployer-keypair.json"),
        "--skip-build",
      ],
    });
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /sha256 MISMATCH/);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("6. --skip-build with a missing ELF fails closed (no deploy)", () => {
    const { run, log } = setupScenario({ prePlace: false });
    const r = run({
      args: [
        "--url",
        "http://127.0.0.1:8899",
        "--scanner-keypair",
        path.join(SBX, "keys", "scanner-keypair.json"),
        "--vault-keypair",
        path.join(SBX, "keys", "vault-keypair.json"),
        "--deployer",
        path.join(SBX, "keys", "deployer-keypair.json"),
        "--skip-build",
      ],
    });
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /cannot read|no artifact|No such file|fail-closed/i);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("7. digest-matched garbage ELF fails the structural check (no deploy)", () => {
    const garbage = Buffer.concat([
      Buffer.from("this is not an elf at all ".repeat(10)),
      Buffer.alloc(300, 7),
    ]);
    const { run, log } = setupScenario({ scannerElf: garbage });
    const r = run();
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /structural identity FAILED|not-elf/);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("8. legacy NS-2 identity bytes in the ELF fail the canary (no deploy)", () => {
    const LEGACY_NS2_SCANNER = "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54";
    const scanner = buildSbfElf({
      idBase58: NS3.scannerProgramId,
      injectBytes: [
        { bytes: Buffer.from(new PublicKey(LEGACY_NS2_SCANNER).toBytes()), alloc: false },
      ],
    });
    const { run, log } = setupScenario({ scannerElf: scanner });
    const r = run();
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /legacy-present|legacy identity bytes/);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("9. wrong SBPF architecture (v3 header) is refused even with matching digest and ID", () => {
    const scanner = buildSbfElf({ idBase58: NS3.scannerProgramId, eMachine: 247, eFlags: 3 });
    const { run, log } = setupScenario({ scannerElf: scanner });
    const r = run();
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /architecture MISMATCH/);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("10. --build-only: builds, gate passes, needs no keypairs, deploys NOTHING", () => {
    const { run, log } = setupScenario();
    const r = run({ args: ["--build-only"] });
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /provenance-verified/);
    assert.equal(deploysInLog(log).length, 0);
    assert.equal(buildsInLog(log).length, 2);
  });

  test("11. --build-only with digest mismatch refuses (no silent ready artifacts)", () => {
    const { run } = setupScenario();
    const vault = buildSbfElf({ idBase58: NS3.vaultProgramId, padTo: 1234 });
    writeFileSync(path.join(SBX, "fixtures", "grave_vault.so"), vault);
    const r = run({ args: ["--build-only"] });
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /sha256 MISMATCH/);
  });

  test("12. --build-only without node refuses (the old warning-only path is gone)", () => {
    const { run } = setupScenario();
    const r = run({ args: ["--build-only"], withNode: false });
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /node is not on PATH/);
  });

  test("13. deploy path without node refuses before any deploy", () => {
    const { run, log } = setupScenario();
    const r = run({ withNode: false });
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /node is not on PATH/);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("14. malformed manifest (missing vault digest) refuses with usage exit code", () => {
    const { run, log } = setupScenario({ omitManifestField: "vault" });
    const r = run();
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /grave_vault\.sha256|schema|REFUSED/i);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("15. platform-tools cache without a provenance stamp refuses BEFORE the build", () => {
    const { run, log } = setupScenario({ stampSha: "0".repeat(64) });
    const r = run();
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /provenance stamp/);
    assert.match(`${r.stdout}\n${r.stderr}`, /rm -rf/);
    assert.equal(buildsInLog(log).length, 0, "build must not start");
    assert.equal(deploysInLog(log).length, 0);
  });

  test("16. wrong scanner keypair identity aborts before funding (existing check intact)", () => {
    const { run, log } = setupScenario();
    const r = run({
      args: [
        "--url",
        "http://127.0.0.1:8899",
        "--scanner-keypair",
        path.join(SBX, "keys", "wrong-scanner-keypair.json"),
        "--vault-keypair",
        path.join(SBX, "keys", "vault-keypair.json"),
        "--deployer",
        path.join(SBX, "keys", "deployer-keypair.json"),
      ],
    });
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /scanner keypair pubkey .* != compiled declare_id/);
    // funding check never ran (no balance call logged)
    assert.equal(readLog(log).filter((l) => l.includes("balance")).length, 0);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("17. funding refusal preserved (lamport-exact, existing check intact)", () => {
    const { run, log } = setupScenario();
    // make the balance stub report a small balance
    const stub = path.join(SBX, "stub", "solana");
    let shim = readFileSync(stub, "utf8");
    shim = shim.replace('echo "9000000000"', 'echo "100000"');
    writeFileSync(stub, shim, { mode: 0o755 });
    const r = run();
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /deployer needs >= 6 SOL/);
    assert.equal(deploysInLog(log).length, 0);
  });
});
