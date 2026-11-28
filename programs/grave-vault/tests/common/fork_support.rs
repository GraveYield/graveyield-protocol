// SPDX-License-Identifier: Apache-2.0
//
// fork_support — shared fixture-loading + skip-integrity plumbing for the
// seven fork-integration suites under programs/grave-vault/tests/.
//
// WHY THIS MODULE EXISTS (test-infrastructure audit, 2026-11): every suite
// carried its own copy of `add_elf()` / `load_manifest()`, and the copies
// had drifted into a verification-integrity bug: a missing REQUIRED fixture
// printed "SKIP" and then returned `required` — i.e. reported success — so
// the suite booted a genesis with programs silently absent and failed later
// with misleading errors (e.g. `vault initialize failed:
// TransactionError(ProgramAccountNotFound)`), or worse, green-lit a suite
// that never executed its assertions.
//
// THE TWO WORKFLOWS this module keeps apart:
//
//   Workflow A — ordinary workspace testing (`cargo test --workspace`):
//     No fork fixtures are required, no network is touched. A suite whose
//     fork fixtures are genuinely absent SKIPS with a loud `SKIP:` banner
//     and a normal return (documented fixture-less behavior). A CORRUPT
//     manifest (present but unparseable) and a present-but-UNREADABLE
//     manifest (any filesystem error other than NotFound) are broken local
//     fixture states, not absence — both fail loudly in both workflows.
//     The same classification applies to program ELFs in `add_elf_from`:
//     only NotFound means absence there too — an existing-but-unreadable
//     ELF (EISDIR, EACCES, EIO, ...) is a broken fixture state and fails
//     loudly for required AND optional registrations alike.
//
//   Workflow B — explicit fork-harness testing (`scripts/build_fork_harness.sh`):
//     The script exports GRAVEYIELD_FORK_HARNESS=1 and verifies every
//     prerequisite before running the suites. Under that flag a missing
//     required fixture FAILS the suite (`harness_skip` panics) instead of
//     skipping, so the harness can never report success while a suite
//     silently skipped its actual assertions.
//
// Optional fixture configurations (e.g. the manifest's `orientation_pool`
// section, which the fetcher writes only when an inverted-orientation pool
// could be loaded from mainnet) stay skippable in BOTH workflows, but the
// skip prints a banner so the harness log always shows what did NOT run.
#![allow(deprecated)]
// bpf_loader facade re-export
// Each of the eight consuming targets (seven suites + the regression target)
// uses a different subset of this plumbing, so some items are always
// unused per target. The allow is scoped to this module only.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use serde_json::Value;
use solana_program_test::ProgramTest;
use solana_sdk::{account::Account, bpf_loader, pubkey::Pubkey};

/// Set to exactly "1" by `scripts/build_fork_harness.sh` for the explicit
/// fork-harness run (Workflow B). Any other value — including absent —
/// means ordinary workspace mode (Workflow A).
pub const HARNESS_ENV: &str = "GRAVEYIELD_FORK_HARNESS";

/// True when the suite runs under the explicit fork harness.
pub fn harness_mode() -> bool {
    matches!(std::env::var(HARNESS_ENV).as_deref(), Ok("1"))
}

/// The failure side of `skip_or_fail!`: under the explicit harness a
/// required-fixture skip is a test FAILURE with an actionable message;
/// this is what makes silent skips impossible in Workflow B.
pub fn harness_skip(reason: &str) -> ! {
    panic!(
        "FORK-HARNESS FAILURE: {reason}. scripts/build_fork_harness.sh must not report success \
         while required fork tests skip — build/fetch the fixtures or fix the harness first."
    )
}

/// Skip-integrity gate for test bodies (Workflow A vs B). Expands to a
/// loud `SKIP:` + `return` in ordinary workspace mode, and to a test
/// FAILURE under the explicit fork harness. Only for fns returning `()`;
/// helpers that must propagate absence use `Option` + `?` instead.
macro_rules! skip_or_fail {
    ($($arg:tt)*) => {
        if crate::fork_support::harness_mode() {
            crate::fork_support::harness_skip(&format!($($arg)*));
        } else {
            eprintln!("SKIP: {}", format!($($arg)*));
            return;
        }
    };
}

/// The suite fixture directory (gitignored; populated by
/// `scripts/build_fork_harness.sh` = build + fetch).
pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

/// The fork fixture manifest, or None when it is genuinely ABSENT
/// (fixture-less workspace run — the caller decides skip vs fail).
///
/// A present-but-unparseable manifest is NEVER mapped to None: a truncated
/// or hand-edited manifest.json must fail loudly in both workflows instead
/// of masquerading as "fixtures absent" and silently skipping the suite.
/// The same holds for a present-but-unreadable manifest: `ErrorKind::
/// NotFound` alone means absence; any other filesystem error (EISDIR,
/// EACCES, EIO, ...) is a broken fixture state and panics with the path
/// and the underlying error.
pub fn load_manifest() -> Option<Value> {
    load_manifest_from(&fixtures_dir())
}

/// `load_manifest` against an explicit directory (injection seam for the
/// regression tests).
///
/// Error classification (do not weaken — pinned by fork_support_regression):
///   - `ErrorKind::NotFound` only: None (genuinely absent fixtures);
///   - any other filesystem error: loud panic with path + underlying error;
///   - invalid JSON: loud "is corrupt" panic (never absence);
///   - valid JSON: Some(manifest).
pub fn load_manifest_from(dir: &Path) -> Option<Value> {
    let path = dir.join("manifest.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "SKIP: fork fixtures not found at {} — run scripts/build_fork_harness.sh (builds the program ELFs and fetches the mainnet fixtures)",
                path.display()
            );
            return None;
        }
        Err(e) => panic!(
            "FORK-FIXTURE BROKEN: {} cannot be read: {e} — a present-but-unreadable fixture state \
             must never masquerade as \"fixtures absent\"; fix the manifest (its mount, \
             permissions, or the file itself) before running the fork suites",
            path.display()
        ),
    };
    match serde_json::from_str(&text) {
        Ok(v) => Some(v),
        Err(e) => panic!(
            "fork fixture manifest at {} is corrupt: {e} — re-run scripts/fetch_v4_fork_fixtures.mjs",
            path.display()
        ),
    }
}

/// Register a fixture ELF as an executable program account under `id`.
///
/// Returns true IFF the ELF was read and registered. A genuinely ABSENT
/// file (NotFound) is never reported as success: it prints one explicit
/// line per registration (distinguishing required from optional) and
/// returns false. The CALLER decides between skip and failure via
/// `skip_or_fail!` — this function only refuses to fabricate a success.
/// A present-but-unreadable file is NOT absence: it fails loudly (see
/// `add_elf_from`).
pub fn add_elf(pt: &mut ProgramTest, file: &str, id: Pubkey, required: bool) -> bool {
    add_elf_from(&fixtures_dir(), pt, file, id, required)
}

/// `add_elf` against an explicit directory (injection seam for the
/// regression tests). Same registration shape the suites always used
/// (bpf_loader-owned executable account).
///
/// Error classification (do not weaken — pinned by fork_support_regression):
///   - `ErrorKind::NotFound` only: the file is genuinely absent — print the
///     required/optional line and return false (the caller decides skip vs
///     fail via `skip_or_fail!`);
///   - any other filesystem error (EISDIR, EACCES, EIO, ...): loud panic
///     with path + underlying error, for required AND optional fixtures —
///     a present-but-unreadable fixture must never masquerade as absent.
pub fn add_elf_from(
    dir: &Path,
    pt: &mut ProgramTest,
    file: &str,
    id: Pubkey,
    required: bool,
) -> bool {
    let path = dir.join(file);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if required {
                eprintln!("FORK-FIXTURE MISSING (required): {file} ({e})");
            } else {
                eprintln!("SKIP: optional fixture {file} absent ({e})");
            }
            return false;
        }
        Err(e) => panic!(
            "FORK-FIXTURE BROKEN: {} cannot be read: {e} — a present-but-unreadable fixture \
             must never masquerade as absent; only ErrorKind::NotFound means absence. Fix the \
             fixture (its mount, permissions, or the file itself) before running the fork suites",
            path.display()
        ),
    };
    pt.add_account(
        id,
        Account {
            lamports: 1,
            data: bytes,
            owner: bpf_loader::id(),
            executable: true,
            rent_epoch: u64::MAX,
        },
    );
    true
}

/// Registers EVERY required ELF and returns false if ANY of them is
/// missing, so a genesis is only ever built with the complete program set.
/// Every missing file is named explicitly. This replaces the pre-audit
/// pattern where only some registrations were checked and unchecked ones
/// silently produced an incomplete genesis.
pub fn required_elfs_registered(pt: &mut ProgramTest, reqs: &[(&str, Pubkey)]) -> bool {
    required_elfs_registered_from(&fixtures_dir(), pt, reqs)
}

/// `required_elfs_registered` against an explicit directory (injection
/// seam for the regression tests).
pub fn required_elfs_registered_from(
    dir: &Path,
    pt: &mut ProgramTest,
    reqs: &[(&str, Pubkey)],
) -> bool {
    let mut missing: Vec<&str> = Vec::new();
    for (file, id) in reqs {
        if !add_elf_from(dir, pt, file, *id, true) {
            missing.push(file);
        }
    }
    if !missing.is_empty() {
        eprintln!(
            "FORK-FIXTURE: required program ELF(s) missing: {} — an incomplete genesis would fail later with misleading errors; refusing to boot",
            missing.join(", ")
        );
        return false;
    }
    true
}

// =====================================================================
// Raydium AMM v4 "stale pnl mark" settlement (fork-test determinism)
// =====================================================================
//
// WHY: every suite that exercises a real V4 withdraw (salvage_pool's
// withdraw leg) boots genesis from the byte-for-byte mainnet pool /
// target_orders fixtures. V4's withdraw calls `calc_take_pnl`
// unconditionally (the ONLY status that skips it is exactly
// WithdrawOnly=3), and that function FAILS with CalcPnlError (custom
// error 37, "P&L calculation error.") whenever
//
//   (pc_vault - need_take_pnl_pc) * (coin_vault - need_take_pnl_coin)
//       < restore(calc_pnl_x) * restore(calc_pnl_y)          (raw amounts)
//
// i.e. whenever the pool's CURRENT vault product K has dropped below the
// K snapshot recorded in `target_orders.calc_pnl_x/y`. On mainnet this is
// a real, recurring transient: LP burns shrink the vault product while
// the calc_pnl mark only moves on the next swap / deposit / withdraw_pnl
// settlement. During such a window EVERY withdraw on the pool reverts,
// and because the fixtures are fetched live at the start of each CI run,
// the failure lands on a different run nondeterministically
// (fork-harness CI job 140886613649: raydium_v4_fork
// real_v4_withdraw_burns_lp_and_settles_40_40_20 failed with
// TransactionError Custom(37) for exactly this reason — while the same
// code, minutes earlier in job 46113461505, passed against a healthy
// snapshot).
//
// WHAT: this helper replicates the V4 condition exactly (the offsets
// below were verified against the live pool 58oQChx… and its
// CZza3Ej4… target orders on 2026-11-28) and, when the captured fixture
// exhibits the stale mark, settles it in memory the way a mainnet
// settlement would have: calc_pnl_x/y are rewritten to the current
// ex-need_take vault amounts in V4's normalized-decimal space. With the
// last mark equal to the current values, V4's pnl math takes the
// `diff == 0` branch: nothing is taken, the withdraw totals are
// untouched, and the withdraw proceeds with the full pro-rata payout —
// economics identical to the healthy-path run.
//
// The fixture FILES stay byte-for-byte mainnet; the settlement happens in
// test memory before genesis, and it prints a loud banner so the harness
// log always shows when a stale mark was settled. Healthy snapshots are
// passed through completely untouched.
//
// RESIDUAL RISK (documented, not fixed here): a real salvor hitting this
// window on mainnet gets CalcPnlError 37 as well; the production
// mitigation is to retry after a mainnet settlement has updated the
// pool's mark. That is salvage-protocol behavior, deliberately outside
// this test-infrastructure fix.

const V4_AMM_STATUS_OFF: usize = 0;
const V4_AMM_COIN_DECIMALS_OFF: usize = 32;
const V4_AMM_PC_DECIMALS_OFF: usize = 40;
const V4_AMM_SYS_DECIMAL_VALUE_OFF: usize = 120;
const V4_AMM_NEED_TAKE_PNL_COIN_OFF: usize = 192;
const V4_AMM_NEED_TAKE_PNL_PC_OFF: usize = 200;
const V4_TARGET_CALC_PNL_X_OFF: usize = 1024;
const V4_TARGET_CALC_PNL_Y_OFF: usize = 1040;
/// SPL token account layout: the `amount` field.
const V4_TOKEN_ACCOUNT_AMOUNT_OFF: usize = 64;
/// `AmmStatus::WithdrawOnly` — the ONLY status for which V4's withdraw
/// skips the `calc_take_pnl` check entirely.
const V4_STATUS_WITHDRAW_ONLY: u64 = 3;

fn v4_read_u64(data: &[u8], off: usize, what: &str, acct: &str) -> u64 {
    let end = off + 8;
    assert!(
        data.len() >= end,
        "FORK-FIXTURE: {acct} data is {} bytes, too short to read {what} at offset {off} — broken fixture state, refusing to guess",
        data.len()
    );
    u64::from_le_bytes(data[off..end].try_into().unwrap())
}

fn v4_read_u128(data: &[u8], off: usize, what: &str, acct: &str) -> u128 {
    let end = off + 16;
    assert!(
        data.len() >= end,
        "FORK-FIXTURE: {acct} data is {} bytes, too short to read {what} at offset {off} — broken fixture state, refusing to guess",
        data.len()
    );
    u128::from_le_bytes(data[off..end].try_into().unwrap())
}

/// Replicates V4's `restore_decimal`: normalized-space value → raw token
/// amount (floored).
fn v4_restore_decimal(val: u128, native_decimals: u32, sys_decimal_value: u128) -> u128 {
    val.checked_mul(10u128.checked_pow(native_decimals).unwrap_or_else(|| {
        panic!("FORK-FIXTURE: 10^{native_decimals} overflows u128 — corrupt amm decimals field")
    }))
    .expect("FORK-FIXTURE: restore_decimal overflow — corrupt amm fixture")
        / sys_decimal_value
}

/// Replicates V4's `normalize_decimal_v2`: raw token amount →
/// normalized-space value (floored).
fn v4_normalize_decimal(val: u128, native_decimals: u32, sys_decimal_value: u128) -> u128 {
    val.checked_mul(sys_decimal_value)
        .expect("FORK-FIXTURE: normalize_decimal overflow — corrupt amm fixture")
        / 10u128.checked_pow(native_decimals).unwrap_or_else(|| {
            panic!("FORK-FIXTURE: 10^{native_decimals} overflows u128 — corrupt amm decimals field")
        })
}

/// Settles a stale Raydium v4 pnl mark in the in-memory `target_orders`
/// fixture copy when the captured mainnet snapshot exhibits the
/// CalcPnlError-37 transient described above. Returns true when the mark
/// was rewritten (stale snapshot), false when the snapshot is healthy (or
/// the pool is in WithdrawOnly status, where V4 skips the check anyway).
///
/// Panics loudly on fixture states that could never have come from the
/// fetcher (truncated accounts, need_take above the vault balance,
/// zero system decimal value): those are broken fixture states, and
/// guessing would only move the failure somewhere less diagnosable.
pub fn settle_stale_v4_pnl_mark(
    pool: &Account,
    target_orders: &mut Account,
    coin_vault: &Account,
    pc_vault: &Account,
) -> bool {
    let status = v4_read_u64(&pool.data, V4_AMM_STATUS_OFF, "status", "pool.bin");
    if status == V4_STATUS_WITHDRAW_ONLY {
        // V4's withdraw skips calc_take_pnl entirely in this status; a
        // stale mark cannot fail the withdraw, so leave the fixture alone.
        return false;
    }

    let coin_decimals = v4_read_u64(
        &pool.data,
        V4_AMM_COIN_DECIMALS_OFF,
        "coin_decimals",
        "pool.bin",
    );
    let pc_decimals = v4_read_u64(
        &pool.data,
        V4_AMM_PC_DECIMALS_OFF,
        "pc_decimals",
        "pool.bin",
    );
    let sys_decimal_value = v4_read_u64(
        &pool.data,
        V4_AMM_SYS_DECIMAL_VALUE_OFF,
        "sys_decimal_value",
        "pool.bin",
    );
    assert!(
        sys_decimal_value > 0,
        "FORK-FIXTURE: pool.bin sys_decimal_value is zero — not a valid Raydium v4 amm account"
    );

    let need_take_coin = v4_read_u64(
        &pool.data,
        V4_AMM_NEED_TAKE_PNL_COIN_OFF,
        "need_take_pnl_coin",
        "pool.bin",
    );
    let need_take_pc = v4_read_u64(
        &pool.data,
        V4_AMM_NEED_TAKE_PNL_PC_OFF,
        "need_take_pnl_pc",
        "pool.bin",
    );

    let coin_vault_amount = v4_read_u64(
        &coin_vault.data,
        V4_TOKEN_ACCOUNT_AMOUNT_OFF,
        "amount",
        "coin_vault.bin",
    );
    let pc_vault_amount = v4_read_u64(
        &pc_vault.data,
        V4_TOKEN_ACCOUNT_AMOUNT_OFF,
        "amount",
        "pc_vault.bin",
    );
    assert!(
        coin_vault_amount >= need_take_coin && pc_vault_amount >= need_take_pc,
        "FORK-FIXTURE: need_take_pnl (coin={need_take_coin}, pc={need_take_pc}) exceeds the vault balances (coin={coin_vault_amount}, pc={pc_vault_amount}) — broken fixture state; V4's own checked_sub would reject this withdraw too"
    );
    let total_coin_without_take_pnl = coin_vault_amount - need_take_coin;
    let total_pc_without_take_pnl = pc_vault_amount - need_take_pc;

    let calc_pnl_x = v4_read_u128(
        &target_orders.data,
        V4_TARGET_CALC_PNL_X_OFF,
        "calc_pnl_x",
        "target_orders.bin",
    );
    let calc_pnl_y = v4_read_u128(
        &target_orders.data,
        V4_TARGET_CALC_PNL_Y_OFF,
        "calc_pnl_y",
        "target_orders.bin",
    );

    // V4's exact CalcPnlError condition, in raw token amounts:
    //   pool_pc * pool_coin >= restore(calc_pnl_x) * restore(calc_pnl_y)
    let current_k = (total_pc_without_take_pnl as u128)
        .checked_mul(total_coin_without_take_pnl as u128)
        .expect("FORK-FIXTURE: vault product overflows u128 — corrupt fixture");
    let recorded_k = v4_restore_decimal(calc_pnl_x, pc_decimals as u32, sys_decimal_value as u128)
        .checked_mul(v4_restore_decimal(
            calc_pnl_y,
            coin_decimals as u32,
            sys_decimal_value as u128,
        ))
        .expect("FORK-FIXTURE: recorded pnl product overflows u128 — corrupt fixture");

    if current_k >= recorded_k {
        // Healthy snapshot: leave the byte-for-byte fixture untouched.
        return false;
    }

    // Stale mark. Settle it the way a mainnet swap / withdraw_pnl
    // settlement would have: mark := current ex-need_take vault amounts,
    // in V4's normalized-decimal space. With last == current, V4's pnl
    // branch computes a zero diff, takes nothing, and leaves the withdraw
    // totals exactly as they were.
    let settled_x = v4_normalize_decimal(
        total_pc_without_take_pnl as u128,
        pc_decimals as u32,
        sys_decimal_value as u128,
    );
    let settled_y = v4_normalize_decimal(
        total_coin_without_take_pnl as u128,
        coin_decimals as u32,
        sys_decimal_value as u128,
    );
    let x_end = V4_TARGET_CALC_PNL_X_OFF + 16;
    let y_end = V4_TARGET_CALC_PNL_Y_OFF + 16;
    assert!(
        target_orders.data.len() >= y_end,
        "FORK-FIXTURE: target_orders data is {} bytes, too short for the calc_pnl fields — broken fixture state",
        target_orders.data.len()
    );
    target_orders.data[V4_TARGET_CALC_PNL_X_OFF..x_end].copy_from_slice(&settled_x.to_le_bytes());
    target_orders.data[V4_TARGET_CALC_PNL_Y_OFF..y_end].copy_from_slice(&settled_y.to_le_bytes());

    eprintln!(
        "FORK-FIXTURE: settled stale Raydium v4 pnl mark in memory — the captured mainnet snapshot has \
         vault K {current_k} < recorded calc_pnl K {recorded_k}, so a real withdraw on this snapshot \
         would revert with CalcPnlError 37 (P&L calculation error) until a mainnet settlement updates \
         the pool. calc_pnl_x/y rewritten to the current ex-need_take vault values ({settled_x}, \
         {settled_y}); withdraw economics unchanged. Fixture files remain byte-for-byte mainnet."
    );
    true
}
