# ADVERSARY — the Phase 12 attack battery

> Roadmap Phase 12 ("Security + economic testnet") demands that the
> protocol be attacked deliberately. Its goal, verbatim:
>
> > Prove that GraveYield refuses to act when its assumptions aren't
> > satisfied. That's more important than proving that it works when
> > everything is normal.

This document catalogues the battery: the fifteen roadmap threat
classes, the concrete attack cases pinned against real protocol logic
in both repos, and the findings ledger the battery produced for the
Phase 13 audit. Every case carries a stable `ADV-*` id shared between
this table, the Rust test names, and the TypeScript suite.

## 1. How to run

```bash
# The TypeScript battery (offline, real SDK/indexer/ops logic):
pnpm --filter @graveyield/adversary test          # 39 cases

# The Rust host battery (pure logic, no fixtures needed):
cargo test -p grave-scanner                        # includes ADV-* host tests
cargo test -p grave-vault --lib                    # includes ADV-ST-* tests

# The fork battery (in-process VM over live mainnet state; needs
# fixtures + ELFs — see scripts/build_fork_harness.sh):
cargo test -p grave-vault --test security_negative_fork

# The fleet battery (salvor-bots repo):
pnpm --filter @graveyield/fleet-core test          # ADV-FLEET cases
pnpm --filter @graveyield/scout test               # ADV-SCOUT cases
```

The battery is offline by construction. Fakes exist only at the RPC
boundary (`FakeConnection`, `ChainView` object literals); the logic
under attack is always the real SDK, indexer, ops, and program code.

## 2. The fifteen threat classes and their verdicts

| # | Roadmap class | Battery cases | Verdict |
|---|---------------|---------------|---------|
| 1 | fake-derelict pools | ADV-ID-01/02/03, ADV-FD-03 (Rust), ADV-FK-01 (fork) | refused + 1 pinned |
| 2 | active pools | ADV-ID-04, ADV-AP-02 (Rust), ADV-SCOUT C1 | refused |
| 3 | manipulated prices | ADV-MP-01/02, ADV-MP-07 (Rust), ADV-SCOUT C2-baseline | refused |
| 4 | fake timestamps | ADV-TS-01/02/03, ADV-TS-01 (Rust 6005), fork freshness matrix | refused + 1 pinned |
| 5 | malicious LP accounts | ADV-LP-01/02/03, ADV-LP-01..05 (Rust), ADV-FK-01 (7018) | refused + 1 finding (F8) |
| 6 | malicious CPI accounts | ADV-CPI-01..04 (Rust), ADV-CPI-05, fork authority substitution | refused |
| 7 | malformed Jupiter routes | ADV-RT-01..05, ADV-RT-04 (fleet) | refused |
| 8 | expired certificates | ADV-CE-01/02, fork 7002/6034/6019 | refused |
| 9 | repeated salvage attempts | ADV-RP-01/02/03, fork one-shot tests | refused |
| 10 | competing Salvors | ADV-CS-01/02 (fleet + fork), ADV-CS-03 (F3) | refused + 1 finding (F3) |
| 11 | failed transactions | ADV-FT-01/02, ops X1 sweep | refused + 1 finding (F9) |
| 12 | partial failures | ADV-FT-03, fork atomicity tests | 1 pinned |
| 13 | dust | ADV-DS-01/02, ADV-DS-04 (Rust), fork 7020/7021 | refused |
| 14 | extreme liquidity | ADV-EL-01 (F2), ADV-EL-02, ADV-EL-06 (Rust) | 1 finding (F2) + pinned |
| 15 | token decimals edge cases | ADV-DC-01/02, ADV-DC-03/08 (Rust) | refused |

## 3. Layer map — where each refusal lives

The battery attacks four independent layers. A fake-derelict pool, for
example, must survive ALL of them to reach settlement — and each layer
refuses it for a different reason:

1. **Indexer pre-filter** (`indexer/src/eligibility.ts`) — the wide
   funnel: inactivity window, TVL floor, LP dust. Cheap, cached,
   advisory.
2. **On-chain GraveScanner** (`programs/grave-scanner/src/criteria.rs`)
   — the narrow authority: six criteria over oracle-signed evidence,
   attestation freshness (SlotHashes), launch-price binding, epoch
   confirmation. Certificates expire (6034/7002).
3. **On-chain GraveVault preflight** (`salvage_pool.rs`) — orientation,
   snapshot binding (7018), CPI account pinning (7013), route vetting,
   slippage floor (7007), one-shot init-once PDAs.
4. **Client gates** (SDK builders + Scout admission + fleet
   revalidation/estimator) — byte-locked wire contracts, fail-closed
   decoders, Charter fee ceiling, monitor-only when chain state exists.

## 4. Findings ledger (for the Phase 13 audit)

The battery did not only prove refusals — it surfaced gaps and
conscious design trade-offs. Each is pinned by a test so its behavior
cannot drift silently.

- **F1 — fee-plan unit mismatch (known, pre-existing).**
  `computeOperationalMaxLamportsPerCu` computes a per-CU price from a
  total-lamports budget; the D3-correct `derivePriorityFeePlan` exists
  in the fleet fork. The battery pins current SDK semantics
  (ADV-MP-02); the audit should confirm the migration plan.
- **F2 — no upper TVL bound (pinned, ADV-EL-01 / ADV-EL-06).** Whale
  pools pass every eligibility layer by design. The economic rails
  (slippage floor, share split, fee ceiling, dust thresholds) are the
  protection; a cap is a product decision for the audit to weigh.
- **F3 — fleet revalidation does not pre-read `PoolRegistry`**
  (ADV-CS-03). A pool already settled by a competing Salvor is
  discovered at simulation, not before. The chain refuses (init-once),
  so the cost is one wasted simulation — a cheap pre-check is
  recommended hardening.
- **F5 — expired leases are silently stealable** (pinned,
  ADV-FLEET F5 case). No fencing token; the chain's init-once PDAs are
  the real backstop. Single-process today by documented non-goal.
- **F8 — decoders tolerate trailing account bytes** (pinned,
  ADV-LP-02). Anchor-compatible (reserved space in upgrades); audit to
  confirm the trade-off.
- **F9 — unknown error codes decode to `undefined`** (pinned,
  ADV-FT-02). Fail-open by design for consumers; consumers must treat
  `undefined` as "unknown — do not auto-retry". A program upgrade that
  adds codes should ship the SDK table in the same release.
- **GOV gap noted by the Rust battery (unpinned):**
  `price_collapse_bps > 10_000` (6006) and the whole
  `sweep_stale_anchor` instruction are currently untested at handler
  level; flagged for the audit scope, not regressions.

## 5. Fixtures and the fork suites

The fork suites run the real compiled programs in
`solana-program-test` against byte-exact mainnet accounts fetched by
`scripts/fetch_v4_fork_fixtures.mjs`. The fixtures and ELFs are
gitignored artifacts; suites that need them skip cleanly when absent.
The Phase 12 fork additions (ADV-FK-01/02/03 in
`security_negative_fork.rs`) follow the same contract: they
compile-validated and skip without artifacts, and run end-to-end via
`scripts/build_fork_harness.sh` once the Solana SBF toolchain is
present (it was absent in the Phase 12 session after a sandbox
rollback; the host and TS batteries need nothing beyond stock cargo
and pnpm).

## 6. Verdict discipline

- `refused` — the protocol reverted the attack; asserted by a test
  with the exact error code (or the exact builder/decoder throw).
- `pinned` — behavior consciously accepted; a test freezes it so it
  cannot drift, and this document explains why it is safe.
- `finding` — a gap the battery surfaced; recorded above with an F-id
  and left for the Phase 13 audit to weigh, never silently "fixed".

The manifest suite (`adversary/test/manifest.adversary.test.ts`)
enforces the registry's integrity: every roadmap class keeps at least
one case, ids stay unique, refused cases must name their expected
refusal, and refusals must remain the battery's center of gravity.
