# Legacy Devnet Deployments — Historical Record

> The program IDs in this document are **legacy**. NS-2 is **confirmed
> deployed and executable on devnet** (read-only verification
> 2026-11-03, §3), but it is **superseded**: its authority key was lost
> (§4), and it is not the active deployment target. The NS-1 deployment
> is retained in this document as a **historical deployment record**;
> its current on-chain status has not been established here. References
> to the legacy deployments remain valid for historical documentation
> and on-chain verification; NS-3 is the next supported deployment
> (§1, §6). Decision record: **DR-002** in
> [`docs/DECISIONS.md`](DECISIONS.md).

## 1. Deployment lineage at a glance

| Generation | Deployed (UTC) | GraveScanner | GraveVault | Upgrade authority | Status |
|---|---|---|---|---|---|
| NS-1 | 2026-10-09 | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` | `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` | single key (`GCCuhCXd…68yk`) | Legacy — retained as a historical deployment record (DR-001 2026-10-25: authority key dead); current on-chain status not established in this document |
| **NS-2 (DR-001 refresh)** | **2026-10-25** | **`CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54`** | **`Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg`** | **`AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa`** | **Legacy — confirmed deployed and executable (§3); authority key permanently lost (DR-002); authority not revoked on-chain** |
| NS-3 | — (deployment pending) | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` (assigned) | `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya` (assigned) | owner deployer key `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` (initial upgrade authority, owner-held) | Preparation — identities assigned (DR-002); repository sync complete; NOT deployed or initialized yet. Becomes the active deployment once recorded in `docs/DEVNET.md` |

## 2. NS-2 deployment record (legacy)

Executed 2026-10-25 (epoch 1191); the full runbook narrative is preserved
as **Appendix A (historical)** of [`docs/DEVNET.md`](DEVNET.md) — the
DEVNET.md body itself is now the NS-3 runbook.

| Item | GraveScanner | GraveVault |
|---|---|---|
| Program ID | `CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54` | `Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg` |
| ProgramData account | `3Gi5CXQFz5c8vfaxnYLWfvMX72gUy1QUSntkS2gfnQfk` | `3SXav4f8qijndQ3pnm2WC7JBPHGEJBJT5pBy6rDST5iy` |
| ProtocolConfig PDA (bump 255) | `Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD` | `hyKk983fguE2CGA5Dx5TLKfBft1AJrm7CHoe1PTUipS` |
| Deploy tx (finalized) | `46kHBf1CNaTnNQUCXGuAyJetzDn5GgKrkK745MtUSdBhuEeqiK3DuB1GnN34GizCkYvQQMYnxByJSWRL6JD3hYPM` (slot 514 928 681) | `5F7RYuP9aXsFjH2fv78ATDG86bPtMUGL6ua2S8aMP6DzrqhnT4DKx73GiHX24K4258QMPv2RspsMBVYYqw8Ly9YS` (slot 514 928 725) |
| Initialize tx (finalized) | `64nYNYuud68irZpi5jgKL5CQNWRMH8jcXGRYiACoVhBRtvsqLCHCCitXeuKMjUTvzdSu6Syab2XKnEbaNMDT7wki` (slot 514 928 823) | `2venFHC3K7JWKWT61H735uK7Yi38fHvz8EnDTpKmAgSj3P8z5tRuaxQ9g1DBSHTxD4BNiuzXf3auv5M3mrNgbLKf` (slot 514 928 827) |
| Deployed bytes | CI run 40178764437 (commit `d4661b4`), sha256 `2e367ea0…cf232`, 367 864 B | CI run 40178764437, sha256 `cbbe3b0f…98518`, 407 184 B |

**Shared historical authority:** `AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa`
— one key held every privileged role of the NS-2 deployment. Each role
is evidenced independently; the ProgramData embedding verified in §3
proves **only** the upgrade-authority role:

- **Program upgrade authority** (both programs): verified on-chain
  from the ProgramData accounts (§3).
- **ProtocolConfig authority** (both programs): verified on-chain by
  read-only decode of both ProtocolConfig accounts (`authority` field
  equals this key; `pending_authority` zeroed) — recorded in
  `docs/assessments/phase4-assessment.md` §4 B1 and re-verified
  read-only 2026-11-03.
- **Oracle signing roles** (`activity_oracle`, `launch_price_oracle`,
  scanner ProtocolConfig): both fields equal this key — recorded from
  the live config accounts 2026-10-26
  (`grave-indexer/docs/ORACLE_PIPELINE.md` §2.4) and re-verified
  read-only 2026-11-03; `initialize` sets both oracles to the authority
  parameter.

Its private key is **permanently lost** (§4 below).

## 3. NS-2 on-chain state (read-only RPC verification, 2026-11-03)

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
   `GraveYield_DR-001_Keypair_Custody_Forensics_2026-11-03`). What was
   actually examined, and nothing more: (a) the original operator
   workspace is **not searchable** — its contents were destroyed by the
   recorded 2026-10-26 workspace reset, which is itself the recorded
   loss event; (b) the **current environment** (a new VM provisioned
   after that reset) was swept end to end: no `*keypair*` file, no
   `devnet-keys/`, no `keys/`, no `target/`, no `~/.config/solana`, no
   shell history, and the canonical addresses absent from every local
   file; (c) git history of all four repositories shows **zero keypair
   files ever committed** (`git log --all --diff-filter=A`); (d) the
   owner-side search of handed-over artifacts and personal storage
   returned nothing (item 3). No other VM, filesystem, or shell history
   was searched, and none is claimed.
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
- The authority was **never revoked on-chain**, so these programs are
  not formally frozen; there is simply no signature holder left, so no
  privileged instruction can succeed.
- Because the same key was also the ProtocolConfig authority (both
  programs) and both oracle signers (verified by read-only
  ProtocolConfig decode, §2), protocol-config changes and attestation
  signing are equally impossible
  (`docs/assessments/phase4-assessment.md` B1/B2).

## 6. Preservation decision (owner directive, 2026-11-03)

- The NS-2 deployments are preserved **untouched** as permanent,
  verifiable historical evidence of the DR-001 refresh and its drills —
  same precedent as NS-1 under DR-001 consequence 3.
- The next supported devnet deployment will be **NS-3**, using fresh
  program IDs. The owner generates and retains all NS-3 keypairs and
  manually executes deployment transactions. Agents may assist with
  preparation and verification but must not handle private keys or
  independently execute deployment transactions (DR-002).
- Recorded as decision **DR-002** in `docs/DECISIONS.md`.

## 7. Where legacy IDs appear

The NS-1/NS-2 IDs remain valid for historical documentation and on-chain
verification. They appear in:

- `docs/LEGACY_DEPLOYMENTS.md` (this file),
- `docs/DECISIONS.md` (decision records),
- **Appendix A** of `docs/DEVNET.md` (the preserved NS-2 execution
  record, explicitly marked historical below the NS-3 runbook body),
- historical evidence artifacts (forensic reports, worklog entries,
  assessment records, bundles/patches of frozen commits),
- the inert ID constants in the tree pending the NS-3 ID sync (§8).

Once NS-3 is recorded in `docs/DEVNET.md`, active code paths and active
documentation point at the NS-3 IDs (the same acceptance rule NS-2
applied to NS-1's IDs, DR-001 consequence 4).

Deployment credentials are never committed to Git, printed in logs, or
exposed in agent output.

## 8. How to tell legacy from active

- **Active deployment** = the one recorded at the top of
  `docs/DEVNET.md` with a deployment date after 2026-11-03, using
  program IDs different from every ID in this file. Until the NS-3
  entry exists, build and test against localnet
  (`scripts/devnet/local_rehearsal_ns3.sh` — the keypair-free NS-3
  rehearsal — or `solana-test-validator`).
- Any constant in the tree still naming `CuQZes…` / `Bd5smh…` refers to
  the LEGACY deployment. Those constants are inert placeholders pending
  the NS-3 ID sync (catalogue: `docs/DECISIONS.md` DR-001 consequence 4
  — `declare_id!` ×2, `Anchor.toml` `[programs.*]`,
  `deploy_devnet.sh` expected IDs, `protocol_admin.mjs`, SDK constants,
  `indexer/src/config.ts`, `ops/src/config.ts`, console `data.ts`, and
  the pinned PDA vectors in tests).
- Read-only RPC queries against the legacy programs return real account
  data — the programs remain deployed and executable on-chain. What
  cannot succeed is every authority-dependent action: upgrades,
  authority changes, close, protocol-config updates, and attestation
  signing all require a signature from the lost key (§5).

## 9. References

- Forensic report: `GraveYield_DR-001_Keypair_Custody_Forensics_2026-11-03` (owner's copy)
- `docs/assessments/phase4-assessment.md` §4 B1/B2, §8 D1/D2
- `docs/DECISIONS.md` — DR-001 (2026-10-25), DR-002 (2026-11-03)
- `docs/DEVNET.md` — NS-2 execution record (superseded status banner)
- `grave-indexer/docs/ORACLE_PIPELINE.md`, `grave-indexer/docs/ORACLE_CUSTODY.md`
- Worklog entries: `DR-001-FORENSICS`, `DR-001-CLOSURE`, `LEGACY-FREEZE-1`
