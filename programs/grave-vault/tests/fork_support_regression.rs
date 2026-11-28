// SPDX-License-Identifier: Apache-2.0
//
// fork_support_regression — pins the skip-integrity contract of the shared
// fork-harness plumbing (tests/common/fork_support.rs). These tests exist
// because the pre-audit suites could silently green-light themselves:
// `add_elf()` reported SUCCESS for a missing required fixture, corrupt
// manifests masqueraded as absent fixtures, and every suite's
// `let Some(x) = ... else { return; }` made a skip indistinguishable from
// a pass. Each regression here fails if any of those behaviors returns.
//
// What is pinned:
//   1. a missing required ELF is a reported FAILURE (returns false) —
//      never a fabricated success;
//   2. a present ELF registers and returns true, and a required set is
//      all-or-nothing (`required_elfs_registered` names every miss);
//   3. a missing optional ELF stays optional (false, no panic);
//   4. an ABSENT manifest is None (fixture-less workspace skip decision
//      stays with the caller), but a CORRUPT manifest fails loudly in
//      both workflows, and so does an UNREADABLE manifest (any filesystem
//      error other than NotFound — surfaced with path + underlying error);
//   5. GRAVEYIELD_FORK_HARNESS=1 flips the skip gate: the same condition
//      that skips in ordinary workspace mode FAILS the test under the
//      explicit fork harness (scripts/build_fork_harness.sh);
//   6. a present-but-unreadable ELF (any filesystem error other than
//      NotFound) fails loudly for required AND optional registrations —
//      only genuine absence may take the skip path.
#![allow(deprecated)] // bpf_loader facade re-export (via fork_support)

use std::path::{Path, PathBuf};

use solana_sdk::pubkey::Pubkey;

#[macro_use]
#[path = "common/fork_support.rs"]
mod fork_support;

use fork_support::{
    add_elf_from, harness_mode, harness_skip, load_manifest_from, required_elfs_registered_from,
    HARNESS_ENV,
};

/// A unique, self-cleaning scratch dir standing in for tests/fixtures/.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new(tag: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("gv-fork-regression-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir must be creatable");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A minimal byte blob standing in for a program ELF (registration does
/// not validate ELF internals — the runtime does, at execution time).
const DUMMY_ELF: &[u8] = b"\x00test-elf-payload-for-registration-only";

// ---------------------------------------------------------------------
// 1 + 2 + 3: add_elf / required_elfs_registered honesty
// ---------------------------------------------------------------------

#[test]
fn missing_required_elf_is_reported_as_failure_not_success() {
    let scratch = ScratchDir::new("missing-required");
    let mut pt = solana_program_test::ProgramTest::default();
    let id = Pubkey::new_unique();

    // The pre-audit bug: a missing REQUIRED fixture returned `required`
    // (true) — i.e. claimed success. It must return false.
    assert!(
        !add_elf_from(scratch.path(), &mut pt, "absent_program.so", id, true),
        "a missing required ELF must be reported as NOT registered"
    );
    assert!(
        !add_elf_from(scratch.path(), &mut pt, "absent_program.so", id, false),
        "a missing optional ELF must be reported as NOT registered"
    );
}

#[test]
fn present_elf_registers_and_required_set_is_all_or_nothing() {
    let scratch = ScratchDir::new("present-required");
    std::fs::write(scratch.path().join("program_a.so"), DUMMY_ELF)
        .expect("fixture write must succeed");
    std::fs::write(scratch.path().join("program_b.so"), DUMMY_ELF)
        .expect("fixture write must succeed");

    let mut pt = solana_program_test::ProgramTest::default();
    assert!(add_elf_from(
        scratch.path(),
        &mut pt,
        "program_a.so",
        Pubkey::new_unique(),
        true
    ));

    // All present -> true.
    let mut pt = solana_program_test::ProgramTest::default();
    assert!(required_elfs_registered_from(
        scratch.path(),
        &mut pt,
        &[
            ("program_a.so", Pubkey::new_unique()),
            ("program_b.so", Pubkey::new_unique()),
        ]
    ));

    // One missing -> false, even though the others registered. This is the
    // contract that keeps an incomplete genesis from ever being booted.
    std::fs::write(scratch.path().join("program_c.so"), DUMMY_ELF)
        .expect("fixture write must succeed");
    let mut pt = solana_program_test::ProgramTest::default();
    assert!(!required_elfs_registered_from(
        scratch.path(),
        &mut pt,
        &[
            ("program_a.so", Pubkey::new_unique()),
            ("program_b.so", Pubkey::new_unique()),
            ("absent.so", Pubkey::new_unique()),
        ]
    ));
}

// ---------------------------------------------------------------------
// 4: load_manifest absence vs corruption
// ---------------------------------------------------------------------

#[test]
fn absent_manifest_is_none_not_an_error() {
    let scratch = ScratchDir::new("absent-manifest");
    // Fixture-less workspace testing hinges on this: absence is None, and
    // the CALLER decides skip (workspace) vs failure (harness).
    assert!(load_manifest_from(scratch.path()).is_none());
}

#[test]
fn corrupt_manifest_fails_loudly_in_both_workflows() {
    let scratch = ScratchDir::new("corrupt-manifest");
    std::fs::write(scratch.path().join("manifest.json"), "{ not json ]")
        .expect("manifest write must succeed");

    let result = std::panic::catch_unwind(|| load_manifest_from(scratch.path()));
    match result {
        Err(payload) => {
            let msg = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            assert!(
                msg.contains("corrupt"),
                "the panic must name the manifest corrupt, got: {msg}"
            );
        }
        Ok(Some(_)) => panic!("a corrupt manifest must not parse into a usable manifest"),
        Ok(None) => {
            panic!("a corrupt manifest must not masquerade as ABSENT (the pre-audit `.ok()` bug)")
        }
    }
}

#[test]
fn valid_manifest_parses() {
    let scratch = ScratchDir::new("valid-manifest");
    std::fs::write(
        scratch.path().join("manifest.json"),
        r#"{"pool_address":"58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2","accounts":{}}"#,
    )
    .expect("manifest write must succeed");
    let manifest = load_manifest_from(scratch.path()).expect("valid manifest must parse");
    assert!(
        manifest.get("pool_address").is_some(),
        "the parsed manifest must carry its fields"
    );
}

/// A deterministic, permission-independent filesystem error: `manifest.json`
/// exists but is a DIRECTORY, so `read_to_string` fails with EISDIR on
/// Linux/macOS (an equivalent non-NotFound error on Windows). This is the
/// reproducible stand-in for "the manifest is there but the fixture state is
/// broken" — no chmod, so it behaves identically when CI runs as root.
#[test]
fn unreadable_manifest_fails_loudly_and_is_not_absence() {
    let scratch = ScratchDir::new("unreadable-manifest");
    std::fs::create_dir(scratch.path().join("manifest.json"))
        .expect("manifest-as-directory must be creatable");

    let result = std::panic::catch_unwind(|| load_manifest_from(scratch.path()));
    match result {
        Err(payload) => {
            let msg = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            assert!(
                msg.contains("FORK-FIXTURE BROKEN"),
                "an unreadable manifest must fail with the FORK-FIXTURE BROKEN banner, got: {msg}"
            );
            assert!(
                msg.contains("manifest.json"),
                "the failure must name the manifest path, got: {msg}"
            );
            assert!(
                msg.contains("cannot be read"),
                "the failure must surface the filesystem error, got: {msg}"
            );
        }
        Ok(Some(_)) => panic!("an unreadable manifest must not produce a usable manifest"),
        Ok(None) => panic!(
            "an unreadable manifest must not masquerade as ABSENT — only ErrorKind::NotFound means absence"
        ),
    }
}

// ---------------------------------------------------------------------
// 5: the harness-mode skip gate
// ---------------------------------------------------------------------

/// A probe shaped like every suite's skip site: `skip_or_fail!` expands to
/// a `return` in workspace mode and a panic under the harness flag.
fn gate_probe(fixtures_available: bool, reached_end: &mut bool) {
    if !fixtures_available {
        skip_or_fail!("regression probe: required fixture missing");
    }
    *reached_end = true;
}

#[test]
fn harness_flag_flips_skip_into_failure() {
    // ---- workspace mode (flag absent): the documented fixture-less skip.
    std::env::remove_var(HARNESS_ENV);
    assert!(!harness_mode(), "no flag = workspace mode");

    let mut reached = false;
    gate_probe(false, &mut reached); // must SKIP (return early), not panic
    assert!(!reached, "workspace mode must take the skip path");

    gate_probe(true, &mut reached);
    assert!(reached, "available fixtures must reach the test body");

    // ---- harness mode (flag = 1): the identical condition now FAILS.
    std::env::set_var(HARNESS_ENV, "1");
    assert!(harness_mode(), "flag = 1 must select harness mode");

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut reached = false;
        gate_probe(false, &mut reached);
        reached
    }));
    match result {
        Err(payload) => {
            let msg = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            assert!(
                msg.starts_with("FORK-HARNESS FAILURE"),
                "harness-mode skips must fail with the FORK-HARNESS FAILURE banner, got: {msg}"
            );
        }
        Ok(_) => panic!(
            "under GRAVEYIELD_FORK_HARNESS=1 a missing required fixture must FAIL the test, not skip it"
        ),
    }

    // ---- any other value is workspace mode (exact-match flag).
    std::env::set_var(HARNESS_ENV, "0");
    assert!(
        !harness_mode(),
        "only the exact value \"1\" is harness mode"
    );

    // restore: never leak the flag into sibling test binaries' environment
    std::env::remove_var(HARNESS_ENV);
    assert!(!harness_mode());

    // harness_skip itself must be a panic in harness mode (it is `-> !`).
    std::env::set_var(HARNESS_ENV, "1");
    let result = std::panic::catch_unwind(|| harness_skip("direct probe"));
    assert!(result.is_err(), "harness_skip must panic under the flag");
    std::env::remove_var(HARNESS_ENV);
}

// ---------------------------------------------------------------------
// 6: add_elf_from error classification (absence vs broken fixture)
// ---------------------------------------------------------------------

/// A deterministic, permission-independent filesystem error, mirroring the
/// manifest test above: the ELF path exists but is a DIRECTORY, so
/// `std::fs::read` fails with EISDIR on Linux/macOS (an equivalent
/// non-NotFound error on Windows). This is the reproducible stand-in for
/// "the fixture is there but the fixture state is broken" — no chmod, so
/// it behaves identically when CI runs as root.
fn assert_unreadable_elf_fails_loudly(required: bool) {
    let tag = if required {
        "unreadable-required-elf"
    } else {
        "unreadable-optional-elf"
    };
    let scratch = ScratchDir::new(tag);
    std::fs::create_dir(scratch.path().join("broken_program.so"))
        .expect("elf-as-directory must be creatable");

    let mut pt = solana_program_test::ProgramTest::default();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        add_elf_from(
            scratch.path(),
            &mut pt,
            "broken_program.so",
            Pubkey::new_unique(),
            required,
        )
    }));
    match result {
        Err(payload) => {
            let msg = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            assert!(
                msg.contains("FORK-FIXTURE BROKEN"),
                "an unreadable ELF must fail with the FORK-FIXTURE BROKEN banner, got: {msg}"
            );
            assert!(
                msg.contains("broken_program.so"),
                "the failure must name the ELF path, got: {msg}"
            );
            assert!(
                msg.contains("cannot be read"),
                "the failure must surface the filesystem error, got: {msg}"
            );
        }
        Ok(true) => panic!("an unreadable ELF must not be reported as registered"),
        Ok(false) => panic!(
            "an unreadable ELF must not masquerade as ABSENT ({}) — only ErrorKind::NotFound \
             means absence; returning false would hand the caller a legitimate skip",
            if required {
                "workspace skip"
            } else {
                "silent optional skip"
            }
        ),
    }
}

#[test]
fn unreadable_required_elf_fails_loudly_and_is_not_missing() {
    // The pre-fix ambiguity: ANY read error printed
    // "FORK-FIXTURE MISSING (required)" and returned false, which the
    // caller legitimately maps to the documented workspace skip — a broken
    // fixture state could therefore silence a whole suite. It must panic
    // instead.
    assert_unreadable_elf_fails_loudly(true);
}

#[test]
fn unreadable_optional_elf_fails_loudly_and_is_not_absent() {
    // Same principle for optional fixtures: genuine absence may be
    // skipped, but an existing unreadable fixture must not be silently
    // treated as absent.
    assert_unreadable_elf_fails_loudly(false);
}

// ---------------------------------------------------------------------
// 7: settle_stale_v4_pnl_mark — the CalcPnlError-37 determinism contract
// ---------------------------------------------------------------------
//
// Pins the in-memory stale-pnl settlement primitive (fork-harness CI job
// 140886613649): a byte-for-byte mainnet snapshot whose current vault
// product K is below the recorded `target_orders.calc_pnl` K makes EVERY
// real V4 withdraw revert with CalcPnlError 37. P125-02: the primitive is
// NEVER invoked by shared fork-test setup on untouched state — suites
// that need a settled pool go through the explicit, named
// post_settlement_v4_pool_fixture builder (pinned in section 8 below),
// and the untouched-state behavior is covered by raydium_v4_fork's
// dedicated stale-PNL tests.

use solana_sdk::account::Account;

use fork_support::settle_stale_v4_pnl_mark;

/// A synthetic Raydium v4 amm account with only the fields the settlement
/// reads (layout offsets are the ones proven against live mainnet).
fn v4_pool_account(
    status: u64,
    coin_decimals: u64,
    pc_decimals: u64,
    sys_decimal_value: u64,
    need_take_coin: u64,
    need_take_pc: u64,
) -> Account {
    let mut data = vec![0u8; 752]; // real mainnet amm accounts are 752 bytes
    data[0..8].copy_from_slice(&status.to_le_bytes());
    data[32..40].copy_from_slice(&coin_decimals.to_le_bytes());
    data[40..48].copy_from_slice(&pc_decimals.to_le_bytes());
    data[120..128].copy_from_slice(&sys_decimal_value.to_le_bytes());
    data[192..200].copy_from_slice(&need_take_coin.to_le_bytes());
    data[200..208].copy_from_slice(&need_take_pc.to_le_bytes());
    Account {
        lamports: 1,
        data,
        owner: Pubkey::new_unique(),
        executable: false,
        rent_epoch: u64::MAX,
    }
}

/// A synthetic target-orders account (real mainnet ones are 2208 bytes)
/// with the two u128 calc_pnl fields.
fn v4_target_account(calc_pnl_x: u128, calc_pnl_y: u128) -> Account {
    let mut data = vec![0u8; 2208];
    data[1024..1040].copy_from_slice(&calc_pnl_x.to_le_bytes());
    data[1040..1056].copy_from_slice(&calc_pnl_y.to_le_bytes());
    Account {
        lamports: 1,
        data,
        owner: Pubkey::new_unique(),
        executable: false,
        rent_epoch: u64::MAX,
    }
}

/// A synthetic SPL token account with just the amount field.
fn spl_token_account(amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    Account {
        lamports: 1,
        data,
        owner: Pubkey::new_unique(),
        executable: false,
        rent_epoch: u64::MAX,
    }
}

/// Canonical SOL/USDC-shaped numbers (sys_decimal_value = 1e9, as on the
/// live pool): 1000 SOL / 100_000 USDC, no pending pnl.
const TEST_SYSV: u64 = 1_000_000_000;
const TEST_COIN_DEC: u64 = 9;
const TEST_PC_DEC: u64 = 6;

#[test]
fn healthy_v4_pnl_mark_is_left_byte_identical() {
    // K_current == K_recorded (the boundary V4 accepts with >=): the
    // fixture must pass through with ALL bytes unchanged — the byte-for-
    // byte mainnet fidelity contract for healthy snapshots.
    let pool = v4_pool_account(6, TEST_COIN_DEC, TEST_PC_DEC, TEST_SYSV, 0, 0);
    let coin_vault = spl_token_account(1_000_000_000_000); // 1000 SOL
    let pc_vault = spl_token_account(100_000_000_000); // 100_000 USDC
    let mut target = v4_target_account(
        (100_000_000_000u128 * TEST_SYSV as u128) / 10u128.pow(TEST_PC_DEC as u32), // 1e14
        1_000_000_000_000, // raw, sysv == 10^9
    );
    let before = target.data.clone();

    assert!(
        !settle_stale_v4_pnl_mark(&pool, &mut target, &coin_vault, &pc_vault),
        "an exactly-settled mark must not be rewritten"
    );
    assert_eq!(
        target.data, before,
        "a healthy snapshot must stay byte-for-byte identical"
    );
}

#[test]
fn stale_v4_pnl_mark_is_settled_exactly_like_a_mainnet_settlement() {
    // Reproduce the CI job 140886613649 shape: the vault coin side shrank
    // (LP burns) while the recorded mark stayed at its pre-burn values, so
    // K_current < K_recorded and a real withdraw reverts with CalcPnlError
    // 37. The settlement must write exactly the normalized ex-need_take
    // vault values — which makes V4's pnl branch take the diff==0 path,
    // keeping the withdraw economics identical to the healthy run.
    let pool = v4_pool_account(6, TEST_COIN_DEC, TEST_PC_DEC, TEST_SYSV, 0, 0);
    let coin_vault = spl_token_account(999_000_000_000); // burned: -1 SOL
    let pc_vault = spl_token_account(100_000_000_000);
    let mut target = v4_target_account(
        (100_000_000_000u128 * TEST_SYSV as u128) / 10u128.pow(TEST_PC_DEC as u32),
        1_000_000_000_000,
    );

    assert!(
        settle_stale_v4_pnl_mark(&pool, &mut target, &coin_vault, &pc_vault),
        "a stale mark must be settled"
    );

    let settled_x = u128::from_le_bytes(target.data[1024..1040].try_into().unwrap());
    let settled_y = u128::from_le_bytes(target.data[1040..1056].try_into().unwrap());
    // Exactly what V4's normalize_decimal_v2 produces for the current
    // ex-need_take vault amounts.
    assert_eq!(
        settled_x,
        (100_000_000_000u128 * TEST_SYSV as u128) / 10u128.pow(TEST_PC_DEC as u32),
        "calc_pnl_x must equal the normalized pc-side vault amount"
    );
    assert_eq!(
        settled_y, 999_000_000_000u128,
        "calc_pnl_y must equal the normalized coin-side vault amount"
    );

    // The settled mark satisfies V4's condition exactly (K_recorded' ==
    // K_current): restore(settled_x) * restore(settled_y) == pc * coin.
    let restored_x = settled_x * 10u128.pow(TEST_PC_DEC as u32) / TEST_SYSV as u128;
    let restored_y = settled_y * 10u128.pow(TEST_COIN_DEC as u32) / TEST_SYSV as u128;
    assert_eq!(
        restored_x * restored_y,
        100_000_000_000u128 * 999_000_000_000u128,
        "the settled mark must satisfy V4's >= condition with the current vaults"
    );
}

#[test]
fn stale_mark_with_need_take_pending_settles_on_ex_need_take_totals() {
    // V4 computes withdraw totals AFTER subtracting need_take_pnl, so the
    // settlement must too (restoring the wrong side of the subtraction
    // would flip a healthy pool into an over/under-settled mark).
    let need_coin = 7u64;
    let need_pc = 5u64;
    let pool = v4_pool_account(6, TEST_COIN_DEC, TEST_PC_DEC, TEST_SYSV, need_coin, need_pc);
    let coin_vault = spl_token_account(999_000_000_000);
    let pc_vault = spl_token_account(100_000_000_000);
    let mut target = v4_target_account(
        (100_000_000_000u128 * TEST_SYSV as u128) / 10u128.pow(TEST_PC_DEC as u32),
        1_000_000_000_000,
    );

    assert!(settle_stale_v4_pnl_mark(
        &pool,
        &mut target,
        &coin_vault,
        &pc_vault
    ));

    let settled_x = u128::from_le_bytes(target.data[1024..1040].try_into().unwrap());
    let settled_y = u128::from_le_bytes(target.data[1040..1056].try_into().unwrap());
    assert_eq!(
        settled_x,
        ((100_000_000_000u64 - need_pc) as u128 * TEST_SYSV as u128)
            / 10u128.pow(TEST_PC_DEC as u32),
        "the pc-side mark must be settled on the ex-need_take total"
    );
    assert_eq!(
        settled_y,
        (999_000_000_000u64 - need_coin) as u128,
        "the coin-side mark must be settled on the ex-need_take total"
    );
}

#[test]
fn withdraw_only_status_skips_the_settlement() {
    // V4's withdraw skips calc_take_pnl entirely when status is exactly
    // WithdrawOnly(3): a stale mark cannot fail that withdraw, so the
    // fixture must stay byte-for-byte untouched.
    let pool = v4_pool_account(3, TEST_COIN_DEC, TEST_PC_DEC, TEST_SYSV, 0, 0);
    let coin_vault = spl_token_account(999_000_000_000);
    let pc_vault = spl_token_account(100_000_000_000);
    let mut target = v4_target_account(1_000_000_000_000_000, 1_000_000_000_000_000);
    let before = target.data.clone();

    assert!(
        !settle_stale_v4_pnl_mark(&pool, &mut target, &coin_vault, &pc_vault),
        "WithdrawOnly pools must not be rewritten"
    );
    assert_eq!(target.data, before);
}

#[test]
fn fresh_pool_with_zero_mark_is_untouched() {
    // A brand-new pool has calc_pnl = 0; K_recorded = 0 <= K_current
    // always. No settlement, no panic.
    let pool = v4_pool_account(1, TEST_COIN_DEC, TEST_PC_DEC, TEST_SYSV, 0, 0);
    let coin_vault = spl_token_account(1_000);
    let pc_vault = spl_token_account(1_000);
    let mut target = v4_target_account(0, 0);
    let before = target.data.clone();

    assert!(!settle_stale_v4_pnl_mark(
        &pool,
        &mut target,
        &coin_vault,
        &pc_vault
    ));
    assert_eq!(target.data, before);
}

#[test]
#[should_panic(expected = "too short to read")]
fn truncated_target_orders_fail_loudly() {
    // A truncated target_orders fixture is a broken fixture state, not a
    // healthy one — the settlement must refuse to guess.
    let pool = v4_pool_account(6, TEST_COIN_DEC, TEST_PC_DEC, TEST_SYSV, 0, 0);
    let coin_vault = spl_token_account(1_000);
    let pc_vault = spl_token_account(1_000);
    let mut target = v4_target_account(1, 1);
    target.data.truncate(1030); // cuts calc_pnl_y in half

    let _ = settle_stale_v4_pnl_mark(&pool, &mut target, &coin_vault, &pc_vault);
}

#[test]
#[should_panic(expected = "need_take_pnl")]
fn need_take_above_vault_balance_fails_loudly() {
    // need_take_pnl above the vault balance is impossible from the
    // fetcher and V4's own checked_sub would reject it; fail loudly here
    // instead of "settling" garbage.
    let pool = v4_pool_account(6, TEST_COIN_DEC, TEST_PC_DEC, TEST_SYSV, 5_000, 0);
    let coin_vault = spl_token_account(1_000);
    let pc_vault = spl_token_account(1_000);
    let mut target = v4_target_account(1, 1);

    let _ = settle_stale_v4_pnl_mark(&pool, &mut target, &coin_vault, &pc_vault);
}

// ---------------------------------------------------------------------
// 8: P125-02 — the explicit post-settlement builder + pure diagnostic
// ---------------------------------------------------------------------
//
// P125-02 contract pins: the named builder is the ONLY sanctioned
// settlement entry point, it rewrites EXACTLY the two calc_pnl u128
// fields, it is a documented no-op on healthy snapshots, it is
// deterministic/idempotent, and the pure diagnostic never mutates
// anything. The untouched captured state (and the CalcPnlError-37
// failure it produces) is never normalized by shared setup.

use fork_support::{
    post_settlement_v4_pool_fixture, stale_v4_pnl_mark_status, PostSettlementDelta,
    V4StalePnlStatus, V4_TARGET_CALC_PNL_X_OFF, V4_TARGET_CALC_PNL_Y_OFF,
};

/// A STALE fixture shape (coin side burned below the recorded mark) with
/// the canonical SOL/USDC numbers.
fn stale_fixture() -> (Account, Account, Account, Account) {
    let pool = v4_pool_account(6, TEST_COIN_DEC, TEST_PC_DEC, TEST_SYSV, 0, 0);
    let coin_vault = spl_token_account(999_000_000_000); // burned: -1 SOL
    let pc_vault = spl_token_account(100_000_000_000);
    let target = v4_target_account(
        (100_000_000_000u128 * TEST_SYSV as u128) / 10u128.pow(TEST_PC_DEC as u32),
        1_000_000_000_000,
    );
    (pool, coin_vault, pc_vault, target)
}

#[test]
fn p125_02_diagnostic_is_pure_and_matches_the_settle_decision() {
    // The diagnostic must never mutate ANY account, and its verdict must
    // agree with the settle primitive's boolean.
    let (pool, coin_vault, pc_vault, mut target) = stale_fixture();
    let pool_before = pool.data.clone();
    let coin_before = coin_vault.data.clone();
    let pc_before = pc_vault.data.clone();
    let target_before = target.data.clone();

    let status = stale_v4_pnl_mark_status(&pool, &target, &coin_vault, &pc_vault);
    assert!(
        matches!(status, V4StalePnlStatus::Stale { .. }),
        "the stale fixture must be diagnosed as stale"
    );
    assert_eq!(
        pool.data, pool_before,
        "the diagnostic must not touch the pool"
    );
    assert_eq!(
        coin_vault.data, coin_before,
        "the diagnostic must not touch the coin vault"
    );
    assert_eq!(
        pc_vault.data, pc_before,
        "the diagnostic must not touch the pc vault"
    );
    assert_eq!(
        target.data, target_before,
        "the diagnostic must not touch target_orders"
    );

    let settled = settle_stale_v4_pnl_mark(&pool, &mut target, &coin_vault, &pc_vault);
    assert!(settled, "the settle primitive agrees with the diagnostic");
}

#[test]
fn p125_02_builder_rewrites_exactly_the_two_calc_pnl_fields() {
    let (pool, coin_vault, pc_vault, mut target) = stale_fixture();
    let before = target.data.clone();

    let delta: PostSettlementDelta =
        post_settlement_v4_pool_fixture(&pool, &mut target, &coin_vault, &pc_vault);

    assert!(
        delta.settled,
        "a stale snapshot must be settled by the builder"
    );
    assert_eq!(
        delta.changed_ranges,
        vec![
            (V4_TARGET_CALC_PNL_X_OFF, V4_TARGET_CALC_PNL_X_OFF + 16),
            (V4_TARGET_CALC_PNL_Y_OFF, V4_TARGET_CALC_PNL_Y_OFF + 16),
        ],
        "the builder must rewrite EXACTLY the two u128 calc_pnl fields"
    );
    // Byte-level cross-check: every changed byte lies in those ranges and
    // the length is untouched.
    assert_eq!(target.data.len(), before.len());
    for (i, (b, a)) in before.iter().zip(target.data.iter()).enumerate() {
        if b != a {
            assert!(
                (V4_TARGET_CALC_PNL_X_OFF..V4_TARGET_CALC_PNL_X_OFF + 16).contains(&i)
                    || (V4_TARGET_CALC_PNL_Y_OFF..V4_TARGET_CALC_PNL_Y_OFF + 16).contains(&i),
                "byte {i} changed outside the calc_pnl fields"
            );
        }
    }
}

#[test]
fn p125_02_builder_is_a_documented_noop_on_healthy_snapshots() {
    // Healthy snapshot: the builder must NOT rewrite anything and must
    // report settled=false with empty ranges — an untouched fixture passes
    // through byte-for-byte (this is what a NO-normalization shared setup
    // relies on).
    let pool = v4_pool_account(6, TEST_COIN_DEC, TEST_PC_DEC, TEST_SYSV, 0, 0);
    let coin_vault = spl_token_account(1_000_000_000_000); // 1000 SOL — healthy
    let pc_vault = spl_token_account(100_000_000_000);
    let mut target = v4_target_account(
        (100_000_000_000u128 * TEST_SYSV as u128) / 10u128.pow(TEST_PC_DEC as u32),
        1_000_000_000_000,
    );
    let before = target.data.clone();

    let delta = post_settlement_v4_pool_fixture(&pool, &mut target, &coin_vault, &pc_vault);
    assert!(!delta.settled);
    assert!(delta.changed_ranges.is_empty());
    assert_eq!(
        target.data, before,
        "a healthy snapshot must stay byte-for-byte identical"
    );
}

#[test]
fn p125_02_builder_is_deterministic_and_idempotent() {
    // Determinism: two independent clones of the same stale state settle
    // to IDENTICAL bytes. Idempotence: a second settle pass is a no-op
    // (the mark is already current), so repeated test execution is
    // deterministic.
    let (pool, coin_vault, pc_vault, mut a) = stale_fixture();
    let untouched_snapshot = a.data.clone();
    let mut b = Account {
        lamports: a.lamports,
        data: a.data.clone(),
        owner: a.owner,
        executable: a.executable,
        rent_epoch: a.rent_epoch,
    };

    let first = post_settlement_v4_pool_fixture(&pool, &mut a, &coin_vault, &pc_vault);
    let second = post_settlement_v4_pool_fixture(&pool, &mut b, &coin_vault, &pc_vault);
    assert_eq!(
        a.data, b.data,
        "the builder is deterministic across independent clones"
    );
    assert_eq!(first, second);
    assert_ne!(
        a.data, untouched_snapshot,
        "the stale mark was actually rewritten"
    );

    // Idempotence: re-settling an already-settled account is a no-op.
    let after_first = a.data.clone();
    let again = settle_stale_v4_pnl_mark(&pool, &mut a, &coin_vault, &pc_vault);
    assert!(
        !again,
        "a settled mark is current — the second pass must be a no-op"
    );
    assert_eq!(a.data, after_first);
}
