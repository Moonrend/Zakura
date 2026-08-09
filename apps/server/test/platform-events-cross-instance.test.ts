/**
 * 平台事件跨实例扇出（Redis Pub/Sub）。
 *
 * 用两个独立的 bus 实例模拟两个 API 副本：在 A 上 publish，
 * 断言连在 B 上的订阅者能收到 —— 这是「多副本平台事件」缺口的守门测试。
 *
 * 需要本机可用的 Redis；REDIS_URL=off 时整组跳过。
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { PlatformEventBus, type PlatformEvent } from "../src/services/platform-events.js";
import { closeRedis, isRedisEnabled } from "../src/services/redis.js";

const enabled = isRedisEnabled();

/** 等待条件成立，最长 timeout 毫秒 */
async function waitFor(cond: () => boolean, timeout = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

const buses: PlatformEventBus[] = [];
function makeBus(): PlatformEventBus {
  const b = new PlatformEventBus();
  buses.push(b);
  return b;
}

after(async () => {
  for (const b of buses) await b.close();
  await closeRedis();
});

describe("platform events 跨实例扇出", { skip: !enabled ? "REDIS_URL=off" : false }, () => {
  it("A 上 publish，B 上的订阅者能收到", async () => {
    const a = makeBus();
    const b = makeBus();
    const tenant = `t-cross-${Date.now()}`;

    const got: PlatformEvent[] = [];
    b.subscribe(tenant, (ev) => got.push(ev));
    // 等 B 的 Redis 订阅真正建立
    await new Promise((r) => setTimeout(r, 300));

    a.publish(tenant, { type: "runner_node", nodeId: "n-cross" });

    assert.ok(await waitFor(() => got.length > 0), "B 未收到来自 A 的事件");
    assert.equal(got[0]!.type, "runner_node");
    assert.equal(typeof got[0]!.ts, "number");
  });

  it("发布方本地无订阅者时事件依然跨实例送达", async () => {
    // 这正是旧实现的缺陷点：publish 曾在本地无监听者时直接 return
    const a = makeBus();
    const b = makeBus();
    const tenant = `t-nolocal-${Date.now()}`;

    const got: PlatformEvent[] = [];
    b.subscribe(tenant, (ev) => got.push(ev));
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(a.hasListeners(tenant), false, "A 本地不应有订阅者");
    a.publish(tenant, { type: "runner_node", nodeId: "n-nolocal" });

    assert.ok(await waitFor(() => got.length > 0), "本地无订阅者时事件被吞掉了");
  });

  it("租户隔离：其它租户收不到", async () => {
    const a = makeBus();
    const b = makeBus();
    const mine = `t-mine-${Date.now()}`;
    const other = `t-other-${Date.now()}`;

    const got: PlatformEvent[] = [];
    b.subscribe(other, (ev) => got.push(ev));
    await new Promise((r) => setTimeout(r, 300));

    a.publish(mine, { type: "runner_node", nodeId: "n-iso" });
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(got.length, 0, "跨租户泄漏");
  });

  it("publishAll 广播到其它实例的所有租户", async () => {
    const a = makeBus();
    const b = makeBus();
    const t1 = `t-all1-${Date.now()}`;
    const t2 = `t-all2-${Date.now()}`;

    const g1: PlatformEvent[] = [];
    const g2: PlatformEvent[] = [];
    b.subscribe(t1, (ev) => g1.push(ev));
    b.subscribe(t2, (ev) => g2.push(ev));
    await new Promise((r) => setTimeout(r, 300));

    a.publishAll({
      type: "platform_service_progress",
      serviceKey: "svc",
      snapshot: { serviceKey: "svc", phase: "p", percent: 1 } as never,
    });

    assert.ok(await waitFor(() => g1.length > 0 && g2.length > 0), "publishAll 未跨实例广播");
  });

  it("不回环：发布方自己的订阅者只收到一次", async () => {
    const a = makeBus();
    const tenant = `t-loop-${Date.now()}`;

    const got: PlatformEvent[] = [];
    a.subscribe(tenant, (ev) => got.push(ev));
    await new Promise((r) => setTimeout(r, 300));

    a.publish(tenant, { type: "runner_node", nodeId: "n-loop" });
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(got.length, 1, `本地 emit 与 Redis 回环重复投递，实际 ${got.length} 次`);
  });
});
