# W2 — NS-3 Deployment Acceptance Report (read-only verification exercise)

**Overall W2 classification: REJECTED.**

The read-only acceptance verifier ran successfully against the approved Solana Devnet
endpoint and established the cluster identity with certainty — but the approved NS-3
deployment arrangement is NOT present on the cluster: neither NS-3 program account
exists, and neither ProtocolConfig PDA account exists. The verifier's overall result is
**FAIL** (exit 1). Per the W2 semantics, this is recorded as **REJECTED** — the observed
cluster state contradicts the approved deployment specification, which requires both
programs live at the pinned addresses with the approved authority arrangement.

This is NOT a successful acceptance record. It is also not, by itself, evidence of
tampering: the runbook ([docs/DEVNET.md](../DEVNET.md)) records the NS-3 deployment as
"assigned, NOT yet deployed — deployment PENDING", and the observed state (nothing at
the NS-3 addresses, while the four legacy NS-1/NS-2 programs remain present as
historical residue) is exactly what a not-yet-executed deployment looks like. The
verifier cannot distinguish "not yet deployed" from "deployed and later removed" —
either way, acceptance is not met and the gate stays closed.

In line with the W2 rules: no missing account was initialized, no state was corrected,
no transaction was signed or submitted, and the verifier was not modified.

## 1. Git provenance

| Item | Value |
|---|---|
| Repository | `https://github.com/GraveYield/graveyield-protocol` |
| Branch | `main` |
| Commit used for W2 | `eaaf935683a3a602bf34bfc0f52e199c571d1ad9` (Merge PR #85; current `origin/main` at execution time) |
| Working-tree state | clean (`git status --short` empty for the entire run) |
| Verifier | `scripts/devnet/verify_ns3_deployment.mjs` |
| Verifier version | no standalone version field exists; version is pinned by git — blob `3215fa62a4af92a5ea1ab32863f622d3b7b2c9b9` at commit `eaaf935` |
| Identity constants | `scripts/devnet/ns3_identities.mjs`, blob `106419c365d0376adf6a1718f53641e3b6f8fac9` at commit `eaaf935` |
| Verifier modifications | none — the verifier ran exactly as committed; machine-readable output is native (`--json`), so no change was needed or made |

## 2. Execution (read-only)

Commands (verbatim; no secrets, keypairs, or tokens are used by this tool by
construction — the CLI accepts no identity or key inputs):

```
node scripts/devnet/verify_ns3_deployment.mjs --url https://api.devnet.solana.com
node scripts/devnet/verify_ns3_deployment.mjs --url https://api.devnet.solana.com --json
node scripts/w2_elf_digest_check.mjs   # evidence collector run OUTSIDE the repo (not committed); see §5
```

Pre-execution inspection performed (per the W2 preparation checklist):

- The complete verifier source (1,251 lines) was read before execution. It performs
  read-only RPC only: `getEpochInfo`, `getGenesisHash`, `getAccountInfo`. It contains no
  keypair, signer, transaction, or writable operation, and refuses identity-override
  flags by construction.
- The PR #83 runbook ([docs/DEVNET.md](../DEVNET.md) §5, Mode 3) specifies exactly this
  invocation against the explicitly approved endpoint `https://api.devnet.solana.com`.
- No environment variables, no signing authority, and no custody material are required;
  none were used. The prohibited custody path was never accessed, listed, or referenced.
- PDA derivations were reproduced locally before the run
  (`node scripts/devnet/ns3_derive_pdas.mjs`): scanner `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe`,
  vault `5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda` — both match the approved pins.

## 3. Cluster identity (Section G)

| Item | Value |
|---|---|
| Endpoint | `https://api.devnet.solana.com` (the runbook-approved public Devnet RPC; cluster identity proven by genesis hash, not by URL string) |
| Observed genesis hash | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Expected (pinned) genesis hash | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Match | **YES — PASS (G1)** |
| Context | slot 519265913 (terminal run) / 519266030 (JSON run), epoch 1202, commitment `finalized` |

The cluster identity gate ran first, before any deployment state was interpreted, and
passed: this is genuine Solana Devnet. The FAIL verdict below is therefore a statement
about the deployment state on the correct cluster, not about a wrong cluster.

## 4. Program verification (Section A) — observed vs expected

Expected upgrade authority (from the approved NS-3 specification / runbook): the
deployer `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` — the initial deployer/upgrade
authority, which is a distinct identity from the governance/ProtocolConfig authority
`BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5` (the verifier enforces exactly this
distinction and checks each against its own pin).

| Field | GraveScanner | GraveVault |
|---|---|---|
| Program ID (pinned) | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` | `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya` |
| Program account exists | **NO — FAIL (A1)** | **NO — FAIL (A6)** |
| Program account owner | not observable (account absent) | not observable (account absent) |
| Executable | not observable (account absent) | not observable (account absent) |
| ProgramData address (loader-derived) | `FxYDhTruh16EoKBgiJaWZCQ9QojWQZGS8J1dXyfSt9dG` | `9wyRhAC8Sasb46bhWW4jxsK6rGKpEGXf6Riz2ibKZgC4` |
| ProgramData exists | **NO — corroborated independently (§5)** | **NO — corroborated independently (§5)** |
| ProgramData owner / structure | not observable (absent) | not observable (absent) |
| Observed upgrade authority | none (no ProgramData) | none (no ProgramData) |
| Expected upgrade authority | deployer `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` | deployer `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` |
| Authority comparison | **FAIL** — approved authority arrangement not present on cluster | **FAIL** — approved authority arrangement not present on cluster |

No correct deployment is inferred from the matching program IDs: the accounts were read
directly and are absent.

## 5. Deployed-ELF digest verification (established loaded-byte procedure)

The W2 checklist requires verifying the deployed ELF bytes against the approved
SHA-256 digests. `verify_ns3_deployment.mjs` verifies program identity, structure, and
authority (Sections A–D) but does not hash deployed bytes; the established on-chain
loaded-byte procedure in this repository is the W1 provenance flow
(`lifecycle_rehearsal/elf_dump.mjs`: read ProgramData bytes via read-only
`getAccountInfo`, strip the 45-byte upgradeable-loader metadata header, hash the ELF
payload, compare against the `provenance.manifest.json` pins).

That procedure was executed reusing the repository's own helper modules
(`programDataPda`, `parseProgramDataAccount`, `validateSbfElfBytes`,
`matchOnChainProgramData`) in a collector script run OUTSIDE the repository (not
committed; no repo file modified). Result (see [elf_digest_check.json](./elf_digest_check.json)):

| Program | Deployed bytes found | Observed SHA-256 | Approved SHA-256 | Result |
|---|---|---|---|---|
| GraveScanner | none (ProgramData absent) | — | `e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98` | **UNVERIFIABLE — no deployed bytes on cluster** |
| GraveVault | none (ProgramData absent) | — | `8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83` | **UNVERIFIABLE — no deployed bytes on cluster** |

There are no deployed ELF bytes to hash, so digest comparison is not possible. This is
reported honestly as an unverifiable category within an overall REJECTED acceptance; it
is not recorded as a pass.

## 6. Configuration verification (Sections B, C, D)

| Item | GraveScanner | GraveVault |
|---|---|---|
| ProtocolConfig PDA (independent derivation) | `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe` (bump 255) — **PASS (B1)**, matches pin | `5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda` (bump 255) — **PASS (B8)**, matches pin |
| Config account exists | **NO — FAIL (B2)** | **NO — FAIL (B9)** |
| Owning program / discriminator / schema decode | not observable (account absent) | not observable (account absent) |
| Governance authority (expected `BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5`) | not observable — **FAIL (B6)** | not observable — **FAIL (B13)** |
| Activity oracle (expected `2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o`) | not observable — **FAIL (C1)** | n/a (vault config carries no oracle fields) |
| Launch-price oracle (expected `97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee`) | not observable — **FAIL (C2)** | n/a |
| Paused state | not observable — **FAIL (D1)** | not observable — **FAIL (D2)** |
| Spec-default configuration values | not observable — **FAIL (B7)** | not observable — **FAIL (B14)** |

The missing ProtocolConfig accounts were NOT initialized. A missing account is a
verification failure, not permission to initialize.

## 7. Legacy residual identities (Section E — report-only, does not affect the verdict)

| Legacy identity | Program ID | Status |
|---|---|---|
| NS-1 scanner | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` | PRESENT, executable, ProgramData upgrade authority `GCCuhCXd5qWVUik38Qv3maoRUoe2upiyJByo2Qyb68yk` |
| NS-1 vault | `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` | PRESENT, executable, ProgramData upgrade authority `GCCuhCXd5qWVUik38Qv3maoRUoe2upiyJByo2Qyb68yk` |
| NS-2 scanner | `CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54` | PRESENT, executable, ProgramData upgrade authority `AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa` |
| NS-2 vault | `Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg` | PRESENT, executable, ProgramData upgrade authority `AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa` |

Historical residue per [docs/LEGACY_DEPLOYMENTS.md](../LEGACY_DEPLOYMENTS.md); report-only.

## 8. Individual check results and overall verifier result

Two independent verifier runs (terminal and `--json`) produced identical verdicts:

- **PASS: 3** (G1 genesis; B1 + B8 PDA derivations)
- **FAIL: 26** (A1–A10; B2–B7, B9–B14; C1–C2; D1–D2)
- **UNVERIFIED: 0** (every RPC call succeeded — absence is definitive, not transport failure)
- **INFO: 4** (legacy residuals, Section E)

**Verifier overall: FAIL (exit code 1).** Raw outputs are preserved verbatim in
[verify_ns3_deployment.output.txt](./verify_ns3_deployment.output.txt) and
[verify_ns3_deployment.output.json](./verify_ns3_deployment.output.json).

## 9. W2 classification: REJECTED

Chosen per the W2 semantics: one or more observed values (program accounts, ProgramData
accounts, ProtocolConfig accounts — all absent) contradict the approved NS-3 deployment
specification. The deployment does not match the approved arrangement because the
approved arrangement is not on the cluster.

Explicitly: this REJECTED classification must not be read as a successful acceptance,
and it does not authorize any deployment change. Closing the gap is an owner-executed
Mode 2 deployment (and Mode 2 initialization/drill/oracle registration) per
[docs/DEVNET.md](../DEVNET.md); after the owner executes it, a fresh W2 run of this
same read-only verifier — unmodified — is the acceptance path. No INCOMPLETE finding
was caused by an RPC failure (unverified count is 0); the only unverifiable sub-item is
the ELF digest comparison, which is impossible by absence of deployed bytes and is
reported as such, not as a pass.

## 10. Security statement

- No production custody path was accessed, listed, inspected, or referenced — including
  the prohibited path under `$HOME/graveyield-ns3-keys/`, which was never touched.
- No private keys or keypair files were accessed, read, copied, or transmitted.
- No transactions were signed or submitted; no RPC method with write semantics was called.
- No program was deployed, upgraded, closed, or initialized (ProtocolConfig accounts
  remain absent by our hand as well as in fact).
- No authority rotation, governance change, oracle registration, or configuration
  change was attempted or performed.
- No pause or unpause operation was performed.
- No verifier check was removed, weakened, or bypassed; the verifier binary executed is
  byte-for-byte the committed file (`3215fa62…`).
- All W2 operations were strictly read-only (`getAccountInfo`, `getGenesisHash`,
  `getEpochInfo`), owner-controlled, and consistent with the PR #83 guardrails.

## 11. Evidence inventory

| File | Content |
|---|---|
| [verify_ns3_deployment.output.txt](./verify_ns3_deployment.output.txt) | Raw terminal output, verifier run 1 (verbatim) |
| [verify_ns3_deployment.output.json](./verify_ns3_deployment.output.json) | Raw machine-readable output, verifier run 2 (`--json`, verbatim) |
| [elf_digest_check.json](./elf_digest_check.json) | Deployed-ELF digest check results (established procedure, repo helper modules) |
| [W2_ACCEPTANCE_REPORT.md](./W2_ACCEPTANCE_REPORT.md) | This report |

Sanitization: all evidence files were scanned for credential markers (`github_pat`,
`ghp_`, `gho_`, `x-access-token`, `password`, `private_key`), URL userinfo, and query
strings — zero matches. The endpoint is the public runbook RPC; all recorded keys are
public keys.
