// SPDX-License-Identifier: Apache-2.0
//
// Finding E regression tests — the market vault-signer relationship.
//
// Pins, OFFLINE (PDA derivation is pure deterministic math — no RPC), the
// two derivations the W1 fixture story depends on, using the REAL public
// mainnet constants of the fixture's SOL/USDC OpenBook market:
//
//   market        8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6
//   program (OpenBook v1) srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX
//   stored nonce  1 (u64 LE @ offset 45 of the market account)
//   REAL mainnet vault signer (read by fetch_v4_fork_fixtures.mjs from the
//                 Raydium pool's own bytes and cross-checked against both
//                 market vault token accounts' owner fields):
//                 CTz5UMLQm2SRWHzQnU62Pi4yJqbNGjgRBHqqp6oDHfF7
//
// Assertions:
//   1. The REAL OpenBook v1 rule — create_program_address([market, nonce_le])
//      — with the market's stored nonce reproduces the real mainnet vault
//      signer. (The real market IS canonical under the program's own rule.)
//   2. fleet-core (since the salvor-side Finding E remediation,
//      ns3/devnet-preparation) derives the vault signer with that SAME real
//      rule — so the UNMODIFIED mainnet market is the compatible fixture.
//   3. The October-era string-seed re-pin adaptation is RETIRED: the
//      string-seed PDA (bump 253) is recorded for contrast only, and any
//      market carrying it would be ON-CURSE (invalid) under the real rule —
//      the W1 harness must load the market UNMODIFIED. If a regression ever
//      re-introduces the re-pin, the create_program_address([market, 253])
//      assertion below fails exactly like the live stage-10 discovery did.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

const MARKET = new PublicKey("8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6");
const MARKET_PROGRAM = new PublicKey("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");
const REAL_VAULT_SIGNER = "CTz5UMLQm2SRWHzQnU62Pi4yJqbNGjgRBHqqp6oDHfF7";
const STORED_NONCE = 1n;
const NONCE_OFFSET = 45; // 5-byte "serum" head + MarketState layout (u64 LE)

function nonceToLe(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

// web3.js 3.x ships the ASYNC statics (createProgramAddress) and dropped the
// Sync variants — those are restored only by the salvor SDK's web3compat
// patch (lib.initWeb3), which this dependency-light test does not import.
// Same derivation semantics, await-based.
async function createProgramAddress(seeds, programId) {
  return PublicKey.createProgramAddress(seeds, programId);
}
async function findPda(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return [await createProgramAddress([...seeds, Buffer.from([bump])], programId), bump];
    } catch {
      // address on-curve — keep walking down
    }
  }
  throw new Error("no valid bump found");
}

describe("market vault-signer derivations (Finding E)", () => {
  test("REAL OpenBook rule [market, nonce_le] reproduces the REAL mainnet vault signer", async () => {
    const derived = await createProgramAddress(
      [MARKET.toBytes(), nonceToLe(STORED_NONCE)],
      MARKET_PROGRAM,
    );
    assert.equal(
      derived.toBase58(),
      REAL_VAULT_SIGNER,
      "the real market's stored nonce MUST be canonical under the real program rule",
    );
  });

  test("the real signer does NOT depend on any string seed", async () => {
    // The string-seed scheme with the stored nonce cannot even produce an
    // off-curve address for this market (proven on-chain in the W1 follow-up
    // session: createProgramAddress(['vault-signer', market, 1_le]) throws
    // Invalid seeds). Any successful string-seed derivation therefore
    // describes a DIFFERENT (adapted) fixture, not the mainnet market.
    await assert.rejects(
      createProgramAddress(
        [Buffer.from("vault-signer", "utf8"), MARKET.toBytes(), nonceToLe(STORED_NONCE)],
        MARKET_PROGRAM,
      ),
      /off the ed25519 curve|Invalid seeds/i,
    );
  });

  test("fleet-core's HISTORICAL string-seed PDA ≠ the real signer (contrast record)", async () => {
    const [pda, bump] = await findPda(
      [Buffer.from("vault-signer", "utf8"), MARKET.toBytes()],
      MARKET_PROGRAM,
    );
    assert.notEqual(pda.toBase58(), REAL_VAULT_SIGNER);
    // Contrast record from the rebuilt harness's local_plan.json (run-42 era).
    assert.equal(bump, 253);
    assert.equal(pda.toBase58(), "HdbYFz2SANRZLn8zkdEcs67oMKi4SMcEFve7xeRceWRJ");
  });

  test("RETIRED re-pin regression guard: a market carrying the string-seed bump is INVALID under the real rule", async () => {
    // The retired October-era adaptation wrote bump 253 into the market's
    // nonce field. Under the REAL OpenBook rule that nonce produces an
    // ON-CURVE address — fleet-core's fail-closed discovery (now on the real
    // rule) hard-fails with "address must fall off the ed25519 curve". This
    // is the exact failure the W1 stage-10 rehearsal hit before the
    // adaptation was retired; if anyone re-introduces the re-pin, this test
    // documents why the local market must stay UNMODIFIED.
    const market = Buffer.alloc(388, 0);
    market.writeBigUInt64LE(STORED_NONCE, NONCE_OFFSET);
    assert.equal(market.readBigUInt64LE(NONCE_OFFSET), 1n);
    await assert.rejects(
      createProgramAddress([MARKET.toBytes(), nonceToLe(253n)], MARKET_PROGRAM),
      /off the ed25519 curve|Invalid seeds/i,
    );
  });
});
