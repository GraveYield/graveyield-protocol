// finalize_reporting.test.mjs — W1 P2 regression: mandatory report
// finalization (Markdown summary + JSON reporting stamp) and the driver's
// exit decision.
//
// W1 requires BOTH the machine-readable JSON report and the readable
// Markdown summary. These tests pin, against REAL filesystem objects:
//   1. successful JSON + Markdown generation → reporting stamped complete,
//      exit code 0;
//   2. a Markdown write failure → completeReporting reports failure naming
//      the MARKDOWN operation, the JSON is stamped reporting.complete=false
//      with the error, exit code 1;
//   3. a JSON write failure → failure names the JSON operation, exit code 1
//      (the Markdown may exist — the JSON stamp cannot);
//   4. a genuine lifecycle failure combined with a reporting failure → the
//      exit reasons list BOTH, side by side (a reporting error never
//      overwrites a real stage failure, and vice versa).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeReporting, w1ExitStatus } from "../lifecycle_rehearsal/summarize.mjs";

const PASSING_DOC = {
  started_at: "2026-11-05T00:00:00Z",
  finished_at: "2026-11-05T01:00:00Z",
  all_pass: true,
  meta: {},
  stages: [{ id: 1, name: "stage one", pass: true, detail: "ok" }],
  adversarial: [],
};
const FAILING_DOC = { ...PASSING_DOC, all_pass: false };

function tempDir() {
  return mkdtempSync(join(tmpdir(), "gy-finalize-"));
}

describe("completeReporting (mandatory Markdown + JSON reporting stamp)", () => {
  test("successful JSON and Markdown generation: ok, JSON stamped complete", () => {
    const dir = tempDir();
    try {
      const jsonPath = join(dir, "run-report.json");
      writeFileSync(jsonPath, JSON.stringify({ meta: {}, all_pass: true }) + "\n");
      const r = completeReporting(PASSING_DOC, jsonPath);
      assert.equal(r.ok, true);
      assert.equal(r.error, null);
      assert.equal(r.mdPath, join(dir, "run-report.summary.md"));
      assert.ok(existsSync(r.mdPath), "summary markdown must exist");
      const stamped = JSON.parse(readFileSync(jsonPath, "utf8"));
      assert.equal(stamped.reporting.complete, true);
      assert.equal(stamped.reporting.error, null);
      assert.equal(stamped.reporting.markdown_path, r.mdPath);
      // The stamped JSON must still carry the original report content.
      assert.equal(stamped.all_pass, true);
      assert.equal(stamped.meta && typeof stamped.meta, "object");
      // And the exit decision for a passing lifecycle + ok reporting is 0.
      assert.deepEqual(w1ExitStatus(PASSING_DOC, r), { code: 0, reasons: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Markdown write failure: fatal, named MARKDOWN, JSON stamped incomplete", () => {
    const dir = tempDir();
    try {
      const jsonPath = join(dir, "run-report.json");
      writeFileSync(jsonPath, JSON.stringify({ meta: {}, all_pass: true }) + "\n");
      // The summary target exists as a DIRECTORY → writeFileSync fails (EISDIR).
      mkdirSync(join(dir, "run-report.summary.md"));
      const r = completeReporting(PASSING_DOC, jsonPath);
      assert.equal(r.ok, false);
      assert.match(r.error, /MARKDOWN summary generation FAILED/);
      assert.match(r.error, /mandatory W1 report missing/);
      assert.equal(r.mdPath, null);
      const stamped = JSON.parse(readFileSync(jsonPath, "utf8"));
      assert.equal(stamped.reporting.complete, false);
      assert.match(stamped.reporting.error, /MARKDOWN/);
      // Exit decision: a passing lifecycle with a reporting failure is exit 1.
      const st = w1ExitStatus(PASSING_DOC, r);
      assert.equal(st.code, 1);
      assert.equal(st.reasons.length, 1);
      assert.match(st.reasons[0], /mandatory reporting incomplete/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("JSON write failure: fatal, named JSON (the Markdown may exist)", () => {
    const dir = tempDir();
    try {
      // The JSON path itself is a DIRECTORY → read+stamp fails (EISDIR), while
      // the derived markdown path (<name>.summary.md) is writable.
      const jsonPath = join(dir, "run-report.json");
      mkdirSync(jsonPath);
      const r = completeReporting(PASSING_DOC, jsonPath);
      assert.equal(r.ok, false);
      assert.match(r.error, /JSON report update FAILED/);
      assert.match(r.error, /cannot stamp reporting status/);
      assert.ok(existsSync(join(dir, "run-report.summary.md")), "markdown was written");
      const st = w1ExitStatus(PASSING_DOC, r);
      assert.equal(st.code, 1);
      assert.match(st.reasons[0], /mandatory reporting incomplete/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("JSON missing entirely: fatal (a summary cannot compensate for a missing JSON report)", () => {
    const dir = tempDir();
    try {
      const r = completeReporting(PASSING_DOC, join(dir, "absent-report.json"));
      assert.equal(r.ok, false);
      assert.match(r.error, /JSON report update FAILED/);
      // The markdown itself was still attempted/written — but the run stays
      // incomplete because the machine-readable report is missing.
      const st = w1ExitStatus(PASSING_DOC, r);
      assert.equal(st.code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w1ExitStatus (genuine failures preserved beside reporting failures)", () => {
  test("passing lifecycle + ok reporting → exit 0", () => {
    assert.deepEqual(w1ExitStatus(PASSING_DOC, { ok: true, error: null }), {
      code: 0,
      reasons: [],
    });
  });

  test("failing lifecycle + ok reporting → exit 1 with the LIFECYCLE reason", () => {
    const st = w1ExitStatus(FAILING_DOC, { ok: true, error: null });
    assert.equal(st.code, 1);
    assert.equal(st.reasons.length, 1);
    assert.match(st.reasons[0], /lifecycle results/);
    assert.match(st.reasons[0], /FAILED/);
  });

  test("failing lifecycle + failing reporting → BOTH reasons, side by side", () => {
    const st = w1ExitStatus(FAILING_DOC, {
      ok: false,
      error: "MARKDOWN summary generation FAILED — boom",
    });
    assert.equal(st.code, 1);
    assert.equal(st.reasons.length, 2);
    // The genuine stage failure comes FIRST and is never overwritten by the
    // reporting error; the reporting failure is named in full.
    assert.match(st.reasons[0], /lifecycle results/);
    assert.match(st.reasons[1], /mandatory reporting incomplete/);
    assert.match(st.reasons[1], /MARKDOWN summary generation FAILED/);
  });

  test("passing lifecycle + failing reporting → exit 1 (no silent success)", () => {
    const st = w1ExitStatus(PASSING_DOC, { ok: false, error: "JSON report update FAILED — x" });
    assert.equal(st.code, 1);
    assert.match(st.reasons[0], /JSON report update FAILED/);
  });

  test("null/undefined reporting is tolerated (defensive) and treated as ok", () => {
    assert.deepEqual(w1ExitStatus(PASSING_DOC, null), { code: 0, reasons: [] });
    assert.equal(w1ExitStatus(FAILING_DOC, null).code, 1);
  });
});
