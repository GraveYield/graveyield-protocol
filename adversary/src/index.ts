// SPDX-License-Identifier: Apache-2.0
//
// @graveyield/adversary — public surface. The battery itself lives in
// `test/*.adversary.test.ts` (node:test suites, offline, real logic);
// this entry point exposes the taxonomy so docs tooling and the fleet
// can reference the case registry without importing test files.

export {
  THREAT_CLASSES,
  CASES,
  type ThreatClass,
  type VerdictKind,
  type BatteryLayer,
  type AdversaryCase,
} from "./taxonomy.js";
