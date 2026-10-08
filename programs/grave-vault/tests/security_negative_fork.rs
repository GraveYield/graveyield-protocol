// SPDX-License-Identifier: Apache-2.0
//
// Phase 7 security-hardening fork harness (vault side): on-chain negative
// paths that the unit tests and the earlier suites do not cover.
//
// Executes `salvage_pool`, `claim_lp_proceeds`, `update_protocol_config`,
// `emergency_pause`, and `initialize` against the REAL mainnet Raydium V4 /
// OpenBook / SPL-token bytecode inside an in-process Solana VM
// (`solana-program-test`), seeded with byte-for-byte mainnet state of the
// canonical SOL/USDC V4 pool
// 58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2.
//
// The adversarial shapes proven here (the roadmap's malicious-account,
// CPI-account-substitution, PDA-collision/authority, replay, and
// emergency-pause rows):
//
//   1. Authority: a wrong signer on `update_protocol_config` or
//      `emergency_pause` reverts 7000 (`Unauthorized` — the `has_one`
//      binding); the rightful authority's call succeeds (positive control).
//   2. Pause: `emergency_pause(true)` gates the FIRST salvage of a pool
//      with 7003 (`ProtocolPaused`) and the transaction is atomic — the
//      PoolRegistry / SalvageReceipt / lazy-init PDAs exist nowhere after
//      the revert; `claim_lp_proceeds` stays live by Charter (proven in
//      the Phase 4 suite); unpausing restores salvage; a replayed salvage
//      of the SAME pool then dies on the PoolRegistry `init` constraint
//      with the sealed root byte-identical (one-shot settlement).
//   3. CPI account substitution: substituting the AMM authority slot
//      (remaining_accounts[0]) with an attacker-owned key reverts 7013
//      (`PreflightFailed`) before any CPI — the Raydium adapter pins
//      remaining[0] to the REAL `RAYDIUM_V4_AMM_AUTHORITY` by address
//      equality; the honest salvage succeeds afterwards.
//   4. Malicious account (cert forgery at the ownership layer): an
//      EligibilityCert PDA account with byte-identical CERT DATA but an
//      ATTACKER-OWNED account owner is repelled by Anchor's ownership
//      constraint — the data alone proves nothing.
//   5. Initialize takeover: re-running `initialize` on an existing
//      ProtocolConfig PDA fails on the `init` constraint — the
//      first-caller-wins window closes at genesis; authority cannot be
//      stolen by re-initialization.
//   6. Claim PDA collisions: a claim against a pool that was never
//      salvaged (no PoolRegistry) fails; a claim submitting a
//      `claim_record` PDA derived for a DIFFERENT pool fails on the seed
//      constraint; both with zero registry movement.
//
// The harness forges exactly three things (documented shortcuts, same
// contract as the earlier suites): the EligibilityCert PDA (serialised
// with GraveScanner's own type), the salvor's LP balance, and the
// salvor's lamports. The conversion leg is skipped via the D6 dust
// threshold (`u64::MAX` — everything is dust), so no Jupiter stand-in is
// needed and the settlement path is the withdraw-leg WSOL only.
//
// Fixtures via `scripts/fetch_v4_fork_fixtures.mjs` (gitignored; tests SKIP
// without them). `grave_vault.so` must be in tests/fixtures
// (scripts/build_fork_harness.sh builds it).

// solana-sdk 2.3 deprecates the monolithic `system_program` / `bpf_loader`
// modules in favour of the split interface crates; the deprecated paths
// still work and keep the harness on the same re-exports anchor-lang's
// prelude uses (same rationale as the earlier suites).
#![allow(deprecated)]

use std::path::PathBuf;
use std::str::FromStr;

use anchor_lang::AccountDeserialize;
use anchor_lang::AccountSerialize;
use grave_vault::constants::{
    JUPITER_V6_PROGRAM_ID, RAYDIUM_V4_AMM_AUTHORITY, RAYDIUM_V4_PROGRAM_ID, VAULT_AUTHORITY_SEED,
    WSOL_MINT,
};
use solana_program_test::{BanksClient, BanksClientError, ProgramTest};
use solana_sdk::{
    account::Account,
    bpf_loader,
    hash::hash,
    instruction::{AccountMeta, Instruction, InstructionError},
    native_token::LAMPORTS_PER_SOL,
    pubkey::Pubkey,
    rent::Rent,
    signature::Keypair,
    signer::Signer,
    system_program,
    transaction::{Transaction, TransactionError},
};

fn vault_id() -> Pubkey {
    grave_vault::ID
}
fn scanner_id() -> Pubkey {
    Pubkey::from_str("5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF").unwrap()
}
fn spl_token_id() -> Pubkey {
    anchor_spl::token::ID
}
fn spl_ata_id() -> Pubkey {
    anchor_spl::associated_token::ID
}

// Error codes asserted by the tests (grave-vault errors.rs).
const ERR_UNAUTHORIZED: u32 = 7000;
const ERR_PROTOCOL_PAUSED: u32 = 7003;
const ERR_PREFLIGHT_FAILED: u32 = 7013;

// Anchored timestamps: genesis clock is "now", so certs expiring in 2100 are
// valid regardless of test time.
const TS_VALID_UNTIL_2100: i64 = 4_102_444_800;

// AmmInfo offset of `lp_amount` (the pool's tracked LP balance).
const AMM_LP_AMOUNT_OFF: usize = 720;
// SPL token account amount offset (165-byte classic token account).
const TA_AMOUNT: usize = 64;
// SPL mint supply offset.
const MINT_SUPPLY: usize = 36;

// Base transaction fee in program-test (one signature) — informational.
const _FEE: u64 = 5_000;

/// A genesis-funded wallet (fees + rent).
fn funded_wallet(lamports: u64) -> (Keypair, (Pubkey, Account)) {
    let kp = Keypair::new();
    let pubkey = kp.pubkey();
    (
        kp,
        (
            pubkey,
            Account {
                lamports,
                data: vec![],
                owner: system_program::ID,
                executable: false,
                rent_epoch: u64::MAX,
            },
        ),
    )
}

// =====================================================================
// Fixture loading
// =====================================================================

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn load_manifest() -> Option<serde_json::Value> {
    let path = fixtures_dir().join("manifest.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => {
            eprintln!(
                "SKIP: fork fixtures not found at {} — run scripts/fetch_v4_fork_fixtures.mjs (see tests/README.md)",
                path.display()
            );
            return None;
        }
    };
    serde_json::from_str(&text).ok()
}

fn pk(s: &str) -> Pubkey {
    Pubkey::from_str(s).unwrap()
}

/// Real mainnet account from a manifest section: (pubkey, Account).
fn load_real_account(section: &serde_json::Value, name: &str) -> (Pubkey, Account) {
    let entry = &section[name];
    let data = std::fs::read(fixtures_dir().join(entry["file"].as_str().unwrap()))
        .unwrap_or_else(|e| panic!("missing fixture for {name}: {e}"));
    let account = Account {
        lamports: entry["lamports"].as_u64().unwrap(),
        data,
        owner: pk(entry["owner"].as_str().unwrap()),
        executable: false,
        rent_epoch: u64::MAX,
    };
    (pk(entry["pubkey"].as_str().unwrap()), account)
}

/// Register a fixture ELF as an executable program account under `id`.
/// Returns false (after printing a SKIP reason) when the file is absent.
fn add_elf(pt: &mut ProgramTest, file: &str, id: Pubkey, required: bool) -> bool {
    match std::fs::read(fixtures_dir().join(file)) {
        Ok(bytes) => {
            pt.add_account(
                id,
                Account {
                    lamports: 1,
                    data: bytes,
                    owner: bpf_loader::id(),
                    executable: true,
                    rent_epoch: u64::MAX,
                },
            );
            true
        }
        Err(e) => {
            if required {
                eprintln!("SKIP: required fixture {file} missing ({e})");
            }
            required
        }
    }
}

fn read_u64(data: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}

fn mint_supply(account: &Account) -> u64 {
    read_u64(&account.data, MINT_SUPPLY)
}

fn forged_token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[TA_AMOUNT..TA_AMOUNT + 8].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized
    Account {
        lamports: Rent::default().minimum_balance(165),
        data,
        owner: spl_token_id(),
        executable: false,
        rent_epoch: u64::MAX,
    }
}

// =====================================================================
// Pool environment (pool 1; withdraw-leg only — no conversion)
// =====================================================================

#[derive(Clone)]
struct PoolEnv {
    pool: Pubkey,
    coin_vault: Pubkey,
    pc_vault: Pubkey,
    lp_mint: Pubkey,
    memecoin_mint: Pubkey,
    open_orders: Pubkey,
    target_orders: Pubkey,
    market: Pubkey,
    market_program: Pubkey,
    market_coin_vault: Pubkey,
    market_pc_vault: Pubkey,
    vault_signer: Pubkey,
    event_queue: Pubkey,
    bids: Pubkey,
    asks: Pubkey,
    lp_supply: u64,
    lp_burn_plan: u64,
    salvor: Pubkey,
    cert_pda: Pubkey,
    cert_bump: u8,
    vault_authority: Pubkey,
    pool_registry: Pubkey,
    salvage_receipt: Pubkey,
    lp_holder_pool_vault: Pubkey,
    protocol_treasury: Pubkey,
    vault_sol_holding: Pubkey,
    vault_base_ata: Pubkey,
    vault_memecoin_ata: Pubkey,
    salvor_lp_ata: Pubkey,
}

impl PoolEnv {
    fn load(section: &serde_json::Value, salvor: &Keypair) -> Self {
        let accounts = &section["accounts"];
        let (pool, pool_acct) = load_real_account(accounts, "pool");
        let (coin_vault, _) = load_real_account(accounts, "coin_vault");
        let (pc_vault, _) = load_real_account(accounts, "pc_vault");
        let (lp_mint, lp_mint_acct) = load_real_account(accounts, "lp_mint");
        let (coin_mint, _) = load_real_account(accounts, "coin_mint");
        let (pc_mint, _) = load_real_account(accounts, "pc_mint");
        let (open_orders, _) = load_real_account(accounts, "open_orders");
        let (target_orders, _) = load_real_account(accounts, "target_orders");
        let (market, _) = load_real_account(accounts, "market");
        let (market_coin_vault, _) = load_real_account(accounts, "market_coin_vault");
        let (market_pc_vault, _) = load_real_account(accounts, "market_pc_vault");
        let (event_queue, _) = load_real_account(accounts, "event_queue");
        let (bids, _) = load_real_account(accounts, "bids");
        let (asks, _) = load_real_account(accounts, "asks");
        let (vault_signer, _) = load_real_account(accounts, "vault_signer");
        let market_program = pk(section["market_program"].as_str().unwrap());

        let base_is_coin_side = section["base_is_coin_side"].as_bool().unwrap();
        if base_is_coin_side {
            assert_eq!(coin_mint, WSOL_MINT);
        } else {
            assert_eq!(pc_mint, WSOL_MINT);
        }
        let memecoin_mint = if base_is_coin_side {
            pc_mint
        } else {
            coin_mint
        };

        let lp_supply = mint_supply(&lp_mint_acct);
        let amm_lp_amount = read_u64(&pool_acct.data, AMM_LP_AMOUNT_OFF);
        let lp_burn_plan = (lp_supply / 10_000).max(1);
        assert!(lp_burn_plan < amm_lp_amount);

        let ata = |wallet: &Pubkey, mint: &Pubkey| {
            Pubkey::find_program_address(
                &[wallet.as_ref(), spl_token_id().as_ref(), mint.as_ref()],
                &spl_ata_id(),
            )
            .0
        };
        let vault_authority = Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED], &vault_id()).0;
        let (cert_pda, cert_bump) = Pubkey::find_program_address(
            &[
                b"eligibility_cert",
                RAYDIUM_V4_PROGRAM_ID.as_ref(),
                pool.as_ref(),
            ],
            &scanner_id(),
        );

        Self {
            pool,
            coin_vault,
            pc_vault,
            lp_mint,
            memecoin_mint,
            open_orders,
            target_orders,
            market,
            market_program,
            market_coin_vault,
            market_pc_vault,
            vault_signer,
            event_queue,
            bids,
            asks,
            lp_supply,
            lp_burn_plan,
            salvor: salvor.pubkey(),
            cert_pda,
            cert_bump,
            vault_authority,
            pool_registry: Pubkey::find_program_address(
                &[b"pool_registry", pool.as_ref()],
                &vault_id(),
            )
            .0,
            salvage_receipt: Pubkey::find_program_address(
                &[b"salvage_receipt", pool.as_ref()],
                &vault_id(),
            )
            .0,
            lp_holder_pool_vault: Pubkey::find_program_address(
                &[b"lp_holder_pool", pool.as_ref()],
                &vault_id(),
            )
            .0,
            protocol_treasury: Pubkey::find_program_address(&[b"protocol_treasury"], &vault_id()).0,
            vault_sol_holding: Pubkey::find_program_address(
                &[b"vault_sol_holding", pool.as_ref()],
                &vault_id(),
            )
            .0,
            vault_base_ata: ata(&vault_authority, &WSOL_MINT),
            vault_memecoin_ata: ata(&vault_authority, &memecoin_mint),
            salvor_lp_ata: ata(&salvor.pubkey(), &lp_mint),
        }
    }

    /// The 13 pool-derived remaining accounts in vault CPI order.
    fn remaining(&self) -> Vec<Pubkey> {
        vec![
            RAYDIUM_V4_AMM_AUTHORITY,
            self.open_orders,
            self.target_orders,
            self.coin_vault,
            self.pc_vault,
            self.market_program,
            self.market,
            self.market_coin_vault,
            self.market_pc_vault,
            self.vault_signer,
            self.event_queue,
            self.bids,
            self.asks,
        ]
    }

    fn remaining_writable(&self) -> Vec<bool> {
        vec![
            false, true, true, true, true, false, true, true, true, false, true, true, true,
        ]
    }
}

// =====================================================================
// Genesis
// =====================================================================

const POOL_ACCOUNTS: [&str; 15] = [
    "pool",
    "coin_vault",
    "pc_vault",
    "lp_mint",
    "coin_mint",
    "pc_mint",
    "open_orders",
    "target_orders",
    "market",
    "market_coin_vault",
    "market_pc_vault",
    "event_queue",
    "bids",
    "asks",
    "vault_signer",
];

/// Serialise the forged cert PDA + salvor LP balance. `cert_owner` decides
/// who owns the cert PDA ACCOUNT — the scanner program for the honest
/// shape, an attacker keypair for the ownership-forgery test.
fn add_forged_pool_side(
    pt: &mut ProgramTest,
    env: &PoolEnv,
    salvor: &Keypair,
    cert_owner: &Pubkey,
) {
    let cert = grave_scanner::state::EligibilityCert {
        amm_program_id: RAYDIUM_V4_PROGRAM_ID,
        pool_address: env.pool,
        writer: salvor.pubkey(),
        anchor_epoch: 0,
        cert_epoch: 0,
        issued_at: TS_VALID_UNTIL_2100 - 3600,
        expires_at: TS_VALID_UNTIL_2100,
        criteria_bitmap: 0x3F,
        reissue_generation: 1,
        bump: env.cert_bump,
        _reserved: [0u8; 56],
    };
    let mut cert_data = Vec::new();
    cert.try_serialize(&mut cert_data).unwrap();
    pt.add_account(
        env.cert_pda,
        Account {
            lamports: Rent::default().minimum_balance(cert_data.len()),
            data: cert_data,
            owner: *cert_owner,
            executable: false,
            rent_epoch: u64::MAX,
        },
    );
    pt.add_account(
        env.salvor_lp_ata,
        forged_token_account(&env.lp_mint, &salvor.pubkey(), env.lp_burn_plan),
    );
}

struct Boot {
    pt: Option<ProgramTest>,
    env1: PoolEnv,
    salvor: Keypair,
}

/// Bootstraps the VM with pool 1's real state, the vault, the real AMM /
/// market / token ELFs. `cert_owner` allows forging an attacker-owned cert
/// account (same bytes, wrong owner). Returns None (SKIP) when required
/// fixtures are absent.
fn build_genesis(
    extra: Vec<(Pubkey, Account)>,
    salvor: Keypair,
    cert_owner: &Pubkey,
) -> Option<Boot> {
    let manifest = load_manifest()?;
    let env1 = PoolEnv::load(&manifest, &salvor);

    let mut pt = ProgramTest::default();
    pt.prefer_bpf(true);
    pt.set_compute_max_units(1_400_000);
    pt.set_transaction_account_lock_limit(64);

    if !add_elf(&mut pt, "grave_vault.so", vault_id(), true) {
        return None;
    }
    add_elf(&mut pt, "raydium_v4.so", RAYDIUM_V4_PROGRAM_ID, true);
    add_elf(&mut pt, "spl_token.so", spl_token_id(), true);
    add_elf(&mut pt, "spl_ata.so", spl_ata_id(), true);
    add_elf(&mut pt, "serum_dex.so", env1.market_program, true);

    for name in POOL_ACCOUNTS {
        let (k, a) = load_real_account(&manifest["accounts"], name);
        pt.add_account(k, a);
    }
    let (wsol_key, wsol_acct) = load_real_account(&manifest["accounts"], "wsol_mint");
    pt.add_account(wsol_key, wsol_acct);
    add_forged_pool_side(&mut pt, &env1, &salvor, cert_owner);

    pt.add_account(
        salvor.pubkey(),
        Account {
            lamports: 100 * LAMPORTS_PER_SOL,
            data: vec![],
            owner: system_program::ID,
            executable: false,
            rent_epoch: u64::MAX,
        },
    );
    for (addr, account) in extra {
        pt.add_account(addr, account);
    }

    Some(Boot {
        pt: Some(pt),
        env1,
        salvor,
    })
}

/// Runs `initialize` (protocol defaults: 40/40/20; dust = u64::MAX so the
/// conversion leg is always skipped and no Jupiter stand-in is needed).
async fn start(boot: Boot) -> (BanksClient, Boot) {
    let mut boot = boot;
    let payer = boot.salvor.pubkey();
    let mut data = anchor_disc("initialize").to_vec();
    data.extend_from_slice(payer.as_ref()); // authority
    data.extend_from_slice(&0u16.to_le_bytes()); // lp share (default)
    data.extend_from_slice(&0u16.to_le_bytes()); // salvor share (default)
    data.extend_from_slice(&0u16.to_le_bytes()); // protocol share (default)
    data.extend_from_slice(&0u64.to_le_bytes()); // priority fee ceiling
    data.extend_from_slice(&0u16.to_le_bytes()); // max slippage bps (0 = 300)
    data.extend_from_slice(&u64::MAX.to_le_bytes()); // dust threshold (skip conversion)
    data.extend_from_slice(&0i64.to_le_bytes()); // timelock (0 = default)
    let init = Instruction::new_with_bytes(
        vault_id(),
        &data,
        vec![
            AccountMeta::new(
                Pubkey::find_program_address(&[b"protocol_config"], &vault_id()).0,
                false,
            ),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    );
    let (mut client, _payer, _bh) = boot.pt.take().unwrap().start().await;
    send(&mut client, &boot.salvor, &[init]).await.unwrap();
    (client, boot)
}

// =====================================================================
// Instruction builders (raw Anchor wire format — no generated client)
// =====================================================================

/// Anchor global instruction discriminator = sha256("global:<name>")[..8].
fn anchor_disc(name: &str) -> [u8; 8] {
    let h = hash(format!("global:{name}").as_bytes()).to_bytes();
    [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]]
}

struct SalvageOpts {
    lp_amount: u64,
    /// remaining_accounts[0] — the REAL AMM authority by default; the
    /// CPI-substitution test swaps in an attacker key.
    cpi_authority: Option<Pubkey>,
    merkle_root: [u8; 32],
}

fn salvage_ix(env: &PoolEnv, opts: &SalvageOpts) -> Instruction {
    let mut data = anchor_disc("salvage_pool").to_vec();
    data.extend_from_slice(RAYDIUM_V4_PROGRAM_ID.as_ref());
    data.extend_from_slice(env.pool.as_ref());
    data.extend_from_slice(&opts.merkle_root); // lp_snapshot_merkle_root
    data.extend_from_slice(&env.lp_supply.to_le_bytes()); // lp_total_supply_at_snapshot
    data.extend_from_slice(&0u64.to_le_bytes()); // min_quote_output_lamports (no swap)
    data.extend_from_slice(&opts.lp_amount.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes()); // empty route
    data.push(0); // no slippage override
    data.push(0); // no route accounts

    let mut metas = vec![
        AccountMeta::new_readonly(
            Pubkey::find_program_address(&[b"protocol_config"], &vault_id()).0,
            false,
        ),
        AccountMeta::new_readonly(env.cert_pda, false),
        AccountMeta::new(env.pool_registry, false),
        AccountMeta::new(env.salvage_receipt, false),
        AccountMeta::new(env.lp_holder_pool_vault, false),
        AccountMeta::new(env.protocol_treasury, false),
        AccountMeta::new(env.salvor, true),
        AccountMeta::new(env.pool, false),
        AccountMeta::new_readonly(RAYDIUM_V4_PROGRAM_ID, false),
        AccountMeta::new_readonly(JUPITER_V6_PROGRAM_ID, false), // pinned; never CPI'd (no route)
        AccountMeta::new(env.vault_authority, false),
        AccountMeta::new(env.vault_sol_holding, false),
        AccountMeta::new(env.salvor_lp_ata, false),
        AccountMeta::new(env.vault_base_ata, false),
        AccountMeta::new(env.vault_memecoin_ata, false),
        AccountMeta::new(env.lp_mint, false),
        AccountMeta::new_readonly(env.memecoin_mint, false),
        AccountMeta::new_readonly(WSOL_MINT, false),
        AccountMeta::new_readonly(spl_token_id(), false),
        AccountMeta::new_readonly(spl_ata_id(), false),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
    let cpi_authority = opts.cpi_authority.unwrap_or(RAYDIUM_V4_AMM_AUTHORITY);
    for (i, (k, w)) in env
        .remaining()
        .iter()
        .zip(env.remaining_writable())
        .enumerate()
    {
        let key = if i == 0 { cpi_authority } else { *k };
        metas.push(if w {
            AccountMeta::new(key, false)
        } else {
            AccountMeta::new_readonly(key, false)
        });
    }
    Instruction::new_with_bytes(vault_id(), &data, metas)
}

/// `claim_lp_proceeds`: pool, balance, Merkle proof — with EXPLICIT registry
/// / claim-record keys so the tests can submit colliding PDAs.
fn claim_ix(
    registry: &Pubkey,
    claim_record: &Pubkey,
    lp_holder_pool_vault: &Pubkey,
    pool: &Pubkey,
    holder: &Pubkey,
    balance_at_snapshot: u64,
    proof: &[[u8; 32]],
) -> Instruction {
    let mut data = anchor_disc("claim_lp_proceeds").to_vec();
    data.extend_from_slice(pool.as_ref());
    data.extend_from_slice(&balance_at_snapshot.to_le_bytes());
    data.extend_from_slice(&(proof.len() as u32).to_le_bytes());
    for p in proof {
        data.extend_from_slice(p);
    }
    let metas = vec![
        AccountMeta::new(*registry, false),
        AccountMeta::new(*claim_record, false),
        AccountMeta::new(*lp_holder_pool_vault, false),
        AccountMeta::new(*holder, true),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
    Instruction::new_with_bytes(vault_id(), &data, metas)
}

/// `update_protocol_config`: all-Option params. `Some` fields are encoded
/// positionally; every field set to `None` makes the call a no-op — enough
/// to prove the authority binding either accepts or rejects.
fn update_config_ix(config: &Pubkey, authority: &Pubkey) -> Instruction {
    let mut data = anchor_disc("update_protocol_config").to_vec();
    data.extend_from_slice(&[0u8; 7]); // Option::None for every param field
    Instruction::new_with_bytes(
        vault_id(),
        &data,
        vec![
            AccountMeta::new(*config, false),
            AccountMeta::new_readonly(*authority, true),
        ],
    )
}

/// `emergency_pause`: bool + (protocol_config, authority).
fn pause_ix(config: &Pubkey, authority: &Pubkey, paused: bool) -> Instruction {
    let mut data = anchor_disc("emergency_pause").to_vec();
    data.push(u8::from(paused));
    Instruction::new_with_bytes(
        vault_id(),
        &data,
        vec![
            AccountMeta::new(*config, false),
            AccountMeta::new_readonly(*authority, true),
        ],
    )
}

// =====================================================================
// Execution + assertion helpers
// =====================================================================

async fn acct(client: &mut BanksClient, k: &Pubkey) -> Account {
    client
        .get_account(*k)
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("account {k} missing"))
}

async fn maybe_acct(client: &mut BanksClient, k: &Pubkey) -> Option<Account> {
    client.get_account(*k).await.unwrap()
}

async fn send(
    client: &mut BanksClient,
    payer: &Keypair,
    ixs: &[Instruction],
) -> Result<(), BanksClientError> {
    let blockhash = client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &[payer], blockhash);
    client.process_transaction(tx).await
}

fn expect_custom(err: BanksClientError, want: u32, ctx: &str) {
    match err {
        BanksClientError::TransactionError(TransactionError::InstructionError(
            _,
            InstructionError::Custom(code),
        )) => assert_eq!(code, want, "{ctx}: expected custom {want}, got {code}"),
        other => panic!("{ctx}: expected custom error {want}, got {other:?}"),
    }
}

fn expect_any_failure(err: BanksClientError, ctx: &str) {
    match err {
        BanksClientError::TransactionError(TransactionError::InstructionError(..)) => {}
        other => panic!("{ctx}: expected a transaction failure, got {other:?}"),
    }
}

/// The sealed root straight from the PoolRegistry (raw borsh offset:
/// disc 8 + amm_program_id 32 + pool_address 32 + salvor 32 = 104; layout
/// drift is caught by the state unit tests, and here byte-equality across
/// a failed replay is what matters).
async fn sealed_root(client: &mut BanksClient, registry: &Pubkey) -> [u8; 32] {
    let a = acct(client, registry).await;
    const ROOT_OFF: usize = 8 + 32 + 32 + 32;
    let mut root = [0u8; 32];
    root.copy_from_slice(&a.data[ROOT_OFF..ROOT_OFF + 32]);
    root
}

fn protocol_config_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"protocol_config"], &vault_id()).0
}

fn claim_record_pda(pool: &Pubkey, holder: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"claim_record", pool.as_ref(), holder.as_ref()],
        &vault_id(),
    )
    .0
}

// =====================================================================
// Tests — one adversarial shape per test, one VM per test
// =====================================================================

/// Roadmap row "authority testing" (vault): a wrong signer on the two
/// authority-gated instructions reverts 7000; the rightful authority's
/// calls succeed (positive control).
#[tokio::test]
async fn unauthorized_authority_signers_revert() {
    let attacker = funded_wallet(LAMPORTS_PER_SOL);
    let Some(boot) = build_genesis(vec![attacker.1], Keypair::new(), &scanner_id()) else {
        return;
    };
    let (mut client, boot) = start(boot).await;
    let attacker = attacker.0;
    let config = protocol_config_pda();

    // Wrong signer on update_protocol_config -> 7000.
    let err = send(
        &mut client,
        &attacker,
        &[update_config_ix(&config, &attacker.pubkey())],
    )
    .await
    .expect_err("attacker must not update config");
    expect_custom(err, ERR_UNAUTHORIZED, "update_protocol_config wrong signer");

    // Wrong signer on emergency_pause -> 7000.
    let err = send(
        &mut client,
        &attacker,
        &[pause_ix(&config, &attacker.pubkey(), true)],
    )
    .await
    .expect_err("attacker must not pause");
    expect_custom(err, ERR_UNAUTHORIZED, "emergency_pause wrong signer");

    // Positive control: the authority can call both.
    send(
        &mut client,
        &boot.salvor,
        &[update_config_ix(&config, &boot.salvor.pubkey())],
    )
    .await
    .expect("authority update_protocol_config must succeed");
    send(
        &mut client,
        &boot.salvor,
        &[pause_ix(&config, &boot.salvor.pubkey(), false)],
    )
    .await
    .expect("authority emergency_pause must succeed");
}

/// Roadmap rows "emergency-pause testing" + "replay testing": pause gates
/// the first salvage ATOMICALLY (no PDA survives the revert), unpause
/// restores it, and a replayed salvage dies on the PoolRegistry init
/// constraint with the sealed root byte-identical.
#[tokio::test]
async fn pause_gates_salvage_atomically_and_salvage_is_oneshot() {
    let Some(boot) = build_genesis(vec![], Keypair::new(), &scanner_id()) else {
        return;
    };
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    let config = protocol_config_pda();
    let opts = || SalvageOpts {
        lp_amount: env.lp_burn_plan,
        cpi_authority: None,
        merkle_root: [7u8; 32],
    };

    // Paused: the FIRST salvage of the pool reverts 7003.
    send(
        &mut client,
        &boot.salvor,
        &[pause_ix(&config, &boot.salvor.pubkey(), true)],
    )
    .await
    .expect("pause must succeed");
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts())])
        .await
        .expect_err("salvage must be gated while paused");
    expect_custom(err, ERR_PROTOCOL_PAUSED, "salvage while paused");

    // Atomicity: the revert left NO pool-scoped PDA behind.
    for pda in [
        env.pool_registry,
        env.salvage_receipt,
        env.lp_holder_pool_vault,
    ] {
        assert!(
            maybe_acct(&mut client, &pda).await.is_none(),
            "PDA {pda} must not exist after the paused salvage reverted"
        );
    }

    // Unpause: the same salvage now succeeds.
    send(
        &mut client,
        &boot.salvor,
        &[pause_ix(&config, &boot.salvor.pubkey(), false)],
    )
    .await
    .expect("unpause must succeed");
    send(&mut client, &boot.salvor, &[salvage_ix(env, &opts())])
        .await
        .expect("salvage after unpause must succeed");
    let root = sealed_root(&mut client, &env.pool_registry).await;
    assert_eq!(root, [7u8; 32]);

    // Replay: a second salvage of the same pool dies on the PoolRegistry
    // `init` constraint; the sealed root is byte-identical afterwards.
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts())])
        .await
        .expect_err("salvage replay must fail");
    expect_any_failure(err, "salvage replay");
    let root_after = sealed_root(&mut client, &env.pool_registry).await;
    assert_eq!(root_after, root, "replay must not touch the sealed root");
}

/// Roadmap row "CPI account substitution testing": the AMM authority slot
/// (remaining_accounts[0]) pinned by the Raydium adapter to the REAL
/// authority PDA — an attacker key in that slot reverts 7013 pre-CPI, and
/// the honest submission succeeds afterwards (atomicity).
#[tokio::test]
async fn cpi_authority_substitution_rejected() {
    let Some(boot) = build_genesis(vec![], Keypair::new(), &scanner_id()) else {
        return;
    };
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    // The attacker never signs anything here — their key only sits in the
    // substituted CPI-authority slot.
    let attacker = Keypair::new();

    let hijacked = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        cpi_authority: Some(attacker.pubkey()),
        merkle_root: [7u8; 32],
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &hijacked)])
        .await
        .expect_err("substituted CPI authority must be rejected");
    expect_custom(err, ERR_PREFLIGHT_FAILED, "substituted amm authority");

    // The hijacked attempt left no registry behind; the honest path works.
    assert!(maybe_acct(&mut client, &env.pool_registry).await.is_none());
    let honest = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        cpi_authority: None,
        merkle_root: [7u8; 32],
    };
    send(&mut client, &boot.salvor, &[salvage_ix(env, &honest)])
        .await
        .expect("honest salvage after the hijack attempt must succeed");
}

/// Roadmap row "malicious-account testing" (ownership layer): an
/// EligibilityCert PDA account with BYTE-IDENTICAL data but an
/// attacker-owned account owner is repelled by Anchor's ownership
/// constraint — serialized cert data proves nothing without the right
/// owner. The positive control (correct owner) runs in every other test.
#[tokio::test]
async fn fake_cert_ownership_rejected() {
    let attacker = Keypair::new();
    let Some(boot) = build_genesis(vec![], Keypair::new(), &attacker.pubkey()) else {
        return;
    };
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;

    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        cpi_authority: None,
        merkle_root: [7u8; 32],
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .expect_err("attacker-owned cert account must be rejected");
    expect_any_failure(err, "cert ownership forgery");

    // Zero movement: no pool-scoped PDA exists after the failed salvage.
    for pda in [
        env.pool_registry,
        env.salvage_receipt,
        env.lp_holder_pool_vault,
    ] {
        assert!(
            maybe_acct(&mut client, &pda).await.is_none(),
            "PDA {pda} must not exist after the forged-cert revert"
        );
    }
}

/// Roadmap row "PDA collision/authority testing" (initialize): re-running
/// `initialize` on an existing ProtocolConfig PDA fails on the `init`
/// constraint — the authority recorded at genesis cannot be stolen by
/// re-initialization.
#[tokio::test]
async fn initialize_takeover_repelled() {
    let attacker = funded_wallet(LAMPORTS_PER_SOL);
    let Some(boot) = build_genesis(vec![attacker.1], Keypair::new(), &scanner_id()) else {
        return;
    };
    let (mut client, boot) = start(boot).await;
    let attacker = attacker.0;

    // Fund the attacker so THEY can pay for the attempt.
    let attacker_ix = {
        let mut data = anchor_disc("initialize").to_vec();
        data.extend_from_slice(attacker.pubkey().as_ref()); // authority = attacker
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&0i64.to_le_bytes());
        Instruction::new_with_bytes(
            vault_id(),
            &data,
            vec![
                AccountMeta::new(protocol_config_pda(), false),
                AccountMeta::new(attacker.pubkey(), true),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )
    };
    let err = send(&mut client, &attacker, &[attacker_ix])
        .await
        .expect_err("re-initialize must fail");
    expect_any_failure(err, "initialize takeover");

    // The config still belongs to the genesis authority.
    let cfg = grave_vault::state::ProtocolConfig::try_deserialize(
        &mut &acct(&mut client, &protocol_config_pda()).await.data[..],
    )
    .expect("config must deserialize");
    assert_eq!(cfg.authority, boot.salvor.pubkey(), "authority unchanged");
}

/// Roadmap rows "PDA collision/authority testing" + "replay testing"
/// (claims): a claim against a never-salvaged pool fails (no registry);
/// a claim submitting a claim_record PDA derived for a DIFFERENT pool
/// fails on the seed constraint; the honest pool's cumulative accounting
/// is untouched by both.
#[tokio::test]
async fn claim_pda_collisions_rejected() {
    let holder = funded_wallet(LAMPORTS_PER_SOL);
    let Some(boot) = build_genesis(vec![holder.1], Keypair::new(), &scanner_id()) else {
        return;
    };
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    let holder = holder.0;

    // Salvage pool 1 so its registry exists (root [7u8;32], balance 0
    // claims are irrelevant — every shape here dies at the constraints).
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        cpi_authority: None,
        merkle_root: [7u8; 32],
    };
    send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .expect("salvage must succeed");
    let claimed_before = {
        let registry = grave_vault::state::PoolRegistry::try_deserialize(
            &mut &acct(&mut client, &env.pool_registry).await.data[..],
        )
        .expect("registry must deserialize");
        registry.lp_holder_pool_claimed_lamports
    };

    // (a) Never-salvaged pool: its registry PDA does not exist.
    let foreign_pool = Pubkey::new_from_array([9u8; 32]);
    let foreign_registry =
        Pubkey::find_program_address(&[b"pool_registry", foreign_pool.as_ref()], &vault_id()).0;
    let foreign_vault =
        Pubkey::find_program_address(&[b"lp_holder_pool", foreign_pool.as_ref()], &vault_id()).0;
    let ix_a = claim_ix(
        &foreign_registry,
        &claim_record_pda(&foreign_pool, &holder.pubkey()),
        &foreign_vault,
        &foreign_pool,
        &holder.pubkey(),
        1_000,
        &[[3u8; 32]],
    );
    let err = send(&mut client, &holder, &[ix_a])
        .await
        .expect_err("claim on unsalvaged pool must fail");
    expect_any_failure(err, "unsalvaged-pool claim");

    // (b) Cross-pool claim record: honest registry, but the ClaimRecord
    // PDA is derived for the foreign pool — seed constraint rejects.
    let ix_b = claim_ix(
        &env.pool_registry,
        &claim_record_pda(&foreign_pool, &holder.pubkey()),
        &env.lp_holder_pool_vault,
        &env.pool,
        &holder.pubkey(),
        1_000,
        &[[3u8; 32]],
    );
    let err = send(&mut client, &holder, &[ix_b])
        .await
        .expect_err("cross-pool claim record must fail");
    expect_any_failure(err, "cross-pool claim record");

    // Zero movement: cumulative claimed untouched by both attempts.
    let registry = grave_vault::state::PoolRegistry::try_deserialize(
        &mut &acct(&mut client, &env.pool_registry).await.data[..],
    )
    .expect("registry must deserialize");
    assert_eq!(
        registry.lp_holder_pool_claimed_lamports, claimed_before,
        "failed claims must not move cumulative accounting"
    );
}
