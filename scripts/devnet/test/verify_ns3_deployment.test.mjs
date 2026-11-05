// SPDX-License-Identifier: Apache-2.0
//
// verify_ns3_deployment.test.mjs — tests for the strictly read-only NS-3
// post-deployment acceptance verifier.
//
// EVERY test runs fully offline: the cluster is a local JSON-RPC mock
// (node:http) serving getAccountInfo / getEpochInfo responses built with
// the real byte layouts. Nothing contacts a public cluster and no keypair
// material exists anywhere in this suite.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import {
  runVerification,
  parseProgramAccount,
  parseProgramDataAccount,
  decodeScannerConfig,
  decodeVaultConfig,
  accountDiscriminator,
  BPF_LOADER_UPGRADEABLE,
} from "../verify_ns3_deployment.mjs";
import { decodeProtocolConfig } from "../protocol_admin.mjs";
import { NS3_LEGACY_IDS } from "../ns3_verify_elf.mjs";
import { NS3, NS3_PDAS } from "../ns3_identities.mjs";
import {
  encodeProgramAccount,
  encodeProgramDataAccount,
  encodeScannerConfig,
  encodeVaultConfig,
  rpcAccount,
} from "./helpers/provenance_fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFIER = path.join(HERE, "..", "verify_ns3_deployment.mjs");

const LOADER = new PublicKey(BPF_LOADER_UPGRADEABLE);
const PD_SCANNER = new PublicKey(Buffer.alloc(32, 1)).toBase58();
const PD_VAULT = new PublicKey(Buffer.alloc(32, 2)).toBase58();
const SLOT = 514_928_999;

function fullState() {
  return {
    accounts: {
      [NS3.scannerProgramId]: rpcAccount(encodeProgramAccount(PD_SCANNER), {
        owner: LOADER,
        executable: true,
        lamports: 833_120,
      }),
      [PD_SCANNER]: rpcAccount(encodeProgramDataAccount({ authority: NS3.deployer }), {
        owner: LOADER,
        lamports: 1_869_627_960,
      }),
      [NS3_PDAS.scannerConfigPda]: rpcAccount(
        encodeScannerConfig({
          authority: NS3.governanceAuthority,
          activityOracle: NS3.activityOracle,
          launchPriceOracle: NS3.launchPriceOracle,
        }),
        { owner: NS3.scannerProgramId },
      ),
      [NS3.vaultProgramId]: rpcAccount(encodeProgramAccount(PD_VAULT), {
        owner: LOADER,
        executable: true,
        lamports: 833_120,
      }),
      [PD_VAULT]: rpcAccount(encodeProgramDataAccount({ authority: NS3.deployer }), {
        owner: LOADER,
        lamports: 2_069_373_560,
      }),
      [NS3_PDAS.vaultConfigPda]: rpcAccount(
        encodeVaultConfig({ authority: NS3.governanceAuthority }),
        { owner: NS3.vaultProgramId },
      ),
    },
  };
}

function handleRpc(req, state) {
  const value = state.accounts[req.params?.[0]] ?? null;
  switch (req.method) {
    case "getAccountInfo":
      return { jsonrpc: "2.0", id: req.id, result: { context: { slot: SLOT }, value } };
    case "getEpochInfo":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: { absoluteSlot: SLOT, blockHeight: SLOT - 200, epoch: 800, slotIndex: 345 },
      };
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

/** Start a mock RPC for the duration of fn(url). */
async function withRpc(state, fn, { failAll = false } = {}) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failAll) {
        res.destroy(); // transport failure → UNVERIFIED territory
        return;
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
    return await fn(url);
  } finally {
    server.close();
  }
}

async function runCli(url, args = []) {
  try {
    const { stdout } = await execFileP("node", [VERIFIER, "--url", url, ...args], {
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

function checkOf(result, idPrefix) {
  return result.checks.filter((c) => c.id.startsWith(idPrefix));
}

describe("verify_ns3_deployment — mock RPC acceptance battery", () => {
  test("1. all-good chain state yields overall PASS with every check PASS", async () => {
    const r = await withRpc(fullState(), (url) => runVerification({ url }));
    assert.equal(r.overall, "PASS", JSON.stringify(r.checks, null, 2));
    assert.equal(r.counts.fail, 0);
    assert.equal(r.counts.unverified, 0);
    for (const id of ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"]) {
      const c = checkOf(r, `${id} `);
      assert.equal(c.length, 1, `missing check ${id}`);
      assert.equal(c[0].status, "PASS", `${id}: ${c[0]?.detail}`);
    }
    assert.equal(String(r.context.slot), String(SLOT));
  });

  test("2. scanner program missing → A-section FAIL, overall FAIL", async () => {
    const s = fullState();
    delete s.accounts[NS3.scannerProgramId];
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(r.overall, "FAIL");
    assert.ok(checkOf(r, "A1 ").every((c) => c.status === "FAIL"));
    assert.match(checkOf(r, "A1 ")[0].detail, /NOT deployed/);
  });

  test("3. program not executable → FAIL", async () => {
    const s = fullState();
    s.accounts[NS3.scannerProgramId].executable = false;
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "A3 ")[0].status, "FAIL");
  });

  test("4. program owner not the loader → FAIL", async () => {
    const s = fullState();
    s.accounts[NS3.scannerProgramId].owner = "11111111111111111111111111111111";
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "A2 ")[0].status, "FAIL");
    assert.match(checkOf(r, "A2 ")[0].detail, /expected BPFLoaderUpgradeab1e/);
  });

  test("5. ProgramData account absent → FAIL", async () => {
    const s = fullState();
    delete s.accounts[PD_SCANNER];
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "A4 ")[0].status, "FAIL");
  });

  test("6. ProgramData owner not the loader → FAIL", async () => {
    const s = fullState();
    s.accounts[PD_SCANNER].owner = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(checkOf(r, "A4 ")[0].status, "FAIL");
  });

  test("7. ProgramData upgrade authority renounced (None) → FAIL", async () => {
    const s = fullState();
    s.accounts[PD_SCANNER] = rpcAccount(encodeProgramDataAccount({ authority: null }), {
      owner: LOADER,
    });
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "A5 ")[0].status, "FAIL");
    assert.match(checkOf(r, "A5 ")[0].detail, /NO upgrade authority/);
  });

  test("8. ProgramData upgrade authority != deployer → FAIL with both keys", async () => {
    const s = fullState();
    s.accounts[PD_SCANNER] = rpcAccount(
      encodeProgramDataAccount({ authority: NS3.governanceAuthority }),
      { owner: LOADER },
    );
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(checkOf(r, "A5 ")[0].status, "FAIL");
    assert.match(checkOf(r, "A5 ")[0].detail, new RegExp(NS3.governanceAuthority));
    assert.match(checkOf(r, "A5 ")[0].detail, new RegExp(NS3.deployer));
  });

  test("9. scanner ProtocolConfig absent → B-section FAIL", async () => {
    const s = fullState();
    delete s.accounts[NS3_PDAS.scannerConfigPda];
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "B2 ")[0].status, "FAIL");
    assert.match(checkOf(r, "B2 ")[0].detail, /does NOT exist/);
  });

  test("10. config owner != its program → FAIL", async () => {
    const s = fullState();
    s.accounts[NS3_PDAS.vaultConfigPda].owner = NS3.scannerProgramId;
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(checkOf(r, "B10 ")[0].status, "FAIL");
  });

  test("11. wrong discriminator (not a ProtocolConfig account) → FAIL", async () => {
    const s = fullState();
    const buf = Buffer.from(s.accounts[NS3_PDAS.scannerConfigPda].data[0], "base64");
    buf[3] ^= 0xff;
    s.accounts[NS3_PDAS.scannerConfigPda].data[0] = buf.toString("base64");
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "B4 ")[0].status, "FAIL");
    assert.match(checkOf(r, "B4 ")[0].detail, /discriminator/);
  });

  test("12. config authority != governance → FAIL", async () => {
    const s = fullState();
    const buf = Buffer.from(s.accounts[NS3_PDAS.vaultConfigPda].data[0], "base64");
    Buffer.from(new PublicKey(NS3.deployer).toBytes()).copy(buf, 8);
    s.accounts[NS3_PDAS.vaultConfigPda].data[0] = buf.toString("base64");
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(checkOf(r, "B13 ")[0].status, "FAIL");
    assert.match(checkOf(r, "B13 ")[0].detail, new RegExp(NS3.deployer));
  });

  test("13. scanner config value diverging from approved defaults → FAIL", async () => {
    const s = fullState();
    const buf = Buffer.from(s.accounts[NS3_PDAS.scannerConfigPda].data[0], "base64");
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    v.setBigUint64(80, 1n, true); // inactivity_seconds = 1 (approved 7_776_000)
    s.accounts[NS3_PDAS.scannerConfigPda].data[0] = buf.toString("base64");
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(checkOf(r, "B7 ")[0].status, "FAIL");
    assert.match(checkOf(r, "B7 ")[0].detail, /inactivitySeconds=1/);
  });

  test("14. vault config value diverging from approved defaults → FAIL", async () => {
    const s = fullState();
    const buf = Buffer.from(s.accounts[NS3_PDAS.vaultConfigPda].data[0], "base64");
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    v.setUint16(84, 9_999, true); // protocol_share_bps above Charter ceiling
    s.accounts[NS3_PDAS.vaultConfigPda].data[0] = buf.toString("base64");
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(checkOf(r, "B14 ")[0].status, "FAIL");
    assert.match(checkOf(r, "B14 ")[0].detail, /protocolShareBps=9999/);
  });

  test("15. activity oracle still the initialization authority → FAIL (register-oracle not run)", async () => {
    const s = fullState();
    const buf = Buffer.from(s.accounts[NS3_PDAS.scannerConfigPda].data[0], "base64");
    Buffer.from(new PublicKey(NS3.governanceAuthority).toBytes()).copy(buf, 123);
    s.accounts[NS3_PDAS.scannerConfigPda].data[0] = buf.toString("base64");
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "C1 ")[0].status, "FAIL");
    assert.match(checkOf(r, "C1 ")[0].detail, /INITIAL INITIALIZATION authority/);
  });

  test("16. launch-price oracle not the dedicated key → FAIL", async () => {
    const s = fullState();
    const buf = Buffer.from(s.accounts[NS3_PDAS.scannerConfigPda].data[0], "base64");
    Buffer.from(new PublicKey(NS3.activityOracle).toBytes()).copy(buf, 155);
    s.accounts[NS3_PDAS.scannerConfigPda].data[0] = buf.toString("base64");
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(checkOf(r, "C2 ")[0].status, "FAIL");
    assert.match(checkOf(r, "C2 ")[0].detail, new RegExp(NS3.activityOracle));
  });

  test("17. paused=true is reported verbatim and fails acceptance", async () => {
    const s = fullState();
    const buf = Buffer.from(s.accounts[NS3_PDAS.scannerConfigPda].data[0], "base64");
    buf.writeUInt8(1, 122);
    s.accounts[NS3_PDAS.scannerConfigPda].data[0] = buf.toString("base64");
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(r.overall, "FAIL");
    assert.equal(checkOf(r, "D1 ")[0].status, "FAIL");
    assert.match(checkOf(r, "D1 ")[0].detail, /paused=true/);
    assert.match(checkOf(r, "D1 ")[0].detail, /CURRENTLY EMERGENCY-PAUSED/);
  });

  test("18. vault emergency_paused=true fails", async () => {
    const s = fullState();
    const buf = Buffer.from(s.accounts[NS3_PDAS.vaultConfigPda].data[0], "base64");
    buf.writeUInt8(1, 112);
    s.accounts[NS3_PDAS.vaultConfigPda].data[0] = buf.toString("base64");
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(checkOf(r, "D2 ")[0].status, "FAIL");
    assert.match(checkOf(r, "D2 ")[0].detail, /emergency_paused=true/);
  });

  test("19. RPC transport failure → UNVERIFIED, overall INCOMPLETE, never PASS", async () => {
    const r = await withRpc(fullState(), (url) => runVerification({ url }), { failAll: true });
    assert.equal(r.overall, "INCOMPLETE");
    assert.ok(r.counts.unverified > 0);
    assert.equal(r.counts.fail, 0);
    assert.ok(checkOf(r, "A1 ").every((c) => c.status === "UNVERIFIED"));
    assert.match(checkOf(r, "A1 ")[0].detail, /RPC failure/);
  });

  test("20. legacy NS-1/NS-2 residues are REPORTED (INFO) and do not flip the verdict", async () => {
    const s = fullState();
    // legacy programs live at their own addresses with their own ProgramData
    const pdLegacyScanner = new PublicKey(Buffer.alloc(32, 3)).toBase58();
    const pdLegacyVault = new PublicKey(Buffer.alloc(32, 4)).toBase58();
    Object.assign(s.accounts, {
      [NS3_LEGACY_IDS[2][1]]: rpcAccount(encodeProgramAccount(pdLegacyScanner), {
        owner: LOADER,
        executable: true,
      }),
      [NS3_LEGACY_IDS[3][1]]: rpcAccount(encodeProgramAccount(pdLegacyVault), {
        owner: LOADER,
        executable: true,
      }),
      [pdLegacyScanner]: rpcAccount(
        encodeProgramDataAccount({ authority: "AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa" }),
        { owner: LOADER },
      ),
    });
    const r = await withRpc(s, (url) => runVerification({ url }));
    assert.equal(
      r.overall,
      "PASS",
      JSON.stringify(
        r.checks.filter((c) => c.status !== "PASS" && c.section !== "E"),
        null,
        2,
      ),
    );
    const eSection = r.checks.filter((c) => c.section === "E");
    assert.equal(eSection.length, 4);
    const present = eSection.filter((c) => /PRESENT/.test(c.detail));
    assert.equal(present.length, 2);
    assert.match(eSection.find((c) => c.id.includes("NS-1 scanner")).detail, /absent/);
    assert.match(
      eSection.find((c) => c.id.includes("NS-2 scanner")).detail,
      /upgrade authority AsB5uPtT/,
    );
  });

  test("21. --json output is machine-readable and carries url/slot/counts", async () => {
    await withRpc(fullState(), async (url) => {
      const out = await runCli(url, ["--json"]);
      assert.equal(out.code, 0, out.stdout + out.stderr);
      const j = JSON.parse(out.stdout);
      assert.equal(j.tool, "verify_ns3_deployment");
      assert.equal(j.read_only, true);
      assert.equal(j.url, url);
      assert.equal(String(j.context.slot), String(SLOT));
      assert.equal(j.overall, "PASS");
      assert.ok(Array.isArray(j.checks) && j.checks.length > 20);
      return null;
    });
  });

  test("22. CLI exit codes: PASS→0", async () => {
    await withRpc(fullState(), async (url) => {
      assert.equal((await runCli(url, ["--json"])).code, 0);
      return null;
    });
  });

  test("23. CLI exit codes: FAIL→1", async () => {
    const s = fullState();
    delete s.accounts[NS3.vaultProgramId];
    await withRpc(s, async (url) => {
      assert.equal((await runCli(url, ["--json"])).code, 1);
      return null;
    });
  });

  test("24. CLI exit codes: INCOMPLETE→3 (RPC failure never passes)", async () => {
    await withRpc(
      fullState(),
      async (url) => {
        assert.equal((await runCli(url, ["--json"])).code, 3);
        return null;
      },
      { failAll: true },
    );
  });

  test("25. usage: missing --url exits 2", async () => {
    const r = await runCliNoUrl();
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--url is REQUIRED/);
  });

  test("26. guard: a flag value pointing at an existing FILE path is refused (never reads keypair files)", async () => {
    await withRpc(fullState(), async (url) => {
      const r = await runCli(url, ["--deployer", VERIFIER]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /must be a PUBLIC KEY/);
      return null;
    });
  });

  test("27. STATIC read-only guarantee: no signer/transaction API in the verifier source", () => {
    const src = readFileSync(VERIFIER, "utf8");
    assert.doesNotMatch(src, /\bKeypair\b/);
    assert.doesNotMatch(src, /sendTransaction|sendAndConfirmTransaction|simulateTransaction/);
    assert.doesNotMatch(src, /\bnew Transaction\b/);
    assert.doesNotMatch(src, /TransactionInstruction/);
    assert.doesNotMatch(src, /signTransaction|signMessage/);
    assert.doesNotMatch(src, /readFileSync\([^)]*keypair/i);
  });

  test("28. schema cross-check: verifier decoder offsets match protocol_admin's decoder", () => {
    const scanner = encodeScannerConfig({
      authority: NS3.governanceAuthority,
      activityOracle: NS3.activityOracle,
      launchPriceOracle: NS3.launchPriceOracle,
      pendingAuthorityEta: 777n,
    });
    const mine = decodeScannerConfig(scanner);
    const theirs = decodeProtocolConfig("scanner", scanner);
    assert.equal(mine.authority.toBase58(), theirs.authority.toBase58());
    assert.equal(mine.pendingAuthority.toBase58(), theirs.pendingAuthority.toBase58());
    assert.equal(mine.inactivitySeconds, theirs.inactivitySeconds);
    assert.equal(mine.priceCollapseBps, theirs.priceCollapseBps);
    assert.equal(mine.minTvlLamports, theirs.minTvlLamports);
    assert.equal(mine.anchorStalenessSeconds, theirs.anchorStalenessSeconds);
    assert.equal(mine.lpBurnDustThreshold, theirs.lpBurnDustThreshold);
    assert.equal(mine.certTtlSeconds, theirs.certTtlSeconds);
    assert.equal(mine.paused, theirs.paused);
    assert.equal(mine.activityOracle.toBase58(), theirs.activityOracle.toBase58());
    assert.equal(mine.launchPriceOracle.toBase58(), theirs.launchPriceOracle.toBase58());
    assert.equal(mine.bump, theirs.bump);
    assert.equal(mine.pendingAuthorityEta, 777n);
    assert.equal(
      Buffer.from(scanner.subarray(0, 8)).toString("hex"),
      accountDiscriminator("ProtocolConfig").toString("hex"),
    );

    const vault = encodeVaultConfig({ authority: NS3.governanceAuthority, timelockSeconds: 42n });
    const mv = decodeVaultConfig(vault);
    const tv = decodeProtocolConfig("vault", vault);
    assert.equal(mv.authority.toBase58(), tv.authority.toBase58());
    assert.equal(mv.lpHolderShareBps, tv.lpHolderShareBps);
    assert.equal(mv.salvorShareBps, tv.salvorShareBps);
    assert.equal(mv.protocolShareBps, tv.protocolShareBps);
    assert.equal(mv.maxPriorityFeeCeilingLamports, tv.maxPriorityFeeCeilingLamports);
    assert.equal(mv.maxSlippageBps, tv.maxSlippageBps);
    assert.equal(mv.jupiterDustThresholdLamports, tv.jupiterDustThresholdLamports);
    assert.equal(mv.timelockSeconds, 42n);
    assert.equal(mv.emergencyPaused, tv.emergencyPaused);
    assert.equal(mv.bump, tv.bump);
  });

  test("29. loader account parsers reject malformed data (fail-closed decoders)", () => {
    assert.throws(() => parseProgramAccount(Buffer.alloc(20)));
    assert.throws(() => parseProgramAccount(Buffer.alloc(36))); // tag 0
    assert.throws(() =>
      parseProgramAccount(encodeProgramAccount("11111111111111111111111111111111")),
    ); // unset pointer
    assert.throws(() => parseProgramDataAccount(Buffer.alloc(8)));
    // a valid None-authority ProgramData parses fine
    const ok = parseProgramDataAccount(encodeProgramDataAccount({ authority: null, slot: 5n }));
    assert.equal(ok.authoritySet, false);
    assert.equal(ok.slot, 5n);
    const pd = encodeProgramDataAccount({ authority: null });
    pd.writeUInt8(7, 12); // invalid option flag
    assert.throws(() => parseProgramDataAccount(pd));
  });
});

// helper: CLI without --url
async function runCliNoUrl() {
  try {
    const { stdout } = await execFileP("node", [VERIFIER], { encoding: "utf8", timeout: 30_000 });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.status ?? err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err),
    };
  }
}
