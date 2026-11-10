# Worklog — investigation/ns3-node-stdout-hang

Format: one entry per work session; every session ends with a commit+push.
Times are UTC.

## Session 1 — 2026-11-10

- Cloned repo at `main` = `b9a1bf4` (post-#97). Verified no existing
  `investigation/*` branch or PR → created branch
  `investigation/ns3-node-stdout-hang`; opened draft PR early per §6.
- **Environment:** sandbox Node v24.22.2 = **exact VM Node version**
  (strong runtime equivalence); kernel/glibc differ (documented in
  ENVIRONMENT.md); no strace in sandbox (same as VM).
- **Phase 1 (source analysis) complete.** Key facts:
  - Checker success path fully synchronous; `process.exit(0)` at
    `ns3_check_provenance.mjs:327`; verdict printed immediately before.
  - Failing invocation is tarball-only → the ONLY npm code executed is the
    `@solana/web3.js` 3.1.1 module load (`ns3_verify_elf.mjs:53`);
    `PublicKey` never constructed on this path.
  - No timers/watchers/streams/children/exit-handlers anywhere on the
    checker's import path → a keep-alive handle cannot explain a hang once
    L327 is reached; only the teardown path itself can stall.
  - `deploy_devnet.sh:198` is the stall point (tarball-only, `>/dev/null`,
    inside `if`); script adds no fd/subshell trickery at that point.
- **Discovered prior art in-repo: PR #95** (merged 2026-11-09) documents the
  same failure twice in CI (complete success output → 5h56m silence →
  orphan node killed) and locally (0/~430 sequential, 3/120 under
  concurrent load, Node 24.22.2), with NO captured stuck-state. Our
  investigation targets exactly that missing capture.
- Hypothesis register opened (H1–H7). H1 (deterministic redirect mechanism)
  provisionally rejected as mechanism; redirect-vs-TTY VM pattern flagged
  as n=1 sampling of an intermittent failure until VM follow-up runs land.
- Next: sandbox reproduction matrix (synthetic manifest/tarball, no repo
  modification), load recipe from PR #95, per-thread /proc capture of any
  hang (the artifact PR #95 could not get).

## Session 1 (continued) — reproduction and capture

- Built out-of-repo repro env: `@solana/web3.js@3.1.1` (+ optional peers
  per lockfile) in a scratch dir; byte-identical checker copies (sha256
  recorded); synthetic 4 KB / 256 MB tarballs + schema-valid synthetic
  manifests. Real manifest pins never used, never modified.
- Baseline sequential matrix (tiny): 0/100. Under PR #95-style load
  (6 fresh-process web3.js import loops + file churn): tiny 0/370.
- **Reproduced:** checker + 256 MB tarball — 21/180 under load (file
  stdout), and the exact VM invocation shape idle: **/dev/null 40/80,
  file ≥15/~30, TTY 0/20**. Every hang follows the complete verdict.
- **Captured the stuck state 11/11 events (22 snapshots):** MainThread
  futex-join on the `V8Worker` thread (val == worker TID in 20/20
  snapshots); worker parked on futex, never woken; permanent (t1≡t2).
- **Bisection:** web3.js-stripped copy 0/120; minimal big-buffer scripts
  0/240; `--no-concurrent-marking/sweeping` no protection (4/60);
  `--trace-exit` full protection (0/60, p≈4e-4) → VM evidence F explained
  as causal timing perturbation.
- **Root cause (mechanism level): CONFIRMED** — Node v24.22.2 process
  teardown deadlocks joining a never-woken V8 platform worker after
  `process.exit(0)`; strictly post-verdict; stdout redirection is
  correlation (rate modulator), not cause. ROOT_CAUSE_REPORT.md written
  (sections A–L per assignment §8); VM follow-up plan V1–V3 prepared.
- Nothing implemented; no repo source file touched; all gates intact.
