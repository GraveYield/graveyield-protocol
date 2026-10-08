// SPDX-License-Identifier: Apache-2.0
//
// Discriminator tests — pin the 8-byte Anchor prefixes against the
// values `protocol_admin.mjs` (the IDL-free pattern proven on devnet)
// computes. Any drift here would surface as a wrong-instruction
// dispatch on chain.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { ScannerIx, VaultIx, AccountDisc, globalDiscriminator, accountDiscriminator } from "../src/index.js";

function sha256(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s).digest().subarray(0, 8));
}

describe("instruction discriminators (IDL-free pattern)", () => {
  test("ScannerIx.initialize matches sha256('global:initialize')[0..8]", () => {
    assert.deepEqual(Buffer.from(ScannerIx.initialize), Buffer.from(sha256("global:initialize")));
  });
  test("ScannerIx.recordLaunchPrice matches sha256('global:record_launch_price')[0..8]", () => {
    assert.deepEqual(Buffer.from(ScannerIx.recordLaunchPrice), Buffer.from(sha256("global:record_launch_price")));
  });
  test("ScannerIx.evaluatePoolPhase1 matches sha256('global:evaluate_pool_phase_1')[0..8]", () => {
    assert.deepEqual(Buffer.from(ScannerIx.evaluatePoolPhase1), Buffer.from(sha256("global:evaluate_pool_phase_1")));
  });
  test("ScannerIx.evaluatePoolPhase2 matches sha256('global:evaluate_pool_phase_2')[0..8]", () => {
    assert.deepEqual(Buffer.from(ScannerIx.evaluatePoolPhase2), Buffer.from(sha256("global:evaluate_pool_phase_2")));
  });
  test("ScannerIx.invalidateAnchor matches sha256('global:invalidate_anchor')[0..8]", () => {
    assert.deepEqual(Buffer.from(ScannerIx.invalidateAnchor), Buffer.from(sha256("global:invalidate_anchor")));
  });
  test("ScannerIx.sweepStaleAnchor matches sha256('global:sweep_stale_anchor')[0..8]", () => {
    assert.deepEqual(Buffer.from(ScannerIx.sweepStaleAnchor), Buffer.from(sha256("global:sweep_stale_anchor")));
  });
  test("ScannerIx.updateProtocolConfig matches sha256('global:update_protocol_config')[0..8]", () => {
    assert.deepEqual(Buffer.from(ScannerIx.updateProtocolConfig), Buffer.from(sha256("global:update_protocol_config")));
  });
  test("ScannerIx.emergencyPause matches sha256('global:emergency_pause')[0..8]", () => {
    assert.deepEqual(Buffer.from(ScannerIx.emergencyPause), Buffer.from(sha256("global:emergency_pause")));
  });

  test("VaultIx.salvagePool matches sha256('global:salvage_pool')[0..8]", () => {
    assert.deepEqual(Buffer.from(VaultIx.salvagePool), Buffer.from(sha256("global:salvage_pool")));
  });
  test("VaultIx.claimLpProceeds matches sha256('global:claim_lp_proceeds')[0..8]", () => {
    assert.deepEqual(Buffer.from(VaultIx.claimLpProceeds), Buffer.from(sha256("global:claim_lp_proceeds")));
  });
  test("VaultIx.sweepDust matches sha256('global:sweep_dust')[0..8]", () => {
    assert.deepEqual(Buffer.from(VaultIx.sweepDust), Buffer.from(sha256("global:sweep_dust")));
  });
  test("VaultIx.emergencyPause matches sha256('global:emergency_pause')[0..8]", () => {
    assert.deepEqual(Buffer.from(VaultIx.emergencyPause), Buffer.from(sha256("global:emergency_pause")));
  });
  test("VaultIx.updateProtocolConfig matches sha256('global:update_protocol_config')[0..8]", () => {
    assert.deepEqual(Buffer.from(VaultIx.updateProtocolConfig), Buffer.from(sha256("global:update_protocol_config")));
  });
});

describe("account discriminators", () => {
  test("AccountDisc.ProtocolConfig matches sha256('account:ProtocolConfig')[0..8]", () => {
    assert.deepEqual(Buffer.from(AccountDisc.ProtocolConfig), Buffer.from(sha256("account:ProtocolConfig")));
  });
  test("AccountDisc.EligibilityAnchor matches sha256('account:EligibilityAnchor')[0..8]", () => {
    assert.deepEqual(Buffer.from(AccountDisc.EligibilityAnchor), Buffer.from(sha256("account:EligibilityAnchor")));
  });
  test("AccountDisc.EligibilityCert matches sha256('account:EligibilityCert')[0..8]", () => {
    assert.deepEqual(Buffer.from(AccountDisc.EligibilityCert), Buffer.from(sha256("account:EligibilityCert")));
  });
  test("AccountDisc.LaunchPrice matches sha256('account:LaunchPrice')[0..8]", () => {
    assert.deepEqual(Buffer.from(AccountDisc.LaunchPrice), Buffer.from(sha256("account:LaunchPrice")));
  });
  test("AccountDisc.PoolRegistry matches sha256('account:PoolRegistry')[0..8]", () => {
    assert.deepEqual(Buffer.from(AccountDisc.PoolRegistry), Buffer.from(sha256("account:PoolRegistry")));
  });
  test("AccountDisc.SalvageReceipt matches sha256('account:SalvageReceipt')[0..8]", () => {
    assert.deepEqual(Buffer.from(AccountDisc.SalvageReceipt), Buffer.from(sha256("account:SalvageReceipt")));
  });
  test("AccountDisc.ClaimRecord matches sha256('account:ClaimRecord')[0..8]", () => {
    assert.deepEqual(Buffer.from(AccountDisc.ClaimRecord), Buffer.from(sha256("account:ClaimRecord")));
  });
});

describe("discriminator helpers", () => {
  test("globalDiscriminator(snakeName) = sha256('global:'+name)[0..8]", () => {
    const d = globalDiscriminator("claim_lp_proceeds");
    assert.deepEqual(Buffer.from(d), Buffer.from(sha256("global:claim_lp_proceeds")));
  });
  test("accountDiscriminator(PascalName) = sha256('account:'+name)[0..8]", () => {
    const d = accountDiscriminator("PoolRegistry");
    assert.deepEqual(Buffer.from(d), Buffer.from(sha256("account:PoolRegistry")));
  });
});
