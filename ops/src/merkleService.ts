// SPDX-License-Identifier: Apache-2.0
//
// Merkle snapshot service — the Phase 11 "Merkle service running" row.
//
// Wraps the SDK's `snapshotLpHolders` + `SnapshotMerkleTree` into a
// scheduled service that produces DETERMINISTIC, SELF-VERIFYING snapshot
// artifacts:
//
//   artifact = {
//     schema, pool, lpMint, snapshotSlot, totalSupply, holderCount,
//     rootHex, holders[], exclusions[], uncxMarkerPresent, builtAtTs,
//     integrity   // sha256 over the canonical serialization of everything above
//   }
//
// Determinism contract (mirrors the Rust snapshotter + on-chain verifier):
//   * holders are sorted by ascending owner pubkey BYTES;
//   * rebuilding the tree from the artifact's holder list must reproduce
//     `rootHex` (verified on every build AND on every load);
//   * the integrity hash pins the whole artifact — a tampered file is
//     rejected at load, fail-closed.
//
// The service is dry-run by default: `runOnce()` for a pool builds the
// artifact and returns it; persisting requires an explicit ArtifactStore.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PublicKey } from "@solana/web3.js";
import {
  snapshotLpHolders,
  SnapshotMerkleTree,
  verifyMerkleProof,
  type SnapshotResult,
} from "@graveyield/sdk";

import type { AlertManager } from "./alerts.js";
import type { HealthRegistry } from "./health.js";

/** Artifact schema version (bump on any breaking field change). */
export const MERKLE_ARTIFACT_SCHEMA = 1;

/** One artifact holder row (base58 owner + decimal balance). */
export interface ArtifactHolder {
  owner: string;
  /** Balance in raw LP token units (decimal string — u64-safe). */
  lpBalance: string;
}

/** The persisted snapshot artifact. */
export interface MerkleArtifact {
  schema: number;
  pool: string;
  lpMint: string;
  snapshotSlot: number;
  /** Total LP supply at snapshot (decimal string). */
  totalSupply: string;
  holderCount: number;
  /** Merkle root, hex. */
  rootHex: string;
  holders: ArtifactHolder[];
  exclusions: Array<{ owner: string; lpBalance: string; reason: "zero" | "sink" }>;
  /** LOCKER-002 off-chain flag: UNCX marker PDA present at snapshot time. */
  uncxMarkerPresent: boolean;
  builtAtTs: number;
  /** sha256 over the canonical serialization of every field above. */
  integrity: string;
}

/** Where artifacts are persisted. `DirectoryArtifactStore` is the stock impl. */
export interface ArtifactStore {
  save(artifact: MerkleArtifact): Promise<void>;
  load(pool: string, snapshotSlot: number): Promise<MerkleArtifact | null>;
}

/** Filesystem store: `<root>/<pool>-<slot>.json`. */
export class DirectoryArtifactStore implements ArtifactStore {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
  }

  async save(artifact: MerkleArtifact): Promise<void> {
    writeFileSync(this.pathFor(artifact.pool, artifact.snapshotSlot), `${JSON.stringify(artifact, null, 2)}\n`);
  }

  async load(pool: string, snapshotSlot: number): Promise<MerkleArtifact | null> {
    const path = this.pathFor(pool, snapshotSlot);
    try {
      return JSON.parse(readFileSync(path, "utf8")) as MerkleArtifact;
    } catch {
      return null;
    }
  }

  private pathFor(pool: string, snapshotSlot: number): string {
    return join(this.rootDir, `${pool}-${snapshotSlot}.json`);
  }
}

/** Service options. */
export interface MerkleServiceOptions {
  health: HealthRegistry;
  alerts: AlertManager;
  /** Optional persistence; absent = build-only (dry-run). */
  store?: ArtifactStore;
  /** Rebuild + compare cycle budget guard (ms) — informational only. */
  pollIntervalMs?: number;
}

/**
 * The Merkle snapshot service. The Connection-taking live path is
 * `buildForPool`; the deterministic artifact machinery (`buildArtifact`,
 * `verifyArtifact`, canonical hashing) is fully offline-testable.
 */
export class MerkleService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: MerkleServiceOptions) {
    const poll = opts.pollIntervalMs ?? 300_000;
    this.opts.health.register("merkle", 3 * poll);
  }

  /**
   * Build (and optionally persist) the artifact for one pool at the live
   * chain state. Uses the SDK's snapshot machinery — the byte-locked
   * TS port of the Rust snapshotter.
   */
  async buildForPool(
    connection: Parameters<typeof snapshotLpHolders>[0],
    pool: PublicKey,
    sinkExclusions?: ReadonlyArray<PublicKey>,
  ): Promise<MerkleArtifact> {
    const snapshotOpts: Parameters<typeof snapshotLpHolders>[2] = {};
    if (sinkExclusions !== undefined) snapshotOpts.sinkExclusions = sinkExclusions;
    const result = await snapshotLpHolders(connection, pool, snapshotOpts);
    const artifact = buildArtifact(pool, result);
    verifyArtifactInternally(artifact);
    this.opts.health.counter("merkle.snapshots-built");
    if (result.uncxMarkerPresent) {
      this.opts.alerts.raise("uncx-marker-present", "warn",
        "UNCX marker PDA present at snapshot time — LOCKER-002 cross-check required before claims",
        { pool: pool.toBase58() });
    }
    if (this.opts.store) {
      await this.opts.store.save(artifact);
      this.opts.health.counter("merkle.artifacts-persisted");
    }
    this.opts.health.heartbeat(
      "merkle",
      "ok",
      `pool=${pool.toBase58()} slot=${artifact.snapshotSlot} holders=${artifact.holderCount} root=${artifact.rootHex.slice(0, 16)}…`,
    );
    return artifact;
  }

  /** Load a stored artifact and fail closed on any tampering. */
  async loadVerified(pool: string, snapshotSlot: number): Promise<MerkleArtifact | null> {
    if (!this.opts.store) return null;
    const artifact = await this.opts.store.load(pool, snapshotSlot);
    if (!artifact) return null;
    verifyArtifactInternally(artifact);
    return artifact;
  }

  /** Run every `intervalMs` for `pools` (pass pool list from the scenario/CLI). */
  start(pools: ReadonlyArray<PublicKey>, connection: Parameters<typeof snapshotLpHolders>[0], intervalMs: number): () => void {
    if (this.timer) return () => this.stop();
    const tick = (): void => {
      for (const pool of pools) {
        this.buildForPool(connection, pool).catch((error: unknown) => {
          this.opts.health.counter("merkle.failures");
          this.opts.health.heartbeat(
            "merkle",
            "degraded",
            `snapshot failed for ${pool.toBase58()}: ${error instanceof Error ? error.message : String(error)}`,
          );
          this.opts.alerts.raise("merkle-snapshot-failed", "warn",
            "Merkle snapshot build failed",
            { pool: pool.toBase58(), error: error instanceof Error ? error.message : String(error) });
        });
      }
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

/**
 * Build the deterministic artifact from a SnapshotResult.
 *
 * The holders are taken from the snapshot's canonical entry order
 * (ascending owner bytes — enforced by SnapshotMerkleTree), which is
 * exactly what makes rebuild-verification meaningful.
 */
export function buildArtifact(pool: PublicKey, result: SnapshotResult): MerkleArtifact {
  const holders: ArtifactHolder[] = result.snapshot.holders.map((holder) => ({
    owner: holder.holder.toBase58(),
    lpBalance: holder.balance.toString(10),
  }));
  const artifact: Omit<MerkleArtifact, "integrity"> = {
    schema: MERKLE_ARTIFACT_SCHEMA,
    pool: pool.toBase58(),
    lpMint: result.snapshot.lpMint.toBase58(),
    snapshotSlot: result.snapshotSlot,
    totalSupply: result.snapshot.totalSupply.toString(10),
    holderCount: holders.length,
    rootHex: Buffer.from(result.tree.root()).toString("hex"),
    holders,
    exclusions: result.exclusions.map((exclusion) => ({
      owner: exclusion.holder.toBase58(),
      lpBalance: exclusion.balance.toString(10),
      reason: exclusion.reason,
    })),
    uncxMarkerPresent: result.uncxMarkerPresent,
    builtAtTs: Math.floor(Date.now() / 1000),
  };
  return { ...artifact, integrity: artifactIntegrity(artifact) };
}

/**
 * Canonical integrity hash: sha256 over a fixed-order serialization.
 * (Manual canonical form rather than JSON.stringify key-order luck.)
 */
export function artifactIntegrity(artifact: Omit<MerkleArtifact, "integrity">): string {
  const canonical = [
    `schema=${artifact.schema}`,
    `pool=${artifact.pool}`,
    `lpMint=${artifact.lpMint}`,
    `slot=${artifact.snapshotSlot}`,
    `totalSupply=${artifact.totalSupply}`,
    `holderCount=${artifact.holderCount}`,
    `root=${artifact.rootHex}`,
    `holders=${artifact.holders.map((h) => `${h.owner}:${h.lpBalance}`).join(",")}`,
    `exclusions=${artifact.exclusions.map((e) => `${e.owner}:${e.lpBalance}:${e.reason}`).join(",")}`,
    `uncx=${artifact.uncxMarkerPresent}`,
    `builtAt=${artifact.builtAtTs}`,
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Verify a stored artifact fail-closed:
 *   1. the integrity hash matches the canonical re-computation;
 *   2. rebuilding the tree from the holder rows reproduces the root;
 *   3. a sampled holder's proof verifies against the root (when ≥1 holder).
 * Throws on any mismatch — a tampered artifact must never reach a claim flow.
 */
export function verifyArtifactInternally(artifact: MerkleArtifact): void {
  const { integrity, ...rest } = artifact;
  if (artifactIntegrity(rest) !== integrity) {
    throw new Error(`merkle artifact integrity mismatch for pool ${artifact.pool} slot ${artifact.snapshotSlot}`);
  }
  const entries = artifact.holders.map((holder) => ({
    owner: new PublicKey(holder.owner),
    lpBalance: BigInt(holder.lpBalance),
  }));
  const rebuilt = SnapshotMerkleTree.fromEntries(entries);
  const rebuiltRootHex = Buffer.from(rebuilt.root()).toString("hex");
  if (rebuiltRootHex !== artifact.rootHex) {
    throw new Error(`merkle artifact root mismatch for pool ${artifact.pool}: stored ${artifact.rootHex} rebuilt ${rebuiltRootHex}`);
  }
  const leaf = rebuilt.leaf(0);
  const proof = rebuilt.proof(0);
  if (leaf && proof && !verifyMerkleProof(rebuilt.root(), leaf, proof)) {
    throw new Error(`merkle artifact proof verification failed for pool ${artifact.pool}`);
  }
}
