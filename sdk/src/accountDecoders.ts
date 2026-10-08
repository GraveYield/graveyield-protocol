// SPDX-License-Identifier: Apache-2.0
//
// Account decoders — borsh readers for every Anchor state account the
// SDK touches. Byte offsets are hand-derived from the Rust state structs
// (mirrors the comment block at the top of
// `scripts/devnet/protocol_admin.mjs::decodeProtocolConfig`).
//
// The reader walks the account bytes WITHOUT requiring the Anchor
// AccountDecoder / IDL — only the 8-byte account discriminator and
// the field layout matter. Every decoder asserts the discriminator
// against `AccountDisc.*` first, so a wrong-shape account fails fast
// with a clear error rather than corrupting downstream math.
//
// Field order is locked by Anchor's `#[account]` derivation and CANNOT
// drift without a program upgrade; reserved bytes are explicit so future
// additions never move existing offsets.

import { PublicKey } from "@solana/web3.js";
import { reader } from "./borsh.js";
import { AccountDisc } from "./discriminators.js";

/** Throw a clear error when the 8-byte discriminator does not match. */
function assertDiscriminator(data: Uint8Array, expected: Uint8Array, accountName: string): void {
  if (data.length < 8) {
    throw new Error(`account is too short for an Anchor discriminator (got ${data.length} bytes)`);
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== expected[i]) {
      throw new Error(
        `account discriminator mismatch — not a ${accountName} account ` +
          `(expected ${Buffer.from(expected).toString("hex")}, got ${Buffer.from(data.slice(0, 8)).toString("hex")})`,
      );
    }
  }
}

// ============================================================ GraveScanner

/** Decoded GraveScanner ProtocolConfig. */
export interface ScannerProtocolConfig {
  program: "scanner";
  accountDiscriminator: Uint8Array;
  authority: PublicKey;
  pendingAuthority: PublicKey;
  pendingAuthorityEta: bigint;
  inactivitySeconds: bigint;
  priceCollapseBps: number;
  minTvlLamports: bigint;
  anchorStalenessSeconds: bigint;
  lpBurnDustThreshold: bigint;
  certTtlSeconds: bigint;
  paused: boolean;
  activityOracle: PublicKey;
  launchPriceOracle: PublicKey;
  bump: number;
}

/** Spec defaults for GraveScanner ProtocolConfig (Charter-locked at launch). */
export const SCANNER_PROTOCOL_CONFIG_DEFAULTS = {
  inactivitySeconds: 7_776_000n,         // 90 d
  priceCollapseBps: 9_900,
  minTvlLamports: 500_000_000n,          // 0.5 SOL
  anchorStalenessSeconds: 1_209_600n,    // 14 d
  lpBurnDustThreshold: 1_000n,
  certTtlSeconds: 3_600n,                // 1 h
} as const;

/** Decode a GraveScanner ProtocolConfig account. */
export function decodeScannerProtocolConfig(data: Uint8Array): ScannerProtocolConfig {
  assertDiscriminator(data, AccountDisc.ProtocolConfig, "ProtocolConfig");
  const r = reader(data);
  r.seek(8);
  const authority = new PublicKey(r.bytes(32));
  const pendingAuthority = new PublicKey(r.bytes(32));
  const pendingAuthorityEta = r.i64();
  const inactivitySeconds = r.u64();
  const priceCollapseBps = r.u16();
  const minTvlLamports = r.u64();
  const anchorStalenessSeconds = r.u64();
  const lpBurnDustThreshold = r.u64();
  const certTtlSeconds = r.i64();
  const paused = r.bool();
  const activityOracle = new PublicKey(r.bytes(32));
  const launchPriceOracle = new PublicKey(r.bytes(32));
  const bump = r.u8();
  return {
    program: "scanner",
    accountDiscriminator: data.slice(0, 8),
    authority,
    pendingAuthority,
    pendingAuthorityEta,
    inactivitySeconds,
    priceCollapseBps,
    minTvlLamports,
    anchorStalenessSeconds,
    lpBurnDustThreshold,
    certTtlSeconds,
    paused,
    activityOracle,
    launchPriceOracle,
    bump,
  };
}

/** Decoded EligibilityAnchor. */
export interface EligibilityAnchor {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  writer: PublicKey;
  firstEligibleEpoch: bigint;
  writtenAt: bigint;
  invalidated: boolean;
  criteriaBitmap: number;
  bump: number;
}

/** Decode an EligibilityAnchor account. */
export function decodeEligibilityAnchor(data: Uint8Array): EligibilityAnchor {
  assertDiscriminator(data, AccountDisc.EligibilityAnchor, "EligibilityAnchor");
  const r = reader(data);
  r.seek(8);
  const ammProgramId = new PublicKey(r.bytes(32));
  const poolAddress = new PublicKey(r.bytes(32));
  const writer = new PublicKey(r.bytes(32));
  const firstEligibleEpoch = r.u64();
  const writtenAt = r.i64();
  const invalidated = r.bool();
  const criteriaBitmap = r.u8();
  const bump = r.u8();
  return { ammProgramId, poolAddress, writer, firstEligibleEpoch, writtenAt, invalidated, criteriaBitmap, bump };
}

/** Decoded EligibilityCert. */
export interface EligibilityCert {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  writer: PublicKey;
  anchorEpoch: bigint;
  certEpoch: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
  criteriaBitmap: number;
  reissueGeneration: bigint;
  bump: number;
}

/** Decode an EligibilityCert account. */
export function decodeEligibilityCert(data: Uint8Array): EligibilityCert {
  assertDiscriminator(data, AccountDisc.EligibilityCert, "EligibilityCert");
  const r = reader(data);
  r.seek(8);
  const ammProgramId = new PublicKey(r.bytes(32));
  const poolAddress = new PublicKey(r.bytes(32));
  const writer = new PublicKey(r.bytes(32));
  const anchorEpoch = r.u64();
  const certEpoch = r.u64();
  const issuedAt = r.i64();
  const expiresAt = r.i64();
  const criteriaBitmap = r.u8();
  const reissueGeneration = r.u64();
  const bump = r.u8();
  return {
    ammProgramId, poolAddress, writer, anchorEpoch, certEpoch, issuedAt,
    expiresAt, criteriaBitmap, reissueGeneration, bump,
  };
}

/** Decoded LaunchPrice. */
export interface LaunchPriceAccount {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  launchPriceQ64x64: bigint;
  firstSwapSlot: bigint;
  firstSwapUnixTs: bigint;
  recordedSlot: bigint;
  recordedAt: bigint;
  bump: number;
}

/** Decode a LaunchPrice account. */
export function decodeLaunchPrice(data: Uint8Array): LaunchPriceAccount {
  assertDiscriminator(data, AccountDisc.LaunchPrice, "LaunchPrice");
  const r = reader(data);
  r.seek(8);
  const ammProgramId = new PublicKey(r.bytes(32));
  const poolAddress = new PublicKey(r.bytes(32));
  const baseMint = new PublicKey(r.bytes(32));
  const quoteMint = new PublicKey(r.bytes(32));
  const launchPriceQ64x64 = r.u128();
  const firstSwapSlot = r.u64();
  const firstSwapUnixTs = r.i64();
  const recordedSlot = r.u64();
  const recordedAt = r.i64();
  const bump = r.u8();
  return {
    ammProgramId, poolAddress, baseMint, quoteMint, launchPriceQ64x64,
    firstSwapSlot, firstSwapUnixTs, recordedSlot, recordedAt, bump,
  };
}

// ============================================================== GraveVault

/** Decoded GraveVault ProtocolConfig. */
export interface VaultProtocolConfig {
  program: "vault";
  accountDiscriminator: Uint8Array;
  authority: PublicKey;
  pendingAuthority: PublicKey;
  pendingAuthorityEta: bigint;
  lpHolderShareBps: number;
  salvorShareBps: number;
  protocolShareBps: number;
  maxPriorityFeeCeilingLamports: bigint;
  maxSlippageBps: number;
  jupiterDustThresholdLamports: bigint;
  timelockSeconds: bigint;
  emergencyPaused: boolean;
  bump: number;
}

/** Spec defaults for GraveVault ProtocolConfig (Charter-locked at launch). */
export const VAULT_PROTOCOL_CONFIG_DEFAULTS = {
  lpHolderShareBps: 4_000,
  salvorShareBps: 4_000,
  protocolShareBps: 2_000,
  maxPriorityFeeCeilingLamports: 1_000_000_000n,
  maxSlippageBps: 300,
  jupiterDustThresholdLamports: 666_666n,
  timelockSeconds: 259_200n, // 72 h
} as const;

/** Decode a GraveVault ProtocolConfig account. */
export function decodeVaultProtocolConfig(data: Uint8Array): VaultProtocolConfig {
  assertDiscriminator(data, AccountDisc.ProtocolConfig, "ProtocolConfig");
  const r = reader(data);
  r.seek(8);
  const authority = new PublicKey(r.bytes(32));
  const pendingAuthority = new PublicKey(r.bytes(32));
  const pendingAuthorityEta = r.i64();
  const lpHolderShareBps = r.u16();
  const salvorShareBps = r.u16();
  const protocolShareBps = r.u16();
  const maxPriorityFeeCeilingLamports = r.u64();
  const maxSlippageBps = r.u16();
  const jupiterDustThresholdLamports = r.u64();
  const timelockSeconds = r.i64();
  const emergencyPaused = r.bool();
  const bump = r.u8();
  return {
    program: "vault",
    accountDiscriminator: data.slice(0, 8),
    authority,
    pendingAuthority,
    pendingAuthorityEta,
    lpHolderShareBps,
    salvorShareBps,
    protocolShareBps,
    maxPriorityFeeCeilingLamports,
    maxSlippageBps,
    jupiterDustThresholdLamports,
    timelockSeconds,
    emergencyPaused,
    bump,
  };
}

/** Decoded PoolRegistry. */
export interface PoolRegistry {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  salvor: PublicKey;
  lpSnapshotMerkleRoot: Uint8Array;
  lpTotalSupplyAtSnapshot: bigint;
  lpHolderPoolTotalLamports: bigint;
  lpHolderPoolClaimedLamports: bigint;
  salvagedAtSlot: bigint;
  salvagedAtTs: bigint;
  bump: number;
}

/** Decode a PoolRegistry account. */
export function decodePoolRegistry(data: Uint8Array): PoolRegistry {
  assertDiscriminator(data, AccountDisc.PoolRegistry, "PoolRegistry");
  const r = reader(data);
  r.seek(8);
  const ammProgramId = new PublicKey(r.bytes(32));
  const poolAddress = new PublicKey(r.bytes(32));
  const salvor = new PublicKey(r.bytes(32));
  const lpSnapshotMerkleRoot = r.bytes(32);
  const lpTotalSupplyAtSnapshot = r.u64();
  const lpHolderPoolTotalLamports = r.u64();
  const lpHolderPoolClaimedLamports = r.u64();
  const salvagedAtSlot = r.u64();
  const salvagedAtTs = r.i64();
  const bump = r.u8();
  return {
    ammProgramId, poolAddress, salvor, lpSnapshotMerkleRoot,
    lpTotalSupplyAtSnapshot, lpHolderPoolTotalLamports,
    lpHolderPoolClaimedLamports, salvagedAtSlot, salvagedAtTs, bump,
  };
}

/** Decoded SalvageReceipt. */
export interface SalvageReceipt {
  poolAddress: PublicKey;
  salvor: PublicKey;
  lpHolderAmountLamports: bigint;
  salvorAmountLamports: bigint;
  protocolAmountLamports: bigint;
  totalProceedsLamports: bigint;
  issuedAtSlot: bigint;
  issuedAtTs: bigint;
  memecoinMint: PublicKey;
  dustMemecoinLamports: bigint;
  dustSweptAtTs: bigint;
  bump: number;
}

/** Decode a SalvageReceipt account. */
export function decodeSalvageReceipt(data: Uint8Array): SalvageReceipt {
  assertDiscriminator(data, AccountDisc.SalvageReceipt, "SalvageReceipt");
  const r = reader(data);
  r.seek(8);
  const poolAddress = new PublicKey(r.bytes(32));
  const salvor = new PublicKey(r.bytes(32));
  const lpHolderAmountLamports = r.u64();
  const salvorAmountLamports = r.u64();
  const protocolAmountLamports = r.u64();
  const totalProceedsLamports = r.u64();
  const issuedAtSlot = r.u64();
  const issuedAtTs = r.i64();
  const memecoinMint = new PublicKey(r.bytes(32));
  const dustMemecoinLamports = r.u64();
  const dustSweptAtTs = r.i64();
  const bump = r.u8();
  return {
    poolAddress, salvor, lpHolderAmountLamports, salvorAmountLamports,
    protocolAmountLamports, totalProceedsLamports, issuedAtSlot, issuedAtTs,
    memecoinMint, dustMemecoinLamports, dustSweptAtTs, bump,
  };
}

/** Decoded ClaimRecord. */
export interface ClaimRecord {
  poolAddress: PublicKey;
  lpHolder: PublicKey;
  amountLamports: bigint;
  lpBalanceAtSnapshot: bigint;
  claimedAtSlot: bigint;
  claimedAtTs: bigint;
  bump: number;
}

/** Decode a ClaimRecord account. */
export function decodeClaimRecord(data: Uint8Array): ClaimRecord {
  assertDiscriminator(data, AccountDisc.ClaimRecord, "ClaimRecord");
  const r = reader(data);
  r.seek(8);
  const poolAddress = new PublicKey(r.bytes(32));
  const lpHolder = new PublicKey(r.bytes(32));
  const amountLamports = r.u64();
  const lpBalanceAtSnapshot = r.u64();
  const claimedAtSlot = r.u64();
  const claimedAtTs = r.i64();
  const bump = r.u8();
  return { poolAddress, lpHolder, amountLamports, lpBalanceAtSnapshot, claimedAtSlot, claimedAtTs, bump };
}

// ------------------------------------------------------ live-RPC fetchers

import type { Connection } from "@solana/web3.js";

/** Fetch + decode the live GraveScanner ProtocolConfig; `null` if not initialized. */
export async function fetchScannerProtocolConfig(
  connection: Connection,
  pda: PublicKey,
): Promise<ScannerProtocolConfig | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeScannerProtocolConfig(info.data);
}

/** Fetch + decode the live GraveVault ProtocolConfig; `null` if not initialized. */
export async function fetchVaultProtocolConfig(
  connection: Connection,
  pda: PublicKey,
): Promise<VaultProtocolConfig | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeVaultProtocolConfig(info.data);
}

/** Fetch + decode the live EligibilityAnchor for `(scanner, amm, pool)`; `null` if absent. */
export async function fetchEligibilityAnchor(
  connection: Connection,
  pda: PublicKey,
): Promise<EligibilityAnchor | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeEligibilityAnchor(info.data);
}

/** Fetch + decode the live EligibilityCert for `(scanner, amm, pool)`; `null` if absent. */
export async function fetchEligibilityCert(
  connection: Connection,
  pda: PublicKey,
): Promise<EligibilityCert | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeEligibilityCert(info.data);
}

/** Fetch + decode the live LaunchPrice for `(scanner, amm, pool)`; `null` if absent. */
export async function fetchLaunchPrice(
  connection: Connection,
  pda: PublicKey,
): Promise<LaunchPriceAccount | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeLaunchPrice(info.data);
}

/** Fetch + decode the live PoolRegistry for `(vault, pool)`; `null` if absent. */
export async function fetchPoolRegistry(
  connection: Connection,
  pda: PublicKey,
): Promise<PoolRegistry | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodePoolRegistry(info.data);
}

/** Fetch + decode the live SalvageReceipt for `(vault, pool)`; `null` if absent. */
export async function fetchSalvageReceipt(
  connection: Connection,
  pda: PublicKey,
): Promise<SalvageReceipt | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeSalvageReceipt(info.data);
}

/** Fetch + decode the live ClaimRecord for `(vault, pool, lpHolder)`; `null` if absent. */
export async function fetchClaimRecord(
  connection: Connection,
  pda: PublicKey,
): Promise<ClaimRecord | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeClaimRecord(info.data);
}
