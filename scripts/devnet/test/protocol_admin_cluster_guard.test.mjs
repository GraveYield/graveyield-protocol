// SPDX-License-Identifier: Apache-2.0
//
// protocol_admin_cluster_guard.test.mjs — regression battery for the
// administration CLI's cluster-identity guard and the explicit,
// mandatory governance authority (this workstream).
//
// TWO clearly separated test layers:
//
//   1. BEHAVIORAL (spawn `node protocol_admin.mjs`): the RPC endpoint is a
//      local, test-scoped node:http JSON-RPC stub on an ephemeral 127.0.0.1
//      port, and every signer path that must NOT be reached is a CANARY
//      (a path that does not exist — if the guard is bypassed, the error
//      becomes ENOENT instead of the expected refusal). No public cluster
//      is contacted, no transaction is ever submitted, and no key material
//      other than EPHEMERAL TEST KEYS generated in-memory is used.
//
//   2. UNIT (import the guard functions with an INJECTED getGenesisHash):
//      these are explicitly MOCKED-RPC tests. They pin the guard's
//      decision table (devnet pin / foreign / unavailable / empty /
//      local opt-in) without any network. They complement — never replace
//      — the behavioral layer above and the real local rehearsal.
//
// What each layer proves:
//   - behavioral: the real CLI entry point orders cluster verification
//     BEFORE signer loading and transaction construction, end to end;
//   - unit: every guard branch, including foreign/empty/timeout-style
//     failures that are awkward to stage over real sockets deterministically.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  assertClusterIdentity,
  assertGovernanceAuthority,
  isLoopbackUrl,
  parseExplicitAuthority,
  assembleOracleUpdateTransaction,
  buildScannerUpdateProtocolConfigIx,
  SCANNER_PROGRAM_ID,
} from "../protocol_admin.mjs";
import { NS3, DEVNET_GENESIS_HASH } from "../ns3_identities.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEVNET_DIR = dirname(HERE); // scripts/devnet
const ADMIN = join(DEVNET_DIR, "protocol_admin.mjs");

/** The real mainnet genesis (read via read-only RPC during this
 *  workstream) — the canonical FOREIGN-cluster fixture. */
const REAL_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

// ------------------------------------------------------------ mock RPC

/**
 * Minimal JSON-RPC stub bound to an ephemeral 127.0.0.1 port. Answers
 * getGenesisHash only; ANY other method returns a method-not-simulated
 * error so a test that reaches past the guard fails loudly instead of
 * quietly "succeeding" against a half-stubbed cluster.
 */
function startRpcServer({ genesisHash = DEVNET_GENESIS_HASH, failGenesis = false } = {}) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let rpc;
      try {
        rpc = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      const respond = (payload) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (rpc.method === "getGenesisHash") {
        if (failGenesis) {
          respond({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32000, message: "simulated genesis failure" },
          });
        } else {
          respond({ jsonrpc: "2.0", id: rpc.id, result: genesisHash });
        }
        return;
      }
      respond({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: "method not simulated by the test RPC stub" },
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// ------------------------------------------------------- spawn helpers

let SBX;
let server;
let port;
let url;

/**
 * ASYNC spawn — mandatory here: a sync spawn would block this process's
 * event loop, and the mock RPC server answering the child LIVES in this
 * process (that would deadlock every guarded invocation until timeout).
 */
function spawnAdmin(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ADMIN, ...args], {
      cwd: DEVNET_DIR,
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out, stderr: err });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: out, stderr: err || "spawn error" });
    });
  });
}

/** A throwaway TEST keypair file (ephemeral; never an owner key). */
async function writeKeypair(name) {
  // web3.js 3.x: Keypair.generate() is a thenable — await it (see
  // register_oracle_instruction.test.mjs for the same pitfall documented).
  const kp = await Keypair.generate();
  const p = join(SBX, name);
  writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  return p;
}

beforeEach(async () => {
  SBX = mkdtempSync(path.join(tmpdir(), "gy-admin-guard-"));
  ({ server, port } = await startRpcServer());
  url = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise((res) => server.close(res));
  }
  rmSync(SBX, { recursive: true, force: true });
  SBX = undefined;
  server = undefined;
});

// ========================================================================
// Behavioral layer — the real CLI entry point, canary signer paths
// ========================================================================

describe("protocol_admin.mjs cluster guard (behavioral, local RPC stub + canary signer paths)", () => {
  test("C1. foreign genesis blocks `pause` BEFORE the authority signer file is loaded", async () => {
    await server.close();
    ({ server, port } = await startRpcServer({ genesisHash: REAL_MAINNET_GENESIS }));
    url = `http://127.0.0.1:${port}`;
    const canary = join(SBX, "authority-never-read.json");
    const r = await spawnAdmin([
      "pause",
      "--url",
      url,
      "--authority",
      canary,
      "--program",
      "scanner",
      "--state",
      "true",
    ]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /NOT Solana Devnet/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /never-read/);
    assert.equal((r.stdout.match(/tx /g) ?? []).length, 0, "no transaction was submitted");
  });

  test("C3. unavailable genesis blocks `drill` before signer loading", async () => {
    await server.close();
    ({ server, port } = await startRpcServer({ failGenesis: true }));
    url = `http://127.0.0.1:${port}`;
    const canary = join(SBX, "drill-authority-never-read.json");
    const r = await spawnAdmin([
      "drill",
      "--url",
      url,
      "--authority",
      canary,
      "--intruder",
      join(SBX, "intruder-never-read.json"),
      "--program",
      "vault",
    ]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /could NOT be verified|did not report a genesis hash/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /never-read/);
    assert.equal((r.stdout.match(/tx /g) ?? []).length, 0);
  });

  test("C4. cluster verification precedes signer loading for register-oracle too", async () => {
    await server.close();
    ({ server, port } = await startRpcServer({ genesisHash: REAL_MAINNET_GENESIS }));
    url = `http://127.0.0.1:${port}`;
    const canary = join(SBX, "oracle-authority-never-read.json");
    const r = await spawnAdmin([
      "register-oracle",
      "--url",
      url,
      "--authority",
      canary,
      "--activity-oracle",
      NS3.activityOracle,
    ]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /NOT Solana Devnet/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /never-read/);
  });

  test("C5. `check` is guarded too: a foreign cluster refuses the read-only command", async () => {
    await server.close();
    ({ server, port } = await startRpcServer({ genesisHash: REAL_MAINNET_GENESIS }));
    url = `http://127.0.0.1:${port}`;
    const r = await spawnAdmin(["check", "--url", url, "--program", "scanner"]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /NOT Solana Devnet/);
  });

  test("C6. an arbitrary REMOTE endpoint cannot use the local-validator exception (no signer load)", async () => {
    const canary = join(SBX, "local-bypass-never-read.json");
    const r = await spawnAdmin([
      "pause",
      "--allow-local-validator",
      "--url",
      "https://api.devnet.solana.com",
      "--authority",
      canary,
      "--program",
      "scanner",
      "--state",
      "true",
    ]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /NOT a loopback endpoint/);
    // the refusal is unconditional — the real devnet RPC was never needed
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /never-read/);
  });

  test("C7. local mode cannot be activated against a non-loopback endpoint (drill)", async () => {
    const canary = join(SBX, "drill-local-bypass-never-read.json");
    const r = await spawnAdmin([
      "drill",
      "--allow-local-validator",
      "--url",
      "https://api.mainnet-beta.solana.com",
      "--authority",
      canary,
      "--intruder",
      join(SBX, "intruder-never-read.json"),
      "--program",
      "scanner",
    ]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /NOT a loopback endpoint/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /never-read/);
  });

  test("C8. missing --authority is refused BEFORE the deployer signer file is loaded", async () => {
    const canary = join(SBX, "deployer-never-read.json");
    const r = await spawnAdmin([
      "init-scanner",
      "--url",
      url, // stub answers the PINNED devnet genesis -> guard passes
      "--deployer",
      canary,
      // no --authority: the historic silent deployer fallback lived here
    ]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /missing required --authority/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /never-read/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /ENOENT/);
  });

  test("C9. malformed --authority is refused clearly", async () => {
    const r = await spawnAdmin([
      "init-scanner",
      "--url",
      url,
      "--deployer",
      join(SBX, "deployer-never-read.json"),
      "--authority",
      "n0t!!a-base58-key",
    ]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /malformed --authority/);
  });

  test("C10. the DEPLOYER is never silently substituted: init with the deployer pubkey as authority refuses on the governance pin", async () => {
    const canary = join(SBX, "deployer-never-read.json");
    const r = await spawnAdmin([
      "init-scanner",
      "--url",
      url,
      "--deployer",
      canary,
      "--authority",
      NS3.deployer, // the exact accident the old default produced
    ]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /not the pinned NS-3 governance authority/);
    // refused BEFORE any signer file was loaded
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /never-read/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /ENOENT/);
  });

  test("C11. a DIFFERENT non-governance authority is rejected for `pause` on Devnet", async () => {
    const authority = await writeKeypair("temp-authority.json");
    const r = await spawnAdmin([
      "pause",
      "--url",
      url,
      "--authority",
      authority,
      "--program",
      "vault",
      "--state",
      "true",
    ]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /not the pinned NS-3 governance authority/);
    assert.equal((r.stdout.match(/tx /g) ?? []).length, 0);
  });

  test("C12. the pinned governance authority passes the pin and reaches the signer stage (init)", async () => {
    const canary = join(SBX, "deployer-next-stage.json");
    const r = await spawnAdmin([
      "init-scanner",
      "--url",
      url,
      "--deployer",
      canary, // does not exist: failure must be the EXPECTED next stage
      "--authority",
      NS3.governanceAuthority,
    ]);
    assert.notEqual(r.code, 0);
    // the guard + authority validation PASSED; the failure is the signer load
    assert.match(`${r.stdout}\n${r.stderr}`, /ENOENT|no such file or directory/i);
  });

  test("C13. `drill` on Devnet rejects a temporary (non-governance) authority keypair", async () => {
    const authority = await writeKeypair("drill-temp-authority.json");
    const intruder = await writeKeypair("drill-intruder.json");
    const r = await spawnAdmin([
      "drill",
      "--url",
      url,
      "--authority",
      authority,
      "--intruder",
      intruder,
      "--program",
      "scanner",
    ]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /not the pinned NS-3 governance authority/);
  });

  test("C14. the fee payer remains independently configurable (unit: wiring, distinct roles)", async () => {
    // web3.js 3.x: Keypair.generate() is a thenable — await it.
    const authority = await Keypair.generate();
    const feePayer = await Keypair.generate();
    const ix = buildScannerUpdateProtocolConfigIx({
      programId: SCANNER_PROGRAM_ID,
      authority: authority.publicKey,
      activityOracle: feePayer.publicKey, // arbitrary distinct key for the wire
    });
    const { tx, instructionSignerCount } = assembleOracleUpdateTransaction({
      instruction: ix,
      authorityPubkey: authority.publicKey,
      feePayerPubkey: feePayer.publicKey,
    });
    assert.equal(tx.feePayer?.toBase58(), feePayer.publicKey.toBase58());
    assert.equal(instructionSignerCount, 2);
    // the authority role is untouched by the fee-payer choice
    const ixSigner = ix.keys.filter((k) => k.isSigner);
    assert.equal(ixSigner.length, 1);
    assert.equal(ixSigner[0].pubkey.toBase58(), authority.publicKey.toBase58());
  });
});

// ========================================================================
// Unit layer — guard decision table with an INJECTED genesis fetcher
// (explicitly mocked; no network). Complements the behavioral suite.
// ========================================================================

describe("assertClusterIdentity decision table (unit, MOCKED genesis fetch)", () => {
  const okFetch = async () => DEVNET_GENESIS_HASH;

  test("U1. exact pinned Devnet genesis -> mode devnet (next validation stage reachable)", async () => {
    const cluster = await assertClusterIdentity(
      { url: "https://api.devnet.solana.com" },
      {
        getGenesisHash: okFetch,
      },
    );
    assert.equal(cluster.mode, "devnet");
    assert.equal(cluster.genesisHash, DEVNET_GENESIS_HASH);
  });

  test("U2. foreign genesis -> refused", async () => {
    await assert.rejects(
      assertClusterIdentity(
        { url: "https://api.devnet.solana.com" },
        { getGenesisHash: async () => REAL_MAINNET_GENESIS },
      ),
      /NOT Solana Devnet/,
    );
  });

  test("U3. unavailable genesis (RPC throws) -> refused", async () => {
    await assert.rejects(
      assertClusterIdentity(
        { url: "https://api.devnet.solana.com" },
        {
          getGenesisHash: async () => {
            throw new Error("ECONNREFUSED");
          },
        },
      ),
      /could NOT be verified/,
    );
  });

  test("U4. empty genesis (RPC answers with nothing) -> refused", async () => {
    await assert.rejects(
      assertClusterIdentity(
        { url: "https://api.devnet.solana.com" },
        { getGenesisHash: async () => "" },
      ),
      /did not report a genesis hash/,
    );
  });

  test("U5. approved loopback + explicit local opt-in -> mode local (temporary authority path)", async () => {
    const cluster = await assertClusterIdentity(
      { url: "http://127.0.0.1:8899", "allow-local-validator": true },
      { getGenesisHash: async () => "LocalValidatorGenesis11111111111111111111111" },
    );
    assert.equal(cluster.mode, "local");
  });

  test("U6. local opt-in against a REMOTE endpoint is refused even when the genesis would match Devnet", async () => {
    await assert.rejects(
      assertClusterIdentity(
        { url: "https://api.devnet.solana.com", "allow-local-validator": true },
        { getGenesisHash: okFetch },
      ),
      /NOT a loopback endpoint/,
    );
  });

  test("U7. loopback endpoint WITHOUT the explicit opt-in is still held to the Devnet pin", async () => {
    await assert.rejects(
      assertClusterIdentity(
        { url: "http://127.0.0.1:8899" },
        { getGenesisHash: async () => "LocalValidatorGenesis11111111111111111111111" },
      ),
      /NOT Solana Devnet/,
    );
  });

  test("U8. malformed (non-string) genesis -> refused", async () => {
    await assert.rejects(
      assertClusterIdentity(
        { url: "https://api.devnet.solana.com" },
        { getGenesisHash: async () => undefined },
      ),
      /did not report a genesis hash/,
    );
  });

  test("U9. missing --url is refused by the guard itself", async () => {
    await assert.rejects(
      assertClusterIdentity({}, { getGenesisHash: okFetch }),
      /missing required --url/,
    );
  });
});

describe("isLoopbackUrl (unit, pure)", () => {
  test("U10. approved loopback spellings only", () => {
    assert.equal(isLoopbackUrl("http://127.0.0.1:8899"), true);
    assert.equal(isLoopbackUrl("http://localhost:8899"), true);
    assert.equal(isLoopbackUrl("http://[::1]:8899"), true);
    assert.equal(isLoopbackUrl("https://localhost"), true);
  });

  test("U11. remote or tricky hosts are NOT loopback", () => {
    assert.equal(isLoopbackUrl("https://api.devnet.solana.com"), false);
    assert.equal(isLoopbackUrl("https://api.mainnet-beta.solana.com"), false);
    assert.equal(isLoopbackUrl("http://localhost.evil.com:8899"), false);
    assert.equal(isLoopbackUrl("http://127.0.0.1.evil.com"), false);
    // a neighbor loopback-range address is NOT the approved endpoint
    assert.equal(isLoopbackUrl("http://127.0.0.2:8899"), false);
    assert.equal(isLoopbackUrl("ftp://127.0.0.1"), false);
    assert.equal(isLoopbackUrl("not a url"), false);
    assert.equal(isLoopbackUrl(""), false);
  });
});

describe("governance authority parsing + pinning (unit)", () => {
  test("U12. pinned governance authority is accepted on Devnet", () => {
    const pk = parseExplicitAuthority({ authority: NS3.governanceAuthority });
    assert.doesNotThrow(() => assertGovernanceAuthority({ mode: "devnet" }, pk));
  });

  test("U13. a different authority is rejected on Devnet (deployer, oracle, random)", () => {
    for (const candidate of [NS3.deployer, NS3.activityOracle, NS3.launchPriceOracle]) {
      assert.throws(
        () => assertGovernanceAuthority({ mode: "devnet" }, new PublicKey(candidate)),
        /not the pinned NS-3 governance authority/,
      );
    }
  });

  test("U14. the TEMPORARY rehearsal authority is accepted ONLY in local mode", async () => {
    const temp = (await Keypair.generate()).publicKey;
    assert.doesNotThrow(() => assertGovernanceAuthority({ mode: "local" }, temp));
    assert.throws(
      () => assertGovernanceAuthority({ mode: "devnet" }, temp),
      /not the pinned NS-3 governance authority/,
    );
  });

  test("U15. missing --authority is refused (no deployer fallback exists anymore)", () => {
    assert.throws(() => parseExplicitAuthority({}), /missing required --authority/);
    assert.throws(() => parseExplicitAuthority({ authority: "" }), /missing required --authority/);
    assert.throws(
      () => parseExplicitAuthority({ authority: true }), // bare flag, no value
      /missing required --authority/,
    );
  });

  test("U16. malformed --authority is refused with a clear error", () => {
    assert.throws(
      () => parseExplicitAuthority({ authority: "hello world" }),
      /malformed --authority/,
    );
    assert.throws(
      // 0 / O / I / l are NOT in the base58 alphabet — the constructor throws
      () => parseExplicitAuthority({ authority: "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl" }),
      /malformed --authority/,
    );
  });
});
