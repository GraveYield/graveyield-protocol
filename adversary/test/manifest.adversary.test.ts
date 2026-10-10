// SPDX-License-Identifier: Apache-2.0
//
// ADV-FM — the battery's self-audit. The taxonomy in src/taxonomy.ts is
// the contract between the roadmap's fifteen threat classes and the
// tests that attack them; this suite enforces it. If a class loses its
// last case, or a case drifts from its class, the battery itself fails.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { THREAT_CLASSES, CASES } from "../src/index.js";

describe("ADV-FM — manifest integrity", () => {
  test("every roadmap threat class has at least one case", () => {
    const covered = new Set(CASES.map((c) => c.threatClass));
    const missing = THREAT_CLASSES.filter((c) => !covered.has(c));
    assert.deepEqual(missing, [], `uncovered threat classes: ${missing.join(", ")}`);
  });

  test("no case cites a class outside the roadmap taxonomy", () => {
    const known = new Set<string>(THREAT_CLASSES);
    const foreign = CASES.filter((c) => !known.has(c.threatClass));
    assert.deepEqual(foreign.map((c) => c.id), []);
  });

  test("case ids are unique and well-formed", () => {
    const ids = CASES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate case id");
    for (const id of ids) {
      assert.match(id, /^ADV-[A-Z]{2,4}-\d{2}$/, `malformed case id: ${id}`);
    }
  });

  test("every case states what it proves", () => {
    for (const c of CASES) {
      assert.ok(c.proves.length >= 20, `${c.id} must state what it proves`);
      if (c.verdict === "refused") {
        assert.ok(c.expected, `${c.id} refused cases must name the expected refusal`);
      }
      if (c.verdict === "finding") {
        assert.match(c.finding ?? "", /^F\d+$/, `${c.id} findings must cite an F-id`);
      }
    }
  });

  test("every verdict kind is one of refused / pinned / finding", () => {
    for (const c of CASES) {
      assert.ok(["refused", "pinned", "finding"].includes(c.verdict));
    }
  });

  test("the battery's center of gravity is refusals", () => {
    // The roadmap goal is refusal-first; a battery dominated by
    // pinned/finding cases would be a confession, not a proof.
    const refused = CASES.filter((c) => c.verdict === "refused").length;
    const other = CASES.length - refused;
    assert.ok(refused >= other, `refused=${refused} must be >= pinned/finding=${other}`);
  });
});
