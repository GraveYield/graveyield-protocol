// SPDX-License-Identifier: Apache-2.0
//
// verify_ns3_deployment tests — the STRICTLY READ-ONLY NS-3 acceptance
// verifier, driven against a fully in-memory fake JSON-RPC endpoint
// (fixture account maps + synthetic ProtocolConfig / Program / ProgramData
// buffers). NO real cluster is contacted (the fetchImpl never leaves the
// process), NO keypair material exists anywhere in these tests, and the
// only "transactions" are entries in a fixture map.
//
// What the suite pins (assignment test list ≥16):
//   ✔ all-good NS-3 chain state → every check PASS, overall PASS, exit 0
//   ✖ RPC transport failure → ALL UNVERIFIED, overall NEVER PASS (exit 2)
//   ✖ RPC error response → UNVERIFIED (never faked into FAIL or PASS)
//   ✖ program account missing / not executable / wrong owner → FAIL
//   ✖ ProgramData missing / wrong authority / cleared authority option → FAIL
//   ✖ ProtocolConfig missing / wrong owner / wrong discriminator → FAIL
//   ✖ config authority != governance → FAIL
//   ✖ config value drift from approved defaults → FAIL
//   ✖ non-zero pending_authority → FAIL
//   ✖ activity / launch-price oracle not the dedicated keys → FAIL
//   ✖ paused=true reported ACCURATELY and fails acceptance (both programs)
//   ✖ deployed-bytes digest != manifest / manifest unreadable → FAIL / UNVERIFIED (blocks PASS)
//   ✖ legacy NS-1/NS-2 ID residue in the deployed bytes → FAIL
//   ✔ PDA derivation matches the pinned NS-3 vectors
//   ✔ JSON report carries observed addresses + slot context
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { runVerification } from "../verify_ns3_deployment.mjs";
import { NS3, NS3_PDAS, configPdaWithBump } from "../ns3_identities.mjs";
import { NS3_LEGACY_IDS } from "../ns3_verify_elf.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------ fixtures

const SCANNER_PK = new PublicKey(NS3.scannerProgramId);
const VAULT_PK = new PublicKey(NS3.vaultProgramId);
const DEPLOYER_PK = new PublicKey(NS3.deployer);
const GOVERNANCE_PK = new PublicKey(NS3.governanceAuthority);
const ACTIVITY_PK = new PublicKey(NS3.activityOracle);
const LAUNCH_PK = new PublicKey(NS3.launchPriceOracle);
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SLOTS = [1234];

function bytesOf(pk) {
  return Buffer.from(pk.toBytes());
}

/** Fake deployed ELF bytes with the program's own ID embedded (so the
 *  legacy scan has something honest to scan) and NO legacy bytes. */
function fakeElf(programPk, { appendLegacy = null, size = 512 } = {}) {
  let buf = Buffer.alloc(size, 0x5a);
  Buffer.from(programPk.toBytes()).copy(buf, 16);
  if (appendLegacy) buf = Buffer.concat([buf, Buffer.from(new PublicKey(appendLegacy).toBytes())]);
  return buf;
}

/** Program account: 4-byte tag 2 + 32-byte programdata address. */
function programAccount(programdataPk) {
  const buf = Buffer.alloc(36);
  buf.writeUInt32LE(2, 0);
  bytesOf(programdataPk).copy(buf, 4);
  return buf;
}

/** ProgramData: tag 3 + slot + Option<authority> + elf bytes. */
function programDataAccount(elfBytes, { authority = DEPLOYER_PK, option = 1 } = {}) {
  const head = Buffer.alloc(13);
  head.writeUInt32LE(3, 0);
  head.writeBigUInt64LE(777n, 4);
  head.writeUInt8(option, 12);
  const auth = option === 1 ? bytesOf(authority) : Buffer.alloc(0);
  return Buffer.concat([head, auth, elfBytes]);
}

function protocolConfigAccount(
  program,
  {
    authority = GOVERNANCE_PK,
    pending = null,
    defaults = true,
    paused = false,
    activity = ACTIVITY_PK,
    launch = LAUNCH_PK,
  } = {},
) {
  const buf = Buffer.alloc(program === "scanner" ? 252 : 210);
  // discriminator: sha256("account:ProtocolConfig")[0..8]
  createHash("sha256").update("account:ProtocolConfig").digest().subarray(0, 8).copy(buf, 0);
  bytesOf(authority).copy(buf, 8);
  bytesOf(pending ?? new PublicKey("11111111111111111111111111111111")).copy(buf, 40);
  // pending_authority_eta @72 (i64) stays 0
  if (program === "scanner") {
    buf.writeBigUInt64LE(defaults ? 7_776_000n : 1n, 80); // inactivity
    buf.writeUInt16LE(9_900, 88);
    buf.writeBigUInt64LE(defaults ? 500_000_000n : 1n, 90); // min_tvl
    buf.writeBigUInt64LE(1_209_600n, 98);
    buf.writeBigUInt64LE(1_000n, 106);
    buf.writeBigInt64LE(3_600n, 114);
    buf.writeUInt8(paused ? 1 : 0, 122);
    bytesOf(activity).copy(buf, 123);
    bytesOf(launch).copy(buf, 155);
    buf.writeUInt8(255, 187);
  } else {
    buf.writeUInt16LE(4_000, 80);
    buf.writeUInt16LE(4_000, 82);
    buf.writeUInt16LE(2_000, 84);
    buf.writeBigUInt64LE(1_000_000_000n, 86);
    buf.writeUInt16LE(300, 94);
    buf.writeBigUInt64LE(666_666n, 96);
    buf.writeBigInt64LE(259_200n, 104);
    buf.writeUInt8(paused ? 1 : 0, 112);
    buf.writeUInt8(255, 113);
  }
  return buf;
}

/** Build the account map + fake fetchImpl for one scenario. */
function makeRpc(accounts, { failAll = false, rpcError = false } = {}) {
  const fetchImpl = async (endpoint, opts) => {
    if (failAll) throw new Error("ECONNREFUSED (fake)");
    const body = JSON.parse(opts.body);
    if (rpcError) {
      return {
        ok: true,
        json: async () => ({ error: { message: "fake node is behind a proxy" } }),
      };
    }
    if (body.method === "getSlot") {
      return { ok: true, json: async () => ({ result: SLOTS[0], context: { slot: SLOTS[0] } }) };
    }
    if (body.method === "getAccountInfo") {
      const addr = body.params[0];
      const acct = accounts[addr];
      return {
        ok: true,
        json: async () => ({
          result: acct
            ? {
                context: { slot: SLOTS[0] },
                value: {
                  data: [acct.data.toString("base64"), "base64"],
                  executable: acct.executable,
                  lamports: acct.lamports,
                  owner: acct.owner,
                },
              }
            : { context: { slot: SLOTS[0] }, value: null },
        }),
      };
    }
    return { ok: false, status: 400, json: async () => ({}) };
  };
  return fetchImpl;
}

/** Full good-scenario account map. */
function goodAccounts({ elfScanner, elfVault } = {}) {
  const scannerElf = elfScanner ?? fakeElf(SCANNER_PK);
  const vaultElf = elfVault ?? fakeElf(VAULT_PK);
  // ProgramData addresses need not be valid PDAs — they are READ from the
  // program account's embedded relation, so any 32-byte value works.
  const scannerDataPk = new PublicKey(NA_ORACLE_BYTES(1));
  const vaultDataPk = new PublicKey(NA_ORACLE_BYTES(2));
  const accounts = {
    [NS3.scannerProgramId]: {
      owner: LOADER,
      executable: true,
      lamports: 833120,
      data: programAccount(scannerDataPk),
    },
    [NS3.vaultProgramId]: {
      owner: LOADER,
      executable: true,
      lamports: 833120,
      data: programAccount(vaultDataPk),
    },
    [scannerDataPk.toBase58()]: {
      owner: LOADER,
      executable: false,
      lamports: 1870000000,
      data: programDataAccount(scannerElf),
    },
    [vaultDataPk.toBase58()]: {
      owner: LOADER,
      executable: false,
      lamports: 2070000000,
      data: programDataAccount(vaultElf),
    },
    [NS3_PDAS.scannerConfigPda]: {
      owner: NS3.scannerProgramId,
      executable: false,
      lamports: 1_000_000,
      data: protocolConfigAccount("scanner"),
    },
    [NS3_PDAS.vaultConfigPda]: {
      owner: NS3.vaultProgramId,
      executable: false,
      lamports: 1_000_000,
      data: protocolConfigAccount("vault"),
    },
  };
  return { accounts, scannerElf, vaultElf, scannerDataPk, vaultDataPk };
}

function NA_ORACLE_BYTES(n) {
  // deterministic 32 bytes, off-curve not required (never used as a signer)
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(0x4e41 + n, 0); // "NA"
  buf.write("fake-programdata-address", 4);
  return buf;
}

async function writeManifest({ scannerElf, vaultElf, dir } = {}) {
  const m = {
    schema: "graveyield.devnet.provenance/1",
    chain: "devnet",
    generation: "NS-3",
    sbpf: { arch: "v0", eMachine: 263, eFlags: 0 },
    platformTools: {
      version: "v1.54",
      tarballSha256: "a".repeat(64),
      tarballUrl: "https://example.invalid/t",
    },
    toolchain: { solanaCli: "3.0.10", anchorCli: "1.2.2" },
    elfs: {
      scanner: {
        artifact: "grave_scanner.so",
        programId: NS3.scannerProgramId,
        sha256: createHash("sha256").update(scannerElf).digest("hex"),
      },
      vault: {
        artifact: "grave_vault.so",
        programId: NS3.vaultProgramId,
        sha256: createHash("sha256").update(vaultElf).digest("hex"),
      },
    },
  };
  const p = join(dir, "manifest.json");
  writeFileSync(p, JSON.stringify(m));
  return p;
}

function checkOf(report, id) {
  return report.checks.find((c) => c.id === id);
}

async function goodRun(dir, mutateAccounts = null, opts = {}) {
  const good = goodAccounts();
  if (mutateAccounts) mutateAccounts(good.accounts, good);
  const manifestPath = await writeManifest({
    scannerElf: good.scannerElf,
    vaultElf: good.vaultElf,
    dir,
  });
  return runVerification({
    url: "http://127.0.0.1:8899",
    fetchImpl: makeRpc(good.accounts, opts),
    manifestPath,
  });
}

// ------------------------------------------------------------ tests

describe("verify_ns3_deployment — strictly read-only NS-3 acceptance verifier", () => {
  test("all-good NS-3 chain state → OVERALL PASS with every check PASS and exit code 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir);
    assert.equal(
      report.overall,
      "PASS",
      JSON.stringify(
        report.checks.filter((c) => c.status !== "PASS"),
        null,
        2,
      ),
    );
    assert.equal(report.exitCode, 0);
    assert.equal(report.slot, SLOTS[0]);
    for (const c of report.checks) {
      assert.equal(c.status, "PASS", `${c.id}: ${c.detail}`);
    }
    // the full check surface exists: A/B per program, C, D, E, Z
    for (const id of [
      "Z:rpc-context",
      "A:scanner:program-account",
      "A:scanner:upgrade-authority",
      "A:vault:program-account",
      "A:vault:upgrade-authority",
      "B:scanner:pda-derivation",
      "B:scanner:config-account",
      "B:scanner:authority",
      "B:scanner:defaults",
      "B:scanner:pending-authority",
      "B:vault:pda-derivation",
      "B:vault:config-account",
      "B:vault:authority",
      "B:vault:defaults",
      "B:vault:pending-authority",
      "C:activity-oracle",
      "C:launch-price-oracle",
      "D:scanner:not-paused",
      "D:vault:not-paused",
      "E:scanner:deployed-digest",
      "E:scanner:legacy-scan",
      "E:vault:deployed-digest",
      "E:vault:legacy-scan",
    ]) {
      assert.ok(checkOf(report, id), `missing check ${id}`);
    }
  });

  test("PDA derivation matches the pinned NS-3 vectors (offline, byte-exact)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir);
    assert.equal(checkOf(report, "B:scanner:pda-derivation").status, "PASS");
    assert.equal(
      configPdaWithBump(SCANNER_PK)[0].toBase58(),
      "5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe",
    );
    assert.equal(
      configPdaWithBump(VAULT_PK)[0].toBase58(),
      "5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda",
    );
    assert.equal(configPdaWithBump(SCANNER_PK)[1], 255);
  });

  test("RPC transport failure → UNVERIFIED everywhere, overall UNVERIFIED, exit 2 (never PASS)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, null, { failAll: true });
    assert.equal(report.overall, "UNVERIFIED");
    assert.equal(report.exitCode, 2);
    assert.ok(report.summary.unverified > 0);
    for (const c of report.checks) {
      if (c.id.endsWith(":pda-derivation")) {
        // the PDA derivation is OFFLINE — it stays honest (PASS) during an outage
        assert.equal(c.status, "PASS", `${c.id}: ${c.detail}`);
        continue;
      }
      assert.equal(c.status, "UNVERIFIED", `${c.id} must not fake a verdict: ${c.status}`);
    }
  });

  test("RPC error response → UNVERIFIED (an RPC outage is not deployment evidence either way)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, null, { rpcError: true });
    assert.equal(report.overall, "UNVERIFIED");
    assert.equal(report.exitCode, 2);
  });

  test("scanner program account missing → FAIL with an explicit not-deployed detail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      delete accounts[NS3.scannerProgramId];
    });
    assert.equal(report.overall, "FAIL");
    const c = checkOf(report, "A:scanner:program-account");
    assert.equal(c.status, "FAIL");
    assert.match(c.detail, /no account exists/);
  });

  test("program account not executable → FAIL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      accounts[NS3.scannerProgramId].executable = false;
    });
    assert.equal(report.overall, "FAIL");
    assert.equal(checkOf(report, "A:scanner:program-account").status, "FAIL");
  });

  test("program account owned by something other than the BPF upgradeable loader → FAIL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      accounts[NS3.vaultProgramId].owner = NS3.scannerProgramId;
    });
    assert.equal(report.overall, "FAIL");
    assert.equal(checkOf(report, "A:vault:program-account").status, "FAIL");
  });

  test("ProgramData account missing (relation dangling) → upgrade-authority FAIL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts, extra) => {
      delete accounts[extra.scannerDataPk.toBase58()];
    });
    assert.equal(report.overall, "FAIL");
    assert.equal(checkOf(report, "A:scanner:upgrade-authority").status, "FAIL");
    assert.match(checkOf(report, "A:scanner:upgrade-authority").detail, /no account exists there/);
  });

  test("ProgramData upgrade authority != NS-3 deployer → FAIL (decoded from the REAL ProgramData, not inferred)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts, extra) => {
      bytesOf(GOVERNANCE_PK).copy(accounts[extra.scannerDataPk.toBase58()].data, 13);
    });
    assert.equal(report.overall, "FAIL");
    const c = checkOf(report, "A:scanner:upgrade-authority");
    assert.equal(c.status, "FAIL");
    assert.match(c.detail, /!= NS-3 deployer/);
  });

  test("ProgramData with the authority option CLEARED (closed authority) → FAIL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts, extra) => {
      const cur = accounts[extra.scannerDataPk.toBase58()].data;
      accounts[extra.scannerDataPk.toBase58()].data = programDataAccount(cur.subarray(45), {
        option: 0,
      });
    });
    assert.equal(report.overall, "FAIL");
    const c = checkOf(report, "A:scanner:upgrade-authority");
    assert.equal(c.status, "FAIL");
    assert.match(c.detail, /option cleared|<none/);
  });

  test("ProtocolConfig missing at the expected PDA → FAIL (initialize not performed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      delete accounts[NS3_PDAS.vaultConfigPda];
    });
    assert.equal(report.overall, "FAIL");
    assert.match(checkOf(report, "B:vault:config-account").detail, /initialize not performed/);
  });

  test("ProtocolConfig owned by a different program → FAIL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      accounts[NS3_PDAS.scannerConfigPda].owner = NS3.vaultProgramId;
    });
    assert.equal(report.overall, "FAIL");
    assert.equal(checkOf(report, "B:scanner:config-account").status, "FAIL");
  });

  test("ProtocolConfig with a wrong account discriminator → FAIL (not a ProtocolConfig account)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      accounts[NS3_PDAS.vaultConfigPda].data[3] ^= 0xff;
    });
    assert.equal(report.overall, "FAIL");
    assert.match(checkOf(report, "B:vault:config-account").detail, /MISMATCH/);
  });

  test("config authority != governance → FAIL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      accounts[NS3_PDAS.scannerConfigPda].data = protocolConfigAccount("scanner", {
        authority: DEPLOYER_PK,
      });
    });
    assert.equal(report.overall, "FAIL");
    assert.match(checkOf(report, "B:scanner:authority").detail, /!= governance|!=/);
  });

  test("config value drift from the approved defaults → FAIL with the drifted field named", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      accounts[NS3_PDAS.scannerConfigPda].data = protocolConfigAccount("scanner", {
        defaults: false,
      });
    });
    assert.equal(report.overall, "FAIL");
    const c = checkOf(report, "B:scanner:defaults");
    assert.equal(c.status, "FAIL");
    assert.match(c.detail, /inactivitySeconds/);
  });

  test("non-zero pending_authority → FAIL (in-flight rotation is not the acceptance state)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      accounts[NS3_PDAS.vaultConfigPda].data = protocolConfigAccount("vault", {
        pending: ACTIVITY_PK,
      });
    });
    assert.equal(report.overall, "FAIL");
    assert.match(
      checkOf(report, "B:vault:pending-authority").detail,
      /authority rotation is in flight/,
    );
  });

  test("activity oracle left at the initialization authority (governance) → FAIL — dedicated key required", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      accounts[NS3_PDAS.scannerConfigPda].data = protocolConfigAccount("scanner", {
        activity: GOVERNANCE_PK,
      });
    });
    assert.equal(report.overall, "FAIL");
    const c = checkOf(report, "C:activity-oracle");
    assert.equal(c.status, "FAIL");
    assert.match(c.detail, /governance/);
  });

  test("launch-price oracle != dedicated key → FAIL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      accounts[NS3_PDAS.scannerConfigPda].data = protocolConfigAccount("scanner", {
        launch: DEPLOYER_PK,
      });
    });
    assert.equal(report.overall, "FAIL");
    assert.equal(checkOf(report, "C:launch-price-oracle").status, "FAIL");
  });

  test("scanner paused=true → reported ACCURATELY (actual decoded value) and acceptance FAILS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      accounts[NS3_PDAS.scannerConfigPda].data = protocolConfigAccount("scanner", { paused: true });
    });
    assert.equal(report.overall, "FAIL");
    const c = checkOf(report, "D:scanner:not-paused");
    assert.equal(c.status, "FAIL");
    assert.match(c.detail, /paused = true \(actual decoded on-chain value\)/);
    assert.equal(c.observed.paused, true);
  });

  test("vault emergency_paused=true → reported and FAIL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir, (accounts) => {
      accounts[NS3_PDAS.vaultConfigPda].data = protocolConfigAccount("vault", { paused: true });
    });
    assert.equal(report.overall, "FAIL");
    assert.equal(checkOf(report, "D:vault:not-paused").status, "FAIL");
  });

  test("deployed bytes digest != manifest digest → FAIL (on-chain bytes are not the approved provenance)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const good = goodAccounts();
    // swap the vault ProgramData for one holding DIFFERENT bytes
    good.accounts[good.vaultDataPk.toBase58()].data = programDataAccount(
      fakeElf(VAULT_PK, { size: 600 }),
    );
    const manifestPath = await writeManifest({
      scannerElf: good.scannerElf,
      vaultElf: good.vaultElf,
      dir,
    });
    const accounts = good.accounts;
    const report = await runVerification({
      url: "http://127.0.0.1:8899",
      fetchImpl: makeRpc(accounts),
      manifestPath,
    });
    assert.equal(report.overall, "FAIL");
    assert.equal(checkOf(report, "E:vault:deployed-digest").status, "FAIL");
  });

  test("legacy NS-1/NS-2 ID residue in the deployed vault bytes → identity-consistency FAIL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const ns2Vault = NS3_LEGACY_IDS.find(([n]) => n === "NS-2 vault")[1];
    const report = await goodRun(dir, (accounts, extra) => {
      accounts[extra.vaultDataPk.toBase58()].data = programDataAccount(
        fakeElf(VAULT_PK, { appendLegacy: ns2Vault }),
      );
    });
    assert.equal(report.overall, "FAIL");
    const c = checkOf(report, "E:vault:legacy-scan");
    assert.equal(c.status, "FAIL");
    assert.match(c.detail, /NS-2 vault/);
  });

  test("manifest unreadable → digest checks UNVERIFIED (blocks PASS without claiming FAIL)", async () => {
    const { accounts } = goodAccounts();
    const report = await runVerification({
      url: "http://127.0.0.1:8899",
      fetchImpl: makeRpc(accounts),
      manifestPath: "/nonexistent/provenance.manifest.json",
    });
    assert.equal(report.overall, "UNVERIFIED");
    assert.equal(report.exitCode, 2);
    assert.equal(checkOf(report, "E:scanner:deployed-digest").status, "UNVERIFIED");
    // the legacy scan is still evidence-based (bytes were readable)
    assert.equal(checkOf(report, "E:scanner:legacy-scan").status, "PASS");
  });

  test("JSON report carries observed addresses, upgrade authorities, and slot context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-verify-"));
    const report = await goodRun(dir);
    const json = JSON.parse(JSON.stringify(report));
    assert.equal(json.slot, SLOTS[0]);
    assert.deepEqual(json.slotsObserved, SLOTS);
    assert.equal(json.observed.identities.scannerProgramId, NS3.scannerProgramId);
    assert.equal(json.observed.expectedPdas.scannerConfigPda, NS3_PDAS.scannerConfigPda);
    assert.ok(json.observed.programData.scanner.address);
    assert.equal(json.observed.programData.scanner.upgradeAuthority, NS3.deployer);
    assert.equal(json.observed.configs.scanner.authority, NS3.governanceAuthority);
    assert.equal(json.observed.configs.scanner.activityOracle, NS3.activityOracle);
    assert.equal(json.observed.configs.vault.timelockSeconds, "259200");
  });

  test("a missing --url is a usage error (no default endpoint is ever guessed)", async () => {
    await assert.rejects(() => runVerification({ fetchImpl: makeRpc({}) }), /explicit --url/);
  });

  test("the verifier module never constructs a signer or reads a keypair (static read-only guarantee)", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(join(HERE, "..", "verify_ns3_deployment.mjs"), "utf8"),
    );
    // Strip // comments first — the header documents the guarantee with the
    // word "Keypair"; the CODE must not contain it.
    const code = src.replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /Keypair/, "no Keypair import or use anywhere in code");
    assert.doesNotMatch(
      code,
      /sendTransaction|sendAndConfirm|requestAirdrop|simulateTransaction/,
      "no transaction-capable RPC call",
    );
    const methods = [...src.matchAll(/rpcCall\([^,]+, "([a-z_A-Z]+)"/g)].map((m) => m[1]);
    for (const m of methods)
      assert.ok(["getAccountInfo", "getSlot"].includes(m), `unexpected RPC method ${m}`);
  });
});
