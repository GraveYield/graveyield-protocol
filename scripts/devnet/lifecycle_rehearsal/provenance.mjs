// provenance.mjs — W1 §11 execution-provenance metadata.
//
// Pure, side-effect-free git inspection helpers so BOTH the driver's report
// and the regression tests can use them without the harness's runtime
// dependencies (web3/SDK/fleet-core imports stay out of this module).
//
// Salvor provenance (W1 review finding): the rehearsal executes salvor-bots
// fleet-core and monitor components; their source revision is part of the
// execution environment and MUST be reproducible from every run report —
// or the report must say, explicitly, that provenance is unavailable.
// Incomplete provenance is never presented as complete: every missing field
// is null and `note` carries the explicit limitation.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// One git query. Returns trimmed stdout — INCLUDING the empty string, which
// is a VALID result (e.g. `git status --porcelain` on a clean tree) — or null
// when git is missing, the command fails, or the path is not a repository.
// Never throws.
function gitOut(args, cwd) {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    return (r.stdout ?? "").trim();
  } catch {
    return null;
  }
}

// Same, but an empty result is normalized to null (metadata queries where an
// empty answer means "not configured", e.g. no remote / detached HEAD).
function git(args, cwd) {
  return gitOut(args, cwd) || null;
}

const UNAVAILABLE_BASE = Object.freeze({
  path: null,
  inspectable: false,
  repository: null,
  branch: null,
  head: null,
  dirty: null,
  note: null,
});

export function gitProvenance(repoPath) {
  const path = repoPath ?? null;
  if (!path || !existsSync(path)) {
    return {
      ...UNAVAILABLE_BASE,
      path,
      note: `PROVENANCE UNAVAILABLE: no checkout found at '${path ?? "(none)"}' — source revision UNKNOWN`,
    };
  }
  if (!existsSync(join(path, ".git"))) {
    return {
      ...UNAVAILABLE_BASE,
      path,
      note: `PROVENANCE UNAVAILABLE: '${path}' is not a git working tree — source revision UNKNOWN`,
    };
  }
  const repository = git(["remote", "get-url", "origin"], path);
  const branch = git(["branch", "--show-current"], path);
  const head = git(["rev-parse", "HEAD"], path);
  // The commit pin is the minimum useful provenance; without it the record
  // is worthless and must be reported as unavailable.
  if (!head) {
    return {
      ...UNAVAILABLE_BASE,
      path,
      note: `PROVENANCE UNAVAILABLE: git inspection failed at '${path}' — source revision UNKNOWN`,
    };
  }
  const status = gitOut(["status", "--porcelain"], path); // "" == clean (valid)
  const dirty = status === null ? null : status.length > 0;
  const notes = [];
  if (!repository) notes.push("origin remote not configured — repository URL unknown");
  if (dirty === null)
    notes.push("working-tree status could not be determined — dirty/clean UNKNOWN");
  if (dirty === true)
    notes.push(
      "working tree DIRTY — recorded source revision may differ from the checked-out files",
    );
  if (!branch) notes.push("detached HEAD or branch unknown");
  return {
    path,
    inspectable: true,
    repository,
    branch,
    head,
    dirty,
    note: notes.length > 0 ? `PROVENANCE PARTIAL: ${notes.join("; ")}` : null,
  };
}
