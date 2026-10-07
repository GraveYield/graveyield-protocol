// SPDX-License-Identifier: Apache-2.0
//
// Criterion 2 launch-price attestations (ORACLE-001, Phase 1.3 / spec D9).
//
// GraveScanner no longer accepts caller-supplied launch-price baselines.
// The Criterion 2 baseline is the quote-per-base price formed by the
// pool's vault balances immediately BEFORE the pool's first successful
// swap (the deployer-seeded initial market price), derived off chain from
// Raydium V4 transaction history and carried as a 168-byte attestation
// signed by the protocol launch-price oracle (a key registered in
// GraveScanner `ProtocolConfig.launch_price_oracle`, separate from the
// activity oracle), verified on chain through the `ed25519_program`
// precompile.
//
// Transaction assembly (canonical pattern — see PROTOCOL_SPEC.md §5/D9):
//
//   1. Derive the launch price from V4 history (`deriveLaunchPriceV4`).
//   2. Build the 168-byte message (`buildLaunchPriceMessage`).
//   3. Sign it with the launch-price oracle key (Ed25519).
//   4. Prepend `buildLaunchPriceEd25519VerifyInstruction(...)` to the
//      `record_launch_price` instruction in the SAME transaction. The
//      precompile verifies the signature before GraveScanner executes;
//      the handler then validates the offsets, the oracle binding, the
//      pool/mint/price echo, and timestamp/slot sanity.
//
// Unlike the C1 last-swap attestation there is NO SlotHashes freshness
// check: the launch price is a time-invariant historical fact and the
// LaunchPrice PDA is init-once, so an old-but-valid attestation cannot
// overwrite anything (the second `init` fails). Recording late is correct.
//
// The byte layout below is NORMATIVE and mirrored byte-for-byte by
// programs/grave-scanner/src/attestation.rs. Do not reorder fields.

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  type TokenBalance,
} from "@solana/web3.js";

import {
  ATTESTATION_MSG_LEN,
  buildEd25519VerifyInstruction,
} from "./lastSwapAttestation.js";

/** Canonical launch-price attestation message length in bytes. */
export const LAUNCH_PRICE_MSG_LEN = 168;

/** Offset of the attestation message inside the `record_launch_price`
 *  instruction data (8B discriminator + 32B amm + 32B pool + 32B base
 *  mint + 32B quote mint + 16B u128 price). The attestation is the LAST
 *  params field. */
export const LAUNCH_PRICE_MSG_OFFSET = 152;

/** Minimum `record_launch_price` instruction data length. */
export const LAUNCH_PRICE_IX_MIN_LEN = 320;

// Raydium V4 AmmInfo layout offsets (mirrors the on-chain adapter).
const AMM_INFO_SIZE = 752;
const COIN_VAULT_OFFSET = 336;
const PC_VAULT_OFFSET = 368;
const COIN_VAULT_MINT_OFFSET = 400;
const PC_VAULT_MINT_OFFSET = 432;

/** A parsed Criterion 2 launch-price attestation. */
export interface LaunchPriceAttestation {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  /** Mint of the base (measured) token. */
  baseMint: PublicKey;
  /** Mint of the quote token (typically WSOL). */
  quoteMint: PublicKey;
  /** Slot of the pool's first successful swap. */
  firstSwapSlot: number;
  /** Unix timestamp (seconds) of the pool's first successful swap. */
  firstSwapUnixTs: number;
  /** Attested launch price as quote-per-base in Q64.64 (u128). */
  launchPriceQ64x64: bigint;
  /** Slot at which the indexer issued the attestation. */
  issuedSlot: number;
}

/** Read a little-endian u128 from `bytes` starting at `offset`. */
function readU128LE(bytes: Uint8Array, offset: number): bigint {
  let out = 0n;
  for (let i = 15; i >= 0; i--) {
    const b = bytes[offset + i];
    if (b === undefined) throw new Error("u128 read out of bounds");
    out = (out << 8n) | BigInt(b);
  }
  return out;
}

/** Write `value` as a little-endian u128 into `bytes` at `offset`. */
function writeU128LE(bytes: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value >= 1n << 128n) {
    throw new Error("launch price must fit in an unsigned 128-bit integer");
  }
  let v = value;
  for (let i = 0; i < 16; i++) {
    bytes[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/** Serialize an attestation into the canonical 168-byte wire format. */
export function buildLaunchPriceMessage(
  att: LaunchPriceAttestation,
): Uint8Array {
  const msg = new Uint8Array(LAUNCH_PRICE_MSG_LEN);
  msg.set(att.ammProgramId.toBytes(), 0);
  msg.set(att.poolAddress.toBytes(), 32);
  msg.set(att.baseMint.toBytes(), 64);
  msg.set(att.quoteMint.toBytes(), 96);
  const view = new DataView(msg.buffer);
  view.setBigUint64(128, BigInt(att.firstSwapSlot), true);
  view.setBigInt64(136, BigInt(att.firstSwapUnixTs), true);
  writeU128LE(msg, 144, att.launchPriceQ64x64);
  view.setBigUint64(160, BigInt(att.issuedSlot), true);
  return msg;
}

/** Parse and length-check a 168-byte launch-price attestation message. */
export function parseLaunchPriceMessage(
  bytes: Uint8Array,
): LaunchPriceAttestation {
  if (bytes.length !== LAUNCH_PRICE_MSG_LEN) {
    throw new Error(
      `launch-price attestation message must be ${LAUNCH_PRICE_MSG_LEN} bytes`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    ammProgramId: new PublicKey(bytes.slice(0, 32)),
    poolAddress: new PublicKey(bytes.slice(32, 64)),
    baseMint: new PublicKey(bytes.slice(64, 96)),
    quoteMint: new PublicKey(bytes.slice(96, 128)),
    firstSwapSlot: Number(view.getBigUint64(128, true)),
    firstSwapUnixTs: Number(view.getBigInt64(136, true)),
    launchPriceQ64x64: readU128LE(bytes, 144),
    issuedSlot: Number(view.getBigUint64(160, true)),
  };
}

/**
 * Build the `ed25519_program` verify instruction for the launch-price
 * attestation. Identical precompile wire format to the C1 builder, but
 * the signed message lives at `LAUNCH_PRICE_MSG_OFFSET` (152) inside the
 * `record_launch_price` instruction data.
 */
export function buildLaunchPriceEd25519VerifyInstruction(opts: {
  /** 64-byte Ed25519 signature over the launch-price message. */
  signature: Uint8Array;
  /** The launch-price oracle public key that produced the signature. */
  oraclePublicKey: PublicKey;
  /** Index of the `record_launch_price` instruction in the transaction. */
  recordInstructionIndex: number;
}): TransactionInstruction {
  // The precompile message span is data[msgOffset..end] of the scanner
  // instruction; length-validate against a synthetic message of the
  // canonical size by reusing the shared builder.
  const placeholder = new Uint8Array(ATTESTATION_MSG_LEN);
  return buildEd25519VerifyInstruction({
    signature: opts.signature,
    oraclePublicKey: opts.oraclePublicKey,
    message: placeholder,
    scannerInstructionIndex: opts.recordInstructionIndex,
    messageAddressOffset: LAUNCH_PRICE_MSG_OFFSET,
  });
}

/** Result of an off-chain launch-price derivation for a Raydium V4 pool. */
export interface LaunchPriceDerivation {
  /** Price (quote-per-base, Q64.64) immediately before the first swap. */
  launchPriceQ64x64: bigint;
  /** Slot of the first successful swap. */
  firstSwapSlot: number;
  /** Unix timestamp of the first successful swap. */
  firstSwapUnixTs: number;
  /** Base (coin-side) mint read from the pool account. */
  baseMint: PublicKey;
  /** Quote (pc-side) mint read from the pool account. */
  quoteMint: PublicKey;
  /** Signature of the first-swap transaction (audit anchor). */
  signature: string;
}

/** Read the vault addresses and mints from a Raydium V4 AmmInfo account. */
export async function readV4PoolPair(
  connection: Connection,
  poolAddress: PublicKey,
): Promise<{
  coinVault: PublicKey;
  pcVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
}> {
  const info = await connection.getAccountInfo(poolAddress);
  if (!info || info.data.length !== AMM_INFO_SIZE) {
    throw new Error(
      `pool account is not a canonical ${AMM_INFO_SIZE}-byte Raydium V4 AmmInfo`,
    );
  }
  return {
    coinVault: new PublicKey(info.data.slice(COIN_VAULT_OFFSET, COIN_VAULT_OFFSET + 32)),
    pcVault: new PublicKey(info.data.slice(PC_VAULT_OFFSET, PC_VAULT_OFFSET + 32)),
    baseMint: new PublicKey(info.data.slice(COIN_VAULT_MINT_OFFSET, COIN_VAULT_MINT_OFFSET + 32)),
    quoteMint: new PublicKey(info.data.slice(PC_VAULT_MINT_OFFSET, PC_VAULT_MINT_OFFSET + 32)),
  };
}

/**
 * Derive a Raydium V4 pool's launch price from RPC transaction history
 * (indexer/operator tooling — the authoritative input for C2 attestations).
 *
 * Strategy: paginate the pool's signature history BACK to genesis (fail
 * closed if the scan window is exhausted before genesis), then walk
 * forward from the oldest transaction. The first transaction that invokes
 * the AMM program on this pool and moves the two vault balances in
 * OPPOSITE directions is the first swap (deposits move both vaults in the
 * same direction; initialization sets both from zero). The launch price is
 * computed from that transaction's PRE token balances:
 *
 *   launch_price_q64x64 = (pc_vault_pre << 64) / coin_vault_pre
 *
 * — byte-identical to the on-chain `PoolData::current_price_q64x64` math.
 *
 * Operational requirements (spec §6.3, ORACLE-003 runbook): run against a
 * full-archive trusted RPC endpoint. `getTransaction` returning null for a
 * pre-first-swap transaction, a missing block time, or a first swap whose
 * pre-swap base balance is zero all throw — the derivation refuses to
 * guess. Returns `null` when the pool has never swapped (such pools are
 * outside the v1.0 C1/C2 eligibility domain).
 */
export async function deriveLaunchPriceV4(
  connection: Connection,
  ammProgramId: PublicKey,
  poolAddress: PublicKey,
  opts?: { maxPages?: number },
): Promise<LaunchPriceDerivation | null> {
  const PAGE_SIZE = 1000;
  const maxPages = opts?.maxPages ?? 50;

  const { coinVault, pcVault, baseMint, quoteMint } = await readV4PoolPair(
    connection,
    poolAddress,
  );

  // --- Phase 1: paginate signatures back to genesis -------------------
  const pages: Awaited<ReturnType<Connection["getSignaturesForAddress"]>>[] = [];
  let cursor: string | undefined = undefined;
  let exhausted = false;
  for (let page = 0; page < maxPages; page++) {
    const query = {
      limit: PAGE_SIZE,
      ...(cursor !== undefined ? { before: cursor } : {}),
    };
    const batch = await connection.getSignaturesForAddress(poolAddress, query);
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    pages.push(batch);
    const last = batch[batch.length - 1];
    if (!last) break; // defensive; batch.length > 0 here
    cursor = last.signature;
    if (batch.length < PAGE_SIZE) {
      exhausted = true;
      break;
    }
  }
  if (!exhausted) {
    throw new Error(
      "launch-price history incomplete: signature scan hit the page limit " +
        "before genesis; raise maxPages or run a full-archive scan",
    );
  }

  // Chronological order: oldest page first, oldest signature first.
  const chronological = pages.reverse().flatMap((p) => p.reverse().map((s) => s));

  // --- Phase 2: walk forward to the first swap ------------------------
  for (const info of chronological) {
    if (info.err !== null) continue;
    const blockTime: number | null | undefined = info.blockTime;
    if (blockTime === null || blockTime === undefined) {
      throw new Error(
        "launch-price history incomplete: first-swap candidate has no block time",
      );
    }
    const tx = await connection.getTransaction(info.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      throw new Error(
        "launch-price history incomplete: transaction unavailable from the " +
          "RPC endpoint (use a full-archive node)",
      );
    }

    const keyList: PublicKey[] = [
      ...tx.transaction.message.getAccountKeys().keySegments().flat(),
      ...(tx.meta?.loadedAddresses?.writable ?? []),
      ...(tx.meta?.loadedAddresses?.readonly ?? []),
    ];
    const indexOf = (k: PublicKey): number => keyList.findIndex((x) => x.equals(k));

    const touchesPool = (
      programIdIndex: number,
      accounts: Array<PublicKey | number>,
    ): boolean => {
      const pid = keyList[programIdIndex];
      if (pid === undefined || !pid.equals(ammProgramId)) return false;
      return accounts.some((a) => {
        const k = typeof a === "number" ? keyList[a] : keyList[indexOf(a)];
        return k !== undefined && k.equals(poolAddress);
      });
    };

    const topLevel = tx.transaction.message.compiledInstructions.some((ci) =>
      touchesPool(ci.programIdIndex, ci.accountKeyIndexes),
    );
    const inner = (tx.meta?.innerInstructions ?? []).some((set) =>
      set.instructions.some((ci) => touchesPool(ci.programIdIndex, ci.accounts)),
    );
    if (!topLevel && !inner) continue;

    // Vault balance deltas from pre/post token balances.
    const amountOf = (
      vault: PublicKey,
      balances: TokenBalance[] | null | undefined,
    ): bigint => {
      const idx = indexOf(vault);
      if (idx < 0) return 0n;
      const entry = (balances ?? []).find((e) => e.accountIndex === idx);
      return entry ? BigInt(entry.uiTokenAmount.amount) : 0n;
    };
    const pre: TokenBalance[] | null | undefined = tx.meta?.preTokenBalances;
    const post: TokenBalance[] | null | undefined = tx.meta?.postTokenBalances;
    const coinDelta = amountOf(coinVault, post) - amountOf(coinVault, pre);
    const pcDelta = amountOf(pcVault, post) - amountOf(pcVault, pre);

    // A swap moves the two vaults in opposite directions and touches both.
    const opposite =
      coinDelta !== 0n &&
      pcDelta !== 0n &&
      coinDelta > 0n !== pcDelta > 0n;
    if (!opposite) continue; // initialize / deposit / withdraw / single-sided

    // First swap found — launch price is the PRE-swap reserve ratio.
    const coinPre = amountOf(coinVault, pre);
    const pcPre = amountOf(pcVault, pre);
    if (coinPre <= 0n) {
      throw new Error(
        "launch-price derivation failed: first swap has no pre-swap base liquidity",
      );
    }
    return {
      launchPriceQ64x64: (pcPre << 64n) / coinPre,
      firstSwapSlot: info.slot,
      firstSwapUnixTs: blockTime,
      baseMint,
      quoteMint,
      signature: info.signature,
    };
  }

  // History exhausted with no swap — the pool has never traded.
  return null;
}
