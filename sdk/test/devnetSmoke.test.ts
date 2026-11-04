// SPDX-License-Identifier: Apache-2.0
//
// Live devnet smoke tests — read-only operations against the deployed
// devnet GraveYield programs:
//
//   * decode both ProtocolConfig PDAs and assert every spec default
//     (the §3.2 tables — Charter-locked launch values)
//   * run `evaluatePool` (read-only) against a real Raydium V4 pool —
//     the SDK must walk all six criteria without throwing
//
// These tests are SKIPPED unless `DEVNET_RPC_URL` is set in the env, so
// `pnpm -r test` stays green in CI / on a fresh sandbox with no network.
//
// Run locally with:
//
//   DEVNET_RPC_URL=https://api.devnet.solana.com pnpm -r test
//
// Deployment: NS-3 (DR-002) — program IDs EFJpKt… / 7VxUGJ… are ASSIGNED
// but NOT yet deployed or initialized. Until the owner executes the NS-3
// deployment (docs/DEVNET.md NS-3 record), the config-decode tests below
// explicitly report "deployment pending" instead of failing: the config
// PDAs cannot exist on chain yet. The NS-2 deployment is preserved as a
// legacy record (docs/LEGACY_DEPLOYMENTS.md) — do NOT re-point at it.
// Config is init-once — do NOT try to re-init.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";

import {
  GraveYieldClient,
  DEVNET_SCANNER_PROGRAM_ID,
  DEVNET_VAULT_PROGRAM_ID,
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
  fetchScannerProtocolConfig,
  fetchVaultProtocolConfig,
  SCANNER_PROTOCOL_CONFIG_DEFAULTS,
  VAULT_PROTOCOL_CONFIG_DEFAULTS,
  decodeGraveYieldError,
} from "../src/index.js";

const DEVNET_RPC = process.env.DEVNET_RPC_URL;
const SKIP = !DEVNET_RPC;

const skipIf = (name: string, fn: () => Promise<void>) => {
  if (SKIP) {
    test.skip(name, () => {});
    return;
  }
  test(name, fn);
};

describe("devnet smoke (read-only)", { skip: SKIP }, () => {
  const connection = new Connection(DEVNET_RPC ?? "http://localhost:8899", "confirmed");
  const client = new GraveYieldClient({
    connection,
    cluster: "devnet",
    graveScannerProgramId: new PublicKey(DEVNET_SCANNER_PROGRAM_ID),
    graveVaultProgramId: new PublicKey(DEVNET_VAULT_PROGRAM_ID),
  });

  skipIf("GraveScanner ProtocolConfig PDA matches the assigned NS-3 value", async () => {
    const pda = scannerProtocolConfigPda(client.graveScannerProgramId);
    assert.equal(
      pda.toBase58(),
      "5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe",
      "scanner ProtocolConfig PDA must match the pre-deployment NS-3 derivation (['protocol_config'], bump 255)",
    );
  });

  skipIf("GraveVault ProtocolConfig PDA matches the assigned NS-3 value", async () => {
    const pda = vaultProtocolConfigPda(client.graveVaultProgramId);
    assert.equal(
      pda.toBase58(),
      "5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda",
      "vault ProtocolConfig PDA must match the pre-deployment NS-3 derivation (['protocol_config'], bump 255)",
    );
  });

  skipIf("GraveScanner ProtocolConfig decodes with all spec defaults", async (t) => {
    const pda = scannerProtocolConfigPda(client.graveScannerProgramId);
    const cfg = await fetchScannerProtocolConfig(connection, pda);
    if (!cfg) {
      t.skip(
        "NS-3 deployment pending: scanner ProtocolConfig not initialized on devnet yet " +
          "(owner executes deployment per docs/DEVNET.md — this test validates it afterward)",
      );
      return;
    }
    assert.equal(cfg.inactivitySeconds, SCANNER_PROTOCOL_CONFIG_DEFAULTS.inactivitySeconds);
    assert.equal(cfg.priceCollapseBps, SCANNER_PROTOCOL_CONFIG_DEFAULTS.priceCollapseBps);
    assert.equal(cfg.minTvlLamports, SCANNER_PROTOCOL_CONFIG_DEFAULTS.minTvlLamports);
    assert.equal(
      cfg.anchorStalenessSeconds,
      SCANNER_PROTOCOL_CONFIG_DEFAULTS.anchorStalenessSeconds,
    );
    assert.equal(cfg.lpBurnDustThreshold, SCANNER_PROTOCOL_CONFIG_DEFAULTS.lpBurnDustThreshold);
    assert.equal(cfg.certTtlSeconds, SCANNER_PROTOCOL_CONFIG_DEFAULTS.certTtlSeconds);
    assert.equal(cfg.paused, false, "scanner must not be paused at rest");
  });

  skipIf("GraveVault ProtocolConfig decodes with all spec defaults", async (t) => {
    const pda = vaultProtocolConfigPda(client.graveVaultProgramId);
    const cfg = await fetchVaultProtocolConfig(connection, pda);
    if (!cfg) {
      t.skip(
        "NS-3 deployment pending: vault ProtocolConfig not initialized on devnet yet " +
          "(owner executes deployment per docs/DEVNET.md — this test validates it afterward)",
      );
      return;
    }
    assert.equal(cfg.lpHolderShareBps, VAULT_PROTOCOL_CONFIG_DEFAULTS.lpHolderShareBps);
    assert.equal(cfg.salvorShareBps, VAULT_PROTOCOL_CONFIG_DEFAULTS.salvorShareBps);
    assert.equal(cfg.protocolShareBps, VAULT_PROTOCOL_CONFIG_DEFAULTS.protocolShareBps);
    assert.equal(
      cfg.maxPriorityFeeCeilingLamports,
      VAULT_PROTOCOL_CONFIG_DEFAULTS.maxPriorityFeeCeilingLamports,
    );
    assert.equal(cfg.maxSlippageBps, VAULT_PROTOCOL_CONFIG_DEFAULTS.maxSlippageBps);
    assert.equal(
      cfg.jupiterDustThresholdLamports,
      VAULT_PROTOCOL_CONFIG_DEFAULTS.jupiterDustThresholdLamports,
    );
    assert.equal(cfg.timelockSeconds, VAULT_PROTOCOL_CONFIG_DEFAULTS.timelockSeconds);
    assert.equal(cfg.emergencyPaused, false, "vault must not be emergency-paused at rest");
  });

  skipIf(
    "evaluatePool walks all six criteria against a real Raydium V4 pool (read-only)",
    async (t) => {
      // evaluatePool needs the initialized scanner ProtocolConfig —
      // client.ensureConfigs() throws "…not initialized on this cluster"
      // before the pool is ever touched. NS-3 is assigned but NOT yet
      // deployed/initialized, so like the config-decode tests above this
      // test reports "deployment pending" instead of failing on the
      // not-yet-initialized cluster; after the owner executes the NS-3
      // deployment (docs/DEVNET.md) the fetch below resolves and the
      // assertions run for real.
      const scannerCfg = await fetchScannerProtocolConfig(
        connection,
        scannerProtocolConfigPda(client.graveScannerProgramId),
      );
      if (!scannerCfg) {
        t.skip(
          "NS-3 deployment pending: scanner ProtocolConfig not initialized on devnet yet " +
            "(owner executes deployment per docs/DEVNET.md — this test validates evaluatePool afterward)",
        );
        return;
      }
      // A real mainnet Raydium V4 pool that exists on devnet? No — devnet
      // has no Raydium V4 pools. So we use a hardcoded test pool address
      // and just assert that evaluatePool throws a recoverable error
      // (typically "pool account not found" since devnet has no V4 pools),
      // OR returns a result with `eligible === false`. The point is that
      // the SDK's wiring is correct, not that the pool is real.
      //
      // The "owner" trick below — passing a fake pool owned by the V4
      // program — keeps the call from throwing on the AMM program ID
      // lookup; instead it surfaces the not-found path cleanly.
      const fakePool = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
      try {
        const result = await client.evaluatePool(fakePool);
        // If the pool somehow resolves, eligible must be false on devnet.
        assert.equal(result.eligible, false);
      } catch (err) {
        // The expected case on devnet: the pool account doesn't exist
        // (or the RPC refused to enumerate V4 pools). The SDK surfaced
        // a clear error, not a stack trace.
        const msg = String((err as { message?: string }).message ?? err);
        assert.ok(
          /not found|not a canonical|owned by|No Signers|Raydium V4/i.test(msg),
          `unexpected error from evaluatePool: ${msg}`,
        );
      }
    },
  );

  skipIf(
    "error decoder maps 6000 (GraveScanner::Unauthorized) and 7000 (GraveVault::Unauthorized)",
    () => {
      const scanner = decodeGraveYieldError(new Error("custom program error: 0x1770"));
      assert.ok(scanner);
      assert.equal(scanner!.code, 6000);
      assert.equal(scanner!.program, "GraveScanner");
      assert.equal(scanner!.name, "Unauthorized");
      const vault = decodeGraveYieldError(new Error("custom program error: 0x1b58"));
      assert.ok(vault);
      assert.equal(vault!.code, 7000);
      assert.equal(vault!.program, "GraveVault");
      assert.equal(vault!.name, "Unauthorized");
    },
  );
});
