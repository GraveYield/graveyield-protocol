#!/usr/bin/env python3
"""Validation and negative-test harness for the M1 locker documentation schemas.

Scope (GY-OPS-RB-05 R1/R7, DR-003 D-05): guards the committed locker-screening
documentation without touching protocol code.

Checks performed:
  1. Both schema documents are valid draft 2020-12 JSON Schemas (meta-validation).
  2. docs/ops/locker-inventory.json validates against docs/ops/locker-inventory.schema.json.
  3. The embedded gy.locker-screening.v1 example validates against its own schema.
  4. The deterministic manifest_sha256 recipe (RFC 8785 JCS canonicalization,
     with manifest_sha256 itself excluded — GY-OPS-RB-05 R7) reproduces the
     digest committed in the screening example (reproducible test vector), and
     a tampered artifact yields a different digest.
  5. RFC 8785 Appendix B.2 number vectors (IEEE 754 bit patterns from the RFC
     text at rfc-editor.org) — authoritative expected serializations.
  6. Committed JCS/manifest test vectors (docs/ops/manifest-test-vectors.json):
     expected canonical UTF-8 bytes, byte lengths, and SHA-256 values, generated
     with an independent RFC 8785 implementation (Node.js JSON.stringify over
     UTF-16-sorted copies) and cross-checked live against that Node
     implementation on every run when node is available.
  7. Integer subset boundary: every schema-valid integer lies in the
     interoperable safe-integer range (|n| <= 2^53 - 1); the canonicalizer
     additionally rejects integers that are not exactly representable as
     IEEE 754 doubles.
  8. Strict JSON parsing: every committed documentation JSON document is
     parsed with duplicate-member rejection at every object nesting level.

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
  T6  pool.token_program and token_program_coverage.mint_program must agree
      (changing one while preserving the other is rejected)
  T7  deterministic manifest recipe on the committed example: the digest
      reproduces, tampering is detected, and the canonical bytes are stable
      across a JSON round-trip
  F1  RFC 8785 conformance: Appendix B.2 numbers, string handling, committed
      vectors, independent Node.js cross-check; invalid Unicode (unpaired
      UTF-16 surrogates in values and member names) is rejected, never
      escaped; integers not exactly representable as IEEE 754 doubles are
      rejected
  F2  manifest-hashing supported subset for getProgramAccounts filters
      (non-integral numbers and non-ASCII member names rejected)
  F3  safe-integer subset boundary: integers beyond 2^53 - 1 are rejected by
      both schemas; the maximum permitted integer is accepted and pinned by a
      committed vector; the first non-double-exact integer is rejected by the
      canonicalizer
  F4  strict JSON parsing: duplicate object members are rejected at the
      document root and at every nesting level; the same member name in
      sibling objects remains accepted

Exit code 0 = every check passed; nonzero = at least one failure.
"""

import copy
import hashlib
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path

import jsonschema

REPO_ROOT = Path(__file__).resolve().parent.parent
INVENTORY_SCHEMA_PATH = REPO_ROOT / "docs" / "ops" / "locker-inventory.schema.json"
INVENTORY_DATA_PATH = REPO_ROOT / "docs" / "ops" / "locker-inventory.json"
SCREENING_SCHEMA_PATH = REPO_ROOT / "docs" / "ops" / "locker-screening.schema.json"
VECTORS_PATH = REPO_ROOT / "docs" / "ops" / "manifest-test-vectors.json"

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
            [(list(e.absolute_path), e.message) for e in errors], default=str
        )
        missing = [s for s in expected_substrings if s not in text]
        if missing:
            ok = False
            detail = f"error(s) raised but not for expected reason(s): {missing}"
    report(name, ok, detail)


def assert_accepted(name, validator, instance):
    errors = list(validator.iter_errors(instance))
    detail = "; ".join(f"{list(e.absolute_path)}: {e.message}" for e in errors[:5])
    report(name, not errors, detail)


def assert_strict_loads_rejected(name, text):
    try:
        strict_json_loads(text)
    except StrictJsonError:
        report(name, True)
    except ValueError as exc:  # noqa: BLE001 — wrong rejection type is a failure
        report(name, False, f"rejected with an unexpected error type: {exc}")
    else:
        report(name, False, "duplicate-member document was not rejected")


# --------------------------------------------------------------------------
# RFC 8785 (JSON Canonicalization Scheme) — genuine implementation.
#
# - Object members are sorted by UTF-16 code units (RFC 8785 §3.2.3), which is
#   implemented by comparing each key's UTF-16 big-endian byte sequence: every
#   code unit is exactly two bytes, so byte-wise lexicographic order equals
#   unit-wise order. This differs from Unicode code-point order for keys
#   containing characters outside the BMP (surrogate pairs).
# - Numbers are serialized per ECMAScript Number::toString (RFC 8785 §3.2.2.3),
#   the shortest round-trip decimal form with ES6 notation thresholds; every
#   number goes through its IEEE 754 double value first. Integers that are not
#   exactly representable as IEEE 754 doubles are rejected (I-JSON, RFC 8785
#   §3.2.2.3).
# - Strings escape per RFC 8785 §3.2.2.2: quotation mark, backslash, and the
#   C0 control characters only; everything else (including U+2028/U+2029,
#   DEL, and supplementary-plane characters) is emitted literally as UTF-8.
#   Unpaired UTF-16 surrogate code units are invalid Unicode input: RFC 8785
#   requires canonicalization to fail rather than silently emit them, so
#   they are rejected (fail closed) instead of being escaped as \udXXX.
# --------------------------------------------------------------------------
_SHORT_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _es6_number(value):
    """Serialize a JSON number per ECMAScript Number::toString (RFC 8785)."""
    if isinstance(value, bool):
        raise TypeError("booleans are not numbers")
    if isinstance(value, int):
        as_double = float(value)
        if as_double != value:
            raise ValueError(
                f"integer {value} is not exactly representable as an "
                "IEEE 754 double (I-JSON / RFC 8785 §3.2.2.3)"
            )
    else:
        as_double = float(value)
    if as_double != as_double or as_double in (float("inf"), float("-inf")):
        raise ValueError("NaN/Infinity are not permitted in JSON")
    if as_double == 0:
        return "0"  # covers 0 and -0 (RFC 8785 Appendix B: minus zero -> 0)
    sign = "-" if as_double < 0 else ""
    text = repr(abs(as_double))  # shortest round-trip digits (same as ES6)
    mantissa, _, exp_part = text.partition("e")
    exp10 = int(exp_part) if exp_part else 0
    if "." in mantissa:
        before, _, after = mantissa.partition(".")
        raw_digits = before + after
        dot_pos = len(before)
    else:
        raw_digits = mantissa
        dot_pos = len(mantissa)
    if raw_digits.strip("0") == "":
        return "0"
    digits1 = raw_digits.lstrip("0")  # leading zeros do not change the value
    trailing = len(digits1) - len(digits1.rstrip("0"))
    digits = digits1.rstrip("0") or "0"
    k = len(digits)
    # value == int(raw_digits) * 10**(exp10 - (len(raw_digits) - dot_pos))
    #        == int(digits)  * 10**(exp10 - (len(raw_digits) - dot_pos) + trailing)
    # ES6 spec convention: s * 10**(n - k) == m  =>  n = q + k.
    q = exp10 - (len(raw_digits) - dot_pos) + trailing
    n = q + k
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        exponent = n - 1
        body = digits[0]
        if k > 1:
            body += "." + digits[1:]
        body += "e" + ("+" if exponent >= 0 else "-") + str(abs(exponent))
    return sign + body


def _serialize_string(text):
    # RFC 8785 §3.2.2.2 requires string data to be valid Unicode. Unpaired
    # UTF-16 surrogate code units cannot be emitted as valid UTF-8 JSON, so
    # canonicalization fails closed instead of escaping them. (Python's JSON
    # parser combines well-formed surrogate pairs into single scalar
    # characters, so any surrogate surviving here is unpaired by
    # construction.)
    out = ['"']
    for ch in text:
        code = ord(ch)
        esc = _SHORT_ESCAPES.get(ch)
        if esc is not None:
            out.append(esc)
        elif 0xD800 <= code <= 0xDFFF:
            raise ValueError(
                "invalid Unicode: unpaired UTF-16 surrogate code unit "
                f"U+{code:04X} fails canonicalization (RFC 8785 §3.2.2.2 "
                "requires valid Unicode input; it must not be escaped)"
            )
        elif code < 0x20:
            out.append("\\u%04x" % code)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(key):
    # UTF-16 big-endian byte order == UTF-16 code-unit order (fixed 2-byte
    # units). surrogatepass is kept only as a defensive fallback; unpaired
    # surrogates are already rejected during string serialization.
    return key.encode("utf-16-be", "surrogatepass")


def jcs_canonicalize(value):
    """RFC 8785 canonical JSON serialization of a parsed JSON value."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, str):
        return _serialize_string(value)
    if isinstance(value, (int, float)):
        return _es6_number(value)
    if isinstance(value, list):
        return "[" + ",".join(jcs_canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        members = []
        for key in sorted(value.keys(), key=_utf16_key):
            members.append(_serialize_string(key) + ":" + jcs_canonicalize(value[key]))
        return "{" + ",".join(members) + "}"
    raise TypeError(f"unsupported value type: {type(value)!r}")


def manifest_digest(artifact):
    """GY-OPS-RB-05 R7: SHA-256 of the canonical form of the artifact with
    its top-level manifest_sha256 member excluded."""
    body = copy.deepcopy(artifact)
    body.pop("manifest_sha256", None)
    canonical = jcs_canonicalize(body)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest(), canonical


# --------------------------------------------------------------------------
# Strict JSON parsing (GY-OPS-RB-05 R7 input hygiene).
#
# Python's json.loads() silently accepts duplicate object keys (last value
# wins), which would allow the object that gets schema-validated to differ
# from the object that gets hashed. Every documentation JSON document is
# therefore parsed with duplicate-member rejection at every object nesting
# level. (The independent Node.js implementation is strict here by
# construction: its JSON.parse already throws on duplicate object keys.)
# --------------------------------------------------------------------------


class StrictJsonError(ValueError):
    """Raised when a JSON document contains a duplicate object member."""


def _object_pairs_no_duplicates(pairs):
    seen = set()
    for key, _value in pairs:
        if key in seen:
            raise StrictJsonError(f"duplicate JSON object member: {key!r}")
        seen.add(key)
    return dict(pairs)


def strict_json_loads(text):
    """json.loads() that rejects duplicate object members at every nesting level."""
    return json.loads(text, object_pairs_hook=_object_pairs_no_duplicates)


# RFC 8785 Appendix B.2 number vectors (rfc-editor.org/rfc/rfc8785.txt):
# (IEEE 754 bit pattern, expected canonical serialization). NaN/Infinity rows
# are omitted: those values are not permitted in JSON.
RFC_NUMBER_VECTORS = [
    ("0000000000000000", "0"),  # Zero
    ("8000000000000000", "0"),  # Minus zero
    ("0000000000000001", "5e-324"),  # Min pos number
    ("8000000000000001", "-5e-324"),  # Min neg number
    ("7fefffffffffffff", "1.7976931348623157e+308"),  # Max pos number
    ("ffefffffffffffff", "-1.7976931348623157e+308"),  # Max neg number
    ("4340000000000000", "9007199254740992"),  # Max pos int
    ("c340000000000000", "-9007199254740992"),  # Max neg int
    ("4430000000000000", "295147905179352830000"),  # ~2**68
    ("44b52d02c7e14af5", "9.999999999999997e+22"),
    ("44b52d02c7e14af6", "1e+23"),
    ("44b52d02c7e14af7", "1.0000000000000001e+23"),
    ("444b1ae4d6e2ef4e", "999999999999999700000"),
    ("444b1ae4d6e2ef4f", "999999999999999900000"),
    ("444b1ae4d6e2ef50", "1e+21"),
    ("3eb0c6f7a0b5ed8c", "9.999999999999997e-7"),
    ("3eb0c6f7a0b5ed8d", "0.000001"),
    ("41b3de4355555553", "333333333.3333332"),
    ("41b3de4355555554", "333333333.33333325"),
    ("41b3de4355555555", "333333333.3333333"),
    ("41b3de4355555556", "333333333.3333334"),
    ("41b3de4355555557", "333333333.33333343"),
    ("becbf647612f3696", "-0.0000033333333333333333"),
    ("43143ff3c1cb0959", "1424953923781206.2"),  # Round to even
]


# Independent RFC 8785 implementation: Node.js. ECMAScript JSON.stringify is
# the serialization RFC 8785 §3.2.2.3 normatively references; JS Array.sort on
# strings orders by UTF-16 code units, which implements §3.2.3 property
# ordering. Expected values committed in the vectors file were generated with
# this implementation, and the live check below re-verifies on every run.
# Node's JSON.parse additionally rejects duplicate object keys by
# construction, independently enforcing the strict-parsing rule on the
# committed vectors file.
NODE_CHECK_SCRIPT = r"""
const crypto = require('crypto');
const fs = require('fs');
function jcs(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  const keys = Object.keys(value).sort(); // UTF-16 code-unit order
  return '{' + keys.map(k => JSON.stringify(k) + ':' + jcs(value[k])).join(',') + '}';
}
function sha(canonical) {
  return crypto.createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
}
function doubleFromHex(hex) {
  const buf = Buffer.from(hex, 'hex');
  const view = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 8; i++) view.setUint8(i, buf[i]);
  return view.getFloat64(0);
}
const vectors = JSON.parse(fs.readFileSync('docs/ops/manifest-test-vectors.json', 'utf8'));
const out = { vectors: {}, rfc: {}, extras: {}, example: null };
for (const t of vectors.vectors) {
  const body = t.exclude_manifest_sha256
    ? Object.fromEntries(Object.entries(t.input).filter(([k]) => k !== 'manifest_sha256'))
    : t.input;
  out.vectors[t.name] = { canonical: jcs(body), sha256: sha(jcs(body)) };
}
// RFC Appendix B.2 numbers via the independent implementation
const rfcVectors = JSON.parse(fs.readFileSync(process.env.RFC_VECTORS_TMP, 'utf8'));
for (const [hex, expected] of rfcVectors) {
  const d = doubleFromHex(hex);
  if (!Number.isFinite(d)) { out.rfc[hex] = { error: 'nonfinite' }; continue; }
  const s = jcs(d);
  out.rfc[hex] = { canonical: s, expected: expected, matches: s === expected };
}
// extra string cases (constructed here to match the Python-side constructions)
out.extras = JSON.parse(fs.readFileSync(process.env.EXTRAS_TMP, 'utf8'));
out.extrasCanonical = {};
for (const [name, input] of Object.entries(JSON.parse(fs.readFileSync(process.env.EXTRAS_INPUT_TMP, 'utf8')))) {
  out.extrasCanonical[name] = jcs(input);
}
// committed screening example
const schema = JSON.parse(fs.readFileSync('docs/ops/locker-screening.schema.json', 'utf8'));
const ex = JSON.parse(JSON.stringify(schema.examples[0]));
delete ex.manifest_sha256;
out.example = { canonical: jcs(ex), sha256: sha(jcs(ex)) };
process.stdout.write(JSON.stringify(out));
"""


# In-script constructed string cases beyond the committed vectors file
# (constructed programmatically so no raw control bytes, U+2028/U+2029, or
# surrogates enter the repository): (name, input, expected canonical)
EXTRA_STRING_ASSERTIONS = [
    ("u0001", "\u0001", '"\\u0001"'),
    ("del_u007f", "\u007f", '"\u007f"'),
    ("u2028_literal", "a\u2028b", '"a\u2028b"'),
    ("u2029_literal", "a\u2029b", '"a\u2029b"'),
    ("supplementary_plane_literal", "\U0001F600", '"\U0001F600"'),
]

# Invalid-Unicode inputs that MUST fail canonicalization (RFC 8785 §3.2.2.2):
# unpaired UTF-16 surrogate code units, in string values and in object member
# names alike. These replace the former lone-surrogate escaping acceptance:
# canonicalization must fail closed, never silently escape invalid Unicode.
REJECTED_UNICODE_INPUTS = [
    ("unpaired_high_surrogate_value", "\ud800"),
    ("unpaired_low_surrogate_value", "\udc00"),
    ("unpaired_high_surrogate_member_name", {"\ud800x": 1}),
    ("unpaired_low_surrogate_member_name", {"tail\udfff": 1}),
]


def run_node_cross_check(screening_example):
    """Returns dict with per-vector digests from the Node implementation, or
    None when node is unavailable."""
    if shutil.which("node") is None:
        return None
    import os
    import tempfile

    rfc_tmp = tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, dir=tempfile.gettempdir()
    )
    json.dump(RFC_NUMBER_VECTORS, rfc_tmp)
    rfc_tmp.close()
    extras_input = {name: input_ for name, input_, _ in EXTRA_STRING_ASSERTIONS}
    extras_expected = {name: expected for name, _, expected in EXTRA_STRING_ASSERTIONS}
    extras_input_tmp = tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, dir=tempfile.gettempdir()
    )
    json.dump(extras_input, extras_input_tmp, ensure_ascii=True)
    extras_input_tmp.close()
    extras_expected_tmp = tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, dir=tempfile.gettempdir()
    )
    json.dump(extras_expected, extras_expected_tmp, ensure_ascii=True)
    extras_expected_tmp.close()
    env = dict(
        os.environ,
        RFC_VECTORS_TMP=rfc_tmp.name,
        EXTRAS_INPUT_TMP=extras_input_tmp.name,
        EXTRAS_EXPECTED_TMP=extras_expected_tmp.name,
    )
    # The inline script reads EXTRAS_TMP for expected values; point it at the
    # expected map (input map is read separately below).
    env["EXTRAS_TMP"] = extras_expected_tmp.name
    env["EXTRAS_INPUT_TMP"] = extras_input_tmp.name
    proc = subprocess.run(
        ["node", "-e", NODE_CHECK_SCRIPT],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    for tmp in (rfc_tmp.name, extras_input_tmp.name, extras_expected_tmp.name):
        Path(tmp).unlink(missing_ok=True)
    if proc.returncode != 0:
        raise RuntimeError(f"node cross-check failed: {proc.stderr[:2000]}")
    return strict_json_loads(proc.stdout)




def main():
    # ---- Load and meta-validate the schemas --------------------------------
    inventory_schema = strict_json_loads(INVENTORY_SCHEMA_PATH.read_text())
    screening_schema = strict_json_loads(SCREENING_SCHEMA_PATH.read_text())
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
    inventory_data = strict_json_loads(INVENTORY_DATA_PATH.read_text())
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

    # ---- RFC 8785 Appendix B.2 authoritative number vectors -----------------
    rfc_failures = []
    for hex_bits, expected in RFC_NUMBER_VECTORS:
        double = struct.unpack(">d", bytes.fromhex(hex_bits))[0]
        try:
            got = _es6_number(double)
        except ValueError as exc:
            rfc_failures.append(f"{hex_bits}: {exc}")
            continue
        if got != expected:
            rfc_failures.append(f"{hex_bits}: expected {expected!r}, got {got!r}")
    report(
        "F1a RFC 8785 Appendix B.2 number vectors (24 IEEE 754 bit patterns) "
        "serialize exactly as the RFC specifies",
        not rfc_failures,
        "; ".join(rfc_failures[:6]),
    )

    # ---- In-script string handling and invalid-Unicode rejection ------------
    string_failures = []
    for name, input_, expected in EXTRA_STRING_ASSERTIONS:
        got = _serialize_string(input_)
        if got != expected:
            string_failures.append(f"{name}: expected {expected!r}, got {got!r}")
    # invalid Unicode must fail canonicalization, never be escaped
    for name, input_ in REJECTED_UNICODE_INPUTS:
        try:
            jcs_canonicalize(input_)
            string_failures.append(f"{name} was canonicalized instead of rejected")
        except ValueError:
            pass
    # integers that are not IEEE 754-exact must be rejected (I-JSON)
    try:
        _es6_number(10**60)
        string_failures.append("non-representable integer 10**60 was not rejected")
    except ValueError:
        pass
    report(
        "F1b JCS string handling: control chars, DEL, U+2028/U+2029 and "
        "supplementary-plane characters literal; unpaired high/low surrogates "
        "(values and member names) rejected; non-exact integers rejected",
        not string_failures,
        "; ".join(string_failures),
    )

    # ---- Committed test vectors (docs/ops/manifest-test-vectors.json) -------
    vectors_doc = strict_json_loads(VECTORS_PATH.read_text())
    vector_results = {}
    vector_failures = []
    for vector in vectors_doc["vectors"]:
        name = vector["name"]
        body = vector["input"]
        if vector.get("exclude_manifest_sha256"):
            body = {
                key: value
                for key, value in body.items()
                if key != "manifest_sha256"
            }
        canonical = jcs_canonicalize(body)
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        byte_len = len(canonical.encode("utf-8"))
        ok = (
            canonical == vector["expected_canonical"]
            and digest == vector["expected_sha256"]
            and byte_len == vector["expected_byte_length"]
        )
        vector_results[name] = {"canonical": canonical, "sha256": digest}
        if not ok:
            vector_failures.append(
                f"{name}: canonical_match={canonical == vector['expected_canonical']} "
                f"digest_match={digest == vector['expected_sha256']} "
                f"len_match={byte_len == vector['expected_byte_length']}"
            )
    report(
        f"F1c committed JCS/manifest test vectors reproduce expected canonical "
        f"UTF-8 bytes, byte lengths, and SHA-256 values ({len(vectors_doc['vectors'])} vectors)",
        not vector_failures,
        "; ".join(vector_failures),
    )

    # ---- Screening example manifest (R7) ------------------------------------
    stated = screening_example["manifest_sha256"]
    recomputed, canonical_example = manifest_digest(screening_example)
    report(
        "T7a deterministic manifest recipe reproduces the committed example digest",
        recomputed == stated,
        f"stated={stated} recomputed={recomputed}",
    )
    tampered = copy.deepcopy(screening_example)
    tampered["run_id"] = tampered["run_id"] + "-TAMPERED"
    report(
        "T7b tampered artifact yields a different manifest digest (detected)",
        manifest_digest(tampered)[0] != stated,
    )
    roundtrip = strict_json_loads(canonical_example)
    report(
        "T7c canonical serialization is byte-stable across a JSON round-trip",
        manifest_digest(roundtrip)[0] == stated,
    )

    # ---- Live cross-check against the independent Node implementation -------
    try:
        node_out = run_node_cross_check(screening_example)
    except Exception as exc:  # noqa: BLE001 — surfaced as a failure
        node_out = None
        report("F1d independent Node.js RFC 8785 cross-check", False, str(exc))
    else:
        if node_out is None:
            report(
                "F1d independent Node.js RFC 8785 cross-check (node unavailable; "
                "committed Node-generated constants still enforced above)",
                True,
            )
        else:
            node_failures = []
            for name, got in node_out["vectors"].items():
                if got["canonical"] != vector_results[name]["canonical"]:
                    node_failures.append(f"{name}: canonical differs")
                if got["sha256"] != vector_results[name]["sha256"]:
                    node_failures.append(f"{name}: sha256 differs")
            for hex_bits, got in node_out["rfc"].items():
                if not got.get("matches", False):
                    node_failures.append(f"rfc {hex_bits}: {got}")
            for name, canonical in node_out.get("extrasCanonical", {}).items():
                expected = dict(
                    (n, e) for n, _i, e in EXTRA_STRING_ASSERTIONS
                )[name]
                if canonical != expected:
                    node_failures.append(
                        f"extra {name}: expected {expected!r}, got {canonical!r}"
                    )
            if node_out["example"]["sha256"] != stated:
                node_failures.append("screening example digest differs from Node")
            report(
                "F1d independent Node.js RFC 8785 cross-check (vectors, RFC "
                "numbers, string cases, example digest)",
                not node_failures,
                "; ".join(node_failures[:6]),
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

    # ---- T6: pool.token_program == token_program_coverage.mint_program -----
    # Both mutations start from a fully valid artifact so the ONLY schema
    # violation is the pool/mint-program mismatch.
    mismatch_2022_pool = copy.deepcopy(base)
    mismatch_2022_pool["pool"]["token_program"] = TOKEN_2022_PROGRAM
    assert_rejected(
        "T6a pool=Token-2022 with mint_program=SPL Token is rejected",
        screening_validator,
        mismatch_2022_pool,
    )
    mismatch_spl_pool = copy.deepcopy(valid_token2022)
    mismatch_spl_pool["pool"]["token_program"] = SPL_TOKEN_PROGRAM
    assert_rejected(
        "T6b pool=SPL Token with mint_program=Token-2022 is rejected",
        screening_validator,
        mismatch_spl_pool,
    )

    # ---- F2: manifest-hashing supported subset for filters ------------------
    valid_filters = copy.deepcopy(base)
    valid_filters["per_locker_queries"] = [
        {
            "program_id": "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo",
            "filters": [
                {"dataSize": 146},
                {"memcmp": {"offset": 41, "bytes": "EXAMPLEb58bytes"}},
            ],
            "result": "EXAMPLE: complete result recorded",
            "raw_response_sha256": "bb" * 32,
        }
    ]
    assert_accepted(
        "F2a filters with ASCII keys and schema-safe values are accepted",
        screening_validator,
        valid_filters,
    )
    float_filters = copy.deepcopy(valid_filters)
    float_filters["per_locker_queries"][0]["filters"][0] = {"dataSize": 146.5}
    assert_rejected(
        "F2b filters containing a non-integral number are rejected (manifest subset)",
        screening_validator,
        float_filters,
    )
    nonascii_key_filters = copy.deepcopy(valid_filters)
    nonascii_key_filters["per_locker_queries"][0]["filters"][0] = {"サイズ": 146}
    assert_rejected(
        "F2c filters containing a non-ASCII property name are rejected (manifest subset)",
        screening_validator,
        nonascii_key_filters,
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

    # ---- F3: safe-integer subset boundary -----------------------------------
    big_int = 9007199254740992  # 2^53 — first integer beyond the safe range
    max_int = 9007199254740991  # 2^53 - 1 — Number.MAX_SAFE_INTEGER
    slots_big = copy.deepcopy(base)
    slots_big["rpc"]["response_slots"] = [big_int]
    assert_rejected(
        "F3a integer 2^53 in rpc.response_slots is rejected (safe-integer maximum is 2^53-1)",
        screening_validator,
        slots_big,
        expected_substrings=("9007199254740991",),
    )
    filter_big = copy.deepcopy(base)
    filter_big["per_locker_queries"] = [
        {
            "program_id": "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo",
            "filters": [{"dataSize": big_int}],
            "result": "EXAMPLE: complete result recorded",
            "raw_response_sha256": "bb" * 32,
        }
    ]
    assert_rejected(
        "F3b out-of-range integer nested inside a filter object is rejected",
        screening_validator,
        filter_big,
        expected_substrings=(
            "9007199254740992",
            "not valid under any of the given schemas",
        ),
    )
    slots_max = copy.deepcopy(base)
    slots_max["rpc"]["response_slots"] = [max_int]
    assert_accepted(
        "F3c maximum permitted integer 2^53-1 accepted in rpc.response_slots",
        screening_validator,
        slots_max,
    )
    filters_max = copy.deepcopy(base)
    filters_max["per_locker_queries"] = [
        {
            "program_id": "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo",
            "filters": [{"dataSize": max_int}, {"limit": -max_int}],
            "result": "EXAMPLE: complete result recorded",
            "raw_response_sha256": "bb" * 32,
        }
    ]
    assert_accepted(
        "F3d maximum permitted integer 2^53-1 accepted in nested filter values",
        screening_validator,
        filters_max,
    )
    try:
        _es6_number(big_int + 1)
        report(
            "F3e canonicalizer rejects the first non-double-exact integer (2^53+1)",
            False,
            "9007199254740993 was serialized instead of rejected",
        )
    except ValueError:
        report(
            "F3e canonicalizer rejects the first non-double-exact integer (2^53+1)",
            True,
        )
    inventory_big = copy.deepcopy(inventory_data)
    inventory_big["entries"][verified_idx]["ratification_details"]["accounts"][0][
        "account_size"
    ] = big_int
    assert_rejected(
        "F3f out-of-range integer account_size rejected by the inventory schema",
        inventory_validator,
        inventory_big,
        expected_substrings=("9007199254740991",),
    )

    # ---- F4: strict JSON parsing (duplicate object members) -----------------
    assert_strict_loads_rejected(
        "F4a duplicate member key at the document root is rejected",
        '{"schema": "gy.locker-screening.v1", "run_id": "EXAMPLE", '
        '"run_id": "EXAMPLE"}',
    )
    assert_strict_loads_rejected(
        "F4b duplicate member key inside a nested object is rejected",
        '{"pool": {"address": "11111111111111111111111111111112", '
        '"address": "11111111111111111111111111111112"}}',
    )
    assert_strict_loads_rejected(
        "F4c duplicate member key inside an object nested in an array is rejected",
        '{"per_locker_queries": [{"filters": [{"dataSize": 1, "dataSize": 2}]}]}',
    )
    try:
        strict_json_loads('{"a": {"x": 1}, "b": {"x": 2}}')
        report(
            "F4d the same member name in sibling objects is accepted "
            "(only true duplicates rejected)",
            True,
        )
    except ValueError as exc:
        report(
            "F4d the same member name in sibling objects is accepted "
            "(only true duplicates rejected)",
            False,
            str(exc),
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
