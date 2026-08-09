import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { platformEvents, type PlatformEvent } from "../src/services/platform-events.js";
import { closeRedis } from "../src/services/redis.js";
import {
  beginAgentProgress,
  clearAgentProgress,
  finishAgentProgress,
  logAgentProgress,
} from "../src/services/agent-progress.js";

after(async () => {
  // 订阅会惰性建立 Redis 连接，不关会吊住测试进程
  await platformEvents.close();
  await closeRedis();
});

describe("platformEvents bus", () => {
  it("delivers events only to the tenant's subscribers", () => {
    const a: PlatformEvent[] = [];
    const b: PlatformEvent[] = [];
    const unsubA = platformEvents.subscribe("tenant-a", (ev) => a.push(ev));
    const unsubB = platformEvents.subscribe("tenant-b", (ev) => b.push(ev));

    platformEvents.publish("tenant-a", { type: "runner_node", nodeId: "n1" });
    assert.equal(a.length, 1);
    assert.equal(b.length, 0);
    assert.equal(a[0]!.type, "runner_node");
    assert.equal(typeof a[0]!.ts, "number");

    unsubA();
    platformEvents.publish("tenant-a", { type: "runner_node", nodeId: "n2" });
    assert.equal(a.length, 1);
    unsubB();
  });

  it("survives a throwing listener", () => {
    const got: PlatformEvent[] = [];
    const unsub1 = platformEvents.subscribe("tenant-c", () => {
      throw new Error("boom");
    });
    const unsub2 = platformEvents.subscribe("tenant-c", (ev) => got.push(ev));
    platformEvents.publish("tenant-c", { type: "runner_node", nodeId: "n1" });
    assert.equal(got.length, 1);
    unsub1();
    unsub2();
  });

  it("hasListeners reflects subscription state", () => {
    assert.equal(platformEvents.hasListeners("tenant-d"), false);
    const unsub = platformEvents.subscribe("tenant-d", () => {});
    assert.equal(platformEvents.hasListeners("tenant-d"), true);
    unsub();
    assert.equal(platformEvents.hasListeners("tenant-d"), false);
  });
});

describe("agent progress publishing", () => {
  it("publishes snapshots to the bound tenant across begin/log/finish", () => {
    const events: PlatformEvent[] = [];
    const unsub = platformEvents.subscribe("tenant-p", (ev) => events.push(ev));

    beginAgentProgress("agent-x", "starting", "tenant-p");
    logAgentProgress("agent-x", "pull", "拉取镜像", { percent: 30 });
    finishAgentProgress("agent-x", { ok: true, message: "就绪" });

    const snapshots = events.filter(
      (e): e is Extract<PlatformEvent, { type: "agent_progress" }> =>
        e.type === "agent_progress",
    );
    assert.equal(snapshots.length, 3);
    assert.equal(snapshots[0]!.snapshot.running, true);
    assert.equal(snapshots[1]!.snapshot.percent, 30);
    assert.equal(snapshots[2]!.snapshot.done, true);
    assert.equal(snapshots[2]!.snapshot.percent, 100);

    clearAgentProgress("agent-x");
    unsub();
  });

  it("does not publish when no tenant was bound", () => {
    const events: PlatformEvent[] = [];
    const unsub = platformEvents.subscribe("tenant-q", (ev) => events.push(ev));
    beginAgentProgress("agent-y", "starting");
    logAgentProgress("agent-y", "s", "m");
    assert.equal(events.length, 0);
    clearAgentProgress("agent-y");
    unsub();
  });
});
