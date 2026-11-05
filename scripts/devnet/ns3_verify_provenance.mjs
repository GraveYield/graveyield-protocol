// SPDX-License-Identifier: Apache-2.0
//
// ns3_verify_provenance.mjs — fail-closed ELF deployment-provenance gate.
//
// WHY: PR #82 taught CI to prove that the bytes it publishes are the
// approved deployment provenance (structural identity + SHA-256 digests,
// v0 arch, pinned v1.54 platform-tools). The DEPLOY script had no such
// gate: `--skip-build` (and every retry) deployed whatever sat in
// target/deploy/ after only a structural embedded-ID check, and the
// build paths ran no toolchain verification at all. This module closes
// that gap: ONE shared manifest (provenance.manifest.json) is consumed
// by BOTH ci.yml and deploy_devnet.sh, so the approved digests exist in
// exactly one place and every deployment path fails closed against them.
//
// WHAT IT VERIFIES (all must pass; any failure refuses the deployment):
//   1. Manifest integrity — schema, NS-3 generation, devnet chain, SBPF
//      v0 arch record, platform-tools v1.54 record with tarball SHA-256,
//      per-ELF artifact names / base58 program IDs / 64-hex digests, and
//      the program IDs must equal the canonical NS-3 identities
//      (ns3_identities.mjs) — a manifest pointing at other IDs is itself
//      a failure.
//   2. Per-ELF SHA-256 — the actual bytes must hash EXACTLY to the
//      manifest digest. This is the load-bearing check: the approved
//      digests were recorded from the deploy-flow build (plain
//      cargo-build-sbf, arch v0, pinned platform-tools v1.54) of the
//      NS-3 tree and are byte-reproducible for that tree (cargo-build-sbf
//      remaps the workspace cwd prefix; the only other embedded paths are
//      baked into the prebuilt platform-tools rlibs). Any source,
//      dependency, toolchain, or arch change shifts the digest and the
//      gate refuses — a digest is NEVER bumped to make a failing check
//      pass; it changes only after independent review and deliberate
//      re-approval in a reviewed PR.
//   3. Structural ELF identity (R-1) — the NS-3 program ID must occur
//      inside allocated sections and NO legacy NS-1/NS-2 ID bytes may
//      appear anywhere (reuses ns3_verify_elf.mjs verbatim — same
//      acceptance CI and the rehearsals already pin).
//   4. SBPF v0 architecture — e_machine/e_flags must equal the manifest
//      record (v0: 263/0). anchor 1.2.2's default v3 output
//      (247/3) is REFUSED: the deployed arch must match the deploy flow,
//      not anchor's default (DR-001/NS-2).
//   5. Optional platform-tools tarball — when the tarball is available
//      (--platform-tools-tarball / GRAVEYIELD_PLATFORM_TOOLS_TARBALL),
//      it is SHA-256-verified against the manifest record before any
//      build-path use. (deploy_devnet.sh additionally requires the
//      v1.54 platform-tools cache directory to exist on build paths.)
//
// WHAT THIS IS NOT: the digest check proves the bytes are the APPROVED
// bytes; it does not re-derive why they were approved. Post-deployment,
// the definitive on-chain proof is scripts/devnet/verify_ns3_deployment.mjs
// (read-only): it re-hashes the DEPLOYED program bytes from ProgramData
// against this same manifest.
//
// Zero new npm dependencies (node:crypto / node:fs; @solana/web3.js for
// base58 decode via ns3_verify_elf.mjs). CLI:
//   node ns3_verify_provenance.mjs --manifest <p> \
//     --scanner-so <p> --vault-so <p> [--platform-tools-tarball <p>]
// Exit codes: 0 = every check passed; 1 = at least one check failed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyElfIdentity, NS3_LEGACY_IDS } from "./ns3_verify_elf.mjs";
import { NS3 } from "./ns3_identities.mjs";

const MANIFEST_SCHEMA = "graveyield.devnet.provenance/1";
const HEX64 = /^[0-9a-f]{64}$/;

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Read one ELF's fixed header and return the arch evidence. Throws on
 *  structurally impossible headers (caller fails closed). */
export function readElfArch(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) {
    throw new Error(`too small to be an ELF64 (${buf ? buf.length : 0} B)`);
  }
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error("missing ELF magic (0x7f 'E' 'L' 'F')");
  }
  if (buf[4] !== 2 || buf[5] !== 1) {
    throw new Error(`not a 64-bit little-endian ELF (EI_CLASS=${buf[4]} EI_DATA=${buf[5]})`);
  }
  return {
    eMachine: buf.readUInt16LE(18),
    eFlags: buf.readUInt32LE(48),
  };
}

/**
 * Validate the manifest's shape and its NS-3 identity cross-references.
 * Returns { ok, problems: [...] } — never throws.
 */
export function checkManifestSchema(manifest) {
  const problems = [];
  const want = (cond, msg) => {
    if (!cond) problems.push(msg);
  };
  want(!!manifest && typeof manifest === "object", "manifest is not an object");
  if (!manifest || typeof manifest !== "object") return { ok: false, problems };

  want(manifest.schema === MANIFEST_SCHEMA, `schema must be ${MANIFEST_SCHEMA}`);
  want(
    manifest.chain === "devnet",
    `chain must be "devnet" (got ${JSON.stringify(manifest.chain)})`,
  );
  want(
    manifest.generation === "NS-3",
    `generation must be "NS-3" (got ${JSON.stringify(manifest.generation)})`,
  );

  const sbpf = manifest.sbpf;
  want(!!sbpf && typeof sbpf === "object", "sbpf record missing");
  if (sbpf && typeof sbpf === "object") {
    want(sbpf.arch === "v0", `sbpf.arch must be "v0" (got ${JSON.stringify(sbpf.arch)})`);
    want(
      sbpf.eMachine === 263,
      `sbpf.eMachine must be 263 (EM_SBF, v0 target; got ${sbpf.eMachine})`,
    );
    want(sbpf.eFlags === 0, `sbpf.eFlags must be 0 for the v0 target (got ${sbpf.eFlags})`);
  }

  const pt = manifest.platformTools;
  want(!!pt && typeof pt === "object", "platformTools record missing");
  if (pt && typeof pt === "object") {
    want(
      pt.version === "v1.54",
      `platformTools.version must be "v1.54" (got ${JSON.stringify(pt.version)})`,
    );
    want(
      HEX64.test(String(pt.tarballSha256 ?? "")),
      "platformTools.tarballSha256 must be 64 lowercase hex chars",
    );
    want(
      typeof pt.tarballUrl === "string" && pt.tarballUrl.startsWith("https://"),
      "platformTools.tarballUrl must be an https URL",
    );
  }

  want(
    !!manifest.toolchain && manifest.toolchain.solanaCli === "3.0.10",
    "toolchain.solanaCli must be 3.0.10",
  );
  want(
    !!manifest.toolchain && manifest.toolchain.anchorCli === "1.2.2",
    "toolchain.anchorCli must be 1.2.2",
  );

  const elfs = manifest.elfs;
  want(!!elfs && typeof elfs === "object", "elfs record missing");
  if (elfs && typeof elfs === "object") {
    const expected = {
      scanner: { artifact: "grave_scanner.so", programId: NS3.scannerProgramId },
      vault: { artifact: "grave_vault.so", programId: NS3.vaultProgramId },
    };
    for (const slot of ["scanner", "vault"]) {
      const e = elfs[slot];
      want(!!e && typeof e === "object", `elfs.${slot} record missing`);
      if (!e || typeof e !== "object") continue;
      want(
        e.artifact === expected[slot].artifact,
        `elfs.${slot}.artifact must be ${expected[slot].artifact}`,
      );
      want(
        e.programId === expected[slot].programId,
        `elfs.${slot}.programId must equal the canonical NS-3 identity ${expected[slot].programId} (got ${e.programId})`,
      );
      want(
        HEX64.test(String(e.sha256 ?? "")),
        `elfs.${slot}.sha256 must be 64 lowercase hex chars`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Parse + schema-check a manifest from a file path. Throws on unreadable
 *  file or invalid JSON; returns { manifest, schema } where schema.ok is
 *  false with problems listed (caller fails closed). */
export function loadManifest(path) {
  const raw = readFileSync(path, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest ${path} is not valid JSON: ${err.message}`);
  }
  return { manifest, schema: checkManifestSchema(manifest) };
}

/**
 * Verify one ELF buffer against one manifest slot. Pure — never throws,
 * returns structured checks (each { id, ok, detail }):
 *   digest / identity / legacy / arch.
 */
export function verifyElfProvenance(label, buf, entry, sbpf) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id: `${label}:${id}`, ok, detail });

  // 1. SHA-256 digest against the manifest (the load-bearing gate).
  const got = buf ? sha256Hex(buf) : null;
  add(
    "digest",
    !!buf && got === entry.sha256,
    buf ? `sha256 ${got} vs manifest ${entry.sha256}` : "no bytes provided",
  );

  // 2. Structural identity + 3. legacy canary (ns3_verify_elf verdicts).
  let verdict = null;
  let legacyHits = [];
  if (buf) {
    try {
      const r = verifyElfIdentity(buf, entry.programId, NS3_LEGACY_IDS);
      verdict = r.verdict;
      legacyHits = r.legacyHits;
    } catch (err) {
      verdict = `error: ${err.message}`;
    }
  }
  add("identity", verdict === "structural", `structural verdict: ${verdict ?? "not evaluated"}`);
  add(
    "legacy",
    buf ? legacyHits.length === 0 : false,
    legacyHits.length === 0
      ? "no legacy NS-1/NS-2 ID bytes present"
      : `legacy ID bytes present: ${legacyHits.join(", ")}`,
  );

  // 4. SBPF v0 architecture (e_machine/e_flags from the fixed header).
  let arch = null;
  if (buf) {
    try {
      arch = readElfArch(buf);
    } catch (err) {
      arch = { error: err.message };
    }
  }
  const archOk =
    arch && !arch.error && arch.eMachine === sbpf.eMachine && arch.eFlags === sbpf.eFlags;
  add(
    "arch",
    !!archOk,
    arch && !arch.error
      ? `e_machine=${arch.eMachine} e_flags=${arch.eFlags} vs required v0 (${sbpf.eMachine}/${sbpf.eFlags})`
      : `header unreadable: ${arch?.error ?? "no bytes"}`,
  );
  return { label, ok: checks.every((c) => c.ok), checks };
}

/**
 * Full provenance verification over in-memory buffers. Pure (no fs) so
 * the test suite can drive it directly.
 * Returns { ok, manifestProblems, elvis: [per-ELF results], tarball }.
 */
export function verifyProvenanceBuffers({ manifest, scannerBuf, vaultBuf, tarballBuf = null }) {
  const schema = checkManifestSchema(manifest);
  const elfs = schema.ok
    ? [
        verifyElfProvenance("scanner", scannerBuf, manifest.elfs.scanner, manifest.sbpf),
        verifyElfProvenance("vault", vaultBuf, manifest.elfs.vault, manifest.sbpf),
      ]
    : [];
  let tarball = null;
  if (tarballBuf !== null && schema.ok) {
    const got = sha256Hex(tarballBuf);
    tarball = {
      ok: got === manifest.platformTools.tarballSha256,
      detail: `tarball sha256 ${got} vs manifest ${manifest.platformTools.tarballSha256}`,
    };
  }
  return {
    ok: schema.ok && elfs.every((e) => e.ok) && (tarball === null || tarball.ok),
    manifestProblems: schema.problems,
    elfs: elfs,
    tarball,
  };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const manifestPath = args.manifest;
  if (!manifestPath || !args["scanner-so"] || !args["vault-so"]) {
    console.error(
      "usage: ns3_verify_provenance.mjs --manifest <p> --scanner-so <p> --vault-so <p> [--platform-tools-tarball <p>]",
    );
    process.exit(2);
  }

  const fail = (msg) => {
    console.error(`FAIL manifest: ${msg}`);
    process.exit(1);
  };

  let manifest;
  let schema;
  try {
    ({ manifest, schema } = loadManifest(manifestPath));
  } catch (err) {
    fail(err.message);
  }
  if (!schema.ok)
    fail(`manifest failed schema/integrity checks:\n  - ${schema.problems.join("\n  - ")}`);
  console.log(
    `OK manifest ${manifestPath}: schema ${manifest.schema}, generation ${manifest.generation}, ` +
      `sbpf ${manifest.sbpf.arch} (e_machine ${manifest.sbpf.eMachine}/e_flags ${manifest.sbpf.eFlags}), ` +
      `platform-tools ${manifest.platformTools.version} (tarball sha256 pinned)`,
  );

  const tarballBuf = args["platform-tools-tarball"]
    ? readFileSync(args["platform-tools-tarball"])
    : null;
  const result = verifyProvenanceBuffers({
    manifest,
    scannerBuf: readFileSync(args["scanner-so"]),
    vaultBuf: readFileSync(args["vault-so"]),
    tarballBuf,
  });
  if (tarballBuf !== null) {
    if (result.tarball.ok) console.log(`OK platform-tools tarball: ${result.tarball.detail}`);
    else console.error(`FAIL platform-tools tarball: ${result.tarball.detail}`);
  }

  let failed = !result.ok;
  for (const elf of result.elfs) {
    for (const c of elf.checks) {
      if (c.ok) console.log(`OK  ${c.id}: ${c.detail}`);
      else {
        console.error(`FAIL ${c.id}: ${c.detail}`);
        failed = true;
      }
    }
  }
  if (failed) {
    console.error(
      "PROVENANCE GATE REFUSED — the bytes above are NOT the approved NS-3 deployment provenance. " +
        "Nothing may be deployed. If this is a legitimate rebuild (source/dependency/toolchain change), " +
        "the new digests must be independently reviewed and deliberately re-pinned in a reviewed PR — " +
        "never bumped to make a failing check pass.",
    );
    process.exit(1);
  }
  console.log(
    "PROVENANCE VERIFIED — bytes are byte-identical to the approved NS-3 deployment provenance " +
      "(structural identity, no legacy IDs, SBPF v0, manifest digests).",
  );
}

// CLI entry only — the module is also imported by the test suite.
if (process.argv[1] && process.argv[1].endsWith("ns3_verify_provenance.mjs")) {
  main();
}
