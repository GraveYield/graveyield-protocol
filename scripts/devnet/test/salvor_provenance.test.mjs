// salvor_provenance.test.mjs — W1 P2 regression: the salvor-bots checkout
// provenance recorded in every run report.
//
// The rehearsal executes salvor-bots fleet-core and monitor; their source
// revision is part of the execution environment. These tests pin:
//   1. a CLEAN checkout → full provenance (repository/branch/head/clean),
//   2. a DIRTY checkout → provenance with an explicit DIRTY limitation,
//   3. an unavailable path / a non-git directory → inspectable:false with an
//      explicit "PROVENANCE UNAVAILABLE" limitation (never silently absent),
//   4. a checkout WITHOUT an origin remote → head pinned, repository null,
//      explicit partial-provenance note,
//   5. renderSummary() surfaces the provenance (or the explicit limitation)
//      in the Markdown summary.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitProvenance } from "../lifecycle_rehearsal/provenance.mjs";
import { renderSummary } from "../lifecycle_rehearsal/summarize.mjs";

function git(dir, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args],
    { cwd: dir, encoding: "utf8" },
  );
}

function makeRepo({ withRemote = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gy-prov-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "tracked.txt"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  if (withRemote) git(dir, "remote", "add", "origin", "https://example.com/salvor-bots.git");
  return dir;
}

describe("gitProvenance (salvor-bots checkout provenance)", () => {
  test("clean checkout: full provenance, no limitation note", () => {
    const dir = makeRepo();
    try {
      const p = gitProvenance(dir);
      assert.equal(p.inspectable, true);
      assert.equal(p.repository, "https://example.com/salvor-bots.git");
      assert.equal(p.branch, "main");
      assert.match(p.head, /^[0-9a-f]{40}$/);
      assert.equal(p.dirty, false);
      assert.equal(p.note, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dirty checkout: provenance kept, DIRTY limitation stated explicitly", () => {
    const dir = makeRepo();
    try {
      appendFileSync(join(dir, "tracked.txt"), "uncommitted change\n");
      const p = gitProvenance(dir);
      assert.equal(p.inspectable, true);
      assert.equal(p.dirty, true);
      assert.match(p.head, /^[0-9a-f]{40}$/);
      assert.match(p.note, /DIRTY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unavailable path: explicit PROVENANCE UNAVAILABLE, never silent", () => {
    const base = mkdtempSync(join(tmpdir(), "gy-prov-missing-"));
    const missing = join(base, "does-not-exist");
    try {
      const p = gitProvenance(missing);
      assert.equal(p.inspectable, false);
      assert.equal(p.head, null);
      assert.equal(p.repository, null);
      assert.equal(p.branch, null);
      assert.equal(p.dirty, null);
      assert.match(p.note, /PROVENANCE UNAVAILABLE/);
      assert.match(p.note, /UNKNOWN/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("non-git directory: explicit PROVENANCE UNAVAILABLE", () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-prov-nogit-"));
    try {
      const p = gitProvenance(dir);
      assert.equal(p.inspectable, false);
      assert.equal(p.head, null);
      assert.match(p.note, /not a git working tree/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checkout without an origin remote: head pinned, repository unknown, note explicit", () => {
    const dir = makeRepo({ withRemote: false });
    try {
      const p = gitProvenance(dir);
      assert.equal(p.inspectable, true);
      assert.match(p.head, /^[0-9a-f]{40}$/);
      assert.equal(p.branch, "main");
      assert.equal(p.repository, null);
      assert.equal(p.dirty, false);
      assert.match(p.note, /repository URL unknown/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("null/undefined path: explicit PROVENANCE UNAVAILABLE", () => {
    for (const p of [gitProvenance(null), gitProvenance(undefined)]) {
      assert.equal(p.inspectable, false);
      assert.equal(p.head, null);
      assert.match(p.note, /PROVENANCE UNAVAILABLE/);
    }
  });
});

describe("renderSummary surfaces salvor provenance (Markdown)", () => {
  const baseDoc = {
    started_at: "2026-11-05T00:00:00Z",
    finished_at: "2026-11-05T01:00:00Z",
    all_pass: true,
    stages: [],
    adversarial: [],
  };

  test("inspectable checkout: head, branch, URL and cleanliness are rendered", () => {
    const md = renderSummary({
      ...baseDoc,
      meta: {
        salvor_provenance: {
          path: "/path/salvor-bots",
          inspectable: true,
          repository: "https://example.com/salvor-bots.git",
          branch: "ns3/devnet-preparation",
          head: "8d8b6aa66303b04019fa4e094e3b41705685aace",
          dirty: false,
          note: null,
        },
      },
    });
    assert.match(
      md,
      /- salvor-bots: `8d8b6aa66303b04019fa4e094e3b41705685aace` @ ns3\/devnet-preparation/,
    );
    assert.match(md, /https:\/\/example\.com\/salvor-bots\.git/);
    assert.match(md, /· clean/);
    assert.doesNotMatch(md, /LIMITATION:/);
  });

  test("unavailable provenance: the limitation is rendered, never omitted", () => {
    const md = renderSummary({
      ...baseDoc,
      meta: {
        salvor_provenance: {
          path: "/path/salvor-bots",
          inspectable: false,
          repository: null,
          branch: null,
          head: null,
          dirty: null,
          note: "PROVENANCE UNAVAILABLE: no checkout found at '/path/salvor-bots' — source revision UNKNOWN",
        },
      },
    });
    assert.match(md, /- salvor-bots: provenance UNAVAILABLE/);
    assert.match(md, /LIMITATION: PROVENANCE UNAVAILABLE/);
    assert.match(md, /source revision UNKNOWN/);
  });

  test("dirty checkout: DIRTY working tree rendered with the limitation", () => {
    const md = renderSummary({
      ...baseDoc,
      meta: {
        salvor_provenance: {
          path: "/path/salvor-bots",
          inspectable: true,
          repository: "https://example.com/salvor-bots.git",
          branch: "main",
          head: "8d8b6aa66303b04019fa4e094e3b41705685aace",
          dirty: true,
          note: "PROVENANCE PARTIAL: working tree DIRTY — recorded source revision may differ from the checked-out files",
        },
      },
    });
    assert.match(md, /DIRTY working tree/);
    assert.match(md, /LIMITATION: PROVENANCE PARTIAL/);
  });
});
