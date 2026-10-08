# @graveyield/indexer

Off-chain GraveScanner v2 — discovers candidate derelict pools across Solana
AMMs and surfaces them to salvors.

## Status — Phase 9 complete

The v1 discovery target is **Raydium V4 only** (roadmap Phase 9: "Don't
support every DEX. Start with: Raydium V4 only."). Additional AMM sources
(Raydium CLMM, Orca, PumpSwap, Meteora) land in Phase 15.

The full Phase 9 pipeline is implemented:

1. **Raydium pool discovery** — `sources/raydiumV4.ts` enumerates every
   752-byte AmmInfo account via `getProgramAccounts` with a dataSize
   filter.
2. **Last activity indexing** — `activity.ts` derives each pool's
   last-swap timestamp from RPC signature history via the SDK's
   `deriveLastSwapV4`. Results are cached (1h TTL).
3. **Reserve/TVL filtering** — `reserves.ts` reads vault balances +
   LP supply, identifies the WSOL side (7019 guard), computes TVL.
4. **Token metadata** — `metadata.ts` reads mint supply + decimals for
   the pool's three mints.
5. **Candidate scoring** — `scoring.ts` combines the C1 inactivity
   margin, C3 TVL margin, and C2 price collapse potential into a single
   numeric score.
6. **Queue** — `queue.ts` is a priority queue ordered by score
   descending, with deduplication by pool address.
7. **Scanner submission** — `submit.ts` builds the C1 attestation
   (112-byte message signed by the activity oracle key via Ed25519) +
   the SDK's phase1 instruction pair, and submits the transaction to
   the on-chain GraveScanner.
8. **Scanner result tracking** — `tracking.ts` monitors the
   EligibilityAnchor and EligibilityCert PDAs to confirm the on-chain
   scanner accepted the submission and later certified the pool.

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
# Install
pnpm install

# Build the SDK first (the indexer depends on it)
pnpm --filter @graveyield/sdk build

# Build the indexer
pnpm --filter @graveyield/indexer build

# Run in discovery-only mode (no on-chain submission)
pnpm --filter @graveyield/indexer start

# Run with on-chain submission (requires the activity oracle key)
ACTIVITY_ORACLE_KEY=<base58-encoded 32-byte Ed25519 secret key> \
RPC_URL=https://api.devnet.solana.com \
pnpm --filter @graveyield/indexer start
```

## Configuration

All configuration is via environment variables with safe defaults:

| Env var | Default | Description |
|---|---|---|
| `RPC_URL` | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `CLUSTER` | `devnet` | `devnet` or `mainnet-beta` |
| `SCANNER_PROGRAM_ID` | devnet ID | GraveScanner program ID |
| `ACTIVITY_ORACLE_KEY` | (none) | base58-encoded 32-byte Ed25519 secret key. If absent, runs in discovery-only mode. |
| `MIN_TVL_LAMPORTS` | `500000000` (0.5 SOL) | Local TVL floor |
| `INACTIVITY_SECONDS` | `7776000` (90d) | Local inactivity threshold |
| `PRICE_COLLAPSE_BPS` | `9900` (99%) | Local price collapse threshold |
| `LP_BURN_DUST_THRESHOLD` | `1000` | LP burn dust threshold |
| `MAX_CANDIDATES_PER_CYCLE` | `5` | Max candidates to submit per scan |
| `POLL_INTERVAL_MS` | `300000` (5min) | Scan loop interval |
| `MAX_POOLS_PER_SCAN` | `1000` | Max pools to enumerate per scan |
| `SIGNATURE_SCAN_LIMIT` | `1000` | Signature scan limit for deriveLastSwapV4 |

## Tests

```bash
# Offline unit tests (pre-filter, queue, scoring, config)
pnpm --filter @graveyield/indexer test

# Or from the repo root
pnpm -r test
```

29 tests covering the six-criterion pre-filter, the candidate queue
(enqueue/drain/peek/dedup), the scoring formula, and the config loader.

## Architecture

```
indexer/src/
  index.ts              — main entry point + GraveScannerV2 loop + re-exports
  scanner.ts            — AmmSource interface + ScannerOptions
  config.ts             — env-driven configuration
  types.ts              — shared types (Candidate, ScoredCandidate, etc.)
  eligibility.ts        — six-criterion pre-filter (preFilterPool)
  sources/raydiumV4.ts  — RaydiumV4Source (pool discovery)
  activity.ts           — ActivityIndexer (cached last-swap derivation)
  reserves.ts           — readReserves + WSOL side identification
  metadata.ts           — readTokenMetadata (3 mints)
  scoring.ts            — scoreCandidate (C1×C3×C2 margin product)
  queue.ts              — CandidateQueue (priority by score)
  submit.ts             — submitCandidate (C1 attestation + phase1 tx)
  tracking.ts           — trackSubmission (monitor Anchor/Cert PDAs)
```

## Relationship to the SDK

The indexer is a consumer of `@graveyield/sdk`. It reuses:
- `deriveLastSwapV4` — for activity indexing
- `fetchV4Pool` / `parseV4AmmInfo` — for pool discovery
- `readVaultReserve` / `readLpMintSupply` — for reserve reading
- `identifyBaseToken` — for the WSOL side guard
- `buildAttestationMessage` / `buildEd25519VerifyInstruction` — for the C1 attestation
- `GraveYieldClient.buildPhase1Ix` — for the phase 1 instruction pair
- `eligibilityAnchorPda` / `eligibilityCertPda` / `fetchEligibilityAnchor` / `fetchEligibilityCert` — for result tracking

## License

Apache-2.0, same as the rest of the GraveYield monorepo.
