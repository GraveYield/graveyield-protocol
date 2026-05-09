// SPDX-License-Identifier: Apache-2.0
//
// Off-chain pre-filter for the six derelict-pool criteria. Cheaper than the
// on-chain check because it can short-circuit on the first failing criterion
// using cached data, and it does not write any PDAs.

import type { Connection, PublicKey } from "@solana/web3.js";

/** Result of the pre-filter. Cheap and non-authoritative. */
export interface PreFilterResult {
  poolAddress: PublicKey;
  passed: boolean;
  failedCriteria: string[];
}

/**
 * Evaluate the six criteria against cached AMM state. The on-chain
 * GraveScanner is the source of truth; this function is the wide-funnel
 * pre-filter that picks candidates worth submitting to Phase 1.
 *
 * TODO(indexer m9): implement against parsed pool accounts.
 */
export async function preFilterPool(
  _connection: Connection,
  _poolAddress: PublicKey,
): Promise<PreFilterResult> {
  throw new Error("not yet implemented — indexer m9");
}
