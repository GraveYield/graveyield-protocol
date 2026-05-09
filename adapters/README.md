# adapters/

Locker adapters for third-party LP-locker programs. Each adapter provides a
uniform interface that GraveScanner uses for **Criterion 5 — LP must NOT be
locked** and that future tooling uses for read-side queries.

| Adapter | Locker | Status |
|---------|--------|--------|
| `uncx/`        | UNCX Network        | Future (m10) |
| `pinksale/`    | PinkSale            | Future (m10) |
| `teamfinance/` | Team Finance        | Future (m10) |

## Adapter contract

Each adapter exports:

```rust
pub trait LockerAdapter {
    fn program_id() -> Pubkey;

    /// Returns true if the supplied LP token account is locked under this
    /// program at the given slot.
    fn is_lp_locked(
        ctx: &LockerCtx,
        lp_mint: &Pubkey,
        pool_address: &Pubkey,
    ) -> Result<bool>;
}
```

## Why future?

Phase 0 (m1-m8) targets Raydium V4 only with a hardcoded "no lock detected"
branch — the early salvor population can verify lock status off-chain. The
adapter layer matters once we expand AMM support and need a uniform on-chain
check across multiple lockers.
