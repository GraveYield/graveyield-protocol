# tests

Integration tests for GraveYield. Anchor + ts-mocha harness lands in milestone m1
alongside the first real instruction handlers. Until then this directory is
intentionally empty so the layout is visible on the filesystem.

Test plan (m1+):

- `tests/grave-scanner/` — Phase 1/Phase 2 evaluation flows, multi-epoch gating,
  `invalidate_anchor`, `sweep_stale_anchor` rent recovery, error-code coverage.
- `tests/grave-vault/` — `salvage_pool` happy path against a mocked Raydium V4
  pool, 40 / 40 / 20 distribution math, `claim_lp_proceeds` Merkle proofs,
  emergency-pause semantics, priority-fee ceiling enforcement.
- `tests/integration/` — full certify-and-salvage flow exercising the
  Scanner → Vault handshake on `solana-test-validator`.

Run:

```bash
anchor test
```

Once `tests/package.json` exists this directory will join the pnpm workspace
(see `pnpm-workspace.yaml`).
