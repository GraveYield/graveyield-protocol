// SPDX-License-Identifier: Apache-2.0
//
// verify_ns3_elf_digests.test.mjs — offline tests for the read-only
// deployed-ELF digest verifier.
//
// EVERY test runs fully offline: the cluster is a local JSON-RPC mock
// (node:http) serving getAccountInfo / getEpochInfo / getGenesisHash
// responses built from the real byte layouts (provenance_fixtures.mjs),
// and the expected digests come from a temp-file provenance manifest that
// passes the REAL loadProvenanceManifest validation. Nothing contacts a
// public cluster, no keypair material exists anywhere, and no account is
// ever initialized: absence and malformation are exercised as they must
// be judged on-chain — as definitive FAILs.
//
// What the suite pins (mapped to the required coverage list):
//   ✔ correct Scanner / Vault program + ProgramData accounts → overall PASS
//   ✔ metadata parsing, payload extraction, 45/13 B structural boundary
//   ✔ successful Scanner and Vault digest matches (observed == pin)
//   ✖ digest mismatch → FAIL with observed vs expected
//   ✖ missing program account / missing ProgramData → FAIL (never a
//     digest match, never a pass)
//   ✖ wrong program owner / wrong ProgramData owner / wrong embedded
//     pointer / malformed accounts → FAIL cascades
//   ✖ missing or malformed upgrade authority → distinct FAIL conditions
//   ✖ invalid / truncated ELF, unsupported SBPF architecture → FAIL
//   ✖ RPC transport failure → UNVERIFIED → overall INCOMPLETE (and FAIL
//     precedence over INCOMPLETE)
//   ✔ JSON and human output shapes are consistent across evidence paths
//   ✔ no false PASS when parsing fails (digest_match stays null)
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PublicKey } from "@solana/web3.js";

const execFileP = promisify(execFile);

import { BPF_LOADER_UPGRADEABLE, DEVNET_GENESIS_HASH } from "../verify_ns3_deployment.mjs";
import {
  PROGRAMDATA_METADATA_LEN,
  TOOL_NAME,
  elfDeclaredSize,
  extractElfPayload,
  runElfDigestVerification,
} from "../verify_ns3_elf_digests.mjs";
import { DEFAULT_MANIFEST_PATH, loadProvenanceManifest } from "../ns3_check_provenance.mjs";
import { NS3, programDataPda } from "../ns3_identities.mjs";
import {
  buildSbfElf,
  encodeProgramAccount,
  encodeProgramDataAccount,
  rpcAccount,
  sha256,
} from "./helpers/provenance_fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "..", "verify_ns3_elf_digests.mjs");

const LOADER = new PublicKey(BPF_LOADER_UPGRADEABLE);
const SLOT = 519_265_000;
// The W2 evidence (docs/w2-ns3-acceptance/elf_digest_check.json) recorded
// these derived ProgramData addresses — pinned here as cross-check vectors
// for the identity module's derivation (Suite B).
const W2_RECORDED_PD = {
  scanner: "FxYDhTruh16EoKBgiJaWZCQ9QojWQZGS8J1dXyfSt9dG",
  vault: "9wyRhAC8Sasb46bhWW4jxsK6rGKpEGXf6Riz2ibKZgC4",
};
// The approved digests (docs/DEVNET.md § provenance; the handoff pins).
const APPROVED_DIGESTS = {
  grave_scanner: "e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98",
  grave_vault: "8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83",
};

// ------------------------------------------------------------ fixtures

const PD_SCANNER = programDataPda(new PublicKey(NS3.scannerProgramId)).toBase58();
const PD_VAULT = programDataPda(new PublicKey(NS3.vaultProgramId)).toBase58();

function pdB58(programIdB58) {
  return programDataPda(new PublicKey(programIdB58)).toBase58();
}

/** A structurally valid SBPF v0 ELF carrying the program's own ID. */
function goodElf(programIdB58) {
  return buildSbfElf({ idBase58: programIdB58 });
}

/** ProgramData bytes as current agave writes them: 45 B metadata + ELF. */
function programDataWithAuthority(authorityB58, elf) {
  return Buffer.concat([
    encodeProgramDataAccount({ slot: BigInt(SLOT), authority: authorityB58 }),
    elf,
  ]);
}

/** Authority-None ProgramData: 13 B metadata (no authority bytes) + ELF. */
function programDataWithoutAuthority(elf) {
  return Buffer.concat([
    encodeProgramDataAccount({ slot: BigInt(SLOT), authority: null }).subarray(0, 13),
    elf,
  ]);
}

/** The legacy bincode layout (u32 authority tag → 48 B metadata) + ELF. */
function legacyLayoutProgramData(authorityB58, elf) {
  const legacy = Buffer.alloc(48);
  legacy.writeUInt32LE(3, 0);
  legacy.writeBigUInt64LE(BigInt(SLOT), 4);
  legacy.writeUInt32LE(1, 12); // legacy u32 Option tag
  Buffer.from(new PublicKey(authorityB58).toBytes()).copy(legacy, 16);
  return Buffer.concat([legacy, elf]);
}

/** A full temp-file manifest that passes the REAL manifest validation. */
function writeTempManifest({ scannerSha, vaultSha }) {
  const dir = mkdtempSync(path.join(tmpdir(), "gy-elf-digest-test-"));
  const manifestPath = path.join(dir, "provenance.manifest.json");
  const manifest = {
    schema: "graveyield.provenance/1",
    note: ["test-injected provenance manifest (temp file); digests = fixture digests"],
    programs: {
      grave_scanner: { artifact: "target/deploy/grave_scanner.so", sha256: scannerSha },
      grave_vault: { artifact: "target/deploy/grave_vault.so", sha256: vaultSha },
    },
    toolchain: {
      sbpf_arch: "v0",
      elf: { e_machine: 263, e_flags: 0 },
      solana_cli: "3.0.10",
      platform_tools: {
        version: "1.54",
        sha256: "f".repeat(64),
        url: "https://example.invalid/platform-tools-linux-x86_64.tar.bz2",
      },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build the mock-cluster state for a scenario. Default: both programs
 * deployed exactly as approved (45 B metadata, deployer authority, SBPF v0
 * ELFs carrying their own IDs).
 */
function fullState(overrides = {}) {
  const scannerElf = overrides.scannerElf ?? goodElf(NS3.scannerProgramId);
  const vaultElf = overrides.vaultElf ?? goodElf(NS3.vaultProgramId);
  const accounts = {
    [NS3.scannerProgramId]: rpcAccount(encodeProgramAccount(PD_SCANNER), {
      owner: LOADER,
      executable: true,
      lamports: 833_120,
    }),
    [PD_SCANNER]: rpcAccount(
      overrides.scannerProgramData ?? programDataWithAuthority(NS3.deployer, scannerElf),
      { owner: LOADER, lamports: 1_869_627_960 },
    ),
    [NS3.vaultProgramId]: rpcAccount(encodeProgramAccount(PD_VAULT), {
      owner: LOADER,
      executable: true,
      lamports: 833_120,
    }),
    [PD_VAULT]: rpcAccount(
      overrides.vaultProgramData ?? programDataWithAuthority(NS3.deployer, vaultElf),
      { owner: LOADER, lamports: 2_069_373_560 },
    ),
  };
  return {
    accounts: overrides.delete ? omitKeys(accounts, overrides.delete) : accounts,
    genesisHash: overrides.genesisHash ?? DEVNET_GENESIS_HASH,
    failWhere: overrides.failWhere ?? null, // (method, params) => true destroys the connection
    fixtureDigests: { scanner: sha256(scannerElf), vault: sha256(vaultElf) },
  };
}

function omitKeys(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

// --------------------------------------------------- mock RPC harness

function handleRpc(req, state) {
  const value = state.accounts[req.params?.[0]] ?? null;
  switch (req.method) {
    case "getAccountInfo":
      return { jsonrpc: "2.0", id: req.id, result: { context: { slot: SLOT }, value } };
    case "getEpochInfo":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: { absoluteSlot: SLOT, blockHeight: SLOT - 200, epoch: 1202, slotIndex: 345 },
      };
    case "getGenesisHash":
      return { jsonrpc: "2.0", id: req.id, result: state.genesisHash };
    case "getVersion":
      return { jsonrpc: "2.0", id: req.id, result: { "solana-core": "3.0.10" } };
    default:
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `method not found: ${req.method}` },
      };
  }
}

/** Start the mock RPC, run fn(url), then clean up server + temp manifest. */
async function withVerification(state, fn) {
  const { manifestPath, cleanup } = writeTempManifest({
    scannerSha: state.fixtureDigests.scanner,
    vaultSha: state.fixtureDigests.vault,
  });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (state.failWhere) {
        let payload;
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          res.destroy();
          return;
        }
        const batch = Array.isArray(payload) ? payload : [payload];
        if (batch.some((r) => state.failWhere(r.method, r.params))) {
          res.destroy(); // transport failure for the matching request ONLY
          return;
        }
      }
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.destroy();
        return;
      }
      const batch = Array.isArray(payload) ? payload : [payload];
      const results = batch.map((r) => handleRpc(r, state));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ url, manifestPath });
  } finally {
    server.close();
    cleanup();
  }
}

function run(state, overrides = {}) {
  return withVerification(state, ({ url, manifestPath }) =>
    runElfDigestVerification({
      url,
      manifestPath,
      manifestLabel: "test-injected provenance manifest",
      ...overrides,
    }),
  );
}

async function runCli(url, args = []) {
  try {
    const { stdout } = await execFileP("node", [TOOL, "--url", url, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.status ?? err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err),
    };
  }
}

const checkOf = (result, idPrefix) => result.checks.filter((c) => c.id.startsWith(idPrefix));

// -------------------------------------------------------------- suites

describe("ELF payload extraction (structural boundary, never a blind offset)", () => {
  test("authority present → 45 B metadata boundary; metadata never enters the payload", () => {
    const elf = goodElf(NS3.scannerProgramId);
    const data = programDataWithAuthority(NS3.deployer, elf);
    const x = extractElfPayload(data);
    assert.equal(x.authoritySet, true);
    assert.equal(x.authority.toBase58(), NS3.deployer);
    assert.equal(x.metadataLen, PROGRAMDATA_METADATA_LEN.withAuthority);
    assert.equal(x.metadataLen, 45);
    assert.equal(x.payload.length, data.length - 45);
    assert.deepEqual(Buffer.from(x.payload), elf);
    assert.equal(x.payload[0], 0x7f);
  });

  test("authority None → 13 B metadata boundary (payload starts immediately after)", () => {
    const elf = goodElf(NS3.vaultProgramId);
    const data = programDataWithoutAuthority(elf);
    const x = extractElfPayload(data);
    assert.equal(x.authoritySet, false);
    assert.equal(x.metadataLen, PROGRAMDATA_METADATA_LEN.withoutAuthority);
    assert.equal(x.metadataLen, 13);
    assert.deepEqual(Buffer.from(x.payload), elf);
  });

  test("legacy bincode layout (48 B, u32 authority tag) → FAILS CLOSED with a precise report, boundary NOT shifted", () => {
    const elf = goodElf(NS3.scannerProgramId);
    const data = legacyLayoutProgramData(NS3.deployer, elf);
    assert.throws(
      () => extractElfPayload(data),
      (err) => {
        assert.match(err.message, /no ELF magic at the structural payload boundary \(offset 45/);
        assert.match(err.message, /LEGACY bincode ProgramData layout/);
        assert.match(err.message, /NOT shifted/);
        return true;
      },
    );
  });

  test("junk payload (no ELF magic anywhere) → FAILS CLOSED, no legacy hint", () => {
    const junk = Buffer.alloc(64, 0x41);
    const data = programDataWithAuthority(NS3.deployer, junk);
    assert.throws(() => extractElfPayload(data), /no ELF magic at the structural payload boundary/);
    try {
      extractElfPayload(data);
    } catch (err) {
      assert.doesNotMatch(err.message, /LEGACY bincode/);
    }
  });

  test("empty payload after metadata → FAILS CLOSED", () => {
    const bare = encodeProgramDataAccount({ slot: 1n, authority: NS3.deployer });
    assert.throws(() => extractElfPayload(bare), /no ELF payload to hash/);
  });
});

describe("ELF declared size (hash span from the ELF's own structure)", () => {
  test("exact fit: declared size == payload length for a well-formed ELF", () => {
    const elf = goodElf(NS3.scannerProgramId);
    assert.equal(elfDeclaredSize(elf), elf.length);
  });

  test("zero loader padding beyond the declared ELF end is tolerated (span excludes it)", () => {
    const elf = goodElf(NS3.vaultProgramId);
    const padded = Buffer.concat([elf, Buffer.alloc(512, 0)]);
    assert.equal(elfDeclaredSize(padded), elf.length);
  });

  test("truncated payload (declared size beyond available bytes) → FAILS CLOSED", () => {
    const elf = goodElf(NS3.scannerProgramId);
    const cut = elf.subarray(0, elf.length - 40);
    assert.throws(() => elfDeclaredSize(cut), /truncated payload/);
  });

  test("stripped section table (e_shoff=0) → span undeterminable → FAILS CLOSED", () => {
    const elf = goodElf(NS3.scannerProgramId);
    elf.writeBigUInt64LE(0n, 40);
    assert.throws(() => elfDeclaredSize(elf), /section header table/);
  });
});

describe("Suite B — repository-constant cross-checks", () => {
  test("loader-derived ProgramData addresses reproduce the W2-recorded derivations", () => {
    assert.equal(pdB58(NS3.scannerProgramId), W2_RECORDED_PD.scanner);
    assert.equal(pdB58(NS3.vaultProgramId), W2_RECORDED_PD.vault);
  });

  test("the committed provenance manifest loads and pins EXACTLY the approved digests + SBPF v0", () => {
    const m = loadProvenanceManifest(DEFAULT_MANIFEST_PATH);
    assert.equal(m.schema, "graveyield.provenance/1");
    assert.equal(m.programs.grave_scanner.sha256, APPROVED_DIGESTS.grave_scanner);
    assert.equal(m.programs.grave_vault.sha256, APPROVED_DIGESTS.grave_vault);
    assert.equal(m.toolchain.sbpf_arch, "v0");
    assert.deepEqual(m.toolchain.elf, { e_machine: 263, e_flags: 0 });
  });
});

describe("deployed-ELF digest verification — mock RPC battery", () => {
  test("1. all-good chain state → overall PASS; both digests match; boundary + arch + identity all PASS", async () => {
    const state = fullState();
    const r = await run(state);
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    assert.equal(r.counts.fail, 0);
    assert.equal(r.counts.unverified, 0);
    assert.equal(r.context.genesisHash, DEVNET_GENESIS_HASH);
    for (const p of r.programs) {
      assert.equal(p.program_account.exists, true);
      assert.equal(p.program_account.executable, true);
      assert.equal(p.program_account.owner, BPF_LOADER_UPGRADEABLE);
      assert.equal(p.pointer_match, true);
      assert.equal(p.programdata.exists, true);
      assert.equal(p.programdata.state_valid, true);
      assert.equal(p.programdata.upgrade_authority.status, "MATCH");
      assert.equal(p.programdata.upgrade_authority.address, NS3.deployer);
      assert.equal(p.elf.extraction, "OK");
      assert.equal(p.elf.payload_offset, 45);
      assert.equal(p.elf.declared_elf_size, p.elf.payload_size);
      assert.equal(p.elf.structure_valid, true);
      assert.match(p.elf.sbpf_arch, /v0/);
      assert.equal(p.elf.sbpf_valid, true);
      assert.equal(p.elf.identity_verdict, "structural");
      assert.equal(p.elf.digest_match, true);
    }
    const scanner = r.programs[0];
    const vault = r.programs[1];
    assert.equal(scanner.elf.observed_sha256, state.fixtureDigests.scanner);
    assert.equal(vault.elf.observed_sha256, state.fixtureDigests.vault);
    assert.equal(scanner.elf.expected_sha256, state.fixtureDigests.scanner);
    assert.equal(vault.elf.expected_sha256, state.fixtureDigests.vault);
    // Every check ran and passed: 1 genesis + 13 per program.
    assert.equal(r.checks.length, 27);
    assert.equal(r.counts.pass, 27);
  });

  test("2. digest mismatch (on-chain bytes differ from the manifest pin) → FAIL with observed vs expected", async () => {
    // fullState() serves the ORIGINAL scanner ELF on chain; the injected
    // manifest pins a DIFFERENT valid ELF's digest → observed != expected.
    const state = fullState();
    const other = goodElf(NS3.scannerProgramId);
    other.writeUInt32LE(0xdeadbeef, 96); // changes bytes AND the digest
    state.fixtureDigests.scanner = sha256(other);
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const digestChecks = checkOf(r, "C3 scanner");
    assert.equal(digestChecks.length, 1);
    assert.equal(digestChecks[0].status, "FAIL");
    assert.match(digestChecks[0].detail, /MISMATCH/);
    assert.match(digestChecks[0].detail, /manifest pins/);
    const scanner = r.programs[0];
    assert.equal(scanner.elf.digest_match, false);
    assert.notEqual(scanner.elf.observed_sha256, scanner.elf.expected_sha256);
    // The mismatch is about scanner only; vault still verifies.
    assert.equal(r.programs[1].elf.digest_match, true);
  });

  test("3. missing program account → FAIL cascade; NO digest match is ever claimed", async () => {
    const state = fullState({ delete: [NS3.scannerProgramId] });
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const exists = checkOf(r, "A1 scanner");
    assert.equal(exists[0].status, "FAIL");
    assert.match(exists[0].detail, /NOT deployed/);
    const scanner = r.programs[0];
    assert.equal(scanner.program_account.exists, false);
    assert.equal(scanner.elf.extraction, "NOT_ATTEMPTED");
    assert.equal(scanner.elf.observed_sha256, null);
    assert.equal(scanner.elf.digest_match, null);
    // All 13 scanner checks ran as FAILs — none skipped, none verified.
    for (const id of [
      "A1",
      "A2",
      "A3",
      "A4",
      "B1",
      "B2",
      "B3",
      "B4",
      "C1",
      "C2",
      "C3",
      "C4",
      "C5",
    ]) {
      const c = checkOf(r, `${id} scanner`);
      assert.equal(c.length, 1, `missing check ${id} scanner`);
      assert.equal(c[0].status, "FAIL", `${id} scanner should FAIL on a missing program account`);
    }
  });

  test("4. missing ProgramData account (derived address, nothing deployed) → FAIL, never a digest match", async () => {
    const state = fullState({ delete: [PD_SCANNER] });
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const b1 = checkOf(r, "B1 scanner");
    assert.equal(b1[0].status, "FAIL");
    assert.match(b1[0].detail, /does NOT exist/);
    const scanner = r.programs[0];
    assert.equal(scanner.programdata.exists, false);
    assert.equal(scanner.pointer_match, true); // pointer math still proven
    assert.equal(scanner.elf.observed_sha256, null);
    assert.equal(scanner.elf.digest_match, null);
    assert.match(checkOf(r, "C3 scanner")[0].detail, /ProgramData account absent/);
  });

  test("5. wrong program-account owner → FAIL cascade", async () => {
    const state = fullState();
    state.accounts[NS3.scannerProgramId].owner = NS3.vaultProgramId;
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "A2 scanner")[0].status, "FAIL");
    assert.equal(checkOf(r, "C3 scanner")[0].status, "FAIL");
  });

  test("6. wrong ProgramData owner → FAIL cascade", async () => {
    const state = fullState();
    state.accounts[PD_SCANNER].owner = NS3.scannerProgramId;
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "B2 scanner")[0].status, "FAIL");
    assert.equal(checkOf(r, "C3 scanner")[0].status, "FAIL");
    assert.equal(r.programs[0].elf.extraction, "NOT_ATTEMPTED");
  });

  test("7. foreign embedded ProgramData pointer → FAIL cascade (derived address is normative)", async () => {
    const state = fullState();
    const foreign = programDataPda(new PublicKey(NS3.vaultProgramId)); // a valid-but-wrong PDA
    state.accounts[NS3.scannerProgramId] = rpcAccount(encodeProgramAccount(foreign.toBase58()), {
      owner: LOADER,
      executable: true,
    });
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const a4 = checkOf(r, "A4 scanner");
    assert.equal(a4[0].status, "FAIL");
    assert.match(a4[0].detail, /is NOT the loader-derived ProgramData address/);
    assert.equal(r.programs[0].pointer_match, false);
  });

  test("8. malformed program account data (truncated, wrong tag) → FAIL, no false PASS", async () => {
    for (const bad of [Buffer.alloc(20, 1), Buffer.alloc(36, 0)]) {
      const state = fullState();
      state.accounts[NS3.scannerProgramId] = rpcAccount(bad, { owner: LOADER, executable: true });
      const r = await run(state);
      assert.equal(r.overall, "FAIL", `data length ${bad.length}`);
      const a4 = checkOf(r, "A4 scanner");
      assert.equal(a4[0].status, "FAIL");
      assert.match(a4[0].detail, /malformed program account data/);
      assert.equal(r.programs[0].elf.digest_match, null);
    }
  });

  test("9. malformed ProgramData metadata (tag 2, bad flag byte) → extraction FAILED, no false PASS", async () => {
    for (const [desc, data] of [
      ["tag=2 (not a ProgramData account)", encodeProgramAccount(PD_VAULT)],
      [
        "tag=3 but authority flag=7",
        (() => {
          const b = encodeProgramDataAccount({ slot: 1n, authority: NS3.deployer });
          b.writeUInt8(7, 12);
          return b;
        })(),
      ],
    ]) {
      const state = fullState();
      state.accounts[PD_SCANNER] = rpcAccount(data, { owner: LOADER });
      const r = await run(state);
      assert.equal(r.overall, "FAIL", desc);
      const b3 = checkOf(r, "B3 scanner");
      assert.equal(b3[0].status, "FAIL", desc);
      assert.equal(r.programs[0].programdata.state_valid, false);
      assert.equal(r.programs[0].programdata.upgrade_authority.status, "MALFORMED");
      assert.equal(r.programs[0].elf.extraction, "FAILED");
      assert.equal(r.programs[0].elf.observed_sha256, null);
      assert.equal(r.programs[0].elf.digest_match, null);
    }
  });

  test("10. absent upgrade authority → distinct FAIL (ABSENT); extraction and digest still reported", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithoutAuthority(elf), { owner: LOADER });
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "FAIL"); // authority absence is a definitive FAIL
    const b4 = checkOf(r, "B4 scanner");
    assert.equal(b4[0].status, "FAIL");
    assert.match(b4[0].detail, /NO upgrade authority/);
    assert.equal(r.programs[0].programdata.upgrade_authority.status, "ABSENT");
    assert.equal(r.programs[0].programdata.upgrade_authority.present, false);
    // The 13 B boundary was still derived structurally and the payload hashed:
    assert.equal(r.programs[0].elf.payload_offset, 13);
    assert.equal(r.programs[0].elf.digest_match, true);
  });

  test("11. unexpected upgrade authority → distinct FAIL (MISMATCH)", async () => {
    const state = fullState();
    const intruder = "11111111111111111111111111111111";
    const elf = goodElf(NS3.scannerProgramId);
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(intruder, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const b4 = checkOf(r, "B4 scanner");
    assert.equal(b4[0].status, "FAIL");
    assert.match(b4[0].detail, /expected/);
    assert.equal(r.programs[0].programdata.upgrade_authority.status, "MISMATCH");
    assert.equal(r.programs[0].programdata.upgrade_authority.address, intruder);
  });

  test("12. invalid ELF payload (magic destroyed) → extraction FAILED, digest never claimed", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    elf[0] = 0x00; // destroy the ELF magic
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const c1 = checkOf(r, "C1 scanner");
    assert.equal(c1[0].status, "FAIL");
    assert.match(c1[0].detail, /no ELF magic/);
    assert.equal(r.programs[0].elf.extraction, "FAILED");
    assert.equal(r.programs[0].elf.digest_match, null);
  });

  test("13. truncated ELF payload (declared size > payload) → span FAIL, digest cascade FAIL", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    const cut = elf.subarray(0, elf.length - 64); // section table half-gone
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, cut), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(elf); // pin the FULL elf — observed must not match
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const c2 = checkOf(r, "C2 scanner");
    assert.equal(c2[0].status, "FAIL");
    assert.equal(r.programs[0].elf.observed_sha256, null);
    assert.equal(r.programs[0].elf.digest_match, null);
  });

  test("14. unsupported SBPF architecture (v3: e_machine 247 / e_flags 3) → arch FAIL even with a matching digest", async () => {
    const state = fullState();
    const v3elf = buildSbfElf({ idBase58: NS3.scannerProgramId, eMachine: 247, eFlags: 3 });
    state.accounts[PD_SCANNER] = rpcAccount(programDataWithAuthority(NS3.deployer, v3elf), {
      owner: LOADER,
    });
    state.fixtureDigests.scanner = sha256(v3elf); // digest pin matches the v3 bytes
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const c4 = checkOf(r, "C4 scanner");
    assert.equal(c4[0].status, "FAIL");
    assert.match(c4[0].detail, /NOT the SBPF v0 deployment target/);
    assert.equal(r.programs[0].elf.sbpf_valid, false);
    // The digest itself matched the (test) pin — the ARCH gate is independent:
    assert.equal(r.programs[0].elf.digest_match, true);
  });

  test("15. RPC transport failure (all requests destroyed) → every check UNVERIFIED, overall INCOMPLETE", async () => {
    const state = fullState({ failWhere: () => true });
    const r = await run(state);
    assert.equal(r.overall, "INCOMPLETE");
    assert.equal(r.counts.unverified, 27);
    assert.equal(r.counts.fail, 0);
    for (const c of r.checks) {
      assert.equal(c.status, "UNVERIFIED", `${c.id} should be UNVERIFIED on transport failure`);
      assert.match(c.detail, /RPC failure|RPC transport/);
    }
    for (const p of r.programs) {
      assert.equal(p.program_account.exists, null); // NOT false — absence is not proven by an RPC failure
      assert.equal(p.elf.digest_match, null);
    }
  });

  test("16. RPC failure on the ProgramData request ONLY → scanner dependent checks UNVERIFIED, vault PASS", async () => {
    const state = fullState({
      failWhere: (method, params) => method === "getAccountInfo" && params?.[0] === PD_SCANNER,
    });
    const r = await run(state);
    assert.equal(r.overall, "INCOMPLETE"); // no FAIL anywhere, but a check could not run
    assert.equal(checkOf(r, "A1 scanner")[0].status, "PASS");
    assert.equal(checkOf(r, "B1 scanner")[0].status, "UNVERIFIED");
    assert.equal(checkOf(r, "C3 scanner")[0].status, "UNVERIFIED");
    assert.equal(r.programs[0].programdata.exists, null);
    assert.equal(r.programs[1].elf.digest_match, true);
  });

  test("17. FAIL takes precedence over INCOMPLETE (vault digest FAIL + scanner RPC failure)", async () => {
    const state = fullState({
      failWhere: (method, params) => method === "getAccountInfo" && params?.[0] === PD_SCANNER,
    });
    // Corrupt the vault ELF on chain so its digest definitively mismatches.
    const velf = goodElf(NS3.vaultProgramId);
    velf[200] ^= 0xff;
    state.accounts[PD_VAULT] = rpcAccount(programDataWithAuthority(NS3.deployer, velf), {
      owner: LOADER,
    });
    const r = await run(state);
    assert.equal(r.overall, "FAIL"); // definitive FAIL wins over the UNVERIFIED scanner section
    assert.equal(r.counts.fail > 0, true);
    assert.equal(r.counts.unverified > 0, true);
    assert.equal(checkOf(r, "C8 vault")[0].status, "FAIL");
    assert.equal(checkOf(r, "C3 scanner")[0].status, "UNVERIFIED");
  });

  test("18. genesis mismatch → immediate FAIL; no deployed bytes are interpreted", async () => {
    const state = fullState({ genesisHash: "Testwa1v1qqeHqS1rSMHEquSQZ8hk4XCvL4xJLbBNo" });
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    assert.equal(r.checks.length, 1); // ONLY the cluster-identity check ran
    assert.equal(r.checks[0].id, "G1 devnet");
    assert.equal(r.checks[0].status, "FAIL");
    assert.match(r.checks[0].detail, /NOT the approved cluster/);
    assert.equal(r.programs[0].program_account.exists, null);
    assert.equal(r.programs[0].elf.digest_match, null);
  });

  test("19. genesis RPC failure → UNVERIFIED cluster identity → overall INCOMPLETE", async () => {
    const state = fullState({ failWhere: (method) => method === "getGenesisHash" });
    const r = await run(state);
    assert.equal(r.overall, "INCOMPLETE");
    const g1 = checkOf(r, "G1 devnet");
    assert.equal(g1[0].status, "UNVERIFIED");
    assert.match(g1[0].detail, /cluster identity could NOT be established/);
  });

  test("20. zero loader padding beyond the declared ELF end is tolerated and excluded from the digest", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    state.accounts[PD_SCANNER] = rpcAccount(
      programDataWithAuthority(NS3.deployer, Buffer.concat([elf, Buffer.alloc(1024, 0)])),
      { owner: LOADER },
    );
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    const scanner = r.programs[0];
    assert.equal(scanner.elf.trailing_padding_bytes, 1024);
    assert.equal(scanner.elf.declared_elf_size, elf.length);
    assert.equal(scanner.elf.payload_size, elf.length + 1024);
    assert.equal(scanner.elf.observed_sha256, sha256(elf)); // padding NOT hashed
    assert.match(checkOf(r, "C2 scanner")[0].detail, /padding excluded from the digest/);
  });

  test("21. non-zero bytes beyond the declared ELF end → FAIL (refuses to hash an unexpected layout)", async () => {
    const state = fullState();
    const elf = goodElf(NS3.scannerProgramId);
    state.accounts[PD_SCANNER] = rpcAccount(
      programDataWithAuthority(NS3.deployer, Buffer.concat([elf, Buffer.from([1, 2, 3, 4])])),
      { owner: LOADER },
    );
    state.fixtureDigests.scanner = sha256(elf);
    const r = await run(state);
    assert.equal(r.overall, "FAIL");
    const c2 = checkOf(r, "C2 scanner");
    assert.equal(c2[0].status, "FAIL");
    assert.match(c2[0].detail, /NOT all zero/);
    assert.equal(r.programs[0].elf.digest_match, null);
  });
});

describe("CLI behavior — output shape consistency, exit codes, refusal of overrides", () => {
  // NOTE: the CLI verifies against the COMMITTED provenance manifest (it has
  // no manifest flag — that is the point), and the committed pins are the
  // approved NS-3 digests. Synthetic fixture ELFs can never reproduce those
  // digests (SHA-256 preimage), so an offline CLI run is ALWAYS a FAIL —
  // which is itself a property worth pinning: the CLI cannot be coaxed into
  // a PASS by mock bytes. PASS verdicts and exit code 0 are pinned by the
  // API-level tests above, where the manifest is injected through the same
  // validated loading path.
  test("22. --json: identical key sets for both programs; required fields present; exit 1 on offline FAIL", async () => {
    const state = fullState();
    let out;
    await withVerification(state, async ({ url }) => {
      // The CLI has no manifest flag — the committed manifest is used. For
      // the shape/exit-code assertions the fixture digests do not need to
      // match the committed pins; only the SHAPE is pinned here.
      out = await runCli(url, ["--json"]);
    });
    assert.equal(out.code, 1, out.stderr || out.stdout);
    const j = JSON.parse(out.stdout);
    assert.equal(j.tool, TOOL_NAME);
    assert.equal(j.read_only, true);
    assert.equal(j.overall, "FAIL"); // committed manifest pins ≠ fixture digests → digest FAILs
    assert.equal(j.programs.length, 2);
    const [scanner, vault] = j.programs;
    assert.deepEqual(Object.keys(scanner).sort(), Object.keys(vault).sort());
    assert.deepEqual(
      Object.keys(scanner.program_account).sort(),
      Object.keys(vault.program_account).sort(),
    );
    assert.deepEqual(
      Object.keys(scanner.programdata).sort(),
      Object.keys(vault.programdata).sort(),
    );
    assert.deepEqual(
      Object.keys(scanner.programdata.upgrade_authority).sort(),
      Object.keys(vault.programdata.upgrade_authority).sort(),
    );
    assert.deepEqual(Object.keys(scanner.elf).sort(), Object.keys(vault.elf).sort());
    // Required fields (handoff § structured output) exist in BOTH programs:
    const required = [
      ["program_account", "exists"],
      ["program_account", "executable"],
      ["program_account", "owner"],
      ["programdata", "exists"],
      ["programdata", "owner"],
      ["programdata", "state_valid"],
      ["programdata", "slot"],
      ["elf", "extraction"],
      ["elf", "payload_offset"],
      ["elf", "payload_size"],
      ["elf", "declared_elf_size"],
      ["elf", "structure_valid"],
      ["elf", "sbpf_arch"],
      ["elf", "sbpf_valid"],
      ["elf", "observed_sha256"],
      ["elf", "expected_sha256"],
      ["elf", "digest_match"],
    ];
    for (const p of [scanner, vault]) {
      assert.equal(typeof p.program_id, "string");
      assert.ok(
        typeof p.programdata_embedded_address === "string" ||
          p.programdata_embedded_address === null,
      );
      assert.ok(typeof p.programdata_derived_address === "string");
      assert.ok(typeof p.pointer_match === "boolean" || p.pointer_match === null);
      for (const [section, field] of required) {
        assert.ok(field in p[section], `${section}.${field} missing`);
      }
      assert.ok("present" in p.programdata.upgrade_authority);
      assert.ok("address" in p.programdata.upgrade_authority);
      assert.ok("status" in p.programdata.upgrade_authority);
    }
  });

  test("23. --json shape stays identical on a divergent evidence path (one program absent, one digest FAIL)", async () => {
    const state = fullState({ delete: [PD_VAULT] });
    let out;
    await withVerification(state, async ({ url }) => {
      out = await runCli(url, ["--json"]);
    });
    assert.equal(out.code, 1, out.stderr || out.stdout);
    const j = JSON.parse(out.stdout);
    const [scanner, vault] = j.programs;
    assert.deepEqual(Object.keys(scanner).sort(), Object.keys(vault).sort());
    assert.deepEqual(Object.keys(scanner.elf).sort(), Object.keys(vault.elf).sort());
    assert.equal(vault.programdata.exists, false);
    assert.equal(vault.elf.digest_match, null);
    assert.equal(vault.elf.observed_sha256, null);
  });

  test("24. human output: structural lines, per-program sections, OVERALL RESULT, exit codes 1/3", async () => {
    // FAIL path (see the suite note — offline CLI runs cannot PASS):
    const state = fullState();
    let failOut, incompleteOut;
    await withVerification(state, async ({ url }) => {
      failOut = await runCli(url, []);
    });
    assert.equal(failOut.code, 1, failOut.stderr || failOut.stdout);
    assert.match(
      failOut.stdout,
      /=== NS-3 deployed-ELF digest verification — STRICTLY READ-ONLY ===/,
    );
    assert.match(failOut.stdout, /overall: FAIL \(pass 25 \/ fail 2 \/ unverified 0 \/ info 0\)/);
    assert.match(failOut.stdout, /manifest: scripts\/devnet\/provenance\.manifest\.json/);
    assert.match(failOut.stdout, /Section A GraveScanner — program account & ProgramData pointer/);
    assert.match(
      failOut.stdout,
      /Section C GraveVault — deployed ELF payload, SBPF v0 architecture & digest provenance/,
    );
    assert.match(failOut.stdout, /OVERALL RESULT: FAIL/);

    // INCOMPLETE path (every RPC request destroyed): exit 3, guidance printed.
    const broken = fullState({ failWhere: () => true });
    await withVerification(broken, async ({ url }) => {
      incompleteOut = await runCli(url, []);
    });
    assert.equal(incompleteOut.code, 3);
    assert.match(incompleteOut.stdout, /overall: INCOMPLETE/);
    assert.match(incompleteOut.stdout, /OVERALL RESULT: INCOMPLETE/);
    assert.match(incompleteOut.stdout, /re-run against a healthy RPC/);
  });

  test("25. usage errors: missing --url and override flags are refused with exit 2", async () => {
    const missing = await execFileCatch(TOOL, []);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--url is REQUIRED/);
    for (const flag of [
      "--manifest",
      "--manifest-path /tmp/x",
      "--scanner-id EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL",
      "--keypair /tmp/x",
      "--deployer cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831",
    ]) {
      const [f, v] = flag.split(" ");
      const r = await execFileCatch(TOOL, ["--url", "http://127.0.0.1:1", f, ...(v ? [v] : [])]);
      assert.equal(r.code, 2, `flag ${f} must be refused`);
      assert.match(r.stderr, /not accepted/);
    }
  });

  test("26. usage error: invalid --commitment value → exit 2", async () => {
    const r = await execFileCatch(TOOL, [
      "--url",
      "http://127.0.0.1:1",
      "--commitment",
      "processed",
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--commitment/);
  });
});

async function execFileCatch(file, args) {
  try {
    const { stdout } = await execFileP("node", [file, ...args], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.status ?? err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err),
    };
  }
}
