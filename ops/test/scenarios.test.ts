// SPDX-License-Identifier: Apache-2.0
//
// ScenarioRunner tests — SC-01/SC-02 against canned services (real
// VaultObserver + IndexerService instances over a fake chain), SC-03
// prerequisite gating. Report persistence is exercised via a temp dir.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";

import {
  AlertManager,
  HealthRegistry,
  IndexerService,
  ScenarioRunner,
  VaultObserver,
  type ChainView,
  type OwnedAccount,
} from "../src/index.js";
import { encodeReceipt, encodeRegistry, encodeVaultConfig, key } from "./fixtures.js";

function fairSplit(total: bigint): { lpHolderAmountLamports: bigint; salvorAmountLamports: bigint; protocolAmountLamports: bigint } {
  return {
    lpHolderAmountLamports: (total * 4_000n) / 10_000n,
    salvorAmountLamports: (total * 4_000n) / 10_000n,
    protocolAmountLamports: (total * 2_000n) / 10_000n,
  };
}

interface World {
  runner: ScenarioRunner;
  health: HealthRegistry;
  accounts: OwnedAccount[];
  indexerThrow: { value: boolean };
  scannerResults: Array<{ poolAddress: PublicKey; status: "submitted" | "confirmed" | "failed" | "skipped"; anchorPda: PublicKey }>;
}

function world(stateDir?: string): World {
  const health = new HealthRegistry("scenario-test", () => Date.now());
  const alerts = new AlertManager({ deliver: () => {} }, 1000, () => Date.now());

  const world: World = {
    runner: undefined as unknown as ScenarioRunner,
    health,
    accounts: [],
    indexerThrow: { value: false },
    scannerResults: [],
  };

  const chain: ChainView = {
    async getProgramAccountsOwned() {
      return world.accounts;
    },
    async getRecentSignatures() {
      return [];
    },
    async getSlot() {
      return 999;
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
  });

  const scanner = {
    runOnce: async () => {
      if (world.indexerThrow.value) throw new Error("indexer exploded");
      return world.scannerResults;
    },
  };

  const indexerService = new IndexerService({
    scanner: scanner as never,
    health,
    alerts,
    submissionMode: false,
    pollIntervalMs: 60_000,
  });

  world.runner = new ScenarioRunner({ indexer: indexerService, observer, health, stateDir });
  return world;
}

describe("SC-01 lifecycle sweep", () => {
  test("a healthy indexer + clean vault sweep reports ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graveyield-ops-sc01-"));
    try {
      const w = world(dir);
      w.scannerResults = [{ poolAddress: key(0x01), status: "skipped", anchorPda: key(0x02) }];
      const report = await w.runner.sc01LifecycleSweep();
      assert.equal(report.id, "SC-01");
      assert.equal(report.ok, true);
      assert.ok(report.checks.every((c) => c.ok));
      assert.ok(report.reportPath);
      assert.ok(existsSync(report.reportPath));
      const persisted = JSON.parse(readFileSync(report.reportPath ?? "", "utf8")) as typeof report;
      assert.equal(persisted.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an indexer failure does not abort the sweep — it is reported as a failed check", async () => {
    const w = world();
    w.indexerThrow.value = true;
    const report = await w.runner.sc01LifecycleSweep();
    assert.equal(report.ok, false);
    const cycleCheck = report.checks.find((c) => c.id === "indexer-cycle");
    assert.ok(cycleCheck);
    assert.equal(cycleCheck.ok, false);
    assert.match(cycleCheck.detail, /indexer exploded/);
  });

  test("a vault accounting anomaly fails the vault-sweep check", async () => {
    const w = world();
    const total = 3_000_000n;
    w.accounts = [
      {
        pubkey: key(0xa1),
        data: encodeReceipt({
          pool: key(0x10),
          salvor: key(0x11),
          lpHolderAmountLamports: 1n,
          salvorAmountLamports: 1n,
          protocolAmountLamports: 1n,
          totalProceedsLamports: total,
        }),
        owner: new PublicKey("HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6"),
        lamports: 1,
      },
    ];
    const report = await w.runner.sc01LifecycleSweep();
    const sweepCheck = report.checks.find((c) => c.id === "vault-sweep");
    assert.ok(sweepCheck);
    assert.equal(sweepCheck.ok, false);
    assert.equal(report.ok, false);
  });

  test("missing wiring is reported, never thrown", async () => {
    const runner = new ScenarioRunner({});
    const report = await runner.sc01LifecycleSweep();
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((c) => c.id === "indexer-present" && !c.ok));
    assert.ok(report.checks.some((c) => c.id === "observer-present" && !c.ok));
  });
});

describe("SC-02 vault audit", () => {
  test("clean books pass every check", async () => {
    const w = world();
    const total = 3_000_000n;
    const split = fairSplit(total);
    const pool = key(0x10);
    w.accounts = [
      {
        pubkey: key(0xa1),
        data: encodeReceipt({ pool, salvor: key(0x11), ...split, totalProceedsLamports: total }),
        owner: new PublicKey("HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6"),
        lamports: 1,
      },
      {
        pubkey: key(0xa2),
        data: encodeRegistry({ pool, lpHolderPoolTotalLamports: split.lpHolderAmountLamports, lpHolderPoolClaimedLamports: 0n }),
        owner: new PublicKey("HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6"),
        lamports: 1,
      },
      {
        pubkey: key(0xa3),
        data: encodeVaultConfig(),
        owner: new PublicKey("HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6"),
        lamports: 1,
      },
    ];
    const report = await w.runner.sc02VaultAudit();
    assert.equal(report.id, "SC-02");
    assert.equal(report.ok, true);
    for (const id of ["r1-receipt-sums", "r2-receipt-shares", "c1-claim-accounting", "c2-claim-ceiling", "c3-registry-receipt-agree", "x1-failed-transactions", "vault-config-readback"]) {
      const check = report.checks.find((c) => c.id === id);
      assert.ok(check, `missing check ${id}`);
      assert.equal(check.ok, true, `check ${id} should pass`);
    }
  });

  test("a registry/receipt disagreement fails c3 and the report", async () => {
    const w = world();
    const total = 3_000_000n;
    const split = fairSplit(total);
    const pool = key(0x10);
    w.accounts = [
      {
        pubkey: key(0xa1),
        data: encodeReceipt({ pool, salvor: key(0x11), ...split, totalProceedsLamports: total }),
        owner: new PublicKey("HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6"),
        lamports: 1,
      },
      {
        pubkey: key(0xa2),
        data: encodeRegistry({ pool, lpHolderPoolTotalLamports: split.lpHolderAmountLamports + 5n, lpHolderPoolClaimedLamports: 0n }),
        owner: new PublicKey("HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6"),
        lamports: 1,
      },
    ];
    const report = await w.runner.sc02VaultAudit();
    const c3 = report.checks.find((c) => c.id === "c3-registry-receipt-agree");
    assert.ok(c3);
    assert.equal(c3.ok, false);
    assert.equal(report.ok, false);
  });
});

describe("SC-03 local rehearsal", () => {
  test("missing prerequisites are reported as failed checks and the run is skipped", () => {
    const runner = new ScenarioRunner({ repoRoot: "/nonexistent-repo-root" });
    const report = runner.sc03LocalRehearsal();
    assert.equal(report.id, "SC-03");
    assert.equal(report.ok, false);
    const run = report.checks.find((c) => c.id === "rehearsal-run");
    assert.ok(run);
    assert.equal(run.ok, false);
    assert.match(run.detail, /skipped|missing/);
  });
});
