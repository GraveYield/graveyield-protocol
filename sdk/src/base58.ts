// SPDX-License-Identifier: Apache-2.0
//
// Minimal base58 codec for Raydium V4 evidence classification.
//
// The Solana RPC returns instruction data as base58 strings inside
// `meta.innerInstructions` (JSON encoding), while outer message
// instructions arrive as already-decoded bytes. The evidence classifier
// must decode both surfaces, and the SDK deliberately carries no base58
// dependency — this module implements the Bitcoin-alphabet decode
// inline. Byte parity is pinned by `lastSwapEvidence.test.ts` against
// real mainnet instruction payloads (a wrong decode surfaces as a wrong
// Raydium V4 tag byte, which the fixture tests catch).

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_INDEX = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) ALPHABET_INDEX.set(ALPHABET.charAt(i), i);

/** Decode a base58 string (Bitcoin/Raydium/Solana alphabet) into bytes. */
export function decodeBase58(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  let n = 0n;
  for (const ch of input) {
    const idx = ALPHABET_INDEX.get(ch);
    if (idx === undefined) {
      throw new Error(`base58: invalid character ${JSON.stringify(ch)}`);
    }
    n = n * 58n + BigInt(idx);
  }
  const hex = n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0");
  const raw = n === 0n ? new Uint8Array(0) : Uint8Array.from(Buffer.from(hex, "hex"));
  // Leading '1' characters encode leading zero bytes.
  let zeros = 0;
  for (const ch of input) {
    if (ch === "1") zeros++;
    else break;
  }
  const out = new Uint8Array(zeros + raw.length);
  out.set(raw, zeros);
  return out;
}

/** Encode bytes as a base58 string (Bitcoin/Raydium/Solana alphabet). */
export function encodeBase58(input: Uint8Array): string {
  if (input.length === 0) return "";
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  let n = 0n;
  for (const byte of input) n = n * 256n + BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = ALPHABET.charAt(Number(n % 58n)) + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

/**
 * Decode instruction data that the RPC/web3.js surface may deliver as
 * either already-decoded bytes (outer compiled instructions) or a base58
 * string (`meta.innerInstructions`, JSON encoding). Byte arrays pass
 * through unchanged; anything else is treated as base58.
 */
export function decodeInstructionData(data: Uint8Array | string): Uint8Array {
  if (typeof data === "string") return decodeBase58(data);
  return data;
}
