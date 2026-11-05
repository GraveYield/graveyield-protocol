// rehearsal_rpc_guard.test.mjs — W1 P1 regression: the orchestrator's
// strictly-local RPC execution boundary.
//
// lifecycle_rehearsal.sh must reject any --url that is not EXACTLY
// http://127.0.0.1:8899 BEFORE it performs ANY operation — before directory
// or key creation, toolchain checks, Solana CLI invocations, airdrops,
// validator boot, or the driver. The proof of ORDERING here is mechanical:
// every external command the orchestrator could call is replaced by a stub
// that appends its argv to a log file. For a rejected URL the log must not
// even exist (zero external commands executed, zero directories created);
// for the accepted local URL the orchestrator must proceed (the guard
// passes) and its first operational command must be the LOCAL keygen —
// nothing network-bearing ever runs in these tests.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  copyFileSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// test -> devnet -> scripts -> repo root (three dirnames)
const REPO_ROOT = dirname(dirname(dirname(HERE)));
const REAL_SCRIPT = join(REPO_ROOT, "scripts", "devnet", "lifecycle_rehearsal.sh");
const LOCAL_RPC = "http://127.0.0.1:8899";
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const DEVNET_RPC = "https://api.devnet.solana.com";

// Hermetic skeleton: a copy of the REAL orchestrator (the file under test)
// inside a throwaway REPO_ROOT, plus the minimal files the script checks
// before its first operational command (salvor-bots and protocol sdk dists
// must exist). HOME is redirected so the script's own solana-path prepend
// resolves to empty directories and cannot shadow the stubs. Stub commands
// are created in an exec-safe directory under the repo's target/.
function makeEnv(tag) {
  const root = mkdtempSync(join(REPO_ROOT, "target", `rpc-guard-${tag}-`));
  const stubDir = join(root, "stubs");
  const log = join(root, "stub-commands.log");
  mkdirSync(stubDir, { recursive: true });
  const stub = (name, exitCode = 0) => {
    const p = join(stubDir, name);
    writeFileSync(
      p,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$0 $*" >> ${JSON.stringify(log)}\nexit ${exitCode}\n`,
    );
    chmodSync(p, 0o755);
  };
  for (const s of ["solana", "solana-test-validator", "node", "pnpm", "cargo", "gcc"]) stub(s);
  // keygen is the orchestrator's FIRST operational command; it fails fast so
  // the accepted-URL case stops deterministically right after the guard.
  stub("solana-keygen", 1);
  const repo = join(root, "repo");
  const scriptsDir = join(repo, "scripts", "devnet");
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(REAL_SCRIPT, join(scriptsDir, "lifecycle_rehearsal.sh"));
  chmodSync(join(scriptsDir, "lifecycle_rehearsal.sh"), 0o755);
  mkdirSync(join(repo, "sdk", "dist"), { recursive: true });
  writeFileSync(join(repo, "sdk", "dist", "index.js"), "");
  const salvor = join(root, "salvor-bots");
  mkdirSync(join(salvor, "fleet-core", "dist"), { recursive: true });
  writeFileSync(join(salvor, "fleet-core", "dist", "index.js"), "");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return {
    root,
    repo,
    script: join(scriptsDir, "lifecycle_rehearsal.sh"),
    stubDir,
    log,
    salvor,
    home,
  };
}

function runRehearsal(env, args) {
  return spawnSync("bash", [env.script, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: env.home, PATH: `${env.stubDir}:${process.env.PATH ?? ""}` },
  });
}

describe("lifecycle_rehearsal.sh local-RPC execution boundary (P1)", () => {
  for (const [label, badUrl] of [
    ["a mainnet RPC URL", PUBLIC_RPC],
    ["a devnet RPC URL", DEVNET_RPC],
  ]) {
    test(`rejects ${label} BEFORE any operational command`, () => {
      const env = makeEnv(label.includes("devnet") ? "devnet" : "mainnet");
      try {
        const r = runRehearsal(env, ["--url", badUrl, "--salvor-bots", env.salvor]);
        assert.equal(
          r.status,
          3,
          `expected refusal exit 3, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
        assert.match(r.stderr, /REFUSING/);
        assert.match(r.stderr, new RegExp(badUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(r.stderr, /local validator endpoint/);
        // ORDERING PROOF: zero external commands executed — the stub log was
        // never even created (no keygen, no solana CLI, no validator, no node).
        assert.equal(existsSync(env.log), false, "an external command ran before the RPC guard");
        // No artifacts/keys directories were created either.
        assert.equal(existsSync(join(env.repo, "target", "lifecycle-rehearsal")), false);
      } finally {
        rmSync(env.root, { recursive: true, force: true });
      }
    });
  }

  test("accepts the exact local endpoint and proceeds to the first operational command (local keygen only)", () => {
    const env = makeEnv("accept");
    try {
      const r = runRehearsal(env, ["--url", LOCAL_RPC, "--salvor-bots", env.salvor]);
      // The keygen stub fails fast by design; the point is WHERE the script
      // got to: past the RPC guard, into local keygen, and NO further.
      assert.equal(
        r.status,
        1,
        `expected the controlled keygen stop, got ${r.status}\nstderr: ${r.stderr}`,
      );
      assert.doesNotMatch(r.stderr, /REFUSING/);
      assert.ok(
        existsSync(env.log),
        "the orchestrator never reached keygen — guard or toolchain check broke",
      );
      const cmds = readFileSync(env.log, "utf8");
      assert.match(cmds, /solana-keygen/, "first operational command must be local keygen");
      // NOTHING network-bearing or transaction-bearing ran: no solana CLI, no
      // validator boot, no driver, no airdrop.
      assert.doesNotMatch(cmds, /^.*solana(-test-validator)? /m);
      assert.doesNotMatch(cmds, /airdrop/);
      // No key material was generated (the stub exits before writing keys).
      const keysDir = join(env.repo, "target", "lifecycle-rehearsal", "keys");
      assert.equal(
        existsSync(keysDir),
        true,
        "orchestrator should have created the keys dir before keygen",
      );
      assert.equal(
        readdirSync(keysDir).filter((f) => f.endsWith(".json")).length,
        0,
        "no key files may exist",
      );
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  test("default (no --url) targets the local endpoint and is accepted", () => {
    const env = makeEnv("default");
    try {
      const r = runRehearsal(env, ["--salvor-bots", env.salvor]);
      assert.doesNotMatch(r.stderr, /REFUSING/);
      assert.ok(existsSync(env.log), "orchestrator must proceed on the default local endpoint");
      assert.match(readFileSync(env.log, "utf8"), /solana-keygen/);
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });
});
