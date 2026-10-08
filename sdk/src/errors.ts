// SPDX-License-Identifier: Apache-2.0
//
// GraveYield program error decoding — full mirror of
// `docs/error_codes.md` (last verified 2026-05-16 against both
// `errors.rs` files at Phase 1.4). Anchor custom errors surface as
// `InstructionError::Custom(code)` in transaction logs:
//
//     "custom program error: 0x1770"  (GraveScanner Unauthorized = 6000)
//     "custom program error: 0x1b58"  (GraveVault   Unauthorized = 7000)
//
// The mirror below covers every code both programs emit so an SDK
// consumer can render a stable name without re-parsing the markdown.

/** A decoded GraveYield program error. */
export interface DecodedGraveYieldError {
  /** Numeric code as emitted on chain (6000–6034 scanner, 7000–7021 vault). */
  code: number;
  /** Lowercase hex form, e.g. `0x1770`. */
  hex: string;
  /** Program family: `"GraveScanner"` or `"GraveVault"`. */
  program: "GraveScanner" | "GraveVault";
  /** Stable Rust enum variant name, e.g. `Unauthorized`. */
  name: string;
  /** One-line description of the condition. */
  description: string;
}

interface ErrorMeta {
  program: "GraveScanner" | "GraveVault";
  name: string;
  description: string;
}

const ERROR_TABLE: Record<number, ErrorMeta> = {
  // ===== GraveScanner (6000-6034) =====
  6000: { program: "GraveScanner", name: "Unauthorized", description: "Caller lacks the multisig authority required." },
  6001: { program: "GraveScanner", name: "PoolNotEligible", description: "Pool does not satisfy all six derelict-pool criteria." },
  6002: { program: "GraveScanner", name: "LaunchPriceNotFound", description: "LaunchPrice PDA missing for this pool." },
  6003: { program: "GraveScanner", name: "UnsupportedAmm", description: "AMM program mismatch or unsupported pool layout." },
  6004: { program: "GraveScanner", name: "MathOverflow", description: "Arithmetic overflow during eligibility computation." },
  6005: { program: "GraveScanner", name: "InvalidClock", description: "Clock sysvar unavailable or returned invalid data." },
  6006: { program: "GraveScanner", name: "InvariantViolation", description: "ProtocolConfig update violates a locked invariant." },
  6007: { program: "GraveScanner", name: "AmmAdapterUnimplemented", description: "AMM adapter registered but parser is a pre-mainnet stub." },
  6008: { program: "GraveScanner", name: "LockerAdapterUnimplemented", description: "Locker adapter registered but not implemented." },
  6009: { program: "GraveScanner", name: "PoolDataParseError", description: "Pool account data did not match the expected layout." },
  6010: { program: "GraveScanner", name: "ProtocolPaused", description: "GraveScanner is paused; evaluate_pool_* reverts." },
  6011: { program: "GraveScanner", name: "CriteriaBitmapMismatch", description: "Phase 2 produced a bitmap that disagrees with the originating EligibilityAnchor." },
  6015: { program: "GraveScanner", name: "AnchorNotFound", description: "Phase 2 attempted without an EligibilityAnchor PDA." },
  6016: { program: "GraveScanner", name: "EpochConfirmationPending", description: "Phase 2 attempted before the multi-epoch confirmation gap elapsed." },
  6017: { program: "GraveScanner", name: "AnchorInvalidated", description: "EligibilityAnchor was invalidated by multisig." },
  6018: { program: "GraveScanner", name: "AnchorNotStale", description: "sweep_stale_anchor called before the staleness window elapsed." },
  6019: { program: "GraveScanner", name: "CertTtlBelowMinimum", description: "update_protocol_config rejected a cert_ttl_seconds below 600s." },
  6020: { program: "GraveScanner", name: "LockerMarkerAccountRequired", description: "UNCX per-pool lock marker PDA was not supplied in remaining_accounts." },
  6021: { program: "GraveScanner", name: "LockerLockEvidenceRequired", description: "UNCX marker exists but no TokenLock evidence was supplied." },
  6022: { program: "GraveScanner", name: "InvalidLockerAccount", description: "A supplied locker-program account failed validation." },
  6023: { program: "GraveScanner", name: "LockerAccountMismatch", description: "A supplied TokenLock is bound to a different (amm_id, lp_mint) pair." },
  6024: { program: "GraveScanner", name: "AttestationMissing", description: "No ed25519_program verify instruction precedes the scanner instruction." },
  6025: { program: "GraveScanner", name: "InvalidAttestationOffsets", description: "The precompile's Ed25519SignatureOffsets are malformed." },
  6026: { program: "GraveScanner", name: "AttestationOracleMismatch", description: "Public key covered by the runtime-verified signature is not the configured activity_oracle." },
  6027: { program: "GraveScanner", name: "AttestationBindingMismatch", description: "Attestation binds different values than the instruction params echo." },
  6028: { program: "GraveScanner", name: "AttestationTimestampInvalid", description: "Attested last-swap timestamp is zero or in the future." },
  6029: { program: "GraveScanner", name: "AttestationStale", description: "Attestation issued_slot no longer resolves in SlotHashes (~512-slot window expired)." },
  6030: { program: "GraveScanner", name: "AttestationSlotHashMismatch", description: "Attested slot hash does not match the chain's SlotHashes entry for issued_slot." },
  6031: { program: "GraveScanner", name: "AttestationSlotInvalid", description: "Attestation issued_slot is zero or in the future relative to current slot." },
  6032: { program: "GraveScanner", name: "InvalidLaunchPrice", description: "Attested launch price is zero." },
  6033: { program: "GraveScanner", name: "LaunchPriceMintMismatch", description: "Recorded launch-price baseline belongs to a different token pair." },
  6034: { program: "GraveScanner", name: "CertStillValid", description: "Phase 2 re-run while EligibilityCert is still live — wait for TTL then reissue in place." },

  // ===== GraveVault (7000-7021) =====
  7000: { program: "GraveVault", name: "Unauthorized", description: "Caller lacks the multisig authority required for this instruction." },
  7001: { program: "GraveVault", name: "InvalidEligibilityCert", description: "EligibilityCert PDA missing, expired, or owned by the wrong program." },
  7002: { program: "GraveVault", name: "EligibilityCertExpired", description: "EligibilityCert TTL has passed. Re-run Phase 2 to mint a fresh cert." },
  7003: { program: "GraveVault", name: "ProtocolPaused", description: "Protocol is paused — only claim_lp_proceeds is callable." },
  7004: { program: "GraveVault", name: "InvalidShareSplit", description: "Distribution shares (LP/salvor/protocol) did not sum to 10_000 bps." },
  7005: { program: "GraveVault", name: "ProtocolShareExceedsCeiling", description: "Attempted to raise protocol_share_bps above the Charter ceiling (2000 bps)." },
  7006: { program: "GraveVault", name: "LpHolderPoolUnsweepable", description: "Attempted to sweep, close, or drain lp_holder_pool_vault — Charter invariant." },
  7007: { program: "GraveVault", name: "SlippageExceeded", description: "Slippage on the Jupiter swap leg exceeded the configured maximum." },
  7008: { program: "GraveVault", name: "PriorityFeeExceedsCeiling", description: "Transaction priority fee exceeds the Charter ceiling (reserved)." },
  7009: { program: "GraveVault", name: "MathOverflow", description: "Arithmetic overflow during distribution math." },
  7010: { program: "GraveVault", name: "InvalidClaimProof", description: "LP holder is not in the snapshot Merkle tree, or proof is invalid." },
  7011: { program: "GraveVault", name: "ClaimAlreadyProcessed", description: "Claim already processed for this (pool, lp_holder) pair." },
  7012: { program: "GraveVault", name: "BelowDustThreshold", description: "Quote output below the Jupiter dust threshold (reserved)." },
  7013: { program: "GraveVault", name: "PreflightFailed", description: "Pre-flight check against the on-chain pool failed." },
  7014: { program: "GraveVault", name: "TimelockNotElapsed", description: "Timelock window has not yet elapsed for a queued parameter change (reserved)." },
  7015: { program: "GraveVault", name: "AmmRedemptionFailed", description: "AMM remove_liquidity CPI returned an error or zero output." },
  7016: { program: "GraveVault", name: "JupiterSwapFailed", description: "Jupiter v6 swap CPI returned an error or zero output." },
  7017: { program: "GraveVault", name: "AmmCpiUnimplemented", description: "AMM CPI adapter is a pre-mainnet stub (CLMM/Orca/PumpSwap)." },
  7018: { program: "GraveVault", name: "InvalidSnapshotData", description: "Salvor's lp_total_supply_at_snapshot does not match the on-chain LP mint supply." },
  7019: { program: "GraveVault", name: "UnsupportedBaseToken", description: "Pool base token is not WSOL." },
  7020: { program: "GraveVault", name: "DustNothingToSweep", description: "sweep_dust found no retained memecoin." },
  7021: { program: "GraveVault", name: "DustAlreadySwept", description: "sweep_dust already ran for this pool — one-shot by design." },
};

/** Decode a program error from a thrown transaction/log object. Returns `undefined` if the input is not a recognized GraveYield custom error. */
export function decodeGraveYieldError(err: unknown): DecodedGraveYieldError | undefined {
  const s = String((err as { message?: string; stack?: string } | undefined)?.message ?? err);
  const m = /custom program error: 0x([0-9a-fA-F]+)/.exec(s);
  if (!m || !m[1]) return undefined;
  return decodeGraveYieldErrorCode(parseInt(m[1], 16));
}

/** Decode a program error from a numeric code (e.g. 6000, 7007). */
export function decodeGraveYieldErrorCode(code: number): DecodedGraveYieldError | undefined {
  const meta = ERROR_TABLE[code];
  if (!meta) return undefined;
  return {
    code,
    hex: `0x${code.toString(16)}`,
    program: meta.program,
    name: meta.name,
    description: meta.description,
  };
}

/** Throw if `err` is a GraveYield custom error matching one of `codes`; otherwise rethrow `err` unchanged. */
export function assertNotGraveYieldError(err: unknown, ...codes: number[]): void {
  const decoded = decodeGraveYieldError(err);
  if (decoded && codes.includes(decoded.code)) {
    throw new Error(
      `unexpected GraveYield error ${decoded.program}::${decoded.name} (${decoded.hex}): ${decoded.description}`,
    );
  }
  throw err;
}
