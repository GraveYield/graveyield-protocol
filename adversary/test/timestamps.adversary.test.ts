// SPDX-License-Identifier: Apache-2.0
//
// ADV-TS — fake timestamps. The client is a byte pipe, not a validator:
// zero, negative, or future timestamps parse byte-exact and reach the
// chain unchanged, where the attestation family (6028/6029/6030/6031)
// refuses them (fork-proven freshness matrix; Rust ADV-TS-01 pins the
// clock-regression gate). These tests pin the client's CONTRACT: no
// silent coercion in either direction, and the one guard the client
// DOES own (slot-hash length) throws.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { buildAttestationMessage, parseAttestationMessage, ATTESTATION_MSG_LEN } from "@graveyield/sdk";
import { key, POOL_A, SLOT_HASH, NOW } from "./helpers.js";

describe("ADV-TS — fake timestamps", () => {
  test("ADV-TS-01: a non-32-byte slotHash cannot enter the wire format", () => {
    assert.throws(
      () =>
        buildAttestationMessage({
          ammProgramId: key("amm"),
          poolAddress: POOL_A,
          lastSwapUnixTs: NOW - 100 * 24 * 3600,
          issuedSlot: 28_000_000,
          slotHash: SLOT_HASH.slice(0, 31),
        }),
      /slotHash must be exactly 32 bytes/,
      "a truncated slot hash must be refused at build time",
    );
    // Oversized is equally refused.
    assert.throws(
      () =>
        buildAttestationMessage({
          ammProgramId: key("amm"),
          poolAddress: POOL_A,
          lastSwapUnixTs: NOW - 100 * 24 * 3600,
          issuedSlot: 28_000_000,
          slotHash: new Uint8Array(33),
        }),
      /slotHash must be exactly 32 bytes/,
    );
  });

  test("ADV-TS-02: zero / future timestamps round-trip byte-exact (no client coercion)", () => {
    const amm = key("amm-ts02");
    const build = (ts: number) =>
      parseAttestationMessage(
        buildAttestationMessage({
          ammProgramId: amm,
          poolAddress: POOL_A,
          lastSwapUnixTs: ts,
          issuedSlot: 28_000_000,
          slotHash: SLOT_HASH,
        }),
      );

    // The zero sentinel parses through — the CHAIN refuses it (6028).
    assert.equal(build(0).lastSwapUnixTs, 0);
    // A far-future timestamp parses through — the CHAIN refuses it (6028,
    // attested ts > clock). The client must not silently clamp it.
    const future = build(NOW + 365 * 24 * 3600);
    assert.equal(future.lastSwapUnixTs, NOW + 365 * 24 * 3600);
    assert.ok(future.poolAddress.equals(POOL_A));
  });

  test("ADV-TS-03: slot-hash binding is content-addressed — a swapped hash is a different attestation", () => {
    const amm = key("amm-ts03");
    const honest = buildAttestationMessage({
      ammProgramId: amm,
      poolAddress: POOL_A,
      lastSwapUnixTs: NOW - 100 * 24 * 3600,
      issuedSlot: 28_000_000,
      slotHash: SLOT_HASH,
    });
    const forged = Uint8Array.from(honest);
    forged.set(createHash("sha256").update("attacker-slot").digest(), 80);
    assert.notDeepEqual(Buffer.from(honest), Buffer.from(forged));
    // The forged variant parses with the attacker's hash — which will not
    // match SlotHashes on chain (6030), and a hash for a slot outside the
    // ~512-slot window is stale on arrival (6029). Both refusals are
    // fork-proven; the client contract is that the bytes pass through.
    const parsed = parseAttestationMessage(forged);
    assert.equal(parsed.issuedSlot, 28_000_000);
    assert.equal(parsed.lastSwapUnixTs, NOW - 100 * 24 * 3600);
  });
});
