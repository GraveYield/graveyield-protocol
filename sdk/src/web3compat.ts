// SPDX-License-Identifier: Apache-2.0
//
// web3.js 3.x compatibility layer.
//
// web3.js 3.x removed the synchronous PDA-derivation API
// (`PublicKey.createProgramAddressSync` / `findProgramAddressSync`) and
// changed the `AccountInfo.data` generic from `Buffer` to `Uint8Array`.
// This module restores the missing pieces locally:
//
//   1. `createProgramAddressSync` / `findProgramAddressSync` — a byte-exact
//      mirror of the Solana runtime algorithm:
//
//        sha256(seed_0 || ... || seed_n || bump || program_id || "ProgramDerivedAddress")
//
//      rejected when the digest is a valid ed25519 curve point, bump
//      searched 255 -> 0, each seed capped at 32 bytes. The on-curve check
//      uses the 3.x public `PublicKey.isOnCurve`; hashing uses node's
//      `crypto.createHash("sha256")` (the same primitive the runtime uses).
//
//      Byte parity is pinned by `sdk/test/pdas.test.ts` regression vectors
//      against the addresses the on-chain programs derive via Anchor's
//      `seeds` constraints; any drift surfaces as `ConstraintSeeds` reverts
//      at runtime, so these vectors are load-bearing.
//
//   2. `asBufferAccount` — spl-token 0.4.x still types its `unpack*` helpers
//      against `AccountInfo<Buffer>`, while 3.x returns
//      `AccountInfo<Uint8Array>`. The adapter copies the account data into a
//      `Buffer` (byte-identical) so the SPL decoders accept the object.
//      Byte-parity is trivially preserved: `Buffer.from(uint8array)` copies
//      the same bytes.

import { createHash } from "node:crypto";

import { MAX_SEED_LENGTH, type AccountInfo, PublicKey } from "@solana/web3.js";

const PDA_DOMAIN_SEPARATOR = Buffer.from("ProgramDerivedAddress", "utf8");
const MAX_PDA_SEEDS = 16;

/** Byte-exact synchronous mirror of the runtime's `create_program_address`. */
export function createProgramAddressSync(
  seeds: Array<Uint8Array>,
  programId: PublicKey,
): PublicKey {
  if (seeds.length > MAX_PDA_SEEDS) {
    throw new Error(`Max number of PDA seeds exceeded: ${seeds.length} > ${MAX_PDA_SEEDS}`);
  }
  for (const seed of seeds) {
    if (seed.length > MAX_SEED_LENGTH) {
      throw new Error(`Max PDA seed length exceeded: ${seed.length} > ${MAX_SEED_LENGTH}`);
    }
  }
  const hasher = createHash("sha256");
  for (const seed of seeds) hasher.update(seed);
  hasher.update(programId.toBytes());
  hasher.update(PDA_DOMAIN_SEPARATOR);
  const digest = hasher.digest();
  if (PublicKey.isOnCurve(digest)) {
    throw new Error("Invalid seeds: address must fall off the ed25519 curve");
  }
  return new PublicKey(digest);
}

/**
 * Byte-exact synchronous mirror of the runtime's `find_program_address`:
 * bump searched 255 -> 0, first off-curve digest wins.
 */
export function findProgramAddressSync(
  seeds: Array<Uint8Array>,
  programId: PublicKey,
): [PublicKey, number] {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return [createProgramAddressSync([...seeds, Uint8Array.of(bump)], programId), bump];
    } catch {
      // digest landed on the curve — continue with the next bump
    }
  }
  throw new Error("Unable to find a viable program address bump");
}

/**
 * spl-token 0.4.x binds its `unpack*` helpers to `AccountInfo<Buffer>`;
 * web3.js 3.x hands out `AccountInfo<Uint8Array>`. Copy the data into a
 * `Buffer` (same bytes) so the SPL decoders accept the account object.
 */
export function asBufferAccount<T extends AccountInfo<Uint8Array>>(
  info: T,
): Omit<T, "data"> & { data: Buffer } {
  return { ...info, data: Buffer.from(info.data) };
}

// ---------------------------------------------------------------------------
// spl-token 0.4.x interop bridge.
//
// spl-token 0.4.x internally calls the 1.x-only `PublicKey.prototype.toBuffer()`
// (e.g. `getAssociatedTokenAddressSync` derives the ATA from
// `[owner.toBuffer(), programId.toBuffer(), mint.toBuffer()]`). Under web3.js 3.x
// those calls hit our `PublicKey` instances, which only expose `toBytes()`.
// Restore `toBuffer()` on the prototype as a byte-identical `Buffer` copy of
// `toBytes()` so every SPL entry point interoperates with 3.x keys. The guard
// makes this inert the moment either library ships a native implementation.
// ---------------------------------------------------------------------------
if (typeof (PublicKey.prototype as { toBuffer?: unknown }).toBuffer !== "function") {
  (PublicKey.prototype as unknown as { toBuffer(): Buffer }).toBuffer = function (
    this: PublicKey,
  ): Buffer {
    return Buffer.from(this.toBytes());
  };
}

// Restore the 1.x synchronous statics on the 3.x class (spl-token 0.4.x's
// `getAssociatedTokenAddressSync` calls `PublicKey.findProgramAddressSync`
// internally). The implementations ARE the byte-exact mirrors above, so the
// restored surface is identical to the removed 1.x API by construction.
const PublicKeyWithSync = PublicKey as typeof PublicKey & {
  createProgramAddressSync?: typeof createProgramAddressSync;
  findProgramAddressSync?: typeof findProgramAddressSync;
};
if (typeof PublicKeyWithSync.findProgramAddressSync !== "function") {
  PublicKeyWithSync.createProgramAddressSync = createProgramAddressSync;
  PublicKeyWithSync.findProgramAddressSync = findProgramAddressSync;
}
