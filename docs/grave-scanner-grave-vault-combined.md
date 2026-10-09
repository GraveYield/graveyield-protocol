# GraveScanner × GraveVault — Combined Technical Documentation

The two-program settlement architecture of the GraveYield Protocol: on-chain
eligibility certification and permissionless salvage settlement.

| | |
|---|---|
| **Version** | 3.0 (living markdown) |
| **Published snapshot** | `published/GraveScanner_GraveVault_CombinedTechnicalDocumentation_v3_0.docx` (external `.docx`; frozen) |
| **Governing specification** | [`PROTOCOL_SPEC.md`](PROTOCOL_SPEC.md) — wins on any disagreement |
| **Error codes** | [`error_codes.md`](error_codes.md) — authoritative; see §7 |
| **Status** | Implementation snapshot: Raydium AMM V4 + WSOL-quote pools on Solana devnet; not an audit or mainnet approval |

> **Living source.** The v3.0 `.docx` snapshot predates the on-main error-code
> numbering and other implementation details; where the snapshot and this
> markdown disagree, this markdown wins per [`README.md`](README.md). The
> error-code scheme in the snapshot's §4.2 is explicitly **superseded** by
> [`error_codes.md`](error_codes.md).

## 1. System overview

GraveYield implements a deterministic lifecycle for derelict AMM liquidity
as two cooperating Anchor programs:

- **GraveScanner** (`programs/grave-scanner/`) — the on-chain source of
  truth for eligibility. It validates pool identity and supported AMM
  account layouts, verifies oracle-signed evidence, evaluates the six
  derelict-pool criteria across a two-phase multi-epoch state machine, and
  issues the certificate the Vault consumes. It never moves liquidity.
- **GraveVault** (`programs/grave-vault/`) — the settlement engine. It
  consumes a fresh Scanner certificate, withdraws liquidity through the
  Raydium V4 CPI, converts the eligible recovered side through Jupiter v6
  under slippage guards, distributes recovered SOL 40 / 40 / 20, and
  records receipts and claims. It never evaluates eligibility.

The division is deliberate: certification is slow, evidence-heavy and
manipulation-resistant; settlement is fast, atomic and conservative. No
instruction in either program combines both roles, so no single compromised
path can both declare a pool derelict and move its funds.

**V1 scope boundaries.** Solana only; Raydium AMM V4 pools only; exactly
one pool side must be WSOL (both orientations supported: coin=WSOL and
pc=WSOL); LP-lock introspection covers the UNCX Raydium V4 locker only; no
protocol token, NFT, points programme, airdrop or staking layer exists at
any level. Other AMM adapters (Raydium CLMM, Orca Whirlpool, PumpSwap,
Meteora) are pre-mainnet stubs that revert as unimplemented.

## 2. Lifecycle: certification → settlement → claims

```
                     GraveScanner                        GraveVault
                     ------------                        ----------
launch-price oracle attestation
        |
        v
record_launch_price  (init-once LaunchPrice PDA)
        |
        v
evaluate_pool_phase_1  -- C1..C6 all pass -->  EligibilityAnchor (epoch E0)
        |
        |  >= 2 consecutive Solana epochs (about 4-6 days)
        v
evaluate_pool_phase_2  -- criteria re-pass + bitmap equality -->
                                             EligibilityCert (TTL, default 1 h)
                                                     |
                                                     v
                                          salvage_pool
                                            1. cert checks (fresh, bound, 0x3F)
                                            2. init-once registry + receipt PDAs
                                            3. Raydium V4 withdraw CPI
                                               (LP burned in salvor's account)
                                            4. Jupiter v6 conversion (guarded)
                                            5. WSOL -> SOL, 40 / 40 / 20 split
                                            6. SalvageReceipt + events
                                                     |
                                                     v
                                          claim_lp_proceeds  (per holder,
                                            Merkle-verified, no expiration)
                                          sweep_dust        (one-shot)
```

Key structural properties:

- **One settlement per pool, ever.** The PoolRegistry and SalvageReceipt
  PDAs are init-once; a second successful salvage for the same pool reverts
  before any lamports move.
- **Two live certs are impossible.** A live EligibilityCert cannot be
  overwritten (`CertStillValid`, 6034); an expired one is reissued in place
  by a later Phase 2 that re-runs the full verification stack with a fresh
  C1 attestation (spec D10). `reissue_generation` counts issues.
- **Settlement is exactly conservative.** The protocol share is computed as
  the remainder of recovered lamports, so the three transfers exhaust the
  proceeds; the rounding remainder accrues to the protocol share.
- **Dust is never silently lost.** Conversion amounts below the dust
  threshold skip the swap; the retained memecoin is recorded on the receipt
  and recoverable through the one-shot `sweep_dust`.

## 3. Evidence model (shared by both programs)

Two criteria consume inputs that cannot be derived on-chain, because
Raydium V4's layout stores no last-swap field and Solana programs cannot
read historical account state. Both arrive as Ed25519 signatures verified
in-transaction via the `ed25519_program` precompile; the scanner requires
the verify instruction to sit immediately before the scanner instruction,
with offsets binding the signature to the embedded message.

| Attestation | Size | Bound fields | Freshness | Consumer |
|-------------|------|--------------|-----------|----------|
| Last-swap (C1) | 112 bytes | `amm_program_id ‖ pool_address ‖ last_swap_unix_ts ‖ issued_slot ‖ slot_hash` | `issued_slot` must resolve in SlotHashes (~512 slots, ≈3.4 minutes) | `evaluate_pool_phase_1`, `evaluate_pool_phase_2` |
| Launch price (C2) | 168 bytes | `amm_program_id ‖ pool_address ‖ base_mint ‖ quote_mint ‖ first_swap_slot ‖ first_swap_unix_ts ‖ launch_price_q64x64 ‖ issued_slot` | None — historical fact recorded into the init-once LaunchPrice PDA; replay is structurally impossible | `record_launch_price` |

The two signing keys are deliberately separate governance-registered
Ed25519 identities (`ProtocolConfig.activity_oracle` and
`ProtocolConfig.launch_price_oracle`), both rotatable via
`update_protocol_config`: the launch-price baseline is permanently binding,
so its key is isolated from the hotter activity key. The residual trust
boundary — oracle honesty about derivation and service availability — is
documented (spec §6.3 / D8 / D9), not hidden, and remains the protocol's
principal operational dependency. Operations status: [`DEVNET.md`](DEVNET.md)
and the pre-mainnet checklist
([`PRE_MAINNET_CHECKLIST.md`](PRE_MAINNET_CHECKLIST.md), ORACLE-003).

## 4. GraveScanner reference

### 4.1 Instructions

| Instruction | Access | Behavior summary |
|-------------|--------|------------------|
| `initialize` | Authority (one-time) | Creates the singleton Scanner ProtocolConfig: thresholds, oracle keys, pause flag. |
| `record_launch_price` | Permissionless + oracle signature | Stores the 168-byte-attested launch-price baseline; init-once per pool; validates mint binding. |
| `evaluate_pool_phase_1` | Permissionless + oracle signature | Parses the Raydium V4 layout, evaluates C1–C6, writes EligibilityAnchor (`first_eligible_epoch`, bitmap). No state on failure. |
| `evaluate_pool_phase_2` | Permissionless + oracle signature | Re-evaluates after the epoch gap; requires fresh C1 and bitmap equality with the anchor; creates or reissues EligibilityCert. |
| `invalidate_anchor` | Authority | Marks an anchor invalid; it can never lead to a certificate. |
| `sweep_stale_anchor` | Permissionless | Closes an uncertified anchor after the staleness window (default 14 days); rent returns to the writer. |
| `update_protocol_config` | Authority | Updates bounded thresholds and oracle keys; violates a locked invariant → `InvariantViolation` (6006); TTL floor 10 minutes (6019). |
| `emergency_pause` | Authority | Sets/clears the Scanner pause flag; gates Phase 1/2 only. |

### 4.2 State

| Account | Seeds | Contents |
|---------|-------|----------|
| ProtocolConfig | `["protocol_config"]` | Authority, thresholds, oracle keys, pause status. |
| LaunchPrice | `["launch_price", amm_program_id, pool_address]` | Mint pair, launch price (q64x64), first-swap slot/time evidence. Init-once. |
| EligibilityAnchor | `["eligibility_anchor", amm_program_id, pool_address]` | First eligible epoch, criteria bitmap, writer, invalidation state. |
| EligibilityCert | `["eligibility_cert", amm_program_id, pool_address]` | Expiry (`expires_at`), bitmap, `reissue_generation`. Consumed by GraveVault. |

### 4.3 Eligibility criteria (defaults from the initialized devnet config)

| ID | Criterion | Default threshold | Evidence |
|----|-----------|-------------------|----------|
| C1 | Trading inactivity | ≥ 90 days (7,776,000 s) since last swap | 112-byte activity-oracle attestation, SlotHashes-fresh |
| C2 | Price collapse from launch | ≥ 99% (9,900 bps) decline | 168-byte launch-price attestation vs on-chain spot from reserves |
| C3 | Minimum residual TVL | ≥ 500,000,000 raw units, quote-side (`pc_vault`) reserve | Read on-chain; raw units — see the unit-parity caveat in [`technical-documentation.md`](technical-documentation.md) §2 |
| C4 | LP supply not burned | LP mint supply > 1,000 raw units | LP mint SPL supply, read on-chain |
| C5 | LP not locked | Locked amount exactly zero | UNCX marker-PDA gate + strictly validated TokenLock evidence (errors 6020–6023) |
| C6 | Multi-epoch confirmation | ≥ 2 consecutive epochs between Phase 1 and Phase 2; identical bitmaps | On-chain anchor/cert state |

All six must hold simultaneously — the evaluator is a conjunction, not a
score; the resulting bitmap must be `0x3F` for settlement.

## 5. GraveVault reference

### 5.1 Instructions

| Instruction | Access | Behavior summary |
|-------------|--------|------------------|
| `initialize` | Authority (one-time) | Creates the Vault ProtocolConfig: split parameters, slippage/dust/fee policy, pause flag. |
| `update_protocol_config` | Authority | Updates bounded parameters; `protocol_share_bps` can never exceed 2,000 (ceiling enforced on-chain, 7005). |
| `emergency_pause` | Authority | Pauses new `salvage_pool` calls; `claim_lp_proceeds` stays live (Charter). |
| `salvage_pool` | Permissionless | Full settlement path: cert validation → init-once registry/receipt → orientation check → Raydium V4 withdraw CPI (LP burned in the salvor's own account) → guarded Jupiter conversion → WSOL→SOL → 40/40/20 → receipt + events. |
| `claim_lp_proceeds` | Permissionless per holder | Merkle-verified pro-rata payout from `lp_holder_pool_vault`; ClaimRecord prevents double claims; callable during pause; no expiration. |
| `sweep_dust` | Permissionless | One-shot, mint-bound transfer of retained memecoin to the treasury ATA; closes the Vault token account; rent goes to the sweeper. |

### 5.2 Settlement allocation

| Bucket | Share | Custody |
|--------|-------|---------|
| Snapshot LP holders | 40% | `lp_holder_pool_vault` PDA — unsweepable by any admin key; only Merkle-verified claims debit it |
| Salvor | 40% | Paid to the transaction's salvor |
| Protocol treasury | ≤ 20% (default 20%) | Computed as the remainder; ceiling enforced on-chain |

### 5.3 State

| Account | Seeds | Contents |
|---------|-------|----------|
| ProtocolConfig | `["protocol_config"]` | Authority, splits, slippage/dust/fee policy, pause flag. |
| PoolRegistry | `["pool_registry", pool_address]` | Immutable salvage record: snapshot root/supply, bucket totals, claimed amount, timestamps. Init-once. |
| `lp_holder_pool_vault` | `["lp_holder_pool", pool_address]` | System-owned SOL bucket for the LP-holder share. No admin sweep path exists (`LpHolderPoolUnsweepable`, 7006, is a reserved tripwire). |
| SalvageReceipt | `["salvage_receipt", pool_address]` | Settlement amounts/times, memecoin mint, retained amount, `dust_swept_at_ts`. Init-once. |
| ClaimRecord | `["claim_record", pool_address, holder]` | One-time per (pool, holder) claim marker. |
| Vault authority | `["vault_authority"]` | PDA signer for required token transfers. |

### 5.4 Claims and the snapshot contract

- Leaf: `SHA256(holder_pubkey_32_bytes ‖ balance_u64_little_endian)`;
  parents: `SHA256(min ‖ max)` sorted-pair hashing; odd nodes promote
  unchanged. Identical convention in the Rust snapshotter, the TypeScript
  SDK and the on-chain verifier.
- `claim_amount = floor(lp_holder_pool_total_lamports ×
  lp_balance_at_snapshot / lp_total_supply_at_snapshot)`.
- The snapshotter enumerates LP token accounts for the LP mint with a hard
  completeness gate (sum of balances == mint supply), attributes UNCX-locked
  LP to the beneficial `TokenLock.lock_owner`, and fails closed on ambiguous
  custody; it seals a self-verifying deterministic JSON artifact.
- Supply equality at salvage time does not prove per-holder balances are
  unchanged since the snapshot; snapshot freshness and handling remain
  operational controls. Snapshot ownership is current LP-token ownership —
  not a cryptographic proof of launch-time identity.

## 6. PDA seed conventions (normative)

Per [`../CONTRIBUTING.md`](../CONTRIBUTING.md), do not invent new seed
schemes ad-hoc. The complete list:

| Program | PDA | Seeds |
|---------|-----|-------|
| GraveScanner | ProtocolConfig | `["protocol_config"]` |
| GraveScanner | LaunchPrice | `["launch_price", amm_program_id, pool_address]` |
| GraveScanner | EligibilityAnchor | `["eligibility_anchor", amm_program_id, pool_address]` |
| GraveScanner | EligibilityCert | `["eligibility_cert", amm_program_id, pool_address]` |
| GraveVault | ProtocolConfig | `["protocol_config"]` |
| GraveVault | PoolRegistry | `["pool_registry", pool_address]` |
| GraveVault | `lp_holder_pool_vault` | `["lp_holder_pool", pool_address]` |
| GraveVault | SalvageReceipt | `["salvage_receipt", pool_address]` |
| GraveVault | ClaimRecord | `["claim_record", pool_address, holder]` |
| GraveVault | Vault authority | `["vault_authority"]` |

Note the two Scanner/Vault ProtocolConfig PDAs share the seed string
`["protocol_config"]` but are namespaced by their own program IDs — they
are distinct accounts.

## 7. Error codes

The authoritative on-chain error tables live in
[`error_codes.md`](error_codes.md), which mirrors
`programs/grave-scanner/src/errors.rs` and `programs/grave-vault/src/errors.rs`
exactly and is updated in lock-step with them. This document deliberately
does not re-tabulate the codes. Summary shape:

- **GraveScanner: 6000–6034** — authority/pause gates (6000, 6010),
  criteria and evidence failures (6001–6009, 6011, 6015–6017),
  anchor housekeeping (6018), config bounds (6019, 6034), UNCX locker
  evidence (6020–6023), attestation verification (6024–6033).
- **GraveVault: 7000–7021** — authority/pause (7000, 7003), certificate
  freshness (7001, 7002), settlement invariants (7004–7006), conversion
  guards (7007, 7012, 7015–7019), claims (7010, 7011), snapshot integrity
  (7013, 7018), dust (7020, 7021), reserved process-enforced slots (7008,
  7014).

When this document and `error_codes.md` disagree, `error_codes.md` wins.

## 8. Security boundaries

| Boundary | Enforcement | Notes |
|----------|-------------|-------|
| Eligibility correctness | On-chain (Scanner) | Phase 2 cannot silently downgrade a Phase 1 pass; bitmap equality closes parameter drift between phases. |
| Evidence authenticity | On-chain cryptographic validation | Precompile signature checks + payload binding; oracle honesty/availability stays an operational boundary. |
| Locker completeness | Partially on-chain | UNCX strictly validated; other lockers are an out-of-band operator check in v1 (LOCKER-002). |
| Settlement conservation | On-chain (Vault) | Remainder to protocol share; shares sum to 10,000 bps (7004); protocol share ≤ 20% (7005). |
| Route safety | On-chain | Route accounts screened against Vault custody/state; Vault WSOL destination must be present; pre-CPI floor + post-CPI output floor; per-tx slippage override can only tighten. |
| Restitution guarantee | On-chain PDA topology | `lp_holder_pool_vault` has no debit path except Merkle-verified claims; claims live during pause; no expiration. |
| Priority-fee ceiling | SDK/operator only | A callee program cannot observe compute-unit prices; 7008 is reserved. See [`architecture/priority-fee-policy.md`](architecture/priority-fee-policy.md). |
| 72-hour parameter timelock | Governance process (Squads v4 buffers) | Not program-enforced in v1.0 (7014 reserved; GOV-001 open). |

## 9. Deployment status

Both programs are deployed to Solana devnet with configurations initialized
at specification defaults; the rehearsed emergency-control drill passed on
9 October 2026 (authority pause → intruder rejection, 6000/7000 → unpause →
readback). Program IDs, drill evidence and qualification limits:
[`DEVNET.md`](DEVNET.md). Devnet upgrade authority is the single deployer
keypair; mainnet requires fresh custody-generated keys and the multisig
transition (KEYS-003). Devnet is not mainnet.

## 10. Terminology

Canonical v4.0 vocabulary is defined in [`glossary.md`](glossary.md) and
enforced by CI: the actor is a **salvor** (a finder under maritime salvage
law), the act is **salvage**, and the subject is a **derelict pool**. This
document is settlement infrastructure documentation — it takes no
discretion and describes no discretionary actor.
