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
//      both workflows;
//   5. GRAVEYIELD_FORK_HARNESS=1 flips the skip gate: the same condition
//      that skips in ordinary workspace mode FAILS the test under the
//      explicit fork harness (scripts/build_fork_harness.sh).
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
