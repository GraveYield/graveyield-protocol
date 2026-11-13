# GY-DOC-RECON-001 — GraveYield Documentation & Specification Alignment Report (Consolidated)

**Status:** Draft for owner review. Applied to no living document, not merged — and this
pull request must not be merged; it is a review artifact.
**Revision 2 (corrective, 2026-11-13):** corrections C-01–C-14 applied per the owner's
corrective-revision assignment (Parts 1 and 2); Section 0 lists every correction, Section 2.3
records the original source-document reconciliation, and Appendix C is the validation record.
This revision is pushed to this PR branch as the proposed replacement of this file
(owner-authorized corrective push, 2026-11-14, on top of the branch's then-current head
`2731b3d`); the pull request remains draft and must not be merged.
**Revision 3 (corrective, 2026-11-14):** owner-review findings applied — the stale
"whitepaper docx not accessible" statements (WP-02 and the Deliverable 2 preamble) are
corrected; repository availability is explicitly distinguished from review-context
availability for all four originals (R3-02); the three non-whitepaper originals are
recorded as owner-inspected in the review context with their historical claims
owner-confirmed (R3-01); the GhostPools r3-vs-r4 differential is upgraded from NOT
PERFORMED to PARTIAL with its remaining gap stated (R3-04); the PR description is
synchronized with this revision (R3-05). The binaries of the three non-whitepaper
originals are still not in the working environment, so section-level citations and the
claim-by-claim r3/r4 differential remain open until they are transferred into it.
**Revision 4 (corroborative, 2026-11-14):** the owner's pointer to the three published PDF
renditions on `main` closed the remaining corroboration gap without any file transfer. All
three binaries are repository objects — present at the report baseline (verified via
`git cat-file` at `c7d2032`) and in the working clone — and their change documentation is
now mined and cited (R4-01/R4-02). The v3.0-era historical claims are no longer
owner-confirmation-only: the published editions themselves corroborate them (TechDoc v4.0
§2 "Oracle distinction" note and §12 Revision history; Combined v4.0 §1.1 and §3.3). The
GhostPools r3-vs-r4 differential is upgraded from PARTIAL to DOCUMENTED from the r4 binary
(§1 p. 2, Appendix A p. 15, Document Changelog pp. 15-17). The pending-transfer limitation
is narrowed accordingly (R4-03): it applies only to the three v3.0-era DOCX originals, and
no report finding depends on their full text.
**Baselines:** `graveyield-protocol` @ `c7d203272b994c055295c925ccd69e42c121f581` (main);
`grave-indexer` @ `17998bab3a1c6854e42b67bf3bd1305433e3c3af` (main); `vendor/protocol` SDK pin
`d52669990a6ea01be7387b0bc4020c29ebdd1699` (zero wire-format drift); W2 NS-3 Devnet acceptance
56/56; live ProtocolConfig readback 2026-11-13.
**Provenance:** this file consolidates deliverables 1–6 and the proposed-doc-changes area of
the assignment workspace into one reviewable document; Appendix B records the corrections
made during consolidation.

---

## Contents

0. [Corrective revision summary (v2)](#0-corrective-revision-summary-v2)
1. [Executive summary](#1-executive-summary)
2. [Repositories and documents examined](#2-repositories-and-documents-examined) (2.3: [original source-document reconciliation matrix](#23-original-source-document-reconciliation-matrix-revision-3))
3. [Documentation alignment matrix (Deliverable 1)](#3-documentation-alignment-matrix-deliverable-1)
4. [Revised whitepaper draft v4.1.0 (Deliverable 2)](#4-revised-whitepaper-draft-v410-deliverable-2)
5. [Canonical technical specification draft (Deliverable 3)](#5-canonical-technical-specification-draft-deliverable-3)
6. [Architecture and data flow description (Deliverable 4)](#6-architecture-and-data-flow-description-deliverable-4)
7. [Requirements and implementation status matrix (Deliverable 5)](#7-requirements-and-implementation-status-matrix-deliverable-5)
8. [Outstanding questions and risk register (Deliverable 6)](#8-outstanding-questions-and-risk-register-deliverable-6)
9. [Proposed documentation-only changes](#9-proposed-documentation-only-changes)
10. [Boundary confirmation](#10-boundary-confirmation)
- [Appendix A. Live devnet readback evidence (raw)](#appendix-a-live-devnet-readback-evidence-raw)
- [Appendix B. Consolidation findings and corrections](#appendix-b-consolidation-findings-and-corrections)
- [Appendix C. Corrective revision validation record](#appendix-c-corrective-revision-validation-record-revisions-2-3)

---

## 0. Corrective revision summary (v2)

This revision applies the owner's corrective-revision assignment (C-01–C-14). It is a
correction pass over the existing consolidated report — not new research. What changed:

1. **C-01 (criteria ordering).** The prior claim that "no ordering divergence exists
   anywhere" was wrong for the assigned original sources: the frozen Combined Technical
   Documentation v3.0 (Table 4) numbered the six criteria in a different order (C1 No LP
   burn, C2 No governance lock, C3 TVL, C4 Multi-epoch, C5 Inactivity, C6 Price decline —
   owner-confirmed by direct inspection of the original in the review context,
   2026-11-14 — R3-01; the binary is not yet in the working environment, so section-level
   citation of the v3.0 original remains open; revision-4 corroboration (R4-01): Combined
   v4.0 §3.3 states in print that v3.0 described a cheapest-first order, and its Table 9
   fixes the shipped order). The historical
   mapping is now documented (spec §3.1, matrix WP-03, Q-02), and legacy v3.0 claims
   (cheapest-first evaluation, `invalidate_cert`, certificate consumption, legacy AMM/adapter
   support, older account/field definitions) are reconciled against current code: none of
   them describes current behavior except as noted and evidenced.
2. **C-02 (certificate validity reversed).** The report previously said "an expired one is
   required for settlement (7002)". Verified against source: settlement requires a **valid,
   unexpired** certificate (`is_expired` gate, salvage_pool.rs:300-303); a missing cert
   reverts 7001 and an expired cert is rejected with 7002 (re-run Phase 2 to reissue). A
   live cert blocks re-certification (6034). Fixed everywhere; the cert is also documented
   as NOT consumed by settlement (init-once PoolRegistry enforces one-shot).
3. **C-03 (multi-epoch wording).** Replaced "≥ 2 consecutive Solana epochs with identical
   criteria bitmap" (which implies per-epoch evaluation) with the precise semantics verified
   in code: Phase 2 occurs no earlier than two epochs after the Phase 1 EligibilityAnchor
   (`current_epoch - first_eligible_epoch >= 2`, criteria.rs:160-179), and Phase 2
   re-evaluates all criteria and requires the resulting bitmap to equal the Phase 1 bitmap
   (evaluate_pool_phase2.rs:188-195). No continuous intervening-epoch evaluation exists.
4. **C-04 (C2 pipeline contradiction).** Every section now separates the implemented parts
   (on-chain `record_launch_price` verification; `LaunchPrice` PDA; both oracle authorities
   registered on Devnet; SDK `deriveLaunchPriceV4` derivation) from the incomplete parts
   (dedicated-indexer C2 issuance workflow: derivation integration, CLI path, evidence-bundle
   type, launch-price key custody — audit F-H3, R-33). Diagrams and stage descriptions are
   labeled as target flow, not operational capability.
5. **C-05 (reserved bytes).** Resolved with a fresh readback: both ProtocolConfig accounts'
   reserved ranges (scanner [188..252) = 64 bytes; vault [114..210) = 96 bytes) are **all
   zero**. The earlier "reserved[64] all-zero: False" line was a Python comparison-literal
   bug in the readback script (`b'\\x00'` is the 4-character string `\x00`, not a NUL byte),
   not an account-state fact. Appendix A records the artifact and the corrected evidence.
6. **C-06 (TVL units).** "500 raw display units" corrected: for a 6-decimal quote mint,
   500,000,000 raw units = 500 display tokens. The implementation applies the same fixed
   raw-unit count to every quote mint with no decimals or value normalization
   (evaluate_pool_phase1.rs:151), so it does not establish a universal 0.5 SOL-equivalent or
   USD minimum. Classified as an unresolved eligibility-design issue for owner review
   (Q-03); threshold unchanged.
7. **C-07 (lock scope).** Historical definitions are now documented against the UNCX-only
   implemented detection scope. The whitepaper side is VERIFIED from the inspected original:
   §2.2 criterion 5 reads "No governance or multisig lock" with data source "Pool account
   authority field". The combined-doc side (governance and pool-authority lock conditions)
   is owner-confirmed from the original (R3-01; the binary itself is not yet in the
   working environment). Presented as an explicit owner
   decision (Q-04) and marked a publication and Mainnet-readiness blocker until resolved. No
   criterion change proposed.
8. **C-08 (salvor LP-token prerequisite).** The "anyone may permissionlessly settle" language
   now discloses the verified prerequisite: the withdraw burns LP from a salvor-controlled
   account (`salvor_lp_token_account`, `token::authority = salvor`; `salvor_lp_amount > 0`),
   so the salvor must source LP tokens themselves; the protocol provides no acquisition path;
   original holders keep their snapshot-based claims; locked/inaccessible LP cannot be burned
   by the salvor. Classified as an economic/operational design issue for owner review (Q-16).
   The discrepancy is deeper than wording: the inspected ORIGINAL whitepaper claims "GraveVault
   redeems the entire LP supply of the pool via CPI" (§2.3) and that GraveVault "Acquires and
   redeems LP tokens via CPI" (§4.2) — neither is implemented (the salvor supplies and burns
   their own LP; there is no acquisition path). Matrix row WP-12 records this as a
   material original-vs-implementation discrepancy.
9. **C-09 (protocol 20% purposes).** The original whitepaper §3.4 purpose restrictions are
   VERIFIED verbatim from the inspected original ("designated exclusively for smart contract
   security audits and bug bounty payouts, protocol maintenance and upgrades, infrastructure
   costs, development of new protocol capabilities and DEX integrations, and legal and
   compliance advisory fees") and restored in both whitepaper renderings, explicitly labeled
   as Charter commitments, not bytecode enforcement (the program enforces only the 20% cap,
   error 7005).
10. **C-10 (roadmap overstatement).** "Implemented and Devnet-verified (W2 NS-3 acceptance
    56/56)" for m1–m8 is replaced by a seven-level status split (source / tests / fork
    simulation / deployment acceptance / end-to-end Devnet demonstration / independent audit /
    Mainnet readiness) with per-milestone evidence. The 56/56 result is preserved but scoped:
    W2's own limitations state it "does not establish full end-to-end GraveYield lifecycle
    operation"; no controlled real-pool salvage has been executed on Devnet.
11. **C-11 (C1/C2 naming collision).** C1–C6 are now used exclusively for eligibility
    criteria. The evidence types are named the activity attestation and the launch-price
    attestation. Verified literal code identifiers: the SDK defines `LastSwapAttestation` and
    `LaunchPriceAttestation`; `ActivityAttestation` is an explanatory name (no such code
    identifier exists) and is labeled as such wherever used. PROTOCOL_SPEC.md §5 itself still
    labels evidence rows "C1/C2" — recorded as documentation decision Q-21, not changed.
12. **C-12 (proposed link paths).** Every relative link in the proposed diffs was resolved
    against the actual repository trees (6 links, 0 problems). The DEVNET.md change's href is
    already the correct directory-relative form (`w2-ns3-acceptance/...`); the `docs/` prefix
    appears only in display text. Validation recorded in §9.2.
13. **C-13 (oracle error-code sequence).** Verified against errors.rs and attestation.rs:
    6024 = precompile presence (AttestationMissing), 6025 = offset validity
    (InvalidAttestationOffsets), 6026 = oracle equality (AttestationOracleMismatch); the
    message-span pin is a **second, later check that also reverts 6025** — the apparent
    repetition is real behavior, now stated explicitly. The spec §4.1 check order was
    corrected to the source order (6024 → 6025 offsets → 6026 → 6025 span).
14. **C-14 (legal framing and salvor discretion).** Maritime salvage is now used only as an
    analogy and potential legal framing (never as settled legal treatment). "The salvor takes
    no discretion" is narrowed to the accurate statement: the salvor does not determine
    eligibility outcomes or the distribution formula, but retains ordinary discretion over
    which qualifying pool to pursue and whether to undertake the operation.

**Original source documents.** Status as of revision 2: (1) the assigned whitepaper DOCX
(`GraveYield_Whitepaper_v4_0_1 (1).docx`) was uploaded by the owner and is now INSPECTED —
its internal metadata (Version 4.0, May 2026) resolves the Q-01 contradiction from the
original, and its material claims are verified first-hand and cited below and in Section 2.3;
(2) the other three assigned originals (TechnicalDocumentation_v3_0, Combined_v3_0,
GhostPools_r3 DOCX) were exhaustively searched for in the GitHub repository (all branch
heads, all 102 pull-request refs, tags/notes, releases, wiki, issue attachments, plus the
other three org repositories) and are NOT present in any repository ref searched (a
repository-availability statement; the owner separately holds the originals and inspected
them in the review context — R3-01/R3-02); the links the owner supplied point to the
repo's newer published editions (v4.0 / v4.0 / r4), which were already inspected in full and
are used as current-canon evidence — they are not substitutes for the assigned originals.
Revision 3 status: those three reconciliations are upgraded from INCOMPLETE to
OWNER-CONFIRMED (the owner inspected each original directly in the review context on
2026-11-14 — R3-01); previously owner-supplied historical facts are re-labeled as
owner-confirmed, including the v3.0 Table 4 ordering. The binaries themselves are still
not in the working environment, so section-level citations from those three files remain
open pending transfer (R3-01).

**Revision 3 additions (owner-review findings, 2026-11-14).** The owner reviewed revision 2
against the outstanding findings, confirmed the C-01–C-14 technical corrections, and
required four further items, applied here:

- **R3-01 (source reconciliation status).** The three originals the report had marked
  unavailable were inspected by the owner directly, in the review context:
  TechnicalDocumentation v3.0 (historical Pyth dependency, cheapest-first evaluation,
  `invalidate_cert`, certificate-consumption model, 72-hour timelock claims, broader AMM
  support); CombinedTechnicalDocumentation v3.0 (historical Table 4 ordering, C1 No LP burn
  … C6 Price decline); GhostPools r3 (its own research scope, estimates, methodology, and
  protocol claims). All historical-claim labels for those documents are upgraded from
  "owner-supplied (assignment brief)" to "owner-confirmed (owner inspection, review
  context, 2026-11-14)". Standing limitation, recorded rather than silently resolved: the
  DOCX binaries are not present in the working environment (filesystem search 2026-11-14 —
  the only .docx files on this machine are the whitepaper original, this assignment's
  generated deliverables, and repository handoff files), so this report still cannot cite
  sections or quotations from those three binaries; section-level verification remains open
  pending transfer of the files into the working environment. (Revision-4 narrowing, R4-03:
  this applies to the three v3.0-era DOCX originals only — the three published v4.0-era PDF
  renditions are repository objects on `main`, present at the report baseline and in the
  working clone, and pdftotext-inspected; see §2 and R4-01.)
- **R3-02 (availability semantics).** "Never committed"-style claims are re-scoped to what
  was actually established: no .docx was located in any repository ref searched (exhaustive
  search recorded in Section 2.3), and repository availability is now stated separately
  from review-context availability everywhere (Section 2.3, Appendix C). The owner's
  independent spot-checks of `docs/published/`-style paths on `main` (404) are consistent
  with the exhaustive search.
- **R3-03 (stale WP-02 statement).** WP-02's status cell asserted the whitepaper original
  was inaccessible — contradicting revision 2's own inspection evidence; corrected,
  together with the Deliverable 2 preamble paragraph and the Q-01 question text carrying
  the same stale claim.
- **R3-04 (GhostPools r3-vs-r4 differential).** Upgraded from NOT PERFORMED to PARTIAL:
  r3's existence, scope, and claim areas are owner-confirmed; the r4 changelog's declared
  r3→r4 deltas are recorded; the claim-by-claim comparison of r3's own estimates and
  methodology against r4's text remains open pending binary transfer. GhostPools rows,
  Section 2.3, and Appendix C item 8 updated. (Upgraded in revision 4, R4-02: the
  differential is now DOCUMENTED from the r4 binary itself — see R4-02.)
- **R3-05 (PR description).** The pull-request body is synchronized with this revision
  (source-document status, row/question/appendix counts, revision history).

**Revision 4 additions (published-edition corroboration, 2026-11-14).** The owner pointed at
the three published PDF renditions on `main` as the accessible form of the newer editions.
All three were verified as repository objects present at the report baseline (`git cat-file`
at `c7d2032`: all present) and re-inspected from freshly extracted binaries (19/13/25
pages, matching the §2 record); their change documentation is now cited as binary-level
corroboration:

- **R4-01 (v3.0 historical claims corroborated by the published editions).** TechDoc v4.0
  PDF §2 (criteria table, "Oracle distinction" note, p. 4): "It does not currently use Pyth
  as the price-collapse oracle described in the old technical document" — published
  confirmation that the old technical document (v3.0) carried the Pyth claim, and the only
  Pyth occurrence in the three-PDF set, matching §2. TechDoc v4.0 §12 Revision history
  (pp. 12-13) characterizes v3.0 (May 2026) as a "Previous technical overview. It predated
  the current implementation and contained stale version, AMM-support, oracle, governance
  and deployment claims" — the exact claim categories of the owner-confirmed v3.0 record
  (broader AMM support, oracle/Pyth, governance/timelock, deployment). Combined v4.0 PDF
  §1.1 "What Changed Since Version 3.0" (p. 1): "Eligibility certificates are reissued, not
  consumed. The v3.0 consumed_at field does not exist" — published confirmation of the v3.0
  certificate-consumption model; the same section documents the wholesale error-code
  replacement (Scanner 6000-6034, Vault 7000-7021). Combined v4.0 §3.3 (p. 8): "v3.0
  described this as a cheapest-first order; the shipped implementation simply fixes the
  order below" — published confirmation of cheapest-first; Table 9 (pp. 8-9) fixes the
  shipped order (C1 Inactivity 90 d, C2 Price collapse 9,900 bps, C3 Residual TVL 0.5 SOL =
  500,000,000 lamports, C4 LP not burned 1,000 LP units, C5 No locked LP via the UNCX marker
  and TokenLock evidence accounts 6020-6023, C6 Epoch confirmation 2 epochs) — consistent
  with the owner-confirmed v3.0 Table 4 sequence (C1 No LP burn … C6 Price decline) being a
  materially different, cheapest-first ordering. Consequence: the v3.0-era claims are now
  owner-confirmed AND published-edition-corroborated. The 72-hour timelock figure and
  `invalidate_cert` naming remain owner-confirmed only (the v4.0 editions do not quote
  them), and the full v3.0 texts remain unverified pending the DOCX binaries — which now
  gates no finding in this report.
- **R4-02 (GhostPools r3-vs-r4 differential documented from the r4 binary).** The r4 PDF
  documents its own delta: §1 (p. 2): "Since the third revision of this working paper (May
  2026), two material developments extend the research program" — (1) institutionalized
  continuous monitoring (Ghost Pool Observatory on Dune: Uniswap V2 pools on Ethereum and
  Base, conservative 180-day no-swap screen, live reserve/metadata enrichment; new §4.4,
  data-source table rows, Appendix D.1 situating the 180-day screen against the 30-day
  academic and 90-day protocol thresholds) and (2) design-to-implementation (spec frozen at
  v1.0.0 rev 1.10.0, deeply merged into §11-12: six-criteria table with on-chain evidence
  sources, two-phase certification with criteria-bitmap equality and certificate TTL,
  restitution claims, Charter governance invariants; §12.4 implementation status; Appendix
  D.2 devnet deployment record of 9 October 2026 with program IDs; §14.4 implementation and
  security risk; §13 legal documentation set v4.0; first two-column typeset edition with
  numeric citations). Continuity assertion, Appendix A (p. 15): "Revision r4 retains these
  reference prices deliberately: the cross-chain estimates of Sections 5-8 are carried
  forward unchanged from r3 so that revisions remain comparable and the effect of new
  methodology (rather than new market prices) is isolated"; observatory outputs are not
  blended into the point estimates. The Document Changelog (pp. 15-17) records the r4 row
  (October 2026) and the r3 row (May 2026: whitepaper v4.0 alignment, canonical
  salvage/salvor/derelict vocabulary, maritime salvage law as primary legal analogy,
  multi-epoch added; the changelog's quoted legacy vocabulary is elided here to comply with
  the repository's canonical-vocabulary lint). Differential status: DOCUMENTED — the r4
  side is binary-anchored with section-level citations, and r4's own continuity assertion
  ties r3's estimates and methodology to the current text; the residual (independent
  re-reading of r3's own wording) requires the r3 DOCX and gates no finding — the report's
  GhostPools rows cite r4 with the paper's own qualifications preserved, and no r4 content
  is presented as r3 content.
- **R4-03 (working-environment limitation narrowed).** The "binaries are not in the working
  environment" statements are re-scoped: they describe the three v3.0-era DOCX originals
  only. The three published v4.0-era PDF renditions are repository objects (added via owner
  uploads `83ac666`/`a4e128e`/`6c32461`, with `40de855` organizing the TechDoc and
  GhostPools uploads into `docs/published/` while the Combined upload remained at `docs/`,
  all before the report baseline), were pdftotext-inspected and recorded in §2, and are now
  additionally mined for corroboration (R4-01/R4-02). Header, §2 log, §2.3 matrix, and
  Appendix C updated.
- **R4-04 (PR description).** The pull-request body is synchronized with this revision
  (source-document status table: differential DOCUMENTED; revision history: revision 4
  entry).

---

## 1. Executive summary

This assignment reconciled every GraveYield documentation surface against (i) the established
architecture decisions in GY-ADR-001 (D1–D10), (ii) the current source of both repositories,
(iii) the W2 NS-3 Devnet deployment acceptance evidence, (iv) an independent live on-chain
readback performed 2026-11-13, and (v) the GhostPools research paper with its methodology
limitations preserved. The controlling principle was that documentation must follow verified
reality — the documents were moved toward the implementation, never the reverse. Every
substantive statement in Sections 3–9 is anchored to source files, commit hashes, account
addresses, or acceptance records.

**Verified baseline.** NS-3 is deployed, initialized, and accepted on Devnet: W2 acceptance
passed 56/56 (deployment acceptance 29/29 + ELF digest verification 27/27, finalized at slots
521557300 / 521557485, epoch 1207); the dedicated activity and launch-price oracle authorities
are registered on-chain; a live readback on 2026-11-13 confirmed both ProtocolConfig accounts
with thresholds at specification defaults. Scope of that evidence (C-10): the acceptance
verifies deployment and ELF-related checks; by its own limitations it is Devnet-only, is not a
Mainnet approval or security-audit certification, and "does not establish full end-to-end
GraveYield lifecycle operation" — no controlled real-pool salvage has been executed on Devnet.
Baseline commits and access limitations are recorded in Section 2.

**Headline findings.**

1. **Deployment-status documents are stale in the safe direction, but stale.** Five living
   documents still describe NS-3 as "pending" although it is deployed and accepted. Ten
   documentation-only fixes (Section 9) flip these records to the verified state while
   preserving every Devnet-only scope statement and every "not a Mainnet approval" boundary.
2. **Approved-but-unimplemented work is the largest class of drift.** GY-ADR-001 D4 (economic
   swap classification in the core SDK), D5 (finalized-transaction-only evidence), and D6
   (explicit completeness status, persistent cursors, controlled backfill) are binding
   direction without code. Until the SDK work lands, the activity attestation must be read as "last
   AMM interaction," not "last economic swap." The revised whitepaper and the canonical spec
   state this explicitly instead of presenting approved policy as implemented behavior
   (Sections 4, 5, 7).
3. **The oracle model is reconciled.** No Pyth or external price-feed dependency exists
   anywhere in the eligibility path; the real evidence issuers are two dedicated Ed25519
   oracle authorities (activity, launch-price), verified live on-chain. Their custody,
   rotation, and revocation are operational requirements (spec §13), not bytecode guarantees.
   Scope caveat (corrected in this revision, C-04): on-chain verification and SDK derivation
   for C2 are implemented, but the dedicated indexer's C2 issuance workflow is not wired into
   the pipeline (R-33) — C2 evidence production is not operationally complete.
4. **C5 locker coverage is limited to UNCX.** The documents now say precisely that "not
   detected" is not "not locked" (PinkSale, Team Finance, Streamflow are outside detection
   scope), and any widening of the criterion is flagged as an owner decision.
5. **The 40% LP allocation is a defined share of realized proceeds, not a recovery guarantee.**
   The revised documents state the mechanism guarantees (proportional claims, unsweepable
   bucket, no deadline, pause immunity) without ever implying restoration of original capital.
6. **Repository responsibilities are separated and the core-repo overlap is mapped.** The
   dedicated indexer is evidence infrastructure — never an eligibility or settlement authority —
   and the core repo's bundled `indexer/` package and ops indexer service receive a
   retain / narrow / migrate / retire recommendation per D3. The recommendation is
   documentation only; no migration was executed.
7. **GhostPools figures are research estimates.** $860M conservative / $2.17B base / $5.4B
   upper bound are the paper's own scenarios with a stated 90% interval of $1.1–4.0B; they are
   not verified recoverable TVL and not guaranteed protocol revenue. The five-level distinction
   (observed → estimated stranded → estimated technically recoverable → GraveYield-eligible →
   realized proceeds) is now explicit in the whitepaper.
8. **The version-lineage question blocks publication.** The externally circulated whitepaper
   file named "v4_0_1" carries internal metadata Version 4.0, and no living v4.0.1 document
   exists. The recommended designation for the revised draft is **4.1.0 (Draft for Owner
   Review)**, absorbing the informal v4.0.1 code-comment references and preserving v4.0 as a
   historical document (GY-ADR-001 D2). This remains owner question Q-01.

**Inventory.** Section 3 carries the 49-row documentation alignment matrix (47 original
rows plus CB-04 and WP-12 added in revision 2) plus the 10-row
D1–D10 decision alignment; Section 7 the 51-row requirements and implementation status matrix
in six classes; Section 8 twenty-one outstanding questions (of which thirteen require owner
approval, per the register's own approval column; Q-21 added by revision 2 is a documentation
decision) and twelve risk entries; Section 9 ten
proposed documentation-only diffs plus the complete proposed whitepaper v4.1.0 file.
Section 10 records the boundary confirmation.

**What this report does not do.** It changes no source code, protocol behavior, deployment,
or governance surface, and it applies no fix to any branch — every change is a proposal
awaiting owner review. The four assigned .docx source documents were not located in any repository ref searched
(Section 2.3 records the full search and the availability semantics — R3-02); as review
artifacts, the whitepaper original is present in the working environment and inspected,
and the other three are owner-confirmed from direct inspection in the review context
(R3-01) while their binaries remain outside the working environment. Owner-confirmed
historical facts are labeled by evidence source, and newer in-repo generations are used
only as corroboration, never as substitutes (Q-01).

---

## 2. Repositories and documents examined

This section reproduces the assignment verification log (evidence/VERIFICATION_LOG.md) — the
record of what was inspected, at which commits, with which access limitations, and which
claims were re-verified directly.


### Verification Log — GY-DOC-RECON-001 (2026-11-13)

All work read-only. No source code, dependency, lockfile, configuration, submodule pin,
deployment, commit, push, or PR was created or modified in either repository.

#### Repositories and commits

| Item | Value | Verification |
|---|---|---|
| Core repo | https://github.com/GraveYield/graveyield-protocol | remote URL verified via `git remote get-url origin` |
| Core HEAD | `c7d203272b994c055295c925ccd69e42c121f581` (main, "Merge pull request #103 from GraveYield/docs/w2-ns3-devnet-acceptance") | `git rev-parse HEAD`; `git rev-list --count HEAD..origin/main` = 0 (clone current) |
| Dedicated indexer repo | https://github.com/GraveYield/grave-indexer | remote URL verified |
| Indexer HEAD | `17998bab3a1c6854e42b67bf3bd1305433e3c3af` (main, "Merge pull request #1 from GraveYield/ns3/devnet-preparation") | `git rev-parse HEAD`; behind count 0 |
| Submodule pin | `vendor/protocol` @ `d52669990a6ea01be7387b0bc4020c29ebdd1699` | `git submodule status`; 84 commits behind main, zero wire-format drift (prior audit tree-diff, re-stated) |
| Default branches | `main` for both repos | `git symbolic-ref refs/remotes/origin/HEAD` |
| Working-tree state | Mode-only changes (100644→100755, 0 insertions/deletions) on all tracked files — sandbox filesystem artifact, not editorial drift; one untracked file `docs/INDEXER_AUDIT_REPORT.md` in grave-indexer (previous audit deliverable) | `git diff --stat` (0 insertions); `git status --short docs/` |
| History | Indexer: 17 commits on main, 1 merged PR (#1). Protocol: PR #103 latest | `git log` |

#### Assigned source documents — access status

| Assigned file | Found? | Disposition |
|---|---|---|
| GraveYield_Whitepaper_v4_0_1 (1).docx | FOUND and INSPECTED (revision 2): uploaded by the owner to the assignment workspace on 2026-11-13 (`upload/GraveYield_Whitepaper_v4_0_1 (1).docx`, 20,977 bytes; full text extracted from the DOCX itself, not from a preview). Internal metadata: header and footer read "Version 4.0 · May 2026"; docProps created 2026-05-02; footer states it supersedes Whitepaper v3.0 (April 2026) with the legacy-vocabulary-to-salvage reframing recorded in its own changelog (the reframing the CI lint and glossary.md:26-42 now enforce). The filename-vs-metadata contradiction (Q-01) is therefore CONFIRMED from the original: the file named v4_0_1 is internally v4.0. See Section 2.3 for the reconciliation matrix and the material claims now verified first-hand. Repository availability (R3-02): no .docx was located in any repository ref searched; this file is an owner-supplied review artifact, not a repository object. |
| GraveYield_TechnicalDocumentation_v3_0.docx | NOT PRESENT in the working environment; OWNER-INSPECTED in the review context (2026-11-14, R3-01) | Revision 3 status: the owner inspected the original directly in the review context and confirms it contains the historical Pyth dependency, cheapest-first evaluation, `invalidate_cert`, the certificate-consumption model, 72-hour timelock claims, and broader AMM support — exactly the legacy claims this report reconciles against current code in spec §3.1 (none of which describes current behavior except as evidenced). The owner-provided links on 2026-11-13 point to the repo's PUBLISHED v4.0 edition (`docs/published/GraveYield_TechnicalDocumentation_v4_0.pdf`), a newer generation, NOT the assigned v3.0 DOCX; it was inspected in full and is used as current-canon evidence only. What is still needed: transfer of the v3.0 DOCX binary into the working environment for section-level citation; until then these historical claims are labeled owner-confirmed, not binarily verified here. Revision-4 corroboration (R4-01): the published v4.0 edition itself corroborates the claim categories from its own change documentation — §2 "Oracle distinction" note (p. 4): "It does not currently use Pyth as the price-collapse oracle described in the old technical document"; §12 Revision history (pp. 12-13): v3.0 "contained stale version, AMM-support, oracle, governance and deployment claims". |
| GraveScanner_GraveVault_CombinedTechnicalDocumentation_v3_0.docx | NOT PRESENT in the working environment; OWNER-INSPECTED in the review context (2026-11-14, R3-01) | Revision 3 status: the owner's direct inspection confirms the historical Table 4 ordering (C1 No LP burn ... C6 Price decline) — the C-01 historical-divergence record now rests on owner-confirmed evidence rather than assignment-brief assertion. The owner-provided link points to the repo's PUBLISHED v4.0 edition (`docs/GraveScanner_GraveVault_CombinedTechnicalDocumentation_v4_0.pdf`, inspected in full — a newer generation, not the assigned v3.0 DOCX). The living combined markdown (v3.0-labeled) was inspected. What is still needed: transfer of the v3.0 DOCX binary into the working environment for section-level citation of the v3.0 original. Revision-4 corroboration (R4-01): the published v4.0 edition corroborates the divergence — §1.1 (p. 1): "Eligibility certificates are reissued, not consumed. The v3.0 consumed_at field does not exist"; §3.3 (p. 8): "v3.0 described this as a cheapest-first order"; Table 9 (pp. 8-9) fixes the shipped C1-C6 order. Caution: v4.0's own "Table 4" is the EligibilityCert layout — table numbering is not comparable across editions. |
| GhostPools_Research_Paper_WP-2026-001r3.docx | NOT PRESENT in the working environment; OWNER-INSPECTED in the review context (2026-11-14, R3-01) | Revision 3 status: the owner's direct inspection confirms r3 contains its own research scope, estimates, methodology, and protocol claims. The r3-vs-r4 differential is DOCUMENTED (R3-04; upgraded by R4-02): r3's existence, scope, and claim areas are owner-confirmed, and the r4 binary documents the declared r3→r4 changes directly — r4 §1 (p. 2): "Since the third revision of this working paper (May 2026), two material developments extend the research program"; r4 Appendix A (p. 15): "the cross-chain estimates of Sections 5-8 are carried forward unchanged from r3 so that revisions remain comparable"; Document Changelog (pp. 15-17, consistent with ghostpools-research.md:128-136). Declared deltas (r4: Ghost Pool Observatory/Dune instrumentation integrated; frozen spec v1.0.0 deeply merged; 9 Oct 2026 devnet deployment recorded; first typeset two-column edition; r3 itself (May 2026): Whitepaper v4.0 alignment, canonical salvage/salvor/derelict vocabulary, maritime salvage law as primary legal analogy, multi-epoch added to feasibility). What remains open (non-gating): independent re-reading of r3's own wording, which requires the r3 DOCX binary; r4's continuity assertion plus the owner's scope confirmation already connect r3's estimates and methodology to the current text. The report's GhostPools rows cite r4 as the current edition and preserve the research-estimate qualifications; no r4 content is presented as r3 content. |

Availability semantics (R3-02, revision 3). Two distinct availability questions are kept
separate throughout this report: (a) REPOSITORY availability — no .docx file was located in
any ref searched (the exhaustive search recorded above and in the workspace verification
log: all branch heads, all 102 pull-request refs, tags/notes, releases, wiki, issue
attachments, plus the other three org repositories; `docs/published/` holds only the
v4.0-era PDF renditions — consistent with the owner's independent spot-checks of those
paths on `main`, which returned 404); and (b) REVIEW-CONTEXT availability — the four
originals are owner-held artifacts supplied for review: the whitepaper DOCX was transferred
into the working environment on 2026-11-13 and inspected from the binary, while the other
three were inspected by the owner in the review context (2026-11-14) but their binaries
have not been transferred into the working environment, so this report cannot yet quote or
cite sections from them (R3-01). Revision-4 narrowing (R4-03): the three published v4.0-era
PDF renditions are NOT subject to this limitation — they are repository objects on `main`,
present at the report baseline (`git cat-file` at `c7d2032`) and in the working clone, and
were pdftotext-inspected; the limitation covers only the three v3.0-era DOCX originals.

Additional artifact received 2026-11-13: `GraveYield_Settlement_Architecture (1).pdf` (14 pp,
image-only — no extractable text layer; AI-generated infographic deck, Gemini/NotebookLM
artifacts visible). Its figures cite WP-2026-001r4 ($2.17B total stranded across chains;
$1.10B base case on Solana, ~155,000 pools). Cataloged as an ILLUSTRATIVE DERIVATIVE only —
it is not one of the four assigned sources, contains no text layer to reconcile, and its
figures must not be quoted beyond the underlying paper's qualified estimates.

PDFs inspected (pdftotext extraction, full read): GhostPools_Research_Paper_WP-2026-001r4.pdf
(19 pp), GraveYield_TechnicalDocumentation_v4_0.pdf (13 pp),
GraveScanner_GraveVault_CombinedTechnicalDocumentation_v4_0.pdf (25 pp).
None contains "4.0.1"; Pyth appears exactly once across the set (the tech-doc correction).
Revision-4 re-verification (R4-03): all three are repository objects on `origin/main` — added
via owner uploads `83ac666` (TechDoc), `a4e128e` (GhostPools r4, then named
`docs/ghostpools_research_paper_wp-2026-001r4.pdf`), and `6c32461` (Combined); the `40de855`
reorganization then moved the TechDoc and GhostPools uploads into `docs/published/` while
the Combined upload stayed at `docs/` — and all three verified present in the
report-baseline tree via `git cat-file` at `c7d2032`; page counts re-confirmed 19/13/25;
the single-Pyth claim re-verified (1/0/0 occurrences across the set).

### 2.3 Original source-document reconciliation matrix (revisions 3-4)

| Source | Version | Sections inspected | Historical claims (verified vs owner-supplied) | Current canonical position | Material discrepancies | Resolution / decision |
|---|---|---|---|---|---|---|
| GraveYield_Whitepaper_v4_0_1 (1).docx — INSPECTED (owner upload, 2026-11-13) | Internally Version 4.0 (May 2026; created 2026-05-02) despite v4_0_1 filename; self-describes as superseding v3.0 (April 2026) | Full text (abstract; §1; §2.1-2.3 incl. criteria table; §3.1-3.4; §4.1-4.5; §5 roadmap; §6; §7; §8; §9; Appendix A glossary; closing changelog) | VERIFIED: criteria table uses bare numerals 1-6 in the canonical semantic order (inactivity, price decline, TVL, LP supply, lock, multi-epoch) — consistent with WP-03; criterion 2 data source "Pyth oracle + LaunchPrice PDA" and four further Pyth claims (§2.1, §4.1, §4.5, glossary); criterion 5 "No governance or multisig lock" (data source "Pool account authority field"); criterion 3 "≥ 0.5 SOL equivalent in base asset"; §2.3 "GraveVault redeems the entire LP supply of the pool via CPI into Raydium, Orca, or PumpSwap"; §4.2 "Acquires and redeems LP tokens via CPI into Raydium CLMM, Orca Whirlpool, or PumpSwap"; §2.3 cert validation "(not expired, not consumed, not invalidated)"; glossary "≥ 2 consecutive Solana epochs"; §3.4 protocol-share purposes ("designated exclusively for smart contract security audits and bug bounty payouts, protocol maintenance and upgrades, infrastructure costs, development of new protocol capabilities and DEX integrations, and legal and compliance advisory fees"); §4.4/§7.2 "72-hour on-chain timelock"; §8.2 "guaranteed 40% restitution share" and "This is not a fully settled legal framework in any major jurisdiction"; §6.1 internal figures (~155,000 derelict pools; $420M-$2.8B Solana; $860M-$5.4B cross-chain); §5 dated roadmap (Q2 2026 → Q2 2027+, audit "Q3 2026", BVI entity "Q4 2026") | criteria.rs bitmap C1-C6; dedicated Ed25519 oracle attestations (no Pyth anywhere in the implementation — live-verified); UNCX-only lock detection (governance/multisig locks undetected, Q-04); raw-unit TVL floor with no SOL/USD normalization (Q-03); salvor-held LP burn with no protocol acquisition path (Q-16); cert not consumed (init-once PoolRegistry); two-epoch gap + bitmap equality (no per-epoch checks); write-only timelock fields (7014 never raised); defined share of realized proceeds, not guaranteed recovery (legal-documentation.md:599); GhostPools r4 qualified figures; status-based roadmap without dates | Pyth claims contradicted by implementation (matrix WP-08/TD rows + §4 draft §4.2); "entire LP supply"/"acquires LP" contradicted by salvage_pool.rs (NEW row WP-12); governance/multisig lock criterion vs UNCX-only detection (Q-04, C-07); "0.5 SOL equivalent" vs raw-unit floor (Q-03, C-06); "not consumed" validation concept vs no consumed state (C-02 note); "consecutive epochs" glossary wording vs gap+bitmap-equality semantics (C-03); "on-chain timelock" vs write-only fields (RSK-05); "guaranteed 40% restitution" vs defined-share language (legal boundary); dated roadmap vs status-based roadmap (Q-12) | Revised whitepaper v4.1.0 (Sections 4 and 9.3) already reflects every correction; Q-01 updated to largely resolved (v4.0 metadata confirmed from the original; 4.1.0 designation still requires owner ratification); the combined-doc Table 4 ordering is owner-confirmed (R3-01; binary transfer pending for section-level citation) |
| GraveYield_TechnicalDocumentation_v3_0.docx — OWNER-INSPECTED (review context, 2026-11-14; binary not in working environment) | — | Owner inspection: presence of the historical claims listed next confirmed; section-level citation pending binary transfer (R3-01); corroborated by the published v4.0 edition's own change documentation (R4-01: §2 Oracle-distinction note p. 4; §12 Revision history pp. 12-13) | Owner-confirmed (R3-01): historical Pyth dependency, cheapest-first evaluation, invalidate_cert, certificate-consumption model, 72-hour timelock claims, broader AMM support, older account/field definitions | technical-documentation.md (living, v4.0) + published v4.0 PDF are the current canon; legacy claims reconciled against current code in spec §3.1 | Reconciled result: none of the confirmed legacy claims describes current behavior except as evidenced in spec §3.1 | PARTIALLY RECONCILED — claims owner-confirmed, published-edition-corroborated (R4-01), and reconciled against current code; the residual is full-v3.0-text verification only, which gates no finding. Do not reconstruct the v3.0 full text from the v4.0 edition; its revision history is evidence about v3.0's claim categories, not a copy of its text |
| GraveScanner_GraveVault_CombinedTechnicalDocumentation_v3_0.docx — OWNER-INSPECTED (review context, 2026-11-14; binary not in working environment) | — | Owner inspection: Table 4 ordering confirmed; section-level citation pending binary transfer (R3-01); corroborated by the published v4.0 edition (R4-01: §1.1 consumed_at/reissue p. 1; §3.3 cheapest-first p. 8; Table 9 shipped order pp. 8-9) | Owner-confirmed (R3-01): Table 4 historical ordering (C1 No LP burn, C2 No governance lock, C3 TVL, C4 Multi-epoch, C5 Inactivity, C6 Price decline); §7 error ranges and §9 deployment narrative known via the living md | living combined md (v3.0-labeled) + published v4.0 PDF are current canon; historical mapping documented in spec §3.1 Table 3.1a | Historical ordering divergence (C-01, owner-confirmed); "Consumed by GraveVault" wording in the living md (CB-04) | RECONCILED FOR THE RECORDED CLAIMS — owner-confirmed AND corroborated by the published v4.0 edition's own change documentation (R4-01); the residual is full-v3.0-text verification only. Historical labels must not be read as current identifiers, and v4.0 table numbers (its Table 4 is the EligibilityCert layout) must not be projected onto v3.0 |
| GhostPools_Research_Paper_WP-2026-001r3.docx — OWNER-INSPECTED (review context, 2026-11-14; binary not in working environment) | — | Owner inspection: r3's own research scope, estimates, methodology, and protocol claims confirmed present; section-level citation pending binary transfer (R3-01); the r4 binary documents the r3→r4 delta directly (R4-02) | Owner-confirmed (R3-01): r3 carries its own research scope, estimates, methodology, and protocol claims; changelog-recorded r3 features (May 2026): Whitepaper v4.0 alignment; salvage/salvor/derelict vocabulary; maritime salvage as primary legal analogy; multi-epoch added to feasibility — per the r4 changelog | r4 (published PDF + ghostpools-research.md) is the current edition; the report's GhostPools rows cite r4 with the paper's own qualifications preserved | r3-vs-r4 differential DOCUMENTED (R3-04, upgraded by R4-02): scope and claim areas owner-confirmed; the r4 binary itself documents the delta (§1 p. 2 two-material-developments passage; Appendix A p. 15 continuity assertion; Document Changelog pp. 15-17) | RECONCILED FOR THE DIFFERENTIAL — documented from the r4 binary (R4-02); r3's own wording remains owner-confirmed-only (non-gating residual). r4 figures are never treated as a substitute for r3 claims |

#### Key searches (read-only)

- `pyth` across protocol repo source: only documentation hits (tech-doc correction paragraph;
  PRE_MAINNET_CHECKLIST; two false positives "Python") — zero in programs/SDK/scripts.
  CONFIRMED AGAINST THE ORIGINAL (revision 2): the assigned whitepaper DOCX claims Pyth as
  the evaluation-time dependency in five places (§2.1 "The only external data dependency at
  evaluation time is Pyth Network"; §2.2 criterion 2 data source "Pyth oracle + LaunchPrice
  PDA"; §4.1 "Reads current SOL/USD price ... from Pyth Network"; §4.5; glossary "Pyth").
  None of these is implemented; the oracle-model correction in Deliverable 2 §5 is now
  anchored to the original's own text.
- the glossary's forbidden lexeme (spelled only in glossary.md:26-42 and
  scripts/terminology-lint.sh — the two files the lint exempts as documentation sites)
  across docs/programs/sdk: only those two files match. All living documents comply with
  the terminology lint.
- `4.0.1|v4_0_1`: 6 hits, all in programs/grave-scanner/src comments ("Whitepaper v4.0.1",
  "Combined Tech Doc v3.0.1"); `v4_0_1` zero hits anywhere.

#### Live chain verification (2026-11-13, read-only, api.devnet.solana.com)

Script: scripts/verify_devnet_live.py; output: evidence/live_rpc_verification_2026-11-13.txt

- GraveScanner ProtocolConfig PDA `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe`: exists,
  252 bytes, owner = NS-3 Scanner program (exact match).
- GraveVault ProtocolConfig PDA `5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda`: exists,
  210 bytes, owner = NS-3 Vault program (exact match).
- Scanner config decode (struct layout verified against state/protocol_config.rs @ c7d2032):
  governance authority bytes [8..40) = BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5 (match);
  pending_authority zeroed (rotation not armed, eta 0);
  activity_oracle @ [123..155) = 2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o (registered);
  launch_price_oracle @ [155..187) = 97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee (registered);
  bump @ 187 = 255 (matches W2 acceptance); reserved[64] at [188..252) all zero — re-verified
  2026-11-13 with a corrected byte comparison; the original evidence line "reserved[64]
  all-zero: False" was a script comparison-literal bug (`b'\\x00'` is a 4-character literal,
  not a NUL byte), not an account fact (C-05; Appendix A). Vault reserved [114..210) also
  verified all zero.
  inactivity_seconds 7,776,000; price_collapse_bps 9,900; min_tvl_lamports 500,000,000;
  anchor_staleness_seconds 1,209,600; lp_burn_dust_threshold 1,000; cert_ttl_seconds 3,600;
  paused = 0 — all at specification defaults.

#### Prior-session facts re-used with direct re-verification

The indexer audit (download/INDEXER_AUDIT_REPORT.md, dated 2026-11-13, same commits) supplied
the indexer-side test baseline (78/78 offline pass, typecheck/build pass, live smoke 3/3) and
findings H-1/H-2/H-3, M-1..M-4, L-1..L-6. For this assignment the material claims were
re-verified directly against the repos (structure, file:line anchors, README/docs quotes);
live chain state was additionally re-confirmed independently today (script above).

#### Test baselines cited (per source, not executed here except as noted)

- Dedicated indexer: 78 offline tests / 14 suites (static count re-verified: 81 test blocks
  minus 3 gated; executed result 78/78 pass recorded by the 2026-11-13 audit on identical HEAD).
- SDK: 108 tests at the 5cc46cd baseline (tech-doc §8.3); Combined PDF says SDK 102 at 27b57ac
  — conflict recorded (TD-05), not adjudicated.
- Protocol aggregate: 668 pass / 0 fail at the NS-1-era baseline (BASELINE_REPORT §); 367 at
  the Phase 12 gate (Combined PDF) — different baselines, conflict recorded.


---

## 3. Documentation alignment matrix (Deliverable 1)

Two sheets: the full reconciliation matrix (49 rows — every material discrepancy found, each
with existing statement, verified current state, required change, evidence, and priority; rows
CB-04 and WP-12 added by corrective revision 2) and
the GY-ADR-001 decision-alignment sheet (D1–D10).

### 3.1 Reconciliation matrix (49 rows)


**GraveYield Documentation Reconciliation Matrix - GY-DOC-RECON-001 (verified 2026-11-13)**

| ID | Document | Section / Claim | Existing Statement (as written) | Verified Current State | Required Change | Evidence | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WP-01 | Whitepaper v4.0 (living md) | Header / snapshot pointer | whitepaper.md:3 - 'Snapshot in published/GraveYield_Whitepaper_v4_0.docx' | No whitepaper .docx exists in docs/published/ (only GhostPools r4 and TechnicalDocumentation v4.0 PDFs). Git history shows no .docx was ever committed to the repo. | Fix the snapshot pointer, or publish the docx snapshot under docs/published/ at the next release render. | graveyield-protocol/docs/whitepaper.md:3; docs/published/ listing; git log --all --diff-filter=A (no docx hits) @ c7d2032 | Medium |
| WP-02 | Whitepaper v4.0 / program source | Version designation | Living whitepaper self-declares 'Whitepaper v4.0' (canon-locked May 2026). Program source comments cite 'Whitepaper v4.0.1' as spec reference (criteria.rs, errors.rs, lib.rs, sweep_stale_anchor.rs, invalidate_anchor.rs). The assigned external docx is named v4_0_1 while its internal metadata reads Version 4.0 (per assignment; file not accessible in this environment). | No living v4.0.1 document exists in either repo; '4.0.1' appears only as code-comment spec references. CORRECTED (revision 3; this cell was stale): the assigned docx WAS inspected — the owner uploaded it on 2026-11-13 and its internal metadata (Version 4.0, May 2026) was read from the file itself (Section 2.3, WP-12); no .docx was located in any repository ref searched (R3-02). Three version designations now coexist: v4.0 (living md), v4.0.1 (code comments + assigned docx filename), v4.0 (docx internal metadata). | Establish ONE authoritative designation. Recommended: publish the revised draft as Version 4.1.0 (Draft), explicitly absorbing the informal v4.0.1 spec patch; preserve v4.0 as historical. Owner decision recorded in Deliverable 6 (Q-01). | graveyield-protocol/docs/whitepaper.md:1; programs/grave-scanner/src/criteria.rs:12; errors.rs:4; lib.rs:110; assignment brief §2.A | High |
| WP-03 | Whitepaper v4.0 | §3 criteria numbering | Criteria table uses bare numerals 1-6 with no C-prefix. | All LIVING canon (PROTOCOL_SPEC §4, technical-documentation §2, combined md §4.3, code criteria.rs:25-30 bitmap bits) uses C1-C6 in the same semantic order. CORRECTED (C-01): the frozen Combined Technical Documentation v3.0 DOCX — the assigned original, Table 4 — numbered the criteria differently (C1 No LP burn, C2 No governance lock, C3 TVL, C4 Multi-epoch, C5 Inactivity, C6 Price decline; owner-confirmed from the original — R3-01), so ordering divergence DID exist historically; the living combined md and all current canon have since converged on the canonical order. Historical labels must not be read as current identifiers; mapping table in spec §3.1. | Adopt the canonical C1-C6 labels in the revised whitepaper; keep thresholds unchanged; annotate the historical mapping wherever v3.0-era labels are quoted. | whitepaper.md:41-48; PROTOCOL_SPEC.md:292-368; technical-documentation.md:129-136; grave-scanner-grave-vault-combined.md:149-156; criteria.rs:25-30; owner inspection of the v3.0 DOCX Table 4 (review context, 2026-11-14; R3-01) | Medium |
| WP-04 | Whitepaper v4.0 | §3 criterion 4 | 'LP not burned \| (boolean)'. | Implementation is threshold-based, not boolean: lp_supply > lp_burn_dust_threshold (strict >), default dust threshold 1,000 raw LP units (marked PRE-MAINNET-TODO(KEYS-002)). | Restate as 'LP supply not burned: lp_supply strictly greater than the LP burn dust threshold (default 1,000 raw LP units)'. | whitepaper.md:46; criteria.rs:142-151; constants.rs:34; technical-documentation.md:134 | Medium |
| WP-05 | Whitepaper v4.0 | §3 criterion 5 | 'LP not locked \| (boolean)'. | Implementation: lp_locked_amount == 0, where the amount is produced exclusively by the UNCX Raydium V4 locker adapter (LOCKER-001; marker PDA + TokenLock evidence, errors 6020-6023). PinkSale, Team Finance, Streamflow and any other lockers are NOT detected (LOCKER-002 open); a pool locked in an undetected locker passes C5. | Qualify the criterion with its detection scope ('zero locked LP attributable to supported locker adapters'); document undetected-locker limitation without expanding the criterion (owner approval required for expansion). | whitepaper.md:47; criteria.rs:153-158; adapters/locker.rs (programs/grave-scanner/src); PRE_MAINNET_CHECKLIST.md LOCKER-002; technical-documentation.md:135 | High |
| WP-06 | Whitepaper v4.0 | §3 criterion 3 | 'Minimum residual TVL \| >= 0.5 SOL (quote-side vault balance)'. | Implementation compares min_tvl_lamports >= 500,000,000 RAW UNITS of the quote-side vault. This equals 0.5 SOL only when the quote mint is WSOL; for a 6-decimal quote mint (e.g. USDC) the same raw count equals 500 display tokens (500,000,000 raw units — CORRECTED in revision 2, C-06; the previous text wrongly said "500 raw display units"). The implementation applies the same fixed raw-unit count to every quote mint with no decimals or value normalization (evaluate_pool_phase1.rs:151 uses the quote reserve directly), so it does not establish a universal 0.5 SOL-equivalent or USD-denominated minimum. Tech-doc lists 'C3 TVL unit consistency' as an open item; live devnet config decodes min_tvl_lamports = 500,000,000. | Add the raw-units caveat to the revised whitepaper; keep the 0.5 SOL default framing tied to WSOL quote pools. | whitepaper.md:45; criteria.rs:135-140; technical-documentation.md:133 + §10 blockers; live RPC decode 2026-11-13 (evidence/live_rpc_verification_2026-11-13.txt) | Medium |
| WP-07 | Whitepaper v4.0 | §3 C1/C2 evidence sentences | Criterion 1 (C1) consumes an indexer-signed Ed25519 activity attestation verified in-transaction against ProtocolConfig.activity_oracle (spec §5 / D8); Criterion 2 (C2) consumes an oracle-signed launch-price attestation (D9). (Labels clarified per C-11: C1-C6 denote criteria; the evidence types are the activity and launch-price attestations.) | Accurate. Byte-verified: 112-byte C1 and 168-byte C2 layouts match attestation.rs and the SDK; dedicated oracle keys registered on devnet (live readback 2026-11-13). | No correction needed; carry into revised draft with full oracle-model explanation (Deliverable 2 §5). | attestation.rs (grave-scanner); PROTOCOL_SPEC.md §5 table:375-383; live verification evidence file | None |
| WP-08 | Whitepaper v4.0 | §5 Charter invariant 8 | 'Squads v4 multisig 3-of-5 at launch, 4-of-7 post-audit.' | Devnet NS-3 runs a dedicated governance authority key (BMnrpx9m...Uwf5) with the deployer holding upgrade authority; the multisig posture is the planned mainnet governance commitment, not an existing devnet artifact (charter-invariants #8: 'No devnet artifact is a proxy for mainnet custody'; KEYS-003 open). | Qualify invariant 8 as a mainnet governance commitment; state devnet single-key posture explicitly. | whitepaper.md:91; charter-invariants.md:26; DEVNET.md authority arrangement; LEGACY_DEPLOYMENTS.md | Medium |
| WP-09 | Whitepaper v4.0 | §6 research reference | Cites 'WP-2026-001r3'. | Canonical research artifact is WP-2026-001r4 (October 2026, docs/published/). | Update reference to r4 in revised whitepaper. | whitepaper.md:98; docs/README.md canonical set; docs/published/ | Low |
| WP-10 | Whitepaper v4.0 | §7 roadmap pointer | 'See grave-scanner-grave-vault-combined.md for the per-milestone breakdown' (m1-m10). | The combined living markdown contains NO m1-m10 milestone table (dangling pointer; the breakdown exists only in the frozen external docx, if anywhere). | Restructure the roadmap in the revised whitepaper with current status per milestone; remove the dangling pointer. | whitepaper.md:104-110; grave-scanner-grave-vault-combined.md (no milestone table found); GhostPools r4 Table 16 build-phase status | Medium |
| WP-11 | Whitepaper v4.0 | §7 m10 locker adapters | m10 = locker adapters for UNCX, PinkSale, Team Finance (future). | UNCX Raydium V4 locker introspection is IMPLEMENTED and retired as checklist item LOCKER-001 (mainnet-verified vectors: 125 locks / 74 pools, per-mint custody reconciliation 74/74). PinkSale / Team Finance remain unimplemented. adapters/ README is stale ('Future (m10)'). | Update roadmap status: UNCX done, others open under LOCKER-002. | PRE_MAINNET_CHECKLIST.md LOCKER-001 row; locker.rs header; adapters/README.md | Medium |
| WP-12 | Original Whitepaper v4.0.1 DOCX (inspected, revision 2) | §2.3 salvage sequence + §4.2 vault responsibilities | 'GraveVault redeems the entire LP supply of the pool via CPI into Raydium, Orca, or PumpSwap' (§2.3); 'Acquires and redeems LP tokens via CPI into Raydium CLMM, Orca Whirlpool, or PumpSwap' (§4.2). | Implementation burns LP from the SALVOR's own token account (`salvor_lp_token_account`, `token::authority = salvor`, `salvor_lp_amount > 0`; salvage_pool.rs:243-249,410-412); the protocol neither redeems the full supply nor acquires LP for the salvor, and provides no acquisition path (added in revision 2, C-08). | Revised drafts must not carry 'redeems the entire LP supply' or 'acquires LP' claims; disclose the LP-token prerequisite; classify the operational model as an owner decision (Q-16). | upload/GraveYield_Whitepaper_v4_0_1 (1).docx §2.3, §4.2; salvage_pool.rs; Q-16 | High |
| TD-01 | Technical Documentation v4.0 | Header / baseline | Version 4.0 - 9 October 2026; 'Repository baseline main @ 5cc46cdce13e'. | Protocol main is now c7d203272b994c055295c925ccd69e42c121f581 (W2 NS-3 acceptance + documentation landed after 5cc46cd). The living doc predates the NS-3 deployment acceptance. | Re-baseline the document against current main and refresh §9 deployment status (see TD-02). | technical-documentation.md:7-8; git log @ c7d2032 | High |
| TD-02 | Technical Documentation v4.0 | §9 Devnet deployment status | 'NS-3 is NOT deployed or initialized yet... deployment PENDING' (assigned 2026-11-04). | CONTRADICTED by evidence: W2 NS-3 post-deployment acceptance PASS 56/56 (29/29 acceptance verifier + 27/27 ELF digest verifier) at devnet slots 521557300 / 521557485, epoch 1207; independent live readback 2026-11-13 confirms both ProtocolConfig PDAs exist with dedicated oracle keys registered and all thresholds at spec defaults. | Flip §9 to the deployed state, citing the W2 acceptance report and the registration transaction; keep the Devnet-only scope limitations verbatim. | technical-documentation.md:449-454; docs/w2-ns3-acceptance/W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md:16-26; evidence/live_rpc_verification_2026-11-13.txt | Critical |
| TD-03 | Technical Documentation v4.0 | §2 Oracle distinction (Pyth) | 'It does not currently use Pyth as the price-collapse oracle described in the old technical document.' | Accurate: zero Pyth references in any program, SDK, script or manifest in either repo (searched; only doc/comment hits). The sole eligibility evidence is the two dedicated Ed25519 oracle authorities. | None; retain the correction and keep Pyth out of the evidence model unless a future owner decision adds it. | technical-documentation.md:138-143; repo-wide searches @ c7d2032 (4 doc-only hits, 2 false positives) | None |
| TD-04 | Technical Documentation v4.0 / combined doc | Deployment date | 'The rehearsed emergency-control drill passed on 9 October 2026.' | BASELINE_REPORT §1.1 records chain timestamps 2026-10-08 17:12-17:14 UTC for the NS-1 drill ('Off by one day'); the docs consistently say 9 October (local-time vs UTC confusion). | Correct the drill date to the UTC date (2026-10-08) or state both with timezone labels. | technical-documentation.md:437-440; BASELINE_REPORT.md:56; combined doc §9 | Medium |
| TD-05 | Technical Documentation v4.0 / Combined doc v4.0 PDF | Test counts | Tech-doc §8.3: SDK 108, indexer 29, snapshotter 53 host tests. Combined PDF: 'Scanner 108, Vault lib 33, Vault fork 9, SDK 102, Indexer 29, Ops 47, Adversary 39' (367 total). BASELINE_REPORT: 668 total (NS-1 era). | Counts conflict across documents and baselines. Dedicated indexer current battery is 78 offline tests (verified run 2026-11-13), which none of the protocol-side docs mention. | Designate one authoritative test-count source per repo, pinned to a commit hash; update all documents at the next revision. | technical-documentation.md:418-427; Combined PDF Table 2; BASELINE_REPORT.md:226; INDEXER_AUDIT_REPORT.md §11 (78/78 verified) | Medium |
| CB-01 | Combined Technical Documentation | Version model inversion | Living markdown declares 'Version 3.0 (living markdown)' with published snapshot v3_0.docx external; the repo ALSO ships docs/GraveScanner_GraveVault_CombinedTechnicalDocumentation_v4_0.pdf, 'Version 4.0', aligned to commit 27b57ac. | The published PDF (v4.0) is NEWER than the living markdown (v3.0) - the repo's own 'markdown wins, docx/pdf is a frozen reference' contract is inverted for this document. | Re-align the living markdown to the v4.0 content (or explicitly mark the v4.0 PDF as the current edition and the md as pending update). Owner-visible doc-model decision. | grave-scanner-grave-vault-combined.md:8-18; CombinedTechnicalDocumentation_v4_0.pdf cover + §8 revision table | High |
| CB-02 | Combined Technical Documentation | §9 Deployment status | Describes NS-1 deployment (5JiCVx... / HUyoG5...) and the 9 Oct 2026 drill as the current devnet state. | Stale twice over: NS-1 authority key is dead (DR-001), NS-2 is preserved legacy (DR-002), and the active deployment is NS-3 with W2 acceptance PASS 56/56. | Rewrite §9 to the three-generation lineage with NS-3 as active (or defer to LEGACY_DEPLOYMENTS.md + W2 report). | combined md §9:265-273; LEGACY_DEPLOYMENTS.md:16-20; W2 acceptance report | Critical |
| CB-03 | Combined Technical Documentation | §7 error-code ranges | 'GraveScanner: 6000-6034 ... GraveVault: 7000-7021'. | Vault enum now runs to 7022 (InvariantViolation, no-op pause toggle); error_codes.md tables and Rust sources include it. | Update to 7000-7022 (combined md §7). | combined md §7:240-248; error_codes.md:98; programs/grave-vault/src/errors.rs | Low |
| CB-04 | Tech-doc PDF v4.0 vs Combined PDF v4.0 | Cross-PDF conflicts | Combined PDF: emergency_pause 'gates evaluate_pool_phase_1/2 AND record_launch_price'; SDK tests 102. Tech-doc PDF: pause gates Phase 1/2 only (record_launch_price not mentioned); SDK tests 108. Different baselines (5cc46cd vs 27b57ac). | The two published v4.0 PDFs disagree on pause scope and test counts; readers get different assurance pictures. | Reconcile in the next revision; state pause scope from source (emergency_pause toggles cfg.paused; evaluate_pool_* revert on paused - record_launch_price gating must be quoted from code). | Combined PDF Table 8 + §1; Tech-doc PDF §3.2/§8.3; programs/grave-scanner/src/instructions/ | Medium |
| EC-01 | docs/error_codes.md | Section headings | Headings read 'GraveScanner - 6000-6019' and 'GraveVault - 7000-7019'. | The headings' own tables run to 6034 and 7022 respectively. | Fix the two headings. | error_codes.md:26, :67 vs :65, :98 | Low |
| EC-02 | SDK errors mirror | Vault 7022 | sdk/src/errors.ts table ends at 7021. | On-chain enum includes 7022 InvariantViolation (no-op pause toggle); the SDK mirror lags by one code. | Add 7022 to the SDK table (CODE CHANGE - flagged for owner-approved implementation; not performed). | sdk/src/errors.ts:201-311; programs/grave-vault/src/errors.rs (7022); error_codes.md:98 | Medium |
| RD-01 | graveyield-protocol README | Criteria phrasing | '...long inactivity, >=99% price collapse, low TVL, no LP burn or lock...'. | 'low TVL' is the inverted phrasing that spec decision D1 explicitly retired ('minimum residual TVL' with >= direction). | Correct the landing-page phrasing to 'minimum residual TVL at or above the floor'. | README.md:10-12; PROTOCOL_SPEC.md D1:579-586 | High |
| RD-02 | graveyield-protocol README | Audit/bounty line | 'Phase 2 audit + Immunefi bug bounty will activate at devnet release.' | Devnet has been released three generations (NS-1/2/3); the audit is the upcoming Phase 13 step. | Reword to future tense relative to Phase 13 (audit + bounty), not devnet release. | README.md:125-126; GhostPools r4 Table 16 (Phases 12-15 Open) | Medium |
| DR-01 | docs/DEVNET.md | NS-3 supersession notice | 'NS-3 PREPARATION RECORD (assigned, NOT yet deployed - 2026-11-04) ... the deployment itself is PENDING'. | Superseded by the executed deployment: W2 acceptance 56/56 PASS with signature table; live readback confirms on-chain state. | Replace the preparation notice with a deployment record notice pointing to the W2 acceptance report; keep the historical NS-2 body. | DEVNET.md:3-8; W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md:90-94 | Critical |
| DR-02 | docs/LEGACY_DEPLOYMENTS.md | NS-3 lineage row | 'NS-3 \| - (deployment pending) ... NOT deployed or initialized yet.' | NS-3 is deployed and accepted (W2 56/56; live readback 2026-11-13). | Update the NS-3 row to deployed with dates/slots from the W2 report (or mark 'see W2 acceptance report'). | LEGACY_DEPLOYMENTS.md:16-20; W2 acceptance report:16-26 | Critical |
| DR-03 | CHANGELOG.md | Documentation lineage | No dated entries for whitepaper/doc version bumps or .docx renders; doc-related entries sit under 'Unreleased'. | The v3.0 -> v4.0 documentation rewrite and snapshot renders are not reconstructible from the changelog (only dated section is v1.0.6 - 2026-05-10). | Introduce a Documentation section in the changelog (or a docs/CHANGELOG) recording every doc version event. | CHANGELOG.md (1559 lines, inspected); Agent-extracted doc-relevant entries | Medium |
| DR-04 | docs/DECISIONS.md | Decision registers | Contains DR-001 (dead deployer key, path B) and DR-002 (NS-2 key lost; NS-3 fresh deployment). | The governing GY-ADR-001 (owner architectural decisions D1-D10) is NOT present in either repo; it exists only as an owner-side document provided with this assignment. | Cross-register GY-ADR-001 in DECISIONS.md (or docs/README) so repo readers can find the binding architectural direction. | DECISIONS.md (full); assignment §2.C | Medium |
| SP-01 | PROTOCOL_SPEC.md | Baseline pin | 'Baseline: main @ 4b8e0b1'; frozen v1.0.0 with revisions 1.1.0-1.10.0. | Spec baseline commit is older than current main (c7d2032); the spec text itself is current for wire formats (verified byte-exact for attestations) but its pinned baseline is stale. | Re-pin the spec baseline line at the next spec PR. | PROTOCOL_SPEC.md:4-6; git log | Medium |
| SP-02 | PROTOCOL_SPEC decisions vs GY-ADR-001 | D-number collision | PROTOCOL_SPEC defines its own decisions D1-D12 (TVL terminology, timelock model, priority fee, slippage, orientation, dust, settlement invariant, C1 oracle model, C2 oracle model, cert reissue, snapshot policy, Merkle policy). GY-ADR-001 defines D1-D10 (owner architectural decisions). | Two different 'D-numbered' decision registers coexist; cross-references (e.g., whitepaper 'see decision D8') ambiguously match both. | In revised documents, qualify every D-reference ('spec decision D8' vs 'GY-ADR-001 D8'). | PROTOCOL_SPEC.md §7:577-824; assignment §2.C | High |
| GP-01 | GhostPools WP-2026-001r4 | Guarantee language | Abstract: 'original LP holders retain guaranteed proportional claims on recovered value'; §13.1 'original LP holders are guaranteed proportional restitution'; §13.3 'guaranteed LP-holder restitution'. | The proportional claim is a defined, bytecode-enforced allocation - but the recovered VALUE is not guaranteed: proceeds depend on residual liquidity and market execution; claims pay floor(bucket x balance / supply) and a permanent residual may remain unclaimed (no guarantee the vault drains); legal documentation states 'No guarantee of recovery is provided.' | Qualify to 'guaranteed proportional CLAIM' (defined allocation) while explicitly disclaiming guaranteed recovery value, in the next paper revision and in any whitepaper quoting it. | GhostPools r4 abstract p.2, §13.1 p.13, §13.3 p.14; PROTOCOL_SPEC.md §6.4:560-575; legal-documentation.md:599 | High |
| GP-02 | GhostPools WP-2026-001r4 / Whitepaper §6 | Headline figures | '$2.17 billion in recoverable liquidity ... $860 million to $5.4 billion ... $400 million per month'; whitepaper §6 points to the research without layer distinctions. | The paper defines 'recoverable' as technically recoverable base-asset liquidity (dead-token discount delta applied to the paired-token side; delta = 0.95/0.70/0.50 for conservative/base/upper), sampled May 2026, +/-15% stratum sampling error, 90% CI $1.1-4.0B. It is NOT the GraveYield-eligible subset and NOT guaranteed settlement proceeds (production criteria concentrate settlement on value-dense pools). | When quoting figures, distinguish: observed/indexed liquidity vs estimated stranded vs estimated technically-recoverable vs pools satisfying GraveYield eligibility vs actual settlement proceeds. Keep research-estimate qualifications. | GhostPools r4 abstract; §4.3/§4.5 (methodology + limitations); §11.2; whitepaper.md:96-102 | High |
| GP-03 | GhostPools WP-2026-001r4 | Deployment record | §12.4 + Appendix D.2: 'On 9 October 2026, both programs were deployed to Solana devnet - GraveScanner 5JiCVx... GraveVault HUyoG5...'. | That is the NS-1 deployment, now a frozen historical record (DR-001: authority key dead); NS-2 preserved legacy (DR-002: key lost); active deployment is NS-3 (W2 acceptance 56/56). | Revise the deployment record in the next paper revision (r5) to the three-generation lineage with the NS-3 acceptance reference. | GhostPools r4 §12.4 p.13, Table 15, App D.2; LEGACY_DEPLOYMENTS.md; W2 acceptance report | Medium |
| GP-04 | GhostPools WP-2026-001r4 | Methodology qualifications | Limitations §4.5/§14.1: point-in-time May 2026 estimates; +/-15% stratum sampling error; delta 'an assumption, not an empirical calibration'; BNB Chain via closed-source third-party APIs; observatory (180-day Uniswap V2 on Ethereum/Base) not blended into point estimates; citation-verification table instructs re-verification before external publication. | Qualifications are present and honest in the paper itself. | Retain all qualifications whenever figures are quoted downstream; do not silently strengthen claims. | GhostPools r4 §4.5 p.6; §14.1 p.14; Table 11 (citation verification) | High |
| GP-05 | GhostPools WP-2026-001r4 | Compute estimate | §12.3: 'approximately 700K compute units'. | The combined doc removed the v3.0 fixed '800K CU' figure because it has no code anchor; CU is now a per-transaction SDK option. | Mark the 700K figure as an estimate without code anchor in the next revision. | GhostPools r4 §12.3; Combined PDF §1.1/§3 | Low |
| IN-01 | grave-indexer README | Test count | 'test/ 49 offline tests + DEVNET_RPC_URL-gated live smoke' (README:36) and 'pnpm test # ... (49 tests)' (README:44). | Actual battery: 78 offline tests across 14 suites (verified run 2026-11-13: 78/78 pass, typecheck pass, build pass, live smoke 3/3). The count grew with NS-3 identity/deployment-state suites (commit 7ddf88c). | Update both README lines to 78 (or de-number: 'the offline battery'), citing the verified run. | grave-indexer README.md:36,44; INDEXER_AUDIT_REPORT.md §11.1-11.2 | Medium |
| IN-02 | grave-indexer docs/ORACLE_PIPELINE.md | §2.5 deployment status | Heading 'deployment PENDING' (:115) and 'Until step 1 exists on chain, nothing on devnet answers at the NS-3 addresses' (:142-144). | NS-3 deployed and accepted; live readback 2026-11-13: classification ready, dedicated oracles registered (activity 2Zygw... launch-price 97JVK...). | Update §2.5 heading + closing paragraph to the deployed state; keep §2.4 NS-2 record as historical. | ORACLE_PIPELINE.md:115,142-144; W2 acceptance; live verification evidence | High |
| IN-03 | grave-indexer docs/ORACLE_PIPELINE.md | §6.2 rotation gating | '(Today this is BLOCKED on 9.5 - the authority keypair is the erased deployer key; see 6.4.)' | Stale twice: the NS-3 governance authority is a dedicated key (BMnrpx...), and oracle registration has executed on devnet (tx 3US6jRzFC3yrx9qaqPMaVajEVcMdjau7eNKgpXrYwVGNrX73ESaQBXdGSUJyfCptaF7KhGCJgCqQnCyYGfAEfw5Z). | Rewrite §6.2 step 2: rotation available via update_protocol_config signed by the governance authority; record the registration tx; fix the §6.4/§2.4 cross-reference. | ORACLE_PIPELINE.md:286-288; W2 acceptance report:79-94; LEGACY_DEPLOYMENTS §3 | High |
| IN-04 | grave-indexer docs/ORACLE_PIPELINE.md | §8 item 2 (9.5 gate) | 'Positive-path acceptance on devnet is owner-gated (9.5) ... every valid bundle is oracle-gated at 6026.' | Item resolved on devnet: dedicated keys registered; positive path no longer oracle-gated against the configured oracles. | Mark item 2 resolved (with verification date + tx); keep the ORACLE_IS_REGISTERED operational guidance for mainnet/future rotations. | ORACLE_PIPELINE.md:362-366; W2 acceptance; live readback | High |
| IN-05 | grave-indexer docs/ORACLE_CUSTODY.md | Opening + status row | 'Until then every attestation fails closed with 6026' (:3-6); GraveScanner row 'deployment pending; this runbook applies once the owner executes the deployment' (:33). | Registration executed; deployment ready. | Update opening and status row to the registered state with date; keep the two-environment separation and the timelock-NOT-implemented caveat verbatim (still accurate). | ORACLE_CUSTODY.md:3-6,33; W2 acceptance | High |
| IN-06 | grave-indexer README + examples | Live-artifact vintage | README:9 'verified against the live devnet deployment'; §5/§7 cite the 13/13 matrix and live artifacts. | All three tracked examples pin the NS-2 deployment (scannerProgramId CuQZes...Ao54; oracle AsB5u...) with timestamps decoding to 2026-10-25 UTC - historical, not the current NS-3 state. | Label NS-2 artifacts as historical in README/docs; optionally regenerate examples against NS-3 in a future owner-approved run. | examples/*.json (decoded timestamps); ORACLE_PIPELINE §2.4; audit §8.6 | Medium |
| IN-07 | grave-indexer src/config.ts | Code comments | 'NS-3 ... (assigned, DR-002; deployment pending)' at config.ts:24 and :29. | Deployment is ready; comments are stale. NOTE: source-file comments are code-adjacent - excluded from documentation-only diffs. | Flag for the owner-approved hygiene changeset (audit R1/R8); do not treat as documentation diff. | src/config.ts:24,29 | Low |
| IN-08 | grave-indexer docs/ORACLE_PIPELINE.md | §7 determinism claim | 'Two runs over identical chain state produce byte-identical ledgers' (unconditional). | Claim is conditional: under the MAX_POOLS_PER_SCAN cap (default 500), selection follows RPC response order before sorting (audit M-3); RPC response ordering is not contractually guaranteed. | Qualify the determinism claim with the cap caveat (or sort before truncation - code change, flagged). | ORACLE_PIPELINE.md:344-347; src/discovery.ts:294-302; audit F-M3 | Medium |
| SPC-01 | docs/README.md | Canonical set + render contract | Canonical set of six lists Combined Tech Doc (v3.0); 'the next quarterly release re-renders the published/ .docx snapshots from these markdown files'. | Combined doc published PDF is v4.0 while the living md is v3.0 (inversion, CB-01); the whitepaper docx snapshot referenced by whitepaper.md does not exist (WP-01). | Update the canonical-set table (versions + pointers) and restate the render contract with actual artifact inventory. | docs/README.md:17-27,80-82; docs/published/ listing | Medium |
| LEG-01 | docs/legal-documentation.md | Guarantee language | v4.0 Draft: 'No guarantee of recovery is provided'; §III.14 'Neither Salvors nor LP holders are guaranteed a particular economic outcome'; eligibility != legal abandonment declarations. | Consistent with the on-chain reality (proportional claim, not guaranteed recovery value) - the strictest language in the doc set. | None; use as the reference standard for qualifying whitepaper and research-paper language. | legal-documentation.md:599,603-611,237 | None |
| GEN-01 | All documents | Forbidden vocabulary | Glossary forbids a nine-pattern legacy vocabulary family (exact spelling only in glossary.md:26-42 and scripts/terminology-lint.sh — the two files the CI lint intentionally exempts as documentation sites for the mapping). | Verified: zero hits for the forbidden patterns in whitepaper.md, technical-documentation.md, PROTOCOL_SPEC.md, programs/, sdk/ (only glossary + lint script reference the mapping). GhostPools r4 changelog confirms r3 replaced the legacy terminology. | None; preserve the lint and the canonical vocabulary in all revised drafts. | glossary.md:26-42; scripts/terminology-lint.sh; repo searches | None |
| GEN-02 | Whitepaper / legal / spec | No Mainnet-readiness claims | None of the living documents claims Mainnet readiness; tech-doc cover states 'not a security audit or mainnet release approval'; W2 §9 scope limitations state Devnet-only, not a Mainnet approval, not a security-audit certification. | Consistent. | Preserve these boundary statements verbatim in revised drafts. | Tech-doc PDF cover; W2 acceptance §9:181-186 | None |
| CB-04 | Combined living md (grave-scanner-grave-vault-combined.md) | §4.3 EligibilityCert row | 'Consumed by GraveVault.' | Implementation does not consume or close the cert: salvage_pool validates it (existence 7001, unexpired 7002, bitmap 0x3F, binding) and one-shot settlement is enforced by the init-once PoolRegistry/SalvageReceipt PDAs (added in revision 2, C-02/C-01). | Correct the wording at the next combined-doc re-alignment (Q-17); not diffed in this revision to keep the changeset to the ten reviewed items. | combined md:147; salvage_pool.rs:300-318; PROTOCOL_SPEC D-note | Low |

> Priority: Critical = contradicted by deployment evidence; must be corrected before any document is republished. High = material misrepresentation risk. Medium = accuracy/completeness. Low = hygiene. 'None' rows record verified-accurate claims kept as-is.
> Evidence paths are relative to the repo root at the recorded commits: graveyield-protocol @ c7d203272b994c055295c925ccd69e42c121f581 (main), grave-indexer @ 17998bab3a1c6854e42b67bf3bd1305433e3c3af (main), vendor/protocol pin d52669990a6ea01be7387b0bc4020c29ebdd1699.


### 3.2 GY-ADR-001 decision alignment (D1–D10)


**GY-ADR-001 Decision Alignment (binding owner direction vs verified state)**

| ADR ID | Established Decision (GY-ADR-001) | Verified State (2026-11-13) | Classification | Evidence |
| --- | --- | --- | --- | --- |
| D1 | Retain GraveYield/grave-indexer as the dedicated indexer repository. | Confirmed: the canonical indexer repo is GraveYield/grave-indexer (main @ 17998ba); package name @graveyield/grave-indexer; org has no graveyield-indexer. Prior naming discrepancy resolved. | Consistent | grave-indexer package.json/README; GitHub org listing; INDEXER_AUDIT_REPORT §2.1 |
| D2 | Prepare a revised whitepaper; preserve v4.0 as a historical document. | Deliverable 2 produced (draft v4.1.0). v4.0 living md retained untouched; no publication performed. | Draft ready - publication pending owner | Deliverable 2; proposed-doc-changes/ |
| D3 | Dedicated indexer is the canonical evidence pipeline; core repo keeps programs + SDK; overlapping core indexer functionality to be narrowed/migrated/retired. | Overlap confirmed: core indexer/ (@graveyield/indexer 0.2.0, 9-stage pipeline incl. SUBMIT holding ACTIVITY_ORACLE_KEY) and ops indexerService duplicate discovery/activity functionality. Recommendation produced (Deliverable 3 §16): retire submit path, migrate candidate funnel, retire duplicates. No migration performed. | Recommendation ready - owner approval required | indexer/README.md + submit.ts; OPS.md service table; Deliverable 6 Q-05 |
| D4 | Only verified economic swaps reset inactivity; liquidity/admin/crank interactions must not count; ambiguous transactions fail closed; canonical classification in the SDK. | NOT implemented: SDK deriveLastSwapV4 accepts ANY Raydium V4 program touch of the pool as 'last swap' (audit H-1); no swap/liquidity discrimination; no ambiguity concept exists. The on-chain evaluator cannot compensate (validates only 0 < ts <= now, 6028). | Approved - not implemented | sdk/src/lastSwapAttestation.ts:215-257; audit F-H1; criteria.rs C1 |
| D5 | Historical transaction evidence must use finalized transactions; this does not weaken the on-chain multi-epoch requirement. | NOT implemented: derivation consumes getSignaturesForAddress results without inspecting confirmationStatus (audit H-2); SDK header names a minConfirmations requirement ('spec §6.3') that is not implemented anywhere. On-chain multi-epoch requirement intact (MIN_EPOCH_CONFIRMATION = 2). | Approved - not implemented | lastSwapAttestation.ts:194-225; audit F-H2; constants.rs:25 |
| D6 | Bounded scanning with explicit completeness status, persistent pagination/cursors, controlled backfill; never infer inactivity from incomplete/truncated history. | Partial: bounded scan exists (SIGNATURE_SCAN_LIMIT default 1000, newest-first, no pagination); C2 derivation fails closed at page limit ('refuses to guess'); C1 has no completeness indicator beyond noSwapFound; no cursor/backfill module exists; provenance records the scan LIMIT, not the actual scan (audit L-6). | Partially implemented | config.ts:126; launchPriceAttestation.ts:254-259; audit F-L6, §5; D6 gap in Deliverable 3 |
| D7 | Core SDK is the single source of truth for shared protocol/evidence semantics; correct and test upstream before repinning the dedicated indexer. | Architecture confirmed: vendored SDK is a workspace dependency; indexer implements no wire formats locally; pin d526699 is 84 commits behind main with ZERO wire-format drift (tree-diff verified). Upstream corrections (D4/D5 semantics) pending; re-pin deferred per D7. | Consistent - upstream fixes pending | grave-indexer pnpm-workspace.yaml; audit §8.5/§9; commit 7ddf88c (prior re-pin) |
| D8 | Documentation must define staged operational and security requirements (testing, RPC resilience, oracle custody/rotation/revocation, deployment verification, environment separation, monitoring, dependency security), distinguishing bytecode-enforced controls from operational/governance commitments. | Partial: charter-invariants.md §4 makes the honest split explicit; PRE_MAINNET_CHECKLIST stages ORACLE-003 (open), KEYS-003 (open), GOV-001 (open); ORACLE_PIPELINE §6 + ORACLE_CUSTODY provide custody/rotation/revocation/monitoring runbooks; no dependency-audit/lint/coverage tooling in indexer CI; no RPC resilience layer (audit M-2). | Partially implemented | charter-invariants.md:68-83; PRE_MAINNET_CHECKLIST.md; ORACLE_PIPELINE §6; audit F-M2/F-L5 |
| D9 | Maintain Solana-first scope; environment-neutral Devnet/Mainnet configuration; multichain deferred. | Scope consistent (spec: Solana, Raydium V4 only; GhostPools covers multichain as research only). Environment neutrality partial: dedicated indexer uses devnet-era naming (DEVNET_RPC_URL, hardcoded 'devnet' destination cluster) - audit M-4. | Partially implemented | PROTOCOL_SPEC.md scope; audit F-M4; config.ts:108 |
| D10 | Provider-independent RPC architecture with timeouts, retries, failover, workload-specific configuration; incomplete evidence never silently presented as complete. | NOT implemented (resilience): timeouts/retries/backoff/failover absent outside the harness (audit M-2). Honesty partial: verifier preserves 'indeterminate' outcome; console pins C2/C4/C5/C6 'pending'; but no completeness indicator for bounded history scans. | Approved - not implemented (resilience layer); honesty partially implemented | audit F-M2; verify.ts outcomes; consoleSnapshot.ts:8-20 |


---

## 4. Revised whitepaper draft v4.1.0 (Deliverable 2)

Complete revised whitepaper draft, reproduced below in full. It preserves the project purpose
and core design, keeps the six substantive eligibility criteria and thresholds unchanged,
reconciles the oracle model with the implemented evidence architecture, classifies every
guarantee by its enforcement source, qualifies the research figures, and promises no dates.
Per GY-ADR-001 D2 it does not replace Whitepaper v4.0, which remains a historical document.
The repo-facing markdown rendering proposed for `docs/whitepaper_v4.1.0_draft.md` is embedded
in Section 9.3; Appendix B (CF-03) records the relationship between the two renderings.


| <br><br>G R A V E Y I E L D P R O T O C O L<br>GraveYield Whitepaper<br>Version 4.1.0 - Draft for Owner Review (not published)<br><br>Settlement infrastructure for derelict liquidity on Solana<br>Reconciled against GY-ADR-001, the current source code, and Devnet acceptance evidence<br>Prepared under assignment GY-DOC-RECON-001 - 2026-11-13<br>Preserves Whitepaper v4.0 (May 2026) as a historical document<br><br>GraveYield - graveyield-protocol/docs - reviewable draft |
| --- |


#### **Document Control**

This is a reconciliation draft prepared under assignment GY-DOC-RECON-001 (Documentation and Specification Reconciliation). It is a reviewable artifact, not a publication. It preserves Whitepaper v4.0 (canon-locked May 2026) as a historical document; nothing in this draft replaces or edits that document. This draft has not been committed, pushed, or published.

**Table 1. Version designation and status**

| Item | Value |
| --- | --- |
| Recommended designation | Version 4.1.0 (Draft for Owner Review) |
| Rationale | The living whitepaper source self-declares v4.0; program-source comments cite an informal "v4.0.1 spec patch" for which no living document exists; the externally circulated whitepaper file is named v4_0_1 while its internal metadata reads Version 4.0. Version 4.1.0 formally absorbs the v4.0.1 patch references and restores a single, unambiguous lineage, leaving 4.0 untouched as history. |
| Supersession rule | Until the owner approves and publishes this draft, PROTOCOL_SPEC.md remains the governing specification and the v4.0 living whitepaper remains the current whitepaper source. |
| Basis of revision | Verified against GraveYield/graveyield-protocol @ c7d203272b994c055295c925ccd69e42c121f581 (main), GraveYield/grave-indexer @ 17998bab3a1c6854e42b67bf3bd1305433e3c3af (main), vendored SDK pin d52669990a6ea01be7387b0bc4020c29ebdd1699, the W2 NS-3 Devnet acceptance report (56/56 checks PASS), and a live read-only ProtocolConfig readback on 2026-11-13. |
| Out of scope | No protocol behavior, thresholds, eligibility logic, SDK behavior, oracle authorities, deployment, or governance configuration is changed by this draft. |

CORRECTED (revision 3; this paragraph was stale): the assigned whitepaper file (filename containing v4_0_1, internal metadata Version 4.0) WAS inspected — the owner uploaded it on 2026-11-13 and it was read from the binary itself (Section 2.3; matrix rows WP-02/WP-12; Q-01 largely resolved). Statements about that file in this draft are verified from the inspected original, not provisional.

#### **1. Premise**

GraveYield is the settlement layer for derelict liquidity on Solana. It is settlement infrastructure; maritime salvage is used in this draft only as an analytical analogy and a potential legal framing, never as a representation of GraveYield's settled legal treatment (the legal documentation governs that boundary). When an AMM liquidity pool crosses all six derelict-pool criteria - long inactivity, at least 99% price collapse from the recorded launch price, minimum residual TVL at or above the floor, LP supply not fully burned, LP not locked within the protocol's detection scope, and multi-epoch confirmation - anyone may submit settlement permissionlessly (no protocol permission gate exists), with one disclosed economic prerequisite: the settlement withdraw burns LP tokens from an account the salvor controls, so the salvor must already hold, or acquire, LP tokens of the pool before settlement (verified: salvage_pool.rs `salvor_lp_token_account`, `token::authority = salvor`; `salvor_lp_amount > 0` required). The protocol provides no LP-acquisition mechanism. Settlement then removes the LP the salvor burns, swaps the recovered tokens, and distributes the proceeds 40 / 40 / 20 to the original LP holders, the salvor, and the protocol.

The actor performing the salvage is a salvor. Maritime-salvage concepts (for example, the salvor-as-finder framing of the 1989 International Convention on Salvage) are used only as an analogy and a potential legal framing; no legal conclusion is drawn here. The discretion boundary is narrow and specific: the salvor does not determine eligibility outcomes (eligibility is evaluated on chain from objective conditions) and does not determine the distribution formula (executed on chain by fixed formula); the salvor retains ordinary discretion over which qualifying pool, if any, to pursue and whether to undertake the operation at all.

Since Whitepaper v4.0 was canon-locked, the evidence architecture has been implemented and accepted on Devnet: two dedicated oracle authorities now sign the two evidence types the criteria consume, and the two-phase eligibility lifecycle is enforced by deployed bytecode. This revision states that architecture as implemented; Section 5 replaces the earlier treatment of external price oracles.

#### **2. What GraveYield Is Not**

Not a yield-farming protocol, liquidity-management tool, or rebalancing service. Not a token: there is no GRAVE, GY, or any token, NFT, points programme, airdrop, or staking layer at any layer of the design. Not discretionary: the protocol takes no governance over which pools qualify; the six criteria are objective on-chain conditions evaluated by a fixed conjunction, and a passing evaluation is the only path to settlement. Not a counterparty guarantee: original LP holders do not require GraveYield's mercy and do not receive a promise - they retain a defined, pro-rata claim on the post-salvage proceeds via claim_lp_proceeds, which stays live even during emergency pause. What that claim is worth depends entirely on what the pool actually contains and what settlement realizes; Section 8 states this limit plainly.

Not a Mainnet product yet. The protocol is deployed and accepted on Solana Devnet only. The Devnet acceptance report explicitly limits itself: it is not a Mainnet deployment approval and not a security-audit certification.

#### **3. Eligibility - The Six Derelict-Pool Criteria**

Eligibility is decided by a single evaluator function in the GraveScanner program, executed identically in both lifecycle phases. The evaluator is a fixed sequential conjunction C1 through C6: the first failed criterion aborts evaluation, a passing evaluation produces the full criteria bitmap 0x3F, and a pool failing any criterion is not eligible. Thresholds live in ProtocolConfig and are governance-tunable only within bounded ranges; invariant-violating updates revert. The canonical numbering below is used across the specification, the technical documentation, and the program source. Historical note (C-01): the frozen Combined Technical Documentation v3.0 (its Table 4) numbered the six criteria in a different order — its C1 was "No LP burn", C2 "No governance lock", C3 TVL, C4 Multi-epoch, C5 Inactivity, C6 Price decline. Those are historical labels only; the canonical identifiers are C1-C6 as defined in this table, and historical labels must not be read as current identifiers.

**Table 2. Canonical criteria (thresholds unchanged from v4.0; defaults shown)**

| ID | Criterion | Rule (default) | Evidence source |
| --- | --- | --- | --- |
| C1 | Trading inactivity | current_unix_ts - last_swap_unix_ts >= inactivity_seconds; default 90 days (7,776,000 s); equality passes. | Indexer-signed 112-byte Ed25519 activity attestation (SDK type `LastSwapAttestation`), verified in-transaction against ProtocolConfig.activity_oracle; the attested slot must still resolve in SlotHashes (approximately 512 slots). |
| C2 | Price collapse from launch | drop_bps = floor((launch - current) x 10,000 / launch) >= price_collapse_bps; default 9,900 bps (99%); 0 if price has risen above launch; capped at 10,000. | Launch price carried by an oracle-signed 168-byte launch-price attestation (SDK type `LaunchPriceAttestation`) recorded init-once in the LaunchPrice PDA; current price derived on-chain from vault balances. |
| C3 | Minimum residual TVL | current_tvl_lamports >= min_tvl_lamports; default 500,000,000 raw units of the quote-side vault balance. This equals 0.5 SOL when the quote mint is WSOL; for other quote mints the floor is the same raw-unit count in that mint's smallest denomination. | Quote-side vault balance read on-chain via the pool's own vault pointer. |
| C4 | LP supply not burned | lp_supply > lp_burn_dust_threshold (strict); default threshold 1,000 raw LP units. | LP mint SPL token supply read on-chain. |
| C5 | LP not locked | lp_locked_amount == 0, exactly. | Detected locked LP attributable to supported locker adapters - currently the UNCX Raydium V4 locker only - proven by a per-pool marker-PDA gate plus strictly validated TokenLock evidence. See the scope note below. |
| C6 | Multi-epoch confirmation | Phase 2 occurs at least MIN_EPOCH_CONFIRMATION (2) Solana epochs (approximately 4-6 days) after Phase 1 and reproduces the Phase 1 criteria bitmap exactly. | EligibilityAnchor PDA (Phase 1) and EligibilityCert PDA (Phase 2) with criteria-bitmap equality. |

##### **3.1 Scope notes required for accuracy**

Criterion 3 is enforced in raw token units. The on-chain comparison is 500,000,000 raw units of the quote-side vault; describing it as "0.5 SOL" is correct only for WSOL-quoted pools (for a 6-decimal quote mint it is 500 display tokens). The same fixed raw-unit count is applied to every quote mint — the code performs no decimals normalization and no SOL/USD conversion — so the economic floor varies with the quote mint and does not establish a universal 0.5 SOL-equivalent minimum. Whether this raw-unit threshold is the intended economic criterion is an unresolved eligibility-design issue requiring owner review before Mainnet readiness (Q-03; C-06).

Criterion 5 is enforced only within the protocol's detection scope. The v1 implementation introspects the UNCX Raydium V4 locker (verified against live mainnet lock state). LP locked in PinkSale, Team Finance, Streamflow, or any other locker, and restrictions imposed by multisig or governance arrangements that no adapter reads, are not detected and therefore do not fail this criterion. "Not detected" is not "not locked"; expanding the criterion's detection scope requires owner approval. Historical definitions were broader: the original whitepaper describes the absence of governance or multisig locks, and the Combined Technical Documentation discusses governance and pool-authority lock conditions; whether UNCX-only detection is the intended canonical criterion, or the implementation is incomplete relative to those historical definitions, is an explicit owner decision (Q-04) and a publication and Mainnet-readiness blocker until resolved.

Criterion 4 uses a strict inequality above a configurable dust threshold, so a pool whose LP supply has been entirely incinerated always fails. Whether a flat dust threshold is the right long-term formulation is an open item (KEYS-002).

Criterion 6 is enforced on chain between the two phases. It is an on-chain multi-epoch requirement and is not replaced or weakened by any off-chain evidence policy (see Section 5.4).

#### **4. Evidence Model — Activity and Launch-Price Attestations**

Two eligibility inputs cannot be derived on chain. Raydium V4's pool account stores no last-swap timestamp, the SlotHashes sysvar covers only approximately 512 recent slots, and Solana programs cannot read historical account state. Inactivity and launch price are therefore carried into the transaction as Ed25519-signed attestations, verified in-transaction through the ed25519_program precompile. There is no external price-feed dependency anywhere in the eligibility path: the implementation does not use Pyth or any other oracle network, and no prior whitepaper description of an external evaluation dependency remains accurate.

##### **4.1 Activity attestation (criterion C1 input)**

The activity attestation (explanatory name — the literal SDK identifier is `LastSwapAttestation`; no `ActivityAttestation` identifier exists in code) carries the pool's last qualifying economic swap timestamp. The dedicated indexer derives it from Raydium V4 transaction history and the designated activity oracle signs a 112-byte message: amm_program_id, pool_address, last_swap_unix_ts, issued_slot, and the slot hash of issued_slot. Under the approved architectural direction, only verified economic swaps reset inactivity; liquidity additions and removals, administrative instructions, crank operations, and other non-swap AMM interactions must not count, and ambiguous transactions must remain unresolved rather than optimistically classified. Canonical classification of transactions belongs in the core SDK. Implementing that classification is approved direction not yet implemented; until it lands, the attested timestamp must be read as "last AMM interaction" and this gap is tracked as a named work item.

##### **4.2 Launch-price attestation (criterion C2 input)**

C2 launch-price evidence establishes the baseline for the collapse calculation. The launch price is defined as the quote-per-base price formed by the pool's vault balances immediately before the pool's first successful swap - the deployer-seeded initial market price. The designated launch-price oracle - deliberately a different key from the activity oracle, because the baseline is init-once and permanently binding - signs a 168-byte message carrying the pool and mint identities, the first-swap slot and timestamp, the price as a Q64.64 fixed-point number, and the issuing slot. record_launch_price accepts the price only inside this attestation and writes the init-once LaunchPrice PDA; caller-supplied prices revert. Deriving the baseline requires sufficient historical transaction coverage to reach the first qualifying price event; if the available history cannot establish it, the evidence is classified incomplete or unavailable and no price is substituted. Implementation status: on-chain verification and SDK derivation are implemented and verified; the dedicated indexer's C2 issuance integration is incomplete (audit F-H3; R-33), so the end-to-end C2 pipeline is not operationally complete and is not depicted as such.

##### **4.3 Division of responsibility**

**Table 3. Who does what in the evidence path**

| Role | Responsibility | Authority |
| --- | --- | --- |
| Dedicated indexer (GraveYield/grave-indexer) | Discovers pools, collects bounded history, derives last-swap and launch-price candidates, produces evidence bundles, signs attestations with the oracle keys it is entrusted with, verifies its own evidence against live chain state, and reports provenance and completeness. | Evidence infrastructure only. It never authorizes salvage, never issues certificates, never mutates protocol state, and submits no transactions. |
| Core SDK (graveyield-protocol/sdk) | Owns every wire format: attestation message builders, precompile instruction layout, account decoders, PDA derivation, error-code mirror. The indexer re-implements none of them. | Single source of truth for protocol and evidence semantics; canonical transaction classification lands here. |
| GraveScanner program | Verifies the precompile signature, oracle identity against ProtocolConfig, binding echo, timestamps, slot validity and C1 freshness; evaluates all six criteria; writes anchors and certificates. | Sole authority for eligibility state. |
| Governance (ProtocolConfig authority) | Registers and rotates both oracle public keys via update_protocol_config; holds pause, invalidation, and config authority. | Governance authority over configuration, not over eligibility outcomes of a correctly configured system. |
| Operator (oracle service owner) | Runs derivation honestly against trusted RPC, protects and rotates keys, monitors freshness and availability per the staged operational runbook. | Operational commitment - not bytecode-enforced. |

##### **4.4 Failure behavior**

Evidence that is incomplete, stale, invalid, or unavailable fails closed. Every failure mode is a revert; there is no fallback to caller-supplied values. Missing precompile instruction or malformed offsets reverts (6024/6025); a signature by any key other than the configured oracle reverts (6026); a message bound to a different pool or program reverts (6027); zero or future timestamps or slots revert (6028/6031); a slot that has aged out of SlotHashes reverts (6029); a slot-hash mismatch reverts (6030); a missing or mismatched launch-price record reverts (6002/6032/6033); a live certificate blocks re-certification (6034); settlement requires a valid, unexpired certificate — a missing certificate reverts (7001) and an expired certificate is rejected (7002; re-run Phase 2 to reissue). CORRECTED in revision 2 (C-02): the previous text wrongly said an expired certificate was "required" for settlement. Oracle downtime blocks new evaluations - an availability cost, not an integrity risk, because the chain rejects evidence it cannot verify. Off-chain, the indexer's verifier mirrors the on-chain check order and preserves an explicit indeterminate outcome for RPC conditions that cannot be resolved, so that unverifiable evidence is never presented as verified. An indexer whose historical scan is incomplete must never claim that a pool has been inactive for a qualifying period; under the approved direction, completeness must be explicit, scan-bounded evidence must be labeled as such, and backfill must be controlled (approved direction; cursor and backfill subsystems not yet implemented).

#### **5. The Two-Phase Eligibility Lifecycle**

A derelict pool is a pool whose terminal state has persisted, and any single point-in-time observation can be manufactured or can reflect a transient lull. The lifecycle therefore converts one-time observation into consensus-confirmed certification.

##### **5.1 Phase 0 - launch-price record**

Before evaluation, a LaunchPrice PDA is recorded for the pool from a launch-price attestation. It is init-once per pool: a second record for the same pool reverts, which both prevents replay and makes a mis-recorded baseline permanent - the reason the launch-price signing key is isolated and its derivation is held to a fail-closed archive standard.

##### **5.2 Phase 1 - EligibilityAnchor**

Phase 1 runs the full evaluator. If any criterion fails, nothing is written. If all six pass, an EligibilityAnchor PDA is created, recording the epoch in which the pool first satisfied every criterion (first_eligible_epoch), the exact criteria bitmap produced, the writer who paid rent, and an invalidated flag. Creation is permissionless; destruction is not. An anchor records a passing observation - it is not a salvage authorization. An anchor conveys no rights of any kind: no liquidity can move on the basis of an anchor, GraveVault does not accept anchors, and the only actions available against an anchor are authority-gated invalidation and permissionless rent-reclaim sweep after the staleness window (default 14 days), neither of which touches pool liquidity.

##### **5.3 The waiting period and Phase 2 - EligibilityCert**

Phase 2 may run no earlier than MIN_EPOCH_CONFIRMATION (2) Solana epochs - approximately four to six days - after the anchor's epoch. Phase 2 re-runs the identical evaluator with a fresh activity attestation (the Phase 1 attestation has necessarily aged out of the SlotHashes window long before the gap elapses, so old evidence cannot be replayed) and additionally requires the new criteria bitmap to equal the anchor's bitmap. If any threshold, oracle key, or adapter behavior changed such that the evaluator would now produce a different result, certification fails entirely and the pool must re-enter Phase 1. On success, Phase 2 writes an EligibilityCert PDA - the only object GraveVault trusts - with a time-to-live of one hour by default (governance-configurable, floored at ten minutes). A live certificate is immutable (re-running Phase 2 fails); an expired certificate is reissued in place by a fresh full Phase 2 run, bumping a generation counter. Reissuance never waives any check.

##### **5.4 What the two phases do not defend against**

Both phases consume oracle-attested evidence; a dishonest activity oracle that lies about last-swap timestamps in both phases would defeat the scheme's premise, which is why oracle key custody, rotation, and monitoring are staged operational requirements rather than completed controls. Certification is per-pool: coordinated manipulation of an entire pool's reserves is bounded economically by the criteria and closed residually by settlement-time checks, but is not made impossible by the anchor mechanism alone. Off-chain snapshot timing is a separate contract (Section 7). The finalization policy for historical evidence (finalized transactions only) is approved direction that strengthens this lifecycle once implemented; it does not replace or weaken the on-chain multi-epoch requirement, which stands independently.

#### **6. Settlement and Distribution - 40 / 40 / 20**

salvage_pool is permissionless and executes the entire settlement in one atomic transaction: pre-flight validation against live pool state, an LP-holder snapshot commitment, CPI to the AMM to remove liquidity (burning the salvor's LP in place), conversion of the recovered assets through a Jupiter route with a protocol-checked slippage floor, and distribution of the recovered SOL.

**LP-token prerequisite (disclosed; verified in source).** The withdraw CPI burns LP from `salvor_lp_token_account`, an account whose token authority must be the salvor, and `salvor_lp_amount` (any amount greater than zero that the salvor controls) selects how much liquidity is removed. Consequences: the salvor must acquire LP tokens before settlement - by purchase, over-the-counter transfer, or a prior position - and the protocol supports no alternative acquisition mechanism; original LP holders' tokens are never taken from them (their claims come from the snapshot census, which must enumerate the full LP mint supply, so burning does not change anyone's claim share); locked LP (UNCX) and LP held by inaccessible wallets cannot be burned by the salvor; and the snapshot supply-parity gate requires the snapshot to match the live supply at settlement time, not that the salvor burn the whole supply. Whether an economic salvor can realistically source LP for a given derelict pool is an open design question requiring owner review before the Mainnet funnel is finalized (Q-16).

Proceeds from a successful salvage are split: 40% to the per-pool lp_holder_pool_vault PDA, claimable pro-rata by original LP holders against the snapshot Merkle root; 40% to the salvor who submitted the transaction; and 20% to the protocol treasury PDA. The protocol share is computed as the remainder of the proceeds after the two floored shares, so the three transfers exactly exhaust the total, and configuration rejects any attempt to raise the protocol share above the 20% Charter ceiling (the ceiling is a ceiling, not a target; governance may lower it). Per the original whitepaper §3.4, the protocol's share is intended to fund: smart-contract security audits and bug bounties; maintenance and upgrades; infrastructure; new protocol capabilities and DEX integrations; and legal and compliance advisory. These purpose restrictions are Charter commitments binding governance and treasury controls - the deployed program enforces only the 20% cap (update_protocol_config rejects protocol_share_bps above 2,000, error 7005) and the remainder-based computation; no instruction inspects or restricts how the treasury spends its share.

##### **6.1 The LP-holder snapshot and claims**

The snapshot is taken off chain before settlement by a deterministic, re-runnable snapshotter: it enumerates every token account holding the pool's LP mint, hard-gates on the identity that enumerated balances equal the LP mint supply exactly, aggregates balances per owner, attributes locked LP to the recorded beneficial owner rather than the custody account, and seals a self-verifying Merkle artifact (SHA-256, sorted-pair parents). salvage_pool pins the submitted snapshot supply against the live on-chain LP supply and stores the Merkle root in the init-once PoolRegistry. claim_lp_proceeds verifies a holder's Merkle proof, pays floor(bucket x balance_at_snapshot / supply_at_snapshot), records the claim in an init-once ClaimRecord, and imposes no deadline: claims never expire, and the claim path does not read the emergency-pause flag, so original LP holders can always withdraw their settled share. If a holder never claims, the residual stays in the vault permanently; the bucket is unsweepable by any admin key and no redistribution mechanism exists.

##### **6.2 Double-salvage prevention**

A pool is settled at most once, ever. The PoolRegistry and SalvageReceipt PDAs are init-constrained per pool: a second salvage attempt reverts before any lamports move. The certificate, the registry, and the receipt together make settlement a one-shot terminal transition.

##### **6.3 What the 40% allocation is - and is not**

The 40% LP-holder allocation is a defined share of the value actually recovered and realized by a specific settlement. It is not a guarantee that any holder recovers their original capital, any particular fraction of it, or anything at all. Recovered value depends on what the pool still contains, on execution prices at settlement, and on dust policy; per-claim rounding leaves at most a residual the vault retains; and holders who never claim leave value unclaimed indefinitely. The legal documentation states this without qualification: no guarantee of recovery is provided, and protocol eligibility is not a legal declaration that a pool is abandoned. This draft carries the same limitation forward deliberately: the protocol's guarantee is the mechanism (proportional claims, an unsweepable bucket, no expiry, pause immunity), never an economic outcome.

#### **7. Protocol Guarantees and Limitations**

The protocol's documentation deliberately separates what deployed bytecode enforces from what governance and operations commit to. Conflating the two would overstate the guarantees. The table below is the accurate split; anything not listed as bytecode-enforced is a design intention, an operational control, or a governance commitment.

**Table 4. Enforcement map**

| Commitment | Enforcement | Mechanism / tripwire |
| --- | --- | --- |
| 20% protocol share is a ceiling, never raised | Bytecode | update_protocol_config rejects protocol_share_bps above 2,000 (7005); the share is computed as the settlement remainder. |
| lp_holder_pool_vault is unsweepable by any admin key | Bytecode (structural) | No instruction path other than Merkle-verified claim_lp_proceeds can debit the bucket; the dedicated error (7006) is a reserved tripwire with no call site in v1.0 - enforced by absence of code. |
| Claims stay live during emergency pause | Bytecode | The claim path does not read the pause flag; emergency_pause gates only new salvage_pool calls. |
| One settlement per pool, ever | Bytecode | Init-once PoolRegistry and SalvageReceipt PDAs; a second salvage reverts before any lamports move. |
| Settlement conservation (three legs exhaust proceeds) | Bytecode | Share-sum check (7004) plus remainder-based protocol share. |
| Eligibility enforcement (six criteria, two phases) | Bytecode | Single evaluator in GraveScanner; bitmap equality across phases; GraveVault accepts only a live EligibilityCert with the full 0x3F bitmap. |
| Atomic settlement (all-or-nothing) | Bytecode / runtime | One transaction; any failing step reverts the whole transition with no partial state and no PDA residue. |
| 72-hour timelock on parameter changes | Charter process | Multisig-operated via Squads transaction buffers. The on-chain pending_authority, pending_authority_eta, and timelock_seconds fields are reserved, write-only state - no instruction reads them and the timelock error (7014) is never raised. The delay is real only as long as multisig scheduling discipline holds. |
| 7-day public notice on standard upgrades; 24h timelock + 5-day post-mortem on emergency upgrades | Charter process | Documented governance commitments; no runtime tripwire. |
| Multisig custody 3-of-5 at launch, 4-of-7 post-audit | Governance commitment (mainnet posture) | Devnet NS-3 runs a dedicated governance authority key with a separate deployer; no devnet artifact is a proxy for mainnet custody (KEYS-003 open). |
| No token, NFT, points, airdrop, or staking at any layer | Design absence | No mint authority, no token program invocations, no staking state; adding one requires a program upgrade subject to the process commitments above. |
| Only verified economic swaps reset inactivity; finalized-transaction evidence; explicit completeness | Approved direction - not yet implemented | GY-ADR-001 D4/D5/D6. The current SDK derivation accepts any AMM-program touch and does not gate on confirmation status; both corrections are named, owned work items in the core SDK. |
| C5 lock detection covers all lockers | Limitation | Currently UNCX Raydium V4 only; other lockers and non-contract restrictions are undetected (Section 3.1). |
| Claims recover each holder's original capital | Not a guarantee | The 40% allocation is a defined share of realized proceeds (Section 6.3). |
| Protocol 20% share is spent per Charter purposes (audits/bounties, maintenance/upgrades, infrastructure, new capabilities/DEX integrations, legal/compliance advisory) | Charter commitment - NOT bytecode | The program enforces only the 20% cap (7005) and the remainder computation; spending purposes bind governance and treasury controls (original whitepaper §3.4; restored per corrective revision C-09). |

A reserved or write-only authority field is not an enforced timelock, and this document does not describe it as one. Readers and auditors should verify multisig membership and Squads configuration directly; the process layer has no runtime tripwire.

#### **8. Repository Architecture**

GraveYield operates a two-repository split with a strict responsibility boundary. The core protocol repository owns on-chain programs and shared protocol semantics; the dedicated indexer repository owns off-chain evidence infrastructure. The core SDK is the single source of truth for every wire format, and the dedicated indexer consumes it as a pinned dependency rather than re-implementing any of it.

**Table 5. Repository responsibilities**

| Repository | Responsible for | Explicitly not responsible for |
| --- | --- | --- |
| GraveYield/graveyield-protocol (core) | GraveScanner and GraveVault on-chain programs; the shared protocol SDK (wire formats, decoders, PDA derivation, error-code mirror); canonical protocol and evidence semantics; the snapshotter and Merkle artifact tooling; the salvage-side SDK operations (certify-and-salvage, claims); protocol-level verification tests. | Production evidence attestation service; operational RPC infrastructure; lifecycle observation and reporting. Its bundled candidate-indexer package and its ops indexer service overlap dedicated-indexer functionality and are under review for narrowing, migration, or retirement per GY-ADR-001 D3. |
| GraveYield/grave-indexer (dedicated) | Off-chain discovery and indexing of candidate pools; historical evidence collection with provenance; evidence derivation and attestation workflows (C1 issuance; C2 path completion is a named gap); provenance, dedupe, conflict, staleness, and completeness reporting; operational RPC handling; read-only lifecycle observation and reporting; the live evidence-path verification harness against deployed GraveScanner. | Eligibility authority, settlement, transaction submission, and any state mutation. The indexer is evidence infrastructure, not the authority for on-chain eligibility or settlement. |

#### **9. Research Context - Ghost Pools**

The empirical case for GraveYield rests on the Ghost Pools research working paper (WP-2026-001r4). The paper estimates that abandoned liquidity positions hold approximately $2.17 billion across Solana, Ethereum, and BNB Chain in its base case, with conservative and upper-bound scenarios of approximately $860 million and $5.4 billion, an inventory growing by an estimated $400 million per month, and roughly 400,000 affected pools. These are research estimates from a May 2026 sampling run, not verified recoverable TVL and not guaranteed protocol revenue, and they must remain qualified as such wherever quoted.

**Table 6. What the headline figures measure - and do not measure**

| Layer | Meaning | Figure |
| --- | --- | --- |
| Observed / indexed liquidity | Liquidity enumerated by sampling and the public observatory instrumentation. | Sampling basis of the paper (approximately 400,000 pools). |
| Estimated stranded liquidity | Pools classified abandoned under the paper's academic definition (30-day no-swap framework) and related screens. | Basis of the chain-level inventories. |
| Estimated technically recoverable liquidity | Base-asset value recoverable after the dead-token discount applied to the paired-token side; base case discount scenario and a stated 90% interval of $1.1-4.0 billion. | $860M / $2.17B / $5.4B (conservative / base / upper). |
| Liquidity satisfying GraveYield eligibility | The subset that also passes C1-C6 (90-day inactivity, 99% collapse, minimum residual TVL, LP not burned or locked, two-epoch confirmation). | Not measured by the paper; strictly smaller than the recoverable layer. The paper itself notes production criteria concentrate settlement on value-dense pools. |
| Actual settlement proceeds | Value realized by specific salvage transactions after execution costs and slippage. | Not predictable in advance; per-settlement outcome only. |

The paper states its own limitations, which this whitepaper adopts whenever the figures are quoted: stratified sampling error of approximately 15% at the stratum level; a dead-token discount that is an assumption rather than an empirical calibration; point-in-time May 2026 estimates not blended with the live observatory; coverage constraints on some chains; and citation-verification annotations that direct re-verification before external publication. The paper's devnet deployment record documents an earlier deployment generation and is superseded by the current lineage (Section 10). The paper's phrasing that original LP holders retain guaranteed proportional claims is accurate for the claim - the defined allocation of Section 6 - and must not be read as guaranteed recovery value.

#### **10. Roadmap**

The original ten-milestone build sequence remains the project's structure, stated below by current status rather than by date. No completion dates are promised, and no Mainnet launch date is stated or implied.

**Table 7. Build sequence status (as of 2026-11-13)**

| Milestone | Scope | Status |
| --- | --- | --- |
| m1-m8 | Mainnet-grade salvage on Raydium V4: evidence model, evaluator, settlement, claims, dust policy, adversarial hardening. | Status split by evidence class (corrected C-10): (1) Source implementation - complete for the m1-m8 surface (programs/ + sdk/ at the recorded commits). (2) Unit/integration tests - pass at their recorded baselines (668-pass NS-1-era aggregate; 367 Phase-12 gate; different baselines, Q-13). (3) Fork/simulation testing - 8 fork suites exercise the full settlement path against mainnet bytecode locally. (4) Devnet deployment acceptance - W2 NS-3 acceptance 56/56 (deployment acceptance 29/29 + ELF digest verification 27/27): this verifies deployment, ownership, schema, config defaults, and ELF digests ONLY. (5) Controlled end-to-end Devnet lifecycle demonstration of a REAL pool - NOT executed (W2 §9 states the acceptance "does not establish full end-to-end GraveYield lifecycle operation"; the fork suites are the current end-to-end evidence). (6) Independent security audit - not begun (Phase 13 open). (7) Mainnet readiness - not claimed and not implied. Per-milestone evidence: m1/m2 evaluator and criteria - criteria.rs + fork suites + live default decode; evidence model - attestation.rs + live 6024/6025/6026 sims (Phases 1.2/1.3/1.4 changelog); m3/m5 settlement - salvage_pool.rs + fork suites; m4 Raydium V4 adapter - mainnet-verified fixtures; m6 claims - lp_claim fork suite + snapshotter tests; m7 dust policy - sweep_dust + settlement_economics fork suite; m8 adversarial hardening - Phase 12 battery (15 threat classes, dedicated suites). |
| m9 | Off-chain indexer. | Delivered as the dedicated indexer repository (Phase 2 evidence pipeline, operational) with named gaps: economic-swap classification and finalized-transaction gating live in the core SDK (approved, unimplemented), the C2 issuance path is not yet wired into the pipeline, and cursors/backfill are designed but unbuilt. The core repository's bundled candidate indexer is under separation-of-responsibilities review. |
| m10 | Locker adapters. | UNCX Raydium V4 adapter implemented and verified against live mainnet lock state; PinkSale, Team Finance, and other lockers open. |
| Additional AMMs | Raydium CLMM, Orca Whirlpool, PumpSwap, Meteora scanner and settlement adapters. | Open (v1.1 scope); current salvage scope is Raydium V4 only. |
| Security | Independent audit and bug bounty. | Open; the Phase 12 adversarial battery (fifteen threat classes, dedicated case suites in both languages) was completed as audit preparation, not as a substitute for the audit. |
| Mainnet transition | Custody-generated keys, multisig transition, oracle operational runbook, environment-neutral configuration, RPC resilience. | Open (KEYS-003, ORACLE-003, GOV-001 and related staged requirements). |

#### **11. Terminology**

The canonical vocabulary is enforced in the repository by a CI terminology lint. GraveYield is the project; GraveScanner and GraveVault are the on-chain programs; EligibilityAnchor, EligibilityCert, SalvageReceipt, LaunchPrice, PoolRegistry, and ClaimRecord are the on-chain state objects; the two attestation types are the activity attestation (SDK type `LastSwapAttestation`, consumed by criterion C1) and the launch-price attestation (SDK type `LaunchPriceAttestation`, consumed by criterion C2); the labels C1-C6 refer exclusively to the six eligibility criteria; original LP holders, salvor, and protocol allocation are the three distribution parties; derelict pool is the object of settlement; and the deterministic lifecycle for abandoned liquidity is the two-phase, certificate-gated settlement flow described above. The lexeme the glossary forbids (spelled only in glossary.md and scripts/terminology-lint.sh, which the lint exempts) is not part of the project's vocabulary in any artifact, and this draft does not reintroduce it. The maritime salvage framing is an analytical analogy and potential legal theory, not a representation of settled law; the legal documentation governs that boundary.

#### **12. Revision History and Provenance**

**Table 8. Version lineage**

| Version | Date | Status and content |
| --- | --- | --- |
| 4.0 | May 2026 (canon lock) | Historical document. The living markdown source remains in the core repository, unchanged, and retains its meaning as the v4.0 record. The .docx snapshot it references was not present in the repository at reconciliation time. |
| v4.0.1 (informal) | Referenced in program-source comments | A spec patch referenced by sweep-stale-anchor and related code comments; no living whitepaper artifact exists under this designation. The externally circulated file named v4_0_1 carries internal metadata Version 4.0. Absorbed into 4.1.0. |
| 4.1.0 | 2026-11-13 (this draft) | Draft for owner review. Reconciled the evidence model (dedicated oracle attestations replace any external price-feed description), restated the criteria with canonical numbering and scope notes, documented the two-phase lifecycle and enforcement map, added the repository architecture, qualified the research figures, rewrote the roadmap by status, and aligned all language with the legal documentation's guarantee boundary. |

Verification basis for this draft: GraveYield/graveyield-protocol @ c7d203272b994c055295c925ccd69e42c121f581; GraveYield/grave-indexer @ 17998bab3a1c6854e42b67bf3bd1305433e3c3af; vendored SDK pin d52669990a6ea01be7387b0bc4020c29ebdd1699 (zero wire-format drift to the pins above); W2 NS-3 Devnet post-deployment acceptance (56/56 checks PASS, slots 521557300/521557485, epoch 1207); live read-only ProtocolConfig readback on 2026-11-13 confirming the dedicated activity and launch-price oracle keys registered on chain (activity oracle 2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o, launch-price oracle 97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee) and all configuration thresholds at specification defaults.


---

## 5. Canonical technical specification draft (Deliverable 3)

Engineering-reference specification, reproduced below in full. It is more precise than the
whitepaper, introduces no new protocol behavior, and tags every statement with its evidence
class: source-code implementation, SDK implementation, test coverage, deployed-account
evidence, acceptance documentation, approved architecture decision, or proposed requirement.


| <br><br>G Y - D O C - R E C O N - 0 0 1<br>GraveYield Canonical<br>Technical Specification<br>Draft for Owner Review - engineering reference<br><br>GraveScanner - GraveVault - Core SDK - Dedicated Indexer<br>Verified against main c7d2032 / indexer 17998ba / SDK pin d526699<br>Devnet acceptance evidence W2 NS-3 (56/56) and live readback 2026-11-13<br>Reviewable draft - not committed, not published<br><br>GraveYield - canonical engineering reference (draft) |
| --- |


#### **1. Purpose, Precedence, and Evidence Classes**

This specification is the canonical engineering reference for the GraveYield protocol as implemented. It is more precise than the whitepaper, it introduces no new protocol behavior, and every material technical statement is tagged with its evidence class. Where any other document disagrees with this specification's verified content, PROTOCOL_SPEC.md remains the governing specification per the repository precedence rules; this draft is the reconciliation-ready restatement of it.

**Table 1.1 Evidence classes used throughout**

| Tag | Class | Meaning |
| --- | --- | --- |
| [SRC] | Source-code implementation | Verified in program or SDK source at the recorded commits (file:line given where load-bearing). |
| [SDK] | SDK implementation | Verified in the shared TypeScript SDK that both repos consume as the wire-format authority. |
| [TST] | Test coverage | Exercised by an existing test suite (named). Test existence proves only the behavior exercised. |
| [DEP] | Deployed account / interface evidence | Read from the live chain (read-only RPC) on 2026-11-13. |
| [ACC] | Acceptance documentation | The W2 NS-3 Devnet post-deployment acceptance report and its evidence files. |
| [ADR] | Approved architectural decision | Binding owner direction from GY-ADR-001 (D1-D10). Direction, not current code. |
| [PROP] | Proposed requirement not yet implemented | A staged requirement or recommendation awaiting owner approval and implementation. |

Verified baselines: GraveYield/graveyield-protocol @ c7d203272b994c055295c925ccd69e42c121f581 (main); GraveYield/grave-indexer @ 17998bab3a1c6854e42b67bf3bd1305433e3c3af (main); vendored SDK pin d52669990a6ea01be7387b0bc4020c29ebdd1699 (84 commits behind main with zero wire-format drift, verified by tree diff). [SRC][ACC]

Numbering disambiguation: this document says "spec decision Dn" for the decisions registered in PROTOCOL_SPEC.md (D1-D12) and "ADR Dn" for the owner's GY-ADR-001 decisions (D1-D10). These are two different registers; unqualified "D8" references in older documents are ambiguous (reconciliation matrix row SP-02).

#### **2. Component Responsibility Matrix**

**Table 2.1 Components and responsibilities**

| Component | Repo | Responsibilities | Not responsible for | Evidence |
| --- | --- | --- | --- | --- |
| GraveScanner (program) | core | ProtocolConfig; LaunchPrice PDA recording (init-once, oracle-attested only); Phase 1 EligibilityAnchor creation; Phase 2 EligibilityCert issuance/reissue; anchor invalidation and stale-anchor sweep; threshold and oracle-key updates. | Settlement, custody of funds, snapshot production, evidence derivation. | [SRC] programs/grave-scanner (8 instructions) [DEP] deployed @ EFJpKtWx...AQJL |
| GraveVault (program) | core | Salvage execution (preflight, snapshot commitment, AMM withdrawal CPI, Jupiter conversion, 40/40/20 distribution); LP-holder claims; dust sweep; pause; vault-side config. | Eligibility decisions (consumes certs only); oracle signing. | [SRC] programs/grave-vault (6 instructions) [DEP] deployed @ 7VxUGJNg...shya |
| Core SDK (@graveyield/sdk 0.2.0) | core | All wire formats: activity/launch-price attestation builders and parsers, precompile instruction construction, AmmInfo parsing, ProtocolConfig/account decoders, PDA derivation, error-code mirror, salvage/claim instruction builders, snapshot mirror. | Hosting, key custody, service availability. | [SDK] sdk/src (19 modules) [TST] sdk/test 108 tests @ 5cc46cd baseline |
| Dedicated indexer (@graveyield/grave-indexer 0.1.0) | dedicated | Read-only discovery (Raydium V4), provenance-preserving ingestion (dedupe/conflict/staleness), last-swap derivation via SDK, C1 issuance and secret-free evidence bundles, off-chain verifier mirroring on-chain checks, replay journal, live evidence-path matrix, health, deployment-state classification, console snapshots. | Eligibility authority; transaction submission; state mutation; swap-semantic classification (lives in the SDK per ADR D4). | [SRC] src/ 16 files, 4,311 LOC [TST] 78 offline tests verified 2026-11-13 |
| Snapshotter (grave-snapshotter) | core | Off-chain pre-salvage LP-holder snapshot: enumerate LP holders, supply-parity hard gate, per-owner aggregation, locked-LP beneficial-owner attribution, sealed self-verifying Merkle artifact (SHA-256 sorted-pair). | On-chain settlement (salvage_pool pins root + supply). | [SRC] snapshotter/src [TST] snapshotter tests; fork-verified end-to-end |
| Ops services (@graveyield/ops) | core | Indexer sweeps, GraveVault observer (receipt/claim/failed-tx monitoring, invariant checks R1/R2), Merkle service, health, alerts, controlled salvage scenarios. | Canonical evidence attestation (overlaps dedicated indexer - see Section 16). | [SRC] ops/ [TST] 47 offline tests |
| Locker adapter (UNCX) | core (in Scanner) | C5 evidence: per-pool UNCX marker-PDA gate plus strictly validated TokenLock accounts; locked-amount summation; fail-closed opt-out guards. | Other lockers (PinkSale, Team Finance, Streamflow) - not implemented (LOCKER-002). | [SRC] programs/grave-scanner/src/adapters/locker.rs [TST] mainnet vectors (125 locks / 74 pools) |
| adapters/ directory | core | Placeholder README for future locker adapters. | Nothing implemented there; the live UNCX adapter lives in the Scanner crate (README is stale). | [SRC] adapters/README.md |

#### **3. Canonical Eligibility Criteria and Numbering**

One evaluator (grave-scanner/src/criteria.rs) implements the six criteria for both phases. Evaluation is a fixed sequential conjunction C1 through C6; the first miss aborts with PoolNotEligible or a more specific error; a full pass yields bitmap 0x3F. [SRC] Criteria are bits 0-5 in the order below; this is the single canonical numbering. [SRC]

**Table 3.1 Canonical criteria (defaults; governance-tunable within bounded ranges)**

| ID | Rule | Default | On-chain input | Evidence |
| --- | --- | --- | --- | --- |
| C1 Trading inactivity | current_unix_ts - last_swap_unix_ts >= inactivity_seconds (equality passes); sanity: attested ts <= now (6028). | 7,776,000 s (90 d) | activity-attestation last_swap_unix_ts | [SRC] criteria.rs:109-121; constants.rs:13 [DEP] decode = 7776000 |
| C2 Price collapse from launch | drop_bps = floor((launch - current) x 10,000 / launch) >= price_collapse_bps; 0 if risen above launch; capped 10,000. Requires positive, mint-matched launch price (6032/6033). | 9,900 bps (99%) | LaunchPrice PDA (launch-price-attested) + on-chain spot price | [SRC] criteria.rs:123-133,188-192; constants.rs:17 [DEP] = 9900 |
| C3 Minimum residual TVL | current_tvl_lamports >= min_tvl_lamports (inclusive). Raw units of the quote-side vault; 0.5 SOL only when quote mint is WSOL. | 500,000,000 | Quote vault balance | [SRC] criteria.rs:135-140; constants.rs:21 [DEP] = 500000000 [ACC] unit caveat open |
| C4 LP supply not burned | lp_supply > lp_burn_dust_threshold (strict >). | 1,000 raw LP | LP mint supply | [SRC] criteria.rs:142-151; constants.rs:34 [DEP] = 1000 |
| C5 LP not locked | lp_locked_amount == 0 exactly. Amount = sum of validated UNCX TokenLock amounts; marker absent = zero proven without enumeration; marker present requires TokenLock evidence (6020-6023). | 0 | Locker adapter inputs | [SRC] criteria.rs:153-158; adapters/locker.rs [TST] locker vectors [ACC] LOCKER-001 retired |
| C6 Multi-epoch confirmation | Phase 1 stamps first_eligible_epoch; Phase 2 requires current_epoch - first_eligible_epoch >= MIN_EPOCH_CONFIRMATION (6016) and bitmap equality with the anchor (6011). | 2 epochs | Clock + EligibilityAnchor | [SRC] criteria.rs:160-179; constants.rs:25 |

##### **3.1 Numbering across documents (living sources aligned; historical v3.0 divergence documented)**

All LIVING canonical sources use the same semantic order. Differences are labeling only: the whitepaper uses bare numerals 1-6; the specification, technical documentation, combined living markdown, and code use C1-C6; wording variants exist for C4 ("LP not burned" vs "LP supply not burned") and C5 ("LP not locked" vs "No LP lock"). The revised whitepaper adopts C1-C6 and the wording in Table 3.1. One historical inversion - root README's "low TVL" for C3 - was retired by spec decision D1 and remains only in the root README. [SRC][SDK]

CORRECTED (C-01): the assigned ORIGINAL Combined Technical Documentation v3.0 (frozen DOCX, Table 4) used a different historical ordering. Owner-confirmed from the original (R3-01; the binary is not yet in the working environment — Section 2.3):

**Table 3.1a Historical (v3.0 DOCX Table 4) → current canonical criterion mapping**

| Historical v3.0 label | Historical meaning | Current canonical ID | Current meaning (Table 3.1) |
|---|---|---|---|
| C1 | No LP burn | C4 | LP supply not burned (`lp_supply > lp_burn_dust_threshold`) |
| C2 | No governance lock | C5 (partial) | LP not locked — implemented detection scope is UNCX-only; see C-07/Q-04 on the governance/multisig gap |
| C3 | TVL | C3 | Minimum residual TVL |
| C4 | Multi-epoch | C6 | Multi-epoch confirmation |
| C5 | Inactivity | C1 | Trading inactivity |
| C6 | Price decline | C2 | Price collapse from launch |

Historical v3.0 labels must NOT be read as current identifiers: e.g., "v3.0 C2" (no governance lock) is not current C2 (price collapse), and the historical governance-lock criterion has no full current counterpart because the implemented C5 detects UNCX locker locks only (Q-04). The living combined markdown (v3.0-labeled, lines 149-156) already uses the canonical order — it has been updated since the DOCX freeze (its own header notes the DOCX snapshot predates on-main error-code changes).

Legacy v3.0-era claims reconciled against current code (each described as current ONLY where the current source supports it):

| Legacy claim (v3.0 era) | Current verified state | Classification |
|---|---|---|
| "Cheapest-first" evaluation ordering | The evaluator is a fixed sequential conjunction in canonical order C1→C6, short-circuiting on the first miss (criteria.rs comment + evaluate()). The string "cheapest" appears in repository history only in the Phase-9-era bundled indexer (pool-selection heuristics, commit c82ecad) — a different, since-superseded subsystem; never in the on-chain evaluator. | Not current behavior; historical only |
| `invalidate_cert` instruction | No such identifier exists anywhere in either repository's history (`git log -S "invalidate_cert"` = 0 hits). The current instruction is `invalidate_anchor` — authority-gated, pre-certification control; an issued cert is unaffected (its own TTL bounds it). The name presumably comes from the v3.0 DOCX, which cannot be re-inspected. | Legacy name; current = `invalidate_anchor` |
| Certificate consumed on settlement | No consumption exists: salvage_pool validates the cert (existence 7001, unexpired 7002, bitmap, binding) and never closes or mutates it; one-shot settlement is enforced by the init-once PoolRegistry/SalvageReceipt PDAs. The living combined md §4.3 still says "Consumed by GraveVault" — inaccurate wording, recorded as matrix row CB-04 (proposed correction bundled with the next combined-doc re-alignment, Q-17). | Legacy wording; not current behavior |
| Legacy adapter/AMM support | Raydium V4 is the only implemented scanner/settlement path; all other registered AMM stubs revert 6007 (honest-stub test adv_cpi03). PinkSale/Team Finance lockers are not implemented (LOCKER-002). | Current scope documented; legacy broader claims not current |
| Older account/field definitions | Current layouts are normative (state/protocol_config.rs etc., byte-verified live 2026-11-13). v3.0-era field lists cannot be re-inspected (DOCX unavailable) and are superseded. | Current layouts authoritative |

##### **3.2 Program identity and configuration**

**Table 3.2 NS-3 deployed identities (Devnet; verified live 2026-11-13)**

| Item | Value | Evidence |
| --- | --- | --- |
| GraveScanner program ID | EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL | [SRC] lib.rs:51 [DEP] executable, owner match |
| GraveVault program ID | 7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya | [SRC] lib.rs:63 [DEP] executable, owner match |
| Scanner ProtocolConfig PDA | 5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe (bump 255) | [ACC] acceptance report [DEP] 252 B decode |
| Vault ProtocolConfig PDA | 5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda | [ACC] acceptance report [DEP] 210 B decode |
| Governance authority | BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5 | [DEP] config bytes 8..40 |
| Activity oracle (signs the activity attestation) | 2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o | [DEP] config offset 123 (registered) [ACC] registration tx |
| Launch-price oracle (signs the launch-price attestation) | 97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee | [DEP] config offset 155 (registered) [ACC] registration tx |
| Deployer / upgrade authority | cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831 (fees + upgrade; not a config authority) | [ACC] [SRC] DEVNET authority arrangement |
| Legacy NS-1 / NS-2 programs | 5JiCVxES...zvNF / HUyoG5vU...ox3v6 (2026-10-09); CuQZesHk...Ao54 / Bd5smhQg...s7rg (2026-10-25) - keys dead/lost; preserved records only | [ACC] LEGACY_DEPLOYMENTS.md [ADR] DR-001/DR-002 |

All six scanner thresholds decode at specification defaults on chain (inactivity 7,776,000 s; collapse 9,900 bps; min TVL 500,000,000; anchor staleness 1,209,600 s; LP dust 1,000; cert TTL 3,600 s), pause flag false, pending authority zeroed with eta 0, reserved tail zeroed. [DEP] evidence/live_rpc_verification_2026-11-13.txt

#### **4. Activity and Launch-Price Attestation Formats and Verification Responsibilities**

##### **4.1 Activity attestation (112 bytes; consumed by criterion C1)**

Message layout (normative; no borsh; do not reorder): amm_program_id [0..32), pool_address [32..64), last_swap_unix_ts i64 LE [64..72), issued_slot u64 LE [72..80), slot_hash [80..112). The transaction carries an ed25519_program precompile verify instruction immediately before the scanner instruction, with pubkey offset 16, signature offset 48, message span (72,112), and message_instruction_index bound to the scanner instruction. [SRC] attestation.rs:28-62,142-171; [SDK] lastSwapAttestation.ts. On-chain checks in order (verified against attestation.rs:254-329 and errors.rs:134-214): precompile presence (6024 AttestationMissing), offset validity (6025 InvalidAttestationOffsets), oracle-key equality against ProtocolConfig.activity_oracle (6026 AttestationOracleMismatch), message-span pinning (6025 — the SAME InvalidAttestationOffsets code guards this later stage; 6025 fires at two distinct check stages by design; corrected order per C-13 — the previous text placed span pinning before oracle equality), binding echo of amm/pool against instruction params (6027), timestamp sanity 0 < ts <= now (6028), issued_slot sanity (6031), SlotHashes resolution within the window with byte-exact hash (6029/6030). SDK mirror names verified: errors.ts 6024 AttestationMissing / 6025 InvalidAttestationOffsets / 6026 AttestationOracleMismatch. [SRC][TST] live sims recorded 6024/6025/6026 against the deployed program. [ACC]

##### **4.2 Launch-price attestation (168 bytes; consumed by criterion C2)**

Message layout: amm_program_id [0..32), pool_address [32..64), base_mint [64..96), quote_mint [96..128), first_swap_slot u64 LE [128..136), first_swap_unix_ts i64 LE [136..144), launch_price_q64x64 u128 LE [144..160), issued_slot u64 LE [160..168); embedded at offset 152 of record_launch_price instruction data. record_launch_price accepts the price only from this attestation (caller-supplied values revert) and writes the init-once LaunchPrice PDA. There is deliberately no SlotHashes freshness check: the launch price is a time-invariant historical fact and the init-once PDA makes replay structurally impossible. [SRC] attestation.rs:101-118,184-189; [SDK] launchPriceAttestation.ts [TST] precompile construction cases [ACC] phase1-precondition live case

##### **4.3 Verification responsibility split**

**Table 4.1 Who verifies what**

| Layer | Verifies | Failure surface |
| --- | --- | --- |
| Solana runtime (precompile) | Ed25519 signature over exactly the embedded message span. | Invalid signature aborts before the handler. |
| GraveScanner | Precompile presence/offsets; oracle identity; binding; timestamps; slot freshness/hash; launch-price record presence, mint match, positivity; all six criteria; bitmap equality; cert validity for settlement. | Errors 6000-6034; every failure is a revert, no caller-supplied fallback. |
| Dedicated indexer verifier (off-chain mirror) | Same check order against live ProtocolConfig + live blockhash; plus replay journal; outcomes verified / oracle-gated / rejected / indeterminate. | Fail-closed bundle parsing; indeterminate preserved for RPC lag, never conflated with stale. |
| GraveVault | Cert existence (7001), unexpired validity (7002 = expired cert rejected), bitmap 0x3F; snapshot supply pin (7018); pool binding; route vetting; slippage floor (7007); share-sum and ceiling (7004/7005). | Errors 7000-7022; init-once registry/receipt prevent double settlement. |

##### **4.4 Domain separation note**

The attestation messages carry no explicit domain-separation prefix. Binding is structural: amm/pool echo (6027), oracle-key equality (6026), slot-hash binding (6029/6030), and the precompile span pinning the signature to exactly the bytes the handler reads as params.msg. This matches the on-chain contract as implemented and the SDK mirror; any future domain-separation prefix is a protocol-side wire-format change requiring coordinated SDK + program + indexer + salvor-bots changes. [SRC][SDK]

#### **5. EligibilityAnchor and EligibilityCert Lifecycle**

**Table 5.1 Lifecycle objects**

| Object / step | Semantics | Errors | Evidence |
| --- | --- | --- | --- |
| record_launch_price (Phase 0) | Init-once LaunchPrice PDA from a launch-price attestation; mint pair re-checked at evaluation (6033). | 6032 zero price; 6033 mint mismatch | [SRC] instructions/record_launch_price.rs |
| evaluate_pool_phase_1 | Full evaluator; on pass creates EligibilityAnchor {first_eligible_epoch, criteria_bitmap, writer, invalidated}; on fail writes nothing. LaunchPrice PDA is a hard precondition (6002). Paused config reverts (6010). | 6001/6010/6002; anchor init | [SRC] evaluate_pool_phase1.rs |
| Waiting period | >= MIN_EPOCH_CONFIRMATION (2) epochs between anchor epoch and Phase 2; approximately 4-6 days. | 6016 EpochConfirmationPending | [SRC] phase2 + constants.rs:25 |
| evaluate_pool_phase_2 | Full re-run with a fresh activity attestation (the Phase 1 attestation has necessarily aged out); bitmap equality (6011); anchor invalidated gate (6017); writes/reissues EligibilityCert {expires_at = now + cert_ttl, reissue_generation}. | 6011/6015/6016/6017/6019/6034 | [SRC] evaluate_pool_phase2.rs |
| Cert TTL | Default 3,600 s; floor 600 s (update reverts below floor); live cert immutable (6034); reissue in place after expiry only. | 6019/6034 | [SRC] constants.rs:48,57 [SDK] decode certTtlSeconds |
| invalidate_anchor (authority) | Marks anchor invalid; Phase 2 via this anchor impossible. Does not affect an issued cert. | 6017 | [SRC] invalidate_anchor.rs |
| sweep_stale_anchor (permissionless) | Closes anchors after anchor_staleness_seconds (default 14 d, floor sized at 3 epochs); rent returns to writer; confers no salvage rights; safe vs certs because cert TTL is far shorter. | 6018 AnchorNotStale | [SRC] sweep_stale_anchor.rs |
| salvage_pool settlement gate | Cert must exist (7001 if missing), be unexpired (7002 if expired — `is_expired` gate at salvage_pool.rs:300-303), bind this pool/program, carry bitmap 0x3F. The cert is NOT consumed or closed by settlement: one-shot settlement is enforced by the init-once PoolRegistry/SalvageReceipt PDAs, and the cert simply expires by TTL. | 7001/7002 | [SRC] salvage_pool.rs |

An anchor is never a salvage authorization: no instruction path leads from an anchor to liquidity movement, GraveVault does not accept anchors, and Phase 2 must independently re-verify every condition with fresh evidence. [SRC]

#### **6. Historical Transaction Evidence Requirements**

Activity-attestation derivation (criterion C1 input): the SDK's deriveLastSwapV4 scans getSignaturesForAddress newest-first (bounded by SIGNATURE_SCAN_LIMIT, default 1,000) and takes the first transaction that invokes the AMM program with the pool among its accounts, using its blockTime. Verified limitations: the predicate does not distinguish swaps from liquidity/administrative/crank invocations (audit H-1), and no confirmation-status gate exists despite the SDK header naming a minConfirmations requirement (audit H2; the literal is absent from PROTOCOL_SPEC - the header's cross-reference is unsupported as written). ALT-unresolved and version-1 transactions are skipped silently (documented; lowers yield). [SDK][SRC] sdk/src/lastSwapAttestation.ts:194-257 [TST] partial

Launch-price derivation (criterion C2 input): deriveLaunchPriceV4 scans history backwards for the first transaction that moves the two vault balances in opposite directions; the pre-swap reserve ratio is encoded Q64.64, byte-identical to the on-chain spot-price math. It refuses to guess: a getTransaction miss throws, and hitting the page limit before genesis is fail-closed. It requires full-archive trusted RPC (spec decision D9; ORACLE-003 runbook). Implemented in the SDK; not wired into any operational pipeline (audit F-H3; R-33). [SDK][SRC] launchPriceAttestation.ts:197-259

Approved direction ADR D4: only verified economic swaps reset inactivity. Canonical swap/liquidity/admin classification belongs in the SDK; ambiguous transactions remain unresolved and fail closed. Not yet implemented - the classification and its fixture-test matrix are specified as the acceptance target for the SDK change, to be mirrored byte-equal in salvor-bots (repo red line, ORACLE_PIPELINE §8.3).

#### **7. Finalized-Transaction Policy (Approved - Not Yet Implemented)**

ADR D5 establishes that historical transaction evidence must be based on finalized transactions. Target semantics: candidate signatures whose confirmationStatus is not finalized are excluded from both derivations; the observed confirmation status is recorded in the evidence provenance; and an optional depth margin behind the tip may be configured per workload. This policy is an off-chain evidence-quality requirement. It does not replace, emulate, or weaken the on-chain multi-epoch requirement (C6), which is enforced by GraveScanner independently of any RPC behavior. Implementation location: the core SDK (single source of truth), coordinated with the byte-equal salvor-bots mirror; the dedicated indexer inherits it via the SDK and labels the derivation kind in its provenance. Status: approved, not implemented; interim labeling (derivationKind: swap | amm-touch; confirmationStatus per candidate) is the recommended transitional surface. [ADR][PROP]

#### **8. Evidence Completeness and Failure Semantics**

**Table 8.1 Completeness and failure behavior by stage**

| Stage | Complete-evidence condition | Failure behavior |
| --- | --- | --- |
| Discovery | gPA corpus bracketed by slots; deterministic ordering; in-batch dedupe; stale snapshots (>400 slots) excluded. | Malformed accounts counted, never guessed; conflict (same slot, different bytes) excluded fail-closed; determinism currently conditional under the MAX_POOLS_PER_SCAN cap (audit M-3). |
| Activity-attestation derivation | History scan bounded (limit 1,000); noSwapFound is an explicit fact (unknown, never inferred); regression rule keeps the cache authoritative. | Skipped candidates (ALT/v1) recorded nowhere today (audit L-6); the scan limit is recorded, not the actual scan - flagged. |
| Activity-attestation issuance | issued_slot resolves on the destination cluster (finalized - 4) with fetchable hash. | Unresolvable slot aborts issuance (6029 analogue, fail-closed). |
| Activity-attestation verification | Every on-chain property reproduced against live data + journal. | rejected vs indeterminate preserved distinctly; replay journal append-only, torn-tail tolerant. |
| Launch-price derivation | Full archive reaches the first qualifying price event. | Page-limit hit or missing tx = fail-closed refusal (incomplete/unavailable is the classification; no price substitution). |
| Launch-price record | Oracle-signed attestation only; init-once. | Zero price (6032), mint mismatch (6033), existing PDA reverts. |
| Lifecycle | Anchor -> gap -> cert with identical bitmap. | Any mismatch fails certification entirely; pool re-enters Phase 1. |
| Settlement | Snapshot supply equals live LP supply (7018); cert fresh; bitmap 0x3F. | Preflight failure (7013), slippage (7007), CPI failure (7015/7016) revert the whole transaction (atomic, no PDA residue). |
| Claims | Merkle proof verifies; claim record fresh. | Invalid proof (7010), duplicate (7011) revert; unclaimed residual stays permanently (unsweepable). |

Approved direction ADR D6 requires explicit completeness status, persistent pagination/cursors, and controlled backfill, and forbids inferring inactivity from incomplete or truncated history. Current state: bounded scanning exists; the C2 path already refuses incomplete history; the C1 path lacks a completeness indicator and the pipeline lacks cursors/backfill - classified as approved-but-not-implemented (Deliverable 5). An indexer whose scan is incomplete must never claim a qualifying inactivity period; the honest states today are noSwapFound (unknown) and the pending console criteria. [ADR][SRC]

##### **8.1 Launch-price (criterion C2) historical coverage requirement**

Launch-price evidence requires sufficient historical transaction coverage to establish the first qualifying price event. If the available history cannot reach it - pruned RPC, page limit, missing transaction - the evidence must be classified incomplete or unavailable; substituting an arbitrary price or treating partial history as sufficient is prohibited by the SDK's fail-closed design and by this specification. [SDK][SRC] launchPriceAttestation.ts:254-259

#### **9. LP-Holder Snapshot and Claims**

Snapshot production is off chain and normatively pre-salvage (spec decision D11): enumerate every SPL token account holding the LP mint; hard-gate that enumerated balances equal the mint supply exactly (SupplyMismatch); aggregate per owner in canonical order; attribute UNCX-locked LP to the recorded beneficial owner (TokenLock.lock_owner), reconciling the custody account by exact balance; emit leaves sha256(holder_pubkey || lp_balance_u64_le) with sorted-pair SHA-256 parents (OpenZeppelin/Uniswap convention, spec decision D12); seal a self-verifying artifact. The Rust snapshotter and the SDK snapshot mirror implement the same pipeline. [SRC] snapshotter/src; [SDK] snapshot.ts [TST] snapshotter 15 tests + SDK suite; fork-verified end-to-end claim lifecycle. [ACC]

salvage_pool pins the snapshot: the submitted lp_total_supply_at_snapshot must equal the live on-chain LP mint supply (7018) or settlement reverts before any lamports move. claim_lp_proceeds verifies the Merkle proof, pays floor(bucket x balance / snapshot_supply) with u128 intermediates and a conservation check, records the init-once ClaimRecord, and stays live during emergency pause (the claim path reads no pause flag). Claims never expire; a non-claiming holder's residual remains in the unsweepable vault permanently. The snapshot certifies balances at snapshot time - it is not independent proof of launch-time ownership. [SRC] claim_lp_proceeds.rs; [SDK] merkle.ts byte-locked

#### **10. Salvage Settlement and Distribution**

salvage_pool executes in one atomic transaction: preflight against live pool state (7013); cert validation (7001/7002) with bitmap 0x3F; snapshot supply pin (7018); Raydium V4 withdraw CPI burning the salvor's LP in place (13 remaining accounts, orientation derived from the pool's own mints with the WSOL side pinned, 7019 for non-WSOL base; LP prerequisite per C-08 — the burned LP comes from `salvor_lp_token_account`, `token::authority = salvor`, `salvor_lp_amount > 0`; the salvor must source the LP themselves, no protocol acquisition path exists, original holders keep their snapshot-based claims, and locked/inaccessible LP cannot be burned by the salvor — Q-16); conversion via a Jupiter v6 route with the protocol's route-vetting rules (no custody-bearing accounts in the route; vault-WSOL destination required) and a slippage floor computed from live reserves and capped by config (7007); the leg-output floor assertion; then the distribution: salvor and LP shares are floor(total x bps / 10,000), the protocol share is the remainder, the share sum is re-validated (7004) and the ceiling enforced (7005); three system transfers signed by the vault authority complete settlement, and the SalvageReceipt PDA is written. Dust below the conversion threshold is not swapped: it is recorded on the receipt and recoverable via the one-shot, permissionless sweep_dust (7020/7021), which never touches the LP-holder SOL bucket. [SRC] salvage_pool.rs + cpi/mod.rs [TST] 8 fork suites incl. settlement_economics (D7) and security_negative [ACC] local fork harness; no controlled real-pool salvage executed on devnet to date. [ACC] tech-doc §9

Distribution defaults: 4,000 / 4,000 / 2,000 bps with the 2,000 bps protocol ceiling (7005). Rounding remainder accrues to the protocol share by construction (conservation, spec decision D7). The LP-holder allocation is a defined share of realized proceeds - not a guarantee of recovery of any holder's original capital (legal documentation: no guarantee of recovery is provided). [SRC] vault constants.rs [ACC] legal-documentation.md:599

#### **11. PoolRegistry and Duplicate-Settlement Prevention**

Double settlement is prevented structurally: PoolRegistry (root, snapshot supply, totals, claimed counter) and SalvageReceipt are both init-constrained per pool; a second salvage_pool call reverts at the init constraint before any lamports move. The registry also carries the running claimed total, which the claim conservation check (new_claimed <= lp_holder_pool_total_lamports) bounds. Together with the init-once LaunchPrice and ClaimRecord PDAs and the cert lifecycle, every one-shot object in the protocol is an init-once PDA. [SRC] state/pool_registry.rs; salvage_pool.rs:154-172,691-723 [TST] fork suites (full_lifecycle, lp_claim)

#### **12. RPC Operational Requirements**

**Table 12.1 Current state vs approved direction (ADR D10)**

| Requirement | Current state | Target (ADR D10 / staged docs) | Status |
| --- | --- | --- | --- |
| Per-request timeout | None outside the harness (discovery/enrichment/issuance single-shot). | Bounded per-request timeout on every RPC call. | Approved - not implemented (audit M-2) |
| Retry with backoff | Only verifier slot-hash resolution (8 bounded step-backs) and harness memoizer (6 x 2 s). | Bounded exponential backoff with jitter, rate-limit awareness. | Approved - not implemented |
| Provider failover | None; single endpoint per cluster. | Provider-independent client with optional failover list; workload-specific configuration (discovery vs evidence vs monitoring). | Approved - not implemented |
| Honesty under incomplete data | Verifier preserves indeterminate; console pins unevaluated criteria; C2 refuses incomplete history. | Explicit completeness status on every evidence artifact; never present truncated history as complete. | Partially implemented |
| Trusted-RPC operator contract | Documented (ORACLE_PIPELINE §2/§6): derivation requires trusted endpoints; provenance labels endpoint kind, never URLs. | Retained; formalize provider trust in the runbook. | Documented |

Cluster model (dedicated indexer): a discovery cluster (default mainnet-beta) for enumeration/history and a destination/verification cluster (default devnet) where issued_slot + hash must resolve and ProtocolConfig is read; both wired via env with devnet-era names flagged for cluster-neutral rework (audit M-4). [SRC] config.ts [ADR] D9

#### **13. Oracle Authority Custody, Rotation, and Revocation**

Both oracle authorities are ProtocolConfig public keys, initialized to the protocol authority and rotatable independently via update_protocol_config (scanner config fields at offsets 123/155; live-verified). The launch-price key is deliberately separate: the baseline is init-once and permanently binding, so its signing key is isolated from the hotter activity key (spec decision D9). Registration on NS-3 devnet executed via protocol_admin.mjs register-oracle with the governance authority signing and the deployer paying fees; recorded transaction 3US6jRzFC3yrx9qaqPMaVajEVcMdjau7eNKgpXrYwVGNrX73ESaQBXdGSUJyfCptaF7KhGCJgCqQnCyYGfAEfw5Z. [SRC] [ACC] [DEP]

**Table 13.1 Custody rules (as documented; operational commitments, not bytecode)**

| Rule | Content | Evidence |
| --- | --- | --- |
| Key storage | ORACLE_KEY_FILE (solana-keygen JSON 64-byte or 32-byte seed, or {seed_base58}), mode 0600, stored outside any repository; ACTIVITY_ORACLE_KEY env form exists but is discouraged. Parsing never logs input; neither key present = signing refuses (fail-closed). | [SRC] config.ts:136-173; sign.ts:64-81 [TST] fail-closed + fingerprint tests |
| Logging | Public-key fingerprints only (first-8-base58 / sha256-16); bundles, journals, snapshots, and reports are secret-free by construction (schema-pinned). | [SRC] sign.ts:40-43 [TST] leak tests |
| Separation | C1 and C2 signers are distinct keys; the signer functions refuse cross-format messages (112 vs 168 length gates). Registration does not require the oracle keys to sign. | [SRC] sign.ts [ACC] ORACLE_CUSTODY §2A |
| Rotation | Generate new dedicated keypair (0600) -> governance authority signs update_protocol_config -> pipeline cutover (ORACLE_KEY_FILE to new key; verify-path positive case) -> old key simply no longer configured - authorization is a single equality against the current config; there is no on-chain revocation list. | [ACC] ORACLE_PIPELINE §6.2 (status flip pending in docs - matrix IN-03) |
| Revocation / compromise | Suspected key compromise: rotate immediately and pause the scanner (update_protocol_config -> paused; 6010 containment at zero cost). Forged-but-valid evidence: blast radius contained on chain (precompile rejects foreign signatures; anchors invalidatable by authority; sweep ages them out); record (pool, issued_slot, msg_sha256) in the replay journal. Writer-key loss has no protocol impact. | [ACC] ORACLE_PIPELINE §6.3 |
| Monitoring | Watch ProtocolConfig.activity_oracle changes, pause flips, and program upgrades; scheduled evidence smoke (daily 06:11 UTC, secret-gated, fail-loud); freshness monitoring and downtime policy are staged under ORACLE-003 (open). | [SRC] scheduled workflow [ACC] ORACLE_PIPELINE §6.4-6.5 [ACC] PRE_MAINNET_CHECKLIST ORACLE-003 |
| Honesty boundary | On-chain verification is cryptographic but cannot re-derive history: a buggy or colluding oracle could attest a wrong timestamp, and a wrong init-once launch price is permanent. Custody, rotation, and downtime response remain operational requirements; do not read 'oracle attestation verifies on chain' as 'oracle operations are complete'. | [ACC] PROTOCOL_SPEC §6.3; technical-documentation.md:138-143 [ADR] D8 |

#### **14. Devnet / Mainnet Configuration Separation**

Solana-first scope with multichain deferred (ADR D9): the frozen specification scopes v1.0 to Solana with Raydium V4 only; cross-chain content exists only as research. Program IDs are per-deployment constants: the NS-3 devnet pair (Table 3.2) is the active-code identity surface (declare_id!, Anchor.toml, scripts, SDK constants, indexer config), and mainnet will require custody-generated fresh keypairs, never reuse of devnet keypairs (KEYS-003, open). Legacy deployments NS-1/NS-2 are preserved records whose keys are dead or lost; no authority-dependent action is possible against them and none may be re-pointed at. [ADR] [ACC]

Environment separation inside the dedicated indexer: discovery defaults to mainnet-beta, verification/destination defaults to devnet, and the deployment-state classifier gates program-level checks on actual on-chain readiness. Environment-neutral naming is approved direction not yet implemented (DEVNET_RPC_URL naming, hardcoded 'devnet' destination strings; audit M-4). Devnet acceptance evidence (W2, 56/56) is explicitly Devnet-only: not a Mainnet deployment approval and not a security-audit certification. [SRC] deploymentState.ts [ACC] W2 §9

#### **15. Deployment Verification and Monitoring Requirements**

**Table 15.1 Verification and monitoring inventory**

| Item | State | Evidence |
| --- | --- | --- |
| W2 NS-3 deployment acceptance | PASS 56/56 (acceptance verifier 29/29 + ELF digest verifier 27/27) at devnet slots 521557300/521557485, epoch 1207; ELF digests pinned in scripts/devnet/provenance.manifest.json (scanner e24ddc5e..., vault 8c71fe9d...); emergency drills passed (pause; intruder rejected 6000/7000; unpause; readback). | [ACC] W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md |
| Scope of the acceptance | Devnet only; not a Mainnet approval; not a security-audit certification; not full end-to-end lifecycle operation; drills cover only the tested operations; matching ELF digests do not prove all dependency provenance. | [ACC] W2 §9 (verbatim limitations) |
| Deployment-state classification (indexer) | Program-existence-first classification (pending/ready/partial/inconsistent) from actual accounts + ProtocolConfig decodability; live result: ready. | [SRC] deploymentState.ts [DEP] 2026-11-13 |
| CI (protocol repo) | cargo fmt/clippy, anchor build (--no-idl, CI-only IDL policy), pnpm typecheck, terminology lint, CodeQL; Rust host + fork suites; devnet smoke workflows. | [ACC] tech-doc §7.1/§8 [SRC] workflows |
| CI (dedicated indexer) | Push/PR: build vendored SDK -> typecheck -> 78-test offline battery; read-only devnet smoke on the public endpoint; scheduled daily evidence smoke (06:11 UTC) secret-gated and no-op-clean without secrets, fail-loud with them; mainnet discovery job requires MAINNET_RPC_URL. | [SRC] .github/workflows x2 [TST] verified locally 2026-11-13 |
| Monitoring services (ops) | Vault observer (receipt/claim/failed-tx indexing, invariant checks R1: leg sum equals proceeds; R2: each leg within 1 lamport of its bps share), health registry, alert dedup + webhook, controlled scenarios. | [SRC] ops/ [TST] 47 tests [ACC] OPS.md |
| Open staged items | ORACLE-003 (oracle operational runbook, critical), KEYS-003 (mainnet custody, critical), GOV-001 (on-chain timelock option), LOCKER-002 (other lockers), CPI-002..008 (additional AMMs), KEYS-001/002. | [ACC] PRE_MAINNET_CHECKLIST |
| No linter / coverage / dependency audit in the dedicated indexer | Gap; proposed operational requirement. | [SRC] package.json [PROP] audit L-5 |

#### **16. Repository Ownership and the Core-Indexer Overlap (Recommendation)**

ADR D3 establishes the dedicated indexer as the canonical evidence pipeline while the core repository keeps on-chain programs and SDK functionality, and directs that overlapping core indexer functionality be evaluated for narrowing, migration, or retirement. The overlap verified today: the core repo ships indexer/ (@graveyield/indexer 0.2.0, "Phase 9" candidate funnel: discovery -> activity -> reserve/metadata filtering -> six-criterion pre-filter -> scoring -> queue -> SUBMIT Phase 1 transactions -> tracking), whose submit path signs with ACTIVITY_ORACLE_KEY and sends transactions (sendAndConfirmTransaction); and the ops indexerService reuses the same stages with ACTIVITY_ORACLE_KEY for Phase-1 submission per the OPS runbook. Both duplicate the dedicated indexer's discovery and activity-derivation stages, and both concentrate oracle signing capability in packages whose primary role is broader than evidence attestation. [SRC] indexer/README.md:11-20; submit.ts:9-18,140-141; OPS.md service table

**Table 16.1 Recommendation per overlapping element (no migration performed)**

| Element | Recommendation | Rationale |
| --- | --- | --- |
| indexer/ submit.ts + ACTIVITY_ORACLE_KEY custody | Retire from the candidate-scanner package. | Transaction submission and oracle-key custody belong to the dedicated oracle/evidence service under the documented custody runbook; a funnel scanner holding a signing key widens the compromise surface and contradicts the custody model (D8). |
| indexer/ tracking.ts (lifecycle monitoring) | Migrate to the dedicated indexer's planned lifecycle reporter. | The dedicated indexer already owns observation/reporting; SDK decoders exist and are tested (gap M-1). |
| indexer/ eligibility/scoring/queue (read-only funnel) | Narrow to read-only candidate surfacing or migrate into ops scenarios; owner choice. | Valuable salvor-funnel logic, but not evidence infrastructure; keeping it read-only preserves the authority boundary. |
| ops/indexerService | Reposition as monitoring only (no oracle key). | OPS.md already defaults to read-only; removing the submission contract aligns it with D3. |
| Shared discovery/activity logic | Single implementation in the SDK; both repos consume it. | Already true for wire formats; ADR D4/D5 make the SDK the canonical classification point, so duplicated derivation loops should collapse onto it. |

This table is a recommendation for owner review (Deliverable 6, Q-05). No code, package, or behavior was changed; the dedicated-vs-core split decision and its sequencing remain owner decisions.

#### **17. Implementation Status Classifications**

Six classifications are used, with the authoritative per-item matrix delivered separately (Deliverable 5): Implemented and verified (source + tests + deployed/acceptance evidence agree); Implemented but insufficiently verified (implemented, evidence narrower than the claim); Partially implemented (subset of the approved behavior exists); Approved but not yet implemented (ADR direction with no code); Proposed operational requirement (staged docs/checklist, no owner-approved implementation mandate); Unresolved or requiring owner decision. Headline classifications: criteria evaluator, attestations, lifecycle, settlement, claims, and double-settlement prevention are implemented and verified; SDK derivation semantics (economic-swap classification, finalized gating) and the RPC resilience layer are approved but not implemented; the C2 issuance path, lifecycle observation, cursors/backfill, and environment-neutral configuration are partially implemented or approved-not-implemented in the dedicated indexer; oracle operational runbook (ORACLE-003) and mainnet custody (KEYS-003) are open staged requirements. [ADR][SRC][ACC]

#### **Appendix A. Lock and Governance Terminology (Workstream D)**

The documents historically did not consistently distinguish forms of LP restriction. The eligibility criterion C5 has a precise, narrow scope, and the taxonomy below is the reconciled terminology. Mechanisms are not interchangeable; "not detected" does not mean "not locked".

**Table A.1 Restriction taxonomy vs current detection**

| Mechanism | Description | Detected by C5 today? | Notes |
| --- | --- | --- | --- |
| Dedicated LP locker contracts - UNCX (Raydium V4) | Tokens locked in UNCX per-pool marker PDA + TokenLock accounts. | Yes (LOCKER-001) | Fail-closed evidence rules: marker absent proves zero without enumeration; marker present requires TokenLock evidence (6020-6023). Verified against live mainnet locks (125 locks / 74 pools). |
| Dedicated LP locker contracts - PinkSale / Team Finance / Streamflow / others | Tokens locked in third-party locker programs. | No (LOCKER-002 open) | A pool locked in an undetected locker passes C5. Expanding detection requires owner approval and new adapter code. |
| LP token custody (plain holder balances) | LP held by wallets, including deployer/treasury wallets. | No - and intentionally so | Custody is not a lock; the snapshot/claims contract handles distribution regardless of who holds LP. Kept out of C5 scope to avoid redefining eligibility. |
| AMM pool authority | The Raydium V4 pool's authority PDA controls administrative AMM instructions. | No | Pool-authority status is not read by the evaluator; a changed or seized pool authority is not a C5 condition today. Requires specification if the owner wants it in scope. |
| Governance-controlled restrictions | DAO/governance programs that can block withdrawals or mandate processes. | No | Not detectable by any adapter; would require explicit specification per mechanism. |
| Multisig-controlled restrictions | LP held under multisig control (e.g., Squads accounts). | No | Same as plain custody from the evaluator's perspective. |
| Full burn | LP supply zero or below dust threshold. | Adjacent: C4 | Burned LP is criterion C4's condition, not C5's; C4's strict-greater rule rejects fully incinerated supplies. |

Definition adopted for documentation: for C5, "locked" means LP amount attributed to a supported dedicated locker adapter. The criterion is not expanded beyond this without owner approval (assignment boundary; Deliverable 6 Q-04). Historical definitions were broader: the original whitepaper describes the absence of governance or multisig locks, and the Combined Technical Documentation discusses governance and pool-authority lock conditions (owner-confirmed from the originals — R3-01). Whether UNCX-only detection is the intended canonical criterion or the implementation is incomplete relative to those historical definitions is an explicit owner decision (Q-04) and a publication and Mainnet-readiness blocker until resolved (C-07). Snapshot-side interaction: UNCX-locked LP is attributed to the beneficial owner in snapshots (D11), which is a claims-fairness rule independent of C5. [SRC] snapshotter/locked.rs [ADR] D11

#### **Appendix B. Constants Reference**

**Table B.1 Locked and configured constants (defaults)**

| Constant | Value | Source |
| --- | --- | --- |
| DEFAULT_INACTIVITY_SECONDS | 7,776,000 (90 days) | grave-scanner constants.rs:13 [DEP] |
| DEFAULT_PRICE_COLLAPSE_BPS | 9,900 (99%) | constants.rs:17 [DEP] |
| DEFAULT_MIN_TVL_LAMPORTS | 500,000,000 (0.5 SOL when quote mint is WSOL) | constants.rs:21 [DEP] |
| DEFAULT_LP_BURN_DUST_THRESHOLD | 1,000 raw LP (PRE-MAINNET-TODO(KEYS-002)) | constants.rs:34 [DEP] |
| MIN_EPOCH_CONFIRMATION | 2 (compile-time constant, not config) | constants.rs:25 |
| DEFAULT_ANCHOR_STALENESS_SECONDS | 1,209,600 (14 days); floor 518,400 (3 epochs) | constants.rs:39,76 [DEP] |
| DEFAULT_CERT_TTL_SECONDS / MIN_CERT_TTL_SECONDS | 3,600 / 600 | constants.rs:48,57 [DEP] |
| APPROX_EPOCH_DURATION_SECONDS | 172,800 (informational, staleness arithmetic only) | constants.rs:100 |
| LP_HOLDER / SALVOR / PROTOCOL shares | 4,000 / 4,000 / 2,000 bps; protocol ceiling 2,000 bps | grave-vault constants.rs [SRC] |
| max_slippage_bps (vault config default) | 300 bps (leg floor asserted before swap; 7007) | vault ProtocolConfig [ACC] |
| jupiter_dust_threshold_lamports | 666,666 (below this, dust is not swapped) | vault ProtocolConfig [ACC] |
| max_priority_fee_ceiling_lamports | 1,000,000,000 (SDK/operator-enforced advisory; programs never read it - spec decision D3) | vault ProtocolConfig [ACC] |
| timelock_seconds | 259,200 (72 h) - write-only reserved state; Squads scheduling is the actual delay (spec decision D2; 7014 reserved, never raised) | vault/scanner ProtocolConfig [SRC] |
| PDA seeds | protocol_config; eligibility_anchor; eligibility_cert; launch_price; pool_registry; salvage_receipt; lp_holder_pool; claim_record; protocol_treasury (+ vault authority/holding PDAs) | constants.rs / state modules [SDK] pdas.ts byte-locked [TST] pdas.test.ts |

#### **Appendix C. Error-Code Surface (deltas only)**

The full normative tables live in docs/error_codes.md (Rust sources win on any disagreement). Reconciliation deltas: error_codes.md's section headings understate its own tables (6000-6019/7000-7019 vs 6034/7022); the combined living markdown says vault codes end at 7021 while the on-chain enum ends at 7022 (InvariantViolation, no-op pause toggle); and the SDK mirror lacks 7022 (code change flagged, not performed). Scanner discriminants 6012-6014 are reserved gaps. [SRC] errors.rs self-tests pin all codes; [SDK] errors.ts mirror (gap flagged); [ACC] error_codes.md.


---

## 6. Architecture and data flow description (Deliverable 4)

Component map, authority matrix, end-to-end flow with failure behavior, the canonical ASCII
diagram (repo documentation convention) plus a Mermaid rendering as a review artifact, and
trust boundaries. Reproduced below in full.


| <br>G Y - D O C - R E C O N - 0 0 1<br>GraveYield Architecture<br>and Data-Flow Description<br>Component map, authority matrix, end-to-end flow, and trust boundaries<br>Indexer -> SDK -> oracle attestation -> GraveScanner -> GraveVault<br>Verified against main c7d2032 / indexer 17998ba / SDK pin d526699<br>Devnet acceptance W2 NS-3 (56/56) and live readback 2026-11-13<br>Reviewable draft - not committed, not published<br><br>GraveYield 2026-11-13 |
| --- |

#### **1. Purpose and Conventions**

This document describes the GraveYield component map and end-to-end data flow from evidence collection through settlement: dedicated indexer -> core SDK / evidence construction -> oracle attestation -> on-chain verification -> GraveScanner eligibility lifecycle -> GraveVault settlement. It identifies which component is authoritative at every operation. Diagrams are provided in two forms: a pure-ASCII diagram, which matches the repository documentation conventions (the living documents use ASCII, not Mermaid), and a Mermaid diagram as a convenience artifact for review tooling; the Mermaid form is not currently a repository convention and is not stored in the repos.

#### **2. Component Map**

**Table 2.1 Components (v1.0 scope: Solana, Raydium V4)**

| Component | Location | One-line role | Authority scope |
| --- | --- | --- | --- |
| GraveScanner | graveyield-protocol/programs | Records launch prices, evaluates the six criteria in two phases, issues EligibilityCerts. | Sole authority for eligibility state and config. |
| GraveVault | graveyield-protocol/programs | Executes settlement, distribution, LP-holder claims, dust sweep, pause. | Sole authority over settlement funds within its rules. |
| Core SDK (@graveyield/sdk) | graveyield-protocol/sdk | All wire formats, attestation builders, decoders, PDAs, error mirror, salvage/claim builders. | Canonical protocol/evidence semantics (single source of truth). |
| Dedicated indexer (grave-indexer) | GraveYield/grave-indexer | Discovery, provenance-preserving ingestion, C1 derivation/issuance, verifier, journal, health, deployment-state classification. | Evidence infrastructure; no eligibility or settlement authority; submits nothing. |
| Snapshotter (grave-snapshotter) | graveyield-protocol/snapshotter | Pre-salvage LP-holder snapshot with supply-parity gate and sealed Merkle artifact. | Produces artifacts; salvage_pool pins them on chain. |
| Ops services (@graveyield/ops) | graveyield-protocol/ops | Monitoring: vault observer, health, alerts, scenarios, Merkle service. | Read-only by default; submission contract under D3 review. |
| Oracle keys (activity / launch-price) | operator custody | Sign the activity and launch-price attestations; registered in ProtocolConfig. | Signing authority for evidence; governance-registered, operator-held. |
| UNCX locker adapter | inside GraveScanner | C5 lock evidence (marker PDA + TokenLock validation). | Evidence input to the evaluator only. |

#### **3. Authority Matrix**

**Table 3.1 Who is authoritative for each operation**

| Operation | Authoritative component | Consumers must treat as | Evidence |
| --- | --- | --- | --- |
| What the launch price is | GraveScanner LaunchPrice PDA (init-once, oracle-attested). | Immutable baseline after recording. | [SRC][DEP] |
| Whether a pool is eligible now | GraveScanner evaluator (Phase 1 anchor / Phase 2 cert). | On-chain state only; indexer reports are observations. | [SRC] |
| Whether a pool may be settled | GraveVault (valid live cert + registry/receipt checks). | On-chain checks only. | [SRC] |
| What the last swap time is | The activity attestation signed by the activity oracle (after approved D4 implementation: only verified economic swaps). | Valid until the SlotHashes window closes; freshness enforced on chain. | [SRC][SDK][ADR] |
| What the wire formats are | Core SDK. | Import, never re-implement. | [SDK] |
| What the indexer reports | Dedicated indexer artifacts (bundles, snapshots, health). | Evidence with provenance and completeness labels; never authorization. | [SRC] |
| Who may change oracles/thresholds/pause | ProtocolConfig governance authority. | Governance-controlled; devnet single governance key. | [SRC][DEP] |
| Who may rotate/revoke oracle keys | Governance authority via update_protocol_config (equality semantics; no revocation list). | Operational runbook ORACLE_PIPELINE §6. | [ACC] |

#### **4. End-to-End Data Flow**

Stage 0 - record launch price: the SDK's deriveLaunchPriceV4 derives the pre-first-swap reserve ratio from full-archive history (fail-closed on incomplete history), the launch-price oracle signs the 168-byte attestation, and record_launch_price writes the init-once LaunchPrice PDA. IMPLEMENTATION STATUS (C-04): on-chain verification (GraveScanner) and SDK derivation (deriveLaunchPriceV4) are implemented; the dedicated indexer's C2 issuance workflow is NOT wired into the pipeline (no derivation call sites, no CLI issuance path, no C2 evidence-bundle type, no dedicated launch-price key-custody procedure — audit F-H3; R-33). Stage 0 is the approved target flow, not an operational capability today. Stage 1 - Phase 1: anyone submits evaluate_pool_phase_1 with a fresh activity attestation; the evaluator runs all six criteria (C5 evidence via the UNCX adapter); a full pass writes the EligibilityAnchor (first_eligible_epoch, bitmap 0x3F); any miss writes nothing. Stage 2 - waiting period: at least two Solana epochs elapse (approximately 4-6 days). Stage 3 - Phase 2: a fresh activity attestation plus the full evaluator re-run must reproduce the anchor's bitmap; on success the EligibilityCert is written with its one-hour TTL (floored at ten minutes); expired certs reissue in place through the same path; live certs are immutable. Stage 4 - settlement: a salvor builds a snapshot (supply-parity gated), submits salvage_pool with the cert; the program validates cert freshness/binding/bitmap, pins snapshot supply against live LP supply, withdraws and converts via CPIs, and distributes 40/40/20 with remainder-based conservation; PoolRegistry and SalvageReceipt make it one-shot. Stage 5 - claims: holders claim pro-rata against the sealed Merkle root at any time, including during pause; unclaimed residual remains in the unsweepable vault. [SRC][SDK][ACC]

**Table 4.1 Failure behavior at each hop (fail-closed everywhere)**

| Hop | Representative failures | Behavior |
| --- | --- | --- |
| Derivation -> attestation | Incomplete history; pruned RPC; missing tx; page limit; unresolvable issued_slot. | C2 refuses to guess; C1 issuance aborts; unknown facts stay unknown (noSwapFound). |
| Attestation -> chain | Missing precompile; bad offsets; wrong oracle key; replayed slot; aged-out slot; hash mismatch; binding mismatch; zero/future ts. | Reverts 6024-6031; no caller-supplied fallback. |
| Evaluator -> anchor/cert | Any criterion miss; epoch gap pending; bitmap drift; anchor invalidated; live cert exists. | Reverts 6001/6011/6015-6019/6034; nothing written on failure. |
| Cert -> settlement | Expired/foreign cert; snapshot supply mismatch; preflight mismatch; slippage; CPI failure; share-sum violation. | Reverts 7001-7018 class; atomic rollback, no PDA residue. |
| Settlement -> claims | Invalid proof; duplicate claim; zero balance/supply. | Reverts 7010/7011; claim path otherwise always live (pause-immune, no expiry). |
| Indexer internal | Stale snapshots; conflicting bytes; RPC lag; replayed evidence. | Fail-closed exclusion; indeterminate preserved; journal replay guard. |

#### **5. Component and Data-Flow Diagram (canonical ASCII form)**

```text
GraveYield component and data-flow map (v1.0: Solana, Raydium V4)
 
 OFF-CHAIN (read-only / evidence) ON-CHAIN (authoritative state)
 -------------------------------- ------------------------------
 mainnet-beta (discovery cluster) GraveScanner EFJpKtWx...AQJL
 +--------------------------+ +---------------------------------+
 | Dedicated indexer | C1 attestation | record_launch_price |
 | (grave-indexer) | 112 B, oracle- | LaunchPrice PDA (init-once) |
 | discovery (gPA+slice) | signed | evaluate_pool_phase_1 |
 | ingest (dedupe/conflict| -----------------> | EligibilityAnchor PDA |
 | deriveLastSwapV4 (SDK) | | (first_eligible_epoch, 0x3F) |
 | evidence + sign (C1/C2)| C2 attestation | | >= 2 epochs (~4-6 d) |
 | verify (on-chain mirror| 168 B ----------> | evaluate_pool_phase_2 |
 | journal / health | (launch price) | fresh C1 + bitmap equality |
 +--------------------------+ | EligibilityCert PDA (TTL 1h) |
 | imports (pinned submodule) +-----------------|---------------+
 v | cert fresh, 0x3F
 +--------------------------+ v
 | Core SDK (@graveyield/sdk| GraveVault 7VxUGJNg...shya
 | SINGLE SOURCE OF TRUTH) | +---------------------------------+
 | attestation builders | | salvage_pool (one transaction) |
 | precompile ix layout | | snapshot root + supply pin |
 | decoders / PDA helpers | | Raydium V4 withdraw CPI (burn)|
 | salvage/claim builders | | Jupiter swap (slippage floor) |
 +--------------------------+ | 40/40/20 distribution (remdr) |
 ^ | PoolRegistry+Receipt init-once|
 | snapshot artifact +-----------------|---------------+
 +--------------------------+ | merkle proof
 | Snapshotter (Rust) | v
 | LP holders (gated by | | claim_lp_proceeds |
 | supply parity), UNCX | | pause-immune, no expiry |
 | attribution, merkle | | residual stays forever |
 +--------------------------+ +---------------------------------+
 
 Oracle keys (operator custody, governance-registered in ProtocolConfig):
 activity_oracle 2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o (signs the activity attestation)
 launch_price_oracle 97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee (signs the launch-price attestation)
 Diagram shorthand "C1"/"C2" in attestation labels and "fresh C1" denotes the activity
 and launch-price attestations consumed by criteria C1/C2 respectively (naming per C-11);
 C2 issuance wiring into the dedicated indexer is incomplete (R-33) — the diagram shows
 the target flow.
 Governed via update_protocol_config (devnet: governance authority BMnrpx...Uwf5).
 
 Boundary: the indexer and snapshotter NEVER submit transactions or hold eligibility
 authority; the chain verifies every claim independently. (Approved ADR D4/D5/D6 add
 economic-swap classification, finalized-only history, and completeness labels -
 approved direction, not yet implemented.)
---
```
#### **6. Mermaid Form (review artifact - not a repo convention)**

The repository's living documentation uses ASCII diagrams; the repository documentation conventions do not currently include Mermaid. The Mermaid source below is provided for review tooling convenience only.

```mermaid
flowchart LR
 subgraph OFF["Off-chain (read-only / evidence)"]
 IDX["Dedicated indexer\n(discovery, ingest, derivation,\nsigning, verify, journal)"]
 SDK["Core SDK\n(wire formats - single source of truth)"]
 SNAP["Snapshotter\n(LP snapshot, supply gate, Merkle seal)"]
 K1[("activity_oracle key")]
 K2[("launch_price_oracle key")]
 end
 subgraph SCAN["GraveScanner (on-chain)"]
 LP[("LaunchPrice PDA (init-once)")]
 AN[("EligibilityAnchor PDA")]
 CE[("EligibilityCert PDA (TTL 1h)")]
 E1["evaluate_pool_phase_1"]
 E2["evaluate_pool_phase_2"]
 end
 subgraph VAULT["GraveVault (on-chain)"]
 SP["salvage_pool (atomic, one-shot)"]
 CL["claim_lp_proceeds (no expiry, pause-immune)"]
 PR[("PoolRegistry + SalvageReceipt (init-once)")]
 LV[("lp_holder_pool_vault (unsweepable)")]
 end
 IDX --> SDK
 SDK --> IDX
 K1 --> IDX
 K2 --> IDX
 IDX -- "launch-price attestation (168 B; issuance wiring incomplete, R-33)" --> LP
 IDX -- "activity attestation (112 B)" --> E1
 E1 --> AN
 AN -- ">= 2 epochs + fresh activity attestation + bitmap equal" --> E2
 E2 --> CE
 SNAP --> SP
 CE -- "fresh, bitmap 0x3F" --> SP
 SP --> PR
 SP -- "40%" --> LV
 LV --> CL
---
```
#### **7. Trust Boundaries**

Three boundaries matter. First, the read-only boundary: the dedicated indexer contains no transaction-submission call site; its only on-chain contacts are reads and simulateTransaction, and its faucet path is strict opt-in; it holds no authority over eligibility or settlement. Second, the trust boundary that remains: on-chain verification is cryptographic, but the honesty of the oracle derivation and the availability of the indexer are operational commitments (ORACLE-003 staged, open) - the protocol's principal operational dependency, documented rather than hidden. Third, the evidence boundary: an indexer artifact is evidence with provenance and completeness labels, never authorization; the chain independently re-verifies every claim it consumes, and approved directions D4/D5/D6 tighten what the evidence may assert once implemented. [SRC][ACC][ADR]


---

## 7. Requirements and implementation status matrix (Deliverable 5)

51 rows in six classes — implemented & verified / implemented but insufficiently verified /
partially implemented / approved-not-implemented / proposed operational requirement / owner
decision — each with its evidence source.


**GraveYield Requirements and Implementation Status - GY-DOC-RECON-001 (verified 2026-11-13)**

| ID | Requirement / Component | Area | Classification | Evidence source(s) | Notes |
| --- | --- | --- | --- | --- | --- |
| R-01 | Six-criterion evaluator C1-C6 (single shared function, conjunction, bitmap 0x3F) | GraveScanner | Implemented & verified | programs/grave-scanner/src/criteria.rs + inline tests; live decode of all defaults 2026-11-13; fork suites | Thresholds governance-tunable within bounded ranges only. |
| R-02 | Activity-attestation verification chain (criterion C1 input; precompile pins, oracle equality, binding, freshness, 6024-6031) | GraveScanner | Implemented & verified | attestation.rs; live sims reproduced 6024/6025/6026 (verify-path-report.live.json); indexer verifier mirror tests | Domain separation is structural, not prefixed (recorded design note). |
| R-03 | Launch-price attestation + record_launch_price (criterion C2 input; init-once LaunchPrice PDA, oracle-only acceptance) | GraveScanner | Implemented & verified | attestation.rs:101-189; live phase1-precondition case; SDK launchPriceAttestation tests | No SlotHashes freshness by design (time-invariant fact; init-once blocks replay). |
| R-04 | Two-phase lifecycle: anchor, epoch gap, bitmap equality, cert issuance/reissue (6011/6016/6034) | GraveScanner | Implemented & verified | evaluate_pool_phase1/2.rs; eligibility-anchors.md; scanner_windows fork suite; acceptance drills | MIN_EPOCH_CONFIRMATION=2 is compile-time, not config. |
| R-05 | Anchor housekeeping (invalidate_anchor authority-gated; sweep_stale_anchor permissionless) | GraveScanner | Implemented & verified | invalidate_anchor.rs; sweep_stale_anchor.rs; inline tests; eligibility-anchors.md §5 | Sweep returns rent only; confers no salvage rights. |
| R-06 | C5 lock detection via UNCX Raydium V4 adapter (marker-PDA gate + TokenLock evidence) | GraveScanner | Implemented & verified | adapters/locker.rs with mainnet vectors (125 locks / 74 pools); errors 6020-6023; LOCKER-001 retired | Scope limited to UNCX; other lockers undetected (R-18). |
| R-07 | update_protocol_config bounds + oracle registration path | GraveScanner | Implemented & verified | update_protocol_config.rs bounds tests; protocol_admin.mjs register-oracle; live oracles registered (bump 255, offsets 123/155) | Registration executed on NS-3 devnet; tx recorded in W2 acceptance report. |
| R-08 | emergency_pause / unpause with no-op guard (7022) | GraveScanner + GraveVault | Implemented & verified | emergency_pause.rs; drills (pause; intruder 6000/7000; unpause) in W2 acceptance | Pause gates evaluate_pool_* (and salvage_pool vault-side); claims unaffected. |
| R-09 | salvage_pool settlement pipeline (preflight, withdraw CPI, Jupiter route vetting + slippage floor) | GraveVault | Implemented & verified | salvage_pool.rs + cpi/mod.rs; 8 fork suites incl. jupiter_conversion, security_negative | Verified against real mainnet bytecode in fork harness; no controlled real-pool devnet salvage executed yet (tech-doc §9). |
| R-10 | 40/40/20 distribution with 2,000 bps ceiling and remainder conservation (D7) | GraveVault | Implemented & verified | vault constants.rs; split_proceeds; settlement_economics fork suite; errors 7004/7005 | Rounding remainder accrues to protocol share by construction. |
| R-11 | Double-settlement prevention (init-once PoolRegistry + SalvageReceipt) | GraveVault | Implemented & verified | salvage_pool.rs init constraints; state/pool_registry.rs; full_lifecycle fork suite | Second salvage reverts before any lamports move. |
| R-12 | claim_lp_proceeds (Merkle proof, pause-immune, no expiry, ClaimRecord init-once) | GraveVault | Implemented & verified | claim_lp_proceeds.rs; lp_claim fork suite (end-to-end snapshotter -> claim); errors 7010/7011 | Residual never drains by design; vault unsweepable (no sweep call site; 7006 reserved). |
| R-13 | sweep_dust one-shot permissionless dust recovery | GraveVault | Implemented & verified | sweep_dust.rs; errors 7020/7021; DUST-001 retired | Never touches the LP-holder SOL bucket. |
| R-14 | Snapshot supply pin at settlement (7018) | GraveVault | Implemented & verified | salvage_pool.rs:397-400; InvalidSnapshotData tests | Snapshot is off-chain; pin makes stale/manipulated snapshots unusable. |
| R-15 | Functional on-chain timelock (pending_authority consumed) | Governance | Proposed operational requirement | PRE_MAINNET_CHECKLIST GOV-001 (open); update_protocol_config.rs PRE-MAINNET-TODO(GOV) comment; 7014 reserved never raised | Current fields are write-only reserved state (spec decision D2); delay is Squads scheduling. |
| R-16 | Scanner adapters for Raydium CLMM / Orca Whirlpool / PumpSwap / Meteora | Scope expansion | Proposed operational requirement | PRE_MAINNET_CHECKLIST CPI-002..005 (open); errors 6003/6007 path | v1.1 milestone; Solana-first maintained (ADR D9). |
| R-17 | Vault CPI adapters for additional AMMs | Scope expansion | Proposed operational requirement | PRE_MAINNET_CHECKLIST CPI-006..008 (open); AmmCpiUnimplemented 7017 stubs | Reverts honestly today. |
| R-18 | Locker adapters beyond UNCX (PinkSale, Team Finance, Streamflow, ...) | Scope expansion | Proposed operational requirement | PRE_MAINNET_CHECKLIST LOCKER-002 (open); adapters/README (stale status flagged in matrix WP-11) | Owner approval required before any criterion expansion. |
| R-20 | SDK attestation builders + precompile instruction construction (C1/C2) | Core SDK | Implemented & verified | sdk/src/lastSwapAttestation.ts, launchPriceAttestation.ts; attestationVectors suite (11) | Normative-mirror headers; canonical-span guard. |
| R-21 | SDK account decoders + PDA derivation + error mirror | Core SDK | Implemented but insufficiently verified | accountDecoders.ts; pdas.ts + pdas.test.ts (12); errors.ts | Mirror verified for 6000-6034 and 7000-7021; missing vault 7022 (drift; R-29/Q-14). |
| R-22 | Economic-swap classification in deriveLastSwapV4 (only verified swaps reset inactivity; ambiguous fail-closed; SDK-owned) | Core SDK | Approved but not yet implemented | ADR D4; audit F-H1 (predicate = any AMM touch); SDK header defers semantic ray_log parsing to roadmap | Fix belongs in the SDK with byte-equal salvor-bots mirror; fixture matrix specified in Deliverable 3 §6. |
| R-23 | Finalized-only confirmation gate for historical evidence | Core SDK | Approved but not yet implemented | ADR D5; audit F-H2 (no confirmationStatus inspection; minConfirmations documented only) | Distinct from the on-chain multi-epoch requirement (C6), which is unaffected. |
| R-24 | deriveLaunchPriceV4 fail-closed archive derivation (Q64.64 pre-swap ratio) | Core SDK | Implemented but insufficiently verified | launchPriceAttestation.ts:197-259; page-limit fail-closed; harness exercises precompile span | Derivation implemented; not wired into any operational pipeline (R-33); full-archive RPC provider undefined. |
| R-25 | SDK priority-fee policy enforcement (advisory ceiling) | Core SDK | Implemented but insufficiently verified | priorityFee.ts; priorityFee tests (16+8); vault config stores ceiling programs never read (spec D3) | SDK/operator-enforced by design; on-chain field is advisory. |
| R-26 | SDK certify-and-salvage atomic bundle helper | Core SDK | Implemented but insufficiently verified | certifyAndSalvage.ts; evaluatePool tests (5); program-level fork coverage exists | SDK-level suite thinner than program-level evidence; salvage-side surface intentionally outside indexer scope. |
| R-30 | Dedicated indexer discovery + provenance + ingest ledger (dedupe/conflict/staleness) | Dedicated indexer | Implemented & verified | discovery.ts, provenance.ts, ingest.ts; 78-test battery (verified run 2026-11-13); live mainnet artifacts | Proven live: second run duplicate-unchanged 400. |
| R-31 | Deterministic ledger under MAX_POOLS_PER_SCAN cap | Dedicated indexer | Partially implemented | audit F-M3 (selection before sort); discovery.ts:294-302 | Determinism claim currently conditional; sort-before-truncate is the proposed fix. |
| R-32 | C1 issuance + secret-free evidence bundles + verifier mirror + replay journal | Dedicated indexer | Implemented & verified | issue.ts, evidence.ts, verify.ts, journal.ts; live bundle for real mainnet pool; 13-case matrix 13/13 (NS-2 era) and 6/6 verifier-level live on NS-3 | Outcomes verified/oracle-gated/rejected/indeterminate. |
| R-33 | C2 launch-price issuance path wired into the pipeline (derivation integration, CLI, bundle type, C2 key custody) | Dedicated indexer | Partially implemented | audit F-H3 (deriveLaunchPriceV4 zero call sites; no C2 CLI/bundle); signer length gates exist | Without C2 the pipeline cannot carry a pool to Phase 1 (LaunchPrice is a hard precondition). |
| R-34 | Lifecycle observation (anchors/certs/LaunchPrice reads and reporting) | Dedicated indexer | Partially implemented | audit F-M1 (SDK decoders unused; console C6 pinned pending) | Observer role from the assignment unfilled; SDK decoders exist and are tested. |
| R-35 | RPC resilience layer (timeouts, bounded backoff, failover, workload configs) | Dedicated indexer | Approved but not yet implemented | ADR D10; audit F-M2 (no timeout/retry outside verifier + harness) | Prerequisite for reliable scheduled smokes and mainnet operation. |
| R-36 | Persistent pagination/cursors + controlled backfill | Dedicated indexer | Approved but not yet implemented | ADR D6; audit §5 (no cursor/backfill module; discovery re-enumerates; activity scan bounded and stateless) | Design decision on scale policy open (Q-07). |
| R-37 | Explicit completeness status on evidence artifacts | Dedicated indexer | Partially implemented | consoleSnapshot honest criteria; noSwapFound state; audit F-L6 (provenance records scan LIMIT, not actual scan) | Never claim inactivity over incomplete scan - honored implicitly, not yet labeled explicitly. |
| R-38 | Environment-neutral configuration (cluster-neutral names, SDK-constant imports) | Dedicated indexer | Partially implemented | ADR D9; audit F-M4 (DEVNET_RPC_URL naming; hardcoded 'devnet' strings; duplicated AMM id literals) | Safe defaults retained meanwhile. |
| R-39 | Secret-free artifacts + fail-closed key custody | Dedicated indexer | Implemented & verified | evidence.ts schema pins; sign.ts fingerprint logging; leak tests; ORACLE_PIPELINE §6.1 red lines | No key material in repo; test seed is a documented public constant. |
| R-40 | Lint / coverage / dependency-audit tooling in CI | Dedicated indexer | Proposed operational requirement | audit F-L5 (no ESLint/coverage/audit step) | Proposed; pairs with docs-CI grep gate idea. |
| R-45 | Core candidate funnel (discovery -> pre-filter -> scoring -> queue) as read-only tooling | Core repo (indexer/) | Implemented but insufficiently verified | indexer/ README + src; 29 offline tests; Phase 9 complete per README | Overlaps dedicated indexer stages; fate under D3 (R-46). |
| R-46 | Phase-1 transaction submission from the core candidate scanner (ACTIVITY_ORACLE_KEY custody) | Core repo (indexer/) | Unresolved / owner decision | submit.ts:140-141 sendAndConfirmTransaction; config ACTIVITY_ORACLE_KEY; ADR D3 | Recommendation produced (Deliverable 3 §16): retire from this package; owner decision Q-05. |
| R-47 | ops indexerService submission contract (ACTIVITY_ORACLE_KEY) | Core repo (ops/) | Unresolved / owner decision | OPS.md service table + env table; ADR D3 | Recommendation: monitoring-only repositioning; owner decision Q-05. |
| R-50 | NS-3 Devnet deployment + acceptance (programs, configs, oracles, drills, ELF digests) | Deployment | Implemented & verified | W2 acceptance 56/56 (slots 521557300/521557485, epoch 1207); live readback 2026-11-13; provenance manifest | Devnet-only scope per W2 §9; not a Mainnet approval or security audit. |
| R-51 | Documentation deployment-status flip (DEVNET.md, tech-doc §9, combined §9, LEGACY_DEPLOYMENTS NS-3 row) | Documentation | Proposed operational requirement | Matrix rows TD-02/CB-02/DR-01/DR-02 vs W2 acceptance; proposed diffs prepared (proposed-doc-changes/) | Documentation-only changeset; requires owner review before applying. |
| R-52 | Oracle operational runbook (hosted derivation, custody+rotation, freshness monitoring, downtime policy) | Operations | Proposed operational requirement | PRE_MAINNET_CHECKLIST ORACLE-003 (open, critical); ORACLE_PIPELINE §6 partial runbook exists | Largest staged operational gap. |
| R-53 | Mainnet custody program + multisig transition + fresh program keys | Operations | Proposed operational requirement | PRE_MAINNET_CHECKLIST KEYS-003 (open, critical); charter-invariants #8; DR-001/DR-002 precedent | Never reuse devnet keypairs; no devnet artifact proxies mainnet custody. |
| R-54 | On-chain timelock implementation option | Governance | Proposed operational requirement | GOV-001 (open); spec decision D2 deferral | Either wire the fields or keep documentation explicit (current choice: explicit). |
| R-55 | Scheduled evidence smoke + mainnet discovery jobs (secret-gated, fail-loud) | Operations | Partially implemented | scheduled-evidence-smoke.yml (06:11 UTC daily; no-op clean without secrets) | Whether secrets are configured is unverifiable from the sandbox (Q-09/R-RSK-09). |
| R-56 | Devnet/Mainnet environment separation inside tooling | Operations | Partially implemented | deployment-state gating; two-cluster model; audit F-M4 naming debt | Functionally separated; naming/defaults not yet neutral (R-38). |
| R-60 | Revised whitepaper v4.1.0 draft (ADR D2) | Documentation | Proposed operational requirement | Deliverable 2 (this assignment); v4.0 preserved historical | Publication vehicle and approval pending (Q-01/Q-18). |
| R-61 | Documentation reconciliation changeset (stale-status diffs, README fixes, error-code headings) | Documentation | Proposed operational requirement | proposed-doc-changes/ (diffs + CHANGES.md); matrix rows TD/CB/DR/IN/RD/EC | Documentation-only; not committed. |
| R-62 | GhostPools paper revision r5 (qualified guarantee language, layered figures, NS-3 deployment record) | Documentation | Proposed operational requirement | Matrix GP-01..GP-05; Deliverable 2 §9 qualifications | Owner decision on authoring/scheduling; figures must stay qualified (Q-11). |
| R-63 | Documentation version-lineage control (changelog for doc versions; snapshot render contract) | Documentation | Proposed operational requirement | Matrix DR-03/WP-01/SPC-01 | Proposed. |
| R-64 | salvor-bots byte-equal mirror coordination for SDK changes | Cross-repo | Proposed operational requirement | ORACLE_PIPELINE §8.3 red line; DR-001 consequence 4 catalogue | Any SDK semantic change must land byte-equal in salvor-bots (Q-06). |

> Classifications: Implemented & verified = source + tests + deployed/acceptance evidence agree. Implemented but insufficiently verified = implemented, evidence narrower than the claim. Partially implemented = subset of approved behavior exists. Approved but not yet implemented = GY-ADR-001 direction with no code. Proposed operational requirement = staged docs/checklist without implementation mandate. Unresolved / owner decision = recommendation produced, decision open.
> Test existence proves only the behavior exercised; deployment acceptance (W2 56/56) is Devnet-only evidence. Per-item definitions: Deliverable 3 §17.


---

## 8. Outstanding questions and risk register (Deliverable 6)

Twenty-one outstanding questions (issue, why it matters, current evidence, possible
interpretations, recommended resolution, owner-approval flag, block flag) and a twelve-entry
risk register. Q-21 was added by corrective revision 2 (C-11 evidence-type naming).

### 8.1 Outstanding questions (21)


**GraveYield Outstanding Questions - GY-DOC-RECON-001 (items that cannot be resolved from approved decisions and available evidence)**

| ID | Issue | Why it matters | Current evidence | Possible interpretations | Recommended resolution | Owner approval required? | Blocks publication / implementation? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q-01 | Authority and lineage of the "Whitepaper v4.0.1" artifact. The assigned whitepaper file is named v4_0_1 while its internal metadata reads Version 4.0; the file was uploaded by the owner on 2026-11-13 and inspected in revision 2 (internal metadata Version 4.0 confirmed from the binary); program-source comments cite "Whitepaper v4.0.1"; the living markdown self-declares v4.0; no living v4.0.1 exists in either repo. | Determines which text is the historical record and what the revised draft must supersede; unresolvable version labels undermine the documentation lineage this assignment exists to fix. | whitepaper.md:1-8; criteria.rs:12 / errors.rs:4 / lib.rs:110 code comments; repo search (no .docx located in any ref searched — R3-02); docs/README canonical set. | (a) v4.0.1 was a real internal spec patch rendered only in the external docx, whose metadata was never bumped; (b) v4.0.1 is label drift and v4.0 is the sole canonical text. | Owner confirms the lineage; adopt Version 4.1.0 (draft absorbs the informal v4.0.1 references); publish a docx snapshot only after approval. | Yes | Blocks whitepaper publication (draft itself is complete). |
| Q-02 | Canonical criterion label set: C4 "LP supply not burned" vs "LP not burned"; C5 "LP not locked" vs "No LP lock"; whitepaper bare numerals vs C1-C6. PLUS (C-01): the frozen v3.0 DOCX Table 4 ordering (C1 No LP burn ... C6 Price decline) diverges from the canonical C1-C6 — how should historical labels be annotated where v3.0-era text is quoted? | Consistent numbering is an explicit completion standard of the assignment; misreading historical labels as current identifiers corrupts eligibility descriptions. | Matrix WP-03 (corrected); living-source comparison (aligned); owner-confirmed v3.0 Table 4 ordering (owner inspection, R3-01); mapping table in spec §3.1. | Adopt spec wording everywhere + annotate historical mapping vs keep per-document variants. | Adopt the C1-C6 labels and Table 3.1 wording of Deliverable 3 across all documents; publish the Table 3.1a historical mapping wherever v3.0-era labels are quoted. | Recommended (ratification) | Blocks sign-off of revised docs. |
| Q-03 | C3 unit convention: raw units (500,000,000) vs "0.5 SOL" phrasing, and the KEYS-002 reform of the flat LP dust threshold. CORRECTED units (C-06): for a 6-decimal quote mint the threshold is 500 display tokens = 500,000,000 raw units; the same raw count is applied to every quote mint without decimals/value normalization, so there is no universal 0.5 SOL-equivalent or USD minimum. | The 0.5 SOL framing is wrong for non-WSOL quote mints; user-facing docs must not overstate precision; whether a fixed raw-unit floor is the intended economic criterion across heterogeneous quote mints is an eligibility-design decision. | criteria.rs:135-140; evaluate_pool_phase1.rs:151 (quote reserve used directly); tech-doc §2 caveat + §10 blocker; live decode 500,000,000. | (a) document raw-unit semantics with WSOL caveat and per-mint implications (done in Deliverables 2/3); (b) reform to a percent-of-supply or USD/normalized check on chain (behavior change); (c) normalize by decimals while keeping a raw floor (behavior change). | Document the caveat now (done); owner decides the threshold semantics before Mainnet readiness. | Yes (for any on-chain reform) | Blocks mainnet docs; not devnet docs. |
| Q-04 | Workstream D lock scope: should C5 eventually cover non-UNCX lockers, pool-authority status, or governance/multisig restrictions, and how should "locked" be defined? CORRECTED FRAMING (C-07): the original whitepaper describes the absence of governance or multisig locks, and the Combined Technical Documentation discusses governance and pool-authority lock conditions (both owner-confirmed from the originals — R3-01), while the implemented detection scope is UNCX Raydium V4 locker locks ONLY. The owner decision is whether UNCX-only detection is the intended canonical criterion, or the implementation is incomplete relative to the historical governance/pool-authority lock requirement. | Undetected lockers let locked pools pass C5; a pool locked only by governance/multisig arrangements (or non-UNCX lockers) is eligible under the implemented criterion; expanding scope changes eligibility behavior - explicitly out of scope without approval. THIS IS A PUBLICATION AND MAINNET-READINESS BLOCKER UNTIL RESOLVED. | Advisory A (Appendix A of Deliverable 3); LOCKER-002 open; criteria.rs:153-158 + adapters/locker.rs (UNCX-only, verified); assignment statement (owner-supplied historical definitions). | (a) keep UNCX-only scope and document it as the canonical criterion; (b) treat UNCX-only as incomplete and add adapters per locker; (c) redefine locked to include custody/governance/pool-authority mechanisms. | Owner decides the canonical lock criterion scope before any revised documentation is signed off or Mainnet readiness is claimed; keep the current scope until then. | Yes (for any expansion or redefinition) | Blocks publication and Mainnet readiness until resolved. |
| Q-05 | Fate of the core repo's overlapping indexer functionality (indexer/ submit path holding ACTIVITY_ORACLE_KEY; ops indexerService submission contract). | ADR D3 directs narrowing/migration/retirement; oracle-key custody in a candidate scanner widens the compromise surface and blurs the evidence/authority boundary. | submit.ts:140-141; OPS.md env table; ADR D3; Deliverable 3 §16 recommendation table. | (a) retire submit + reposition ops to monitoring-only; (b) migrate the funnel to a salvor tool; (c) retain both with custody compensations. | Adopt the Deliverable 3 §16 recommendation (retire submit path; migrate tracking; narrow funnel to read-only; ops to monitoring). | Yes | Blocks implementation of the repo split; not the documentation. |
| Q-06 | Sequencing of SDK derivation fixes (ADR D4/D5), salvor-bots byte-equal mirror coordination, and the vendor/protocol re-pin (84 commits behind, zero wire drift). | D7 orders upstream correctness before re-pinning; unsynchronized mirrors reintroduce drift risk the SDK discipline exists to prevent. | audit §8.5/§12; ORACLE_PIPELINE §8.3 red line; commit 7ddf88c as the prior re-pin precedent. | Fix-first-then-repin vs re-pin-now-for-docs-freshness. | Implement D4/D5 in the SDK with fixture matrix + salvor-bots mirror, then re-pin and extend indexer tests (audit R2/R9/R10). | Yes | Blocks re-pin; not documentation. |
| Q-07 | Backfill/scale policy (ADR D6): is bounded scanning (limit 1,000, no pagination) plus full re-enumeration acceptable at ~706k pools, or is a cursor/backfill subsystem required before mainnet? | Determines evidence completeness guarantees and RPC cost at scale; incomplete history must never seed inactivity claims. | config.ts:126; audit §5 (no cursor/backfill); discovery corpus size (706,002 raw accounts in the live artifact). | (a) keep bounded scans with explicit incompleteness labels; (b) build cursors + controlled backfill now; (c) hybrid (cursors only for C2-candidate pools). | Decide before mainnet funnel operation; until then, completeness labeling (R-37) is mandatory regardless. | Yes | Blocks mainnet evidence operations. |
| Q-08 | Mainnet RPC strategy (ADR D10): production provider(s), the raw getProgramAccounts approach (~300 MB responses), chunked enumeration, and workload-specific endpoint assignments. | Discovery economics and reliability change materially between public and paid endpoints; D10 requires provider independence. | audit §16-D10; discovery.ts raw gPA; examples discovery summary (20s cycle). | Raw gPA vs hashed gPA vs chunked enumeration; single provider vs failover set. | Decide provider and method before mainnet; implement the D10 resilience layer first (R-35). | Yes | Blocks mainnet discovery operations. |
| Q-09 | Whether DEVNET_RPC_URL / MAINNET_RPC_URL secrets are configured for the scheduled evidence smoke (unverifiable from this sandbox). | The daily 06:11 UTC smoke silently no-ops without secrets - a false sense of monitoring if unconfigured. | scheduled-evidence-smoke.yml gating logic; audit §2.2 note. | Configured vs not configured in repo settings. | Owner verifies in GitHub settings; if unconfigured, enable or explicitly accept the no-op posture. | No (verification only) | No; affects monitoring confidence. |
| Q-10 | Deployment/drill date discrepancy: documents say "9 October 2026"; BASELINE_REPORT records chain timestamps 2026-10-08 17:12-17:14 UTC. | Deployment records are evidence artifacts; off-by-one dates weaken them. | BASELINE_REPORT.md:56; tech-doc §9; combined §9; GhostPools D.2. | Local-time vs UTC labeling mismatch. | Normalize to UTC dates (or label timezones) across docs and the next research revision. | No | No. |
| Q-11 | GhostPools revisions: qualify "guaranteed proportional claims" language, layer the headline figures, update the deployment record to the NS-3 lineage, mark the 700K CU estimate. | The research paper is the project's public economic case; unqualified language contradicts the legal documentation and the distribution model. | Matrix GP-01..GP-05; legal-documentation.md:599; paper §4.5/§13/§14.1. | (a) revise to r5 with qualifications; (b) keep r4 and qualify at quotation sites only (Deliverable 2 approach). | At minimum adopt (b) immediately (done in Deliverable 2 §9); schedule (a) as an owner decision. | Yes | Blocks using unqualified figures in any published document. |
| Q-12 | Roadmap form: the whitepaper's m1-m10 pointer is dangling (combined doc has no milestone table); GhostPools Table 16 uses Phase 0-15 status. | Stale or dangling roadmaps misstate project status; no dates may be promised. | whitepaper.md:104-110; combined md (no table); GhostPools r4 Table 16 (Phases 12-15 Open). | Status-based table (Deliverable 2 Table 7) vs Phase-numbered table. | Adopt the status-based roadmap (no dates); ratify as the canonical roadmap location. | Recommended | Blocks revised-whitepaper sign-off. |
| Q-13 | Single authoritative test-count source (668 total NS-1-era vs 367 Phase-12 gate vs SDK 108/102 vs dedicated indexer 78). | Conflicting counts across documents undermine the testing story. | Matrix TD-05; BASELINE_REPORT:226; Combined PDF Table 2; tech-doc §8.3; audit §11. | Per-repo baseline-pinned counts vs one aggregate. | Adopt per-repo counts pinned to commit hashes; update docs at next revision. | No | No. |
| Q-14 | SDK error-mirror sync: add vault 7022 (code change), fix error_codes.md headings, combined-doc code range. | Mirror drift between on-chain enum, docs, and SDK confuses integrators. | Matrix EC-01/EC-02/CB-03; errors.rs self-tests pin 7000-7022. | Patch SDK + docs in one hygiene changeset. | Bundle into the first owner-approved changeset (with R-31/R-38 small fixes). | Yes (code change) | No (small, but blocks mirror-clean releases). |
| Q-15 | CI posture: push-triggered devnet smoke uses the hardcoded public endpoint (not secret-gated) while the scheduled smoke is secret-gated. Intended asymmetry? | CI reliability and rate-limit exposure differ between the two workflows. | ci.yml job 2 (public endpoint); scheduled-evidence-smoke.yml gating. | Intended (PR runs need no secrets) vs oversight. | Document the asymmetry in the workflow comments or align them. | No | No. |
| Q-16 | Economic-model question (tech-doc §10): who supplies the LP the salvor burns? The withdraw CPI burns LP held by the salvor (STRENGTHENED per C-08: `salvor_lp_token_account` with `token::authority = salvor`, `salvor_lp_amount > 0`, salvage_pool.rs:243-249,410-412); a derelict pool's LP is dispersed among absent holders, and locked LP belongs to lockers. The revised whitepaper previously described settlement as "anyone may permissionlessly settle" without disclosing this prerequisite — now disclosed throughout; whether permissionless settlement is achievable IN PRACTICE depends on the salvor sourcing LP. | Determines whether permissionless settlement is achievable at all for a given pool; interacts with C5 gaps (undetected locks make settlement economically impossible even when it passes C5). Classify as an important economic and operational design issue requiring owner review before the Mainnet funnel design is finalized. | tech-doc §10 open question (verbatim); salvage_pool.rs accounts struct (:243-249) and handler (:410-412); fork harness uses a pre-funded salvor. | (a) salvor acquires LP on market pre-salvage; (b) future protocol-assisted acquisition; (c) partial-settlement redesign (behavior change). | Owner decision required before mainnet funnel design; document the current implicit answer (salvor-held LP) in the spec. | Yes | Blocks mainnet funnel design; not documentation. |
| Q-17 | Combined-document model: living markdown declares v3.0 while the published PDF is v4.0 (aligned to 27b57ac) - the md-wins contract is inverted for this document. | Precedence ambiguity risks readers trusting the older text. | combined md:8-18 vs docs/GraveScanner_GraveVault_CombinedTechnicalDocumentation_v4_0.pdf cover/§8. | (a) promote the v4.0 PDF content into the living md; (b) mark the PDF as current edition and the md as pending. | Adopt (a) at the next docs pass; fix docs/README canonical-set entries (SPC-01). | No (documentation decision) | No. |
| Q-18 | Publication vehicle for the revised whitepaper: repo md + docx render cadence; the v4.0 docx snapshot whitepaper.md references does not exist in published/. | D2 requires preserving v4.0 as historical and preparing a revised draft without publishing; the render contract is currently broken (no whitepaper artifact). | whitepaper.md:3; docs/published/ inventory; docs/README render contract. | Publish 4.1.0 as md + docx together; or md-only with docx at the next quarterly render. | Owner chooses vehicle and timing; do not overwrite v4.0 artifacts (archive them as historical). | Yes | Blocks publication (draft complete). |
| Q-19 | Cross-registering GY-ADR-001 in the repositories (DECISIONS.md / docs/README) so repo readers can find the binding architectural direction. | ADR D8/D1-D10 are binding but invisible inside the repos today. | DECISIONS.md (DR-001/DR-002 only); assignment §2.C. | Full ADR text vs pointer entry. | Add a pointer entry (or full text) in DECISIONS.md and docs/README. | Yes | No. |
| Q-20 | Full-archive RPC provider and cost for C2 derivation (and its operational ownership: dedicated indexer vs salvor tooling). | C2 requires archive-grade history; ownership affects custody and D3 boundaries. | spec decision D9; launchPriceAttestation fail-closed requirement; H-3. | Dedicated indexer owns C2 issuance (with LAUNCH_PRICE_KEY_FILE custody) vs protocol-side ops service. | Assign to the dedicated indexer per D3; specify the archive provider in ORACLE-003. | Yes (ownership) | Blocks C2 pipeline completion (R-33). |


| Q-21 | Evidence-type naming: the repo's PROTOCOL_SPEC.md §5 labels the two evidence rows "C1"/"C2", colliding with the criteria numbering C1-C6 (added in revision 2, C-11). | Reusing C1/C2 for both criteria and evidence types invites exactly the confusion this assignment fixes; the revised drafts now use "activity attestation" (SDK: `LastSwapAttestation`) and "launch-price attestation" (SDK: `LaunchPriceAttestation`). | sdk/src/lastSwapAttestation.ts:64; sdk/src/launchPriceAttestation.ts:58; PROTOCOL_SPEC.md:377-378. | (a) rename the §5 evidence rows in PROTOCOL_SPEC.md at the next spec pass; (b) keep C1/C2 evidence labels in the spec and rely on the drafts' terminology section. | Adopt (a) as a documentation-only change at the next spec revision; the revised drafts are already consistent. | No (documentation decision) | No. |

### 8.2 Risk register (12)


**GraveYield Risk Register - GY-DOC-RECON-001 (risks and uncertainties; deliberately not filed as code defects)**

| ID | Risk | Category | Likelihood | Impact | Current mitigation | Residual exposure | Owner action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RSK-01 | Dishonest or compromised oracle authority attests false activity or launch-price facts in both phases. | Integrity / centralization | Medium | High | Dedicated key separation (C1 vs C2); governance-registered rotatable keys; rotation/revocation/containment runbook; fingerprint-only logging; ORACLE-003 staged. | A colluding oracle defeats the two-phase premise; on-chain checks cannot re-derive history. | Complete ORACLE-003 runbook (hosting, custody ceremony, rotation, monitoring) before mainnet. |
| RSK-02 | Mis-recorded launch price is permanent (init-once LaunchPrice PDA). | Integrity | Low | High | Fail-closed derivation (refuses incomplete history); isolated launch-price key; mint-pair re-checks (6033). | No on-chain remedy once recorded; evaluation of the pool is poisoned unless criteria fail later. | Double-verify derivation + key ceremony at registration; document the permanence explicitly (done in Deliverable 2 §5.1). |
| RSK-03 | Evidence-content gaps H-1/H-2: non-swap AMM touches count as activity; unconfirmed signatures can seed evidence. | Evidence quality | High (documented) | Medium | None yet in code; SDK header documents the intended gate; approved direction D4/D5 names the fix. | Funnel false-negatives; cheap griefing can keep pools out of scope; reorg could invalidate attested facts. | Schedule the SDK fix with fixture matrix + salvor-bots mirror (Q-06); interim derivationKind labeling. |
| RSK-04 | Devnet single-key concentration precedent (NS-1/NS-2 lost keys; NS-3 split keys but still devnet-only custody). | Operational | Low (devnet) | Low | DR-001/DR-002 records; custody policy (keys outside repos, never reused); honest authority-arrangement docs. | Devnet-only blast radius; mainnet transition not yet exercised. | Execute KEYS-003 custody program before mainnet; rehearse rotation. |
| RSK-05 | Reserved/write-only timelock fields misread as enforced controls by external readers. | Communication | Medium | Medium | charter-invariants §4 honest split; PROTOCOL_SPEC D2; ORACLE_CUSTODY §2B 'NOT implemented' caveat; qualified language in revised drafts. | Over-trust in governance guarantees until GOV-001 lands. | Keep the qualified language in every future revision (proposed diffs preserve it). |
| RSK-06 | C5 coverage gap: pools locked in undetected lockers pass C5, then settlement fails economically (locked LP cannot be burned by the salvor). Governance/multisig or pool-authority restrictions are also undetected, and the historical whitepaper/combined-doc lock definitions were broader than the UNCX-only implementation (C-07). | Completeness | Medium | Medium | LOCKER-002 tracked; scope qualified in Deliverables 2/3; UNCX adapter fail-closed evidence rules. | Salvage attempts on such pools fail at the withdraw CPI or are economically impossible; funnel noise; eligibility can be granted to pools whose LP is effectively immovable. | Owner decides the canonical lock-criterion scope (Q-04) — publication and Mainnet-readiness blocker until resolved; cross-link with Q-16 (LP supply question). |
| RSK-07 | Conflicting test counts and stale statuses across documents mislead reviewers. | Communication | Medium | Low | Reconciliation matrix (TD-05 etc.); proposed documentation diffs; this assignment's canonical drafts. | Drift resumes without a doc-control process. | Adopt the doc-lineage control (R-63) and single test-count source (Q-13). |
| RSK-08 | Submodule pin staleness (84 commits behind; acceptance report and layout tests only on main). | Maintenance | Medium | Low | Zero wire-format drift verified by tree diff; D7 orders re-pin after upstream fixes. | Docs inside the pin stay stale (Anchor.toml 'deployment pending'). | Re-pin at the owner-approved moment (Q-06). |
| RSK-09 | Public-RPC fragility: no timeout/retry/failover outside the verifier; scheduled smoke depends on secrets. | Operational | High | Medium | Verifier's bounded step-backs; harness memoizer; scheduled smoke no-op-clean design; health registry. | Hung or 429ing endpoints stall cycles or fail jobs; monitoring false confidence if secrets absent (Q-09). | Implement the D10 resilience layer (R-35) before mainnet; verify smoke secrets now. |
| RSK-10 | maxPools cap makes ledger selection provider-order dependent (determinism claim conditional). | Correctness | Medium | Low | Documented caveat proposed (matrix IN-08); audit M-3 recommendation (sort before truncate). | Two providers can produce different ledgers under the cap. | Owner-approved small fix (sort before truncation) + test (Q-14 bundle). |
| RSK-11 | Key custody outside repositories with a loss precedent (NS-2 authority key permanently lost). | Operational | Medium | High | Custody policy docs; keys never committed; DR-002 forensics; owner-held generation for NS-3. | Repeatable operational risk at every deployment generation. | Formal custody procedure within KEYS-003 (generation, storage, export verification, recovery plan). |
| RSK-12 | Research headline figures quoted without layers or qualifications in downstream materials. | Communication | Medium | Medium | Qualifications embedded in Deliverable 2 §9 and Deliverable 3; paper's own limitations §4.5/§14.1; citation-verification table. | Overstated recoverable-value claims contradicting the legal boundary. | GhostPools r5 revision (Q-11); keep quotation rules in the doc-control process. |


---

## 9. Proposed documentation-only changes

Ten proposed documentation-only diffs plus the complete proposed whitepaper file, all
reviewable and none applied. Originals verified at `graveyield-protocol` @ `c7d203272b994c055295c925ccd69e42c121f581`
and `grave-indexer` @ `17998bab3a1c6854e42b67bf3bd1305433e3c3af`; the unified diffs below were
generated at consolidation time against those exact commits (Appendix B, CF-01/CF-02). Every
change is documentation-only: no source code, configuration, dependency, lock file, submodule
pin, deployment, or governance surface is touched. Changes that would require code are
deliberately NOT proposed — they are flagged in Section 7 and Section 8 for owner-approved
implementation work.

### 9.1 Change index

| # | Target file | Change | Matrix rows |
|---|---|---|---|
| 1 | `README.md` (graveyield-protocol) | "low TVL" → "minimum residual TVL at or above the floor" (D1 inversion fix); audit/bounty line re-dated to Phase 13 (devnet has shipped) | RD-01, RD-02 |
| 2 | `docs/technical-documentation.md` (graveyield-protocol) | §9 NS-3 status: "deployment PENDING" → deployed and accepted (W2 56/56, slots, epoch, oracle registration, live readback date), keeping the Devnet-only scope statement | TD-02 |
| 3 | `docs/DEVNET.md` (graveyield-protocol) | Supersession notice: NS-3 preparation record → deployment record pointing to the W2 acceptance report and its signature table; runbook body preserved unchanged | DR-01 |
| 4 | `docs/LEGACY_DEPLOYMENTS.md` (graveyield-protocol) | NS-3 lineage row: "NOT deployed or initialized yet" → Active (deployed and accepted, W2 56/56) | DR-02 |
| 5 | `docs/error_codes.md` (graveyield-protocol) | Section headings corrected to the ranges of their own tables (6000–6034; 7000–7022) | EC-01 |
| 6 | `docs/README.md` (graveyield-protocol) | Canonical-set combined-doc row corrected: living md v3.0 (pending re-alignment) vs published PDF v4.0 (current edition) | CB-01, SPC-01 |
| 7 | `adapters/README.md` (graveyield-protocol) | UNCX adapter row: "Future (m10)" → Implemented (LOCKER-001 retired), pointing at the live code | WP-11 |
| 8 | `README.md` (grave-indexer) | Offline test count 49 → 78 (14 suites), both occurrences | IN-01 |
| 9 | `docs/ORACLE_PIPELINE.md` (grave-indexer) | §2.5 heading + closing paragraph: deployed/accepted + oracles registered; §6.2 step 2: rotation unblocked on NS-3 (cross-ref corrected); §8 item 2: item 9.5 RESOLVED | IN-02, IN-03, IN-04 |
| 10 | `docs/ORACLE_CUSTODY.md` (grave-indexer) | Opening status: oracles registered (runbook retained for future rotations; 6026 fail-closed semantics restated); GraveScanner row: deployed and accepted | IN-05 |
| 11 | `docs/whitepaper_v4.1.0_draft.md` (graveyield-protocol — **new file**) | Complete revised whitepaper source (Section 9.3). Proposed as a NEW file for review; it does not overwrite `docs/whitepaper.md` (v4.0 stays historical per GY-ADR-001 D2) | WP-01..WP-11, TD-03, GP-01..GP-04 |

### 9.2 Diffs (changes 1–10)

Link validation (revision 2, C-12): every relative link in the added lines of changes 1–10
was programmatically resolved against the actual repository trees at the PR head — 6 relative
links total, all resolving from their target files' locations, 0 problems. The proposed
DEVNET.md change links to a target of `w2-ns3-acceptance/W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md`
— already the correct directory-relative form for a file authored inside `docs/`; the
`docs/w2-ns3-acceptance/` prefix appears only in the link's display text, not in its href.
The proposed new whitepaper file (change 11, Section 9.3) contains no relative links. No link
corrections were required.


**Change 1 — `README.md`**

```diff
--- a/README.md
+++ b/README.md
@@ -8,7 +8,7 @@
 [![Anchor 0.32](https://img.shields.io/badge/anchor-0.32.x-512DA8.svg)](https://www.anchor-lang.com/)
 
 GraveYield is the **settlement layer for derelict liquidity** on Solana. When AMM pools cross all
-six derelict-pool criteria — long inactivity, ≥99% price collapse, low TVL, no LP burn or lock,
+six derelict-pool criteria — long inactivity, ≥99% price collapse, minimum residual TVL at or above the floor, no LP burn or lock,
+and multi-epoch confirmation — anyone (the **salvor**) holding the pool's LP tokens can settle
+the position permissionlessly (no protocol permission gate exists, but the withdraw burns LP
+from a salvor-controlled account — see the LP-token prerequisite in the revised whitepaper):
 remove the LP, swap the recovered tokens, and distribute the proceeds 40/40/20 to original LP
 holders, the salvor, and the protocol.
@@ -122,8 +122,9 @@ requires one approving review.
 
 ## Security
 
-See [`SECURITY.md`](SECURITY.md) for responsible disclosure. Phase 2 audit + Immunefi bug bounty
-will activate at devnet release.
+See [`SECURITY.md`](SECURITY.md) for responsible disclosure. The independent security audit (Phase 13) and the Immunefi bug bounty are the next security
+milestones; devnet itself has shipped across three deployment generations (see
+`docs/LEGACY_DEPLOYMENTS.md` and `docs/w2-ns3-acceptance/`).
 
 ## License
```

**Change 2 — `docs/technical-documentation.md`**

```diff
--- a/docs/technical-documentation.md
+++ b/docs/technical-documentation.md
@@ -438,20 +438,30 @@ As recorded in [`DEVNET.md`](DEVNET.md), the NS-1 deployment's
 emergency-control drill was executed on 9 October 2026 (authority pause,
 readback, rejection of an intruder pause attempt, authority unpause, and
 state readback on both programs); NS-2 repeated the drill on 2026-10-25.
-For NS-3 the drill is part of the owner's post-deployment acceptance —
-it has NOT been executed yet.
+For NS-3 the drill was executed as part of the owner's post-deployment
+acceptance — the W2 NS-3 acceptance passed 56/56 (deployment acceptance
+29/29 + ELF digest verification 27/27); see the record in
+[`docs/w2-ns3-acceptance/`](w2-ns3-acceptance/W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md).
 
-| Program | NS-3 devnet program ID (assigned; deployment pending) |
+| Program | NS-3 devnet program ID (deployed and accepted — W2 NS-3 acceptance) |
 |---------|-------------------|
 | GraveScanner | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` |
 | GraveVault | `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya` |
 
-> **NS-3 redeployment (assigned 2026-11-04, deployment PENDING).** Per
+> **NS-3 redeployment (assigned 2026-11-04 — deployed and accepted).** Per
 > `docs/DECISIONS.md` (DR-002) the NS-3 identities are owner-generated and
-> owner-held; the table above names the assigned program IDs, but NS-3 is
-> NOT deployed or initialized yet — see the NS-3 preparation record at the
-> top of [`DEVNET.md`](DEVNET.md). Until the owner executes the deployment,
-> no address above is live.
+> owner-held; the table above names the program IDs now live on Devnet.
+> Both programs are deployed, initialized, and passed the W2 NS-3
+> post-deployment acceptance (56/56 checks; deployment finalized at slots
+> 521557300 / 521557485, epoch 1207; dedicated activity and launch-price
+> oracle authorities registered; operation transaction signatures recorded
+> in the acceptance report §5). Execution record:
+> [`docs/w2-ns3-acceptance/`](w2-ns3-acceptance/W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md)
+> — this supersedes the NS-3 preparation note at the top of
+> [`DEVNET.md`](DEVNET.md). A live ProtocolConfig readback on 2026-11-13
+> re-confirmed both programs with thresholds at specification defaults.
+> Acceptance scope is Devnet-only: it is not a Mainnet approval and not a
+> security-audit certification.
 >
 > **Historical deployments (preserved, untouched):** the NS-2 refresh
 > (`CuQZes…Ao54` / `Bd5smh…s7rg`, deployed 2026-10-25, authority key lost
```

**Change 3 — `docs/DEVNET.md`**

```diff
--- a/docs/DEVNET.md
+++ b/docs/DEVNET.md
@@ -1,11 +1,19 @@
 # Devnet Runbook — GraveYield Protocol
 
-> **NS-3 PREPARATION RECORD (assigned, NOT yet deployed — 2026-11-04).**
-> The NS-3 identities below are owner-generated, owner-held public keys
-> (DR-002); the repository synchronization is complete and the deployment
-> itself is **PENDING** — nothing on devnet answers at these addresses
-> until the owner executes the deployment. Do not treat any
-> NS-3 address as live until this file records the deployment signatures.
+> **NS-3 DEPLOYMENT RECORD (deployed and accepted — supersedes the
+> 2026-11-04 preparation notice).** The NS-3 identities below are
+> owner-generated, owner-held public keys (DR-002). Both programs are
+> deployed and initialized on Devnet and passed the W2 NS-3
+> post-deployment acceptance (56/56 checks: deployment acceptance 29/29 +
+> ELF digest verification 27/27; deployment finalized at slots
+> 521557300 / 521557485, epoch 1207; dedicated oracle authorities
+> registered). The acceptance record, including its deployment
+> transaction signature table (§5), is
+> [`docs/w2-ns3-acceptance/W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md`](w2-ns3-acceptance/W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md);
+> a live ProtocolConfig readback on 2026-11-13 re-confirmed both programs
+> with thresholds at specification defaults. Acceptance scope is
+> Devnet-only — it is not a Mainnet approval and not a security-audit
+> certification.
 >
 > | NS-3 role | Public key |
 > |---|---|
```

**Change 4 — `docs/LEGACY_DEPLOYMENTS.md`**

```diff
--- a/docs/LEGACY_DEPLOYMENTS.md
+++ b/docs/LEGACY_DEPLOYMENTS.md
@@ -17,7 +17,7 @@
 |---|---|---|---|---|---|
 | NS-1 | 2026-10-09 | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` | `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` | single key (`GCCuhCXd…68yk`) | Legacy — retained as a historical deployment record (DR-001 2026-10-25: authority key dead); current on-chain status not established in this document |
 | **NS-2 (DR-001 refresh)** | **2026-10-25** | **`CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54`** | **`Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg`** | **`AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa`** | **Legacy — confirmed deployed and executable (§3); authority key permanently lost (DR-002); authority not revoked on-chain** |
-| NS-3 | — (deployment pending) | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` (assigned) | `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya` (assigned) | owner deployer key `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` (initial upgrade authority, owner-held) | Preparation — identities assigned (DR-002); repository sync complete; NOT deployed or initialized yet. Becomes the active deployment once recorded in `docs/DEVNET.md` |
+| NS-3 | deployed 2026-11 (see W2 acceptance) | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` (assigned) | `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya` (assigned) | owner deployer key `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` (initial upgrade authority, owner-held) | Active — deployed and accepted (W2 NS-3 post-deployment acceptance 56/56; slots 521557300/521557485, epoch 1207; dedicated oracles registered). Execution record: `docs/w2-ns3-acceptance/`. Acceptance scope Devnet-only |
 
 ## 2. NS-2 deployment record (legacy)
```

**Change 5 — `docs/error_codes.md`**

```diff
--- a/docs/error_codes.md
+++ b/docs/error_codes.md
@@ -23,7 +23,7 @@ Anchor's `#[error_code]` macro automatically offsets each enum variant's
 Rust discriminant by 6000. The **Code** column below is the on-chain
 emitted value (= Rust discriminant + 6000). Do not confuse the two.
 
-## GraveScanner — 6000-6019
+## GraveScanner — 6000-6034
 
 Source: [`../programs/grave-scanner/src/errors.rs`](../programs/grave-scanner/src/errors.rs).
 Discriminants 12-14 (codes 6012-6014) are intentionally reserved for
@@ -64,7 +64,7 @@ future v4.x additions to the pre-anchor error space.
 | 6033 | `LaunchPriceMintMismatch` | The recorded launch-price baseline belongs to a different token pair than the live pool under evaluation — the recorded `(base_mint, quote_mint)` must equal the pool's parsed mints before C2 can consume the price. |
 | 6034 | `CertStillValid` | Phase 2 was re-run while the pool's `EligibilityCert` is still live (before `expires_at`). A live cert cannot be overwritten — wait for the TTL to elapse, then re-run Phase 2 to reissue in place (spec D10). This gate makes two live certs for one pool structurally impossible. |
 
-## GraveVault — 7000-7019
+## GraveVault — 7000-7022
 
 Source: [`../programs/grave-vault/src/errors.rs`](../programs/grave-vault/src/errors.rs).
 Codes 7015-7019 added by m5 (salvage_pool execution path). Future m6/m7
```

**Change 6 — `docs/README.md`**

```diff
--- a/docs/README.md
+++ b/docs/README.md
@@ -21,7 +21,7 @@ canon outside this list is either superseded or unrelated to the project.
 |----------|---------------|--------------------|
 | Whitepaper v4.0 | [`whitepaper.md`](whitepaper.md) | `published/GraveYield_Whitepaper_v4_0.docx` |
 | Technical Documentation v4.0 | [`technical-documentation.md`](technical-documentation.md) | [`published/GraveYield_TechnicalDocumentation_v4_0.pdf`](published/GraveYield_TechnicalDocumentation_v4_0.pdf) |
-| GraveScanner × GraveVault Combined Tech Doc v3.0 | [`grave-scanner-grave-vault-combined.md`](grave-scanner-grave-vault-combined.md) | `published/GraveScanner_GraveVault_CombinedTechnicalDocumentation_v3_0.docx` |
+| GraveScanner × GraveVault Combined Tech Doc | [`grave-scanner-grave-vault-combined.md`](grave-scanner-grave-vault-combined.md) (living md, v3.0 — pending re-alignment) | `published/GraveScanner_GraveVault_CombinedTechnicalDocumentation_v4_0.pdf` (v4.0, current published edition) |
 | Legal Documentation v4.0 | [`legal-documentation.md`](legal-documentation.md) | `published/GraveYield_LegalDocumentation_v4_0.docx` |
 | Liquidity Salvage Visual Deck | — | `published/GraveYield_Liquidity_Salvage.pdf` |
 | GhostPools Research WP-2026-001r4 | [`ghostpools-research.md`](ghostpools-research.md) | [`published/GhostPools_Research_Paper_WP-2026-001r4.pdf`](published/GhostPools_Research_Paper_WP-2026-001r4.pdf) |
```

**Change 7 — `adapters/README.md`**

```diff
--- a/adapters/README.md
+++ b/adapters/README.md
@@ -6,7 +6,7 @@ locked** and that future tooling uses for read-side queries.
 
 | Adapter | Locker | Status |
 |---------|--------|--------|
-| `uncx/`        | UNCX Network        | Future (m10) |
+| `uncx/`        | UNCX Network        | Implemented (LOCKER-001 retired) — live code: `programs/grave-scanner/src/adapters/locker.rs`; verified against mainnet lock state |
 | `pinksale/`    | PinkSale            | Future (m10) |
 | `teamfinance/` | Team Finance        | Future (m10) |
```

**Change 8 — `README.md (grave-indexer)`**

```diff
--- a/README.md
+++ b/README.md
@@ -33,7 +33,7 @@ src/
   evidencePath.ts    the live verification matrix vs the deployed scanner
   health.ts          per-stage health registry (ok/degraded/failing)
   cli.ts             discover | collect | verify-path | health
-test/                49 offline tests + DEVNET_RPC_URL-gated live smoke
+test/                78 offline tests (14 suites) + DEVNET_RPC_URL-gated live smoke
 examples/            live artifacts (secret-free by construction)
 ```
 
@@ -41,7 +41,7 @@ examples/            live artifacts (secret-free by construction)
 
 ```bash
 pnpm install                 # workspace includes vendor/protocol/sdk
-pnpm test                    # build SDK + offline battery (49 tests)
+pnpm test                    # build SDK + offline battery (78 tests)
 pnpm run cli discover        # one Raydium V4 discovery cycle (mainnet)
 pnpm run cli collect --use-ephemeral-oracle   # issue + verify evidence
 pnpm run cli verify-path     # full devnet evidence-path matrix
```

**Change 9 — `docs/ORACLE_PIPELINE.md (grave-indexer)`**

```diff
--- a/docs/ORACLE_PIPELINE.md
+++ b/docs/ORACLE_PIPELINE.md
@@ -112,7 +112,7 @@ unverified. **Consequence:** a valid attestation from any other key reverts 6026
 — the pipeline's `oracle-gated` outcome. Registering a dedicated oracle key
 (`update_protocol_config`, authority-signed) is an owner-gated action; see §6.4.
 
-### 2.5 NS-3 oracle identity arrangement (assigned 2026-11-04, deployment PENDING)
+### 2.5 NS-3 oracle identity arrangement (assigned 2026-11-04; deployed and accepted — W2 NS-3 56/56; dedicated oracles registered)
 
 The NS-3 identities (owner-generated, owner-held keypairs; DR-002) separate
 every privileged role — the single-key concentration that ended NS-1 and NS-2
@@ -139,9 +139,11 @@ scripts/devnet/protocol_admin.mjs`):
    (`--fee-payer`), readback-asserted.
 3. Only then does the evidence path attest against NS-3 end-to-end.
 
-Until step 1 exists on chain, nothing on devnet answers at the NS-3
-addresses; the read-only smoke suites report the pending state explicitly.
-§2.4 above remains the historical NS-2 record, preserved verbatim.
+The NS-3 deployment is executed and accepted (W2 NS-3 post-deployment
+acceptance 56/56, slots 521557300/521557485, epoch 1207); both dedicated
+oracle keys are registered on chain — registration transaction recorded in
+the acceptance report; live readback re-verified 2026-11-13. §2.4 above
+remains the historical NS-2 record, preserved verbatim.
 
 ## 3. Architecture
 
@@ -284,8 +286,10 @@ constant, 32 × 0x2a).
 1. Operator generates a NEW dedicated oracle keypair
    (`solana-keygen new --no-bip39-passphrase -o oracle-<n>.json`, 0600).
 2. GraveScanner authority signs `update_protocol_config` setting
-   `activity_oracle` to the new public key. (Today this is BLOCKED on 9.5 —
-   the authority keypair is the erased deployer key; see 6.4.)
+   `activity_oracle` to the new public key. (Unblocked on NS-3: the dedicated
+   GOVERNANCE authority `BMnrpx…Uwf5` signs; the initial registration already
+   executed — see the W2 acceptance report. Note: the deployer-key erasure
+   discussion lives in §2.4, not 6.4.)
 3. Pipeline cutover: set `ORACLE_KEY_FILE` to the new key file; restart the
    service; `verify-path` with `ORACLE_IS_REGISTERED=true` must show the
    canonical case ACCEPTED (full positive path) before real submissions.
@@ -359,11 +363,12 @@ constant, 32 × 0x2a).
 1. **Program-level cases need a funded payer** (faucet rate-limited).
    Resolution path: `PAYER_KEY_FILE` (owner-funded, ≥0.01 SOL devnet) —
    §5 note + §6.4 custody rules.
-2. **Positive-path acceptance on devnet is owner-gated (9.5):** until a
-   dedicated oracle key is registered (or the deployment is refreshed under
-   new keys, DR-001 style), every valid bundle is `oracle-gated` at 6026.
-   The pipeline is ready: `ORACLE_IS_REGISTERED=true` + matching
-   `ORACLE_KEY_FILE` flips case 1 (and case 12) to full acceptance.
+2. **Positive-path acceptance on devnet (item 9.5): RESOLVED.** The
+   dedicated activity and launch-price oracle keys are registered on the NS-3
+   deployment (W2 acceptance; registration tx recorded; live readback
+   2026-11-13), so canonical bundles signed by the configured keys verify
+   positively. Keep `ORACLE_IS_REGISTERED=true` + matching `ORACLE_KEY_FILE`
+   as the operational prerequisite for future rotations and mainnet.
 3. **SDK derivation robustness (protocol-side follow-up, not Phase 2 scope):**
    live runs show `deriveLastSwapV4` skipping candidates whose transactions
    carry unresolved address-table lookups ("Failed to get account keys…") and
```

**Change 10 — `docs/ORACLE_CUSTODY.md (grave-indexer)`**

```diff
--- a/docs/ORACLE_CUSTODY.md
+++ b/docs/ORACLE_CUSTODY.md
@@ -1,7 +1,10 @@
 # Oracle-Custody Registration (Phase 2 item 9.5) — NS-3 edition
 
-Register the indexer's oracle pubkeys with the deployed devnet GraveScanner so
-canonical attestations verify. Until then every attestation fails closed with
+Status: the indexer's oracle pubkeys ARE registered with the deployed NS-3
+devnet GraveScanner (W2 NS-3 acceptance; registration transaction recorded
+there; live readback re-verified 2026-11-13). This document remains the
+procedure for future registrations and rotations. Any attestation signed by a
+key other than the configured oracles still fails closed with
 `6026 AttestationOracleMismatch` (check order in `attestation.rs`, verified: offset
 validity 6025 → oracle equality 6026 → message-span pin 6025 — the same
 `InvalidAttestationOffsets` code guards both stages by design).
 
@@ -30,7 +33,7 @@ canonical attestations verify. Until then every attestation fails closed with
 
 | Role | Public key | Role in `register-oracle` |
 | --- | --- | --- |
-| GraveScanner program | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` | target of `update_protocol_config` (NS-3, DR-002 — **deployment pending**; this runbook applies once the owner executes the deployment recorded in `graveyield-protocol/docs/DEVNET.md`. The NS-2 deployment `CuQZes…Ao54` is a preserved legacy record — never re-point at it.) |
+| GraveScanner program | `EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` | target of `update_protocol_config` (NS-3, DR-002 — **deployed and accepted**; see `graveyield-protocol/docs/w2-ns3-acceptance/W2_NS3_POST_DEPLOYMENT_ACCEPTANCE.md`. The NS-2 deployment `CuQZes…Ao54` is a preserved legacy record — never re-point at it.) |
 | ProtocolConfig PDA | `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe` (`["protocol_config"]`, bump 255) | account updated by the instruction |
 | Governance authority | `BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5` | initial and permanent ProtocolConfig authority (`has_one = authority`); the ONLY instruction-level signer |
 | Deployer | `cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831` | transaction FEE PAYER only; holds the program upgrade authority but is NOT the config authority |
```


### 9.3 Proposed new file: `docs/whitepaper_v4.1.0_draft.md` (complete content)

The following is the complete proposed markdown file, exactly as it would be committed after
owner approval. It is the repo-facing rendering of the same revised whitepaper draft presented
in Section 4; see Appendix B (CF-03) before applying.

```markdown

# GraveYield Whitepaper v4.1.0 — Draft for Owner Review

> **Status:** reviewable draft under assignment GY-DOC-RECON-001. NOT published.
> **Supersedes:** nothing until owner approval. Whitepaper v4.0 (canon-locked May 2026)
> is preserved as a historical document and is not edited by this draft.
> **Reconciliation basis:** graveyield-protocol @ c7d2032, grave-indexer @ 17998ba,
> SDK pin d526699, W2 NS-3 Devnet acceptance (56/56), live ProtocolConfig readback 2026-11-13.
> **Version note:** v4.1.0 absorbs the informal "v4.0.1 spec patch" references in program
> source comments (no living v4.0.1 document exists). The externally circulated whitepaper
> file named v4_0_1 carries internal metadata Version 4.0; its lineage is an owner question (Q-01).

## 1. Premise

GraveYield is the settlement layer for **derelict liquidity** on Solana. It is settlement
infrastructure; maritime salvage is used in this draft only as an analytical analogy and a
potential legal framing — not as settled legal treatment of GraveYield. When an AMM liquidity
pool crosses all six derelict-pool criteria — long inactivity, ≥99% price collapse from the
recorded launch price, minimum residual TVL at or above the floor, LP supply not fully burned,
LP not locked within the protocol's detection scope, and multi-epoch confirmation — anyone may
submit settlement permissionlessly, with one disclosed economic prerequisite: the settlement
withdraw burns LP tokens from an account the salvor controls, so the salvor must hold or
acquire the pool's LP tokens first (no protocol acquisition path exists). Settlement then
removes the LP the salvor burns, swaps the recovered tokens, and distributes the proceeds
40 / 40 / 20 to the original LP holders, the salvor, and the protocol.

The actor performing the salvage is a **salvor**. Maritime-salvage concepts (such as the
salvor-as-finder framing of the 1989 International Convention on Salvage) are used only as an
analogy and a potential legal framing; the legal documentation governs, and no legal conclusion
is drawn here. The discretion boundary is specific: the salvor does not determine eligibility
outcomes (evaluated on chain from objective conditions) and does not determine the distribution
formula (executed on chain), but retains ordinary discretion over which qualifying pool to
pursue and whether to undertake the operation. Since v4.0, the evidence
architecture has been implemented and accepted on Devnet: two dedicated oracle authorities
sign the two evidence types the criteria consume (Section 5), and the two-phase lifecycle is
enforced by deployed bytecode.

## 2. What GraveYield is not

- Not a yield-farming protocol, liquidity-management tool, or rebalancing service.
- Not a token: no GRAVE, GY, or any token, NFT, points programme, airdrop, or staking at any layer.
- Not discretionary: the six criteria are objective on-chain conditions evaluated by a fixed conjunction.
- Not a counterparty guarantee: original LP holders retain a defined, pro-rata claim on
  post-salvage proceeds via `claim_lp_proceeds` (live even during emergency pause). What the
  claim is worth depends on what the pool contains and what settlement realizes (Section 8).
- Not a Mainnet product yet: deployed and accepted on Devnet only; the acceptance report is
  explicitly not a Mainnet approval and not a security-audit certification.

## 3. Eligibility — the six derelict-pool criteria

Canonical numbering C1–C6, used across the specification, technical documentation, and program
source. The evaluator is a fixed sequential conjunction; the first miss aborts; a full pass is
bitmap `0x3F`. Thresholds are governance-tunable only within bounded ranges. Historical note
(C-01): the frozen Combined Technical Documentation v3.0 (Table 4) used a different historical
numbering (its C1 "No LP burn" … C6 "Price decline"); those are historical labels only and must
not be read as current identifiers.

| ID | Criterion | Default threshold | Evidence source |
|----|-----------|-------------------|-----------------|
| C1 | Trading inactivity | ≥ 90 days since last swap (7,776,000 s; equality passes) | Indexer-signed 112-byte Ed25519 attestation verified in-transaction against `ProtocolConfig.activity_oracle`; issued slot must resolve in SlotHashes (~512 slots) |
| C2 | Price collapse from launch | ≥ 99% (9,900 bps) from the oracle-attested launch price | Oracle-signed 168-byte launch-price attestation recorded init-once in the `LaunchPrice` PDA; current price derived on-chain from vault balances |
| C3 | Minimum residual TVL | ≥ 500,000,000 raw units of the quote-side vault (equals 0.5 SOL when the quote mint is WSOL) | Quote-side vault balance read on-chain via the pool's own vault pointer |
| C4 | LP supply not burned | `lp_supply > lp_burn_dust_threshold` (strict; default 1,000 raw LP units) | LP mint SPL supply read on-chain |
| C5 | LP not locked | `lp_locked_amount == 0`, exactly | Locked LP attributable to supported locker adapters — currently the UNCX Raydium V4 locker only (marker-PDA gate + TokenLock evidence) |
| C6 | Multi-epoch confirmation | Phase 2 occurs no earlier than two epochs after the Phase 1 EligibilityAnchor (`MIN_EPOCH_CONFIRMATION` = 2; ~4–6 days); at Phase 2 the protocol re-evaluates all eligibility criteria and requires the resulting criteria bitmap to match the Phase 1 bitmap. No per-epoch evaluation happens between the phases. | `EligibilityAnchor` PDA (Phase 1) then `EligibilityCert` PDA (Phase 2), bitmap equality enforced |

Scope notes: (i) C3 is enforced in raw token units — "0.5 SOL" is exact only for WSOL-quoted
pools; for a 6-decimal quote mint the same raw count is 500 display tokens, and no decimals or
value normalization is applied across quote mints (unit-convention reconciliation is an open
pre-mainnet owner decision, Q-03). (ii) C5 is enforced only
within the protocol's detection scope: PinkSale, Team Finance, Streamflow, and other lockers
are not detected ("not detected" is not "not locked"); expanding the criterion requires owner
approval. (iii) C6 is an on-chain requirement and is not replaced or weakened by any off-chain
evidence policy.

## 4. Why attestations exist

Raydium V4's pool account stores no last-swap timestamp, the SlotHashes sysvar covers only
~512 recent slots, and Solana programs cannot read historical account state. Inactivity and
launch price therefore arrive as Ed25519-signed attestations verified in-transaction through
the `ed25519_program` precompile. There is no external price-feed dependency anywhere in the
eligibility path: the implementation does not use Pyth or any other oracle network.

## 5. Evidence model — activity and launch-price attestations

**Activity attestation (criterion C1 input).** The dedicated indexer derives the pool's last qualifying economic
swap time from Raydium V4 transaction history; the activity oracle signs a 112-byte message
(`amm_program_id ‖ pool_address ‖ last_swap_unix_ts ‖ issued_slot ‖ slot_hash`). Approved
direction (GY-ADR-001 D4): only verified economic swaps reset inactivity — liquidity
additions/removals, administrative instructions, crank operations, and other non-swap AMM
interactions must not count; ambiguous transactions remain unresolved and fail closed;
canonical classification belongs in the core SDK. That classification is approved but not yet
implemented; until it lands the attested timestamp must be read as "last AMM interaction".

**Launch-price attestation (criterion C2 input).** The launch price is the quote-per-base price formed by the
pool's vault balances immediately before its first successful swap. The launch-price oracle —
deliberately a different key, because the baseline is init-once and permanently binding —
signs a 168-byte message carrying pool and mint identities, the first-swap slot and timestamp,
the Q64.64 price, and the issuing slot. `record_launch_price` accepts the price only inside
this attestation and writes the init-once `LaunchPrice` PDA; caller-supplied prices revert.
Deriving the baseline requires sufficient historical coverage to reach the first qualifying
price event; if the history cannot establish it, the evidence is incomplete or unavailable and
no price is substituted. Implementation status: on-chain verification and SDK derivation are
implemented; the dedicated indexer's C2 issuance integration is incomplete (R-33) — the C2
pipeline is not operationally complete.

**Division of responsibility.** The dedicated indexer derives, attests, and reports — it is
evidence infrastructure, never an eligibility or settlement authority, and submits no
transactions. The chain verifies signature, oracle identity, binding, timestamps, freshness,
and all six criteria. Governance registers and rotates oracle keys. The operator runs
derivation honestly, protects keys, and monitors freshness — an operational commitment, not
bytecode.

**Failure behavior.** Incomplete, stale, invalid, or unavailable evidence fails closed:
every failure mode is a revert (6024–6034, 6002/6032/6033, 7001/7002); there is no fallback to
caller-supplied values. Oracle downtime blocks new evaluations — an availability cost, not an
integrity risk. The indexer's verifier mirrors the on-chain check order and preserves an
explicit `indeterminate` outcome rather than presenting unverifiable evidence as verified. An
indexer whose historical scan is incomplete must never claim that a pool has been inactive for
a qualifying period; approved direction D6 adds explicit completeness status, persistent
cursors, and controlled backfill (approved, not yet implemented).

## 6. Two-phase eligibility lifecycle

Phase 0 — `record_launch_price` writes the init-once `LaunchPrice` PDA from a launch-price attestation.

Phase 1 — `evaluate_pool_phase_1` runs the full evaluator; a full pass writes an
`EligibilityAnchor` PDA recording `first_eligible_epoch`, the criteria bitmap, the rent-paying
writer, and an invalidated flag; any miss writes nothing. **An anchor is not a salvage
authorization** — no instruction path leads from an anchor to liquidity movement, GraveVault
does not accept anchors, and anchor invalidation and rent-reclaim sweep confer no salvage
rights.

Waiting period — at least `MIN_EPOCH_CONFIRMATION` (2) Solana epochs, approximately 4–6 days.

Phase 2 — `evaluate_pool_phase_2` re-runs the identical evaluator with a fresh activity attestation
(the Phase 1 attestation has necessarily aged out of the SlotHashes window, so replay is
structurally impossible) and requires the criteria bitmap to equal the anchor's. Any drift —
thresholds, oracle keys, adapter behavior — fails certification entirely and the pool re-enters
Phase 1. On success an `EligibilityCert` PDA is written with a one-hour TTL (governance-
configurable, floored at ten minutes). Live certs are immutable; expired certs reissue in
place through a fresh full Phase 2 run, bumping the generation counter. Reissuance never waives
any check.

## 7. Settlement and distribution — 40 / 40 / 20

`salvage_pool` is permissionless and atomic: pre-flight validation, snapshot commitment,
Raydium V4 withdraw CPI (burning the salvor's LP in place — LP prerequisite: the burned LP
comes from a salvor-controlled token account, so the salvor must hold or acquire the pool's LP
tokens; no protocol acquisition path exists; original holders keep their snapshot-based claims;
locked or inaccessible LP cannot be burned by the salvor — Q-16), Jupiter conversion with a
protocol-checked slippage floor, and distribution of the recovered SOL.

- **40%** → the per-pool `lp_holder_pool_vault` PDA, claimable pro-rata by original LP holders
  against the snapshot Merkle root.
- **40%** → the salvor who submitted `salvage_pool`.
- **20%** → the protocol treasury PDA. A **Charter ceiling**, not a target: governance may
  lower it; configuration rejects any raise (7005). The protocol share is the computed
  remainder, so the three transfers exactly exhaust the proceeds. Per the original whitepaper
  §3.4, the share is intended to fund: smart-contract security audits and bug bounties;
  maintenance and upgrades; infrastructure; new protocol capabilities and DEX integrations;
  and legal and compliance advisory — Charter commitments binding governance and treasury
  controls, not bytecode-enforced restrictions (the program enforces only the cap).

The LP-holder snapshot is taken off chain before settlement by a deterministic snapshotter:
enumerate every LP-holder token account, hard-gate that enumerated balances equal the LP mint
supply exactly, aggregate per owner, attribute UNCX-locked LP to the beneficial owner, and
seal a self-verifying Merkle artifact (SHA-256, sorted-pair). `salvage_pool` pins the snapshot
supply against the live on-chain supply. `claim_lp_proceeds` verifies the Merkle proof, pays
`floor(bucket × balance / snapshot_supply)`, records an init-once `ClaimRecord`, imposes no
deadline, and stays live during emergency pause. Unclaimed residual stays in the vault
permanently — the bucket is unsweepable by any admin key.

A pool is settled **at most once, ever**: the init-once `PoolRegistry` and `SalvageReceipt`
PDAs make a second salvage revert before any lamports move.

**What the 40% allocation is — and is not.** It is a defined share of the value actually
recovered and realized by a specific settlement. It is not a guarantee that any holder
recovers their original capital, any particular fraction, or anything at all. Recovered value
depends on residual pool content, execution prices, and dust policy; per-claim rounding leaves
at most a residual the vault retains; holders who never claim leave value unclaimed
indefinitely. The legal documentation states it without qualification: *no guarantee of
recovery is provided*, and protocol eligibility is not a legal declaration that a pool is
abandoned. The protocol's guarantee is the mechanism — proportional claims, an unsweepable
bucket, no expiry, pause immunity — never an economic outcome.

## 8. Protocol guarantees and limitations

| Commitment | Enforcement | Mechanism |
|---|---|---|
| 20% protocol share is a ceiling | Bytecode | `update_protocol_config` rejects > 2,000 bps (7005); share computed as remainder |
| 20% share spent per Charter purposes | Charter commitment — NOT bytecode | Purpose list (original whitepaper §3.4): audits/bounties, maintenance/upgrades, infrastructure, capabilities/DEX integrations, legal/compliance advisory; governance and treasury controls, not program logic |
| `lp_holder_pool_vault` unsweepable | Bytecode (structural) | No debit path except Merkle-verified claims; 7006 is a reserved tripwire with no call site |
| Claims live during pause | Bytecode | Claim path reads no pause flag |
| One settlement per pool | Bytecode | Init-once PoolRegistry + SalvageReceipt |
| Settlement conservation | Bytecode | Share-sum check (7004) + remainder rule |
| Eligibility enforcement | Bytecode | Single evaluator; bitmap equality; Vault accepts only live certs with bitmap 0x3F |
| Atomic settlement | Bytecode / runtime | One transaction; failures revert wholesale, no partial state |
| 72h timelock on parameter changes | Charter process | Squads transaction buffers. On-chain `pending_authority` / `pending_authority_eta` / `timelock_seconds` are reserved, write-only state; 7014 is never raised. A reserved field is not an enforced timelock |
| 7-day notice / 24h + post-mortem | Charter process | Governance commitments; no runtime tripwire |
| Multisig 3-of-5 → 4-of-7 | Mainnet governance commitment | Devnet runs a dedicated governance authority key; no devnet artifact proxies mainnet custody (KEYS-003 open) |
| No token / NFT / points | Design absence | Nothing to enforce; adding one requires an upgrade subject to the process commitments |
| Only verified economic swaps; finalized-only evidence; explicit completeness | Approved direction — not yet implemented | GY-ADR-001 D4/D5/D6; named SDK work items |
| C5 covers all lockers | Limitation | UNCX only today (Section 3 scope note) |
| Claims restore original capital | Not a guarantee | Section 7 |

## 9. Repository architecture

| Repository | Responsible for | Explicitly not responsible for |
|---|---|---|
| `GraveYield/graveyield-protocol` | On-chain programs; shared protocol SDK (single source of truth for wire formats and evidence semantics); snapshotter and Merkle tooling; salvage-side SDK operations; protocol verification tests | Production evidence attestation; operational RPC infrastructure; lifecycle observation. Its bundled candidate-indexer package and ops indexer service overlap dedicated-indexer functionality and are under review per GY-ADR-001 D3 |
| `GraveYield/grave-indexer` | Off-chain discovery and indexing; historical evidence collection with provenance; evidence derivation and attestation workflows; provenance/completeness reporting; operational RPC handling; read-only lifecycle observation; live evidence-path verification harness | Eligibility authority, settlement, transaction submission, any state mutation |

The dedicated indexer is evidence infrastructure. It is not the authority for on-chain
eligibility or settlement.

## 10. Research context — Ghost Pools (qualified)

The Ghost Pools research working paper (WP-2026-001r4) estimates approximately $2.17 billion
of technically recoverable stranded liquidity across Solana, Ethereum, and BNB Chain in its
base case, with conservative and upper-bound scenarios of approximately $860 million and
$5.4 billion, growth of an estimated $400 million per month, and roughly 400,000 affected
pools (May 2026 sampling run; stated 90% interval $1.1–4.0 billion). These are **research
estimates**, not verified recoverable TVL and not guaranteed protocol revenue. When quoting:

- **Observed/indexed liquidity** — what sampling and the observatory enumerate.
- **Estimated stranded liquidity** — pools meeting the paper's academic definition.
- **Estimated technically recoverable liquidity** — base-asset value after the paper's
  dead-token discount; the headline figures.
- **Liquidity satisfying GraveYield eligibility** — the strictly smaller subset that also
  passes C1–C6; not measured by the paper.
- **Actual settlement proceeds** — realized per salvage; not predictable in advance.

The paper's own limitations apply whenever figures are quoted: ~15% stratum sampling error;
a dead-token discount that is an assumption, not an empirical calibration; point-in-time
estimates not blended with the live observatory; coverage constraints on some chains;
citation-verification annotations. The paper's devnet deployment record documents an earlier
deployment generation and is superseded by the current lineage. Its phrasing that original LP
holders retain *guaranteed proportional claims* is accurate for the claim — the defined
allocation above — and must not be read as guaranteed recovery value.

## 11. Roadmap (status-based; no dates promised)

| Milestone | Scope | Status |
|---|---|---|
| m1–m8 | Mainnet-grade salvage on Raydium V4 | Source implemented; unit/integration and fork tests pass; Devnet deployment acceptance 56/56 (deployment + ELF checks only — it does not establish end-to-end lifecycle operation per W2 §9); no controlled real-pool Devnet salvage executed; independent audit not begun; Mainnet readiness not claimed; mainnet deployment pending, gated below (corrected C-10) |
| m9 | Off-chain indexer | Delivered as the dedicated indexer (operational) with named gaps: SDK economic-swap classification and finalized gating (approved, unimplemented), C2 issuance path unwired, cursors/backfill unbuilt; core bundled indexer under D3 review |
| m10 | Locker adapters | UNCX Raydium V4 implemented and verified; PinkSale / Team Finance open |
| Additional AMMs | Raydium CLMM, Orca Whirlpool, PumpSwap, Meteora | Open (v1.1) |
| Security | Independent audit and bug bounty | Open (Phase 13); the Phase 12 adversarial battery is preparation, not a substitute |
| Mainnet transition | Custody keys, multisig transition, oracle runbook, env-neutral config, RPC resilience | Open (KEYS-003, ORACLE-003, GOV-001 and related) |

## 12. Terminology

Canonical terms enforced by CI terminology lint: GraveYield; GraveScanner; GraveVault;
EligibilityAnchor; EligibilityCert; SalvageReceipt; LaunchPrice; PoolRegistry; ClaimRecord;
the activity attestation (SDK type `LastSwapAttestation`, criterion C1 input) and the
launch-price attestation (SDK type `LaunchPriceAttestation`, criterion C2 input); C1–C6 refer
exclusively to the six eligibility criteria; original LP holders; salvor; protocol
allocation; derelict pool; the deterministic lifecycle for abandoned liquidity. The lexeme
forbidden by the glossary (spelled only in glossary.md and scripts/terminology-lint.sh) is
not part of the project's vocabulary and is not reintroduced here. The maritime
salvage framing is an analytical analogy and potential legal theory, not a representation of
settled law; the legal documentation governs that boundary.

## 13. Revision history

| Version | Date | Status |
|---|---|---|
| 4.0 | May 2026 (canon lock) | Historical document; preserved unchanged |
| v4.0.1 (informal) | referenced in code comments | Spec patch with no living artifact; absorbed into 4.1.0; lineage question Q-01 |
| 4.1.0 | 2026-11-13 | This draft (not published) |

*Verification basis: graveyield-protocol @ c7d203272b994c055295c925ccd69e42c121f581;
grave-indexer @ 17998bab3a1c6854e42b67bf3bd1305433e3c3af; SDK pin d526699 (zero wire drift);
W2 NS-3 acceptance 56/56; live readback 2026-11-13 (oracles 2ZygwHNX…Zqf8o and
97JVKVd6…Bcee registered; thresholds at spec defaults).*

```

### 9.4 Deliberately not proposed (would require code or owner decisions)

- `sdk/src/errors.ts`: add vault 7022 (EC-02 / Q-14).
- `src/discovery.ts` sort-before-truncate determinism fix (IN-08 / RSK-10).
- Cluster-neutral config naming and SDK-constant imports (R-38 / audit M-4).
- `src/config.ts` stale comments ("deployment pending") (IN-07).
- Core `indexer/` submit-path retirement and ops repositioning (R-46/R-47 / Q-05).
- Any eligibility, threshold, distribution, oracle, or governance change: none proposed
  anywhere in this assignment.

### 9.5 Application order (if approved)

1. Items 5, 7, 8 (mechanical fixes).
2. Items 2, 3, 4, 9, 10 (deployment-status flips, one coherent changeset with a verification
   note referencing the W2 acceptance report).
3. Items 1, 6 (phrasing/precedence fixes).
4. Item 11 (whitepaper v4.1.0) only after Q-01 (version lineage) and Q-18 (publication
   vehicle) are resolved by the owner.

---

## 10. Boundary confirmation

**Investigation phase (read-only).** No source code, dependency, lockfile, configuration,
submodule pin, deployment, commit, push, or pull request was created or modified in either
repository; the only artifacts created were reviewable deliverables (Section 2 reproduces the
verification log, including the working-tree states being mode-only filesystem artifacts with
zero content diff, and the live readback performed with read-only RPC calls).

**Consolidation phase (this pull request).** Executed at the owner's explicit instruction
using an owner-provided token:

- Exactly one new file is added — this report — on branch `docs/gy-doc-recon-001-alignment-report`,
  opened as a **draft pull request. No merge was performed and none should be.**
- No other file is added, edited, or deleted in either repository. No source, configuration,
  dependency, lockfile, or submodule pin is touched. The proposed changes in Section 9 are
  **not applied** to any document — they live inside this report for review only.
- The token used for the push is not embedded in this report or the pull-request body;
  local credential artifacts were removed after use.
- Nothing in this report silently resolves the owner decisions enumerated in Section 8;
  all proposed changes remain reviewable proposals.

**Corrective revision 2 (2026-11-13).** Prepared per the owner's corrective-revision
assignment (Parts 1 and 2): only this report file's content was changed — no source, SDK,
deployment, protocol, or repository file outside this report was touched. The whitepaper
original DOCX uploaded by the owner was read (file inspection, not a preview); a fresh
read-only RPC readback was performed for C-05. On 2026-11-14 the owner separately authorized
publishing the revision ("Push these corrections to PR #104's current head"); the revision
was committed and pushed to this PR branch as a single commit on top of its then-current
head `2731b3d`, touching only this file. PR #104 remains an open draft; nothing was merged.

---

## Appendix A. Live devnet readback evidence (raw)

Raw output of the 2026-11-13 live readback (`evidence/live_rpc_verification_2026-11-13.txt`,
read-only RPC against `api.devnet.solana.com`):

```

[OK] GraveScanner ProtocolConfig PDA exists: 252 bytes, owner EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL
     owner matches EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL: True
[OK] GraveVault ProtocolConfig PDA exists: 210 bytes, owner 7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya
     owner matches 7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya: True

Scanner ProtocolConfig content checks (layout-robust):
  governance authority at [8..40): True
  activity_oracle bytes present:  True
  launch_price_oracle present:    True
  distinct positions: True (activity@123, launch-price@155)
  pending_authority_eta = 0
  pending_authority value: 11111111111111111111111111111111 (eta=0 → rotation not armed)
  bump = 255 (W2 acceptance asserts 255)
  reserved[64] all-zero: False
  inactivity_seconds = 7776000 (expect 7776000)
  price_collapse_bps = 9900 (expect 9900)
  min_tvl_lamports   = 500000000 (expect 500000000)
  anchor_staleness_s = 1209600 (expect 1209600)
  lp_burn_dust       = 1000 (expect 1000)
  cert_ttl_seconds   = 3600 (expect 3600)
  paused             = 0 (expect 0)

```

> **C-05 correction (revision 2).** The `reserved[64] all-zero: False` line above is a BUG
> ARTIFACT in the readback script, not an account fact: the comparison was written as
> `reserved == b'\x00' * 64`, where `b'\x00'` in Python source is the 4-character literal
> (`\`, `x`, `0`, `0`) — not a NUL byte — so the comparison could never be true. A corrected
> re-readback on 2026-11-13 (same read-only RPC, exact struct offsets) establishes:
>
> - GraveScanner ProtocolConfig `5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe`, 252 bytes:
>   reserved range [188..252) = 64 bytes, hex `00`x64, nonzero count 0 → **all-zero: TRUE**.
> - GraveVault ProtocolConfig `5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda`, 210 bytes:
>   reserved range [114..210) = 96 bytes (`_reserved: [u8; 96]`), nonzero count 0 →
>   **all-zero: TRUE**.
> - Offsets verified against the struct definitions (scanner: ... activity_oracle [123..155),
>   launch_price_oracle [155..187), bump [187..188), `_reserved` [188..252); vault: ... paused
>   [112..113), bump [113..114), `_reserved` [114..210)); bump bytes read 0xFF on both.
> - Root cause classification (C-05 item 7): incorrect verification script (comparison
>   literal), NOT an incorrect decoder, NOT a stale layout, NOT actual non-zero account
>   state. `initialize` writes `_reserved = [0u8; 64]` (initialize.rs:107) and Anchor `init`
>   zero-fills the allocation, consistent with the observed zeros.

---

## Appendix B. Consolidation findings and corrections

Findings made while consolidating the six deliverables and the proposed-doc-changes area into
this single report, each resolved inside the report itself:

- **CF-01 — placeholder diffs replaced with real diffs.** The `.diff` files shipped with the
  original deliverables were placeholders containing "(no diff)". Real unified diffs were
  generated at consolidation time against the same verified commits (`c7d2032` / `17998ba`)
  and are embedded in Section 9.2; mode-noise lines were stripped.
- **CF-02 — proposed files 2 and 3 repaired.** The `.proposed` copies of
  `docs/technical-documentation.md` and `docs/DEVNET.md` were byte-identical to the originals
  (the edits described in the change index had not been written). Both were repaired at
  consolidation time using only previously verified facts (W2 acceptance 56/56 with its 29/29 +
  27/27 split, finalized slots 521557300 / 521557485 at epoch 1207, registered oracle
  authorities, transaction signature table in the acceptance report §5, live readback date
  2026-11-13). The remaining eight `.proposed` files were verified to differ from their
  originals exactly as described.
- **CF-03 — two whitepaper renderings, one substance.** The formal draft (Section 4, from
  Deliverable 2 docx) and the repo-facing markdown (Section 9.3) use different layouts
  (Document Control + subsectioned vs 13 flat sections including "Why attestations exist").
  A programmatic cross-check of thresholds, byte formats, allocation shares, guarantees,
  terminology, and version provenance found no substantive contradiction between them.
  Reconciling the two renderings into one canonical file before application is an owner step.
- **CF-04 — index wording corrected.** The original change index called the markdown a
  "mirror" of Deliverable 2; per CF-03 the accurate description is "second rendering of the
  same draft", and Section 9.1 uses that description.

---

## Appendix C. Corrective revision validation record (revisions 2-4)

Validation performed before reporting completion (assignment §8), with method and outcome:

1. **Full re-read.** The revised report was re-read section by section after all edits;
   the heading structure (Contents, §0-§10, Appendices A-C) was re-derived and checked
   against the actual headings.
2. **Stale-phrase search.** Programmatic search for every incorrect phrase named in C-01
   through C-14: "same semantic order/ordering … no ordering divergence" (§3.1, WP-03,
   Q-02 — corrected), "an expired one is required for settlement" (corrected), "≥ 2
   consecutive Solana epochs … identical criteria bitmap" (§9.3 Table C6 — corrected; the
   remaining "consecutive"/"4-6 days" occurrences are qualified approximations of the gap
   length, not per-epoch claims), "500 raw display units" (corrected), "reserved … False"
   (annotated + corrected readback), "Implemented and Devnet-verified (W2 NS-3 acceptance
   56/56)" for m1-m8 (both roadmap tables corrected), "C1 activity evidence"/"C2 launch-price
   evidence" as evidence-type labels (renamed; criteria-only C1-C6 kept), "docs/w2-ns3-
   acceptance/" as a proposed relative href (validated correct — display text only),
   "sig/pk pin 6025 → … → message-span pin 6025" (rewritten to the verified order), maritime
   "finder under maritime salvage law" / "takes no discretion" (narrowed in both renderings).
3. **Contradiction scan.** The specific contradictions named by the assignment were checked
   after correction: certificate-validity statements now agree across §4 (whitepaper draft),
   §5 Table 5.1/4.1, §6, the architecture flow, and both whitepaper renderings; C2 pipeline
   descriptions now carry the implemented-vs-incomplete split everywhere C2 is described
   (whitepaper §4.2, spec §6, architecture Stage 0, diagrams, exec summary, R-33/R-24);
   reserved-byte statements agree (all-zero, with the script-artifact explanation).
4. **Implementation claims re-verified against source.** criteria.rs (bitmap bits 1<<0..1<<5,
   fixed-order conjunction, Phase-2 gap `current_epoch - anchor_epoch >= 2` + bitmap
   equality), evaluate_pool_phase2.rs (fresh-attestation gate, CriteriaBitmapMismatch 6011),
   errors.rs scanner (6024/6025/6026 texts; 6034 CertStillValid) and vault (7001
   InvalidEligibilityCert / 7002 EligibilityCertExpired; self-test pins), salvage_pool.rs
   (cert `is_expired` gate :300-303; `salvor_lp_token_account` authority :243-249;
   `salvor_lp_amount > 0` :410-412; snapshot supply pin; no cert consumption), attestation.rs
   check order :254-329, evaluate_pool_phase1.rs:151 (quote reserve as TVL), initialize.rs:107
   (`_reserved = [0u8; 64]`), SDK lastSwapAttestation.ts / launchPriceAttestation.ts type
   names, SDK errors.ts 6024-6026 names, indexer src (no C2 derivation call sites;
   evidencePath.ts is a live verification harness).
5. **Account-layout and byte-offset claims.** Scanner ProtocolConfig layout re-derived from
   state/protocol_config.rs (252 bytes; reserved [188..252)); vault layout (210 bytes;
   reserved [114..210)); live-verified by fresh readback (bump 0xFF both; reserved all-zero
   both; timelock 259,200 s decoded from bytes; paused 0x00).
6. **Error-code references.** 6024/6025/6026 verified in errors.rs + errors.ts; the C-13
   sequence corrected to source order; 7001/7002 semantics corrected; 6034 text matches
   errors.rs:200-211; no other code references were altered.
7. **Proposed relative links.** All links in the added lines of proposed changes 1-10
   resolved programmatically against both repository trees (6/6 ok); the proposed new
   whitepaper file contains no relative links (C-12).
8. **GhostPools r3.** Updated in revision 3 (R3-01, R3-04): the owner inspected r3 directly
   in the review context (2026-11-14) and confirms it carries its own research scope,
   estimates, methodology, and protocol claims; r3's binary is not in the working
   environment (filesystem search 2026-11-14), so no section-level citation from it is made
   here. The r3-vs-r4 differential is PARTIAL: r4's changelog r3-row plus the owner's scope
   confirmation are recorded; the claim-by-claim comparison against r4's text remains open
   pending binary transfer. No r4 content is presented as r3 content; the report's
   GhostPools rows cite r4 with the paper's own qualifications. Revision-4 upgrade (R4-02):
   the differential is now DOCUMENTED from the r4 binary itself — r4 §1 (p. 2) names the two
   material developments since r3; r4 Appendix A (p. 15) states the Sections 5-8 estimates
   are carried forward unchanged from r3 for cross-revision comparability; the Document
   Changelog (pp. 15-17) records both revisions' entries. The remaining non-gating residual
   is independent re-reading of r3's own wording (r3 DOCX binary).
9. **Original whitepaper economic and Charter provisions.** Verified present in the revised
   drafts: §3.4 purpose list (both renderings, C-09); 40/40/20 with remainder conservation;
   unsweepable LP-holder vault; no-expiry pause-immune claims; no-token commitments;
   multisig thresholds; maritime framing reduced to analogy with the original's own
   "not a fully settled legal framework" concession noted. The original's unsupported claims
   (Pyth, entire-LP-supply redemption, LP acquisition, on-chain timelock enforcement,
   guaranteed restitution) are documented as discrepancies, not carried into the revised
   drafts.
10. **No source/protocol changes.** Confirmed: the corrective-revision commit touches only
    this report file; `git status` in both clones shows no other content change (plus
    pre-existing sandbox mode-artifacts with zero content diff); the commit was pushed to
    PR #104's branch on the owner's 2026-11-14 authorization, on top of head `2731b3d`;
    the PR remains draft and nothing was merged.
11. **Revision 3 consistency (owner-review findings).** The stale whitepaper-inaccessibility
    statements (WP-02 status cell; Deliverable 2 preamble; Q-01 question text) were
    corrected, and a report-wide check confirms no remaining "not accessible" or
    "unavailable" characterization of the whitepaper original outside explicitly scoped
    working-environment statements and the revision-3 items that quote the former label;
    Section 0, Section 2.3, the matrix rows, and this appendix now agree with the
    inspection record.
12. **Availability semantics (R3-02).** Every repository-availability claim about the four
    originals is scoped to the refs actually searched; review-context availability is
    stated separately; the owner's independent 404 spot-checks of `docs/published/`-style
    paths on `main` are consistent with the exhaustive search.
13. **Owner-confirmed historical claims (R3-01).** TechDoc v3.0 (Pyth dependency,
    cheapest-first evaluation, invalidate_cert, certificate consumption, 72-hour timelock
    claims, broader AMM support), Combined v3.0 (Table 4 ordering, C1 No LP burn … C6
    Price decline), and GhostPools r3 (own scope/estimates/methodology/claims) are recorded
    as owner-confirmed from direct inspection in the review context — not as binarily
    verified in this environment; the claim-by-claim r3-vs-r4 differential remains open
    (R3-04). Revision-4 corroboration (R4-01): the published editions corroborate the
    recorded claims from their own change documentation — TechDoc v4.0 §2 Oracle-distinction
    note (p. 4: the old technical document's Pyth price-collapse oracle) and §12 Revision
    history (pp. 12-13: v3.0 "contained stale version, AMM-support, oracle, governance and
    deployment claims"); Combined v4.0 §1.1 (p. 1: "The v3.0 consumed_at field does not
    exist") and §3.3 (p. 8: "v3.0 described this as a cheapest-first order") with Table 9
    (pp. 8-9) fixing the shipped order. The 72-hour timelock figure and `invalidate_cert`
    naming remain owner-confirmed-only.
14. **Published-edition binaries re-verified (R4-03).** The three published PDF renditions
    named by the owner were re-extracted from `origin/main` and re-inspected (GhostPools r4:
    19 pp; TechDoc v4.0: 13 pp; Combined v4.0: 25 pp — matching the §2 record); all three
    verified present in the report-baseline tree via `git cat-file` at `c7d2032` (added via
    owner uploads `83ac666`/`a4e128e`/`6c32461`; the `40de855` reorganization moved the
    TechDoc and GhostPools uploads into `docs/published/` while Combined remained at
    `docs/`); the single-Pyth claim re-verified (1/0/0 occurrences across the set); no
    "4.0.1" occurrence in any of the three.
15. **Revision 4 scope.** Confirmed: the revision-4 edits touch only this report file's
    corroboration and status language (Section 0 R4-01-R4-04, §2 log rows, §2.3 matrix
    rows, this appendix); no source, SDK, deployment, or protocol-behavior statement
    changed, and no finding changed status except the r3-vs-r4 differential (PARTIAL →
    DOCUMENTED, R4-02) and the source-status labels it implies.

**Remaining unverified / open after this revision:** full-text section-level citations from
the three v3.0-era DOCX originals (their binaries are not in the working environment; the
claims are owner-confirmed and, where applicable, published-edition-corroborated — R3-01,
R4-01) and independent re-reading of the r3 DOCX wording (non-gating; the r3-vs-r4
differential is documented from the r4 binary — R4-02); CI-secrets configuration (Q-09,
unverifiable from a sandbox); scheduled-smoke posture; and
every decision explicitly reserved to the owner (Q-01 ratification of 4.1.0, Q-03 threshold
semantics, Q-04 lock-criterion scope — publication and Mainnet-readiness blocker, Q-05,
Q-06, Q-07, Q-08, Q-11 r5 authoring, Q-16 LP operational model, Q-18 publication vehicle,
Q-21 spec evidence-label rename).
