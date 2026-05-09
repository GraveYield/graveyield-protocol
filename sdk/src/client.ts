// SPDX-License-Identifier: Apache-2.0

import type { Connection, PublicKey } from "@solana/web3.js";
import type { Cluster, EligibilityResult, LpSnapshot } from "./types.js";

/**
 * GraveYieldClient — the top-level entry point for SDK consumers.
 *
 * Construction is intentionally explicit: pass a Solana `Connection`, the
 * target cluster, and the on-chain ProtocolConfig snapshots. The client
 * caches the Charter ceiling values and refuses to submit transactions
 * violating them.
 */
export class GraveYieldClient {
  readonly connection: Connection;
  readonly cluster: Cluster;
  readonly graveScannerProgramId: PublicKey;
  readonly graveVaultProgramId: PublicKey;

  constructor(opts: {
    connection: Connection;
    cluster: Cluster;
    graveScannerProgramId: PublicKey;
    graveVaultProgramId: PublicKey;
  }) {
    this.connection = opts.connection;
    this.cluster = opts.cluster;
    this.graveScannerProgramId = opts.graveScannerProgramId;
    this.graveVaultProgramId = opts.graveVaultProgramId;
  }

  /**
   * Evaluate a single AMM pool against all six derelict-pool criteria. Does
   * not write anything on-chain — pure read.
   *
   * TODO(sdk m1): wire in real on-chain reads.
   */
  async evaluatePool(_poolAddress: PublicKey): Promise<EligibilityResult> {
    throw new Error("not yet implemented — sdk m1");
  }

  /**
   * Capture an LP-holder snapshot for the supplied pool. Output is suitable
   * to seed `salvage_pool`'s `lp_snapshot_merkle_root` parameter.
   *
   * TODO(sdk m4): implement holder enumeration + Merkle root.
   */
  async snapshotLpHolders(_poolAddress: PublicKey): Promise<LpSnapshot> {
    throw new Error("not yet implemented — sdk m4");
  }
}
