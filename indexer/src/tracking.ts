// SPDX-License-Identifier: Apache-2.0
//
// Scanner result tracking — the ninth stage of the Phase 9 indexer
// pipeline. After submitting a candidate to the on-chain GraveScanner
// Phase 1, the indexer monitors the EligibilityAnchor PDA to confirm
// the on-chain scanner accepted the submission, and later monitors the
// EligibilityCert PDA to detect when Phase 2 certification completes
// (after the multi-epoch confirmation gap).
//
// The tracking is poll-based: the indexer checks the PDA accounts on
// each scan cycle. A confirmed anchor appears as a non-null
// `fetchEligibilityAnchor` result; a confirmed cert appears as a
// non-null `fetchEligibilityCert` result with `expires_at > now`.
//
// The tracking result feeds the observability layer (Phase 11) so
// operators can see "this pool was submitted at slot X, the anchor
// landed at slot Y, the cert issued at epoch Z and expires at time T."

import { Connection, PublicKey } from "@solana/web3.js";
import {
  eligibilityAnchorPda,
  eligibilityCertPda,
  fetchEligibilityAnchor,
  fetchEligibilityCert,
} from "@graveyield/sdk";
import { RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";
import type { TrackingResult } from "./types.js";

/**
 * Track a submission's on-chain outcome. Checks the EligibilityAnchor
 * and EligibilityCert PDAs for the given pool.
 */
export async function trackSubmission(
  connection: Connection,
  scannerProgramId: PublicKey,
  poolAddress: PublicKey,
): Promise<TrackingResult> {
  const anchorPda = eligibilityAnchorPda(scannerProgramId, RAYDIUM_V4_PROGRAM_ID, poolAddress);
  const certPda = eligibilityCertPda(scannerProgramId, RAYDIUM_V4_PROGRAM_ID, poolAddress);

  const [anchor, cert] = await Promise.all([
    fetchEligibilityAnchor(connection, anchorPda),
    fetchEligibilityCert(connection, certPda),
  ]);

  if (!anchor) {
    return {
      poolAddress,
      anchorPda,
      status: "anchor-missing",
    };
  }

  if (cert && cert.expiresAt > 0n) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (cert.expiresAt > now) {
      return {
        poolAddress,
        anchorPda,
        status: "cert-written",
        anchorFirstEligibleEpoch: anchor.firstEligibleEpoch,
        certExpiresAt: cert.expiresAt,
      };
    }
  }

  return {
    poolAddress,
    anchorPda,
    status: "anchor-written",
    anchorFirstEligibleEpoch: anchor.firstEligibleEpoch,
  };
}
