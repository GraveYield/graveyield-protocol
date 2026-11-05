// prepare_local_accounts.mjs — builds every account JSON the local validator
// loads at genesis and the local_plan.json the driver consumes.
//
//  - LP mint: REAL mainnet bytes with supply PATCHED to the local holder set
//    (C6 re-pin — economic grounding comes from manifest parsed.amm_lp_amount,
//    NOT from the re-pinned supply).
//  - Holder LP ATAs: built from scratch (165B SPL token layout).
//  - Market (F3, Finding E RETIRED): the fleet-core vault-signer mismatch is
//    FIXED on the salvor side — fleet-core (salvor-bots ns3/devnet-preparation)
//    now derives the market vault signer with the REAL OpenBook v1 rule
//    create_program_address([market, stored_nonce_le], market_program), which
//    reproduces the real mainnet signer for stored nonce 1. The W1 local
//    market is therefore loaded UNMODIFIED (real mainnet bytes): no nonce
//    re-pin, no market-vault owner re-point. The real-rule derivation is
//    still HARD-ASSERTED here on every run (fixture provenance gate) and
//    both derivations are recorded in local_plan.market. The October-era
//    string-seed re-pin adaptation is retired; see probe_vault_signer.mjs
//    and local_plan.market.
//  - loader_account_flags.txt is written ONCE, AFTER the holder section
//    (fix 9: writing it before the holder dumps appended left 0 LP holders
//    loaded and failed the snapshot completeness gate at 0 vs supply).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { initWeb3, initIds, IDS, getWeb3 } from "./lib.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[++i];
}
const { fixtures, artifacts, keys, salvorBots } = args;
for (const [k, v] of Object.entries({ fixtures, artifacts, keys, salvorBots })) {
  if (!v) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

await initWeb3(salvorBots);
initIds();
const W3 = getWeb3();
const { PublicKey } = W3;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const manifest = JSON.parse(readFileSync(join(fixtures, "manifest.json"), "utf8"));
const outDir = join(artifacts, "accounts");
mkdirSync(outDir, { recursive: true });

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}
function accountJson({ pubkey, owner, lamports, data, executable = false }) {
  return {
    pubkey,
    account: {
      lamports,
      data: [b64(data), "base64"],
      owner,
      executable,
      rentEpoch: 0,
    },
  };
}
function loadBin(name) {
  return Buffer.from(readFileSync(join(fixtures, `${name}.bin`)));
}
function metaOf(name) {
  const m = manifest.accounts[name];
  if (!m) throw new Error(`manifest missing account ${name}`);
  return m;
}

// --- 1. holder keypairs + LP amounts (C6) --------------------------------------------
async function readKeypair(name) {
  // web3.js 3.x: Keypair.fromSecretKey is async (fix 3)
  return W3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(keys, `${name}.json`), "utf8"))),
  );
}
const salvor = await readKeypair("salvor");
const claimantA = await readKeypair("claimant_a");
const claimantB = await readKeypair("claimant_b");

const ammLp = BigInt(manifest.parsed?.amm_lp_amount ?? 0n);
if (ammLp <= 0n) throw new Error(`manifest amm_lp_amount must be > 0, got ${ammLp}`);
const burnAmount = ammLp / 10_000n; // floor(amm_lp_amount/10_000) — the salvage burn
if (burnAmount <= 0n) throw new Error(`derived burn amount is zero (amm_lp_amount=${ammLp})`);
const claimA = burnAmount / 3n;
const claimB = burnAmount / 5n;
const LP_MINT = new PublicKey(metaOf("lp_mint").pubkey);

const holders = [
  { name: "salvor", kp: salvor, balance: burnAmount },
  { name: "claimant_a", kp: claimantA, balance: claimA },
  { name: "claimant_b", kp: claimantB, balance: claimB },
];
const supply = holders.reduce((a, h) => a + h.balance, 0n);

function holderAta(owner) {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM.toBytes(), LP_MINT.toBytes()],
    ATA_PROGRAM,
  )[0];
}
for (const h of holders) h.lp_ata = holderAta(h.kp.publicKey);

// --- 2. patched lp_mint (supply re-pin) -----------------------------------------------
const SPL_MINT_SUPPLY_OFFSET = 36;
const lpMintBytes = loadBin("lp_mint");
lpMintBytes.writeBigUInt64LE(supply, SPL_MINT_SUPPLY_OFFSET);
writeFileSync(
  join(outDir, "lp_mint.json"),
  JSON.stringify(
    accountJson({
      pubkey: LP_MINT.toBase58(),
      owner: metaOf("lp_mint").owner,
      lamports: metaOf("lp_mint").lamports,
      data: lpMintBytes,
    }),
  ) + "\n",
);

// --- 3. market identity (F3/Finding E — real OpenBook rule, NO re-pin) -----------------
// The market, market_coin_vault and market_pc_vault are loaded EXACTLY as
// fetched (real mainnet bytes). The only market logic here is the hard
// fixture-provenance assertion: the REAL OpenBook v1 rule with the STORED
// nonce must reproduce the manifest's vault signer (which the fetcher
// cross-proved against the Raydium pool bytes AND both market vault token
// accounts' owner fields). The historical string-seed PDA derivation is
// recorded for contrast only — fleet-core no longer uses it.
const MARKET_NONCE_OFFSET = 45; // u64 LE vault_signer_nonce (probe_vault_signer.mjs finding)
const marketProgram = new PublicKey(manifest.market_program);
const marketPk = new PublicKey(metaOf("market").pubkey);
const marketBytes = loadBin("market");
const storedNonce = marketBytes.readBigUInt64LE(MARKET_NONCE_OFFSET);
// REAL OpenBook v1 rule ([market, stored_nonce_le]) — the canonical
// relationship the real mainnet market actually satisfies.
const realSchemeSigner = PublicKey.createProgramAddressSync(
  [
    marketPk.toBytes(),
    (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(storedNonce);
      return b;
    })(),
  ],
  marketProgram,
);
if (realSchemeSigner.toBase58() !== metaOf("vault_signer").pubkey) {
  throw new Error(
    `real OpenBook derivation ([market, nonce_le]) does not reproduce the manifest vault signer ` +
      `(${realSchemeSigner.toBase58()} vs ${metaOf("vault_signer").pubkey}) — fixture provenance broken`,
  );
}
// Historical fleet-core string-seed scheme — recorded for contrast; since
// salvor-bots' Finding E remediation fleet-core derives the REAL rule, so
// the former re-pin adaptation is RETIRED (the unmodified fixture is the
// compatible one).
const [stringSeedSigner, stringSeedBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault-signer", "utf8"), marketPk.toBytes()],
  marketProgram,
);
for (const acct of ["market", "market_coin_vault", "market_pc_vault"]) {
  const m = metaOf(acct);
  writeFileSync(
    join(outDir, `${acct}.json`),
    JSON.stringify(
      accountJson({ pubkey: m.pubkey, owner: m.owner, lamports: m.lamports, data: loadBin(acct) }),
    ) + "\n",
  );
}

// --- 4. untouched pool accounts (real mainnet bytes) -------------------------------------
const plainAccounts = [
  "pool",
  "coin_vault",
  "pc_vault",
  "coin_mint",
  "pc_mint",
  "wsol_mint",
  "open_orders",
  "target_orders",
  "event_queue",
  "bids",
  "asks",
  "vault_signer",
];
for (const name of plainAccounts) {
  const m = metaOf(name);
  writeFileSync(
    join(outDir, `${name}.json`),
    JSON.stringify(
      accountJson({ pubkey: m.pubkey, owner: m.owner, lamports: m.lamports, data: loadBin(name) }),
    ) + "\n",
  );
}

// --- 5. holder LP ATAs (fresh local token accounts) ---------------------------------------
const TOKEN_ACCOUNT_LAMPORTS = 2_039_280; // rent-exempt minimum for a 165B account
for (const h of holders) {
  const data = Buffer.alloc(165);
  data.subarray(0, 32).set(LP_MINT.toBytes());
  data.subarray(32, 64).set(h.kp.publicKey.toBytes());
  data.writeBigUInt64LE(h.balance, 64);
  data.writeUInt32LE(0, 72); // delegate option: none
  data.writeUInt8(1, 108); // state: initialized
  data.writeUInt32LE(0, 112); // is_native option: none
  data.writeBigUInt64LE(0n, 116); // delegated amount
  data.writeUInt32LE(0, 144); // close authority option: none
  writeFileSync(
    join(outDir, `${h.name}_lp_ata.json`),
    JSON.stringify(
      accountJson({
        pubkey: h.lp_ata.toBase58(),
        owner: TOKEN_PROGRAM.toBase58(),
        lamports: TOKEN_ACCOUNT_LAMPORTS,
        data,
      }),
    ) + "\n",
  );
}

// --- 6. local_plan.json --------------------------------------------------------------------
const plan = {
  pool: manifest.pool_address,
  amm_program: manifest.amm_program,
  market_program: manifest.market_program,
  base_is_coin_side: manifest.base_is_coin_side,
  wsol_mint: manifest.wsol_mint,
  memecoin_mint: manifest.base_is_coin_side ? metaOf("pc_mint").pubkey : metaOf("coin_mint").pubkey,
  lp_mint: LP_MINT.toBase58(),
  lp_total_supply_repinned: supply.toString(),
  amm_lp_amount: ammLp.toString(),
  burn_amount: burnAmount.toString(),
  salvage_lp_amount: burnAmount.toString(),
  market: {
    stored_nonce: storedNonce.toString(),
    loaded_unmodified: true,
    real_scheme_signer_from_stored_nonce: realSchemeSigner.toBase58(),
    real_scheme_matches_manifest_vault_signer:
      realSchemeSigner.toBase58() === metaOf("vault_signer").pubkey,
    fleet_core_string_seed_signer: stringSeedSigner.toBase58(),
    fleet_core_string_seed_bump: String(stringSeedBump),
    note: "F3 (Finding E, RETIRED adaptation): fleet-core now derives the market vault signer with the REAL OpenBook v1 rule create_program_address([market, stored_nonce_le]) — the unmodified mainnet market (stored nonce 1) IS canonical under it, so the W1 local market loads UNMODIFIED. The October-era string-seed nonce re-pin is retired; the string-seed PDA is recorded for contrast only.",
  },
  holders: Object.fromEntries(
    holders.map((h) => [
      h.name,
      {
        pubkey: h.kp.publicKey.toBase58(),
        lp_ata: h.lp_ata.toBase58(),
        balance: h.balance.toString(),
      },
    ]),
  ),
  uncx_marker: PublicKey.findProgramAddressSync(
    [Buffer.from("global_lp_tracker", "utf8"), new PublicKey(manifest.pool_address).toBytes()],
    IDS.uncxLocker,
  )[0].toBase58(),
};
writeFileSync(join(artifacts, "local_plan.json"), JSON.stringify(plan, null, 2) + "\n");

// --- 7. loader_account_flags.txt — dedupe + write AFTER the holder section (fix 9) ---------
const flagLines = [];
const pushUnique = (line) => {
  if (!flagLines.includes(line)) flagLines.push(line);
};
pushUnique(
  `--bpf-program EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL ${join(artifacts, "grave_scanner.so")}`,
);
pushUnique(
  `--bpf-program 7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya ${join(artifacts, "grave_vault.so")}`,
);
pushUnique(
  `--bpf-program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 ${join(fixtures, "raydium_v4.so")}`,
);
pushUnique(`--bpf-program ${metaOf("market").owner} ${join(fixtures, "serum_dex.so")}`);
for (const name of [
  ...plainAccounts,
  "lp_mint",
  "market",
  "market_coin_vault",
  "market_pc_vault",
]) {
  const pkStr = name === "lp_mint" ? LP_MINT.toBase58() : metaOf(name).pubkey;
  const file = ["lp_mint", "market", "market_coin_vault", "market_pc_vault"].includes(name)
    ? join(outDir, `${name === "lp_mint" ? "lp_mint" : name}.json`)
    : join(outDir, `${name}.json`);
  pushUnique(`--account ${pkStr} ${file}`);
}
for (const h of holders) {
  pushUnique(`--account ${h.lp_ata.toBase58()} ${join(outDir, `${h.name}_lp_ata.json`)}`);
}
pushUnique("--account-index spl-token-mint");
writeFileSync(join(artifacts, "loader_account_flags.txt"), flagLines.join("\n") + "\n");

console.log(
  `prepare_local_accounts: supply=${supply} burn=${burnAmount} claimA=${claimA} claimB=${claimB}`,
);
console.log(
  `prepare_local_accounts: market loaded UNMODIFIED (stored nonce ${storedNonce}; real OpenBook rule reproduces the manifest vault signer; string-seed PDA ${stringSeedSigner.toBase58()} recorded for contrast only)`,
);
console.log(
  `prepare_local_accounts: ${flagLines.length} loader flags → ${join(artifacts, "loader_account_flags.txt")}`,
);
console.log("prepare_local_accounts: DONE");
