# GY-OPS-RB-05 — Manual Locker Screening Runbook

- **Version:** 1.0.0
- **Status:** OWNER-RATIFIED FOR M1
- **Decision:** DR-003 / D-05 / Q-04
- **Scope:** Protocol-wide, inventory-scoped best-effort screening
- **Mandatory limitation:** Best-effort screening against a ratified inventory — not universal detection.

## 1. Purpose

This runbook supplements the on-chain UNCX adapter. The current adapter is strict and fail-closed for UNCX, but does not detect every non-UNCX locker or custody arrangement. The purpose of this procedure is to detect known locks and unknown LP custody before Phase 2 certification and salvage.

A PASS is always qualified. It means no lock was found within the exact queried inventory and generic custody enumeration at the recorded slot. It does not mean no possible lock exists.

## 2. Roles

- **Operator:** performs the checks, captures raw responses, produces the artifact, and signs the result.
- **Independent reviewer:** independently re-executes the UNCX check, samples per-locker queries and generic custody enumeration, verifies the hashes and inventory version, and countersigns.
- A single-signature record is incomplete and cannot be used as a qualified PASS.

## 3. Required inputs

- Pool address and AMM program.
- LP mint and token program (SPL Token / Token-2022 as applicable).
- Cluster identity: local Mainnet fork for M1.
- Approved RPC endpoint(s), endpoint identity, commitment, and request timestamps.
- Versioned `locker-inventory.json`, validated against `docs/ops/locker-inventory.schema.json`.
- Exact account filters and layouts for every inventory entry queried.
- Operator and reviewer identities.
- Snapshot context and certification phase.

## 4. Procedure

### R0 — Initialize the run

Create one run record per `(run_id, pool)`. Record cluster, RPC endpoint, commitment, pool, AMM, LP mint, token program, operator, reviewer, start time, and inventory version.

### R1 — Load the ratified inventory

Load the versioned inventory. The inventory data (`docs/ops/locker-inventory.json`) must be validated against its schema (`docs/ops/locker-inventory.schema.json`, `gy.locker-inventory.v1`) before use, and the inventory version and SHA-256 must be recorded in the screening artifact. Each relied-upon entry must specify:
- name and program ID;
- account type;
- discriminator and account size;
- mint/pool offsets and filters;
- PDA derivation where applicable;
- source evidence and validation date;
- ratifier and approval timestamp.

**Inventory status at ratification:** UNCX is the only locker whose account layout and adapter are verified in-repository. Streamflow, Team Finance, PinkSale, and other candidate lockers are not query-authoritative until their program IDs, layouts, and filters have been independently confirmed and included in a later inventory version. Do not invent or guess program IDs.

### R2 — UNCX marker check

Derive the UNCX marker PDA for the AMM and query it at the recorded commitment.
- Absent marker: evidence of no UNCX lock for that AMM at the queried state only.
- Present marker: retrieve and validate all associated TokenLock evidence; do not certify without complete remaining-account evidence. Each retained TokenLock raw response is hashed and recorded in the artifact (`uncx_check.token_lock_evidence_sha256`); a present marker with no retained TokenLock evidence cannot support PASS.
- Any malformed, inconsistent, or unavailable response: fail closed.

Preserve the raw JSON response, derived PDA, endpoint, slot/context, timestamp, and SHA-256.

### R3 — Per-locker sweeps

For every additional inventory entry that has been validated:
- issue `getProgramAccounts` with exact, versioned filters;
- record program ID, filters, account size, discriminator, mint offsets, commitment, response context, and timestamp;
- preserve raw response and SHA-256;
- do not widen filters to force a result;
- record pagination limitations. If the endpoint cannot return a complete result, the query is incomplete and cannot support PASS.

A zero-account result is evidence of absence only for the queried program, filters, and recorded state.

### R4 — Generic LP custody enumeration

Enumerate token accounts for the LP mint using exact mint filters for the applicable token program.

**Token-program coverage (mandatory, fail-closed).**

1. Determine the token program that owns the LP mint by reading the mint account, and record the determination and its evidence.
2. Run full `getProgramAccounts` enumeration for the LP mint under that token program.
3. Run the same mint-filtered query against the other token program (SPL Token or Token-2022) and record its result. Token accounts for a mint exist only under the mint's own token program, so any nonzero result under the other program shows that the recorded mint-program determination is wrong or the query was mis-scoped; the run fails closed and must be restarted with a corrected, re-verified determination.
4. If the LP mint is a Token-2022 mint, record its extension set explicitly in the artifact (a per-extension array; null is required for SPL Token mints) and apply the per-extension rules below. Do not rely on a fixed account-size filter for Token-2022 accounts: extensions change the account data size, so a size filter can silently drop accounts. Use mint memcmp filters; if a size filter must be used, its value must be justified against the recorded extension set, otherwise the query is incomplete and fails closed.

   Per-extension handling — fail-closed unless an adequate verification method is recorded in the artifact:
   - **transfer-fee:** withheld-fee amounts are not visible in ordinary balance reads; either include withheld amounts in the relevant balance reconciliation or record the extension as unsupported. A run whose reconciliation omits withheld-fee amounts cannot PASS.
   - **confidential transfer / confidential balances:** confidential amounts are invisible to public-balance enumeration. Ordinary enumeration must not produce a PASS without an adequate, recorded verification method covering the confidential component; otherwise the run ends `INCOMPLETE_FAIL_CLOSED`.
   - **transfer-hook:** hook-mediated custody is reportable; attribute the hook program and classify its custody paths under the PDA rules below.
   - **any other extension:** record it, assess its effect on enumeration and reconciliation, and treat an unverifiable effect as incomplete (fail closed).
5. Validate every returned token account before it enters the aggregation: the account's owner program matches the queried token program; its mint field equals the LP mint; its data parses to the expected layout (base layout plus the recorded extension layouts for Token-2022); and its account state is recorded. An account failing any of these checks is malformed evidence and fails closed. Record the completion of these checks in the artifact (`token_program_coverage.account_validation`).
6. An unsupported token program, an ambiguous mint-program determination, or skipped token-program coverage cannot produce a PASS.

Aggregate balances by owner and classify each owner:
- known holder wallet;
- approved benign custody with written basis;
- known locker/custody program;
- unknown wallet/PDA/custodian.

**PDA owner classification (mandatory, fail-closed).** A PDA owner must never be classified as a known holder wallet. An account's on-chain owner program identifies the program that owns the account data; it does not, by itself, prove which program derived an arbitrary PDA or under which seeds. For every PDA owner:

1. fetch the PDA account and record its owning program;
2. attempt attribution with documented derivation evidence — re-derive candidate PDAs from each ratified-inventory program using known, documented seeds and compare the derived addresses to the observed address;
3. record the derivation inputs (program ID and seeds), the owning program, and the custody conclusion in the artifact.

Attribution is accepted only when a derived address matches the observed address and the derivation inputs are recorded. If the PDA cannot be attributed reliably — the owning program is undeterminable or outside the ratified inventory, no known seed set reproduces the address, or the custody path cannot be documented — the owner remains classified as an unknown custodian and the run ends `DISQUALIFIED_UNKNOWN_CUSTODIAN`. Reclassification as approved benign custody requires a written basis and owner approval recorded in the artifact; it can never be inferred from enumeration or ownership data alone.

Any detected non-UNCX lock or unknown custodian disqualifies the candidate. Incomplete enumeration, truncation, unsupported token program, or unresolved owner is not a PASS.

`getTokenLargestAccounts` top-N is a weaker fallback only. If used, label the result weaker and do not treat it as equivalent to full enumeration.

### R5 — Snapshotter cross-check

When the Rust `grave-snapshotter` is run, preserve its custody reconciliation output and compare the attributed balances with the generic custody enumeration.

SDK snapshot fields or hardcoded flags must never be cited as proof of locker screening.

### R6 — Determination

Permitted determinations:
- `DISQUALIFIED_NON_UNCX_LOCK`
- `DISQUALIFIED_UNKNOWN_CUSTODIAN`
- `INCOMPLETE_FAIL_CLOSED`
- `QUALIFIED_PASS_WITHIN_QUERIED_INVENTORY`

A qualified PASS must use this wording:

> No lock was found within the queried program inventory and generic custody enumeration at slot S. Best-effort screening against a ratified inventory — not universal detection.

Any non-UNCX lock or unknown custodian disqualifies the candidate.

### R7 — Evidence artifact

Create one artifact per `(run_id, pool)` using schema `gy.locker-screening.v1`, defined in `docs/ops/locker-screening.schema.json`. Include:
- pool, AMM, LP mint, token program, cluster;
- RPC endpoint identity, commitment, timestamps, response slots;
- inventory version and inventory hash;
- UNCX PDA derivation and raw response;
- every per-locker query, exact filters, raw response hash, and result;
- generic custody table and owner classifications;
- snapshotter cross-check and reconciliation status;
- determination and disqualifying evidence;
- limitations acknowledgement;
- operator signature and reviewer countersignature;
- deterministic SHA-256 manifest (recipe below) and retention date.

**Deterministic manifest hashing (mandatory).** `manifest_sha256` is computed over the completed artifact itself, never over the separate evidence files it references:

1. Take the final artifact object and remove its top-level `manifest_sha256` member. Every other field present in the artifact (required and optional alike) is included; nothing else is added.
2. Canonicalize the remaining object per RFC 8785 (JSON Canonicalization Scheme): UTF-8 output; object members sorted recursively by UTF-16 code-unit order (not Unicode code-point order — the two orders differ for keys containing characters outside the BMP); no insignificant whitespace; ECMAScript `Number::toString` number serialization (shortest round-trip decimal, minus zero as `0`); JCS string escaping (quotation mark, backslash, and C0 control characters only; every other character emitted literally as UTF-8). The artifact schema constrains every nested value — including the versioned `getProgramAccounts` filter objects in `per_locker_queries` — to strings, booleans, IEEE 754-exact integers, null, arrays, and ASCII-keyed objects, so non-integral numbers and non-ASCII property names cannot occur in a conforming artifact; the canonicalizer nevertheless implements full RFC 8785 number and string handling. Naive key sorting by Unicode code points (for example Python `json.dumps(..., sort_keys=True)`) is not RFC 8785-compliant and must not be relied upon.
3. Set `manifest_sha256` to the lowercase hex SHA-256 of those exact UTF-8 bytes.

The manifest is therefore reproducible from the artifact alone. Verification is symmetric and external to the schema, which records the digest but cannot recompute it: the independent reviewer (R8) re-canonicalizes the artifact minus `manifest_sha256`, recomputes the digest, and rejects the artifact on any mismatch, and `scripts/validate-locker-docs-schemas.py` performs the same recomputation in CI on the committed example. An artifact whose manifest cannot be reproduced from its own contents is tampered or incomplete evidence and fails closed.

Reproducible test vectors — covering non-ASCII (UTF-16) property ordering, numeric serialization, nested structures, string escaping, and the exclusion of `manifest_sha256` itself, each with the expected canonical UTF-8 bytes, byte length, and SHA-256 — are committed at `docs/ops/manifest-test-vectors.json`. Their expected values were generated with an independent RFC 8785 implementation (Node.js `JSON.stringify` over UTF-16-sorted copies — the ECMAScript serialization normatively referenced by RFC 8785 §3.2.2.3) and pinned against the RFC 8785 Appendix B.2 number vectors; the CI validator enforces them and, when Node.js is available, live-cross-checks the Python canonicalizer against that independent implementation on every run.

Retain for the certification lifetime plus at least two years, or longer if a later owner policy requires it.

### R8 — Independent review

The reviewer must:
1. re-execute R2;
2. sample and verify R3 queries and filters;
3. independently sample R4 owner aggregation and classifications;
4. verify the artifact hashes and manifest;
5. confirm that no unknown custodian was passed;
6. countersign the determination.

### R9 — Lifecycle placement

- Complete screening before Phase 2 certification submission (`docs/M1_EXECUTION_SPEC.md` Stage 6 gate).
- Re-verify within the certification TTL before salvage when the evidence is not bundled into the same valid evidence window.
- Phase 1 may use R2 as a preliminary UNCX-only check, but it is not the final protocol-wide screening determination.

### R10 — Limitations (mandatory)

This procedure cannot guarantee detection of:
- lockers outside the ratified inventory;
- custody invisible to generic token-account enumeration;
- locks created and closed between checks;
- PDA custody patterns that bypass the queried token-account model;
- Token-2022 hook custody not represented by the query;
- off-chain contractual locks;
- any account or program omitted because the inventory or query was incomplete.

**Best-effort screening against a ratified inventory — not universal detection.**

## 5. Fail-closed conditions

Do not issue PASS if:
- RPC query fails or is truncated;
- inventory entry is unverified or its layout changed;
- marker/account validation fails;
- custody owner is unknown or unresolved;
- a non-UNCX lock is detected;
- token-program coverage is incomplete;
- operator/reviewer signatures or hashes are missing;
- evidence is stale relative to the certification window.

## 6. M1 cluster note

M1 runs on a local Mainnet-fork validator. Record the fork identity and fixture state. Do not label the screening artifact as Testnet or Mainnet production evidence. A fork PASS is not a claim about universal Mainnet locker coverage.
