# W2 — NS-3 Preflight: Corrections and Addendum (C1–C6)

**Supersedes six specific statements in** `docs/w2-ns3-acceptance/W2_NS3_PREFLIGHT_COMPLETION_REPORT.md` @ commit `12c9c82acc0c8091972414e23270392853832b36` (PR #102).
**The original report is NOT modified.** Per the owner's instruction, it stands unchanged until the owner has reviewed this addendum; any consolidation into the report is a later, owner-approved edit.
**Scope:** narrowly scoped corrections only. No re-audit, no deployment, no state-changing transaction, no keypair access, no production code or configuration change, no new PR/branch.
**Prepared:** 2026-11-12. Corrections C4 and C6 use read-only Devnet JSON-RPC against `https://api.devnet.solana.com` (endpoint explicit on every call; no CLI config touched).

---

## C1 — PR #102 creation record, and why it was created despite the no-commit/no-push rule

**Exact record (verified via GitHub API, 2026-11-12, and against the local clone):**

| Field | Value |
|---|---|
| PR | **https://github.com/GraveYield/graveyield-protocol/pull/102** (open, not draft, base `main` @ `80fdfca`) |
| Branch | `docs/w2-ns3-preflight-completion` (head repo = `GraveYield/graveyield-protocol` — same repo, no fork) |
| Commit | `12c9c82acc0c8091972414e23270392853832b36` — author/committer `graveyield-preflight-bot <preflight-bot@users.noreply.github.com>`, 2026-11-12T03:00:32Z; parent = `80fdfca2dd68…f10b` (the verification commit), i.e. `main` + exactly one commit |
| Changed files | **exactly one**: `docs/w2-ns3-acceptance/W2_NS3_PREFLIGHT_COMPLETION_REPORT.md` — status `added`, **+325 / −0**, mode `100644` |
| Drift | None since creation: PR `updated_at == created_at` (2026-11-12T03:00:56Z); head SHA still `12c9c82`; no commits after it |

**Why this action was taken despite "do not commit or push":** the original task brief's final line **explicitly directed** "Then push and open a PR", supplying a PAT for that purpose. That final instruction was read as a targeted, owner-issued exception to the brief's general prohibition (which was aimed at code and state changes) — exactly the interpretation the report itself flagged for owner review (report line 27, "Report delivery note"). The content pushed was documentation only: no source, manifest, identity, or configuration file was touched, nothing was merged, and the merge/close decision was left to the owner (report §12.2). This addendum confirms that reading was applied and records the full change surface (one file, +325/−0) so the owner can verify the scope claim independently. No further GitHub actions are taken beyond the corrections push to this same PR ordered below.

## C2 — Platform-tools v1.54: four-layer resolution, the v1.51-named link, and cache-dir contents

The report's §1 (line 17), §4 layer 4 (line 64/71) and §14.3 (lines 232–234) treated **atime evidence and the `1.89.0-sbpf-solana-v1.54` toolchain-link name as confirmation that the v1.54 cache directory was executed**. That wording is **withdrawn as conclusive proof**. Atimes are mount-option-dependent (relatime) and were not re-observable; link names are labels, not content attestations. The corrected four-layer statement:

| Layer | Corrected finding | Grade |
|---|---|---|
| 1. Source-level metadata resolution | agave `v3.0.10` `platform-tools-sdk/cargo-build-sbf/src/toolchain.rs`: `DEFAULT_PLATFORM_TOOLS_VERSION = "v1.51"` (line 18), `DEFAULT_RUST_VERSION = "1.84.1"` (line 19); `install_and_link_tools()` reads `workspace.metadata.solana.tools-version` when no `--tools-version` flag is passed. The deploy path passes **no** version flag (`deploy_devnet.sh` — verified by grep), so it resolves the workspace metadata → **v1.54**. | PASS (source) |
| 2. Verified archive contents | manifest pin `scripts/devnet/provenance.manifest.json`: `https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-linux-x86_64.tar.bz2`, sha256 `fcc41631…9f31e`; fail-closed bounded check **before any extraction** (build log lines 1–3: `bounded-provenance-check: … PROVENANCE OK`, `platform-tools v1.54 archive OK`). "Authenticated" = digest equals the committed, CI-enforced manifest pin — not an upstream signature chain. | PASS (digest) |
| 3. Cache seeding | `deploy_devnet.sh` lines 261–269: for `v1.51`, `v1.54`, `v1.57` — `rm -rf` then `tar xjf` **from that single verified archive**, plus the `.graveyield-pinned-sha256` stamp; build log lines 4–6 confirm all three seeded in-run before any compile. | PASS (by construction) |
| 4. Actual runtime compiler selection | The build selected **two different version-named directories at different phases** (below), and both held the same verified v1.54 bytes. What is established is the *executed bytes*, not a single directory name. | PASS (narrowed, below) |

**Corrected layer-4 statement.** Runtime evidence from the preserved build log (`evidence/build_only_run1.log`):

- The **Rust program builds** ran via a rustup link named `1.89.0-sbpf-solana-v1.54` (log line 187). Per `generate_toolchain_name()` (toolchain.rs:366–384), a non-default name is only produced by the branch that (a) received `requested_toolchain_version == "v1.54"` — reachable only via the workspace-metadata path here, since no flag is passed — and (b) **executed** `~/.cache/solana/v1.54/platform-tools/rust/bin/rustc --version` (`get_base_rust_version()`, toolchain.rs:137–151) and embedded its reported version (`1.89.0`). This is source-consistent corroboration of v1.54 resolution — stronger than an atime, but still name-derivation, not a content hash.
- The **sbf/c C-dependency step** ran `platform-tools-sdk/sbf/scripts/install.sh` from the agave v3.0.10 release tree (`config.sbf_sdk` defaults to `<cargo-build-sbf dir>/platform-tools-sdk/sbf`, main.rs:60–63; the release-tree copy in the session toolchain is byte-identical to the agave v3.0.10 source — verified by `diff`). That script **hardcodes** `tools_version=v1.51`, `rust_version=1.84.1` (install.sh:112–113) and unconditionally emits `rustup toolchain link 1.84.1-sbpf-solana-v1.51 platform-tools/rust` (install.sh:151; log line 194). Its cache-hit path (`get()`, install.sh:61–66) symlinked `dependencies/platform-tools` → `~/.cache/solana/v1.51/platform-tools` **without any download** (no `anza-xyz`/`platform-tools-linux` fetch anywhere in the log — verified by grep), after which the traced `rustc` probe (log line 180) executed rustc from the **v1.51-named** seeded directory. The subsequent vault-build `link_solana_toolchain()` then uninstalled that link (log lines 196–197) and re-established the v1.54-named one.

**Significance of the generated v1.51-named toolchain link:** it is produced from hardcoded constants (`install.sh:112–113,151`, and equivalently the default branch of `generate_toolchain_name`, toolchain.rs:367–373) whenever the requested version equals the compiled-in default — it performs **no filesystem probe and carries zero information about directory contents**. Its existence in the trace is therefore *disproof by counterexample* of using toolchain-link names (or version banners) as evidence of executed toolchain version: two different names appeared in one build, and neither attests content. Its only operational effect was to point the C-deps phase at the `v1.51`-**named** seeded directory.

**Did every selected cache directory contain byte-identical authenticated v1.54 contents?** **Yes — by construction, not by per-file re-hash.** All three seeded dirs were freshly `rm -rf`'d and re-extracted from the *one* digest-verified archive immediately before the build (layer 3), so they are byte-identical to each other and to the authenticated v1.54 archive contents; the build's writes went to `sdk/sbf/dependencies/` under the agave release tree and to `~/.cache/solana/v2.3.3/` (Criterion, C5), never into `platform-tools/rust` of any seeded dir. Honest limits: identity rests on the extraction mechanism (same tar stream), no per-file diffing was performed, and the ephemeral cache no longer exists in the current (recycled) sandbox, so this cannot be re-hashed today — the evidence is the preserved log, the preserved toolchain tree, and the script source at `80fdfca`. One **latent path** is recorded for completeness: had `~/.cache/solana/v1.51/platform-tools` been absent, `install.sh` would have downloaded platform-tools **v1.51 directly from GitHub, bypassing the manifest** (install.sh:111–145) — not taken in this run (no such fetch in the log); the deploy-flow invariant therefore depends on the script's seeding step having run first, which it does by construction on every `deploy_devnet.sh` build.

## C3 — `deploy_devnet.sh` git mode and every direct runbook invocation

**Exact git mode:** `100644` — `git ls-files -s scripts/devnet/deploy_devnet.sh` → `100644 6e7d4570fe7c831f649ae5493f12601dcb5623a3 0 scripts/devnet/deploy_devnet.sh` (commit `12c9c82` tree). The script has a `#!/usr/bin/env bash` shebang but is not executable in a fresh clone.

**Runbook commands invoking the script directly (not via `bash`) — complete list, `docs/DEVNET.md`:**

| Location | Text | Nature |
|---|---|---|
| DEVNET.md **line 204** (§2 Mode 1 command block) | `scripts/devnet/deploy_devnet.sh --build-only   # build + provenance gate, no keypairs` | copy-pasteable command → fails with `Permission denied` on a fresh clone |
| DEVNET.md **line 239** (§3 Mode 2 command block, lines 239–243) | `scripts/devnet/deploy_devnet.sh \` (with `--url`/`--scanner-keypair`/`--vault-keypair`/`--deployer` continuation) | the owner deployment command → same failure |
| DEVNET.md **line 76** (mode-selection table) | "`scripts/devnet/deploy_devnet.sh`" as the mode-2 entry point | reference cell (not a command block); same unprefixed pattern |

Adjacent same-pattern occurrences outside the runbook: the script's own header usage examples (deploy_devnet.sh lines 9 and 11) and a prose mention in `scripts/devnet/lifecycle_rehearsal/README.md` line 29. Context that needs **no** correction: `scripts/devnet/local_rehearsal_ns3.sh` (line 202 of the same block) is committed `100755` and works as written; `scripts/check-toolchain.sh` (line 201) is already prefixed `bash`; all internal callers already spawn via `bash` (`lifecycle_rehearsal.sh:97`, `local_rehearsal.sh:101`, `deploy_gate.test.mjs:429` — `spawnSync("bash", [...])`), so CI and tests are unaffected.

**Smallest documentation correction (recommended; NOT applied — no files modified):** prefix the two runbook command lines with `bash ` — i.e. DEVNET.md lines 204 and 239 become `bash scripts/devnet/deploy_devnet.sh …`. Two changed lines make every copy-pasteable runbook command correct on a fresh clone. Equivalent alternatives, if the owner prefers: a one-sentence "run via `bash`" note in DEVNET.md §2, or the repo-level fix already recommended in report §13.1 (`git update-index --chmod=+x scripts/devnet/deploy_devnet.sh` in a reviewed PR). Harmonizing the script-header usage lines is optional polish, not required.

## C4 — Intruder funding: records check and read-only Devnet verification

**Records check.** The address `8U71ZhBZ1G2UdH3hxbnwRhuvZHT192M2UZ5QCi75DNL1` appears **nowhere** in the protocol repository at `12c9c82` (grep across the full worktree: zero matches) nor in the preserved session snapshot. The project records define the intruder **role**, never an address: `docs/DEVNET.md` line 143 ("Throwaway intruder — needs its OWN fee dust (0.01 SOL)"), lines 424/427 (`--intruder /path/to/throwaway-keypair.json` — a custody path, deliberately not a repo constant), lines 445–447 (drill semantics). The address therefore enters the record for the first time via the owner's correction request.

**Read-only Devnet query (explicit endpoint `https://api.devnet.solana.com`; JSON-RPC only; no keypair touched, no transaction):**

```
POST getBalance      ["8U71ZhBZ1G2UdH3hxbnwRhuvZHT192M2UZ5QCi75DNL1"]
→ {"context":{"slot":521351307},"value":100000000}            (100,000,000 lamports = 0.1 SOL exactly)
POST getAccountInfo  ["8U71ZhBZ1G2UdH3hxbnwRhuvZHT192M2UZ5QCi75DNL1", {"encoding":"base64"}]
→ lamports 100000000, owner "11111111111111111111111111111111" (System Program),
  executable false, space 0, data "" (slot 521351307; getMultipleAccounts concurs at 521351308)
```

**Conclusion:** the owner-reported 0.1 SOL is **VERIFIED** — a plain, unfunded-purpose system account (space 0) holding exactly 0.1 SOL, comfortably above the 0.01 SOL the drills require (DEVNET.md:143). This upgrades report §7 (line 121) and §12.4 (line 171): intruder row **UNVERIFIED → VERIFIED** (owner-supplied address; balance confirmed 2026-11-12). Note: the first `getAccountInfo` call in the session transiently returned `null` on the public endpoint and was disproved by three consistent re-queries across `getBalance`/`getAccountInfo`/`getMultipleAccounts` — a live illustration of the verifier's own design rule that RPC failure must never be read as absence.

## C5 — Criterion v2.3.3: what was downloaded, where it entered, what the ELF hashes establish

**Precise download record** (all from the preserved `evidence/build_only_run1.log`):

- **What:** `criterion-v2.3.3-linux-x86_64.tar.bz2`, **677,858 bytes**, HTTP 200 via 302 → `release-assets.githubusercontent.com`, fetched by `wget --retry-connrefused` at **2026-11-12T02:47:48–49Z** (log lines 162–177).
- **Which code fetched it:** the "Install Criterion" section (install.sh:87–108) of `platform-tools-sdk/sbf/scripts/install.sh` — the sbf/c dependency installer that ships with agave v3.0.10 and runs during the sbf/c dependency step of `cargo-build-sbf` (via `env.sh:10` / `c/sbf.mk:2`), between the scanner build finishing and the vault build starting. Criterion v2.3.3 (linux) is **hardcoded** there.
- **Where it landed:** through `get()`'s download path (install.sh:61–79) into `~/.cache/solana/v2.3.3/criterion/` (its own cache version dir), then symlinked as `criterion` into the sbf/c dependencies directory (`config.sbf_sdk/dependencies`, i.e. under the agave release tree). It is **not** pinned by any digest anywhere (not in the provenance manifest; `install.sh` performs no checksum), it never entered the workspace source or `target/deploy/`, and the log shows it only downloaded + extracted — no C compilation consumed it in this run.

**What the matching final ELF hashes establish:** independent `sha256sum` of both built ELFs equals the manifest pins (`e24ddc5e…cd6c98` scanner, `8c71fe9d…33e83` vault), and CI's independent build on `80fdfca` reproduces the same pins — so this build **byte-reproduced the pinned deployment artifacts**, and nothing in the post-build environment, including the Criterion download, influenced the deployed bytes. That is the entire claim ("digest-neutral" — empirical, this run + CI corroboration).

**What they do NOT establish (supply-chain assurance must not be overstated):**

1. The Criterion tarball's integrity or authenticity — no digest pin, no signature; TLS-to-GitHub is the only control. A hostile Criterion could in principle execute code in the build sandbox at C-test build time (in this run: download + extract only).
2. End-to-end upstream authenticity of the toolchain — the trust anchor is the manifest's own sha256 pins (committed at `80fdfca`, fail-closed in CI). Matching hashes prove agreement with the pins, not that the pins derive from a trusted upstream; that rests on repo governance and CI review, outside preflight scope.
3. Anything about other hosts or latent paths (e.g. install.sh's manifest-bypassing v1.51 download path, C2; CI runner images).

## C6 — Live-verifier timestamp correction and log inventory

**The malformed timestamp.** Report §9 (line 144) says "Live run (2026-11-12T02:50:0xZ, slot 521319065, FINALIZED)". The original transcript (`scripts/verify_acceptance_live.txt`, 87 lines, preserved — see below) contains **no wall-clock line**; its only temporal record is `context: slot 521319065 epoch 1206 commitment finalized`. The "02:50:0x" value is therefore unreproducible from primary evidence and is **incorrect**. Chain-anchored correction (read-only RPC, 2026-11-12):

```
POST getBlockTime 521319065 → 1794452032 = 2026-11-12T02:53:52Z   (deployment-verifier slot)
POST getBlockTime 521319072 → 1794452034 = 2026-11-12T02:53:54Z   (ELF-digest-verifier slot)
```

These agree with the transcript files' own write times to within ~1–2 s (`verify_acceptance_live.txt` mtime **02:53:54.496Z**; `verify_elf_digests_live.txt` mtime **02:53:55.260Z**; FINALIZED commitment means the run completed at-or-after the slot's block time, bounding it tightly). **Corrected statement for §9:** live deployment-verifier run completed ≈ **2026-11-12T02:53:52–54Z** (slot 521319065, FINALIZED); digests run ≈ **02:53:54–55Z** (slot 521319072). No other conclusion in §9 changes. (§14.5's separate `timestamp_utc=2026-11-12T02:37:23Z` RPC record is internally consistent with its script's 02:37:13Z write time and needs no correction.)

**The five referenced logs (report §14 preamble, line 188) — accessibility confirmed**, preserved in the session snapshot at `/tmp/my-project/scripts/` and **now attached durably on this branch under `docs/w2-ns3-acceptance/evidence/`**:

| File | Size | Written (UTC) | Status |
|---|---|---|---|
| `evidence/build_only_run1.log` | 11,418 B | 02:47:56.698Z | preserved + attached |
| `evidence/devnet_tests.log` | 45,889 B | 02:53:35.337Z | preserved + attached |
| `evidence/verify_acceptance_live.txt` | 7,965 B | 02:53:54.496Z | preserved + attached |
| `evidence/verify_elf_digests_live.txt` | 6,982 B | 02:53:55.260Z | preserved + attached |
| `evidence/devnet_ro_checks.sh` | 1,409 B | 02:37:13.041Z | preserved + attached; **its separate transcript file was not preserved** — report §14.5 is the summarized record of its output (internally timestamped 02:37:23Z); the script itself is attached so its commands are fully reconstructable |

Also preserved (not §14-referenced): `fetch_toolchains.log`/`.sh`, `rustup_install.log`, `setup_devnet_deps.sh`, `devnet_build_test.log` (0 bytes, empty).

---

## Summary of grades after correction

| Report location | Original | Corrected |
|---|---|---|
| §1 line 17; §4 layer 4 (lines 64, 71); §14.3 lines 232–234 | "atime evidence confirms … executed toolchain" | atimes/link names demoted to corroboration; executed **bytes** established via C2's seeding invariant + source-verified resolution — **PASS (narrowed)** |
| §7 line 121; §12.4 line 171 (intruder) | UNVERIFIED | **VERIFIED** — 0.1 SOL on-chain, read-only (C4) |
| §9 line 144 (timestamp) | `2026-11-12T02:50:0xZ` | **≈ 2026-11-12T02:53:52–54Z** (chain-anchored; C6) |
| §6 line 112; §13.1 (mode) | mode 100644, "docs §2/§3 invoke directly" | confirmed exact mode; complete invocation list: DEVNET.md **204, 239** (commands), **76** (table ref), script header 9/11 (C3) |
| §4 line 76; §14.9 line 320 (Criterion) | "post-processing fetched … digest-neutral" | entry point, destination, and epistemic limits made precise; digest-neutral claim retained, narrowly (C5) |
| §14 line 188 (logs) | "preserved in the session workspace" | four logs + script preserved and attached on-branch; ro-checks transcript not preserved (§14.5 is its record) (C6) |
| §1 line 27 (delivery note) | flagged for owner review | confirmed: PR #102, one file, +325/−0, nothing merged (C1) |

**Overall classification: unchanged — READY FOR OWNER REVIEW (preflight).** No correction above weakens a gate, an identity, a digest, or a custody boundary; C2 narrows an evidentiary claim, C4 closes an UNVERIFIED item in the owner's favor, C6 corrects a transcription error.

*Nothing in this addendum deploys, signs, or authorizes anything; custody and execution remain exclusively the owner's.*
