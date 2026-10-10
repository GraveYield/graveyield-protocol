// SPDX-License-Identifier: Apache-2.0
//
// Phase 12 adversarial battery — threat-class taxonomy and verdict model.
//
// Roadmap Phase 12 ("Security + economic testnet") demands that the
// protocol be attacked deliberately, across fifteen enumerated threat
// classes, with one goal:
//
//   > Prove that GraveYield refuses to act when its assumptions aren't
//   > satisfied. That's more important than proving that it works when
//   > everything is normal.
//
// This module is the battery's spine:
//
//   * THREAT_CLASSES — the fifteen classes from the roadmap row, in
//     roadmap order. Every attack case in the battery cites exactly one
//     class; the manifest test proves the mapping is total (no class
//     without a case, no case without a class).
//   * Verdict kinds — every case resolves to exactly one of:
//       refused  — the protocol reverted the attack (the happy outcome)
//       pinned   — behavior consciously accepted and pinned so the
//                  audit sees it on purpose (e.g. no upper TVL bound)
//       finding  — a gap the battery surfaced; recorded for the audit
//                  (Phase 13) with a stable F-id in docs/ADVERSARY.md
//   * The ADV-* id space mirrors the Rust-side battery (host + fork
//     tests use the same ids) so a single table in docs/ADVERSARY.md
//     covers both languages.

/** The fifteen roadmap threat classes, in roadmap order. */
export const THREAT_CLASSES = [
  "fake-dead-pools",
  "active-pools",
  "manipulated-prices",
  "fake-timestamps",
  "malicious-lp-accounts",
  "malicious-cpi-accounts",
  "malformed-jupiter-routes",
  "expired-certificates",
  "repeated-salvage-attempts",
  "competing-salvors",
  "failed-transactions",
  "partial-failures",
  "dust",
  "extreme-liquidity",
  "token-decimals-edge-cases",
] as const;

export type ThreatClass = (typeof THREAT_CLASSES)[number];

/** How the protocol responded to the attack. */
export type VerdictKind =
  /** The protocol refused the attack — expected, asserted by a test. */
  | "refused"
  /** Behavior consciously accepted and pinned for the audit. */
  | "pinned"
  /** A gap surfaced by the battery — logged for Phase 13 (audit). */
  | "finding";

/** Where in the stack the case executes. */
export type BatteryLayer =
  | "rust-host" //   cargo test (pure host logic)
  | "rust-fork" //   cargo test --test *_fork (in-process VM, live state)
  | "ts-sdk" //      SDK builders/decoders/math
  | "ts-indexer" //  pipeline pre-filter/scoring/queue
  | "ts-ops" //      observer/merkle fail-closed services
  | "fleet"; //      salvor-bots (Scout/executor/adversarial races)

/** One entry in the battery's case registry (mirrors the test files). */
export interface AdversaryCase {
  /** Stable id, e.g. `ADV-ID-01`. Prefixes: ID identity, TS timestamps,
   *  MP prices, LP accounts, CPI cpi-accounts, RT routes, CE certs,
   *  RP replay, CS competing salvors, FT failed/partial tx, DS dust,
   *  EL extreme liquidity, DC decimals, FM manifest/meta. */
  id: string;
  threatClass: ThreatClass;
  title: string;
  layer: BatteryLayer;
  verdict: VerdictKind;
  /** For `refused`: the expected on-chain error code(s) or refusal name. */
  expected?: string;
  /** For `finding`: the F-id in docs/ADVERSARY.md. */
  finding?: string;
  /** One-line statement of what is proven. */
  proves: string;
}

/**
 * The TS-side registry. The Rust-side cases (ADV-* in criteria.rs,
 * adapters, salvage_pool.rs, and the fork suite) are catalogued in
 * docs/ADVERSARY.md and cross-referenced by id; the manifest test pins
 * this registry's integrity (unique ids, total class coverage).
 */
export const CASES: readonly AdversaryCase[] = [
  // ---- fake-dead-pools -------------------------------------------------
  {
    id: "ADV-ID-01",
    threatClass: "fake-dead-pools",
    title: "attestation bound to pool A cannot vouch for pool B (byte-level binding)",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "6027 AttestationBindingMismatch (on-chain); byte-level pin here",
    proves:
      "the 112-byte message embeds (amm,pool) immutably — a re-labeled message is a different message and the on-chain binding check refuses it",
  },
  {
    id: "ADV-ID-02",
    threatClass: "fake-dead-pools",
    title: "launch-price message bound to a different token pair than the live pool",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "6033 LaunchPriceMintMismatch (on-chain); pre-submit detection here",
    proves:
      "readV4PoolPair extracts the pool's own mints so the Scout can detect a C2 message minted for another pair before ever paying a fee",
  },
  {
    id: "ADV-ID-03",
    threatClass: "fake-dead-pools",
    title: "pool that never swapped cannot produce attestable inactivity evidence",
    layer: "ts-indexer",
    verdict: "pinned",
    expected: "noSwapFound counts as maximally dead off-chain; on-chain C2 refuses zero launch price",
    proves:
      "absence-of-swings is treated as dead by the wide funnel, but the narrow authority (chain) refuses any pool without a recorded launch price — defense in depth, not trust",
  },
  // ---- active-pools ----------------------------------------------------
  {
    id: "ADV-ID-04",
    threatClass: "active-pools",
    title: "recently active pool fails the indexer pre-filter (C1)",
    layer: "ts-indexer",
    verdict: "refused",
    expected: "C1-inactivity in failedCriteria",
    proves: "the wide funnel never queues an active pool for submission",
  },
  // ---- manipulated-prices ----------------------------------------------
  {
    id: "ADV-MP-01",
    threatClass: "manipulated-prices",
    title: "price collapse math clamps and follows live reserves, not trusted input",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "drop clamped to 10_000 bps; zero base reserve refused",
    proves:
      "current price is always recomputed from on-chain reserve bytes (quote-per-base) — a manipulated caller-supplied price has no path into C2",
  },
  {
    id: "ADV-MP-02",
    threatClass: "manipulated-prices",
    title: "fee ceiling: a priority fee above the Charter ceiling is rejected",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "shouldRejectFee true / computeBudgetIxs throws",
    proves: "operators cannot opt out of the Charter fee ceiling",
  },
  // ---- fake-timestamps -------------------------------------------------
  {
    id: "ADV-TS-01",
    threatClass: "fake-timestamps",
    title: "attestation slotHash guard: a non-32-byte slot hash cannot enter the wire format",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "buildAttestationMessage throws",
    proves: "the last layer of the freshness chain (slot binding) cannot be weakened client-side",
  },
  {
    id: "ADV-TS-02",
    threatClass: "fake-timestamps",
    title: "adversarial timestamp/slot values round-trip losslessly (no client coercion)",
    layer: "ts-sdk",
    verdict: "pinned",
    expected: "zero/future values parse byte-exact; semantics enforced on-chain (6028/6029/6031)",
    proves:
      "the client is a byte pipe, not a validator — fake timestamps are the CHAIN's problem and the chain refuses them (Rust ADV-TS-01 + fork freshness matrix)",
  },
  // ---- malicious-lp-accounts -------------------------------------------
  {
    id: "ADV-LP-01",
    threatClass: "malicious-lp-accounts",
    title: "decoders fail closed on wrong discriminators, short and truncated accounts",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "assertDiscriminator throws / reader underflow throws",
    proves:
      "hostile account bytes (wrong owner program, truncated body, spoofed discriminant) can never decode into a trusted shape",
  },
  {
    id: "ADV-LP-02",
    threatClass: "malicious-lp-accounts",
    title: "trailing bytes after a valid account body are tolerated (Anchor-compatible)",
    layer: "ts-sdk",
    verdict: "finding",
    finding: "F8",
    proves:
      "decoders do not reject extra trailing bytes — pinned as intended (Anchor space reallocation) and flagged for the audit to confirm",
  },
  {
    id: "ADV-LP-03",
    threatClass: "malicious-lp-accounts",
    title: "claim ceiling: books where claims exceed the receipt's LP share raise the anomaly",
    layer: "ts-ops",
    verdict: "refused",
    expected: "claim-accounting-anomaly (C2)",
    proves: "a malicious bookkeeping state is detected by the standing observer",
  },
  // ---- malformed-jupiter-routes ----------------------------------------
  {
    id: "ADV-RT-01",
    threatClass: "malformed-jupiter-routes",
    title: "salvage builder refuses a non-32-byte Merkle root",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "buildSalvagePoolIx throws",
    proves: "a truncated snapshot root cannot silently weaken the LP claim tree",
  },
  {
    id: "ADV-RT-02",
    threatClass: "malformed-jupiter-routes",
    title: "salvage builder refuses Raydium remaining_accounts ≠ 13",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "buildSalvagePoolIx throws (12 and 14 both)",
    proves: "the CPI account contract is exact — scrambled CPI lists never reach the wire",
  },
  {
    id: "ADV-RT-03",
    threatClass: "malformed-jupiter-routes",
    title: "salvage builder refuses a truncated Jupiter route account list",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "buildSalvagePoolIx throws on missing route account",
    proves: "route accounts are bound to their declared length before submission",
  },
  {
    id: "ADV-RT-04",
    threatClass: "malformed-jupiter-routes",
    title: "route-leg economics refuse an empty or inconsistent quote",
    layer: "fleet",
    verdict: "refused",
    expected: "estimateSalvageEconomics reject('route-failure')",
    proves: "a malformed route cannot manufacture proceeds in the executor's economics",
  },
  // ---- malicious-cpi-accounts ------------------------------------------
  {
    id: "ADV-CPI-05",
    threatClass: "malicious-cpi-accounts",
    title: "the salvage builder pins the Jupiter v6 program and the real Raydium authority into the account list",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "keys embed JUPITER_V6_PROGRAM_ID and RAYDIUM_V4_AMM_AUTHORITY at their canonical slots",
    proves:
      "a caller cannot re-point the CPI at an impostor program or a fake AMM authority client-side — the substitution refusal (7013) is fork-proven and the wire shape cannot even express it",
  },
  // ---- expired-certificates --------------------------------------------
  {
    id: "ADV-CE-01",
    threatClass: "expired-certificates",
    title: "expiry semantics visible to every client layer (decode + boundary)",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "decodeEligibilityCert reads expiresAt; fleet revalidate refuses cert-expired",
    proves:
      "certificates age out everywhere consistently; the chain's 7002/6034 gates (fork-proven) are mirrored client-side",
  },
  {
    id: "ADV-CE-02",
    threatClass: "expired-certificates",
    title: "cert TTL below the 600 s floor is refused at initialize (fork)",
    layer: "rust-fork",
    verdict: "refused",
    expected: "6019 CertTtlBelowMinimum",
    proves: "a short-lived cert cannot be configured into existence",
  },
  // ---- repeated-salvage-attempts ---------------------------------------
  {
    id: "ADV-RP-01",
    threatClass: "repeated-salvage-attempts",
    title: "replay refusal codes decode consistently across the whole family",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "6034/7002/7011/7021 decode to their stable names",
    proves:
      "every replay guard has a stable code the fleet can branch on — replays are refused at anchor, cert, claim-record and dust layers",
  },
  {
    id: "ADV-RP-02",
    threatClass: "repeated-salvage-attempts",
    title: "Merkle artifacts fail closed on any tampering",
    layer: "ts-ops",
    verdict: "refused",
    expected: "integrity hash / root rebuild / proof verification all reject",
    proves: "a replayed or doctored snapshot cannot mint a second claim reality",
  },
  // ---- competing-salvors -----------------------------------------------
  {
    id: "ADV-CS-01",
    threatClass: "competing-salvors",
    title: "one pool, many racing executors — exactly one proceeds, others suppressed",
    layer: "fleet",
    verdict: "refused",
    expected: "duplicate-suppressed / lease-conflict for the losers",
    proves: "the fleet's at-most-once layer turns internal competition into zero double-submission",
  },
  {
    id: "ADV-CS-02",
    threatClass: "competing-salvors",
    title: "external competing Salvor is refused on-chain by the init-once registry",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "second salvage reverts (init constraint) — fork pause_gates..._oneshot",
    proves: "first-wins is enforced by the chain, not by politeness between bots",
  },
  {
    id: "ADV-CS-03",
    threatClass: "competing-salvors",
    title: "fleet revalidation does not pre-read the PoolRegistry — a lost race is discovered at simulation, not before",
    layer: "fleet",
    verdict: "finding",
    finding: "F3",
    proves:
      "the executor layer wastes one simulation on a pool another Salvor already settled; the chain still refuses, but the pre-check is a cheap hardening the audit should weigh",
  },
  // ---- failed-transactions ---------------------------------------------
  {
    id: "ADV-FT-01",
    threatClass: "failed-transactions",
    title: "error decoding surfaces every on-chain refusal with hex + name",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "decodeGraveYieldErrorCode covers 6000-6034 and 7000-7021",
    proves: "failed transactions are diagnosable — no silent or opaque failure classes",
  },
  {
    id: "ADV-FT-02",
    threatClass: "failed-transactions",
    title: "unknown error codes decode to undefined (fail-open by design, flagged)",
    layer: "ts-sdk",
    verdict: "finding",
    finding: "F9",
    proves:
      "a future program upgrade's new codes render as undefined in old SDKs — consumers must treat undefined as 'unknown, refuse to auto-retry'",
  },
  // ---- partial-failures ------------------------------------------------
  {
    id: "ADV-FT-03",
    threatClass: "partial-failures",
    title: "below the dust threshold the swap leg is skipped (floor not enforced) — by design",
    layer: "ts-sdk",
    verdict: "pinned",
    expected: "jupiterDustThresholdLamports semantics (D6); fork-proven sweep path",
    proves:
      "sub-dust memecoin remnants are retained, not swapped — flagged so the audit confirms the economics consciously",
  },
  // ---- dust -------------------------------------------------------------
  {
    id: "ADV-DS-01",
    threatClass: "dust",
    title: "indexer dust boundary: LP supply exactly at the threshold is refused",
    layer: "ts-indexer",
    verdict: "refused",
    expected: "C4-lp-not-burned at supply == threshold",
    proves: "the wide funnel and the chain agree on the dust boundary (strict >)",
  },
  {
    id: "ADV-DS-02",
    threatClass: "dust",
    title: "dust sweep is one-shot and refuses a second run",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "7021 DustAlreadySwept / 7020 DustNothingToSweep decode",
    proves: "dust handling cannot be re-run to drip the treasury",
  },
  // ---- extreme-liquidity ------------------------------------------------
  {
    id: "ADV-EL-01",
    threatClass: "extreme-liquidity",
    title: "no upper TVL bound — whale pools pass every filter",
    layer: "ts-indexer",
    verdict: "finding",
    finding: "F2",
    proves:
      "deliberately uncapped; the economic rails (slippage floor, share split, fee ceiling) are the protection — audit to weigh a cap",
  },
  {
    id: "ADV-EL-02",
    threatClass: "extreme-liquidity",
    title: "executor economics stay exact at u64::MAX reserves and supplies",
    layer: "fleet",
    verdict: "refused",
    expected: "no RangeError, integer math exact, break-even coherent",
    proves: "extreme-but-valid pools produce exact economics, not NaN or overflow",
  },
  // ---- token-decimals-edge-cases ----------------------------------------
  {
    id: "ADV-DC-01",
    threatClass: "token-decimals-edge-cases",
    title: "price math is exact across decimal extremes (0..18 shape via reserve ratios)",
    layer: "ts-sdk",
    verdict: "refused",
    expected: "quotePerBaseQ64x64 exact in u128; zero base reserve refused (0n)",
    proves: "decimal-agnostic Q64.64 math cannot be descaled by weird tokens",
  },
  {
    id: "ADV-DC-02",
    threatClass: "token-decimals-edge-cases",
    title: "settlement split conserves at every total including 1 lamport (fork + host)",
    layer: "rust-host",
    verdict: "refused",
    expected: "split_proceeds conservation (Rust ADV-ST-01/02)",
    proves: "no decimals configuration can strand or duplicate value between shares",
  },
] as const;
