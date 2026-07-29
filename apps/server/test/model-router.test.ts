import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ModelCatalogEntry } from "@zakura/shared";
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

    for (const protocol of [
      "vercel-ai-gateway",
      "groq",
      "together",
      "fireworks",
      "cerebras",
      "deepinfra",
      "novita",
      "baseten",
      "lambda",
      "huggingface",
      "sambanova",
      "hyperbolic",
      "nebius",
    ] as const) {
      const adapter = getModelAdapter(protocol);
      assert.equal(adapter.protocol, protocol);
      assert.ok(adapter.supportedCapabilities.includes("chat"));
    }

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

describe("model catalog metadata", () => {
  it("falls back to the model id after the last slash when matching catalog metadata", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { createPglite } = await import("../src/db/pglite.js");
    const schema = await import("../src/db/schema.js");
    const { ModelCatalogService } = await import("../src/services/model-catalog.js");

    const dataDir = await mkdtemp(join(tmpdir(), "model-catalog-match-"));
    const client = await createPglite(dataDir);
    try {
      await client.exec(`
        CREATE TABLE model_catalog_entries (
          id text PRIMARY KEY,
          tenant_id text NOT NULL,
          source text NOT NULL,
          provider_id text NOT NULL,
          provider_name text NOT NULL,
          model_id text NOT NULL,
          name text NOT NULL,
          meta_json text NOT NULL DEFAULT '{}',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);

      const db = drizzle(client, { schema });
      const tenantId = schema.newId();
      const meta: ModelCatalogEntry = {
        source: "models.dev",
        providerId: "deepseek",
        providerName: "DeepSeek",
        modelId: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        capabilities: ["chat"],
      };
      await db.insert(schema.modelCatalogEntries).values({
        id: schema.newId(),
        tenantId,
        source: meta.source,
        providerId: meta.providerId,
        providerName: meta.providerName,
        modelId: meta.modelId,
        name: meta.name,
        metaJson: JSON.stringify(meta),
      });

      const catalog = new ModelCatalogService(db);
      (
        catalog as unknown as {
          ensureTenantCatalog: (tenantId: string) => Promise<void>;
        }
      ).ensureTenantCatalog = async () => {};

      const best = await catalog.matchBest(
        tenantId,
        "openrouter/deepseek-v4-pro",
      );
      assert.equal(best?.modelId, "deepseek-v4-pro");
      assert.equal(best?.score, 1);
    } finally {
      await client.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("marks image-input text models as chat-capable multimodal entries", async () => {
    const { parseModelsDevPayload } = await import(
      "../src/services/model-catalog.js"
    );

    const entries = parseModelsDevPayload({
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        api: "https://api.deepseek.com",
        models: {
          "deepseek-vl-chat": {
            id: "deepseek-vl-chat",
            name: "DeepSeek VL Chat",
            modalities: { input: ["text", "image"], output: ["text"] },
          },
        },
      },
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.providerId, "deepseek");
    assert.deepEqual(entries[0]!.capabilities, ["chat"]);
    assert.deepEqual(entries[0]!.modalities?.input, ["text", "image"]);
  });

  it("parses reasoning options from llm-metadata", async () => {
    const { parseLlmMetadataPayload } = await import(
      "../src/services/model-catalog.js"
    );

    const [entry] = parseLlmMetadataPayload({
      providers: [{ id: "alibaba-cn", name: "Alibaba (China)" }],
      models: [
        {
          provider: "alibaba-cn",
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          reasoning: true,
          reasoning_options: [
            { type: "toggle" },
            { type: "effort", values: ["high", "max"] },
          ],
        },
      ],
    });

    assert.deepEqual(entry?.reasoningLevels, ["none", "high", "max"]);
    assert.equal(entry?.defaultReasonLevel, undefined);
    assert.equal(entry?.reasoning, true);
  });
});

describe("openai-compatible multimodal mapping", () => {
  const mkRoute = (
    meta?: ResolvedRoute["meta"],
  ): ResolvedRoute => ({
    routeId: "r1",
    routeSlug: "deepseek-vl-chat",
    alias: "deepseek-vl-chat",
    capability: "chat",
    model: "deepseek-vl-chat",
    weight: 100,
    options: {},
    ...(meta ? { meta } : {}),
    upstream: {
      id: "up1",
      protocol: "deepseek",
      config: { baseUrl: "https://api.deepseek.com", apiKey: "sk-test" },
    },
  });

  it("passes image_url parts when catalog says the model accepts image input", async () => {
    const { mapOpenAiCompatibleMessages } = await import(
      "../src/model-router/adapters/openai-compatible.js"
    );
    const [msg] = mapOpenAiCompatibleMessages(
      mkRoute({
        source: "models.dev",
        providerId: "deepseek",
        providerName: "DeepSeek",
        modelId: "deepseek-vl-chat",
        name: "DeepSeek VL Chat",
        capabilities: ["chat"],
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
      [
        {
          role: "user",
          content: "describe it",
          parts: [
            { type: "text", text: "describe it" },
            { type: "image_url", imageUrl: { url: "data:image/png;base64,AAA=" } },
          ],
        },
      ],
    );

    assert.deepEqual(msg?.content, [
      { type: "text", text: "describe it" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAA=", detail: "auto" },
      },
    ]);
  });

  it("omits image input when catalog metadata is unavailable", async () => {
    const { mapOpenAiCompatibleMessages } = await import(
      "../src/model-router/adapters/openai-compatible.js"
    );
    const [msg] = mapOpenAiCompatibleMessages(mkRoute(), [
      {
        role: "user",
        content: "describe it",
        parts: [{ type: "image_url", imageUrl: { url: "https://example.com/a.png" } }],
      },
    ]);

    assert.deepEqual(msg?.content, [
      { type: "text", text: "[Image omitted: selected model does not support image input]" },
    ]);
  });
});

describe("model-router tool history normalization", () => {
  it("drops orphan tool messages and repairs missing tool results", async () => {
    const { normalizeToolCallHistory } = await import("../src/model-router/messages.js");
    const fixed = normalizeToolCallHistory([
      { role: "user", content: "hi" },
      { role: "tool", content: "orphan", toolCallId: "lost", name: "web_search" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          },
        ],
      },
      { role: "user", content: "next" },
    ]);

    assert.deepEqual(
      fixed.map((m) => [m.role, m.toolCallId ?? "", m.content]),
      [
        ["user", "", "hi"],
        ["assistant", "", null],
        ["tool", "c1", "（该工具调用没有可用结果：历史上下文已自动修复）"],
        ["user", "", "next"],
      ],
    );
  });

  it("infers a missing tool_call_id when one call is pending", async () => {
    const { normalizeToolCallHistory } = await import("../src/model-router/messages.js");
    const fixed = normalizeToolCallHistory([
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "ok", name: "web_search" },
    ]);

    assert.equal(fixed[1]!.role, "tool");
    assert.equal(fixed[1]!.toolCallId, "c1");
  });
});

describe("model-router invoke options", () => {
  it("runtime routeOptions override model default reasoning", async () => {
    const { applyInvokeRouteOptions } = await import("../src/model-router/executor.js");
    const route: ResolvedRoute = {
      routeId: "r1",
      routeSlug: "gpt-5",
      alias: "gpt-5",
      capability: "chat",
      model: "gpt-5",
      weight: 100,
      options: { reasoning: { enabled: true, effort: "medium" } },
      upstream: {
        id: "up1",
        protocol: "openai",
        config: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
      },
    };

    assert.deepEqual(
      applyInvokeRouteOptions(route, {
        routeOptions: { reasoning: { enabled: false } },
      }).options.reasoning,
      { enabled: false },
    );
    assert.deepEqual(route.options.reasoning, { enabled: true, effort: "medium" });
  });

  it("drops runtime reasoning levels unsupported by metadata", async () => {
    const { applyInvokeRouteOptions } = await import("../src/model-router/executor.js");
    const route: ResolvedRoute = {
      routeId: "r1",
      routeSlug: "deepseek-reasoner",
      alias: "deepseek-reasoner",
      capability: "chat",
      model: "deepseek-reasoner",
      weight: 100,
      options: {},
      meta: {
        source: "models.dev",
        providerId: "deepseek",
        providerName: "DeepSeek",
        modelId: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
        capabilities: ["chat"],
        reasoning: true,
        reasoningLevels: ["none", "high", "max"],
      },
      upstream: {
        id: "up1",
        protocol: "deepseek",
        config: { baseUrl: "https://api.deepseek.com", apiKey: "sk-test" },
      },
    };

    assert.deepEqual(
      applyInvokeRouteOptions(route, {
        routeOptions: { reasoning: { enabled: true, effort: "high" } },
      }).options.reasoning,
      { enabled: true, effort: "high" },
    );
    assert.equal(
      applyInvokeRouteOptions(route, {
        routeOptions: { reasoning: { enabled: true, effort: "medium" } },
      }).options.reasoning,
      undefined,
    );
    assert.deepEqual(
      applyInvokeRouteOptions(route, {
        routeOptions: { reasoning: { enabled: false } },
      }).options.reasoning,
      { enabled: false },
    );
  });
});

describe("model-router reasoning request mapping", () => {
  it("maps metadata reasoning_options without inventing unsupported levels", async () => {
    const { applyReasoningOptions } = await import("../src/model-router/reasoning.js");
    const meta: ModelCatalogEntry = {
      source: "llm-metadata",
      providerId: "alibaba-cn",
      providerName: "Alibaba (China)",
      modelId: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      capabilities: ["chat"],
      reasoning: true,
      reasoningLevels: ["none", "high", "max"],
      raw: {
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["high", "max"] },
        ],
      },
    };

    const highBody: Record<string, unknown> = {};
    applyReasoningOptions(
      "custom",
      highBody,
      { reasoning: { enabled: true, effort: "max" } },
      meta,
    );
    assert.deepEqual(highBody, {
      enable_thinking: true,
      reasoning_effort: "max",
    });

    const offBody: Record<string, unknown> = {};
    applyReasoningOptions("custom", offBody, { reasoning: { enabled: false } }, meta);
    assert.deepEqual(offBody, { enable_thinking: false });
  });

  it("does not send reasoning_effort none for generic OpenAI-compatible routes", async () => {
    const { applyReasoningOptions } = await import("../src/model-router/reasoning.js");
    const body: Record<string, unknown> = {};
    applyReasoningOptions("openai", body, { reasoning: { enabled: false } });
    assert.deepEqual(body, {});
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
