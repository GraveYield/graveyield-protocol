// SPDX-License-Identifier: Apache-2.0
//
// claims-snapshot.yml — producer-workflow validation (workstream D,
// I-06). YAML parsing alone proves nothing about behavior, so these
// tests pin the SECURITY-CRITICAL structure of the companion producer
// workflow:
//
//   * the workflow `name` is exactly `grave-snapshotter-cli` — the
//     identity the indexer publication pipeline pins as
//     GY_CLAIMS_PRODUCER_WORKFLOW (a rename on either side breaks the
//     handoff FAIL-CLOSED, which is the intent);
//   * workflow_dispatch is the ONLY trigger (no push/PR/schedule
//     producer runs);
//   * least-privilege permissions (contents: read, nothing else);
//   * REQUIRED governed inputs, fail-closed on empty/missing — the
//     sink ledger and the RPC secret gate run FIRST, before build and
//     before any network call;
//   * the RPC URL crosses into the shell ONLY as env, is consumed only
//     as a quoted "$SNAP_RPC_URL", and is never echoed;
//   * no dispatch input or secret reaches a run script via ${{ }}
//     interpolation (static injection check);
//   * the build is pinned (toolchain 1.91.1 = rust-toolchain.toml,
//     `cargo build --release --locked`);
//   * the real CLI runs with `--lock-evidence rpc` and
//     `--sink-ledger` (never silently empty);
//   * the Actions artifact is named EXACTLY `claims-artifact.json` (the
//     name the indexer handoff retrieves) with if-no-files-found: error;
//   * third-party actions are pinned to full commit SHAs;
//   * NO release, ref, push, or transaction commands exist anywhere in
//     the file (artifact-only, read-only safety envelope).
//
// KNOWN LIMITATION (stated explicitly): these tests inspect DECLARED
// structure, not GitHub's runtime behavior. The fail-closed gate order,
// secret masking, and artifact upload behavior rest on documented
// GitHub Actions semantics; the workflow's own end-to-end behavior is
// demonstrated separately (see docs/claims-snapshot-workflow.md).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      name?: string;
      permissions?: Record<string, string>;
      steps: Array<Record<string, unknown>>;
    }
  >;
}

const WORKFLOW_PATH = "../../.github/workflows/claims-snapshot.yml";

function loadWorkflow(): Workflow {
  const raw = readFileSync(new URL(WORKFLOW_PATH, import.meta.url), "utf8");
  const json = execFileSync(
    "python3",
    [
      "-c",
      "import sys,yaml,json;d=yaml.safe_load(sys.stdin.read());\nif True in d: d['on']=d.pop(True)\nprint(json.dumps(d))",
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, input: raw },
  );
  return JSON.parse(json) as Workflow;
}

/** All shell snippets the job runs (run: blocks), in order. */
function runBlocks(job: Workflow["jobs"][string]): string[] {
  return job.steps.filter((s) => typeof s["run"] === "string").map((s) => s["run"] as string);
}

function stepEnv(step: Record<string, unknown>): Record<string, unknown> {
  return ((step["env"] ?? {}) as Record<string, unknown>) ?? {};
}

describe("claims-snapshot producer workflow — security-critical structure (I-06)", () => {
  const raw = readFileSync(new URL(WORKFLOW_PATH, import.meta.url), "utf8");
  const wf = loadWorkflow();
  const job = wf.jobs["snapshot"];
  assert.ok(job, "the snapshot job exists");

  test("the workflow name is EXACTLY grave-snapshotter-cli (indexer pin lock-step)", () => {
    assert.equal(wf.name, "grave-snapshotter-cli");
  });

  test("workflow_dispatch is the ONLY trigger; all governed inputs are required", () => {
    assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"]);
    const inputs = (wf.on["workflow_dispatch"] as { inputs?: Record<string, unknown> }).inputs ?? {};
    for (const required of ["pool", "amm", "lp_mint", "commitment", "sink_ledger"]) {
      const input = inputs[required] as { required?: boolean } | undefined;
      assert.ok(input, `input ${required} exists`);
      assert.equal(input.required, true, `input ${required} is required`);
    }
    const commitment = inputs["commitment"] as { type?: string; options?: string[] };
    assert.equal(commitment.type, "choice");
    assert.deepEqual(commitment.options, ["confirmed", "finalized"], "commitment never defaults; unsupported levels impossible");
  });

  test("least-privilege permissions: contents read ONLY, job-level grants nothing more", () => {
    assert.deepEqual(wf.permissions, { contents: "read" });
    assert.equal(job.permissions, undefined, "the job does not elevate permissions");
  });

  test("the fail-closed input gate is the FIRST step and runs before checkout/build", () => {
    const steps = job.steps;
    const gateIdx = steps.findIndex((s) => String(s["name"] ?? "").includes("Fail closed"));
    assert.equal(gateIdx, 0, "the input gate is step 1");
    const checkoutIdx = steps.findIndex((s) => String(s["uses"] ?? "").startsWith("actions/checkout"));
    const buildIdx = steps.findIndex((s) => (s["name"] as string | undefined)?.includes("Build grave-snapshotter-cli"));
    assert.ok(checkoutIdx > gateIdx && buildIdx > gateIdx, "gate runs before checkout and build");
    const gateRun = runBlocks(job)[0]!;
    for (const check of ["SNAP_POOL", "SNAP_AMM", "SNAP_LP_MINT", "SNAP_COMMITMENT", "SNAP_SINK_LEDGER", "SNAP_RPC_URL"]) {
      assert.ok(gateRun.includes(check), `the gate checks ${check}`);
    }
    assert.ok(/sink_ledger is required/.test(gateRun), "an empty sink ledger is refused");
    assert.ok(/SNAPSHOTTER_RPC_URL secret is not configured/.test(gateRun), "a missing RPC secret is refused");
  });

  test("the RPC URL crosses into the shell ONLY as env, consumed quoted, never echoed", () => {
    const cliStep = job.steps.find((s) => (s["name"] as string | undefined)?.includes("Run grave-snapshotter-cli"));
    assert.ok(cliStep, "the CLI step exists");
    const env = stepEnv(cliStep);
    assert.equal(env["SNAP_RPC_URL"], "${{ secrets.SNAPSHOTTER_RPC_URL }}");
    const run = String(cliStep["run"]);
    assert.ok(run.includes('"$SNAP_RPC_URL"'), "the RPC URL is consumed as a quoted env var");
    assert.ok(!run.includes("${{"), "no expression inside the run script");
    // The URL is never echoed anywhere in the workflow.
    for (const line of raw.split("\n")) {
      if (line.includes("SNAP_RPC_URL") || line.includes("SNAPSHOTTER_RPC_URL")) {
        assert.ok(!/\becho\b/.test(line), `the RPC URL is never echoed: ${line.trim()}`);
      }
    }
    // The CLI consumes the URL only via --url "$SNAP_RPC_URL".
    assert.ok(run.includes('--url "$SNAP_RPC_URL"'));
  });

  test("no dispatch input or secret is interpolated into any run script", () => {
    for (const run of runBlocks(job)) {
      assert.ok(!run.includes("${{"), `expression inside a run block: ${run.slice(0, 80)}`);
    }
  });

  test("the real CLI runs with mandatory locker evidence and governed sink ledger", () => {
    const run = runBlocks(job).find((r) => r.includes("--out claims-artifact.json"));
    assert.ok(run, "the CLI invocation exists");
    assert.ok(run.includes("--lock-evidence rpc"), "RPC-backed locker evidence is mandatory");
    assert.ok(run.includes('--sink-ledger sink-ledger.json'), "the governed sink ledger is applied");
    assert.ok(run.includes("--out claims-artifact.json"), "the artifact path is deterministic");
  });

  test("the build is pinned: toolchain 1.91.1 + --locked + exact package/bin targets", () => {
    const toolchainStep = job.steps.find((s) => String(s["uses"] ?? "").startsWith("dtolnay/rust-toolchain"));
    assert.ok(toolchainStep, "the toolchain step exists");
    assert.equal((toolchainStep["with"] as Record<string, unknown>)["toolchain"], "1.91.1", "matches rust-toolchain.toml");
    const build = runBlocks(job).find((r) => r.includes("cargo build"));
    assert.ok(build?.includes("--locked"), "the build honors the committed Cargo.lock");
    assert.ok(build?.includes("-p grave-snapshotter --bin grave-snapshotter-cli"), "the exact producer binary is built");
  });

  test("the Actions artifact is named EXACTLY claims-artifact.json with if-no-files-found: error", () => {
    const uploads = job.steps.filter((s) => String(s["uses"] ?? "").startsWith("actions/upload-artifact"));
    assert.equal(uploads.length, 2, "artifact + provenance uploads exist");
    const main = uploads.map((u) => (u["with"] as Record<string, unknown>)["name"]).includes("claims-artifact.json");
    assert.ok(main, "the handoff artifact name matches the indexer pin (GY_CLAIMS_ARTIFACT_NAME)");
    for (const u of uploads) {
      assert.equal((u["with"] as Record<string, unknown>)["if-no-files-found"], "error", "an incomplete upload can never look like success");
    }
  });

  test("every third-party action is pinned to a full commit SHA", () => {
    for (const s of job.steps) {
      const uses = String(s["uses"] ?? "");
      if (uses.length === 0) continue;
      assert.match(uses, /@[0-9a-f]{40}/, `action pinned to a full SHA: ${uses}`);
    }
  });

  test("NO release, ref, push, or transaction commands exist anywhere (artifact-only envelope)", () => {
    // Checked against EXECUTABLE content only (run blocks + action refs);
    // comments are documentation, not behavior.
    const executable = [
      ...runBlocks(job),
      ...job.steps.map((s) => String(s["uses"] ?? "")),
    ].join("\n");
    const banned = ["gh release", "git push", "git tag", "POST /git/tags", "git/refs", "anchor build", "solana-keygen", "solana program deploy", "sendTransaction", "send-transaction", "salvage"];
    for (const b of banned) {
      assert.ok(!executable.includes(b), `banned command absent from executable content: ${b}`);
    }
  });

  test("a provenance sidecar records the exact producer commit and run identity", () => {
    const provStep = job.steps.find((s) => (s["name"] as string | undefined)?.includes("provenance"));
    assert.ok(provStep, "the provenance step exists");
    const run = String(provStep["run"]);
    for (const field of ["producer_commit_sha", "run_id", "toolchain", "artifact_sha256", "artifact_byte_length", "sink_ledger_input_sha256"]) {
      assert.ok(run.includes(field), `provenance records ${field}`);
    }
    const env = stepEnv(provStep);
    assert.equal(env["PRODUCER_COMMIT"], "${{ github.sha }}", "the commit is the dispatch commit");
    assert.equal(env["RUN_ID"], "${{ github.run_id }}", "the run identity is recorded");
  });
});
