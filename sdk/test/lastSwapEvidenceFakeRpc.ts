// SPDX-License-Identifier: Apache-2.0
//
// IMPL-001 last-swap evidence test harness — fixture-backed fake RPC.
//
// Real mainnet fixtures (see fixtures/lastSwap/PROVENANCE.md) are loaded
// through the SAME deserialization path production uses
// (`VersionedTransaction.deserialize`) so the harness hands the SDK the
// exact response shape a live web3.js `Connection` produces (probed
// 2026-11-14: MessageV0/MessageV1/legacy `getAccountKeys`, PublicKey
// loaded addresses, base58 inner instruction data, BigInt slot/blockTime).
// Synthetic edge cases are deterministic, labeled mutations of those real
// responses — never fabricated production evidence.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PublicKey,
  VersionedTransaction,
  type AccountInfo,
  type Connection,
} from "@solana/web3.js";

import { RAYDIUM_V4_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "../src/index.js";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/lastSwap/", import.meta.url));

export const POOL = new PublicKey("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2");
export const COIN_VAULT = new PublicKey("DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz");
export const PC_VAULT = new PublicKey("HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz");

interface RawFixture {
  kind: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  confirmationStatus: string;
  txVersion: number | string;
  wireBase64: string;
  meta: {
    err: unknown;
    innerInstructions: Array<{
      index: number;
      instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
    }>;
    loadedAddresses: { writable: string[]; readonly: string[] };
    preTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null;
    postTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null;
  };
  provenance: Record<string, unknown>;
}

function readRawFixture(name: string): RawFixture {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}/${name}.json`, "utf8")) as RawFixture;
}

/** A parsed real fixture: byte-exact response object + metadata. */
export interface LoadedTx {
  signature: string;
  slot: number;
  blockTime: number;
  err: unknown;
  response: Record<string, unknown>;
  /** The message's resolved account keys (static + ALT-loaded). */
  accountKeys: PublicKey[];
  /** Index of the first Raydium V4 instruction in the OUTER message, or -1. */
  outerV4Index: number;
  /** Where the first V4 instruction lives. */
  v4Surface: "outer" | "inner";
}

export function loadTxFixture(name: string): LoadedTx {
  const fx = readRawFixture(name);
  const txObj = VersionedTransaction.deserialize(Buffer.from(fx.wireBase64, "base64"));
  const loaded = {
    writable: fx.meta.loadedAddresses.writable.map((k) => new PublicKey(k)),
    readonly: fx.meta.loadedAddresses.readonly.map((k) => new PublicKey(k)),
  };
  const accountKeys = [
    ...txObj.message.getAccountKeys({ accountKeysFromLookups: loaded }).keySegments().flat(),
  ];
  const meta = {
    err: fx.meta.err,
    innerInstructions: fx.meta.innerInstructions,
    loadedAddresses: loaded,
    preTokenBalances: fx.meta.preTokenBalances,
    postTokenBalances: fx.meta.postTokenBalances,
  };
  const response = {
    slot: BigInt(fx.slot),
    blockTime: fx.blockTime === null ? null : BigInt(fx.blockTime),
    transaction: txObj,
    meta,
  };
  const isV4 = (pidIndex: number): boolean =>
    pidIndex >= 0 &&
    pidIndex < accountKeys.length &&
    accountKeys[pidIndex].equals(RAYDIUM_V4_PROGRAM_ID);
  const outerV4Index = txObj.message.compiledInstructions.findIndex((ci) =>
    isV4(ci.programIdIndex),
  );
  let v4Surface: "outer" | "inner" = "outer";
  if (outerV4Index < 0) {
    for (const set of fx.meta.innerInstructions) {
      if (set.instructions.some((ix) => isV4(ix.programIdIndex))) v4Surface = "inner";
    }
  }
  return {
    signature: fx.signature,
    slot: fx.slot,
    blockTime: fx.blockTime ?? 0,
    err: fx.meta.err,
    response: response as unknown as Record<string, unknown>,
    accountKeys,
    outerV4Index,
    v4Surface,
  };
}

// ---------------------------------------------------------------------------
// Labeled mutation builders — synthetic edge cases derived from REAL
// fixtures. Each helper clones the parsed response so fixtures stay
// immutable across tests.
// ---------------------------------------------------------------------------

function shallowCloneResponse(tx: LoadedTx): Record<string, unknown> {
  const base = tx.response as {
    slot: bigint;
    blockTime: bigint | null;
    transaction: {
      message: {
        getAccountKeys: (opts?: unknown) => {
          keySegments(): ReadonlyArray<ReadonlyArray<PublicKey | string>>;
        };
        compiledInstructions: Array<Record<string, unknown>>;
      };
    };
    meta: Record<string, unknown> | null;
  };
  // Plain duck-typed message: the real Message class exposes getters that
  // cannot be overridden per-clone.
  const baseMessage = base.transaction.message;
  const message = {
    getAccountKeys: (opts?: unknown) => baseMessage.getAccountKeys.call(baseMessage, opts),
    compiledInstructions: [...baseMessage.compiledInstructions],
  };
  return {
    slot: base.slot,
    blockTime: base.blockTime,
    transaction: { message },
    meta: base.meta === null ? null : { ...base.meta },
  };
}

/** Replace the data of the first V4 instruction (outer or inner). */
export function withV4InstructionData(tx: LoadedTx, data: Uint8Array): Record<string, unknown> {
  const clone = shallowCloneResponse(tx);
  const message = (clone.transaction as { message: Record<string, unknown> }).message;
  const compiled = message.compiledInstructions as Array<{
    programIdIndex: number;
    accountKeyIndexes: number[];
    data: Uint8Array | string;
  }>;
  if (tx.v4Surface === "outer") {
    message.compiledInstructions = compiled.map((ci, i) =>
      i === tx.outerV4Index ? { ...ci, data } : ci,
    );
  } else {
    const meta = clone.meta as {
      innerInstructions: Array<{ index: number; instructions: Array<Record<string, unknown>> }>;
    };
    let replaced = false;
    meta.innerInstructions = meta.innerInstructions.map((set) => ({
      ...set,
      instructions: set.instructions.map((ix) => {
        if (!replaced && tx.accountKeys[ix.programIdIndex]?.equals(RAYDIUM_V4_PROGRAM_ID)) {
          replaced = true;
          return { ...ix, data };
        }
        return ix;
      }),
    }));
  }
  return clone;
}

/**
 * SYNTHETIC (labeled): re-map the real swap's account view so the pool and
 * vaults resolve through ALT-loaded positions — a v0-style message whose
 * static keys end at a split point and whose remaining keys arrive via
 * `accountKeysFromLookups`. Exercises the adapter's ALT-resolution path
 * (the old implementation called `getAccountKeys()` without lookups and
 * crashed or misresolved such transactions). No production evidence is
 * fabricated: the instruction set is the real swap fixture's.
 */
export function withSwapAccountsInLoadedKeys(tx: LoadedTx): Record<string, unknown> {
  const clone = shallowCloneResponse(tx);
  const allKeys = [...tx.accountKeys];
  const splitAt = Math.max(8, Math.floor(allKeys.length / 2));
  const staticPart = allKeys.slice(0, splitAt);
  const loadedWritable = allKeys.slice(splitAt);
  const message = (clone.transaction as { message: Record<string, unknown> }).message;
  message.getAccountKeys = (opts?: { accountKeysFromLookups?: unknown }) => ({
    keySegments: () =>
      opts?.accountKeysFromLookups ? [staticPart, loadedWritable, []] : [staticPart],
  });
  (clone.meta as Record<string, unknown>).loadedAddresses = {
    writable: loadedWritable,
    readonly: [],
  };
  return clone;
}

/** Raydium V4 instruction data for `tag` + 16 zero arg bytes (17 bytes total,
 *  the exact wire length of every swap/admin instruction on mainnet). */
export function v4TagData(tag: number): Uint8Array {
  const data = new Uint8Array(17);
  data[0] = tag;
  return data;
}

/** Replace the program id of the first V4 instruction (pool no longer invoked
 *  by the AMM program). */
export function withV4ProgramReplaced(tx: LoadedTx): Record<string, unknown> {
  const clone = shallowCloneResponse(tx);
  const message = (clone.transaction as { message: Record<string, unknown> }).message;
  const tokenProgramIndex = tx.accountKeys.findIndex((k) => k.equals(SPL_TOKEN_PROGRAM_ID));
  const compiled = message.compiledInstructions as Array<Record<string, unknown>>;
  message.compiledInstructions = compiled.map((ci, i) =>
    i === tx.outerV4Index ? { ...ci, programIdIndex: tokenProgramIndex } : ci,
  );
  return clone;
}

/** Out-of-bounds program id index — malformed metadata view. */
export function withOobProgramIdIndex(tx: LoadedTx): Record<string, unknown> {
  const clone = shallowCloneResponse(tx);
  const message = (clone.transaction as { message: Record<string, unknown> }).message;
  const compiled = message.compiledInstructions as Array<Record<string, unknown>>;
  message.compiledInstructions = compiled.map((ci, i) =>
    i === 0 ? { ...ci, programIdIndex: 99_999 } : ci,
  );
  return clone;
}

/** Drop the vault entries from the V4 instruction's account list. */
export function withVaultsRemovedFromAccounts(tx: LoadedTx): Record<string, unknown> {
  const clone = shallowCloneResponse(tx);
  const vaultIdx = new Set<number>();
  tx.accountKeys.forEach((k, i) => {
    if (k.equals(COIN_VAULT) || k.equals(PC_VAULT)) vaultIdx.add(i);
  });
  const tokenProgramIndex = tx.accountKeys.findIndex((k) => k.equals(SPL_TOKEN_PROGRAM_ID));
  const message = (clone.transaction as { message: Record<string, unknown> }).message;
  const compiled = message.compiledInstructions as Array<{
    programIdIndex: number;
    accountKeyIndexes: number[];
    data: Uint8Array | string;
  }>;
  if (tx.v4Surface === "outer") {
    message.compiledInstructions = compiled.map((ci, i) =>
      i === tx.outerV4Index
        ? {
            ...ci,
            accountKeyIndexes: ci.accountKeyIndexes.map((a) =>
              vaultIdx.has(a) ? tokenProgramIndex : a,
            ),
          }
        : ci,
    );
  } else {
    const meta = clone.meta as {
      innerInstructions: Array<{ index: number; instructions: Array<Record<string, unknown>> }>;
    };
    let replaced = false;
    meta.innerInstructions = meta.innerInstructions.map((set) => ({
      ...set,
      instructions: set.instructions.map((ix) => {
        if (
          !replaced &&
          tx.accountKeys[ix.programIdIndex as number]?.equals(RAYDIUM_V4_PROGRAM_ID)
        ) {
          replaced = true;
          return {
            ...ix,
            accounts: (ix.accounts as number[]).map((a) =>
              vaultIdx.has(a) ? tokenProgramIndex : a,
            ),
          };
        }
        return ix;
      }),
    }));
  }
  return clone;
}

/** Zero out one vault's post balance (claimed swap without the movement). */
export function withVaultDeltasZeroed(tx: LoadedTx): Record<string, unknown> {
  const clone = shallowCloneResponse(tx);
  const meta = clone.meta as {
    preTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null;
    postTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null;
  };
  const coinIdx = tx.accountKeys.findIndex((k) => k.equals(COIN_VAULT));
  const pcIdx = tx.accountKeys.findIndex((k) => k.equals(PC_VAULT));
  const freeze = (
    entries: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null,
  ) =>
    entries?.map((e) =>
      e.accountIndex === coinIdx || e.accountIndex === pcIdx
        ? { ...e, uiTokenAmount: { ...e.uiTokenAmount, amount: "1000000" } }
        : e,
    ) ?? null;
  meta.preTokenBalances = freeze(meta.preTokenBalances);
  meta.postTokenBalances = freeze(meta.postTokenBalances);
  return clone;
}

/** Drop all token balance data (incomplete RPC response). */
export function withTokenBalancesRemoved(tx: LoadedTx): Record<string, unknown> {
  const clone = shallowCloneResponse(tx);
  const meta = clone.meta as Record<string, unknown>;
  meta.preTokenBalances = null;
  meta.postTokenBalances = null;
  return clone;
}

/** Transaction succeeded marker flip (failed transaction). */
export function withErr(tx: LoadedTx, err: unknown): Record<string, unknown> {
  const clone = shallowCloneResponse(tx);
  (clone.meta as Record<string, unknown>).err = err;
  return clone;
}

/** Remove transaction metadata entirely. */
export function withMetaRemoved(tx: LoadedTx): Record<string, unknown> {
  const clone = shallowCloneResponse(tx);
  clone.meta = null;
  return clone;
}

/**
 * Sources accepted by the Correction 001 §2 mutations: a loaded fixture
 * (uses its `response`) or an already-built response object — so the
 * mutations compose (`withInnerInstructionsNull(withV4ProgramReplaced(tx))`).
 */
type ResponseSource = LoadedTx | Record<string, unknown>;

function toResponse(source: ResponseSource): Record<string, unknown> {
  return "response" in source ? (source.response as Record<string, unknown>) : source;
}

/** Shallow-clone a plain response with a fresh top-level meta object. */
function shallowClonePlain(response: Record<string, unknown>): Record<string, unknown> {
  return {
    ...response,
    meta: response.meta === null ? null : { ...(response.meta as Record<string, unknown>) },
  };
}

/**
 * SYNTHETIC (labeled, Correction 001 §2): remove `meta.err` while keeping
 * the rest of the metadata — the RPC response does not record whether the
 * transaction succeeded or failed. Success can never be inferred here.
 */
export function withErrMetaRemoved(source: ResponseSource): Record<string, unknown> {
  const clone = shallowClonePlain(toResponse(source));
  delete (clone.meta as Record<string, unknown>).err;
  return clone;
}

/**
 * SYNTHETIC (labeled, Correction 001 §2): `meta.innerInstructions = null`
 * — the RPC recorded the transaction but NOT its inner (CPI) instruction
 * list. Absence of the list is never proof that no inner instructions
 * occurred.
 */
export function withInnerInstructionsNull(source: ResponseSource): Record<string, unknown> {
  const clone = shallowClonePlain(toResponse(source));
  (clone.meta as Record<string, unknown>).innerInstructions = null;
  return clone;
}

/**
 * SYNTHETIC (labeled, Correction 001 §2): remove `meta.innerInstructions`
 * entirely (some encodings omit the property instead of nulling it).
 * Equivalent to null: recording unavailable, never "empty".
 */
export function withInnerInstructionsRemoved(source: ResponseSource): Record<string, unknown> {
  const clone = shallowClonePlain(toResponse(source));
  delete (clone.meta as Record<string, unknown>).innerInstructions;
  return clone;
}

// ---------------------------------------------------------------------------

export interface FakeCandidate {
  signature: string;
  /** Response object (real or mutated), or null → getTransaction misses. */
  response: Record<string, unknown> | null;
  /** Signature-level block time override (null → missing block time). */
  blockTime?: number | null;
  slot?: number;
  confirmationStatus?: string | null;
  err?: unknown | null;
}

/**
 * How the fake's `getTransaction` reacts to the requested
 * `maxSupportedTransactionVersion` (Correction 001 §3):
 *   - "accept" (default): serve the response for any request (the fake
 *     is version-agnostic, like the real duck-typed response surface);
 *   - "reject-nonzero-version": throw a provider-style version error for
 *     every request whose max version is above 0 (an endpoint that caps
 *     the parameter) — exercises the version-0 fallback;
 *   - "reject-all": throw for every request (the tx cannot be fetched at
 *     all) — the candidate must stay unresolved, never silently skipped.
 */
type VersionBehavior = "accept" | "reject-nonzero-version" | "reject-all";

interface RecordedTxFetch {
  signature: string;
  maxSupportedTransactionVersion: number | undefined;
  commitment: string | undefined;
}

/**
 * In-memory Connection covering the D4/D5 derivation surface: bounded
 * signature scans, per-candidate transaction fetches, the pool AmmInfo
 * account, and the finalized slot for depth-margin tests.
 */
export class LastSwapFakeRpc {
  private readonly poolBytes: Uint8Array | null;
  private readonly versionBehavior: VersionBehavior;
  finalizedSlot: number | null = null;
  scanLimits: number[] = [];
  /** Every getTransaction call, with the requested version + commitment. */
  readonly txFetches: RecordedTxFetch[] = [];

  constructor(
    private readonly candidates: FakeCandidate[],
    opts?: { poolAccountData?: Uint8Array | null; versionBehavior?: VersionBehavior },
  ) {
    this.poolBytes =
      opts !== undefined && "poolAccountData" in opts
        ? opts.poolAccountData
        : loadPoolAccountBytes();
    this.versionBehavior = opts?.versionBehavior ?? "accept";
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  async getSignaturesForAddress(
    _address: PublicKey,
    opts?: { limit?: number },
  ): Promise<
    Array<{
      signature: string;
      slot: bigint;
      blockTime: bigint | null;
      err: unknown;
      confirmationStatus: string | null;
    }>
  > {
    this.scanLimits.push(opts?.limit ?? 1000);
    const limit = opts?.limit ?? this.candidates.length;
    return this.candidates.slice(0, limit).map((c) => ({
      signature: c.signature,
      slot: BigInt(c.slot ?? 900_000),
      blockTime:
        c.blockTime === undefined
          ? ((c.response as { blockTime?: bigint | null } | null)?.blockTime ?? null)
          : c.blockTime === null
            ? null
            : BigInt(c.blockTime),
      err:
        c.err === undefined
          ? ((c.response as { meta?: { err?: unknown } | null } | null)?.meta?.err ?? null)
          : c.err,
      confirmationStatus: c.confirmationStatus ?? "finalized",
    }));
  }

  async getTransaction(
    signature: string,
    opts?: { maxSupportedTransactionVersion?: number; commitment?: string },
  ): Promise<Record<string, unknown> | null> {
    this.txFetches.push({
      signature,
      maxSupportedTransactionVersion: opts?.maxSupportedTransactionVersion,
      commitment: opts?.commitment,
    });
    const version = opts?.maxSupportedTransactionVersion;
    if (this.versionBehavior === "reject-nonzero-version" && version !== 0) {
      throw new Error(`Transaction version (${String(version)}) is not supported by this endpoint`);
    }
    if (this.versionBehavior === "reject-all") {
      throw new Error(`Transaction version (${String(version)}) is not supported by this endpoint`);
    }
    const candidate = this.candidates.find((c) => c.signature === signature);
    return candidate?.response ?? null;
  }

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    if (this.poolBytes !== null && address.equals(POOL)) {
      return {
        lamports: 1_000_000,
        data: Buffer.from(this.poolBytes),
        owner: RAYDIUM_V4_PROGRAM_ID,
        executable: false,
        rentEpoch: 0n,
      } as unknown as AccountInfo<Uint8Array>;
    }
    return null;
  }

  async getSlot(commitment?: "finalized"): Promise<bigint> {
    if (commitment === "finalized" && this.finalizedSlot !== null)
      return BigInt(this.finalizedSlot);
    return 1_000_000n;
  }
}

let poolBytesCache: Uint8Array | null | undefined;
/** 752-byte AmmInfo bytes from the real pool-account fixture. */
export function loadPoolAccountBytes(): Uint8Array | null {
  if (poolBytesCache !== undefined) return poolBytesCache;
  try {
    const raw = JSON.parse(readFileSync(`${FIXTURE_DIR}/pool_account_sol_usdc.json`, "utf8")) as {
      dataBase64: string;
    };
    poolBytesCache = new Uint8Array(Buffer.from(raw.dataBase64, "base64"));
  } catch {
    poolBytesCache = null;
  }
  return poolBytesCache;
}
