// SPDX-License-Identifier: Apache-2.0
//
// deploy_gate.test.mjs — end-to-end tests for the fail-closed provenance
// gate in deploy_devnet.sh.
//
// EVERY test runs fully offline: the SBF toolchain (solana, solana-keygen,
// cargo-build-sbf) is stubbed with shell shims that record invocations,
// curl is stubbed to emit a scenario-controlled platform-tools archive,
// and the deploy "RPC" is the stub's own log. Nothing here ever contacts a
// public cluster, and no keypair material is real — the stub keygen prints
// public keys only. The script under test is copied into a sandbox repo
// tree together with a scenario-specific provenance manifest whose digests
// match the fabricated fixture ELFs and the fabricated platform-tools
// archive.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

// Binaries the deploy script may exec besides the stubbed toolchain; the
// nodeless PATH exposes ONLY these (no node) to prove fail-closed behavior.
const NEEDED_BINS = [
  "bash",
  "sh",
  "dirname",
  "mkdir",
  "cp",
  "mv",
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
  // --version is handled FIRST (the deploy script checks the deployment
  // CLI version compatibility before it may touch any keypair path —
  // fix D; a version-string check, not executable authentication).
  writeFileSync(
    path.join(stub, "solana-keygen"),
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  if [[ -n "\${KEYGEN_BAD_VERSION:-}" ]]; then echo "solana-keygen 9.9.9"; else echo "solana-keygen 3.0.10"; fi
  exit 0
fi
echo "solana-keygen $*" >> "$SBX_LOG"
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
if [[ "$1" == "--version" ]]; then
  if [[ -n "\${SOLANA_BAD_VERSION:-}" ]]; then echo "solana-cli 9.9.9 (src:devbuild)"; else echo "solana-cli 3.0.10 (src:devbuild)"; fi
  exit 0
fi
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
  *) echo "stub solana: unsupported invocation $*" >&2; exit 1 ;;
esac
`,
    0o755,
  );
  // curl: never touches the network — emits the scenario-controlled
  // platform-tools archive (fix B tests drive download success/failure
  // through GY_TEST_PT_TARBALL / GY_TEST_CURL_FAIL).
  writeFile(
    path.join(stub, "curl"),
    `#!/usr/bin/env bash
if [[ -n "\${GY_TEST_CURL_FAIL:-}" ]]; then
  echo "stub curl: simulated download failure" >&2
  exit 18
fi
out=""; prev=""
for a in "$@"; do [[ "$prev" == "-o" ]] && out="$a"; prev="$a"; done
if [[ -z "$out" ]]; then echo "stub curl: no -o target" >&2; exit 1; fi
src="\${GY_TEST_PT_TARBALL:-}"
if [[ -z "$src" || ! -f "$src" ]]; then echo "stub curl: no fixture archive at '$src'" >&2; exit 1; fi
cat "$src" > "$out"
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

/** A PATH that has node but NO solana (fix D: CLI-absent refusal). */
function nodeBinDir(sbx) {
  const bin = path.join(sbx, "nodebin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(execFileSync("which", ["node"], { encoding: "utf8" }).trim(), path.join(bin, "node"));
  return bin;
}

/**
 * Build the scenario platform-tools fixture archive: a REAL tar.bz2 with
 * the same internal layout as the release tarball (entries directly at the
 * root — ./version.md, ./rust/bin/... — no wrapper directory).
 */
function makePlatformToolsFixture(fixtures) {
  const src = path.join(fixtures, "pt-src");
  mkdirSync(path.join(src, "rust", "bin"), { recursive: true });
  writeFileSync(path.join(src, "version.md"), "platform-tools 1.54 TEST FIXTURE\n");
  writeFileSync(path.join(src, "rust", "bin", "cargo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const good = path.join(fixtures, "platform-tools.tar.bz2");
  execFileSync("tar", ["cjf", good, "-C", src, "."]);
  // a second, DIFFERENT archive for the wrong-digest scenarios
  const badSrc = path.join(fixtures, "pt-src-bad");
  mkdirSync(path.join(badSrc, "rust", "bin"), { recursive: true });
  writeFileSync(path.join(badSrc, "version.md"), "TAMPERED TOOLCHAIN BYTES\n");
  const bad = path.join(fixtures, "platform-tools-bad.tar.bz2");
  execFileSync("tar", ["cjf", bad, "-C", badSrc, "."]);
  assert.notEqual(sha256(readFileSync(good)), sha256(readFileSync(bad)));
  return { good, bad, sha: sha256(readFileSync(good)) };
}

/** Write the sandbox's scenario manifest around the given fixture digests. */
function writeManifest(
  sbx,
  { scannerSha, vaultSha, omit = null, platformToolsSha, solanaCli = "3.0.10" },
) {
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
      solana_cli: solanaCli,
      platform_tools: {
        version: "1.54",
        sha256: platformToolsSha,
        url: "https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-linux-x86_64.tar.bz2",
      },
    },
  };
  writeFileSync(
    path.join(sbx, "repo", "scripts", "devnet", "provenance.manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

/**
 * Pre-seed the platform-tools cache directories with a (possibly foreign)
 * stamp and, optionally, the (possibly corrupt) archive cache file.
 */
function seedCache(sbx, { stampSha = null, archivePath = null, canary = false } = {}) {
  for (const v of ["v1.51", "v1.57"]) {
    const dest = path.join(sbx, "home", ".cache", "solana", v, "platform-tools");
    mkdirSync(path.join(dest, "rust", "bin"), { recursive: true });
    writeFileSync(path.join(dest, "rust", "bin", "cargo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    if (canary) writeFileSync(path.join(dest, "FOREIGN-CANARY"), "tampered bytes\n");
    if (stampSha !== null) {
      writeFileSync(path.join(dest, ".graveyield-pinned-sha256"), `${stampSha}\n`);
    }
  }
  if (archivePath) {
    const destArchive = path.join(
      sbx,
      "home",
      ".cache",
      "solana",
      ".graveyield-platform-tools-v1.54.tar.bz2",
    );
    mkdirSync(path.dirname(destArchive), { recursive: true });
    copyFileSync(archivePath, destArchive);
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
 * Scenario setup: fixture ELFs + matching manifest + platform-tools
 * fixture archive. Returns { run } — run(args, opts) executes the script.
 */
function setupScenario({
  scannerElf,
  vaultElf,
  stampSha = null, // null = no stamp; "manifest" = stamp equals the manifest pin; anything else = foreign stamp
  seedArchive = true,
  archiveIsGood = true,
  canary = false,
  omitManifestField = null,
  prePlace = false,
  solanaCli = "3.0.10",
} = {}) {
  const fixtures = path.join(SBX, "fixtures");
  mkdirSync(fixtures, { recursive: true });
  const pt = makePlatformToolsFixture(fixtures);
  const resolvedStampSha = stampSha === "manifest" ? pt.sha : stampSha;
  const scanner = scannerElf ?? buildSbfElf({ idBase58: NS3.scannerProgramId });
  const vault = vaultElf ?? buildSbfElf({ idBase58: NS3.vaultProgramId });
  writeFileSync(path.join(fixtures, "grave_scanner.so"), scanner);
  writeFileSync(path.join(fixtures, "grave_vault.so"), vault);
  writeManifest(SBX, {
    scannerSha: sha256(scanner),
    vaultSha: sha256(vault),
    omit: omitManifestField,
    platformToolsSha: pt.sha,
    solanaCli,
  });
  seedCache(SBX, {
    stampSha: resolvedStampSha,
    archivePath: seedArchive ? (archiveIsGood ? pt.good : pt.bad) : null,
    canary,
  });
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
  const run = ({
    withNode = true,
    args = deployArgs,
    curlEmits = "good",
    curlFail = false,
    pathOverride = null,
  } = {}) => {
    const origPath = process.env.PATH ?? "/usr/bin:/bin";
    const stubDir = path.join(SBX, "stub");
    const binDir = path.join(SBX, "bin");
    const childPath =
      pathOverride ?? (withNode ? `${stubDir}:${origPath}` : `${stubDir}:${binDir}`);
    const child = spawnSync(
      "bash",
      [path.join(repo, "scripts", "devnet", "deploy_devnet.sh"), ...args],
      {
        cwd: repo,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: childPath,
          HOME: path.join(SBX, "home"),
          SBX_LOG: log,
          FIXTURES: fixtures,
          GY_TEST_PT_TARBALL: curlEmits === "good" ? pt.good : pt.bad,
          ...(curlFail ? { GY_TEST_CURL_FAIL: "1" } : {}),
        },
      },
    );
    return {
      code: child.status ?? 1,
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
    };
  };
  return { run, log, pt };
}

/** A PATH that keeps node but removes the solana stub (fix D). */
function pathWithoutSolana(sbx) {
  const nodeBin = nodeBinDir(sbx);
  const stub = path.join(SBX, "stub");
  rmSync(path.join(stub, "solana"));
  const bin = path.join(SBX, "bin");
  return `${stub}:${bin}:${nodeBin}`;
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

function keypairReadsInLog(logPath) {
  return readLog(logPath).filter((l) => l.startsWith("solana-keygen pubkey"));
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

    const scannerKeypair = path.join(SBX, "keys", "scanner-keypair.json");
    const vaultKeypair = path.join(SBX, "keys", "vault-keypair.json");
    const deployerKeypair = path.join(SBX, "keys", "deployer-keypair.json");

    assert.ok(deploys[0].includes(`--program-id ${scannerKeypair}`),
      "scanner deployment must use the external scanner keypair path");
    assert.ok(deploys[1].includes(`--program-id ${vaultKeypair}`),
      "vault deployment must use the external vault keypair path");
    assert.ok(deploys[0].includes(`--keypair ${deployerKeypair}`),
      "scanner deployment must use the external deployer keypair path");
    assert.ok(deploys[1].includes(`--keypair ${deployerKeypair}`),
      "vault deployment must use the external deployer keypair path");

    const deployDir = path.join(SBX, "repo", "target", "deploy");
    assert.equal(
      existsSync(path.join(deployDir, "grave_scanner-keypair.json")),
      false,
      "scanner keypair must remain outside target/deploy",
    );
    assert.equal(
      existsSync(path.join(deployDir, "grave_vault-keypair.json")),
      false,
      "vault keypair must remain outside target/deploy",
    );

    assert.match(deploys[0], /--url http:\/\/127\.0\.0\.1:8899/);
    assert.match(r.stdout, /PROVENANCE OK/);
    // The verified cached archive means NO platform-tools download happened.
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

  // ========================================================================
  // Fix B — the platform-tools ARCHIVE is the only trust anchor
  // ========================================================================

  test("B1. a foreign-stamped cache is REPLACED by bytes from the verified archive (stamp never trusted)", () => {
    const { run, log, pt } = setupScenario({
      stampSha: "0".repeat(64), // foreign stamp
      canary: true, // tampered marker inside the cache dir
    });
    const r = run();
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /seeded from the verified archive/);
    assert.equal(deploysInLog(log).length, 2);
    // the stamp was rewritten to the manifest pin
    const stamp = path.join(
      SBX,
      "home",
      ".cache",
      "solana",
      "v1.51",
      "platform-tools",
      ".graveyield-pinned-sha256",
    );
    assert.equal(readFileSync(stamp, "utf8").trim(), pt.sha);
    // the tampered cache contents did not survive the re-seed
    assert.equal(
      existsSync(
        path.join(SBX, "home", ".cache", "solana", "v1.51", "platform-tools", "FOREIGN-CANARY"),
      ),
      false,
    );
  });

  test("B2. a cache directory with NO stamp at all is re-seeded the same way", () => {
    const { run, log } = setupScenario({ stampSha: null, canary: true });
    const r = run();
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(deploysInLog(log).length, 2);
    assert.equal(
      existsSync(
        path.join(SBX, "home", ".cache", "solana", "v1.57", "platform-tools", "FOREIGN-CANARY"),
      ),
      false,
    );
  });

  test("B3. a CORRUPTED cached archive is deleted and re-downloaded (fail-closed re-download)", () => {
    const { run, log } = setupScenario({ stampSha: null, archiveIsGood: false });
    const r = run();
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /does NOT match the manifest pin/);
    assert.match(r.stdout, /downloading platform-tools/);
    assert.equal(deploysInLog(log).length, 2);
  });

  test("B4. a fresh download with the WRONG digest is refused — nothing extracted, nothing built, nothing deployed", () => {
    const { run, log } = setupScenario({ stampSha: null, seedArchive: false });
    const r = run({ curlEmits: "bad" });
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /failed the manifest digest check/);
    assert.match(`${r.stdout}\n${r.stderr}`, /NOTHING was\s+extracted/);
    assert.equal(buildsInLog(log).length, 0, "build must not start");
    assert.equal(deploysInLog(log).length, 0);
    // no archive was persisted from the bad download
    assert.equal(
      existsSync(
        path.join(SBX, "home", ".cache", "solana", ".graveyield-platform-tools-v1.54.tar.bz2"),
      ),
      false,
    );
  });

  test("B5. a download FAILURE aborts before build; program keypairs remain external", () => {
    const { run, log } = setupScenario({ stampSha: null, seedArchive: false });
    const r = run({ curlFail: true });
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /download failed/);
    assert.equal(deploysInLog(log).length, 0);
    // The toolchain refusal happens before the build; neither program
    // keypair is ever copied into the build tree.
    const deployDir = path.join(SBX, "repo", "target", "deploy");
    for (const name of ["grave_scanner-keypair.json", "grave_vault-keypair.json"]) {
      assert.equal(
        existsSync(path.join(deployDir, name)),
        false,
        `${name} must not be copied into target/deploy`,
      );
    }
  });

  test("B6. the verified archive PERSISTS after a successful run (next run re-verifies offline)", () => {
    const { run } = setupScenario();
    const r = run();
    assert.equal(r.code, 0);
    const archive = path.join(
      SBX,
      "home",
      ".cache",
      "solana",
      ".graveyield-platform-tools-v1.54.tar.bz2",
    );
    assert.equal(
      existsSync(archive),
      true,
      "the verified archive must be kept for re-verification",
    );
  });

  test("B7. the provenance gate re-verifies the archive a second time (two trust moments, one file)", () => {
    const { run } = setupScenario();
    const r = run();
    assert.equal(r.code, 0);
    assert.match(r.stdout, /platform-tools v1\.54 tarball sha256 matches the manifest pin/);
  });

  test("B8. a MATCHING stamp is not load-bearing either: the cache is still re-seeded from the verified archive", () => {
    const { run } = setupScenario({ stampSha: "manifest", canary: true });
    const r = run();
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /seeded from the verified archive/);
    assert.equal(
      existsSync(
        path.join(SBX, "home", ".cache", "solana", "v1.51", "platform-tools", "FOREIGN-CANARY"),
      ),
      false,
    );
  });

  test("B9. a tampered tool BINARY under a VALID stamp is replaced from the authenticated archive", () => {
    // Strongest adversarial cache claim available: the compiler binary
    // inside the cache is swapped for attacker-controlled bytes while the
    // plaintext stamp still reads exactly the manifest pin. The stamp is
    // never load-bearing (fix B), so the cache must be rebuilt from the
    // hash-verified archive and the tampered compiler must not survive.
    const { run, log, pt } = setupScenario({ stampSha: "manifest" });
    const tampered = "#!/bin/sh\necho TAMPERED-COMPILER; exit 0\n";
    const cargoPaths = ["v1.51", "v1.57"].map((v) =>
      path.join(SBX, "home", ".cache", "solana", v, "platform-tools", "rust", "bin", "cargo"),
    );
    for (const p of cargoPaths) writeFileSync(p, tampered, { mode: 0o755 });

    const r = run();
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /seeded from the verified archive/);
    assert.equal(deploysInLog(log).length, 2, "a re-seeded cache still leads to a normal deploy");
    // the tampered compiler bytes did NOT survive: no TAMPERED-COMPILER marker
    for (const p of cargoPaths) {
      assert.doesNotMatch(readFileSync(p, "utf8"), /TAMPERED-COMPILER/);
    }
    // belt and braces: every cache binary is byte-identical to a fresh
    // extraction of the VERIFIED archive — not merely "not tampered"
    const extract = mkdtempSync(path.join(tmpdir(), "gy-pt-extract-"));
    try {
      execFileSync("tar", ["xjf", pt.good, "-C", extract]);
      for (const p of cargoPaths) {
        assert.deepEqual(
          [...readFileSync(p)],
          [...readFileSync(path.join(extract, "rust", "bin", "cargo"))],
        );
      }
    } finally {
      rmSync(extract, { recursive: true, force: true });
    }
    // the stamp is rewritten to the manifest pin (same value it already had)
    const stamp = readFileSync(
      path.join(
        SBX,
        "home",
        ".cache",
        "solana",
        "v1.51",
        "platform-tools",
        ".graveyield-pinned-sha256",
      ),
      "utf8",
    ).trim();
    assert.equal(stamp, pt.sha);
  });

  // ========================================================================
  // Fix D — deployment-CLI version-compatibility check on EVERY deploy
  // path, before keypairs (version strings only, no content attestation)
  // ========================================================================

  test("D1. wrong `solana --version` refuses BEFORE any keypair path is touched", () => {
    const { run, log } = setupScenario();
    const r = runWithEnv(run, { SOLANA_BAD_VERSION: "1" });
    assert.notEqual(r.code, 0);
    assert.match(
      `${r.stdout}\n${r.stderr}`,
      /solana --version 'solana-cli 9\.9\.9.*' does not match the pinned deployment CLI 3\.0\.10/,
    );
    // no keypair file was READ (no solana-keygen pubkey in the log)
    assert.equal(keypairReadsInLog(log).length, 0);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("D2. wrong `solana-keygen --version` refuses before keypair reads", () => {
    const { run, log } = setupScenario();
    // a run with KEYGEN_BAD_VERSION=1
    const r = runWithEnv(run, { KEYGEN_BAD_VERSION: "1" });
    assert.notEqual(r.code, 0);
    assert.match(
      `${r.stdout}\n${r.stderr}`,
      /solana-keygen --version 'solana-keygen 9\.9\.9' does not match the pinned deployment CLI 3\.0\.10/,
    );
    assert.equal(keypairReadsInLog(log).length, 0);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("D3. a missing solana CLI refuses before keypair access", () => {
    const { run, log } = setupScenario();
    const customPath = pathWithoutSolana(SBX);
    const r = runWithEnv(run, {}, { pathOverride: customPath });
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /solana CLI not on PATH/);
    assert.equal(keypairReadsInLog(log).length, 0);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("D4. the --skip-build deploy path ALSO verifies the CLI (pre-placed correct bytes)", () => {
    const { run, log } = setupScenario({ prePlace: true });
    const r = runWithEnv(run, { SOLANA_BAD_VERSION: "1" }, {}, [
      "--url",
      "http://127.0.0.1:8899",
      "--scanner-keypair",
      path.join(SBX, "keys", "scanner-keypair.json"),
      "--vault-keypair",
      path.join(SBX, "keys", "vault-keypair.json"),
      "--deployer",
      path.join(SBX, "keys", "deployer-keypair.json"),
      "--skip-build",
    ]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /does not match the pinned deployment CLI/);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("D5. the CLI version is compared against the MANIFEST pin (not a hardcoded constant)", () => {
    const { run, log } = setupScenario({ solanaCli: "3.0.11" });
    const r = run(); // stub reports 3.0.10, manifest pins 3.0.11
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /does not match the pinned deployment CLI 3\.0\.11/);
    assert.equal(deploysInLog(log).length, 0);
  });

  test("D6. every RUN re-verifies the CLI (retries re-check; nothing caches the verdict)", () => {
    const { run, log } = setupScenario();
    const r1 = run();
    assert.equal(r1.code, 0, r1.stderr);
    const r2 = run();
    assert.equal(r2.code, 0, r2.stderr);
    const versionChecks = readLog(log).filter((l) => /^solana --version/.test(l));
    assert.ok(
      versionChecks.length >= 2,
      `expected >=2 solana --version invocations across two runs, got ${versionChecks.length}`,
    );
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

/** Run with a custom env on top of the scenario env. */
function runWithEnv(run, extraEnv = {}, overrides = {}, args = undefined) {
  try {
    Object.assign(process.env, extraEnv);
    return run({ args, ...overrides });
  } finally {
    for (const k of Object.keys(extraEnv)) delete process.env[k];
  }
}
