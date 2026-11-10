// SPDX-License-Identifier: Apache-2.0
//
// ns3_provenance_wrapper.test.mjs — behaviour tests for the bounded,
// fail-closed shell execution wrapper of the NS-3 provenance checker
// (scripts/devnet/run_ns3_check_provenance.sh).
//
// Fully offline and dependency-free: every scenario drives the REAL wrapper
// against tiny mock "checker" commands (fixtures written to a throwaway
// temp dir) that reproduce the exact output contract of
// ns3_check_provenance.mjs — `PASS [...]` lines, the final
// `PROVENANCE OK — ...` verdict on stdout, `FAIL [...]` / `PROVENANCE
// FAILED` on failure — plus hang behaviour (SIGTERM-immune) for the
// bounded-termination paths. The real 497 MB platform-tools archive and
// the real checker are NEVER run here.
//
// Covered decision matrix (mirrors the reviewed CI rule, PR #95):
//   1. normal success                     -> wrapper exit 0, output relayed
//   2. verdict recorded, then hang        -> bounded teardown (TERM -> grace
//                                            -> KILL), verdict stands, 0
//   3. timeout without a verdict          -> fail closed, 124
//   4. missing / truncated verdict        -> fail closed, 1
//   5. explicit provenance failure        -> fail closed, 1 (markers beat
//                                            a success verdict)
//   6. non-zero checker exit              -> fail closed, 1
//   7. temp log cleanup (success/failure) -> no "ns3-check-" leftovers
//   8. wrapper interrupted (SIGTERM)      -> checker killed, logs cleaned,
//                                            exit 143
//   +  invalid wrapper arguments / non-executable command -> exit 2 before
//      anything runs
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WRAPPER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "run_ns3_check_provenance.sh",
);

const OK_LINE = "PROVENANCE OK — the bytes to deploy are exactly the recorded deployment digests.";
const HARD_KILL_MS = 60_000; // absolute guard: no scenario may exceed this

function sh(name, body) {
  const p = path.join(FIXTURES, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function ns3CheckLeftovers() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("ns3-check-"));
}

/** Run the wrapper; resolve { code, stdout, stderr, ms }. */
function runWrapper(args, { env = {}, timeoutMs = HARD_KILL_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(WRAPPER, args, {
      cwd: path.dirname(WRAPPER),
      env: { ...process.env, TMPDIR: tmpdir(), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    let settled = false;
    const finish = (killed) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (killed) child.kill("SIGKILL");
      resolve({ code: child.exitCode ?? null, stdout, stderr, ms: Date.now() - started });
    };
    const guard = setTimeout(() => finish(true), timeoutMs);
    child.on("close", () => finish(false));
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function until(fn, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let FIXTURES;

describe("run_ns3_check_provenance.sh (bounded provenance checker execution)", () => {
  test("fixtures and wrapper exist", () => {
    FIXTURES = mkdtempSync(path.join(tmpdir(), "gy-wrapper-test-"));
    sh(
      "mock_ok.sh",
      `
      echo "PASS [digest-scanner] sha256 e24ddc5e matches the manifest pin"
      echo "PASS [arch-scanner] SBPF v0 confirmed"
      echo "${OK_LINE}"
      exit 0`,
    );
    sh(
      "mock_hang_after_verdict.sh",
      `
      trap '' TERM
      echo "PASS [digest-scanner] sha256 e24ddc5e matches the manifest pin"
      echo "${OK_LINE}"
      while :; do sleep 5; done`,
    );
    sh(
      "mock_timeout_no_verdict.sh",
      `
      trap '' TERM
      echo "PASS [digest-scanner] sha256 e24ddc5e matches the manifest pin"
      while :; do sleep 5; done`,
    );
    sh(
      "mock_missing_verdict.sh",
      `
      echo "PASS [digest-scanner] sha256 e24ddc5e matches the manifest pin"
      exit 0`,
    );
    sh(
      "mock_truncated_verdict.sh",
      `
      printf 'PROVENAN'
      exit 0`,
    );
    sh(
      "mock_explicit_failure.sh",
      `
      echo "PASS [digest-scanner] sha256 e24ddc5e matches the manifest pin"
      echo "FAIL [digest-vault] sha256 MISMATCH: got deadbeef, manifest pins e24ddc5e"
      echo "PROVENANCE FAILED — deployment gate stays CLOSED." >&2
      exit 1`,
    );
    sh(
      "mock_failure_with_verdict.sh",
      `
      echo "FAIL [digest-vault] sha256 MISMATCH"
      echo "${OK_LINE}"
      exit 1`,
    );
    sh(
      "mock_exit7.sh",
      `
      echo "some partial output"
      exit 7`,
    );
    sh(
      "mock_hang_forever.sh",
      `
      trap '' TERM
      echo "$$" > "\$MOCK_PIDFILE"
      while :; do sleep 5; done`,
    );
    // sanity: the wrapper must exist and be executable
    let st = null;
    try {
      st = statSync(WRAPPER);
    } catch {
      st = null;
    }
    assert.ok(st, `wrapper missing at ${WRAPPER}`);
  });

  test("(1) normal successful checker execution -> exit 0, output relayed", async () => {
    const r = await runWrapper(["--", path.join(FIXTURES, "mock_ok.sh")]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("PASS [digest-scanner]"), "PASS lines relayed on stdout");
    assert.ok(r.stdout.includes("PROVENANCE OK"), "verdict relayed on stdout");
    assert.ok(r.stderr.includes("bounded-provenance-check:"), "decision banner on stderr");
    assert.match(r.stderr, /checker exited 0 with the recorded 'PROVENANCE OK' verdict/);
    assert.ok(r.ms < HARD_KILL_MS);
  });

  test("(2) verdict recorded then hang -> bounded TERM/grace/KILL, verdict stands -> exit 0", async () => {
    const r = await runWrapper([
      "--timeout",
      "2",
      "--kill-grace",
      "1",
      "--",
      path.join(FIXTURES, "mock_hang_after_verdict.sh"),
    ]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("PROVENANCE OK"), "recorded verdict relayed");
    // The mock ignores SIGTERM: the wrapper MUST escalate to SIGKILL for the
    // run to end at all — and it must end well before the hard guard.
    assert.ok(r.ms >= 2_000, "wrapper respected the 2s timeout");
    assert.ok(r.ms < 15_000, `bounded run ended promptly (${r.ms}ms)`);
    assert.match(r.stderr, /verdict was recorded and stands/);
  });

  test("(3) timeout WITHOUT a success verdict -> fail closed with exit 124", async () => {
    const r = await runWrapper([
      "--timeout",
      "2",
      "--kill-grace",
      "1",
      "--",
      path.join(FIXTURES, "mock_timeout_no_verdict.sh"),
    ]);
    assert.equal(r.code, 124, `stderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes("PROVENANCE OK"));
    assert.match(r.stderr, /bounded termination fired after 2s but NO success verdict/);
    assert.ok(r.ms < 15_000, `bounded run ended promptly (${r.ms}ms)`);
  });

  test("(4) missing or truncated verdict -> fail closed with exit 1", async () => {
    const missing = await runWrapper(["--", path.join(FIXTURES, "mock_missing_verdict.sh")]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /verdict was NOT recorded \(checker rc=0\)/);
    assert.match(missing.stderr, /captured checker stdout/);

    const truncated = await runWrapper(["--", path.join(FIXTURES, "mock_truncated_verdict.sh")]);
    assert.equal(truncated.code, 1);
    assert.match(truncated.stderr, /verdict was NOT recorded/);
  });

  test("(5) explicit provenance failure -> fail closed with exit 1", async () => {
    const r = await runWrapper(["--", path.join(FIXTURES, "mock_explicit_failure.sh")]);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("FAIL [digest-vault]"), "FAIL lines relayed");
    assert.match(r.stderr, /explicit verification failure/);
    assert.match(r.stderr, /gate stays CLOSED/);

    // Failure markers beat a (forged) success verdict: fail closed anyway.
    const forged = await runWrapper(["--", path.join(FIXTURES, "mock_failure_with_verdict.sh")]);
    assert.equal(forged.code, 1);
    assert.match(forged.stderr, /explicit verification failure/);
  });

  test("(6) non-zero checker exit without verdict -> fail closed with exit 1", async () => {
    const r = await runWrapper(["--", path.join(FIXTURES, "mock_exit7.sh")]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /checker rc=7/);
    assert.match(r.stderr, /verdict was NOT recorded/);
  });

  test("(7) temporary logs are cleaned up on success and failure", async () => {
    const beforeSuccess = ns3CheckLeftovers();
    const ok = await runWrapper(["--", path.join(FIXTURES, "mock_ok.sh")]);
    assert.equal(ok.code, 0);
    const afterSuccess = ns3CheckLeftovers();
    assert.deepEqual(
      afterSuccess.filter((n) => !beforeSuccess.includes(n)),
      [],
      `leftover temp logs after success: ${afterSuccess}`,
    );

    const beforeFail = ns3CheckLeftovers();
    const fail = await runWrapper(["--", path.join(FIXTURES, "mock_explicit_failure.sh")]);
    assert.equal(fail.code, 1);
    const afterFail = ns3CheckLeftovers();
    assert.deepEqual(
      afterFail.filter((n) => !beforeFail.includes(n)),
      [],
      `leftover temp logs after failure: ${afterFail}`,
    );
  });

  test("(8) wrapper interrupted (SIGTERM) -> checker killed, logs cleaned, exit 143", async () => {
    const pidfile = path.join(FIXTURES, "mock.pid");
    const before = ns3CheckLeftovers();
    const child = spawn(
      WRAPPER,
      ["--timeout", "60", "--kill-grace", "1", "--", path.join(FIXTURES, "mock_hang_forever.sh")],
      {
        cwd: path.dirname(WRAPPER),
        env: { ...process.env, TMPDIR: tmpdir(), MOCK_PIDFILE: pidfile },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));

    // Wait until the mock has registered its pid, then interrupt the wrapper.
    const registered = await until(() => {
      try {
        return Number(readPid(pidfile)) > 0;
      } catch {
        return false;
      }
    });
    assert.ok(registered, "mock checker never registered its pid");
    const mockPid = Number(readPid(pidfile));
    assert.ok(isAlive(mockPid), "mock checker should be running before the interrupt");

    const started = Date.now();
    child.kill("SIGTERM");
    const exitCode = await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 30_000);
      child.on("close", (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    const ms = Date.now() - started;

    assert.equal(exitCode, 143, `stderr: ${stderr}`);
    assert.ok(ms < 20_000, `interrupt handled promptly (${ms}ms)`);
    // The TERM-immune checker must have been terminated (grace -> SIGKILL).
    assert.ok(await until(() => !isAlive(mockPid)), "checker survived the interrupt");
    // Temp logs are gone.
    const after = ns3CheckLeftovers();
    assert.deepEqual(
      after.filter((n) => !before.includes(n)),
      [],
      `leftover temp logs after interrupt: ${after}`,
    );
    assert.match(stderr, /interrupted by SIGTERM/);
  });

  test("(extra) invalid arguments and non-executable command -> exit 2, nothing runs", async () => {
    const badTimeout = await runWrapper([
      "--timeout",
      "abc",
      "--",
      "/tmp/gy-wrapper-test-nonexistent",
    ]);
    assert.equal(badTimeout.code, 2);
    assert.match(badTimeout.stderr, /must be a positive integer/);

    const unknown = await runWrapper(["--nonsense", "--", "/tmp/gy-wrapper-test-nonexistent"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown wrapper argument/);

    const noCmd = await runWrapper([]);
    assert.equal(noCmd.code, 2);
    assert.match(noCmd.stderr, /no checker command given after --/);

    const notExecutable = await runWrapper(["--", "/tmp/gy-wrapper-test-does-not-exist"]);
    assert.equal(notExecutable.code, 2);
    assert.match(notExecutable.stderr, /not executable/);
  });
});

function readPid(p) {
  return readFileSync(p, "utf8").trim();
}
