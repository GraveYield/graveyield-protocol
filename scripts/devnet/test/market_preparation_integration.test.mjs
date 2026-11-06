// market_preparation_integration.test.mjs — W1 P2 regression: the REAL
// market account-preparation path (prepare_local_accounts.mjs) exercised
// end-to-end with controlled fixture inputs.
//
// The derivation-only tests (fixture_vault_signer.test.mjs) pin the OpenBook
// math but never execute the account-preparation implementation. This test
// runs the REAL prepare_local_accounts.mjs subprocess against a deterministic
// temporary fixture directory (isolated throwaway keys — no production
// custody paths, no RPC, no validator) and verifies:
//   1. the generated market account bytes EXACTLY match the input fixture
//      bytes (no transformation of any kind),
//   2. the stored nonce is unchanged (offset 45, u64 LE),
//   3. the market coin-vault account retains its original owner,
//   4. the market PC-vault account retains its original owner,
//   5. the REAL OpenBook v1 derivation ([market, stored_nonce_le]) still
//      reproduces the fixture's expected vault signer,
//   6. no historical string-seed re-pin or market-vault owner transformation
//      is introduced (local_plan records loaded_unmodified, and the vault
//      owners are NOT the retired string-seed PDA),
// plus a NEGATIVE case: a fixture whose manifest vault signer does NOT match
// the real OpenBook derivation must be REJECTED ("fixture provenance broken").
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// test -> devnet -> scripts -> repo root
const REPO_ROOT = dirname(dirname(dirname(HERE)));
const PREPARE = join(
  REPO_ROOT,
  "scripts",
  "devnet",
  "lifecycle_rehearsal",
  "prepare_local_accounts.mjs",
);

const SERUM = new PublicKey("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const RAYDIUM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const SYSTEM = "11111111111111111111111111111111";
const STORED_NONCE = 1n;
const NONCE_OFFSET = 45;

// web3.js 3.x ships the ASYNC statics; the Sync variants exist only under the
// salvor web3compat patch (inside the subprocess under test). Same semantics.
async function createProgramAddress(seeds, programId) {
  return PublicKey.createProgramAddress(seeds, programId);
}
async function findPda(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return [await createProgramAddress([...seeds, Buffer.from([bump])], programId), bump];
    } catch {
      // on-curve — keep walking down
    }
  }
  throw new Error("no valid bump found");
}
function nonceLe(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

// The salvor checkout supplies web3.js + the web3compat patch for the
// subprocess. Default: the orchestrator's own default ($REPO_ROOT/../salvor-bots).
const SALVOR_BOTS = process.env.SALVOR_BOTS ?? join(REPO_ROOT, "..", "salvor-bots");
const SALVOR_SKIP =
  !existsSync(join(SALVOR_BOTS, "package.json")) ||
  !existsSync(join(SALVOR_BOTS, "dist", "index.js"))
    ? "salvor-bots checkout not available/built — run `pnpm install && pnpm -r build` in the salvor workspace"
    : null;

async function buildFixtures({ breakVaultSigner = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gy-mkt-prep-"));
  const fix = join(root, "fixtures");
  const art = join(root, "artifacts");
  const keys = join(root, "keys");
  for (const d of [fix, art, keys]) mkdirSync(d, { recursive: true });

  // Deterministic off-curve pubkeys (PDA-derived under the owning program).
  const market = (await findPda([Buffer.from("gy-mkt-fixture", "utf8")], SERUM))[0];
  const vaultSigner = await createProgramAddress([market.toBytes(), nonceLe(STORED_NONCE)], SERUM);
  const [stringSeedPda] = await findPda(
    [Buffer.from("vault-signer", "utf8"), market.toBytes()],
    SERUM,
  );
  const lpMint = (await findPda([Buffer.from("gy-lp-mint", "utf8")], TOKEN))[0];
  const pool = (await findPda([Buffer.from("gy-pool", "utf8")], RAYDIUM))[0];
  const coinMint = (await findPda([Buffer.from("gy-coin", "utf8")], TOKEN))[0];
  const pcMint = (await findPda([Buffer.from("gy-pc", "utf8")], TOKEN))[0];
  const coinVault = (await findPda([Buffer.from("gy-coin-v", "utf8")], TOKEN))[0];
  const pcVault = (await findPda([Buffer.from("gy-pc-v", "utf8")], TOKEN))[0];
  const openOrders = (await findPda([Buffer.from("gy-oo", "utf8")], SERUM))[0];

  // Recorded for the contrast assertion: the RETIRED string-seed PDA must
  // never become a vault owner or the stored nonce.
  assert.notEqual(vaultSigner.toBase58(), stringSeedPda.toBase58());

  const manifestVaultSigner = breakVaultSigner ? coinMint.toBase58() : vaultSigner.toBase58();

  const accounts = {
    market: { pubkey: market.toBase58(), owner: SERUM.toBase58(), lamports: 1_000_000 },
    market_coin_vault: {
      pubkey: coinVault.toBase58(),
      owner: manifestVaultSigner,
      lamports: 2_039_280,
    },
    market_pc_vault: {
      pubkey: pcVault.toBase58(),
      owner: manifestVaultSigner,
      lamports: 2_039_280,
    },
    lp_mint: { pubkey: lpMint.toBase58(), owner: TOKEN.toBase58(), lamports: 1_000_000 },
    pool: { pubkey: pool.toBase58(), owner: RAYDIUM.toBase58(), lamports: 1_000_000 },
    coin_vault: {
      pubkey: coinVault.toBase58(),
      owner: vaultSigner.toBase58(),
      lamports: 2_039_280,
    },
    pc_vault: { pubkey: pcVault.toBase58(), owner: vaultSigner.toBase58(), lamports: 2_039_280 },
    coin_mint: { pubkey: coinMint.toBase58(), owner: TOKEN.toBase58(), lamports: 1_000_000 },
    pc_mint: { pubkey: pcMint.toBase58(), owner: TOKEN.toBase58(), lamports: 1_000_000 },
    wsol_mint: { pubkey: coinMint.toBase58(), owner: TOKEN.toBase58(), lamports: 1_000_000 },
    open_orders: { pubkey: openOrders.toBase58(), owner: SERUM.toBase58(), lamports: 1_000_000 },
    target_orders: { pubkey: openOrders.toBase58(), owner: SERUM.toBase58(), lamports: 1_000_000 },
    event_queue: { pubkey: openOrders.toBase58(), owner: SERUM.toBase58(), lamports: 1_000_000 },
    bids: { pubkey: openOrders.toBase58(), owner: SERUM.toBase58(), lamports: 1_000_000 },
    asks: { pubkey: openOrders.toBase58(), owner: SERUM.toBase58(), lamports: 1_000_000 },
    vault_signer: { pubkey: manifestVaultSigner, owner: SYSTEM, lamports: 1_000_000 },
  };
  writeFileSync(
    join(fix, "manifest.json"),
    JSON.stringify({
      pool_address: pool.toBase58(),
      amm_program: RAYDIUM.toBase58(),
      market_program: SERUM.toBase58(),
      base_is_coin_side: true,
      wsol_mint: coinMint.toBase58(),
      parsed: { amm_lp_amount: "5000000" }, // → burn 500, claims 166/100, supply 766
      accounts,
    }) + "\n",
  );

  // Account bytes: content arbitrary EXCEPT the market's stored nonce @45
  // (the layout the script reads) and the lp_mint's supply @36 (patched).
  const bin = (name, size) => writeFileSync(join(fix, `${name}.bin`), Buffer.alloc(size, 0));
  const marketBytes = Buffer.alloc(388, 0);
  marketBytes.writeBigUInt64LE(STORED_NONCE, NONCE_OFFSET);
  writeFileSync(join(fix, "market.bin"), marketBytes);
  for (const [name, size] of [
    ["market_coin_vault", 165],
    ["market_pc_vault", 165],
    ["lp_mint", 82],
    ["pool", 752],
    ["coin_vault", 165],
    ["pc_vault", 165],
    ["coin_mint", 82],
    ["pc_mint", 82],
    ["wsol_mint", 82],
    ["open_orders", 322],
    ["target_orders", 3220],
    ["event_queue", 1212],
    ["bids", 8],
    ["asks", 8],
    ["vault_signer", 0],
  ])
    bin(name, size);

  // Isolated throwaway keypairs (test-local, never production custody).
  for (const name of ["salvor", "claimant_a", "claimant_b"]) {
    const kp = nacl.sign.keyPair();
    writeFileSync(join(keys, `${name}.json`), JSON.stringify([...kp.secretKey]) + "\n");
  }
  return { root, fix, art, keys, market, vaultSigner, stringSeedPda, accounts, marketBytes };
}

function runPrepare(fix, art, keys) {
  return spawnSync(
    process.execPath,
    [PREPARE, "--artifacts", art, "--fixtures", fix, "--keys", keys, "--salvorBots", SALVOR_BOTS],
    { encoding: "utf8" },
  );
}

function accountFromJson(path) {
  const j = JSON.parse(readFileSync(path, "utf8"));
  return {
    pubkey: j.pubkey,
    owner: j.account.owner,
    data: Buffer.from(j.account.data[0], "base64"),
  };
}

describe(
  "prepare_local_accounts market path (integration, real subprocess)",
  { skip: SALVOR_SKIP ?? false },
  () => {
    test("market loads UNMODIFIED: bytes, nonce, vault owners, real OpenBook derivation", async () => {
      const fx = await buildFixtures();
      try {
        const r = runPrepare(fx.fix, fx.art, fx.keys);
        assert.equal(
          r.status,
          0,
          `prepare_local_accounts failed:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );

        // 1. Generated market bytes EXACTLY match the input fixture bytes.
        const outMarket = accountFromJson(join(fx.art, "accounts", "market.json"));
        assert.equal(outMarket.pubkey, fx.accounts.market.pubkey);
        assert.ok(outMarket.data.equals(fx.marketBytes), "market bytes were transformed");
        assert.equal(outMarket.owner, fx.accounts.market.owner);

        // 2. The stored nonce is unchanged.
        assert.equal(outMarket.data.readBigUInt64LE(NONCE_OFFSET), STORED_NONCE);

        // 3./4. Market coin-vault and PC-vault keep their ORIGINAL owners.
        const outCoin = accountFromJson(join(fx.art, "accounts", "market_coin_vault.json"));
        const outPc = accountFromJson(join(fx.art, "accounts", "market_pc_vault.json"));
        assert.equal(outCoin.pubkey, fx.accounts.market_coin_vault.pubkey);
        assert.equal(outCoin.owner, fx.vaultSigner.toBase58(), "coin-vault owner was re-pointed");
        assert.equal(outPc.pubkey, fx.accounts.market_pc_vault.pubkey);
        assert.equal(outPc.owner, fx.vaultSigner.toBase58(), "pc-vault owner was re-pointed");
        assert.ok(outCoin.data.equals(Buffer.alloc(165, 0)), "coin-vault bytes were transformed");
        assert.ok(outPc.data.equals(Buffer.alloc(165, 0)), "pc-vault bytes were transformed");

        // 5. The REAL OpenBook v1 derivation (market ADDRESS + stored nonce,
        //    the script's own rule) over the OUTPUT state still reproduces the
        //    fixture's expected vault signer.
        const derived = await createProgramAddress(
          [
            new PublicKey(outMarket.pubkey).toBytes(),
            nonceLe(outMarket.data.readBigUInt64LE(NONCE_OFFSET)),
          ],
          SERUM,
        );
        assert.equal(derived.toBase58(), fx.vaultSigner.toBase58());

        // 6. No historical string-seed re-pin or owner transformation: the plan
        //    records the unmodified load, and no output owner is the RETIRED
        //    string-seed PDA.
        const plan = JSON.parse(readFileSync(join(fx.art, "local_plan.json"), "utf8"));
        assert.equal(plan.market.loaded_unmodified, true);
        assert.equal(plan.market.stored_nonce, STORED_NONCE.toString());
        assert.equal(plan.market.real_scheme_matches_manifest_vault_signer, true);
        assert.equal(plan.market.real_scheme_signer_from_stored_nonce, fx.vaultSigner.toBase58());
        assert.notEqual(outCoin.owner, fx.stringSeedPda.toBase58());
        assert.notEqual(outPc.owner, fx.stringSeedPda.toBase58());
        assert.notEqual(plan.market.fleet_core_string_seed_signer, outCoin.owner);
        // The contrast record is inert: the string-seed bump never lands in the
        // market's nonce field.
        assert.notEqual(
          BigInt(plan.market.stored_nonce),
          BigInt(plan.market.fleet_core_string_seed_bump),
        );
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    });

    test("NEGATIVE: a manifest vault signer that breaks the real OpenBook derivation is REJECTED", async () => {
      const fx = await buildFixtures({ breakVaultSigner: true });
      try {
        const r = runPrepare(fx.fix, fx.art, fx.keys);
        assert.notEqual(r.status, 0, "a broken fixture must be rejected");
        assert.match(r.stderr, /fixture provenance broken/);
        assert.match(r.stderr, /does not reproduce the manifest vault signer/);
        // Fail-closed: no local_plan may be produced from a broken fixture.
        assert.equal(existsSync(join(fx.art, "local_plan.json")), false);
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    });
  },
);
