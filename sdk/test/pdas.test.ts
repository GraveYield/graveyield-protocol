// SPDX-License-Identifier: Apache-2.0
//
// PDA derivation tests — pins the SDK's PDA addresses against the
// on-chain `find_program_address` seeds declared in
// `programs/grave-scanner/src/constants.rs` and
// `programs/grave-vault/src/constants.rs`. Drift here would surface as
// Anchor `ConstraintSeeds` reverts on chain.
//
// The devnet program IDs (5JiCVx... / HUyoG5...) are the REAL deployed
// addresses (handoff §3.2). Test vectors derived against them pin the
// canonical PDAs the SDK will reproduce on chain.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  scannerProtocolConfigPda,
  eligibilityAnchorPda,
  eligibilityCertPda,
  launchPricePda,
  vaultProtocolConfigPda,
  poolRegistryPda,
  salvageReceiptPda,
  lpHolderPoolVaultPda,
  claimRecordPda,
  protocolTreasuryPda,
  vaultAuthorityPda,
  vaultSolHoldingPda,
} from "../src/index.js";

const SCANNER = new PublicKey("5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF");
const VAULT = new PublicKey("HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6");
const AMM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const POOL = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const HOLDER = new PublicKey("11111111111111111111111111111111");

describe("PDA derivation — deterministic, canonical seeds", () => {
  test("scannerProtocolConfigPda is stable under [protocol_config] seeds", () => {
    const pda = scannerProtocolConfigPda(SCANNER);
    assert.equal(pda.toBase58(), "GcdZJhCpg7sjgEEHTsoSkT2Pi83d8kP3NrTqdvMm2Bhu",
      "scanner ProtocolConfig PDA must match the devnet-deployed value (handoff §3.2)");
  });

  test("vaultProtocolConfigPda is stable under [protocol_config] seeds", () => {
    const pda = vaultProtocolConfigPda(VAULT);
    assert.equal(pda.toBase58(), "2SCqqpEwKMuWnJWe7UQJTzFeDPif4jUPUspWKZdZ5vaU",
      "vault ProtocolConfig PDA must match the devnet-deployed value (handoff §3.2)");
  });

  test("eligibilityAnchorPda uses [eligibility_anchor, amm, pool] seeds", () => {
    const pda = eligibilityAnchorPda(SCANNER, AMM, POOL);
    // Re-derive with the same seeds for cross-check
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("eligibility_anchor"), AMM.toBuffer(), POOL.toBuffer()],
      SCANNER,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("eligibilityCertPda uses [eligibility_cert, amm, pool] seeds", () => {
    const pda = eligibilityCertPda(SCANNER, AMM, POOL);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("eligibility_cert"), AMM.toBuffer(), POOL.toBuffer()],
      SCANNER,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("launchPricePda uses [launch_price, amm, pool] seeds", () => {
    const pda = launchPricePda(SCANNER, AMM, POOL);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_price"), AMM.toBuffer(), POOL.toBuffer()],
      SCANNER,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("poolRegistryPda uses [pool_registry, pool] seeds", () => {
    const pda = poolRegistryPda(VAULT, POOL);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_registry"), POOL.toBuffer()],
      VAULT,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("salvageReceiptPda uses [salvage_receipt, pool] seeds", () => {
    const pda = salvageReceiptPda(VAULT, POOL);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("salvage_receipt"), POOL.toBuffer()],
      VAULT,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("lpHolderPoolVaultPda uses [lp_holder_pool, pool] seeds", () => {
    const pda = lpHolderPoolVaultPda(VAULT, POOL);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_holder_pool"), POOL.toBuffer()],
      VAULT,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("claimRecordPda uses [claim_record, pool, holder] seeds", () => {
    const pda = claimRecordPda(VAULT, POOL, HOLDER);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim_record"), POOL.toBuffer(), HOLDER.toBuffer()],
      VAULT,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("protocolTreasuryPda is a singleton under [protocol_treasury]", () => {
    const a = protocolTreasuryPda(VAULT);
    const b = protocolTreasuryPda(VAULT);
    assert.deepEqual(a.toBase58(), b.toBase58());
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_treasury")],
      VAULT,
    );
    assert.equal(a.toBase58(), expected.toBase58());
  });

  test("vaultAuthorityPda is a singleton under [vault_authority]", () => {
    const pda = vaultAuthorityPda(VAULT);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority")],
      VAULT,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("vaultSolHoldingPda uses [vault_sol_holding, pool] seeds", () => {
    const pda = vaultSolHoldingPda(VAULT, POOL);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_sol_holding"), POOL.toBuffer()],
      VAULT,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });
});
