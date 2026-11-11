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
//     manifest (present but unparseable) is a broken local fixture state,
//     not absence — it fails loudly in both workflows.
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
pub fn load_manifest() -> Option<Value> {
    load_manifest_from(&fixtures_dir())
}

/// `load_manifest` against an explicit directory (injection seam for the
/// regression tests).
pub fn load_manifest_from(dir: &Path) -> Option<Value> {
    let path = dir.join("manifest.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => {
            eprintln!(
                "SKIP: fork fixtures not found at {} — run scripts/build_fork_harness.sh (builds the program ELFs and fetches the mainnet fixtures)",
                path.display()
            );
            return None;
        }
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
/// Returns true IFF the ELF was read and registered. A missing file is
/// never reported as success: it prints one explicit line per registration
/// (distinguishing required from optional) and returns false. The CALLER
/// decides between skip and failure via `skip_or_fail!` — this function
/// only refuses to fabricate a success.
pub fn add_elf(pt: &mut ProgramTest, file: &str, id: Pubkey, required: bool) -> bool {
    add_elf_from(&fixtures_dir(), pt, file, id, required)
}

/// `add_elf` against an explicit directory (injection seam for the
/// regression tests). Same registration shape the suites always used
/// (bpf_loader-owned executable account).
pub fn add_elf_from(
    dir: &Path,
    pt: &mut ProgramTest,
    file: &str,
    id: Pubkey,
    required: bool,
) -> bool {
    match std::fs::read(dir.join(file)) {
        Ok(bytes) => {
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
        Err(e) => {
            if required {
                eprintln!("FORK-FIXTURE MISSING (required): {file} ({e})");
            } else {
                eprintln!("SKIP: optional fixture {file} absent ({e})");
            }
            false
        }
    }
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
