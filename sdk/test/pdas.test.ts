// SPDX-License-Identifier: Apache-2.0
//
// PDA derivation tests — pins the SDK's PDA addresses against the
// on-chain `find_program_address` seeds declared in
// `programs/grave-scanner/src/constants.rs` and
// `programs/grave-vault/src/constants.rs`. Drift here would surface as
// Anchor `ConstraintSeeds` reverts on chain.
//
// The devnet program IDs (CuQZes... / Bd5smh...) are the REAL deployed
// addresses (DR-001/NS-2 fresh devnet deployment, 2026-10-25 — see
// docs/DECISIONS.md; the pre-refresh deployment is a frozen static
// reference). Test vectors derived against them pin the canonical PDAs
// the SDK will reproduce on chain.

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

const SCANNER = new PublicKey("CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54");
const VAULT = new PublicKey("Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg");
const AMM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const POOL = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const HOLDER = new PublicKey("11111111111111111111111111111111");

describe("PDA derivation — deterministic, canonical seeds", () => {
  test("scannerProtocolConfigPda is stable under [protocol_config] seeds", async () => {
    const pda = scannerProtocolConfigPda(SCANNER);
    assert.equal(
      pda.toBase58(),
      "Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD",
      "scanner ProtocolConfig PDA must match the devnet-deployed value (DR-001 fresh deployment)",
    );
  });

  test("vaultProtocolConfigPda is stable under [protocol_config] seeds", async () => {
    const pda = vaultProtocolConfigPda(VAULT);
    assert.equal(
      pda.toBase58(),
      "hyKk983fguE2CGA5Dx5TLKfBft1AJrm7CHoe1PTUipS",
      "vault ProtocolConfig PDA must match the devnet-deployed value (DR-001 fresh deployment)",
    );
  });

  test("eligibilityAnchorPda uses [eligibility_anchor, amm, pool] seeds", async () => {
    const pda = eligibilityAnchorPda(SCANNER, AMM, POOL);
    // Re-derive with the same seeds for cross-check
    const [expected] = await PublicKey.findProgramAddress(
      [Buffer.from("eligibility_anchor"), AMM.toBytes(), POOL.toBytes()],
      SCANNER,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("eligibilityCertPda uses [eligibility_cert, amm, pool] seeds", async () => {
    const pda = eligibilityCertPda(SCANNER, AMM, POOL);
    const [expected] = await PublicKey.findProgramAddress(
      [Buffer.from("eligibility_cert"), AMM.toBytes(), POOL.toBytes()],
      SCANNER,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("launchPricePda uses [launch_price, amm, pool] seeds", async () => {
    const pda = launchPricePda(SCANNER, AMM, POOL);
    const [expected] = await PublicKey.findProgramAddress(
      [Buffer.from("launch_price"), AMM.toBytes(), POOL.toBytes()],
      SCANNER,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("poolRegistryPda uses [pool_registry, pool] seeds", async () => {
    const pda = poolRegistryPda(VAULT, POOL);
    const [expected] = await PublicKey.findProgramAddress(
      [Buffer.from("pool_registry"), POOL.toBytes()],
      VAULT,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("salvageReceiptPda uses [salvage_receipt, pool] seeds", async () => {
    const pda = salvageReceiptPda(VAULT, POOL);
    const [expected] = await PublicKey.findProgramAddress(
      [Buffer.from("salvage_receipt"), POOL.toBytes()],
      VAULT,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("lpHolderPoolVaultPda uses [lp_holder_pool, pool] seeds", async () => {
    const pda = lpHolderPoolVaultPda(VAULT, POOL);
    const [expected] = await PublicKey.findProgramAddress(
      [Buffer.from("lp_holder_pool"), POOL.toBytes()],
      VAULT,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("claimRecordPda uses [claim_record, pool, holder] seeds", async () => {
    const pda = claimRecordPda(VAULT, POOL, HOLDER);
    const [expected] = await PublicKey.findProgramAddress(
      [Buffer.from("claim_record"), POOL.toBytes(), HOLDER.toBytes()],
      VAULT,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("protocolTreasuryPda is a singleton under [protocol_treasury]", async () => {
    const a = protocolTreasuryPda(VAULT);
    const b = protocolTreasuryPda(VAULT);
    assert.deepEqual(a.toBase58(), b.toBase58());
    const [expected] = await PublicKey.findProgramAddress(
      [Buffer.from("protocol_treasury")],
      VAULT,
    );
    assert.equal(a.toBase58(), expected.toBase58());
  });

  test("vaultAuthorityPda is a singleton under [vault_authority]", async () => {
    const pda = vaultAuthorityPda(VAULT);
    const [expected] = await PublicKey.findProgramAddress([Buffer.from("vault_authority")], VAULT);
    assert.equal(pda.toBase58(), expected.toBase58());
  });

  test("vaultSolHoldingPda uses [vault_sol_holding, pool] seeds", async () => {
    const pda = vaultSolHoldingPda(VAULT, POOL);
    const [expected] = await PublicKey.findProgramAddress(
      [Buffer.from("vault_sol_holding"), POOL.toBytes()],
      VAULT,
    );
    assert.equal(pda.toBase58(), expected.toBase58());
  });
});
