# Eligibility anchors and the two-phase model

How GraveScanner converts a one-time observation into manipulation-resistant,
multi-epoch certification — and why the anchor exists at all.

> **Scope.** This deep-dive explains the design rationale of the
> EligibilityAnchor / EligibilityCert lifecycle. The normative rules live in
> [`../PROTOCOL_SPEC.md`](../PROTOCOL_SPEC.md); instruction-level behavior is
> in [`../technical-documentation.md`](../technical-documentation.md) §3 and
> the combined reference
> [`../grave-scanner-grave-vault-combined.md`](../grave-scanner-grave-vault-combined.md).

## 1. The problem: terminal state must be confirmed, not observed

A derelict pool is a pool whose terminal state has persisted. Any single
point-in-time observation can be manufactured: a validator can skew clock
sysvars within bounded tolerance, a pool can experience a transient lull in
swaps, and a parameter change between observation and settlement could
silently alter what "eligible" means. Certifying a pool for settlement — an
operation that permanently removes its liquidity — on the basis of one
observation would make the entire protocol hostage to timing artifacts.

The two-phase model answers with a consensus-native commitment device: the
**EligibilityAnchor**. Phase 1 records *when a pool first satisfied all six
criteria*; Phase 2, executed no earlier than two consecutive Solana epochs
later (roughly 4–6 days), re-runs the identical evaluator and additionally
requires the criteria bitmap to equal the anchor's bitmap. Only Phase 2
mints the **EligibilityCert** that GraveVault's `salvage_pool` consumes.

## 2. Anchor anatomy

The EligibilityAnchor PDA is derived as
`["eligibility_anchor", amm_program_id, pool_address]` and records:

| Field | Purpose |
|-------|---------|
| `first_eligible_epoch` | The Solana epoch in which Phase 1 observed all six criteria passing. Phase 2 computes `current_epoch - first_eligible_epoch` against the confirmation minimum. |
| `criteria_bitmap` | The exact evaluator result at Phase 1 (`0x3F` for a passing pool). Phase 2 must reproduce it bit-for-bit. |
| `writer` | The account that paid rent for the anchor; `sweep_stale_anchor` returns that rent. |
| `invalidated` | Set by authority via `invalidate_anchor`. An invalidated anchor can never lead to a certificate. |

Deliberate design points:

- **No state on failure.** If Phase 1 evaluation fails any criterion, nothing
  is written. The anchor only ever records a full pass, so its existence is
  itself evidence.
- **Permissionless creation, authority-gated destruction.** Anyone can run
  Phase 1; only authority can invalidate an anchor. This keeps certification
  permissionless end-to-end while giving governance a kill switch against
  grief anchors.
- **Deterministic PDA.** One anchor per (AMM program, pool). Re-running
  Phase 1 on a pool with a live anchor does not reset its clock.

## 3. Phase 2: re-evaluation with bitmap equality

Phase 2 is not a diff against the anchor's stored data — it is a **full
re-run of the evaluator** with a **fresh 112-byte C1 attestation**. The
original attestation from Phase 1 has necessarily aged out of the
SlotHashes freshness window (~512 slots) long before the epoch gap elapses,
so Phase 2 cannot replay old evidence even if it wanted to.

The bitmap-equality requirement (error `CriteriaBitmapMismatch`, 6011)
closes the parameter-drift vector: if any threshold, oracle key or adapter
behavior changed between Phase 1 and Phase 2 such that the evaluator would
now produce a different result, certification fails entirely and the pool
must re-enter Phase 1. An eligibility rule that changes mid-flight resets
certification — it never silently carries forward.

This also protects LP holders from premature settlement: a pool that
re-floats (renewed trading, a liquidity add, a locker appearing) fails
re-certification, and the anchor's epoch clock does not help the salvor —
Phase 2 must pass *now*, not merely have passed once.

## 4. Certificate semantics

The EligibilityCert PDA (`["eligibility_cert", amm_program_id,
pool_address]`) is the only object GraveVault trusts. Its properties:

- **TTL.** Default one hour, governance-configurable with a hard floor of
  ten minutes (`CertTtlBelowMinimum`, 6019). A short TTL bounds the window
  between certification and settlement, limiting exposure to state drift
  (reserves moving, LP supply changing, locks appearing).
- **Live certs are immutable.** Re-running Phase 2 while a cert is still
  live fails with `CertStillValid` (6034). Two live certs for one pool are
  structurally impossible.
- **Expired certs reissue in place.** After the TTL elapses, Phase 2 may
  re-run the full stack (fresh C1, all six criteria, bitmap equality) and
  reissue the cert, bumping `reissue_generation` (spec D10). Reissuance
  never waives any check — it is a fresh certification with a fresh
  timestamp, not an extension.
- **One consumption.** `salvage_pool` validates freshness, program binding,
  pool binding and the full `0x3F` bitmap, then the init-once PoolRegistry
  and SalvageReceipt PDAs ensure the cert can fund exactly one settlement,
  ever.

## 5. Anchor housekeeping

Stale anchors would otherwise accumulate as unreclaimable rent. Two paths
exist:

| Path | Access | Effect |
|------|--------|--------|
| `sweep_stale_anchor` | Permissionless, after `anchor_staleness_seconds` (default 14 days) | Closes an anchor that never reached Phase 2; rent returns to the original writer. Error `AnchorNotStale` (6018) fires early. Confers no salvage rights. |
| `invalidate_anchor` | Authority, any time before Phase 2 | Marks the anchor invalid; certification via this anchor becomes impossible (`AnchorInvalidated`, 6017). |

Neither path touches a pool's actual liquidity. Housekeeping is purely a
state-hygiene concern, which is why it can be permissionless.

## 6. What the two-phase model does not defend against

Honesty about limits, consistent with the protocol's documented-boundaries
posture:

- **Oracle honesty.** Both phases consume oracle-attested evidence. The
  epoch gap makes fabricated *activity* expensive to sustain across
  consensus windows, but a dishonest activity oracle that lies about
  last-swap timestamps in both phases defeats the scheme. Key custody,
  rotation and monitoring are tracked as ORACLE-003 in
  [`../PRE_MAINNET_CHECKLIST.md`](../PRE_MAINNET_CHECKLIST.md).
- **Off-chain snapshot timing.** The anchor certifies pool *state*
  criteria; LP-holder balances are certified separately by the snapshot
  contract at settlement time (see the combined reference §5.4).
- **Adjacent-pool effects.** Certification is per-pool. Coordinated
  manipulation of an entire pool's *reserves* (e.g., a large LP adding and
  removing across both phases) is economically bounded by C3/C4/C5 but not
  made impossible by the anchor mechanism alone; the bitmap equality and
  epoch gap raise its cost, and the settlement-time checks (freshness,
  supply parity) close the residual gap at execution.
