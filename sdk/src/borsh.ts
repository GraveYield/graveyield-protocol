// SPDX-License-Identifier: Apache-2.0
//
// Borsh writer — hand-rolled little-endian byte writer mirroring the
// Anchor borsh wire format. Used by every instruction builder in the
// SDK to construct instruction data without an IDL (the canonical
// pattern proven in `scripts/devnet/protocol_admin.mjs`).
//
// Anchor's instruction data is `discriminator(8) || borsh-serialised params`,
// where `discriminator = sha256("global:<snake_case_name>")[0..8]`. Account
// discriminators are `sha256("account:<PascalCase>")[0..8]` and live at the
// start of state accounts. Both are produced by `./discriminators.ts`.
//
// The writer tracks its own offset and refuses `done()` until exactly
// `size` bytes are filled — a borsh struct that doesn't fit (or that
// leaves bytes unwritten) is a bug at the SDK layer, not a runtime
// surprise on chain.

export interface BorshWriter {
  /** Append a raw byte buffer at the current offset. */
  bytes(b: Uint8Array): BorshWriter;
  /** Append a single byte. */
  u8(v: number): BorshWriter;
  /** Append a little-endian u16. */
  u16(v: number): BorshWriter;
  /** Append a little-endian u32. */
  u32(v: number): BorshWriter;
  /** Append a little-endian u64 (accepts number | bigint | string). */
  u64(v: number | bigint | string): BorshWriter;
  /** Append a little-endian i64 (accepts number | bigint | string). */
  i64(v: number | bigint | string): BorshWriter;
  /** Append a little-endian u128 (accepts number | bigint | string). */
  u128(v: number | bigint | string): BorshWriter;
  /** Append a little-endian i128 (accepts number | bigint | string). */
  i128(v: number | bigint | string): BorshWriter;
  /** Append a borsh bool (1 byte, 0 or 1). */
  bool(v: boolean): BorshWriter;
  /** Append a borsh `Option<T>` tag (0 = None, 1 = Some). */
  option<T>(v: T | null | undefined, some: (w: BorshWriter, v: T) => void): BorshWriter;
  /** Append a borsh `Vec<T>` (4-byte LE length prefix + each element). */
  vec<T>(items: ReadonlyArray<T>, each: (w: BorshWriter, v: T) => void): BorshWriter;
  /** Finalize: assert every byte was filled, return the underlying buffer. */
  done(): Uint8Array;
}

/** Create a borsh writer over a freshly-allocated `size`-byte buffer. */
export function writer(size: number): BorshWriter {
  if (!Number.isInteger(size) || size < 0) {
    throw new RangeError(`borsh writer size must be a non-negative integer, got ${size}`);
  }
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let at = 0;

  const assertRemaining = (n: number) => {
    if (at + n > buf.length) {
      throw new RangeError(`borsh writer overflow at offset ${at}: need ${n} more bytes, have ${buf.length - at}`);
    }
  };

  const w: BorshWriter = {
    bytes(b) {
      assertRemaining(b.length);
      buf.set(b, at);
      at += b.length;
      return w;
    },
    u8(v) {
      if (!Number.isInteger(v) || v < 0 || v > 0xff) {
        throw new RangeError(`u8 out of range: ${v}`);
      }
      assertRemaining(1);
      buf[at] = v;
      at += 1;
      return w;
    },
    u16(v) {
      if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
        throw new RangeError(`u16 out of range: ${v}`);
      }
      assertRemaining(2);
      view.setUint16(at, v, true);
      at += 2;
      return w;
    },
    u32(v) {
      if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
        throw new RangeError(`u32 out of range: ${v}`);
      }
      assertRemaining(4);
      view.setUint32(at, v, true);
      at += 4;
      return w;
    },
    u64(v) {
      const big = BigInt(v);
      if (big < 0n || big > 0xffff_ffff_ffff_ffffn) {
        throw new RangeError(`u64 out of range: ${big}`);
      }
      assertRemaining(8);
      view.setBigUint64(at, big, true);
      at += 8;
      return w;
    },
    i64(v) {
      const big = BigInt(v);
      if (big < -0x8000_0000_0000_0000n || big > 0x7fff_ffff_ffff_ffffn) {
        throw new RangeError(`i64 out of range: ${big}`);
      }
      assertRemaining(8);
      view.setBigInt64(at, big, true);
      at += 8;
      return w;
    },
    u128(v) {
      const big = BigInt(v);
      if (big < 0n || big > ((1n << 128n) - 1n)) {
        throw new RangeError(`u128 out of range: ${big}`);
      }
      assertRemaining(16);
      let cur = big;
      for (let i = 0; i < 16; i++) {
        buf[at + i] = Number(cur & 0xffn);
        cur >>= 8n;
      }
      at += 16;
      return w;
    },
    i128(v) {
      const big = BigInt(v);
      if (big < -(1n << 127n) || big > (1n << 127n) - 1n) {
        throw new RangeError(`i128 out of range: ${big}`);
      }
      assertRemaining(16);
      let cur = big;
      for (let i = 0; i < 16; i++) {
        buf[at + i] = Number(cur & 0xffn);
        cur >>= 8n;
      }
      at += 16;
      return w;
    },
    bool(v) {
      return w.u8(v ? 1 : 0);
    },
    option(v, some) {
      if (v === null || v === undefined) {
        return w.u8(0);
      }
      w.u8(1);
      some(w, v);
      return w;
    },
    vec(items, each) {
      w.u32(items.length);
      for (const item of items) {
        each(w, item);
      }
      return w;
    },
    done() {
      if (at !== buf.length) {
        throw new Error(`borsh writer filled ${at}/${buf.length} bytes — instruction data length is wrong`);
      }
      return buf;
    },
  };

  return w;
}

// ---------------------------------------------------------------- readers
//
// Hand-rolled little-endian readers mirroring the writer. Used by the
// account decoders to pull fields out of raw account bytes the same way
// `protocol_admin.mjs::decodeProtocolConfig` does.

export interface BorshReader {
  bytes(n: number): Uint8Array;
  u8(): number;
  u16(): number;
  u32(): number;
  u64(): bigint;
  i64(): bigint;
  u128(): bigint;
  i128(): bigint;
  bool(): boolean;
  /** Read a borsh `Vec<T>` of fixed-shape elements. */
  vec<T>(each: (r: BorshReader) => T): T[];
  remaining(): number;
  position(): number;
  seek(n: number): void;
}
export function reader(buf: Uint8Array): BorshReader {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 0;

  const assertRemaining = (n: number) => {
    if (at + n > buf.length) {
      throw new RangeError(`borsh reader underflow at offset ${at}: need ${n} more bytes, have ${buf.length - at}`);
    }
  };

  const r: BorshReader = {
    bytes(n) {
      assertRemaining(n);
      const out = buf.slice(at, at + n);
      at += n;
      return out;
    },
    u8() {
      assertRemaining(1);
      const v = buf[at];
      if (v === undefined) throw new RangeError(`borsh reader u8 underflow at ${at}`);
      at += 1;
      return v;
    },
    u16() {
      assertRemaining(2);
      const v = view.getUint16(at, true);
      at += 2;
      return v;
    },
    u32() {
      assertRemaining(4);
      const v = view.getUint32(at, true);
      at += 4;
      return v;
    },
    u64() {
      assertRemaining(8);
      const v = view.getBigUint64(at, true);
      at += 8;
      return v;
    },
    i64() {
      assertRemaining(8);
      const v = view.getBigInt64(at, true);
      at += 8;
      return v;
    },
    u128() {
      assertRemaining(16);
      let v = 0n;
      for (let i = 15; i >= 0; i--) {
        const b = buf[at + i];
        if (b === undefined) throw new RangeError(`borsh reader u128 underflow at ${at + i}`);
        v = (v << 8n) | BigInt(b);
      }
      at += 16;
      return v;
    },
    i128() {
      assertRemaining(16);
      const u = r.u128();
      const sign = u >> 127n;
      if (sign === 0n) return u;
      return u - (1n << 128n);
    },
    bool() {
      return r.u8() !== 0;
    },
    vec<T>(each: (r: BorshReader) => T): T[] {
      const len = r.u32();
      if (len > 0x100_0000) {
        throw new RangeError(`borsh vec length implausible: ${len}`);
      }
      const out: T[] = [];
      for (let i = 0; i < len; i++) {
        out.push(each(r));
      }
      return out;
    },
    remaining() {
      return buf.length - at;
    },
    position() {
      return at;
    },
    seek(n) {
      if (n < 0 || n > buf.length) {
        throw new RangeError(`borsh reader seek out of bounds: ${n}`);
      }
      at = n;
    },
  };

  return r;
}
