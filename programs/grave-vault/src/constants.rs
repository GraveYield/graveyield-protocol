// SPDX-License-Identifier: Apache-2.0
//
// GraveVault constants. Charter invariants are encoded here as `const` and
// asserted by every code path that depends on them.

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

// Cross-program seeds we read from GraveScanner.
pub const ELIGIBILITY_CERT_SEED: &[u8] = b"eligibility_cert";
