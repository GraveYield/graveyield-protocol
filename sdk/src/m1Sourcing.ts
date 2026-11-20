// SPDX-License-Identifier: Apache-2.0
//
// D-01 M1 WSOL quote-side sourcing predicate (GY-M1-ODR-001 §3,
// GY-M1-SPEC-001 §2.1 "C3 M1 sourcing restriction" and §7 item 2).
//
// Owner-approved M1 sourcing predicate — a candidate pool is M1-eligible
// only when ALL three conditions hold:
//
//   1. Exactly one of the two pool mints is WSOL;
//   2. WSOL is the Raydium AMM V4 `pc_mint` (the quote-side mint);
//   3. The other mint (`coin_mint`, the base side) is non-WSOL.
//
// The canonical WSOL mint is the SDK's existing `WSOL_MINT` constant
// (raydiumV4Constants.ts) — this module deliberately does not introduce
// a second WSOL definition.
//
// Field mapping (SDK parser `parseV4AmmInfo`):
//
//   coin_mint  — AmmInfo offset 400 — exposed as `V4PoolAccount.baseMint`
//   pc_mint    — AmmInfo offset 432 — exposed as `V4PoolAccount.quoteMint`
//
// POLICY BOUNDARY: this restriction is M1 sourcing-only. It is NOT a
// settlement-orientation restriction and must not be tightened into the
// settlement-adjacent orientation logic (`identifyBaseToken`'s 7019
// guard, `evaluatePool`'s C3 quote-side TVL math, or the salvage_pool
// builder) — those keep accepting either single-WSOL orientation for
// non-M1 protocol behaviour.
//
// FAIL-CLOSED: missing, malformed, ambiguous or unverifiable orientation
// data is always rejected. Uncertain orientation is never M1-eligible.

import { PublicKey, type Connection } from "@solana/web3.js";

import { WSOL_MINT } from "./raydiumV4Constants.js";
import { fetchV4Pool, type V4PoolAccount } from "./raydiumV4.js";

// ---------------------------------------------------------------------------
// Verdict model
// ---------------------------------------------------------------------------

/**
 * Machine-checkable rejection reasons. Every non-acceptance path maps to
 * exactly one reason so callers (indexer pre-filter, queue, operator
 * artifacts) can record and audit the rejection.
 */
export type M1SourcingRejectionReason =
  /** `coin_mint` is missing (null/undefined) — orientation cannot be established. */
  | "missing-coin-mint"
  /** `pc_mint` is missing (null/undefined) — orientation cannot be established. */
  | "missing-pc-mint"
  /** A mint field is present but not a usable PublicKey — unverifiable data. */
  | "unverifiable-orientation"
  /** Neither mint is WSOL. */
  | "no-wsol-side"
  /** Both mints are WSOL. */
  | "both-sides-wsol"
  /** WSOL sits on `coin_mint` (base side) instead of `pc_mint` (quote side). */
  | "wsol-on-coin-side";

/** A pool that passed the M1 sourcing predicate. */
export interface M1SourcingAccepted {
  accepted: true;
  /** The WSOL mint — always the canonical `WSOL_MINT` constant. */
  wsolMint: PublicKey;
  /** The non-WSOL (`coin_mint` / base-side) mint. */
  memecoinMint: PublicKey;
}

/** A pool that failed the M1 sourcing predicate, with the exact reason. */
export interface M1SourcingRejected {
  accepted: false;
  reason: M1SourcingRejectionReason;
  /** Human-readable detail for logs and operator artifacts. */
  detail: string;
  /** The observed `coin_mint` (base58), or null when it could not be established. */
  coinMint: string | null;
  /** The observed `pc_mint` (base58), or null when it could not be established. */
  pcMint: string | null;
}

export type M1SourcingVerdict = M1SourcingAccepted | M1SourcingRejected;

/**
 * Explicit Raydium V4 orientation fields. Callers that hold a parsed
 * `V4PoolAccount` (or the parsed AmmInfo identity-field subset used by
 * discovery records) may pass it directly — `evaluateM1Sourcing` maps
 * `baseMint` → `coin_mint` and `quoteMint` → `pc_mint` (the parser's
 * documented field mapping above).
 */
export interface M1SourcingOrientation {
  /** Raydium V4 `coin_mint` (AmmInfo @400; the SDK's `baseMint`). */
  coinMint: PublicKey | null | undefined;
  /** Raydium V4 `pc_mint` (AmmInfo @432; the SDK's `quoteMint`). */
  pcMint: PublicKey | null | undefined;
}

/**
 * Parsed AmmInfo identity fields without the pool address — the shape a
 * discovery record embeds (`DiscoveredPool.pool`). Accepted for caller
 * convenience; treated exactly like a full `V4PoolAccount`.
 */
export interface M1SourcingPoolFields {
  coinVault: PublicKey;
  pcVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
}

/** Input accepted by the M1 sourcing guard. */
export type M1SourcingInput = M1SourcingOrientation | V4PoolAccount | M1SourcingPoolFields;

function base58OrNull(mint: PublicKey | null | undefined): string | null {
  if (mint === null || mint === undefined) return null;
  if (!(mint instanceof PublicKey)) return null;
  return mint.toBase58();
}

/**
 * Runtime discriminator: the parsed-pool forms (full `V4PoolAccount` or
 * the identity-field subset) carry baseMint/quoteMint and no explicit
 * orientation fields. A hybrid object that sets coinMint/pcMint is
 * treated as the explicit orientation form (which is authoritative by
 * contract).
 */
function isParsedPool(pool: M1SourcingInput): pool is V4PoolAccount | M1SourcingPoolFields {
  return "baseMint" in pool && "quoteMint" in pool && !("coinMint" in pool) && !("pcMint" in pool);
}

/**
 * Normalize the input into explicit orientation fields. The mapping is
 * the parser's own: `baseMint` IS `coin_mint` and `quoteMint` IS
 * `pc_mint` — this is field naming, never token-orientation rewriting.
 */
function orientationOf(pool: M1SourcingInput): M1SourcingOrientation {
  if (isParsedPool(pool)) {
    return { coinMint: pool.baseMint, pcMint: pool.quoteMint };
  }
  return { coinMint: pool.coinMint, pcMint: pool.pcMint };
}

/**
 * Evaluate the D-01 M1 WSOL quote-side sourcing predicate. Pure, total
 * and fail-closed: every uncertain input resolves to a rejection, never
 * to an acceptance.
 */
export function evaluateM1Sourcing(pool: M1SourcingInput): M1SourcingVerdict {
  const { coinMint, pcMint } = orientationOf(pool);

  if (coinMint === null || coinMint === undefined) {
    return {
      accepted: false,
      reason: "missing-coin-mint",
      detail: "coin_mint is missing — pool orientation cannot be established",
      coinMint: null,
      pcMint: base58OrNull(pcMint),
    };
  }
  if (pcMint === null || pcMint === undefined) {
    return {
      accepted: false,
      reason: "missing-pc-mint",
      detail: "pc_mint is missing — pool orientation cannot be established",
      coinMint: base58OrNull(coinMint),
      pcMint: null,
    };
  }
  if (!(coinMint instanceof PublicKey) || !(pcMint instanceof PublicKey)) {
    return {
      accepted: false,
      reason: "unverifiable-orientation",
      detail: "mint fields are not usable PublicKeys — orientation is unverifiable",
      coinMint: base58OrNull(coinMint),
      pcMint: base58OrNull(pcMint),
    };
  }

  const coinIsWsol = coinMint.equals(WSOL_MINT);
  const pcIsWsol = pcMint.equals(WSOL_MINT);

  if (coinIsWsol && pcIsWsol) {
    return {
      accepted: false,
      reason: "both-sides-wsol",
      detail: `both mints are WSOL — coin=${coinMint.toBase58()}, pc=${pcMint.toBase58()}`,
      coinMint: coinMint.toBase58(),
      pcMint: pcMint.toBase58(),
    };
  }
  if (!coinIsWsol && !pcIsWsol) {
    return {
      accepted: false,
      reason: "no-wsol-side",
      detail: `neither mint is WSOL — coin=${coinMint.toBase58()}, pc=${pcMint.toBase58()}`,
      coinMint: coinMint.toBase58(),
      pcMint: pcMint.toBase58(),
    };
  }
  if (coinIsWsol && !pcIsWsol) {
    return {
      accepted: false,
      reason: "wsol-on-coin-side",
      detail: `WSOL is coin_mint (base side) — M1 requires WSOL on pc_mint (quote side): coin=${coinMint.toBase58()}, pc=${pcMint.toBase58()}`,
      coinMint: coinMint.toBase58(),
      pcMint: pcMint.toBase58(),
    };
  }

  return {
    accepted: true,
    wsolMint: pcMint,
    memecoinMint: coinMint,
  };
}

// ---------------------------------------------------------------------------
// Guard (throwing) form + fetch-based candidate acceptance
// ---------------------------------------------------------------------------

/** Error thrown by the M1 sourcing guard when a pool is not M1-eligible. */
export class M1SourcingError extends Error {
  readonly reason: M1SourcingRejectionReason;
  readonly verdict: M1SourcingRejected;

  constructor(verdict: M1SourcingRejected) {
    super(`M1 sourcing rejected (D-01): ${verdict.reason} — ${verdict.detail}`);
    this.name = "M1SourcingError";
    this.reason = verdict.reason;
    this.verdict = verdict;
  }
}

/**
 * Assert the D-01 M1 sourcing predicate. Returns the acceptance (with
 * the WSOL / memecoin mints) or throws `M1SourcingError`.
 */
export function assertM1Sourcing(pool: M1SourcingInput): M1SourcingAccepted {
  const verdict = evaluateM1Sourcing(pool);
  if (!verdict.accepted) throw new M1SourcingError(verdict);
  return verdict;
}

/**
 * Fetch a Raydium V4 pool account and assert the D-01 M1 sourcing
 * predicate against the freshly parsed fields. This is the SDK-level
 * candidate-acceptance guard: it runs AFTER any earlier discovery filter
 * and independently re-validates the pool from chain state.
 *
 * Fail-closed end to end:
 *   - a missing account, a non-Raydium owner or a non-canonical layout
 *     throws from `fetchV4Pool` (never swallowed here);
 *   - a parsed pool with the wrong orientation throws `M1SourcingError`.
 */
export async function assertM1SourcingForPool(
  connection: Connection,
  poolAddress: PublicKey,
): Promise<M1SourcingAccepted> {
  const pool = await fetchV4Pool(connection, poolAddress);
  return assertM1Sourcing(pool);
}
