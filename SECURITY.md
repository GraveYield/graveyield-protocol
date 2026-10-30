# Security policy

## Reporting a vulnerability

GraveYield Protocol is settlement infrastructure handling derelict liquidity. Security reports
are taken seriously and triaged urgently.

**Please do not open public issues for security reports.** Use **GitHub private
vulnerability reporting** on this repository (Security tab) with:

1. A clear description of the vulnerability.
2. Steps to reproduce, or a proof-of-concept.
3. The affected component and version (Anchor program, SDK, indexer, etc.).
4. Your name or pseudonym for credit (optional).

You'll get an acknowledgement within **48 hours** and a status update at most once every
**7 days** until resolution.

## Scope

In scope:

- Anchor programs: `programs/grave-scanner`, `programs/grave-vault`
- TypeScript salvor SDK: `sdk/`
- Off-chain GraveScanner v2 indexer: `indexer/`
- Locker adapters when shipped: `adapters/`

Out of scope:

- Issues in dependencies — please report those upstream.
- Spam, social engineering, denial-of-service against off-chain RPC providers.
- Issues in third-party AMMs, lockers, or wallet software.

## Bug bounty

A formal bug bounty programme will activate at **devnet release / Phase 2 audit prep** via
**Immunefi**. Until then, white-hat reports are welcomed but cannot offer cash rewards;
acknowledgement and credit will be provided.

## Audit programme

- **Phase 1 audit** — pre-devnet, internal + advisor review.
- **Phase 2 audit** — pre-mainnet, two independent firms (target: OtterSec + Neodyme).
- **Continuous review** — CodeRabbit Pro on every PR once the repo flips public.

Audit reports will be published to `docs/audits/` once mainnet ships.

## Coordinated disclosure

Once a fix is in flight, we'll coordinate a public disclosure timeline with the reporter.
Default window is **90 days from initial report** or **immediately after a fix is deployed**,
whichever is sooner — extendable by mutual agreement when complexity warrants.
