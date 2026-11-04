// SPDX-License-Identifier: Apache-2.0
//
// PDA derivation tests — pins the SDK's PDA addresses against the
// on-chain `find_program_address` seeds declared in
// `programs/grave-scanner/src/constants.rs` and
// `programs/grave-vault/src/constants.rs`. Drift here would surface as
// Anchor `ConstraintSeeds` reverts on chain.
//
// The NS-3 devnet program IDs (EFJpKt… / 7VxUGJ…) are the ASSIGNED
// deployment identities (DR-002, owner-generated owner-held keypairs).
// The ProtocolConfig PDAs below are the pre-deployment derivations of
// ['protocol_config'] under those IDs (bump 255) — after the owner
// executes the NS-3 deployment they must match the on-chain readbacks
// byte-exactly. The NS-2 (CuQZes…/Bd5smh…) and NS-1 (5JiCVx…/HUyoG5…)
// deployments are preserved in docs/LEGACY_DEPLOYMENTS.md.

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

const SCANNER = new PublicKey("EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL");
const VAULT = new PublicKey("7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya");
const AMM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const POOL = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const HOLDER = new PublicKey("11111111111111111111111111111111");

describe("PDA derivation — deterministic, canonical seeds", () => {
  test("scannerProtocolConfigPda is stable under [protocol_config] seeds", async () => {
    const pda = scannerProtocolConfigPda(SCANNER);
    assert.equal(
      pda.toBase58(),
      "5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe",
      "scanner ProtocolConfig PDA must match the pre-deployment NS-3 derivation (bump 255)",
    );
  });

  test("vaultProtocolConfigPda is stable under [protocol_config] seeds", async () => {
    const pda = vaultProtocolConfigPda(VAULT);
    assert.equal(
      pda.toBase58(),
      "5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda",
      "vault ProtocolConfig PDA must match the pre-deployment NS-3 derivation (bump 255)",
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
