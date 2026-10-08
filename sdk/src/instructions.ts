// SPDX-License-Identifier: Apache-2.0
//
// GraveYield instruction builders — IDL-free Anchor instruction data +
// account-meta constructors. Mirrors the pattern proven in
// `scripts/devnet/protocol_admin.mjs`:
//
//   * `discriminator = sha256("global:<snake_case>")[0..8]`
//   * hand-rolled borsh for params (mirror the Rust structs field-by-field)
//   * PDA via `PublicKey.findProgramAddressSync(seeds, programId)`
//   * account meta via the same `isSigner` / `isWritable` shape Anchor
//     emits.
//
// Every builder is a pure function — it returns a `TransactionInstruction`
// without touching the network. The caller assembles them into a
// `Transaction`, attaches a blockhash + priority-fee instructions, and
// signs/submits. The top-level `GraveYieldClient` operations wrap these
// builders with the read-back / priority-fee / simulation helpers.

import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_SLOT_HASHES_PUBKEY,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { writer } from "./borsh.js";
import { ScannerIx, VaultIx } from "./discriminators.js";
import {
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
  eligibilityAnchorPda,
  eligibilityCertPda,
  launchPricePda,
  poolRegistryPda,
  salvageReceiptPda,
  lpHolderPoolVaultPda,
  claimRecordPda,
  protocolTreasuryPda,
  vaultAuthorityPda,
  vaultSolHoldingPda,
} from "./pdas.js";
import { WSOL_MINT, RAYDIUM_V4_PROGRAM_ID, JUPITER_V6_PROGRAM_ID } from "./raydiumV4Constants.js";

/** Helper: convert a PublicKey to an AccountMeta with `isSigner=false, isWritable=false`. */
function metaReadOnly(pubkey: PublicKey): AccountMeta {
  return { pubkey, isSigner: false, isWritable: false };
}
/** Helper: convert a PublicKey to a writable AccountMeta. */
function metaWritable(pubkey: PublicKey): AccountMeta {
  return { pubkey, isSigner: false, isWritable: true };
}
/** Helper: convert a PublicKey to a signer AccountMeta. */
function metaSigner(pubkey: PublicKey, writable = true): AccountMeta {
  return { pubkey, isSigner: true, isWritable: writable };
}

/** 32-byte raw of a PublicKey (for borsh writer). */
function pkBytes(p: PublicKey): Uint8Array {
  return p.toBytes();
}

// ============================================================ GraveScanner

/** Build GraveScanner::initialize. params: authority(32) u64 u16 u64 u64 u64 i64 = 74 bytes. */
export function buildScannerInitializeIx(opts: {
  scannerProgramId: PublicKey;
  authority: PublicKey;
  payer: PublicKey;
  /** Override defaults; pass `0`-like for a field to take the program default. */
  inactivitySeconds?: number | bigint;
  priceCollapseBps?: number;
  minTvlLamports?: number | bigint;
  anchorStalenessSeconds?: number | bigint;
  lpBurnDustThreshold?: number | bigint;
  certTtlSeconds?: number | bigint;
}): TransactionInstruction {
  const dataBytes = writer(8 + 74)
    .bytes(ScannerIx.initialize)
    .bytes(pkBytes(opts.authority))
    .u64(opts.inactivitySeconds ?? 0)
    .u16(opts.priceCollapseBps ?? 0)
    .u64(opts.minTvlLamports ?? 0)
    .u64(opts.anchorStalenessSeconds ?? 0)
    .u64(opts.lpBurnDustThreshold ?? 0)
    .i64(opts.certTtlSeconds ?? 0)
    .done();
  return new TransactionInstruction({
    programId: opts.scannerProgramId,
    keys: [
      metaWritable(scannerProtocolConfigPda(opts.scannerProgramId)),
      metaSigner(opts.payer),
      metaReadOnly(SystemProgram.programId),
    ],
    data: Buffer.from(dataBytes),
  });
}

/** Build GraveScanner::record_launch_price. */
export function buildRecordLaunchPriceIx(opts: {
  scannerProgramId: PublicKey;
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  launchPriceQ64x64: bigint;
  /** 168-byte canonical attestation message — `buildLaunchPriceMessage`. */
  msg: Uint8Array;
  payer: PublicKey;
}): TransactionInstruction {
  if (opts.msg.length !== 168) {
    throw new Error(`record_launch_price msg must be 168 bytes (got ${opts.msg.length})`);
  }
  const dataBytes = writer(8 + 32 * 4 + 16 + 168)
    .bytes(ScannerIx.recordLaunchPrice)
    .bytes(pkBytes(opts.ammProgramId))
    .bytes(pkBytes(opts.poolAddress))
    .bytes(pkBytes(opts.baseMint))
    .bytes(pkBytes(opts.quoteMint))
    .u128(opts.launchPriceQ64x64)
    .bytes(opts.msg)
    .done();
  return new TransactionInstruction({
    programId: opts.scannerProgramId,
    keys: [
      metaWritable(launchPricePda(opts.scannerProgramId, opts.ammProgramId, opts.poolAddress)),
      metaReadOnly(scannerProtocolConfigPda(opts.scannerProgramId)),
      metaReadOnly(SYSVAR_INSTRUCTIONS_PUBKEY),
      metaSigner(opts.payer),
      metaReadOnly(SystemProgram.programId),
    ],
    data: Buffer.from(dataBytes),
  });
}

/** Build GraveScanner::evaluate_pool_phase_1. */
export function buildEvaluatePoolPhase1Ix(opts: {
  scannerProgramId: PublicKey;
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  /** 112-byte canonical attestation message — `buildAttestationMessage`. */
  msg: Uint8Array;
  writer: PublicKey;
  /** `remaining_accounts`: pool + coin_vault + pc_vault + lp_mint (+ locker accounts). */
  remainingAccounts?: ReadonlyArray<AccountMeta>;
}): TransactionInstruction {
  if (opts.msg.length !== 112) {
    throw new Error(`evaluate_pool_phase_1 msg must be 112 bytes (got ${opts.msg.length})`);
  }
  const dataBytes = writer(8 + 32 + 32 + 112)
    .bytes(ScannerIx.evaluatePoolPhase1)
    .bytes(pkBytes(opts.ammProgramId))
    .bytes(pkBytes(opts.poolAddress))
    .bytes(opts.msg)
    .done();
  const keys: AccountMeta[] = [
    metaReadOnly(scannerProtocolConfigPda(opts.scannerProgramId)),
    metaWritable(eligibilityAnchorPda(opts.scannerProgramId, opts.ammProgramId, opts.poolAddress)),
    metaReadOnly(launchPricePda(opts.scannerProgramId, opts.ammProgramId, opts.poolAddress)),
    metaWritable(opts.poolAddress),
    metaReadOnly(SYSVAR_INSTRUCTIONS_PUBKEY),
    metaReadOnly(SYSVAR_SLOT_HASHES_PUBKEY),
    metaSigner(opts.writer),
    metaReadOnly(SystemProgram.programId),
    ...(opts.remainingAccounts ?? []),
  ];
  return new TransactionInstruction({
    programId: opts.scannerProgramId,
    keys,
    data: Buffer.from(dataBytes),
  });
}

/** Build GraveScanner::evaluate_pool_phase_2. */
export function buildEvaluatePoolPhase2Ix(opts: {
  scannerProgramId: PublicKey;
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  /** 112-byte canonical attestation message — `buildAttestationMessage`. */
  msg: Uint8Array;
  writer: PublicKey;
  /** `remaining_accounts`: pool + coin_vault + pc_vault + lp_mint (+ locker accounts). */
  remainingAccounts?: ReadonlyArray<AccountMeta>;
}): TransactionInstruction {
  if (opts.msg.length !== 112) {
    throw new Error(`evaluate_pool_phase_2 msg must be 112 bytes (got ${opts.msg.length})`);
  }
  const dataBytes = writer(8 + 32 + 32 + 112)
    .bytes(ScannerIx.evaluatePoolPhase2)
    .bytes(pkBytes(opts.ammProgramId))
    .bytes(pkBytes(opts.poolAddress))
    .bytes(opts.msg)
    .done();
  const keys: AccountMeta[] = [
    metaReadOnly(scannerProtocolConfigPda(opts.scannerProgramId)),
    metaReadOnly(eligibilityAnchorPda(opts.scannerProgramId, opts.ammProgramId, opts.poolAddress)),
    metaWritable(eligibilityCertPda(opts.scannerProgramId, opts.ammProgramId, opts.poolAddress)),
    metaReadOnly(launchPricePda(opts.scannerProgramId, opts.ammProgramId, opts.poolAddress)),
    metaWritable(opts.poolAddress),
    metaReadOnly(SYSVAR_INSTRUCTIONS_PUBKEY),
    metaReadOnly(SYSVAR_SLOT_HASHES_PUBKEY),
    metaSigner(opts.writer),
    metaReadOnly(SystemProgram.programId),
    ...(opts.remainingAccounts ?? []),
  ];
  return new TransactionInstruction({
    programId: opts.scannerProgramId,
    keys,
    data: Buffer.from(dataBytes),
  });
}

/** Build GraveScanner::emergency_pause (params: bool). */
export function buildScannerEmergencyPauseIx(opts: {
  scannerProgramId: PublicKey;
  authority: PublicKey;
  paused: boolean;
}): TransactionInstruction {
  const dataBytes = writer(9).bytes(ScannerIx.emergencyPause).bool(opts.paused).done();
  return new TransactionInstruction({
    programId: opts.scannerProgramId,
    keys: [
      metaWritable(scannerProtocolConfigPda(opts.scannerProgramId)),
      metaSigner(opts.authority, false),
    ],
    data: Buffer.from(dataBytes),
  });
}

/** Build GraveScanner::invalidate_anchor (multisig-only). */
export function buildInvalidateAnchorIx(opts: {
  scannerProgramId: PublicKey;
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  authority: PublicKey;
}): TransactionInstruction {
  const dataBytes = writer(8 + 32 + 32)
    .bytes(ScannerIx.invalidateAnchor)
    .bytes(pkBytes(opts.ammProgramId))
    .bytes(pkBytes(opts.poolAddress))
    .done();
  return new TransactionInstruction({
    programId: opts.scannerProgramId,
    keys: [
      metaReadOnly(scannerProtocolConfigPda(opts.scannerProgramId)),
      metaWritable(eligibilityAnchorPda(opts.scannerProgramId, opts.ammProgramId, opts.poolAddress)),
      metaSigner(opts.authority, false),
    ],
    data: Buffer.from(dataBytes),
  });
}

/** Build GraveScanner::sweep_stale_anchor (permissionless). */
export function buildSweepStaleAnchorIx(opts: {
  scannerProgramId: PublicKey;
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  /** Refund destination (default: the original anchor writer — the caller passes it). */
  refundTo: PublicKey;
  /** Optional caller (signer-only when rent reclaim is gated). Defaults to refundTo. */
  caller?: PublicKey;
}): TransactionInstruction {
  const dataBytes = ScannerIx.sweepStaleAnchor; // no params
  const keys: AccountMeta[] = [
    metaReadOnly(scannerProtocolConfigPda(opts.scannerProgramId)),
    metaWritable(eligibilityAnchorPda(opts.scannerProgramId, opts.ammProgramId, opts.poolAddress)),
    metaWritable(opts.refundTo),
    metaSigner(opts.caller ?? opts.refundTo, false),
    metaReadOnly(SystemProgram.programId),
  ];
  return new TransactionInstruction({
    programId: opts.scannerProgramId,
    keys,
    data: Buffer.from(dataBytes),
  });
}

// ============================================================== GraveVault

/** Build GraveVault::initialize. params: authority(32) u16 u16 u16 u64 u16 u64 i64 = 64 bytes. */
export function buildVaultInitializeIx(opts: {
  vaultProgramId: PublicKey;
  authority: PublicKey;
  payer: PublicKey;
  lpHolderShareBps?: number;
  salvorShareBps?: number;
  protocolShareBps?: number;
  maxPriorityFeeCeilingLamports?: number | bigint;
  maxSlippageBps?: number;
  jupiterDustThresholdLamports?: number | bigint;
  timelockSeconds?: number | bigint;
}): TransactionInstruction {
  const dataBytes = writer(8 + 64)
    .bytes(VaultIx.initialize)
    .bytes(pkBytes(opts.authority))
    .u16(opts.lpHolderShareBps ?? 0)
    .u16(opts.salvorShareBps ?? 0)
    .u16(opts.protocolShareBps ?? 0)
    .u64(opts.maxPriorityFeeCeilingLamports ?? 0)
    .u16(opts.maxSlippageBps ?? 0)
    .u64(opts.jupiterDustThresholdLamports ?? 0)
    .i64(opts.timelockSeconds ?? 0)
    .done();
  return new TransactionInstruction({
    programId: opts.vaultProgramId,
    keys: [
      metaWritable(vaultProtocolConfigPda(opts.vaultProgramId)),
      metaSigner(opts.payer),
      metaReadOnly(SystemProgram.programId),
    ],
    data: Buffer.from(dataBytes),
  });
}

/** Build GraveVault::emergency_pause (params: bool). */
export function buildVaultEmergencyPauseIx(opts: {
  vaultProgramId: PublicKey;
  authority: PublicKey;
  paused: boolean;
}): TransactionInstruction {
  const dataBytes = writer(9).bytes(VaultIx.emergencyPause).bool(opts.paused).done();
  return new TransactionInstruction({
    programId: opts.vaultProgramId,
    keys: [
      metaWritable(vaultProtocolConfigPda(opts.vaultProgramId)),
      metaSigner(opts.authority, false),
    ],
    data: Buffer.from(dataBytes),
  });
}

/**
 * Build GraveVault::claim_lp_proceeds. The Merkle proof comes from the
 * snapshot artifact (`SnapshotResult.proofs[index]`).
 */
export function buildClaimLpProceedsIx(opts: {
  vaultProgramId: PublicKey;
  poolAddress: PublicKey;
  lpHolder: PublicKey;
  lpBalanceAtSnapshot: number | bigint;
  /** Sorted-pair Merkle proof — `proofs[index]` from the snapshot artifact. */
  merkleProof: ReadonlyArray<Uint8Array>;
}): TransactionInstruction {
  // borsh: disc(8) + pool_address(32) + lp_balance_at_snapshot(8) + vec<u8[32]>(4 + 32 * n)
  const proofLen = opts.merkleProof.length;
  const dataSize = 8 + 32 + 8 + 4 + 32 * proofLen;
  const w = writer(dataSize)
    .bytes(VaultIx.claimLpProceeds)
    .bytes(pkBytes(opts.poolAddress))
    .u64(opts.lpBalanceAtSnapshot);
  w.u32(proofLen);
  for (const elem of opts.merkleProof) {
    if (elem.length !== 32) {
      throw new Error(`merkle proof element must be 32 bytes (got ${elem.length})`);
    }
    w.bytes(elem);
  }
  const dataBytes = w.done();
  const keys: AccountMeta[] = [
    metaWritable(poolRegistryPda(opts.vaultProgramId, opts.poolAddress)),
    metaWritable(claimRecordPda(opts.vaultProgramId, opts.poolAddress, opts.lpHolder)),
    metaWritable(lpHolderPoolVaultPda(opts.vaultProgramId, opts.poolAddress)),
    metaSigner(opts.lpHolder),
    metaReadOnly(SystemProgram.programId),
  ];
  return new TransactionInstruction({
    programId: opts.vaultProgramId,
    keys,
    data: Buffer.from(dataBytes),
  });
}

/**
 * Build GraveVault::sweep_dust (Phase 4, D6 dust policy recovery).
 *
 * The `vault_memecoin_token_account` is the ATA of the `vault_authority`
 * PDA for the salvage receipt's memecoin mint. The destination is the
 * protocol treasury's ATA for the same mint — Anchor's associated-token
 * constraints derive both, so the caller cannot redirect.
 */
export function buildSweepDustIx(opts: {
  vaultProgramId: PublicKey;
  poolAddress: PublicKey;
  memecoinMint: PublicKey;
  sweeper: PublicKey;
}): TransactionInstruction {
  const dataBytes = writer(8 + 32).bytes(VaultIx.sweepDust).bytes(pkBytes(opts.poolAddress)).done();
  const vaultAuthority = vaultAuthorityPda(opts.vaultProgramId);
  const treasury = protocolTreasuryPda(opts.vaultProgramId);
  // Derive ATAs (the standard SPL Associated Token layout).
  const { getAssociatedTokenAddressSync } = requireAssociatedToken();
  const vaultMemecoinAta = getAssociatedTokenAddressSync(opts.memecoinMint, vaultAuthority, true);
  const treasuryAta = getAssociatedTokenAddressSync(opts.memecoinMint, treasury, true);
  const keys: AccountMeta[] = [
    metaWritable(salvageReceiptPda(opts.vaultProgramId, opts.poolAddress)),
    metaWritable(vaultAuthority),
    metaWritable(vaultMemecoinAta),
    metaReadOnly(treasury),
    metaWritable(treasuryAta),
    metaReadOnly(opts.memecoinMint),
    metaSigner(opts.sweeper),
    metaReadOnly(TOKEN_PROGRAM_ID),
    metaReadOnly(ASSOCIATED_TOKEN_PROGRAM_ID),
    metaReadOnly(SystemProgram.programId),
  ];
  return new TransactionInstruction({
    programId: opts.vaultProgramId,
    keys,
    data: Buffer.from(dataBytes),
  });
}

// salvage_pool is intentionally NOT a single-function builder — its 22+
// account list + Jupiter route data is operator-specific (the salvor
// fetches the route from Jupiter's quote API and supplies the 13
// Raydium V4 remaining_accounts). The top-level `certifyAndSalvage`
// helper composes phase-2 + salvage; the salvage_pool instruction
// builder lives in `./salvagePool.ts` (separated because the account
// list is non-trivial).

/** Lazy import to avoid pulling @solana/spl-token at module load for non-salvage builders. */
function requireAssociatedToken() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@solana/spl-token") as typeof import("@solana/spl-token");
}
