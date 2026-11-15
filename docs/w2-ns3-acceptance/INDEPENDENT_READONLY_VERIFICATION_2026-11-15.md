# Independent Read-Only Verification — NS-3 Devnet, 2026-11-15

## 1. Purpose and provenance

This file is the committed repository record of the independent read-only
verification of the live NS-3 Devnet deployment performed on **2026-11-15**
during the review of [PR #110](https://github.com/GraveYield/graveyield-protocol/pull/110)
("docs: reconcile NS-3 deployment and acceptance records", merged
2026-11-15, merge commit `3ac3c9f944b4619faa0507ed3d4de30cce3d9aa0`).

**Source of record:** the "Independent current-state verification" section of
the PR #110 description — the surviving author record of the run. The
verification was performed with ad-hoc plain JSON-RPC calls rather than the
repository's verifier scripts, and the raw per-check RPC transcript was not
retained as a repository artifact; the PR description is therefore the only
public statement of the run. Sections 3 and 4 below transcribe that PR record
**verbatim** — nothing has been added, removed, or re-interpreted. Where the
PR record truncates a digest (e.g. `e24ddc5e…6c98`), the truncation is
reproduced as recorded; the full pinned digests live in
[`scripts/devnet/provenance.manifest.json`](../../scripts/devnet/provenance.manifest.json).

This record supplements — and does not replace or amend — the recorded W2
post-deployment acceptance
([`W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md`](W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md),
29/29 + 27/27, combined 56/56), which remains the primary in-repo acceptance
evidence for the deployment itself.

## 2. Verification parameters (as recorded in PR #110)

| Field | Value |
| --- | --- |
| Date | 2026-11-15 |
| Cluster | Solana Devnet (`https://api.devnet.solana.com`) |
| Result | 14/14 checks passed |
| Finalized slot | `522363929` |
| Epoch | `1209` |
| RPC methods used | `getGenesisHash`, `getEpochInfo`, `getAccountInfo`, `getTransaction`, `getBlockTime` only |
| Tooling | ad-hoc plain JSON-RPC — the repository's own verifier scripts were not used (no Node toolchain was exercised in the PR-authoring environment) |
| Access mode | strictly read-only; no keys, no transactions, no state mutation |
| Repository state under verification | PR #110 head `38b6afca2fb9a4688d394fa715bd113ff42e2d33` (ELF digests checked against the provenance-manifest pins as of that commit) |
| Raw per-check output transcript | **not retained** — the PR #110 description (transcribed in Section 3) is the surviving record |

## 3. Checks performed and results (verbatim transcription of the PR #110 record)

> **Independent current-state verification (this PR, 2026-11-15; plain JSON-RPC to `https://api.devnet.solana.com` using only `getGenesisHash` / `getEpochInfo` / `getAccountInfo` / `getTransaction` / `getBlockTime` — the repository's own verifier scripts were not used): 14/14 checks passed at finalized slot 522363929 (epoch 1209).**
>
> - Cluster identity: genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` matches the pinned Devnet genesis.
> - GraveScanner `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL`: program account exists, executable, owned by `BPFLoaderUpgradeab1e…`, 36-byte Program account; embedded ProgramData pointer reads `FxYDhTruh16EoKBgiJaWZCQ9QojWQZGS8J1dXyfSt9dG` (loader-owned, tag 3, deploy slot 521526224, upgrade authority `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831`); extracted ELF payload is 321,056 B and its SHA-256 `e24ddc5e…6c98` matches the provenance-manifest pin.
> - GraveVault `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya`: same shape; ProgramData `9wyRhAC8Sasb46bhWW4jxsK6rGKpEGXf6Riz2ibKZgC4` (tag 3, deploy slot 521526300, same upgrade authority); payload 361,528 B, SHA-256 `8c71fe9d…3e83` matches the pin.
> - ProtocolConfig PDAs re-derived from scratch (own base58 + ed25519 off-curve implementation, no repo code): scanner `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe` (bump 255), vault `5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda` (bump 255). Both accounts exist, are owned by their program, carry the `account:ProtocolConfig` discriminator, decode at 252 B / 210 B with authority `BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5`, spec-default values, scanner `paused = false` with the dedicated activity oracle `2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o` and launch-price oracle `97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee` registered, vault `emergency_paused = false`.
> - All five recorded transactions landed on Devnet with `meta.err = null`: scanner deploy slot 521526224, vault deploy 521526300, scanner init 521526590, vault init 521526710, oracle registration 521552630; `getBlockTime` dates them 2026-11-12 (16:40–16:42 UTC deploys + initializations; 18:25 UTC oracle registration).

## 4. Recorded limitations (verbatim transcription of the PR #110 record)

> - The independent verification is a point-in-time read-only observation (2026-11-15). It does not establish that the recorded state will persist — the upgrade authority remains the single deployer key, and nothing here constrains future changes.
> - No security-audit completion is claimed. The W2 governance drills remain the specific tested pause / unauthorized-pause / unpause operations, not a comprehensive authorization assessment.
> - No end-to-end salvage lifecycle has occurred on Devnet, and this PR claims none. No EligibilityAnchor / EligibilityCert / LaunchPrice / PoolRegistry / SalvageReceipt / ClaimRecord activity was asserted.
> - The five recorded transactions were confirmed via `getTransaction` within the RPC retained-history window; beyond that window they are corroborated only by the recorded acceptance artifacts.
> - The repository's own verifier scripts (`verify_ns3_deployment.mjs`, `verify_ns3_elf_digests.mjs`) were not re-executed in this PR's environment (no Node toolchain was exercised); the 29/29 + 27/27 figures cited are the recorded W2 artifacts, cross-checked against the committed evidence files and reproduced independently at the raw-RPC level (as described above), not re-derived with the repo tooling.
> - Configuration decoding used the on-disk Rust struct layouts (`programs/*/src/state/protocol_config.rs`); agreement of account sizes (252 B / 210 B) and discriminators with the deployed accounts is the consistency evidence, not a layout proof.
> - Mainnet state is entirely out of scope: nothing was verified or claimed about Mainnet.

The PR #110 description additionally records two limitations scoped to that
PR's other work streams (the SC-03 rehearsal documentation and the
fork-harness flake fix); they are not specific to this verification and are
not reproduced here. See the
[PR #110 description](https://github.com/GraveYield/graveyield-protocol/pull/110)
for the complete list.

## 5. Evidence inventory

- **Source of record:** PR #110 description
  (<https://github.com/GraveYield/graveyield-protocol/pull/110>), section
  "Independent current-state verification" — merged 2026-11-15
  (`3ac3c9f944b4619faa0507ed3d4de30cce3d9aa0`); transcribed verbatim in Sections 3–4 of this file.
- **Corroborating in-repo acceptance records (the deployment's primary
  evidence):** [`W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md`](W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md)
  with `evidence/verify_acceptance_post_deployment.txt`,
  `evidence/verify_elf_digests_post_deployment.txt`, and
  [`scripts/devnet/provenance.manifest.json`](../../scripts/devnet/provenance.manifest.json).
- **Reproduction path going forward:** the repository's own read-only
  verifiers remain the reproducible acceptance route —
  `node scripts/devnet/verify_ns3_deployment.mjs --url https://api.devnet.solana.com`
  (29 deployment checks) and
  `node scripts/devnet/verify_ns3_elf_digests.mjs --url https://api.devnet.solana.com`
  (27 digest checks), as documented in
  [`docs/DEVNET.md`](../DEVNET.md) §5. Re-running them produces new
  point-in-time observations at new slots; it does not re-execute the
  2026-11-15 run recorded here.

## 6. Conclusion

On 2026-11-15, an independent read-only pass using only
`getGenesisHash` / `getEpochInfo` / `getAccountInfo` / `getTransaction` /
`getBlockTime` against `https://api.devnet.solana.com` passed 14/14 checks
at finalized slot `522363929` (epoch 1209), as recorded in PR #110 and
transcribed above. That is a point-in-time observation of the live Devnet
deployment — it is not a security audit, not a Mainnet statement, and not
evidence that a controlled end-to-end salvage has run; the limitations in
Section 4 apply to this record in full.
