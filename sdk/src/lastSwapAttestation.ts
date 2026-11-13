// SPDX-License-Identifier: Apache-2.0
//
// Criterion 1 last-swap attestations (ORACLE-002, Phase 1.2 / spec D8).
//
// GraveScanner no longer accepts caller-supplied last-swap timestamps.
// Criterion 1 inactivity evidence is a 112-byte attestation signed by the
// protocol activity oracle (a key registered in GraveScanner
// `ProtocolConfig.activity_oracle`), verified on chain through the
// `ed25519_program` precompile.
//
// Transaction assembly (canonical pattern — see PROTOCOL_SPEC.md §5):
//
//   1. Derive the attested last-swap time from Raydium V4 transaction
//      history (`deriveLastSwapV4` — indexer/operator tooling).
//   2. Fetch the slot hash for the issuance slot (`fetchSlotHash`).
//   3. Build the 112-byte message (`buildAttestationMessage`).
//   4. Sign it with the activity oracle key (Ed25519).
//   5. Prepend `buildEd25519VerifyInstruction(...)` to the scanner
//      instruction in the SAME transaction. The precompile verifies the
//      signature before GraveScanner executes; GraveScanner then validates
//      the offsets, the oracle binding, and slot freshness (SlotHashes).
//
// The byte layout below is NORMATIVE and mirrored byte-for-byte by
// programs/grave-scanner/src/attestation.rs. Do not reorder fields.

import { PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";

import { fetchV4Pool } from "./raydiumV4.js";
import {
  classifySwapCandidate,
  type SwapCandidateTx,
  type SwapCandidateOutcome,
  type CompiledInstructionView,
  type TokenBalanceView,
} from "./raydiumV4Evidence.js";

/** Ed25519 signature-verification native program (precompile). */
export const ED25519_PROGRAM_ID = new PublicKey("Ed25519SigVerify111111111111111111111111111");

/** Canonical attestation message length in bytes. */
export const ATTESTATION_MSG_LEN = 112;

/** Offset of the attestation message inside the GraveScanner instruction data
 *  (8B Anchor discriminator + 32B amm + 32B pool). */
export const IX_DATA_MSG_OFFSET = 72;

/** Minimum GraveScanner instruction data length (disc + amm + pool + msg). */
export const IX_DATA_MIN_LEN = 184;

/**
 * Precompile instruction header: 1-byte signature count + 1 ignored
 * padding byte + the 14-byte `Ed25519SignatureOffsets` struct (7 × u16
 * LE, starting at byte 2). Byte-identical to the runtime's own
 * `SIGNATURE_OFFSETS_START` + `SIGNATURE_OFFSETS_SERIALIZED_SIZE`
 * layout in `solana-ed25519-program`.
 */
export const ED25519_HEADER_LEN = 16;

/** Public key offset inside the precompile instruction data (canonical,
 * pubkey-first placement, mirroring the runtime's own builder). */
export const PRECOMPILE_PK_OFFSET = 16;

/** Signature offset inside the precompile instruction data. */
export const PRECOMPILE_SIG_OFFSET = 48;

/** Canonical precompile instruction data length (header + pk + sig). */
export const PRECOMPILE_MIN_LEN = 112;

/** 0xFFFF = "the instruction currently being executed" (the precompile). */
export const CUR_INSTRUCTION_INDEX = 0xffff;

/** A parsed Criterion 1 attestation. */
export interface LastSwapAttestation {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  /** Attested unix timestamp (seconds) of the pool's most recent swap. */
  lastSwapUnixTs: number;
  /** Slot at which the indexer issued the attestation. */
  issuedSlot: number;
  /** 32-byte slot hash (blockhash) binding the attestation to a real slot. */
  slotHash: Uint8Array;
}

/** Serialize an attestation into the canonical 112-byte wire format. */
export function buildAttestationMessage(att: LastSwapAttestation): Uint8Array {
  if (att.slotHash.length !== 32) {
    throw new Error("slotHash must be exactly 32 bytes");
  }
  const msg = new Uint8Array(ATTESTATION_MSG_LEN);
  msg.set(att.ammProgramId.toBytes(), 0);
  msg.set(att.poolAddress.toBytes(), 32);
  const view = new DataView(msg.buffer);
  view.setBigInt64(64, BigInt(att.lastSwapUnixTs), true);
  view.setBigUint64(72, BigInt(att.issuedSlot), true);
  msg.set(att.slotHash, 80);
  return msg;
}

/** Parse and length-check a 112-byte attestation message. */
export function parseAttestationMessage(bytes: Uint8Array): LastSwapAttestation {
  if (bytes.length !== ATTESTATION_MSG_LEN) {
    throw new Error(`attestation message must be ${ATTESTATION_MSG_LEN} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    ammProgramId: new PublicKey(bytes.slice(0, 32)),
    poolAddress: new PublicKey(bytes.slice(32, 64)),
    lastSwapUnixTs: Number(view.getBigInt64(64, true)),
    issuedSlot: Number(view.getBigUint64(72, true)),
    slotHash: bytes.slice(80, 112),
  };
}

/**
 * Build the `ed25519_program` verify instruction that must immediately
 * precede the GraveScanner instruction in the same transaction.
 *
 * Layout (112 bytes, the runtime wire format consumed by
 * `agave_precompiles::ed25519::verify` — mirrored byte-for-byte by
 * `grave-scanner/src/attestation.rs`): 1-byte signature count + 1
 * ignored padding byte, the 7-field `Ed25519SignatureOffsets` struct at
 * byte 2 (sig_offset, sig_ix, pk_offset, pk_ix, message_data_offset,
 * message_data_size, message_instruction_index — all u16 LE), then the
 * covered public key (32B) and the signature (64B). The message offsets
 * point at `messageAddressOffset` inside the GraveScanner instruction
 * at `scannerInstructionIndex`, so the runtime-verified signature
 * covers exactly the attestation bytes embedded in the scanner
 * instruction.
 *
 * The default offset targets the C1 last-swap attestation
 * (`IX_DATA_MSG_OFFSET` = 72, 112-byte message). The C2 launch-price
 * attestation embeds its 168-byte message at offset 152 and passes
 * `messageAddressOffset: LAUNCH_PRICE_MSG_OFFSET` instead (see
 * `launchPriceAttestation.ts`).
 *
 * Phase 6 correction (spec rev 1.10.0): the precompile wire format is
 * the runtime's OWN layout — the previously documented 14-byte header
 * (sig at 14, pk at 78, count as the 5th u16, no message-size field)
 * is not a format any Solana runtime accepts: the precompile reads the
 * signature count from data[0], so such instructions die in precompile
 * verification before the scanner executes.
 */
export function buildEd25519VerifyInstruction(opts: {
  /** 64-byte Ed25519 signature over the attestation message. */
  signature: Uint8Array;
  /** The activity oracle public key that produced the signature. */
  oraclePublicKey: PublicKey;
  /** The attestation message (canonical length for its offset; its
   *  length becomes the precompile's `message_data_size`). */
  message: Uint8Array;
  /** Index of the GraveScanner instruction within the transaction. */
  scannerInstructionIndex: number;
  /** Offset of the signed message inside the GraveScanner instruction
   *  data. Defaults to `IX_DATA_MSG_OFFSET` (72). */
  messageAddressOffset?: number;
}): TransactionInstruction {
  if (opts.signature.length !== 64) {
    throw new Error("signature must be exactly 64 bytes");
  }
  if (opts.scannerInstructionIndex < 0 || opts.scannerInstructionIndex > 0xfffe) {
    throw new Error("scannerInstructionIndex out of range");
  }
  const messageAddressOffset = opts.messageAddressOffset ?? IX_DATA_MSG_OFFSET;
  if (messageAddressOffset < 0 || messageAddressOffset > 0xffff) {
    throw new Error("messageAddressOffset out of range");
  }
  // The (offset, size) pair must be one of the two canonical attestation
  // spans: C1 (72, 112) or C2 (152, 168 — see launchPriceAttestation.ts).
  // Anything else would sign bytes the scanner will not read as `params.msg`.
  const canonicalSpan =
    (messageAddressOffset === IX_DATA_MSG_OFFSET && opts.message.length === ATTESTATION_MSG_LEN) ||
    (messageAddressOffset === 152 && opts.message.length === 168);
  if (!canonicalSpan) {
    throw new Error("message length must match the canonical span for messageAddressOffset");
  }
  const data = Buffer.alloc(PRECOMPILE_MIN_LEN);
  data[0] = 1; // num_signatures
  data[1] = 0; // ignored padding byte (runtime does not check it)
  const w = (off: number, v: number) => data.writeUInt16LE(v, off);
  w(2, PRECOMPILE_SIG_OFFSET); // signature_offset
  w(4, CUR_INSTRUCTION_INDEX); // signature_instruction_index
  w(6, PRECOMPILE_PK_OFFSET); // public_key_offset
  w(8, CUR_INSTRUCTION_INDEX); // public_key_instruction_index
  w(10, messageAddressOffset); // message_data_offset
  w(12, opts.message.length); // message_data_size
  w(14, opts.scannerInstructionIndex); // message_instruction_index
  Buffer.from(opts.oraclePublicKey.toBytes()).copy(data, PRECOMPILE_PK_OFFSET);
  Buffer.from(opts.signature).copy(data, PRECOMPILE_SIG_OFFSET);
  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data,
  });
}

/** Result of an off-chain last-swap derivation for a Raydium V4 pool. */
export interface LastSwapDerivation {
  lastSwapUnixTs: number;
  slot: number;
  signature: string;
}

// ---------------------------------------------------------------------------
// Canonical D4/D5 evidence derivation (spec Deliverable 3 §6-§8, ADR D4/D5).
//
// History of this module: the original `deriveLastSwapV4` accepted ANY
// Raydium V4 program touch of the pool as the "last swap" (audit H-1), had
// no confirmation-status gate despite the header naming a minConfirmations
// requirement (audit H2), silently skipped candidates with missing block
// times or transaction data (converting incomplete evidence into a weaker
// — and unsafe — inactivity determination), and resolved account keys
// through `message.getAccountKeys()` WITHOUT `accountKeysFromLookups`,
// which under web3.js 3.x throws for version-0 transactions with address
// lookup tables and rejects version-1 transactions entirely (audit P4-B5:
// 11/12 pools failed activity derivation in the Phase 3 snapshot).
//
// The corrected implementation classifies candidates through
// `classifySwapCandidate` (the canonical D4 classifier), gates every
// candidate on `finalized` confirmation status (ADR D5 / Deliverable 3 §7),
// records the observed status and a per-candidate outcome, and reports an
// explicit completeness status so that an exhausted-but-incomplete scan is
// never representable as a valid inactivity determination (§8).
// ---------------------------------------------------------------------------

/** A candidate signature's recorded evidence outcome (newest-first order). */
export interface LastSwapCandidateRecord {
  signature: string;
  slot: number | null;
  blockTime: number | null;
  /** Observed confirmation status, recorded per Deliverable 3 §7. */
  confirmationStatus: string | null;
  outcome: SwapCandidateOutcome;
}

/** Explicit completeness status of a last-swap evidence derivation. */
export type LastSwapEvidenceStatus =
  /** Newest finalized, verified economic swap established. */
  | "verified"
  /** Scan covered the pool's full available signature history; every
   *  candidate is provably not an economic swap on this pool. */
  | "no_swap_in_scan"
  /** Unresolved evidence present (or an empty/bounded scan) — no valid
   *  inactivity determination may be derived from this result. */
  | "incomplete";

export interface LastSwapEvidenceResult {
  status: LastSwapEvidenceStatus;
  /** Set only when `status === "verified"`. */
  lastSwap: LastSwapDerivation | null;
  /** Per-candidate records, newest-first, bounded by the scan limit. */
  candidates: LastSwapCandidateRecord[];
  scan: {
    requestedLimit: number;
    signaturesReturned: number;
    /** True when the RPC returned fewer signatures than requested — the
     *  pool's full available history was covered. */
    reachedHistoryEnd: boolean;
  };
  /** True when the result is a sound basis for an inactivity claim. */
  definitive: boolean;
}

export interface DeriveLastSwapEvidenceOptions {
  /** Signature scan limit (bounded-scan behavior preserved; default 1,000). */
  scanLimit?: number;
  /** Override the authoritative pool vaults (fetched from the on-chain
   *  AmmInfo when omitted). */
  coinVault?: PublicKey;
  pcVault?: PublicKey;
  /**
   * Optional finalized depth margin behind the finalized tip (ADR D5 /
   * Deliverable 3 §7): candidates newer than `finalized_slot - depth` are
   * excluded even when the RPC already reports `finalized`. Default 0
   * (pure confirmation-status gate).
   */
  finalizedDepthSlots?: number;
}

/**
 * Block-time sanity skew: a block time further in the future than this is
 * invalid evidence (the on-chain evaluator enforces `0 < ts <= now`, 6028 —
 * catching it here keeps the failure upstream and explicit).
 */
const BLOCK_TIME_FUTURE_TOLERANCE_SECONDS = 600;

type LastSwapTxResponse = {
  slot: number | bigint;
  blockTime?: number | bigint | null;
  transaction: {
    message: {
      getAccountKeys(opts?: { accountKeysFromLookups?: unknown }): {
        keySegments(): ReadonlyArray<ReadonlyArray<PublicKey | string>>;
      };
      compiledInstructions: ReadonlyArray<{
        programIdIndex: number;
        accountKeyIndexes?: ReadonlyArray<number>;
        accounts?: ReadonlyArray<number | PublicKey>;
        data: Uint8Array | string;
      }>;
    };
  };
  meta: {
    err: unknown;
    innerInstructions?: ReadonlyArray<{
      index?: number;
      instructions: ReadonlyArray<{
        programIdIndex: number;
        accounts?: ReadonlyArray<number | PublicKey>;
        data: Uint8Array | string;
      }>;
    }>;
    loadedAddresses?: {
      writable?: ReadonlyArray<PublicKey | string>;
      readonly?: ReadonlyArray<PublicKey | string>;
    } | null;
    preTokenBalances?: ReadonlyArray<TokenBalanceView> | null;
    postTokenBalances?: ReadonlyArray<TokenBalanceView> | null;
  } | null;
};

function toPublicKey(key: PublicKey | string): PublicKey {
  return typeof key === "string" ? new PublicKey(key) : key;
}

/**
 * Adapt a web3.js `getTransaction` response into the classifier's
 * normalized view. Account keys resolve through
 * `getAccountKeys({ accountKeysFromLookups })` — the canonical web3.js
 * path for address-lookup-table (v0) and inlined-key (v1/legacy)
 * transactions.
 */
function normalizeSwapCandidateTx(tx: LastSwapTxResponse): SwapCandidateTx {
  const message = tx.transaction.message;
  const accountKeys = message
    .getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined })
    .keySegments()
    .flat()
    .map(toPublicKey);

  const messageInstructions: CompiledInstructionView[] = message.compiledInstructions.map((ci) => ({
    programIdIndex: ci.programIdIndex,
    accounts: (ci.accountKeyIndexes ?? ci.accounts ?? []) as ReadonlyArray<number | PublicKey>,
    data: ci.data,
  }));

  const innerSets = [...(tx.meta?.innerInstructions ?? [])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  const innerInstructions = innerSets.map((set) =>
    set.instructions.map((ix): CompiledInstructionView => ({
      programIdIndex: ix.programIdIndex,
      accounts: (ix.accounts ?? []) as ReadonlyArray<number | PublicKey>,
      data: ix.data,
    })),
  );

  return {
    accountKeys,
    messageInstructions,
    innerInstructions,
    err: tx.meta?.err ?? null,
    preTokenBalances: tx.meta?.preTokenBalances ?? null,
    postTokenBalances: tx.meta?.postTokenBalances ?? null,
  };
}

/**
 * Fetch a candidate transaction, preferring full versioned-transaction
 * support (version-1 transactions exist on 2026 mainnet and are rejected
 * by the RPC when `maxSupportedTransactionVersion` is 0). Falls back to
 * version 0 for endpoints that cap the parameter.
 */
async function fetchCandidateTx(
  connection: Connection,
  signature: string,
): Promise<LastSwapTxResponse | null> {
  try {
    return (await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 4,
      commitment: "finalized",
    })) as unknown as LastSwapTxResponse | null;
  } catch (err) {
    if (!String(err).includes("version")) throw err;
  }
  return (await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "finalized",
  })) as unknown as LastSwapTxResponse | null;
}

/**
 * Derive the canonical D4/D5 last-swap evidence for a Raydium V4 pool:
 * the newest FINALIZED, VERIFIED economic swap in the pool's bounded
 * signature history, with explicit per-candidate outcomes and an explicit
 * completeness status.
 *
 * Fail-closed guarantees (D4/D5, Deliverable 3 §6-§8):
 *   * only verified economic swaps can produce `lastSwap`;
 *   * non-finalized signatures, missing transaction data, missing/invalid
 *     block times, malformed metadata, ambiguous and conflicting evidence
 *     remain `unresolved` and are recorded per candidate;
 *   * an unresolved candidate NEWER than the newest verified swap makes
 *     the result `incomplete` (the true last swap could be that
 *     candidate) — `lastSwap` stays null and no inactivity claim is safe;
 *   * an empty signature response is `incomplete` (a pruned or unindexed
 *     RPC is indistinguishable from a pool that never transacted);
 *   * a bounded scan that did not reach the end of history is
 *     `incomplete` unless a verified swap was found.
 */
export async function deriveLastSwapEvidenceV4(
  connection: Connection,
  ammProgramId: PublicKey,
  poolAddress: PublicKey,
  opts?: DeriveLastSwapEvidenceOptions,
): Promise<LastSwapEvidenceResult> {
  const scanLimit = opts?.scanLimit ?? 1000;
  const finalizedDepthSlots = opts?.finalizedDepthSlots ?? 0;

  // Authoritative vaults: from the caller when provided, otherwise the
  // on-chain AmmInfo (never inferred from instruction layouts — the v1
  // swap layouts have an optional account that shifts indices).
  let coinVault: PublicKey | null = opts?.coinVault ?? null;
  let pcVault: PublicKey | null = opts?.pcVault ?? null;
  if (coinVault === null || pcVault === null) {
    try {
      const pool = await fetchV4Pool(connection, poolAddress);
      coinVault = coinVault ?? pool.coinVault;
      pcVault = pcVault ?? pool.pcVault;
    } catch {
      // Corroboration impossible — swap-tagged candidates fail closed as
      // `pool_vaults_unavailable` instead of crashing the derivation.
    }
  }

  let finalizedSlot: number | null = null;
  if (finalizedDepthSlots > 0) {
    try {
      finalizedSlot = Number(await connection.getSlot("finalized"));
    } catch {
      // Depth margin unavailable — the confirmation-status gate below
      // still applies in full.
      finalizedSlot = null;
    }
  }
  const nowUnixSeconds = Math.floor(Date.now() / 1000);

  const sigInfos = await connection.getSignaturesForAddress(poolAddress, {
    limit: scanLimit,
  });

  const candidates: LastSwapCandidateRecord[] = [];
  const seen = new Set<string>();
  for (const info of sigInfos) {
    if (seen.has(info.signature)) continue; // defensive: dedupe RPC pages
    seen.add(info.signature);
    const slot = Number(info.slot);
    const rawBlockTime = info.blockTime;
    const blockTime =
      rawBlockTime === null || rawBlockTime === undefined ? null : Number(rawBlockTime);

    const record: LastSwapCandidateRecord = {
      signature: info.signature,
      slot: Number.isSafeInteger(slot) ? slot : null,
      blockTime: blockTime !== null && Number.isSafeInteger(blockTime) ? blockTime : null,
      confirmationStatus: info.confirmationStatus ?? null,
      outcome: { kind: "unresolved", reason: "transaction_data_missing" },
    };

    const finalize = (outcome: SwapCandidateOutcome): void => {
      record.outcome = outcome;
      candidates.push(record);
    };

    // ADR D5 / Deliverable 3 §7: non-finalized candidates are excluded
    // (and their observed status recorded) — never treated as swaps and
    // never treated as proof of inactivity.
    if (info.confirmationStatus !== "finalized") {
      finalize({ kind: "unresolved", reason: "signature_not_finalized" });
      continue;
    }
    if (
      finalizedSlot !== null &&
      Number.isSafeInteger(slot) &&
      slot > finalizedSlot - finalizedDepthSlots
    ) {
      finalize({ kind: "unresolved", reason: "signature_not_finalized" });
      continue;
    }
    if (rawBlockTime === null || rawBlockTime === undefined) {
      finalize({ kind: "unresolved", reason: "block_time_missing" });
      continue;
    }
    if (
      blockTime === null ||
      !Number.isSafeInteger(blockTime) ||
      blockTime <= 0 ||
      blockTime > nowUnixSeconds + BLOCK_TIME_FUTURE_TOLERANCE_SECONDS
    ) {
      finalize({ kind: "unresolved", reason: "block_time_invalid" });
      continue;
    }

    let tx: LastSwapTxResponse | null = null;
    try {
      tx = await fetchCandidateTx(connection, info.signature);
    } catch {
      tx = null;
    }
    if (!tx) {
      finalize({ kind: "unresolved", reason: "transaction_data_missing" });
      continue;
    }
    if (!tx.meta) {
      finalize({ kind: "unresolved", reason: "transaction_meta_missing" });
      continue;
    }

    try {
      finalize(
        classifySwapCandidate(normalizeSwapCandidateTx(tx), {
          ammProgramId,
          poolAddress,
          coinVault,
          pcVault,
        }),
      );
    } catch {
      // Any normalization/classification failure is unresolved evidence —
      // it is never converted into a swap or a non-swap.
      finalize({ kind: "unresolved", reason: "malformed_transaction_metadata" });
    }
  }

  const newestVerifiedIdx = candidates.findIndex((c) => c.outcome.kind === "verified_swap");
  const newestVerified = newestVerifiedIdx >= 0 ? candidates[newestVerifiedIdx] : undefined;
  const reachedHistoryEnd = sigInfos.length < scanLimit;

  if (newestVerified) {
    const newestVerifiedIdxSafe = candidates.indexOf(newestVerified);
    const blocked = candidates
      .slice(0, newestVerifiedIdxSafe)
      .some((c) => c.outcome.kind === "unresolved");
    if (blocked) {
      return {
        status: "incomplete",
        lastSwap: null,
        candidates,
        scan: { requestedLimit: scanLimit, signaturesReturned: sigInfos.length, reachedHistoryEnd },
        definitive: false,
      };
    }
    return {
      status: "verified",
      lastSwap: {
        lastSwapUnixTs: newestVerified.blockTime as number,
        slot: newestVerified.slot as number,
        signature: newestVerified.signature,
      },
      candidates,
      scan: { requestedLimit: scanLimit, signaturesReturned: sigInfos.length, reachedHistoryEnd },
      definitive: true,
    };
  }

  // No verified swap: a valid "no swap in scan" determination requires the
  // full available history covered, at least one candidate seen, and every
  // candidate provably not an economic swap on this pool.
  const allResolved =
    candidates.length > 0 && candidates.every((c) => c.outcome.kind === "not_economic_swap");
  const definitive = reachedHistoryEnd && allResolved;
  return {
    status: definitive ? "no_swap_in_scan" : "incomplete",
    lastSwap: null,
    candidates,
    scan: { requestedLimit: scanLimit, signaturesReturned: sigInfos.length, reachedHistoryEnd },
    definitive,
  };
}

/**
 * Derive a Raydium V4 pool's last swap from RPC transaction history
 * (indexer/operator tooling — the authoritative input for attestations).
 *
 * Corrected canonical behavior (D4/D5): only a FINALIZED, VERIFIED
 * economic swap (canonical Raydium V4 classification + opposite-direction
 * vault corroboration) is returned; liquidity, administrative, crank,
 * initialization and other non-economic V4 interactions never qualify;
 * failed transactions never qualify; ambiguous, malformed, conflicting or
 * incomplete evidence never qualifies.
 *
 * Return contract: the newest verified swap, or `null`. `null` means
 * "no verified swap available" — it does NOT distinguish "provably no
 * swap in the covered history" from "incomplete/unresolved evidence".
 * Callers that must represent that distinction (the dedicated indexer)
 * consume `deriveLastSwapEvidenceV4` directly.
 *
 * Operational requirements (spec §6.3): run against a trusted RPC
 * endpoint with finalized commitment. Bounded-scan behavior and limits
 * are unchanged (`scanLimit`, default 1,000).
 */
export async function deriveLastSwapV4(
  connection: Connection,
  ammProgramId: PublicKey,
  poolAddress: PublicKey,
  opts?: { scanLimit?: number },
): Promise<LastSwapDerivation | null> {
  const result = await deriveLastSwapEvidenceV4(connection, ammProgramId, poolAddress, opts);
  return result.lastSwap;
}

/**
 * Fetch the 32-byte slot hash (blockhash) for a slot — the value that
 * GraveScanner cross-checks against the SlotHashes sysvar. Attestations
 * must be issued for a recent slot: once the slot ages out of the
 * ~512-entry SlotHashes window the on-chain check fails closed.
 */
export async function fetchSlotHash(
  connection: Connection,
  slot: number,
): Promise<Uint8Array | null> {
  const block = await connection.getBlock(slot, {
    maxSupportedTransactionVersion: 0,
  });
  if (!block) return null;
  return new PublicKey(block.blockhash).toBytes();
}
