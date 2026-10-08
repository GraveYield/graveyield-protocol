// SPDX-License-Identifier: Apache-2.0
//
// Raydium V4 AmmInfo reader — byte-locked mirror of the on-chain
// adapter `programs/grave-scanner/src/adapters/raydium_v4.rs` and the
// vault's own AmmInfo offsets in `programs/grave-vault/src/constants.rs`.
//
// AmmInfo is the canonical 752-byte pool-account layout. The fields
// the SDK needs are:
//
//   - coin_vault       (Pubkey) @ 336
//   - pc_vault         (Pubkey) @ 368
//   - coin_vault_mint  (Pubkey) @ 400
//   - pc_vault_mint    (Pubkey) @ 432
//   - lp_mint          (Pubkey) @ 464
//
// Reserves and the LP supply are NOT on the pool account itself — they
// live in the SPL token accounts at `coin_vault` / `pc_vault` (reserve
// balances) and the `lp_mint` (supply). The on-chain adapter passes
// those accounts via `remaining_accounts`; the SDK fetches them via
// `getAccountInfo` and parses the SPL layouts.

import { Connection, PublicKey } from "@solana/web3.js";
import { unpackAccount, unpackMint } from "@solana/spl-token";

// Re-export the network constants so SDK consumers can import everything
// from a single module if they prefer.
export {
  WSOL_MINT,
  RAYDIUM_V4_PROGRAM_ID,
  RAYDIUM_V4_AMM_AUTHORITY,
  SPL_TOKEN_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "./raydiumV4Constants.js";
import {
  WSOL_MINT as _WSOL,
  RAYDIUM_V4_PROGRAM_ID as _RAYDIUM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID as _SPL_TOKEN_PROGRAM_ID,
} from "./raydiumV4Constants.js";

/** Canonical AmmInfo account size on Raydium V4. */
export const RAYDIUM_V4_AMM_INFO_SIZE = 752;

const OFF = {
  COIN_VAULT: 336,
  PC_VAULT: 368,
  COIN_VAULT_MINT: 400,
  PC_VAULT_MINT: 432,
  LP_MINT: 464,
} as const;

/** Parsed Raydium V4 pool account — only the fields the SDK reads. */
export interface V4PoolAccount {
  poolAddress: PublicKey;
  /** Coin-side (base) vault SPL token account pubkey. */
  coinVault: PublicKey;
  /** Pc-side (quote) vault SPL token account pubkey. */
  pcVault: PublicKey;
  /** Mint held by `coinVault`. */
  baseMint: PublicKey;
  /** Mint held by `pcVault`. */
  quoteMint: PublicKey;
  /** Pool's LP mint. */
  lpMint: PublicKey;
}

/**
 * Parse the canonical AmmInfo fields from a 752-byte buffer. Throws on
 * a malformed account (wrong size). This is the same byte layout the
 * on-chain adapter asserts — drift surfaces as `PoolDataParseError`
 * (6009) at runtime.
 */
export function parseV4AmmInfo(poolAddress: PublicKey, data: Uint8Array): V4PoolAccount {
  if (data.length !== RAYDIUM_V4_AMM_INFO_SIZE) {
    throw new Error(
      `pool account is not a canonical ${RAYDIUM_V4_AMM_INFO_SIZE}-byte Raydium V4 AmmInfo (got ${data.length} bytes)`,
    );
  }
  return {
    poolAddress,
    coinVault: new PublicKey(data.slice(OFF.COIN_VAULT, OFF.COIN_VAULT + 32)),
    pcVault: new PublicKey(data.slice(OFF.PC_VAULT, OFF.PC_VAULT + 32)),
    baseMint: new PublicKey(data.slice(OFF.COIN_VAULT_MINT, OFF.COIN_VAULT_MINT + 32)),
    quoteMint: new PublicKey(data.slice(OFF.PC_VAULT_MINT, OFF.PC_VAULT_MINT + 32)),
    lpMint: new PublicKey(data.slice(OFF.LP_MINT, OFF.LP_MINT + 32)),
  };
}

/** Fetch a Raydium V4 pool account and parse the canonical fields. */
export async function fetchV4Pool(
  connection: Connection,
  poolAddress: PublicKey,
): Promise<V4PoolAccount> {
  const info = await connection.getAccountInfo(poolAddress);
  if (!info) {
    throw new Error(`pool account ${poolAddress.toBase58()} not found`);
  }
  if (!info.owner.equals(_RAYDIUM_V4_PROGRAM_ID)) {
    throw new Error(
      `pool account ${poolAddress.toBase58()} is owned by ${info.owner.toBase58()}, not Raydium V4`,
    );
  }
  return parseV4AmmInfo(poolAddress, info.data);
}

/** Read the SPL token account at `vault` and return its `amount` (raw, in base units). */
export async function readVaultReserve(connection: Connection, vault: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(vault);
  if (!info) {
    throw new Error(`vault token account ${vault.toBase58()} not found`);
  }
  if (!info.owner.equals(_SPL_TOKEN_PROGRAM_ID)) {
    throw new Error(
      `vault account ${vault.toBase58()} is owned by ${info.owner.toBase58()}, not SPL token`,
    );
  }
  const acct = unpackAccount(vault, info);
  return BigInt(acct.amount.toString());
}

/** Read an LP mint's supply (raw, in base units). */
export async function readLpMintSupply(connection: Connection, lpMint: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(lpMint);
  if (!info) {
    throw new Error(`LP mint ${lpMint.toBase58()} not found`);
  }
  if (!info.owner.equals(_SPL_TOKEN_PROGRAM_ID)) {
    throw new Error(
      `LP mint ${lpMint.toBase58()} is owned by ${info.owner.toBase58()}, not SPL token`,
    );
  }
  const mint = unpackMint(lpMint, info);
  return BigInt(mint.supply.toString());
}

/** Identify which side of the pool (coin/pc) is WSOL — `UnsupportedBaseToken` (7019) guard. */
export function identifyBaseToken(pool: V4PoolAccount): {
  /** The memecoin (non-WSOL) mint. */
  memecoinMint: PublicKey;
  /** True if the coin side is WSOL (the pc side is the memecoin). */
  coinIsWsol: boolean;
} {
  const coinIsWsol = pool.baseMint.equals(_WSOL);
  const pcIsWsol = pool.quoteMint.equals(_WSOL);
  if (coinIsWsol === pcIsWsol) {
    // 7019: exactly one side must be WSOL. Both WSOL or both non-WSOL
    // is rejected by salvage_pool before any CPI.
    throw new Error(
      `UnsupportedBaseToken (7019): pool ${pool.poolAddress.toBase58()} ` +
        `must have exactly one WSOL side — coin=${pool.baseMint.toBase58()}, pc=${pool.quoteMint.toBase58()}`,
    );
  }
  const memecoinMint = coinIsWsol ? pool.quoteMint : pool.baseMint;
  return { memecoinMint, coinIsWsol };
}

/**
 * Compute the pool's current price as quote-per-base in Q64.64
 * (the same math `grave_scanner::adapters::PoolData::current_price_q64x64`
 *  uses on chain). The result feeds the Criterion 2 collapse comparison.
 */
export function quotePerBaseQ64x64(baseReserve: bigint, quoteReserve: bigint): bigint {
  if (baseReserve <= 0n) return 0n;
  return (quoteReserve << 64n) / baseReserve;
}
