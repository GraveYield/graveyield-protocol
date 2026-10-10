// SPDX-License-Identifier: Apache-2.0
//
// Adversary battery helpers — deterministic keys and hand-encoded
// account bodies. Every encoder here builds byte-exact Anchor shapes
// (mirroring ops/test/fixtures.ts) so the REAL SDK decoders run over
// hostile bytes. No mocks of the logic under test: fakes exist only at
// the RPC boundary, and most suites never even need one.

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

/** Deterministic 32-byte key from a seed (reproducible vectors). */
export function key(seed: string): PublicKey {
  return new PublicKey(createHash("sha256").update(`graveyield-adversary:${seed}`).digest());
}

/** Minimal big-endian-free LE byte writer (mirrors ops/test/fixtures.ts). */
export class ByteWriter {
  private readonly parts: number[] = [];

  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.parts.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  u32(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  u64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    this.parts.push(...b);
    return this;
  }
  i64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, v, true);
    this.parts.push(...b);
    return this;
  }
  u128(v: bigint): this {
    const b = new Uint8Array(16);
    new DataView(b.buffer).setBigUint64(0, v & 0xffff_ffff_ffff_ffffn, true);
    new DataView(b.buffer).setBigUint64(8, v >> 64n, true);
    this.parts.push(...b);
    return this;
  }
  pubkey(p: PublicKey): this {
    this.parts.push(...p.toBytes());
    return this;
  }
  bool(b: boolean): this {
    this.parts.push(b ? 1 : 0);
    return this;
  }
  bytes(arr: Uint8Array | number[]): this {
    this.parts.push(...arr);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** Canonical Raydium V4 AmmInfo offsets (mirror adapters/raydium_v4.rs). */
export const OFF_COIN_VAULT = 336;
export const OFF_PC_VAULT = 368;
export const OFF_COIN_VAULT_MINT = 400;
export const OFF_PC_VAULT_MINT = 432;
export const OFF_LP_MINT = 464;
export const AMM_INFO_SIZE = 752;

/** Synthetic 752-byte pool account with the given pubkeys planted. */
export function synthAmmInfo(mints: {
  coinVault: PublicKey;
  pcVault: PublicKey;
  coinMint: PublicKey;
  pcMint: PublicKey;
  lpMint: PublicKey;
}): Uint8Array {
  const buf = new Uint8Array(AMM_INFO_SIZE);
  buf.set(mints.coinVault.toBytes(), OFF_COIN_VAULT);
  buf.set(mints.pcVault.toBytes(), OFF_PC_VAULT);
  buf.set(mints.coinMint.toBytes(), OFF_COIN_VAULT_MINT);
  buf.set(mints.pcMint.toBytes(), OFF_PC_VAULT_MINT);
  buf.set(mints.lpMint.toBytes(), OFF_LP_MINT);
  return buf;
}

/** Read a pubkey from raw account bytes (for binding checks). */
export function readPubkeyAt(data: Uint8Array, offset: number): PublicKey {
  return new PublicKey(data.slice(offset, offset + 32));
}

/** Shared pool identity used across suites. */
export const POOL_A = key("pool-A");
export const POOL_B = key("pool-B");
export const MEME_MINT = key("memecoin-mint");
export const FAKE_WSOL = key("fake-wsol-never-real");

/** A slot hash — 32 arbitrary-but-fixed bytes. */
export const SLOT_HASH = createHash("sha256").update("slot-hash-vector").digest();

/** Deterministic "now" for timestamp vectors (fixed, reproducible). */
export const NOW = 1_735_689_600; // 2025-01-01T00:00:00Z
