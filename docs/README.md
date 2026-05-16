# GraveYield Protocol — documentation

This directory is the **living source of truth** for GraveYield's specifications.
Every spec change lands here as a markdown PR alongside the corresponding code
change. Spec drift is treated as a bug.

## Canonical spec set (locked, May 2026)

The spec set is exactly six documents. Anything claiming to be GraveYield
canon outside this list is either superseded or unrelated to the project.

| Document | Living source | Published snapshot |
|----------|---------------|--------------------|
| Whitepaper v4.0 | [`whitepaper.md`](whitepaper.md) | `published/GraveYield_Whitepaper_v4_0.docx` |
| Technical Documentation v3.0 | [`technical-documentation.md`](technical-documentation.md) | `published/GraveYield_TechnicalDocumentation_v3_0.docx` |
| GraveScanner × GraveVault Combined Tech Doc v3.0 | [`grave-scanner-grave-vault-combined.md`](grave-scanner-grave-vault-combined.md) | `published/GraveScanner_GraveVault_CombinedTechnicalDocumentation_v3_0.docx` |
| Legal Documentation v3.0 | [`legal-documentation.md`](legal-documentation.md) | `published/GraveYield_LegalDocumentation_v3_0.docx` |
| Liquidity Salvage Visual Deck | — | `published/GraveYield_Liquidity_Salvage.pdf` |
| GhostPools Research WP-2026-001r3 | [`ghostpools-research.md`](ghostpools-research.md) | `published/GhostPools_Research_Paper_WP-2026-001r3.docx` |

## Architecture deep-dives

| Topic | Document |
|-------|----------|
| Eligibility anchors and the two-phase model | [`architecture/eligibility-anchors.md`](architecture/eligibility-anchors.md) |
| Charter invariants (the things governance cannot change) | [`architecture/charter-invariants.md`](architecture/charter-invariants.md) |
| Priority-fee policy (Charter ceiling + operator margin) | [`architecture/priority-fee-policy.md`](architecture/priority-fee-policy.md) |

## Reference

| Topic | Document |
|-------|----------|
| Error codes (Scanner 6000-6019, Vault 7000-7014) | [`error_codes.md`](error_codes.md) |

## Glossary

[`glossary.md`](glossary.md) defines the canonical v4.0 vocabulary. It is the
authoritative reference for the terminology lint enforced by CI.

## Updating spec

1. Open a PR that changes both the markdown and the code in the same commit.
2. The terminology lint will fail any PR introducing forbidden words.
3. After review and merge, the next quarterly release re-renders the
   `published/` `.docx` snapshots from these markdown files. Until then,
   the markdown is the source — the docx is a frozen reference.

## What goes in `published/`

`published/` is a **snapshot directory**. Files there are versioned by name
(`v4_0.docx`, `v3_0.docx`, `WP-2026-001r3.docx`) and never edited in place.
A new minor revision lands as a new file (`v4_1.docx`, `WP-2026-001r4.docx`).
