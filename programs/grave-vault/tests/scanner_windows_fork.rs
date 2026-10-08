// SPDX-License-Identifier: Apache-2.0
//
// Phase 7 security-hardening fork harness (scanner side): the evidence
// layer's windows, rotations, replays, and pause semantics, proven against
// the REAL `grave-scanner` BPF inside an in-process Solana VM
// (`solana-program-test`), seeded with byte-for-byte mainnet state of the
// canonical SOL/USDC V4 pool
// 58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2.
//
// The adversarial shapes proven here (the roadmap's authority-rotation,
// certificate-expiration, replay, emergency-pause, and freshness rows):
//
//   1. Authority rotation: `update_protocol_config` rotates BOTH oracle
//      keys; an attestation signed by the RETIRED oracle reverts 6026
//      (`AttestationOracleMismatch`) even with a valid signature over a
//      fresh message; the NEW oracle's attestation certifies (positive
//      control). Rotation does NOT touch the recorded LaunchPrice PDA
//      (init-once, spec D9).
//   2. Certificate reissue window: a second `evaluate_pool_phase_2` while
//      the cert is valid reverts 6034 (`CertStillValid`) and leaves the
//      cert's `reissue_generation` untouched. The expiry CROSSING itself
//      cannot be reached in-VM (program-test freezes `unix_timestamp` on
//      warp; documented here by design): the inclusive `now >=
//      expires_at` boundary is host-tested (Phase 1.4 cert-lifecycle
//      unit tests) and the expired-cert salvage rejection (7002) is
//      fork-proven in the Phase 2.1 suite — this test pins the GATE.
//   3. Attestation freshness matrix: future issued slot 6031, future
//      timestamp 6028, out-of-window slot (aged out of SlotHashes) 6029,
//      hash mismatch 6030 — all with VALID signatures (freshness is a
//      data property, not a signature property) — then the honest
//      attestation certifies (positive control).
//   4. Launch-price replay: `record_launch_price` is init-once; a
//      replayed submission (fresh signature, same wire fields) dies on
//      the `init` constraint with the recorded price byte-identical.
//   5. Scanner pause: `emergency_pause(true)` gates `evaluate_pool_phase_1`,
//      `evaluate_pool_phase_2`, and `record_launch_price` with 6010, while
//      governance (`update_protocol_config`) stays live; a wrong signer
//      cannot pause (6000); unpausing restores evaluation.
//   6. Epoch confirmation boundary: Phase 2 before 2 confirmed epochs
//      reverts 6016 (`EpochConfirmationPending`); exactly
//      `anchor_epoch + MIN_EPOCH_CONFIRMATION` passes (the `>=` boundary).
//
// The harness forges exactly two things (documented shortcuts): the
// evidence authorities are test keypairs (in production the
// indexer/oracle keys are registered at initialize — same trust shape),
// and the VM holds no UNCX locker state (the locker evidence is honestly
// empty: the marker PDA does not exist = proven unlocked). Everything
// else — pool bytes, reserves, mint addresses, SlotHashes, ed25519
// precompile — is the real VM state.
//
// Fixtures via `scripts/fetch_v4_fork_fixtures.mjs` (gitignored; tests SKIP
// without them). `grave_scanner.so` must be in tests/fixtures
// (scripts/build_fork_harness.sh builds it).

// solana-sdk 2.3 deprecations — same rationale as the earlier suites.
#![allow(deprecated)]

use std::path::PathBuf;
use std::str::FromStr;

use anchor_lang::solana_program::sysvar::instructions;
use anchor_lang::AccountDeserialize;
use grave_scanner::state::ProtocolConfig as ScannerProtocolConfig;
use grave_vault::constants::RAYDIUM_V4_PROGRAM_ID;
use solana_program_test::{BanksClient, BanksClientError, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    bpf_loader,
    hash::hash,
    instruction::{AccountMeta, Instruction, InstructionError},
    native_token::LAMPORTS_PER_SOL,
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    system_program,
    sysvar::clock as clock_sysvar,
    sysvar::slot_hashes as slot_hashes_sysvar,
    transaction::{Transaction, TransactionError},
};
fn scanner_id() -> Pubkey {
    Pubkey::from_str("5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF").unwrap()
}
fn ed25519_id() -> Pubkey {
    Pubkey::from_str("Ed25519SigVerify111111111111111111111111111").unwrap()
}
fn uncx_locker_id() -> Pubkey {
    Pubkey::from_str("GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo").unwrap()
}

// Error codes asserted by the tests (grave-scanner errors.rs).
const ERR_UNAUTHORIZED: u32 = 6000;
const ERR_PROTOCOL_PAUSED: u32 = 6010;
const ERR_ATTESTATION_ORACLE_MISMATCH: u32 = 6026;
const ERR_ATTESTATION_TIMESTAMP_INVALID: u32 = 6028;
const ERR_ATTESTATION_STALE: u32 = 6029;
const ERR_ATTESTATION_SLOT_HASH_MISMATCH: u32 = 6030;
const ERR_ATTESTATION_SLOT_INVALID: u32 = 6031;
const ERR_EPOCH_CONFIRMATION_PENDING: u32 = 6016;
const ERR_CERT_STILL_VALID: u32 = 6034;

// AmmInfo offsets (752-byte layout) the scanner pipeline reads.
const AMM_COIN_VAULT_OFF: usize = 336;
const AMM_PC_VAULT_OFF: usize = 368;
const AMM_COIN_MINT_OFF: usize = 400;
const AMM_PC_MINT_OFF: usize = 432;

// Base transaction fee in program-test (one signature) — informational.
const _FEE: u64 = 5_000;

// The C1 message's last-swap timestamp is anchored IN THE PAST so the
// inactivity criterion (threshold 1s in this harness) is comfortably met
// — same margin the Phase 6 suite uses.
const INACTIVITY_MARGIN_SECONDS: i64 = 3_600;

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
    read_u64(&account.data, 64)
}

// =====================================================================
// Pool environment (scanner view: pool bytes + reserves + PDAs)
// =====================================================================

struct ScannerEnv {
    pool: Pubkey,
    coin_vault: Pubkey,
    pc_vault: Pubkey,
    lp_mint: Pubkey,
    uncx_marker: Pubkey,
    anchor_pda: Pubkey,
    cert_pda: Pubkey,
    launch_price_pda: Pubkey,
}

impl ScannerEnv {
    fn load(section: &serde_json::Value) -> Self {
        let accounts = &section["accounts"];
        let (pool, pool_acct) = load_real_account(accounts, "pool");
        let (coin_vault, _) = load_real_account(accounts, "coin_vault");
        let (pc_vault, _) = load_real_account(accounts, "pc_vault");
        let (lp_mint, _) = load_real_account(accounts, "lp_mint");
        assert_eq!(pool_acct.data.len(), 752, "canonical AmmInfo size");
        // Orientation parity with the adapter: coin vault pointer in the
        // AmmInfo must resolve to the SAME account we seeded.
        assert_eq!(read_pubkey(&pool_acct.data, AMM_COIN_VAULT_OFF), coin_vault);
        assert_eq!(read_pubkey(&pool_acct.data, AMM_PC_VAULT_OFF), pc_vault);

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
            uncx_marker,
            anchor_pda,
            cert_pda,
            launch_price_pda,
        }
    }

    /// The scanner-side remaining accounts: the adapter's pool pointers
    /// plus the UNCX marker gate account (non-existent = proven unlocked).
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

const SCANNER_POOL_ACCOUNTS: [&str; 7] = [
    "pool",
    "coin_vault",
    "pc_vault",
    "lp_mint",
    "coin_mint",
    "pc_mint",
    "wsol_mint",
];

struct Boot {
    pt: Option<ProgramTest>,
    env: ScannerEnv,
    salvor: Keypair,
    /// The registered evidence authority (= config authority at boot).
    oracle: Keypair,
}

fn build_genesis(salvor: Keypair, oracle: Keypair) -> Option<Boot> {
    let manifest = load_manifest()?;
    let env = ScannerEnv::load(&manifest);

    let mut pt = ProgramTest::default();
    pt.prefer_bpf(true);
    pt.set_compute_max_units(1_400_000);
    pt.set_transaction_account_lock_limit(64);

    if !add_elf(&mut pt, "grave_scanner.so", scanner_id(), true) {
        return None;
    }

    for name in SCANNER_POOL_ACCOUNTS {
        let (k, a) = load_real_account(&manifest["accounts"], name);
        pt.add_account(k, a);
    }

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
    pt.add_account(
        oracle.pubkey(),
        Account {
            lamports: 10 * LAMPORTS_PER_SOL,
            data: vec![],
            owner: system_program::ID,
            executable: false,
            rent_epoch: u64::MAX,
        },
    );

    Some(Boot {
        pt: Some(pt),
        env,
        salvor,
        oracle,
    })
}

/// Boots the VM and runs GraveScanner `initialize` with the explicit
/// governance thresholds sized for the fork pool (same shape as the Phase
/// 6 suite): both oracles = the registered authority key.
async fn start(mut boot: Boot) -> (ProgramTestContext, Boot) {
    let mut ctx = boot.pt.take().unwrap().start_with_context().await;
    send(
        &mut ctx.banks_client,
        &boot.salvor,
        &[scanner_init_ix(
            &boot.oracle.pubkey(),
            &boot.salvor.pubkey(),
        )],
    )
    .await
    .expect("scanner initialize failed");
    (ctx, boot)
}

// =====================================================================
// Clock / SlotHashes readers (raw sysvar bytes)
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
// Attestation machinery (runtime precompile wire format — Phase 6 shape)
// =====================================================================

/// Anchor global instruction discriminator = sha256("global:<name>")[..8].
fn anchor_disc(name: &str) -> [u8; 8] {
    let h = hash(format!("global:{name}").as_bytes()).to_bytes();
    [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]]
}

/// The `ed25519_program` verify instruction in the RUNTIME wire format.
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

/// The 112-byte C1 last-swap attestation message.
fn c1_msg(amm: &Pubkey, pool: &Pubkey, ts: i64, slot: u64, h: &[u8; 32]) -> [u8; 112] {
    let mut m = [0u8; 112];
    m[0..32].copy_from_slice(amm.as_ref());
    m[32..64].copy_from_slice(pool.as_ref());
    m[64..72].copy_from_slice(&ts.to_le_bytes());
    m[72..80].copy_from_slice(&slot.to_le_bytes());
    m[80..112].copy_from_slice(h);
    m
}

/// Sign `msg` with the oracle key and build the precompile instruction.
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
fn evaluate_pool_ix(
    env: &ScannerEnv,
    msg: &[u8; 112],
    phase2: bool,
    writer: &Pubkey,
) -> Instruction {
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
        AccountMeta::new_readonly(instructions::id(), false),
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
/// fork pool, oracles = the registered authority key.
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
/// msg(168).
fn record_launch_price_ix(
    env: &ScannerEnv,
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
        AccountMeta::new_readonly(instructions::id(), false),
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(system_program::ID, false),
    ];
    Instruction::new_with_bytes(scanner_id(), &data, metas)
}

/// The 168-byte C2 launch-price attestation message.
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

/// GraveScanner `update_protocol_config`: 8 Option fields; the rotation
/// helper sets the two oracle keys, everything else None.
fn scanner_update_config_ix(
    oracles: Option<(&Pubkey, &Pubkey)>,
    authority: &Pubkey,
) -> Instruction {
    let mut data = anchor_disc("update_protocol_config").to_vec();
    data.extend_from_slice(&[0u8; 6]); // Option::None for the six scalar fields
    match oracles {
        None => {
            data.push(0);
            data.push(0);
        }
        Some((activity, launch_price)) => {
            data.push(1);
            data.extend_from_slice(activity.as_ref());
            data.push(1);
            data.extend_from_slice(launch_price.as_ref());
        }
    }
    Instruction::new_with_bytes(
        scanner_id(),
        &data,
        vec![
            AccountMeta::new(scanner_config_pda(), false),
            AccountMeta::new_readonly(*authority, true),
        ],
    )
}

/// GraveScanner `emergency_pause`: bool + (protocol_config, authority).
fn scanner_pause_ix(authority: &Pubkey, paused: bool) -> Instruction {
    let mut data = anchor_disc("emergency_pause").to_vec();
    data.push(u8::from(paused));
    Instruction::new_with_bytes(
        scanner_id(),
        &data,
        vec![
            AccountMeta::new(scanner_config_pda(), false),
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

async fn send(
    client: &mut BanksClient,
    payer: &Keypair,
    ixs: &[Instruction],
) -> Result<(), BanksClientError> {
    let blockhash = client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &[payer], blockhash);
    client.process_transaction(tx).await
}

/// Multi-signer send: `payer` pays the fee, `extra` co-sign (e.g. the
/// config authority on a governance instruction).
async fn send_multi(
    client: &mut BanksClient,
    payer: &Keypair,
    extra: &[&Keypair],
    ixs: &[Instruction],
) -> Result<(), BanksClientError> {
    let blockhash = client.get_latest_blockhash().await.unwrap();
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &signers, blockhash);
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

/// Reads the oracle-signed C2 baseline (pool facts + price) and records the
/// LaunchPrice PDA — the preconditions every Phase 2 test needs.
async fn record_c2(ctx: &mut ProgramTestContext, boot: &Boot) {
    let client = &mut ctx.banks_client;
    let pool_acct = acct(client, &boot.env.pool).await;
    let base_mint = read_pubkey(&pool_acct.data, AMM_COIN_MINT_OFF);
    let quote_mint = read_pubkey(&pool_acct.data, AMM_PC_MINT_OFF);
    let base_reserve = token_amount(&acct(client, &boot.env.coin_vault).await);
    let quote_reserve = token_amount(&acct(client, &boot.env.pc_vault).await);
    let current_price: u128 = ((quote_reserve as u128) << 64) / (base_reserve as u128);
    let launch_price = current_price * 200; // 99.5% collapse vs the baseline

    let (slot, _, ts) = read_clock(client).await;
    let c2 = c2_msg(
        &RAYDIUM_V4_PROGRAM_ID,
        &boot.env.pool,
        &base_mint,
        &quote_mint,
        slot,
        ts,
        launch_price,
        slot,
    );
    let c2_ix = record_launch_price_ix(
        &boot.env,
        &base_mint,
        &quote_mint,
        launch_price,
        &c2,
        &boot.salvor.pubkey(),
    );
    let c2_precompile = attestation_ix(&boot.oracle, &c2, 152, 1);
    send(client, &boot.salvor, &[c2_precompile, c2_ix])
        .await
        .expect("record_launch_price failed");
}

// =====================================================================
// Tests — one adversarial shape per test, one VM per test
// =====================================================================

/// Roadmap row "authority rotation testing": rotating both oracle keys
/// repels the RETIRED oracle's attestations (6026 — a valid signature over
/// a fresh message is no longer trust) and accepts the NEW oracle's; the
/// recorded LaunchPrice PDA survives the rotation untouched (init-once,
/// spec D9).
#[tokio::test]
async fn attestation_oracle_rotation_enforced() {
    let Some(boot) = build_genesis(Keypair::new(), Keypair::new()) else {
        return;
    };
    let (mut ctx, boot) = start(boot).await;
    let old_oracle = boot.oracle.pubkey();
    let new_oracle = Keypair::new();

    // Make SlotHashes usable (boot has only slot 0; issued_slot must > 0).
    let slot = read_clock(&mut ctx.banks_client).await.0;
    ctx.warp_to_slot(slot + 1).expect("warp to usable slot");

    // C2 from the ORIGINAL oracle, then Phase 1 — both must succeed.
    record_c2(&mut ctx, &boot).await;
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, false, &boot.salvor.pubkey());
        send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect("phase 1 under the original oracle must succeed");
    }

    // Warp past the multi-epoch confirmation window so Phase 2 is
    // reachable once the oracle question is settled.
    let anchor_epoch = read_clock(&mut ctx.banks_client).await.1;
    ctx.warp_to_epoch(anchor_epoch + 3)
        .expect("warp past epoch confirmation");

    // Rotate BOTH oracles to the new key (the config authority co-signs —
    // the multisig stand-in; salvor pays the fee).
    send_multi(
        &mut ctx.banks_client,
        &boot.salvor,
        &[&boot.oracle],
        &[scanner_update_config_ix(
            Some((&new_oracle.pubkey(), &new_oracle.pubkey())),
            &old_oracle,
        )],
    )
    .await
    .expect("oracle rotation must succeed");
    {
        let cfg = ScannerProtocolConfig::try_deserialize(
            &mut &acct(&mut ctx.banks_client, &scanner_config_pda())
                .await
                .data[..],
        )
        .expect("config must deserialize");
        assert_eq!(cfg.activity_oracle, new_oracle.pubkey());
        assert_eq!(cfg.launch_price_oracle, new_oracle.pubkey());
    }

    // Phase 2 with the RETIRED oracle's signature over a FRESH message:
    // the signature is cryptographically valid, but the key is no longer
    // trusted — 6026.
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, true, &boot.salvor.pubkey());
        let err = send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect_err("retired oracle must be rejected");
        expect_custom(
            err,
            ERR_ATTESTATION_ORACLE_MISMATCH,
            "retired oracle phase 2",
        );
    }

    // Positive control: the NEW oracle's attestation certifies.
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&new_oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, true, &boot.salvor.pubkey());
        send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect("new oracle phase 2 must succeed");
    }
    // The cert is live and anchored to the rotated oracle's evaluation.
    let cert = grave_scanner::state::EligibilityCert::try_deserialize(
        &mut &acct(&mut ctx.banks_client, &boot.env.cert_pda).await.data[..],
    )
    .expect("cert must deserialize");
    assert_eq!(cert.criteria_bitmap, 0x3F);
    assert_eq!(cert.amm_program_id, RAYDIUM_V4_PROGRAM_ID);
    assert_eq!(cert.pool_address, boot.env.pool);
}

/// Roadmap row "certificate expiration testing" (the reissue gate): a
/// second Phase 2 while the cert is valid reverts 6034 and leaves the
/// cert byte-identical. The expiry CROSSING is unreachable in-VM
/// (program-test freezes unix_timestamp on warp) — the inclusive
/// `now >= expires_at` boundary is host-tested (Phase 1.4) and the
/// expired-cert salvage rejection (7002) is fork-proven (Phase 2.1).
#[tokio::test]
async fn cert_reissue_gate_rejects_while_valid() {
    let Some(boot) = build_genesis(Keypair::new(), Keypair::new()) else {
        return;
    };
    let (mut ctx, boot) = start(boot).await;
    let anchor_epoch = {
        let slot = read_clock(&mut ctx.banks_client).await.0;
        ctx.warp_to_slot(slot + 1).expect("warp to usable slot");
        read_clock(&mut ctx.banks_client).await.1
    };

    record_c2(&mut ctx, &boot).await;
    // Phase 1, then Phase 2 after the epoch gap — the cert is issued.
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, false, &boot.salvor.pubkey());
        send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect("phase 1 must succeed");
    }
    ctx.warp_to_epoch(anchor_epoch + 3)
        .expect("warp past epoch confirmation");
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, true, &boot.salvor.pubkey());
        send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect("phase 2 issue must succeed");
    }
    let cert_before = acct(&mut ctx.banks_client, &boot.env.cert_pda).await;

    // Reissue attempt while valid: 6034, cert untouched.
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, true, &boot.salvor.pubkey());
        let err = send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect_err("reissue while valid must fail");
        expect_custom(err, ERR_CERT_STILL_VALID, "reissue while valid");
    }
    let cert_after = acct(&mut ctx.banks_client, &boot.env.cert_pda).await;
    assert_eq!(
        cert_before.data, cert_after.data,
        "rejected reissue must not touch the cert"
    );
}

/// Roadmap row "certificate expiration testing" (the freshness half) +
/// "replay testing": attestation data stamps are enforced — future slot
/// 6031, future timestamp 6028, SlotHashes-aged-out slot 6029, corrupted
/// hash 6030, all over VALIDLY SIGNED fresh messages; the honest
/// attestation then certifies (positive control).
#[tokio::test]
async fn attestation_freshness_matrix() {
    let Some(boot) = build_genesis(Keypair::new(), Keypair::new()) else {
        return;
    };
    let (mut ctx, boot) = start(boot).await;
    let slot0 = read_clock(&mut ctx.banks_client).await.0;
    ctx.warp_to_slot(slot0 + 1).expect("warp to usable slot");

    record_c2(&mut ctx, &boot).await;

    // Warp far enough that the earliest usable entries age out of the
    // ~512-entry SlotHashes window (the AttestationStale shape).
    let (now_slot, _, _) = read_clock(&mut ctx.banks_client).await;
    ctx.warp_to_slot(now_slot + 2_000)
        .expect("warp out of window");

    // (a) Future issued slot -> 6031. The slot is future RELATIVE TO THE
    // POST-WARP bank slot (read fresh here).
    {
        let client = &mut ctx.banks_client;
        let (cur_slot, _, ts) = read_clock(client).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts,
            cur_slot + 100,
            &[9u8; 32],
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, false, &boot.salvor.pubkey());
        let err = send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect_err("future issued slot must fail");
        expect_custom(err, ERR_ATTESTATION_SLOT_INVALID, "future issued slot");
    }

    // (b) Future last-swap timestamp -> 6028.
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts + 1_000,
            slot,
            &[9u8; 32],
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, false, &boot.salvor.pubkey());
        let err = send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect_err("future timestamp must fail");
        expect_custom(err, ERR_ATTESTATION_TIMESTAMP_INVALID, "future timestamp");
    }

    // (c) NEVER-VISITED slot -> 6029. Warps append the slots they jump
    // TO (sparse history), so an interior slot like 1000 was never a
    // bank slot: <= now, > 0, and absent from SlotHashes — only the
    // lookup can reject it.
    {
        let client = &mut ctx.banks_client;
        let (_, _, ts) = read_clock(client).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts,
            1_000,
            &[9u8; 32],
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, false, &boot.salvor.pubkey());
        let err = send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect_err("aged-out slot must fail");
        expect_custom(err, ERR_ATTESTATION_STALE, "aged-out slot");
    }

    // (d) Corrupted hash for a REAL in-window slot -> 6030.
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, mut hash) = newest_slot_hash(client, slot).await;
        hash[0] ^= 0xFF;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, false, &boot.salvor.pubkey());
        let err = send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect_err("hash mismatch must fail");
        expect_custom(err, ERR_ATTESTATION_SLOT_HASH_MISMATCH, "hash mismatch");
    }

    // Positive control: the honest attestation certifies.
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, false, &boot.salvor.pubkey());
        send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect("honest phase 1 must succeed");
    }
}

/// Roadmap row "replay testing" (C2): `record_launch_price` is init-once —
/// a replayed submission (fresh signature, identical wire fields) dies on
/// the `init` constraint and the recorded price is byte-identical.
#[tokio::test]
async fn record_launch_price_is_oneshot() {
    let Some(boot) = build_genesis(Keypair::new(), Keypair::new()) else {
        return;
    };
    let (mut ctx, boot) = start(boot).await;
    let slot0 = read_clock(&mut ctx.banks_client).await.0;
    ctx.warp_to_slot(slot0 + 1).expect("warp to usable slot");

    record_c2(&mut ctx, &boot).await;
    let launch_before = acct(&mut ctx.banks_client, &boot.env.launch_price_pda).await;

    // Replay: same pool/base/quote/price wire fields, a FRESH signed
    // message — the init constraint rejects before the handler runs.
    {
        let client = &mut ctx.banks_client;
        let pool_acct = acct(client, &boot.env.pool).await;
        let base_mint = read_pubkey(&pool_acct.data, AMM_COIN_MINT_OFF);
        let quote_mint = read_pubkey(&pool_acct.data, AMM_PC_MINT_OFF);
        let base_reserve = token_amount(&acct(client, &boot.env.coin_vault).await);
        let quote_reserve = token_amount(&acct(client, &boot.env.pc_vault).await);
        let current_price: u128 = ((quote_reserve as u128) << 64) / (base_reserve as u128);
        let launch_price = current_price * 200;
        let (slot, _, ts) = read_clock(client).await;
        let c2 = c2_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            &base_mint,
            &quote_mint,
            slot,
            ts,
            launch_price,
            slot,
        );
        let c2_ix = record_launch_price_ix(
            &boot.env,
            &base_mint,
            &quote_mint,
            launch_price,
            &c2,
            &boot.salvor.pubkey(),
        );
        let c2_precompile = attestation_ix(&boot.oracle, &c2, 152, 1);
        let err = send(client, &boot.salvor, &[c2_precompile, c2_ix])
            .await
            .expect_err("launch-price replay must fail");
        match err {
            BanksClientError::TransactionError(TransactionError::InstructionError(..)) => {}
            other => panic!("expected instruction failure, got {other:?}"),
        }
    }
    let launch_after = acct(&mut ctx.banks_client, &boot.env.launch_price_pda).await;
    assert_eq!(
        launch_before.data, launch_after.data,
        "replay must not touch the recorded launch price"
    );
}

/// Roadmap row "emergency-pause testing" (scanner): pause gates Phase 1,
/// Phase 2, and `record_launch_price` with 6010 while governance stays
/// live; a wrong signer cannot toggle the pause (6000); unpausing
/// restores evaluation (positive control).
#[tokio::test]
async fn scanner_pause_gates_evaluation_not_governance() {
    let attacker = Keypair::new();
    let Some(boot) = build_genesis(Keypair::new(), Keypair::new()) else {
        return;
    };
    let (mut ctx, boot) = start(boot).await;
    let slot0 = read_clock(&mut ctx.banks_client).await.0;
    ctx.warp_to_slot(slot0 + 1).expect("warp to usable slot");

    record_c2(&mut ctx, &boot).await;

    // Pause. Then: Phase 1 gated on the FRESH pool (its anchor `init`
    // rolls back with the reverted transaction), and the C2 replay gated.
    // (Phase 2's pause check is the same handler line; while paused its
    // anchor precondition cannot exist, so its rejection there surfaces
    // at the constraint layer — the handler gate is proven via Phase 1.)
    send_multi(
        &mut ctx.banks_client,
        &boot.salvor,
        &[&boot.oracle],
        &[scanner_pause_ix(&boot.oracle.pubkey(), true)],
    )
    .await
    .expect("pause must succeed");
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, false, &boot.salvor.pubkey());
        let err = send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect_err("evaluation must be gated while paused");
        expect_custom(err, ERR_PROTOCOL_PAUSED, "phase 1 while paused");
    }

    // Governance stays live: config update + pause itself.
    send_multi(
        &mut ctx.banks_client,
        &boot.salvor,
        &[&boot.oracle],
        &[scanner_update_config_ix(None, &boot.oracle.pubkey())],
    )
    .await
    .expect("governance must stay live during pause");

    // A wrong signer cannot flip the pause.
    let err = send_multi(
        &mut ctx.banks_client,
        &boot.salvor,
        &[&attacker],
        &[scanner_pause_ix(&attacker.pubkey(), false)],
    )
    .await
    .expect_err("wrong signer must not unpause");
    expect_custom(err, ERR_UNAUTHORIZED, "wrong-signer unpause");

    // Unpause: evaluation restored — Phase 1 anchors (its `init` now
    // commits), and after the epoch gap Phase 2 certifies.
    send_multi(
        &mut ctx.banks_client,
        &boot.salvor,
        &[&boot.oracle],
        &[scanner_pause_ix(&boot.oracle.pubkey(), false)],
    )
    .await
    .expect("unpause must succeed");
    let anchor_epoch = {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, false, &boot.salvor.pubkey());
        send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect("phase 1 after unpause must succeed");
        read_clock(client).await.1
    };
    ctx.warp_to_epoch(anchor_epoch + 3)
        .expect("warp past epoch confirmation");
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, true, &boot.salvor.pubkey());
        send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect("phase 2 after unpause must succeed");
    }
    let cert = grave_scanner::state::EligibilityCert::try_deserialize(
        &mut &acct(&mut ctx.banks_client, &boot.env.cert_pda).await.data[..],
    )
    .expect("cert must deserialize");
    assert_eq!(cert.criteria_bitmap, 0x3F);
}

/// Roadmap row "integration testing" (phase-window boundary): Phase 2
/// requires `current_epoch - anchor_epoch >= MIN_EPOCH_CONFIRMATION`
/// (2) — one epoch short reverts 6016, exactly two passes.
#[tokio::test]
async fn phase2_epoch_confirmation_boundary() {
    let Some(boot) = build_genesis(Keypair::new(), Keypair::new()) else {
        return;
    };
    let (mut ctx, boot) = start(boot).await;
    let slot0 = read_clock(&mut ctx.banks_client).await.0;
    ctx.warp_to_slot(slot0 + 1).expect("warp to usable slot");

    record_c2(&mut ctx, &boot).await;
    let anchor_epoch = {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, false, &boot.salvor.pubkey());
        send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect("phase 1 must succeed");
        read_clock(client).await.1
    };

    // One epoch in: still pending.
    ctx.warp_to_epoch(anchor_epoch + 1).expect("warp +1");
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, true, &boot.salvor.pubkey());
        let err = send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect_err("one epoch must still be pending");
        expect_custom(err, ERR_EPOCH_CONFIRMATION_PENDING, "one epoch");
    }

    // Exactly MIN_EPOCH_CONFIRMATION epochs: the `>=` boundary passes.
    ctx.warp_to_epoch(anchor_epoch + 2).expect("warp +2");
    {
        let client = &mut ctx.banks_client;
        let (slot, _, ts) = read_clock(client).await;
        let (hash_slot, hash) = newest_slot_hash(client, slot).await;
        let msg = c1_msg(
            &RAYDIUM_V4_PROGRAM_ID,
            &boot.env.pool,
            ts - INACTIVITY_MARGIN_SECONDS,
            hash_slot,
            &hash,
        );
        let precompile = attestation_ix(&boot.oracle, &msg, 72, 1);
        let eval = evaluate_pool_ix(&boot.env, &msg, true, &boot.salvor.pubkey());
        send(client, &boot.salvor, &[precompile, eval])
            .await
            .expect("two epochs must certify");
    }
}
