// summarize_esc.test.mjs — W1 regression: the Markdown summary's table-cell
// escaping (CodeQL alert #1 — js/incomplete-string-escaping-or-encoding).
//
// summarize.mjs renders free-form stage/adversarial detail strings into
// Markdown table rows. esc() must escape EVERY backslash BEFORE escaping
// pipes: a cell value containing `\|` (or a trailing `\`) under the old
// pipe-only order produced `\\|` — the doubled backslash renders as a
// literal `\` and the pipe stayed a LIVE cell separator, silently adding a
// column to the generated run summary. These tests pin the corrected
// behavior end-to-end: any future escape-order regression breaks the
// column-count assertions below.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { esc, renderSummary } from "../lifecycle_rehearsal/summarize.mjs";

// Splits a Markdown table row on cell separators. A `|` is a separator iff
// it is preceded by an EVEN number of consecutive backslashes (an odd run
// escapes the pipe and belongs to the cell content).
function splitCells(row) {
  const cells = [];
  let cur = "";
  let backslashes = 0;
  for (const ch of row) {
    if (ch === "\\") {
      backslashes += 1;
      cur += ch;
      continue;
    }
    if (ch === "|" && backslashes % 2 === 0) {
      cells.push(cur);
      cur = "";
      backslashes = 0;
      continue;
    }
    backslashes = 0;
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

describe("summarize.mjs Markdown cell escaping (esc)", () => {
  test("plain text passes through unchanged", () => {
    assert.equal(esc("plain detail"), "plain detail");
  });

  test("nullish values become the empty string", () => {
    assert.equal(esc(null), "");
    assert.equal(esc(undefined), "");
  });

  test("pipes are escaped so a cell stays one cell", () => {
    assert.equal(esc("a|b"), "a\\|b");
    assert.equal(esc("x|y|z"), "x\\|y\\|z");
  });

  test("REGRESSION (CodeQL alert #1): backslashes are escaped BEFORE pipes", () => {
    // Old order: esc("a\\|b") === "a\\\\|b" (live pipe). Corrected order:
    assert.equal(esc("a\\|b"), "a\\\\\\|b");
    // A lone trailing backslash must not swallow the next character.
    assert.equal(esc("trailing\\"), "trailing\\\\");
    // Re-escaping an already-escaped cell keeps it a SINGLE cell (all pipes
    // stay odd-backslash-escaped — no live separator may ever appear).
    assert.equal(splitCells(`| ${esc(esc("a\\|b"))} |`).length, 3);
    // The escaped output never leaves a live pipe in the cell.
    assert.equal(splitCells(`| ${esc("a\\|b")} |`).length, 3);
  });

  test("renderSummary: hostile stage/adversarial strings keep the table shape", () => {
    const doc = {
      started_at: "2026-11-05T00:00:00Z",
      finished_at: "2026-11-05T01:00:00Z",
      all_pass: true,
      stages: [
        {
          id: 1,
          name: "stage with | pipe and \\ backslash",
          pass: true,
          detail: "d\\|d | tail\\",
        },
      ],
      adversarial: [
        {
          id: "A1",
          name: "adv\\|name|pipe",
          expected: { code: 6011 },
          observed: { code: 6011 },
          pass: true,
          zero_movement: { proved: true },
        },
      ],
    };
    const md = renderSummary(doc);
    const rows = md.split("\n").filter((l) => l.startsWith("|"));
    assert.ok(rows.length > 0, "summary must contain table rows");
    for (const row of rows) {
      // Structural separators are the ONLY even-backslash-preceded pipes;
      // header `|---|` rows are pure separators.
      const cells = splitCells(row);
      if (row.includes("stage with")) {
        // Stage table: | # | Stage | Result | Detail | → 4 cells → 6 split
        // segments (leading + trailing empties included).
        assert.equal(cells.length, 6, `stage row lost its column shape: ${row}`);
        assert.equal(cells[2].trim(), "stage with \\| pipe and \\\\ backslash");
        assert.equal(cells[4].trim(), "d\\\\\\|d \\| tail\\\\");
      }
      if (row.includes("adv\\\\\\|name")) {
        // Adversarial table: | ID | Case | Expected | Observed | Result |
        // Zero movement | → 6 cells → 8 segments.
        assert.equal(cells.length, 8, `adversarial row lost its column shape: ${row}`);
      }
    }
  });
});
