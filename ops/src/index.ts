// SPDX-License-Identifier: Apache-2.0
//
// @graveyield/ops — Phase 11 infrastructure & observability.
//
//   health          HealthRegistry — component status, counters, snapshots
//   alerts          AlertManager + console/JSONL/webhook sinks
//   views           ChainView (injectable chain reads) + Connection adapter
//   vaultObserver   VaultObserver — receipts/claims/failed-tx indexing
//   merkleService   MerkleService — deterministic snapshot artifacts
//   indexerService  IndexerService — supervised GraveScannerV2 loop
//   scenarios       ScenarioRunner — SC-01/SC-02/SC-03 controlled scenarios
//   config          env-driven OpsConfig
//   cli             graveyield-ops entrypoints

export * from "./health.js";
export * from "./alerts.js";
export * from "./views.js";
export * from "./vaultObserver.js";
export * from "./merkleService.js";
export * from "./indexerService.js";
export * from "./scenarios.js";
export * from "./config.js";
export {
  main as opsMain,
  parseArgs as opsParseArgs,
  wireOps,
  type OpsWiring,
} from "./cli.js";
