// SPDX-License-Identifier: Apache-2.0
//
// Phase 3 fork harness (roadmap Phase 3, checklist CPI-010 / SLIP-001 /
// the route-destination integrity gap tracked alongside them).
//
// Executes the REAL GraveVault `salvage_pool` instruction — withdraw leg AND
// Jupiter conversion leg — against the REAL mainnet Raydium V4 / OpenBook /
// SPL-token bytecode inside an in-process Solana VM (`solana-program-test`),
// seeded with byte-for-byte mainnet state of TWO real pools:
//
//   pool 1  58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2  SOL/USDC
//           (coin = WSOL — the canonical base_is_coin_side = true shape)
//   pool 2  AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA  RAY/WSOL
//           (pc = WSOL — the INVERTED orientation, CPI-010's false path)
//
// The Jupiter aggregator is exercised through `jupiter_v6_stub`, a
// TEST-ONLY program deployed at the pinned Jupiter v6 program id inside the
// VM. The vault treats Jupiter as an opaque program (route data + accounts
// forwarded verbatim, no route-plan parsing), so the harness contract only
// needs a callee at the pinned id that performs a REAL swap and can fail
// deterministically. The stub CPIs a genuine Raydium V4 `swapBaseIn`
// against the same byte-for-byte mainnet pool state as the withdraw leg —
// see the stub's header for the full rationale. Nothing about the vault
// assumes or depends on the stub's internals; every defense proven here
// (route vetting, slippage ceiling, swap-leg floor) guards against an
// ARBITRARY callee, which is strictly stronger than guarding against one
// known program.
//
// The harness forges exactly four things (documented shortcuts):
//   1. the EligibilityCert PDA (serialised with GraveScanner's own type),
//   2. the salvor's LP token account balance,
//   3. the salvor's lamports,
//   4. the Jupiter stand-in program itself (see above).
//
// What this PROVES (the acceptance bar for Phase 3):
//   - the full pipeline LP -> Raydium withdraw -> memecoin -> Jupiter ->
//     WSOL -> SOL unwrap -> 40/40/20 executes end-to-end in ONE transaction
//     for BOTH pool orientations,
//   - the submitted floor cannot be lossier than the pool-implied
//     conversion minus the protocol cap (SLIP-001: config.max_slippage_bps,
//     HARD_MAX_SLIPPAGE_BPS and max_slippage_bps_override are now READ),
//   - a route referencing vault custody accounts is rejected, the vault's
//     WSOL destination must be present, a hijacked route destination cannot
//     deliver (N1),
//   - bad route data and failed aggregator transactions revert atomically,
//   - orientation is derived from the pool's own bytes: no-WSOL pools
//     revert UnsupportedBaseToken BEFORE any CPI, and mis-declared
//     memecoin/LP mints are bound to the pool's bytes.
//
// Fixtures via `scripts/fetch_v4_fork_fixtures.mjs` (gitignored; tests SKIP
// without them). `grave_vault.so` and `jupiter_v6_stub.so` must be in
// tests/fixtures (scripts/build_fork_harness.sh builds both).

// solana-sdk 2.3 deprecates the monolithic `system_program` /
// `bpf_loader` modules in favour of the split interface crates; the
// deprecated paths still work and keep the harness on the same re-exports
// anchor-lang's prelude uses.
#![allow(deprecated)]

use std::path::PathBuf;
use std::str::FromStr;

use anchor_lang::AccountSerialize;
use grave_scanner::state::EligibilityCert;
use grave_vault::constants::{
    JUPITER_V6_PROGRAM_ID, RAYDIUM_V4_AMM_AUTHORITY, RAYDIUM_V4_PROGRAM_ID, VAULT_AUTHORITY_SEED,
    WSOL_MINT,
};
use serde_json::Value;
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
    Pubkey::from_str("7ZZ78chnUh5iipPgwR4L8fT8wKFmUM7kauRzjaYARr9m").unwrap()
}
fn spl_token_id() -> Pubkey {
    anchor_spl::token::ID
}
fn spl_ata_id() -> Pubkey {
    anchor_spl::associated_token::ID
}

// Error codes asserted by the tests (grave-vault errors.rs).
const ERR_SLIPPAGE_EXCEEDED: u32 = 7007;
const ERR_PREFLIGHT_FAILED: u32 = 7013;
const ERR_UNSUPPORTED_BASE_TOKEN: u32 = 7019;

// Anchored timestamps: genesis clock is "now", so certs expiring in 2100 are
// valid regardless of test time.
const TS_VALID_UNTIL_2100: i64 = 4_102_444_800;

// AmmInfo offset of `lp_amount` (the pool's tracked LP balance).
const AMM_LP_AMOUNT_OFF: usize = 720;
// SPL token account amount offset (165-byte classic token account).
const TA_AMOUNT: usize = 64;
// SPL mint supply offset.
const MINT_SUPPLY: usize = 36;

// Effective slippage cap used by the harness when computing floors: the
// protocol default (config.max_slippage_bps = 300 bps via initialize's
// 0-means-default), below the 1_000 bps hard ceiling.
const HARNESS_CAP_BPS: u128 = 300;
const BPS_DEN: u128 = 10_000;

// =====================================================================
// Fixture loading
// =====================================================================

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn load_manifest() -> Option<Value> {
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
fn load_real_account(section: &Value, name: &str) -> (Pubkey, Account) {
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

fn token_amount(account: &Account) -> u64 {
    read_u64(&account.data, TA_AMOUNT)
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

/// Minimal 82-byte SPL mint account (no mint authority, zero supply).
fn forged_mint(decimals: u8) -> Account {
    let mut data = vec![0u8; 82];
    data[44] = decimals;
    data[45] = 1; // is_initialized — required by the SPL unpack
    Account {
        lamports: Rent::default().minimum_balance(82),
        data,
        owner: spl_token_id(),
        executable: false,
        rent_epoch: u64::MAX,
    }
}

// =====================================================================
// Pool environment
// =====================================================================

struct PoolEnv {
    // Real mainnet pubkeys.
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
    // Real mainnet numbers (from fixture bytes / manifest parse).
    coin_reserve: u64,
    pc_reserve: u64,
    lp_supply: u64,
    lp_burn_plan: u64,
    // Pro-rata upper bounds on the withdraw payout (V4's PnL adjustment can
    // only reduce; the dry-run below produces the exact values).
    base_is_coin_side: bool,
    // Derived / forged identities.
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
    /// Load one pool's fixtures. `section` is the manifest root (pool 1) or
    /// the `orientation_pool` object (pool 2).
    fn load(section: &Value, salvor: &Keypair) -> Self {
        let accounts = &section["accounts"];
        let (pool, pool_acct) = load_real_account(accounts, "pool");
        let (coin_vault, coin_vault_acct) = load_real_account(accounts, "coin_vault");
        let (pc_vault, pc_vault_acct) = load_real_account(accounts, "pc_vault");
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
        // v1.0 fixture invariant: exactly one side is WSOL.
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

        let coin_reserve = token_amount(&coin_vault_acct);
        let pc_reserve = token_amount(&pc_vault_acct);
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
            coin_reserve,
            pc_reserve,
            lp_supply,
            lp_burn_plan,
            base_is_coin_side,
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

/// Serialise the forged cert PDA + salvor LP balance for one pool.
fn add_forged_pool_side(pt: &mut ProgramTest, env: &PoolEnv, salvor: &Keypair) {
    let cert = EligibilityCert {
        amm_program_id: RAYDIUM_V4_PROGRAM_ID,
        pool_address: env.pool,
        writer: salvor.pubkey(),
        anchor_epoch: 0,
        cert_epoch: 0,
        issued_at: TS_VALID_UNTIL_2100 - 3600,
        expires_at: TS_VALID_UNTIL_2100,
        criteria_bitmap: 0x3F,
        reissue_generation: 1,
        bump: env.cert_bump, // Anchor re-derives the PDA from this field
        _reserved: [0u8; 56],
    };
    let mut cert_data = Vec::new();
    cert.try_serialize(&mut cert_data).unwrap();
    pt.add_account(
        env.cert_pda,
        Account {
            lamports: Rent::default().minimum_balance(cert_data.len()),
            data: cert_data,
            owner: scanner_id(),
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
    env2: Option<PoolEnv>,
    salvor: Keypair,
    /// `u64::MAX` = conversion leg skipped (dry-run mode); `0` = protocol
    /// default (666_666) — swap leg active.
    dust: u64,
}

/// Bootstraps the VM with BOTH fixture pools' real state, the vault, the
/// real AMM / market / token ELFs and the Jupiter stand-in. Returns None
/// (SKIP) when required fixtures are absent.
fn build_genesis(dust: u64, extra: Vec<(Pubkey, Account)>) -> Option<Boot> {
    build_genesis_with(dust, extra, Keypair::new())
}

/// Same, with a caller-chosen salvor keypair (needed by tests that must
/// pre-derive salvor-owned accounts, e.g. a forged LP ATA).
fn build_genesis_with(dust: u64, extra: Vec<(Pubkey, Account)>, salvor: Keypair) -> Option<Boot> {
    let manifest = load_manifest()?;
    let env1 = PoolEnv::load(&manifest, &salvor);

    let mut pt = ProgramTest::default();
    pt.prefer_bpf(true);
    // The salvage tx runs a real V4 withdraw + a real V4 swapBaseIn + 3 ATA
    // creates + 4 token/system transfers; the 200k default would truncate.
    pt.set_compute_max_units(1_400_000);
    pt.set_transaction_account_lock_limit(64);

    if !add_elf(&mut pt, "grave_vault.so", vault_id(), true) {
        return None;
    }
    if !add_elf(&mut pt, "jupiter_v6_stub.so", JUPITER_V6_PROGRAM_ID, true) {
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
    add_forged_pool_side(&mut pt, &env1, &salvor);
    // Optional orientation pool (pc = WSOL).
    let env2 = manifest.get("orientation_pool").map(|section| {
        let env = PoolEnv::load(section, &salvor);
        add_elf(&mut pt, "serum_dex2.so", env.market_program, true);
        for name in POOL_ACCOUNTS {
            let (k, a) = load_real_account(&section["accounts"], name);
            pt.add_account(k, a);
        }
        add_forged_pool_side(&mut pt, &env, &salvor);
        env
    });

    // Forged: shared salvor lamports (fees + rents for both pools' PDAs).
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
        env2,
        salvor,
        dust,
    })
}

/// Runs `initialize` (dust/slip params at 0 = protocol defaults).
async fn start(boot: Boot) -> (BanksClient, Boot) {
    let mut boot = boot;
    let payer = boot.salvor.pubkey();
    let mut data = anchor_disc("initialize").to_vec();
    data.extend_from_slice(payer.as_ref()); // authority
    data.extend_from_slice(&0u16.to_le_bytes()); // lp share (0 = 40%)
    data.extend_from_slice(&0u16.to_le_bytes()); // salvor share (0 = 40%)
    data.extend_from_slice(&0u16.to_le_bytes()); // protocol share (0 = 20%)
    data.extend_from_slice(&0u64.to_le_bytes()); // priority fee ceiling (0 = default)
    data.extend_from_slice(&0u16.to_le_bytes()); // max slippage bps (0 = default 300)
    data.extend_from_slice(&boot.dust.to_le_bytes()); // dust threshold
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

/// A Jupiter route: opaque data + ordered (pubkey, writable) accounts,
/// forwarded verbatim by the vault to the Jupiter stand-in.
struct Route {
    data: Vec<u8>,
    accounts: Vec<(Pubkey, bool)>,
}

/// Build a single-hop route against the Jupiter stand-in's documented
/// account contract (6-account prefix + V4 program + 18 swapBaseIn
/// accounts). `user_destination` overrides BOTH destination slots (used by
/// the hijack test). `tail` appends extra accounts (used by the protected-
/// account test).
fn jupiter_route(
    env: &PoolEnv,
    in_amount: u64,
    min_out: u64,
    fail_mode: u8,
    user_destination: Option<Pubkey>,
    tail: Vec<(Pubkey, bool)>,
) -> Route {
    let mut data = hash(b"global:route").to_bytes()[..8].to_vec();
    data.extend_from_slice(&in_amount.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    data.push(fail_mode);

    let dest = user_destination.unwrap_or(env.vault_base_ata);
    let mut accounts: Vec<(Pubkey, bool)> = vec![
        (spl_token_id(), false),           // 0 token_program
        (env.vault_authority, false),      // 1 user_transfer_authority (signer)
        (env.vault_memecoin_ata, true),    // 2 user_source
        (dest, true),                      // 3 user_destination
        (env.vault_base_ata, true),        // 4 destination_token_account
        (WSOL_MINT, false),                // 5 destination_mint
        (RAYDIUM_V4_PROGRAM_ID, false),    // 6 v4 program (stub's CPI callee)
        (spl_token_id(), false),           // 7 dup
        (env.pool, true),                  // 8 amm
        (RAYDIUM_V4_AMM_AUTHORITY, false), // 9 amm_authority
        (env.open_orders, true),           // 10
        (env.target_orders, true),         // 11
        (env.coin_vault, true),            // 12
        (env.pc_vault, true),              // 13
        (env.market_program, false),       // 14
        (env.market, true),                // 15
        (env.bids, true),                  // 16
        (env.asks, true),                  // 17
        (env.event_queue, true),           // 18
        (env.market_coin_vault, true),     // 19
        (env.market_pc_vault, true),       // 20
        (env.vault_signer, false),         // 21
        (env.vault_memecoin_ata, true),    // 22 dup source
        (dest, true),                      // 23 dup destination
        (env.vault_authority, false),      // 24 user_owner (signer)
    ];
    accounts.extend(tail);
    Route { data, accounts }
}

struct SalvageOpts {
    lp_amount: u64,
    pool_account: Pubkey,
    amm_program_override: Option<Pubkey>,
    memecoin_mint: Pubkey,
    memecoin_ata: Pubkey,
    lp_mint: Pubkey,
    salvor_lp_ata: Pubkey,
    min_quote_output_lamports: u64,
    slippage_override: Option<u16>,
    route: Option<Route>,
}

fn salvage_ix(env: &PoolEnv, opts: &SalvageOpts) -> Instruction {
    let route = opts.route.as_ref();
    let route_data: &[u8] = route.map(|r| r.data.as_slice()).unwrap_or(&[]);
    let route_len = route.map(|r| r.accounts.len()).unwrap_or(0);

    let mut data = anchor_disc("salvage_pool").to_vec();
    data.extend_from_slice(RAYDIUM_V4_PROGRAM_ID.as_ref());
    data.extend_from_slice(env.pool.as_ref());
    data.extend_from_slice(&[7u8; 32]); // lp_snapshot_merkle_root (placeholder)
    data.extend_from_slice(&env.lp_supply.to_le_bytes()); // lp_total_supply_at_snapshot
    data.extend_from_slice(&opts.min_quote_output_lamports.to_le_bytes());
    data.extend_from_slice(&opts.lp_amount.to_le_bytes());
    data.extend_from_slice(&(route_data.len() as u32).to_le_bytes());
    data.extend_from_slice(route_data);
    match opts.slippage_override {
        Some(o) => {
            data.push(1);
            data.extend_from_slice(&o.to_le_bytes());
        }
        None => data.push(0),
    }
    data.push(route_len as u8);

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
        AccountMeta::new(opts.pool_account, false),
        AccountMeta::new_readonly(
            opts.amm_program_override.unwrap_or(RAYDIUM_V4_PROGRAM_ID),
            false,
        ),
        AccountMeta::new_readonly(JUPITER_V6_PROGRAM_ID, false),
        AccountMeta::new(env.vault_authority, false),
        AccountMeta::new(env.vault_sol_holding, false),
        AccountMeta::new(opts.salvor_lp_ata, false),
        AccountMeta::new(env.vault_base_ata, false),
        AccountMeta::new(opts.memecoin_ata, false),
        AccountMeta::new(opts.lp_mint, false),
        AccountMeta::new_readonly(opts.memecoin_mint, false),
        AccountMeta::new_readonly(WSOL_MINT, false),
        AccountMeta::new_readonly(spl_token_id(), false),
        AccountMeta::new_readonly(spl_ata_id(), false),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
    for (k, w) in env.remaining().iter().zip(env.remaining_writable()) {
        metas.push(if w {
            AccountMeta::new(*k, false)
        } else {
            AccountMeta::new_readonly(*k, false)
        });
    }
    if let Some(r) = route {
        for (k, w) in &r.accounts {
            metas.push(if *w {
                AccountMeta::new(*k, false)
            } else {
                AccountMeta::new_readonly(*k, false)
            });
        }
    }
    Instruction::new_with_bytes(vault_id(), &data, metas)
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

/// A closed token account is deleted from the state entirely (zero lamports).
async fn expect_closed(client: &mut BanksClient, k: &Pubkey, ctx: &str) {
    let a = client.get_account(*k).await.unwrap();
    assert!(
        a.is_none()
            || (a.as_ref().unwrap().lamports == 0
                && a.as_ref().unwrap().owner == system_program::ID
                && a.as_ref().unwrap().data.is_empty()),
        "{ctx}: expected {k} to be closed/deleted"
    );
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

/// The pool's memecoin-side reserve (the side that is NOT WSOL).
fn memecoin_reserve(env: &PoolEnv) -> u64 {
    if env.base_is_coin_side {
        env.pc_reserve
    } else {
        env.coin_reserve
    }
}

/// Exact dry-run of the withdraw leg: boots a fresh VM with the conversion
/// leg disabled (dust = u64::MAX, empty route — the Phase 2.1 shape) and
/// reads the post-withdraw pool reserves. The VM is deterministic, so the
/// real test's withdraw produces byte-identical deltas; the salvor's
/// off-chain quote (in_amount + floor) is derived from the same numbers.
/// Returns (memecoin_received, wsol_reserve_after, memecoin_reserve_after).
async fn dry_run_withdraw(env: &PoolEnv, salvor: &Keypair) -> (u64, u64, u64) {
    let Some(boot) = build_genesis(u64::MAX, vec![]) else {
        // build_genesis prints its own SKIP reason; the caller's test body
        // is unreachable in that case, so returning zeroes keeps the types.
        return (0, 0, 0);
    };
    // The dry-run must target the SAME pool: rebuild a boot limited to it.
    // (Genesis contains both pools; only the env under test is exercised.)
    let _ = salvor;
    let (mut client, boot) = start(boot).await;
    let env = if boot.env1.pool == env.pool {
        &boot.env1
    } else {
        boot.env2
            .as_ref()
            .expect("orientation pool fixtures missing")
    };
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: 0,
        slippage_override: None,
        route: None,
    };
    send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .unwrap_or_else(|e| panic!("dry-run salvage failed: {e:?}"));

    let coin_after = token_amount(&acct(&mut client, &env.coin_vault).await);
    let pc_after = token_amount(&acct(&mut client, &env.pc_vault).await);
    let (wsol_after, mem_after) = if env.base_is_coin_side {
        (coin_after, pc_after)
    } else {
        (pc_after, coin_after)
    };
    let p_mem = memecoin_reserve(env) - mem_after;
    assert!(p_mem > 0, "dry-run withdraw paid zero memecoin");
    (p_mem, wsol_after, mem_after)
}

/// The pool-implied WSOL conversion of `memecoin_in` at the post-withdraw
/// reserve ratio (identical to the vault's on-chain computation).
fn implied_wsol(memecoin_in: u64, wsol_reserve: u64, memecoin_reserve: u64) -> u128 {
    (memecoin_in as u128) * (wsol_reserve as u128) / (memecoin_reserve as u128)
}

/// The floor the harness submits: the implied conversion tightened by the
/// protocol cap, exactly what the on-chain ceiling requires.
fn harness_floor(implied: u128) -> u64 {
    ((implied * (BPS_DEN - HARNESS_CAP_BPS)) / BPS_DEN) as u64
}

// =====================================================================
// Tests — the full pipeline (the Phase 3 exit condition)
// =====================================================================

/// LP -> Raydium withdraw -> memecoin -> Jupiter -> WSOL -> SOL unwrap ->
/// 40/40/20, in ONE transaction, against real mainnet bytecode and real
/// pool state, for BOTH pool orientations. Asserts exact conservation.
async fn run_full_pipeline(env_sel: &PoolEnv) {
    let Some(boot) = build_genesis(0, vec![]) else {
        return;
    };
    // Salvor's off-chain quote: exact withdraw output + post-withdraw
    // reserves from a deterministic dry-run.
    let (p_mem, wsol_after, mem_after) = dry_run_withdraw(env_sel, &boot.salvor).await;
    let implied = implied_wsol(p_mem, wsol_after, mem_after);
    let floor = harness_floor(implied);

    let (mut client, boot) = start(boot).await;
    let env = if boot.env1.pool == env_sel.pool {
        &boot.env1
    } else {
        boot.env2
            .as_ref()
            .expect("orientation pool fixtures missing")
    };

    let route = jupiter_route(env, p_mem, 0, 0, None, vec![]);
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: floor,
        slippage_override: None,
        route: Some(route),
    };
    let res = client
        .process_transaction_with_metadata(Transaction::new_signed_with_payer(
            &[salvage_ix(env, &opts)],
            Some(&boot.salvor.pubkey()),
            &[&boot.salvor],
            client.get_latest_blockhash().await.unwrap(),
        ))
        .await
        .unwrap();
    if let Err(e) = res.result {
        for l in res.metadata.map(|m| m.log_messages).unwrap_or_default() {
            eprintln!("LOG: {l}");
        }
        panic!("full-pipeline salvage failed: {e:?}");
    }

    // -------- LP burn is real and exact
    let supply_after = mint_supply(&acct(&mut client, &env.lp_mint).await);
    assert_eq!(supply_after, env.lp_supply - env.lp_burn_plan);

    // -------- reserve deltas. The route swaps through the SAME pool the
    // withdraw came from, so the memecoin-side reserve ROUNDS BACK to its
    // fixture value (withdraw out == swap in, the AMM fee is a coin-side
    // effect), while the WSOL-side reserve decreased by withdraw + swap.
    let coin_after = token_amount(&acct(&mut client, &env.coin_vault).await);
    let pc_after = token_amount(&acct(&mut client, &env.pc_vault).await);
    let memecoin_reserve_before = memecoin_reserve(env);
    let memecoin_after = if env.base_is_coin_side {
        pc_after
    } else {
        coin_after
    };
    assert_eq!(
        memecoin_after, memecoin_reserve_before,
        "same-pool route: memecoin reserve must round-trip exactly"
    );
    let base_delta = if env.base_is_coin_side {
        env.coin_reserve - coin_after
    } else {
        env.pc_reserve - pc_after
    };
    assert!(base_delta > 0);

    // -------- the memecoin was FULLY converted (dust = 0 on the happy path)
    let memecoin_left = token_amount(&acct(&mut client, &env.vault_memecoin_ata).await);
    assert_eq!(memecoin_left, 0, "memecoin ATA must be fully drained");

    // -------- the base ATA was closed (unwrap) and everything distributed
    expect_closed(&mut client, &env.vault_base_ata, "vault_base_ata").await;

    // -------- 40/40/20 settlement on the TOTAL recovery (withdraw + swap)
    let rent0 = Rent::default().minimum_balance(0);
    let rent_ta = Rent::default().minimum_balance(165);
    let holding = acct(&mut client, &env.vault_sol_holding).await;
    assert_eq!(
        holding.lamports,
        rent0 + rent_ta,
        "vault_sol_holding must retain exactly the two rents after distribution"
    );

    // Receipt layout (borsh, after 8-byte discriminator): pool_address (32),
    // salvor (32), lp_holder_amount (8), salvor_amount (8), protocol_amount
    // (8), total_proceeds (8).
    let receipt = acct(&mut client, &env.salvage_receipt).await;
    assert_eq!(receipt.owner, vault_id());
    let rd = &receipt.data;
    assert_eq!(&rd[8..40], env.pool.as_ref());
    let lp_holder_amount = read_u64(rd, 72);
    let salvor_amount = read_u64(rd, 80);
    let protocol_amount = read_u64(rd, 88);
    let total = read_u64(rd, 96);

    // The swap output is derived exactly: the vault's total recovery is
    // withdraw-WSOL + swap-WSOL, and the WSOL reserve delta equals exactly
    // that sum (the memecoin leg round-tripped). The withdraw-only part W
    // comes from the dry-run, so swap_out = total − W.
    let w_withdraw: u64 = if env.base_is_coin_side {
        env.coin_reserve - wsol_after
    } else {
        env.pc_reserve - wsol_after
    };
    let swap_out = (total as u128)
        .checked_sub(w_withdraw as u128)
        .expect("total must exceed the withdraw-side base payout");
    assert!(swap_out > 0, "Jupiter leg must have produced output");
    // Sanity rail (generous): the AMM's effective swap price can deviate
    // from the raw reserve ratio through its OpenBook open-orders inventory,
    // but never by an order of magnitude. The PROTOCOL-enforced bounds are
    // the floor below and the exact 40/40/20 conservation above.
    assert!(
        swap_out <= implied * 2,
        "swap output {} implausibly exceeds the implied conversion {}",
        swap_out,
        implied
    );
    assert!(swap_out >= floor as u128);

    // 40/40/20 recomputed from the total must match the receipt exactly.
    let exp_salvor = (total as u128 * 4_000 / 10_000) as u64;
    let exp_lp = (total as u128 * 4_000 / 10_000) as u64;
    let exp_protocol = total - exp_salvor - exp_lp;
    assert_eq!(salvor_amount, exp_salvor);
    assert_eq!(lp_holder_amount, exp_lp);
    assert_eq!(protocol_amount, exp_protocol);

    let treasury = acct(&mut client, &env.protocol_treasury).await;
    assert_eq!(treasury.lamports, exp_protocol);
    let lp_pool = acct(&mut client, &env.lp_holder_pool_vault).await;
    assert_eq!(lp_pool.lamports, rent0 + exp_lp);
}

#[tokio::test]
async fn full_pipeline_converts_memecoin_to_sol() {
    let Some(boot) = build_genesis(0, vec![]) else {
        return;
    };
    run_full_pipeline(&boot.env1).await;
}

#[tokio::test]
async fn inverted_orientation_pool_converts_memecoin() {
    let Some(boot) = build_genesis(0, vec![]) else {
        return;
    };
    let Some(env2) = &boot.env2 else {
        eprintln!("SKIP: orientation pool fixtures missing (manifest has no orientation_pool)");
        return;
    };
    run_full_pipeline(env2).await;
}

// =====================================================================
// Tests — orientation derivation (CPI-010)
// =====================================================================

#[tokio::test]
async fn pool_without_wsol_side_rejected_before_any_cpi() {
    // Patch pool 1's coin mint to a random key: neither side is WSOL.
    // Like every other test in this suite, this must SKIP cleanly (not
    // panic) when the fork fixtures are absent — the documented
    // fixture-less behavior (tests/README.md).
    let Some(manifest) = load_manifest() else {
        return;
    };
    let (pool_key, mut pool_acct) = load_real_account(&manifest["accounts"], "pool");
    let bogus = Pubkey::new_unique();
    pool_acct.data[400..432].copy_from_slice(bogus.as_ref());
    let Some(boot) = build_genesis(0, vec![(pool_key, pool_acct)]) else {
        return;
    };
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: 0,
        slippage_override: None,
        route: None,
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_UNSUPPORTED_BASE_TOKEN,
        "a pool with no WSOL side must revert UnsupportedBaseToken (7019) pre-CPI",
    );
    // Nothing moved.
    let supply = mint_supply(&acct(&mut client, &env.lp_mint).await);
    assert_eq!(supply, env.lp_supply);
    assert_eq!(
        token_amount(&acct(&mut client, &env.coin_vault).await),
        env.coin_reserve
    );
}

#[tokio::test]
async fn foreign_memecoin_mint_rejected() {
    // The submitted memecoin mint is not the pool's non-WSOL mint: the
    // vault must bind the accounts to the pool's own bytes. The fake mint
    // account is injected so the pre-handler ATA creation succeeds and the
    // HANDLER's binding check is what fires.
    let fake_mint = Pubkey::new_unique();
    let Some(boot) = build_genesis(0, vec![(fake_mint, forged_mint(6))]) else {
        return;
    };
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    let fake_ata = Pubkey::find_program_address(
        &[
            env.vault_authority.as_ref(),
            spl_token_id().as_ref(),
            fake_mint.as_ref(),
        ],
        &spl_ata_id(),
    )
    .0;
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: fake_mint,
        memecoin_ata: fake_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: 0,
        slippage_override: None,
        route: None,
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_PREFLIGHT_FAILED,
        "foreign memecoin mint must fail pre-flight",
    );
    let supply = mint_supply(&acct(&mut client, &env.lp_mint).await);
    assert_eq!(supply, env.lp_supply, "no state may move");
}

#[tokio::test]
async fn foreign_lp_mint_rejected() {
    // The submitted LP mint is not the pool's LP mint. The fake mint AND a
    // matching (zero-balance) salvor LP account are injected so Anchor's
    // account validation passes and the HANDLER's binding check fires.
    let salvor = Keypair::new();
    let fake_lp_mint = Pubkey::new_unique();
    let fake_lp_ata = Pubkey::find_program_address(
        &[
            salvor.pubkey().as_ref(),
            spl_token_id().as_ref(),
            fake_lp_mint.as_ref(),
        ],
        &spl_ata_id(),
    )
    .0;
    let Some(boot) = build_genesis_with(
        0,
        vec![
            (fake_lp_mint, forged_mint(8)),
            (
                fake_lp_ata,
                forged_token_account(&fake_lp_mint, &salvor.pubkey(), 0),
            ),
        ],
        salvor,
    ) else {
        return;
    };
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: fake_lp_mint,
        salvor_lp_ata: fake_lp_ata,
        min_quote_output_lamports: 0,
        slippage_override: None,
        route: None,
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_PREFLIGHT_FAILED,
        "foreign LP mint must fail pre-flight",
    );
    let supply = mint_supply(&acct(&mut client, &env.lp_mint).await);
    assert_eq!(supply, env.lp_supply, "no state may move");
}

// =====================================================================
// Tests — slippage ceiling (SLIP-001)
// =====================================================================

#[tokio::test]
async fn zero_floor_rejected_by_slippage_ceiling() {
    let Some(boot) = build_genesis(0, vec![]) else {
        return;
    };
    let (p_mem, wsol_after, mem_after) = dry_run_withdraw(&boot.env1, &boot.salvor).await;
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    let route = jupiter_route(env, p_mem, 0, 0, None, vec![]);
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: 0, // infinitely permissive floor
        slippage_override: None,
        route: Some(route),
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .unwrap_err();
    let implied = implied_wsol(p_mem, wsol_after, mem_after);
    assert!(
        implied > 0,
        "test precondition: the implied conversion must be non-zero"
    );
    expect_custom(
        err,
        ERR_SLIPPAGE_EXCEEDED,
        "a zero floor must be rejected by the protocol slippage ceiling",
    );
    // Atomic: the withdraw already executed inside the reverted tx — the
    // LP supply and reserves are untouched.
    let supply = mint_supply(&acct(&mut client, &env.lp_mint).await);
    assert_eq!(supply, env.lp_supply);
    assert_eq!(
        token_amount(&acct(&mut client, &env.coin_vault).await),
        env.coin_reserve
    );
}

#[tokio::test]
async fn override_tightens_slippage_ceiling() {
    let Some(boot) = build_genesis(0, vec![]) else {
        return;
    };
    let (p_mem, wsol_after, mem_after) = dry_run_withdraw(&boot.env1, &boot.salvor).await;
    let implied = implied_wsol(p_mem, wsol_after, mem_after);
    // A floor that satisfies the default 300 bps cap exactly.
    let floor = harness_floor(implied);
    // ...but with the per-tx override at 100 bps the ceiling requires
    // floor >= implied * 9900 / 10000 > floor — must revert.
    assert!((implied * (BPS_DEN - 100) / BPS_DEN) as u64 > floor);

    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    let route = jupiter_route(env, p_mem, 0, 0, None, vec![]);
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: floor,
        slippage_override: Some(100),
        route: Some(route),
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_SLIPPAGE_EXCEEDED,
        "the per-tx override must tighten the ceiling",
    );
}

// =====================================================================
// Tests — the swap leg under adversarial routes
// =====================================================================

#[tokio::test]
async fn insufficient_output_reverts_atomically() {
    let Some(boot) = build_genesis(0, vec![]) else {
        return;
    };
    let (p_mem, wsol_after, mem_after) = dry_run_withdraw(&boot.env1, &boot.salvor).await;
    let implied = implied_wsol(p_mem, wsol_after, mem_after);
    // The ceiling accepts any floor ABOVE the implied conversion minus the
    // cap — so an impossible 10x floor passes the ceiling but must fail the
    // post-swap output check.
    let impossible_floor = (implied * 10) as u64;

    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    let route = jupiter_route(env, p_mem, 0, 0, None, vec![]);
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: impossible_floor,
        slippage_override: None,
        route: Some(route),
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_SLIPPAGE_EXCEEDED,
        "an unachievable floor must fail the post-swap output check",
    );
    // Atomic revert: the REAL swap that just ran inside the failed tx left
    // no trace — reserves and LP supply are exactly the fixture values.
    let supply = mint_supply(&acct(&mut client, &env.lp_mint).await);
    assert_eq!(supply, env.lp_supply);
    assert_eq!(
        token_amount(&acct(&mut client, &env.coin_vault).await),
        env.coin_reserve
    );
    assert_eq!(
        token_amount(&acct(&mut client, &env.pc_vault).await),
        env.pc_reserve
    );
}

#[tokio::test]
async fn hijacked_route_destination_rejected() {
    // The route credits an ATTACKER's WSOL account while the vault watches
    // its own: the swap-leg floor must see a zero delta and revert — the
    // attacker keeps nothing (the tx reverted).
    let attacker = Keypair::new();
    let attacker_wsol_ata = Pubkey::find_program_address(
        &[
            attacker.pubkey().as_ref(),
            spl_token_id().as_ref(),
            WSOL_MINT.as_ref(),
        ],
        &spl_ata_id(),
    )
    .0;
    let Some(boot) = build_genesis(
        0,
        vec![(
            attacker_wsol_ata,
            forged_token_account(&WSOL_MINT, &attacker.pubkey(), 0),
        )],
    ) else {
        return;
    };
    let (p_mem, wsol_after, mem_after) = dry_run_withdraw(&boot.env1, &boot.salvor).await;
    let floor = harness_floor(implied_wsol(p_mem, wsol_after, mem_after));

    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    let route = jupiter_route(env, p_mem, 0, 0, Some(attacker_wsol_ata), vec![]);
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: floor,
        slippage_override: None,
        route: Some(route),
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_SLIPPAGE_EXCEEDED,
        "a route paying an attacker destination must fail the floor check",
    );
    // The attacker received nothing — the whole transaction reverted.
    assert_eq!(
        token_amount(&acct(&mut client, &attacker_wsol_ata).await),
        0,
        "hijacked destination must stay empty"
    );
    let supply = mint_supply(&acct(&mut client, &env.lp_mint).await);
    assert_eq!(supply, env.lp_supply);
}

#[tokio::test]
async fn bad_route_data_rejected() {
    let Some(boot) = build_genesis(0, vec![]) else {
        return;
    };
    let (p_mem, wsol_after, mem_after) = dry_run_withdraw(&boot.env1, &boot.salvor).await;
    let floor = harness_floor(implied_wsol(p_mem, wsol_after, mem_after));
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    let mut route = jupiter_route(env, p_mem, 0, 0, None, vec![]);
    route.data[0] ^= 0xff; // corrupted discriminator — the aggregator rejects
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: floor,
        slippage_override: None,
        route: Some(route),
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .unwrap_err();
    // Raw callee code surfacing (see failed_jupiter test): the stand-in's
    // discriminator rejection is 6002.
    expect_custom(err, 6002, "a rejected route must revert the salvage");
}

#[tokio::test]
async fn failed_jupiter_transaction_rejected() {
    let Some(boot) = build_genesis(0, vec![]) else {
        return;
    };
    let (p_mem, wsol_after, mem_after) = dry_run_withdraw(&boot.env1, &boot.salvor).await;
    let floor = harness_floor(implied_wsol(p_mem, wsol_after, mem_after));
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    // fail_mode = 1: the aggregator itself fails mid-route.
    let route = jupiter_route(env, p_mem, 0, 1, None, vec![]);
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: floor,
        slippage_override: None,
        route: Some(route),
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .unwrap_err();
    // The runtime surfaces the CALLEE's raw custom code (same behaviour the
    // Phase 2.1 suite documents for raw AMM codes): the stand-in's simulated
    // failure 6003 is what the transaction reports. The vault's own
    // `JupiterSwapFailed` mapping is internal belt-and-braces.
    expect_custom(
        err,
        6003,
        "a failing aggregator must revert the salvage atomically",
    );
    let supply = mint_supply(&acct(&mut client, &env.lp_mint).await);
    assert_eq!(supply, env.lp_supply, "atomic revert leaves no trace");
}

#[tokio::test]
async fn route_referencing_protected_accounts_rejected() {
    let Some(boot) = build_genesis(0, vec![]) else {
        return;
    };
    let (p_mem, wsol_after, mem_after) = dry_run_withdraw(&boot.env1, &boot.salvor).await;
    let floor = harness_floor(implied_wsol(p_mem, wsol_after, mem_after));
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    // A route whose account list includes the LP-holder pool vault — no
    // legitimate route touches the vault's settlement state.
    let route = jupiter_route(
        env,
        p_mem,
        0,
        0,
        None,
        vec![(env.lp_holder_pool_vault, true)],
    );
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        amm_program_override: None,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: floor,
        slippage_override: None,
        route: Some(route),
    };
    let err = send(&mut client, &boot.salvor, &[salvage_ix(env, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_PREFLIGHT_FAILED,
        "a route referencing a vault custody account must fail pre-flight",
    );
    let supply = mint_supply(&acct(&mut client, &env.lp_mint).await);
    assert_eq!(supply, env.lp_supply, "no state may move");
}
