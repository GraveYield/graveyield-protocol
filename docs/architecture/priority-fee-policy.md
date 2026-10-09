# Priority-fee policy — Charter ceiling + operator margin

How a salvage transaction pays for priority without ever letting the fee
become a profit-signal for the protocol, and where each rule is enforced.

> **Scope.** The normative source is
> [`../PROTOCOL_SPEC.md`](../PROTOCOL_SPEC.md) decision **D3**; the on-chain
> config surface and its reserved error are in
> [`../error_codes.md`](../error_codes.md) (7008). The implementation lives
> in the TypeScript SDK (`sdk/src/priorityFee.ts` in this repository, and
> the fleet-hardened copy in the `GraveYield/salvor-bots` repository).

## 1. The rule

GraveYield treats transaction priority fees as an **operational cost of
salvage**, never as a bid for settlement rights. Two constraints apply
together (spec D3):

1. **Total fee budget** — the salvage transaction's entire priority-fee
   spend must stay within a fixed fraction of its expected profit:
   `total_budget = floor(margin × expected_profit)`.
   The default operational margin is 25% of expected profit.
2. **Per-CU ceiling** — the compute-unit price must not exceed the Charter
   ceiling configured in the Vault's `ProtocolConfig`
   (`max_priority_fee_ceiling_lamports`, devnet default 1,000,000,000).

The fee plan is therefore `min(derived per-CU price, ceiling)`, and a
salvage whose budget cannot fund a meaningful priority fee at all is
rejected client-side — if there is no headroom, the salvage is not worth
racing.

## 2. Units: the documented naming drift

The Vault config field is *named* `max_priority_fee_ceiling_lamports` —
"lamports" — but it is *consumed* as **micro-lamports per compute unit**
via `setComputeUnitPrice`, which is the unit the Solana runtime prices
compute units in. The SDK's usage is authoritative; the spec's "lamports/CU"
wording is a naming drift that is documented here rather than silently
reinterpreted. Practical consequence: the devnet default of 1,000,000,000
is 1e9 micro-lamports/CU = 1 lamport/CU = 1 SOL of fee per 1,000,000,000
compute units — a generous devnet-scale ceiling, not a per-transaction
lamport budget.

## 3. The math (fleet-hardened form)

The `GraveYield/salvor-bots` fleet workspace ships `derivePriorityFeePlan`,
the D3-correct integer implementation, with the SDK's BN-only arithmetic
rules preserved (no float ever touches a lamport amount):

```
total_budget      = floor(margin_bps × expected_profit / 10_000)
price_per_cu_raw  = floor(total_budget × 1_000_000 / compute_unit_limit)
price_per_cu      = min(price_per_cu_raw, ceiling_micro_lamports_per_cu)
```

Both divisions are BN integer floors; `margin` is quantised to basis points
so no floating-point value participates in the computation. The
`compute_unit_limit` input is the transaction's actual compute-budget limit
— deriving a per-CU price against an assumed limit and then letting the
transaction carry a different limit is exactly the unit-mismatch class of
bug this function exists to prevent.

**Worked example.** Expected profit 2,000,000 lamports (0.002 SOL), margin
25%, compute-unit limit 700,000 (the worst-case salvage estimate), ceiling
1,000,000,000 µlamports/CU:

- `total_budget = floor(2,500 × ... )` → `floor(0.25 × 2,000,000)` =
  500,000 lamports total.
- `price_per_cu_raw = floor(500,000 × 1,000,000 / 700,000)` = 714,285
  µlamports/CU.
- Below the ceiling → plan is 714,285 µlamports/CU; total spend at exactly
  700,000 CU ≈ 499,999 lamports ≈ the budget. Conservation holds.

## 4. The legacy helper and its hazard

This repository's SDK still exports
`computeOperationalMaxLamportsPerCu(expectedProfitLamports, ceiling,
marginRatio)`. **Its semantics are a known unit mismatch** (fleet audit
finding F1): it returns `margin × expected_profit` — a *total* lamport
amount — and compares it directly against a *per-CU* ceiling, so the result
is only meaningful by coincidence when a transaction's compute-unit limit
happens to be ~1,000,000 and the two units blur. For any other limit the
"per-CU" value it produces is wrong by `compute_unit_limit / 1_000_000`.

Status:

- In `salvor-bots` (fleet workspace), the helper is **deprecated with a
  hazard doc** and `derivePriorityFeePlan` is the supported path; fleet bots
  and the shared pipeline use the D3-correct function exclusively.
- In this repository the legacy function remains the only implementation,
  pending the next SDK mirroring pass. Consumers here should treat its
  output as a *total budget* and derive the per-CU price themselves (§3),
  or wait for the mirror rather than building on the mismatched unit.

## 5. Enforcement boundary: SDK/operator only

A callee program cannot observe the compute-unit price a transaction
carried; the runtime consumes it before invocation. The Charter ceiling is
therefore **not bytecode-enforced** — the on-chain error
`PriorityFeeExceedsCeiling` (7008) is *reserved* and never raised in v1.0.
Enforcement lives in:

- the SDK hard-fail predicate (`shouldRejectFee`: reject when a proposed
  price exceeds either the operational max or the Charter ceiling),
- operator policy in every bot that submits salvage transactions, and
- review discipline: any code path that attaches `setComputeUnitPrice`
  must derive its value from a fee plan, never from an inline constant.

This is the same documented-boundaries posture as the 72-hour timelock
(GOV-001): the commitment is real, its enforcement layer is named, and no
documentation claims bytecode guarantees that do not exist. The settlement
economics themselves are unaffected — priority fees are paid by the salvor
out of the salvor's share and never touch the 40 / 40 / 20 split of
*recovered* lamports.

## 6. Interaction with the rest of the pipeline

- **Estimator.** A salvage is only attempted when expected profit clears
  the base fee + priority-fee plan + rent + failure-cost model (see the
  combined reference and the fleet estimator). The fee plan is an input to
  that decision, not an afterthought.
- **Compute budget.** Worst-case salvage compute is ~700K CU (two-phase
  evaluation excluded; that is certification-side). Limit-setting belongs
  to the transaction assembly, and the per-CU price must be derived against
  the same limit that ships in the transaction (§3).
- **Charter.** Nothing here can raise the protocol's 20% share or convert
  fees into protocol revenue — see
  [`charter-invariants.md`](charter-invariants.md) invariant 1.
