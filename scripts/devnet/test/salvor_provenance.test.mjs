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
//      in the Markdown summary,
//   6. remote-URL sanitization (second independent-review finding): a remote
//      with embedded credentials is sanitized BEFORE recording — in the
//      collector's return value, in the JSON-serialized provenance, and in
//      the rendered Markdown. A remote that cannot be sanitized confidently
//      is explicitly withheld, never fabricated.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitProvenance, sanitizeRemoteUrl } from "../lifecycle_rehearsal/provenance.mjs";
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

// ---------------------------------------------------------------------------
// sanitizeRemoteUrl — the ACTUAL sanitizer the provenance collector uses
// (imported directly, not a test-only copy). Git remotes can embed
// credentials (user:password, tokens) and sensitive query parameters; the
// raw `git remote get-url origin` output must never reach JSON or Markdown.
describe("sanitizeRemoteUrl (remote-URL credential sanitization, W1 P2)", () => {
  test("ordinary HTTPS remote is preserved verbatim (host + repository path)", () => {
    assert.equal(
      sanitizeRemoteUrl("https://github.com/GraveYield/salvor-bots.git"),
      "https://github.com/GraveYield/salvor-bots.git",
    );
  });

  test("HTTPS remote with embedded username and password: credentials removed", () => {
    const out = sanitizeRemoteUrl(
      "https://builduser:s3cret-pa55word@github.com/GraveYield/salvor-bots.git",
    );
    assert.equal(out, "https://github.com/GraveYield/salvor-bots.git");
    assert.doesNotMatch(out ?? "", /builduser|s3cret-pa55word/);
  });

  test("HTTPS remote with token-like query parameters and fragment: both removed", () => {
    const out = sanitizeRemoteUrl(
      "https://github.com/GraveYield/salvor-bots.git?token=ghp_abc123secret&ci=1#frag",
    );
    assert.equal(out, "https://github.com/GraveYield/salvor-bots.git");
    assert.doesNotMatch(out ?? "", /ghp_abc123secret|ci=1|frag|\?|#/);
  });

  test("SSH URL with username: userinfo removed, host and path kept", () => {
    assert.equal(
      sanitizeRemoteUrl("ssh://git@github.com/GraveYield/salvor-bots.git"),
      "ssh://github.com/GraveYield/salvor-bots.git",
    );
    assert.equal(
      sanitizeRemoteUrl("ssh://deploy:tok3n@git.example.com:2222/fleet/salvor-bots.git"),
      "ssh://git.example.com:2222/fleet/salvor-bots.git",
    );
  });

  test("scp-like remote (user@host:path): userinfo stripped, host:path kept", () => {
    assert.equal(
      sanitizeRemoteUrl("git@github.com:GraveYield/salvor-bots.git"),
      "github.com:GraveYield/salvor-bots.git",
    );
  });

  test("file:// remote keeps only the path (no credential surface)", () => {
    assert.equal(
      sanitizeRemoteUrl("file:///home/ci/checkouts/salvor-bots"),
      "file:///home/ci/checkouts/salvor-bots",
    );
  });

  test("malformed or unavailable remotes return null — nothing fabricated", () => {
    for (const bad of ["not a remote", "", "   ", null, undefined, 42, {}, "!!!"]) {
      assert.equal(sanitizeRemoteUrl(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });

  test("opaque or unparseable shapes that could carry credentials are withheld", () => {
    // An opaque scheme keeps everything after the colon in an opaque path —
    // it cannot be credibly sanitized, so it is withheld rather than guessed.
    assert.equal(sanitizeRemoteUrl("x:https://u:p@host/repo"), null);
    // A path-embedded credential-looking residue must never survive.
    assert.equal(sanitizeRemoteUrl("host:path@with@creds"), null);
  });

  test("INVARIANT: no credential material survives ANY credential-bearing input", () => {
    const secrets = ["builduser:s3cret", "ghp_abc123secret", "x-access-token:oauthtok3n"];
    const inputs = [
      "https://builduser:s3cret@github.com/o/r.git",
      "https://builduser:s3cret@github.com/o/r.git?token=ghp_abc123secret#f",
      "ssh://x-access-token:oauthtok3n@git.example.com/o/r.git",
      "builduser:s3cret@github.com:o/r.git",
      "git@github.com:o/r.git?token=ghp_abc123secret",
    ];
    for (const input of inputs) {
      const out = sanitizeRemoteUrl(input);
      assert.ok(typeof out === "string" || out === null);
      if (out !== null) {
        // The strict invariant: `@`, `?` and `#` are the only characters that
        // can introduce credentials or hidden parameters — none may survive.
        assert.doesNotMatch(out, /[@?#]/, `invariant violated for input: ${input}`);
        for (const secret of secrets) {
          if (input.includes(secret)) {
            assert.ok(!out.includes(secret), `secret leaked for input: ${input}`);
          }
        }
      }
    }
  });
});

describe("gitProvenance records SANITIZED remote provenance (JSON + Markdown)", () => {
  function makeRepoWithRemote(url) {
    const dir = mkdtempSync(join(tmpdir(), "gy-prov-san-"));
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "tracked.txt"), "x\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "remote", "add", "origin", url);
    return dir;
  }

  test("credentialed HTTPS origin: provenance is useful AND credential-free", () => {
    const dir = makeRepoWithRemote(
      "https://builduser:s3cret-pa55word@github.com/GraveYield/salvor-bots.git",
    );
    try {
      const p = gitProvenance(dir);
      assert.equal(p.inspectable, true);
      assert.equal(p.repository, "https://github.com/GraveYield/salvor-bots.git");
      assert.match(p.head, /^[0-9a-f]{40}$/);
      assert.equal(p.dirty, false);
      assert.equal(p.note, null);
      // JSON output (the report is serialized provenance): no credential.
      const asJson = JSON.stringify(p);
      assert.doesNotMatch(asJson, /s3cret-pa55word|builduser/);
      // Markdown output: no credential, repository identification preserved.
      const md = renderSummary({
        started_at: "2026-11-06T00:00:00Z",
        finished_at: "2026-11-06T01:00:00Z",
        all_pass: true,
        stages: [],
        adversarial: [],
        meta: { salvor_provenance: p },
      });
      assert.doesNotMatch(md, /s3cret-pa55word|builduser/);
      assert.match(md, /https:\/\/github\.com\/GraveYield\/salvor-bots\.git/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unparseable origin: head pinned, repository WITHHELD, note explicit (no fabrication)", () => {
    const dir = makeRepoWithRemote("!!!not-a-remote!!!");
    try {
      const p = gitProvenance(dir);
      assert.equal(p.inspectable, true);
      assert.match(p.head, /^[0-9a-f]{40}$/);
      assert.equal(p.repository, null);
      assert.match(p.note, /PROVENANCE PARTIAL/);
      assert.match(p.note, /withheld/);
      // The withheld URL itself must not leak through the note either.
      const asJson = JSON.stringify(p);
      assert.doesNotMatch(asJson, /not-a-remote/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
