// SPDX-License-Identifier: Apache-2.0
//
// External program IDs that the SDK references from instruction
// builders. Kept in a separate file so that the instruction builders
// can depend on them without pulling in the Raydium V4 pool parser
// (which itself pulls in @solana/spl-token and makes heavier use of
// `Connection`).
//
// Each constant mirrors the on-chain `constants.rs` in the respective
// program (see `programs/grave-vault/src/constants.rs`).

import { PublicKey } from "@solana/web3.js";

/** Wrapped SOL mint — fixed Solana network constant. */
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** Mainnet Raydium V4 AMM program ID. */
export const RAYDIUM_V4_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

/** Raydium V4 AMM authority PDA. Used to validate `amm_authority` remaining_accounts. */
export const RAYDIUM_V4_AMM_AUTHORITY = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");

/** Jupiter v6 aggregator program — mainnet. */
export const JUPITER_V6_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/** SPL Token program. */
export const SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** SPL Associated Token program. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** System program. */
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

/** Compute budget program (priority fee + compute unit limit instructions). */
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111");
