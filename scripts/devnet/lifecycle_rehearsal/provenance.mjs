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

// --- remote-URL sanitization (W1 P2 review finding) --------------------------------
// Git remotes can embed credentials — `https://user:token@host/repo.git`,
// token-bearing query strings (`?token=…`), fragments — and the raw
// `git remote get-url origin` output previously went straight into the JSON
// report and the Markdown summary. sanitizeRemoteUrl keeps what identifies
// the repository (scheme, host, port, repository path) and drops everything
// that can carry a secret (userinfo, query string, fragment).
//
// The invariant is strict and testable: the returned value NEVER contains
// `@`, `?` or `#` — the only characters that can introduce credentials or
// hidden parameters — so no credential material can survive any input shape.
// A value that cannot be sanitized CONFIDENTLY returns null: callers must
// then record the provenance as withheld/unavailable (never fabricate a
// plausible-looking URL).
export function sanitizeRemoteUrl(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;
  let candidate = null;
  try {
    const u = new URL(s);
    if (u.hostname) {
      // Scheme-bearing remote (https, ssh, git, git+ssh, …): protocol +
      // host[:port] + path only. Userinfo, the ENTIRE query string and the
      // fragment are dropped — there is no parameter allowlist, because
      // token-like parameters cannot be enumerated reliably.
      candidate = `${u.protocol}//${u.host}${u.pathname}`;
    } else if (u.protocol === "file:") {
      // Local checkout path (`file:///…`): no credential surface beyond the
      // path itself, which is already recorded in the provenance `path`.
      candidate = `${u.protocol}//${u.pathname}`;
    }
    // A parsed URL with neither host nor file: (opaque scheme like
    // `git:something`) keeps its payload in an opaque path that cannot be
    // credibly sanitized — leave candidate null (withheld below).
  } catch {
    // Not a parseable URL. scp-like short remotes (`[user@]host:path`) carry
    // the credential in the userinfo — strip it, keep `host:path`.
    const scp = /^(?:[^@\s/]+@)?([^\s:@/]+):([^\s/].*)$/.exec(s);
    if (scp) candidate = `${scp[1]}:${scp[2]}`;
    // Anything else (bare relative paths, malformed values) stays null:
    // record nothing rather than risk recording credentials.
  }
  // Belt-and-braces invariant: no credential- or parameter-bearing character
  // may survive sanitization. A remote whose repository path would need
  // `@`, `?` or `#` is withheld, not recorded.
  if (candidate === null || /[@?#]/.test(candidate)) return null;
  return candidate;
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
  // The recorded repository URL is SANITIZED (never the raw remote): git
  // remotes can embed credentials that must not leak into reports. When a
  // remote exists but cannot be recorded safely, that is stated explicitly —
  // it is never silently dropped or replaced with fabricated metadata.
  const rawRepository = git(["remote", "get-url", "origin"], path);
  const repository = sanitizeRemoteUrl(rawRepository);
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
  if (!repository) {
    notes.push(
      rawRepository
        ? "origin remote URL withheld — the configured remote could not be recorded without credential exposure"
        : "origin remote not configured — repository URL unknown",
    );
  }
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
