// SPDX-License-Identifier: Apache-2.0
//
// Criterion 1 last-swap attestations (ORACLE-002, Phase 1.2 / spec D8).
//
// GraveScanner no longer accepts caller-supplied last-swap timestamps.
// Criterion 1 inactivity evidence is a 112-byte attestation signed by the
// protocol activity oracle (a key registered in GraveScanner
// `ProtocolConfig.activity_oracle`), verified on chain through the
// `ed25519_program` precompile.
//
// Transaction assembly (canonical pattern — see PROTOCOL_SPEC.md §5):
//
//   1. Derive the attested last-swap time from Raydium V4 transaction
//      history (`deriveLastSwapV4` — indexer/operator tooling).
//   2. Fetch the slot hash for the issuance slot (`fetchSlotHash`).
//   3. Build the 112-byte message (`buildAttestationMessage`).
//   4. Sign it with the activity oracle key (Ed25519).
//   5. Prepend `buildEd25519VerifyInstruction(...)` to the scanner
//      instruction in the SAME transaction. The precompile verifies the
//      signature before GraveScanner executes; GraveScanner then validates
//      the offsets, the oracle binding, and slot freshness (SlotHashes).
//
// The byte layout below is NORMATIVE and mirrored byte-for-byte by
// programs/grave-scanner/src/attestation.rs. Do not reorder fields.

import {
  PublicKey,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";

/** Ed25519 signature-verification native program (precompile). */
export const ED25519_PROGRAM_ID = new PublicKey(
  "Ed25519SigVerify111111111111111111111111111",
);

/** Canonical attestation message length in bytes. */
export const ATTESTATION_MSG_LEN = 112;

/** Offset of the attestation message inside the GraveScanner instruction data
 *  (8B Anchor discriminator + 32B amm + 32B pool). */
export const IX_DATA_MSG_OFFSET = 72;

/** Minimum GraveScanner instruction data length (disc + amm + pool + msg). */
export const IX_DATA_MIN_LEN = 184;

/** Ed25519SignatureOffsets header length. */
export const ED25519_HEADER_LEN = 14;

/** Signature offset inside the precompile instruction data. */
export const PRECOMPILE_SIG_OFFSET = 14;

/** Public key offset inside the precompile instruction data. */
export const PRECOMPILE_PK_OFFSET = 78;

/** 0xFFFF = "the instruction currently being executed" (the precompile). */
export const CUR_INSTRUCTION_INDEX = 0xffff;

/** A parsed Criterion 1 attestation. */
export interface LastSwapAttestation {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  /** Attested unix timestamp (seconds) of the pool's most recent swap. */
  lastSwapUnixTs: number;
  /** Slot at which the indexer issued the attestation. */
  issuedSlot: number;
  /** 32-byte slot hash (blockhash) binding the attestation to a real slot. */
  slotHash: Uint8Array;
}

/** Serialize an attestation into the canonical 112-byte wire format. */
export function buildAttestationMessage(att: LastSwapAttestation): Uint8Array {
  if (att.slotHash.length !== 32) {
    throw new Error("slotHash must be exactly 32 bytes");
  }
  const msg = new Uint8Array(ATTESTATION_MSG_LEN);
  msg.set(att.ammProgramId.toBytes(), 0);
  msg.set(att.poolAddress.toBytes(), 32);
  const view = new DataView(msg.buffer);
  view.setBigInt64(64, BigInt(att.lastSwapUnixTs), true);
  view.setBigUint64(72, BigInt(att.issuedSlot), true);
  msg.set(att.slotHash, 80);
  return msg;
}

/** Parse and length-check a 112-byte attestation message. */
export function parseAttestationMessage(bytes: Uint8Array): LastSwapAttestation {
  if (bytes.length !== ATTESTATION_MSG_LEN) {
    throw new Error(`attestation message must be ${ATTESTATION_MSG_LEN} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    ammProgramId: new PublicKey(bytes.slice(0, 32)),
    poolAddress: new PublicKey(bytes.slice(32, 64)),
    lastSwapUnixTs: Number(view.getBigInt64(64, true)),
    issuedSlot: Number(view.getBigUint64(72, true)),
    slotHash: bytes.slice(80, 112),
  };
}

/**
 * Build the `ed25519_program` verify instruction that must immediately
 * precede the GraveScanner instruction in the same transaction.
 *
 * Layout (110 bytes): Ed25519SignatureOffsets header (14B) + signature
 * (64B) + oracle public key (32B). The message offsets point at
 * `messageAddressOffset` inside the GraveScanner instruction at
 * `scannerInstructionIndex`, so the runtime-verified signature covers
 * exactly the attestation bytes embedded in the scanner instruction.
 *
 * The default offset targets the C1 last-swap attestation
 * (`IX_DATA_MSG_OFFSET` = 72). The C2 launch-price attestation embeds its
 * 168-byte message at offset 152 and passes
 * `messageAddressOffset: LAUNCH_PRICE_MSG_OFFSET` instead (see
 * `launchPriceAttestation.ts`) — the precompile wire format is identical.
 */
export function buildEd25519VerifyInstruction(opts: {
  /** 64-byte Ed25519 signature over the attestation message. */
  signature: Uint8Array;
  /** The activity oracle public key that produced the signature. */
  oraclePublicKey: PublicKey;
  /** The attestation message (for length validation). */
  message: Uint8Array;
  /** Index of the GraveScanner instruction within the transaction. */
  scannerInstructionIndex: number;
  /** Offset of the signed message inside the GraveScanner instruction
   *  data. Defaults to `IX_DATA_MSG_OFFSET` (72). */
  messageAddressOffset?: number;
}): TransactionInstruction {
  if (opts.signature.length !== 64) {
    throw new Error("signature must be exactly 64 bytes");
  }
  if (opts.message.length !== ATTESTATION_MSG_LEN) {
    throw new Error(`message must be ${ATTESTATION_MSG_LEN} bytes`);
  }
  if (opts.scannerInstructionIndex < 0 || opts.scannerInstructionIndex > 0xfffe) {
    throw new Error("scannerInstructionIndex out of range");
  }
  const messageAddressOffset = opts.messageAddressOffset ?? IX_DATA_MSG_OFFSET;
  if (messageAddressOffset < 0 || messageAddressOffset > 0xffff) {
    throw new Error("messageAddressOffset out of range");
  }
  const data = Buffer.alloc(PRECOMPILE_PK_OFFSET + 32);
  const w = (off: number, v: number) => data.writeUInt16LE(v, off);
  w(0, PRECOMPILE_SIG_OFFSET); // signature_offset
  w(2, CUR_INSTRUCTION_INDEX); // signature_instruction_index
  w(4, messageAddressOffset); // message_address_offset
  w(6, opts.scannerInstructionIndex); // message_instruction_index
  w(8, 1); // num_signatures
  w(10, PRECOMPILE_PK_OFFSET); // public_key_offset
  w(12, CUR_INSTRUCTION_INDEX); // public_key_instruction_index
  Buffer.from(opts.signature).copy(data, PRECOMPILE_SIG_OFFSET);
  Buffer.from(opts.oraclePublicKey.toBytes()).copy(data, PRECOMPILE_PK_OFFSET);
  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data,
  });
}

/** Result of an off-chain last-swap derivation for a Raydium V4 pool. */
export interface LastSwapDerivation {
  lastSwapUnixTs: number;
  slot: number;
  signature: string;
}

/**
 * Derive a Raydium V4 pool's last swap from RPC transaction history
 * (indexer/operator tooling — the authoritative input for attestations).
 *
 * Strategy: newest-first signature scan over the pool account; for each
 * candidate, confirm the transaction actually invoked the AMM program on
 * this pool (top-level or inner instructions). The first match's block
 * time is the last-swap timestamp.
 *
 * Operational requirements (spec §6.3): run against a trusted RPC
 * endpoint, and require at least `minConfirmations` confirmed signatures
 * behind the tip before attesting. Semantic `ray_log` parsing is tracked
 * by the indexer milestone in the roadmap.
 */
export async function deriveLastSwapV4(
  connection: Connection,
  ammProgramId: PublicKey,
  poolAddress: PublicKey,
  opts?: { scanLimit?: number },
): Promise<LastSwapDerivation | null> {
  const scanLimit = opts?.scanLimit ?? 1000;
  const sigInfos = await connection.getSignaturesForAddress(poolAddress, {
    limit: scanLimit,
  });
  for (const info of sigInfos) {
    if (info.err !== null) continue;
    const blockTime: number | null | undefined = info.blockTime;
    if (blockTime === null || blockTime === undefined) continue;
    const tx = await connection.getTransaction(info.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;

    // Full ordered account list: static keys + ALT-loaded writable/readonly.
    const keyList: PublicKey[] = [
      ...tx.transaction.message.getAccountKeys().keySegments().flat(),
      ...(tx.meta?.loadedAddresses?.writable ?? []),
      ...(tx.meta?.loadedAddresses?.readonly ?? []),
    ];
    const keyAt = (idx: number): PublicKey | undefined => keyList[idx];
    const indexOf = (k: PublicKey): number =>
      keyList.findIndex((x) => x.equals(k));

    const touchesPool = (
      programIdIndex: number,
      accounts: Array<PublicKey | number>,
    ): boolean => {
      const pid = keyAt(programIdIndex);
      if (pid === undefined || !pid.equals(ammProgramId)) return false;
      return accounts.some((a) => {
        const k = typeof a === "number" ? keyAt(a) : keyAt(indexOf(a));
        return k !== undefined && k.equals(poolAddress);
      });
    };

    const topLevel = tx.transaction.message.compiledInstructions.some((ci) =>
      touchesPool(ci.programIdIndex, ci.accountKeyIndexes),
    );
    const inner = (tx.meta?.innerInstructions ?? []).some((set) =>
      set.instructions.some((ci) =>
        touchesPool(ci.programIdIndex, ci.accounts),
      ),
    );
    if (topLevel || inner) {
      return {
        lastSwapUnixTs: blockTime,
        slot: info.slot,
        signature: info.signature,
      };
    }
  }
  return null;
}

/**
 * Fetch the 32-byte slot hash (blockhash) for a slot — the value that
 * GraveScanner cross-checks against the SlotHashes sysvar. Attestations
 * must be issued for a recent slot: once the slot ages out of the
 * ~512-entry SlotHashes window the on-chain check fails closed.
 */
export async function fetchSlotHash(
  connection: Connection,
  slot: number,
): Promise<Uint8Array | null> {
  const block = await connection.getBlock(slot, {
    maxSupportedTransactionVersion: 0,
  });
  if (!block) return null;
  return new PublicKey(block.blockhash).toBytes();
}
