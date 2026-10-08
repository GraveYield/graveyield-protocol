// SPDX-License-Identifier: Apache-2.0
//
// PDA derivation — byte-locked mirrors of the on-chain constants in
// `programs/grave-scanner/src/constants.rs` and
// `programs/grave-vault/src/constants.rs`. The seeds below are the
// exact byte arrays the programs pass to `find_program_address`, so
// the SDK reproduces the same PDA addresses Anchor's `init` / `seeds`
// constraints accept.
//
// Drift here would surface as Anchor `ConstraintSeeds` reverts at
// runtime, not at compile time, so every seed is asserted against the
// program source via the on-chain test suites.

import { PublicKey } from "@solana/web3.js";

// ----------------------------------------------------------------- scanner

const SCANNER_PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config", "utf8");
const ELIGIBILITY_ANCHOR_SEED = Buffer.from("eligibility_anchor", "utf8");
const ELIGIBILITY_CERT_SEED = Buffer.from("eligibility_cert", "utf8");
const LAUNCH_PRICE_SEED = Buffer.from("launch_price", "utf8");

// ------------------------------------------------------------------- vault

const VAULT_PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config", "utf8");
const POOL_REGISTRY_SEED = Buffer.from("pool_registry", "utf8");
const LP_HOLDER_POOL_SEED = Buffer.from("lp_holder_pool", "utf8");
const SALVAGE_RECEIPT_SEED = Buffer.from("salvage_receipt", "utf8");
const CLAIM_RECORD_SEED = Buffer.from("claim_record", "utf8");
const PROTOCOL_TREASURY_SEED = Buffer.from("protocol_treasury", "utf8");
const VAULT_AUTHORITY_SEED = Buffer.from("vault_authority", "utf8");
const VAULT_SOL_HOLDING_SEED = Buffer.from("vault_sol_holding", "utf8");

// ---------------------------------------------------------- scanner PDAs

/** GraveScanner ProtocolConfig PDA — singleton under `["protocol_config"]`. */
export function scannerProtocolConfigPda(scannerProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SCANNER_PROTOCOL_CONFIG_SEED], scannerProgramId);
  return pda;
}

/** EligibilityAnchor PDA — `["eligibility_anchor", amm, pool]` under GraveScanner. */
export function eligibilityAnchorPda(
  scannerProgramId: PublicKey,
  ammProgramId: PublicKey,
  poolAddress: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [ELIGIBILITY_ANCHOR_SEED, ammProgramId.toBuffer(), poolAddress.toBuffer()],
    scannerProgramId,
  );
  return pda;
}

/** EligibilityCert PDA — `["eligibility_cert", amm, pool]` under GraveScanner. */
export function eligibilityCertPda(
  scannerProgramId: PublicKey,
  ammProgramId: PublicKey,
  poolAddress: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [ELIGIBILITY_CERT_SEED, ammProgramId.toBuffer(), poolAddress.toBuffer()],
    scannerProgramId,
  );
  return pda;
}

/** LaunchPrice PDA — `["launch_price", amm, pool]` under GraveScanner. Init-once per pool. */
export function launchPricePda(
  scannerProgramId: PublicKey,
  ammProgramId: PublicKey,
  poolAddress: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [LAUNCH_PRICE_SEED, ammProgramId.toBuffer(), poolAddress.toBuffer()],
    scannerProgramId,
  );
  return pda;
}

// ------------------------------------------------------------- vault PDAs

/** GraveVault ProtocolConfig PDA — singleton under `["protocol_config"]`. */
export function vaultProtocolConfigPda(vaultProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([VAULT_PROTOCOL_CONFIG_SEED], vaultProgramId);
  return pda;
}

/** PoolRegistry PDA — `["pool_registry", pool]` under GraveVault. Init-once at salvage. */
export function poolRegistryPda(vaultProgramId: PublicKey, poolAddress: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [POOL_REGISTRY_SEED, poolAddress.toBuffer()],
    vaultProgramId,
  );
  return pda;
}

/** SalvageReceipt PDA — `["salvage_receipt", pool]` under GraveVault. Init-once at salvage. */
export function salvageReceiptPda(vaultProgramId: PublicKey, poolAddress: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SALVAGE_RECEIPT_SEED, poolAddress.toBuffer()],
    vaultProgramId,
  );
  return pda;
}

/** LpHolderPoolVault PDA — `["lp_holder_pool", pool]` under GraveVault. Native-SOL system account. */
export function lpHolderPoolVaultPda(vaultProgramId: PublicKey, poolAddress: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [LP_HOLDER_POOL_SEED, poolAddress.toBuffer()],
    vaultProgramId,
  );
  return pda;
}

/** ClaimRecord PDA — `["claim_record", pool, lp_holder]` under GraveVault. Init-once per (pool, holder). */
export function claimRecordPda(
  vaultProgramId: PublicKey,
  poolAddress: PublicKey,
  lpHolder: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [CLAIM_RECORD_SEED, poolAddress.toBuffer(), lpHolder.toBuffer()],
    vaultProgramId,
  );
  return pda;
}

/** ProtocolTreasury PDA — singleton under `["protocol_treasury"]` under GraveVault. */
export function protocolTreasuryPda(vaultProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([PROTOCOL_TREASURY_SEED], vaultProgramId);
  return pda;
}

/** VaultAuthority PDA — singleton under `["vault_authority"]` under GraveVault. Inner-CPI signer. */
export function vaultAuthorityPda(vaultProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([VAULT_AUTHORITY_SEED], vaultProgramId);
  return pda;
}

/** VaultSolHoldingAccount PDA — `["vault_sol_holding", pool]` under GraveVault. Lazy-init at salvage. */
export function vaultSolHoldingPda(vaultProgramId: PublicKey, poolAddress: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [VAULT_SOL_HOLDING_SEED, poolAddress.toBuffer()],
    vaultProgramId,
  );
  return pda;
}

// ---------------------------------------------------- locker marker PDAs
//
// UNCX Raydium V4 per-pool lock marker PDA — derived under the UNCX
// locker program from `["global_lp_tracker", amm_id]`. Its presence on
// chain is the on-chain C5 evidence (LOCKER-001). The SDK does not
// re-derive UNCX's own PDAs (LOCKER-002 — the SDK surfaces an off-chain
// cross-check for non-UNCX lockers, but UNCX's own introspection is the
// on-chain adapter's job). We only expose the seed strings so the SDK
// can call `getProgramAccounts` against UNCX if an operator wants a
// preflight check.

export const UNCX_LP_TRACKER_SEED = Buffer.from("global_lp_tracker", "utf8");
