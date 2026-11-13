# Fixture provenance — last-swap evidence tests (IMPL-001)

All `tx_*.json` fixtures are REAL mainnet-beta transactions, fetched
read-only (`getTransaction`, commitment `finalized`) on 2026-11-14 from
`https://api.mainnet-beta.solana.com` (fallback `solana-rpc.publicnode.com`).
No fixture contains synthetic transaction evidence presented as real; the
only synthetic cases are built IN TEST CODE from these real fixtures by the
labeled mutations documented below, and each mutation's purpose is stated
next to its test.

The pool for every fixture is the canonical Raydium V4 SOL/USDC AMM
`58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2` (AmmInfo owner
`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`); authoritative vaults from
`pool_account_sol_usdc.json` (offsets 336/368 of the 752-byte AmmInfo):
coin vault `DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz` (wSOL),
pc vault `HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz` (USDC).

Reduced committed form: `wireBase64` (byte-exact transaction wire),
`meta.err`, `meta.innerInstructions` (instruction `data` as base58 strings —
the exact surface the RPC returns), `meta.loadedAddresses` (base58), and
`meta.preTokenBalances` / `meta.postTokenBalances`. Full raw payloads and
the fetch scripts are retained in the IMPL-001 deliverables workspace; each
fixture can be independently re-fetched and re-verified with:

```
curl https://api.mainnet-beta.solana.com -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":["<SIGNATURE>",{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":4}]}'
```

| file | signature | slot | blockTime | tx version | Raydium V4 content |
| --- | --- | --- | --- | --- | --- |
| `tx_swap_base_in_v2_outer_legacy.json` | `tsq9Gs64x14oX5KDMkP35QFKQt4dsxeeoHFF6k8dKHyKqgYpuPNjiXQh9791C834AZYVKjK59VnnAErXgZoxexb` | 469047084 | 1794598900 | legacy | direct (outer) `SwapBaseInV2` (tag 16) |
| `tx_swap_base_in_inner_v1.json` | `3cuRQ8M9bYE8eTSqBYJuRgBQkrcM6RUfcr52pw78SnUQtFahA23tagxEYiAB6vm1G5Ln9woLjdv64kn4kBomNkd7` | 469047074 | 1794598898 | 1 | `SwapBaseIn` (tag 9) as an inner CPI instruction |
| `tx_swap_base_in_v2_inner_v1.json` | `3ZyYFgizS3xm1VqM56WGoRSXfBqFzm6yf5Ly4Qkd4ma8GDPyUbrikMcSSshyVMFhVctbRMfwttcqshNcFN4Xzair` | 469047033 | 1794598889 | 1 | `SwapBaseInV2` (tag 16) as an inner CPI instruction |
| `tx_failed_swap_inner_v1.json` | `pNVy3tzUUaQdJamVHjev6GuimGsLSd4kR4poAVduidgFrvf6PfFZr7JJ7X5QdnYfeucLQniPTUwKqr2i6Bi7FxN` | 469047962 | 1794599090 | 1 | FAILED transaction (`meta.err = InstructionError [1] Custom(13)`), swap-tagged V4 instruction present |
| `tx_swap_v0_alt_lookup.json` | `5TUr6fM5gjkDkSg4pKLTBD99mPZtA9pSWhMD1A89gg4StvSq9ymntYyoXY1rno4yoJkuobqf2uVKe8yjaMiXXYED` | 469049187 | 1794599355 | 0 | version-0 transaction with 1 address-lookup-table lookup (6 loaded writable + 13 loaded readonly keys); the pool is referenced by program `6Vo3245e...` (tag 175), NOT by the AMM program — vault balances unchanged. Real evidence for ALT key resolution and `pool_not_invoked_by_amm_program`. |
| `pool_account_sol_usdc.json` | — (account snapshot) | — | — | — | 752-byte AmmInfo via `getAccountInfo` (base64) |

Signatures are also visible in each fixture's own `provenance` block
(endpoint, method/params, `fetchedAtUtc`, and the crude tag inspection
recorded at fetch time).

## Synthetic cases

Every synthetic edge case in `lastSwapEvidence.test.ts` is produced from
one of the REAL fixtures above by a small, deterministic, code-level
mutation applied to the parsed response object. None of them is committed
as if it were production evidence. Mutation inventory:

* tag replacement on the real V4 instruction (`deposit` 3, `withdraw` 4,
  `initialize2` 1, `setParams` 6, `withdrawPnl` 7,
  `withdrawExcessLamports` 18, unknown tag 200, removed tag 2) — validates
  the non-economic and ambiguous classification branches;
* vault-delta zeroing / token-balance removal — validates
  `conflicting_evidence` and `incomplete_rpc_response`;
* block-time removal / future skew (signature-status level) — validates
  `block_time_missing` / `block_time_invalid`;
* `confirmationStatus` override (`confirmed`) — validates the ADR D5
  finalized-only gate;
* program-id replacement on the real V4 instruction — validates
  `pool_not_invoked_by_amm_program`;
* out-of-bounds program-id index — validates
  `malformed_transaction_metadata`;
* missing transaction (fake RPC returns null) — validates
  `transaction_data_missing`.
