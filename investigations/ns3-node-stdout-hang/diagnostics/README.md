# diagnostics/

Reproduction & capture tooling (run OUTSIDE the repository tree; they never
modify repo files and never touch real manifest pins — synthetic fixtures
only).

| Script | Purpose |
| --- | --- |
| `setup_fixtures.sh` | Creates the out-of-repo scratch env: byte-identical checker copies (sha256-recorded), synthetic 4 KB / 256 MB tarballs, schema-valid synthetic manifests pinning those digests. |
| `matrix_sequential.sh` | Baseline sequential matrix: stdout mode × `--trace-exit` × n. |
| `load_repro.sh` | PR #95-style load (6 fresh-process `@solana/web3.js` import loops + file churn) with a verdict watcher; variants: checker/tiny/big/pipe/trace-exit/noweb3/minimal/gc-off. Captures any hang via `capture_stuck.sh`. |
| `idle_matrix.sh` / `idle_tty_clean.sh` | Idle-machine factorial (the exact VM invocation shape): devnull / file / TTY cells. |
| `capture_stuck.sh` | `/proc` snapshot of a hung process we own: per-thread comm/wchan/syscall, status, fds. No strace needed. |

Reference captures (`captures/`): one idle hang and one loaded hang —
MainThread `futex(val=<V8Worker tid>)`, `V8Worker` parked on `futex(val=0)`.
