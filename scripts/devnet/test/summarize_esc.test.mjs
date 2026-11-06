// summarize_esc.test.mjs — W1 regression: the Markdown summary's table-cell
// escaping (CodeQL alert #1 — js/incomplete-string-escaping-or-encoding).
//
// summarize.mjs renders free-form stage/adversarial detail strings into
// Markdown table rows. esc() must (1) normalize CRLF/LF/CR line breaks to a
// single space (a raw newline inside a cell would split the row and inject
// extra table lines) and (2) escape EVERY backslash BEFORE escaping pipes:
// a cell value containing `\|` (or a trailing `\`) under the old pipe-only
// order produced `\\|` — the doubled backslash renders as a literal `\` and
// the pipe stayed a LIVE cell separator, silently adding a column to the
// generated run summary. These tests pin the corrected behavior end-to-end:
// any future escape-order or newline-normalization regression breaks the
// string and column-count assertions below.
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

  test("REGRESSION (W1 review): LF and CR line breaks normalize to a single space", () => {
    // A raw newline inside a table cell would split the row and inject extra
    // table lines into the generated summary. LF, CRLF and lone CR must all
    // become a single space BEFORE the backslash/pipe escapes run.
    assert.equal(esc("row1\nrow2"), "row1 row2");
    assert.equal(esc("row1\r\nrow2"), "row1 row2");
    assert.equal(esc("a\rb"), "a b");
    // No line-break character may survive into the cell.
    for (const v of ["a\nb", "a\r\nb", "a\rb", "\n", "\r\n", "\r"]) {
      assert.ok(!/[\r\n]/.test(esc(v)), `newline survived for ${JSON.stringify(v)}`);
    }
  });

  test("REGRESSION (W1 review): combined backslashes, pipes and newlines", () => {
    // The order matters: newline normalization runs FIRST, then backslash
    // doubling, then the pipe escape. `x\\\n|y` → "x\\\ \|y" — the pipe stays
    // odd-backslash-escaped and no newline survives.
    assert.equal(esc("x\\\n|y"), "x\\\\ \\|y");
    assert.equal(esc("end\\\n"), "end\\\\ ");
    assert.equal(esc("a\nb|c\nd"), "a b\\|c d");
    for (const out of [esc("x\\\n|y"), esc("end\\\n"), esc("a\nb|c\nd")]) {
      assert.ok(!/[\r\n]/.test(out), "newline survived a combined value");
      assert.equal(splitCells(`| ${out} |`).length, 3, "combined value split the cell");
    }
  });

  test("renderSummary: multi-line stage detail stays a single table row", () => {
    const doc = {
      started_at: "2026-11-05T00:00:00Z",
      finished_at: "2026-11-05T01:00:00Z",
      all_pass: true,
      stages: [
        {
          id: 1,
          name: "multiline stage",
          pass: true,
          detail: "line1\nline2 | col\r\nline3",
        },
      ],
      adversarial: [],
    };
    const md = renderSummary(doc);
    const stageRows = md.split("\n").filter((l) => l.includes("multiline stage"));
    assert.equal(stageRows.length, 1, "a newline in a cell split the row");
    assert.equal(splitCells(stageRows[0]).length, 6, "stage row lost its column shape");
    assert.ok(!/[\r\n]/.test(stageRows[0].replace(/\\\|/g, "X")), "newline survived in the row");
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
