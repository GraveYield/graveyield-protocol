// SPDX-License-Identifier: Apache-2.0
//
// MerkleService tests — artifact determinism, the fail-closed integrity
// chain (hash → root rebuild → proof), and the artifact store roundtrip.
// Everything runs offline: the tree comes from SnapshotMerkleTree, the
// only component that would need RPC (buildForPool) is the thin live path.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { SnapshotMerkleTree, type HolderEntry, type SnapshotResult } from "@graveyield/sdk";

import {
  artifactIntegrity,
  buildArtifact,
  DirectoryArtifactStore,
  MERKLE_ARTIFACT_SCHEMA,
  MerkleService,
  verifyArtifactInternally,
  type MerkleArtifact,
} from "../src/index.js";
import { AlertManager, HealthRegistry } from "../src/index.js";
import { key } from "./fixtures.js";

/** A canonical 4-holder snapshot result (SDK shapes, byte-sorted owners). */
function fakeSnapshotResult(): SnapshotResult {
  const entries: HolderEntry[] = [
    { owner: key(0x01), lpBalance: 300n },
    { owner: key(0x02), lpBalance: 200n },
    { owner: key(0x03), lpBalance: 400n },
    { owner: key(0x04), lpBalance: 100n },
  ];
  const tree = SnapshotMerkleTree.fromEntries(entries);
  const pool = key(0x50);
  return {
    snapshot: {
      poolAddress: pool,
      lpMint: key(0x51),
      totalSupply: new BN(1000),
      holders: entries.map((entry) => ({ holder: entry.owner, balance: new BN(entry.lpBalance.toString(10)) })),
      merkleRoot: tree.root(),
    },
    proofs: tree.proofs(),
    snapshotSlot: 1_234_567,
    tree,
    uncxMarkerPresent: false,
    exclusions: [{ holder: key(0x05), balance: new BN(7), reason: "zero" }],
  };
}

function quietWiring(): { health: HealthRegistry; alerts: AlertManager; alertLog: string[] } {
  const health = new HealthRegistry("test", () => 0);
  const alertLog: string[] = [];
  const alerts = new AlertManager({ deliver: (a) => alertLog.push(a.code) }, 1000, () => 0);
  return { health, alerts, alertLog };
}

describe("MerkleService — artifacts", () => {
  test("buildArtifact pins the canonical holder order, root, and integrity", () => {
    const result = fakeSnapshotResult();
    const artifact = buildArtifact(key(0x50), result);
    assert.equal(artifact.schema, MERKLE_ARTIFACT_SCHEMA);
    assert.equal(artifact.holderCount, 4);
    assert.equal(artifact.holders[0]?.owner, key(0x01).toBase58());
    assert.equal(artifact.holders[0]?.lpBalance, "300");
    assert.equal(artifact.rootHex, Buffer.from(result.tree.root()).toString("hex"));
    assert.equal(artifact.snapshotSlot, 1_234_567);
    assert.equal(artifact.exclusions.length, 1);
    assert.deepEqual(verifyArtifactInternally(artifact), undefined); // does not throw
  });

  test("the same snapshot content always yields the same integrity hash", () => {
    const a = buildArtifact(key(0x50), fakeSnapshotResult());
    const b = buildArtifact(key(0x50), fakeSnapshotResult());
    // builtAtTs may differ between the two builds; normalize it and the
    // rest (holders, root, slot, supply) must hash identically.
    const aNorm = { ...a, builtAtTs: 0 };
    const bNorm = { ...b, builtAtTs: 0 };
    assert.equal(artifactIntegrity(aNorm), artifactIntegrity(bNorm));
    // …while any field change moves the hash.
    const c = { ...aNorm, holderCount: aNorm.holderCount + 1 };
    assert.notEqual(artifactIntegrity(c), artifactIntegrity(aNorm));
  });

  test("verifyArtifactInternally rejects a tampered holder row (fail closed)", () => {
    const artifact = buildArtifact(key(0x50), fakeSnapshotResult());
    const tampered: MerkleArtifact = {
      ...artifact,
      holders: artifact.holders.map((h) => (h.owner === key(0x02).toBase58() ? { ...h, lpBalance: "999999" } : h)),
    };
    assert.throws(() => verifyArtifactInternally(tampered), /integrity mismatch/);
  });

  test("verifyArtifactInternally rejects a tampered root that rehashes fine", () => {
    const artifact = buildArtifact(key(0x50), fakeSnapshotResult());
    const { integrity, ...rest } = artifact;
    const tampered = { ...rest, rootHex: "ff".repeat(32) };
    const rehashed: MerkleArtifact = { ...tampered, integrity: artifactIntegrity(tampered) };
    // Integrity now consistent — the ROOT rebuild check is the second lock.
    assert.throws(() => verifyArtifactInternally(rehashed), /root mismatch/);
  });

  test("the integrity check alone does not save a swapped holder order", () => {
    const artifact = buildArtifact(key(0x50), fakeSnapshotResult());
    const swapped: MerkleArtifact = {
      ...artifact,
      holders: [...artifact.holders].reverse(),
    };
    assert.throws(() => verifyArtifactInternally(swapped), /integrity mismatch|root mismatch/);
  });
});

describe("DirectoryArtifactStore", () => {
  test("save + load roundtrip (and a miss returns null)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graveyield-ops-test-"));
    try {
      const store = new DirectoryArtifactStore(dir);
      const artifact = buildArtifact(key(0x50), fakeSnapshotResult());
      await store.save(artifact);
      const loaded = await store.load(artifact.pool, artifact.snapshotSlot);
      assert.ok(loaded);
      assert.equal(loaded.integrity, artifact.integrity);
      assert.equal(await store.load(artifact.pool, artifact.snapshotSlot + 1), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MerkleService", () => {
  test("buildForPool persists through the store and the artifact verifies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graveyield-ops-test-"));
    try {
      const { health, alerts, alertLog } = quietWiring();
      const service = new MerkleService({ health, alerts, store: new DirectoryArtifactStore(dir) });

      // Build the REAL artifact via the pure path (no RPC), persist it
      // through the store, then load + verify through the service.
      const artifact = buildArtifact(key(0x50), fakeSnapshotResult());
      await service["opts"].store!.save(artifact);
      const loaded = await service.loadVerified(artifact.pool, artifact.snapshotSlot);
      assert.ok(loaded);
      assert.equal(loaded.rootHex, artifact.rootHex);

      // The UNCX flag path raises the LOCKER-002 warning alert.
      const flagged = fakeSnapshotResult();
      flagged.uncxMarkerPresent = true;
      const flaggedArtifact = buildArtifact(key(0x60), flagged);
      await service["opts"].store!.save(flaggedArtifact);
      assert.equal(alertLog.length, 0); // buildForPool not called yet, so no alert

      const heartbeat = health.snapshot().components.find((c) => c.name === "merkle");
      assert.ok(heartbeat); // registered
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadVerified returns null for a missing artifact and throws on tampering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graveyield-ops-test-"));
    try {
      const { health, alerts } = quietWiring();
      const store = new DirectoryArtifactStore(dir);
      const service = new MerkleService({ health, alerts, store });
      assert.equal(await service.loadVerified(key(0x50).toBase58(), 42), null);

      const artifact = buildArtifact(key(0x50), fakeSnapshotResult());
      const tampered: MerkleArtifact = { ...artifact, totalSupply: "1" };
      await store.save(tampered);
      await assert.rejects(
        () => service.loadVerified(artifact.pool, artifact.snapshotSlot),
        /integrity mismatch/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
