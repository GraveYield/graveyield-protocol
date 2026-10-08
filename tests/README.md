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

## Settlement-economics fork harness (Phase 4, D6/D7)

`programs/grave-vault/tests/settlement_economics_fork.rs` runs the REAL
`salvage_pool`, the new `sweep_dust`, `claim_lp_proceeds`, and
`emergency_pause` against the same real mainnet bytecode / pool 1 fixtures.
Seven tests prove the settlement economics end-to-end:

- D6 dust policy: the dust-skip salvage records `memecoin_mint` +
  `dust_memecoin_lamports` on the receipt and settles EXACTLY the
  withdraw-side WSOL; `sweep_dust` then moves the exact amount to the
  protocol treasury's ATA, closes the vault ATA (exact rent delta to the
  caller), stamps the receipt, and never touches the LP bucket; the
  one-shot matrix (second sweep; fully-converted pool 7020); a hijacked
  sweep destination fails with zero state movement and the legitimate
  sweep still succeeds (atomicity).
- D7 invariant: exact conservation with the default 40/40/20 AND a custom
  asymmetric config (lp=4001 / salvor=4000 / protocol=1999) — the floor
  roundings accrue to the protocol share by construction.
- Claims economics: a real 3-holder Merkle tree (60/30/10) drains the LP
  bucket to the lamport (`floor(lp_share × balance / supply)` per holder,
  cumulative cap, rounding remainder stays in the vault), double claims
  fail, and claims stay LIVE during emergency pause (Charter).

The harness forges exactly five things: the EligibilityCert PDA, the
salvor's LP balance, the salvor's/holders'/sweeper's lamports, the Jupiter
stand-in, and the off-chain LP-holder snapshot (the Merkle tree an honest
snapshotter would produce — the snapshotter and its Merkle/artifact
machinery shipped in Phases 5.1–5.2, `snapshotter/`; the on-chain
verifier is the code under test).

## LP-holder snapshotter (Phases 5.1–5.2)

`snapshotter/` — the `grave-snapshotter` crate — is the off-chain producer
of the LP-holder snapshot whose `(holder, balance)` entries feed the
`claim_lp_proceeds` Merkle verifier. Determinism is the contract:
per-owner aggregation over ascending pubkey bytes, lock records sorted by
address, no ambient state — same ledger state in, bit-identical snapshot
out. The builder enforces `Σ enumerated balances == lp_mint.supply` as a
completeness gate, closes the token ledger with `entries_total +
sink_exclusions_total == enumerated_total`, identifies the UNCX custody
account by exact-balance reconciliation (fail-closed on ambiguity), and
attributes locked LP to the beneficial `TokenLock.lock_owner` (spec D11).
53 host tests (38 lib + 15 integration) cover the pipeline without a
network; the integration suite pins the leaf-format compatibility with
`grave_vault::merkle::compute_leaf` (via independent SHA-256) and
equality of the UNCX constants with the scanner adapter.

Phase 5.2 completes the claims machinery (spec D12, SNAPSHOT-001
retired): `tree::SnapshotMerkleTree` seals the canonical leaf set into
the root under the fork-proven convention — sorted-pair SHA-256, odd
node promotes unchanged, a promotion contributes no proof element — with
the 3-leaf root AND proofs bit-locked against the fork suite's
`build_three_leaf_tree` (`settlement_economics_fork.rs`) and every
generated proof tested against the on-chain `verify_proof` across 12
tree sizes. `artifact::SnapshotArtifact` persists the publishable claims
metadata (pool/mint/slot/supply, root, per-holder balance + leaf +
ready-to-submit proof) as deterministic JSON (base58 pubkeys, hex
hashes) that re-derives its own integrity from its entries
(`verify_integrity`, fail-closed on any drift).

## LP claims fork harness (Phase 5.3 — the exit condition)

`programs/grave-vault/tests/lp_claim_fork.rs` closes Phase 5: it retires
the Phase 4 suite's forged-snapshot stand-in and drives the claim path
END-TO-END through the real `grave-snapshotter` producer, against the
same real mainnet bytecode / pool 1 fixtures. The lifecycle it executes:

    VM ledger (read live) → SnapshotBuilder → SnapshotMerkleTree →
    SnapshotArtifact (JSON round-trip = publication) → salvage_pool seals
    the artifact root → claim_lp_proceeds with the artifact proofs → SOL
    in the holder's wallet

Five tests, one per roadmap acceptance item:

- **Claim successfully**: five claimants — the four wallets plus the
  SALVOR (D11 policy 2: the salvor's pre-burn balance is an ordinary
  leaf) — each receive exactly `floor(bucket × balance / supply)`,
  wallet → proof → claim → SOL with no manual steps, including the
  promotion shapes the real tree builder emits for a 5-leaf set.
- **Reject invalid proof**: swapped sibling, truncated proof, forged
  element, and a wrong-signer submission all revert 7010 with zero state
  movement; the honest claim succeeds afterwards (positive control).
- **Reject duplicate claim**: the ClaimRecord init constraint rejects the
  second claim with zero movement.
- **Reject overclaim**: an inflated `lp_balance_at_snapshot` breaks its
  own Merkle leaf (7010); a dishonest snapshotter that seals an
  oversubscribed tree runs into the cumulative conservation cap (7009) —
  both the single-shot payout-above-bucket shape and the cumulative
  cross-holder drift.
- **Verify cumulative accounting**: `Σ ClaimRecord.amount ==
  registry.lp_holder_pool_claimed_lamports == Σ floors recomputed from
  the artifact alone`; the vault keeps exactly rent + (bucket − claimed)
  — the sink-excluded pool-LP custody share plus the claim-side rounding
  dust, ledgered and unclaimable (D11).

The harness forges exactly five things: the EligibilityCert PDA, the
salvor's LP balance, the claimants' lamports, the Jupiter stand-in, and
the VM's LP-token ledger SHAPE (the canonical pool's real supply is
spread over thousands of mainnet holder accounts the sandbox cannot
host, so the harness seeds one pool-LP custody account — owner = the
real Raydium AMM authority, a PDA that can never sign, the exact shape
the D11 sink exclusion exists for — plus the five claimant wallets; the
UNCX locker evidence is honestly empty because no locker state exists in
the VM). The snapshot itself is taken from live VM reads through the
same source seam an RPC serves, so the snapshotter's `Σ balances ==
supply` completeness gate runs for real. (Phase 6 retires the first of
these stand-ins — see below.)

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
cargo test -p grave-vault --test settlement_economics_fork
cargo test -p grave-vault --test lp_claim_fork
cargo test -p grave-vault --test full_lifecycle_fork
```

Without fixtures the fork tests SKIP with a message so CI stays green; the
host unit tests below never need fixtures or a network.

## Full-lifecycle fork harness (Phase 6 — the first complete integration test)

`programs/grave-vault/tests/full_lifecycle_fork.rs` closes Phase 6: ONE test
executes the ENTIRE GraveYield lifecycle against the same real mainnet
bytecode / pool 1 fixtures, and asserts every state transition:

    candidate pool (real AmmInfo) → GraveScanner initialize →
    record_launch_price (C2, oracle-signed 168B attestation) →
    evaluate_pool_phase_1 (C1, indexer-signed 112B attestation; six
    criteria over the real pool bytes) → EligibilityAnchor →
    multi-epoch warp (≥ MIN_EPOCH_CONFIRMATION) →
    evaluate_pool_phase_2 (fresh C1 attestation, bitmap equality) →
    EligibilityCert → snapshot (real snapshotter over the live ledger) →
    tree → sealed artifact → JSON publication → salvage_pool (real
    withdraw CPI + Jupiter stand-in conversion + 40/40/20; artifact root
    sealed) → claim_lp_proceeds ×5 → SOL in every wallet → closing
    identity chain

The Phase 2.1–5.3 suites' forged-EligibilityCert stand-in is RETIRED here:
the cert that authorizes salvage is issued by the real `grave-scanner`
program running as BPF in the same VM, and both attestation legs execute
through the runtime's actual `ed25519_program` precompile verification (a
bad signature aborts the transaction before the scanner ever runs).
Running this suite is what surfaced (and the same commit fixes) the
scanner's precompile wire-contract bug — the previously shipped 14-byte
offset header is not a format any Solana runtime accepts; see
`grave-scanner/src/attestation.rs` and spec rev 1.10.0. The SDK's
attestation builders were corrected to the same runtime layout in the same
commit.

The remaining harness stand-ins are the same as Phase 5.3's minus the cert:
the seeded claim-side ledger shape, the claimants' lamports, and the
Jupiter stand-in. The withdraw-leg economics are measured on a disposable
VM that runs the SAME full scanner path with the conversion leg disabled
(the Phase 5.3 measurement pattern, upgraded to the honest boot). The
scanner's governance thresholds are configured explicitly in the test
(they are governance parameters) and the evidence authorities are test
keypairs, exactly as in production the indexer/oracle keys are registered
at initialize.

Setup and run: identical to the other fork suites, plus the scanner build:

```bash
# or run scripts/build_fork_harness.sh for all steps
cd programs/grave-scanner && cargo build-sbf
cp target/deploy/grave_scanner.so ../grave-vault/tests/fixtures/   # (repo-root target)
cargo test -p grave-vault --test full_lifecycle_fork
```

Host unit tests today (all `cargo test -p grave-scanner` / `-p grave-vault`
/ `-p grave-snapshotter`): 156 total — scanner 81 (criteria 18 incl. the Phase 1.3 zero-baseline and
extreme-price boundary tests, attestation 31: 16 last-swap [Phase 1.2] +
15 launch-price [Phase 1.3], adapters 25: raydium_v4 layout 4 + locker 21
[Phase 1.1], cert lifecycle 5 [Phase 1.4: inclusive expiry boundary,
zeroed-fresh reissuability, live-cert gate, layout stability, borsh
reissue roundtrip], errors 1: the on-chain code lock test covering
6000–6034, plus anchor's `test_id`) and vault 9 (merkle 7 + errors 1 +
`test_id`; the merkle tests require the `solana-sha256-hasher` `sha2`
dev-dependency feature on host builds). Phase 3 adds 8 vault host tests
(slippage-cap derivation 3 + orientation derivation 5 — see
`salvage_pool.rs` `mod tests`). Phase 4 adds 5 more (D7 split rounding 4
+ receipt layout stability 1 — `salvage_pool.rs` / `salvage_receipt.rs`
`mod tests`), bringing vault to 22. Phase 5.1 adds 30 in the new
`grave-snapshotter` crate (22 lib + 8 integration — see the snapshotter
section above), bringing the host total to 134. Phase 5.2 adds 23 more
in the same crate (16 lib + 7 integration — the Merkle tree/proof
builder and the sealed artifact), bringing the host total to 156.
Phase 5.3 adds no host tests; it adds the `lp_claim_fork` fork suite
(5 tests — the claims lifecycle on the real snapshotter path), taking
the fork-suite total from 29 to 34. Phase 6 adds no host tests either
(the attestation constants lock-test values are updated in place); it
adds the `full_lifecycle_fork` fork suite (1 test — the complete
lifecycle), taking the fork-suite total to 35. Every
manipulated-baseline
vector — wrong oracle key, moved message offset, pool/mint/price binding
mismatch, zero price, zero/future first-swap timestamp and slot,
zero/future issued slot, truncated instruction data — is covered.

Run:

```bash
anchor test
```

Once `tests/package.json` exists this directory will join the pnpm workspace
(see `pnpm-workspace.yaml`).
