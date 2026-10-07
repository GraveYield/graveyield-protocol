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
- `tests/grave-vault/` — `salvage_pool` happy path against a mocked Raydium V4
  pool, 40 / 40 / 20 distribution math, `claim_lp_proceeds` Merkle proofs,
  emergency-pause semantics. (Priority-fee ceiling enforcement is SDK-side
  policy — covered by SDK unit tests, not program tests; see
  `docs/PROTOCOL_SPEC.md` D3.)
- `tests/integration/` — full certify-and-salvage flow exercising the
  Scanner → Vault handshake on `solana-test-validator`.

Host unit tests today (all `cargo test -p grave-scanner` / `-p grave-vault`):
85 total — scanner 76 (criteria 18 incl. the Phase 1.3 zero-baseline and
extreme-price boundary tests, attestation 31: 16 last-swap [Phase 1.2] +
15 launch-price [Phase 1.3], adapters 25: raydium_v4 layout 4 + locker 21
[Phase 1.1], errors 1: the on-chain code lock test covering 6000–6033,
plus anchor's `test_id`) and vault 9 (merkle 7 + errors 1 + `test_id`;
the merkle tests require the `solana-sha256-hasher` `sha2`
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
