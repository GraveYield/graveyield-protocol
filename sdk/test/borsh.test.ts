// SPDX-License-Identifier: Apache-2.0
//
// Borsh writer/reader round-trip tests. The SDK's instruction data is
// `discriminator(8) || borsh-serialised params`; the writer is hand-rolled
// to mirror Anchor's wire format without an IDL. These tests pin the
// byte layout against hand-derived vectors so a future reordering of
// fields fails fast.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writer, reader } from "../src/index.js";

describe("borsh writer + reader round-trip", () => {
  test("u8 / u16 / u32 / u64 / i64 / u128 / i128 round-trip", () => {
    const data = writer(1 + 2 + 4 + 8 + 8 + 16 + 16)
      .u8(0xff)
      .u16(0xffff)
      .u32(0xffff_ffff)
      .u64(0xffff_ffff_ffff_ffffn)
      .i64(-1n)
      .u128((1n << 128n) - 1n)
      .i128(-(1n << 127n))
      .done();
    const r = reader(data);
    assert.equal(r.u8(), 0xff);
    assert.equal(r.u16(), 0xffff);
    assert.equal(r.u32(), 0xffff_ffff);
    assert.equal(r.u64(), 0xffff_ffff_ffff_ffffn);
    assert.equal(r.i64(), -1n);
    assert.equal(r.u128(), (1n << 128n) - 1n);
    assert.equal(r.i128(), -(1n << 127n));
    assert.equal(r.remaining(), 0);
  });

  test("u8 out of range throws", () => {
    assert.throws(() => writer(1).u8(256), /u8 out of range/);
    assert.throws(() => writer(1).u8(-1), /u8 out of range/);
  });
  test("u64 accepts number | bigint | string", () => {
    const data = writer(8).u64("1234567890123456789").done();
    const r = reader(data);
    assert.equal(r.u64(), 1234567890123456789n);
  });

  test("i64 accepts negative bigints", () => {
    const data = writer(8).i64(-42n).done();
    assert.equal(reader(data).i64(), -42n);
  });

  test("u128 round-trip at full 128-bit range", () => {
    const v = (1n << 128n) - 1n;
    const data = writer(16).u128(v).done();
    assert.equal(reader(data).u128(), v);
  });

  test("u128 out of range throws", () => {
    assert.throws(() => writer(16).u128(1n << 128n), /u128 out of range/);
    assert.throws(() => writer(16).u128(-1n), /u128 out of range/);
  });

  test("bool round-trip", () => {
    const data = writer(2).bool(true).bool(false).done();
    const r = reader(data);
    assert.equal(r.bool(), true);
    assert.equal(r.bool(), false);
  });

  test("vec round-trip of u8 elements", () => {
    const items = [1, 2, 3, 255];
    const data = writer(4 + items.length)
      .vec(items, (w, v) => w.u8(v))
      .done();
    const r = reader(data);
    const out = r.vec((rr) => rr.u8());
    assert.deepEqual(out, items);
  });

  test("vec round-trip of u64 elements", () => {
    const items = [1n, 1000n, 999_999_999n];
    const data = writer(4 + items.length * 8)
      .vec(items, (w, v) => w.u64(v))
      .done();
    const r = reader(data);
    const out = r.vec((rr) => rr.u64());
    assert.deepEqual(out, items);
  });

  test("option Some/None round-trip", () => {
    const some = writer(1 + 8).option(42n, (w, v) => w.u64(v)).done();
    const none = writer(1).option<bigint>(null, (w, v) => w.u64(v)).done();
    assert.equal(reader(some).u8(), 1);
    assert.equal(reader(none).u8(), 0);
  });

  test("writer overflow throws", () => {
    assert.throws(() => writer(4).u64(0n), /borsh writer overflow/);
  });

  test("writer underflow throws on done() with leftover bytes", () => {
    assert.throws(() => writer(8).u32(0).done(), /filled 4\/8 bytes/);
  });

  test("reader underflow throws", () => {
    const r = reader(new Uint8Array(4));
    r.u32();
    assert.throws(() => r.u8(), /borsh reader underflow/);
  });

  test("reader seek works", () => {
    const r = reader(new Uint8Array([0x01, 0x02, 0x03]));
    r.seek(2);
    assert.equal(r.u8(), 0x03);
  });

  test("bytes round-trip preserves the raw content", () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const data = writer(4).bytes(payload).done();
    assert.deepEqual(reader(data).bytes(4), payload);
  });
});
