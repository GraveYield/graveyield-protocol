// SPDX-License-Identifier: Apache-2.0
//
// verify_ns3_deployment.mjs — STRICTLY READ-ONLY NS-3 post-deployment
// acceptance verifier.
//
// ═══════════════════════════════════════════════════════════════════════
// READ-ONLY GUARANTEE (the whole point of this tool — do not weaken it):
//   * NO signers are constructed, requested, or needed.
//   * NO keypair file is read, loaded, parsed, or referenced — this module
//     never imports Keypair and never opens any *.json key material (the
//     ONLY file it may read is the repo's provenance manifest).
//   * NO wallet is connected; NO transaction is built, signed, or sent.
//   * NO on-chain state is modified in any way: the only RPC methods used
//     are `getAccountInfo` and `getSlot`. Nothing else.
//   * Safe to run from any machine against any RPC endpoint the operator
//     names. Agents may run this freely (DR-002: agent-assisted read-only
//     verification is an allowed role).
// ═══════════════════════════════════════════════════════════════════════
//
// WHY: docs/DEVNET.md records the NS-3 deployment, but until now nothing
// INDEPENDENTLY established what is actually on chain: whether the
// program accounts live at the NS-3 IDs under the BPF upgradeable loader,
// whether the upgrade authority is really the NS-3 deployer (decoded from
// the REAL ProgramData accounts — never inferred from a config account),
// whether both ProtocolConfigs sit at the expected PDAs with the
// governance authority and the approved initialization defaults, whether
// the dedicated oracle signers are registered, whether anything is
// paused, and whether the deployed bytes are the approved NS-3 provenance
// (no NS-1/NS-2 residue). This verifier answers all of that read-only.
//
// USAGE:
//   node verify_ns3_deployment.mjs --url https://api.devnet.solana.com [--json]
//   (--url is REQUIRED and explicit — there is deliberately no default
//    endpoint. A read-only tool must never guess where it looks.)
//
// RESULT SEMANTICS — three states, fail-closed:
//   PASS       the check ran and the observed chain state is exactly the
//              approved NS-3 acceptance state.
//   FAIL       the check ran and the observed chain state is NOT the
//              approved state (missing account, wrong authority, drifted
//              value, legacy residue, paused, ...). A FAIL is deployment
//              evidence: something real on chain contradicts acceptance.
//   UNVERIFIED the check could not RUN (RPC transport failure, RPC error
//              response, unreadable manifest). An RPC failure is NOT
//              evidence that the deployment is invalid — but it is also
//              NOT a pass: ANY UNVERIFIED blocks the OVERALL PASS.
// Exit codes: 0 = OVERALL PASS (every check PASS); 1 = at least one FAIL;
//             2 = no FAIL but at least one UNVERIFIED; 3 = usage error.
//
// CHECKS (docs/DEVNET.md §acceptance; the full list, per program where applicable):
//   A  program accounts: exists, executable, owner = BPF upgradeable
//      loader, data encodes the Program state, and the embedded ProgramData
//      relation resolves; upgrade authority decoded from the REAL
//      ProgramData account == NS-3 deployer (initial upgrade authority).
//   B  ProtocolConfig: PDA independently re-derived from the program ID and
//      == expected NS-3 PDA; account exists at that PDA; owner == program
//      ID; Anchor account discriminator valid; decoded per the CURRENT
//      schema (protocol_admin.mjs, asserted against the Rust structs);
//      authority == NS-3 governance; config values == approved
//      initialization defaults; pending_authority zeroed (reported, with
//      the honest note that pending/timelock fields are NOT enforced
//      mechanisms — see docs/DEVNET.md).
//   C  scanner oracle signers: activity and launch-price fields equal the
//      DEDICATED NS-3 oracle public keys (not the governance/deployer key
//      they start at before register-oracle).
//   D  emergency state: the ACTUAL decoded pause flags are reported for
//      both programs; acceptance requires both unpaused.
//   E  deployment identity consistency: SHA-256 of the DEPLOYED ELF bytes
//      (read from each ProgramData account) == the approved digest in
//      provenance.manifest.json (the same manifest the deploy gate and CI
//      consume), and NO NS-1/NS-2 program-ID byte residue anywhere in the
//      deployed bytes. (Repo-side legacy-ID sync is a separate offline
//      check: scripts/devnet/ns3_verify_sync.mjs.)
//
// Every report lists the observed public keys, addresses, and the RPC
// slot/context the observations came from, so the acceptance evidence is
// independently re-derivable.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { NS3, NS3_PDAS, configPdaWithBump } from "./ns3_identities.mjs";
import { decodeProtocolConfig, SCANNER_DEFAULTS, VAULT_DEFAULTS } from "./protocol_admin.mjs";
import { NS3_LEGACY_IDS } from "./ns3_verify_elf.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST_PATH = join(HERE, "provenance.manifest.json");

const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const ZERO_KEY = "11111111111111111111111111111111";
// Program account (BPF upgradeable loader): 4-byte enum tag (2 = Program)
// + 32-byte programdata address. ProgramData account: 4-byte tag (3 =
// ProgramData) + 8-byte modify slot + 1-byte Option tag + 32-byte upgrade
// authority + the deployed ELF bytes. Verified against the recorded NS-2
// readbacks in docs/LEGACY_DEPLOYMENTS.md §3 (authority embedding at
// offset 13; ELF starts at 45).
const PROGRAM_TAG = 2;
const PROGRAM_DATA_TAG = 3;
const PROGRAM_DATA_FIXED_LEN = 45;

function accountDiscriminator(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}
const PROTOCOL_CONFIG_DISCRIMINATOR = accountDiscriminator("ProtocolConfig");

const LEGACY_ID_BYTES = NS3_LEGACY_IDS.map(([name, id]) => ({
  name,
  bytes: Buffer.from(new PublicKey(id).toBytes()),
}));

/** A transport/RPC failure — maps to UNVERIFIED (never FAIL). */
class RpcUnverified extends Error {}

async function rpcCall(endpoint, method, params, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (err) {
    throw new RpcUnverified(`RPC transport failure (${method}): ${err.message ?? err}`);
  }
  if (!res.ok) {
    throw new RpcUnverified(`RPC HTTP ${res.status} on ${method}`);
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new RpcUnverified(`RPC response not JSON on ${method}: ${err.message ?? err}`);
  }
  if (body.error) {
    throw new RpcUnverified(
      `RPC error on ${method}: ${body.error.message ?? JSON.stringify(body.error)}`,
    );
  }
  return body.result;
}

/** getAccountInfo → null when the account does not exist; throws
 *  RpcUnverified on transport/RPC failure; FAILS (assert) on malformed
 *  value shapes (an existing account with an unreadable envelope is
 *  evidence, not an RPC outage). */
async function fetchAccountInfo(endpoint, addressBase58, fetchImpl, ctx) {
  const result = await rpcCall(
    endpoint,
    "getAccountInfo",
    [addressBase58, { encoding: "base64" }],
    fetchImpl,
  );
  const slot = result?.context?.slot;
  if (typeof slot === "number") ctx.slots.add(slot);
  const value = result?.value;
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value.data) ||
    value.data.length !== 2 ||
    value.data[1] !== "base64" ||
    typeof value.owner !== "string"
  ) {
    throw new Error(`malformed getAccountInfo value for ${addressBase58}`);
  }
  return {
    owner: value.owner,
    executable: value.executable === true,
    lamports: value.lamports,
    data: Buffer.from(value.data[0], "base64"),
    slot,
  };
}

// ------------------------------------------------------------- decoders

function decodeProgramAccount(data) {
  if (data.length !== 36) throw new Error(`program account data is ${data.length} B, expected 36`);
  const tag = data.readUInt32LE(0);
  if (tag !== PROGRAM_TAG)
    throw new Error(`program account tag ${tag}, expected ${PROGRAM_TAG} (Program)`);
  return { tag, programdataAddress: new PublicKey(data.subarray(4, 36)).toBase58() };
}

function decodeProgramDataAccount(data) {
  if (data.length < PROGRAM_DATA_FIXED_LEN) {
    throw new Error(
      `ProgramData account data is ${data.length} B, expected >= ${PROGRAM_DATA_FIXED_LEN}`,
    );
  }
  const tag = data.readUInt32LE(0);
  if (tag !== PROGRAM_DATA_TAG) {
    throw new Error(`ProgramData tag ${tag}, expected ${PROGRAM_DATA_TAG} (ProgramData)`);
  }
  const modifySlot = data.readBigUInt64LE(4);
  const option = data.readUInt8(12);
  const authority = option === 1 ? new PublicKey(data.subarray(13, 45)).toBase58() : null;
  return { tag, modifySlot, option, authority, elfBytes: data.subarray(PROGRAM_DATA_FIXED_LEN) };
}

function isZeroKey(pk) {
  return pk.toBase58() === ZERO_KEY || pk.toBytes().every((b) => b === 0);
}

// ------------------------------------------------------------ check core

function makeChecks() {
  const checks = [];
  const add = (id, title, status, detail, observed = null) => {
    checks.push({ id, title, status, detail, observed });
  };
  return { checks, add };
}

async function verifyProgramChainState(program, endpoint, fetchImpl, ctx, add, manifest) {
  const isScanner = program === "scanner";
  const programId = isScanner ? NS3.scannerProgramId : NS3.vaultProgramId;
  const prefix = isScanner ? "scanner" : "vault";

  // ---- A: program account + ProgramData + upgrade authority
  // Exactly ONE of the following outcomes is reported per check id:
  // a fetch outcome (PASS/FAIL/UNVERIFIED) or a decode outcome — never both.
  const A_TITLE = "program account present/executable/loader-owned";
  const AUTH_TITLE = "upgrade authority (decoded from the real ProgramData) == NS-3 deployer";
  let programAcct = null;
  let programAcctReported = false;
  let programdataAddress = null;
  try {
    programAcct = await fetchAccountInfo(endpoint, programId, fetchImpl, ctx);
  } catch (err) {
    programAcctReported = true;
    if (err instanceof RpcUnverified) {
      add(`A:${prefix}:program-account`, A_TITLE, "UNVERIFIED", err.message);
    } else {
      add(`A:${prefix}:program-account`, A_TITLE, "FAIL", `present but malformed: ${err.message}`);
    }
  }
  if (programAcct === null && !programAcctReported) {
    programAcctReported = true;
    add(
      `A:${prefix}:program-account`,
      A_TITLE,
      "FAIL",
      `no account exists at the NS-3 ${program} program ID ${programId} — deployment not performed (or wrong cluster)`,
    );
  }
  if (programAcct !== null && !programAcctReported) {
    const ownerOk = programAcct.owner === BPF_LOADER_UPGRADEABLE;
    let relation = null;
    let relationErr = null;
    try {
      relation = decodeProgramAccount(programAcct.data);
      programdataAddress = relation.programdataAddress;
    } catch (err) {
      relationErr = err.message;
    }
    if (ownerOk && programAcct.executable && relation) {
      add(
        `A:${prefix}:program-account`,
        "program account present/executable/loader-owned",
        "PASS",
        `owner ${programAcct.owner}, executable, ${programAcct.data.length} B, Program tag; embeds ProgramData ${programdataAddress}`,
        {
          programId,
          owner: programAcct.owner,
          executable: true,
          programdataAddress,
          lamports: programAcct.lamports,
        },
      );
    } else {
      add(
        `A:${prefix}:program-account`,
        "program account present/executable/loader-owned",
        "FAIL",
        `owner=${programAcct.owner} (want ${BPF_LOADER_UPGRADEABLE}), executable=${programAcct.executable}, ` +
          (relationErr ? `data does not decode as a Program account: ${relationErr}` : "ok"),
        { programId, owner: programAcct.owner, executable: programAcct.executable },
      );
    }

    // ProgramData + REAL upgrade-authority decode (never inferred from a
    // config account). If the program account was too malformed to yield a
    // ProgramData address, the authority check is reported UNVERIFIED —
    // it could not run — rather than silently skipped.
    let programdata = null;
    let authReported = false;
    if (programdataAddress === null) {
      add(
        `A:${prefix}:upgrade-authority`,
        AUTH_TITLE,
        "UNVERIFIED",
        "program account data did not decode to an embedded ProgramData address — authority readback could not run",
      );
      authReported = true;
    } else {
      try {
        programdata = await fetchAccountInfo(endpoint, programdataAddress, fetchImpl, ctx);
      } catch (err) {
        authReported = true;
        if (err instanceof RpcUnverified) {
          add(`A:${prefix}:upgrade-authority`, AUTH_TITLE, "UNVERIFIED", err.message);
        } else {
          add(`A:${prefix}:upgrade-authority`, AUTH_TITLE, "FAIL", err.message);
        }
      }
      if (programdata === null && !authReported) {
        authReported = true;
        add(
          `A:${prefix}:upgrade-authority`,
          AUTH_TITLE,
          "FAIL",
          `the program account embeds ProgramData ${programdataAddress} but no account exists there`,
          { programdataAddress },
        );
      }
    }
    if (programdata && !authReported) {
      try {
        const decoded = decodeProgramDataAccount(programdata.data);
        const authOk = decoded.option === 1 && decoded.authority === NS3.deployer;
        add(
          `A:${prefix}:upgrade-authority`,
          "upgrade authority (decoded from the real ProgramData) == NS-3 deployer",
          authOk ? "PASS" : "FAIL",
          authOk
            ? `ProgramData ${programdataAddress} (owner ${programdata.owner}) decodes with authority ${decoded.authority} == NS-3 deployer`
            : `ProgramData ${programdataAddress} decodes authority ${decoded.authority ?? "<none — authority option cleared>"} != NS-3 deployer ${NS3.deployer}`,
          {
            programdataAddress,
            upgradeAuthority: decoded.authority,
            modifySlot: decoded.modifySlot.toString(),
          },
        );
        ctx.elfBytes[prefix] = decoded.elfBytes;
        ctx.programData[prefix] = {
          address: programdataAddress,
          ...pickDefined({
            upgradeAuthority: decoded.authority,
            modifySlot: decoded.modifySlot.toString(),
          }),
        };
      } catch (err) {
        add(
          `A:${prefix}:upgrade-authority`,
          "upgrade authority (decoded from the real ProgramData) == NS-3 deployer",
          "FAIL",
          err.message,
        );
      }
    }
  }

  // ---- B: ProtocolConfig (independently re-derived PDA)
  const [derivedPda, derivedBump] = configPdaWithBump(new PublicKey(programId));
  const expectedPda = isScanner ? NS3_PDAS.scannerConfigPda : NS3_PDAS.vaultConfigPda;
  const pdaOk = derivedPda.toBase58() === expectedPda;
  add(
    `B:${prefix}:pda-derivation`,
    "ProtocolConfig PDA re-derived from the program ID == expected NS-3 PDA",
    pdaOk ? "PASS" : "FAIL",
    pdaOk
      ? `['protocol_config'] under ${programId} → ${derivedPda.toBase58()} (bump ${derivedBump}) == expected ${expectedPda}`
      : `derived ${derivedPda.toBase58()} != expected ${expectedPda} — the pinned NS-3 PDA vector is not the honest derivation`,
    { derivedPda: derivedPda.toBase58(), bump: derivedBump, expectedPda },
  );

  let cfgAcct = null;
  let cfgFetchReported = false;
  try {
    cfgAcct = await fetchAccountInfo(endpoint, expectedPda, fetchImpl, ctx);
  } catch (err) {
    cfgFetchReported = true;
    if (err instanceof RpcUnverified) {
      add(
        `B:${prefix}:config-account`,
        "ProtocolConfig present at the expected PDA, program-owned, discriminator valid",
        "UNVERIFIED",
        err.message,
      );
    } else {
      add(
        `B:${prefix}:config-account`,
        "ProtocolConfig present at the expected PDA, program-owned, discriminator valid",
        "FAIL",
        err.message,
      );
    }
  }
  if (cfgAcct === null && !cfgFetchReported) {
    add(
      `B:${prefix}:config-account`,
      "ProtocolConfig present at the expected PDA, program-owned, discriminator valid",
      "FAIL",
      `no account exists at the expected PDA ${expectedPda} — initialize not performed`,
    );
  }
  if (cfgAcct !== null) {
    const ownerOk = cfgAcct.owner === programId;
    const discOk =
      cfgAcct.data.length >= 8 &&
      Buffer.compare(cfgAcct.data.subarray(0, 8), PROTOCOL_CONFIG_DISCRIMINATOR) === 0;
    const structuralOk = ownerOk && discOk;
    add(
      `B:${prefix}:config-account`,
      "ProtocolConfig present at the expected PDA, program-owned, discriminator valid",
      structuralOk ? "PASS" : "FAIL",
      structuralOk
        ? `owner ${cfgAcct.owner} == program ID; discriminator matches sha256("account:ProtocolConfig")[0..8]; ${cfgAcct.data.length} B`
        : `owner=${cfgAcct.owner} (want ${programId}); discriminator ${discOk ? "matches" : "MISMATCH — not a ProtocolConfig account"}; ${cfgAcct.data.length} B`,
      { configPda: expectedPda, owner: cfgAcct.owner },
    );

    if (structuralOk) {
      try {
        const cfg = decodeProtocolConfig(program, Buffer.from(cfgAcct.data));
        ctx.configs[prefix] = cfg;

        // authority == governance
        const authOk = cfg.authority.toBase58() === NS3.governanceAuthority;
        add(
          `B:${prefix}:authority`,
          "ProtocolConfig authority == NS-3 governance authority",
          authOk ? "PASS" : "FAIL",
          `authority ${cfg.authority.toBase58()} ${authOk ? "==" : "!="} governance ${NS3.governanceAuthority}`,
          { authority: cfg.authority.toBase58() },
        );

        // config values == approved initialization defaults
        const defaults = isScanner ? SCANNER_DEFAULTS : VAULT_DEFAULTS;
        const drift = [];
        const observedValues = {};
        for (const [field, want] of Object.entries(defaults)) {
          const got = cfg[field];
          const gotStr = typeof got === "bigint" ? got.toString() : String(got);
          const wantStr = typeof want === "bigint" ? want.toString() : String(want);
          observedValues[field] = gotStr;
          if (gotStr !== wantStr) drift.push(`${field}=${gotStr} (approved default ${wantStr})`);
        }
        add(
          `B:${prefix}:defaults`,
          "config values match the approved NS-3 initialization defaults",
          drift.length === 0 ? "PASS" : "FAIL",
          drift.length === 0
            ? `all ${Object.keys(defaults).length} governed values equal the approved defaults (zero-param initialize)`
            : `drifted from the approved defaults: ${drift.join("; ")}`,
          observedValues,
        );

        // pending authority: report + require zeroed (an in-flight rotation
        // is not the approved acceptance state). Honest note: the
        // pending-authority/eta/timelock fields are reserved state, NOT an
        // enforced transfer or timelock mechanism (docs/DEVNET.md).
        const pendingZero = isZeroKey(cfg.pendingAuthority);
        add(
          `B:${prefix}:pending-authority`,
          "pending_authority zeroed (no in-flight rotation)",
          pendingZero ? "PASS" : "FAIL",
          pendingZero
            ? "pending_authority is the zero key (and note: pending/eta/timelock fields are reserved write-only state, not enforced mechanisms)"
            : `pending_authority is ${cfg.pendingAuthority.toBase58()} — an authority rotation is in flight; not the approved acceptance state`,
          { pendingAuthority: cfg.pendingAuthority.toBase58() },
        );
      } catch (err) {
        add(
          `B:${prefix}:decode`,
          "ProtocolConfig decodes per the current schema",
          "FAIL",
          err.message,
        );
      }
    }
  }

  // ---- C: dedicated oracle signers (scanner only — vault has none)
  if (isScanner && ctx.configs.scanner) {
    const cfg = ctx.configs.scanner;
    const activityOk = cfg.activityOracle.toBase58() === NS3.activityOracle;
    const launchOk = cfg.launchPriceOracle.toBase58() === NS3.launchPriceOracle;
    add(
      "C:activity-oracle",
      "activity oracle == dedicated NS-3 activity key (not the initialization authority)",
      activityOk ? "PASS" : "FAIL",
      `activity_oracle ${cfg.activityOracle.toBase58()} ${activityOk ? "==" : "!="} dedicated ${NS3.activityOracle}` +
        ` (governance ${NS3.governanceAuthority}, deployer ${NS3.deployer} — the fields START at the authority at initialize; acceptance requires the dedicated keys)`,
      { activityOracle: cfg.activityOracle.toBase58() },
    );
    add(
      "C:launch-price-oracle",
      "launch-price oracle == dedicated NS-3 launch-price key (not the initialization authority)",
      launchOk ? "PASS" : "FAIL",
      `launch_price_oracle ${cfg.launchPriceOracle.toBase58()} ${launchOk ? "==" : "!="} dedicated ${NS3.launchPriceOracle}` +
        ` (governance ${NS3.governanceAuthority}, deployer ${NS3.deployer})`,
      { launchPriceOracle: cfg.launchPriceOracle.toBase58() },
    );
  }

  // ---- D: emergency state — report the ACTUAL decoded flags
  if (ctx.configs[prefix]) {
    const cfg = ctx.configs[prefix];
    const paused = isScanner ? cfg.paused : cfg.emergencyPaused;
    const field = isScanner ? "paused" : "emergency_paused";
    add(
      `D:${prefix}:not-paused`,
      `${program} emergency state reported and unpaused`,
      paused === false ? "PASS" : "FAIL",
      `${field} = ${paused} (actual decoded on-chain value)${paused ? " — the program IS paused; acceptance requires unpaused" : ""}`,
      { [field]: paused },
    );
  }

  // ---- E: deployed-byte identity (digest vs shared manifest + legacy scan)
  const elfBytes = ctx.elfBytes[prefix];
  if (!elfBytes) {
    add(
      `E:${prefix}:deployed-digest`,
      "deployed ELF bytes SHA-256 == approved provenance manifest digest",
      "UNVERIFIED",
      "deployed bytes unavailable (program/ProgramData account missing or RPC failure)",
    );
    add(
      `E:${prefix}:legacy-scan`,
      "no NS-1/NS-2 program-ID residue in the deployed bytes",
      "UNVERIFIED",
      "deployed bytes unavailable (program/ProgramData account missing or RPC failure)",
    );
  } else {
    if (manifest) {
      const entry = manifest.elfs?.[prefix];
      const got = createHash("sha256").update(elfBytes).digest("hex");
      const digestOk = !!entry && got === entry.sha256;
      add(
        `E:${prefix}:deployed-digest`,
        "deployed ELF bytes SHA-256 == approved provenance manifest digest",
        digestOk ? "PASS" : "FAIL",
        digestOk
          ? `on-chain ${prefix} ELF (${elfBytes.length} B) hashes to the manifest digest ${got} — deployed bytes ARE the approved NS-3 provenance`
          : `on-chain ${prefix} ELF sha256 ${got} != manifest ${entry?.sha256 ?? "<manifest has no scanner/vault entry>"} — deployed bytes are NOT the approved provenance`,
        { sha256: got, bytes: elfBytes.length },
      );
    } else {
      add(
        `E:${prefix}:deployed-digest`,
        "deployed ELF bytes SHA-256 == approved provenance manifest digest",
        "UNVERIFIED",
        `manifest unreadable (${ctx.manifestError ?? "not found"}) — byte-identity against the approved provenance could not be established`,
      );
    }
    const residue = [];
    for (const legacy of LEGACY_ID_BYTES) {
      if (elfBytes.indexOf(legacy.bytes) !== -1) residue.push(legacy.name);
    }
    add(
      `E:${prefix}:legacy-scan`,
      "no NS-1/NS-2 program-ID residue in the deployed bytes",
      residue.length === 0 ? "PASS" : "FAIL",
      residue.length === 0
        ? `none of the ${LEGACY_ID_BYTES.length} legacy NS-1/NS-2 ID byte sequences occur in the deployed ${prefix} ELF (${elfBytes.length} B)`
        : `legacy ID bytes found in the deployed ${prefix} ELF: ${residue.join(", ")}`,
    );
  }
}

function pickDefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * Run the full read-only verification. Pure-ish: performs only RPC reads
 * via fetchImpl and one local manifest read. Returns the full report
 * object (also used by the test suite).
 */
export async function runVerification({
  url,
  fetchImpl = globalThis.fetch,
  manifestPath = DEFAULT_MANIFEST_PATH,
}) {
  if (!url)
    throw new Error("an explicit --url RPC endpoint is required (no default endpoint is guessed)");
  const ctx = { slots: new Set(), elfBytes: {}, configs: {}, programData: {}, manifestError: null };
  const { checks, add } = makeChecks();

  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    ctx.manifestError = err.message;
  }

  let clusterSlot = null;
  let slotReported = false;
  try {
    clusterSlot = await rpcCall(url, "getSlot", [], fetchImpl);
    if (typeof clusterSlot === "number") ctx.slots.add(clusterSlot);
  } catch (err) {
    slotReported = true;
    add("Z:rpc-context", "RPC reachable (getSlot)", "UNVERIFIED", err.message);
  }
  if (!slotReported) {
    if (typeof clusterSlot !== "number") {
      add("Z:rpc-context", "RPC reachable (getSlot)", "UNVERIFIED", "getSlot returned no slot");
    } else {
      add(
        "Z:rpc-context",
        "RPC reachable (getSlot)",
        "PASS",
        `endpoint reachable; observed slot ${clusterSlot}`,
        { slot: clusterSlot },
      );
    }
  }

  await verifyProgramChainState("scanner", url, fetchImpl, ctx, add, manifest);
  await verifyProgramChainState("vault", url, fetchImpl, ctx, add, manifest);

  const failed = checks.filter((c) => c.status === "FAIL");
  const unverified = checks.filter((c) => c.status === "UNVERIFIED");
  const overall = failed.length > 0 ? "FAIL" : unverified.length > 0 ? "UNVERIFIED" : "PASS";
  return {
    overall,
    exitCode: overall === "PASS" ? 0 : overall === "FAIL" ? 1 : 2,
    url,
    slot: clusterSlot,
    slotsObserved: [...ctx.slots].sort((a, b) => a - b),
    manifestRead: manifest !== null,
    summary: {
      pass: checks.length - failed.length - unverified.length,
      fail: failed.length,
      unverified: unverified.length,
    },
    checks,
    observed: {
      identities: NS3,
      expectedPdas: NS3_PDAS,
      programData: ctx.programData,
      configs: {
        scanner: ctx.configs.scanner ? summarizeConfig("scanner", ctx.configs.scanner) : null,
        vault: ctx.configs.vault ? summarizeConfig("vault", ctx.configs.vault) : null,
      },
    },
  };
}

function summarizeConfig(program, cfg) {
  const out = {
    authority: cfg.authority.toBase58(),
    pendingAuthority: cfg.pendingAuthority.toBase58(),
  };
  const defaults = program === "scanner" ? SCANNER_DEFAULTS : VAULT_DEFAULTS;
  for (const field of Object.keys(defaults)) {
    const v = cfg[field];
    out[field] = typeof v === "bigint" ? v.toString() : v;
  }
  if (program === "scanner") {
    out.activityOracle = cfg.activityOracle.toBase58();
    out.launchPriceOracle = cfg.launchPriceOracle.toBase58();
  }
  return out;
}

// ------------------------------------------------------------- reporting

function renderReport(report) {
  const lines = [];
  lines.push("NS-3 deployment acceptance verification — STRICTLY READ-ONLY");
  lines.push(`  endpoint: ${report.url}`);
  lines.push(`  slot:     ${report.slot ?? "<unavailable>"}`);
  lines.push(
    `  checks:   ${report.summary.pass} PASS / ${report.summary.fail} FAIL / ${report.summary.unverified} UNVERIFIED`,
  );
  lines.push("");
  for (const c of report.checks) {
    lines.push(`  [${c.status.padEnd(10)}] ${c.id} — ${c.title}`);
    lines.push(`               ${c.detail}`);
  }
  lines.push("");
  if (report.overall === "PASS") {
    lines.push("OVERALL RESULT: PASS — the observed on-chain state matches the approved NS-3");
    lines.push("acceptance state (programs + ProgramData upgrade authorities + configs at the");
    lines.push("expected PDAs with governance authority and approved defaults, dedicated oracle");
    lines.push("signers, both unpaused, deployed bytes hash to the approved provenance).");
  } else if (report.overall === "FAIL") {
    lines.push(
      `OVERALL RESULT: FAIL — ${report.summary.fail} check(s) observed on-chain state that`,
    );
    lines.push(
      "contradicts NS-3 acceptance. This is deployment evidence; see the FAIL details above.",
    );
  } else {
    lines.push(
      `OVERALL RESULT: UNVERIFIED — ${report.summary.unverified} check(s) could not run (RPC/manifest`,
    );
    lines.push(
      "failure). An RPC failure is NOT evidence that the deployment is invalid, but it blocks",
    );
    lines.push(
      "the overall PASS: re-run against a healthy endpoint before accepting the deployment.",
    );
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) {
    console.error("usage: verify_ns3_deployment.mjs --url <RPC_ENDPOINT> [--json]");
    console.error("  the RPC endpoint is required and explicit; this tool is strictly read-only");
    console.error(
      "  (no signers, no keypairs, no wallets, no transactions — getAccountInfo/getSlot only)",
    );
    process.exit(3);
  }
  const report = await runVerification({
    url: args.url,
    manifestPath: args.manifest ?? DEFAULT_MANIFEST_PATH,
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
  }
  process.exit(report.exitCode);
}

// CLI entry only — the module is also imported by the test suite.
if (process.argv[1] && process.argv[1].endsWith("verify_ns3_deployment.mjs")) {
  await main();
}
