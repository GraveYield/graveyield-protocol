# W2 — NS-3 Post-Deployment Devnet Acceptance

**Classification:** ACCEPTED — DEVNET DEPLOYMENT VERIFICATION
**Network:** Solana Devnet
**RPC endpoint:** `https://api.devnet.solana.com`
**Commitment:** Finalized

## 1. Executive Summary

The owner-controlled W2 NS-3 Devnet deployment and initialization have been completed.

Both NS-3 programs are deployed and executable. Their ProtocolConfig accounts are initialized. Governance pause and unpause drills succeeded for both programs, and unauthorized pause attempts were rejected.

The GraveScanner ProtocolConfig contains the registered activity and launch-price oracle addresses. Both deployed ELF payloads match their approved SHA-256 pins in the provenance manifest.

| Verification | Result |
|---|---:|
| Deployment acceptance verifier | PASS — 29/29 |
| ELF digest verifier | PASS — 27/27 |
| Combined checks | **PASS — 56/56** |
| Failed checks | 0 |
| Unverified checks | 0 |

The verifiers used separate finalized Devnet reads:
- Deployment acceptance: slot `521557300`, epoch `1207`.
- ELF digest verification: slot `521557485`, epoch `1207`.

This establishes the recorded W2 NS-3 Devnet acceptance conditions. It does not establish Mainnet readiness, security-audit completion, or full end-to-end GraveYield lifecycle operation.

## 2. Chronology and Earlier Records

The earlier W2 documents describe the pre-deployment state and remain unchanged.

1. `W2_NS3_PREFLIGHT_COMPLETION_REPORT.md` classified the work as READY FOR OWNER REVIEW, not deployment acceptance.
2. `W2_NS3_PREFLIGHT_CORRECTIONS.md` documented six corrections while retaining that preflight classification.
3. `W2_ACCEPTANCE_REPORT.md` recorded a REJECTED result because the NS-3 programs and ProtocolConfig accounts were absent during that earlier run.
4. The owner subsequently deployed both NS-3 programs, initialized both ProtocolConfig accounts, completed governance drills, and registered the GraveScanner oracle addresses.
5. The later post-deployment verifiers returned PASS.

The earlier REJECTED result remains a valid historical record of its original run. It does not represent the later post-deployment state.

## 3. Network and Program Identity

| Field | Value |
|---|---|
| Network | Solana Devnet |
| Genesis hash | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| RPC endpoint | `https://api.devnet.solana.com` |
| Commitment | finalized |

| Program | Program ID |
|---|---|
| GraveScanner NS-3 | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` |
| GraveVault NS-3 | `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya` |

Both program accounts were verified as executable and owned by the BPF Upgradeable Loader. Their ProgramData pointers were independently derived, and their ProgramData accounts decoded successfully.

| Role | Address |
|---|---|
| Deployer / upgrade authority | `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` |
| Governance | `BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5` |
| Activity oracle | `2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o` |
| Launch-price oracle | `97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee` |

The verifier confirmed that both ProtocolConfig governance authorities match the pinned governance address.

## 4. ProtocolConfig Initialization

| Program | ProtocolConfig PDA |
|---|---|
| GraveScanner NS-3 | `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe` |
| GraveVault NS-3 | `5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda` |

Both accounts passed ownership, discriminator, schema, governance-authority, and approved-default checks.

The verifier also confirmed:
- GraveScanner `paused = false`.
- GraveVault `emergency_paused = false`.
- GraveScanner's activity oracle address is registered.
- GraveScanner's launch-price oracle address is registered.

Oracle registration is recorded for GraveScanner only. This report does not claim a separate Vault oracle registration.

## 5. Deployment and Initialization Transactions

The following transaction signatures record the owner-controlled Devnet operations:

| Operation | Transaction signature |
|---|---|
| GraveScanner NS-3 deployment | `4ZPJW8sZubvLcoMa6KK8MDJFChcgx61BMt7hhSfMXvEkyGwMhSmJYTfsehE2b2LZg73k65WaJaL6B71WG6JjBXQ8` |
| GraveVault NS-3 deployment | `7jV6Ao2uDycUrZ8KTpKyxWpvetewwaChvUYCTE58jYsVFwvVaUnf5rBp5rD57VFQJos5wEg7WaXopw1aybKDqCG` |
| GraveScanner ProtocolConfig initialization | `27buHLDqnsagD7YMvEopQsxW6v3Uy6PraXEUp8yeMStCXZT6q1zpixrN6aR2NNA33EdXdBoWAmmnPMQFEmH3nrik` |
| GraveVault ProtocolConfig initialization | `36WE4ZhLNNLfJGfhuxaze5n8KNu2RP3FMBvCexV1vpmtShFuvDTRbjuqiYqWQykFvNcXBhGBYSpmGD1WauBToraL` |
| GraveScanner oracle registration | `3US6jRzFC3yrx9qaqPMaVajEVcMdjau7eNKgpXrYwVGNrX73ESaQBXdGSUJyfCptaF7KhGCJgCqQnCyYGfAEfw5Z` |

Oracle registration in this record applies to GraveScanner. No separate GraveVault oracle-registration transaction is claimed.

## 6. Governance Authorization Drills

Both programs completed governance pause and unpause drills on Devnet.

| Test | GraveScanner | GraveVault |
|---|---|---|
| Governance pause | PASS | PASS |
| Paused-state readback | PASS | PASS |
| Unauthorized pause attempt | Rejected: `Unauthorized (0x1770)` | Rejected: `Unauthorized (0x1b58)` |
| Governance unpause | PASS | PASS |
| Final state | `paused = false` | `emergency_paused = false` |

The unauthorized attempts were made using the owner-supplied intruder address. Both programs rejected the unauthorized requests.

These drills establish the tested authorization behavior for the recorded Devnet operations. They do not constitute a comprehensive security audit.

## 7. Post-Deployment Acceptance Verification

Evidence file: `evidence/verify_acceptance_post_deployment.txt`

Command executed:

`node scripts/devnet/verify_ns3_deployment.mjs --url https://api.devnet.solana.com`

Result:

- Overall: `PASS`
- Passed checks: 29
- Failed checks: 0
- Unverified checks: 0
- Informational observations: 6
- Finalized context slot: `521557300`
- Epoch: `1207`
- Commitment: `finalized`

The verifier confirmed the NS-3 program identities, executable status, ProgramData relationships, initialized ProtocolConfig accounts, governance authorities, approved configuration values, and GraveScanner oracle addresses.

The six informational observations are documented in Section 9. They do not change the verifier's PASS result.

## 8. Deployed ELF Digest Verification

Evidence file: `evidence/verify_elf_digests_post_deployment.txt`

Command executed:

`node scripts/devnet/verify_ns3_elf_digests.mjs --url https://api.devnet.solana.com`

Result:

- Overall: `PASS`
- Passed checks: 27
- Failed checks: 0
- Unverified checks: 0
- Finalized context slot: `521557485`
- Epoch: `1207`
- Commitment: `finalized`

The verifier confirmed that both deployed ELF payloads match the SHA-256 values pinned in `scripts/devnet/provenance.manifest.json`.

| Program | ELF payload size | SHA-256 |
|---|---:|---|
| GraveScanner NS-3 | 321056 bytes | `e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98` |
| GraveVault NS-3 | 361528 bytes | `8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83` |

Both payloads were identified as SBPF v0 (`e_machine 263`, `e_flags 0`). The verifier also confirmed the expected NS-3 structural identity and absence of legacy program IDs in allocated sections.

This result establishes agreement between the deployed ELF payloads and the manifest's pinned digests. It does not independently establish the authenticity of every build dependency or the provenance manifest's original trust anchors.

## 9. Informational Observations and Scope Limitations

The deployment acceptance verifier returned six INFO observations:

1. **Pending authority — GraveScanner:** `pending_authority=11111111111111111111111111111111`, `pending_authority_eta=0`. These are reserved write-only state fields, not an enforced timelock.
2. **Pending authority — GraveVault:** `pending_authority=11111111111111111111111111111111`, `pending_authority_eta=0`. These are reserved write-only state fields, not an enforced timelock.
3. **Legacy NS-1 GraveScanner:** `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` remains present and executable. Upgrade authority: `GCCuhCXd5qWVUik38Qv3maoRUoe2upiyJByo2Qyb68yk`.
4. **Legacy NS-1 GraveVault:** `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` remains present and executable. Upgrade authority: `GCCuhCXd5qWVUik38Qv3maoRUoe2upiyJByo2Qyb68yk`.
5. **Legacy NS-2 GraveScanner:** `CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54` remains present and executable. Upgrade authority: `AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa`.
6. **Legacy NS-2 GraveVault:** `Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg` remains present and executable. Upgrade authority: `AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa`.

The verifier identifies the four legacy deployments as historical residue that does not affect the NS-3 verdict.

### Scope Limitations

- This acceptance applies to Solana Devnet only.
- It is not a Mainnet deployment approval.
- It is not a security-audit certification.
- It does not establish full end-to-end GraveYield lifecycle operation.
- Matching ELF digests do not independently prove the authenticity of all build dependencies or the provenance manifest's original trust anchors.
- The governance drills cover the specific tested pause, unauthorized-pause, and unpause operations; they are not a comprehensive authorization assessment.


## 10. Evidence Inventory

### New post-deployment verifier outputs

- `docs/w2-ns3-acceptance/evidence/verify_acceptance_post_deployment.txt`
- `docs/w2-ns3-acceptance/evidence/verify_elf_digests_post_deployment.txt`

### Historical records preserved

- `docs/w2-ns3-acceptance/W2_ACCEPTANCE_REPORT.md`
- `docs/w2-ns3-acceptance/W2_NS3_PREFLIGHT_COMPLETION_REPORT.md`
- `docs/w2-ns3-acceptance/W2_NS3_FINAL_OWNER_HANDOFF.md`
- `docs/w2-ns3-acceptance/W2_NS3_PREFLIGHT_CORRECTIONS.md`

The historical records above were retained as historical evidence and were not rewritten by this post-deployment report.

## 11. Conclusion

W2 NS-3 has passed the documented owner-controlled Solana Devnet deployment acceptance checks. The post-deployment acceptance verifier passed 29 of 29 checks, and the deployed ELF digest verifier passed 27 of 27 checks. Combined result: 56 passed, 0 failed, and 0 unverified.

The evidence confirms that both NS-3 programs are deployed and executable, their ProtocolConfig accounts are initialized with the expected governance authority and approved defaults, the tested governance pause/unpause controls behave as expected, GraveScanner's two oracle addresses are registered, and both deployed ELF payloads match the SHA-256 values pinned in the provenance manifest.

The six INFO observations remain part of the record: two pending-authority fields are reserved write-only state rather than enforced timelocks, and four legacy NS-1/NS-2 program deployments remain present on Devnet.

**Final classification: W2 NS-3 Devnet deployment acceptance — PASS.**

This classification is limited to the tested Devnet deployment and verification scope. It is not Mainnet deployment approval, security-audit certification, or proof of complete end-to-end GraveYield lifecycle operation. Earlier preflight and rejected acceptance reports remain unchanged and accurately describe their earlier states.
