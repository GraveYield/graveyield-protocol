// SPDX-License-Identifier: Apache-2.0
//
// AlertManager + sinks tests — dedup windows, suppressed delivery, sink
// isolation (a throwing/failing sink must never break the raiser), and
// the injectable-fetch webhook sink.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AlertManager,
  composeAlertSinks,
  ConsoleAlertSink,
  JsonlAlertSink,
  WebhookAlertSink,
  type Alert,
  type AlertSink,
} from "../src/index.js";

function collectingSink(): { sink: AlertSink; alerts: Alert[] } {
  const alerts: Alert[] = [];
  return { sink: { deliver: (alert) => alerts.push(alert) }, alerts };
}

describe("AlertManager", () => {
  test("first raise is delivered unsuppressed", () => {
    let now = 1_000;
    const { sink, alerts } = collectingSink();
    const manager = new AlertManager(sink, 30 * 60 * 1000, () => now);
    const raised = manager.raise("receipt-sum-mismatch", "critical", "bad math", { total: "3" });
    assert.equal(raised.suppressed, false);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.code, "receipt-sum-mismatch");
    assert.equal(alerts[0]?.severity, "critical");
  });

  test("same code inside the dedup window is delivered suppressed and counted", () => {
    let now = 1_000;
    const { sink, alerts } = collectingSink();
    const manager = new AlertManager(sink, 30 * 60 * 1000, () => now);
    manager.raise("code-a", "warn", "first");
    now += 10_000;
    const second = manager.raise("code-a", "warn", "second");
    assert.equal(second.suppressed, true);
    assert.equal(alerts.length, 2);
    assert.equal(manager.raiseCount("code-a"), 2);
  });

  test("same code after the dedup window fires unsuppressed again", () => {
    let now = 1_000;
    const { sink, alerts } = collectingSink();
    const manager = new AlertManager(sink, 30 * 60 * 1000, () => now);
    manager.raise("code-a", "warn", "first");
    now += 30 * 60 * 1000 + 1;
    const second = manager.raise("code-a", "warn", "second");
    assert.equal(second.suppressed, false);
    assert.equal(alerts.length, 2);
  });

  test("different codes do not suppress each other", () => {
    const { sink, alerts } = collectingSink();
    let now = 1_000;
    const manager = new AlertManager(sink, 30 * 60 * 1000, () => now);
    manager.raise("code-a", "warn", "a");
    manager.raise("code-b", "warn", "b");
    assert.equal(alerts.length, 2);
    assert.ok(alerts.every((a) => !a.suppressed));
  });

  test("a throwing sink never breaks the raiser", () => {
    const broken: AlertSink = {
      deliver: () => {
        throw new Error("sink exploded");
      },
    };
    const manager = new AlertManager(broken, 1000, () => 0);
    const raised = manager.raise("code-a", "info", "still delivered");
    assert.ok(raised);
    assert.equal(manager.raiseCount("code-a"), 1);
  });

  test("a rejecting async sink never breaks the raiser", async () => {
    const broken: AlertSink = {
      deliver: async () => {
        throw new Error("async sink exploded");
      },
    };
    const manager = new AlertManager(broken, 1000, () => 0);
    manager.raise("code-a", "info", "still delivered");
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the rejection land
    assert.equal(manager.raiseCount("code-a"), 1);
  });
});

describe("sinks", () => {
  test("ConsoleAlertSink writes one formatted line to stderr", () => {
    const lines: string[] = [];
    const sink = new ConsoleAlertSink((line) => lines.push(line));
    sink.deliver({
      code: "vault-tx-failed",
      severity: "warn",
      message: "tx failed",
      atMs: 1,
      context: { signature: "abc" },
      suppressed: false,
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /^\[ALERT:warn\] vault-tx-failed — tx failed/);
    assert.match(lines[0] ?? "", /"signature":"abc"/);
  });

  test("JsonlAlertSink appends valid JSON lines and survives a broken appender", () => {
    const written: string[] = [];
    const sink = new JsonlAlertSink((line) => {
      if (written.length === 0) {
        written.push(line);
        return;
      }
      throw new Error("disk full");
    });
    sink.deliver({ code: "a", severity: "info", message: "one", atMs: 1, context: {}, suppressed: false });
    sink.deliver({ code: "b", severity: "info", message: "two", atMs: 2, context: {}, suppressed: true });
    assert.equal(written.length, 1);
    const parsed = JSON.parse(written[0] ?? "{}") as Alert;
    assert.equal(parsed.code, "a");
    assert.equal(sink.deliveredLines().length, 2); // the second was captured in-memory
  });

  test("WebhookAlertSink posts JSON and records failures without throwing", async () => {
    const posts: Array<{ url: string; init: RequestInit }> = [];
    const sink = new WebhookAlertSink("https://hooks.example/graveyield", async (url, init) => {
      posts.push({ url, init: init ?? {} });
      return new Response(null, { status: 200 });
    });
    await sink.deliver({ code: "a", severity: "critical", message: "m", atMs: 1, context: {}, suppressed: false });
    assert.equal(sink.lastDeliveryError(), null);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.url, "https://hooks.example/graveyield");

    const failing = new WebhookAlertSink("https://hooks.example/graveyield", async () => {
      throw new Error("DNS is a lie");
    });
    await failing.deliver({ code: "a", severity: "critical", message: "m", atMs: 1, context: {}, suppressed: false });
    assert.equal(failing.lastDeliveryError(), "DNS is a lie");
  });

  test("composeAlertSinks fans out to every sink and isolates throwers", () => {
    const got: string[] = [];
    const good: AlertSink = { deliver: (a) => got.push(a.code) };
    const broken: AlertSink = {
      deliver: () => {
        throw new Error("boom");
      },
    };
    const fanout = composeAlertSinks(broken, good);
    fanout.deliver({
      code: "fanout-test",
      severity: "info",
      message: "m",
      atMs: 0,
      context: {},
      suppressed: false,
    });
    assert.deepEqual(got, ["fanout-test"]);
  });
});
