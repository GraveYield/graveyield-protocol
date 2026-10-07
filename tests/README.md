# tests

Integration tests for GraveYield. Anchor + ts-mocha harness lands in milestone m1
alongside the first real instruction handlers. Until then this directory is
intentionally empty so the layout is visible on the filesystem.

Test plan (m1+):

- `tests/grave-scanner/` — Phase 1/Phase 2 evaluation flows, multi-epoch gating,
  `invalidate_anchor`, `sweep_stale_anchor` rent recovery, error-code coverage,
  locker-evidence supply (marker PDA + TokenLock enumeration) for both phases,
  launch-price attestation supply (ed25519 verify instruction + 168-byte
  message) for `record_launch_price`, and last-swap attestation supply
  (ed25519 verify instruction + 112-byte message + SlotHashes-anchored
  freshness) for both phases.
- `tests/grave-vault/` — `salvage_pool` 40 / 40 / 20 distribution math,
  `claim_lp_proceeds` Merkle proofs, emergency-pause semantics. The Raydium
  V4 withdraw itself is covered by the FORK HARNESS below (real mainnet
  bytecode, not a mock). (Priority-fee ceiling enforcement is SDK-side
  policy — covered by SDK unit tests, not program tests; see
  `docs/PROTOCOL_SPEC.md` D3.)
- `tests/integration/` — full certify-and-salvage flow exercising the
  Scanner → Vault handshake on `solana-test-validator`.

## Raydium V4 fork harness (Phase 2.1, CPI-009)

`programs/grave-vault/tests/raydium_v4_fork.rs` executes the real
`salvage_pool` instruction against the REAL mainnet Raydium V4, OpenBook and
SPL-token bytecode inside an in-process Solana VM (`solana-program-test`),
seeded with byte-for-byte mainnet state of the canonical Raydium SOL/USDC V4
pool. It proves: the 22-account withdraw ordering is accepted by the deployed
V4 program; a real LP burn + real reserve transfers execute end-to-end;
`vault_authority`'s roles; exact 40/40/20 settlement; and that scrambled /
malicious account submissions are rejected (by the vault's pre-flight where
the vault is the defence, and by the real V4 program where V4 is). Its dust
threshold is `u64::MAX`, so the conversion leg is skipped — it remains the
withdraw regression lock.

The harness forges exactly three things: the EligibilityCert PDA (serialised
with GraveScanner's own type), the salvor's LP balance, and the salvor's
lamports.

## Jupiter conversion fork harness (Phase 3, CPI-010 / SLIP-001)

`programs/grave-vault/tests/jupiter_conversion_fork.rs` runs the FULL
pipeline — withdraw leg AND conversion leg — in one transaction, against
real mainnet bytecode for TWO pool orientations:

- pool 1: SOL/USDC `58oQCh…` (coin = WSOL, `base_is_coin_side = true`),
- pool 2: RAY/WSOL `AVs9TA…` (pc = WSOL, the inverted orientation).

The Jupiter aggregator is exercised through `tests/jupiter_v6_stub/`, a
DOCUMENTED test-only program deployed at the pinned Jupiter v6 program id
inside the VM: it CPIs a real Raydium V4 `swapBaseIn` against the same
mainnet pool state and can fail deterministically. The vault forwards routes
verbatim and assumes nothing about route internals, so every defense proven
through the stub (route vetting, slippage ceiling, swap-leg floor) holds
against an arbitrary callee. The stub is never deployed anywhere.

The harness forges exactly four things: the EligibilityCert PDA, the
salvor's LP balance, the salvor's lamports, and the Jupiter stand-in itself.

Proven: the full LP -> Raydium -> memecoin -> Jupiter -> WSOL -> SOL ->
40/40/20 pipeline for both orientations with exact conservation; the
protocol slippage ceiling (a zero or losing floor reverts 7007 BEFORE the
swap; the per-tx override tightens it); route-account vetting (vault custody
accounts forbidden, WSOL destination required); hijacked destinations deliver
nothing; bad route data / failing aggregator revert atomically (7016);
orientation derived from pool bytes (no-WSOL pools revert 7019 pre-CPI;
foreign memecoin/LP mints revert 7013).

Setup and run:

```bash
# 1) build the vault program AND the Jupiter stand-in, copy both where the
#    harness looks — or run scripts/build_fork_harness.sh for all steps
cd programs/grave-vault && cargo build-sbf
cd tests/jupiter_v6_stub && cargo build-sbf
cp target/deploy/grave_vault.so tests/fixtures/grave_vault.so        # (repo-root target)
cp target/deploy/jupiter_v6_stub.so tests/fixtures/jupiter_v6_stub.so

# 2) fetch the mainnet fixtures (~7 MB, gitignored; both pools + 5 ELFs)
node scripts/fetch_v4_fork_fixtures.mjs     # from the repo root

# 3) run the fork suites
cargo test -p grave-vault --test raydium_v4_fork
cargo test -p grave-vault --test jupiter_conversion_fork
```

Without fixtures the fork tests SKIP with a message so CI stays green; the
host unit tests below never need fixtures or a network.

Host unit tests today (all `cargo test -p grave-scanner` / `-p grave-vault`):
90 total — scanner 81 (criteria 18 incl. the Phase 1.3 zero-baseline and
extreme-price boundary tests, attestation 31: 16 last-swap [Phase 1.2] +
15 launch-price [Phase 1.3], adapters 25: raydium_v4 layout 4 + locker 21
[Phase 1.1], cert lifecycle 5 [Phase 1.4: inclusive expiry boundary,
zeroed-fresh reissuability, live-cert gate, layout stability, borsh
reissue roundtrip], errors 1: the on-chain code lock test covering
6000–6034, plus anchor's `test_id`) and vault 9 (merkle 7 + errors 1 +
`test_id`; the merkle tests require the `solana-sha256-hasher` `sha2`
dev-dependency feature on host builds). Phase 3 adds 8 vault host tests
(slippage-cap derivation 3 + orientation derivation 5 — see
`salvage_pool.rs` `mod tests`). Every manipulated-baseline
vector — wrong oracle key, moved message offset, pool/mint/price binding
mismatch, zero price, zero/future first-swap timestamp and slot,
zero/future issued slot, truncated instruction data — is covered.

Run:

```bash
anchor test
```

Once `tests/package.json` exists this directory will join the pnpm workspace
(see `pnpm-workspace.yaml`).
