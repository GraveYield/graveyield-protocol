// SPDX-License-Identifier: Apache-2.0
//
// verify_ns3_elf_digests.mjs — STRICTLY READ-ONLY deployed-ELF digest
// verification for the NS-3 Devnet deployment (docs/DEVNET.md § Mode 3).
//
// WHAT IT IS: a standalone, reproducible utility that retrieves the ACTUAL
// GraveScanner / GraveVault program bytes deployed on-chain (read-only
// RPC), extracts the real ELF payload from the upgradeable-loader
// ProgramData account, validates its structure and SBPF v0 architecture,
// hashes it, and compares the observed SHA-256 against the approved
// digests pinned in scripts/devnet/provenance.manifest.json (the single
// source of expected digests — never duplicated here).
//
// It is a SIBLING of — not a replacement for — the existing verifiers:
//   * scripts/devnet/verify_ns3_deployment.mjs  — the full deployment
//     acceptance gate (identity, ProgramData structure, authorities,
//     ProtocolConfig, oracles, pause state). It verifies the ARRANGEMENT
//     but does not hash deployed bytes (W2 report §5).
//   * scripts/devnet/ns3_verify_elf.mjs — the PRE-deployment structural
//     identity check of LOCAL build artifacts.
//   * THIS tool — the deployed-bytes digest proof. Deployment acceptance
//     requires BOTH the acceptance verifier and this digest verifier to
//     pass on the same cluster.
//
// WHAT IT WILL NEVER DO (by construction):
//   * no keypair / wallet / signer handling — no signer dependency, no
//     keypair argument, no identity-override flags of any kind (the
//     checked program IDs and the manifest are PINNED repository
//     constants, never options);
//   * no transaction construction, signing, or submission — the ONLY RPC
//     methods used are getGenesisHash, getEpochInfo (context only) and
//     getAccountInfo, all read-only;
//   * no local-ELF substitution — if RPC retrieval fails, the dependent
//     checks are UNVERIFIED (overall INCOMPLETE); a local build artifact
//     is never hashed as a stand-in for deployed bytes;
//   * no initialization of missing accounts — absence is a definitive
//     FAIL, never worked around.
//
// ELF payload extraction methodology (evidence-based, not hard-coded):
//   The ProgramData wire layout is parsed STRUCTURALLY before any offset
//   is chosen, reusing parseProgramDataAccount() from
//   verify_ns3_deployment.mjs (byte layout verified independently on
//   2026-11-05 against the anza-xyz/solana-sdk loader-v3-interface sources
//   AND live on-chain bytes — see that file's header):
//     u32 tag=3 LE + u64 slot + u8 authority-set flag + optional 32 B
//     upgrade authority  →  45 B metadata with an authority (the
//     "packed layout written by current agave", verified byte-for-byte
//     against devnet ProgramData accounts on 2026-10-29 — W1
//     lifecycle_rehearsal/elf_dump.mjs), 13 B metadata with authority
//     = None. The legacy bincode layout (48/16 B, u32 authority tag) is
//     NOT what current agave writes; if ELF magic is absent at the
//     structural boundary but present at the legacy offset, the tool
//     REPORTS that observation and FAILS CLOSED — it never silently
//     shifts the extraction boundary. The full metadata is NEVER hashed.
//
// ELF byte-span methodology (what exactly is hashed):
//   Five different "ELF length" notions exist and only ONE is defensible
//   as the hash boundary:
//     1. the ProgramData PAYLOAD length (account bytes after the loader
//        metadata) — what is on the wire;
//     2. the section-header-table end (e_shoff + e_shnum·e_shentsize) —
//        a common but NOT universal ELF end (valid ELFs may carry section
//        contents beyond it);
//     3. the MAX byte extent the ELF's own structures imply — the SHT
//        end, every non-NOBITS section extent (sh_offset + sh_size), and
//        every program-header extent (p_offset + p_filesz);
//     4. the uploaded .so file length — the span the approved manifest
//        digests were computed over (sha256File over the whole artifact);
//     5. the loader-interpreted span — the whole payload; the loader
//        neither trims nor re-bounds it.
//   Evidence (W1 lifecycle rehearsal, elf_dump.mjs
//   matchOnChainProgramData): the upgradeable loader stores the ELF so it
//   "runs to the EXACT END of the account" — the default deploy writes
//   the uploaded file verbatim after the metadata (verified byte-for-byte
//   against devnet ProgramData accounts, 2026-10-29); zero bytes beyond
//   the ELF can exist only when a larger --max-len was explicitly
//   reserved. THIS TOOL therefore hashes the MAX STRUCTURE-IMPLIED
//   EXTENT (concept 3): every byte the ELF itself declares is inside the
//   digest, so a valid ELF with section contents beyond the section
//   header table is NEVER truncated by a table-position assumption. If
//   the payload is longer than that extent, the excess is beyond
//   anything the ELF declares and must be all-zero loader padding
//   (excluded from the digest); non-zero excess — or any ELF structure
//   implying bytes beyond the payload (truncated account), or a header
//   / section table that cannot be validated — FAILS CLOSED and nothing
//   is hashed. For every well-formed build output the extent equals the
//   file length, so the observed digest is computed over exactly the
//   span the manifest pin was computed over; the approved-digest
//   comparison is never weakened to accommodate synthetic layouts.
//
// VERDICT SEMANTICS — identical to the W2 acceptance verifier (PR #88
// precision corrections):
//   * PASS       — the check ran and the chain matches the approved value.
//   * FAIL       — a definitive mismatch, absent required account,
//                  malformed account, unexpected identity, invalid loader
//                  structure, or digest mismatch. Missing ProgramData is a
//                  FAIL — never a digest match, never a pass. A malformed
//                  account can never produce a PASS.
//   * UNVERIFIED — RPC transport or retrieval failure prevented the
//                  check. An RPC timeout is NOT evidence of an absent
//                  account and must never be misreported as one.
//   * Overall: FAIL takes precedence over INCOMPLETE; INCOMPLETE applies
//     only when no definitive FAIL exists. Exit codes: 0 PASS, 1 FAIL,
//     3 INCOMPLETE, 2 usage error.
//
// GENESIS GATE ORDERING (strict): the pinned Devnet genesis hash is
// established BEFORE any account is fetched. A foreign genesis is a
// deterministic FAIL with NO account checks at all; a FAILED genesis
// request is UNVERIFIED and SHORT-CIRCUITS the whole run (INCOMPLETE,
// exit 3) — on a cluster whose identity could not be established, no
// deployed byte is fetched or interpreted at all (pinned by test via the
// RPC call history, not just the final classification).
//
// structure_valid semantics (the field never contradicts the evidence):
//   null  — no ELF payload was ever assessed (extraction failed or was
//           never reached: absent accounts, malformed loader metadata,
//           RPC-UNVERIFIED paths);
//   false — ELF bytes existed and were assessed, and at least one
//           structural stage FAILED (ELF64 header validation, byte-span
//           establishment from the ELF's own metadata, in-range section
//           table, zero-only tail adjudication, or the SBPF v0
//           architecture requirement);
//   true  — ALL of those structural stages actually ran and passed (the
//           digest stages are content properties, not structure: a
//           digest mismatch on a structurally valid ELF reports
//           digest_match=false with structure_valid=true — "right shape,
//           wrong bytes").
//
// CLI:
//   node scripts/devnet/verify_ns3_elf_digests.mjs --url https://api.devnet.solana.com [--json]
//        [--commitment finalized|confirmed]
//   Commitment defaults to FINALIZED (same acceptance default as the
//   acceptance verifier); "confirmed" is a diagnostic override recorded
//   verbatim in the output context.
import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { NS3, programDataPda } from "./ns3_identities.mjs";
import {
  BPF_LOADER_UPGRADEABLE,
  DEVNET_GENESIS_HASH,
  parseProgramAccount,
  parseProgramDataAccount,
} from "./verify_ns3_deployment.mjs";
import {
  DEFAULT_MANIFEST_PATH,
  REQUIRED_SBPF,
  checkElfProvenance,
  loadProvenanceManifest,
} from "./ns3_check_provenance.mjs";
import { parseElf64Sections, validateSbfElfHeader } from "./ns3_verify_elf.mjs";

export const TOOL_NAME = "verify_ns3_elf_digests";

const PASS = "PASS";
const FAIL = "FAIL";
const UNVERIFIED = "UNVERIFIED";

/**
 * Upgradeable-loader ProgramData metadata lengths (evidence-pinned; see the
 * file header). Exported for tests and cross-checks only — runtime code
 * derives the boundary from the parsed loader state, never from these
 * constants alone.
 */
export const PROGRAMDATA_METADATA_LEN = Object.freeze({ withAuthority: 45, withoutAuthority: 13 });

/** The two verified NS-3 programs, in reporting order. */
const PROGRAM_SPECS = Object.freeze([
  {
    label: "scanner",
    name: "GraveScanner",
    manifestKey: "grave_scanner",
    checkBase: { a: 1, b: 1, c: 1 },
  },
  {
    label: "vault",
    name: "GraveVault",
    manifestKey: "grave_vault",
    checkBase: { a: 6, b: 6, c: 6 },
  },
]);

// ------------------------------------------------------ ELF payload helpers

/**
 * Extract the deployed ELF payload from ProgramData account bytes.
 *
 * The metadata boundary is DERIVED from the parsed loader state (45 B when
 * an upgrade authority is present, 13 B when it is None) — the 45-byte
 * boundary is the repository-verified packed layout, never a blind constant.
 * Throws with a precise message on any structural mismatch; callers fail
 * closed on the throw. The loader metadata (tag, slot, authority) is NEVER
 * part of the returned payload.
 */
export function extractElfPayload(programDataBytes) {
  const buf = Buffer.from(programDataBytes);
  const meta = parseProgramDataAccount(buf); // tag=3 + slot + authority flag (+ authority)
  const metadataLen = meta.authoritySet
    ? PROGRAMDATA_METADATA_LEN.withAuthority
    : PROGRAMDATA_METADATA_LEN.withoutAuthority;
  const payload = buf.subarray(metadataLen);
  if (payload.length === 0) {
    throw new Error(
      `ProgramData carries no bytes after the ${metadataLen} B loader metadata — no ELF payload to hash`,
    );
  }
  if (!(payload[0] === 0x7f && payload[1] === 0x45 && payload[2] === 0x4c && payload[3] === 0x46)) {
    // Fail closed with a precise structural diagnosis. If the ELF magic
    // happens to sit at the LEGACY bincode offset (48/16), say so — as
    // evidence — but refuse to shift the boundary: current agave writes the
    // packed layout, and the repository-verified structure is normative.
    let legacyHint = "";
    const legacyOffset = metadataLen + 3; // u32 authority tag instead of u8
    if (
      buf.length > legacyOffset + 4 &&
      buf[legacyOffset] === 0x7f &&
      buf[legacyOffset + 1] === 0x45 &&
      buf[legacyOffset + 2] === 0x4c &&
      buf[legacyOffset + 3] === 0x46
    ) {
      legacyHint =
        ` (ELF magic found at offset ${legacyOffset} — the LEGACY bincode ProgramData layout with a ` +
        "u32 authority tag. That is NOT the layout current agave writes and NOT the " +
        "repository-verified structure; the extraction boundary is NOT shifted)";
    }
    throw new Error(
      `no ELF magic at the structural payload boundary (offset ${metadataLen} — ` +
        `u32 tag=3 + u64 slot + u8 authority flag${meta.authoritySet ? " + 32 B authority" : ""} ` +
        `= ${metadataLen} B metadata)${legacyHint}`,
    );
  }
  return {
    tag: meta.tag,
    slot: meta.slot,
    authoritySet: meta.authoritySet,
    authority: meta.authority,
    metadataLen,
    payload,
  };
}

/**
 * ELF64 program-header entry size (fixed layout): p_type u32 + p_flags u32
 * + p_offset u64 + p_vaddr u64 + p_paddr u64 + p_filesz u64 + p_memsz u64
 * + p_align u64 = 56 B.
 */
export const ELF64_PHENTSIZE = 56;

/** PN_XNUM: e_phnum escape value — the real count lives in sh_info of SH0. */
const PN_XNUM = 0xffff;

/** SHT_NOBITS — occupies no file bytes; excluded from extent math. */
const SHT_NOBITS = 8;

/**
 * Establish the deployed ELF's byte span from the ELF's OWN structure —
 * never from a section-header-table position assumption.
 *
 * The span is the MAX byte extent implied by every structure the ELF
 * itself declares:
 *   - the section header table end (e_shoff + e_shnum·64, extended
 *     numbering resolved exactly as parseElf64Sections resolves it);
 *   - every non-NOBITS section extent (sh_offset + sh_size);
 *   - every program-header extent (p_offset + p_filesz; PN_XNUM
 *     resolved from sh_info of section header 0).
 *
 * Hashing this span covers EVERY byte the ELF declares — a valid ELF
 * whose section contents (or segments) sit beyond the section header
 * table is hashed in full, never truncated by a table-end assumption.
 * Fail-closed on every structure that makes the span undeterminable,
 * impossible, or beyond the available payload (truncated account): the
 * caller refuses to hash rather than guess.
 *
 * Returns { span, basis, shtEnd, sectionMax, segmentMax,
 * extendedSectionNumbering, extendedProgramHeaderCount } — `basis`
 * names which structure(s) set the maximum (reported verbatim in the
 * JSON output and human-readable report).
 */
export function elfDeclaredSpan(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 64) {
    throw new Error(
      `ELF payload too small (${payload ? payload.length : 0} B; an ELF64 header alone is 64 B)`,
    );
  }
  // Stage: ELF64 header validation (the repository's own SBF validator —
  // magic + class + data encoding + e_machine in the loader-accepted set).
  // A payload that is not a valid 64-bit LSB SBF ELF has no defensible
  // byte span; refuse before reading any extent.
  validateSbfElfHeader(payload);

  const eShoff = Number(payload.readBigUInt64LE(40));
  const eShentsize = payload.readUInt16LE(58);
  if (eShentsize !== 64) {
    throw new Error(
      `unexpected section header entry size ${eShentsize} (ELF64 fixed layout is 64)`,
    );
  }
  if (eShoff === 0) {
    throw new Error(
      "no section header table (e_shoff=0) — the ELF byte span cannot be determined; refusing to hash",
    );
  }

  // Section count: the SAME extended-numbering rule parseElf64Sections
  // applies (real count in sh_size of section header 0 when e_shnum = 0).
  let extendedSectionNumbering = false;
  let shnum = payload.readUInt16LE(60);
  if (shnum === 0) {
    if (payload.length < eShoff + 64) {
      throw new Error(
        `section header table out of range (e_shoff=${eShoff}, extended section count unreadable, file=${payload.length} B)`,
      );
    }
    shnum = Number(payload.readBigUInt64LE(eShoff + 32));
    if (shnum === 0) {
      throw new Error(
        "e_shnum = 0 with a zero extended section count — malformed section table; refusing to hash",
      );
    }
    if (shnum > 0xffff) {
      throw new Error(`extended section count ${shnum} exceeds the ELF64 u16 section-index space`);
    }
    extendedSectionNumbering = true;
  }
  const shtEnd = eShoff + shnum * 64;
  if (!Number.isSafeInteger(shtEnd)) {
    throw new Error(
      `impossible section header table end ${shtEnd} (e_shoff=${eShoff}, e_shnum=${shnum})`,
    );
  }
  if (shtEnd > payload.length) {
    throw new Error(
      `section header table out of range (ends at ${shtEnd}, payload=${payload.length} B) — truncated payload`,
    );
  }

  // Section extents — from the SAME parse the structural-identity gate
  // uses (parseElf64Sections re-validates the header, the extended
  // numbering, the table range, the string table, and every section's
  // range against THIS payload; any throw fails closed here).
  const sections = parseElf64Sections(payload);
  let sectionMax = 0;
  for (const s of sections) {
    if (s.type === SHT_NOBITS) continue; // occupies no file bytes
    const end = s.offset + s.size;
    if (!Number.isSafeInteger(end) || end > payload.length) {
      throw new Error(
        `section "${s.name}" (offset ${s.offset} + size ${s.size}) extends beyond the payload ` +
          `(${payload.length} B) — truncated payload`,
      );
    }
    sectionMax = Math.max(sectionMax, end);
  }

  // Program-header extents (fixed ELF64 layout, 56 B entries).
  let extendedProgramHeaderCount = false;
  let ePhnum = payload.readUInt16LE(56);
  if (ePhnum === PN_XNUM) {
    if (payload.length < eShoff + 48) {
      throw new Error(
        `section header table out of range (e_shoff=${eShoff}, PN_XNUM program count unreadable, file=${payload.length} B)`,
      );
    }
    ePhnum = payload.readUInt32LE(eShoff + 44); // sh_info of section header 0
    extendedProgramHeaderCount = true;
  }
  let segmentMax = 0;
  if (ePhnum > 0) {
    const ePhoff = Number(payload.readBigUInt64LE(32));
    const ePhentsize = payload.readUInt16LE(54);
    if (ePhentsize !== ELF64_PHENTSIZE) {
      throw new Error(
        `unexpected program header entry size ${ePhentsize} (ELF64 fixed layout is ${ELF64_PHENTSIZE})`,
      );
    }
    if (ePhoff === 0) {
      throw new Error(
        `e_phnum=${ePhnum} but e_phoff=0 — inconsistent program header table; refusing to hash`,
      );
    }
    const phEnd = ePhoff + ePhnum * ELF64_PHENTSIZE;
    if (!Number.isSafeInteger(phEnd) || phEnd > payload.length) {
      throw new Error(
        `program header table out of range (ends at ${phEnd}, payload=${payload.length} B) — truncated payload`,
      );
    }
    for (let i = 0; i < ePhnum; i++) {
      const base = ePhoff + i * ELF64_PHENTSIZE;
      const pOffset = Number(payload.readBigUInt64LE(base + 8));
      const pFilesz = Number(payload.readBigUInt64LE(base + 32));
      const end = pOffset + pFilesz;
      if (!Number.isSafeInteger(end) || end > payload.length) {
        throw new Error(
          `program header ${i} (p_offset ${pOffset} + p_filesz ${pFilesz}) extends beyond the payload ` +
            `(${payload.length} B) — truncated payload`,
        );
      }
      segmentMax = Math.max(segmentMax, end);
    }
  }

  const span = Math.max(shtEnd, sectionMax, segmentMax, 64);
  if (span > payload.length) {
    throw new Error(
      `ELF structure-implied span ${span} B exceeds the available payload ${payload.length} B — truncated payload`,
    );
  }
  const parts = [];
  if (span === shtEnd) {
    parts.push(
      extendedSectionNumbering
        ? "section header table end (extended numbering)"
        : "section header table end",
    );
  }
  if (span === sectionMax && sectionMax > 0) parts.push("section extents");
  if (span === segmentMax && segmentMax > 0) parts.push("program header extents");
  return {
    span,
    basis: parts.length > 0 ? parts.join(" + ") : "ELF header only (64 B)",
    shtEnd,
    sectionMax,
    segmentMax,
    extendedSectionNumbering,
    extendedProgramHeaderCount,
  };
}

/** SHA-256 hex of exactly the bytes passed in — no more, no less. */
export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ------------------------------------------------------------------ core

/** The always-complete per-program report shape (JSON consistency). */
function initialProgramReport(spec, approvedDigest) {
  const programId = new PublicKey(NS3[`${spec.label}ProgramId`]);
  return {
    name: spec.name,
    label: spec.label,
    program_id: programId.toBase58(),
    program_account: { exists: null, executable: null, owner: null, data_len: null },
    programdata_embedded_address: null,
    programdata_derived_address: programDataPda(programId).toBase58(),
    pointer_match: null,
    programdata: {
      exists: null,
      owner: null,
      data_len: null,
      state_valid: null,
      slot: null,
      upgrade_authority: { present: null, address: null, status: "UNVERIFIED" },
    },
    elf: {
      extraction: "UNVERIFIED",
      payload_offset: null,
      payload_size: null,
      declared_elf_size: null,
      span_basis: null,
      trailing_padding_bytes: null,
      structure_valid: null,
      sbpf_arch: null,
      sbpf_valid: null,
      identity_verdict: null,
      observed_sha256: null,
      expected_sha256: approvedDigest,
      digest_match: null,
    },
  };
}

function manifestSummary(manifest, display) {
  return {
    path: display,
    schema: manifest.schema,
    sbpf_required: { ...REQUIRED_SBPF },
    digests: {
      grave_scanner: manifest.programs.grave_scanner.sha256,
      grave_vault: manifest.programs.grave_vault.sha256,
    },
  };
}

/**
 * Run the full read-only deployed-ELF digest verification. Never throws for
 * on-chain or RPC conditions (usage mistakes still throw). Returns
 * { checks, overall, counts, context, identities, manifest, programs }.
 *
 * `manifestPath`/`manifestLabel` are FUNCTION options for offline tests
 * ONLY — the CLI exposes no manifest flag and always verifies against the
 * committed scripts/devnet/provenance.manifest.json.
 */
export async function runElfDigestVerification(options = {}) {
  const {
    url,
    commitment = "finalized",
    manifestPath = DEFAULT_MANIFEST_PATH,
    manifestLabel,
  } = options;
  if (!url) throw new Error("runElfDigestVerification requires an explicit RPC url");
  if (commitment !== "finalized" && commitment !== "confirmed") {
    throw new Error("commitment must be 'finalized' (default) or 'confirmed' (diagnostic)");
  }
  // No override surface: reject every option that could redirect the tool
  // at a different program ID, manifest, or key source.
  for (const k of [
    "scannerProgramId",
    "vaultProgramId",
    "manifestOverride",
    "keypair",
    "deployer",
    "governance",
  ]) {
    if (k in options) {
      throw new Error(
        `runElfDigestVerification does not accept '${k}': verified identities and the ` +
          "provenance manifest are PINNED repository constants, not options",
      );
    }
  }

  // The approved provenance manifest — the single source of expected digests.
  // Structural validation (schema, hex64, SBPF v0 invariant) is the
  // repository's own loadProvenanceManifest; a malformed manifest aborts
  // before any RPC.
  const manifest = loadProvenanceManifest(manifestPath);
  const manifestDisplay = manifestLabel ?? "scripts/devnet/provenance.manifest.json";

  const identities = {
    deployer: { value: NS3.deployer, source: "pinned" },
    loader: { value: BPF_LOADER_UPGRADEABLE, source: "pinned" },
  };
  const deployerPk = new PublicKey(NS3.deployer);
  const loaderPk = new PublicKey(BPF_LOADER_UPGRADEABLE);

  const connection = new Connection(url, commitment);

  // Per-program report objects — built up front so the JSON shape is
  // identical regardless of where verification stops.
  const reports = new Map(
    PROGRAM_SPECS.map((spec) => [
      spec.label,
      {
        spec,
        report: initialProgramReport(spec, manifest.programs[spec.manifestKey].sha256),
      },
    ]),
  );

  // ---- context (read-only; a context failure demotes nothing by itself)
  let context;
  try {
    const epochInfo = await connection.getEpochInfo();
    context = { slot: epochInfo.absoluteSlot, epoch: epochInfo.epoch, commitment };
  } catch {
    context = { slot: null, epoch: null, commitment, error: "getEpochInfo failed (RPC transport)" };
  }

  // ---- genesis gate: establish WHICH cluster this is before any deployed
  // bytes are interpreted (same cluster-identity rule as the acceptance
  // verifier — a foreign cluster is not a misconfigured deployment).
  let genesisHash = null;
  try {
    genesisHash = await connection.getGenesisHash();
  } catch (err) {
    context.genesisError = `getGenesisHash failed (RPC transport): ${err.message ?? err}`;
  }
  context.genesisHash = genesisHash;

  const checks = [];
  const add = (section, id, title, status, detail) =>
    checks.push({ section, id, title, status, detail });

  const countsNow = () => ({
    pass: checks.filter((c) => c.status === PASS).length,
    fail: checks.filter((c) => c.status === FAIL).length,
    unverified: checks.filter((c) => c.status === UNVERIFIED).length,
    info: checks.filter((c) => c.status === "INFO").length,
  });

  // -------------------------------------------- SECTION G — cluster identity
  if (genesisHash === null) {
    add(
      "G",
      "G1 devnet",
      "RPC endpoint reports the pinned Solana Devnet genesis hash",
      UNVERIFIED,
      `${context.genesisError ?? "getGenesisHash failed"} — cluster identity could NOT be established ` +
        `(pinned Devnet genesis: ${DEVNET_GENESIS_HASH}); the digest verdict is blocked (INCOMPLETE) ` +
        "until the endpoint reports it",
    );
    // SHORT-CIRCUIT: on a cluster whose identity could not be established,
    // NO account is fetched and NO deployed byte is interpreted. The
    // overall verdict is INCOMPLETE (UNVERIFIED with zero FAILs) and the
    // exit code is 3. Tests pin this via the RPC call history — after a
    // failed getGenesisHash the endpoint receives no getAccountInfo call.
    return {
      checks,
      overall: "INCOMPLETE",
      counts: countsNow(),
      context,
      identities,
      manifest: manifestSummary(manifest, manifestDisplay),
      programs: [...reports.values()].map((r) => r.report),
    };
  } else if (genesisHash !== DEVNET_GENESIS_HASH) {
    add(
      "G",
      "G1 devnet",
      "RPC endpoint reports the pinned Solana Devnet genesis hash",
      FAIL,
      `endpoint genesis ${genesisHash} != pinned Devnet ${DEVNET_GENESIS_HASH} — this is NOT the ` +
        "approved cluster. No deployed bytes are interpreted on a foreign cluster; point --url at " +
        "Solana Devnet (https://api.devnet.solana.com) and re-run",
    );
    return {
      checks,
      overall: "FAIL",
      counts: countsNow(),
      context,
      identities,
      manifest: manifestSummary(manifest, manifestDisplay),
      programs: [...reports.values()].map((r) => r.report),
    };
  } else {
    add(
      "G",
      "G1 devnet",
      "RPC endpoint reports the pinned Solana Devnet genesis hash",
      PASS,
      `genesis ${genesisHash} matches the pinned Devnet identity`,
    );
  }

  // Cached, never-throwing account fetcher (house pattern).
  const cache = new Map();
  async function fetchAccount(addressPubkey) {
    const key = addressPubkey.toBase58();
    if (cache.has(key)) return cache.get(key);
    let entry;
    try {
      const info = await connection.getAccountInfo(addressPubkey);
      entry = { ok: true, info: info ?? null };
    } catch (err) {
      entry = { ok: false, err };
    }
    cache.set(key, entry);
    return entry;
  }

  for (const { spec, report } of reports.values()) {
    await verifyProgram({
      spec,
      report,
      fetchAccount,
      manifest,
      manifestDisplay,
      add,
      deployerPk,
      loaderPk,
    });
  }

  const counts = countsNow();
  const overall = counts.fail > 0 ? "FAIL" : counts.unverified > 0 ? "INCOMPLETE" : "PASS";
  return {
    checks,
    overall,
    counts,
    context,
    identities,
    manifest: manifestSummary(manifest, manifestDisplay),
    programs: [...reports.values()].map((r) => r.report),
  };
}

/**
 * Verify one program end-to-end (program account → ProgramData → ELF →
 * digest). Every branch records checks; a missing account or malformed
 * structure cascades FAIL into the dependent checks (W2 PR #88 semantics),
 * an RPC failure cascades UNVERIFIED, and a digest is only ever reported
 * when the real retrieved payload was validated and hashed.
 */
async function verifyProgram({
  spec,
  report,
  fetchAccount,
  manifest,
  manifestDisplay,
  add,
  deployerPk,
  loaderPk,
}) {
  const { label, manifestKey, checkBase } = spec;
  const programId = new PublicKey(NS3[`${label}ProgramId`]);
  const programAddr = programId.toBase58();
  const derivedPd = programDataPda(programId);
  const derivedPdB58 = derivedPd.toBase58();
  const approvedDigest = manifest.programs[manifestKey].sha256;

  const aId = (n) => `A${checkBase.a + n} ${label}`;
  const bId = (n) => `B${checkBase.b + n} ${label}`;
  const cId = (n) => `C${checkBase.c + n} ${label}`;

  const A = {
    exists: "program account exists",
    owner: "program account owner is the BPF upgradeable loader",
    exec: "program account is executable",
    pointer: "embedded ProgramData pointer equals the independently derived loader PDA",
  };
  const B = {
    exists: "ProgramData account exists (fetched at the embedded pointer address)",
    owner: "ProgramData account owner is the BPF upgradeable loader",
    state: "ProgramData loader state decodes (tag 3, slot, upgrade-authority metadata)",
    authority: `upgrade authority (real ProgramData) is the deployer ${NS3.deployer}`,
  };
  const C = {
    extract: "ELF payload extracted at the structural metadata boundary",
    span: "ELF byte span established from the ELF's own structure (header, section table, sections, program headers); tail is zero padding only",
    digest: "observed SHA-256 equals the approved provenance manifest digest",
    arch: `SBPF v0 architecture (e_machine ${REQUIRED_SBPF.e_machine} / e_flags ${REQUIRED_SBPF.e_flags})`,
    identity: "structural NS-3 identity (embedded ID in allocated sections; no legacy IDs)",
  };

  /** Add the same status/detail to a list of [section, id, title] triples. */
  const markAll = (triples, status, detail) => {
    for (const [section, id, title] of triples) add(section, id, title, status, detail);
  };
  const triples = (ids, titles) => ids.map((id, i) => [id[0], id, titles[i]]);
  const depIds = [
    aId(0),
    aId(1),
    aId(2),
    aId(3),
    bId(0),
    bId(1),
    bId(2),
    bId(3),
    cId(0),
    cId(1),
    cId(2),
    cId(3),
    cId(4),
  ];
  const depTitles = [
    A.exists,
    A.owner,
    A.exec,
    A.pointer,
    B.exists,
    B.owner,
    B.state,
    B.authority,
    C.extract,
    C.span,
    C.digest,
    C.arch,
    C.identity,
  ];

  // ---------------- program account
  const progRes = await fetchAccount(programId);
  if (!progRes.ok) {
    markAll(
      triples(depIds, depTitles),
      UNVERIFIED,
      `not verified — RPC failure: ${progRes.err.message ?? progRes.err}`,
    );
    return;
  }

  const progInfo = progRes.info;
  if (!progInfo) {
    report.program_account.exists = false;
    report.elf.extraction = "NOT_ATTEMPTED";
    add(
      "A",
      aId(0),
      A.exists,
      FAIL,
      `no account exists at ${programAddr} — the NS-3 ${label} program is NOT deployed on this cluster`,
    );
    markAll(
      triples(depIds.slice(1), depTitles.slice(1)),
      FAIL,
      "cannot verify — program account absent (a missing account is definitive, not a transport failure)",
    );
    return;
  }

  report.program_account.exists = true;
  report.program_account.owner = progInfo.owner.toBase58();
  report.program_account.executable = Boolean(progInfo.executable);
  report.program_account.data_len = progInfo.data.length;
  add(
    "A",
    aId(0),
    A.exists,
    PASS,
    `${programAddr} — owner ${progInfo.owner.toBase58()}, executable=${progInfo.executable}, ${progInfo.data.length} B data`,
  );

  if (!progInfo.owner.equals(loaderPk)) {
    report.elf.extraction = "NOT_ATTEMPTED";
    add(
      "A",
      aId(1),
      A.owner,
      FAIL,
      `owner is ${progInfo.owner.toBase58()}, expected ${BPF_LOADER_UPGRADEABLE}`,
    );
    markAll(
      triples(depIds.slice(2), depTitles.slice(2)),
      FAIL,
      "cannot verify — program account owner is not the BPF upgradeable loader",
    );
    return;
  }
  add("A", aId(1), A.owner, PASS, progInfo.owner.toBase58());

  if (!progInfo.executable) {
    report.elf.extraction = "NOT_ATTEMPTED";
    add("A", aId(2), A.exec, FAIL, "executable=false — the loader would refuse to invoke it");
    markAll(
      triples(depIds.slice(3), depTitles.slice(3)),
      FAIL,
      "cannot verify — program account is not executable",
    );
    return;
  }
  add("A", aId(2), A.exec, PASS, "executable=true");

  let embeddedPd = null;
  try {
    embeddedPd = parseProgramAccount(progInfo.data).programdata;
  } catch (err) {
    report.elf.extraction = "NOT_ATTEMPTED";
    add("A", aId(3), A.pointer, FAIL, `malformed program account data: ${err.message}`);
    markAll(
      triples(depIds.slice(4), depTitles.slice(4)),
      FAIL,
      "cannot verify — program account data malformed",
    );
    return;
  }
  report.programdata_embedded_address = embeddedPd.toBase58();
  report.pointer_match = embeddedPd.equals(derivedPd);
  if (!report.pointer_match) {
    report.elf.extraction = "NOT_ATTEMPTED";
    add(
      "A",
      aId(3),
      A.pointer,
      FAIL,
      `ProgramData pointer ${embeddedPd.toBase58()} is NOT the loader-derived ProgramData address of ` +
        `${programAddr} (expected ${derivedPdB58} = PDA([program_id], BPFLoaderUpgradeable)) — ` +
        "the approved deployment arrangement always yields the derived address; a foreign pointer is refused",
    );
    markAll(
      triples(depIds.slice(4), depTitles.slice(4)),
      FAIL,
      "cannot trust bytes reached through a non-derived ProgramData pointer",
    );
    return;
  }
  add(
    "A",
    aId(3),
    A.pointer,
    PASS,
    `program account -> ProgramData ${embeddedPd.toBase58()} (== independently derived loader PDA)`,
  );

  // ---------------- ProgramData account (fetched at the EMBEDDED pointer,
  // which is proven above to equal the derived address)
  const pdRes = await fetchAccount(embeddedPd);
  if (!pdRes.ok) {
    report.elf.extraction = "UNVERIFIED";
    markAll(
      triples(depIds.slice(4), depTitles.slice(4)),
      UNVERIFIED,
      `not verified — RPC failure: ${pdRes.err.message ?? pdRes.err}`,
    );
    return;
  }

  const pdInfo = pdRes.info;
  if (!pdInfo) {
    report.programdata.exists = false;
    report.elf.extraction = "NOT_ATTEMPTED";
    add(
      "B",
      bId(0),
      B.exists,
      FAIL,
      `the program account points at ProgramData ${embeddedPd.toBase58()}, which does NOT exist on this cluster`,
    );
    markAll(
      triples(depIds.slice(5), depTitles.slice(5)),
      FAIL,
      "cannot verify — ProgramData account absent (deriving its address does not establish existence; " +
        "missing ProgramData is a FAIL, never a digest match)",
    );
    return;
  }

  report.programdata.exists = true;
  report.programdata.owner = pdInfo.owner.toBase58();
  report.programdata.data_len = pdInfo.data.length;
  add(
    "B",
    bId(0),
    B.exists,
    PASS,
    `${embeddedPd.toBase58()} — owner ${pdInfo.owner.toBase58()}, ${pdInfo.data.length} B data`,
  );

  if (!pdInfo.owner.equals(loaderPk)) {
    report.elf.extraction = "NOT_ATTEMPTED";
    add(
      "B",
      bId(1),
      B.owner,
      FAIL,
      `owner is ${pdInfo.owner.toBase58()}, expected ${BPF_LOADER_UPGRADEABLE}`,
    );
    markAll(
      triples(depIds.slice(6), depTitles.slice(6)),
      FAIL,
      "cannot verify — ProgramData owner is not the loader",
    );
    return;
  }
  add("B", bId(1), B.owner, PASS, pdInfo.owner.toBase58());

  let extracted = null;
  try {
    extracted = extractElfPayload(pdInfo.data);
  } catch (err) {
    report.programdata.state_valid = false;
    report.programdata.upgrade_authority.status = "MALFORMED";
    report.elf.extraction = "FAILED";
    add(
      "B",
      bId(2),
      B.state,
      FAIL,
      `malformed ProgramData (${embeddedPd.toBase58()}): ${err.message}`,
    );
    add(
      "B",
      bId(3),
      B.authority,
      FAIL,
      "cannot read the upgrade authority — ProgramData metadata malformed",
    );
    add("C", cId(0), C.extract, FAIL, err.message);
    markAll(
      triples(depIds.slice(9), depTitles.slice(9)),
      FAIL,
      "cannot verify — ELF payload could not be extracted from the ProgramData bytes",
    );
    return;
  }

  report.programdata.state_valid = true;
  report.programdata.slot = extracted.slot;
  report.programdata.upgrade_authority.present = extracted.authoritySet;
  report.programdata.upgrade_authority.address = extracted.authority
    ? extracted.authority.toBase58()
    : null;
  report.elf.payload_offset = extracted.metadataLen;
  report.elf.payload_size = extracted.payload.length;
  add(
    "B",
    bId(2),
    B.state,
    PASS,
    `tag 3, slot ${extracted.slot}, authority ${extracted.authoritySet ? "present" : "None"} — ` +
      `${extracted.metadataLen} B metadata, payload starts at offset ${extracted.metadataLen}`,
  );

  // Upgrade authority — the pinned deployment acceptance rule (the deployer
  // is the initial and current upgrade authority). Absent / mismatched
  // authorities are reported as DISTINCT conditions and FAIL; extraction
  // and digest work continues regardless (more evidence, never a weakened
  // check).
  if (!extracted.authoritySet) {
    report.programdata.upgrade_authority.status = "ABSENT";
    add(
      "B",
      bId(3),
      B.authority,
      FAIL,
      `ProgramData ${embeddedPd.toBase58()} has NO upgrade authority (renounced/None) — the program can never be upgraded`,
    );
  } else if (extracted.authority.equals(deployerPk)) {
    report.programdata.upgrade_authority.status = "MATCH";
    add(
      "B",
      bId(3),
      B.authority,
      PASS,
      `ProgramData ${embeddedPd.toBase58()} upgrade authority = ${extracted.authority.toBase58()}`,
    );
  } else {
    report.programdata.upgrade_authority.status = "MISMATCH";
    add(
      "B",
      bId(3),
      B.authority,
      FAIL,
      `ProgramData ${embeddedPd.toBase58()} upgrade authority is ${extracted.authority.toBase58()}, ` +
        `expected ${NS3.deployer}`,
    );
  }

  // ---------------- ELF payload: extraction proven, span + digest next
  add(
    "C",
    cId(0),
    C.extract,
    PASS,
    `ELF magic at structural offset ${extracted.metadataLen}; ${extracted.payload.length} B payload after ` +
      `${extracted.metadataLen} B loader metadata`,
  );
  report.elf.extraction = "OK";

  let spanInfo = null;
  let spanEstablished = false;
  try {
    spanInfo = elfDeclaredSpan(extracted.payload);
  } catch (err) {
    // The ELF bytes existed and were structurally assessed — the header /
    // section-table / span stage FAILED. structure_valid is FALSE (never
    // null: the payload was assessable; never true: a structural stage
    // failed). Nothing is hashed.
    report.elf.structure_valid = false;
    add("C", cId(1), C.span, FAIL, err.message);
    markAll(
      triples(depIds.slice(10), depTitles.slice(10)),
      FAIL,
      "cannot verify — the ELF byte span could not be established from the ELF's own structure; refusing to hash",
    );
    return;
  }
  report.elf.declared_elf_size = spanInfo.span;
  report.elf.span_basis = spanInfo.basis;
  if (spanInfo.span === extracted.payload.length) {
    spanEstablished = true;
    report.elf.trailing_padding_bytes = 0;
    add(
      "C",
      cId(1),
      C.span,
      PASS,
      `ELF byte span ${spanInfo.span} B == payload ${extracted.payload.length} B (exact fit — the layout ` +
        `current agave writes; span basis: ${spanInfo.basis})`,
    );
  } else {
    let paddingOk = true;
    for (let i = spanInfo.span; i < extracted.payload.length; i++) {
      if (extracted.payload[i] !== 0) {
        paddingOk = false;
        break;
      }
    }
    report.elf.trailing_padding_bytes = extracted.payload.length - spanInfo.span;
    if (!paddingOk) {
      // Bytes beyond everything the ELF declares are NOT zero — they are
      // neither ELF content nor loader padding. A structural stage failed:
      // structure_valid=false, refuse to hash.
      report.elf.structure_valid = false;
      add(
        "C",
        cId(1),
        C.span,
        FAIL,
        `ELF byte span ${spanInfo.span} B < payload ${extracted.payload.length} B and bytes beyond the ` +
          "declared ELF end are NOT all zero — unexpected data after the ELF; refusing to hash",
      );
      markAll(
        triples(depIds.slice(10), depTitles.slice(10)),
        FAIL,
        "cannot verify — unexpected non-zero bytes beyond the declared ELF end",
      );
      return;
    }
    spanEstablished = true;
    add(
      "C",
      cId(1),
      C.span,
      PASS,
      `ELF byte span ${spanInfo.span} B + ${extracted.payload.length - spanInfo.span} B zero loader padding ` +
        `(padding excluded from the digest; span basis: ${spanInfo.basis})`,
    );
  }

  // Hash EXACTLY the established ELF span of the RPC-retrieved bytes and run
  // the repository's own provenance gate (digest pin + SBPF v0 arch +
  // structural NS-3 identity + legacy canary) over those same bytes.
  const elfBytes = extracted.payload.subarray(0, spanInfo.span);
  const provenance = checkElfProvenance(elfBytes, {
    label,
    manifestPath: manifestDisplay,
    digest: approvedDigest,
    expectedId: programAddr,
  });
  const [digestCheck, archCheck, identityCheck] = provenance;

  report.elf.observed_sha256 = sha256Hex(elfBytes);
  report.elf.digest_match = digestCheck.ok === true;

  report.elf.sbpf_arch = `${REQUIRED_SBPF.arch} (e_machine ${REQUIRED_SBPF.e_machine} / e_flags ${REQUIRED_SBPF.e_flags})`;
  report.elf.sbpf_valid = archCheck.ok === true;
  report.elf.identity_verdict = identityCheck.ok ? "structural" : identityCheck.detail;

  // structure_valid — the structural stages that ACTUALLY ran and passed
  // (see the file header): payload extraction, ELF64 header validation,
  // byte-span establishment from the ELF's own metadata (which subsumes
  // the in-range section-table validation — elfDeclaredSpan derives the
  // span THROUGH parseElf64Sections), the zero-only tail adjudication,
  // and the SBPF v0 architecture. Digest stages are content, not
  // structure: digest_match=false with structure_valid=true is the
  // meaningful "right shape, wrong bytes" outcome, not a contradiction.
  // A regression test asserts these invariants on every evidence path.
  report.elf.structure_valid =
    report.elf.extraction === "OK" && spanEstablished && report.elf.sbpf_valid === true;

  add(
    "C",
    cId(2),
    C.digest,
    digestCheck.ok ? PASS : FAIL,
    digestCheck.ok
      ? `observed sha256 ${report.elf.observed_sha256} == approved pin (${manifestDisplay})`
      : digestCheck.detail,
  );

  add("C", cId(3), C.arch, archCheck.ok ? PASS : FAIL, archCheck.detail);

  add("C", cId(4), C.identity, identityCheck.ok ? PASS : FAIL, identityCheck.detail);
}

// ---------------------------------------------------------------- reporting

function renderTerminal(result) {
  const lines = [];
  const { checks, overall, counts, context, identities, manifest, programs } = result;
  lines.push("=== NS-3 deployed-ELF digest verification — STRICTLY READ-ONLY ===");
  lines.push(
    `overall: ${overall} (pass ${counts.pass} / fail ${counts.fail} / unverified ${counts.unverified} / info ${counts.info})`,
  );
  lines.push(
    `context: slot ${context.slot ?? "unknown"} epoch ${context.epoch ?? "unknown"} commitment ${context.commitment}${context.error ? ` (${context.error})` : ""}`,
  );
  lines.push(
    `cluster: genesis ${context.genesisHash ?? "unknown"}${context.genesisError ? ` (${context.genesisError})` : ""} — pinned Devnet ${DEVNET_GENESIS_HASH}`,
  );
  lines.push(
    `manifest: ${manifest.path} — schema ${manifest.schema}, SBPF ${manifest.sbpf_required.arch} ` +
      `(e_machine ${manifest.sbpf_required.e_machine} / e_flags ${manifest.sbpf_required.e_flags})`,
  );
  lines.push(
    `identities: deployer ${identities.deployer.value} [${identities.deployer.source}], upgradeable loader ${identities.loader.value} [${identities.loader.source}]`,
  );
  const sectionTitles = {
    G: "Section G — cluster identity (pinned Solana Devnet genesis hash; runs before any deployed bytes are interpreted)",
  };
  for (const p of programs) {
    sectionTitles[`A ${p.label}`] = `Section A ${p.name} — program account & ProgramData pointer`;
    sectionTitles[`B ${p.label}`] = `Section B ${p.name} — ProgramData state & upgrade authority`;
    sectionTitles[`C ${p.label}`] =
      `Section C ${p.name} — deployed ELF payload, SBPF v0 architecture & digest provenance`;
  }
  const keyOf = (c) => (c.section === "G" ? "G" : `${c.section} ${c.id.split(" ")[1]}`);
  let current = "";
  for (const c of checks) {
    const k = keyOf(c);
    if (k !== current) {
      current = k;
      lines.push("", sectionTitles[k] ?? k);
    }
    lines.push(`  ${c.status.padEnd(10)} [${c.id}] ${c.title}`);
    lines.push(`             ${c.detail}`);
  }
  lines.push("", `OVERALL RESULT: ${overall}`);
  if (overall === "FAIL") {
    lines.push(
      "  The deployed bytes or the deployment arrangement do not match the approved provenance. Do not",
      "  treat the deployment as digest-verified; investigate every FAIL above. Missing accounts are",
      "  definitive FAILs — never initialize them during verification.",
    );
  }
  if (overall === "INCOMPLETE") {
    lines.push(
      "  One or more checks could not be verified (RPC failure). This is NOT evidence that the deployed",
      "  bytes are wrong — but it blocks the digest verdict: re-run against a healthy RPC. A local ELF",
      "  is never substituted for the unretrieved deployed bytes.",
    );
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) {
        out[k] = v;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out[k] = next;
          i++;
        } else {
          out[k] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usageError(message) {
  console.error(`usage error: ${message}`);
  console.error(
    "usage: node scripts/devnet/verify_ns3_elf_digests.mjs --url <RPC_URL> [--json] [--commitment finalized|confirmed]\n" +
      "  --commitment defaults to FINALIZED; 'confirmed' is a diagnostic override for a just-submitted deploy.\n" +
      "  There are NO identity, program-ID, keypair, or manifest flags: the verified programs and the\n" +
      "  approved digests are the PINNED repository constants (ns3_identities.mjs + provenance.manifest.json).\n" +
      "  Read-only by construction: getGenesisHash / getEpochInfo / getAccountInfo only.",
  );
  process.exit(2);
}

/** Flags that must never be accepted (no overrides, no key material). */
const FORBIDDEN_FLAGS = [
  "manifest",
  "manifest-path",
  "scanner-id",
  "vault-id",
  "scanner-so",
  "vault-so",
  "program-id",
  "scanner",
  "vault",
  "deployer",
  "governance",
  "keypair",
  "signer",
];

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) usageError("--url is REQUIRED (this tool never assumes a cluster)");
  for (const f of FORBIDDEN_FLAGS) {
    if (args[f] !== undefined) {
      usageError(
        `--${f} is not accepted: the verified programs, identities, and approved digests are PINNED ` +
          "repository constants (ns3_identities.mjs + provenance.manifest.json) — no overrides exist.",
      );
    }
  }
  if (args.commitment !== undefined && !["finalized", "confirmed"].includes(args.commitment)) {
    usageError("--commitment must be 'finalized' (default) or 'confirmed' (diagnostic)");
  }
  const result = await runElfDigestVerification({
    url: args.url,
    commitment: args.commitment ?? "finalized",
  });
  if (args.json) {
    console.log(
      JSON.stringify(
        { tool: TOOL_NAME, read_only: true, url: args.url, ...result },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
      ),
    );
  } else {
    console.log(renderTerminal(result));
  }
  process.exit(result.overall === "PASS" ? 0 : result.overall === "FAIL" ? 1 : 3);
}

// CLI entry only — the module is also imported by the test suite.
if (process.argv[1] && process.argv[1].endsWith("verify_ns3_elf_digests.mjs")) {
  main().catch((err) => {
    console.error(`fatal: ${err.message ?? err}`);
    process.exit(2);
  });
}
