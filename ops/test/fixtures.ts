// SPDX-License-Identifier: Apache-2.0
//
// Offline fixtures for the ops test suites: hand-encoded GraveVault
// Anchor accounts (discriminator + borsh fields, little-endian) and a
// canned ChainView. No RPC, no network — the SDK decoders validate the
// shapes exactly like they would on live bytes.

import { PublicKey } from "@solana/web3.js";
import { AccountDisc } from "@graveyield/sdk";

/** Minimal borsh writer for the fixture layouts (LE ints, raw bytes). */
export class ByteWriter {
  private readonly chunks: Buffer[] = [];

  bytes(raw: Uint8Array): this {
    this.chunks.push(Buffer.from(raw));
    return this;
  }

  u16(value: number): this {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(value);
    this.chunks.push(buf);
    return this;
  }

  u64(value: bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    this.chunks.push(buf);
    return this;
  }

  i64(value: bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(value);
    this.chunks.push(buf);
    return this;
  }

  u8(value: number): this {
    this.chunks.push(Buffer.from([value & 0xff]));
    return this;
  }

  bool(value: boolean): this {
    this.chunks.push(Buffer.from([value ? 1 : 0]));
    return this;
  }

  pubKey(key: PublicKey): this {
    return this.bytes(key.toBytes());
  }

  build(discriminator: Uint8Array): Uint8Array {
    return Uint8Array.from(Buffer.concat([Buffer.from(discriminator), ...this.chunks]));
  }
}

export function key(seed: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(seed));
}

export interface ReceiptFields {
  pool: PublicKey;
  salvor: PublicKey;
  lpHolderAmountLamports: bigint;
  salvorAmountLamports: bigint;
  protocolAmountLamports: bigint;
  totalProceedsLamports: bigint;
  issuedAtSlot?: bigint;
  issuedAtTs?: bigint;
  memecoinMint?: PublicKey;
  dustMemecoinLamports?: bigint;
  dustSweptAtTs?: bigint;
  bump?: number;
}

export function encodeReceipt(fields: ReceiptFields): Uint8Array {
  const w = new ByteWriter();
  w.pubKey(fields.pool)
    .pubKey(fields.salvor)
    .u64(fields.lpHolderAmountLamports)
    .u64(fields.salvorAmountLamports)
    .u64(fields.protocolAmountLamports)
    .u64(fields.totalProceedsLamports)
    .u64(fields.issuedAtSlot ?? 100n)
    .i64(fields.issuedAtTs ?? 1_000n)
    .pubKey(fields.memecoinMint ?? key(0xee))
    .u64(fields.dustMemecoinLamports ?? 0n)
    .i64(fields.dustSweptAtTs ?? 0n)
    .u8(fields.bump ?? 254);
  return w.build(AccountDisc.SalvageReceipt);
}

export interface ClaimFields {
  pool: PublicKey;
  lpHolder: PublicKey;
  amountLamports: bigint;
  lpBalanceAtSnapshot?: bigint;
  claimedAtSlot?: bigint;
  claimedAtTs?: bigint;
  bump?: number;
}

export function encodeClaim(fields: ClaimFields): Uint8Array {
  const w = new ByteWriter();
  w.pubKey(fields.pool)
    .pubKey(fields.lpHolder)
    .u64(fields.amountLamports)
    .u64(fields.lpBalanceAtSnapshot ?? 5_000n)
    .u64(fields.claimedAtSlot ?? 200n)
    .i64(fields.claimedAtTs ?? 2_000n)
    .u8(fields.bump ?? 253);
  return w.build(AccountDisc.ClaimRecord);
}

export interface RegistryFields {
  ammProgramId?: PublicKey;
  pool: PublicKey;
  salvor?: PublicKey;
  merkleRoot?: Uint8Array;
  lpTotalSupplyAtSnapshot?: bigint;
  lpHolderPoolTotalLamports: bigint;
  lpHolderPoolClaimedLamports: bigint;
  salvagedAtSlot?: bigint;
  salvagedAtTs?: bigint;
  bump?: number;
}

export function encodeRegistry(fields: RegistryFields): Uint8Array {
  const w = new ByteWriter();
  w.pubKey(fields.ammProgramId ?? new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"))
    .pubKey(fields.pool)
    .pubKey(fields.salvor ?? key(0x77))
    .bytes(fields.merkleRoot ?? new Uint8Array(32).fill(0x11))
    .u64(fields.lpTotalSupplyAtSnapshot ?? 1_000_000n)
    .u64(fields.lpHolderPoolTotalLamports)
    .u64(fields.lpHolderPoolClaimedLamports)
    .u64(fields.salvagedAtSlot ?? 300n)
    .i64(fields.salvagedAtTs ?? 3_000n)
    .u8(fields.bump ?? 252);
  return w.build(AccountDisc.PoolRegistry);
}

export interface VaultConfigFields {
  authority?: PublicKey;
  pendingAuthority?: PublicKey;
  pendingAuthorityEta?: bigint;
  lpHolderShareBps?: number;
  salvorShareBps?: number;
  protocolShareBps?: number;
  maxPriorityFeeCeilingLamports?: bigint;
  maxSlippageBps?: number;
  jupiterDustThresholdLamports?: bigint;
  timelockSeconds?: bigint;
  emergencyPaused?: boolean;
  bump?: number;
}

export function encodeVaultConfig(fields: VaultConfigFields = {}): Uint8Array {
  const w = new ByteWriter();
  w.pubKey(fields.authority ?? key(0x01))
    .pubKey(fields.pendingAuthority ?? PublicKey.default)
    .i64(fields.pendingAuthorityEta ?? 0n)
    .u16(fields.lpHolderShareBps ?? 4_000)
    .u16(fields.salvorShareBps ?? 4_000)
    .u16(fields.protocolShareBps ?? 2_000)
    .u64(fields.maxPriorityFeeCeilingLamports ?? 1_000_000_000n)
    .u16(fields.maxSlippageBps ?? 300)
    .u64(fields.jupiterDustThresholdLamports ?? 666_666n)
    .i64(fields.timelockSeconds ?? 259_200n)
    .bool(fields.emergencyPaused ?? false)
    .u8(fields.bump ?? 251);
  return w.build(AccountDisc.ProtocolConfig);
}

/** Bytes of an account nobody decodes (e.g. a vault-authority seed PDA). */
export function opaqueAccountBytes(): Uint8Array {
  return new Uint8Array(64).fill(0x42);
}
