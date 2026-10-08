// SPDX-License-Identifier: Apache-2.0
//
// Phase 5.3 fork harness (LP claims proven on the REAL snapshotter path).
//
// Executes the complete claim lifecycle — snapshot → Merkle tree → sealed
// artifact → salvage (root sealed on-chain) → `claim_lp_proceeds` → SOL in
// the holder's wallet — against the REAL mainnet Raydium V4 / OpenBook /
// SPL-token bytecode inside an in-process Solana VM
// (`solana-program-test`), seeded with byte-for-byte mainnet state of the
// canonical SOL/USDC V4 pool
// 58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2.
//
// This suite retires the Phase 4 harness's documented stand-in: there, the
// off-chain snapshot was "the Merkle tree an honest snapshotter would
// produce" (`settlement_economics_fork.rs` forged shortcut #5, built by
// hand with `build_three_leaf_tree`). Here every root and every proof comes
// from the shipped `grave-snapshotter` crate exactly as production will
// produce them:
//
//   1. the LP-holder ledger is read from the live VM state into an
//      `InMemorySource` — the same facts an `RpcSource` would serve from a
//      real ledger (supply + every token account, one consistent view);
//   2. `SnapshotBuilder::build` produces the deterministic snapshot (the
//      `Σ enumerated balances == lp_mint.supply` completeness gate runs for
//      real — the VM ledger is fully enumerable, so the gate must pass);
//   3. `SnapshotMerkleTree::from_snapshot` + `SnapshotArtifact::seal` seal
//      the root and per-holder ready-to-submit proofs;
//   4. the artifact is serialized to JSON and re-loaded — the publication
//      boundary; holders only ever consume the published document;
//   5. `salvage_pool` seals `artifact.merkle_root` +
//      `artifact.lp_total_supply_at_snapshot` into `PoolRegistry` (pinned
//      against the live mint);
//   6. each holder claims with THEIR OWN entry from the published artifact
//      (`proof_for`) — wallet → proof → claim → SOL, no manual steps.
//
// What this PROVES (the acceptance bar for Phase 5.3):
//   - Claim successfully: five claimants (including the salvor — D11
//     policy 2: the pre-burn balance is an ordinary leaf) each receive
//     exactly floor(bucket × balance / supply), driven end-to-end by the
//     artifact proofs, including the promotion shapes the real tree
//     builder emits for a 5-leaf set.
//   - Reject invalid proof: swapped sibling, truncated proof, forged
//     element, and a wrong-signer submission all revert 7010
//     (`InvalidClaimProof`) with zero state movement; the same holder then
//     claims successfully with the honest entry (positive control).
//   - Reject duplicate claim: a second claim by the same (pool, holder)
//     fails at the ClaimRecord init constraint with zero movement.
//   - Reject overclaim: (a) an inflated `lp_balance_at_snapshot` is
//     repelled by the proof (leaf binds the balance); (b) a dishonest
//     snapshotter that seals an oversubscribed tree is repelled by the
//     cumulative conservation cap (7009) — both the single-shot
//     amount-above-bucket shape and the cumulative cross-holder drift the
//     defense-in-depth comment describes.
//   - Verify cumulative accounting: `Σ ClaimRecord.amount ==
//     registry.lp_holder_pool_claimed_lamports == Σ floor(bucket ×
//     balance / supply)`; the vault retains exactly rent + (bucket −
//     claimed); the sink-excluded custody share and the claim-side
//     rounding dust stay in the bucket, ledgered and unclaimable (D11).
//
// The harness forges exactly five things (documented shortcuts):
//   1. the EligibilityCert PDA (serialised with GraveScanner's own type),
//   2. the salvor's LP token account balance,
//   3. the claimants' + salvor's lamports,
//   4. the Jupiter stand-in program itself (same contract as Phase 3/4),
//   5. the VM's LP-token ledger SHAPE: the canonical pool's real supply is
//      spread over thousands of mainnet holder accounts the sandbox cannot
//      host, so the harness seeds one pool-LP custody account (owner = the
//      REAL Raydium AMM authority — a PDA that can never sign a claim, the
//      exact shape the D11 sink exclusion exists for) plus five claimant
//      wallets. There is no UNCX locker state in the VM, so the locker
//      evidence is honestly empty (`InMemoryLocks` with no records).
//
// Fixtures via `scripts/fetch_v4_fork_fixtures.mjs` (gitignored; tests SKIP
// without them). `grave_vault.so` and `jupiter_v6_stub.so` must be in
// tests/fixtures (scripts/build_fork_harness.sh builds both).

// solana-sdk 2.3 deprecates the monolithic `system_program` / `bpf_loader`
// modules in favour of the split interface crates; the deprecated paths
// still work and keep the harness on the same re-exports anchor-lang's
// prelude uses (same rationale as the Phase 3/4 suites).
#![allow(deprecated)]

use std::path::PathBuf;
use std::str::FromStr;

use anchor_lang::AccountDeserialize;
use anchor_lang::AccountSerialize;
use anchor_lang::Space;
use grave_snapshotter::source::InMemorySource;
use grave_snapshotter::{
    HolderEntry, InMemoryLocks, SnapshotArtifact, SnapshotBuilder, SnapshotMerkleTree,
    SnapshotRequest, TokenAccountSnapshot,
};
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
const ERR_MATH_OVERFLOW: u32 = 7009;
const ERR_INVALID_CLAIM_PROOF: u32 = 7010;

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

// Base transaction fee in program-test (one signature).
const FEE: u64 = 5_000;

// SalvageReceipt raw offset (borsh, after the 8-byte discriminator) — the
// LP share the bucket is funded with.
const R_LP: usize = 72;

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

fn token_owner(account: &Account) -> Pubkey {
    Pubkey::new_from_array(account.data[32..64].try_into().unwrap())
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
// Pool environment (identical to the Phase 4 suite, pool 1 focus)
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
    coin_reserve: u64,
    pc_reserve: u64,
    lp_supply: u64,
    lp_burn_plan: u64,
    base_is_coin_side: bool,
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

/// Serialise the forged cert PDA + salvor LP balance.
fn add_forged_pool_side(pt: &mut ProgramTest, env: &PoolEnv, salvor: &Keypair) {
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

/// A claimant wallet + its pre-salvage LP balance + its genesis lamports.
struct Claimant {
    wallet: Keypair,
    balance: u64,
    start_lamports: u64,
}

fn wallet_ata(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), spl_token_id().as_ref(), mint.as_ref()],
        &spl_ata_id(),
    )
    .0
}

/// The four non-salvor claimants: deterministic splits of the claimable
/// remainder after the pool-LP custody share and the burn plan. The salvor
/// is claimant #0 (D11 policy 2: the pre-burn balance is an ordinary leaf)
/// and is assembled by the boot fn — its keypair is owned by the genesis.
fn claim_wallets(claimable_total: u64) -> Vec<Claimant> {
    let b1 = claimable_total / 2;
    let b2 = claimable_total * 3 / 10;
    let b3 = claimable_total / 8;
    let b4 = claimable_total - b1 - b2 - b3;
    [
        (b1, LAMPORTS_PER_SOL),
        (b2, LAMPORTS_PER_SOL),
        (b3, LAMPORTS_PER_SOL),
        (b4, LAMPORTS_PER_SOL),
    ]
    .into_iter()
    .map(|(balance, start_lamports)| Claimant {
        wallet: Keypair::new(),
        balance,
        start_lamports,
    })
    .collect()
}

/// Genesis accounts for the claim side: the pool-LP custody token account
/// (owner = the real AMM authority — can never sign a claim, the exact
/// shape the D11 sink exclusion exists for), each wallet's LP ATA (so the
/// VM ledger is enumerable and Σ == supply holds) and each wallet's
/// funding (fees + ClaimRecord rent).
fn claim_side_genesis(
    lp_mint: &Pubkey,
    custody_account: Pubkey,
    custody_balance: u64,
    wallets: &[Claimant],
) -> Vec<(Pubkey, Account)> {
    let mut out = vec![(
        custody_account,
        forged_token_account(lp_mint, &RAYDIUM_V4_AMM_AUTHORITY, custody_balance),
    )];
    for claimant in wallets {
        out.push((
            wallet_ata(&claimant.wallet.pubkey(), lp_mint),
            forged_token_account(lp_mint, &claimant.wallet.pubkey(), claimant.balance),
        ));
        out.push((
            claimant.wallet.pubkey(),
            Account {
                lamports: claimant.start_lamports,
                data: vec![],
                owner: system_program::ID,
                executable: false,
                rent_epoch: u64::MAX,
            },
        ));
    }
    out
}

struct Boot {
    pt: Option<ProgramTest>,
    env1: PoolEnv,
    salvor: Keypair,
    /// `u64::MAX` = conversion leg always skipped (dry-run shape); `0` =
    /// protocol default floor — swap leg always active.
    dust: u64,
}

/// Bootstraps the VM with pool 1's real state, the vault, the real AMM /
/// market / token ELFs and the Jupiter stand-in. Returns None (SKIP) when
/// required fixtures are absent.
fn build_genesis(dust: u64, extra: Vec<(Pubkey, Account)>, salvor: Keypair) -> Option<Boot> {
    let manifest = load_manifest()?;
    let env1 = PoolEnv::load(&manifest, &salvor);

    let mut pt = ProgramTest::default();
    pt.prefer_bpf(true);
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
        dust,
    })
}

/// Runs `initialize` (protocol defaults: 40/40/20, dust 0 → conversion leg
/// active).
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

/// Single-hop route against the stub's documented account contract
/// (identical to the Phase 3/4 suites' builder).
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
    memecoin_mint: Pubkey,
    memecoin_ata: Pubkey,
    lp_mint: Pubkey,
    salvor_lp_ata: Pubkey,
    min_quote_output_lamports: u64,
    route: Option<Route>,
    /// Off-chain snapshot root — always a REAL root in this suite: the
    /// artifact's for honest runs, a deliberately-oversubscribed tree's for
    /// the dishonest-snapshotter scenarios.
    merkle_root: [u8; 32],
}

fn salvage_ix(env: &PoolEnv, opts: &SalvageOpts) -> Instruction {
    let route = opts.route.as_ref();
    let route_data: &[u8] = route.map(|r| r.data.as_slice()).unwrap_or(&[]);
    let route_len = route.map(|r| r.accounts.len()).unwrap_or(0);

    let mut data = anchor_disc("salvage_pool").to_vec();
    data.extend_from_slice(RAYDIUM_V4_PROGRAM_ID.as_ref());
    data.extend_from_slice(env.pool.as_ref());
    data.extend_from_slice(&opts.merkle_root); // lp_snapshot_merkle_root
    data.extend_from_slice(&env.lp_supply.to_le_bytes()); // lp_total_supply_at_snapshot
    data.extend_from_slice(&opts.min_quote_output_lamports.to_le_bytes());
    data.extend_from_slice(&opts.lp_amount.to_le_bytes());
    data.extend_from_slice(&(route_data.len() as u32).to_le_bytes());
    data.extend_from_slice(route_data);
    data.push(0); // no slippage override
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
        AccountMeta::new_readonly(RAYDIUM_V4_PROGRAM_ID, false),
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

/// `claim_lp_proceeds`: pool, balance, Merkle proof.
fn claim_ix(
    env: &PoolEnv,
    holder: &Pubkey,
    claim_record: &Pubkey,
    balance_at_snapshot: u64,
    proof: &[[u8; 32]],
) -> Instruction {
    let mut data = anchor_disc("claim_lp_proceeds").to_vec();
    data.extend_from_slice(env.pool.as_ref());
    data.extend_from_slice(&balance_at_snapshot.to_le_bytes());
    data.extend_from_slice(&(proof.len() as u32).to_le_bytes());
    for p in proof {
        data.extend_from_slice(p);
    }
    let metas = vec![
        AccountMeta::new(env.pool_registry, false),
        AccountMeta::new(*claim_record, false),
        AccountMeta::new(env.lp_holder_pool_vault, false),
        AccountMeta::new(*holder, true),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
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

fn expect_failure(err: BanksClientError, ctx: &str) {
    match err {
        BanksClientError::TransactionError(TransactionError::InstructionError(..)) => {}
        other => panic!("{ctx}: expected a transaction failure, got {other:?}"),
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

/// Exact dry-run of the withdraw leg (conversion disabled): boots a fresh VM
/// and reads the post-withdraw pool reserves. The VM is deterministic, so the
/// real test's withdraw produces byte-identical deltas.
/// Returns (memecoin_received, wsol_reserve_after, memecoin_reserve_after).
async fn dry_run_withdraw() -> (u64, u64, u64) {
    let Some(boot) = build_genesis(u64::MAX, vec![], Keypair::new()) else {
        return (0, 0, 0);
    };
    let (mut client, boot) = start(boot).await;
    let env = &boot.env1;
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: 0,
        route: None,
        merkle_root: [7u8; 32],
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

/// The exact on-chain pro-rata math: floor(bucket × balance / supply) in
/// u128, mirroring `claim_lp_proceeds`.
fn pro_rata(bucket: u64, balance: u64, supply: u64) -> u64 {
    ((bucket as u128) * (balance as u128) / (supply as u128)) as u64
}

fn claim_record_pda(env: &PoolEnv, holder: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"claim_record", env.pool.as_ref(), holder.as_ref()],
        &vault_id(),
    )
    .0
}

fn claim_record_rent() -> u64 {
    Rent::default().minimum_balance(8 + <grave_vault::state::ClaimRecord as Space>::INIT_SPACE)
}

// =====================================================================
// Phase 5.3 — the claim lifecycle on the real snapshotter
// =====================================================================

/// Read the LP-token ledger from the live VM into an `InMemorySource`: the
/// mint supply (+ served slot) and every seeded token account, one
/// consistent view. These are the same facts an `RpcSource` would serve
/// from a real ledger, so `SnapshotBuilder` consumes the fork exactly like
/// mainnet — including the `Σ balances == supply` completeness gate, which
/// must pass over a fully-enumerable VM ledger.
async fn read_ledger_source(
    client: &mut BanksClient,
    lp_mint: &Pubkey,
    token_accounts: &[Pubkey],
) -> InMemorySource {
    let mint_acct = acct(client, lp_mint).await;
    let supply = mint_supply(&mint_acct);
    let slot = client.get_root_slot().await.unwrap();
    let mut accounts = Vec::new();
    for addr in token_accounts {
        let a = acct(client, addr).await;
        assert_eq!(
            a.owner,
            spl_token_id(),
            "{addr} must be an SPL token account in the VM ledger"
        );
        accounts.push(TokenAccountSnapshot {
            address: *addr,
            owner: token_owner(&a),
            amount: token_amount(&a),
        });
    }
    InMemorySource::new(*lp_mint, slot, supply, accounts)
}

/// All five claimants as (wallet, pre-salvage balance, genesis lamports):
/// the salvor first — D11 policy 2, the pre-burn balance is an ordinary
/// leaf — then the four wallets.
fn claimant_list<'a>(
    salvor: &'a Keypair,
    burn: u64,
    wallets: &'a [Claimant],
) -> Vec<(&'a Keypair, u64, u64)> {
    let mut out = vec![(salvor, burn, 100 * LAMPORTS_PER_SOL)];
    out.extend(
        wallets
            .iter()
            .map(|c| (&c.wallet, c.balance, c.start_lamports)),
    );
    out
}

/// The booted, salvaged honest environment: the registry is sealed with the
/// published artifact's root, the LP bucket is funded, and every claimant
/// owns an artifact entry with a ready-to-submit proof.
struct ClaimFork {
    client: BanksClient,
    env: PoolEnv,
    /// The artifact exactly as a holder receives it (JSON round-tripped).
    published: SnapshotArtifact,
    salvor: Keypair,
    wallets: Vec<Claimant>,
    /// The sink-excluded pool-LP custody share (D11 exclusion ledger).
    custody_balance: u64,
    /// Σ claimant balances (the leaf-set total).
    claimable_total: u64,
    /// `lp_holder_pool_total_lamports` — the claim bucket.
    bucket: u64,
    supply: u64,
}

/// Boot → snapshot → tree → artifact → JSON publication → salvage. The
/// full honest lifecycle; everything downstream consumes only the
/// published artifact. Returns None (SKIP) when fixtures are absent.
async fn boot_claim_lifecycle() -> Option<ClaimFork> {
    // ---- ledger layout (derived from the fixture supply, pre-genesis) ----
    let manifest = load_manifest()?;
    let (lp_mint_pubkey, lp_mint_acct) = load_real_account(&manifest["accounts"], "lp_mint");
    let supply = mint_supply(&lp_mint_acct);
    let burn = (supply / 10_000).max(1);
    let custody_balance = supply / 4;
    let claimable_total = supply - custody_balance - burn;
    let wallets = claim_wallets(claimable_total);
    let custody_account = Pubkey::new_unique();

    // ---- full-pipeline salvage economics (dry-run on a disposable VM) ----
    let (p_mem, wsol_after, mem_after) = dry_run_withdraw().await;
    let floor = harness_floor(implied_wsol(p_mem, wsol_after, mem_after));

    // ---- genesis: real pool state + the seeded claim side ----
    let extra = claim_side_genesis(&lp_mint_pubkey, custody_account, custody_balance, &wallets);
    let salvor = Keypair::new();
    let boot = build_genesis(0, extra, salvor)?;
    let (mut client, boot) = start(boot).await;
    let env = boot.env1.clone();
    let salvor = boot.salvor;

    // ---- SNAPSHOT: the real snapshotter over the live VM ledger ----
    let mut addresses = vec![custody_account, env.salvor_lp_ata];
    addresses.extend(
        wallets
            .iter()
            .map(|c| wallet_ata(&c.wallet.pubkey(), &env.lp_mint)),
    );
    let source = read_ledger_source(&mut client, &env.lp_mint, &addresses).await;
    let locks = InMemoryLocks::from_records(&env.pool, &env.lp_mint, vec![]);
    let request = SnapshotRequest {
        pool_address: env.pool,
        amm_program_id: RAYDIUM_V4_PROGRAM_ID,
        lp_mint: env.lp_mint,
        sink_exclusions: vec![RAYDIUM_V4_AMM_AUTHORITY],
        custody_owner_overrides: vec![],
    };
    let snapshot = SnapshotBuilder::new(request)
        .build(&source, &locks)
        .expect("the honest VM ledger must snapshot cleanly");

    assert_eq!(snapshot.lp_total_supply_at_snapshot, supply);
    assert_eq!(snapshot.reconciliation.enumerated_total, supply);
    assert_eq!(
        snapshot.reconciliation.sink_exclusions_total, custody_balance,
        "the pool-LP custody share must land in the D11 exclusion ledger"
    );
    // the leaf set = the four wallets' claimable remainder + the salvor's
    // pre-burn balance (D11 policy 2) = supply − custody share
    assert_eq!(
        snapshot.reconciliation.entries_total,
        claimable_total + burn
    );
    assert_eq!(snapshot.entries.len(), wallets.len() + 1);
    // no UNCX locker state exists in the VM — the evidence is honestly empty
    assert_eq!(snapshot.locked.total_locked, 0);
    assert!(snapshot.locked.custody.is_none());
    // canonical ascending-owner order — the leaf set's contract
    assert!(snapshot.entries.windows(2).all(|w| w[0].owner < w[1].owner));
    // every claimant's seeded balance landed in the leaf set
    for (wallet, balance, _) in claimant_list(&salvor, burn, &wallets) {
        let entry = snapshot
            .entries
            .iter()
            .find(|e| e.owner == wallet.pubkey())
            .unwrap_or_else(|| panic!("snapshot must carry claimant {}", wallet.pubkey()));
        assert_eq!(entry.lp_balance, balance);
    }

    // ---- TREE + ARTIFACT + publication (the JSON boundary) ----
    let tree = SnapshotMerkleTree::from_snapshot(&snapshot).unwrap();
    let artifact = SnapshotArtifact::seal(&snapshot, &tree).unwrap();
    artifact
        .verify_integrity()
        .expect("the sealed artifact must verify");
    let json = serde_json::to_string(&artifact).unwrap();
    // determinism: the same snapshot always seals to byte-identical JSON
    assert_eq!(
        serde_json::to_string(&SnapshotArtifact::seal(&snapshot, &tree).unwrap()).unwrap(),
        json
    );
    // holders consume the PUBLISHED document only
    let published: SnapshotArtifact = serde_json::from_str(&json).unwrap();
    assert_eq!(published, artifact);
    published
        .verify_integrity()
        .expect("the published artifact must verify");
    assert_eq!(published.leaf_count, wallets.len() + 1);
    assert_eq!(published.tree_depth, 3, "5 leaves: 5 -> 3 -> 2 -> 1");
    assert_eq!(
        published.lp_total_supply_at_snapshot, env.lp_supply,
        "the supply `salvage_pool` will pin against the live mint"
    );

    // ---- SALVAGE: the artifact's root + supply are sealed on-chain ----
    let bucket = salvage_and_seal(
        &mut client,
        &salvor,
        &env,
        published.merkle_root,
        p_mem,
        floor,
    )
    .await;

    Some(ClaimFork {
        client,
        env,
        published,
        salvor,
        wallets,
        custody_balance,
        claimable_total,
        bucket,
        supply,
    })
}

/// The full-pipeline salvage (real withdraw + Jupiter conversion +
/// settlement) with `root` submitted as the snapshot root. Returns the
/// claim bucket after asserting the registry sealed the root.
async fn salvage_and_seal(
    client: &mut BanksClient,
    salvor: &Keypair,
    env: &PoolEnv,
    root: [u8; 32],
    p_mem: u64,
    floor: u64,
) -> u64 {
    let route = jupiter_route(env, p_mem, 0, 0, None, vec![]);
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: floor,
        route: Some(route),
        merkle_root: root,
    };
    let res = client
        .process_transaction_with_metadata(Transaction::new_signed_with_payer(
            &[salvage_ix(env, &opts)],
            Some(&salvor.pubkey()),
            &[salvor],
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

    let rd = &acct(client, &env.salvage_receipt).await.data;
    let lp_amt = read_u64(rd, R_LP);
    assert!(lp_amt > 0, "the LP bucket must be funded");

    let registry = grave_vault::state::PoolRegistry::try_deserialize(
        &mut &acct(client, &env.pool_registry).await.data[..],
    )
    .expect("registry must deserialize");
    assert_eq!(
        registry.lp_snapshot_merkle_root, root,
        "the submitted root must be sealed"
    );
    assert_eq!(
        registry.lp_total_supply_at_snapshot, env.lp_supply,
        "the salvage pins the submitted supply against the live mint"
    );
    assert_eq!(registry.lp_holder_pool_total_lamports, lp_amt);
    assert_eq!(registry.lp_holder_pool_claimed_lamports, 0);
    lp_amt
}

/// The dishonest-snapshotter scenario: a producer bypasses the
/// snapshotter's gates and seals a tree whose balances oversubscribe the
/// supply. `salvage_pool` cannot see balances (the root is opaque), so the
/// cumulative conservation cap is the last line of defense. The tree is
/// built with the REAL builder from doctored-but-canonical entries —
/// exactly what a buggy or malicious producer would emit.
async fn boot_oversubscribed(mut claimants: Vec<(Keypair, u64)>) -> Option<OversubFork> {
    claimants.sort_by(|a, b| a.0.pubkey().cmp(&b.0.pubkey()));
    let manifest = load_manifest()?;
    let (_, lp_mint_acct) = load_real_account(&manifest["accounts"], "lp_mint");
    let supply = mint_supply(&lp_mint_acct);

    let (p_mem, wsol_after, mem_after) = dry_run_withdraw().await;
    let floor = harness_floor(implied_wsol(p_mem, wsol_after, mem_after));

    // funded claimant wallets only — no honest snapshot, so no LP ledger
    let funded: Vec<(Pubkey, Account)> = claimants
        .iter()
        .map(|(wallet, _)| {
            (
                wallet.pubkey(),
                Account {
                    lamports: LAMPORTS_PER_SOL,
                    data: vec![],
                    owner: system_program::ID,
                    executable: false,
                    rent_epoch: u64::MAX,
                },
            )
        })
        .collect();
    let boot = build_genesis(0, funded, Keypair::new())?;
    let (mut client, boot) = start(boot).await;
    let env = boot.env1.clone();

    let entries: Vec<HolderEntry> = claimants
        .iter()
        .map(|(wallet, balance)| HolderEntry {
            owner: wallet.pubkey(),
            lp_balance: *balance,
        })
        .collect();
    let tree = SnapshotMerkleTree::from_entries(&entries).expect("canonical entries build a tree");
    let bucket = salvage_and_seal(&mut client, &boot.salvor, &env, tree.root(), p_mem, floor).await;

    Some(OversubFork {
        client,
        env,
        bucket,
        supply,
        claimants,
        proofs: tree.proofs(),
    })
}

struct OversubFork {
    client: BanksClient,
    env: PoolEnv,
    bucket: u64,
    supply: u64,
    /// Canonical (sorted) claimants with their doctored balances.
    claimants: Vec<(Keypair, u64)>,
    /// Real builder proofs, index-aligned with `claimants`.
    proofs: Vec<Vec<[u8; 32]>>,
}

// =====================================================================
// Tests — the five Phase 5.3 acceptance items
// =====================================================================

/// THE exit condition: a holder goes wallet → proof → claim → SOL with no
/// manual steps — the proof comes from the published artifact, the root
/// was sealed by the real salvage, and the SOL lands exactly.
#[tokio::test]
async fn claim_journey_wallet_proof_claim_sol() {
    let Some(fork) = boot_claim_lifecycle().await else {
        return;
    };
    let ClaimFork {
        mut client,
        env,
        published,
        salvor,
        wallets,
        claimable_total,
        bucket,
        supply,
        ..
    } = fork;
    let rent0 = Rent::default().minimum_balance(0);
    // the artifact's reconciliation mirrors the VM ledger's exclusion
    // ledger: leaf set = wallets' remainder + the salvor's pre-burn leaf
    assert_eq!(
        published.reconciliation.entries_total,
        claimable_total + env.lp_burn_plan
    );
    let mut cumulative = 0u64;
    for (i, (wallet, balance, _start)) in claimant_list(&salvor, env.lp_burn_plan, &wallets)
        .into_iter()
        .enumerate()
    {
        // the holder looks up THEIR OWN entry in the published artifact
        let entry = published
            .proof_for(&wallet.pubkey())
            .unwrap_or_else(|| panic!("the artifact must carry claimant {i}"));
        assert_eq!(entry.lp_balance, balance);
        let expected = pro_rata(bucket, balance, supply);

        let before = acct(&mut client, &wallet.pubkey()).await.lamports;
        send(
            &mut client,
            wallet,
            &[claim_ix(
                &env,
                &wallet.pubkey(),
                &claim_record_pda(&env, &wallet.pubkey()),
                entry.lp_balance,
                &entry.proof,
            )],
        )
        .await
        .unwrap_or_else(|e| panic!("claim {i} failed: {e:?}"));

        cumulative += expected;
        // exact SOL landing: the pro-rata floor, net of fee + record rent
        assert_eq!(
            acct(&mut client, &wallet.pubkey()).await.lamports,
            before - FEE - claim_record_rent() + expected,
            "claim {i} must pay exactly floor(bucket × balance / supply)"
        );
        // cumulative accounting ticks with every claim
        let registry = grave_vault::state::PoolRegistry::try_deserialize(
            &mut &acct(&mut client, &env.pool_registry).await.data[..],
        )
        .unwrap();
        assert_eq!(registry.lp_holder_pool_claimed_lamports, cumulative);
        assert!(cumulative <= bucket, "overclaim at claimant {i}");
        // the bucket drains claim by claim
        assert_eq!(
            acct(&mut client, &env.lp_holder_pool_vault).await.lamports,
            rent0 + bucket - cumulative
        );
    }
    eprintln!(
        "journey: bucket {bucket} / claimed {cumulative} / remainder {}",
        bucket - cumulative
    );
}

/// Swapped sibling, truncated proof, forged element, wrong signer — every
/// malformed submission reverts 7010 with zero state movement, and the
/// honest claim still succeeds afterwards (positive control).
#[tokio::test]
async fn invalid_proofs_rejected_with_zero_state_movement() {
    let Some(fork) = boot_claim_lifecycle().await else {
        return;
    };
    let ClaimFork {
        mut client,
        env,
        published,
        wallets,
        bucket,
        ..
    } = fork;
    let rent0 = Rent::default().minimum_balance(0);
    let vault_full = rent0 + bucket;

    let a = &wallets[0];
    let b = &wallets[1];
    let entry_a = published.proof_for(&a.wallet.pubkey()).unwrap().clone();
    let entry_b = published.proof_for(&b.wallet.pubkey()).unwrap().clone();
    let record_a = claim_record_pda(&env, &a.wallet.pubkey());
    let record_b = claim_record_pda(&env, &b.wallet.pubkey());

    // (a) swapped sibling: A's first proof element replaced by B's
    let mut tampered = entry_a.proof.clone();
    tampered[0] = entry_b.proof[0];
    let before = acct(&mut client, &a.wallet.pubkey()).await.lamports;
    let err = send(
        &mut client,
        &a.wallet,
        &[claim_ix(
            &env,
            &a.wallet.pubkey(),
            &record_a,
            entry_a.lp_balance,
            &tampered,
        )],
    )
    .await
    .unwrap_err();
    expect_custom(
        err,
        ERR_INVALID_CLAIM_PROOF,
        "swapped sibling must revert 7010",
    );
    assert_eq!(
        acct(&mut client, &a.wallet.pubkey()).await.lamports,
        before - FEE
    );
    assert_eq!(
        acct(&mut client, &env.lp_holder_pool_vault).await.lamports,
        vault_full
    );
    assert!(maybe_acct(&mut client, &record_a).await.is_none());

    // (b) truncated proof: the last folding step is missing
    let truncated = &entry_a.proof[..entry_a.proof.len() - 1];
    let before = acct(&mut client, &a.wallet.pubkey()).await.lamports;
    let err = send(
        &mut client,
        &a.wallet,
        &[claim_ix(
            &env,
            &a.wallet.pubkey(),
            &record_a,
            entry_a.lp_balance,
            truncated,
        )],
    )
    .await
    .unwrap_err();
    expect_custom(
        err,
        ERR_INVALID_CLAIM_PROOF,
        "truncated proof must revert 7010",
    );
    assert_eq!(
        acct(&mut client, &a.wallet.pubkey()).await.lamports,
        before - FEE
    );
    assert_eq!(
        acct(&mut client, &env.lp_holder_pool_vault).await.lamports,
        vault_full
    );
    assert!(maybe_acct(&mut client, &record_a).await.is_none());

    // (c) forged element: a hash nobody produced
    let mut forged = entry_a.proof.clone();
    forged[entry_a.proof.len() - 1] = hash(b"forged-sibling").to_bytes();
    let before = acct(&mut client, &a.wallet.pubkey()).await.lamports;
    let err = send(
        &mut client,
        &a.wallet,
        &[claim_ix(
            &env,
            &a.wallet.pubkey(),
            &record_a,
            entry_a.lp_balance,
            &forged,
        )],
    )
    .await
    .unwrap_err();
    expect_custom(
        err,
        ERR_INVALID_CLAIM_PROOF,
        "forged element must revert 7010",
    );
    assert_eq!(
        acct(&mut client, &a.wallet.pubkey()).await.lamports,
        before - FEE
    );
    assert_eq!(
        acct(&mut client, &env.lp_holder_pool_vault).await.lamports,
        vault_full
    );
    assert!(maybe_acct(&mut client, &record_a).await.is_none());

    // (d) wrong signer: B submits A's entry — the leaf binds the signer's
    // pubkey, so B cannot spend A's entitlement
    let before = acct(&mut client, &b.wallet.pubkey()).await.lamports;
    let err = send(
        &mut client,
        &b.wallet,
        &[claim_ix(
            &env,
            &b.wallet.pubkey(),
            &record_b,
            entry_a.lp_balance,
            &entry_a.proof,
        )],
    )
    .await
    .unwrap_err();
    expect_custom(
        err,
        ERR_INVALID_CLAIM_PROOF,
        "wrong signer must revert 7010",
    );
    assert_eq!(
        acct(&mut client, &b.wallet.pubkey()).await.lamports,
        before - FEE
    );
    assert_eq!(
        acct(&mut client, &env.lp_holder_pool_vault).await.lamports,
        vault_full
    );
    assert!(maybe_acct(&mut client, &record_b).await.is_none());

    // positive control: the honest entry was never poisoned
    let registry = grave_vault::state::PoolRegistry::try_deserialize(
        &mut &acct(&mut client, &env.pool_registry).await.data[..],
    )
    .unwrap();
    assert_eq!(registry.lp_holder_pool_claimed_lamports, 0);
    let before = acct(&mut client, &a.wallet.pubkey()).await.lamports;
    let expected = pro_rata(
        bucket,
        entry_a.lp_balance,
        published.lp_total_supply_at_snapshot,
    );
    send(
        &mut client,
        &a.wallet,
        &[claim_ix(
            &env,
            &a.wallet.pubkey(),
            &record_a,
            entry_a.lp_balance,
            &entry_a.proof,
        )],
    )
    .await
    .unwrap_or_else(|e| panic!("the honest claim must succeed: {e:?}"));
    assert_eq!(
        acct(&mut client, &a.wallet.pubkey()).await.lamports,
        before - FEE - claim_record_rent() + expected
    );
}

/// The ClaimRecord init constraint is the canonical double-claim defense:
/// the second claim fails and moves nothing.
#[tokio::test]
async fn duplicate_claim_rejected_with_zero_movement() {
    let Some(fork) = boot_claim_lifecycle().await else {
        return;
    };
    let ClaimFork {
        mut client,
        env,
        published,
        wallets,
        bucket,
        supply,
        ..
    } = fork;
    let rent0 = Rent::default().minimum_balance(0);
    let a = &wallets[0];
    let entry_a = published.proof_for(&a.wallet.pubkey()).unwrap().clone();
    let record_a = claim_record_pda(&env, &a.wallet.pubkey());

    // first claim succeeds
    send(
        &mut client,
        &a.wallet,
        &[claim_ix(
            &env,
            &a.wallet.pubkey(),
            &record_a,
            entry_a.lp_balance,
            &entry_a.proof,
        )],
    )
    .await
    .unwrap_or_else(|e| panic!("first claim failed: {e:?}"));
    let expected = pro_rata(bucket, entry_a.lp_balance, supply);
    let registry = grave_vault::state::PoolRegistry::try_deserialize(
        &mut &acct(&mut client, &env.pool_registry).await.data[..],
    )
    .unwrap();
    assert_eq!(registry.lp_holder_pool_claimed_lamports, expected);
    let vault_after_first = rent0 + bucket - expected;
    assert_eq!(
        acct(&mut client, &env.lp_holder_pool_vault).await.lamports,
        vault_after_first
    );

    // second claim: the ClaimRecord PDA already exists → the init
    // constraint rejects before any lamports move
    let before = acct(&mut client, &a.wallet.pubkey()).await.lamports;
    let err = send(
        &mut client,
        &a.wallet,
        &[claim_ix(
            &env,
            &a.wallet.pubkey(),
            &record_a,
            entry_a.lp_balance,
            &entry_a.proof,
        )],
    )
    .await
    .unwrap_err();
    expect_failure(err, "duplicate claim must fail at the ClaimRecord init");
    assert_eq!(
        acct(&mut client, &a.wallet.pubkey()).await.lamports,
        before - FEE,
        "a failed duplicate moves no proceeds (only the tx fee)"
    );
    let registry = grave_vault::state::PoolRegistry::try_deserialize(
        &mut &acct(&mut client, &env.pool_registry).await.data[..],
    )
    .unwrap();
    assert_eq!(registry.lp_holder_pool_claimed_lamports, expected);
    assert_eq!(
        acct(&mut client, &env.lp_holder_pool_vault).await.lamports,
        vault_after_first
    );
}

/// Overclaim is repelled at BOTH layers: an inflated balance breaks its
/// own Merkle leaf (7010), and a dishonest snapshotter that seals an
/// oversubscribed tree runs into the cumulative conservation cap (7009).
#[tokio::test]
async fn overclaim_rejected_at_both_layers() {
    // ---- layer 1: the proof binds the balance ----
    {
        let Some(fork) = boot_claim_lifecycle().await else {
            return;
        };
        let ClaimFork {
            mut client,
            env,
            published,
            wallets,
            bucket,
            ..
        } = fork;
        let rent0 = Rent::default().minimum_balance(0);
        let a = &wallets[0];
        let entry_a = published.proof_for(&a.wallet.pubkey()).unwrap().clone();
        let record_a = claim_record_pda(&env, &a.wallet.pubkey());
        let inflated = entry_a.lp_balance * 2;
        let before = acct(&mut client, &a.wallet.pubkey()).await.lamports;
        let err = send(
            &mut client,
            &a.wallet,
            &[claim_ix(
                &env,
                &a.wallet.pubkey(),
                &record_a,
                inflated,
                &entry_a.proof,
            )],
        )
        .await
        .unwrap_err();
        expect_custom(
            err,
            ERR_INVALID_CLAIM_PROOF,
            "inflated balance must revert 7010",
        );
        assert_eq!(
            acct(&mut client, &a.wallet.pubkey()).await.lamports,
            before - FEE
        );
        assert_eq!(
            acct(&mut client, &env.lp_holder_pool_vault).await.lamports,
            rent0 + bucket
        );
        assert!(maybe_acct(&mut client, &record_a).await.is_none());
    }

    // ---- layer 2a: a single holder proven at TWICE the supply ----
    let manifest = load_manifest().unwrap();
    let (_, lp_mint_acct) = load_real_account(&manifest["accounts"], "lp_mint");
    let supply = mint_supply(&lp_mint_acct);
    let Some(mut fork) = boot_oversubscribed(vec![(Keypair::new(), 2 * supply)]).await else {
        return;
    };
    let (holder, balance) = {
        let (h, b) = &fork.claimants[0];
        (h.pubkey(), *b)
    };
    // the payout would be 2× the bucket — the cap must fire
    assert_eq!(pro_rata(fork.bucket, balance, fork.supply), 2 * fork.bucket);
    let record = claim_record_pda(&fork.env, &holder);
    let before = acct(&mut fork.client, &holder).await.lamports;
    let err = send(
        &mut fork.client,
        &fork.claimants[0].0,
        &[claim_ix(
            &fork.env,
            &holder,
            &record,
            balance,
            &fork.proofs[0],
        )],
    )
    .await
    .unwrap_err();
    expect_custom(
        err,
        ERR_MATH_OVERFLOW,
        "a payout above the bucket must revert 7009",
    );
    let registry = grave_vault::state::PoolRegistry::try_deserialize(
        &mut &acct(&mut fork.client, &fork.env.pool_registry).await.data[..],
    )
    .unwrap();
    assert_eq!(registry.lp_holder_pool_claimed_lamports, 0);
    assert_eq!(
        acct(&mut fork.client, &fork.env.lp_holder_pool_vault)
            .await
            .lamports,
        Rent::default().minimum_balance(0) + fork.bucket
    );
    assert_eq!(acct(&mut fork.client, &holder).await.lamports, before - FEE);
    assert!(maybe_acct(&mut fork.client, &record).await.is_none());

    // ---- layer 2b: two holders each proven just over half the supply —
    // the first claim fits, the second crosses the cumulative cap ----
    let inflated_half = supply / 2 + supply / 1000;
    let Some(mut fork) = boot_oversubscribed(vec![
        (Keypair::new(), inflated_half),
        (Keypair::new(), inflated_half),
    ])
    .await
    else {
        return;
    };
    let (h1, b1) = {
        let (h, b) = &fork.claimants[0];
        (h.pubkey(), *b)
    };
    let (h2, b2) = {
        let (h, b) = &fork.claimants[1];
        (h.pubkey(), *b)
    };
    let first = pro_rata(fork.bucket, b1, fork.supply);
    assert!(
        first > fork.bucket / 2,
        "setup: the first claim must exceed half the bucket"
    );
    let record1 = claim_record_pda(&fork.env, &h1);
    send(
        &mut fork.client,
        &fork.claimants[0].0,
        &[claim_ix(&fork.env, &h1, &record1, b1, &fork.proofs[0])],
    )
    .await
    .unwrap_or_else(|e| panic!("the first inflated claim fits and must succeed: {e:?}"));
    let registry = grave_vault::state::PoolRegistry::try_deserialize(
        &mut &acct(&mut fork.client, &fork.env.pool_registry).await.data[..],
    )
    .unwrap();
    assert_eq!(registry.lp_holder_pool_claimed_lamports, first);

    let record2 = claim_record_pda(&fork.env, &h2);
    let vault_mid = acct(&mut fork.client, &fork.env.lp_holder_pool_vault)
        .await
        .lamports;
    let err = send(
        &mut fork.client,
        &fork.claimants[1].0,
        &[claim_ix(&fork.env, &h2, &record2, b2, &fork.proofs[1])],
    )
    .await
    .unwrap_err();
    expect_custom(
        err,
        ERR_MATH_OVERFLOW,
        "the second inflated claim must cross the cumulative cap (7009)",
    );
    let registry = grave_vault::state::PoolRegistry::try_deserialize(
        &mut &acct(&mut fork.client, &fork.env.pool_registry).await.data[..],
    )
    .unwrap();
    assert_eq!(
        registry.lp_holder_pool_claimed_lamports, first,
        "the reverted claim must leave the accounting untouched"
    );
    assert_eq!(
        acct(&mut fork.client, &fork.env.lp_holder_pool_vault)
            .await
            .lamports,
        vault_mid
    );
    assert!(maybe_acct(&mut fork.client, &record2).await.is_none());
}

/// The closing identity chain: Σ ClaimRecords == registry cumulative ==
/// Σ floors recomputed from the artifact alone; the vault keeps exactly
/// rent + (bucket − claimed) — the sink-excluded custody share plus the
/// claim-side rounding dust, ledgered and unclaimable (D11).
#[tokio::test]
async fn cumulative_accounting_closes_exactly() {
    let Some(fork) = boot_claim_lifecycle().await else {
        return;
    };
    let ClaimFork {
        mut client,
        env,
        published,
        salvor,
        wallets,
        custody_balance,
        bucket,
        supply,
        ..
    } = fork;
    let rent0 = Rent::default().minimum_balance(0);
    let claimants = claimant_list(&salvor, env.lp_burn_plan, &wallets);

    for &(wallet, _balance, _) in claimants.iter() {
        let entry = published.proof_for(&wallet.pubkey()).unwrap();
        send(
            &mut client,
            wallet,
            &[claim_ix(
                &env,
                &wallet.pubkey(),
                &claim_record_pda(&env, &wallet.pubkey()),
                entry.lp_balance,
                &entry.proof,
            )],
        )
        .await
        .unwrap_or_else(|e| panic!("claim by {} failed: {e:?}", wallet.pubkey()));
    }

    let registry = grave_vault::state::PoolRegistry::try_deserialize(
        &mut &acct(&mut client, &env.pool_registry).await.data[..],
    )
    .unwrap();
    let claimed = registry.lp_holder_pool_claimed_lamports;

    // every ClaimRecord matches its artifact entry and the pro-rata floor
    let mut sum_records = 0u64;
    for &(wallet, balance, _) in claimants.iter() {
        let record = grave_vault::state::ClaimRecord::try_deserialize(
            &mut &acct(&mut client, &claim_record_pda(&env, &wallet.pubkey()))
                .await
                .data[..],
        )
        .unwrap();
        assert_eq!(record.pool_address, env.pool);
        assert_eq!(record.lp_holder, wallet.pubkey());
        let expected = pro_rata(bucket, balance, supply);
        assert_eq!(record.amount_lamports, expected);
        assert_eq!(record.lp_balance_at_snapshot, balance);
        assert!(record.claimed_at_ts > 0);
        sum_records += record.amount_lamports;
    }
    assert_eq!(sum_records, claimed);

    // the artifact alone reproduces the ledger
    let sum_from_artifact: u64 = published
        .entries
        .iter()
        .map(|e| pro_rata(bucket, e.lp_balance, supply))
        .sum();
    assert_eq!(sum_from_artifact, claimed);

    // conservation: the vault keeps exactly rent + (bucket − claimed)
    let remainder = bucket - claimed;
    assert_eq!(
        acct(&mut client, &env.lp_holder_pool_vault).await.lamports,
        rent0 + remainder
    );
    // the remainder decomposes into the sink-excluded custody share plus
    // the claim-side rounding dust (< 1 lamport lost per floor)
    let custody_share = pro_rata(bucket, custody_balance, supply);
    let rounding = remainder - custody_share;
    assert!(rounding <= claimants.len() as u64);
    eprintln!(
        "accounting: bucket {bucket} / claimed {claimed} / custody share {custody_share} / rounding dust {rounding}"
    );
}
