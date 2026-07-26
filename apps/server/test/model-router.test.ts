import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  registerBuiltinModelAdapters,
  getModelAdapter,
  resolveAdapterForCapability,
  weightedShuffle,
  orderRoutesForStrategy,
  type ResolvedRoute,
} from "../src/model-router/index.js";

describe("model-router registry", () => {
  registerBuiltinModelAdapters();

  it("registers openai, bailian, anthropic and gemini adapters", () => {
    const openai = getModelAdapter("openai");
    assert.equal(openai.protocol, "openai");
    assert.ok(openai.supportedCapabilities.includes("embedding"));

    const bailian = getModelAdapter("bailian");
    assert.equal(bailian.protocol, "bailian");
    assert.ok(bailian.supportedCapabilities.includes("embedding"));
    assert.ok(bailian.supportedCapabilities.includes("rerank"));
    assert.ok(!bailian.supportedCapabilities.includes("chat"));

    const deepseek = getModelAdapter("deepseek");
    assert.equal(deepseek.protocol, "deepseek");
    assert.ok(deepseek.supportedCapabilities.includes("chat"));

    const anthropic = getModelAdapter("anthropic");
    assert.equal(anthropic.protocol, "anthropic");
    assert.ok(anthropic.supportedCapabilities.includes("chat"));
    assert.ok(!anthropic.supportedCapabilities.includes("embedding"));

    const gemini = getModelAdapter("gemini");
    assert.equal(gemini.protocol, "gemini");
    assert.ok(!gemini.supportedCapabilities.includes("rerank"));
  });

  it("rejects unsupported capability for protocol", () => {
    assert.throws(() => resolveAdapterForCapability("gemini", "rerank"));
    assert.throws(() => resolveAdapterForCapability("anthropic", "embedding"));
    assert.throws(() => resolveAdapterForCapability("bailian", "chat"));
  });
});

describe("bailian remote model helpers", () => {
  it("infers embedding/rerank from model ids including qwen3.7-text-embedding", async () => {
    const {
      dashScopeOrigin,
      inferBailianCapability,
    } = await import("../src/model-router/adapters/bailian.js");
    const { inferCapabilitiesFromModelId } = await import(
      "../src/services/upstream-models.js"
    );

    assert.equal(inferBailianCapability("qwen3.7-text-embedding"), "embedding");
    assert.equal(inferBailianCapability("text-embedding-v4"), "embedding");
    assert.equal(inferBailianCapability("qwen3-rerank"), "rerank");
    assert.equal(inferBailianCapability("qwen-plus"), null);
    assert.equal(
      dashScopeOrigin("https://dashscope.aliyuncs.com/api/v1"),
      "https://dashscope.aliyuncs.com",
    );
    assert.deepEqual(inferCapabilitiesFromModelId("qwen3.7-text-embedding"), [
      "embedding",
    ]);
  });

  it("keeps only embedding/rerank from live DashScope list", async () => {
    const { listBailianRemoteModels } = await import(
      "../src/model-router/adapters/bailian.js"
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/compatible-mode/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "qwen3.7-text-embedding" },
              { id: "text-embedding-v4" },
              { id: "qwen3-rerank" },
              { id: "qwen-plus" },
              { id: "qwen3.7-max" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ code: "NotFound" }), { status: 404 });
    }) as typeof fetch;

    try {
      const { models, message } = await listBailianRemoteModels({
        baseUrl: "https://dashscope.aliyuncs.com/api/v1",
        apiKey: "sk-test",
      });
      const ids = models.map((m) => m.id).sort();
      assert.deepEqual(ids, [
        "qwen3-rerank",
        "qwen3.7-text-embedding",
        "text-embedding-v4",
      ]);
      assert.ok(models.every((m) => m.capability === "embedding" || m.capability === "rerank"));
      assert.match(String(message), /Embedding\/Rerank/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("model-router weighted strategy", () => {
  it("weightedShuffle preserves all items", () => {
    const items = [
      { id: "a", weight: 70 },
      { id: "b", weight: 30 },
      { id: "c", weight: 10 },
    ];
    const shuffled = weightedShuffle(items);
    assert.equal(shuffled.length, 3);
    assert.deepEqual(
      new Set(shuffled.map((i) => i.id)),
      new Set(["a", "b", "c"]),
    );
  });

  it("orderRoutesForStrategy groups by alias", () => {
    const mk = (
      alias: string,
      id: string,
      weight: number,
    ): ResolvedRoute => ({
      routeId: id,
      routeSlug: id,
      alias,
      capability: "chat",
      model: alias,
      weight,
      options: {},
      upstream: {
        id: `up-${id}`,
        protocol: "openai",
        config: { baseUrl: "https://example.com" },
      },
    });
    const routes = [
      mk("gpt-4o", "r1", 70),
      mk("gpt-4o", "r2", 30),
      mk("claude", "r3", 100),
    ];
    const ordered = orderRoutesForStrategy(routes, "priority", "gpt-4o");
    assert.equal(ordered[0]!.alias, "gpt-4o");
    assert.equal(ordered[1]!.alias, "gpt-4o");
    assert.equal(ordered[2]!.alias, "claude");
  });
});
