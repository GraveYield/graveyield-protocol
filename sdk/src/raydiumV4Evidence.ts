// SPDX-License-Identifier: Apache-2.0
//
// Canonical Raydium V4 economic-swap classification (spec D4, ADR D4 /
// R-22; Deliverable 3 §6 "Historical Transaction Evidence Requirements").
//
// This module is the SINGLE SOURCE OF TRUTH for deciding whether a
// candidate transaction contains a verified economic swap on a given
// Raydium V4 pool (the only interaction that may reset pool inactivity
// for Criterion 1). The dedicated indexer consumes this logic through
// the SDK; nothing else may re-implement it (D7).
//
// ---------------------------------------------------------------------------
// Authoritative instruction semantics (verified 2026-11-14 against three
// independent sources):
//
//   1. raydium-io/raydium-amm, program/src/instruction.rs —
//      `AmmInstruction::unpack` matches on the FIRST DATA BYTE:
//        1 Initialize2, 3 Deposit, 4 Withdraw, 6 SetParams, 7 WithdrawPnl,
//        9 SwapBaseIn, 11 SwapBaseOut, 14 CreateConfigAccount,
//        15 UpdateConfigAccount, 16 SwapBaseInV2, 17 SwapBaseOutV2,
//        18 WithdrawExcessLamports; tags 0/2/5/8/10/12/13 are not supported.
//   2. docs.raydium.io "AMM v4 instructions" — the 2026-07 program upgrade
//      removed the OpenBook/Serum dependency (market accounts accepted but
//      ignored for v1 swaps); SwapBaseInV2/SwapBaseOutV2 (tags 16/17) are the
//      canonical 8-account swap entrypoints the Raydium router always uses;
//      the seven removed tags now revert (`unimplemented!`). The 2026-09
//      upgrade added `WithdrawExcessLamports` (tag 18).
//   3. Live mainnet evidence (2026-11-14): SwapBaseInV2 (tag 16) dominates
//      current swap traffic; SwapBaseIn (tag 9) appears inside aggregator
//      CPIs and in version-0 and version-1 transactions.
//
// Classification requirements (D4):
//   * A verified economic swap requires ALL of:
//       - the transaction succeeded (meta.err === null),
//       - a Raydium V4 program instruction whose data carries a swap tag
//         (9/11/16/17) and whose account list includes the pool (amm) account,
//       - the pool's two authoritative vault addresses (from the on-chain
//         AmmInfo, NOT inferred from instruction layout — the v1 layouts have
//         an optional target-orders account that shifts indices) appear in
//         the instruction accounts, and
//       - the transaction's pre/post token balances show both vaults moving
//         by nonzero amounts in OPPOSITE directions (the same economic
//         predicate `deriveLaunchPriceV4` already uses; deposits and
//         withdrawals move both vaults in the SAME direction, and pool
//         initialization sets both from zero).
//   * Everything that cannot be reliably established remains UNRESOLVED
//     (fail-closed): ambiguous or malformed evidence, conflicting vault
//     movement, missing/malformed transaction metadata, missing or invalid
//     block time, unavailable corroboration data.
//   * Non-economic V4 interactions (liquidity, admin, initialization) and
//     failed transactions are classified NOT economic — they provably did
//     not swap.
// ---------------------------------------------------------------------------

import { PublicKey } from "@solana/web3.js";

import { decodeInstructionData } from "./base58.js";

// ----- authoritative tag table --------------------------------------------

export const V4_TAG_INITIALIZE2 = 1;
export const V4_TAG_DEPOSIT = 3;
export const V4_TAG_WITHDRAW = 4;
export const V4_TAG_SET_PARAMS = 6;
export const V4_TAG_WITHDRAW_PNL = 7;
export const V4_TAG_SWAP_BASE_IN = 9;
export const V4_TAG_SWAP_BASE_OUTPUT = 11;
export const V4_TAG_CREATE_CONFIG_ACCOUNT = 14;
export const V4_TAG_UPDATE_CONFIG_ACCOUNT = 15;
export const V4_TAG_SWAP_BASE_IN_V2 = 16;
export const V4_TAG_SWAP_BASE_OUT_V2 = 17;
export const V4_TAG_WITHDRAW_EXCESS_LAMPORTS = 18;

/** Instruction tags that constitute an economic swap when verified. */
export const RAYDIUM_V4_SWAP_TAGS: ReadonlySet<number> = new Set([
  V4_TAG_SWAP_BASE_IN,
  V4_TAG_SWAP_BASE_OUTPUT,
  V4_TAG_SWAP_BASE_IN_V2,
  V4_TAG_SWAP_BASE_OUT_V2,
]);
/** Liquidity operations — never reset inactivity. */
export const RAYDIUM_V4_LIQUIDITY_TAGS: ReadonlySet<number> = new Set([
  V4_TAG_DEPOSIT,
  V4_TAG_WITHDRAW,
]);
/** Pool initialization — never resets inactivity. */
export const RAYDIUM_V4_INITIALIZATION_TAGS: ReadonlySet<number> = new Set([V4_TAG_INITIALIZE2]);
/** Administrative / upkeep operations — never reset inactivity. */
export const RAYDIUM_V4_ADMIN_TAGS: ReadonlySet<number> = new Set([
  V4_TAG_SET_PARAMS,
  V4_TAG_WITHDRAW_PNL,
  V4_TAG_CREATE_CONFIG_ACCOUNT,
  V4_TAG_UPDATE_CONFIG_ACCOUNT,
  V4_TAG_WITHDRAW_EXCESS_LAMPORTS,
]);
/**
 * Tags the deployed program rejects (`unimplemented!` — docs "removed /
 * no longer callable"): a SUCCESSFUL transaction cannot contain an executed
 * instruction with one of these tags. Their presence is contradictory
 * evidence and fail-closes to unresolved.
 */
export const RAYDIUM_V4_REMOVED_TAGS: ReadonlySet<number> = new Set([0, 2, 5, 8, 10, 12, 13]);

export type RaydiumV4SwapTag = "swapBaseIn" | "swapBaseOutput" | "swapBaseInV2" | "swapBaseOutV2";

export const RAYDIUM_V4_SWAP_TAG_NAMES: ReadonlyMap<number, RaydiumV4SwapTag> = new Map([
  [V4_TAG_SWAP_BASE_IN, "swapBaseIn"],
  [V4_TAG_SWAP_BASE_OUTPUT, "swapBaseOutput"],
  [V4_TAG_SWAP_BASE_IN_V2, "swapBaseInV2"],
  [V4_TAG_SWAP_BASE_OUT_V2, "swapBaseOutV2"],
]);

// ----- outcome taxonomy ----------------------------------------------------

/**
 * Why a candidate could not be classified as a verified swap OR as a
 * provable non-swap (fail-closed per D4.5 / D5). Missing or incomplete
 * evidence MUST stay unresolved — it is never silently converted into a
 * valid inactivity determination.
 */
export type UnresolvedEvidenceReason =
  /** Signature confirmation status is not `finalized` (ADR D5). */
  | "signature_not_finalized"
  /** getTransaction returned nothing for the signature / fetch failed. */
  | "transaction_data_missing"
  /** Transaction metadata absent. */
  | "transaction_meta_missing"
  /**
   * `meta.err` is absent — the RPC response does not record whether the
   * transaction succeeded or failed. Only an EXPLICIT `meta.err === null`
   * may establish transaction success (Correction 001 §2).
   */
  | "transaction_status_missing"
  /** blockTime absent from the signature status or the transaction. */
  | "block_time_missing"
  /** blockTime present but not a valid unix timestamp. */
  | "block_time_invalid"
  /** Account keys / instruction structure could not be resolved. */
  | "malformed_transaction_metadata"
  /** Evidence that cannot be reliably established either way. */
  | "ambiguous_evidence"
  /** Evidence claims contradict observed transaction effects. */
  | "conflicting_evidence"
  /** Pool AmmInfo unavailable — vault corroboration impossible. */
  | "pool_vaults_unavailable"
  /**
   * `meta.innerInstructions` is missing or null — the RPC did not record
   * the transaction's inner (CPI) instructions. Unavailable inner evidence
   * is NOT proof that no inner instructions occurred (Correction 001 §2):
   * without it, a same-transaction inner-CPI swap on this pool cannot be
   * ruled out, so no definitive non-swap conclusion is possible.
   */
  | "inner_instructions_unavailable"
  /** pre/post token balance data not returned by the RPC. */
  | "incomplete_rpc_response";

/** Why a candidate is provably NOT an economic swap. */
export type NotEconomicSwapReason =
  | "failed_transaction"
  | "liquidity_addition"
  | "liquidity_removal"
  | "pool_initialization"
  | "administrative_operation"
  /** A V4 interaction with a non-swap, non-liquidity purpose. */
  | "non_economic_invocation"
  /** The pool account was not invoked by the AMM program at all. */
  | "pool_not_invoked_by_amm_program";

export type SwapCandidateOutcome =
  | {
      kind: "verified_swap";
      tag: RaydiumV4SwapTag;
      /** True when the swap instruction executed as a CPI (inner instruction). */
      routedViaInnerInstruction: boolean;
    }
  | { kind: "not_economic_swap"; reason: NotEconomicSwapReason }
  | { kind: "unresolved"; reason: UnresolvedEvidenceReason };

// ----- normalized transaction view -----------------------------------------

/** Minimal compiled-instruction view (outer or inner). */
export interface CompiledInstructionView {
  programIdIndex: number;
  /** Account references: indexes into the resolved account-key list, or
   *  already-resolved public keys (parsed-encoding responses). */
  accounts: ReadonlyArray<number | PublicKey>;
  /** Instruction data: raw bytes, or a base58 string (JSON-encoding
   *  `meta.innerInstructions`). */
  data: Uint8Array | string;
}

/** Minimal token-balance view (`meta.preTokenBalances` entries). */
export interface TokenBalanceView {
  accountIndex: number;
  uiTokenAmount: { amount: string };
}

/**
 * Normalized candidate-transaction view consumed by the classifier.
 * Built from a web3.js `TransactionResponse` (see
 * `lastSwapAttestation.ts`) or directly in tests.
 */
export interface SwapCandidateTx {
  /** Resolved account keys: message static keys + ALT-loaded keys
   *  (writable first, then readonly), in wire order. */
  accountKeys: ReadonlyArray<PublicKey>;
  /** Message-level (outer) instructions in execution order. */
  messageInstructions: ReadonlyArray<CompiledInstructionView>;
  /**
   * Inner (CPI) instruction groups from transaction metadata.
   * THREE distinct states (Correction 001 §2):
   *   - an array (possibly empty): the RPC RECORDED the inner-instruction
   *     list; empty means genuinely no inner instructions occurred;
   *   - `null`: the RPC did not record inner instructions for this
   *     transaction. Absence of the list is NOT evidence that no inner
   *     instructions occurred — candidates without a directly-provable
   *     outer swap stay unresolved.
   */
  innerInstructions: ReadonlyArray<ReadonlyArray<CompiledInstructionView>> | null;
  /**
   * `null` only when the response EXPLICITLY records success
   * (`meta.err === null`). `undefined` means the status was not recorded
   * at all and can never be interpreted as success.
   */
  err: unknown | null | undefined;
  preTokenBalances: ReadonlyArray<TokenBalanceView> | null | undefined;
  postTokenBalances: ReadonlyArray<TokenBalanceView> | null | undefined;
}

export interface SwapClassificationOptions {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  /** Authoritative pool vaults (from the on-chain AmmInfo). When null,
   *  swap-tagged candidates fail closed as `pool_vaults_unavailable`. */
  coinVault: PublicKey | null;
  pcVault: PublicKey | null;
}

// ----- classification ------------------------------------------------------

interface V4Hit {
  tag: number;
  dataLen: number;
  routedViaInnerInstruction: boolean;
  accountRefs: ReadonlyArray<number | PublicKey>;
  /** True when the instruction data could not be decoded (base58 error). */
  dataUndecodable: boolean;
}

function resolveRef(
  ref: number | PublicKey,
  accountKeys: ReadonlyArray<PublicKey>,
): PublicKey | undefined {
  if (typeof ref === "number") return accountKeys[ref];
  return ref;
}

function collectV4Hits(tx: SwapCandidateTx, ammProgramId: PublicKey): V4Hit[] {
  const hits: V4Hit[] = [];
  const scan = (
    ixs: ReadonlyArray<CompiledInstructionView>,
    routedViaInnerInstruction: boolean,
  ): void => {
    for (const ix of ixs) {
      const pid = tx.accountKeys[ix.programIdIndex];
      if (pid === undefined) {
        // An instruction whose program id index is out of bounds means the
        // account-key view itself is broken — handled at the tx level.
        hits.push({
          tag: -1,
          dataLen: -2,
          routedViaInnerInstruction,
          accountRefs: [],
          dataUndecodable: false,
        });
        continue;
      }
      if (!pid.equals(ammProgramId)) continue;
      let tag = -1;
      let dataLen = 0;
      let dataUndecodable = false;
      try {
        const data = decodeInstructionData(ix.data);
        dataLen = data.length;
        tag = dataLen > 0 ? (data[0] ?? -1) : -1;
      } catch {
        dataUndecodable = true;
      }
      hits.push({
        tag,
        dataLen,
        routedViaInnerInstruction,
        accountRefs: ix.accounts,
        dataUndecodable,
      });
    }
  };
  scan(tx.messageInstructions, false);
  // `innerInstructions === null` means the RPC did not RECORD the inner
  // instruction list (Correction 001 §2). Scanning nothing would silently
  // equate "recording unavailable" with "genuinely empty" — the empty
  // array is the only representation of a recorded, empty inner list.
  if (tx.innerInstructions !== null) {
    for (const set of tx.innerInstructions) scan(set, true);
  }
  return hits;
}

/** True when the instruction's account list references the pool account. */
function referencesPool(
  hit: V4Hit,
  pool: PublicKey,
  accountKeys: ReadonlyArray<PublicKey>,
): boolean {
  for (const ref of hit.accountRefs) {
    const k = resolveRef(ref, accountKeys);
    if (k && k.equals(pool)) return true;
  }
  return false;
}

/** True when the instruction's account list references `vault`. */
function referencesKey(hit: V4Hit, key: PublicKey, accountKeys: ReadonlyArray<PublicKey>): boolean {
  for (const ref of hit.accountRefs) {
    const k = resolveRef(ref, accountKeys);
    if (k && k.equals(key)) return true;
  }
  return false;
}

function vaultAmount(
  vault: PublicKey,
  accountKeys: ReadonlyArray<PublicKey>,
  balances: ReadonlyArray<TokenBalanceView> | null | undefined,
): bigint | null {
  let vaultIndex = -1;
  for (let i = 0; i < accountKeys.length; i++) {
    const k = accountKeys[i];
    if (k && k.equals(vault)) {
      vaultIndex = i;
      break;
    }
  }
  if (vaultIndex < 0) return null;
  const entry = (balances ?? []).find((e) => e.accountIndex === vaultIndex);
  if (!entry) return null;
  return BigInt(entry.uiTokenAmount.amount);
}

/**
 * Classify one candidate transaction against a Raydium V4 pool.
 *
 * Returns the D4 outcome for the candidate: `verified_swap` only when a
 * swap-tagged V4 instruction on this pool is corroborated by opposite,
 * nonzero movement of both authoritative pool vaults in a transaction
 * whose success is EXPLICITLY recorded; `not_economic_swap` when the
 * candidate provably did not swap on this pool; `unresolved` when the
 * evidence cannot be reliably established (fail-closed).
 *
 * Inner-instruction evidence (Correction 001 §2): a `null`
 * `innerInstructions` list means the RPC did not record the CPI
 * instruction surface. A swap directly proven by an OUTER instruction
 * (tag + corroboration) is still verifiable; but WITHOUT that direct
 * proof, unavailable inner evidence leaves the candidate unresolved —
 * the transaction could still contain an inner-CPI swap on this pool,
 * so no definitive non-swap conclusion is possible.
 */
export function classifySwapCandidate(
  tx: SwapCandidateTx,
  opts: SwapClassificationOptions,
): SwapCandidateOutcome {
  const { ammProgramId, poolAddress, coinVault, pcVault } = opts;

  // The transaction status must be EXPLICITLY recorded (Correction 001
  // §2): only `meta.err === null` establishes success; an absent status
  // can never be normalized into success.
  if (tx.err === undefined) {
    return { kind: "unresolved", reason: "transaction_status_missing" };
  }
  // A failed transaction has no economic effect (Solana reverts atomically).
  if (tx.err !== null) {
    return { kind: "not_economic_swap", reason: "failed_transaction" };
  }

  const hits = collectV4Hits(tx, ammProgramId);

  // A program-id index beyond the resolved key list means the account-key
  // view itself is broken — no per-instruction conclusion is reliable.
  if (hits.some((h) => h.dataLen === -2)) {
    return { kind: "unresolved", reason: "malformed_transaction_metadata" };
  }

  const poolHits = hits.filter((h) => referencesPool(h, poolAddress, tx.accountKeys));

  // --- swap-tagged candidates on this pool -------------------------------
  const swapHits = poolHits.filter((h) => RAYDIUM_V4_SWAP_TAGS.has(h.tag));
  if (swapHits.length > 0) {
    if (coinVault === null || pcVault === null) {
      return { kind: "unresolved", reason: "pool_vaults_unavailable" };
    }
    // Account relationships: a swap on this pool always passes both vaults.
    const vaultsReferenced = swapHits.every(
      (h) =>
        referencesKey(h, coinVault, tx.accountKeys) && referencesKey(h, pcVault, tx.accountKeys),
    );
    if (!vaultsReferenced) {
      return { kind: "unresolved", reason: "conflicting_evidence" };
    }
    if (
      tx.preTokenBalances === null ||
      tx.preTokenBalances === undefined ||
      tx.postTokenBalances === null ||
      tx.postTokenBalances === undefined
    ) {
      return { kind: "unresolved", reason: "incomplete_rpc_response" };
    }
    const coinPre = vaultAmount(coinVault, tx.accountKeys, tx.preTokenBalances);
    const pcPre = vaultAmount(pcVault, tx.accountKeys, tx.preTokenBalances);
    const coinPost = vaultAmount(coinVault, tx.accountKeys, tx.postTokenBalances);
    const pcPost = vaultAmount(pcVault, tx.accountKeys, tx.postTokenBalances);
    if (coinPre === null || pcPre === null || coinPost === null || pcPost === null) {
      // A successful swap always moves both vaults; their absence from the
      // balance data contradicts the claimed swap.
      return { kind: "unresolved", reason: "conflicting_evidence" };
    }
    const coinDelta = coinPost - coinPre;
    const pcDelta = pcPost - pcPre;
    const opposite = coinDelta !== 0n && pcDelta !== 0n && coinDelta > 0n !== pcDelta > 0n;
    if (!opposite) {
      return { kind: "unresolved", reason: "conflicting_evidence" };
    }
    const primary = swapHits[0];
    const tag = primary === undefined ? undefined : RAYDIUM_V4_SWAP_TAG_NAMES.get(primary.tag);
    if (tag === undefined) {
      return { kind: "unresolved", reason: "ambiguous_evidence" };
    }
    return {
      kind: "verified_swap",
      tag,
      routedViaInnerInstruction: swapHits.some((h) => h.routedViaInnerInstruction),
    };
  }

  // --- non-swap V4 interactions on this pool ------------------------------
  if (poolHits.length > 0) {
    // Correction 001 §2: the outer instruction proves the tx touched this
    // pool through the AMM program, but without recorded inner
    // instructions a same-transaction inner-CPI swap cannot be ruled
    // out — no definitive non-swap conclusion is possible.
    if (tx.innerInstructions === null) {
      return { kind: "unresolved", reason: "inner_instructions_unavailable" };
    }
    // Undecodable or empty V4 instruction data, and tags the deployed
    // program rejects (removed/`unimplemented!`) — contradictory evidence
    // in a successful transaction; fail closed, never guess away.
    if (
      poolHits.some(
        (h) => h.dataUndecodable || h.dataLen <= 0 || RAYDIUM_V4_REMOVED_TAGS.has(h.tag),
      )
    ) {
      return { kind: "unresolved", reason: "ambiguous_evidence" };
    }
    if (poolHits.some((h) => RAYDIUM_V4_LIQUIDITY_TAGS.has(h.tag))) {
      const hasDeposit = poolHits.some((h) => h.tag === V4_TAG_DEPOSIT);
      return {
        kind: "not_economic_swap",
        reason: hasDeposit ? "liquidity_addition" : "liquidity_removal",
      };
    }
    if (poolHits.some((h) => RAYDIUM_V4_INITIALIZATION_TAGS.has(h.tag))) {
      return { kind: "not_economic_swap", reason: "pool_initialization" };
    }
    if (poolHits.some((h) => RAYDIUM_V4_ADMIN_TAGS.has(h.tag))) {
      return { kind: "not_economic_swap", reason: "administrative_operation" };
    }
    // Unknown tag on the AMM program — cannot establish what it was.
    return { kind: "unresolved", reason: "ambiguous_evidence" };
  }

  // --- no AMM-program invocation of this pool ------------------------------
  // Correction 001 §2: the pool APPEARS in the transaction (the candidate
  // came from the pool's signature history), so an unrecorded inner CPI
  // from a router/aggregator program could still have swapped on this
  // pool. Only a RECORDED (possibly empty) inner list proves the pool was
  // not invoked by the AMM program.
  if (tx.innerInstructions === null) {
    return { kind: "unresolved", reason: "inner_instructions_unavailable" };
  }
  return { kind: "not_economic_swap", reason: "pool_not_invoked_by_amm_program" };
}
