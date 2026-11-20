// SPDX-License-Identifier: Apache-2.0
//
// Scanner submission — the eighth stage of the Phase 9 indexer pipeline.
// Takes the top scored candidates from the queue and submits them to
// the on-chain GraveScanner Phase 1 (`evaluate_pool_phase_1`).
//
// The submission requires a C1 last-swap attestation — a 112-byte
// message signed by the activity oracle key (Ed25519), verified
// on-chain via the `ed25519_program` precompile. The indexer holds the
// activity oracle key because it IS the activity-indexing oracle
// (ORACLE-002 / ORACLE-003).
//
// Transaction shape (instructions in order):
//   0: ed25519_program verify  (C1 last-swap attestation)
//   1: GraveScanner::evaluate_pool_phase_1
//
// The precompile's `scannerInstructionIndex` is 1 (the phase 1 ix is
// immediately after the precompile).
//
// If the indexer does NOT hold the activity oracle key (discovery-only
// mode), it logs the candidate and skips submission. The on-chain
// submission is left to the salvor bot operator who holds the oracle
// key as a separate responsibility.

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  GraveYieldClient,
  buildAttestationMessage,
  evaluateM1Sourcing,
  fetchRecentSlotHash,
  fetchV4Pool,
  findProgramAddressSync,
  type Phase1Input,
  type V4PoolAccount,
} from "@graveyield/sdk";
import { RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";
import type { IndexerConfig } from "./config.js";
import type { Candidate, SubmissionResult } from "./types.js";

/**
 * Submit a candidate to the on-chain GraveScanner Phase 1.
 *
 * If the indexer holds the activity oracle key, it:
 *   1. Reads ONE validated SlotHashes sysvar snapshot and takes a REAL
 *      recent `(slot, hash)` entry as a pair (`fetchRecentSlotHash`).
 *   2. Builds the 112-byte C1 attestation message from the activity record,
 *      binding the returned slot and hash EXACTLY as the pair the on-chain
 *      GraveScanner verifier resolves from the same sysvar.
 *   3. Signs the message with the oracle key (Ed25519).
 *   4. Builds the (precompile, phase1) instruction pair via the SDK.
 *   5. Submits the transaction.
 *
 * If the oracle key is absent, the submission is skipped (the indexer
 * logs the candidate for the operator to submit manually).
 */
export async function submitCandidate(
  connection: Connection,
  config: IndexerConfig,
  candidate: Candidate,
  opts?: {
    writer?: Keypair;
    oracleKeypair?: Keypair;
    /**
     * Test seam: replaces `sendAndConfirmTransaction` so unit tests can
     * capture the assembled transaction without a network. Production
     * callers never pass it.
     */
    sendOverride?: (connection: Connection, tx: Transaction, signers: Keypair[]) => Promise<string>;
  },
): Promise<SubmissionResult> {
  const anchorPda = deriveAnchorPda(config.scannerProgramId, candidate);

  // D-01 M1 sourcing defense-in-depth (GY-M1-ODR-001 §3): a candidate
  // that reached this path through a stale queue snapshot, manual
  // injection, or an unguarded discovery source must STILL not be
  // submitted unless it satisfies the exact WSOL quote-side predicate
  // (pc_mint WSOL, coin_mint non-WSOL, exactly one WSOL side). Fail
  // closed BEFORE any attestation material is produced or any
  // transaction is built — the candidate cannot proceed, and the refusal
  // is machine-checkable on the SubmissionResult.
  //
  // The ACTUAL on-chain pool account is authoritative: this gate
  // re-fetches the pool with the SDK's established account-fetching and
  // decoding path (`fetchV4Pool` — Raydium V4 owner check + canonical
  // 752-byte AmmInfo layout, coin_mint @400 / pc_mint @432) and applies
  // the shared predicate to the DECODED values. Candidate-supplied mint
  // metadata (`candidate.discovery.pool`) is never trusted here, so a
  // discovery record claiming a valid orientation cannot smuggle through
  // a pool whose on-chain account is oriented differently. Fail-closed:
  // a missing, non-Raydium, or malformed pool account is a rejection
  // ("unverifiable-orientation"), never an acceptance.
  if (config.m1SourcingEnforced ?? true) {
    let actualPool: V4PoolAccount;
    try {
      actualPool = await fetchV4Pool(connection, candidate.poolAddress);
    } catch (err) {
      return {
        poolAddress: candidate.poolAddress,
        status: "skipped",
        error:
          `m1-sourcing-rejected: unverifiable-orientation — pool account could not be ` +
          `fetched/decoded (fail-closed): ${String((err as { message?: string }).message ?? err)}`,
        anchorPda,
      };
    }
    const verdict = evaluateM1Sourcing(actualPool);
    if (!verdict.accepted) {
      return {
        poolAddress: candidate.poolAddress,
        status: "skipped",
        error: `m1-sourcing-rejected: ${verdict.reason} — ${verdict.detail}`,
        anchorPda,
      };
    }
  }

  // If no oracle keypair is available, skip submission.
  const oracleKeypair = opts?.oracleKeypair;
  if (!config.activityOracleSecretKey && !oracleKeypair) {
    return {
      poolAddress: candidate.poolAddress,
      status: "skipped",
      error: "no activity oracle key — discovery-only mode",
      anchorPda,
    };
  }

  // If no writer keypair is available, skip submission (need a payer for
  // the EligibilityAnchor PDA rent).
  const writer = opts?.writer;
  if (!writer) {
    return {
      poolAddress: candidate.poolAddress,
      status: "skipped",
      error: "no writer keypair — cannot pay EligibilityAnchor rent",
      anchorPda,
    };
  }

  try {
    // 1. Canonical (slot, hash) pairing: the issuance slot and its hash
    //    come from ONE validated SlotHashes sysvar snapshot as a REAL
    //    entry — never `getBlock(slot).blockhash` (not the sysvar entry;
    //    rehearsal finding F1 → 6030 on every SDK-sourced hash) and never
    //    a slot manufactured by subtracting an offset from `getSlot()`
    //    (slots can be skipped; only a sysvar entry is guaranteed to
    //    resolve on-chain). The exact returned slot is placed into the
    //    attestation message and signed by the oracle below.
    const recent = await fetchRecentSlotHash(connection);
    if (!recent) {
      return {
        poolAddress: candidate.poolAddress,
        status: "failed",
        error: "no valid SlotHashes sysvar entry available for attestation issuance",
        anchorPda,
      };
    }
    const issuedSlot = recent.slot;
    const slotHash = recent.hash;

    const att = {
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: candidate.poolAddress,
      lastSwapUnixTs: candidate.activity.lastSwapUnixTs,
      issuedSlot,
      slotHash,
    };
    const msg = buildAttestationMessage(att);

    // 2. Sign the message with the oracle key (Ed25519 via tweetnacl).
    const oracleKp =
      oracleKeypair ?? (await Keypair.fromSecretKey(config.activityOracleSecretKey!));
    const signature = nacl.sign.detached(Buffer.from(msg), oracleKp.secretKey);

    // 3. Build the SDK client + phase1 instruction pair.
    const client = new GraveYieldClient({
      connection,
      cluster: config.cluster,
      graveScannerProgramId: config.scannerProgramId,
      graveVaultProgramId: config.vaultProgramId,
    });

    const phase1Input: Phase1Input = {
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: candidate.poolAddress,
      // NOTE: `buildPhase1Ix` reads `derivation.slot` as the attestation's
      // `issuedSlot`, so it MUST be the same slot whose hash is passed in
      // `slotHash` — here, exactly the pair returned by
      // `fetchRecentSlotHash` from one sysvar snapshot.
      derivation: {
        lastSwapUnixTs: candidate.activity.lastSwapUnixTs,
        slot: issuedSlot,
        signature: candidate.activity.lastSwapSignature,
      },
      slotHash,
      signature: new Uint8Array(signature),
      oraclePublicKey: oracleKp.publicKey,
      writer: writer.publicKey,
    };

    const { precompileIx, phase1Ix } = client.buildPhase1Ix(phase1Input);

    // 4. Assemble + submit the transaction.
    const tx = new Transaction().add(precompileIx, phase1Ix);
    const send = opts?.sendOverride ?? sendAndConfirmTransaction;
    const sig = await send(connection, tx, [writer]);

    return {
      poolAddress: candidate.poolAddress,
      signature: sig,
      status: "confirmed",
      anchorPda,
    };
  } catch (err) {
    return {
      poolAddress: candidate.poolAddress,
      status: "failed",
      error: String((err as { message?: string }).message ?? err),
      anchorPda,
    };
  }
}

/** Derive the EligibilityAnchor PDA for a candidate. */
function deriveAnchorPda(scannerProgramId: PublicKey, candidate: Candidate): PublicKey {
  const [pda] = findProgramAddressSync(
    [
      Buffer.from("eligibility_anchor"),
      RAYDIUM_V4_PROGRAM_ID.toBytes(),
      candidate.poolAddress.toBytes(),
    ],
    scannerProgramId,
  );
  return pda;
}
