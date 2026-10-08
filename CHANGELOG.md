# Changelog

## [Unreleased — Phase 11 (Protocol scope, run ahead of Phases 8-10 by owner call): devnet launch kit — real program IDs, identity-gated deployment tooling, and the rehearsed emergency-control drill]

### Added
- **Devnet program IDs are real keypairs.** The keyless SHA-256-derived
  placeholder IDs were undeployable by construction (nobody holds their
  secret). Real devnet keypairs were generated OUTSIDE the repository
  (never in git; `target/deploy/` copies are gitignored) and synced across
  the full surface: both `declare_id!` calls, every `Anchor.toml` program
  section, and the six fork suites that derive scanner PDAs
  (`raydium_v4_fork`, `jupiter_conversion_fork`,
  `settlement_economics_fork`, `lp_claim_fork`, `scanner_windows_fork`,
  `security_negative_fork`). KEYS-003 reworded to track the remaining gap
  (mainnet ships fresh custody-generated keypairs; devnet keys are
  throwaways and MUST NOT be reused). No program logic changed, no error
  codes changed, no spec rev bump — program IDs are deployment facts, not
  protocol semantics.
  - GraveScanner devnet ID: `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF`
  - GraveVault devnet ID: `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6`
- **`scripts/devnet/` — new internal workspace package
  `@graveyield/devnet-tools`** (private, unpublished; `pnpm-workspace.yaml`
  + lockfile updated):
  - `protocol_admin.mjs` — devnet/rehearsal administration with no IDL
    dependency: Anchor discriminators via `sha256("global:<name>")[0..8]`,
    hand-rolled borsh for both `InitializeParams` shapes, `["protocol_config"]`
    PDA derivation, full borsh readback of BOTH `ProtocolConfig` layouts
    (field offsets hand-derived from the state structs, account
    discriminator verified, not just fields), and a compact error-name
    mirror of `docs/error_codes.md`. Commands: `init-scanner` / `init-vault`
    / `init-all` / `pause` / `check` / `drill`.
  - `deploy_devnet.sh` — identity-gated build + deploy: refuses to run when
    a keypair's pubkey does not match the compiled `declare_id!` (an ELF
    deployed under a foreign address would fail every Anchor owner check),
    when the deployer holds < 2 SOL, or when `target/deploy` holds a stale
    keypair from a different identity. Builds via `cargo build-sbf`
    per package, deploys via `solana program deploy` with the matching
    `--program-id` keypair.
  - `local_rehearsal.sh` — the whole devnet sequence (deploy → init-all →
    both drills) executed against a bare `solana-test-validator` using the
    production scripts, with throwaway payer/intruder keys minted into a
    `mktemp` dir and discarded.
- **`docs/DEVNET.md`** — the devnet runbook: network facts, key-custody
  policy (devnet throwaways vs mainnet custody keys), prerequisites, the
  gated deployment stages, the initialization defaults table for both
  configs, the five-step emergency-control drill, the rehearsal path, and
  the explicitly out-of-scope items (Phase 8-10 infrastructure; controlled
  salvage scenarios). Registered under the new `## Operations` section of
  `docs/README.md` and in `scripts/README.md`.

### The emergency-control drill (Phase 11: "emergency controls tested")
Per program, `drill` asserts the full spec behavior on a live chain:
(1) freshly initialized config readback — authority, every default from
`constants.rs`, unpaused; (2) authority pauses; (3) readback asserts the
flag flipped; (4) an intruder keypair attempts pause and the transaction
MUST revert with that program's `Unauthorized` (GraveScanner 6000 /
GraveVault 7000) — a silent land fails the drill; (5) authority unpauses;
readback asserts restoration. The drill ran green on both programs in the
test-validator rehearsal; the identical commands are the devnet handover
step (see `docs/DEVNET.md` §3).

### Deployment status (honest note)
The producing sandbox is faucet-rate-limited (CLI airdrop and the public
JSON faucet both reject its IP), so the on-chain devnet deployment is
handed over as a funded-wallet step of the already-proven sequence —
`docs/DEVNET.md` §1 is copy-paste ready. Everything except the network
transfer is proven: the ELFs build under the real IDs, the identity gates
hold, and deploy/initialize/pause/intruder-reject/unpause all behave per
spec in the local rehearsal.

## [Unreleased — Phase 7: security hardening — fuzz, invariant, and adversarial account testing across both programs and the full fork harness]

### Added
- **Property-based security testing (`proptest`, host-side; both programs).**
  The roadmap's fuzz / invariant / arithmetic-boundary rows, implemented as
  property suites on the pinned stable toolchain (no nightly/cargo-fuzz
  needed):
  - `grave-vault/src/merkle.rs::proptests` (5): honest producer-built
    proofs always verify across random 1..=48-entry trees (cross-component:
    the REAL `grave-snapshotter` builder against the on-chain verifier);
    ANY single-bit flip of root, leaf, or a proof element invalidates; a
    proof minted for one holder never verifies another holder's leaf;
    proof lengths are bounded by tree depth (the fuzzer DISPROVED the
    uniformity and log2-floor assumptions — promotion shapes legitimately
    vary proof length, both wrong assumptions are documented in the test);
    single-entry boundary (empty proof accepts exactly that leaf).
    Regression seeds for the disproven assumptions are committed under
    `programs/grave-vault/proptest-regressions/`.
  - `grave-vault/src/instructions/salvage_pool.rs::proptests` (3): D7
    conservation under EVERY valid share config and EVERY total (0, 1,
    u64::MAX, random) — the three shares exhaust the total exactly, floors
    are exact, and the protocol share never receives less than its own
    floor; boundary totals route the indivisible lamport to protocol; the
    slippage cap is bounded by the hard ceiling and the per-tx override
    can only tighten.
  - `grave-scanner/src/attestation.rs::proptests` (4): the ed25519
    precompile-offset checker and the SlotHashes lookup NEVER panic on
    arbitrary attacker-controlled bytes (fail-closed on truncation);
    well-formed sysvars resolve only the exact target slot; the message
    validator never panics on random 112-byte messages.
  - `grave-scanner/src/criteria.rs::proptests` (3): the price-collapse
    arithmetic is total (clamped bps or clean MathOverflow, never a
    panic), monotone in the current price with the re-float guard pinned,
    and exact at the 9_900 / 10_000 / 1-bps boundaries.
- **`programs/grave-vault/tests/security_negative_fork.rs`** (6 fork
  tests): the vault-side adversarial-account roadmap rows against real
  mainnet bytecode — wrong authority signers revert 7000 (config update +
  pause, with the rightful authority as positive control); pause gates the
  first salvage ATOMICALLY (7003 and no pool-scoped PDA survives the
  revert), unpausing restores it, and a replayed salvage dies on the
  PoolRegistry init constraint with the sealed root byte-identical;
  substituting the AMM-authority slot (remaining_accounts[0]) with an
  attacker key reverts 7013 pre-CPI and the honest salvage succeeds after;
  an EligibilityCert PDA with byte-identical data but an ATTACKER-OWNED
  account owner is repelled by the ownership constraint; re-running
  `initialize` cannot steal the config authority; claims against a
  never-salvaged pool and with a cross-pool `claim_record` PDA both fail
  with zero cumulative movement.
- **`programs/grave-vault/tests/scanner_windows_fork.rs`** (6 fork tests):
  the scanner-side windows, rotation, and replay rows — `update_protocol_config`
  rotates BOTH oracle keys and the RETIRED oracle's valid signature over a
  fresh message reverts 6026 while the new oracle certifies (authority
  rotation; the recorded LaunchPrice PDA survives untouched); the cert
  reissue gate rejects a second Phase 2 while valid (6034) with the cert
  byte-identical (the expiry CROSSING is unreachable in-VM — program-test
  freezes unix_timestamp on warp — and stays covered by the Phase 1.4 host
  predicate tests and the Phase 2.1 expired-cert 7002 fork test); the
  attestation freshness matrix proves future slot 6031, future timestamp
  6028, never-in-SlotHashes slot 6029, and corrupted hash 6030 over VALID
  signatures, then certifies honestly; `record_launch_price` is init-once
  (replay rejected, price byte-identical); scanner pause gates evaluation
  (6010) while governance stays live and a wrong signer cannot unpause
  (6000); Phase 2 requires exactly `anchor_epoch + MIN_EPOCH_CONFIRMATION`
  (6016 at +1, success at +2).
- Fork-suite total 35 → 47. Host unit-test total 156 → 171 (scanner 88 /
  vault 30 / snapshotter 53). `proptest = "1"` added as a dev-dependency
  of both programs (host test targets only; the BPF builds are unchanged).

## [Unreleased — Phase 6: the first complete lifecycle integration test; the C1/C2 precompile wire contract corrected (spec rev 1.10.0)]

### Added
- **`programs/grave-vault/tests/full_lifecycle_fork.rs`** — the Phase 6
  end-to-end harness and the roadmap's "first complete integration test":
  ONE test executes the ENTIRE GraveYield lifecycle against the real
  mainnet Raydium V4 / OpenBook / SPL-token bytecode (canonical pool 1
  fixtures) and asserts every state transition:
  candidate pool → GraveScanner `initialize` (governance thresholds,
  oracle keys) → `record_launch_price` (C2, oracle-signed 168-byte Ed25519
  attestation) → `evaluate_pool_phase_1` (C1, indexer-signed 112-byte
  attestation; all six criteria evaluated over the real pool bytes) →
  `EligibilityAnchor` (bitmap 0x3F) → multi-epoch waiting period (VM warp
  past `MIN_EPOCH_CONFIRMATION`) → `evaluate_pool_phase_2` (FRESH C1
  attestation, bitmap equality, epoch gap) → `EligibilityCert` →
  LP-holder snapshot (the real snapshotter over the live VM ledger, the
  `Σ == supply` completeness gate running for real) → `SnapshotMerkleTree`
  → sealed `SnapshotArtifact` → JSON publication → `salvage_pool` (real
  withdraw CPI + Jupiter stand-in conversion + 40/40/20 settlement; the
  artifact root + supply sealed into `PoolRegistry`) →
  `claim_lp_proceeds` ×5 with the artifact's ready-to-submit proofs →
  SOL in every historical holder's wallet → the closing identity chain
  (`Σ ClaimRecords == registry cumulative == Σ floors recomputed from the
  artifact alone`; the vault keeps exactly rent + (bucket − claimed)).
- Fork-suite total 34 → 35. Host totals unchanged (156: scanner 81 /
  vault 22 / snapshotter 53).

### Fixed
- **The C1/C2 attestation precompile wire contract (mainnet-blocking; only
  an end-to-end test could catch it).** The scanner's offset checker — and
  the SDK's attestation builders — assumed a 14-byte `ed25519_program`
  header (signature count as the 5th u16, no message-size field, sig at
  14, pk at 78). The runtime's actual format (`agave_precompiles::ed25519
  ::verify`) reads the signature count from `data[0]` and parses the
  7-field offsets struct at byte 2 with a `message_data_size` field: an
  instruction in the previously shipped shape dies in precompile
  verification before the scanner executes, and a runtime-valid
  instruction was rejected by the scanner (`InvalidAttestationOffsets`) —
  the attestation path could never succeed end-to-end. The Phase 1.2/1.3
  suites passed because both sides of their unit tests shared the same
  wrong shape; `full_lifecycle_fork.rs` executes the real precompile, so
  the contract is now proven against the actual runtime. The fix pins
  every field fail-closed (count == 1, sig/pk at the canonical placements
  48/16, message offset/size/index exactly the attestation span, covered
  key == the configured oracle). Intent, error codes, instruction data,
  and account layouts are unchanged; the 112/168-byte messages are
  unchanged.
- `programs/grave-scanner/src/attestation.rs`: offset contract + module
  header + the 31 attestation unit tests rewritten to the runtime wire
  format (the tamper vectors retarget the real byte positions; the
  constants lock test pins sig 48 / pk 16 / header 16 / min 112).
- `sdk/src/lastSwapAttestation.ts`: `buildEd25519VerifyInstruction` emits
  the runtime layout (112-byte data, pk@16, sig@48, `message_data_size` =
  the canonical message length) and validates the (offset, size) pair
  against the two canonical attestation spans (72, 112) and (152, 168);
  constants updated (`ED25519_HEADER_LEN` 16, `PRECOMPILE_PK_OFFSET` 16,
  `PRECOMPILE_SIG_OFFSET` 48, `PRECOMPILE_MIN_LEN` 112).
- `sdk/src/launchPriceAttestation.ts`: the C2 wrapper passes a 168-byte
  placeholder so the precompile's `message_data_size` is 168.

### Changed
- `scripts/build_fork_harness.sh`: builds and copies `grave_scanner.so`
  and runs all FIVE fork suites (Phase 2.1 / 3 / 4 / 5.3 / 6).
- `tests/README.md`: Phase 6 section (the full-lifecycle harness, the
  retired cert stand-in, scanner-build setup) and the fork-suite counts.
- `docs/PROTOCOL_SPEC.md`: rev 1.10.0 (the corrected precompile wire
  contract, normative in §5).

## [Unreleased — Phase 5.3: the claim path proven on the real snapshotter (wallet → proof → claim → SOL)]

### Added
- **`programs/grave-vault/tests/lp_claim_fork.rs`** — the Phase 5.3 claims
  fork harness and the roadmap's Phase 5 exit condition, proven against the
  real mainnet Raydium V4 / OpenBook / SPL-token bytecode (canonical
  SOL/USDC pool 1 fixtures, same harness family as Phases 2.1–4). The
  suite retires the Phase 4 harness's documented forged-snapshot stand-in:
  every root and every proof now comes from the shipped
  `grave-snapshotter` crate exactly as production will produce them — the
  LP-holder ledger is read from the live VM through the same source seam
  an RPC serves, `SnapshotBuilder` runs its `Σ enumerated balances ==
  lp_mint.supply` completeness gate for real, `SnapshotMerkleTree` +
  `SnapshotArtifact::seal` produce the published claims document (JSON
  round-trip is the publication boundary — holders only ever consume the
  published artifact), `salvage_pool` seals the artifact's root + supply
  into `PoolRegistry`, and each holder claims with THEIR OWN entry
  (`proof_for`) — wallet → proof → claim → SOL with no manual steps.
  Five tests, one per roadmap acceptance item:
  - **Claim successfully** — five claimants, including the SALVOR (D11
    policy 2: the pre-burn balance is an ordinary leaf), each receive
    exactly `floor(bucket × balance / supply)`, exercising the promotion
    shapes the real tree builder emits for a 5-leaf set; per-claim
    accounting (holder delta, registry cumulative, bucket drain) asserted
    after every claim.
  - **Reject invalid proof** — swapped sibling, truncated proof, forged
    element, and a wrong-signer submission (the leaf binds the signer) all
    revert 7010 with zero state movement; the honest entry still claims
    afterwards (positive control).
  - **Reject duplicate claim** — the ClaimRecord init constraint rejects
    the second claim; only the tx fee moves.
  - **Reject overclaim** — both defense layers: an inflated
    `lp_balance_at_snapshot` breaks its own Merkle leaf (7010); a
    dishonest snapshotter that seals an oversubscribed tree (canonical
    doctored entries through the REAL tree builder — what a buggy or
    malicious producer would emit, invisible to `salvage_pool` since the
    root is opaque) hits the cumulative conservation cap (7009), in both
    the single-shot payout-above-bucket shape and the cumulative
    cross-holder drift the defense-in-depth comment describes.
  - **Verify cumulative accounting** — `Σ ClaimRecord.amount ==
    registry.lp_holder_pool_claimed_lamports == Σ floors recomputed from
    the artifact alone`; every ClaimRecord matches its artifact entry
    (pool, holder, amount, balance-at-snapshot); the vault keeps exactly
    rent + (bucket − claimed), where the remainder decomposes into the
    sink-excluded pool-LP custody share plus the claim-side rounding dust
    (< 1 lamport per floor) — ledgered and unclaimable per D11.
- Fork-suite total 29 → 34. Host totals unchanged (156: scanner 81 /
  vault 22 / snapshotter 53).

### Changed
- `programs/grave-vault/Cargo.toml`: `grave-snapshotter` added as a
  dev-dependency (dev-only edge; the snapshotter only dev-depends back on
  `grave-vault`, so no build cycle exists). `Cargo.lock` gains the single
  dev-dependency edge — no new resolution.
- `tests/settlement_economics_fork.rs` header: the forged-snapshot note now
  points at the real producer (comment-only; the hand-built tree remains
  the claims-economics regression lock).
- `snapshotter/src/lib.rs`: crate docs point at the Phase 5.3 end-to-end
  proof (comment-only).

## [Unreleased — Phase 5.2: Merkle tree + sealed snapshot artifact (SNAPSHOT-001 retired)]

### Added
- **`grave_snapshotter::tree` (`SnapshotMerkleTree`)** — the off-chain
  Merkle tree builder and proof generator, the reference producer of the
  root `salvage_pool` seals into `PoolRegistry` and `claim_lp_proceeds`
  verifies against. Leaves are `SHA256(pubkey || balance_le_u64)`
  (40-byte preimage, byte-locked to `grave_vault::merkle::compute_leaf`),
  parents are sorted-pair SHA-256, and an odd node at any level promotes
  unchanged — the exact convention the Phase 4 fork harness proved
  end-to-end (`build_three_leaf_tree`), now bit-locked between the
  shipped builder and the fork suite by test. Tree input must be
  canonical (ascending owner bytes, unique owners, strictly positive
  balances — the snapshot's own validator, fail-closed), so the root is a
  pure function of the leaf set. Proofs fold under the on-chain
  `verify_proof`; a promotion level contributes no element.
- **`grave_snapshotter::artifact` (`SnapshotArtifact`)** — the sealed,
  publishable claims artifact: pool/mint/slot/supply metadata, the
  Merkle root, and per-holder (balance, leaf, ready-to-submit proof) as
  deterministic JSON (base58 pubkeys, lowercase hex hashes, canonical
  field and entry order — the same snapshot always seals to
  byte-identical JSON). `seal()` fail-closes against mixed-up
  tree/snapshot handles (the tree is re-derived and compared);
  `verify_integrity()` re-derives root, leaves, proofs, depth, count,
  format version, and the closing reconciliation identity from the
  persisted entries and refuses any drift (`ArtifactMismatch`).
- **23 new host tests** (16 lib + 7 integration), host total 134 → 156:
  tree shapes n ∈ {1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 32, 33} (every
  promotion shape, depth/proof-length invariants), canonical-order
  fail-closed gates, leaf/preimage pins, artifact
  determinism/round-trip/tamper matrix, and the integration locks:
  every generated proof verifies under the on-chain `verify_proof`, the
  3-leaf root and proofs are bit-identical to the fork recipe, and the
  production-shaped fixture (sink + custody + locks) seals into a
  verifiable artifact whose JSON round-trip stays verifiable.

### Changed
- `grave-vault/src/merkle.rs`: the stale header comment ("the off-chain
  builder pads odd levels by duplicating") now documents the fork-proven
  convention actually shipped (odd node promotes unchanged; a promotion
  contributes no proof element) and names the reference builder.
  Comment-only; no behavior change. Spec rev 1.8.0 → 1.9.0 (D12 added;
  §2/§6.3 updated); SNAPSHOT-001 retired with the
  `PRE-MAINNET-TODO(SNAPSHOT)` marker removed;
  `SnapshotError` gained `Serialization`/`ArtifactMismatch`;
  `snapshotter` regular deps: `sha2 0.10`, `serde 1 (derive)`,
  `serde_json 1` (all pre-resolved in Cargo.lock).

## [Unreleased — Phase 5.1: off-chain LP-holder snapshotter (`grave-snapshotter`)]

### Added
- **`snapshotter/` workspace crate (`grave-snapshotter`)** — the Phase 5.1
  off-chain LP-holder snapshotter, the real producer of the snapshot the
  Phase 4 fork harness stood in for: deterministic, invariant-checked
  enumeration of the LP-holder set whose `(holder, balance)` entries feed
  the fork-proven `claim_lp_proceeds` Merkle verifier. Pipeline: LP mint
  supply + full token-account enumeration (RPC source via
  `getProgramAccounts` behind the pluggable `LpAccountSource` trait) →
  per-owner aggregation over ascending pubkey bytes → exclusion ledger
  (zero balances + operator-declared sinks) → UNCX locked-LP attribution
  to beneficial `TokenLock.lock_owner`s (records strictly validated
  off-chain with the scanner adapter's exact on-chain checks — size,
  discriminator, PDA re-derivation, (amm_id, lp_mint) binding) → custody
  account identified by exact-balance reconciliation (`balance ==
  Σ current_locked_amount`, the 74/74 mainnet LOCKER-001 identity;
  fail-closed on ambiguity, `custody_owner_overrides` as the escape
  hatch) → merged leaf set with the closing identity
  `entries_total + sink_exclusions_total == enumerated_total ==
  lp_mint.supply` enforced as a hard gate (`SupplyMismatch`).
- **Snapshot policies pinned (spec rev 1.8.0, D11)** — pre-salvage
  snapshot point (the on-chain supply pin is the integrity anchor); the
  salvor's pre-burn balance is an ordinary leaf (omitting it would strand
  its share of the LP bucket); burned LP needs no exclusion (it never
  enumerates); locked LP is attributed to beneficial owners, never to
  custody PDAs; zero-balance/sink exclusions are ledgered, never silent;
  determinism is part of the contract (same ledger state in,
  bit-identical snapshot out).
- **30 host tests** (`cargo test -p grave-snapshotter`, no network):
  determinism across rebuilds and input orderings, canonical ordering,
  exclusion ledger, custody reconciliation matrix (unique match /
  ambiguity fail-closed / override / not-found / lock-owner-is-custody /
  custody-as-sink misconfiguration), supply-mismatch and empty-snapshot
  gates, TokenLock validation vectors (size / discriminator / forged PDA /
  foreign amm / foreign mint), RPC filter wire shapes, leaf-format
  compatibility lock against `grave_vault::merkle::compute_leaf` (via
  independent SHA-256), and UNCX constants drift lock against the scanner
  adapter.

### Changed
- Workspace: `snapshotter` joins the members list, so `cargo fmt --check`
  and `clippy -D warnings` cover it like every other crate.
  `scripts/list-pre-mainnet-todos.sh` now scans `snapshotter/` and lists
  the `SNAPSHOT` scope (marker registered for the Phase 5.2 remainder,
  tracked as SNAPSHOT-001 in the checklist).

## [Unreleased — Phase 4: settlement economics proven (D6 dust policy retired + D7 invariant proven)]

### Added
- **`sweep_dust` instruction (D6, DUST-001 retired)** — the complete dust
  policy: after any salvage, the memecoin retained in the vault memecoin
  ATA (below-threshold dust OR swap-leg route residual) is recoverable by a
  PERMISSIONLESS one-shot instruction. It transfers the ATA's entire
  balance to the protocol treasury's ATA for the same mint (destination
  pinned by ATA derivation — a caller cannot redirect value), closes the
  vault ATA (rent reclaimed by the caller — the standard sweep incentive),
  stamps `SalvageReceipt.dust_swept_at_ts`, and emits `DustSwept`. Guards:
  mint bound to the receipt (`PreflightFailed` 7013), empty ATA
  (`DustNothingToSweep` 7020), already-swept (`DustAlreadySwept` 7021).
  `lp_holder_pool_vault` is untouched — the sweep moves memecoin tokens,
  never LP-holder SOL proceeds (Charter).
- **`SalvageReceipt` dust fields (breaking, pre-mainnet)** — three fields
  appended after `issued_at_ts` (all existing byte offsets stable, pinned
  by a new layout unit test): `memecoin_mint` (fully identifies the
  salvage and binds the sweep), `dust_memecoin_lamports` (what the vault
  RETAINED — below-threshold dust or route residual — outside the 40/40/20
  settlement, per D6 "retained, unconverted"), `dust_swept_at_ts` (0 until
  swept).
- **Settlement-economics fork harness** —
  `programs/grave-vault/tests/settlement_economics_fork.rs`: seven tests
  against real mainnet bytecode and pool state proving the Phase 4
  acceptance bar: (1) the dust-skip path records the retained amount and
  settles EXACTLY the withdraw-side WSOL; (2) `sweep_dust` moves the exact
  dust to the treasury ATA, closes the vault ATA with the exact rent
  delta, stamps the receipt, and never touches the LP bucket; (3) the
  one-shot matrix (second sweep reverts; fully-converted pool reverts
  7020); (4) a hijacked sweep destination fails with ZERO state movement
  and the legitimate sweep still succeeds afterwards (atomicity); (5) D7
  end-to-end with a custom asymmetric config (lp=4001 / salvor=4000 /
  protocol=1999): floors bite, the remainder accrues to the protocol share
  by construction, and conservation is EXACT; (6) claims-side economics
  with a real 3-holder Merkle tree (60/30/10): every holder claims exactly
  `floor(lp_share × balance / supply)`, cumulative claims never exceed the
  bucket, the claim-side rounding remainder stays in the vault, double
  claims fail, and claims stay LIVE during emergency pause (Charter).
- **`split_proceeds` helper + host unit tests** — the D7 settlement split
  extracted from the handler and pinned for the rounding edges the real
  fixtures cannot reach (totals 1 / 9_999 / 10_001, asymmetric shares,
  u64::MAX with extreme share configs): floors are `floor(total × bps /
  10_000)`, the protocol share is the remainder, and conservation holds
  for every input.

### Changed
- `salvage_pool` records `memecoin_mint` + the vault memecoin ATA's final
  balance as `dust_memecoin_lamports` on the receipt (covers the skip path
  AND swap-leg residual); the `PRE-MAINNET-TODO(DUST)` marker is retired.
- `scripts/build_fork_harness.sh` and `tests/README.md` include the Phase 4
  suite; error codes extended to 7021 (`DustNothingToSweep`,
  `DustAlreadySwept`) with the code-lock test extended accordingly.
- Spec rev 1.7.0 (D6 implemented; D7 fork-proven; §6.1 rows; §6.4 bullet
  retired); `PRE_MAINNET_CHECKLIST.md` DUST-001 moved to Retired.

## [Unreleased — Phase 3: the Jupiter conversion pipeline proven end-to-end (CPI-010 / SLIP-001 / route-destination integrity retired)]

### Added
- **Conversion-leg fork harness** —
  `programs/grave-vault/tests/jupiter_conversion_fork.rs`: executes the real
  `salvage_pool` — withdraw leg AND conversion leg — against real mainnet
  Raydium V4 / OpenBook / SPL-token bytecode with byte-for-byte mainnet state
  of TWO pools covering BOTH base orientations: SOL/USDC (coin = WSOL) and
  RAY/WSOL (pc = WSOL). Twelve tests: the full pipeline
  (LP -> Raydium -> memecoin -> Jupiter -> WSOL -> SOL unwrap -> 40/40/20)
  for both orientations with exact conservation assertions, plus the
  adversarial matrix (zero floor vs the slippage ceiling, override
  tightening, unachievable floor, hijacked route destination, route
  referencing vault custody accounts, bad route data, failing aggregator,
  foreign memecoin/LP mint binding, no-WSOL pool).
- **Test-only Jupiter stand-in** —
  `programs/grave-vault/tests/jupiter_v6_stub/`: a documented stub deployed
  at the pinned Jupiter v6 program id inside the in-process VM that executes
  a REAL Raydium V4 `swapBaseIn` against the same mainnet pool state as the
  withdraw leg and can fail deterministically. The vault treats Jupiter as
  an opaque program (route forwarded verbatim, no route-plan parsing), so
  every defense proven through the stub holds against an ARBITRARY callee.
  The stub is never deployed anywhere and is excluded from program builds.
- **Second fixture pool** — `scripts/fetch_v4_fork_fixtures.mjs` now also
  fetches the RAY/WSOL orientation pool (pc = WSOL) under the manifest's
  `orientation_pool` key (accounts suffixed `2`, including its OpenBook V1
  market program ELF). Pool 1 files are unchanged.
- **`probe_swap_wire.mjs`** — documented V4 `swapBaseIn` wire probe used
  during Phase 3 discovery.

### Fixed
- **Base-token orientation was hardcoded (CPI-010, B5).** `salvage_pool`
  now derives orientation from the pool's own AmmInfo mints (coin@400 /
  pc@432): exactly one side must be the pinned WSOL mint, `base_is_coin_side`
  follows, and any other shape reverts `UnsupportedBaseToken` (7019) BEFORE
  any CPI instead of failing inside the Raydium withdraw as
  `AmmRedemptionFailed`. The submitted `lp_mint` and `memecoin_mint` are
  bound to the pool's own bytes (`PreflightFailed` 7013) — the SPL token
  program does not check mint consistency on Raydium's plain transfers, so
  this closes a real desynchronisation path. Both orientations are proven
  end-to-end. Spec D5 rewritten; checklist CPI-010 retired.
- **The protocol slippage ceiling was dead code (SLIP-001, B6).**
  `config.max_slippage_bps`, `HARD_MAX_SLIPPAGE_BPS` and
  `max_slippage_bps_override` are now read: when the conversion leg is
  active, the submitted floor must be at least the pool-implied conversion
  (post-withdraw reserve ratio — no oracle, no caller input) minus
  `min(config, hard ceiling, override)`; enforced BEFORE the swap CPI.
  A salvor can no longer submit `min_quote_output_lamports = 0`. Spec D4
  amended; checklist SLIP-001 retired.
- **Jupiter route integrity (N1 / CPI-011).** Route accounts are vetted
  before the swap CPI: none may reference a vault custody/state account
  (registry, receipt, LP-holder vault, treasury, SOL holding, config, cert,
  salvor, salvor LP account) and the vault's WSOL destination must be
  present. Combined with the ceiling (floor `0` now impossible) and the
  existing post-CPI floor re-check, a hijacked or malicious route reverts
  atomically and delivers nothing. Spec §6.3/§8 row 15 updated.
- **Five stale comments from the late 2.1 architecture change** (tag 219 /
  20-account wire references, `vault_authority`-as-`user_owner`,
  the removed deposit-then-burn step, `vault_lp_token_account`) corrected
  across `cpi/raydium_v4.rs`, `cpi/mod.rs` and the Phase 2.1 harness header.

### Changed
- `scripts/build_fork_harness.sh` builds the stand-in crate and runs BOTH
  fork suites; the workspace adds the test-only crate as a member so
  `cargo fmt --check` / `clippy -D warnings` cover it.

## [Unreleased — Phase 2.1: Raydium V4 withdraw proven against mainnet bytecode (CPI-009 retired)]

### Fixed
- **The Raydium V4 withdraw CPI could never have succeeded.** The
  `solana-program-test` fork harness (built in this phase) executes the real
  `salvage_pool` instruction against the real mainnet Raydium V4 /
  OpenBook / SPL-token bytecode with byte-for-byte mainnet pool state, and
  caught three latent defects plus one architectural mismatch:
  1. **Wrong account count.** The deployed V4 withdraw requires the
     22-account form (two padding slots at positions 8/9 — live traffic
     fills them with the pool account — plus event queue, bids and asks at
     the tail); the vault sent 18, which every deployed-binary path rejects.
  2. **Read-only accounts the withdraw mutates.** `pool` (AmmInfo
     `lp_amount`/`recent_epoch`) and `lp_mint` (burn) must be writable in
     the outer instruction, otherwise the CPI fails with
     `PrivilegeEscalationAttempt`.
  3. **Missing callee program account.** The runtime requires the CPI's
     callee program to be among the caller's accounts; `salvage_pool` now
     takes `amm_program` (validated executable and equal to `pool.owner`)
     and `jupiter_program` (address-pinned to Jupiter v6) and threads both
     into their CPI account lists.
  4. **PDA withdrawer rejected by the deployed program.** Burning LP as the
     `vault_authority` PDA (an off-curve, account-less `user_owner`) is
     rejected by the deployed V4 bytecode; live withdraw traffic always has
     a real wallet as `user_owner`. The architecture changed accordingly:
     the withdraw burns `salvor_lp_amount` **in place** in the salvor's LP
     account (the salvor signs the salvage transaction and is the withdraw
     signer) and the proceeds land in vault-owned accounts. The vault LP
     ATA, the deposit-then-burn transfer and the withdraw's PDA signer
     seeds are removed. Atomicity is unchanged (single transaction), and
     the vault never takes custody of LP.

### Added
- **Fork harness** — `programs/grave-vault/tests/raydium_v4_fork.rs`
  (10 tests): happy path with exact LP-burn / supply / reserve-delta /
  40-40-20 / receipt assertions, plus the adversarial matrix (forged
  target orders, scrambled open-orders/target-orders, swapped coin/pc
  vaults, wrong `amm_program`, unbound pool, insufficient LP, zero LP,
  extra remaining accounts, expired cert). Fixtures are fetched by
  `scripts/fetch_v4_fork_fixtures.mjs` (gitignored; tests skip without
  them) and `scripts/build_fork_harness.sh` wraps build + fetch + run.
- **Withdraw failure semantics** — pre-flight failures surface vault error
  codes (7002/7013); failures inside the V4 CPI surface the deployed AMM's
  raw error codes (e.g. 4 `InvalidCoinVault`, 25
  `InvalidTargetAccountOwner`, 40 `InsufficientFunds`) because the runtime
  propagates the inner custom code; documented in the harness.

### Changed
- `salvage_pool` account surface (breaking, pre-mainnet): `amm_program` and
  `jupiter_program` named accounts added; `vault_lp_token_account` removed;
  `RAYDIUM_V4_WITHDRAW_REMAINING_ACCOUNTS_REQUIRED` is 13 (authority, open
  orders, target orders, both AMM vaults, market program, market, both
  market vaults, market vault signer, event queue, bids, asks). The two
  padding slots are filled internally with the pool account.

## [Unreleased — Phase 1.4: eligibility certificate lifecycle (B4)]

### Added
- **Expiry-gated cert reissuance (spec `PROTOCOL_SPEC.md` §7 / decision
  D10).** The `EligibilityCert` PDA was init-once: once it expired, the
  pool's salvage path was permanently bricked — the vault's
  `EligibilityCertExpired` (7002) message said "Re-run Phase 2", but
  re-running Phase 2 reverted on re-creating an existing PDA. Phase 2
  now creates the cert with `init_if_needed` and reissues it **in
  place** once expired. One gate governs all lifecycle states: a fresh
  (zeroed) PDA reads as expired (`expires_at == 0`), an expired cert is
  reissuable, and a **live** cert reverts the new error 6034
  `CertStillValid` — two live certs for one pool are structurally
  impossible (single PDA + gate). Every reissue re-runs the full Phase 2
  verification stack (fresh C1 attestation, six criteria, locker
  evidence, mint-pair check, bitmap equality); there is no shortcut
  path to a cert.
- **`EligibilityCert.reissue_generation`** — auditable counter of
  repeated Phase 2 attempts (1 = first issue, N = Nth reissue), carved
  out of `_reserved` (64 → 56 bytes; total account size unchanged).
  `EligibilityCertIssued` events now carry `generation`.
- **Cert lifecycle host tests** — inclusive expiry boundary
  (`[issued_at, expires_at)`), zeroed-fresh reissuability, live-cert
  gate, layout stability, and a borsh roundtrip of the reissue
  overwrite.
- **Scanner error 6034** — `CertStillValid` (lock test extended to
  6000–6034).

### Changed
- **`evaluate_pool_phase2` behavior:** a second Phase 2 call on an
  expired cert now succeeds (in-place reissue) instead of reverting
  `AccountAlreadyInitialized`; a call on a live cert reverts 6034. No
  instruction data changed. `grave-scanner` now enables the
  `anchor-lang` `init-if-needed` cargo feature (the reinitialization-
  attack surface is closed by the expiry gate + unconditional full-field
  rewrite; the vault already used the same feature for its PDAs).
- **Failed salvage semantics documented** (no state change needed): a
  reverting `salvage_pool` leaves the cert untouched (retry within the
  TTL works); the vault's init-once `PoolRegistry`/`SalvageReceipt` PDAs
  permanently settle a salvaged pool; a drained pool fails
  re-certification at Criterion 3 (minimum TVL) regardless.
- **Documented v1.0 boundaries (spec §6.4):** no on-chain revocation of
  a live cert (`invalidate_anchor` censors the certification path
  upstream only) and no post-salvage cert rent recovery — both reserved
  for future revisions.

### Verified
- `cargo test -p grave-scanner` 81/81 (76 → 81: +5 cert lifecycle),
  `cargo test -p grave-vault` 9/9, `clippy -D warnings` clean (scanner
  + vault), `fmt --check` clean, terminology lint pass, workspace
  typecheck green.

## [Unreleased — Phase 1.3: authoritative launch price (ORACLE-001)]

### Added
- **Oracle-signed launch-price baseline (spec `PROTOCOL_SPEC.md` §5 /
  decision D9).** "Launch price" is now defined normatively as the
  quote-per-base price formed by the pool's vault balances immediately
  before the pool's first successful swap (the deployer-seeded initial
  market price). The value reaches `record_launch_price` only as a
  168-byte Ed25519 attestation
  `amm_program_id ‖ pool_address ‖ base_mint ‖ quote_mint ‖
  first_swap_slot ‖ first_swap_unix_ts ‖ launch_price_q64x64 ‖
  issued_slot` verified in-transaction via the `ed25519_program`
  precompile. This closes two live attack vectors of the caller-supplied
  baseline: fake-high prices (forged C2 collapses) and fake-low prices
  (permanent C2 denial-of-service on the init-once record).
- **`ProtocolConfig.launch_price_oracle`** — new governance-controlled
  signing key for C2 attestations, deliberately separate from the hotter
  `activity_oracle` key (the init-once baseline is permanently binding).
  Initialised to the protocol authority at `initialize`; rotatable
  independently via `update_protocol_config` (new `launch_price_oracle:
  Option<Pubkey>` param).
- **`LaunchPrice` provenance fields** — attested `first_swap_slot` and
  `first_swap_unix_ts` persisted alongside the price (reserved space
  shrunk 32 → 16 bytes; total account size unchanged), making the
  init-once baseline auditable against the original attestation.
- **Evaluation-time mint-pair re-check** — both `evaluate_pool_phase_1`
  and `evaluate_pool_phase_2` now reject a baseline recorded for a
  different token pair than the live pool's parsed mints.
- **Scanner errors 6032–6033** — `InvalidLaunchPrice` (zero attested
  price), `LaunchPriceMintMismatch` (baseline mint pair ≠ live pool).
- **`sdk/src/launchPriceAttestation.ts`** — canonical 168-byte message
  builder/parser (byte-for-byte mirror of the on-chain layout),
  `buildLaunchPriceEd25519VerifyInstruction` (precompile wiring at
  message offset 152), `readV4PoolPair`, and
  `deriveLaunchPriceV4`: fail-closed operator/indexer tooling that
  paginates signature history back to genesis, identifies the first swap
  by opposite-direction vault-balance deltas (deposits/initialization
  move both vaults the same way), and computes
  `(pc_vault_pre << 64) / coin_vault_pre` — the exact on-chain price
  formula. Incomplete history, missing block times, pruned transactions,
  and zero pre-swap base liquidity all throw; a never-swapped pool
  returns `null`.
- **Extreme-price boundary tests** — `compute_drop_bps` pinned at the
  minimum representable price, large-representable prices, and the
  fail-closed `MathOverflow` boundary above ~2^114.6 Q64.64 (spec §6.4).

### Changed
- **BREAKING (pre-mainnet):** `record_launch_price` instruction data
  gained `msg: [u8; 168]` (the signed attestation, now the last params
  field) and the accounts gained `protocol_config` +
  `instruction_sysvar`. A caller-supplied price that does not byte-exactly
  echo the attested price reverts (`AttestationBindingMismatch`, 6027).
  The instruction is now pause-gated like the evaluation path.
- **`attestation.rs` refactor** — the Ed25519 offset validator is
  generalized (`verify_ed25519_offsets_at`) with the C1 validator kept as
  a thin wrapper at the canonical offset 72; the C2 path validates at
  offset 152 over a 320-byte instruction. A shared
  `load_instruction_pair` helper replaces duplicated sysvar loading.
- **SDK `buildEd25519VerifyInstruction`** — accepts an optional
  `messageAddressOffset` (defaults to the C1 offset 72, wire format
  unchanged).
- **`programs/grave-vault/Cargo.toml`** — added `solana-sha256-hasher`
  with the `sha2` feature as a dev-dependency. The dependabot 2.3.0 →
  3.1.0 bump had silently broken the merkle host tests on host builds
  (`hashv` panics off-chain without the software feature); the tests
  compile but failed at runtime since that bump. Caught by the Phase 1.3
  verification pass; on-chain BPF builds are unaffected.

### Verified
- `cargo test -p grave-scanner` 76/76, `cargo test -p grave-vault` 9/9,
  `clippy -D warnings` clean, `fmt --check` clean, terminology lint pass,
  workspace typecheck green, and a 26-check TS↔Rust wire-format
  verification (independent encoder vs SDK builder vs byte-slice
  assertions vs precompile offsets).

## [Unreleased — Phase 1.2: authoritative last-swap evidence (ORACLE-002)]

### Added
- **`programs/grave-scanner/src/attestation.rs`** — on-chain verification of
  indexer-signed Criterion 1 evidence (spec `PROTOCOL_SPEC.md` §5, decision
  D8). A 112-byte message `amm_program_id ‖ pool_address ‖ last_swap_unix_ts ‖
  issued_slot ‖ slot_hash` is signed by the protocol activity oracle and
  verified inside `evaluate_pool_phase_1` / `evaluate_pool_phase_2` through the
  `ed25519_program` precompile: the handler validates the precompile's
  `Ed25519SignatureOffsets` (single signature, canonical offsets binding the
  signature to exactly the attestation embedded in the instruction data), the
  oracle public key, the pool/AMM binding, timestamp sanity (no zero/future),
  and re-anchors `issued_slot` against the `SlotHashes` sysvar so a replayed
  attestation fails closed once the slot ages out (~512 slots). 15 host unit
  tests cover the stale-pool, recently-active-pool, and every manipulated-
  timestamp vector.
- **`ProtocolConfig.activity_oracle`** — new governance-controlled field; the
  public key whose Ed25519 signatures authorize C1 attestations. Initialised
  to the protocol authority at `initialize`; rotatable via
  `update_protocol_config` (new `activity_oracle: Option<Pubkey>` param).
- **Scanner errors 6024–6031** — `AttestationMissing`,
  `InvalidAttestationOffsets`, `AttestationOracleMismatch`,
  `AttestationBindingMismatch`, `AttestationTimestampInvalid`,
  `AttestationStale`, `AttestationSlotHashMismatch`, `AttestationSlotInvalid`.
- **`sdk/src/lastSwapAttestation.ts`** — canonical attestation message
  builder/parser (byte-for-byte mirror of the on-chain layout), Ed25519
  verify-instruction builder for transaction assembly, and operator/indexer
  tooling: `deriveLastSwapV4` (RPC transaction-history derivation) and
  `fetchSlotHash` (SlotHashes anchoring).

### Changed
- **BREAKING (pre-mainnet):** `evaluate_pool_phase_1` / `evaluate_pool_phase_2`
  instruction data replaced the caller-supplied `last_swap_unix_ts: i64`
  parameter with `msg: [u8; 112]` (the signed attestation), and both handlers
  gained `instruction_sysvar` + `slot_hashes` sysvar accounts. A caller-
  supplied timestamp is no longer an accepted input anywhere.
- **`PoolData`** — the dead `last_swap_unix_ts` field and the Raydium V4
  adapter's `0` sentinel were removed; C1 evidence now has exactly one source
  (the attestation).
- **Docs** — `PROTOCOL_SPEC.md` rev 1.2.0 (§4 C1, §5, §6.1/6.3, §7 D8, §8 row
  11, §9); whitepaper C1/C2 evidence wording; glossary (`activity oracle`,
  `last-swap attestation`); `error_codes.md` 6024–6031;
  `PRE_MAINNET_CHECKLIST.md` ORACLE-002 retired, ORACLE-003 opened (oracle
  operational runbook); `tests/README.md` updated.

### Sync convention
- `cargo test -p grave-scanner`: 56/56 pass (41 pre-existing + 15 new);
  `cargo clippy -D warnings` clean; `cargo fmt` clean; workspace typecheck
  (sdk + indexer) clean.

## [Unreleased — m6: claim_lp_proceeds Merkle verification]

### Added
- **`programs/grave-vault/src/merkle.rs`** — SHA-256 sorted-pair Merkle proof verifier matching OpenZeppelin / Uniswap convention. `compute_leaf(holder, balance)` produces `sha256(pubkey || balance_le_u64)`; `verify_proof(root, leaf, proof)` walks the proof in sorted-pair order. 7 host unit tests cover deterministic-leaf, distinct-leaf, two-leaf tree, four-leaf balanced tree, sorted-pair order invariance, empty-proof edge case, and tampered-leaf rejection.

### Changed
- **`claim_lp_proceeds` handler** — replaces the m3 placeholder (`require!(!params.merkle_proof.is_empty(), …)`) with a real Merkle verification against `pool_registry.lp_snapshot_merkle_root`. The pro-rata math, conservation check, and `LpClaimProcessed` event are unchanged from m3.
- **`claim_lp_proceeds` SOL transfer wired** — replaces the m3 `TODO(GraveVault m6)` comment with a real `system_program::transfer` CPI signed by `lp_holder_pool_vault`'s own seeds via `invoke_signed`. The vault is a system-owned PDA created by salvage_pool's lazy-init; its seeds are its signing authority.
- **`claim_lp_proceeds` defensive checks** added:
  - `lp_balance_at_snapshot > 0` (rejects zero-balance claims with `InvalidClaimProof`)
  - `pool_registry.lp_total_supply_at_snapshot > 0` (prevents division-by-zero if PoolRegistry is corrupted)
- **`lib.rs`** — `+ pub mod merkle;`.

### Sync convention
- No new error codes required. `InvalidClaimProof` (7010) and `ClaimAlreadyProcessed` (7011) already cover the m6 surface. `docs/error_codes.md` unchanged.

### Unverified
- BPF compile via `anchor build` (CI gate).
- End-to-end localnet smoke test: snapshot a Raydium V4 SOL/X pool's LP holders, salvage it via m5, then claim from multiple holders against the sealed root. Tracked in `PRE_MAINNET_CHECKLIST.md` as a v1.0-release-blocker.
- Real off-chain GraveScanner v2 indexer integration. The Merkle leaf encoding (`sha256(pubkey || balance_le_u64)`) is documented in this file and the canon — the off-chain builder MUST match it byte-for-byte.

## [Unreleased — m5: salvage_pool execution path]

### Added
- **GraveVault salvage_pool execution path** end-to-end (m5):
  - `cpi/raydium_v4.rs` — real Raydium V4 `withdraw` CPI (vault_authority PDA-signs `user_owner`; 18-account list; 9-byte data `[tag=4][amount_le]`; AMM authority constant validation; pre/post balance deltas).
  - `cpi/jupiter.rs` — Jupiter v6 swap CPI helper (forwards salvor's pre-computed route data + accounts; vault_authority signs).
  - `cpi/raydium_clmm.rs`, `cpi/orca_whirlpool.rs`, `cpi/pump_swap.rs` — honest-stub adapters; revert `AmmCpiUnimplemented` (7017).
  - `cpi/mod.rs` — dispatcher by `pool.owner`.
- **salvage_pool handler** rewritten to wire: salvor→vault LP transfer, dispatched remove_liquidity CPI, Jupiter swap (or dust skip), WSOL→SOL unwrap via `close_account` to `vault_sol_holding_account`, 40/40/20 distribution via three `system_program::transfer` calls, PoolRegistry + SalvageReceipt population, `PoolSalvaged` + `SalvageCompleted` emit.
- **Five new error codes** (7015-7019): `AmmRedemptionFailed`, `JupiterSwapFailed`, `AmmCpiUnimplemented`, `InvalidSnapshotData`, `UnsupportedBaseToken`. Mirrored to `docs/error_codes.md` in lock-step per the sync convention.
- **New PDA seeds**: `VAULT_AUTHORITY_SEED` (singleton signer), `VAULT_SOL_HOLDING_SEED` (per-pool, transient native-SOL holding for unwrap).
- **New constants**: `WSOL_MINT`, `RAYDIUM_V4_PROGRAM_ID`, `RAYDIUM_V4_AMM_AUTHORITY` (`5Q544...`), `RAYDIUM_CLMM_PROGRAM_ID`, `ORCA_WHIRLPOOL_PROGRAM_ID`, `PUMP_SWAP_PROGRAM_ID`, `JUPITER_V6_PROGRAM_ID`, `RAYDIUM_V4_INSTRUCTION_TAG_WITHDRAW = 4`, `RAYDIUM_V4_WITHDRAW_REMAINING_ACCOUNTS_REQUIRED = 11`, `BPS_DENOMINATOR = 10_000`, `HARD_MAX_SLIPPAGE_BPS = 1_000`.
- **PRE_MAINNET_CHECKLIST**: new rows `CPI-006/007/008` (CLMM/Orca/PumpSwap stubs) + `CPI-009` (Raydium V4 account-ordering verification against a live mainnet pool — blocking row).

### Changed
- `salvage_pool` instruction signature now takes `Context<'_, '_, '_, 'info, SalvagePool<'info>>` (explicit `'info` threading per Anchor 0.31+ lifetime invariance — see failure-pattern memory).
- `SalvagePoolParams` extended with `salvor_lp_amount`, `jupiter_route_data: Vec<u8>`, `max_slippage_bps_override: Option<u16>`, `jupiter_route_accounts_len: u8`.
- `SalvagePool` Accounts struct extended with `vault_authority`, `vault_sol_holding_account`, `salvor_lp_token_account`, `vault_lp_token_account`, `vault_base_token_account`, `vault_memecoin_token_account`, `lp_mint`, `memecoin_mint`, `wsol_mint` (pinned via `address` constraint), `token_program`, `associated_token_program`.

### Unverified
- BPF compile via `anchor build` (deferred to CI on this PR).
- Live Raydium V4 fork test of the exact 18-account ordering. The `amm_authority` constant check provides one assertion; full integration is `CPI-009` in `PRE_MAINNET_CHECKLIST.md`.
- Real Jupiter v6 swap end-to-end. The CPI helper forwards what the salvor's bot quotes; verification is a localnet smoke test post-merge.
- Pool orientation: `base_is_coin_side` is currently hardcoded `true` (assumes WSOL is the pool's coin side). A SOL/X pool where WSOL is the PC side will need the bot to invert its submission ordering; a runtime parse of pool data to detect orientation is in `PRE-MAINNET-TODO(CPI)` comments in `salvage_pool.rs`.

All notable changes to the GraveYield protocol monorepo are documented here.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version bumps in this file refer to the workspace as a whole; per-program
version pinning lives in each program's `Cargo.toml`.

## [Unreleased]

## [v1.0.6] — 2026-05-10

### m3 — GraveVault `salvage_pool` pre-flight + cert freshness gates

This release lands milestone 3 of the canonical 10-step build sequence:
**GraveVault `salvage_pool` pre-flight + PoolRegistry**. The CPI bodies
for AMM `remove_liquidity` (m5), Jupiter swap (m6), and 40/40/20
distribution (m7) remain honest-stubbed and explicitly marked.

#### Added

- **`MIN_CERT_TTL_SECONDS = 600`** floor in `programs/grave-scanner/src/constants.rs`.
  Hardcoded; raising it requires a program upgrade.
- **`ProtocolConfig.cert_ttl_seconds: i64`** field on the GraveScanner
  ProtocolConfig (governance-configurable, 72h timelocked, default 3600s).
  This replaces the previously-hardcoded `ELIGIBILITY_CERT_TTL_SECONDS`
  const at the runtime path in `evaluate_pool_phase_2`. The const itself
  is retained as `DEFAULT_CERT_TTL_SECONDS` for default-handling at init,
  and an `#[deprecated]` alias is left at `ELIGIBILITY_CERT_TTL_SECONDS`
  for backwards-compatible test fixtures.
- **Error 6019 `CertTtlBelowMinimum`** on GraveScanner. Raised by
  `initialize` and `update_protocol_config` when a `cert_ttl_seconds`
  parameter falls below `MIN_CERT_TTL_SECONDS`.
- **Anchor 0.32-compatible lazy vault init** for `lp_holder_pool_vault` in
  `salvage_pool`. Anchor 0.32 rejects `init` / `init_if_needed` on
  `SystemAccount` by design; PR #12's original approach is replaced with
  a manual `anchor_lang::system_program::create_account` CPI issued by
  the handler when `vault.lamports() == 0`. First salvage of a pool
  creates the 0-data system-owned PDA via the CPI (signed with the PDA
  bump); subsequent salvages of the same pool are still blocked at the
  `pool_registry` init constraint, so the lazy creation only matters on
  the first call. Net on-chain semantics are identical to the original
  `init_if_needed` design.

#### Changed

- **`salvage_pool` pre-flight gates wired** in `programs/grave-vault/src/instructions/salvage_pool.rs`:
  - Pause check (`ProtocolPaused`).
  - **Cert freshness** via `EligibilityCert::is_expired(now)` (`EligibilityCertExpired`).
  - **Cert criteria bitmap** must equal `0x3F` (all six derelict-pool
    criteria validated at Phase 2) (`InvalidEligibilityCert`).
  - **Cert pool / AMM binding** — `cert.amm_program_id == params.amm_program_id`
    AND `cert.pool_address == params.pool_address` (`InvalidEligibilityCert`).
  - Pool account address consistency (`PreflightFailed`).
- **`eligibility_cert` account** in `salvage_pool` migrated from
  `UncheckedAccount<'info>` to `Account<'info, EligibilityCert>`. Anchor
  now handles the 8-byte discriminator check and owner-program (`grave_scanner::ID`)
  validation automatically; the previous manual ownership require! is
  redundant and removed.
- **`lp_holder_pool_vault`** in `claim_lp_proceeds` migrated from
  `UncheckedAccount<'info>` to `SystemAccount<'info>` (read-only path,
  no `init` constraint — safe under Anchor 0.32). In `salvage_pool` the
  account is declared as `UncheckedAccount<'info>` with `mut, seeds,
  bump` (PDA validation only) and lazy-initialized via the manual CPI
  described above. The account remains charter-invariant unsweepable;
  only `claim_lp_proceeds` may debit it (against a valid Merkle proof,
  m6+).
- **`evaluate_pool_phase_2`** now reads `cfg.cert_ttl_seconds` from
  ProtocolConfig instead of the hardcoded const when stamping
  `cert.expires_at`.

#### Honest stubs (audit-pending, unchanged from v1.0.5)

- AMM `remove_liquidity` CPI for Raydium V4: wired in v1.0.5; not yet
  integration-tested against a seeded localnet pool (OpenBook seed harness
  is a v1.1 deliverable).
- AMM adapters for Raydium CLMM, Orca Whirlpool, PumpSwap: revert
  `AmmAdapterUnimplemented`.
- Locker release adapters (UNCX / PinkSale / Team Finance): revert
  `LockerAdapterUnimplemented`.
- Jupiter v6 swap CPI: not yet wired; m6 deliverable.
- 40/40/20 distribution math: not yet wired; m7 deliverable.
  `SalvageReceipt` distribution fields are zeroed at init.
- LP-holder Merkle proof verification in `claim_lp_proceeds`: returns
  `InvalidClaimProof` until m6 wires the SHA-256 sorted-pair verification.

#### Verification status

Locally verified on the official Solana 3.x stack (rust 1.91.1, anchor
0.32.1, solana 3.0.10, platform-tools v1.54):

- `cargo fmt --all -- --check`: clean
- `cargo clippy --workspace --all-targets -- -D warnings`: clean
- `cargo test --workspace --lib`: **20/20 pass** (19 grave-scanner + 1
  grave-vault)
- `cargo-build-sbf --tools-version v1.54`: BPF compile clean in ~51s

CI `anchor build` job is currently failing at the post-cargo-build-sbf
phase (anchor's IDL generation step) — investigation tracked in a
follow-up patch. The local cargo-build-sbf compile of both programs
succeeds, so the deployable BPF artifact is unaffected.

#### Pre-mainnet checklist

- Replace placeholder program IDs in both crates' `declare_id!` and
  `Anchor.toml` with real keypairs via `anchor keys list && anchor keys sync`.
- Re-deploy ProtocolConfig PDAs on devnet — adding `cert_ttl_seconds`
  changes `INIT_SPACE` and existing config accounts will fail `realloc`
  unless rotated through a fresh `initialize`. (Pre-mainnet: no live
  config exists, so this is a no-op for the canonical deploy path.)