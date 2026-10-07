# tests

Integration tests for GraveYield. Anchor + ts-mocha harness lands in milestone m1
alongside the first real instruction handlers. Until then this directory is
intentionally empty so the layout is visible on the filesystem.

Test plan (m1+):

- `tests/grave-scanner/` — Phase 1/Phase 2 evaluation flows, multi-epoch gating,
  `invalidate_anchor`, `sweep_stale_anchor` rent recovery, error-code coverage,
  locker-evidence supply (marker PDA + TokenLock enumeration) for both phases,
  and last-swap attestation supply (ed25519 verify instruction + 112-byte
  message + SlotHashes-anchored freshness) for both phases.
- `tests/grave-vault/` — `salvage_pool` happy path against a mocked Raydium V4
  pool, 40 / 40 / 20 distribution math, `claim_lp_proceeds` Merkle proofs,
  emergency-pause semantics. (Priority-fee ceiling enforcement is SDK-side
  policy — covered by SDK unit tests, not program tests; see
  `docs/PROTOCOL_SPEC.md` D3.)
- `tests/integration/` — full certify-and-salvage flow exercising the
  Scanner → Vault handshake on `solana-test-validator`.

Host unit tests today (all `cargo test -p grave-scanner` / `-p grave-vault`):
56 total — 41 pre-existing (criteria 14, raydium_v4 layout 4, scanner errors 1,
vault merkle 7, vault errors 1, plus 14 Phase 1.1 locker-adapter tests) + 15
attestation-module tests (stale pool, recently active pool, and every
manipulated-timestamp vector) including the expanded error-code lock test
covering 6024–6031.

Run:

```bash
anchor test
```

Once `tests/package.json` exists this directory will join the pnpm workspace
(see `pnpm-workspace.yaml`).
