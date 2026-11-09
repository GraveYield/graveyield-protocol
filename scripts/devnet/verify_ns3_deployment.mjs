// SPDX-License-Identifier: Apache-2.0
//
// verify_ns3_deployment.mjs — STRICTLY READ-ONLY NS-3 post-deployment
// acceptance verifier (DR-002; docs/DEVNET.md § acceptance).
//
// WHAT IT IS: an independent on-chain acceptance gate for the NS-3 devnet
// deployment. It talks to a cluster ONLY through read-only RPC
// (getAccountInfo / getEpochInfo / getGenesisHash) and verifies that what
// is actually live
// at the NS-3 addresses matches the approved arrangement:
//
//   A. Program accounts & ProgramData — both programs exist, are
//      executable, are owned by the BPF upgradeable loader, and their
//      REAL ProgramData account (decoded from the program account's
//      embedded pointer, NOT inferred from any config) exists, is owned
//      by the loader, and names the deployer as upgrade authority. The
//      embedded pointer must ALSO equal the INDEPENDENTLY derived
//      ProgramData address (PDA([program_id], BPFLoaderUpgradeable)) —
//      the recorded arrangement is never taken on trust.
//   B. ProtocolConfig — the PDA is derived INDEPENDENTLY (['protocol_config']
//      under each program ID, bump 255) and must equal the pinned
//      derivation; the account exists, is owned by its program, carries a
//      valid Anchor `account:ProtocolConfig` discriminator, decodes per the
//      CURRENT on-chain schema (byte offsets mirrored from the Rust
//      structs), has authority = governance, and matches the approved
//      spec-default configuration values.
//   C. Dedicated oracle signers — the scanner's activity and launch-price
//      oracle fields are the dedicated NS-3 oracle public keys, NOT the
//      initial initialization authority (governance/deployer).
//   D. Emergency state — the ACTUAL paused flag of both programs is
//      reported verbatim; acceptance requires both unpaused (a paused
//      program FAILS with its real state in the detail).
//   E. NS-1/NS-2 residual identities — the four legacy program IDs are
//      probed read-only and REPORTED (present/absent + upgrade authority
//      status). Report-only: legacy residue never flips the NS-3 verdict.
//   G. Cluster identity (runs FIRST — before any deployment state is
//      interpreted) — the RPC endpoint's getGenesisHash must equal the
//      pinned, independently verified Solana Devnet genesis hash
//      (DEVNET_GENESIS_HASH below). A different cluster is an IMMEDIATE
//      FAIL and no deployment check is evaluated on foreign bytes; a
//      failed/unreadable genesis response is UNVERIFIED, which forces
//      overall INCOMPLETE — acceptance is blocked either way.
//
// VERDICT SEMANTICS — read before trusting the output:
//   * PASS  — the check ran and the chain matches the approved value.
//   * FAIL  — the check ran and the chain does NOT match: the deployment
//             is not acceptable as-is (missing accounts, wrong owner,
//             wrong authority, wrong defaults, paused, malformed data).
//   * UNVERIFIED — the check could NOT run: RPC transport failure or an
//             unreadable response. An RPC failure is NOT evidence that the
//             deployment is invalid — but it is equally NOT evidence that
//             it is fine, so ANY unverified check forces the overall
//             result to INCOMPLETE and the exit code to 3. The gate never
//             passes on partial evidence.
//   * INFO  — report-only observation (section E, pending-authority
//             fields); never affects the verdict.
//
// WHAT THIS TOOL WILL NEVER DO (by construction, enforced by test):
//   * no keypair/wallet/signer handling — the CLI accepts PUBLIC KEYS only
//     and REFUSES a value that resolves to an existing file path (never
//     point it at a keypair file);
//   * no transaction construction, signing, or submission;
//   * no default cluster: --url must name the RPC endpoint explicitly.
//
// Byte-layout sources (normative, do not drift):
//   - programs/grave-scanner/src/state/protocol_config.rs  (schema + offsets)
//   - programs/grave-vault/src/state/protocol_config.rs    (schema + offsets)
//   - programs/*/src/constants.rs                          (seeds/defaults)
//   - docs/LEGACY_DEPLOYMENTS.md §3  (loader account layouts). The
//     UpgradeableLoaderState wire format was verified INDEPENDENTLY on
//     2026-11-05 against (1) the anza-xyz/solana-sdk loader-v3-interface
//     sources (enum ordinal order + size_of_program()=36 /
//     size_of_programdata_metadata()=45) and (2) live devnet
//     getAccountInfo bytes of the NS-2 programs:
//       program account     = u32 tag 2 LE + 32-byte ProgramData pointer
//                             (36 B total)
//       ProgramData account = u32 tag 3 LE + u64 slot + 1-byte
//                             authority-set flag + 32-byte upgrade
//                             authority (45 B metadata)
//     and the ProgramData ADDRESS is derivable offline:
//       get_program_data_address(program_id) =
//         PDA([program_id], BPFLoaderUpgradeable)  — bump 255 for both
//     NS-3 programs; the verifier re-derives it and refuses a program
//     account whose embedded pointer is anything else.
//
// CLI:
//   node verify_ns3_deployment.mjs --url <RPC_URL> [--commitment finalized|confirmed] [--json]
//
//   Commitment default is FINALIZED. "confirmed" is a DIAGNOSTIC override
//   only: an acceptance run reported with the default is decided on
//   finalized (root) state; passing --commitment confirmed is for
//   debugging a just-submitted deployment and is recorded verbatim in the
//   output context.
//
//   IDENTITY OVERRIDES WERE REMOVED (security fix C): --deployer,
//   --governance, --activity-oracle and --launch-price-oracle no longer
//   exist. The verifier always checks the 8 pinned NS-3 identities
//   (NS3 + the two derived ProtocolConfig PDAs in ns3_identities.mjs) —
//   acceptance identities are constants, not options, so a caller can
//   never coax a PASS by feeding the verifier a different arrangement.
//
// Exit codes: 0 overall PASS; 1 overall FAIL; 3 overall INCOMPLETE
// (unverified checks); 2 usage error.
import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  NS3,
  NS3_PDAS,
  configPdaWithBump,
  programDataPda,
  DEVNET_GENESIS_HASH,
} from "./ns3_identities.mjs";
import { NS3_LEGACY_IDS } from "./ns3_verify_elf.mjs";

export const TOOL_NAME = "verify_ns3_deployment";

/** The BPF upgradeable loader — the only legitimate owner of program accounts. */
export const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";

/**
 * Pinned Solana Devnet genesis hash — the cluster-identity anchor (fix G):
 * the RPC endpoint must report exactly this genesis BEFORE any deployment
 * state is interpreted.
 *
 * SINGLE SOURCE: the value lives in ns3_identities.mjs — the same module
 * the deployment script reads (via node, no text parsing) and the
 * administration CLI imports — so the deployment gate, the admin CLI and
 * this acceptance verifier can never silently drift apart. For the full
 * provenance of the pin (live RPC + Anza docs + independent cross-check,
 * 2026-11-06) see the DEVNET_GENESIS_HASH comment in ns3_identities.mjs.
 * A devnet genesis reset would change the live value — that failure mode
 * is deliberate: the pin is re-verified by a human and re-pinned
 * consciously, never silently.
 */
export { DEVNET_GENESIS_HASH };

/** Anchor account discriminator = first 8 bytes of sha256("account:<Name>"). */
export function accountDiscriminator(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

export const SCANNER_CONFIG_SPACE = 252; // 8 disc + InitSpace (64 reserved)
export const VAULT_CONFIG_SPACE = 210; // 8 disc + InitSpace (96 reserved)

/** Approved NS-3 spec-default config values (both programs' constants.rs). */
export const EXPECTED_SCANNER_DEFAULTS = Object.freeze({
  inactivitySeconds: 7_776_000n, // 90 d
  priceCollapseBps: 9_900,
  minTvlLamports: 500_000_000n, // 0.5 SOL
  anchorStalenessSeconds: 1_209_600n, // 14 d
  lpBurnDustThreshold: 1_000n,
  certTtlSeconds: 3_600n,
});
export const EXPECTED_VAULT_DEFAULTS = Object.freeze({
  lpHolderShareBps: 4_000,
  salvorShareBps: 4_000,
  protocolShareBps: 2_000, // Charter ceiling
  maxPriorityFeeCeilingLamports: 1_000_000_000n,
  maxSlippageBps: 300,
  jupiterDustThresholdLamports: 666_666n,
  timelockSeconds: 259_200n, // 72 h
});

// ------------------------------------------------------ account decoders

/**
 * Parse a BPF-upgradeable PROGRAM account (36 B: u32 tag=2 + ProgramData
 * pointer at offset 4). Throws with a precise message on any mismatch —
 * callers fail closed on the throw.
 */
export function parseProgramAccount(data) {
  const buf = Buffer.from(data);
  if (buf.length < 36) {
    throw new Error(`program account too small (${buf.length} B; Program layout is 36 B)`);
  }
  const tag = buf.readUInt32LE(0);
  if (tag !== 2) {
    throw new Error(`program account tag ${tag} != 2 (not an initialized upgradeable Program)`);
  }
  const programdata = new PublicKey(buf.subarray(4, 36));
  if (programdata.equals(PublicKey.default)) {
    throw new Error("program account carries an UNSET (all-zero) ProgramData pointer");
  }
  return { tag, programdata };
}

/**
 * Parse a BPF-upgradeable PROGRAMDATA account (45 B metadata: u32 tag=3 +
 * u64 slot + 1-byte authority-set flag + 32-byte upgrade authority at
 * offset 13). Throws on any structural mismatch.
 *
 * Tag values are the UpgradeableLoaderState bincode enum ordinals
 * (u32 LE): 0=Uninitialized, 1=Buffer, 2=Program, 3=ProgramData —
 * verified against the anza-xyz/solana-sdk loader-v3-interface sources
 * AND live on-chain bytes (see the header). A ProgramData account whose
 * tag is anything but 3 is not a ProgramData account.
 */
export function parseProgramDataAccount(data) {
  const buf = Buffer.from(data);
  if (buf.length < 13) {
    throw new Error(`ProgramData account too small (${buf.length} B; header alone is 13 B)`);
  }
  const tag = buf.readUInt32LE(0);
  if (tag !== 3) {
    throw new Error(
      `ProgramData account tag ${tag} != 3 (UpgradeableLoaderState::ProgramData discriminant is 3; ` +
        "this is not a ProgramData account)",
    );
  }
  const slot = buf.readBigUInt64LE(4);
  const flag = buf.readUInt8(12);
  if (flag !== 0 && flag !== 1) {
    throw new Error(`ProgramData authority-set flag is ${flag} (expected 0 or 1)`);
  }
  const authoritySet = flag === 1;
  if (authoritySet && buf.length < 45) {
    throw new Error(
      `ProgramData declares an upgrade authority but is too small (${buf.length} B; 45 B needed)`,
    );
  }
  const authority = authoritySet ? new PublicKey(buf.subarray(13, 45)) : null;
  return { tag, slot, authoritySet, authority };
}

/**
 * Decode the GraveScanner ProtocolConfig (offsets after the 8-byte
 * Anchor discriminator — mirror of protocol_admin.mjs, asserted by test).
 * Throws if the account is shorter than the current schema.
 */
export function decodeScannerConfig(data) {
  const buf = Buffer.from(data);
  if (buf.length < SCANNER_CONFIG_SPACE) {
    throw new Error(
      `scanner config too small (${buf.length} B; current schema is ${SCANNER_CONFIG_SPACE} B)`,
    );
  }
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const pk = (off) => new PublicKey(buf.subarray(off, off + 32));
  return {
    authority: pk(8),
    pendingAuthority: pk(40),
    pendingAuthorityEta: v.getBigInt64(72, true),
    inactivitySeconds: v.getBigUint64(80, true),
    priceCollapseBps: v.getUint16(88, true),
    minTvlLamports: v.getBigUint64(90, true),
    anchorStalenessSeconds: v.getBigUint64(98, true),
    lpBurnDustThreshold: v.getBigUint64(106, true),
    certTtlSeconds: v.getBigInt64(114, true),
    // Strict boolean decode (fix E): the on-chain bool is one byte and
    // borsh only ever emits 0/1. Any other byte means the account does
    // not match the current schema (corruption, a different program, or
    // a crafted account) and MUST fail the decode instead of being
    // silently coerced ("x === 1" would read 2/255 as false).
    paused: strictBool(v.getUint8(122), "scanner paused"),
    activityOracle: pk(123),
    launchPriceOracle: pk(155),
    bump: v.getUint8(187),
  };
}

/**
 * Decode the GraveVault ProtocolConfig (same convention). Throws if the
 * account is shorter than the current schema.
 */
export function decodeVaultConfig(data) {
  const buf = Buffer.from(data);
  if (buf.length < VAULT_CONFIG_SPACE) {
    throw new Error(
      `vault config too small (${buf.length} B; current schema is ${VAULT_CONFIG_SPACE} B)`,
    );
  }
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const pk = (off) => new PublicKey(buf.subarray(off, off + 32));
  return {
    authority: pk(8),
    pendingAuthority: pk(40),
    pendingAuthorityEta: v.getBigInt64(72, true),
    lpHolderShareBps: v.getUint16(80, true),
    salvorShareBps: v.getUint16(82, true),
    protocolShareBps: v.getUint16(84, true),
    maxPriorityFeeCeilingLamports: v.getBigUint64(86, true),
    maxSlippageBps: v.getUint16(94, true),
    jupiterDustThresholdLamports: v.getBigUint64(96, true),
    timelockSeconds: v.getBigInt64(104, true),
    // Strict boolean decode (fix E) — same rationale as `paused`.
    emergencyPaused: strictBool(v.getUint8(112), "vault emergency_paused"),
    bump: v.getUint8(113),
  };
}

/**
 * Strict boolean decode (fix E): only the borsh bool encodings 0 and 1
 * are legal; anything else throws with the field name and the offending
 * byte so the check fails closed instead of coercing garbage to false.
 */
export function strictBool(byte, field) {
  if (byte !== 0 && byte !== 1) {
    throw new Error(
      `${field} byte is ${byte} (boolean fields encode ONLY 0/1 — account does not match the current schema)`,
    );
  }
  return byte === 1;
}

// ------------------------------------------------------------------ core

const PASS = "PASS";
const FAIL = "FAIL";
const UNVERIFIED = "UNVERIFIED";
const INFO = "INFO";

/**
 * Run the full read-only verification. Never throws for on-chain or RPC
 * conditions (usage mistakes still throw). Returns
 * { checks, overall, counts, context, identities }.
 */
export async function runVerification(options = {}) {
  const { url, commitment = "finalized" } = options;
  if (!url) throw new Error("runVerification requires an explicit RPC url");
  // Fix C — identity overrides are REMOVED at the API boundary too: any
  // attempt to pass them fails closed instead of being silently ignored.
  for (const k of ["deployer", "governance", "activityOracle", "launchPriceOracle"]) {
    if (k in options) {
      throw new Error(
        `runVerification no longer accepts '${k}': acceptance identities are the PINNED NS-3 constants, not options`,
      );
    }
  }
  if (commitment !== "finalized" && commitment !== "confirmed") {
    throw new Error("commitment must be 'finalized' (default) or 'confirmed' (diagnostic)");
  }
  // The 8 pinned NS-3 identities — constants, never caller-supplied.
  const identities = {
    deployer: { value: NS3.deployer, source: "pinned" },
    governance: { value: NS3.governanceAuthority, source: "pinned" },
    activityOracle: { value: NS3.activityOracle, source: "pinned" },
    launchPriceOracle: { value: NS3.launchPriceOracle, source: "pinned" },
  };
  const pk = (b58) => new PublicKey(b58);
  const scannerProgram = pk(NS3.scannerProgramId);
  const vaultProgram = pk(NS3.vaultProgramId);
  const loaderPk = pk(BPF_LOADER_UPGRADEABLE);
  const deployerPk = pk(identities.deployer.value);
  const governancePk = pk(identities.governance.value);
  const activityPk = pk(identities.activityOracle.value);
  const launchPricePk = pk(identities.launchPriceOracle.value);

  const connection = new Connection(url, commitment);

  // ---- context (read-only; a context failure demotes nothing by itself)
  // No initial value: both the try and the catch path below assign context
  // unconditionally, so an initializer would be a dead store.
  let context;
  try {
    const epochInfo = await connection.getEpochInfo();
    context = {
      slot: epochInfo.absoluteSlot,
      epoch: epochInfo.epoch,
      commitment,
    };
  } catch {
    context = { slot: null, epoch: null, commitment, error: "getEpochInfo failed (RPC transport)" };
  }

  // ---- genesis gate (fix G): establish WHICH cluster this is before any
  // deployment state is interpreted. getGenesisHash is read-only and cheap.
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
  const unverifiedId = (section, id, title, err) =>
    add(section, id, title, UNVERIFIED, `not verified — RPC failure: ${err.message ?? err}`);

  // ------------------------------------SECTION G — cluster identity (fix G)
  // The genesis hash is the cluster's fingerprint. It must equal the pinned
  // Solana Devnet genesis BEFORE any deployment state is interpreted: a
  // different cluster is not a misconfigured deployment, it is a different
  // world — so a mismatch fails closed right here and sections A–E never
  // evaluate against foreign bytes.
  if (genesisHash === null) {
    add(
      "G",
      "G1 devnet",
      "RPC endpoint reports the pinned Solana Devnet genesis hash",
      UNVERIFIED,
      `${context.genesisError ?? "getGenesisHash failed"} — cluster identity could NOT be established ` +
        `(pinned Devnet genesis: ${DEVNET_GENESIS_HASH}); acceptance is blocked (INCOMPLETE) until ` +
        "the endpoint reports it",
    );
  } else if (genesisHash !== DEVNET_GENESIS_HASH) {
    add(
      "G",
      "G1 devnet",
      "RPC endpoint reports the pinned Solana Devnet genesis hash",
      FAIL,
      `endpoint genesis ${genesisHash} != pinned Devnet ${DEVNET_GENESIS_HASH} — this is NOT the ` +
        "approved cluster. No deployment state is interpreted on a foreign cluster; " +
        "point --url at Solana Devnet (https://api.devnet.solana.com) and re-run",
    );
    // Fail closed immediately — no deployment check runs on a foreign cluster.
    const countsNow = {
      pass: checks.filter((c) => c.status === PASS).length,
      fail: checks.filter((c) => c.status === FAIL).length,
      unverified: checks.filter((c) => c.status === UNVERIFIED).length,
      info: checks.filter((c) => c.status === INFO).length,
    };
    return {
      checks,
      overall: countsNow.fail > 0 ? "FAIL" : countsNow.unverified > 0 ? "INCOMPLETE" : "PASS",
      counts: countsNow,
      context,
      identities,
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

  // Cached, never-throwing account fetcher.
  const cache = new Map();
  async function fetchAccount(addressPubkey, label) {
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
    void label;
    return entry;
  }

  // ------------------------------------------------SECTION A — programs
  const programs = [
    { n: 1, label: "scanner", programId: scannerProgram },
    { n: 6, label: "vault", programId: vaultProgram },
  ];
  const programData = {}; // label -> {programdata, dataAccount}
  for (const p of programs) {
    const base = p.label;
    const addr = p.programId.toBase58();
    const res = await fetchAccount(p.programId, `${base} program`);
    if (!res.ok) {
      for (const [k, t] of [
        [1, "program account exists"],
        [2, "program account owner is the BPF upgradeable loader"],
        [3, "program account is executable"],
        [4, "ProgramData account decodes from the program account pointer"],
        [5, `upgrade authority (real ProgramData) is the deployer ${identities.deployer.value}`],
      ]) {
        unverifiedId("A", `A${p.n + k - 1} ${base}`, t, res.err);
      }
      continue;
    }
    const info = res.info;
    if (!info) {
      add(
        "A",
        `A${p.n} ${base}`,
        "program account exists",
        FAIL,
        `no account exists at ${addr} — the NS-3 ${base} program is NOT deployed on this cluster`,
      );
      for (const [k, t] of [
        [2, "program account owner is the BPF upgradeable loader"],
        [3, "program account is executable"],
        [4, "ProgramData account decodes from the program account pointer"],
        [5, `upgrade authority (real ProgramData) is the deployer ${identities.deployer.value}`],
      ]) {
        add(
          "A",
          `A${p.n + k - 1} ${base}`,
          t,
          FAIL,
          `cannot verify — program account absent at ${addr}`,
        );
      }
      continue;
    }
    add(
      "A",
      `A${p.n} ${base}`,
      "program account exists",
      PASS,
      `${addr} — owner ${info.owner.toBase58()}, executable=${info.executable}, ${info.data.length} B data, ${info.lamports} lamports`,
    );
    // A+1 owner
    if (info.owner.equals(loaderPk)) {
      add(
        "A",
        `A${p.n + 1} ${base}`,
        "program account owner is the BPF upgradeable loader",
        PASS,
        info.owner.toBase58(),
      );
    } else {
      add(
        "A",
        `A${p.n + 1} ${base}`,
        "program account owner is the BPF upgradeable loader",
        FAIL,
        `owner is ${info.owner.toBase58()}, expected ${BPF_LOADER_UPGRADEABLE}`,
      );
    }
    // A+2 executable
    if (info.executable) {
      add("A", `A${p.n + 2} ${base}`, "program account is executable", PASS, "executable=true");
    } else {
      add(
        "A",
        `A${p.n + 2} ${base}`,
        "program account is executable",
        FAIL,
        "executable=false — the loader would refuse to invoke it",
      );
    }
    // A+3 ProgramData relationship — decode the REAL pointer AND verify it
    // against the INDEPENDENTLY derived ProgramData address (fix: never
    // trust the recorded/pointed arrangement on its own).
    let pd = null;
    let derivedPd = null;
    // No initial value: the try block assigns pointerIsDerived, and the catch
    // path continues before its first read below (an initializer would be a
    // dead store).
    let pointerIsDerived;
    try {
      pd = parseProgramAccount(info.data);
      derivedPd = programDataPda(p.programId);
      pointerIsDerived = pd.programdata.equals(derivedPd);
    } catch (err) {
      add(
        "A",
        `A${p.n + 3} ${base}`,
        "ProgramData account decodes from the program account pointer",
        FAIL,
        `malformed program account data: ${err.message}`,
      );
      add(
        "A",
        `A${p.n + 4} ${base}`,
        `upgrade authority (real ProgramData) is the deployer ${identities.deployer.value}`,
        FAIL,
        "cannot read the upgrade authority — program account data malformed",
      );
      continue;
    }
    const pdRes = await fetchAccount(pd.programdata, `${base} ProgramData`);
    if (!pdRes.ok) {
      unverifiedId(
        "A",
        `A${p.n + 3} ${base}`,
        "ProgramData account decodes from the program account pointer",
        pdRes.err,
      );
      unverifiedId(
        "A",
        `A${p.n + 4} ${base}`,
        `upgrade authority (real ProgramData) is the deployer ${identities.deployer.value}`,
        pdRes.err,
      );
      continue;
    }
    const pdInfo = pdRes.info;
    if (!pdInfo) {
      add(
        "A",
        `A${p.n + 3} ${base}`,
        "ProgramData account decodes from the program account pointer",
        FAIL,
        `the program account points at ProgramData ${pd.programdata.toBase58()}, which does NOT exist on this cluster`,
      );
      add(
        "A",
        `A${p.n + 4} ${base}`,
        `upgrade authority (real ProgramData) is the deployer ${identities.deployer.value}`,
        FAIL,
        "cannot read the upgrade authority — ProgramData account absent",
      );
      continue;
    }
    if (!pdInfo.owner.equals(loaderPk)) {
      add(
        "A",
        `A${p.n + 3} ${base}`,
        "ProgramData account decodes from the program account pointer",
        FAIL,
        `ProgramData ${pd.programdata.toBase58()} exists but its owner is ${pdInfo.owner.toBase58()} (expected the loader)`,
      );
      add(
        "A",
        `A${p.n + 4} ${base}`,
        `upgrade authority (real ProgramData) is the deployer ${identities.deployer.value}`,
        FAIL,
        "ProgramData owner is not the loader",
      );
      continue;
    }
    let decodedPd;
    try {
      decodedPd = parseProgramDataAccount(pdInfo.data);
    } catch (err) {
      add(
        "A",
        `A${p.n + 3} ${base}`,
        "ProgramData account decodes from the program account pointer",
        FAIL,
        `malformed ProgramData (${pd.programdata.toBase58()}): ${err.message}`,
      );
      add(
        "A",
        `A${p.n + 4} ${base}`,
        `upgrade authority (real ProgramData) is the deployer ${identities.deployer.value}`,
        FAIL,
        "cannot read the upgrade authority — ProgramData malformed",
      );
      continue;
    }
    if (!pointerIsDerived) {
      add(
        "A",
        `A${p.n + 3} ${base}`,
        "ProgramData account decodes from the program account pointer",
        FAIL,
        `ProgramData pointer ${pd.programdata.toBase58()} is NOT the loader-derived ProgramData address of ${addr} ` +
          `(expected ${derivedPd.toBase58()} = PDA([program_id], BPFLoaderUpgradeable), ` +
          "solana_loader_v3_interface::get_program_data_address) — the approved deployment arrangement " +
          "always yields the derived address; a foreign pointer is refused",
      );
      add(
        "A",
        `A${p.n + 4} ${base}`,
        `upgrade authority (real ProgramData) is the deployer ${identities.deployer.value}`,
        FAIL,
        "cannot trust the upgrade authority of a ProgramData account reached through a non-derived pointer",
      );
      continue;
    }
    add(
      "A",
      `A${p.n + 3} ${base}`,
      "ProgramData account decodes from the program account pointer",
      PASS,
      `program account -> ProgramData ${pd.programdata.toBase58()} (owner loader, tag 3, slot ${decodedPd.slot}; ` +
        "pointer == independently derived loader PDA)",
    );
    programData[base] = { programdata: pd.programdata, decoded: decodedPd };
    // A+4 upgrade authority = deployer (decoded from the REAL ProgramData).
    if (!decodedPd.authoritySet) {
      add(
        "A",
        `A${p.n + 4} ${base}`,
        `upgrade authority (real ProgramData) is the deployer ${identities.deployer.value}`,
        FAIL,
        `ProgramData ${pd.programdata.toBase58()} has NO upgrade authority (renounced/None) — the program can never be upgraded or closed`,
      );
    } else if (decodedPd.authority.equals(deployerPk)) {
      add(
        "A",
        `A${p.n + 4} ${base}`,
        `upgrade authority (real ProgramData) is the deployer ${identities.deployer.value}`,
        PASS,
        `ProgramData ${pd.programdata.toBase58()} upgrade authority = ${decodedPd.authority.toBase58()}`,
      );
    } else {
      add(
        "A",
        `A${p.n + 4} ${base}`,
        `upgrade authority (real ProgramData) is the deployer ${identities.deployer.value}`,
        FAIL,
        `ProgramData ${pd.programdata.toBase58()} upgrade authority is ${decodedPd.authority.toBase58()}, expected ${identities.deployer.value}`,
      );
    }
  }

  // --------------------------------------------SECTION B — ProtocolConfig
  const configs = [
    {
      label: "scanner",
      programId: scannerProgram,
      pinnedPda: NS3_PDAS.scannerConfigPda,
      deriv: "B1",
      exists: "B2",
      owner: "B3",
      disc: "B4",
      dec: "B5",
      auth: "B6",
      def: "B7",
    },
    {
      label: "vault",
      programId: vaultProgram,
      pinnedPda: NS3_PDAS.vaultConfigPda,
      deriv: "B8",
      exists: "B9",
      owner: "B10",
      disc: "B11",
      dec: "B12",
      auth: "B13",
      def: "B14",
    },
  ];
  const decodedConfigs = {};
  const configState = {}; // label -> "ok" | "fail" | "unverified"
  for (const c of configs) {
    // Independent PDA derivation (offline math; the pinned vector is the
    // recorded expectation, reproduced here rather than trusted).
    const [derived, bump] = configPdaWithBump(c.programId);
    if (derived.toBase58() === c.pinnedPda) {
      add(
        "B",
        `${c.deriv} ${c.label}`,
        "['protocol_config'] PDA derived independently and matches the pinned derivation",
        PASS,
        `derived ${derived.toBase58()} (bump ${bump}) == pinned ${c.pinnedPda}`,
      );
    } else {
      add(
        "B",
        `${c.deriv} ${c.label}`,
        "['protocol_config'] PDA derived independently and matches the pinned derivation",
        FAIL,
        `derived ${derived.toBase58()} != pinned ${c.pinnedPda} — the pinned vector and the identity constants disagree`,
      );
    }
    const res = await fetchAccount(derived, `${c.label} config`);
    if (!res.ok) {
      configState[c.label] = "unverified";
      for (const [id, t] of [
        [c.exists, "config account exists"],
        [c.owner, "config account owner is its own program"],
        [c.disc, "config carries the Anchor account:ProtocolConfig discriminator"],
        [c.dec, "config decodes per the current on-chain schema"],
        [c.auth, `config authority is the governance authority ${identities.governance.value}`],
        [c.def, "config values match the approved spec defaults"],
      ]) {
        unverifiedId("B", `${id} ${c.label}`, t, res.err);
      }
      continue;
    }
    const info = res.info;
    if (!info) {
      configState[c.label] = "fail";
      add(
        "B",
        `${c.exists} ${c.label}`,
        "config account exists",
        FAIL,
        `${c.label} ProtocolConfig ${derived.toBase58()} does NOT exist — initialize has not run (or ran on a different cluster)`,
      );
      for (const [id, t] of [
        [c.owner, "config account owner is its own program"],
        [c.disc, "config carries the Anchor account:ProtocolConfig discriminator"],
        [c.dec, "config decodes per the current on-chain schema"],
        [c.auth, `config authority is the governance authority ${identities.governance.value}`],
        [c.def, "config values match the approved spec defaults"],
      ]) {
        add(
          "B",
          `${id} ${c.label}`,
          t,
          FAIL,
          `cannot verify — no account at the derived PDA ${derived.toBase58()}`,
        );
      }
      continue;
    }
    add(
      "B",
      `${c.exists} ${c.label}`,
      "config account exists",
      PASS,
      `${derived.toBase58()} — ${info.data.length} B, ${info.lamports} lamports`,
    );
    if (info.owner.equals(c.programId)) {
      add(
        "B",
        `${c.owner} ${c.label}`,
        "config account owner is its own program",
        PASS,
        info.owner.toBase58(),
      );
    } else {
      add(
        "B",
        `${c.owner} ${c.label}`,
        "config account owner is its own program",
        FAIL,
        `owner is ${info.owner.toBase58()}, expected ${c.programId.toBase58()}`,
      );
    }
    const wantDisc = accountDiscriminator("ProtocolConfig");
    const gotDisc = Buffer.from(info.data.subarray(0, 8));
    if (gotDisc.equals(wantDisc)) {
      add(
        "B",
        `${c.disc} ${c.label}`,
        "config carries the Anchor account:ProtocolConfig discriminator",
        PASS,
        `sha256("account:ProtocolConfig")[0..8] = ${wantDisc.toString("hex")}`,
      );
    } else {
      configState[c.label] = "fail";
      add(
        "B",
        `${c.disc} ${c.label}`,
        "config carries the Anchor account:ProtocolConfig discriminator",
        FAIL,
        `discriminator ${gotDisc.toString("hex")} != expected ${wantDisc.toString("hex")} — not a ProtocolConfig account`,
      );
      for (const [id, t] of [
        [c.dec, "config decodes per the current on-chain schema"],
        [c.auth, `config authority is the governance authority ${identities.governance.value}`],
        [c.def, "config values match the approved spec defaults"],
      ]) {
        add("B", `${id} ${c.label}`, t, FAIL, "cannot decode — discriminator mismatch");
      }
      continue;
    }
    let cfg;
    try {
      cfg = c.label === "scanner" ? decodeScannerConfig(info.data) : decodeVaultConfig(info.data);
    } catch (err) {
      configState[c.label] = "fail";
      add(
        "B",
        `${c.dec} ${c.label}`,
        "config decodes per the current on-chain schema",
        FAIL,
        err.message,
      );
      add(
        "B",
        `${c.auth} ${c.label}`,
        `config authority is the governance authority ${identities.governance.value}`,
        FAIL,
        "cannot decode",
      );
      add(
        "B",
        `${c.def} ${c.label}`,
        "config values match the approved spec defaults",
        FAIL,
        "cannot decode",
      );
      continue;
    }
    add(
      "B",
      `${c.dec} ${c.label}`,
      "config decodes per the current on-chain schema",
      PASS,
      `all fields decoded (bump ${cfg.bump}, pending_authority ${cfg.pendingAuthority.toBase58()}, pending_authority_eta ${cfg.pendingAuthorityEta})`,
    );
    decodedConfigs[c.label] = cfg;
    configState[c.label] = "ok";
    if (cfg.bump !== bump) {
      add(
        "B",
        `${c.dec} ${c.label}`,
        "config decodes per the current on-chain schema",
        FAIL,
        `stored bump ${cfg.bump} != derived bump ${bump}`,
      );
    }
    // authority = governance
    if (cfg.authority.equals(governancePk)) {
      add(
        "B",
        `${c.auth} ${c.label}`,
        `config authority is the governance authority ${identities.governance.value}`,
        PASS,
        `authority = ${cfg.authority.toBase58()}`,
      );
    } else {
      add(
        "B",
        `${c.auth} ${c.label}`,
        `config authority is the governance authority ${identities.governance.value}`,
        FAIL,
        `authority is ${cfg.authority.toBase58()}, expected ${identities.governance.value}`,
      );
    }
    // approved defaults
    if (c.label === "scanner") {
      const want = EXPECTED_SCANNER_DEFAULTS;
      const diffs = [];
      for (const [k, wantV] of Object.entries(want)) {
        if (cfg[k] !== wantV) diffs.push(`${k}=${cfg[k]} (approved ${wantV})`);
      }
      if (diffs.length === 0) {
        add(
          "B",
          `${c.def} ${c.label}`,
          "config values match the approved spec defaults",
          PASS,
          Object.entries(want)
            .map(([k, v]) => `${k}=${v}`)
            .join(", "),
        );
      } else {
        add(
          "B",
          `${c.def} ${c.label}`,
          "config values match the approved spec defaults",
          FAIL,
          `divergence: ${diffs.join("; ")}`,
        );
      }
    } else {
      const want = EXPECTED_VAULT_DEFAULTS;
      const diffs = [];
      for (const [k, wantV] of Object.entries(want)) {
        if (cfg[k] !== wantV) diffs.push(`${k}=${cfg[k]} (approved ${wantV})`);
      }
      if (diffs.length === 0) {
        add(
          "B",
          `${c.def} ${c.label}`,
          "config values match the approved spec defaults",
          PASS,
          Object.entries(want)
            .map(([k, v]) => `${k}=${v}`)
            .join(", "),
        );
      } else {
        add(
          "B",
          `${c.def} ${c.label}`,
          "config values match the approved spec defaults",
          FAIL,
          `divergence: ${diffs.join("; ")}`,
        );
      }
    }
    // pending-authority fields: report-only (reserved write-only state per
    // the NS-3 arrangement — NOT an enforced timelock mechanism).
    add(
      "INFO",
      `INFO pending-authority ${c.label}`,
      "pending-authority fields reported verbatim (reserved write-only state — not an enforced timelock)",
      INFO,
      `pending_authority=${cfg.pendingAuthority.toBase58()} pending_authority_eta=${cfg.pendingAuthorityEta}`,
    );
  }

  // -------------------------------------SECTION C — dedicated oracle signers
  const scfg = decodedConfigs.scanner;
  if (!scfg) {
    for (const [id, t] of [
      ["C1", `activity oracle is the dedicated NS-3 key ${identities.activityOracle.value}`],
      ["C2", `launch-price oracle is the dedicated NS-3 key ${identities.launchPriceOracle.value}`],
    ]) {
      add(
        "C",
        id,
        t,
        configState.scanner === "unverified" ? UNVERIFIED : FAIL,
        "cannot verify — scanner ProtocolConfig did not decode",
      );
    }
  } else {
    for (const [id, field, dedicated, dedicatedLabel] of [
      ["C1", "activityOracle", activityPk, identities.activityOracle.value],
      ["C2", "launchPriceOracle", launchPricePk, identities.launchPriceOracle.value],
    ]) {
      const got = scfg[field].toBase58();
      const title = `${field.replace(/([A-Z])/g, " $1").trim()} is the dedicated NS-3 key ${dedicatedLabel} (scanner)`;
      if (scfg[field].equals(dedicated)) {
        add(
          "C",
          `${id} scanner`,
          title,
          PASS,
          `${field} = ${got} (dedicated signer, NOT the initialization authority)`,
        );
      } else if (scfg[field].equals(governancePk) || scfg[field].equals(deployerPk)) {
        add(
          "C",
          `${id} scanner`,
          title,
          FAIL,
          `${field} = ${got} — still the INITIAL INITIALIZATION authority; register-oracle has not rotated it to the dedicated NS-3 signer`,
        );
      } else {
        add(
          "C",
          `${id} scanner`,
          title,
          FAIL,
          `${field} = ${got}, expected the dedicated ${dedicatedLabel}`,
        );
      }
    }
  }

  // ------------------------------------------------SECTION D — emergency
  for (const [label, cfg] of Object.entries(decodedConfigs)) {
    const paused = label === "scanner" ? cfg.paused : cfg.emergencyPaused;
    const field = label === "scanner" ? "paused" : "emergency_paused";
    const id = label === "scanner" ? "D1" : "D2";
    if (!paused) {
      add(
        "D",
        `${id} ${label}`,
        `${label} emergency state reported and unpaused`,
        PASS,
        `${field}=false — both programs must be unpaused at acceptance`,
      );
    } else {
      add(
        "D",
        `${id} ${label}`,
        `${label} emergency state reported and unpaused`,
        FAIL,
        `${field}=true — the ${label} program is CURRENTLY EMERGENCY-PAUSED on-chain (actual state reported verbatim; acceptance requires unpaused)`,
      );
    }
  }
  if (!decodedConfigs.scanner) {
    add(
      "D",
      "D1 scanner",
      "scanner emergency state reported and unpaused",
      configState.scanner === "unverified" ? UNVERIFIED : FAIL,
      "cannot verify — scanner ProtocolConfig did not decode",
    );
  }
  if (!decodedConfigs.vault) {
    add(
      "D",
      "D2 vault",
      "vault emergency state reported and unpaused",
      configState.vault === "unverified" ? UNVERIFIED : FAIL,
      "cannot verify — vault ProtocolConfig did not decode",
    );
  }

  // -------------------------------------SECTION E — legacy residual report
  for (const [name, legacyId] of NS3_LEGACY_IDS) {
    let pkLegacy;
    try {
      pkLegacy = new PublicKey(legacyId);
    } catch {
      continue;
    }
    const res = await fetchAccount(pkLegacy, `legacy ${name}`);
    if (!res.ok) {
      add(
        "E",
        `E ${name}`,
        `legacy ${name} (${legacyId}) residual status`,
        INFO,
        `report unavailable — RPC failure: ${res.err.message ?? res.err}`,
      );
      continue;
    }
    const info = res.info;
    if (!info) {
      add(
        "E",
        `E ${name}`,
        `legacy ${name} (${legacyId}) residual status`,
        INFO,
        "absent on this cluster",
      );
      continue;
    }
    let extra = "";
    if (info.owner.toBase58() === BPF_LOADER_UPGRADEABLE && info.data.length >= 36) {
      try {
        const ptr = parseProgramAccount(info.data);
        const pdRes = await fetchAccount(ptr.programdata, `legacy ${name} ProgramData`);
        if (pdRes.ok && pdRes.info) {
          const d = parseProgramDataAccount(pdRes.info.data);
          extra = d.authoritySet
            ? ` ProgramData upgrade authority ${d.authority.toBase58()}`
            : " ProgramData upgrade authority RENOUNCED (None)";
        } else if (pdRes.ok) {
          extra = " ProgramData account ABSENT";
        }
      } catch {
        extra = " (program account data not decodable as upgradeable Program)";
      }
    }
    add(
      "E",
      `E ${name}`,
      `legacy ${name} (${legacyId}) residual status`,
      INFO,
      `PRESENT — owner ${info.owner.toBase58()}, executable=${info.executable},${extra} — historical residue; does not affect the NS-3 verdict`,
    );
  }

  const counts = {
    pass: checks.filter((c) => c.status === PASS).length,
    fail: checks.filter((c) => c.status === FAIL).length,
    unverified: checks.filter((c) => c.status === UNVERIFIED).length,
    info: checks.filter((c) => c.status === INFO).length,
  };
  const overall = counts.fail > 0 ? "FAIL" : counts.unverified > 0 ? "INCOMPLETE" : "PASS";
  return { checks, overall, counts, context, identities };
}

// ---------------------------------------------------------------- reporting

function renderTerminal(result) {
  const lines = [];
  const { checks, overall, counts, context, identities } = result;
  lines.push("=== NS-3 deployment acceptance — STRICTLY READ-ONLY ===");
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
    `identities: deployer ${identities.deployer.value} [${identities.deployer.source}], governance ${identities.governance.value} [${identities.governance.source}], activity oracle ${identities.activityOracle.value} [${identities.activityOracle.source}], launch-price oracle ${identities.launchPriceOracle.value} [${identities.launchPriceOracle.source}]`,
  );
  let section = "";
  for (const c of checks) {
    if (c.section !== section) {
      section = c.section;
      const titles = {
        G: "Section G — cluster identity (pinned Solana Devnet genesis hash; runs before any deployment state)",
        A: "Section A — program accounts, ProgramData relationship, upgrade authority",
        B: "Section B — ProtocolConfig PDA, schema decode, governance authority, approved defaults",
        C: "Section C — dedicated oracle signers",
        D: "Section D — emergency (paused) state, reported verbatim",
        E: "Section E — NS-1/NS-2 residual identities (report only)",
        INFO: "Report-only observations",
      };
      lines.push("", titles[section] ?? section);
    }
    lines.push(`  ${c.status.padEnd(10)} [${c.id}] ${c.title}`);
    lines.push(`             ${c.detail}`);
  }
  lines.push("", `OVERALL RESULT: ${overall}`);
  if (overall === "INCOMPLETE") {
    lines.push("  One or more checks could not be verified (RPC failure). This is NOT evidence");
    lines.push(
      "  of an invalid deployment — but it blocks acceptance: re-run against a healthy RPC.",
    );
  }
  if (overall === "FAIL") {
    lines.push("  The on-chain state does not match the approved NS-3 arrangement. Do not treat");
    lines.push("  this deployment as accepted; investigate every FAIL above.");
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
    "usage: node verify_ns3_deployment.mjs --url <RPC_URL> [--commitment finalized|confirmed] [--json]\n" +
      "  --commitment defaults to FINALIZED; 'confirmed' is a diagnostic override for a just-submitted deploy.\n" +
      "  Identity flags (--deployer/--governance/--activity-oracle/--launch-price-oracle) were REMOVED:\n" +
      "  this verifier always checks the 8 pinned NS-3 identities (constants in ns3_identities.mjs).",
  );
  process.exit(2);
}

/** Identity-override flags removed by fix C — never accepted again. */
const REMOVED_IDENTITY_FLAGS = ["deployer", "governance", "activity-oracle", "launch-price-oracle"];

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) usageError("--url is REQUIRED (this tool never assumes a cluster)");
  for (const f of REMOVED_IDENTITY_FLAGS) {
    if (args[f] !== undefined) {
      usageError(
        `--${f} is no longer accepted: acceptance identities are the PINNED NS-3 constants, not options. ` +
          "Re-run without identity flags.",
      );
    }
  }
  if (args.commitment !== undefined && !["finalized", "confirmed"].includes(args.commitment)) {
    usageError("--commitment must be 'finalized' (default) or 'confirmed' (diagnostic)");
  }
  const result = await runVerification({
    url: args.url,
    commitment: args.commitment ?? "finalized",
  });
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          tool: TOOL_NAME,
          read_only: true,
          url: args.url,
          ...result,
          checks: result.checks.map((c) => ({
            section: c.section,
            id: c.id,
            title: c.title,
            status: c.status,
            detail: c.detail,
          })),
        },
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
if (process.argv[1] && process.argv[1].endsWith("verify_ns3_deployment.mjs")) {
  main().catch((err) => {
    console.error(`fatal: ${err.message ?? err}`);
    process.exit(2);
  });
}
