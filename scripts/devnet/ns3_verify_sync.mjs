// SPDX-License-Identifier: Apache-2.0
//
// ns3_verify_sync.mjs — NS-3 identity synchronization verifier (M-1).
//
// Asserts that every ACTIVE identity surface in graveyield-protocol names
// the SAME NS-3 program IDs, that the pinned ProtocolConfig PDA vectors
// are the honest derivations of those IDs, and — when sibling checkouts
// are supplied — that the downstream mirrors (salvor-bots src, console
// data.ts, grave-indexer defaults) agree. Exists because DR-001
// consequence 4 was prose, not code, and the salvage mirror drifted once
// already (salvor devnetSmoke NS-1 vectors, fixed in the NS-3 sync).
//
// Usage:
//   node ns3_verify_sync.mjs [--repos <dir-with-sibling-checkouts>]
//   (protocol-internal checks always run; cross-repo checks run only when
//    the sibling checkouts are found — no failure if absent, clearly
//    reported as SKIPPED.)
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { NS3, NS3_PDAS, configPdaWithBump, findProgramAddressSync } from "./ns3_identities.mjs";

const DEVNET_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(DEVNET_DIR));

// Legacy identities that must not appear in any ACTIVE surface.
export const LEGACY_IDS = {
  ns1Scanner: "5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF",
  ns1Vault: "HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6",
  ns1ScannerConfigPda: "GcdZJhCpg7sjgEEHTsoSkT2Pi83d8kP3NrTqdvMm2Bhu",
  ns1VaultConfigPda: "2SCqqpEwKMuWnJWe7UQJTzFeDPif4jUPUspWKZdZ5vaU",
  ns2Scanner: "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54",
  ns2Vault: "Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg",
  ns2ScannerConfigPda: "Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD",
  ns2VaultConfigPda: "hyKk983fguE2CGA5Dx5TLKfBft1AJrm7CHoe1PTUipS",
  ns2Authority: "AsB5uPtT7S6FB9G7nGp58nWA8iPFaH3bDuj49ss1EWXa",
  ns1Authority: "GCCuhCXd5qWVUik38Qv3maoRUoe2upiyJByo2Qyb68yk",
};

/** ACTIVE surfaces inside graveyield-protocol: file → regex capturing the ID. */
export const PROTOCOL_ACTIVE_SURFACES = [
  ["programs/grave-scanner/src/lib.rs", /declare_id!\("([1-9A-HJ-NP-Za-km-z]{43,44})"\)/],
  ["programs/grave-vault/src/lib.rs", /declare_id!\("([1-9A-HJ-NP-Za-km-z]{43,44})"\)/],
  ["Anchor.toml", /grave_scanner\s*=\s*"([1-9A-HJ-NP-Za-km-z]{43,44})"/g],
  ["Anchor.toml", /grave_vault\s*=\s*"([1-9A-HJ-NP-Za-km-z]{43,44})"/g],
  ["scripts/devnet/deploy_devnet.sh", /EXPECTED_SCANNER="([1-9A-HJ-NP-Za-km-z]{43,44})"/],
  ["scripts/devnet/deploy_devnet.sh", /EXPECTED_VAULT="([1-9A-HJ-NP-Za-km-z]{43,44})"/],
  ["scripts/devnet/protocol_admin.mjs", /SCANNER_PROGRAM_ID = new PublicKey\("([1-9A-HJ-NP-Za-km-z]{43,44})"\)/],
  ["scripts/devnet/protocol_admin.mjs", /VAULT_PROGRAM_ID = new PublicKey\("([1-9A-HJ-NP-Za-km-z]{43,44})"\)/],
  ["scripts/devnet/lifecycle_rehearsal/lib.mjs", /scanner: pk\("([1-9A-HJ-NP-Za-km-z]{43,44})"\)/],
  ["scripts/devnet/lifecycle_rehearsal/lib.mjs", /vault: pk\("([1-9A-HJ-NP-Za-km-z]{43,44})"\)/],
  ["scripts/devnet/lifecycle_rehearsal/pin_elfs.mjs", /SCANNER_ID = "([1-9A-HJ-NP-Za-km-z]{43,44})"/],
  ["scripts/devnet/lifecycle_rehearsal/pin_elfs.mjs", /VAULT_ID = "([1-9A-HJ-NP-Za-km-z]{43,44})"/],
  ["scripts/devnet/lifecycle_rehearsal/prepare_local_accounts.mjs", /--bpf-program ([1-9A-HJ-NP-Za-km-z]{43,44}) \$\{join\(artifacts, "grave_(?:scanner|vault)\.so"\)\}/g],
  ["sdk/src/client.ts", /DEVNET_SCANNER_PROGRAM_ID = "([1-9A-HJ-NP-Za-km-z]{43,44})"/],
  ["sdk/src/client.ts", /DEVNET_VAULT_PROGRAM_ID = "([1-9A-HJ-NP-Za-km-z]{43,44})"/],
  ["indexer/src/config.ts", /DEVNET_SCANNER_PROGRAM_ID = new PublicKey\(\s*"([1-9A-HJ-NP-Za-km-z]{43,44})"/],
  ["indexer/src/config.ts", /DEVNET_VAULT_PROGRAM_ID = new PublicKey\(\s*"([1-9A-HJ-NP-Za-km-z]{43,44})"/],
  ["ops/src/config.ts", /DEVNET_SCANNER_PROGRAM_ID = new PublicKey\(\s*"([1-9A-HJ-NP-Za-km-z]{43,44})"/],
  ["ops/src/config.ts", /DEVNET_VAULT_PROGRAM_ID = new PublicKey\(\s*"([1-9A-HJ-NP-Za-km-z]{43,44})"/],
];

export function read(rel) {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/** Extract every regex-1 capture (with /g flag support). */
function captures(text, re) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const out = [];
  let m;
  while ((m = g.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** The protocol-internal NS-3 sync check. Throws with a precise message on drift. */
export function checkProtocolInternal() {
  const problems = [];
  const seen = { scanner: new Set(), vault: new Set() };
  for (const [rel, re] of PROTOCOL_ACTIVE_SURFACES) {
    const text = read(rel);
    const caps = captures(text, re);
    if (caps.length === 0) {
      problems.push(`${rel}: identity pattern not found (pattern drifted?) — ${re}`);
      continue;
    }
    for (const cap of caps) {
      const bucket = rel.includes("vault") && !rel.includes("scanner") ? "vault" : null;
      // Bucket by which expected ID it equals, then verify homogeneity.
      if (cap === NS3.scannerProgramId) seen.scanner.add(rel);
      else if (cap === NS3.vaultProgramId) seen.vault.add(rel);
      else {
        problems.push(
          `${rel}: found program ID ${cap} — expected NS-3 scanner ${NS3.scannerProgramId} or vault ${NS3.vaultProgramId}`,
        );
      }
      void bucket;
    }
    // No legacy ID may survive in an ACTIVE surface.
    for (const [name, legacy] of Object.entries(LEGACY_IDS)) {
      if (text.includes(legacy)) {
        problems.push(`${rel}: ACTIVE surface still references legacy ${name} ${legacy}`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`NS-3 identity sync broken:\n  - ${problems.join("\n  - ")}`);
  return { ok: true, scannerSurfaces: [...seen.scanner], vaultSurfaces: [...seen.vault] };
}

/** Pinned config-PDA vectors must be the honest derivations of the NS-3 IDs. */
export function checkPinnedPdaVectors() {
  const problems = [];
  const derive = (id) => configPdaWithBump(new PublicKey(id))[0].toBase58();
  const scannerPda = derive(NS3.scannerProgramId);
  const vaultPda = derive(NS3.vaultProgramId);
  if (scannerPda !== NS3_PDAS.scannerConfigPda) problems.push("scanner PDA self-check failed");
  if (vaultPda !== NS3_PDAS.vaultConfigPda) problems.push("vault PDA self-check failed");

  const pdasTest = read("sdk/test/pdas.test.ts");
  if (!pdasTest.includes(NS3.scannerProgramId)) problems.push("sdk/test/pdas.test.ts: NS-3 scanner ID not pinned");
  if (!pdasTest.includes(NS3.vaultProgramId)) problems.push("sdk/test/pdas.test.ts: NS-3 vault ID not pinned");
  if (!pdasTest.includes(scannerPda)) problems.push(`sdk/test/pdas.test.ts: derived scanner PDA ${scannerPda} not pinned`);
  if (!pdasTest.includes(vaultPda)) problems.push(`sdk/test/pdas.test.ts: derived vault PDA ${vaultPda} not pinned`);

  const smoke = read("sdk/test/devnetSmoke.test.ts");
  if (!smoke.includes(scannerPda) || !smoke.includes(vaultPda)) {
    problems.push("sdk/test/devnetSmoke.test.ts: NS-3 config PDA vectors missing");
  }
  if (problems.length > 0) throw new Error(`NS-3 PDA vector pins broken:\n  - ${problems.join("\n  - ")}`);
  return { ok: true, scannerPda, vaultPda };
}

/** Cross-repo checks — run only when sibling checkouts exist; report skipped otherwise. */
export function checkCrossRepo(reposDir) {
  const results = [];
  const probe = (repo, rel) => {
    const p = reposDir ? join(reposDir, repo, rel) : null;
    return p && existsSync(p) ? { path: p, text: readFileSync(p, "utf8") } : null;
  };

  // salvor-bots: byte-equal src/ mirror + test pins
  const salvorClient = probe("salvor-bots", "src/client.ts");
  if (salvorClient) {
    const canonical = read("sdk/src/client.ts");
    const byteEqual = salvorClient.text === canonical;
    results.push({
      repo: "salvor-bots",
      check: "src/client.ts byte-equal to protocol sdk/src/client.ts (mirror policy)",
      ok: byteEqual,
    });
    const salvorPdas = probe("salvor-bots", "test/pdas.test.ts");
    if (salvorPdas) {
      const scannerPda = NS3_PDAS.scannerConfigPda;
      const vaultPda = NS3_PDAS.vaultConfigPda;
      results.push({
        repo: "salvor-bots",
        check: "test/pdas.test.ts pins NS-3 IDs + config PDAs",
        ok:
          salvorPdas.text.includes(NS3.scannerProgramId) &&
          salvorPdas.text.includes(NS3.vaultProgramId) &&
          salvorPdas.text.includes(scannerPda) &&
          salvorPdas.text.includes(vaultPda),
      });
    }
    const salvorSmoke = probe("salvor-bots", "test/devnetSmoke.test.ts");
    if (salvorSmoke) {
      results.push({
        repo: "salvor-bots",
        check: "test/devnetSmoke.test.ts free of NS-1-era PDA vectors (BL-4)",
        ok: !salvorSmoke.text.includes(LEGACY_IDS.ns1ScannerConfigPda) && !salvorSmoke.text.includes(LEGACY_IDS.ns1VaultConfigPda),
      });
    }
  } else {
    results.push({ repo: "salvor-bots", check: "src mirror", ok: null, note: "sibling checkout not found — skipped" });
  }

  // console: data.ts constants
  const consoleData = probe("graveyield-console", "src/lib/gy/data.ts");
  if (consoleData) {
    results.push({
      repo: "graveyield-console",
      check: "data.ts PROGRAM_IDS = NS-3 IDs + derived PDAs",
      ok:
        consoleData.text.includes(NS3.scannerProgramId) &&
        consoleData.text.includes(NS3.vaultProgramId) &&
        consoleData.text.includes(NS3_PDAS.scannerConfigPda) &&
        consoleData.text.includes(NS3_PDAS.vaultConfigPda),
    });
  } else {
    results.push({ repo: "graveyield-console", check: "data.ts constants", ok: null, note: "sibling checkout not found — skipped" });
  }

  // grave-indexer: config defaults
  const indexerConfig = probe("grave-indexer", "src/config.ts");
  if (indexerConfig) {
    results.push({
      repo: "grave-indexer",
      check: "src/config.ts DEVNET_* defaults = NS-3 IDs",
      ok:
        indexerConfig.text.includes(NS3.scannerProgramId) &&
        indexerConfig.text.includes(NS3.vaultProgramId),
    });
  } else {
    results.push({ repo: "grave-indexer", check: "config defaults", ok: null, note: "sibling checkout not found — skipped" });
  }

  return results;
}

function main() {
  const argv = process.argv.slice(2);
  let reposDir = null;
  const i = argv.indexOf("--repos");
  if (i !== -1 && argv[i + 1]) reposDir = argv[i + 1];
  else if (process.env.GRAVEYIELD_REPOS_DIR) reposDir = process.env.GRAVEYIELD_REPOS_DIR;
  else if (existsSync(join(REPO_ROOT, "..", "salvor-bots"))) reposDir = join(REPO_ROOT, "..");

  let failures = 0;
  const internal = checkProtocolInternal();
  console.log(`OK protocol-internal NS-3 sync (${internal.scannerSurfaces.length}+${internal.vaultSurfaces.length} surfaces)`);
  const pda = checkPinnedPdaVectors();
  console.log(`OK pinned PDA vectors (scanner ${pda.scannerPda}, vault ${pda.vaultPda})`);
  for (const r of checkCrossRepo(reposDir)) {
    if (r.ok === true) console.log(`OK ${r.repo}: ${r.check}`);
    else if (r.ok === false) {
      console.error(`FAIL ${r.repo}: ${r.check}`);
      failures++;
    } else console.log(`SKIP ${r.repo}: ${r.check} — ${r.note}`);
  }
  if (failures > 0) process.exit(1);
  console.log("NS-3 identity synchronization: VERIFIED");
}

// CLI entry only (the test suite imports the check functions directly).
if (process.argv[1] && process.argv[1].endsWith("ns3_verify_sync.mjs")) {
  main();
}
