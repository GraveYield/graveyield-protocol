// SPDX-License-Identifier: Apache-2.0
//
// ns3_check_provenance.mjs — fail-closed NS-3 deployment-provenance gate.
//
// WHY: PR #82 made CI verify that the ELFs it publishes as
// deployment-provenance artifacts are byte-identical to the recorded
// deployment digests — but the DEPLOYMENT path itself (deploy_devnet.sh)
// never re-checked them: `--skip-build` would happily deploy any ELF
// pre-placed into target/deploy/, and a locally rebuilt tree deployed
// without any digest comparison. This checker closes that gap by giving
// the deployment script and CI ONE shared gate over ONE shared manifest
// (provenance.manifest.json) — no independent copies of the digests.
//
// WHAT IT ENFORCES (every check fail-closed):
//   1. Manifest integrity — schema, well-formed 64-hex digests, artifact
//      paths inside the build tree. A malformed manifest aborts.
//   2. ELF SHA-256 — each artifact's digest must equal the manifest pin.
//      A missing, unreadable, or changed ELF aborts.
//   3. SBPF v0 architecture — the ELF header must carry e_machine 263 /
//      e_flags 0 (the deploy-flow v0 target; DR-001/NS-2). An ELF built
//      for any other sbpf version aborts EVEN IF its digest and embedded
//      ID match. This invariant is hardcoded here and cross-checked
//      against the manifest: a manifest edited to a different arch is
//      itself a failure.
//   4. Structural NS-3 identity — the expected program ID must occur
//      inside an allocated ELF section and no NS-1/NS-2 legacy ID bytes
//      may appear anywhere (reuses ns3_verify_elf.mjs; the caller passes
//      the expected IDs — the manifest is never the identity source).
//   5. Optional platform-tools tarball integrity (--platform-tools-tarball):
//      the toolchain tarball's digest must equal the manifest pin.
//
// WHAT THIS IS NOT: it does not prove the build is trustworthy — it
// proves the bytes being deployed are EXACTLY the bytes whose digests
// were reviewed and recorded. Updating a digest is a deliberate,
// reviewed act (docs/DEVNET.md § provenance), never a way to make a
// red build green.
//
// CLI (consumed by deploy_devnet.sh + .github/workflows/ci.yml):
//   node ns3_check_provenance.mjs \
//     --scanner-so <path.so> --vault-so <path.so> \
//     --scanner-id <PK> --vault-id <PK> \
//     [--manifest <path>] [--platform-tools-tarball <path>]
//
// Exit codes: 0 all checks pass; 1 any check failed; 2 usage/manifest error.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NS3_LEGACY_IDS, verifyElfIdentity } from "./ns3_verify_elf.mjs";

export const PROVENANCE_SCHEMA = "graveyield.provenance/1";

/**
 * The ONLY accepted on-chain target architecture (DR-001/NS-2): the
 * deploy-flow SBPF v0 target (triple sbpf-solana-solana). e_machine 247
 * with a non-zero e_flags is the sbpf v1–v3 line anchor 1.2.2 would
 * otherwise emit — those bytes are NOT the deployment provenance and are
 * refused here even when every other check passes. Hardcoded so a
 * manifest edit cannot weaken the arch gate.
 */
export const REQUIRED_SBPF = Object.freeze({ arch: "v0", e_machine: 263, e_flags: 0 });

const HEX64 = /^[0-9a-f]{64}$/;

/** Default manifest: the one committed next to this script. */
export const DEFAULT_MANIFEST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "provenance.manifest.json",
);

/**
 * Load and strictly validate the provenance manifest. Throws (caller exits 2)
 * with a precise message on any structural problem.
 */
export function loadProvenanceManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new Error(`provenance manifest unreadable at ${manifestPath}: ${err.message}`);
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch (err) {
    throw new Error(`provenance manifest is not valid JSON (${manifestPath}): ${err.message}`);
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    throw new Error("provenance manifest must be a JSON object");
  }
  if (m.schema !== PROVENANCE_SCHEMA) {
    throw new Error(
      `provenance manifest schema ${JSON.stringify(m.schema)} != expected "${PROVENANCE_SCHEMA}"`,
    );
  }
  const programs = m.programs ?? {};
  for (const name of ["grave_scanner", "grave_vault"]) {
    const p = programs[name];
    if (typeof p !== "object" || p === null) {
      throw new Error(`provenance manifest missing programs.${name}`);
    }
    if (typeof p.sha256 !== "string" || !HEX64.test(p.sha256)) {
      throw new Error(
        `programs.${name}.sha256 must be a lowercase 64-hex digest (got ${JSON.stringify(p.sha256)})`,
      );
    }
    if (typeof p.artifact !== "string" || p.artifact.length === 0) {
      throw new Error(`programs.${name}.artifact must be a path string`);
    }
    if (path.isAbsolute(p.artifact) || p.artifact.split(path.sep).includes("..")) {
      throw new Error(
        `programs.${name}.artifact must stay inside the build tree (got ${p.artifact})`,
      );
    }
  }
  const t = m.toolchain ?? {};
  // The arch pin is an invariant, not a knob: the manifest must agree with
  // REQUIRED_SBPF or the gate refuses to run at all.
  if (t.sbpf_arch !== REQUIRED_SBPF.arch) {
    throw new Error(
      `toolchain.sbpf_arch ${JSON.stringify(t.sbpf_arch)} != required "${REQUIRED_SBPF.arch}" — ` +
        "the deployment target architecture is an invariant and cannot be re-pinned",
    );
  }
  if (
    typeof t.elf !== "object" ||
    t.elf === null ||
    t.elf.e_machine !== REQUIRED_SBPF.e_machine ||
    t.elf.e_flags !== REQUIRED_SBPF.e_flags
  ) {
    throw new Error(
      `toolchain.elf must pin e_machine ${REQUIRED_SBPF.e_machine} / e_flags ${REQUIRED_SBPF.e_flags} ` +
        "(SBPF v0) — the deployment target architecture is an invariant",
    );
  }
  if (typeof t.solana_cli !== "string" || !/^\d+\.\d+\.\d+$/.test(t.solana_cli)) {
    throw new Error(
      `toolchain.solana_cli must be a semver string (got ${JSON.stringify(t.solana_cli)})`,
    );
  }
  const pt = t.platform_tools ?? {};
  if (typeof pt !== "object" || pt === null) {
    throw new Error("provenance manifest missing toolchain.platform_tools");
  }
  if (typeof pt.version !== "string" || pt.version.length === 0) {
    throw new Error("toolchain.platform_tools.version must be a string");
  }
  if (typeof pt.sha256 !== "string" || !HEX64.test(pt.sha256)) {
    throw new Error("toolchain.platform_tools.sha256 must be a lowercase 64-hex digest");
  }
  if (typeof pt.url !== "string" || !pt.url.startsWith("https://")) {
    throw new Error("toolchain.platform_tools.url must be an https URL");
  }
  return m;
}

/** SHA-256 of a file, hex lowercase. Throws on unreadable input. */
export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Check one ELF buffer: SBPF v0 header + digest pin + structural identity.
 * Returns [{ id, ok, detail }] — never throws for a verdict (only for
 * caller mistakes like a missing argument).
 */
export function checkElfProvenance(buf, { label, manifestPath, digest, expectedId }) {
  const checks = [];
  const push = (id, ok, detail) => checks.push({ id, ok, detail });
  const actual = createHash("sha256").update(buf).digest("hex");
  push(
    `digest-${label}`,
    actual === digest,
    actual === digest
      ? `sha256 ${actual} matches the ${manifestPath} pin`
      : `sha256 MISMATCH: got ${actual}, manifest pins ${digest} — deployment provenance closed; ` +
          "re-pin only after an independently reviewed rebuild (docs/DEVNET.md)",
  );
  const eMachine = buf.length >= 20 ? buf.readUInt16LE(18) : -1;
  const eFlags = buf.length >= 40 ? buf.readUInt32LE(36) : -1;
  const archOk = eMachine === REQUIRED_SBPF.e_machine && eFlags === REQUIRED_SBPF.e_flags;
  push(
    `arch-${label}`,
    archOk,
    archOk
      ? `SBPF v0 confirmed (e_machine ${eMachine}, e_flags ${eFlags})`
      : `architecture MISMATCH: e_machine ${eMachine} / e_flags ${eFlags} — this is NOT the ` +
          `SBPF v0 deployment target (${REQUIRED_SBPF.e_machine}/${REQUIRED_SBPF.e_flags}); ` +
          "an ELF built for another sbpf version is refused even if its digest and ID match",
  );
  const identity = verifyElfIdentity(buf, expectedId, NS3_LEGACY_IDS);
  push(
    `identity-${label}`,
    identity.verdict === "structural",
    identity.verdict === "structural"
      ? `structural NS-3 identity OK (${identity.detail})`
      : `structural identity FAILED (${identity.verdict}: ${identity.detail})`,
  );
  return checks;
}

/**
 * Run the full provenance gate. Returns { ok, checks } where every element
 * of checks is { id, ok, detail }; ok === true only when ALL checks pass.
 * Either both ELF artifacts (with their expected IDs) or a
 * platformToolsTarball must be supplied — the tarball-only form is what the
 * deployment script uses to hash-verify the toolchain download before
 * seeding the cargo-build-sbf cache.
 */
export function checkProvenance({
  manifestPath = DEFAULT_MANIFEST_PATH,
  scannerSo,
  vaultSo,
  scannerId,
  vaultId,
  platformToolsTarball,
} = {}) {
  const wantElfs = Boolean(scannerSo || vaultSo || scannerId || vaultId);
  if (wantElfs && (!scannerSo || !vaultSo || !scannerId || !vaultId)) {
    throw new Error(
      "checkProvenance requires scannerSo, vaultSo, scannerId AND vaultId together " +
        "(or none of them for a tarball-only check)",
    );
  }
  if (!wantElfs && !platformToolsTarball) {
    throw new Error("checkProvenance requires the ELF artifacts or a platformToolsTarball");
  }
  const manifest = loadProvenanceManifest(manifestPath);
  const relManifest = `scripts/devnet/${path.basename(manifestPath)}`;
  const checks = [];
  const artifacts = wantElfs
    ? [
        { label: "scanner", so: scannerSo, id: scannerId, pin: manifest.programs.grave_scanner },
        { label: "vault", so: vaultSo, id: vaultId, pin: manifest.programs.grave_vault },
      ]
    : [];
  for (const a of artifacts) {
    let buf;
    try {
      buf = readFileSync(a.so);
    } catch (err) {
      checks.push({
        id: `artifact-${a.label}`,
        ok: false,
        detail: `cannot read ${a.so} (${err.code ?? err.message}) — fail-closed: no artifact, no deploy`,
      });
      continue;
    }
    checks.push(
      ...checkElfProvenance(buf, {
        label: a.label,
        manifestPath: relManifest,
        digest: a.pin.sha256,
        expectedId: a.id,
      }),
    );
  }
  if (platformToolsTarball) {
    const pin = manifest.toolchain.platform_tools;
    let actual;
    try {
      actual = sha256File(platformToolsTarball);
    } catch (err) {
      actual = `unreadable: ${err.message}`;
    }
    checks.push({
      id: "platform-tools",
      ok: actual === pin.sha256,
      detail:
        actual === pin.sha256
          ? `platform-tools v${pin.version} tarball sha256 matches the manifest pin`
          : `platform-tools tarball sha256 MISMATCH: got ${actual}, manifest pins ${pin.sha256} ` +
            `(v${pin.version}) — the toolchain that would produce the ELFs is not the pinned one`,
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// --------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const wantElfs = Boolean(
    args["scanner-so"] || args["vault-so"] || args["scanner-id"] || args["vault-id"],
  );
  if (wantElfs) {
    for (const req of ["scanner-so", "vault-so", "scanner-id", "vault-id"]) {
      if (!args[req]) {
        console.error(`missing --${req}`);
        process.exit(2);
      }
    }
  } else if (!args["platform-tools-tarball"]) {
    console.error(
      "nothing to check: pass --scanner-so/--vault-so/--scanner-id/--vault-id " +
        "and/or --platform-tools-tarball",
    );
    process.exit(2);
  }
  let result;
  try {
    result = checkProvenance({
      manifestPath: args.manifest ?? DEFAULT_MANIFEST_PATH,
      scannerSo: args["scanner-so"],
      vaultSo: args["vault-so"],
      scannerId: args["scanner-id"],
      vaultId: args["vault-id"],
      platformToolsTarball: args["platform-tools-tarball"],
    });
  } catch (err) {
    console.error(`REFUSED: ${err.message}`);
    process.exit(2);
  }
  for (const c of result.checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"} [${c.id}] ${c.detail}`);
  }
  if (result.ok) {
    console.log("PROVENANCE OK — the bytes to deploy are exactly the recorded deployment digests.");
    process.exit(0);
  }
  console.error(
    "PROVENANCE FAILED — deployment gate stays CLOSED. " +
      "Do NOT update digests to make this pass; see docs/DEVNET.md (provenance re-pin procedure).",
  );
  process.exit(1);
}

// CLI entry only — the module is also imported by the test suite.
if (process.argv[1] && process.argv[1].endsWith("ns3_check_provenance.mjs")) {
  main();
}
