// SPDX-License-Identifier: Apache-2.0
//
// The injectable chain view.
//
// Every ops service reads the chain through this narrow interface so the
// test suites stay fully offline (canned fixtures implement ChainView)
// while production wires it to a real web3 Connection.
//
// Only the reads the services actually need are part of the interface —
// anything else must go through the SDK's GraveYieldClient.

import type { Connection, PublicKey, AccountInfo } from "@solana/web3.js";

/** A program-owned account as returned by a getProgramAccounts sweep. */
export interface OwnedAccount {
  pubkey: PublicKey;
  /** Raw account data (the SDK decoders take the full buffer). */
  data: Uint8Array;
  owner: PublicKey;
  lamports: number;
}

/** A signature-status entry (failed-tx monitoring). */
export interface SignatureStatusEntry {
  signature: string;
  /** null when the transaction has not reached a block yet. */
  err: unknown | null;
  slot: number | null;
  confirmationStatus: string | null;
}

/**
 * The narrow read-only chain view every ops service consumes.
 * All methods are async to keep the RPC and fixture paths interchangeable.
 */
export interface ChainView {
  /** All accounts owned by `programId` (base64-encoded payloads decoded here). */
  getProgramAccountsOwned(programId: PublicKey): Promise<OwnedAccount[]>;
  /** Recent signatures for an address, newest first. */
  getRecentSignatures(address: PublicKey, limit: number): Promise<SignatureStatusEntry[]>;
  /** Current slot (best effort; null when unavailable). */
  getSlot(): Promise<number | null>;
  /** Raw account info (null when absent). */
  getAccountInfo(address: PublicKey): Promise<AccountInfo<Buffer> | null>;
}

/** Production adapter over a real web3 Connection. */
export function connectionChainView(connection: Connection): ChainView {
  return {
    async getProgramAccountsOwned(programId: PublicKey) {
      const response = await connection.getProgramAccounts(programId, {
        encoding: "base64",
      });
      return response.map((entry) => ({
        pubkey: entry.pubkey,
        data: new Uint8Array(
          Buffer.isBuffer(entry.account.data)
            ? entry.account.data
            : Buffer.from(entry.account.data),
        ),
        owner: entry.account.owner,
        lamports: entry.account.lamports,
      }));
    },
    async getRecentSignatures(address: PublicKey, limit: number) {
      const signatures = await connection.getSignaturesForAddress(address, { limit });
      return signatures.map((entry) => ({
        signature: entry.signature,
        err: entry.err ?? null,
        slot: entry.slot ?? null,
        confirmationStatus: entry.confirmationStatus ?? null,
      }));
    },
    async getSlot() {
      try {
        return await connection.getSlot();
      } catch {
        return null;
      }
    },
    async getAccountInfo(address: PublicKey) {
      return connection.getAccountInfo(address);
    },
  };
}
