# Legacy Devnet Deployments — Permanent Frozen Record

> **READ THIS FIRST.** The program IDs in this document are **LEGACY**.
> They are permanently frozen and must never be targeted, upgraded,
> re-used, or referenced as "the deployment" by any developer, agent,
> script, or CI job. Until a future NS-3 deployment is executed and
> recorded in [`docs/DEVNET.md`](DEVNET.md), **no active devnet
> deployment exists**. Decision record: **DR-002** in
> [`docs/DECISIONS.md`](DECISIONS.md). Owner directive of 2026-11-03.

## 1. Deployment lineage at a glance

| Generation | Deployed (UTC) | GraveScanner | GraveVault | Upgrade authority | Status |
|---|---|---|---|---|---|
| NS-1 | 2026-10-09 | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` | `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` | single key (`GCCuhCXd…68yk`) | Legacy — frozen (DR-001, 2026-10-25: key dead) |
| **NS-2 (DR-001 refresh)** | **2026-10-25** | **`CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54`** | **`Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg`** | **`AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa`** | **Legacy — frozen by this record: key permanently lost** |
| NS-3 | — | TBD | TBD | TBD (owner-generated, owner-held) | Future — the only deployment that may be created |

## 2. NS-2 deployment record (frozen by this document)

Executed 2026-10-25 (epoch 1191); full runbook narrative in
[`docs/DEVNET.md`](DEVNET.md) (status line there is superseded — see its
banner).

| Item | GraveScanner | GraveVault |
|---|---|---|
| Program ID | `CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54` | `Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg` |
| ProgramData account | `3Gi5CXQFz5c8vfaxnYLWfvMX72gUy1QUSntkS2gfnQfk` | `3SXav4f8qijndQ3pnm2WC7JBPHGEJBJT5pBy6rDST5iy` |
| ProtocolConfig PDA (bump 255) | `Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD` | `hyKk983fguE2CGA5Dx5TLKfBft1AJrm7CHoe1PTUipS` |
| Deploy tx (finalized) | `46kHBf1CNaTnNQUCXGuAyJetzDn5GgKrkK745MtUSdBhuEeqiK3DuB1GnN34GizCkYvQQMYnxByJSWRL6JD3hYPM` (slot 514 928 681) | `5F7RYuP9aXsFjH2fv78ATDG86bPtMUGL6ua2S8aMP6DzrqhnT4DKx73GiHX24K4258QMPv2RspsMBVYYqw8Ly9YS` (slot 514 928 725) |
| Initialize tx (finalized) | `64nYNYuud68irZpi5jgKL5CQNWRMH8jcXGRYiACoVhBRtvsqLCHCCitXeuKMjUTvzdSu6Syab2XKnEbaNMDT7wki` (slot 514 928 823) | `2venFHC3K7JWKWT61H735uK7Yi38fHvz8EnDTpKmAgSj3P8z5tRuaxQ9g1DBSHTxD4BNiuzXf3auv5M3mrNgbLKf` (slot 514 928 827) |
| Deployed bytes | CI run 40178764437 (commit `d4661b4`), sha256 `2e367ea0…cf232`, 367 864 B | CI run 40178764437, sha256 `cbbe3b0f…98518`, 407 184 B |

**Shared historical upgrade authority:** `AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa`
— a single key that simultaneously held: program upgrade authority for
both programs, ProtocolConfig authority for both programs, and both
oracle signing roles (`activity_oracle`, `launch_price_oracle` —
`docs/assessments/phase4-assessment.md` §4 B1; `ORACLE_PIPELINE.md`).
Its private key is **permanently lost** (§4 below).

## 3. On-chain state (read-only RPC verification, 2026-11-03)

All four accounts verified live against `https://api.devnet.solana.com`
via read-only `getAccountInfo`:

| Account | Owner | Executable | Lamports | Data (B) | Embedded relation |
|---|---|---|---|---|---|
| Scanner program `CuQZes…Ao54` | `BPFLoaderUpgradeab1e…` | yes | 833 120 | 36 | embeds ProgramData `3Gi5CX…` at offset 4 ✓ |
| Scanner ProgramData `3Gi5CX…` | `BPFLoaderUpgradeab1e…` | no | 1 869 627 960 (≈1.87 SOL) | 367 909 | embeds authority `AsB5u…` at offset 13 ✓ |
| Vault program `Bd5smh…7rg` | `BPFLoaderUpgradeab1e…` | yes | 833 120 | 36 | embeds ProgramData `3SXav4…` at offset 4 ✓ |
| Vault ProgramData `3SXav4…` | `BPFLoaderUpgradeab1e…` | no | 2 069 373 560 (≈2.07 SOL) | 407 229 | embeds authority `AsB5u…` at offset 13 ✓ |

The authority embedding has been unchanged since the deploy slots —
no upgrade, authority rotation, or close was ever attempted.

## 4. What happened to the authority key

1. The NS-2 keypairs (scanner, vault, deployer) were minted 2026-10-25
   in that deployment session's operator-workspace custody directory
   (convention `devnet-keys/` per `deploy_devnet.sh` `KEYS_SRC`), used
   for the deployment and the emergency-control drills, and destroyed by
   the recorded 2026-10-26 workspace reset. The export to the owner was
   recorded as **"unverified"** (`docs/assessments/phase4-assessment.md`
   §4 B1; `ORACLE_PIPELINE.md`).
2. Forensic investigation 2026-11-03 (owner's report:
   `GraveYield_DR-001_Keypair_Custody_Forensics_2026-11-03`): no key
   material on any VM, no `~/.config/solana`, no shell history, and
   **zero keypair files ever committed to any repository** (verified via
   `git log --all --diff-filter=A` across all four repos).
3. Owner-side search completed 2026-11-03 with **no findings**
   (owner-confirmed). Decision D1 resolves to branch (b): the key is
   gone.
4. Conclusion: the authority key is **permanently unrecoverable**. No
   further recovery attempts are to be made by anyone.

## 5. Why these deployments cannot be upgraded

- In the BPF upgradeable loader model, every privileged action
  (`Upgrade`, `SetAuthority`, `Close`) requires a signature from the
  ProgramData account's upgrade authority — verified on-chain to be
  `AsB5u…` (§3).
- An ed25519 private key cannot be reconstructed from its public key,
  and the chain offers no override or recovery path.
- **Formal vs operational freeze (owner-mandated distinction):** the
  authority was **never revoked on-chain** — these programs are *not*
  formally frozen on-chain. They are **operationally frozen**: no
  signature holder exists, so no privileged instruction can ever
  succeed. Treat them as permanently inaccessible.
- Because the same key was also the config authority and both oracle
  authorities, protocol-config changes and attestation signing are
  equally impossible (`docs/assessments/phase4-assessment.md` B1/B2).

## 6. Preservation decision (owner directive, 2026-11-03)

- The NS-2 deployments are preserved **untouched** as permanent,
  verifiable historical evidence of the DR-001 refresh and its drills —
  same precedent as NS-1 under DR-001 consequence 3.
- All future work uses **fresh program IDs (NS-3)**. The new deployment
  authority will be generated and secured **manually by the project
  owner**; the owner and their own assistant will execute the
  redeployment manually, one verified step at a time. Agents are NOT
  authorized to generate credentials, deploy, build a deployment, or
  perform any on-chain transaction.
- Recorded as decision **DR-002** in `docs/DECISIONS.md`.

## 7. Binding preservation rules

1. Do not upgrade, close, withdraw, transfer, or modify either legacy
   program or its ProgramData account.
2. Do not attempt to recover, replace, or bypass the lost authority.
3. Do not generate new program keypairs or authority wallets (agents).
4. Do not deploy any program (agents).
5. Do not change the legacy program IDs in source code or configuration
   until the owner-approved NS-3 sync.
6. Do not delete or overwrite deployment artifacts, keypairs, manifests,
   or historical records; do not remove deployment history from
   documentation.
7. Deployment credentials must never be committed to Git, printed in
   logs, or exposed in agent output.

The legacy IDs may appear only in: this file, historical/appendix
documentation, and historical evidence artifacts. After NS-3, they must
not appear in any active code path (same acceptance rule NS-2 applied to
NS-1's IDs).

## 8. How to tell legacy from active

- **Active deployment = the one recorded at the top of
  `docs/DEVNET.md` with a matching status line and a deployment date
  after 2026-11-03, using program IDs different from every ID in this
  file.** Until that entry exists, there is no active devnet deployment;
  build and test against localnet
  (`scripts/devnet/local_rehearsal.sh` / `solana-test-validator`).
- Any constant in the tree still naming `CuQZes…` / `Bd5smh…` refers to
  the LEGACY deployment. Those constants are inert placeholders pending
  the NS-3 ID sync (catalogue: `docs/DECISIONS.md` DR-001 consequence 4
  — `declare_id!` ×2, `Anchor.toml` `[programs.*]`,
  `deploy_devnet.sh` expected IDs, `protocol_admin.mjs`, SDK constants,
  `indexer/src/config.ts`, `ops/src/config.ts`, console `data.ts`, and
  the pinned PDA vectors in tests).
- Do not point admin tooling (`protocol_admin.mjs`) at devnet expecting
  an active deployment: authority actions would fail, and read-only
  calls would hit tombstones.

## 9. References

- Forensic report: `GraveYield_DR-001_Keypair_Custody_Forensics_2026-11-03` (owner's copy)
- `docs/assessments/phase4-assessment.md` §4 B1/B2, §8 D1/D2
- `docs/DECISIONS.md` — DR-001 (2026-10-25), DR-002 (2026-11-03)
- `docs/DEVNET.md` — NS-2 execution record (superseded status banner)
- `grave-indexer/docs/ORACLE_PIPELINE.md`, `grave-indexer/docs/ORACLE_CUSTODY.md`
- Worklog entries: `DR-001-FORENSICS`, `DR-001-CLOSURE`, `LEGACY-FREEZE-1`
