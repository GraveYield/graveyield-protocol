# @graveyield/indexer

Off-chain GraveScanner v2 — discovers candidate derelict pools across Solana
AMMs and surfaces them to salvors.

## Why off-chain?

The on-chain GraveScanner program is the authority on eligibility for a
specific pool: it writes EligibilityAnchor and EligibilityCert PDAs that
GraveVault consumes. But running an on-chain check across every Solana AMM
pool every minute would be prohibitively expensive in compute and rent.

The off-chain indexer is the **wide funnel**:

1. Enumerate every pool in every supported AMM program.
2. Apply a cheap pre-filter for the six derelict criteria using cached
   account data.
3. Stream survivors to the salvor SDK as candidates worth submitting to
   on-chain Phase 1.

The on-chain GraveScanner remains the **narrow authority** — it is the
only way to mint an EligibilityCert that GraveVault accepts.

## Run

```bash
pnpm install
pnpm --filter @graveyield/indexer build
pnpm --filter @graveyield/indexer start
```

Configuration lives in environment variables (RPC URL, AMM source toggles).
A `.env.example` lands with the m9 implementation.

## Status

Phase 0 scaffold. Implementation tracked as m9 in the build sequence.
