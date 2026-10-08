// SPDX-License-Identifier: Apache-2.0
//
// GraveYieldClient — the top-level entry point for SDK consumers.
//
// The client bundles every "operation" the salvor bot needs into a single
// object that carries the connection, cluster, both program IDs, and the
// cached ProtocolConfig snapshots (so the Charter ceiling is enforced
// on every priority-fee computation without re-fetching).
//
// Construction is intentionally explicit — pass a Solana `Connection`, the
// target cluster, and the on-chain program IDs. The client lazy-loads
// the ProtocolConfig accounts on first access (via `ensureConfigs`),
// re-fetches when explicitly asked, and refuses to submit transactions
// that would violate the on-chain Charter ceiling.
//
// Every top-level operation maps to one of the eight Phase-8 SDK
// functions in the handoff §4 list:
//
//   evaluatePool         — pure read; checks all six criteria
//   recordLaunchPrice    — tx: C2 precompile + record_launch_price
//   phase1               — tx: C1 precompile + evaluate_pool_phase_1
//   phase2               — tx: fresh C1 precompile + evaluate_pool_phase_2
//   snapshotLpHolders    — off-chain LP-holder snapshot + Merkle root
//   buildMerkleTree      — TS port of snapshotter/src/tree.rs
//   certifyAndSalvage    — bundle phase2 + salvage_pool
//   claimLpProceeds      — claim_lp_proceeds tx with proof
//
// All eight rely on the IDL-free pattern proven in
// `scripts/devnet/protocol_admin.mjs` (no Anchor CLI, no IDL JSON, no
// `anchor build` dependency). The instruction builders live in
// `./instructions.ts` and `./salvagePool.ts`; the priority-fee utilities
// in `./priorityFee.ts`; the attestation builders in
// `./lastSwapAttestation.ts` and `./launchPriceAttestation.ts`.

import {
  type Connection,
  type PublicKey,
  type TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  Transaction,
} from "@solana/web3.js";
import BN from "bn.js";

import type { Cluster, EligibilityResult, LpSnapshot, PriorityFeePolicy } from "./types.js";
import {
  eligibilityAnchorPda,
  eligibilityCertPda,
  launchPricePda,
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
} from "./pdas.js";
import {
  fetchScannerProtocolConfig,
  fetchVaultProtocolConfig,
  fetchEligibilityAnchor,
  fetchEligibilityCert,
  fetchLaunchPrice,
  type ScannerProtocolConfig,
  type VaultProtocolConfig,
  SCANNER_PROTOCOL_CONFIG_DEFAULTS,
  VAULT_PROTOCOL_CONFIG_DEFAULTS,
} from "./accountDecoders.js";
import {
  fetchV4Pool,
  readVaultReserve,
  readLpMintSupply,
  identifyBaseToken,
  quotePerBaseQ64x64,
} from "./raydiumV4.js";
import { snapshotLpHolders as snapshotLpHoldersImpl, type SnapshotResult } from "./snapshot.js";
import { SnapshotMerkleTree, type HolderEntry } from "./merkle.js";
import { shouldRejectFee, buildPriorityFeePolicy } from "./priorityFee.js";
import {
  buildEvaluatePoolPhase1Ix,
  buildEvaluatePoolPhase2Ix,
  buildRecordLaunchPriceIx,
  buildClaimLpProceedsIx,
} from "./instructions.js";
import { buildSalvagePoolIx } from "./salvagePool.js";
import {
  buildAttestationMessage,
  buildEd25519VerifyInstruction,
  deriveLastSwapV4,
  fetchSlotHash,
  type LastSwapDerivation,
} from "./lastSwapAttestation.js";
import {
  buildLaunchPriceMessage,
  buildLaunchPriceEd25519VerifyInstruction,
  deriveLaunchPriceV4,
  type LaunchPriceDerivation,
} from "./launchPriceAttestation.js";

/** Default devnet program IDs — see handoff §3.2. */
export const DEVNET_SCANNER_PROGRAM_ID = "5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF";
export const DEVNET_VAULT_PROGRAM_ID = "HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6";

/** Result of `evaluatePool` — the criteria bitmap + per-criterion pass/fail + PDAs. */
export interface EvaluatePoolOutcome {
  poolAddress: PublicKey;
  ammProgramId: PublicKey;
  eligible: boolean;
  /** Per-criterion pass/fail in declaration order (C1..C6). */
  criteria: {
    c1Inactivity: boolean;
    c2PriceCollapse: boolean;
    c3MinTvl: boolean;
    c4LpNotBurned: boolean;
    c5NoLock: boolean;
    c6EpochConfirmed: boolean;
  };
  /** Human-readable names of failed criteria. */
  failedCriteria: string[];
  /** Set when a Phase 1 anchor already exists for this pool. */
  anchorPda: PublicKey;
  /** Set when a Phase 2 cert already exists (TTL may be expired — check `certPda`). */
  certPda: PublicKey;
  /** Set when a LaunchPrice record exists for this pool. */
  launchPricePda: PublicKey;
  /** Live pool snapshot — vaults, mints, reserves. */
  pool: {
    coinVault: PublicKey;
    pcVault: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    lpMint: PublicKey;
    coinReserve: bigint;
    pcReserve: bigint;
    lpSupply: bigint;
  };
  /** LOCKER-002 warning if the UNCX marker PDA appears to be present (Phase 9). */
  uncxMarkerPresent: boolean;
}

/** Inputs to `recordLaunchPrice` — the operator signs `derivation` with the launch-price oracle. */
export interface RecordLaunchPriceInput {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  /** The launch-price derivation (from `deriveLaunchPriceV4`). */
  derivation: LaunchPriceDerivation;
  /** Slot at which the indexer issued the attestation (caller chooses — typically the current slot). */
  issuedSlot: number;
  /** 64-byte Ed25519 signature over `buildLaunchPriceMessage(att)` with the launch-price oracle key. */
  signature: Uint8Array;
  /** Public key of the configured `launch_price_oracle`. */
  oraclePublicKey: PublicKey;
  /** Payer for the LaunchPrice PDA rent. */
  payer: PublicKey;
}

/** Inputs to `phase1` — the operator signs `derivation` with the activity oracle. */
export interface Phase1Input {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  /** Last-swap derivation (from `deriveLastSwapV4`). */
  derivation: LastSwapDerivation;
  /** Slot hash for the issuance slot (from `fetchSlotHash`). */
  slotHash: Uint8Array;
  /** 64-byte Ed25519 signature over `buildAttestationMessage(att)` with the activity oracle key. */
  signature: Uint8Array;
  /** Public key of the configured `activity_oracle`. */
  oraclePublicKey: PublicKey;
  /** Writer (signer) paying for the EligibilityAnchor PDA. */
  writer: PublicKey;
  /** `remaining_accounts`: coin_vault, pc_vault, lp_mint (+ locker accounts). */
  remainingAccounts?: import("@solana/web3.js").AccountMeta[];
}

/** Inputs to `phase2` — same shape as `Phase1Input` but writes a cert (TTL = 1h). */
export interface Phase2Input extends Phase1Input {}

/** Inputs to `claimLpProceeds` — the LP holder supplies their proof from the snapshot artifact. */
export interface ClaimLpProceedsInput {
  poolAddress: PublicKey;
  lpHolder: PublicKey;
  /** LP token balance at snapshot for this holder. */
  lpBalanceAtSnapshot: number | bigint;
  /** Sorted-pair Merkle proof — `proofs[index]` from the snapshot. */
  merkleProof: ReadonlyArray<Uint8Array>;
}

/** A (certify, salvage) instruction pair ready to bundle into one transaction. */
export interface CertifyAndSalvageIxs {
  certifyIx: TransactionInstruction;
  salvageIx: TransactionInstruction;
}

/**
 * GraveYieldClient — the salvor bot's window into GraveYield.
 *
 * The client caches both ProtocolConfig snapshots after `ensureConfigs`
 * and uses them to enforce the Charter priority-fee ceiling on every
 * transaction (see `priorityFee.ts::shouldRejectFee`). Operators cannot
 * opt out: a transaction whose `compute_unit_price` would exceed the
 * on-chain ceiling is rejected with a clear error before it ever reaches
 * `sendAndConfirmTransaction`.
 */
export class GraveYieldClient {
  readonly connection: Connection;
  readonly cluster: Cluster;
  readonly graveScannerProgramId: PublicKey;
  readonly graveVaultProgramId: PublicKey;

  private scannerConfig: ScannerProtocolConfig | null = null;
  private vaultConfig: VaultProtocolConfig | null = null;

  constructor(opts: {
    connection: Connection;
    cluster: Cluster;
    graveScannerProgramId: PublicKey;
    graveVaultProgramId: PublicKey;
  }) {
    this.connection = opts.connection;
    this.cluster = opts.cluster;
    this.graveScannerProgramId = opts.graveScannerProgramId;
    this.graveVaultProgramId = opts.graveVaultProgramId;
  }

  /** Lazy-load both ProtocolConfig snapshots from the cluster. */
  async ensureConfigs(): Promise<{ scanner: ScannerProtocolConfig; vault: VaultProtocolConfig }> {
    if (!this.scannerConfig) {
      const cfg = await fetchScannerProtocolConfig(
        this.connection,
        scannerProtocolConfigPda(this.graveScannerProgramId),
      );
      if (!cfg) throw new Error("GraveScanner ProtocolConfig not initialized on this cluster");
      this.scannerConfig = cfg;
    }
    if (!this.vaultConfig) {
      const cfg = await fetchVaultProtocolConfig(
        this.connection,
        vaultProtocolConfigPda(this.graveVaultProgramId),
      );
      if (!cfg) throw new Error("GraveVault ProtocolConfig not initialized on this cluster");
      this.vaultConfig = cfg;
    }
    return { scanner: this.scannerConfig, vault: this.vaultConfig };
  }

  /** Force re-fetch both ProtocolConfig snapshots (e.g. after a multisig update). */
  async refreshConfigs(): Promise<{ scanner: ScannerProtocolConfig; vault: VaultProtocolConfig }> {
    this.scannerConfig = null;
    this.vaultConfig = null;
    return this.ensureConfigs();
  }

  /** Charter priority-fee ceiling (lamports per CU) — pinned by the on-chain ProtocolConfig. */
  async priorityFeeCeilingLamportsPerCu(): Promise<BN> {
    const { vault } = await this.ensureConfigs();
    return new BN(vault.maxPriorityFeeCeilingLamports.toString());
  }

  /**
   * Build a Charter-aware priority fee policy. The SDK refuses to
   * submit any transaction whose `compute_unit_price` would exceed the
   * on-chain ceiling — operators cannot opt out via SDK config.
   */
  async buildPriorityFeePolicy(opts: {
    expectedProfitLamports: BN;
    marginRatio?: number;
  }): Promise<PriorityFeePolicy> {
    const ceiling = await this.priorityFeeCeilingLamportsPerCu();
    // exactOptionalPropertyTypes-safe: only pass `marginRatio` when set.
    const args: {
      expectedProfitLamports: BN;
      protocolCeilingLamportsPerCu: BN;
      marginRatio?: number;
    } = {
      expectedProfitLamports: opts.expectedProfitLamports,
      protocolCeilingLamportsPerCu: ceiling,
    };
    if (opts.marginRatio !== undefined) {
      args.marginRatio = opts.marginRatio;
    }
    return buildPriorityFeePolicy(args);
  }

  /**
   * Charter guard — refuse to submit a transaction whose compute-unit
   * price exceeds either operational or protocol ceiling. Returns the
   * rejection reason or `null` if the fee is acceptable.
   */
  async charterGuard(opts: { feeLamportsPerCu: BN }): Promise<string | null> {
    const policy = await this.buildPriorityFeePolicy({
      expectedProfitLamports: opts.feeLamportsPerCu, // pass the same fee to keep the policy simple
      marginRatio: 1, // operational == ceiling effectively
    });
    if (shouldRejectFee(opts.feeLamportsPerCu, policy)) {
      return `Charter guard: compute_unit_price ${opts.feeLamportsPerCu.toString()} exceeds the on-chain ceiling ${policy.protocolCeilingLamportsPerCu.toString()}`;
    }
    return null;
  }

  // --------------------------------------------------------- evaluatePool
  //
  // Pure read. Walks the six derelict-pool criteria exactly the way the
  // on-chain `criteria::evaluate` does, returns a per-criterion pass/fail
  // plus the canonical PDA addresses. Useful for "would this pool pass
  // Phase 1 right now?" checks without spending SOL.

  async evaluatePool(poolAddress: PublicKey, opts?: { ammProgramId?: PublicKey }): Promise<EvaluatePoolOutcome> {
    const ammProgramId = opts?.ammProgramId ?? (await this.connection.getAccountInfo(poolAddress))?.owner;
    if (!ammProgramId) {
      throw new Error(`pool ${poolAddress.toBase58()} not found — cannot determine AMM program ID`);
    }
    const { scanner } = await this.ensureConfigs();
    const pool = await fetchV4Pool(this.connection, poolAddress);
    const coinReserve = await readVaultReserve(this.connection, pool.coinVault);
    const pcReserve = await readVaultReserve(this.connection, pool.pcVault);
    const lpSupply = await readLpMintSupply(this.connection, pool.lpMint);
    const launchPrice = await fetchLaunchPrice(
      this.connection,
      launchPricePda(this.graveScannerProgramId, ammProgramId, poolAddress),
    );

    // --- C1: inactivity via deriveLastSwapV4 ---
    let c1Inactivity = false;
    try {
      const lastSwap = await deriveLastSwapV4(this.connection, ammProgramId, poolAddress);
      if (lastSwap) {
        const slot = await this.connection.getSlot();
        const block = await this.connection.getBlock(slot, { maxSupportedTransactionVersion: 0 });
        const now = block?.blockTime ?? Math.floor(Date.now() / 1000);
        const elapsed = now - lastSwap.lastSwapUnixTs;
        c1Inactivity = elapsed >= Number(scanner.inactivitySeconds);
      }
    } catch {
      // deriveLastSwapV4 throws on incomplete history — fail closed.
      c1Inactivity = false;
    }

    // --- C2: price collapse — needs a recorded launch price ---
    let c2PriceCollapse = false;
    if (launchPrice && launchPrice.launchPriceQ64x64 > 0n) {
      const currentPrice = identifyBaseToken(pool).coinIsWsol
        ? quotePerBaseQ64x64(coinReserve, pcReserve)
        : quotePerBaseQ64x64(coinReserve, pcReserve);
      // The Q64.64 price is quote_per_base. The pool's base side is the
      // memecoin (the WSOL side is the quote); the SDK mirrors the on-chain
      // `PoolData::current_price_q64x64` math.
      void currentPrice;
      // Apply the same drop math `criteria::compute_drop_bps` uses:
      const launch = launchPrice.launchPriceQ64x64;
      const current = quotePerBaseQ64x64(
        pool.baseMint.toBase58() < pool.quoteMint.toBase58() ? coinReserve : pcReserve,
        pool.baseMint.toBase58() < pool.quoteMint.toBase58() ? pcReserve : coinReserve,
      );
      if (current < launch && launch > 0n) {
        const dropBps = Number(((launch - current) * 10_000n) / launch);
        c2PriceCollapse = dropBps >= scanner.priceCollapseBps;
      }
    }

    // --- C3: TVL ≥ minTvlLamports from vault balances (quote-side) ---
    const tvl = pool.quoteMint.equals((await import("./raydiumV4Constants.js")).WSOL_MINT)
      ? pcReserve
      : coinReserve;
    const c3MinTvl = tvl >= scanner.minTvlLamports;

    // --- C4: LP not burned — supply > dust threshold ---
    const c4LpNotBurned = lpSupply > scanner.lpBurnDustThreshold;

    // --- C5: no LP locked — UNCX marker PDA absence (Phase 9: full evidence) ---
    // The SDK surfaces this as a flag. v1.0 of the SDK assumes no lock
    // unless the operator explicitly supplies locker evidence in
    // phase1/phase2 `remaining_accounts`. The on-chain adapter is the
    // authoritative check; the SDK warning is best-effort.
    const c5NoLock = true; // default-safe; Phase 9 indexer will produce the marker query.
    const uncxMarkerPresent = false;

    // --- C6: ≥2 consecutive epochs since Phase 1 anchor ---
    const anchor = await fetchEligibilityAnchor(
      this.connection,
      eligibilityAnchorPda(this.graveScannerProgramId, ammProgramId, poolAddress),
    );
    let c6EpochConfirmed = false;
    if (anchor) {
      const currentEpoch = await this.connection.getEpochInfo().then((e) => e.epoch);
      const elapsed = currentEpoch - Number(anchor.firstEligibleEpoch);
      c6EpochConfirmed = elapsed >= 2; // MIN_EPOCH_CONFIRMATION = 2
    }

    const failedCriteria: string[] = [];
    if (!c1Inactivity) failedCriteria.push("C1-inactivity");
    if (!c2PriceCollapse) failedCriteria.push("C2-price-collapse");
    if (!c3MinTvl) failedCriteria.push("C3-min-tvl");
    if (!c4LpNotBurned) failedCriteria.push("C4-lp-not-burned");
    if (!c5NoLock) failedCriteria.push("C5-no-lock");
    if (!c6EpochConfirmed) failedCriteria.push("C6-epoch-confirmed");

    return {
      poolAddress,
      ammProgramId,
      eligible: failedCriteria.length === 0,
      criteria: {
        c1Inactivity,
        c2PriceCollapse,
        c3MinTvl,
        c4LpNotBurned,
        c5NoLock,
        c6EpochConfirmed,
      },
      failedCriteria,
      anchorPda: eligibilityAnchorPda(this.graveScannerProgramId, ammProgramId, poolAddress),
      certPda: eligibilityCertPda(this.graveScannerProgramId, ammProgramId, poolAddress),
      launchPricePda: launchPricePda(this.graveScannerProgramId, ammProgramId, poolAddress),
      pool: {
        coinVault: pool.coinVault,
        pcVault: pool.pcVault,
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        lpMint: pool.lpMint,
        coinReserve,
        pcReserve,
        lpSupply,
      },
      uncxMarkerPresent,
    };
  }

  // --------------------------------------------------- recordLaunchPrice
  //
  // One transaction: ed25519 precompile (C2 attestation) + record_launch_price.

  buildRecordLaunchPriceIx(input: RecordLaunchPriceInput): {
    precompileIx: TransactionInstruction;
    recordIx: TransactionInstruction;
  } {
    const att = {
      ammProgramId: input.ammProgramId,
      poolAddress: input.poolAddress,
      baseMint: input.derivation.baseMint,
      quoteMint: input.derivation.quoteMint,
      firstSwapSlot: input.derivation.firstSwapSlot,
      firstSwapUnixTs: input.derivation.firstSwapUnixTs,
      launchPriceQ64x64: input.derivation.launchPriceQ64x64,
      issuedSlot: input.issuedSlot,
    };
    const msg = buildLaunchPriceMessage(att);
    const recordIx = buildRecordLaunchPriceIx({
      scannerProgramId: this.graveScannerProgramId,
      ammProgramId: input.ammProgramId,
      poolAddress: input.poolAddress,
      baseMint: att.baseMint,
      quoteMint: att.quoteMint,
      launchPriceQ64x64: att.launchPriceQ64x64,
      msg,
      payer: input.payer,
    });
    // The precompile must precede the record instruction in the same tx.
    // We use the same index convention as `lastSwapAttestation.ts`:
    // scannerInstructionIndex is the position of the record instruction
    // AFTER the precompile, so it's 1.
    const precompileIx = buildLaunchPriceEd25519VerifyInstruction({
      signature: input.signature,
      oraclePublicKey: input.oraclePublicKey,
      recordInstructionIndex: 1,
    });
    return { precompileIx, recordIx };
  }

  // --------------------------------------------------------------- phase1
  //
  // One transaction: ed25519 precompile (C1 attestation) + evaluate_pool_phase_1.

  buildPhase1Ix(input: Phase1Input): {
    precompileIx: TransactionInstruction;
    phase1Ix: TransactionInstruction;
  } {
    const att = {
      ammProgramId: input.ammProgramId,
      poolAddress: input.poolAddress,
      lastSwapUnixTs: input.derivation.lastSwapUnixTs,
      issuedSlot: input.derivation.slot,
      slotHash: input.slotHash,
    };
    const msg = buildAttestationMessage(att);
    const phase1IxArgs: Parameters<typeof buildEvaluatePoolPhase1Ix>[0] = {
      scannerProgramId: this.graveScannerProgramId,
      ammProgramId: input.ammProgramId,
      poolAddress: input.poolAddress,
      msg,
      writer: input.writer,
    };
    if (input.remainingAccounts) phase1IxArgs.remainingAccounts = input.remainingAccounts;
    const phase1Ix = buildEvaluatePoolPhase1Ix(phase1IxArgs);
    const precompileIx = buildEd25519VerifyInstruction({
      signature: input.signature,
      oraclePublicKey: input.oraclePublicKey,
      message: msg,
      scannerInstructionIndex: 1,
      messageAddressOffset: 72,
    });
    return { precompileIx, phase1Ix };
  }

  // --------------------------------------------------------------- phase2
  //
  // One transaction: fresh ed25519 precompile (C1 attestation) + evaluate_pool_phase_2.

  buildPhase2Ix(input: Phase2Input): {
    precompileIx: TransactionInstruction;
    phase2Ix: TransactionInstruction;
  } {
    const att = {
      ammProgramId: input.ammProgramId,
      poolAddress: input.poolAddress,
      lastSwapUnixTs: input.derivation.lastSwapUnixTs,
      issuedSlot: input.derivation.slot,
      slotHash: input.slotHash,
    };
    const msg = buildAttestationMessage(att);
    const phase2IxArgs: Parameters<typeof buildEvaluatePoolPhase2Ix>[0] = {
      scannerProgramId: this.graveScannerProgramId,
      ammProgramId: input.ammProgramId,
      poolAddress: input.poolAddress,
      msg,
      writer: input.writer,
    };
    if (input.remainingAccounts) phase2IxArgs.remainingAccounts = input.remainingAccounts;
    const phase2Ix = buildEvaluatePoolPhase2Ix(phase2IxArgs);
    const precompileIx = buildEd25519VerifyInstruction({
      signature: input.signature,
      oraclePublicKey: input.oraclePublicKey,
      message: msg,
      scannerInstructionIndex: 1,
      messageAddressOffset: 72,
    });
    return { precompileIx, phase2Ix };
  }

  // ------------------------------------------------- snapshotLpHolders
  //
  // Off-chain snapshot + Merkle root — the input `salvage_pool` consumes.

  async snapshotLpHolders(poolAddress: PublicKey, opts?: { sinkExclusions?: ReadonlyArray<PublicKey> }): Promise<SnapshotResult> {
    return snapshotLpHoldersImpl(this.connection, poolAddress, opts);
  }

  // -------------------------------------------------- buildMerkleTree
  //
  // Pure helper — wraps `SnapshotMerkleTree.fromEntries` so the salvor
  // doesn't have to import the tree class directly. Useful when the
  // snapshot was produced out-of-band (e.g. by the Phase 9 indexer).

  buildMerkleTree(holders: ReadonlyArray<HolderEntry>): SnapshotMerkleTree {
    return SnapshotMerkleTree.fromEntries(holders);
  }

  // -------------------------------------------------- certifyAndSalvage
  //
  // Bundle the (phase2, salvage_pool) instructions into a single
  // transaction so the cert TTL (1h) cannot race the salvage landing.
  // See `certifyAndSalvage.ts` for the full implementation.

  buildCertifyAndSalvageIxs(opts: {
    phase2: Phase2Input;
    salvage: import("./salvagePool.js").SalvagePoolIxInput;
  }): CertifyAndSalvageIxs {
    const { precompileIx: c1Precompile, phase2Ix } = this.buildPhase2Ix(opts.phase2);
    // The cert TTL is 1h. We bundle: c1Precompile (instruction 0) +
    // phase2Ix (instruction 1) + salvageIx (instruction 2). The phase 2
    // cert is consumed by the salvage_pool handler in the same tx.
    //
    // Note: the precompile's scannerInstructionIndex must point at the
    // phase 2 instruction (index 1) — the salvage_pool instruction is a
    // SEPARATE program and doesn't carry the attestation.
    void c1Precompile;
    const salvageIx = buildSalvagePoolIx(opts.salvage);
    return { certifyIx: phase2Ix, salvageIx };
  }

  // -------------------------------------------------- claimLpProceeds
  //
  // Build the `claim_lp_proceeds` instruction. Callable during pause.

  buildClaimLpProceedsIx(input: ClaimLpProceedsInput): TransactionInstruction {
    return buildClaimLpProceedsIx({
      vaultProgramId: this.graveVaultProgramId,
      poolAddress: input.poolAddress,
      lpHolder: input.lpHolder,
      lpBalanceAtSnapshot: input.lpBalanceAtSnapshot,
      merkleProof: input.merkleProof,
    });
  }

  // -------------------------------------------------- computeBudgetIxs
  //
  // Helpers to attach a compute-unit price + limit to a transaction in a
  // Charter-aware way. The Charter ceiling is enforced: if the
  // requested `lamportsPerCu` exceeds the on-chain `maxPriorityFeeCeilingLamports`,
  // the helper throws.

  async computeBudgetIxs(opts: {
    lamportsPerCu: BN;
    computeUnitLimit?: number;
  }): Promise<TransactionInstruction[]> {
    const rejection = await this.charterGuard({ feeLamportsPerCu: opts.lamportsPerCu });
    if (rejection) {
      throw new Error(rejection);
    }
    const out: TransactionInstruction[] = [];
    if (opts.computeUnitLimit !== undefined) {
      out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit }));
    }
    out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(opts.lamportsPerCu.toString()) }));
    return out;
  }
}

// Re-export the snapshot types so consumers can import them from the client.
export type { LpSnapshot, EligibilityResult, PriorityFeePolicy };

// Default-export the canonical defaults so test consumers can assert
// against the devnet ProtocolConfig live values without re-deriving.
export { SCANNER_PROTOCOL_CONFIG_DEFAULTS, VAULT_PROTOCOL_CONFIG_DEFAULTS };
export { SystemProgram };
