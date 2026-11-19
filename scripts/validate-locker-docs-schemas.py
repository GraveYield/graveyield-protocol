#!/usr/bin/env python3
"""Validation and negative-test harness for the M1 locker documentation schemas.

Scope (GY-OPS-RB-05 R1/R7, DR-003 D-05): guards the committed locker-screening
documentation without touching protocol code.

Checks performed:
  1. Both schema documents are valid draft 2020-12 JSON Schemas (meta-validation).
  2. docs/ops/locker-inventory.json validates against docs/ops/locker-inventory.schema.json.
  3. The embedded gy.locker-screening.v1 example validates against its own schema.
  4. The deterministic manifest_sha256 recipe (RFC 8785 canonicalization, with
     manifest_sha256 itself excluded — GY-OPS-RB-05 R7) reproduces the digest
     committed in the example (reproducible test vector), and a tampered
     artifact yields a different digest.

Negative-test matrix (fail-closed constraints must actually reject):
  T1  qualified PASS without a reviewer countersignature is rejected
      (absent reviewer / null reviewer / empty identity / empty signature)
  T2  marker_present=true without TokenLock evidence is rejected
      (absent / null / empty array / malformed hash accepted case included)
  T3  Token-2022 mint without explicit extension records is rejected
      (absent / null / item missing handling; SPL Token with extensions rejected)
  T4  candidate_unverified entry with a non-null program_id is rejected
  T5  candidate_unverified entry with query_authoritative=true is rejected
      (plus candidate with ratification_details, verified entry violations)
  T6  valid SPL Token and valid Token-2022 screening examples are accepted

Exit code 0 = every check passed; nonzero = at least one failure.
"""

import copy
import hashlib
import json
import sys
from pathlib import Path

import jsonschema

REPO_ROOT = Path(__file__).resolve().parent.parent
INVENTORY_SCHEMA_PATH = REPO_ROOT / "docs" / "ops" / "locker-inventory.schema.json"
INVENTORY_DATA_PATH = REPO_ROOT / "docs" / "ops" / "locker-inventory.json"
SCREENING_SCHEMA_PATH = REPO_ROOT / "docs" / "ops" / "locker-screening.schema.json"

SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

FAILURES = []
CHECKS = 0


def report(name, ok, detail=""):
    global CHECKS
    CHECKS += 1
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


def assert_rejected(name, validator, instance, expected_substrings=()):
    errors = list(validator.iter_errors(instance))
    ok = bool(errors)
    detail = ""
    if not ok:
        detail = "expected rejection but instance validated"
    elif expected_substrings:
        text = json.dumps(
            [
                (list(e.absolute_path), e.message)
                for e in errors
            ],
            default=str,
        )
        missing = [s for s in expected_substrings if s not in text]
        if missing:
            ok = False
            detail = f"error(s) raised but not for expected reason(s): {missing}"
    report(name, ok, detail)


def assert_accepted(name, validator, instance):
    errors = list(validator.iter_errors(instance))
    detail = "; ".join(
        f"{list(e.absolute_path)}: {e.message}" for e in errors[:5]
    )
    report(name, not errors, detail)


def canonical_json(obj):
    """RFC 8785 (JCS) canonical serialization for schema-conformant artifacts:
    ASCII keys, string/boolean/integer/array/object values only, so
    sort_keys code-point ordering matches the RFC's UTF-16 ordering and no
    float formatting is involved."""
    return json.dumps(
        obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def manifest_digest(artifact):
    body = copy.deepcopy(artifact)
    body.pop("manifest_sha256", None)
    return hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()


def main():
    # ---- Load and meta-validate the schemas --------------------------------
    inventory_schema = json.loads(INVENTORY_SCHEMA_PATH.read_text())
    screening_schema = json.loads(SCREENING_SCHEMA_PATH.read_text())
    inventory_validator = jsonschema.Draft202012Validator(inventory_schema)
    screening_validator = jsonschema.Draft202012Validator(screening_schema)

    # check_schema raises on an invalid schema document:
    try:
        jsonschema.Draft202012Validator.check_schema(inventory_schema)
        report("S0a locker-inventory.schema.json passes meta-validation", True)
    except jsonschema.SchemaError as exc:
        report("S0a locker-inventory.schema.json passes meta-validation", False, str(exc))
    try:
        jsonschema.Draft202012Validator.check_schema(screening_schema)
        report("S0b locker-screening.schema.json passes meta-validation", True)
    except jsonschema.SchemaError as exc:
        report("S0b locker-screening.schema.json passes meta-validation", False, str(exc))

    # ---- Committed data must validate --------------------------------------
    inventory_data = json.loads(INVENTORY_DATA_PATH.read_text())
    assert_accepted(
        "S1 docs/ops/locker-inventory.json validates against gy.locker-inventory.v1",
        inventory_validator,
        inventory_data,
    )

    screening_example = copy.deepcopy(screening_schema["examples"][0])
    assert_accepted(
        "S2 embedded gy.locker-screening.v1 example validates against its schema",
        screening_validator,
        screening_example,
    )

    # ---- Deterministic manifest hashing (R7) -------------------------------
    stated = screening_example["manifest_sha256"]
    recomputed = manifest_digest(screening_example)
    report(
        "T7a deterministic manifest recipe reproduces the committed example digest",
        recomputed == stated,
        f"stated={stated} recomputed={recomputed}",
    )
    tampered = copy.deepcopy(screening_example)
    tampered["run_id"] = tampered["run_id"] + "-TAMPERED"
    report(
        "T7b tampered artifact yields a different manifest digest (detected)",
        manifest_digest(tampered) != stated,
    )
    roundtrip = json.loads(canonical_json({k: v for k, v in screening_example.items() if k != "manifest_sha256"}))
    report(
        "T7c canonical serialization is byte-stable across a JSON round-trip",
        manifest_digest(roundtrip) == stated,
    )

    # ---- T1: reviewer required for qualified PASS --------------------------
    base = copy.deepcopy(screening_example)
    no_reviewer = copy.deepcopy(base)
    del no_reviewer["reviewer"]
    assert_rejected(
        "T1a qualified PASS with reviewer absent is rejected",
        screening_validator,
        no_reviewer,
    )
    null_reviewer = copy.deepcopy(base)
    null_reviewer["reviewer"] = None
    assert_rejected(
        "T1b qualified PASS with null reviewer is rejected",
        screening_validator,
        null_reviewer,
    )
    empty_identity = copy.deepcopy(base)
    empty_identity["reviewer"]["identity"] = ""
    assert_rejected(
        "T1c qualified PASS with empty reviewer identity is rejected",
        screening_validator,
        empty_identity,
    )
    empty_signature = copy.deepcopy(base)
    empty_signature["reviewer"]["signature"] = ""
    assert_rejected(
        "T1d qualified PASS with empty reviewer signature is rejected",
        screening_validator,
        empty_signature,
    )

    # ---- T2: marker_present=true requires TokenLock evidence ---------------
    marker = copy.deepcopy(base)
    marker["uncx_check"]["marker_present"] = True
    no_evidence = copy.deepcopy(marker)
    no_evidence["uncx_check"].pop("token_lock_evidence_sha256", None)
    assert_rejected(
        "T2a marker_present=true without token_lock_evidence_sha256 is rejected",
        screening_validator,
        no_evidence,
    )
    null_evidence = copy.deepcopy(marker)
    null_evidence["uncx_check"]["token_lock_evidence_sha256"] = None
    assert_rejected(
        "T2b marker_present=true with null token_lock_evidence_sha256 is rejected",
        screening_validator,
        null_evidence,
    )
    empty_evidence = copy.deepcopy(marker)
    empty_evidence["uncx_check"]["token_lock_evidence_sha256"] = []
    assert_rejected(
        "T2c marker_present=true with empty evidence array is rejected",
        screening_validator,
        empty_evidence,
    )
    bad_hash_evidence = copy.deepcopy(marker)
    bad_hash_evidence["uncx_check"]["token_lock_evidence_sha256"] = ["not-a-sha256"]
    assert_rejected(
        "T2d marker_present=true with malformed evidence hash is rejected",
        screening_validator,
        bad_hash_evidence,
    )
    good_evidence = copy.deepcopy(marker)
    good_evidence["uncx_check"]["token_lock_evidence_sha256"] = [
        "aa" * 32,
    ]
    assert_accepted(
        "T2e marker_present=true with a valid SHA-256 evidence entry is accepted",
        screening_validator,
        good_evidence,
    )

    # ---- T3: token2022_extensions / account_validation ---------------------
    token2022 = copy.deepcopy(base)
    token2022["pool"]["token_program"] = TOKEN_2022_PROGRAM
    token2022["token_program_coverage"]["mint_program"] = TOKEN_2022_PROGRAM
    null_ext = copy.deepcopy(token2022)
    null_ext["token_program_coverage"]["token2022_extensions"] = None
    assert_rejected(
        "T3a Token-2022 mint with null token2022_extensions is rejected",
        screening_validator,
        null_ext,
    )
    absent_ext = copy.deepcopy(token2022)
    del absent_ext["token_program_coverage"]["token2022_extensions"]
    assert_rejected(
        "T3b Token-2022 mint with token2022_extensions absent is rejected",
        screening_validator,
        absent_ext,
    )
    missing_handling = copy.deepcopy(token2022)
    missing_handling["token_program_coverage"]["token2022_extensions"] = [
        {"extension": "transfer-fee"}
    ]
    assert_rejected(
        "T3c Token-2022 extension record without handling is rejected",
        screening_validator,
        missing_handling,
    )
    no_account_validation = copy.deepcopy(token2022)
    no_account_validation["token_program_coverage"]["token2022_extensions"] = [
        {
            "extension": "transfer-fee",
            "handling": "EXAMPLE: withheld fees included in reconciliation",
        }
    ]
    del no_account_validation["token_program_coverage"]["account_validation"]
    assert_rejected(
        "T3d Token-2022 coverage without account_validation is rejected",
        screening_validator,
        no_account_validation,
    )
    spl_with_extensions = copy.deepcopy(base)
    spl_with_extensions["token_program_coverage"]["token2022_extensions"] = [
        {
            "extension": "transfer-fee",
            "handling": "EXAMPLE: withheld fees included in reconciliation",
        }
    ]
    assert_rejected(
        "T3e SPL Token mint with a non-null extensions array is rejected",
        screening_validator,
        spl_with_extensions,
    )
    valid_token2022 = copy.deepcopy(token2022)
    valid_token2022["token_program_coverage"]["token2022_extensions"] = [
        {
            "extension": "transfer-fee",
            "handling": "EXAMPLE: withheld fees included in reconciliation",
        }
    ]
    valid_token2022["token_program_coverage"]["cross_program_query_result"] = (
        "EXAMPLE: 0 accounts under SPL Token for this mint; recorded"
    )
    assert_accepted(
        "T3f valid Token-2022 example with explicit extension records is accepted",
        screening_validator,
        valid_token2022,
    )
    assert_accepted(
        "T3g valid SPL Token example (committed base example) is accepted",
        screening_validator,
        base,
    )

    # ---- T4/T5: inventory entry status/program_id/query_authoritative ------
    entries = copy.deepcopy(inventory_data["entries"])
    verified_idx = next(
        i for i, e in enumerate(entries) if e["status"] == "verified_in_repository"
    )
    candidate_idx = next(
        i for i, e in enumerate(entries) if e["status"] == "candidate_unverified"
    )

    candidate_with_program = copy.deepcopy(inventory_data)
    candidate_with_program["entries"][candidate_idx]["program_id"] = (
        "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo"
    )
    assert_rejected(
        "T4a candidate_unverified with a non-null program_id is rejected",
        inventory_validator,
        candidate_with_program,
    )
    candidate_authoritative = copy.deepcopy(inventory_data)
    candidate_authoritative["entries"][candidate_idx]["query_authoritative"] = True
    assert_rejected(
        "T5a candidate_unverified with query_authoritative=true is rejected",
        inventory_validator,
        candidate_authoritative,
    )
    candidate_ratified = copy.deepcopy(inventory_data)
    candidate_ratified["entries"][candidate_idx]["ratification_details"] = copy.deepcopy(
        inventory_data["entries"][verified_idx]["ratification_details"]
    )
    assert_rejected(
        "T5b candidate_unverified with ratification_details is rejected",
        inventory_validator,
        candidate_ratified,
    )
    verified_null_program = copy.deepcopy(inventory_data)
    verified_null_program["entries"][verified_idx]["program_id"] = None
    assert_rejected(
        "T5c verified_in_repository with null program_id is rejected",
        inventory_validator,
        verified_null_program,
    )
    verified_no_ratification = copy.deepcopy(inventory_data)
    del verified_no_ratification["entries"][verified_idx]["ratification_details"]
    assert_rejected(
        "T5d verified_in_repository without ratification_details is rejected",
        inventory_validator,
        verified_no_ratification,
    )
    verified_not_authoritative = copy.deepcopy(inventory_data)
    verified_not_authoritative["entries"][verified_idx]["query_authoritative"] = False
    assert_rejected(
        "T5e verified_in_repository with query_authoritative=false is rejected",
        inventory_validator,
        verified_not_authoritative,
    )

    # ---- Summary ------------------------------------------------------------
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} of {CHECKS} checks failed:")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    print(f"ok: all {CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
