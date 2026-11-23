# Environment comparison — investigation sandbox vs original VM

## Original VM (from assignment §2)

| Component | Value |
| --- | --- |
| OS | Ubuntu VM (SSH access) |
| Node.js | **v24.22.2** |
| cargo-build-sbf | 3.0.10 |
| platform-tools | v1.54 |
| Repo location | `~/graveyield-protocol` |
| Background load | **Hermes Agent runs on this same VM** |
| strace | not available (per PR #95 §2: "no strace available") |

## Investigation sandbox (this environment)

| Component | Value |
| --- | --- |
| OS | Linux 5.10.134-013.15.kangaroo.al8.x86_64 (Alibaba Cloud Linux kernel; NOT Ubuntu) |
| Node.js | **v24.22.2** — **byte-identical major.minor.patch to the VM** |
| git | 2.47.3 |
| Available tooling | `script` (PTY emulation), `jq`, `curl`, coreutils `timeout`; **no `strace`** (same limitation as VM) |
| Repo | fresh clone at `b9a1bf4` (main, post-#97) |

## Equivalence statement (honest)

- **Node.js runtime: demonstrably equivalent** (same exact version v24.22.2,
  same platform Linux x86_64). Runtime-behavior findings from this sandbox
  carry strong evidentiary weight for the VM's Node-level behavior.
- **Kernel and OS: NOT equivalent** (5.10 al8 kernel vs Ubuntu; different
  glibc, different kernel config). Kernel-level or libc-level mechanisms
  (thread teardown, futex behavior, NSS/dlopen behavior) must be confirmed
  on the VM before being labeled confirmed for the VM.
- **Load profile: NOT equivalent.** The VM runs the Hermes Agent
  concurrently; the sandbox load is artificial (see REPRODUCTIONS.md).
  PR #95 [CI-E] already established that the hang is load-dependent.
- Therefore: a reproduction here establishes the mechanism at the Node.js
  level [REPRO]; whether the exact VM sessions hit the same mechanism is
  confirmed only by the VM follow-up tests in ROOT_CAUSE_REPORT.md §J.

## Dependency pin (relevant for import side effects)

`scripts/devnet/package.json`: `@solana/web3.js ^3.1.1`; root
`package.json` pnpm override pins **`3.1.1` exactly**
(`pnpm-lock.yaml` lines 13, 868). Optional native peers per lockfile:
`bufferutil@4.1.0`, `utf-8-validate@6.0.6`,
`fastestsmallesttextencoderdecoder@1.0.22`.

All reproduction installs are performed OUTSIDE the repository tree
(scratch directory, own `node_modules`); the repository itself is never
npm-installed into and its project environment is never altered.
