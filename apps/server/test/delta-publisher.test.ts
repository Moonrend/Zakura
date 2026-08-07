/**
 * DeltaPublisher：首包立即 flush，后续短批。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeltaPublisher } from "../src/services/cloud-agent/loop.js";
import type { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";

describe("DeltaPublisher TTFT", () => {
  it("flushes first chunk immediately", async () => {
    const times: number[] = [];
    const t0 = Date.now();
    const store = {
      appendEvent: async () => {
        times.push(Date.now() - t0);
        return {} as never;
      },
    } as unknown as CloudAgentSessionStore;

    const pub = new DeltaPublisher(store, "s", "r", "m", "reasoning_delta");
    pub.push("思");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(times.length, 1);
    assert.ok(times[0]! < 30, `first flush should be immediate, got ${times[0]}ms`);
    await pub.drain();
  });

  it("batches subsequent small chunks within ~16ms window", async () => {
    let calls = 0;
    const store = {
      appendEvent: async () => {
        calls += 1;
        return {} as never;
      },
    } as unknown as CloudAgentSessionStore;

    const pub = new DeltaPublisher(store, "s", "r", "m");
    pub.push("a"); // immediate
    pub.push("b");
    pub.push("c");
    await new Promise((r) => setTimeout(r, 40));
    await pub.drain();
    // 首包 1 次 + 后续合并至少 1 次
    assert.ok(calls >= 2);
    assert.ok(calls <= 4, `expected coalescing, got ${calls} calls`);
  });
});
