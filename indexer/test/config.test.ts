// SPDX-License-Identifier: Apache-2.0
//
// Config tests — pin the environment-driven configuration loader. The
// config has safe defaults for every parameter, so the indexer runs in
// discovery-only mode with zero configuration.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, DEVNET_SCANNER_PROGRAM_ID, DEFAULT_MIN_TVL_LAMPORTS } from "../src/index.js";

describe("loadConfig", () => {
  test("returns devnet defaults when no env is set", () => {
    // Clear all relevant env vars.
    const vars = ["RPC_URL", "CLUSTER", "SCANNER_PROGRAM_ID", "ACTIVITY_ORACLE_KEY", "MIN_TVL_LAMPORTS", "MAX_CANDIDATES_PER_CYCLE", "POLL_INTERVAL_MS", "MAX_POOLS_PER_SCAN", "SIGNATURE_SCAN_LIMIT"];
    const saved: Record<string, string | undefined> = {};
    for (const v of vars) { saved[v] = process.env[v]; delete process.env[v]; }

    const config = loadConfig();
    assert.equal(config.rpcUrl, "https://api.devnet.solana.com");
    assert.equal(config.cluster, "devnet");
    assert.equal(config.scannerProgramId.toBase58(), DEVNET_SCANNER_PROGRAM_ID.toBase58());
    assert.equal(config.minTvlLamports, DEFAULT_MIN_TVL_LAMPORTS);
    assert.equal(config.maxCandidatesPerCycle, 5);
    assert.equal(config.pollIntervalMs, 300_000);
    assert.equal(config.maxPoolsPerScan, 1000);
    assert.equal(config.signatureScanLimit, 1000);
    assert.equal(config.activityOracleSecretKey, null);

    // Restore env vars.
    for (const v of vars) { if (saved[v] !== undefined) process.env[v] = saved[v]; }
  });

  test("reads RPC_URL from env", () => {
    const saved = process.env.RPC_URL;
    process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
    const config = loadConfig();
    assert.equal(config.rpcUrl, "https://api.mainnet-beta.solana.com");
    if (saved !== undefined) process.env.RPC_URL = saved;
    else delete process.env.RPC_URL;
  });

  test("reads MIN_TVL_LAMPORTS from env", () => {
    const saved = process.env.MIN_TVL_LAMPORTS;
    process.env.MIN_TVL_LAMPORTS = "123456789";
    const config = loadConfig();
    assert.equal(config.minTvlLamports, 123456789n);
    if (saved !== undefined) process.env.MIN_TVL_LAMPORTS = saved;
    else delete process.env.MIN_TVL_LAMPORTS;
  });

  test("reads MAX_CANDIDATES_PER_CYCLE from env", () => {
    const saved = process.env.MAX_CANDIDATES_PER_CYCLE;
    process.env.MAX_CANDIDATES_PER_CYCLE = "10";
    const config = loadConfig();
    assert.equal(config.maxCandidatesPerCycle, 10);
    if (saved !== undefined) process.env.MAX_CANDIDATES_PER_CYCLE = saved;
    else delete process.env.MAX_CANDIDATES_PER_CYCLE;
  });

  test("CLUSTER=mainnet-beta sets cluster to mainnet-beta", () => {
    const saved = process.env.CLUSTER;
    process.env.CLUSTER = "mainnet-beta";
    const config = loadConfig();
    assert.equal(config.cluster, "mainnet-beta");
    if (saved !== undefined) process.env.CLUSTER = saved;
    else delete process.env.CLUSTER;
  });

  test("CLUSTER=devnet (or anything else) sets cluster to devnet", () => {
    const saved = process.env.CLUSTER;
    process.env.CLUSTER = "devnet";
    const config = loadConfig();
    assert.equal(config.cluster, "devnet");
    if (saved !== undefined) process.env.CLUSTER = saved;
    else delete process.env.CLUSTER;
  });
});
