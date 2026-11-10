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
