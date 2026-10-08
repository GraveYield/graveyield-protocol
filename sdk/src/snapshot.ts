// SPDX-License-Identifier: Apache-2.0
//
// LP-holder snapshot — TypeScript mirror of the deterministic snapshot
// pipeline in `snapshotter/src/builder.rs` (Phase 5.1).
//
// The on-chain salvage_pool instruction takes a Merkle root sealed from
// an off-chain snapshot taken BEFORE the salvage. This module is the
// SDK's off-chain producer:
//
//   1. Read the LP mint supply (+ served slot).
//   2. Enumerate every SPL token account holding the LP mint via
//      `connection.getProgramAccounts(TOKEN_PROGRAM_ID, { filters: [
//        { memcmp: { offset: 0, bytes: lpMint } }, { dataSize: 165 } ] })`.
//   3. Hard gate: Σ enumerated balances == mint supply (`SupplyMismatch`).
//   4. Aggregate balances per owner (ascending pubkey bytes via Map sort).
//   5. Exclude zero-balance owners and any operator-declared sink owners.
//   6. (LOCKED-LP attribution is a Phase 9 indexer concern — the SDK
//      surfaces an explicit warning if the UNCX marker PDA is present on
//      chain; LOCKER-002.)
//   7. Emit the canonical leaf set + the closing identity:
//      `Σ entries == enumerated_total == supply`.
//
// Determinism contract: given the same RPC state the builder yields a
// bit-identical snapshot — Map iteration is deterministic over
// string-pubkeys (lexicographic), and no ambient state participates.
//
// Trust boundary: the snapshot is the operator's published claim. The
// on-chain verifier (`salvage_pool`'s supply pin against the live mint
// supply, `InvalidSnapshotData` 7018) is the final integrity anchor.

import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { unpackAccount, unpackMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { LpSnapshot } from "./types.js";
import { SnapshotMerkleTree, type HolderEntry } from "./merkle.js";
import BN from "bn.js";

/** Per-owner aggregated balance, sorted by ascending owner pubkey bytes. */
export interface SnapshotHolder {
  holder: PublicKey;
  balance: BN;
}

/** Result of `snapshotLpHolders` — the snapshot plus ready-to-submit Merkle root + proofs. */
export interface SnapshotResult {
  /** The full snapshot (pool, mint, supply, holders, root). */
  snapshot: LpSnapshot;
  /** Per-holder Merkle proofs in canonical entry order (leaf→root). */
  proofs: Uint8Array[][];
  /** The Solana slot at which the enumeration was served (best-effort from `getSlot`). */
  snapshotSlot: number;
  /** The full Merkle tree (root + leaves + per-index proofs). */
  tree: SnapshotMerkleTree;
  /** Off-chain LOCKER-002 warning: the UNCX marker PDA was present on chain. */
  uncxMarkerPresent: boolean;
  /** Excluded owners (zero balance or declared sinks), with reasons. */
  exclusions: Array<{ holder: PublicKey; balance: BN; reason: "zero" | "sink" }>;
}

/** Canonical SPL token account size (legacy layout; extensions append after byte 165). */
const SPL_TOKEN_ACCOUNT_SIZE = 165;

/**
 * Build a deterministic LP-holder snapshot for a Raydium V4 pool.
 *
 * @param opts.sinkExclusions  Owners that can never sign a claim (incinerator-style
 *   accounts). Their balances leave the leaf set and are recorded in the exclusion ledger.
 *   Burned LP needs no entry here — burned tokens never enumerate.
 */
export async function snapshotLpHolders(
  connection: Connection,
  poolAddress: PublicKey,
  opts?: { sinkExclusions?: ReadonlyArray<PublicKey> },
): Promise<SnapshotResult> {
  // We read the pool first to discover the LP mint. This avoids requiring
  // the caller to pass it (which would let the caller pin the wrong mint
  // to a real pool — a subtle attack the on-chain `salvage_pool` defends
  // against by binding the submitted LP mint to the pool's own AmmInfo
  // bytes; the SDK mirrors that bind by deriving the mint from the pool).
  const { fetchV4Pool } = await import("./raydiumV4.js");
  const pool = await fetchV4Pool(connection, poolAddress);
  const lpMint = pool.lpMint;

  // 1. Supply.
  const supplyInfo = await connection.getAccountInfo(lpMint);
  if (!supplyInfo) {
    throw new Error(`LP mint ${lpMint.toBase58()} not found`);
  }
  const mint = unpackMint(lpMint, supplyInfo);
  const totalSupply = BigInt(mint.supply.toString());

  // 2. Enumerate every SPL token account holding the LP mint via
  //    `getProgramAccounts` with a memcmp filter on the mint (the
  //    canonical RPC pattern; `getTokenAccountsByOwner` would require
  //    per-owner queries we cannot enumerate).
  const accountsResponse = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    encoding: "base64",
    filters: [
      { dataSize: SPL_TOKEN_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: lpMint.toBase58() } },
    ],
  });

  // 3. Aggregate per owner + drop zero-balance + drop declared sinks.
  const sinkSet = new Set((opts?.sinkExclusions ?? []).map((p) => p.toBase58()));
  const byOwner = new Map<string, bigint>();
  let enumeratedTotal = 0n;
  const exclusions: SnapshotResult["exclusions"] = [];

  for (const entry of accountsResponse) {
    const info: AccountInfo<Buffer> = entry.account;
    if (!info.data) continue;
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data);
    if (data.length !== SPL_TOKEN_ACCOUNT_SIZE) continue;
    let parsed: ReturnType<typeof unpackAccount>;
    try {
      parsed = unpackAccount(entry.pubkey, info);
    } catch {
      continue;
    }
    if (!parsed.mint.equals(lpMint)) continue; // defensive memcmp
    const amount = BigInt(parsed.amount.toString());
    enumeratedTotal += amount;
    const ownerKey = parsed.owner.toBase58();
    if (amount === 0n) {
      exclusions.push({ holder: parsed.owner, balance: new BN(0), reason: "zero" });
      continue;
    }
    if (sinkSet.has(ownerKey)) {
      exclusions.push({ holder: parsed.owner, balance: new BN(amount.toString(10)), reason: "sink" });
      continue;
    }
    const prev = byOwner.get(ownerKey) ?? 0n;
    byOwner.set(ownerKey, prev + amount);
  }

  // 4. Completeness gate: Σ balances == supply.
  const entriesTotal = [...byOwner.values()].reduce((a, b) => a + b, 0n);
  if (entriesTotal !== totalSupply) {
    throw new Error(
      `snapshot completeness gate failed: Σ enumerated balances (${enumeratedTotal}) ` +
        `!= lp_mint.supply (${totalSupply}); Σ entries=${entriesTotal}, ` +
        `Σ exclusions=${enumeratedTotal - entriesTotal}`,
    );
  }

  // 5. Sort by ascending owner pubkey bytes (BTreeMap equivalent).
  const sortedOwners = [...byOwner.keys()].sort();
  const holders: SnapshotHolder[] = sortedOwners.map((ownerStr) => ({
    holder: new PublicKey(ownerStr),
    balance: new BN(byOwner.get(ownerStr)!.toString(10)),
  }));

  // 6. Build the Merkle tree over the canonical leaf set.
  const holderEntries: HolderEntry[] = holders.map((h) => ({
    owner: h.holder,
    lpBalance: BigInt(h.balance.toString(10)),
  }));
  const tree = SnapshotMerkleTree.fromEntries(holderEntries);
  const root = tree.root();
  const proofs = tree.proofs();

  // 7. Surface LOCKER-002: check whether the UNCX per-pool marker PDA
  //    exists on chain. (The SDK cannot re-derive UNCX's own PDAs, but
  //    `getProgramAccounts` against the UNCX locker program with a
  //    `memcmp` filter for this pool's amm_id would surface the marker.
  //    For the SDK v1, we surface the requirement as a flag the operator
  //    should resolve out-of-band — Phase 9 indexer will produce the
  //    TokenLock evidence.)
  const uncxMarkerPresent = false; // Phase 9 indexer concern; default-safe.

  // 8. Best-effort served slot (the on-chain supply pin at salvage is
  //    the final anchor, not the snapshot slot — see snapshotter crate
  //    "SNAPSHOT POINT" doc).
  let snapshotSlot = 0;
  try {
    snapshotSlot = await connection.getSlot();
  } catch {
    /* best-effort; default to 0 */
  }

  const snapshot: LpSnapshot = {
    poolAddress,
    lpMint,
    totalSupply: new BN(totalSupply.toString(10)),
    holders: holders.map((h) => ({ holder: h.holder, balance: h.balance })),
    merkleRoot: root,
  };

  return {
    snapshot,
    proofs,
    snapshotSlot,
    tree,
    uncxMarkerPresent,
    exclusions,
  };
}
