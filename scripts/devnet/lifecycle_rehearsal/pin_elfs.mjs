// pin_elfs.mjs — ELF provenance + pinning for the local validator.
//  - dumps the DEPLOYED devnet scanner/vault ELFs (`solana program dump`, exact
//    NS-2 bytes — strongest provenance, C1 resolution (a))
//  - fetches the real mainnet Raydium V4 / Serum / SPL fixtures via the repo's
//    own cross-validating fetcher (fetch_v4_fork_fixtures.mjs, reused verbatim)
//  - writes artifacts/sha256.txt (the pin table the driver embeds in the report)
// NO program keypairs are needed: the validator loads ELFs with
// `--bpf-program <ID> <file.so>` (upgrades disabled) at the fixed NS-2 IDs.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(DRIVER_DIR)); // scripts/devnet/lifecycle_rehearsal -> repo root

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[++i];
}
const { artifacts, fixtures, rpc } = args;
for (const [k, v] of Object.entries({ artifacts, fixtures, rpc })) {
  if (!v) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

const SCANNER_ID = "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54";
const VAULT_ID = "Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg";

mkdirSync(artifacts, { recursive: true });
mkdirSync(fixtures, { recursive: true });

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// 1. devnet program dumps ---------------------------------------------------------
const solana = "solana";
const dumps = [
  { id: SCANNER_ID, out: join(artifacts, "grave_scanner.so") },
  { id: VAULT_ID, out: join(artifacts, "grave_vault.so") },
];
for (const d of dumps) {
  console.log(`pin_elfs: solana program dump ${d.id}`);
  spawnSync(solana, ["program", "dump", d.id, d.out, "--url", rpc], { stdio: "inherit" });
  const st = statSync(d.out, { throwIfNoEntry: false });
  if (!st || st.size < 100_000) throw new Error(`devnet dump of ${d.id} failed/too small`);
}

// 2. real mainnet V4/serum/spl fixtures (repo fetcher, zero npm deps) ---------------
console.log("pin_elfs: fetch_v4_fork_fixtures.mjs (real mainnet bytes)");
execFileSync("node", [join(REPO_ROOT, "scripts", "fetch_v4_fork_fixtures.mjs")], {
  stdio: "inherit",
  env: { ...process.env, RPC_URL: process.env.FORK_RPC_URL ?? "https://api.mainnet-beta.solana.com" },
  cwd: REPO_ROOT, // fetcher writes programs/grave-vault/tests/fixtures/ relative to repo root
});

// fetcher writes to programs/grave-vault/tests/fixtures/ — copy into our fixtures dir
const fetchedDir = join(REPO_ROOT, "programs", "grave-vault", "tests", "fixtures");
const wanted = [
  "manifest.json", "pool.bin", "coin_vault.bin", "pc_vault.bin", "coin_mint.bin",
  "pc_mint.bin", "lp_mint.bin", "wsol_mint.bin", "open_orders.bin", "market.bin",
  "target_orders.bin", "market_coin_vault.bin", "market_pc_vault.bin",
  "event_queue.bin", "bids.bin", "asks.bin", "vault_signer.bin",
  "raydium_v4.so", "serum_dex.so",
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
  scanner: { file: dumps[0].out, sha256: sha256File(dumps[0].out), bytes: statSync(dumps[0].out).size, source: `devnet program dump ${SCANNER_ID}` },
  vault: { file: dumps[1].out, sha256: sha256File(dumps[1].out), bytes: statSync(dumps[1].out).size, source: `devnet program dump ${VAULT_ID}` },
  raydium_v4: { file: join(fixtures, "raydium_v4.so"), sha256: sha256File(join(fixtures, "raydium_v4.so")), source: "mainnet fixture fetch" },
  serum_dex: { file: join(fixtures, "serum_dex.so"), sha256: sha256File(join(fixtures, "serum_dex.so")), source: "mainnet fixture fetch" },
  pool_accounts: Object.fromEntries(
    Object.entries(manifest.accounts).map(([k, v]) => [k, { sha256: sha256File(join(fixtures, `${k}.bin`)), bytes: statSync(join(fixtures, `${k}.bin`)).size }]),
  ),
};
writeFileSync(join(artifacts, "sha256.txt"), JSON.stringify(pins, null, 2) + "\n");
console.log(`pin_elfs: pins written to ${join(artifacts, "sha256.txt")}`);
console.log(`pin_elfs: DONE pool=${manifest.pool_address} base_is_coin_side=${manifest.base_is_coin_side}`);
