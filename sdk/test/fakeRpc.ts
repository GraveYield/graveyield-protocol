// SPDX-License-Identifier: Apache-2.0
//
// SDK test helpers — in-memory account encoders byte-exact against the
// SDK decoders (mirrors scout/test/helpers.ts, kept SDK-side so SDK
// tests never import from a workspace package). No network anywhere.

import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import {
  AccountDisc,
  RAYDIUM_V4_AMM_INFO_SIZE,
  writer,
} from "../src/index.js";

/** Encode a GraveScanner ProtocolConfig account (layout: accountDecoders.ts). */
export function encodeScannerConfig(opts: {
  authority: PublicKey;
  inactivitySeconds?: bigint;
  priceCollapseBps?: number;
  minTvlLamports?: bigint;
  anchorStalenessSeconds?: bigint;
  lpBurnDustThreshold?: bigint;
  certTtlSeconds?: bigint;
  activityOracle: PublicKey;
  launchPriceOracle: PublicKey;
  paused?: boolean;
}): Uint8Array {
  return writer(8 + 32 + 32 + 8 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 32 + 32 + 1)
    .bytes(AccountDisc.ProtocolConfig)
    .bytes(opts.authority.toBytes())
    .bytes(PublicKey.default.toBytes()) // pendingAuthority
    .i64(0n) // pendingAuthorityEta
    .u64(opts.inactivitySeconds ?? 7_776_000n)
    .u16(opts.priceCollapseBps ?? 9_900)
    .u64(opts.minTvlLamports ?? 500_000_000n)
    .u64(opts.anchorStalenessSeconds ?? 1_209_600n)
    .u64(opts.lpBurnDustThreshold ?? 1_000n)
    .i64(opts.certTtlSeconds ?? 3_600n)
    .bool(opts.paused ?? false)
    .bytes(opts.activityOracle.toBytes())
    .bytes(opts.launchPriceOracle.toBytes())
    .u8(255) // bump
    .done();
}

/** Encode a GraveVault ProtocolConfig account (layout: accountDecoders.ts). */
export function encodeVaultConfig(opts: {
  authority: PublicKey;
  maxPriorityFeeCeilingLamports?: bigint;
  paused?: boolean;
}): Uint8Array {
  return writer(8 + 32 + 32 + 8 + 2 + 2 + 2 + 8 + 2 + 8 + 8 + 1 + 1)
    .bytes(AccountDisc.ProtocolConfig)
    .bytes(opts.authority.toBytes())
    .bytes(PublicKey.default.toBytes()) // pendingAuthority
    .i64(0n) // pendingAuthorityEta
    .u16(4_000) // lpHolderShareBps
    .u16(4_000) // salvorShareBps
    .u16(2_000) // protocolShareBps
    .u64(opts.maxPriorityFeeCeilingLamports ?? 1_000_000_000n)
    .u16(300) // maxSlippageBps
    .u64(666_666n) // jupiterDustThresholdLamports
    .i64(259_200n) // timelockSeconds
    .bool(opts.paused ?? false)
    .u8(255) // bump
    .done();
}

/** Encode a LaunchPrice account (layout: accountDecoders.ts). */
export function encodeLaunchPriceAccount(opts: {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  launchPriceQ64x64: bigint;
}): Uint8Array {
  return writer(8 + 32 * 4 + 16 + 8 + 8 + 8 + 8 + 1)
    .bytes(AccountDisc.LaunchPrice)
    .bytes(opts.ammProgramId.toBytes())
    .bytes(opts.poolAddress.toBytes())
    .bytes(opts.baseMint.toBytes())
    .bytes(opts.quoteMint.toBytes())
    .u128(opts.launchPriceQ64x64)
    .u64(1n) // firstSwapSlot
    .i64(1_700_000_000n) // firstSwapUnixTs
    .u64(2n) // recordedSlot
    .i64(1_700_000_100n) // recordedAt
    .u8(252) // bump
    .done();
}

/** Encode a canonical 165-byte SPL token account. */
export function encodeTokenAccount(mint: PublicKey, amount: bigint): Uint8Array {
  const buf = new Uint8Array(165);
  buf.set(mint.toBytes(), 0);
  buf.set(PublicKey.default.toBytes(), 32); // owner (unused by the SDK)
  const view = new DataView(buf.buffer);
  view.setBigUint64(64, amount, true);
  view.setUint8(108, 1); // state = initialized
  return buf;
}

/** Encode a canonical 82-byte SPL mint account. */
export function encodeMint(decimals: number, supply: bigint): Uint8Array {
  const buf = new Uint8Array(82);
  const view = new DataView(buf.buffer);
  view.setBigUint64(36, supply, true);
  view.setUint8(44, decimals);
  view.setUint8(45, 1); // isInitialized
  return buf;
}

/** Encode a canonical 752-byte Raydium V4 AmmInfo with the SDK-parsed fields. */
export function encodeAmmInfo(opts: {
  coinVault: PublicKey;
  pcVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
}): Uint8Array {
  const buf = new Uint8Array(RAYDIUM_V4_AMM_INFO_SIZE);
  buf.set(opts.coinVault.toBytes(), 336);
  buf.set(opts.pcVault.toBytes(), 368);
  buf.set(opts.baseMint.toBytes(), 400);
  buf.set(opts.quoteMint.toBytes(), 432);
  buf.set(opts.lpMint.toBytes(), 464);
  return buf;
}

/** Account owner for SPL token/mint accounts — the SDK asserts it. */
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/**
 * In-memory Connection covering `evaluatePool`'s surface. Methods the
 * test does not care about (signature history) are absent on purpose:
 * evaluatePool fail-closes C1 on the resulting throw, which is exactly
 * the branch the C2 pinning wants.
 */
export class EvaluatePoolFakeRpc {
  readonly accounts = new Map<string, AccountInfo<Uint8Array>>();
  currentEpoch = 10;

  setAccount(address: PublicKey, data: Uint8Array, owner: PublicKey): void {
    this.accounts.set(address.toBase58(), {
      lamports: 1_000_000,
      data: Buffer.from(data),
      owner,
      executable: false,
      rentEpoch: 0n,
    } as AccountInfo<Uint8Array>);
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    return this.accounts.get(address.toBase58()) ?? null;
  }

  async getEpochInfo() {
    return {
      epoch: this.currentEpoch,
      slotIndex: 0,
      slotsInEpoch: 432_000,
      absoluteSlot: 1_000_000,
      blockHeight: 1,
      transactionCount: 0n,
    };
  }

  async getSlot(): Promise<number> {
    return 1_000_000;
  }

  async getBlock(_slot: number, _opts?: unknown): Promise<never> {
    throw new Error("EvaluatePoolFakeRpc: no block history (C1 fail-closed by design)");
  }
}
