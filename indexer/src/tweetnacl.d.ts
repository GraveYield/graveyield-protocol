// SPDX-License-Identifier: Apache-2.0
//
// Ambient type declaration for `tweetnacl` (runtime dep, ^1.0.3).
// tweetnacl ships no type definitions and no @types package was fetchable
// at the time of writing, so this file declares the ONE call surface the
// indexer uses: deriving an Ed25519 public key from a 32-byte secret
// (indexer/src/config.ts — ACTIVITY_ORACLE_KEY parsing). Keep it in sync
// if additional nacl surfaces are ever adopted; anything narrower than
// the real API is intentional here.

export interface NaclSignKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface NaclSign {
  keyPair: (() => NaclSignKeyPair) & {
    fromSecretKey(secretKey: Uint8Array): NaclSignKeyPair;
  };
}

declare module "tweetnacl" {
  interface Nacl {
    sign: NaclSign;
  }
  const nacl: Nacl;
  export default nacl;
}
