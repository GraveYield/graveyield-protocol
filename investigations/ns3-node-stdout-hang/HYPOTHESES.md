# Hypothesis register — FINAL (investigation complete)

Statuses at close: CONFIRMED / STRONGLY-SUPPORTED / REJECTED / REQUIRES-VM.
Superseded reasoning is kept for the record. Evidence references point to
EVIDENCE.md and REPRODUCTIONS.md.

---

## H1 — "stdout redirection causes the hang" (the assignment's implied frame)

**Status: REJECTED as mechanism; CONFIRMED as a conditional *correlation*
that the VM happened to sample.**

- Rejected as mechanism: file, `/dev/null` and TTY stdout are all
  synchronous in Node; every hang occurs after all verdict bytes are
  durably written; pipe-stdout runs never hung (0/60); the captured
  deadlock is in thread teardown, unreachable from any stdout code path.
- Confirmed as correlation: on an **idle** machine the redirected shapes
  (/dev/null 40/80 ≈ 50%, file ≈50%) hang while TTY does not (0/20) —
  which is exactly what the owner's single VM runs sampled (A=0, B/C=124).
  The stdout type is a *rate modulator* (timing of the final writes vs the
  worker's park cycle), not the cause.

## H2 — Intermittent Node.js process-teardown hang after `process.exit(0)`

**Status: CONFIRMED — mechanism captured and identified (sandbox, same Node
version as VM).**

- 11/11 captured hang events, 20/20 `/proc` snapshots: MainThread blocked
  in `futex(FUTEX_WAIT_BITSET, val=<V8Worker TID>)` (join-style wait on the
  V8 platform worker thread); `V8Worker` asleep on `futex(..., val=0)`,
  never woken; t1≡t2 (permanent). CI occurrences (PR #95) match: orphan
  node process, hours-long hang.
- Required ingredients (measured): large transient external-memory
  allocation (256 MB tarball `readFileSync` — 0/470 hangs without it),
  web3.js 3.1.1 module-graph heap (0/120 without vs 21/180 with),
  timing/stdout shape (idle file//dev/null ≈50%, TTY 0%, `--trace-exit` 0%).
- Concurrent-GC flags did not protect (4/60) → the stuck worker is not
  doing concurrent mark/sweep. Deeper attribution (which V8/Node component
  owns the missed wakeup) is beyond `/proc` visibility without symbols and
  is a Node.js/V8 upstream question — the captures are sufficient to file
  it upstream.

## H3 — The `@solana/web3.js` 3.1.1 import chain is a required ingredient

**Status: STRONGLY SUPPORTED (rate factor), not a clean predicate.**

- web3.js-stripped byte-identical copy: 0/120 under matched conditions vs
  21/180 with the import (p ≈ 1.3·10⁻⁵).
- But web3.js import alone does NOT suffice: minimal big-buffer scripts
  with the import hung 0/120. The import is a heap/graph-size contributor
  to the race window, not a side-effect handle (none exists — import-only
  runs exit cleanly).

## H4 — `--trace-exit` causally "fixes" the hang

**Status: CONFIRMED as a causal timing effect (mechanism: pre-exit stderr
instrumentation delays exit-initiation past the lost-wakeup window).**

- Matched-cell A/B: big tarball + load, 0/60 with `--trace-exit` vs 21/180
  without (p ≈ 4·10⁻⁴). The VM's single F run is thereby *explained*, not
  anomalous.
- Semantics unchanged: the trace (captured) shows the same `process.exit`
  from `main:327:13` via `node:internal/process/per_thread:241`, exit code
  0.

## H5 — The deployment script introduces its own failure

**Status: REJECTED (unchanged from opening assessment; see EVIDENCE §3.5).**
The script exposes the standalone CLI hang at `deploy_devnet.sh:198` and
`run_provenance_gate()`; `local_rehearsal_ns3.sh:81` shares the exposure.

## H6 — Manifest/tarball content or hashing of the large tarball is causal

**Status: REVISED — the tarball SIZE is a required ingredient; the manifest
content is not.** 4 KB tarball: 0/470. 256 MB tarball: reproduces. Synthetic
manifest/digests reproduce; the real manifest's pins were never needed and
never touched. The mechanism is the transient 256 MB buffer's effect on
teardown timing, not the hashing logic.

## H7 — Environment-level external interference on the VM (Hermes Agent,
        rlimit, cgroup, watchdog, kernel)

**Status: REJECTED as a necessary condition** — the hang reproduces on an
idle machine at ≈50% with the exact VM invocation shape. Residual VM-specific
rate differences remain possible; V1–V3 (ROOT_CAUSE_REPORT §J) bound them.
