# Ghost Pools — Working Paper WP-2026-001r4 (cover)

**Mapping the Stranded Liquidity Crisis Across Solana, Ethereum, and BNB Chain**

| | |
|---|---|
| **Working paper** | WP-2026-001r4 · October 2026 |
| **Author** | GraveYield Protocol Research Division |
| **Contact** | research@graveyield.xyz · graveyield.xyz/research |
| **Published snapshot** | [`published/GhostPools_Research_Paper_WP-2026-001r4.pdf`](published/GhostPools_Research_Paper_WP-2026-001r4.pdf) (19 pages, typeset two-column) |

> **Cover document.** This markdown is the living cover and abstract for the
> research paper; the typeset PDF in `published/` is the citable artifact
> and is never edited in place. This file carries the paper's abstract, its
> headline findings and a section map so readers can verify claims against
> the PDF without leaving the repository. It does not restate the full
> paper; the PDF wins for typeset content, this cover wins for navigation.

## Abstract

The emergence of permissionless token launchpads — most notably Pump.fun on
Solana — has produced an unprecedented volume of cryptocurrency token
creation, with over 12 million tokens deployed on the Solana blockchain
alone since early 2024. The overwhelming majority of these tokens exhibit
rapid lifecycle collapse, becoming economically inactive within days or
weeks of launch. However, the liquidity deposited into Automated Market
Maker (AMM) pools associated with these tokens does not vanish upon token
death — it persists on-chain in what the paper terms **ghost pools**:
abandoned liquidity positions with no active market participants, no
functional UI access, and no mechanism for value recovery under current
DeFi infrastructure.

The paper presents the first systematic empirical analysis of ghost pool
formation across three major blockchain ecosystems — Solana, Ethereum, and
BNB Chain — quantifying the total addressable stranded liquidity,
characterizing the demographic profile of affected liquidity providers,
analyzing the structural causes of liquidity abandonment, and evaluating
the technical and economic feasibility of automated salvage
infrastructure. The base case estimates **$2.17 billion** in recoverable
liquidity currently stranded across these three chains, with conservative
and upper-bound scenarios ranging from approximately **$860 million to
$5.4 billion**. The inventory grows by an estimated **$400 million per
month**.

Revision r4 additionally introduces a continuous public observatory
instrumentation — the GraveYield Ghost Pool Observatory on Dune, which
monitors potentially abandoned Uniswap V2 liquidity pools on Ethereum and
Base using a conservative 180-day no-swap criterion, continuously enriched
with live reserve and token metadata — and documents the protocol's
progression from design to deployment: the Phase 0 specification is
frozen, the settlement economics are proven against mainnet bytecode, and
both Anchor programs (GraveScanner, GraveVault) were deployed to Solana
devnet on 9 October 2026 with configurations initialized at specification
defaults.

The paper argues that ghost pools represent a fundamental market failure
in decentralized finance — a state of economic finality without
settlement infrastructure. The development of restitution-preserving,
permissionless liquidity salvage infrastructure — exemplified by protocols
such as GraveYield — constitutes both a technically viable and
economically significant intervention. Critically, the paper distinguishes
between **restitution-preserving permissionless salvage** (in which
original LP holders retain guaranteed proportional claims on recovered
value) and **autonomous harvesting** (in which recovered value is claimed
entirely by third parties). Only the former is legally and ethically
defensible; only the former is grounded in centuries of maritime salvage
law precedent governing the recovery of derelict property.

**Keywords:** DeFi · liquidity pools · automated market makers · memecoin
· stranded capital · Solana · Ethereum · BNB Chain · liquidity salvage ·
ghost pools · derelict pools · abandoned liquidity

## Headline findings

| Finding | Value (May 2026 sampling run) |
|---------|-------------------------------|
| Total ghost pools across surveyed chains | ~400,000 |
| Solana stranded liquidity (base case) | $1.10B (~155,000 pools) |
| Ethereum + EVM chains stranded liquidity (base case) | $475M (~81,000 pools) |
| BNB Chain stranded liquidity (base case) | $420M (~120,000 pools) |
| Global base case / conservative / upper bound | $2.17B / $860M / $5.4B |
| Estimated inventory replenishment | ~$400M per month |
| Annualized opportunity cost (8% benchmark, base case) | $173.6M ($868M over five years) |
| Value concentration | Solana carries roughly half the global inventory; Ethereum mainnet Uniswap V2 pools carry the highest per-pool value density (~$8,400 average residual) |

## The three definitional layers

The paper operates with three deliberately layered inactivity thresholds
(paper Table 14):

| Layer | Threshold | Role |
|-------|-----------|------|
| Academic definition (paper Definition 3.1) | ≥30 days no swap | Classification framework, includes off-chain signals (developer wallet, social) |
| Protocol production criteria | ≥90 days no swap | Salvage eligibility, on-chain verified (C1), plus five further on-chain criteria and two-phase multi-epoch certification |
| Observatory screen | ≥180 days no swap | Conservative public monitoring of Uniswap V2 on Ethereum and Base |

## Structure of the published paper

| Section | Content |
|---------|---------|
| 1–2 | Introduction, scope, contributions; AMM background, memecoin lifecycle dynamics, maritime salvage law precedent, DeFi capital-inefficiency literature |
| 3 | Theoretical framework: formal ghost-pool definition (five academic conditions), formation dynamics, welfare economics |
| 4 | Methodology: stratified sampling, data sources, valuation scenarios (dead-token discount δ), the r4 Dune observatory instrumentation, limitations |
| 5–8 | Empirical analyses: Solana (~155,000 pools, $1.10B base case), Ethereum and EVM chains (~81,000 pools, $475M), BNB Chain (~120,000 pools, $420M), cross-chain comparison |
| 9 | Economic valuation: market-failure anatomy (coordination failure, information asymmetry, technical barrier), opportunity-cost analysis |
| 10 | Structural causes: developer-driven abandonment (~78% of Pump.fun-origin cases within 14 days), retail behavioral factors, the Ethereum dust trap |
| 11 | The case for salvage infrastructure: five design requirements; GraveYield architecture — six on-chain criteria, two-phase certification, oracle-attested evidence, 40/40/20 settlement, Merkle claims, Charter invariants; adoption scenarios |
| 12 | Technical feasibility: on-chain execution viability, multi-epoch rationale, CPI analysis, implementation status and the 9 October 2026 devnet deployment record |
| 13 | Legal and regulatory considerations: the salvage permission spectrum, maritime salvage law as legal defense, residual exposure (conversion, escheatment, securities, MiCA, AML/CFT), Southeast Asia frameworks |
| 14 | Risk factors and limitations: data limitations, citation-verification status, regulatory risk, implementation and security risk |
| 15 | Conclusion, policy implications, future research |
| Appendices A–D | Methodology notes; academic classification criteria; academic-vs-protocol criteria mapping; observatory instrumentation and devnet deployment record |

## Scope and relation to the protocol

The ghost-pool concept is the **academic** classification; production
salvage eligibility is deliberately more conservative and on-chain-only —
the mapping is fixed in [`PROTOCOL_SPEC.md`](PROTOCOL_SPEC.md) (frozen
v1.0.0) and restated in the paper's Appendix C. Nothing in this paper
modifies protocol behavior; where the paper and the specification
disagree, the specification wins per
[`README.md`](README.md) precedence. The protocol framing — settlement
infrastructure, not an intervention programme — and the canonical
vocabulary are defined in [`glossary.md`](glossary.md); the legal analysis
lives in the published Legal Documentation v4.0 set (see
[`legal-documentation.md`](legal-documentation.md)).

## Document changelog (research paper)

| Revision | Date | Change |
|----------|------|--------|
| WP-2026-001 | April 2026 | Initial release. |
| WP-2026-001r2 | April 2026 | Aligned with Whitepaper v3.0; 40/40/20 flat split; restitution-preserving framing; upper bound unified at $5.4B; citation-verification table; Appendix C added. |
| WP-2026-001r3 | May 2026 | Aligned with Whitepaper v4.0; canonical salvage/salvor/derelict vocabulary adopted; maritime salvage law added as primary legal analogy; multi-epoch confirmation added to feasibility analysis and Appendix C. |
| WP-2026-001r4 | October 2026 | Integrated the Ghost Pool Observatory (Dune) as continuous instrumentation; deeply merged the frozen specification v1.0.0 (criteria table with evidence sources, two-phase certification, oracle-attested evidence, settlement mechanics, Charter invariants); documented the 9 October 2026 devnet deployment; first typeset two-column edition. |
