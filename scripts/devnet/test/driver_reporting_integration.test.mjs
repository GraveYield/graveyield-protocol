// driver_reporting_integration.test.mjs — W1 P2 regression (second
// independent review): the REAL driver's early-failure path produces the
// mandatory reporting artifacts.
//
// finalize_reporting.test.mjs pins the helper functions in isolation; this
// file spawns `drive_lifecycle.mjs` itself and proves, end to end, that an
// EARLY lifecycle failure (a failure that happens before any stage has
// passed, including the stage-1 RPC-endpoint guard) finalizes through the
// SAME mandatory-reporting mechanism as normal completion:
//   - the process exits non-zero;
//   - the JSON report exists, carries the original failure reason (a failed
//     "FATAL" report entry + a top-level `failure` field), and is stamped
//     with the explicit `reporting` marker;
//   - the Markdown summary exists next to the JSON and renders the failure.
//
// Two early-failure variants are exercised, both strictly local:
//   1. a non-rehearsal endpoint (127.0.0.1:1 — a CLOSED local port) → the
//      driver's stage-1 endpoint guard failFasts BEFORE any RPC call: the
//      report must contain ONLY the FATAL entry (no stage-1 entry), proving
//      the guard fired before any operational work;
//   2. the exact rehearsal endpoint (127.0.0.1:8899) with NO validator
//      listening → stage 1 fails on its first RPC call and failFasts: the
//      report must contain the failed stage-1 entry (connection error) plus
//      the FATAL entry.
// The sandbox never exposes a public cluster and the driver's own guard
// refuses any non-local endpoint, so these spawns cannot touch Devnet or
// Mainnet.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import net from "node:net";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  cpSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";

const HERE = dirname(fileURLToPath(import.meta.url));
// test -> devnet -> scripts -> repo root (three dirnames)
const REPO_ROOT = dirname(dirname(dirname(HERE)));
const DRIVER = join(REPO_ROOT, "scripts", "devnet", "lifecycle_rehearsal", "drive_lifecycle.mjs");
const LOCAL_RPC = "http://127.0.0.1:8899";
// A CLOSED local port: not the rehearsal endpoint, so the guard must refuse
// it — and even if the guard were broken, the subsequent RPC would fail
// instantly against nothing (this test can never reach a public cluster).
const CLOSED_LOCAL_RPC = "http://127.0.0.1:1";

// Throwaway fixture pubkeys (generated once for this suite; never key
// material, never funded, never used on any cluster).
const FIX = {
  pool: "7Sb4Uk78giExBKhLHn2Wgiuv6L8yjeoCsTzMuQBjErXH",
  coin_vault: "5irCT4jtbdogJnxUkVGpu4RJziXLyJ5qD2Zejoa12uAe",
  pc_vault: "GBkf6cUeSADkH5xdyd74etm14wHm5Rh8GbXRRkNvAq5R",
  lp_mint: "5uJjy6BP9b1sue41GMK4SH2y9VK1ufW1FRypxXFBHJWS",
  memecoin_mint: "5W8vWopwY4EKuYcmFWDVYoPfbeinAzevgbnRvhrdiHce",
  lp_ata: "HzUrQtqq7K9Wi6H6AJaKLJqvWzDyjNnqeiGfzeGnwJSH",
};

// The driver must not find a live validator on 8899 (if one ever is, the
// spawn would execute a REAL rehearsal — refuse to run instead).
function portClosed(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.on("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.on("error", () => resolve(true));
    s.setTimeout(250, () => {
      s.destroy();
      resolve(true);
    });
  });
}

// Build the minimal, fully isolated driver environment: throwaway keys,
// fixture manifest/plan/pins, and a fixture "salvor-bots" checkout whose
// dist is the REPO's own built SDK (it applies the same web3compat patch the
// real salvor SDK applies) with @solana/web3.js symlinked to the workspace's
// resolved copy so module identities match exactly as in a real run.
function makeEnv(tag) {
  const base = join(REPO_ROOT, "target");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, `drv-report-${tag}-`));
  const artifacts = join(root, "artifacts");
  const fixtures = join(root, "fixtures");
  const keys = join(root, "keys");
  for (const d of [artifacts, fixtures, keys]) mkdirSync(d, { recursive: true });

  writeFileSync(
    join(fixtures, "manifest.json"),
    JSON.stringify({
      pool_address: FIX.pool,
      amm_program: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
      market_program: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      base_is_coin_side: true,
      _fetched_at: "2026-11-06T00:00:00Z",
      _rpc: LOCAL_RPC,
      accounts: {
        coin_vault: { pubkey: FIX.coin_vault },
        pc_vault: { pubkey: FIX.pc_vault },
      },
    }) + "\n",
  );
  writeFileSync(
    join(artifacts, "local_plan.json"),
    JSON.stringify({
      lp_mint: FIX.lp_mint,
      memecoin_mint: FIX.memecoin_mint,
      holders: { salvor: { lp_ata: FIX.lp_ata } },
    }) + "\n",
  );
  // The pin table is only read AFTER stage 1's first RPC — these early
  // failures never reach it; the shape is enough for the report metadata.
  writeFileSync(
    join(artifacts, "sha256.txt"),
    JSON.stringify({ scanner: { file: null, sha256: null }, vault: { file: null, sha256: null } }) +
      "\n",
  );
  // Seven throwaway keypairs (nacl-generated; the driver only loads them).
  for (const k of [
    "authority",
    "intruder",
    "activity_oracle",
    "launch_oracle",
    "salvor",
    "claimant_a",
    "claimant_b",
  ]) {
    writeFileSync(
      join(keys, `${k}.json`),
      JSON.stringify(Array.from(nacl.sign.keyPair().secretKey)),
    );
  }

  // Fixture salvor checkout: package.json + dist (the repo's built SDK) +
  // symlinked @solana/web3.js + empty fleet-core/monitor dist stubs.
  const salvor = join(root, "salvor-bots");
  mkdirSync(join(salvor, "dist"), { recursive: true });
  writeFileSync(
    join(salvor, "package.json"),
    JSON.stringify({ name: "salvor-bots-fixture", private: true, type: "module" }) + "\n",
  );
  cpSync(join(REPO_ROOT, "sdk", "dist"), join(salvor, "dist"), { recursive: true });
  // The fixture's node_modules is a symlink to the sdk workspace's real
  // node_modules: every dependency the copied dist resolves (@solana/web3.js,
  // bn.js, …) is the IDENTICAL module instance a real run uses.
  symlinkSync(join(REPO_ROOT, "sdk", "node_modules"), join(salvor, "node_modules"), "dir");
  mkdirSync(join(salvor, "fleet-core", "dist"), { recursive: true });
  writeFileSync(join(salvor, "fleet-core", "dist", "index.js"), "");
  mkdirSync(join(salvor, "monitor", "dist"), { recursive: true });
  writeFileSync(join(salvor, "monitor", "dist", "index.js"), "");

  return { root, artifacts, fixtures, keys, salvor };
}

function runDriver(env, url) {
  return spawnSync(
    "node",
    [
      DRIVER,
      "--url",
      url,
      "--artifacts",
      env.artifacts,
      "--fixtures",
      env.fixtures,
      "--keys",
      env.keys,
      // NOTE: the driver's documented arg spelling is camelCase --salvorBots
      // (the historical W1 "fix 1").
      "--salvorBots",
      env.salvor,
    ],
    { encoding: "utf8", cwd: REPO_ROOT, timeout: 120_000 },
  );
}

function readRunReport(artifacts) {
  const files = readdirSync(artifacts).filter((f) => /^run-report-.*\.json$/.test(f));
  assert.equal(files.length, 1, `exactly one run report expected, got: ${files.join(", ")}`);
  const jsonPath = join(artifacts, files[0]);
  const doc = JSON.parse(readFileSync(jsonPath, "utf8"));
  const mdPath = jsonPath.replace(/\.json$/, "") + ".summary.md";
  return { jsonPath, doc, mdPath, md: readFileSync(mdPath, "utf8") };
}

describe("drive_lifecycle.mjs early failures produce mandatory reporting (integration)", () => {
  test("non-rehearsal endpoint: guard failFasts BEFORE any RPC, both reports generated", async (t) => {
    if (!(await portClosed(1)))
      t.skip("port 1 unexpectedly open on 127.0.0.1 — hermeticity cannot be guaranteed");
    const env = makeEnv("guard");
    try {
      const r = runDriver(env, CLOSED_LOCAL_RPC);
      assert.ok(r.status !== 0, `early failure must exit non-zero (got ${r.status})`);
      assert.match(r.stderr, /FATAL:/);
      assert.ok(
        r.stderr.includes(CLOSED_LOCAL_RPC),
        "the failure output must name the refused endpoint",
      );
      const { doc, mdPath, md } = readRunReport(env.artifacts);
      // The JSON is stamped with the explicit reporting marker and reports
      // itself as complete (both files were generated).
      assert.ok(doc.reporting, "the JSON must carry the reporting stamp");
      assert.equal(doc.reporting.complete, true);
      assert.equal(doc.reporting.markdown_path, mdPath);
      assert.equal(doc.reporting.error, null);
      // The original failure reason is preserved in the report itself.
      assert.match(String(doc.failure), /RPC endpoint is http:\/\/127\.0\.0\.1:1/);
      assert.equal(doc.all_pass, false);
      // ORDERING PROOF: the guard fired before stage 1 did anything — the
      // report contains ONLY the FATAL entry, no (numeric) stage-1 entry.
      assert.equal(
        doc.stages.length,
        1,
        `expected only the FATAL entry: ${JSON.stringify(doc.stages)}`,
      );
      assert.equal(doc.stages[0].id, "FATAL");
      assert.equal(doc.stages[0].pass, false);
      // The Markdown exists next to the JSON and renders the failure.
      assert.ok(existsSync(mdPath), "the mandatory Markdown must exist");
      assert.match(md, /all_pass: false/);
      assert.match(md, /FAIL/);
      assert.match(md, /early failure — mandatory reporting finalization/);
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  test("rehearsal endpoint with no validator: stage-1 RPC failure failFasts, both reports generated", async (t) => {
    if (!(await portClosed(8899))) {
      t.skip(
        "a validator is listening on 127.0.0.1:8899 — refusing to spawn the driver against it",
      );
    }
    const env = makeEnv("novalidator");
    try {
      const r = runDriver(env, LOCAL_RPC);
      assert.ok(r.status !== 0, `early failure must exit non-zero (got ${r.status})`);
      assert.match(r.stderr, /FATAL:/);
      assert.match(r.stderr, /stage 1/);
      const { doc, mdPath, md } = readRunReport(env.artifacts);
      assert.ok(doc.reporting, "the JSON must carry the reporting stamp");
      assert.equal(doc.reporting.complete, true);
      assert.equal(doc.reporting.markdown_path, mdPath);
      assert.equal(doc.all_pass, false);
      // Stage 1 failed with its connection error, THEN the FATAL entry.
      assert.ok(doc.stages.length >= 2, `expected stage 1 + FATAL: ${JSON.stringify(doc.stages)}`);
      const s1 = doc.stages.find((s) => s.id === 1);
      assert.ok(s1, "the failed stage-1 entry must be recorded");
      assert.equal(s1.pass, false);
      assert.match(s1.reason, /fetch failed|ECONNREFUSED|connect|Connect/i);
      assert.equal(doc.stages[doc.stages.length - 1].id, "FATAL");
      // The Markdown exists and renders the failed stage.
      assert.ok(existsSync(mdPath), "the mandatory Markdown must exist");
      assert.match(md, /all_pass: false/);
      assert.match(md, /FAIL/);
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });
});
