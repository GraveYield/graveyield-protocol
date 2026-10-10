// SPDX-License-Identifier: Apache-2.0
//
// HealthRegistry tests — freshness derivation, overall status, counters,
// deterministic rendering. All time is injected; nothing sleeps.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { HealthRegistry } from "../src/index.js";

describe("HealthRegistry", () => {
  test("never-reported components report never-reported and degrade the service", () => {
    let now = 1_000;
    const registry = new HealthRegistry("svc", () => now);
    registry.register("indexer", 60_000);
    const snap = registry.snapshot();
    const indexer = snap.components.find((c) => c.name === "indexer");
    assert.ok(indexer);
    assert.equal(indexer.status, "never-reported");
    assert.equal(snap.status, "degraded");
  });

  test("heartbeat inside the freshness window keeps the reported status", () => {
    let now = 1_000;
    const registry = new HealthRegistry("svc", () => now);
    registry.register("indexer", 60_000);
    registry.heartbeat("indexer", "ok", "cycle 1 done");
    now += 30_000; // inside the 60 s window
    const snap = registry.snapshot();
    const indexer = snap.components.find((c) => c.name === "indexer");
    assert.ok(indexer);
    assert.equal(indexer.status, "ok");
    assert.equal(indexer.ageMs, 30_000);
    assert.equal(snap.status, "ok");
  });

  test("a component past its freshness window reports stale even after ok", () => {
    let now = 1_000;
    const registry = new HealthRegistry("svc", () => now);
    registry.register("merkle", 60_000);
    registry.heartbeat("merkle", "ok", "built");
    now += 60_001;
    const snap = registry.snapshot();
    const merkle = snap.components.find((c) => c.name === "merkle");
    assert.ok(merkle);
    assert.equal(merkle.status, "stale");
    assert.equal(snap.status, "degraded");
  });

  test("down beats stale beats degraded beats ok for overall status", () => {
    let now = 1_000;
    const registry = new HealthRegistry("svc", () => now);
    registry.register("a", 60_000);
    registry.register("b", 60_000);
    registry.register("c", 60_000);
    registry.heartbeat("a", "degraded", "partial");
    registry.heartbeat("b", "ok", "fine");
    registry.heartbeat("c", "down", "broken");
    assert.equal(registry.snapshot().status, "down");

    const registry2 = new HealthRegistry("svc2", () => now);
    registry2.register("a", 60_000);
    registry2.register("b", 60_000);
    registry2.heartbeat("a", "degraded", "partial");
    registry2.heartbeat("b", "ok", "fine");
    assert.equal(registry2.snapshot().status, "degraded");
  });

  test("counters are monotonic and render sorted", () => {
    const registry = new HealthRegistry("svc", () => 0);
    registry.register("x", 60_000);
    registry.counter("zebra");
    registry.counter("zebra");
    registry.counter("alpha", 5);
    registry.counter("alpha", -2); // allowed: delta may be negative for corrections
    const snap = registry.snapshot();
    assert.deepEqual(snap.counters, { alpha: 3, zebra: 2 });
  });

  test("heartbeat for an unregistered component throws (wiring bug = loud)", () => {
    const registry = new HealthRegistry("svc", () => 0);
    assert.throws(() => registry.heartbeat("ghost", "ok", "boo"), /unregistered component/);
  });

  test("re-registration preserves heartbeat history and updates the window", () => {
    let now = 1_000;
    const registry = new HealthRegistry("svc", () => now);
    registry.register("indexer", 60_000);
    registry.heartbeat("indexer", "ok", "cycle 1");
    registry.register("indexer", 5_000); // tighten the window
    now += 6_000;
    const snap = registry.snapshot();
    const indexer = snap.components.find((c) => c.name === "indexer");
    assert.ok(indexer);
    assert.equal(indexer.status, "stale");
  });

  test("snapshot components render in sorted name order (deterministic)", () => {
    const registry = new HealthRegistry("svc", () => 0);
    registry.register("zeta", 1);
    registry.register("alpha", 1);
    registry.register("mid", 1);
    const names = registry.snapshot().components.map((c) => c.name);
    assert.deepEqual(names, ["alpha", "mid", "zeta"]);
  });

  test("render() is stable JSON and summary() is one line", () => {
    let now = 1_000;
    const registry = new HealthRegistry("svc", () => now);
    registry.register("indexer", 60_000);
    registry.heartbeat("indexer", "ok", "cycle");
    now += 10;
    const first = registry.render();
    const second = registry.render();
    assert.equal(first, second);
    assert.ok(registry.summary().startsWith("svc: ok (indexer ok)"));
  });
});
