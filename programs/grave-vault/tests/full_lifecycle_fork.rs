// SPDX-License-Identifier: Apache-2.0
//
// Phase 6 — the first COMPLETE GraveYield integration test (roadmap
// Phase 6). One test executes the entire protocol lifecycle end to end
// against real mainnet Raydium V4 / OpenBook / SPL-token bytecode:
//
//   candidate pool (real mainnet AmmInfo state)
//     -> GraveScanner initialize (governance thresholds, oracle keys)
//     -> record_launch_price      (C2 baseline: oracle-signed 168B Ed25519
//                                  attestation, runtime precompile path)
//     -> evaluate_pool_phase_1    (C1 evidence: indexer-signed 112B Ed25519
//                                  attestation + six criteria over the real
//                                  pool bytes) -> EligibilityAnchor
//     -> multi-epoch waiting period (VM warp; >= MIN_EPOCH_CONFIRMATION)
//     -> evaluate_pool_phase_2    (fresh C1 attestation, bitmap equality,
//                                  epoch gap) -> EligibilityCert
//     -> LP-holder snapshot over the live VM ledger (grave-snapshotter)
//     -> SnapshotMerkleTree -> sealed SnapshotArtifact -> JSON publication
//     -> salvage_pool             (real withdraw CPI + Jupiter stand-in
//                                  conversion + 40/40/20 settlement; the
//                                  artifact root + supply sealed on chain)
//     -> claim_lp_proceeds x5     (artifact proofs -> SOL in wallets)
//
// and asserts every state transition along the way.
//
// The forged-EligibilityCert stand-in the Phase 2.1-5.3 suites documented
// is GONE here: the cert that authorizes salvage is issued by the real
// grave-scanner program running as BPF in the same VM, and both
// attestation paths execute through the runtime's actual ed25519
// precompile verification. (Phase 6 also CORRECTED the scanner's
// precompile offset contract — the previously shipped 14-byte header is
// not a wire format any Solana runtime accepts; see
// grave-scanner/src/attestation.rs and spec rev 1.10.0.)
//
// Harness notes:
//   * The withdraw-leg economics are measured on a disposable VM that
//     runs the SAME full scanner path (no forged cert anywhere) with the
//     conversion leg disabled — the VM is deterministic, so the real
//     salvage's withdraw produces byte-identical deltas (the Phase 5.3
//     suite's measurement pattern, upgraded to the honest boot).
//   * Governance thresholds are configured explicitly (they are
//     governance parameters, not constants): the fork pool is a real
//     mainnet account, and the C1/C2 evidence authorities are test
//     keypairs, exactly as in production the indexer/oracle keys are
//     registered in ProtocolConfig at initialize.

// solana-sdk 2.3 deprecates the monolithic `system_program` / `bpf_loader`
// modules in favour of the split interface crates; the deprecated paths
// still work and keep the harness on the same re-exports anchor-lang's
// prelude uses (same rationale as the Phase 3/4/5 suites).
#![allow(deprecated)]

use std::path::PathBuf;
use std::str::FromStr;

use anchor_lang::AccountDeserialize;
use anchor_lang::Space;
use grave_scanner::state::{
    EligibilityAnchor, EligibilityCert, LaunchPrice, ProtocolConfig as ScannerProtocolConfig,
};
use grave_snapshotter::source::InMemorySource;
use grave_snapshotter::{
    InMemoryLocks, SnapshotArtifact, SnapshotBuilder, SnapshotMerkleTree, SnapshotRequest,
    TokenAccountSnapshot,
};
use grave_vault::constants::{
    JUPITER_V6_PROGRAM_ID, RAYDIUM_V4_AMM_AUTHORITY, RAYDIUM_V4_PROGRAM_ID, VAULT_AUTHORITY_SEED,
    WSOL_MINT,
};
use solana_program_test::{BanksClient, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    bpf_loader,
    hash::hash,
    instruction::{AccountMeta, Instruction},
    native_token::LAMPORTS_PER_SOL,
    pubkey::Pubkey,
    rent::Rent,
    signature::Keypair,
    signer::Signer,
    system_program,
    sysvar::clock as clock_sysvar,
    sysvar::slot_hashes as slot_hashes_sysvar,
    transaction::Transaction,
};

fn vault_id() -> Pubkey {
    grave_vault::ID
}
fn scanner_id() -> Pubkey {
    grave_scanner::ID
}
fn spl_token_id() -> Pubkey {
    anchor_spl::token::ID
}
fn spl_ata_id() -> Pubkey {
    anchor_spl::associated_token::ID
}
/// Ed25519 signature-verification native program (precompile).
fn ed25519_id() -> Pubkey {
    Pubkey::from_str("Ed25519SigVerify111111111111111111111111111").unwrap()
}
/// UNCX Raydium AMM V4 locker — the marker PDA for this pool is supplied
/// (non-existent = proven unlocked) to satisfy the C5 marker gate.
fn uncx_locker_id() -> Pubkey {
    Pubkey::from_str("GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo").unwrap()
}

/// Anchored wall-clock reference: the VM's genesis clock is "now", so any
/// attestation timestamp of `now - 3600` is comfortably in the past while
/// staying positive.
const INACTIVITY_MARGIN_SECONDS: i64 = 3_600;

// AmmInfo offset of `lp_amount` (the pool's tracked LP balance).
const AMM_LP_AMOUNT_OFF: usize = 720;
// AmmInfo offsets of the pool's own pointers (scanner adapter parity).
const AMM_COIN_VAULT_OFF: usize = 336;
const AMM_PC_VAULT_OFF: usize = 368;
const AMM_COIN_MINT_OFF: usize = 400;
const AMM_PC_MINT_OFF: usize = 432;
const AMM_LP_MINT_OFF: usize = 464;
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

fn read_pubkey(data: &[u8], off: usize) -> Pubkey {
    Pubkey::new_from_array(data[off..off + 32].try_into().unwrap())
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
// Pool environment (identical to the Phase 4/5 suites, pool 1 focus)
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
    anchor_pda: Pubkey,
    launch_price_pda: Pubkey,
    uncx_marker: Pubkey,
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
        let (cert_pda, _) = Pubkey::find_program_address(
            &[
                b"eligibility_cert",
                RAYDIUM_V4_PROGRAM_ID.as_ref(),
                pool.as_ref(),
            ],
            &scanner_id(),
        );
        let (anchor_pda, _) = Pubkey::find_program_address(
            &[
                b"eligibility_anchor",
                RAYDIUM_V4_PROGRAM_ID.as_ref(),
                pool.as_ref(),
            ],
            &scanner_id(),
        );
        let (launch_price_pda, _) = Pubkey::find_program_address(
            &[
                b"launch_price",
                RAYDIUM_V4_PROGRAM_ID.as_ref(),
                pool.as_ref(),
            ],
            &scanner_id(),
        );
        let (uncx_marker, _) =
            Pubkey::find_program_address(&[b"global_lp_tracker", pool.as_ref()], &uncx_locker_id());

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
            anchor_pda,
            launch_price_pda,
            uncx_marker,
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

    /// The scanner-side remaining accounts: the adapter's pool pointers
    /// (looked up by pubkey, any order) plus the UNCX marker gate account
    /// (non-existent here = proven unlocked).
    fn scanner_remaining(&self) -> Vec<Pubkey> {
        vec![
            self.coin_vault,
            self.pc_vault,
            self.lp_mint,
            self.uncx_marker,
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
/// is claimant #0 (D11 policy 2: the pre-burn balance is an ordinary leaf).
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
    /// `u64::MAX` = conversion leg always skipped (measurement shape);
    /// `0` = protocol default floor — swap leg always active.
    dust: u64,
}

/// Bootstraps the VM with pool 1's real state, the vault AND scanner
/// programs, the real AMM / market / token ELFs and the Jupiter stand-in.
/// There is NO forged cert anywhere — the EligibilityCert is issued by the
/// real scanner later in the pipeline. Returns None (SKIP) when required
/// fixtures are absent.
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
    if !add_elf(&mut pt, "grave_scanner.so", scanner_id(), true) {
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

    // The salvor's pre-salvage LP balance — the LP the salvage will deposit
    // (the snapshotter later treats the pre-burn balance as an ordinary
    // leaf, D11 policy 2). Seeded, not forged: this is an SPL token account,
    // not a program-owned evidence account.
    pt.add_account(
        env1.salvor_lp_ata,
        forged_token_account(&env1.lp_mint, &salvor.pubkey(), env1.lp_burn_plan),
    );

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

/// Starts the VM and runs the vault `initialize` (protocol defaults:
/// 40/40/20, dust as configured — 0 → conversion leg active). The
/// `ProgramTestContext` handle is kept: warping is the multi-epoch
/// waiting period's only lever.
async fn start(mut boot: Boot) -> (ProgramTestContext, Boot) {
    let mut ctx = boot.pt.take().unwrap().start_with_context().await;
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
    send(&mut ctx.banks_client, &boot.salvor, &[init])
        .await
        .expect("vault initialize failed");
    (ctx, boot)
}

// =====================================================================
// Clock / SlotHashes readers (raw sysvar bytes — the exact layouts the
// scanner's attestation module consumes)
// =====================================================================

/// (slot, epoch, unix_timestamp) from the live Clock sysvar.
async fn read_clock(client: &mut BanksClient) -> (u64, u64, i64) {
    let a = acct(client, &clock_sysvar::id()).await;
    let slot = read_u64(&a.data, 0);
    let epoch = read_u64(&a.data, 16);
    let ts = i64::from_le_bytes(a.data[32..40].try_into().unwrap());
    (slot, epoch, ts)
}

/// The freshest (slot, hash) entry the VM's SlotHashes sysvar can resolve.
/// Entries are scanned (newest-first in practice) and the max slot is
/// returned; fails the test when no positive-slot entry exists (slot 0 is
/// unusable — the scanner requires `issued_slot > 0`).
async fn newest_slot_hash(client: &mut BanksClient, now_slot: u64) -> (u64, [u8; 32]) {
    let a = acct(client, &slot_hashes_sysvar::id()).await;
    let count = read_u64(&a.data, 0) as usize;
    let mut best: Option<(u64, [u8; 32])> = None;
    for i in 0..count {
        let base = 8 + i * 40;
        let slot = read_u64(&a.data, base);
        if slot == 0 || slot > now_slot {
            continue;
        }
        let mut h = [0u8; 32];
        h.copy_from_slice(&a.data[base + 8..base + 40]);
        if best.is_none_or(|(s, _)| slot > s) {
            best = Some((slot, h));
        }
    }
    best.unwrap_or_else(|| panic!("no usable slot-hash entry at slot {now_slot}"))
}

// =====================================================================
// Attestation machinery (runtime precompile wire format)
// =====================================================================

/// Anchor global instruction discriminator = sha256("global:<name>")[..8].
fn anchor_disc(name: &str) -> [u8; 8] {
    let h = hash(format!("global:{name}").as_bytes()).to_bytes();
    [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]]
}

/// The `ed25519_program` verify instruction in the RUNTIME wire format
/// (byte-identical to `solana_ed25519_program`'s own builder, mirrored by
/// `grave-scanner/src/attestation.rs`): 1-byte signature count + padding,
/// the 7-field offsets struct at byte 2, then pk (32B) and sig (64B).
fn ed25519_verify_ix(
    sig: &[u8; 64],
    pk: &[u8; 32],
    msg_offset: u16,
    msg_size: u16,
    msg_ix_index: u16,
) -> Instruction {
    const PK_OFF: usize = 16;
    const SIG_OFF: usize = 48;
    let mut d = Vec::with_capacity(112);
    d.push(1u8); // num signatures
    d.push(0u8); // ignored padding
    d.extend_from_slice(&(SIG_OFF as u16).to_le_bytes());
    d.extend_from_slice(&0xFFFFu16.to_le_bytes()); // sig ix = current
    d.extend_from_slice(&(PK_OFF as u16).to_le_bytes());
    d.extend_from_slice(&0xFFFFu16.to_le_bytes()); // pk ix = current
    d.extend_from_slice(&msg_offset.to_le_bytes());
    d.extend_from_slice(&msg_size.to_le_bytes());
    d.extend_from_slice(&msg_ix_index.to_le_bytes());
    d.extend_from_slice(pk);
    d.extend_from_slice(sig);
    Instruction::new_with_bytes(ed25519_id(), &d, vec![])
}

/// The 112-byte C1 last-swap attestation message:
/// `amm ‖ pool ‖ last_swap_unix_ts ‖ issued_slot ‖ slot_hash`.
fn c1_msg(amm: &Pubkey, pool: &Pubkey, ts: i64, slot: u64, h: &[u8; 32]) -> [u8; 112] {
    let mut m = [0u8; 112];
    m[0..32].copy_from_slice(amm.as_ref());
    m[32..64].copy_from_slice(pool.as_ref());
    m[64..72].copy_from_slice(&ts.to_le_bytes());
    m[72..80].copy_from_slice(&slot.to_le_bytes());
    m[80..112].copy_from_slice(h);
    m
}

/// Sign `msg` with the oracle key and build the precompile instruction
/// that verifies it against the attestation bytes embedded at
/// `msg_offset` (u16) in the scanner instruction at `msg_ix_index`.
fn attestation_ix(oracle: &Keypair, msg: &[u8], msg_offset: u16, msg_ix_index: u16) -> Instruction {
    let sig: [u8; 64] = oracle
        .sign_message(msg)
        .as_ref()
        .try_into()
        .expect("64-byte signature");
    ed25519_verify_ix(
        &sig,
        &oracle.pubkey().to_bytes(),
        msg_offset,
        msg.len() as u16,
        msg_ix_index,
    )
}

/// `evaluate_pool_phase_1` / `_2`: disc + amm + pool + msg(112).
fn evaluate_pool_ix(env: &PoolEnv, msg: &[u8; 112], phase2: bool, writer: &Pubkey) -> Instruction {
    let name = if phase2 {
        "evaluate_pool_phase_2"
    } else {
        "evaluate_pool_phase_1"
    };
    let mut data = anchor_disc(name).to_vec();
    data.extend_from_slice(RAYDIUM_V4_PROGRAM_ID.as_ref());
    data.extend_from_slice(env.pool.as_ref());
    data.extend_from_slice(msg);

    let mut metas = vec![AccountMeta::new_readonly(scanner_config_pda(), false)];
    if phase2 {
        // protocol_config, eligibility_anchor (ro), eligibility_cert (init_if_needed)
        metas.push(AccountMeta::new_readonly(env.anchor_pda, false));
        metas.push(AccountMeta::new(env.cert_pda, false));
    } else {
        // protocol_config, eligibility_anchor (init, writable)
        metas.push(AccountMeta::new(env.anchor_pda, false));
    }
    metas.extend([
        AccountMeta::new_readonly(env.launch_price_pda, false),
        AccountMeta::new_readonly(env.pool, false),
        AccountMeta::new_readonly(
            anchor_lang::solana_program::sysvar::instructions::id(),
            false,
        ),
        AccountMeta::new_readonly(slot_hashes_sysvar::id(), false),
        AccountMeta::new(*writer, true),
        AccountMeta::new_readonly(system_program::ID, false),
    ]);
    for k in env.scanner_remaining() {
        metas.push(AccountMeta::new_readonly(k, false));
    }
    Instruction::new_with_bytes(scanner_id(), &data, metas)
}

fn scanner_config_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"protocol_config"], &scanner_id()).0
}

/// GraveScanner `initialize`: explicit governance thresholds sized for the
/// fork pool (see module header), oracles = the test authority key.
fn scanner_init_ix(authority: &Pubkey, payer: &Pubkey) -> Instruction {
    let mut data = anchor_disc("initialize").to_vec();
    data.extend_from_slice(authority.as_ref());
    data.extend_from_slice(&1u64.to_le_bytes()); // inactivity_seconds
    data.extend_from_slice(&5_000u16.to_le_bytes()); // price_collapse_bps
    data.extend_from_slice(&1u64.to_le_bytes()); // min_tvl_lamports
    data.extend_from_slice(&0u64.to_le_bytes()); // anchor staleness (default)
    data.extend_from_slice(&1_000u64.to_le_bytes()); // lp burn dust threshold
    data.extend_from_slice(&0i64.to_le_bytes()); // cert ttl (default 3600)
    Instruction::new_with_bytes(
        scanner_id(),
        &data,
        vec![
            AccountMeta::new(scanner_config_pda(), false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    )
}

/// `record_launch_price`: disc + amm + pool + base + quote + price(16) +
/// msg(168) — the attestation is the LAST params field (offset 152).
fn record_launch_price_ix(
    env: &PoolEnv,
    base_mint: &Pubkey,
    quote_mint: &Pubkey,
    price: u128,
    msg: &[u8; 168],
    payer: &Pubkey,
) -> Instruction {
    let mut data = anchor_disc("record_launch_price").to_vec();
    data.extend_from_slice(RAYDIUM_V4_PROGRAM_ID.as_ref());
    data.extend_from_slice(env.pool.as_ref());
    data.extend_from_slice(base_mint.as_ref());
    data.extend_from_slice(quote_mint.as_ref());
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(msg);

    let metas = vec![
        AccountMeta::new(env.launch_price_pda, false),
        AccountMeta::new_readonly(scanner_config_pda(), false),
        AccountMeta::new_readonly(
            anchor_lang::solana_program::sysvar::instructions::id(),
            false,
        ),
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
    Instruction::new_with_bytes(scanner_id(), &data, metas)
}

/// The 168-byte C2 launch-price attestation message:
/// `amm ‖ pool ‖ base_mint ‖ quote_mint ‖ first_swap_slot ‖
/// first_swap_unix_ts ‖ launch_price_q64x64 ‖ issued_slot`.
#[allow(clippy::too_many_arguments)] // canonical 8-field wire format
fn c2_msg(
    amm: &Pubkey,
    pool: &Pubkey,
    base: &Pubkey,
    quote: &Pubkey,
    first_swap_slot: u64,
    first_swap_ts: i64,
    price: u128,
    issued_slot: u64,
) -> [u8; 168] {
    let mut m = [0u8; 168];
    m[0..32].copy_from_slice(amm.as_ref());
    m[32..64].copy_from_slice(pool.as_ref());
    m[64..96].copy_from_slice(base.as_ref());
    m[96..128].copy_from_slice(quote.as_ref());
    m[128..136].copy_from_slice(&first_swap_slot.to_le_bytes());
    m[136..144].copy_from_slice(&first_swap_ts.to_le_bytes());
    m[144..160].copy_from_slice(&price.to_le_bytes());
    m[160..168].copy_from_slice(&issued_slot.to_le_bytes());
    m
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

/// Lamports of an account that may legitimately not exist yet (PDAs the
/// vault creates at salvage time).
async fn lamports_or_zero(client: &mut BanksClient, k: &Pubkey) -> u64 {
    client
        .get_account(*k)
        .await
        .unwrap()
        .map_or(0, |a| a.lamports)
}

async fn send(
    client: &mut BanksClient,
    payer: &Keypair,
    ixs: &[Instruction],
) -> Result<(), solana_program_test::BanksClientError> {
    let blockhash = client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &[payer], blockhash);
    client.process_transaction(tx).await
}

// =====================================================================
// Vault instruction builders (identical to the Phase 4/5 suites)
// =====================================================================

/// A Jupiter route: opaque data + ordered (pubkey, writable) accounts,
/// forwarded verbatim by the vault to the Jupiter stand-in.
struct Route {
    data: Vec<u8>,
    accounts: Vec<(Pubkey, bool)>,
}

/// Single-hop route against the stub's documented account contract
/// (identical to the Phase 3/4/5 suites' builder).
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
    /// Off-chain snapshot root — a REAL root in this suite.
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

/// The pool's memecoin-side reserve (the side that is NOT WSOL).
fn memecoin_reserve(env: &PoolEnv) -> u64 {
    if env.base_is_coin_side {
        env.pc_reserve
    } else {
        env.coin_reserve
    }
}

/// Exact dry-run of the withdraw leg (conversion disabled): boots a fresh
/// VM through the FULL honest scanner pipeline, salvages, and reads the
/// post-withdraw pool reserves. The VM is deterministic, so the real
/// salvage's withdraw produces byte-identical deltas.
/// Returns (memecoin_received, wsol_reserve_after, memecoin_reserve_after).
async fn dry_run_withdraw() -> (u64, u64, u64) {
    let Some(boot) = build_genesis(u64::MAX, vec![], Keypair::new()) else {
        return (0, 0, 0);
    };
    let (mut ctx, boot) = start(boot).await;
    let env = &boot.env1;
    let oracle = Keypair::new();
    run_scanner_pipeline(&mut ctx, env, &boot.salvor, &oracle).await;

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
    send(
        &mut ctx.banks_client,
        &boot.salvor,
        &[salvage_ix(env, &opts)],
    )
    .await
    .unwrap_or_else(|e| panic!("dry-run salvage failed: {e:?}"));

    let coin_after = token_amount(&acct(&mut ctx.banks_client, &env.coin_vault).await);
    let pc_after = token_amount(&acct(&mut ctx.banks_client, &env.pc_vault).await);
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
// The real scanner pipeline (no stand-ins)
// =====================================================================

/// Runs GraveScanner end to end against the real pool, asserting every
/// state transition:
///
///   initialize -> record_launch_price -> evaluate_pool_phase_1
///   -> [multi-epoch warp] -> evaluate_pool_phase_2 -> EligibilityCert
///
/// Both attestation legs go through the runtime's real ed25519 precompile
/// verification (the precompile executes BEFORE the scanner handler in the
/// same transaction — a bad signature aborts the whole transaction).
async fn run_scanner_pipeline(
    ctx: &mut ProgramTestContext,
    env: &PoolEnv,
    salvor: &Keypair,
    oracle: &Keypair,
) {
    let anchor_epoch;

    // ---- make SlotHashes usable: boot has only slot 0, and the scanner
    // requires issued_slot > 0. One nudge gives us a positive entry. ----
    let slot = {
        let client = &mut ctx.banks_client;
        let (slot, _epoch, _ts) = read_clock(client).await;
        slot
    };
    ctx.warp_to_slot(slot + 1).expect("warp to usable slot");

    {
        let client = &mut ctx.banks_client;
        // ---- 1. scanner initialize: oracles = the test authority key ----
        send(
            client,
            salvor,
            &[scanner_init_ix(&oracle.pubkey(), &salvor.pubkey())],
        )
        .await
        .unwrap_or_else(|e| panic!("scanner initialize failed: {e:?}"));
        let cfg = ScannerProtocolConfig::try_deserialize(
            &mut &acct(client, &scanner_config_pda()).await.data[..],
        )
        .expect("scanner ProtocolConfig must deserialize");
        assert_eq!(cfg.authority, oracle.pubkey());
        assert_eq!(cfg.activity_oracle, oracle.pubkey());
        assert_eq!(cfg.launch_price_oracle, oracle.pubkey());
        assert_eq!(cfg.inactivity_seconds, 1);
        assert_eq!(cfg.price_collapse_bps, 5_000);
        assert_eq!(cfg.min_tvl_lamports, 1);
        assert_eq!(cfg.cert_ttl_seconds, 3_600);
        assert!(!cfg.paused);

        // ---- 2. pool facts from the REAL pool bytes (scanner parity) ----
        let pool_acct = acct(client, &env.pool).await;
        assert_eq!(pool_acct.data.len(), 752, "canonical AmmInfo size");
        let coin_vault = read_pubkey(&pool_acct.data, AMM_COIN_VAULT_OFF);
        let pc_vault = read_pubkey(&pool_acct.data, AMM_PC_VAULT_OFF);
        let base_mint = read_pubkey(&pool_acct.data, AMM_COIN_MINT_OFF);
        let quote_mint = read_pubkey(&pool_acct.data, AMM_PC_MINT_OFF);
        assert_eq!(coin_vault, env.coin_vault);
        assert_eq!(pc_vault, env.pc_vault);
        assert_eq!(read_pubkey(&pool_acct.data, AMM_LP_MINT_OFF), env.lp_mint);
        let base_reserve = token_amount(&acct(client, &coin_vault).await);
        let quote_reserve = token_amount(&acct(client, &pc_vault).await);
        assert_eq!(base_reserve, env.coin_reserve);
        assert_eq!(quote_reserve, env.pc_reserve);
        let current_price: u128 = ((quote_reserve as u128) << 64) / (base_reserve as u128);
        assert!(current_price > 0);

        // ---- 3. record_launch_price (C2): oracle-signed 168B attestation ----
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, _hash) = newest_slot_hash(client, slot).await;
        let launch_price = current_price * 200; // a 99.5% collapse vs the baseline
        let c2 = c2_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &env.pool,
            &base_mint,
            &quote_mint,
            hash_slot,                          // first_swap_slot (resolvable)
            ts - 2 * INACTIVITY_MARGIN_SECONDS, // first_swap_unix_ts
            launch_price,
            hash_slot, // issued_slot
        );
        send(
            client,
            salvor,
            &[
                attestation_ix(oracle, &c2, 152, 1),
                record_launch_price_ix(
                    env,
                    &base_mint,
                    &quote_mint,
                    launch_price,
                    &c2,
                    &salvor.pubkey(),
                ),
            ],
        )
        .await
        .unwrap_or_else(|e| panic!("record_launch_price failed: {e:?}"));
        let lp =
            LaunchPrice::try_deserialize(&mut &acct(client, &env.launch_price_pda).await.data[..])
                .expect("LaunchPrice must deserialize");
        assert_eq!(lp.amm_program_id, RAYDIUM_V4_PROGRAM_ID);
        assert_eq!(lp.pool_address, env.pool);
        assert_eq!(lp.base_mint, base_mint);
        assert_eq!(lp.quote_mint, quote_mint);
        assert_eq!(lp.launch_price_q64x64, launch_price);

        // ---- 4. evaluate_pool_phase_1: C1 attestation + six criteria ----
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let c1 = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        send(
            client,
            salvor,
            &[
                attestation_ix(oracle, &c1, 72, 1),
                evaluate_pool_ix(env, &c1, false, &salvor.pubkey()),
            ],
        )
        .await
        .unwrap_or_else(|e| panic!("evaluate_pool_phase_1 failed: {e:?}"));
        let anchor =
            EligibilityAnchor::try_deserialize(&mut &acct(client, &env.anchor_pda).await.data[..])
                .expect("EligibilityAnchor must deserialize");
        let (_slot, epoch, _ts) = read_clock(client).await;
        assert_eq!(anchor.amm_program_id, RAYDIUM_V4_PROGRAM_ID);
        assert_eq!(anchor.pool_address, env.pool);
        assert_eq!(anchor.writer, salvor.pubkey());
        assert_eq!(anchor.first_eligible_epoch, epoch);
        assert_eq!(anchor.criteria_bitmap, 0x3F, "all six criteria pass");
        assert!(!anchor.invalidated);
        anchor_epoch = epoch;
    }

    // ---- 5. the multi-epoch waiting period (Criterion 6) ----
    ctx.warp_to_epoch(anchor_epoch + 3)
        .expect("warp past the confirmation window");

    // ---- 6. evaluate_pool_phase_2: FRESH C1 attestation + cert ----
    {
        let client = &mut ctx.banks_client;
        let (slot, epoch, ts) = read_clock(client).await;
        assert!(
            epoch.saturating_sub(anchor_epoch) >= 2,
            "the warp must cross MIN_EPOCH_CONFIRMATION epochs"
        );
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let c1_fresh = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        send(
            client,
            salvor,
            &[
                attestation_ix(oracle, &c1_fresh, 72, 1),
                evaluate_pool_ix(env, &c1_fresh, true, &salvor.pubkey()),
            ],
        )
        .await
        .unwrap_or_else(|e| panic!("evaluate_pool_phase_2 failed: {e:?}"));
        let cert =
            EligibilityCert::try_deserialize(&mut &acct(client, &env.cert_pda).await.data[..])
                .expect("EligibilityCert must deserialize");
        assert_eq!(cert.amm_program_id, RAYDIUM_V4_PROGRAM_ID);
        assert_eq!(cert.pool_address, env.pool);
        assert_eq!(cert.writer, salvor.pubkey());
        assert_eq!(cert.anchor_epoch, anchor_epoch);
        assert!(cert.cert_epoch.saturating_sub(cert.anchor_epoch) >= 2);
        assert_eq!(cert.criteria_bitmap, 0x3F);
        assert_eq!(cert.reissue_generation, 1);
        assert_eq!(cert.expires_at, cert.issued_at + 3_600);
        assert!(
            !cert.is_expired(cert.issued_at),
            "a fresh cert must be live for salvage"
        );
    }
}

// =====================================================================
// LP-holder snapshot (the real snapshotter over the live VM ledger)
// =====================================================================

/// Read the LP-token ledger from the live VM into an `InMemorySource` (the
/// Phase 5.3 pattern: one consistent view; the Σ == supply completeness
/// gate runs for real).
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

// =====================================================================
// Phase 6 — ONE test: the complete GraveYield lifecycle
// =====================================================================

#[tokio::test]
async fn candidate_pool_to_lp_claim_end_to_end() {
    let Some(manifest) = load_manifest() else {
        return;
    };
    let (lp_mint_pubkey, lp_mint_acct) = load_real_account(&manifest["accounts"], "lp_mint");
    let supply = mint_supply(&lp_mint_acct);
    let burn = (supply / 10_000).max(1);
    let custody_balance = supply / 4;
    let claimable_total = supply - custody_balance - burn;
    let wallets = claim_wallets(claimable_total);
    let custody_account = Pubkey::new_unique();

    // ---- withdraw-leg economics (disposable VM, honest boot, no swap) ----
    let (p_mem, wsol_after, mem_after) = dry_run_withdraw().await;
    let floor = harness_floor(implied_wsol(p_mem, wsol_after, mem_after));

    // ---- genesis: real pool state + the seeded claim side ----
    let extra = claim_side_genesis(&lp_mint_pubkey, custody_account, custody_balance, &wallets);
    let salvor = Keypair::new();
    let oracle = Keypair::new();
    let Some(boot) = build_genesis(0, extra, salvor) else {
        return;
    };
    let env0 = boot.env1.clone();
    let (mut ctx, boot) = start(boot).await;
    let env = env0;
    let salvor = boot.salvor;

    // ================================================================
    // Candidate pool -> GraveScanner -> EligibilityAnchor -> cert
    // ================================================================
    run_scanner_pipeline(&mut ctx, &env, &salvor, &oracle).await;
    let client = &mut ctx.banks_client;

    // ================================================================
    // Snapshot: the real snapshotter over the live VM ledger
    // ================================================================
    let mut addresses = vec![custody_account, env.salvor_lp_ata];
    addresses.extend(
        wallets
            .iter()
            .map(|c| wallet_ata(&c.wallet.pubkey(), &env.lp_mint)),
    );
    let source = read_ledger_source(client, &env.lp_mint, &addresses).await;
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
    assert_eq!(
        snapshot.reconciliation.entries_total,
        claimable_total + burn
    );
    assert_eq!(snapshot.entries.len(), wallets.len() + 1);
    assert_eq!(snapshot.locked.total_locked, 0);
    assert!(snapshot.locked.custody.is_none());
    assert!(snapshot.entries.windows(2).all(|w| w[0].owner < w[1].owner));
    for (wallet, balance, _) in claimant_list(&salvor, burn, &wallets) {
        let entry = snapshot
            .entries
            .iter()
            .find(|e| e.owner == wallet.pubkey())
            .unwrap_or_else(|| panic!("snapshot must carry claimant {}", wallet.pubkey()));
        assert_eq!(entry.lp_balance, balance);
    }

    // ---- tree + artifact + publication (the JSON boundary) ----
    let tree = SnapshotMerkleTree::from_snapshot(&snapshot).unwrap();
    let artifact = SnapshotArtifact::seal(&snapshot, &tree).unwrap();
    artifact
        .verify_integrity()
        .expect("the sealed artifact must verify");
    let json = serde_json::to_string(&artifact).unwrap();
    assert_eq!(
        serde_json::to_string(&SnapshotArtifact::seal(&snapshot, &tree).unwrap()).unwrap(),
        json,
        "the same snapshot always seals to byte-identical JSON"
    );
    let published: SnapshotArtifact = serde_json::from_str(&json).unwrap();
    assert_eq!(published, artifact);
    published
        .verify_integrity()
        .expect("the published artifact must verify");
    assert_eq!(published.leaf_count, wallets.len() + 1);
    assert_eq!(published.tree_depth, 3, "5 leaves: 5 -> 3 -> 2 -> 1");
    assert_eq!(published.lp_total_supply_at_snapshot, env.lp_supply);

    // ================================================================
    // GraveVault: salvage (withdraw CPI + conversion + 40/40/20),
    // sealing the artifact root + supply on chain
    // ================================================================
    let rent0 = Rent::default().minimum_balance(0);
    let lp_mint_before = mint_supply(&acct(client, &env.lp_mint).await);
    let amm_lp_before = read_u64(&acct(client, &env.pool).await.data, AMM_LP_AMOUNT_OFF);
    let treasury_before = lamports_or_zero(client, &env.protocol_treasury).await;

    let route = jupiter_route(&env, p_mem, 0, 0, None, vec![]);
    let opts = SalvageOpts {
        lp_amount: env.lp_burn_plan,
        pool_account: env.pool,
        memecoin_mint: env.memecoin_mint,
        memecoin_ata: env.vault_memecoin_ata,
        lp_mint: env.lp_mint,
        salvor_lp_ata: env.salvor_lp_ata,
        min_quote_output_lamports: floor,
        route: Some(route),
        merkle_root: published.merkle_root,
    };
    send(client, &salvor, &[salvage_ix(&env, &opts)])
        .await
        .unwrap_or_else(|e| panic!("full-pipeline salvage failed: {e:?}"));

    // pool-side state transitions. The withdraw deltas are byte-identical
    // to the measurement rig (deterministic VM); the conversion leg then
    // additionally moves `p_mem` memecoin through the pool itself (the
    // single-hop stub route), so raw reserves are NOT compared to the
    // dry-run — the LP side is.
    let lp_mint_after = mint_supply(&acct(client, &env.lp_mint).await);
    assert_eq!(
        lp_mint_before - lp_mint_after,
        env.lp_burn_plan,
        "the withdraw CPI burns the deposited LP"
    );
    assert_eq!(
        amm_lp_before - read_u64(&acct(client, &env.pool).await.data, AMM_LP_AMOUNT_OFF),
        env.lp_burn_plan,
        "the pool's tracked LP balance drops by the same amount"
    );
    assert_eq!(
        token_amount(&acct(client, &env.salvor_lp_ata).await),
        0,
        "the salvor's LP is spent"
    );

    // receipt: 40/40/20 conservation (D7)
    let receipt = grave_vault::state::SalvageReceipt::try_deserialize(
        &mut &acct(client, &env.salvage_receipt).await.data[..],
    )
    .expect("SalvageReceipt must deserialize");
    assert_eq!(receipt.pool_address, env.pool);
    assert_eq!(receipt.salvor, salvor.pubkey());
    assert_eq!(
        receipt.total_proceeds_lamports,
        receipt.lp_holder_amount_lamports
            + receipt.salvor_amount_lamports
            + receipt.protocol_amount_lamports,
        "no SOL disappears and none is created (D7)"
    );
    assert!(receipt.total_proceeds_lamports > 0);
    assert_eq!(receipt.memecoin_mint, env.memecoin_mint);

    // registry: the artifact root + supply are sealed; the bucket funded
    let registry = grave_vault::state::PoolRegistry::try_deserialize(
        &mut &acct(client, &env.pool_registry).await.data[..],
    )
    .expect("registry must deserialize");
    assert_eq!(registry.amm_program_id, RAYDIUM_V4_PROGRAM_ID);
    assert_eq!(registry.pool_address, env.pool);
    assert_eq!(registry.salvor, salvor.pubkey());
    assert_eq!(
        registry.lp_snapshot_merkle_root, published.merkle_root,
        "the artifact's root must be sealed"
    );
    assert_eq!(
        registry.lp_total_supply_at_snapshot, env.lp_supply,
        "the salvage pins the submitted supply against the live mint"
    );
    let bucket = registry.lp_holder_pool_total_lamports;
    assert_eq!(bucket, receipt.lp_holder_amount_lamports);
    assert_eq!(registry.lp_holder_pool_claimed_lamports, 0);
    assert_eq!(
        acct(client, &env.lp_holder_pool_vault).await.lamports,
        rent0 + bucket,
        "the LP bucket is funded with the LP share"
    );
    assert_eq!(
        acct(client, &env.protocol_treasury).await.lamports,
        treasury_before + receipt.protocol_amount_lamports
    );
    eprintln!(
        "lifecycle: recovered {} lamports (lp {} / salvor {} / protocol {})",
        receipt.total_proceeds_lamports,
        receipt.lp_holder_amount_lamports,
        receipt.salvor_amount_lamports,
        receipt.protocol_amount_lamports
    );

    // ================================================================
    // LP claim: wallet -> proof -> claim -> SOL (the exit condition)
    // ================================================================
    let mut cumulative = 0u64;
    for (i, (wallet, balance, _start)) in claimant_list(&salvor, burn, &wallets)
        .into_iter()
        .enumerate()
    {
        let entry = published
            .proof_for(&wallet.pubkey())
            .unwrap_or_else(|| panic!("the artifact must carry claimant {i}"));
        assert_eq!(entry.lp_balance, balance);
        let expected = pro_rata(bucket, balance, supply);

        let before = acct(client, &wallet.pubkey()).await.lamports;
        send(
            client,
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
        assert_eq!(
            acct(client, &wallet.pubkey()).await.lamports,
            before - FEE - claim_record_rent() + expected,
            "claim {i} must pay exactly floor(bucket × balance / supply)"
        );
        let registry = grave_vault::state::PoolRegistry::try_deserialize(
            &mut &acct(client, &env.pool_registry).await.data[..],
        )
        .unwrap();
        assert_eq!(registry.lp_holder_pool_claimed_lamports, cumulative);
        assert!(cumulative <= bucket, "overclaim at claimant {i}");
        assert_eq!(
            acct(client, &env.lp_holder_pool_vault).await.lamports,
            rent0 + bucket - cumulative
        );
    }

    // ================================================================
    // The closing identity chain (cumulative accounting)
    // ================================================================
    let registry = grave_vault::state::PoolRegistry::try_deserialize(
        &mut &acct(client, &env.pool_registry).await.data[..],
    )
    .unwrap();
    let claimed = registry.lp_holder_pool_claimed_lamports;

    let mut sum_records = 0u64;
    for &(wallet, balance, _) in claimant_list(&salvor, burn, &wallets).iter() {
        let record = grave_vault::state::ClaimRecord::try_deserialize(
            &mut &acct(client, &claim_record_pda(&env, &wallet.pubkey()))
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

    let sum_from_artifact: u64 = published
        .entries
        .iter()
        .map(|e| pro_rata(bucket, e.lp_balance, supply))
        .sum();
    assert_eq!(sum_from_artifact, claimed);

    let remainder = bucket - claimed;
    assert_eq!(
        acct(client, &env.lp_holder_pool_vault).await.lamports,
        rent0 + remainder
    );
    let custody_share = pro_rata(bucket, custody_balance, supply);
    let rounding = remainder - custody_share;
    assert!(rounding <= wallets.len() as u64 + 1);
    eprintln!(
        "lifecycle complete: bucket {bucket} / claimed {claimed} / custody share {custody_share} / rounding dust {rounding}"
    );
}
