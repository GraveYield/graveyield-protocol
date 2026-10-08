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

import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  GraveYieldClient,
  buildAttestationMessage,
  fetchSlotHash,
  type Phase1Input,
} from "@graveyield/sdk";
import { RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";
import type { IndexerConfig } from "./config.js";
import type { Candidate, SubmissionResult } from "./types.js";

/**
 * Submit a candidate to the on-chain GraveScanner Phase 1.
 *
 * If the indexer holds the activity oracle key, it:
 *   1. Builds the 112-byte C1 attestation message from the activity record.
 *   2. Fetches the slot hash for the issuance slot.
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
  opts?: { writer?: Keypair; oracleKeypair?: Keypair },
): Promise<SubmissionResult> {
  const anchorPda = deriveAnchorPda(config.scannerProgramId, candidate);

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
    // 1. Build the C1 attestation message.
    const issuedSlot = await connection.getSlot();
    const slotHash = await fetchSlotHash(connection, issuedSlot);
    if (!slotHash) {
      return {
        poolAddress: candidate.poolAddress,
        status: "failed",
        error: "could not fetch slot hash for issuance slot",
        anchorPda,
      };
    }

    const att = {
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: candidate.poolAddress,
      lastSwapUnixTs: candidate.activity.lastSwapUnixTs,
      issuedSlot,
      slotHash,
    };
    const msg = buildAttestationMessage(att);

    // 2. Sign the message with the oracle key (Ed25519 via tweetnacl).
    const oracleKp = oracleKeypair ?? Keypair.fromSecretKey(config.activityOracleSecretKey!);
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
    const sig = await sendAndConfirmTransaction(connection, tx, [writer]);

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
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("eligibility_anchor"), RAYDIUM_V4_PROGRAM_ID.toBuffer(), candidate.poolAddress.toBuffer()],
    scannerProgramId,
  );
  return pda;
}
