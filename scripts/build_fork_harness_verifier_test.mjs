#!/usr/bin/env node
// build_fork_harness_verifier_test.mjs — regression tests for the fail-closed
// prerequisite verifier embedded in scripts/build_fork_harness.sh (step [6/7]).
//
// Background (PR #100 closeout, 2026-11): the verifier originally required
// every manifest-referenced fixture to be NON-EMPTY, which was a false
// positive for vault-signer PDA fixtures — a Raydium vault signer carries
// lamports but zero bytes of on-chain data, and the fetcher faithfully
// records an unfunded PDA as an empty system account. CI failed with
// "vault_signer.bin (empty)" / "vault_signer2.bin (empty)" on a perfectly
// healthy fetch. The verifier now checks each file BYTE-EXACTLY against the
// data_len recorded in the manifest by the fetcher (strictly stronger than
// non-empty: it also catches truncated/stale downloads), falling back to
// non-empty only for entries without a data_len and for the three locally
// built ELFs.
//
// Method: the real VERIFY block is extracted verbatim from the harness
// script, the FIXTURES constant is redirected to a synthetic directory, and
// the block is executed once per scenario. The fetcher's data_len injection
// loop is mirrored verbatim and checked for the same semantics.
//
// Run from anywhere:
//
//     node scripts/build_fork_harness_verifier_test.mjs
//
// Exits non-zero if any scenario fails. node >= 18 only — no new deps.

import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(__dirname, "build_fork_harness.sh");
const harness = readFileSync(HARNESS, "utf8");

// ---- extract the VERIFY heredoc body verbatim ------------------------------
const start = harness.indexOf("node --input-type=module <<'VERIFY'");
const end = harness.indexOf("\nVERIFY\n", start);
if (start < 0 || end < 0) throw new Error("VERIFY block not found in harness script");
const verifyBody = harness.slice(start, end).replace(/^node --input-type=module <<'VERIFY'\n/, "");

let passed = 0;
let failed = 0;
const base = mkdtempSync(join(tmpdir(), "forkprereq-"));

function runScenario(name, build) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  build(dir);
  const codeFile = join(dir, "_verify.mjs");
  writeFileSync(
    codeFile,
    verifyBody.replace(
      'const FIXTURES = "programs/grave-vault/tests/fixtures";',
      `const FIXTURES = ${JSON.stringify(dir)};`,
    ),
  );
  const r = spawnSync("node", [codeFile], { encoding: "utf8" });
  const code = r.status ?? 1;
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { code, out };
}

function expect(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} — ${detail}`);
  }
}

const acct = (file, len) => ({ pubkey: "Pk", lamports: 1, owner: "Owner", file, data_len: len });
const BUILT = ["grave_scanner.so", "grave_vault.so", "jupiter_v6_stub.so"];

function writeFixtures(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}
const bytes = (n) => Buffer.alloc(n, 1);

// ---- scenario a: healthy set incl. zero-length vault signers ---------------
{
  const manifest = {
    accounts: {
      pool: acct("pool.bin", 752),
      vault_signer: acct("vault_signer.bin", 0),
    },
    orientation_pool: {
      accounts: {
        pool: acct("pool2.bin", 752),
        vault_signer: acct("vault_signer2.bin", 0),
      },
    },
  };
  const { code, out } = runScenario("healthy", (dir) => {
    writeFixtures(dir, {
      "manifest.json": JSON.stringify(manifest),
      "pool.bin": bytes(752),
      "vault_signer.bin": bytes(0),
      "pool2.bin": bytes(752),
      "vault_signer2.bin": bytes(0),
      ...Object.fromEntries(BUILT.map((n) => [n, bytes(1024)])),
    });
  });
  expect("healthy set (0-byte vault signers + orientation) exits 0", code === 0, `code=${code} ${out}`);
  expect("healthy set prints prerequisites OK", out.includes("prerequisites OK"), out);
}

// ---- scenario b: referenced file missing -----------------------------------
{
  const manifest = { accounts: { pool: acct("pool.bin", 752) } };
  const { code, out } = runScenario("missing_file", (dir) => {
    writeFixtures(dir, {
      "manifest.json": JSON.stringify(manifest),
      ...Object.fromEntries(BUILT.map((n) => [n, bytes(1024)])),
    });
  });
  expect("missing referenced file exits 1", code === 1, `code=${code} ${out}`);
  expect("missing file reported", out.includes("pool.bin (missing)"), out);
}

// ---- scenario c: size drift vs data_len (truncated/stale) ------------------
{
  const manifest = { accounts: { pool: acct("pool.bin", 752) } };
  const { code, out } = runScenario("size_drift", (dir) => {
    writeFixtures(dir, {
      "manifest.json": JSON.stringify(manifest),
      "pool.bin": bytes(100),
      ...Object.fromEntries(BUILT.map((n) => [n, bytes(1024)])),
    });
  });
  expect("size drift exits 1", code === 1, `code=${code} ${out}`);
  expect("size drift reported with both sizes", out.includes("size 100, manifest data_len 752"), out);
}

// ---- scenario d: no data_len recorded + empty file (legacy fallback) -------
{
  const manifest = {
    accounts: {
      pool: { pubkey: "Pk", lamports: 1, owner: "Owner", file: "pool.bin" },
    },
  };
  const { code, out } = runScenario("legacy_empty", (dir) => {
    writeFixtures(dir, {
      "manifest.json": JSON.stringify(manifest),
      "pool.bin": bytes(0),
      ...Object.fromEntries(BUILT.map((n) => [n, bytes(1024)])),
    });
  });
  expect("legacy entry with empty file exits 1", code === 1, `code=${code} ${out}`);
  expect("legacy empty reported", out.includes("(empty — no data_len recorded"), out);
}

// ---- scenario e: orientation_pool absent → warn, not fatal -----------------
{
  const manifest = { accounts: { pool: acct("pool.bin", 752) } };
  const { code, out } = runScenario("no_orientation", (dir) => {
    writeFixtures(dir, {
      "manifest.json": JSON.stringify(manifest),
      "pool.bin": bytes(752),
      ...Object.fromEntries(BUILT.map((n) => [n, bytes(1024)])),
    });
  });
  expect("no orientation_pool still exits 0", code === 0, `code=${code} ${out}`);
  expect("orientation absence warned", out.includes("WARN: manifest has no orientation_pool"), out);
}

// ---- scenario f: corrupt manifest ------------------------------------------
{
  const { code, out } = runScenario("corrupt_manifest", (dir) => {
    writeFixtures(dir, { "manifest.json": "{not json", "grave_scanner.so": bytes(16) });
  });
  expect("corrupt manifest exits 1", code === 1, `code=${code} ${out}`);
  expect("corrupt manifest reported", out.includes("missing or unparseable"), out);
}

// ---- scenario g: built ELF empty --------------------------------------------
{
  const manifest = { accounts: { pool: acct("pool.bin", 752) } };
  const { code, out } = runScenario("built_elf_empty", (dir) => {
    writeFixtures(dir, {
      "manifest.json": JSON.stringify(manifest),
      "pool.bin": bytes(752),
      "grave_scanner.so": bytes(1024),
      "grave_vault.so": bytes(1024),
      "jupiter_v6_stub.so": bytes(0),
    });
  });
  expect("empty built ELF exits 1", code === 1, `code=${code} ${out}`);
  expect("empty built ELF reported", out.includes("jupiter_v6_stub.so (empty — no data_len recorded"), out);
}

// ---- scenario h: fetcher data_len injection loop (mirrored verbatim) -------
{
  // Mirror of the loop in scripts/fetch_v4_fork_fixtures.mjs; if that loop
  // ever changes shape, update this mirror and the expectations together.
  const files = { "pool.bin": bytes(752), "vault_signer.bin": bytes(0) };
  const orientationFiles = { "pool2.bin": bytes(752), "vault_signer2.bin": bytes(0) };
  const manifest = {
    accounts: { pool: acct("pool.bin", -1), vault_signer: acct("vault_signer.bin", -1) },
  };
  const orientationSection = {
    accounts: { pool: acct("pool2.bin", -1), vault_signer: acct("vault_signer2.bin", -1) },
  };
  for (const entry of Object.values(manifest.accounts)) {
    entry.data_len = files[entry.file].length;
  }
  if (orientationSection) {
    for (const entry of Object.values(orientationSection.accounts)) {
      entry.data_len = orientationFiles[entry.file].length;
    }
    manifest.orientation_pool = orientationSection;
  }
  expect("pool-1 data_len recorded", manifest.accounts.pool.data_len === 752, JSON.stringify(manifest.accounts.pool));
  expect("pool-1 zero-length vault signer data_len recorded", manifest.accounts.vault_signer.data_len === 0, JSON.stringify(manifest.accounts.vault_signer));
  expect("orientation data_len recorded", manifest.orientation_pool.accounts.pool.data_len === 752, JSON.stringify(manifest.orientation_pool.accounts.pool));
  expect("orientation vault signer data_len recorded", manifest.orientation_pool.accounts.vault_signer.data_len === 0, JSON.stringify(manifest.orientation_pool.accounts.vault_signer));
}

rmSync(base, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
