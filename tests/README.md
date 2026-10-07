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
the vault is the defence, and by the real V4 program where V4 is).

The harness forges exactly three things: the EligibilityCert PDA (serialised
with GraveScanner's own type), the salvor's LP balance, and the salvor's
lamports.

Setup and run:

```bash
# 1) build the vault program and copy it where the harness looks
cd programs/grave-vault
cargo build-sbf
cp target/deploy/grave_vault.so tests/fixtures/grave_vault.so   # (repo-root target)

# 2) fetch the mainnet fixtures (~3.2 MB, gitignored; ~23 RPC calls)
node scripts/fetch_v4_fork_fixtures.mjs     # from the repo root

# 3) run the fork suite
cargo test -p grave-vault --test raydium_v4_fork
```

Or all at once: `bash scripts/build_fork_harness.sh` (from the repo root).
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
dev-dependency feature on host builds). Every manipulated-baseline
vector — wrong oracle key, moved message offset, pool/mint/price binding
mismatch, zero price, zero/future first-swap timestamp and slot,
zero/future issued slot, truncated instruction data — is covered.

Run:

```bash
anchor test
```

Once `tests/package.json` exists this directory will join the pnpm workspace
(see `pnpm-workspace.yaml`).
