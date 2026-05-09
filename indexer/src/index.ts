// SPDX-License-Identifier: Apache-2.0
//
// GraveScanner v2 — off-chain indexer.
//
// The on-chain GraveScanner program is the authority on eligibility for any
// specific pool. The off-chain indexer's job is the wide funnel: enumerate
// every AMM pool across supported programs, compute a cheap pre-filter for
// the six derelict criteria, and surface candidates to salvor bots that then
// run the on-chain Phase 1 / Phase 2 flow.
//
// Build sequence m9 — implementation lands after Anchor programs ship.

export * from "./scanner.js";
export * from "./eligibility.js";

async function main(): Promise<void> {
  // TODO(indexer m9): boot scanner against configured RPC, run forever.
  // Stub for scaffold only.
  // eslint-disable-next-line no-console
  console.log("graveyield-indexer: scaffold (m9 not yet implemented)");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
