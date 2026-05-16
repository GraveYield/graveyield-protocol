// SPDX-License-Identifier: Apache-2.0
//
// GraveVault constants. Charter invariants are encoded here as `const` and
// asserted by every code path that depends on them.

use anchor_lang::prelude::*;

// =====================================================================
// Charter-locked invariants. Governance CANNOT change these.
// =====================================================================

/// Maximum protocol share in basis points. Charter ceiling. Governance can
/// LOWER the runtime `protocol_share_bps` below this value, but
/// `update_protocol_config` rejects any attempt to raise it.
pub const PROTOCOL_SHARE_BPS_CEILING: u16 = 2_000; // 20.00%

/// Default protocol share at launch (matches the ceiling for symmetry of
/// the 40/40/20 split). Governance may lower below this.
pub const DEFAULT_PROTOCOL_SHARE_BPS: u16 = 2_000;

/// Default original-LP share at launch (40%). Together with `DEFAULT_SALVOR_SHARE_BPS`
/// and `DEFAULT_PROTOCOL_SHARE_BPS` this must sum to exactly 10_000 bps.
pub const DEFAULT_LP_HOLDER_SHARE_BPS: u16 = 4_000;

/// Default salvor share at launch (40%).
pub const DEFAULT_SALVOR_SHARE_BPS: u16 = 4_000;

/// Basis-point denominator. All share math: (amount * share_bps) / BPS_DENOMINATOR.
pub const BPS_DENOMINATOR: u64 = 10_000;

// =====================================================================
// Operational defaults (governance-tunable within bounds).
// =====================================================================

/// Default Charter-level priority fee ceiling (lamports per CU). 1 SOL is a
/// deliberately high safety rail, not an operational target. Salvor SDKs set
/// their own operational max under this ceiling (default = 25% of expected
/// profit margin) and refuse to submit transactions that would exceed it.
pub const DEFAULT_MAX_PRIORITY_FEE_CEILING_LAMPORTS: u64 = 1_000_000_000;

/// Default maximum slippage in basis points for the Jupiter swap leg (3%).
pub const DEFAULT_MAX_SLIPPAGE_BPS: u16 = 300;

/// Hard maximum slippage in basis points (10%). `update_protocol_config`
/// rejects any value above this regardless of multisig vote.
pub const HARD_MAX_SLIPPAGE_BPS: u16 = 1_000;

/// Default Jupiter dust threshold in lamports — skip swap if quote output
/// would be below this. Matches the operating-parameter brief.
pub const DEFAULT_JUPITER_DUST_THRESHOLD_LAMPORTS: u64 = 666_666;

/// Default timelock for parameter changes (72 hours, expressed in seconds).
pub const DEFAULT_TIMELOCK_SECONDS: i64 = 72 * 60 * 60;

// =====================================================================
// PDA seeds.
// =====================================================================

pub const PROTOCOL_CONFIG_SEED: &[u8] = b"protocol_config";
pub const POOL_REGISTRY_SEED: &[u8] = b"pool_registry";
pub const LP_HOLDER_POOL_SEED: &[u8] = b"lp_holder_pool";
pub const SALVAGE_RECEIPT_SEED: &[u8] = b"salvage_receipt";
pub const CLAIM_RECORD_SEED: &[u8] = b"claim_record";
pub const PROTOCOL_TREASURY_SEED: &[u8] = b"protocol_treasury";

/// Singleton vault authority PDA. Signs inner CPIs (Raydium withdraw,
/// Jupiter swap, system transfers from `vault_sol_holding_account`).
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";

/// Per-pool transient SOL holding PDA. Receives native SOL when the vault's
/// WSOL token account is closed after the Jupiter swap, before the 40/40/20
/// distribution transfers fan out. Lazy-init via `create_account` CPI on
/// first salvage of a given pool (same pattern as `lp_holder_pool_vault`).
pub const VAULT_SOL_HOLDING_SEED: &[u8] = b"vault_sol_holding";

// Cross-program seeds we read from GraveScanner.
pub const ELIGIBILITY_CERT_SEED: &[u8] = b"eligibility_cert";

// =====================================================================
// External program IDs (mainnet).
// =====================================================================

/// Wrapped SOL mint — fixed Solana network constant.
pub const WSOL_MINT: Pubkey = anchor_lang::solana_program::pubkey!(
    "So11111111111111111111111111111111111111112"
);

/// Raydium V4 AMM program — mainnet.
pub const RAYDIUM_V4_PROGRAM_ID: Pubkey = anchor_lang::solana_program::pubkey!(
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);

/// Raydium V4 AMM authority — fixed PDA derived from the V4 program.
/// Used to validate the `amm_authority` account passed by the salvor in
/// `remaining_accounts` rather than trusting it blindly.
pub const RAYDIUM_V4_AMM_AUTHORITY: Pubkey = anchor_lang::solana_program::pubkey!(
    "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
);

/// Raydium CLMM (concentrated liquidity) program — m5 honest-stub target.
pub const RAYDIUM_CLMM_PROGRAM_ID: Pubkey = anchor_lang::solana_program::pubkey!(
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
);

/// Orca Whirlpool program — m5 honest-stub target.
pub const ORCA_WHIRLPOOL_PROGRAM_ID: Pubkey = anchor_lang::solana_program::pubkey!(
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
);

/// PumpSwap program — m5 honest-stub target.
pub const PUMP_SWAP_PROGRAM_ID: Pubkey = anchor_lang::solana_program::pubkey!(
    "PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP"
);

/// Jupiter v6 aggregator program — mainnet.
pub const JUPITER_V6_PROGRAM_ID: Pubkey = anchor_lang::solana_program::pubkey!(
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);

// =====================================================================
// Raydium V4 withdraw CPI layout.
// =====================================================================

/// Instruction discriminator for Raydium V4 `Withdraw`. Per Raydium V4
/// `instruction.rs`, the tag is u8 = 4. Instruction data layout:
///   [tag: u8 = 4] [amount: u64 LE] = 9 bytes total.
pub const RAYDIUM_V4_INSTRUCTION_TAG_WITHDRAW: u8 = 4;

/// Number of `remaining_accounts` salvor must supply for the Raydium V4
/// withdraw CPI (pool internals + OpenBook market accounts that aren't in
/// the named `Accounts` struct). See `cpi/raydium_v4.rs` for the layout.
pub const RAYDIUM_V4_WITHDRAW_REMAINING_ACCOUNTS_REQUIRED: usize = 11;
