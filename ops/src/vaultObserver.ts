// SPDX-License-Identifier: Apache-2.0
//
// GraveVault observer — the Phase 11 "salvage receipts indexed / claims
// indexed / failed transactions monitored" service.
//
// One sweep = one getProgramAccounts over the GraveVault program, decoded
// with the SDK's own account decoders (no duplicated layouts), plus a
// failed-transaction sweep over the program's recent signatures. Every
// observation is structured; every anomaly raises a coded alert.
//
// Checks performed per sweep:
//   R1. Receipt sum invariant   lpHolder + salvor + protocol == totalProceeds
//   R2. Receipt share invariant each leg within 1 lamport of its
//                               4000/4000/2000 bps share (identical to the
//                               fleet Monitor's reconcile tolerance)
//   C1. Claim accounting        Σ ClaimRecords(pool) == registry.claimed
//   C2. Claim ceiling           Σ ClaimRecords(pool) ≤ receipt.lpHolderAmount
//   C3. Registry/receipt agree  registry.lpHolderPoolTotal == receipt.lpHolder
//   X1. Failed-tx sweep         recent vault signatures with err != null
//
// READ-ONLY by construction: this module holds no keypair, builds no
// instructions, and submits nothing.

import { PublicKey } from "@solana/web3.js";
import {
  AccountDisc,
  decodeClaimRecord,
  decodePoolRegistry,
  decodeSalvageReceipt,
  decodeVaultProtocolConfig,
  type ClaimRecord,
  type PoolRegistry,
  type SalvageReceipt,
  type VaultProtocolConfig,
} from "@graveyield/sdk";

import type { AlertManager } from "./alerts.js";
import type { HealthRegistry } from "./health.js";
import type { ChainView } from "./views.js";

/** A decoded GraveVault account payload (no address — see VaultAccount). */
export type DecodedVaultAccount =
  | { kind: "salvage-receipt"; receipt: SalvageReceipt }
  | { kind: "claim-record"; claim: ClaimRecord }
  | { kind: "pool-registry"; registry: PoolRegistry }
  | { kind: "vault-config"; config: VaultProtocolConfig };

/** A decoded GraveVault account with its address. */
export type VaultAccount = DecodedVaultAccount & { address: PublicKey };

/** Per-pool claim accounting roll-up. */
export interface PoolClaimRollup {
  poolAddress: string;
  claims: number;
  /** Σ ClaimRecord.amountLamports for the pool (lamports). */
  claimedLamports: bigint;
  /** The registry's on-chain claimed total (lamports), null when no registry. */
  registryClaimedLamports: bigint | null;
  /** The receipt's LP-holder leg (lamports), null when no receipt. */
  receiptLpHolderLamports: bigint | null;
  checks: { c1Accounted: boolean; c2WithinCeiling: boolean; c3Agrees: boolean };
}

/** The structured result of one observer sweep. */
export interface VaultObservation {
  takenAtMs: number;
  slot: number | null;
  vaultConfig: VaultProtocolConfig | null;
  receipts: Array<{ address: string; receipt: SalvageReceipt; checks: { r1Sum: boolean; r2Shares: boolean } }>;
  claims: Array<{ address: string; claim: ClaimRecord }>;
  registries: Array<{ address: string; registry: PoolRegistry }>;
  rollups: PoolClaimRollup[];
  failedTransactions: Array<{ signature: string; slot: number | null; err: string }>;
  /** Receipts failing R1 or R2. */
  anomalousReceipts: number;
  /** Rollups failing any of C1–C3. */
  anomalousRollups: number;
}

/** Observer options. */
export interface VaultObserverOptions {
  vaultProgramId: PublicKey;
  chain: ChainView;
  health: HealthRegistry;
  alerts: AlertManager;
  /** Sweep interval in ms (drives the health freshness window). */
  pollIntervalMs?: number;
  /** Failed-tx sweep depth (defaults to the config value). */
  failedTxSweepLimit?: number;
}

const LP_HOLDER_SHARE_BPS = 4_000;
const SALVOR_SHARE_BPS = 4_000;
const PROTOCOL_SHARE_BPS = 2_000;

/**
 * The GraveVault observer. Construct with a ChainView (real Connection via
 * `connectionChainView`, or a canned fixture in tests), then `runOnce()`
 * per sweep or `start(intervalMs)` to sweep forever.
 */
export class VaultObserver {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: VaultObserverOptions) {
    const poll = opts.pollIntervalMs ?? 60_000;
    this.opts.health.register("vault-observer", 3 * poll);
  }

  /** Run one sweep. Returns the structured observation; raises alerts on anomalies. */
  async runOnce(): Promise<VaultObservation> {
    const { chain, health, alerts } = this.opts;
    const takenAtMs = Date.now();
    health.counter("vault-observer.cycles");
    let degraded = false;

    let slot: number | null = null;
    try {
      slot = await chain.getSlot();
    } catch {
      degraded = true;
    }

    let owned: Awaited<ReturnType<ChainView["getProgramAccountsOwned"]>>;
    try {
      owned = await chain.getProgramAccountsOwned(this.opts.vaultProgramId);
    } catch (error) {
      degraded = true;
      health.heartbeat(
        "vault-observer",
        "down",
        `getProgramAccounts failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      alerts.raise("vault-accounts-unavailable", "critical",
        "GraveVault account sweep failed — the observer is blind",
        { program: this.opts.vaultProgramId.toBase58() });
      throw error instanceof Error ? error : new Error(String(error));
    }

    // Decode + dispatch on the SDK discriminators; unknown accounts are
    // counted (the program owns PDAs like vault authority seeds that are
    // not Anchor accounts) but never alerts.
    const receipts: VaultObservation["receipts"] = [];
    const claims: VaultObservation["claims"] = [];
    const registries: VaultObservation["registries"] = [];
    let vaultConfig: VaultProtocolConfig | null = null;
    let unknownAccounts = 0;

    for (const account of owned) {
      const decoded = tryDecodeVaultAccount(account.data);
      if (!decoded) {
        unknownAccounts++;
        continue;
      }
      if (decoded.kind === "salvage-receipt") {
        const checks = checkReceiptSums(decoded.receipt);
        receipts.push({ address: account.pubkey.toBase58(), receipt: decoded.receipt, checks });
      } else if (decoded.kind === "claim-record") {
        claims.push({ address: account.pubkey.toBase58(), claim: decoded.claim });
      } else if (decoded.kind === "pool-registry") {
        registries.push({ address: account.pubkey.toBase58(), registry: decoded.registry });
      } else {
        vaultConfig = decoded.config;
      }
    }

    // R1/R2 alerts.
    let anomalousReceipts = 0;
    for (const entry of receipts) {
      if (!entry.checks.r1Sum || !entry.checks.r2Shares) {
        anomalousReceipts++;
        health.counter("vault-observer.anomalous-receipts");
        alerts.raise("receipt-sum-mismatch", "critical",
          "SalvageReceipt fails the 40/40/20 accounting invariant",
          {
            receipt: entry.address,
            pool: entry.receipt.poolAddress.toBase58(),
            r1Sum: entry.checks.r1Sum,
            r2Shares: entry.checks.r2Shares,
            total: entry.receipt.totalProceedsLamports.toString(10),
          });
      }
    }

    // C1–C3 rollups per pool.
    const rollups = buildClaimRollups(receipts, claims, registries);
    let anomalousRollups = 0;
    for (const rollup of rollups) {
      const ok = rollup.checks.c1Accounted && rollup.checks.c2WithinCeiling && rollup.checks.c3Agrees;
      if (!ok) {
        anomalousRollups++;
        health.counter("vault-observer.anomalous-rollups");
        alerts.raise("claim-accounting-anomaly", "critical",
          "GraveVault claim accounting does not reconcile",
          {
            pool: rollup.poolAddress,
            claims: rollup.claims,
            claimed: rollup.claimedLamports.toString(10),
            registryClaimed: rollup.registryClaimedLamports?.toString(10) ?? null,
            receiptLpHolder: rollup.receiptLpHolderLamports?.toString(10) ?? null,
            c1Accounted: rollup.checks.c1Accounted,
            c2WithinCeiling: rollup.checks.c2WithinCeiling,
            c3Agrees: rollup.checks.c3Agrees,
          });
      }
    }

    // X1 failed-transaction sweep.
    const failedTransactions: VaultObservation["failedTransactions"] = [];
    try {
      const recent = await chain.getRecentSignatures(
        this.opts.vaultProgramId,
        this.opts.failedTxSweepLimit ?? 50,
      );
      for (const entry of recent) {
        if (entry.err !== null && entry.err !== undefined) {
          failedTransactions.push({
            signature: entry.signature,
            slot: entry.slot,
            err: summarizeErr(entry.err),
          });
        }
      }
    } catch {
      degraded = true; // sweep is best-effort; do not fail the whole cycle
    }
    // Alert on NEW failed signatures only (the dedup window handles the rest).
    for (const failed of failedTransactions) {
      health.counter("vault-observer.failed-transactions");
      alerts.raise("vault-tx-failed", "warn",
        "A GraveVault transaction failed on chain",
        { signature: failed.signature, slot: failed.slot, err: failed.err });
    }

    health.counter("vault-observer.receipts-seen", receipts.length);
    health.counter("vault-observer.claims-seen", claims.length);
    health.heartbeat(
      "vault-observer",
      degraded ? "degraded" : "ok",
      `receipts=${receipts.length} claims=${claims.length} registries=${registries.length} ` +
        `anomalies=${anomalousReceipts + anomalousRollups} failedTx=${failedTransactions.length} ` +
        `unknownAccts=${unknownAccounts}`,
    );

    return {
      takenAtMs,
      slot,
      vaultConfig,
      receipts,
      claims,
      registries,
      rollups,
      failedTransactions,
      anomalousReceipts,
      anomalousRollups,
    };
  }

  /** Sweep forever on `intervalMs`. Returns the stop function. */
  start(intervalMs: number): () => void {
    if (this.timer) return () => this.stop();
    const tick = (): void => {
      this.runOnce().catch(() => {
        // runOnce already heartbeated + alerted; the loop must survive.
      });
    };
    this.timer = setInterval(tick, intervalMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Decode one vault-owned account with the SDK decoders (null when unknown). */
export function tryDecodeVaultAccount(data: Uint8Array): DecodedVaultAccount | null {
  if (data.length < 8) return null;
  const disc = data.slice(0, 8);
  if (sameBytes(disc, AccountDisc.SalvageReceipt)) {
    return { kind: "salvage-receipt", receipt: decodeSalvageReceipt(data) };
  }
  if (sameBytes(disc, AccountDisc.ClaimRecord)) {
    return { kind: "claim-record", claim: decodeClaimRecord(data) };
  }
  if (sameBytes(disc, AccountDisc.PoolRegistry)) {
    return { kind: "pool-registry", registry: decodePoolRegistry(data) };
  }
  if (sameBytes(disc, AccountDisc.ProtocolConfig)) {
    return { kind: "vault-config", config: decodeVaultProtocolConfig(data) };
  }
  return null;
}

/** R1 + R2 — the exact monitor semantics (sum; ±1-lamport bps shares). */
export function checkReceiptSums(receipt: SalvageReceipt): { r1Sum: boolean; r2Shares: boolean } {
  const sum =
    receipt.lpHolderAmountLamports +
    receipt.salvorAmountLamports +
    receipt.protocolAmountLamports;
  const r1Sum = sum === receipt.totalProceedsLamports;
  const r2Shares =
    shareMatches(receipt.lpHolderAmountLamports, receipt.totalProceedsLamports, LP_HOLDER_SHARE_BPS) &&
    shareMatches(receipt.salvorAmountLamports, receipt.totalProceedsLamports, SALVOR_SHARE_BPS) &&
    shareMatches(receipt.protocolAmountLamports, receipt.totalProceedsLamports, PROTOCOL_SHARE_BPS);
  return { r1Sum, r2Shares };
}

/** |amount − bps% × total| ≤ 1 lamport (integer rounding tolerance). */
function shareMatches(amount: bigint, total: bigint, bps: number): boolean {
  const share = (total * BigInt(bps)) / 10_000n;
  const diff = amount > share ? amount - share : share - amount;
  return diff <= 1n;
}

/** Per-pool C1–C3 rollups over receipts + claims + registries. */
export function buildClaimRollups(
  receipts: VaultObservation["receipts"],
  claims: VaultObservation["claims"],
  registries: VaultObservation["registries"],
): PoolClaimRollup[] {
  const pools = new Set<string>();
  for (const r of receipts) pools.add(r.receipt.poolAddress.toBase58());
  for (const c of claims) pools.add(c.claim.poolAddress.toBase58());
  for (const r of registries) pools.add(r.registry.poolAddress.toBase58());

  const receiptByPool = new Map(receipts.map((r) => [r.receipt.poolAddress.toBase58(), r.receipt]));
  const registryByPool = new Map(registries.map((r) => [r.registry.poolAddress.toBase58(), r.registry]));

  const rollups: PoolClaimRollup[] = [];
  for (const pool of [...pools].sort()) {
    const poolClaims = claims.filter((c) => c.claim.poolAddress.toBase58() === pool);
    const claimedLamports = poolClaims.reduce((acc, c) => acc + c.claim.amountLamports, 0n);
    const receipt = receiptByPool.get(pool);
    const registry = registryByPool.get(pool);
    const receiptLpHolder = receipt?.lpHolderAmountLamports ?? null;
    const registryClaimed = registry?.lpHolderPoolClaimedLamports ?? null;

    const c1Accounted = registryClaimed === null ? poolClaims.length === 0 : registryClaimed === claimedLamports;
    const c2WithinCeiling = receiptLpHolder === null ? poolClaims.length === 0 : claimedLamports <= receiptLpHolder;
    const c3Agrees = (() => {
      if (!registry || !receipt) return true; // single-sided pools have nothing to disagree with
      return registry.lpHolderPoolTotalLamports === receipt.lpHolderAmountLamports;
    })();

    rollups.push({
      poolAddress: pool,
      claims: poolClaims.length,
      claimedLamports,
      registryClaimedLamports: registryClaimed,
      receiptLpHolderLamports: receiptLpHolder,
      checks: { c1Accounted, c2WithinCeiling, c3Agrees },
    });
  }
  return rollups;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function summarizeErr(err: unknown): string {
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
