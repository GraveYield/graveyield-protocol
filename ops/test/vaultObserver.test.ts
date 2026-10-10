// SPDX-License-Identifier: Apache-2.0
//
// VaultObserver tests — the R1/R2 receipt invariants, C1–C3 claim
// accounting, failed-tx sweep, and alert wiring, all against canned
// accounts encoded with the SDK's own discriminators.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  AlertManager,
  HealthRegistry,
  VaultObserver,
  type ChainView,
  type OwnedAccount,
  type SignatureStatusEntry,
} from "../src/index.js";
import {
  encodeClaim,
  encodeReceipt,
  encodeRegistry,
  encodeVaultConfig,
  key,
  opaqueAccountBytes,
} from "./fixtures.js";

/** 40/40/20 of `total` — exact (multiple of 10 000). */
function fairSplit(total: bigint): { lpHolderAmountLamports: bigint; salvorAmountLamports: bigint; protocolAmountLamports: bigint } {
  return {
    lpHolderAmountLamports: (total * 4_000n) / 10_000n,
    salvorAmountLamports: (total * 4_000n) / 10_000n,
    protocolAmountLamports: (total * 2_000n) / 10_000n,
  };
}

interface Harness {
  observer: VaultObserver;
  health: HealthRegistry;
  alerts: AlertManager;
  alertLog: Array<{ code: string; severity: string; context: Record<string, unknown> }>;
  setAccounts(accounts: OwnedAccount[]): void;
  setSignatures(signatures: SignatureStatusEntry[]): void;
  failAccounts: { value: boolean };
  failSignatures: { value: boolean };
}

function harness(): Harness {
  const health = new HealthRegistry("test", () => 0);
  const alertLog: Harness["alertLog"] = [];
  const alerts = new AlertManager({ deliver: (a) => alertLog.push({ code: a.code, severity: a.severity, context: a.context }) }, 30 * 60 * 1000, () => 0);

  let accounts: OwnedAccount[] = [];
  let signatures: SignatureStatusEntry[] = [];
  const failAccounts = { value: false };
  const failSignatures = { value: false };

  const chain: ChainView = {
    async getProgramAccountsOwned() {
      if (failAccounts.value) throw new Error("RPC unreachable");
      return accounts;
    },
    async getRecentSignatures() {
      if (failSignatures.value) throw new Error("sig sweep unreachable");
      return signatures;
    },
    async getSlot() {
      return 424_242;
    },
    async getAccountInfo() {
      return null;
    },
  };

  const observer = new VaultObserver({
    vaultProgramId: new PublicKey("HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6"),
    chain,
    health,
    alerts,
    pollIntervalMs: 60_000,
    failedTxSweepLimit: 10,
  });

  return {
    observer,
    health,
    alerts,
    alertLog,
    setAccounts(next) {
      accounts = next;
    },
    setSignatures(next) {
      signatures = next;
    },
    failAccounts,
    failSignatures,
  };
}

function owned(pubkey: PublicKey, data: Uint8Array): OwnedAccount {
  return { pubkey, data, owner: new PublicKey("HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6"), lamports: 1_000_000 };
}

describe("VaultObserver — receipts (R1/R2)", () => {
  test("a fair 40/40/20 receipt passes both invariants with zero alerts", async () => {
    const h = harness();
    const total = 3_000_000n;
    const split = fairSplit(total);
    h.setAccounts([
      owned(key(0xa1), encodeReceipt({ pool: key(0x01), salvor: key(0x02), ...split, totalProceedsLamports: total })),
    ]);
    const observation = await h.observer.runOnce();
    assert.equal(observation.receipts.length, 1);
    assert.equal(observation.receipts[0]?.checks.r1Sum, true);
    assert.equal(observation.receipts[0]?.checks.r2Shares, true);
    assert.equal(observation.anomalousReceipts, 0);
    assert.equal(h.alertLog.length, 0);
  });

  test("a receipt whose legs do not sum to the total raises the critical alert", async () => {
    const h = harness();
    h.setAccounts([
      owned(
        key(0xa2),
        encodeReceipt({
          pool: key(0x01),
          salvor: key(0x02),
          lpHolderAmountLamports: 1_000_000n,
          salvorAmountLamports: 1_000_000n,
          protocolAmountLamports: 500_000n,
          totalProceedsLamports: 3_000_000n,
        }),
      ),
    ]);
    const observation = await h.observer.runOnce();
    assert.equal(observation.receipts[0]?.checks.r1Sum, false);
    assert.equal(observation.receipts[0]?.checks.r2Shares, false);
    assert.equal(observation.anomalousReceipts, 1);
    assert.ok(h.alertLog.some((a) => a.code === "receipt-sum-mismatch" && a.severity === "critical"));
  });

  test("a receipt with the right sum but a leg off by more than 1 lamport fails R2 only", async () => {
    const h = harness();
    // total = 3_000_001 (not a multiple of 10 000): the legs must absorb
    // the rounding remainder to keep R1 true. Here the LP leg takes 2
    // extra lamports (off its floor-share by 2 → R2 fails) while the
    // salvor leg stays within the ±1 tolerance and the protocol leg is
    // exact — and the sum still equals the total (R1 holds).
    h.setAccounts([
      owned(
        key(0xa3),
        encodeReceipt({
          pool: key(0x01),
          salvor: key(0x02),
          lpHolderAmountLamports: 1_200_002n, // floor share 1_200_000 → diff 2 → R2 fail
          salvorAmountLamports: 1_199_999n, // floor share 1_200_000 → diff 1 → tolerance
          protocolAmountLamports: 600_000n, // floor share 600_000 → exact
          totalProceedsLamports: 3_000_001n,
        }),
      ),
    ]);
    const observation = await h.observer.runOnce();
    assert.equal(observation.receipts[0]?.checks.r1Sum, true);
    assert.equal(observation.receipts[0]?.checks.r2Shares, false);
    assert.equal(observation.anomalousReceipts, 1);
  });

  test("a receipt within the 1-lamport rounding tolerance passes R2", async () => {
    const h = harness();
    h.setAccounts([
      owned(
        key(0xa4),
        encodeReceipt({
          pool: key(0x01),
          salvor: key(0x02),
          lpHolderAmountLamports: 1_199_999n, // exactly 1 lamport short
          salvorAmountLamports: 1_200_001n, // exactly 1 lamport over
          protocolAmountLamports: 600_000n,
          totalProceedsLamports: 3_000_000n,
        }),
      ),
    ]);
    const observation = await h.observer.runOnce();
    assert.equal(observation.receipts[0]?.checks.r1Sum, true);
    assert.equal(observation.receipts[0]?.checks.r2Shares, true);
    assert.equal(observation.anomalousReceipts, 0);
  });
});

describe("VaultObserver — claims (C1–C3)", () => {
  const pool = key(0x10);
  const holderA = key(0x20);
  const holderB = key(0x21);
  const total = 3_000_000n;
  const split = fairSplit(total); // lp 1_200_000

  test("claims reconcile against the registry and the receipt ceiling", async () => {
    const h = harness();
    h.setAccounts([
      owned(key(0xa5), encodeReceipt({ pool, salvor: key(0x02), ...split, totalProceedsLamports: total })),
      owned(key(0xa6), encodeRegistry({ pool, lpHolderPoolTotalLamports: split.lpHolderAmountLamports, lpHolderPoolClaimedLamports: 700_000n })),
      owned(key(0xa7), encodeClaim({ pool, lpHolder: holderA, amountLamports: 500_000n })),
      owned(key(0xa8), encodeClaim({ pool, lpHolder: holderB, amountLamports: 200_000n })),
    ]);
    const observation = await h.observer.runOnce();
    assert.equal(observation.rollups.length, 1);
    const rollup = observation.rollups[0];
    assert.ok(rollup);
    assert.equal(rollup.claims, 2);
    assert.equal(rollup.claimedLamports, 700_000n);
    assert.deepEqual(rollup.checks, { c1Accounted: true, c2WithinCeiling: true, c3Agrees: true });
    assert.equal(h.alertLog.length, 0);
  });

  test("claims exceeding the receipt's LP-holder leg raise the ceiling alert (C2)", async () => {
    const h = harness();
    h.setAccounts([
      owned(key(0xa9), encodeReceipt({ pool, salvor: key(0x02), ...split, totalProceedsLamports: total })),
      owned(key(0xb0), encodeRegistry({ pool, lpHolderPoolTotalLamports: split.lpHolderAmountLamports, lpHolderPoolClaimedLamports: 1_300_000n })),
      owned(key(0xb1), encodeClaim({ pool, lpHolder: holderA, amountLamports: 700_000n })),
      owned(key(0xb2), encodeClaim({ pool, lpHolder: holderB, amountLamports: 600_000n })),
    ]);
    const observation = await h.observer.runOnce();
    const rollup = observation.rollups[0];
    assert.ok(rollup);
    assert.equal(rollup.checks.c2WithinCeiling, false);
    assert.equal(observation.anomalousRollups, 1);
    assert.ok(h.alertLog.some((a) => a.code === "claim-accounting-anomaly" && a.severity === "critical"));
  });

  test("registry claimed total disagreeing with the claim records fails C1", async () => {
    const h = harness();
    h.setAccounts([
      owned(key(0xb3), encodeReceipt({ pool, salvor: key(0x02), ...split, totalProceedsLamports: total })),
      owned(key(0xb4), encodeRegistry({ pool, lpHolderPoolTotalLamports: split.lpHolderAmountLamports, lpHolderPoolClaimedLamports: 999_999n })),
      owned(key(0xb5), encodeClaim({ pool, lpHolder: holderA, amountLamports: 100_000n })),
    ]);
    const observation = await h.observer.runOnce();
    const rollup = observation.rollups[0];
    assert.ok(rollup);
    assert.equal(rollup.checks.c1Accounted, false);
    assert.equal(observation.anomalousRollups, 1);
  });

  test("registry total disagreeing with the receipt leg fails C3", async () => {
    const h = harness();
    h.setAccounts([
      owned(key(0xb6), encodeReceipt({ pool, salvor: key(0x02), ...split, totalProceedsLamports: total })),
      owned(key(0xb7), encodeRegistry({ pool, lpHolderPoolTotalLamports: split.lpHolderAmountLamports + 1n, lpHolderPoolClaimedLamports: 0n })),
    ]);
    const observation = await h.observer.runOnce();
    const rollup = observation.rollups[0];
    assert.ok(rollup);
    assert.equal(rollup.checks.c3Agrees, false);
    assert.equal(observation.anomalousRollups, 1);
  });
});

describe("VaultObserver — failed transactions + resilience", () => {
  test("failed vault transactions are surfaced and alerted (X1)", async () => {
    const h = harness();
    h.setAccounts([]);
    h.setSignatures([
      { signature: "sig-ok-1", err: null, slot: 100, confirmationStatus: "finalized" },
      { signature: "sig-bad-1", err: { InstructionError: [1, { Custom: 7009 }] }, slot: 101, confirmationStatus: "failed" },
    ]);
    const observation = await h.observer.runOnce();
    assert.equal(observation.failedTransactions.length, 1);
    assert.equal(observation.failedTransactions[0]?.signature, "sig-bad-1");
    assert.ok(h.alertLog.some((a) => a.code === "vault-tx-failed" && a.severity === "warn"));
  });

  test("unrecognized program-owned accounts are counted, never alerted", async () => {
    const h = harness();
    h.setAccounts([owned(key(0xc0), opaqueAccountBytes())]);
    const observation = await h.observer.runOnce();
    assert.equal(observation.receipts.length, 0);
    assert.equal(observation.claims.length, 0);
    assert.equal(h.alertLog.length, 0);
    const heartbeat = h.health.snapshot().components.find((c) => c.name === "vault-observer");
    assert.ok(heartbeat);
    assert.match(heartbeat.detail, /unknownAccts=1/);
  });

  test("the vault ProtocolConfig is decoded when present", async () => {
    const h = harness();
    h.setAccounts([owned(key(0xc1), encodeVaultConfig())]);
    const observation = await h.observer.runOnce();
    assert.ok(observation.vaultConfig);
    assert.equal(observation.vaultConfig.lpHolderShareBps, 4_000);
    assert.equal(observation.vaultConfig.maxSlippageBps, 300);
  });

  test("an RPC outage throws, heartbeats down, and raises the blind-observer alert", async () => {
    const h = harness();
    h.failAccounts.value = true;
    await assert.rejects(() => h.observer.runOnce(), /RPC unreachable/);
    assert.ok(h.alertLog.some((a) => a.code === "vault-accounts-unavailable" && a.severity === "critical"));
    const heartbeat = h.health.snapshot().components.find((c) => c.name === "vault-observer");
    assert.ok(heartbeat);
    assert.equal(heartbeat.status, "down");
  });

  test("a failing signature sweep degrades the cycle but keeps the accounting results", async () => {
    const h = harness();
    const total = 3_000_000n;
    const split = fairSplit(total);
    h.setAccounts([
      owned(key(0xc2), encodeReceipt({ pool: key(0x01), salvor: key(0x02), ...split, totalProceedsLamports: total })),
    ]);
    h.failSignatures.value = true;
    const observation = await h.observer.runOnce();
    assert.equal(observation.receipts.length, 1);
    assert.equal(observation.anomalousReceipts, 0);
    assert.equal(observation.failedTransactions.length, 0);
    const heartbeat = h.health.snapshot().components.find((c) => c.name === "vault-observer");
    assert.ok(heartbeat);
    assert.equal(heartbeat.status, "degraded");
  });
});
