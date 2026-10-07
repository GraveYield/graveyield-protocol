# Changelog

## [Unreleased — Phase 1.4: eligibility certificate lifecycle (B4)]

### Added
- **Expiry-gated cert reissuance (spec `PROTOCOL_SPEC.md` §7 / decision
  D10).** The `EligibilityCert` PDA was init-once: once it expired, the
  pool's salvage path was permanently bricked — the vault's
  `EligibilityCertExpired` (7002) message said "Re-run Phase 2", but
  re-running Phase 2 reverted on re-creating an existing PDA. Phase 2
  now creates the cert with `init_if_needed` and reissues it **in
  place** once expired. One gate governs all lifecycle states: a fresh
  (zeroed) PDA reads as expired (`expires_at == 0`), an expired cert is
  reissuable, and a **live** cert reverts the new error 6034
  `CertStillValid` — two live certs for one pool are structurally
  impossible (single PDA + gate). Every reissue re-runs the full Phase 2
  verification stack (fresh C1 attestation, six criteria, locker
  evidence, mint-pair check, bitmap equality); there is no shortcut
  path to a cert.
- **`EligibilityCert.reissue_generation`** — auditable counter of
  repeated Phase 2 attempts (1 = first issue, N = Nth reissue), carved
  out of `_reserved` (64 → 56 bytes; total account size unchanged).
  `EligibilityCertIssued` events now carry `generation`.
- **Cert lifecycle host tests** — inclusive expiry boundary
  (`[issued_at, expires_at)`), zeroed-fresh reissuability, live-cert
  gate, layout stability, and a borsh roundtrip of the reissue
  overwrite.
- **Scanner error 6034** — `CertStillValid` (lock test extended to
  6000–6034).

### Changed
- **`evaluate_pool_phase2` behavior:** a second Phase 2 call on an
  expired cert now succeeds (in-place reissue) instead of reverting
  `AccountAlreadyInitialized`; a call on a live cert reverts 6034. No
  instruction data changed. `grave-scanner` now enables the
  `anchor-lang` `init-if-needed` cargo feature (the reinitialization-
  attack surface is closed by the expiry gate + unconditional full-field
  rewrite; the vault already used the same feature for its PDAs).
- **Failed salvage semantics documented** (no state change needed): a
  reverting `salvage_pool` leaves the cert untouched (retry within the
  TTL works); the vault's init-once `PoolRegistry`/`SalvageReceipt` PDAs
  permanently settle a salvaged pool; a drained pool fails
  re-certification at Criterion 3 (minimum TVL) regardless.
- **Documented v1.0 boundaries (spec §6.4):** no on-chain revocation of
  a live cert (`invalidate_anchor` censors the certification path
  upstream only) and no post-salvage cert rent recovery — both reserved
  for future revisions.

### Verified
- `cargo test -p grave-scanner` 81/81 (76 → 81: +5 cert lifecycle),
  `cargo test -p grave-vault` 9/9, `clippy -D warnings` clean (scanner
  + vault), `fmt --check` clean, terminology lint pass, workspace
  typecheck green.

## [Unreleased — Phase 1.3: authoritative launch price (ORACLE-001)]

### Added
- **Oracle-signed launch-price baseline (spec `PROTOCOL_SPEC.md` §5 /
  decision D9).** "Launch price" is now defined normatively as the
  quote-per-base price formed by the pool's vault balances immediately
  before the pool's first successful swap (the deployer-seeded initial
  market price). The value reaches `record_launch_price` only as a
  168-byte Ed25519 attestation
  `amm_program_id ‖ pool_address ‖ base_mint ‖ quote_mint ‖
  first_swap_slot ‖ first_swap_unix_ts ‖ launch_price_q64x64 ‖
  issued_slot` verified in-transaction via the `ed25519_program`
  precompile. This closes two live attack vectors of the caller-supplied
  baseline: fake-high prices (forged C2 collapses) and fake-low prices
  (permanent C2 denial-of-service on the init-once record).
- **`ProtocolConfig.launch_price_oracle`** — new governance-controlled
  signing key for C2 attestations, deliberately separate from the hotter
  `activity_oracle` key (the init-once baseline is permanently binding).
  Initialised to the protocol authority at `initialize`; rotatable
  independently via `update_protocol_config` (new `launch_price_oracle:
  Option<Pubkey>` param).
- **`LaunchPrice` provenance fields** — attested `first_swap_slot` and
  `first_swap_unix_ts` persisted alongside the price (reserved space
  shrunk 32 → 16 bytes; total account size unchanged), making the
  init-once baseline auditable against the original attestation.
- **Evaluation-time mint-pair re-check** — both `evaluate_pool_phase_1`
  and `evaluate_pool_phase_2` now reject a baseline recorded for a
  different token pair than the live pool's parsed mints.
- **Scanner errors 6032–6033** — `InvalidLaunchPrice` (zero attested
  price), `LaunchPriceMintMismatch` (baseline mint pair ≠ live pool).
- **`sdk/src/launchPriceAttestation.ts`** — canonical 168-byte message
  builder/parser (byte-for-byte mirror of the on-chain layout),
  `buildLaunchPriceEd25519VerifyInstruction` (precompile wiring at
  message offset 152), `readV4PoolPair`, and
  `deriveLaunchPriceV4`: fail-closed operator/indexer tooling that
  paginates signature history back to genesis, identifies the first swap
  by opposite-direction vault-balance deltas (deposits/initialization
  move both vaults the same way), and computes
  `(pc_vault_pre << 64) / coin_vault_pre` — the exact on-chain price
  formula. Incomplete history, missing block times, pruned transactions,
  and zero pre-swap base liquidity all throw; a never-swapped pool
  returns `null`.
- **Extreme-price boundary tests** — `compute_drop_bps` pinned at the
  minimum representable price, large-representable prices, and the
  fail-closed `MathOverflow` boundary above ~2^114.6 Q64.64 (spec §6.4).

### Changed
- **BREAKING (pre-mainnet):** `record_launch_price` instruction data
  gained `msg: [u8; 168]` (the signed attestation, now the last params
  field) and the accounts gained `protocol_config` +
  `instruction_sysvar`. A caller-supplied price that does not byte-exactly
  echo the attested price reverts (`AttestationBindingMismatch`, 6027).
  The instruction is now pause-gated like the evaluation path.
- **`attestation.rs` refactor** — the Ed25519 offset validator is
  generalized (`verify_ed25519_offsets_at`) with the C1 validator kept as
  a thin wrapper at the canonical offset 72; the C2 path validates at
  offset 152 over a 320-byte instruction. A shared
  `load_instruction_pair` helper replaces duplicated sysvar loading.
- **SDK `buildEd25519VerifyInstruction`** — accepts an optional
  `messageAddressOffset` (defaults to the C1 offset 72, wire format
  unchanged).
- **`programs/grave-vault/Cargo.toml`** — added `solana-sha256-hasher`
  with the `sha2` feature as a dev-dependency. The dependabot 2.3.0 →
  3.1.0 bump had silently broken the merkle host tests on host builds
  (`hashv` panics off-chain without the software feature); the tests
  compile but failed at runtime since that bump. Caught by the Phase 1.3
  verification pass; on-chain BPF builds are unaffected.

### Verified
- `cargo test -p grave-scanner` 76/76, `cargo test -p grave-vault` 9/9,
  `clippy -D warnings` clean, `fmt --check` clean, terminology lint pass,
  workspace typecheck green, and a 26-check TS↔Rust wire-format
  verification (independent encoder vs SDK builder vs byte-slice
  assertions vs precompile offsets).

## [Unreleased — Phase 1.2: authoritative last-swap evidence (ORACLE-002)]

### Added
- **`programs/grave-scanner/src/attestation.rs`** — on-chain verification of
  indexer-signed Criterion 1 evidence (spec `PROTOCOL_SPEC.md` §5, decision
  D8). A 112-byte message `amm_program_id ‖ pool_address ‖ last_swap_unix_ts ‖
  issued_slot ‖ slot_hash` is signed by the protocol activity oracle and
  verified inside `evaluate_pool_phase_1` / `evaluate_pool_phase_2` through the
  `ed25519_program` precompile: the handler validates the precompile's
  `Ed25519SignatureOffsets` (single signature, canonical offsets binding the
  signature to exactly the attestation embedded in the instruction data), the
  oracle public key, the pool/AMM binding, timestamp sanity (no zero/future),
  and re-anchors `issued_slot` against the `SlotHashes` sysvar so a replayed
  attestation fails closed once the slot ages out (~512 slots). 15 host unit
  tests cover the stale-pool, recently-active-pool, and every manipulated-
  timestamp vector.
- **`ProtocolConfig.activity_oracle`** — new governance-controlled field; the
  public key whose Ed25519 signatures authorize C1 attestations. Initialised
  to the protocol authority at `initialize`; rotatable via
  `update_protocol_config` (new `activity_oracle: Option<Pubkey>` param).
- **Scanner errors 6024–6031** — `AttestationMissing`,
  `InvalidAttestationOffsets`, `AttestationOracleMismatch`,
  `AttestationBindingMismatch`, `AttestationTimestampInvalid`,
  `AttestationStale`, `AttestationSlotHashMismatch`, `AttestationSlotInvalid`.
- **`sdk/src/lastSwapAttestation.ts`** — canonical attestation message
  builder/parser (byte-for-byte mirror of the on-chain layout), Ed25519
  verify-instruction builder for transaction assembly, and operator/indexer
  tooling: `deriveLastSwapV4` (RPC transaction-history derivation) and
  `fetchSlotHash` (SlotHashes anchoring).

### Changed
- **BREAKING (pre-mainnet):** `evaluate_pool_phase_1` / `evaluate_pool_phase_2`
  instruction data replaced the caller-supplied `last_swap_unix_ts: i64`
  parameter with `msg: [u8; 112]` (the signed attestation), and both handlers
  gained `instruction_sysvar` + `slot_hashes` sysvar accounts. A caller-
  supplied timestamp is no longer an accepted input anywhere.
- **`PoolData`** — the dead `last_swap_unix_ts` field and the Raydium V4
  adapter's `0` sentinel were removed; C1 evidence now has exactly one source
  (the attestation).
- **Docs** — `PROTOCOL_SPEC.md` rev 1.2.0 (§4 C1, §5, §6.1/6.3, §7 D8, §8 row
  11, §9); whitepaper C1/C2 evidence wording; glossary (`activity oracle`,
  `last-swap attestation`); `error_codes.md` 6024–6031;
  `PRE_MAINNET_CHECKLIST.md` ORACLE-002 retired, ORACLE-003 opened (oracle
  operational runbook); `tests/README.md` updated.

### Sync convention
- `cargo test -p grave-scanner`: 56/56 pass (41 pre-existing + 15 new);
  `cargo clippy -D warnings` clean; `cargo fmt` clean; workspace typecheck
  (sdk + indexer) clean.

## [Unreleased — m6: claim_lp_proceeds Merkle verification]

### Added
- **`programs/grave-vault/src/merkle.rs`** — SHA-256 sorted-pair Merkle proof verifier matching OpenZeppelin / Uniswap convention. `compute_leaf(holder, balance)` produces `sha256(pubkey || balance_le_u64)`; `verify_proof(root, leaf, proof)` walks the proof in sorted-pair order. 7 host unit tests cover deterministic-leaf, distinct-leaf, two-leaf tree, four-leaf balanced tree, sorted-pair order invariance, empty-proof edge case, and tampered-leaf rejection.

### Changed
- **`claim_lp_proceeds` handler** — replaces the m3 placeholder (`require!(!params.merkle_proof.is_empty(), …)`) with a real Merkle verification against `pool_registry.lp_snapshot_merkle_root`. The pro-rata math, conservation check, and `LpClaimProcessed` event are unchanged from m3.
- **`claim_lp_proceeds` SOL transfer wired** — replaces the m3 `TODO(GraveVault m6)` comment with a real `system_program::transfer` CPI signed by `lp_holder_pool_vault`'s own seeds via `invoke_signed`. The vault is a system-owned PDA created by salvage_pool's lazy-init; its seeds are its signing authority.
- **`claim_lp_proceeds` defensive checks** added:
  - `lp_balance_at_snapshot > 0` (rejects zero-balance claims with `InvalidClaimProof`)
  - `pool_registry.lp_total_supply_at_snapshot > 0` (prevents division-by-zero if PoolRegistry is corrupted)
- **`lib.rs`** — `+ pub mod merkle;`.

### Sync convention
- No new error codes required. `InvalidClaimProof` (7010) and `ClaimAlreadyProcessed` (7011) already cover the m6 surface. `docs/error_codes.md` unchanged.

### Unverified
- BPF compile via `anchor build` (CI gate).
- End-to-end localnet smoke test: snapshot a Raydium V4 SOL/X pool's LP holders, salvage it via m5, then claim from multiple holders against the sealed root. Tracked in `PRE_MAINNET_CHECKLIST.md` as a v1.0-release-blocker.
- Real off-chain GraveScanner v2 indexer integration. The Merkle leaf encoding (`sha256(pubkey || balance_le_u64)`) is documented in this file and the canon — the off-chain builder MUST match it byte-for-byte.

## [Unreleased — m5: salvage_pool execution path]

### Added
- **GraveVault salvage_pool execution path** end-to-end (m5):
  - `cpi/raydium_v4.rs` — real Raydium V4 `withdraw` CPI (vault_authority PDA-signs `user_owner`; 18-account list; 9-byte data `[tag=4][amount_le]`; AMM authority constant validation; pre/post balance deltas).
  - `cpi/jupiter.rs` — Jupiter v6 swap CPI helper (forwards salvor's pre-computed route data + accounts; vault_authority signs).
  - `cpi/raydium_clmm.rs`, `cpi/orca_whirlpool.rs`, `cpi/pump_swap.rs` — honest-stub adapters; revert `AmmCpiUnimplemented` (7017).
  - `cpi/mod.rs` — dispatcher by `pool.owner`.
- **salvage_pool handler** rewritten to wire: salvor→vault LP transfer, dispatched remove_liquidity CPI, Jupiter swap (or dust skip), WSOL→SOL unwrap via `close_account` to `vault_sol_holding_account`, 40/40/20 distribution via three `system_program::transfer` calls, PoolRegistry + SalvageReceipt population, `PoolSalvaged` + `SalvageCompleted` emit.
- **Five new error codes** (7015-7019): `AmmRedemptionFailed`, `JupiterSwapFailed`, `AmmCpiUnimplemented`, `InvalidSnapshotData`, `UnsupportedBaseToken`. Mirrored to `docs/error_codes.md` in lock-step per the sync convention.
- **New PDA seeds**: `VAULT_AUTHORITY_SEED` (singleton signer), `VAULT_SOL_HOLDING_SEED` (per-pool, transient native-SOL holding for unwrap).
- **New constants**: `WSOL_MINT`, `RAYDIUM_V4_PROGRAM_ID`, `RAYDIUM_V4_AMM_AUTHORITY` (`5Q544...`), `RAYDIUM_CLMM_PROGRAM_ID`, `ORCA_WHIRLPOOL_PROGRAM_ID`, `PUMP_SWAP_PROGRAM_ID`, `JUPITER_V6_PROGRAM_ID`, `RAYDIUM_V4_INSTRUCTION_TAG_WITHDRAW = 4`, `RAYDIUM_V4_WITHDRAW_REMAINING_ACCOUNTS_REQUIRED = 11`, `BPS_DENOMINATOR = 10_000`, `HARD_MAX_SLIPPAGE_BPS = 1_000`.
- **PRE_MAINNET_CHECKLIST**: new rows `CPI-006/007/008` (CLMM/Orca/PumpSwap stubs) + `CPI-009` (Raydium V4 account-ordering verification against a live mainnet pool — blocking row).

### Changed
- `salvage_pool` instruction signature now takes `Context<'_, '_, '_, 'info, SalvagePool<'info>>` (explicit `'info` threading per Anchor 0.31+ lifetime invariance — see failure-pattern memory).
- `SalvagePoolParams` extended with `salvor_lp_amount`, `jupiter_route_data: Vec<u8>`, `max_slippage_bps_override: Option<u16>`, `jupiter_route_accounts_len: u8`.
- `SalvagePool` Accounts struct extended with `vault_authority`, `vault_sol_holding_account`, `salvor_lp_token_account`, `vault_lp_token_account`, `vault_base_token_account`, `vault_memecoin_token_account`, `lp_mint`, `memecoin_mint`, `wsol_mint` (pinned via `address` constraint), `token_program`, `associated_token_program`.

### Unverified
- BPF compile via `anchor build` (deferred to CI on this PR).
- Live Raydium V4 fork test of the exact 18-account ordering. The `amm_authority` constant check provides one assertion; full integration is `CPI-009` in `PRE_MAINNET_CHECKLIST.md`.
- Real Jupiter v6 swap end-to-end. The CPI helper forwards what the salvor's bot quotes; verification is a localnet smoke test post-merge.
- Pool orientation: `base_is_coin_side` is currently hardcoded `true` (assumes WSOL is the pool's coin side). A SOL/X pool where WSOL is the PC side will need the bot to invert its submission ordering; a runtime parse of pool data to detect orientation is in `PRE-MAINNET-TODO(CPI)` comments in `salvage_pool.rs`.

All notable changes to the GraveYield protocol monorepo are documented here.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version bumps in this file refer to the workspace as a whole; per-program
version pinning lives in each program's `Cargo.toml`.

## [Unreleased]

## [v1.0.6] — 2026-05-10

### m3 — GraveVault `salvage_pool` pre-flight + cert freshness gates

This release lands milestone 3 of the canonical 10-step build sequence:
**GraveVault `salvage_pool` pre-flight + PoolRegistry**. The CPI bodies
for AMM `remove_liquidity` (m5), Jupiter swap (m6), and 40/40/20
distribution (m7) remain honest-stubbed and explicitly marked.

#### Added

- **`MIN_CERT_TTL_SECONDS = 600`** floor in `programs/grave-scanner/src/constants.rs`.
  Hardcoded; raising it requires a program upgrade.
- **`ProtocolConfig.cert_ttl_seconds: i64`** field on the GraveScanner
  ProtocolConfig (governance-configurable, 72h timelocked, default 3600s).
  This replaces the previously-hardcoded `ELIGIBILITY_CERT_TTL_SECONDS`
  const at the runtime path in `evaluate_pool_phase_2`. The const itself
  is retained as `DEFAULT_CERT_TTL_SECONDS` for default-handling at init,
  and an `#[deprecated]` alias is left at `ELIGIBILITY_CERT_TTL_SECONDS`
  for backwards-compatible test fixtures.
- **Error 6019 `CertTtlBelowMinimum`** on GraveScanner. Raised by
  `initialize` and `update_protocol_config` when a `cert_ttl_seconds`
  parameter falls below `MIN_CERT_TTL_SECONDS`.
- **Anchor 0.32-compatible lazy vault init** for `lp_holder_pool_vault` in
  `salvage_pool`. Anchor 0.32 rejects `init` / `init_if_needed` on
  `SystemAccount` by design; PR #12's original approach is replaced with
  a manual `anchor_lang::system_program::create_account` CPI issued by
  the handler when `vault.lamports() == 0`. First salvage of a pool
  creates the 0-data system-owned PDA via the CPI (signed with the PDA
  bump); subsequent salvages of the same pool are still blocked at the
  `pool_registry` init constraint, so the lazy creation only matters on
  the first call. Net on-chain semantics are identical to the original
  `init_if_needed` design.

#### Changed

- **`salvage_pool` pre-flight gates wired** in `programs/grave-vault/src/instructions/salvage_pool.rs`:
  - Pause check (`ProtocolPaused`).
  - **Cert freshness** via `EligibilityCert::is_expired(now)` (`EligibilityCertExpired`).
  - **Cert criteria bitmap** must equal `0x3F` (all six derelict-pool
    criteria validated at Phase 2) (`InvalidEligibilityCert`).
  - **Cert pool / AMM binding** — `cert.amm_program_id == params.amm_program_id`
    AND `cert.pool_address == params.pool_address` (`InvalidEligibilityCert`).
  - Pool account address consistency (`PreflightFailed`).
- **`eligibility_cert` account** in `salvage_pool` migrated from
  `UncheckedAccount<'info>` to `Account<'info, EligibilityCert>`. Anchor
  now handles the 8-byte discriminator check and owner-program (`grave_scanner::ID`)
  validation automatically; the previous manual ownership require! is
  redundant and removed.
- **`lp_holder_pool_vault`** in `claim_lp_proceeds` migrated from
  `UncheckedAccount<'info>` to `SystemAccount<'info>` (read-only path,
  no `init` constraint — safe under Anchor 0.32). In `salvage_pool` the
  account is declared as `UncheckedAccount<'info>` with `mut, seeds,
  bump` (PDA validation only) and lazy-initialized via the manual CPI
  described above. The account remains charter-invariant unsweepable;
  only `claim_lp_proceeds` may debit it (against a valid Merkle proof,
  m6+).
- **`evaluate_pool_phase_2`** now reads `cfg.cert_ttl_seconds` from
  ProtocolConfig instead of the hardcoded const when stamping
  `cert.expires_at`.

#### Honest stubs (audit-pending, unchanged from v1.0.5)

- AMM `remove_liquidity` CPI for Raydium V4: wired in v1.0.5; not yet
  integration-tested against a seeded localnet pool (OpenBook seed harness
  is a v1.1 deliverable).
- AMM adapters for Raydium CLMM, Orca Whirlpool, PumpSwap: revert
  `AmmAdapterUnimplemented`.
- Locker release adapters (UNCX / PinkSale / Team Finance): revert
  `LockerAdapterUnimplemented`.
- Jupiter v6 swap CPI: not yet wired; m6 deliverable.
- 40/40/20 distribution math: not yet wired; m7 deliverable.
  `SalvageReceipt` distribution fields are zeroed at init.
- LP-holder Merkle proof verification in `claim_lp_proceeds`: returns
  `InvalidClaimProof` until m6 wires the SHA-256 sorted-pair verification.

#### Verification status

Locally verified on the official Solana 3.x stack (rust 1.91.1, anchor
0.32.1, solana 3.0.10, platform-tools v1.54):

- `cargo fmt --all -- --check`: clean
- `cargo clippy --workspace --all-targets -- -D warnings`: clean
- `cargo test --workspace --lib`: **20/20 pass** (19 grave-scanner + 1
  grave-vault)
- `cargo-build-sbf --tools-version v1.54`: BPF compile clean in ~51s

CI `anchor build` job is currently failing at the post-cargo-build-sbf
phase (anchor's IDL generation step) — investigation tracked in a
follow-up patch. The local cargo-build-sbf compile of both programs
succeeds, so the deployable BPF artifact is unaffected.

#### Pre-mainnet checklist

- Replace placeholder program IDs in both crates' `declare_id!` and
  `Anchor.toml` with real keypairs via `anchor keys list && anchor keys sync`.
- Re-deploy ProtocolConfig PDAs on devnet — adding `cert_ttl_seconds`
  changes `INIT_SPACE` and existing config accounts will fail `realloc`
  unless rotated through a fresh `initialize`. (Pre-mainnet: no live
  config exists, so this is a no-op for the canonical deploy path.)