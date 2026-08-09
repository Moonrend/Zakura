/**
 * 会话级消息队列（服务端权威）+ agent loop steer 注入。
 * REDIS_URL=off：走进程内队列实现；快照广播失败会被吞掉（无真实 DB）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";
import { runAgentLoop } from "../src/services/cloud-agent-runtime.js";
import type { CloudAgentQueuedMessage } from "@zakura/shared";

function withRedisOff<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.REDIS_URL;
  process.env.REDIS_URL = "off";
  return fn().finally(() => {
    if (prev === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev;
  });
}

function item(
  messageId: string,
  content: string,
  mode: "steer" | "queue",
): CloudAgentQueuedMessage {
  return { messageId, content, attachments: [], mode, createdAt: "2026-01-01T00:00:00Z" };
}

describe("session queue (REDIS_URL=off in-memory)", () => {
  it("keeps FIFO across enqueue/update/remove/take", async () => {
    await withRedisOff(async () => {
      const store = new CloudAgentSessionStore({} as never);
      await store.enqueueQueued("s1", item("m1", "a", "steer"));
      await store.enqueueQueued("s1", item("m2", "b", "queue"));
      await store.enqueueQueued("s1", item("m3", "c", "steer"));
      assert.deepEqual(
        (await store.listQueued("s1")).map((i) => i.messageId),
        ["m1", "m2", "m3"],
      );

      await store.updateQueued("s1", "m2", { content: "b2" });
      assert.equal((await store.listQueued("s1"))[1]!.content, "b2");

      const removed = await store.removeQueued("s1", "m1");
      assert.equal(removed?.messageId, "m1");

      const head = await store.takeNextQueued("s1");
      assert.equal(head?.messageId, "m2");
      assert.deepEqual(
        (await store.listQueued("s1")).map((i) => i.messageId),
        ["m3"],
      );
    });
  });

  it("drainSteerQueued only takes steer items and keeps queue items", async () => {
    await withRedisOff(async () => {
      const store = new CloudAgentSessionStore({} as never);
      await store.enqueueQueued("s2", item("m1", "注入1", "steer"));
      await store.enqueueQueued("s2", item("m2", "排队1", "queue"));
      await store.enqueueQueued("s2", item("m3", "注入2", "steer"));
      const steers = await store.drainSteerQueued("s2");
      assert.deepEqual(
        steers.map((i) => i.messageId),
        ["m1", "m3"],
      );
      assert.deepEqual(
        (await store.listQueued("s2")).map((i) => i.messageId),
        ["m2"],
      );
      // 再次 drain 为空且不重复
      assert.deepEqual(await store.drainSteerQueued("s2"), []);
    });
  });

  it("promoteQueued moves item to head with interrupt flag", async () => {
    await withRedisOff(async () => {
      const store = new CloudAgentSessionStore({} as never);
      await store.enqueueQueued("s3", item("m1", "a", "queue"));
      await store.enqueueQueued("s3", item("m2", "b", "queue"));
      const promoted = await store.promoteQueued("s3", "m2");
      assert.equal(promoted?.interrupt, true);
      const list = await store.listQueued("s3");
      assert.deepEqual(
        list.map((i) => i.messageId),
        ["m2", "m1"],
      );
      assert.equal(list[0]!.interrupt, true);
      // requeueFront 放回队头（出队后 startTurn 竞争失败的回滚路径）
      const taken = await store.takeNextQueued("s3");
      await store.requeueFront("s3", taken!);
      assert.equal((await store.listQueued("s3"))[0]!.messageId, "m2");
    });
  });

  it("claimQueuedForImmediate removes only that item into queue-next", async () => {
    await withRedisOff(async () => {
      const store = new CloudAgentSessionStore({} as never);
      await store.enqueueQueued("s4", item("m1", "a", "queue"));
      await store.enqueueQueued("s4", item("m2", "b", "queue"));
      await store.enqueueQueued("s4", item("m3", "c", "steer"));
      const claimed = await store.claimQueuedForImmediate("s4", "m2");
      assert.equal(claimed?.messageId, "m2");
      assert.equal(claimed?.interrupt, true);
      assert.deepEqual(
        (await store.listQueued("s4")).map((i) => i.messageId),
        ["m1", "m3"],
      );
      const next = await store.takeQueueNext("s4");
      assert.equal(next?.messageId, "m2");
      assert.equal(await store.takeQueueNext("s4"), null);
    });
  });

  it("run cancel listeners fire immediately and mark local flag", async () => {
    await withRedisOff(async () => {
      const store = new CloudAgentSessionStore({} as never);
      let fired = 0;
      const off = store.onRunCancel("run-x", () => {
        fired += 1;
      });
      // 触发本地信号（绕过 DB 校验路径直接测传导）
      (store as unknown as { fireRunCancel: (id: string) => void }).fireRunCancel("run-x");
      assert.equal(fired, 1);
      assert.equal(await store.isCancelRequested("run-x"), true);
      // 已取消后再注册：立即触发
      let late = 0;
      store.onRunCancel("run-x", () => {
        late += 1;
      });
      assert.equal(late, 1);
      off();
    });
  });
});

describe("runAgentLoop steer injection from session queue", () => {
  type FakeEvent = { type: string; runId?: string | null; payload: Record<string, unknown> };

  it("injects steers after a no-tool round and continues the same run", async () => {
    await withRedisOff(async () => {
      const events: FakeEvent[] = [];
      let steerServed = false;
      const store = {
        appendEvent: async (input: FakeEvent) => {
          events.push(input);
          return { ...input, id: `ev-${events.length}`, seq: events.length, createdAt: "" };
        },
        isCancelRequested: async () => false,
        onRunCancel: () => () => {},
        finishRun: async () => {},
        drainSteerQueued: async () => {
          if (steerServed) return [];
          steerServed = true;
          return [item("s1", "补充：别动测试", "steer")];
        },
      };
      const modelInputs: Array<Array<{ role: string; content: string | null }>> = [];
      const modelRouter = {
        chatStream: async (_t: string, messages: unknown[]) => {
          modelInputs.push([...(messages as Array<{ role: string; content: string | null }>)]);
          return {
            content: modelInputs.length === 1 ? "初版方案" : "已按补充调整",
            model: "test",
            routeSlug: "r",
            openai: {},
          };
        },
      };

      const result = await runAgentLoop(
        {
          store: store as never,
          modelRouter: modelRouter as never,
          gateway: {} as never,
        },
        {
          tenantId: "t1",
          agent: { id: "a1" } as never,
          cloud: {},
          sessionId: "sess-1",
          runId: "run-1",
          messages: [{ role: "user", content: "做重构" }],
          definitions: [],
          nameMap: new Map(),
        },
      );

      assert.equal(result.status, "completed");
      assert.equal(result.finalText, "已按补充调整");
      assert.equal(modelInputs.length, 2);
      // 第二轮模型输入包含注入的用户补充
      const second = modelInputs[1]!;
      assert.equal(
        second.some((m) => m.role === "user" && m.content === "补充：别动测试"),
        true,
      );
      // 事件流：user_message 带 steer 标记，且最终 run_end(completed)
      const steerEv = events.find((e) => e.type === "user_message");
      assert.ok(steerEv);
      assert.equal((steerEv!.payload as { steer?: boolean }).steer, true);
      const end = events.find((e) => e.type === "run_end");
      assert.equal((end!.payload as { status?: string }).status, "completed");
    });
  });
});
