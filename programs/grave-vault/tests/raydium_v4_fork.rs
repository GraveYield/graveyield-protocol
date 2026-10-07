// SPDX-License-Identifier: Apache-2.0
//
// Phase 2.1 fork harness (roadmap Phase 2, checklist CPI-009).
//
// Executes the REAL GraveVault `salvage_pool` instruction against the REAL
// mainnet Raydium V4 / OpenBook / SPL-token bytecode inside an in-process
// Solana VM (`solana-program-test`), seeded with byte-for-byte mainnet state
// of the canonical Raydium SOL/USDC V4 pool (58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2):
//
//   AmmInfo, coin/pc vaults, LP mint, open orders, target orders, OpenBook
//   market + its vaults + bids/asks/event queue, and the four program ELFs.
//
// The harness forges exactly three things (documented shortcuts — the vault
// only ever reads them):
//   1. the EligibilityCert PDA (serialised with GraveScanner's own
//      `EligibilityCert::try_serialize`, so layout drift fails loudly),
//   2. the salvor's LP token account balance (real holders can't be asked),
//   3. the salvor's lamports.
//
// What this PROVES (the acceptance bar for CPI-009):
//   - the vault's 20-account withdraw ordering is accepted by the deployed
//     Raydium V4 bytecode (a real LP burn + real reserve transfers execute),
//   - `vault_authority` PDA-signs as `user_owner` for the burn,
//   - LP supply decreases by exactly the burned amount,
//   - balance deltas land in the right vault accounts and settle 40/40/20,
//   - scrambled / malicious account submissions are rejected — by the vault's
//     pre-flight where the vault is the defence, and by the real Raydium V4
//     program where V4 is.
//
// Fixtures are fetched once via `scripts/fetch_v4_fork_fixtures.mjs` (they
// are gitignored). Without them the tests SKIP with a message so CI stays
// green; with them they run for real. `grave_vault.so` must be copied into
// tests/fixtures after `cargo build-sbf` (see scripts/build_fork_harness.sh).

// solana-sdk 2.3 deprecates the monolithic `system_program` module in favour
// of `solana_system_interface`; the deprecated path still works and keeps the
// harness on the same re-exports anchor-lang's prelude uses.
#![allow(deprecated)]

use std::path::PathBuf;
use std::str::FromStr;

use anchor_lang::AccountSerialize;
use grave_scanner::state::EligibilityCert;
use grave_vault::constants::{
    RAYDIUM_V4_AMM_AUTHORITY, RAYDIUM_V4_PROGRAM_ID, VAULT_AUTHORITY_SEED, WSOL_MINT,
};
use serde_json::Value;
use solana_program_test::{BanksClient, BanksClientError, ProgramTest};
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction, InstructionError},
    native_token::LAMPORTS_PER_SOL,
    pubkey::Pubkey,
    rent::Rent,
    signature::Keypair,
    signer::Signer,
    system_program,
    transaction::{Transaction, TransactionError},
};

// GraveVault / GraveScanner placeholder program IDs (KEYS-003; same values as
// Anchor.toml). The vault ID also comes from `declare_id!`.
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

// Error codes asserted by the negative tests (grave-vault errors.rs).
const ERR_ELIGIBILITY_CERT_EXPIRED: u32 = 7002;
const ERR_PREFLIGHT_FAILED: u32 = 7013;

// Raw deployed-AMM error code: InsufficientFunds (Raydium AmmError index 40).
const AMM_ERR_INSUFFICIENT_FUNDS: u32 = 40;

// Anchored timestamps: genesis clock is "now", so certs expiring in 2100 are
// valid and certs expiring in 2001 are expired — regardless of test time.
const TS_VALID_UNTIL_2100: i64 = 4_102_444_800;
const TS_LONG_PAST: i64 = 1_000_000_000;

// AmmInfo offset of `lp_amount` (the pool's tracked LP balance).
const AMM_LP_AMOUNT_OFF: usize = 720;

// SPL token account amount offset (165-byte classic token account).
const TA_AMOUNT: usize = 64;
// SPL mint supply offset.
const MINT_SUPPLY: usize = 36;

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

fn b58encode_pubkey(bytes: &[u8]) -> String {
    const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits = vec![0u8];
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::new();
    if bytes.first() == Some(&0) {
        out.push('1');
    }
    while let Some(&0) = digits.last() {
        digits.pop();
    }
    for d in digits.iter().rev() {
        out.push(B58[*d as usize] as char);
    }
    out
}

fn pk(s: &str) -> Pubkey {
    Pubkey::from_str(s).unwrap()
}

/// Real mainnet account from the manifest: (pubkey, Account).
fn load_real_account(manifest: &Value, name: &str) -> (Pubkey, Account) {
    let entry = &manifest["accounts"][name];
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

// =====================================================================
// Harness
// =====================================================================

struct ForkHarness {
    pt: Option<ProgramTest>,
    // Real mainnet pubkeys.
    pool: Pubkey,
    amm_program: Pubkey,
    coin_vault: Pubkey,
    pc_vault: Pubkey,
    lp_mint: Pubkey,
    pc_mint: Pubkey,
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
    // Real mainnet numbers (read from fixture bytes).
    coin_reserve: u64,
    pc_reserve: u64,
    lp_supply: u64,
    amm_lp_amount: u64,
    lp_burn_plan: u64,
    // Derived / forged identities.
    salvor: Keypair,
    cert_pda: Pubkey,
    protocol_config: Pubkey,
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

impl ForkHarness {
    /// Builds the genesis. Returns None (after printing a SKIP reason) when
    /// fixtures are absent, so CI without fixtures stays green. `extra`
    /// accounts are injected into genesis (used by adversarial tests).
    fn try_new(cert_expires_at: i64, extra: Vec<(Pubkey, Account)>) -> Option<Self> {
        let manifest = load_manifest()?;
        let parsed = &manifest["parsed"];

        let amm_program = pk(manifest["amm_program"].as_str().unwrap());
        let market_program = pk(manifest["market_program"].as_str().unwrap());
        let pool = pk(manifest["pool_address"].as_str().unwrap());

        // ---- real accounts, byte-for-byte from mainnet
        let (pool_addr, pool_acct) = load_real_account(&manifest, "pool");
        let (coin_vault, coin_vault_acct) = load_real_account(&manifest, "coin_vault");
        let (pc_vault, pc_vault_acct) = load_real_account(&manifest, "pc_vault");
        let (lp_mint, lp_mint_acct) = load_real_account(&manifest, "lp_mint");
        let (coin_mint, coin_mint_acct) = load_real_account(&manifest, "coin_mint");
        let (pc_mint, pc_mint_acct) = load_real_account(&manifest, "pc_mint");
        let (wsol_mint, wsol_mint_acct) = load_real_account(&manifest, "wsol_mint");
        let (open_orders, open_orders_acct) = load_real_account(&manifest, "open_orders");
        let (target_orders, target_orders_acct) = load_real_account(&manifest, "target_orders");
        let (market, market_acct) = load_real_account(&manifest, "market");
        let (market_coin_vault, market_coin_vault_acct) =
            load_real_account(&manifest, "market_coin_vault");
        let (market_pc_vault, market_pc_vault_acct) =
            load_real_account(&manifest, "market_pc_vault");
        let (event_queue, event_queue_acct) = load_real_account(&manifest, "event_queue");
        let (bids, bids_acct) = load_real_account(&manifest, "bids");
        let (asks, asks_acct) = load_real_account(&manifest, "asks");
        let (vault_signer, vault_signer_acct) = load_real_account(&manifest, "vault_signer");

        assert_eq!(pool_addr, pool);
        // v1.0 frozen orientation (spec D5): the coin side must be WSOL.
        assert_eq!(coin_mint, WSOL_MINT);
        assert_eq!(coin_mint, pk(parsed["coinMint"].as_str().unwrap()));
        assert!(manifest["base_is_coin_side"].as_bool().unwrap());

        let coin_reserve = read_u64(&coin_vault_acct.data, TA_AMOUNT);
        let pc_reserve = read_u64(&pc_vault_acct.data, TA_AMOUNT);
        let lp_supply = read_u64(&lp_mint_acct.data, MINT_SUPPLY);
        let amm_lp_amount = read_u64(&pool_acct.data, AMM_LP_AMOUNT_OFF);
        assert!(lp_supply > 0);
        assert!(amm_lp_amount > 0);
        // Burn 0.01% of supply — both sides must yield non-zero amounts (the
        // real V4 rejects zero outputs) and stay below the pool's tracked LP.
        let lp_burn_plan = (lp_supply / 10_000).max(1);
        assert!(
            lp_burn_plan < amm_lp_amount,
            "planned burn must be < amm.lp_amount"
        );
        assert!(
            (coin_reserve as u128) * (lp_burn_plan as u128) / (lp_supply as u128) > 0
                && (pc_reserve as u128) * (lp_burn_plan as u128) / (lp_supply as u128) > 0,
            "planned burn rounds to zero on one side"
        );

        // ---- derived / forged identities
        let salvor = Keypair::new();
        let (cert_pda, cert_bump) = Pubkey::find_program_address(
            &[b"eligibility_cert", amm_program.as_ref(), pool.as_ref()],
            &scanner_id(),
        );
        let (protocol_config, _) = Pubkey::find_program_address(&[b"protocol_config"], &vault_id());
        let (vault_authority, _) =
            Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED], &vault_id());
        let (pool_registry, _) =
            Pubkey::find_program_address(&[b"pool_registry", pool.as_ref()], &vault_id());
        let (salvage_receipt, _) =
            Pubkey::find_program_address(&[b"salvage_receipt", pool.as_ref()], &vault_id());
        let (lp_holder_pool_vault, _) =
            Pubkey::find_program_address(&[b"lp_holder_pool", pool.as_ref()], &vault_id());
        let (protocol_treasury, _) =
            Pubkey::find_program_address(&[b"protocol_treasury"], &vault_id());
        let (vault_sol_holding, _) =
            Pubkey::find_program_address(&[b"vault_sol_holding", pool.as_ref()], &vault_id());
        // Classic ATA derivation: PDA ["wallet", "token_program", "mint"] under
        // the SPL associated-token-account program.
        let ata = |wallet: &Pubkey, mint: &Pubkey| {
            Pubkey::find_program_address(
                &[wallet.as_ref(), spl_token_id().as_ref(), mint.as_ref()],
                &spl_ata_id(),
            )
            .0
        };
        let vault_base_ata = ata(&vault_authority, &WSOL_MINT);
        let vault_memecoin_ata = ata(&vault_authority, &pc_mint);
        let salvor_lp_ata = ata(&salvor.pubkey(), &lp_mint);

        // ---- program-test genesis
        let mut pt = ProgramTest::default();
        pt.prefer_bpf(true);
        // The salvage tx runs a real V4 withdraw + 3 ATA creates + 4 token /
        // system transfers; the 200k default would truncate it. Production
        // salvor txs set the equivalent budget via a compute-budget ix.
        pt.set_compute_max_units(1_400_000);
        pt.set_transaction_account_lock_limit(64);

        // Programs: real mainnet ELFs, located by name in tests/fixtures/.
        pt.add_program("grave_vault", vault_id(), None);
        pt.add_program("raydium_v4", amm_program, None);
        pt.add_program("serum_dex", market_program, None);
        pt.add_program("spl_token", spl_token_id(), None);
        pt.add_program("spl_ata", spl_ata_id(), None);

        // Real mainnet state.
        pt.add_account(pool_addr, pool_acct);
        pt.add_account(coin_vault, coin_vault_acct);
        pt.add_account(pc_vault, pc_vault_acct);
        pt.add_account(lp_mint, lp_mint_acct);
        pt.add_account(coin_mint, coin_mint_acct);
        pt.add_account(pc_mint, pc_mint_acct);
        pt.add_account(wsol_mint, wsol_mint_acct);
        pt.add_account(open_orders, open_orders_acct);
        pt.add_account(target_orders, target_orders_acct);
        pt.add_account(market, market_acct);
        pt.add_account(market_coin_vault, market_coin_vault_acct);
        pt.add_account(market_pc_vault, market_pc_vault_acct);
        pt.add_account(event_queue, event_queue_acct);
        pt.add_account(bids, bids_acct);
        pt.add_account(asks, asks_acct);
        pt.add_account(vault_signer, vault_signer_acct);

        // Forged: salvor lamports (fees + rents).
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
        // Forged: salvor's LP holdings (real holders can't be asked to sign).
        pt.add_account(
            salvor_lp_ata,
            forged_token_account(&lp_mint, &salvor.pubkey(), lp_burn_plan),
        );
        // Forged: eligibility cert PDA — serialised with GraveScanner's own
        // type, so any cert layout drift breaks this harness loudly.
        let cert = EligibilityCert {
            amm_program_id: amm_program,
            pool_address: pool,
            writer: salvor.pubkey(),
            anchor_epoch: 0,
            cert_epoch: 0,
            issued_at: cert_expires_at - 3600,
            expires_at: cert_expires_at,
            criteria_bitmap: 0x3F,
            reissue_generation: 1,
            bump: cert_bump, // Anchor re-derives the PDA from this field
            _reserved: [0u8; 56],
        };
        let mut cert_data = Vec::new();
        cert.try_serialize(&mut cert_data).unwrap();
        pt.add_account(
            cert_pda,
            Account {
                lamports: Rent::default().minimum_balance(cert_data.len()),
                data: cert_data,
                owner: scanner_id(),
                executable: false,
                rent_epoch: u64::MAX,
            },
        );
        for (addr, account) in extra {
            pt.add_account(addr, account);
        }

        Some(Self {
            pt: Some(pt),
            pool,
            amm_program,
            coin_vault,
            pc_vault,
            lp_mint,
            pc_mint,
            open_orders,
            target_orders,
            market,
            market_program,
            market_coin_vault,
            market_pc_vault,
            vault_signer: pk(parsed["vaultSigner"].as_str().unwrap()),
            event_queue,
            bids,
            asks,
            coin_reserve,
            pc_reserve,
            lp_supply,
            amm_lp_amount,
            lp_burn_plan,
            salvor,
            cert_pda,
            protocol_config,
            vault_authority,
            pool_registry,
            salvage_receipt,
            lp_holder_pool_vault,
            protocol_treasury,
            vault_sol_holding,
            vault_base_ata,
            vault_memecoin_ata,
            salvor_lp_ata,
        })
    }

    /// The 13 pool-derived remaining accounts in vault CPI order
    /// (index 0 amm_authority = the canonical authority PDA; the two
    /// padding slots are supplied by the vault itself).
    fn remaining_default(&self) -> Vec<Pubkey> {
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

    /// Writability for `remaining_default()`: only the amm target orders and
    /// the two amm vaults are mutated by the real withdraw.
    fn remaining_writable_default() -> Vec<bool> {
        // Writability mirrors live mainnet withdraw traffic.
        vec![
            false, // amm_authority
            true,  // open_orders
            true,  // target_orders
            true,  // coin_vault
            true,  // pc_vault
            false, // market_program
            true,  // market
            true,  // market_coin_vault
            true,  // market_pc_vault
            false, // market_vault_signer
            true,  // event_queue
            true,  // bids
            true,  // asks
        ]
    }
}

// =====================================================================
// Instruction builders (raw Anchor wire format — no generated client)
// =====================================================================

/// Anchor global instruction discriminator = sha256("global:<name>")[..8].
fn anchor_disc(name: &str) -> [u8; 8] {
    let h = solana_sdk::hash::hash(format!("global:{name}").as_bytes()).to_bytes();
    [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]]
}

fn initialize_ix(h: &ForkHarness, payer: &Pubkey) -> Instruction {
    let mut data = anchor_disc("initialize").to_vec();
    data.extend_from_slice(payer.as_ref()); // authority
    data.extend_from_slice(&0u16.to_le_bytes()); // lp_holder_share_bps (0 = 40%)
    data.extend_from_slice(&0u16.to_le_bytes()); // salvor_share_bps (0 = 40%)
    data.extend_from_slice(&0u16.to_le_bytes()); // protocol_share_bps (0 = 20%)
    data.extend_from_slice(&0u64.to_le_bytes()); // priority fee ceiling (0 = default)
    data.extend_from_slice(&0u16.to_le_bytes()); // max slippage bps (0 = default)
                                                 // Dust threshold = u64::MAX isolates the Raydium V4 withdrawal leg: the
                                                 // memecoin side always stays below dust, so the Jupiter swap is skipped
                                                 // (the conversion pipeline is Phase 3's scope).
    data.extend_from_slice(&u64::MAX.to_le_bytes());
    data.extend_from_slice(&0i64.to_le_bytes()); // timelock (0 = default)
    Instruction::new_with_bytes(
        vault_id(),
        &data,
        vec![
            AccountMeta::new(h.protocol_config, false),
            AccountMeta::new(h.salvor.pubkey(), true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    )
}

struct SalvageOpts {
    lp_amount: u64,
    pool_account: Pubkey,
    amm_program_override: Option<Pubkey>,
    remaining: Vec<Pubkey>,
    remaining_writable: Vec<bool>,
}

fn salvage_ix(h: &ForkHarness, opts: &SalvageOpts) -> Instruction {
    let mut data = anchor_disc("salvage_pool").to_vec();
    data.extend_from_slice(h.amm_program.as_ref());
    data.extend_from_slice(h.pool.as_ref());
    data.extend_from_slice(&[7u8; 32]); // lp_snapshot_merkle_root (placeholder value)
    data.extend_from_slice(&h.lp_supply.to_le_bytes()); // lp_total_supply_at_snapshot
    data.extend_from_slice(&0u64.to_le_bytes()); // min_quote_output_lamports (swap leg skipped)
    data.extend_from_slice(&opts.lp_amount.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes()); // jupiter_route_data: len 0
    data.push(0); // max_slippage_bps_override: None
    data.push(0); // jupiter_route_accounts_len: 0

    let mut metas = vec![
        AccountMeta::new_readonly(h.protocol_config, false),
        AccountMeta::new_readonly(h.cert_pda, false),
        AccountMeta::new(h.pool_registry, false),
        AccountMeta::new(h.salvage_receipt, false),
        AccountMeta::new(h.lp_holder_pool_vault, false),
        AccountMeta::new(h.protocol_treasury, false),
        AccountMeta::new(h.salvor.pubkey(), true),
        AccountMeta::new(opts.pool_account, false),
        AccountMeta::new_readonly(opts.amm_program_override.unwrap_or(h.amm_program), false),
        AccountMeta::new_readonly(grave_vault::constants::JUPITER_V6_PROGRAM_ID, false),
        AccountMeta::new(h.vault_authority, false),
        AccountMeta::new(h.vault_sol_holding, false),
        AccountMeta::new(h.salvor_lp_ata, false),
        AccountMeta::new(h.vault_base_ata, false),
        AccountMeta::new(h.vault_memecoin_ata, false),
        AccountMeta::new(h.lp_mint, false),
        AccountMeta::new_readonly(h.pc_mint, false),
        AccountMeta::new_readonly(WSOL_MINT, false),
        AccountMeta::new_readonly(spl_token_id(), false),
        AccountMeta::new_readonly(spl_ata_id(), false),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
    for (k, w) in opts.remaining.iter().zip(&opts.remaining_writable) {
        metas.push(if *w {
            AccountMeta::new(*k, false)
        } else {
            AccountMeta::new_readonly(*k, false)
        });
    }
    Instruction::new_with_bytes(vault_id(), &data, metas)
}

fn default_salvage_opts(h: &ForkHarness, lp_amount: u64) -> SalvageOpts {
    SalvageOpts {
        lp_amount,
        pool_account: h.pool,
        amm_program_override: None,
        remaining: h.remaining_default(),
        remaining_writable: ForkHarness::remaining_writable_default(),
    }
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

/// Boots the genesis + runs `initialize`. Returns the client for salvage.
async fn setup(mut h: ForkHarness) -> (BanksClient, ForkHarness) {
    let init_ix = initialize_ix(&h, &h.salvor.pubkey());
    let (mut client, _genesis_payer, _bh) = h.pt.take().unwrap().start().await;
    // Every tx (including initialize) is paid and signed by the harness
    // salvor keypair — it is the funded fee payer and the instruction's
    // only required signer.
    send(&mut client, &h.salvor, &[init_ix]).await.unwrap();
    (client, h)
}

// =====================================================================
// Tests — happy path
// =====================================================================

#[tokio::test]
async fn real_v4_withdraw_burns_lp_and_settles_40_40_20() {
    let Some(h) = ForkHarness::try_new(TS_VALID_UNTIL_2100, vec![]) else {
        return;
    };
    let (mut client, h) = setup(h).await;

    // -------- pre-state from the live VM (should match fixture reads)
    let supply_before = mint_supply(&acct(&mut client, &h.lp_mint).await);
    let coin_before = token_amount(&acct(&mut client, &h.coin_vault).await);
    let pc_before = token_amount(&acct(&mut client, &h.pc_vault).await);
    assert_eq!(supply_before, h.lp_supply);
    assert_eq!(coin_before, h.coin_reserve);
    assert_eq!(pc_before, h.pc_reserve);

    // DEBUG: verify injected target orders state
    {
        let t = acct(&mut client, &h.target_orders).await;
        eprintln!(
            "DEBUG target: owner={} len={} data.owner={}",
            t.owner,
            t.data.len(),
            Pubkey::from_str(&b58encode_pubkey(&t.data[0..32]))
                .ok()
                .map(|_| "decoded-ok")
                .unwrap_or("?")
        );
        eprintln!("DEBUG target owner==v4: {}", t.owner == h.amm_program);
    }

    // -------- the real salvage (with logs on failure)
    let bh = client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[salvage_ix(&h, &default_salvage_opts(&h, h.lp_burn_plan))],
        Some(&h.salvor.pubkey()),
        &[&h.salvor],
        bh,
    );
    let res = client.process_transaction_with_metadata(tx).await.unwrap();
    if let Err(e) = res.result {
        for l in res.metadata.map(|m| m.log_messages).unwrap_or_default() {
            eprintln!("LOG: {l}");
        }
        panic!("salvage_pool against real Raydium V4 bytecode failed: {e:?}");
    }

    // -------- LP burn is real and exact
    let supply_after = mint_supply(&acct(&mut client, &h.lp_mint).await);
    assert_eq!(
        supply_after,
        h.lp_supply - h.lp_burn_plan,
        "LP mint supply must decrease by exactly the burned amount"
    );
    let salvor_lp_left = token_amount(&acct(&mut client, &h.salvor_lp_ata).await);
    assert_eq!(
        salvor_lp_left, 0,
        "the salvor's LP must be fully burned in place"
    );

    // -------- reserve deltas
    let coin_after = token_amount(&acct(&mut client, &h.coin_vault).await);
    let pc_after = token_amount(&acct(&mut client, &h.pc_vault).await);
    let coin_delta = h.coin_reserve - coin_after;
    let pc_delta = h.pc_reserve - pc_after;
    assert!(coin_delta > 0 && pc_delta > 0, "both sides must pay out");
    // V4's withdraw computes floor(reserve * burn / lp_amount) with a PnL
    // adjustment that can only reduce the payout — so the payout is bounded
    // above by the naive pro-rata amount and we accept a generous 50% floor
    // (mis-mapped legs would pay ~0 or the wrong mint, which the exact
    // assertions below catch).
    let coin_upper =
        (h.coin_reserve as u128 * h.lp_burn_plan as u128 / h.amm_lp_amount as u128) as u64;
    let pc_upper = (h.pc_reserve as u128 * h.lp_burn_plan as u128 / h.amm_lp_amount as u128) as u64;
    assert!(
        coin_delta <= coin_upper,
        "coin payout exceeds pro-rata upper bound"
    );
    assert!(
        pc_delta <= pc_upper,
        "pc payout exceeds pro-rata upper bound"
    );
    assert!(
        coin_delta >= coin_upper / 2,
        "coin payout implausibly small"
    );
    assert!(pc_delta >= pc_upper / 2, "pc payout implausibly small");

    // -------- base side (WSOL) lands in the vault and unwraps exactly
    let base_received = coin_delta; // base_is_coin_side = true
    let memecoin_received = pc_delta;
    let rent0 = Rent::default().minimum_balance(0);
    let rent_ta = Rent::default().minimum_balance(165);
    let holding = acct(&mut client, &h.vault_sol_holding).await;
    // holding = its own rent (create_account) + WSOL amount + the closed
    // base ATA's rent-reclaim - the three 40/40/20 transfers (which sum
    // exactly back to the WSOL amount).
    assert_eq!(
        holding.lamports,
        rent0 + rent_ta,
        "vault_sol_holding must retain exactly the two rents after distribution"
    );

    // -------- 40/40/20 settlement (exact)
    let total = base_received;
    let salvor_share = (total as u128 * 4000 / 10_000) as u64;
    let lp_share = (total as u128 * 4000 / 10_000) as u64;
    let protocol_share = total - salvor_share - lp_share;
    let treasury = acct(&mut client, &h.protocol_treasury).await;
    assert_eq!(
        treasury.lamports, protocol_share,
        "protocol treasury must receive exactly its remainder share (fresh account)"
    );
    let lp_pool = acct(&mut client, &h.lp_holder_pool_vault).await;
    assert_eq!(
        lp_pool.lamports,
        rent0 + lp_share,
        "lp_holder_pool_vault must hold its rent + the 40% LP share"
    );
    let salvor_balance = acct(&mut client, &h.salvor.pubkey()).await;
    // salvor got 40% but paid rents + fees; assert the inflow of at least the
    // share minus every rent it could possibly have paid.
    assert!(
        salvor_balance.lamports > 100 * LAMPORTS_PER_SOL - (rent0 * 2 + rent_ta * 3 + 20_000),
        "salvor balance implausibly low — share not received"
    );

    // -------- memecoin stays in the vault ATA (dust path skipped the swap)
    let vault_memecoin = token_amount(&acct(&mut client, &h.vault_memecoin_ata).await);
    assert_eq!(vault_memecoin, memecoin_received);

    // -------- base ATA was closed (unwrap): deleted from state entirely
    expect_closed(&mut client, &h.vault_base_ata, "vault_base_ata").await;

    // -------- PoolRegistry + SalvageReceipt (exact)
    let registry = acct(&mut client, &h.pool_registry).await;
    assert_eq!(registry.owner, vault_id());
    let receipt = acct(&mut client, &h.salvage_receipt).await;
    assert_eq!(receipt.owner, vault_id());
    // Receipt layout (borsh, after 8-byte discriminator): pool_address (32),
    // salvor (32), lp_holder_amount (8), salvor_amount (8), protocol_amount
    // (8), total_proceeds (8).
    let rd = &receipt.data;
    assert_eq!(&rd[8..40], h.pool.as_ref());
    let lp_holder_amount = read_u64(rd, 72);
    let salvor_amount = read_u64(rd, 80);
    let protocol_amount = read_u64(rd, 88);
    let total_proceeds = read_u64(rd, 96);
    assert_eq!(total_proceeds, total);
    assert_eq!(lp_holder_amount, lp_share);
    assert_eq!(salvor_amount, salvor_share);
    assert_eq!(protocol_amount, protocol_share);
}

// =====================================================================
// Tests — adversarial matrix
// =====================================================================

#[tokio::test]
async fn wrong_amm_program_rejected_by_vault_preflight() {
    let Some(h) = ForkHarness::try_new(TS_VALID_UNTIL_2100, vec![]) else {
        return;
    };
    let (mut client, h) = setup(h).await;
    // A real, executable program account that is NOT the pool's owner.
    let mut opts = default_salvage_opts(&h, h.lp_burn_plan);
    opts.amm_program_override = Some(h.market_program);
    let err = send(&mut client, &h.salvor, &[salvage_ix(&h, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_PREFLIGHT_FAILED,
        "amm_program != pool.owner must fail pre-flight",
    );
}

#[tokio::test]
async fn scrambled_open_orders_vs_target_rejected_by_real_v4() {
    let Some(h) = ForkHarness::try_new(TS_VALID_UNTIL_2100, vec![]) else {
        return;
    };
    let (mut client, h) = setup(h).await;
    let mut remaining = h.remaining_default();
    remaining.swap(1, 2); // open_orders <-> target_orders
    let mut opts = default_salvage_opts(&h, h.lp_burn_plan);
    opts.remaining = remaining;
    let err = send(&mut client, &h.salvor, &[salvage_ix(&h, &opts)])
        .await
        .unwrap_err();
    // Raw deployed-AMM code: 25 = AmmError::InvalidTargetAccountOwner (the
    // serum-owned open orders account lands in the target-orders slot).
    expect_custom(
        err,
        25,
        "real V4 must reject a scrambled open_orders/target_orders submission",
    );
}

#[tokio::test]
async fn scrambled_coin_vs_pc_vaults_rejected_by_real_v4() {
    let Some(h) = ForkHarness::try_new(TS_VALID_UNTIL_2100, vec![]) else {
        return;
    };
    let (mut client, h) = setup(h).await;
    let mut remaining = h.remaining_default();
    remaining.swap(3, 4); // amm coin vault <-> amm pc vault
    let mut opts = default_salvage_opts(&h, h.lp_burn_plan);
    opts.remaining = remaining;
    let err = send(&mut client, &h.salvor, &[salvage_ix(&h, &opts)])
        .await
        .unwrap_err();
    // Raw deployed-AMM code: 4 = AmmError::InvalidCoinVault.
    expect_custom(
        err,
        4,
        "real V4 must reject swapped coin/pc vaults (InvalidCoinVault)",
    );
}

#[tokio::test]
async fn unbound_pool_account_rejected_by_preflight() {
    // A 752-byte account owned by the real V4 program but NOT the pool the
    // cert binds to — the vault must refuse before any CPI.
    let fake_pool = Pubkey::new_unique();
    let mut fake_data = vec![0u8; 752];
    fake_data[0..8].copy_from_slice(&6u64.to_le_bytes()); // status = SwapOnly
    let fake_acct = Account {
        lamports: Rent::default().minimum_balance(752),
        data: fake_data,
        owner: RAYDIUM_V4_PROGRAM_ID,
        executable: false,
        rent_epoch: u64::MAX,
    };
    let Some(h) = ForkHarness::try_new(TS_VALID_UNTIL_2100, vec![(fake_pool, fake_acct)]) else {
        return;
    };
    let (mut client, h) = setup(h).await;
    let mut opts = default_salvage_opts(&h, h.lp_burn_plan);
    opts.pool_account = fake_pool;
    let err = send(&mut client, &h.salvor, &[salvage_ix(&h, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_PREFLIGHT_FAILED,
        "unbound pool account must fail pre-flight",
    );
}

#[tokio::test]
async fn insufficient_lp_rejected_by_token_program() {
    let Some(h) = ForkHarness::try_new(TS_VALID_UNTIL_2100, vec![]) else {
        return;
    };
    let (mut client, h) = setup(h).await;
    let opts = default_salvage_opts(&h, h.lp_burn_plan + 1); // one more than owned
    let err = send(&mut client, &h.salvor, &[salvage_ix(&h, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        AMM_ERR_INSUFFICIENT_FUNDS,
        "SPL token program must reject the over-transfer",
    );
}

#[tokio::test]
async fn zero_lp_rejected_by_preflight() {
    let Some(h) = ForkHarness::try_new(TS_VALID_UNTIL_2100, vec![]) else {
        return;
    };
    let (mut client, h) = setup(h).await;
    let opts = default_salvage_opts(&h, 0);
    let err = send(&mut client, &h.salvor, &[salvage_ix(&h, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_PREFLIGHT_FAILED,
        "zero LP amount must fail pre-flight",
    );
}

#[tokio::test]
async fn extra_remaining_accounts_rejected_by_preflight() {
    let Some(h) = ForkHarness::try_new(TS_VALID_UNTIL_2100, vec![]) else {
        return;
    };
    let (mut client, h) = setup(h).await;
    let mut remaining = h.remaining_default();
    remaining.push(Pubkey::new_unique()); // malicious tail account
    let mut opts = default_salvage_opts(&h, h.lp_burn_plan);
    opts.remaining = remaining;
    opts.remaining_writable.push(false);
    let err = send(&mut client, &h.salvor, &[salvage_ix(&h, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_PREFLIGHT_FAILED,
        "extra remaining accounts must fail the count check",
    );
}

#[tokio::test]
async fn fake_target_orders_rejected_by_real_v4() {
    let Some(h) = ForkHarness::try_new(TS_VALID_UNTIL_2100, vec![]) else {
        return;
    };
    let (mut client, h) = setup(h).await;
    let mut remaining = h.remaining_default();
    remaining[2] = Pubkey::new_unique(); // not the pool's target orders
    let mut opts = default_salvage_opts(&h, h.lp_burn_plan);
    opts.remaining = remaining;
    let err = send(&mut client, &h.salvor, &[salvage_ix(&h, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        25,
        "real V4 must reject a forged target_orders account",
    );
}

#[tokio::test]
async fn expired_cert_rejected_by_vault() {
    let Some(h) = ForkHarness::try_new(TS_LONG_PAST, vec![]) else {
        return;
    };
    let (mut client, h) = setup(h).await;
    let opts = default_salvage_opts(&h, h.lp_burn_plan);
    let err = send(&mut client, &h.salvor, &[salvage_ix(&h, &opts)])
        .await
        .unwrap_err();
    expect_custom(
        err,
        ERR_ELIGIBILITY_CERT_EXPIRED,
        "expired cert must be rejected (7002)",
    );
}
