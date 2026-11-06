// pin_elfs.mjs — ELF provenance + pinning for the local validator.
//  - ELF SOURCE POLICY (NS-3, W1): the rehearsal pins LOCALLY BUILT ELFs via
//    `--local-so <scanner.so> <vault.so>` — and the local-so path itself
//    fail-closed-verifies the bytes against scripts/devnet/provenance.manifest.json
//    (approved NS-3 digests + SBPF v0 + structural identity) BEFORE pinning,
//    so even a standalone invocation cannot pin unverified bytes. The
//    default-less devnet-dump path (dumpAndVerifyElf) is retained ONLY as an
//    explicit verification tool for deployed programs (e.g. post-deployment
//    diagnostics); the W1 rehearsal orchestrator never calls it — the
//    harness must not depend on downloading program bytes from Devnet.
//  - fetches the real mainnet Raydium V4 / Serum / SPL fixtures via the
//    repo's own cross-validating fetcher (fetch_v4_fork_fixtures.mjs,
//    reused verbatim; READ-ONLY public RPC — third-party bytes, not
//    GraveYield program bytes)
//  - writes artifacts/sha256.txt (the pin table the driver embeds in the
//    report)
// NO program keypairs are needed: the validator loads ELFs with
// `--bpf-program <ID> <file.so>` (upgrades disabled) at the fixed NS-3 IDs.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dumpAndVerifyElf } from "./elf_dump.mjs";
import { checkProvenance } from "../ns3_check_provenance.mjs";

const DRIVER_DIR = dirname(fileURLToPath(import.meta.url));
// lifecycle_rehearsal -> scripts/devnet -> scripts -> REPO ROOT (three dirnames — fix 2)
const REPO_ROOT = dirname(dirname(dirname(DRIVER_DIR)));

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[++i];
}
const { artifacts, fixtures, rpc } = args;
for (const [k, v] of Object.entries({ artifacts, fixtures })) {
  if (!v) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

const SCANNER_ID = "EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL";
const VAULT_ID = "7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya";

// Optional NS-3 pre-deployment ELF source: `--local-so <scanner.so> <vault.so>`.
// When given, the locally built ELFs are pinned instead of devnet dumps.
// W1 HARD GATE: the local bytes must first pass the shared fail-closed
// provenance gate against scripts/devnet/provenance.manifest.json — sha256
// equal to the approved NS-3 digests, SBPF v0 header, structural NS-3
// identity, no NS-1/NS-2 legacy ID bytes. A mismatch ABORTS here: the pin
// table can never record bytes that are not the approved artifacts.
const localSo = args["local-so"]
  ? String(args["local-so"])
      .split(/[\s,]+/)
      .filter(Boolean)
  : null;
if (localSo && localSo.length !== 2) {
  console.error("--local-so expects exactly two paths: <scanner.so> <vault.so>");
  process.exit(2);
}
// `--rpc` is only meaningful for the explicit devnet-dump verification path,
// which the W1 rehearsal does NOT use (local builds only, W1 §7).
if (!localSo && !rpc) {
  console.error("missing --rpc (required for the devnet-dump path; not used with --local-so)");
  process.exit(2);
}
if (localSo) {
  const gate = checkProvenance({
    scannerSo: localSo[0],
    vaultSo: localSo[1],
    scannerId: SCANNER_ID,
    vaultId: VAULT_ID,
  });
  for (const c of gate.checks)
    console.log(`pin_elfs: ${c.ok ? "PASS" : "FAIL"} [${c.id}] ${c.detail}`);
  if (!gate.ok) {
    console.error(
      "pin_elfs: REFUSING to pin — the local ELFs are NOT the approved NS-3 artifacts " +
        "(provenance.manifest.json digest/arch/identity gate failed). Rebuild via " +
        "scripts/devnet/deploy_devnet.sh --build-only; never edit the manifest to pass.",
    );
    process.exit(1);
  }
}

mkdirSync(artifacts, { recursive: true });
mkdirSync(fixtures, { recursive: true });

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// 1. devnet program dumps (or local NS-3 builds pre-deployment) ---------------
// Finding A fix: each dump goes through dumpAndVerifyElf (elf_dump.mjs) —
// the destination is isolated before the dump, the subprocess result is
// fully checked (spawn error / signal / exit status), the output must be a
// real SBF ELF of the expected size, and the bytes are byte-compared against
// the on-chain program data over a fresh RPC read. A failed dump can no
// longer leave a stale binary from a previous run in place to be accepted.
const dumps = [
  { id: SCANNER_ID, out: join(artifacts, "grave_scanner.so") },
  { id: VAULT_ID, out: join(artifacts, "grave_vault.so") },
];
const dumpPins = [];
if (localSo) {
  // NS-3 W1 path: pin the LOCALLY BUILT, provenance-gated ELFs (no devnet
  // dump). The gate above already proved the bytes equal the approved
  // manifest digests; provenance is recorded honestly as "local build".
  for (let i = 0; i < dumps.length; i++) {
    copyFileSync(localSo[i], dumps[i].out);
    const sha256 = sha256File(dumps[i].out);
    dumpPins.push({
      programId: dumps[i].id,
      sha256,
      approved_match: true,
      source:
        "local build via deploy_devnet.sh --build-only (authenticated platform-tools v1.54); sha256 == approved NS-3 digests in scripts/devnet/provenance.manifest.json (fail-closed gate passed); NO devnet dump",
    });
    console.log(`pin_elfs: local ELF ${dumps[i].id} — sha256 ${sha256} (approved digests: MATCH)`);
  }
} else {
  for (const d of dumps) {
    console.log(`pin_elfs: solana program dump ${d.id}`);
    dumpPins.push(await dumpAndVerifyElf({ programId: d.id, outPath: d.out, rpcUrl: rpc }));
    console.log(`pin_elfs: ${d.id} verified — sha256 ${dumpPins[dumpPins.length - 1].sha256}`);
  }
}

// 2. real mainnet V4/serum/spl fixtures (repo fetcher, zero npm deps) ---------------
console.log("pin_elfs: fetch_v4_fork_fixtures.mjs (real mainnet bytes)");
execFileSync("node", [join(REPO_ROOT, "scripts", "fetch_v4_fork_fixtures.mjs")], {
  stdio: "inherit",
  env: {
    ...process.env,
    RPC_URL: process.env.FORK_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  },
  cwd: REPO_ROOT, // fetcher writes programs/grave-vault/tests/fixtures/ relative to repo root
});

// fetcher writes to programs/grave-vault/tests/fixtures/ — copy into our fixtures dir
const fetchedDir = join(REPO_ROOT, "programs", "grave-vault", "tests", "fixtures");
const wanted = [
  "manifest.json",
  "pool.bin",
  "coin_vault.bin",
  "pc_vault.bin",
  "coin_mint.bin",
  "pc_mint.bin",
  "lp_mint.bin",
  "wsol_mint.bin",
  "open_orders.bin",
  "market.bin",
  "target_orders.bin",
  "market_coin_vault.bin",
  "market_pc_vault.bin",
  "event_queue.bin",
  "bids.bin",
  "asks.bin",
  "vault_signer.bin",
  "raydium_v4.so",
  "serum_dex.so",
];
for (const f of wanted) {
  copyFileSync(join(fetchedDir, f), join(fixtures, f));
}

const manifest = JSON.parse(readFileSync(join(fixtures, "manifest.json"), "utf8"));
if (!manifest.pool_address || !manifest.accounts?.coin_vault?.pubkey) {
  throw new Error("fixture manifest missing expected fields");
}

// 3. pin table ---------------------------------------------------------------------
const pins = {
  scanner: {
    file: dumps[0].out,
    sha256: sha256File(dumps[0].out),
    bytes: statSync(dumps[0].out).size,
    source: localSo
      ? "local build (approved NS-3 digests verified)"
      : `devnet program dump ${SCANNER_ID}`,
    ...dumpPins[0],
  },
  vault: {
    file: dumps[1].out,
    sha256: sha256File(dumps[1].out),
    bytes: statSync(dumps[1].out).size,
    source: localSo
      ? "local build (approved NS-3 digests verified)"
      : `devnet program dump ${VAULT_ID}`,
    ...dumpPins[1],
  },
  raydium_v4: {
    file: join(fixtures, "raydium_v4.so"),
    sha256: sha256File(join(fixtures, "raydium_v4.so")),
    source: "mainnet fixture fetch",
  },
  serum_dex: {
    file: join(fixtures, "serum_dex.so"),
    sha256: sha256File(join(fixtures, "serum_dex.so")),
    source: "mainnet fixture fetch",
  },
  pool_accounts: Object.fromEntries(
    Object.entries(manifest.accounts).map(([k]) => [
      k,
      {
        sha256: sha256File(join(fixtures, `${k}.bin`)),
        bytes: statSync(join(fixtures, `${k}.bin`)).size,
      },
    ]),
  ),
};
writeFileSync(join(artifacts, "sha256.txt"), JSON.stringify(pins, null, 2) + "\n");
console.log(`pin_elfs: pins written to ${join(artifacts, "sha256.txt")}`);
console.log(
  `pin_elfs: DONE pool=${manifest.pool_address} base_is_coin_side=${manifest.base_is_coin_side}`,
);
