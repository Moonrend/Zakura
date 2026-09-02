/**
 * 记忆 HTTP API：租户级 Memory Provider 配置，以及单 Agent 的记忆数据管理
 * （检索、增删改、图谱、嵌入统计与重嵌入）。
 *
 * 从 routes.ts 拆出，路由与行为保持不变。
 */
import type { Hono } from "hono";
import { MEMORY_LAYERS, type MemoryStore } from "../services/memory-store.js";
import {
  isMemoryProviderKind,
  type MemoryProvidersService,
} from "../services/memory-providers.js";
import { resolveAgentMemory } from "../services/memory-runtime.js";
import type { AgentService } from "../services/agents.js";

type SessionVars = {
  session?: {
    userId: string;
    tenantId: string;
    email: string;
    role: string;
    isPlatformAdmin?: boolean;
  };
};

export type MemoryRouteDeps = {
  memoryStore: MemoryStore;
  memoryProviders: MemoryProvidersService;
  agentService: AgentService;
  /** 可选：嵌入向量生成（检索 / 重嵌入）。缺省时相关能力按无嵌入降级。 */
  modelRouter?: import("../services/model-router.js").ModelRouterService;
};

export function registerMemoryRoutes(
  app: Hono<{ Variables: SessionVars }>,
  { memoryStore, memoryProviders, agentService, modelRouter }: MemoryRouteDeps,
): void {
  app.get("/api/memory-providers/meta", async (c) => {
    return c.json({ kinds: memoryProviders.kinds() });
  });

  app.get("/api/memory-providers", async (c) => {
    const session = c.get("session")!;
    const [list, usage] = await Promise.all([
      memoryProviders.list(session.tenantId),
      memoryProviders.usage(session.tenantId),
    ]);
    return c.json({
      providers: list,
      agents: usage,
      kinds: memoryProviders.kinds(),
      note: "本页仅管理记忆 Provider；各 Agent 在记忆页选择使用哪一个。",
    });
  });

  app.post("/api/memory-providers", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      kind?: string;
      slug?: string;
      config?: Record<string, unknown>;
      isDefault?: boolean;
    }>();
    try {
      if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
      if (!body.kind || !isMemoryProviderKind(body.kind)) {
        return c.json({ error: "invalid kind" }, 400);
      }
      const created = await memoryProviders.create(session.tenantId, {
        name: body.name,
        kind: body.kind,
        slug: body.slug,
        config: body.config,
        isDefault: body.isDefault,
      });
      return c.json(created, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/memory-providers/:id", async (c) => {
    const session = c.get("session")!;
    const row = await memoryProviders.get(session.tenantId, c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  });

  app.patch("/api/memory-providers/:id", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      config?: Record<string, unknown>;
      isDefault?: boolean;
    }>();
    try {
      const updated = await memoryProviders.update(session.tenantId, c.req.param("id"), body);
      return c.json(updated);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/memory-providers/:id", async (c) => {
    const session = c.get("session")!;
    try {
      await memoryProviders.remove(session.tenantId, c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/memory-providers/:id/health", async (c) => {
    const session = c.get("session")!;
    try {
      const health = await memoryProviders.healthCheck(session.tenantId, c.req.param("id"));
      return c.json(health);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });


  app.get("/api/agents/:id/memory", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const [stats, providers, resolved] = await Promise.all([
      memoryStore.stats(session.tenantId, agent.id),
      memoryProviders.list(session.tenantId),
      resolveAgentMemory(memoryProviders, agent),
    ]);
    let embedding: {
      enabled: boolean;
      model: string | null;
      stats: Awaited<ReturnType<typeof memoryStore.embeddingStats>>;
    } | null = null;
    if (resolved?.kind === "builtin") {
      const emb = (await import("../services/embedding-client.js")).parseEmbeddingConfig(
        resolved.config,
      );
      const embStats = await memoryStore.embeddingStats(session.tenantId, agent.id);
      embedding = {
        enabled: Boolean(emb),
        model: emb?.model ?? null,
        stats: embStats,
      };
    }
    return c.json({
      enabled: agent.enableMemory,
      memoryProviderId: agent.memoryProviderId,
      provider: resolved
        ? {
            id: resolved.provider.id,
            name: resolved.provider.name,
            kind: resolved.kind,
            config: resolved.config,
            storesLocally: resolved.storesLocally,
          }
        : null,
      providers,
      layers: MEMORY_LAYERS,
      stats,
      embedding,
    });
  });

  app.get("/api/agents/:id/memory/items", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const items = await memoryStore.list(session.tenantId, agent.id, {
      q: c.req.query("q") ?? undefined,
      layer: c.req.query("layer") ?? undefined,
      userId: c.req.query("userId") ?? undefined,
      pinned:
        c.req.query("pinned") === "1" || c.req.query("pinned") === "true"
          ? true
          : undefined,
      limit: Number(c.req.query("limit") ?? 50) || 50,
      offset: Number(c.req.query("offset") ?? 0) || 0,
    });
    return c.json({ items, layers: MEMORY_LAYERS });
  });

  app.get("/api/agents/:id/memory/search", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const q = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit") ?? 10) || 10;
    const results = await memoryStore.search(session.tenantId, agent.id, q, limit);
    return c.json({ results });
  });

  app.post("/api/agents/:id/memory/items", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json<{
      content: string;
      layer?: string;
      tags?: string[];
      pinned?: boolean;
      importance?: number;
      userId?: string;
    }>();
    try {
      const resolved = await resolveAgentMemory(memoryProviders, agent);
      const { withEmbedding } = await import("../services/memory-embed.js");
      const base = {
        content: body.content,
        layer: body.layer ?? (resolved?.kind === "traditional" ? "note" : "fact"),
        tags: body.tags,
        pinned: body.pinned,
        importance: body.importance,
        userId: body.userId,
        source: "manual" as const,
        providerId: resolved?.provider.id ?? agent.memoryProviderId,
      };
      const { input, embeddingError } = await withEmbedding(
        base,
        resolved?.kind === "builtin" ? resolved.config : null,
        { tenantId: session.tenantId, modelRouter },
      );
      const item = await memoryStore.add(session.tenantId, agent.id, input);
      return c.json(
        { ...item, ...(embeddingError ? { embeddingWarning: embeddingError } : {}) },
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/memory/reembed", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    try {
      const resolved = await resolveAgentMemory(memoryProviders, agent);
      if (!resolved || resolved.kind !== "builtin") {
        return c.json({ error: "仅 Built-in Provider 支持本地向量重建" }, 400);
      }
      const { parseEmbeddingConfig, reembedAgentMemories } = await import(
        "../services/memory-embed.js"
      );
      const cfg = parseEmbeddingConfig(resolved.config);
      if (!cfg) {
        return c.json({ error: "请先在记忆 Provider 中启用 embedding，并配置路由或 baseUrl/model" }, 400);
      }
      const result = await reembedAgentMemories(
        memoryStore,
        session.tenantId,
        agent.id,
        cfg,
        { limit: 100, modelRouter },
      );
      const stats = await memoryStore.embeddingStats(session.tenantId, agent.id);
      return c.json({ ...result, stats });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/agents/:id/memory/embedding-stats", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const resolved = await resolveAgentMemory(memoryProviders, agent);
    const emb =
      resolved?.kind === "builtin"
        ? (await import("../services/embedding-client.js")).parseEmbeddingConfig(
            resolved.config,
          )
        : null;
    const stats = await memoryStore.embeddingStats(session.tenantId, agent.id);
    return c.json({
      enabled: Boolean(emb),
      model: emb?.model ?? null,
      baseUrl: emb?.baseUrl ?? null,
      stats,
    });
  });

  app.get("/api/agents/:id/memory/graph", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    return c.json(await memoryStore.graph(session.tenantId, agent.id));
  });

  app.post("/api/agents/:id/memory/edges", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json<{
      fromId: string;
      toId: string;
      relation?: string;
    }>();
    try {
      const edge = await memoryStore.link(
        session.tenantId,
        agent.id,
        body.fromId,
        body.toId,
        body.relation ?? "related",
      );
      return c.json(edge, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/agents/:id/memory/edges/:edgeId", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    await memoryStore.unlink(session.tenantId, agent.id, c.req.param("edgeId"));
    return c.json({ ok: true });
  });

  app.patch("/api/agents/:id/memory/items/:memId", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json<Record<string, unknown>>();
    try {
      const resolved = await resolveAgentMemory(memoryProviders, agent);
      const patch: {
        content?: string;
        layer?: string;
        tags?: string[];
        pinned?: boolean;
        importance?: number;
        userId?: string;
        embedding?: number[] | null;
        embeddingModel?: string | null;
      } = {
        content: typeof body.content === "string" ? body.content : undefined,
        layer: typeof body.layer === "string" ? body.layer : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
        importance: typeof body.importance === "number" ? body.importance : undefined,
        userId: typeof body.userId === "string" ? body.userId : undefined,
      };
      let embeddingWarning: string | undefined;
      if (typeof body.content === "string" && resolved?.kind === "builtin") {
        const { withEmbedding } = await import("../services/memory-embed.js");
        const { input, embeddingError } = await withEmbedding(
          { content: body.content },
          resolved.config,
          { tenantId: session.tenantId, modelRouter },
        );
        if (input.embedding) {
          patch.embedding = input.embedding;
          patch.embeddingModel = input.embeddingModel;
        }
        embeddingWarning = embeddingError;
      }
      const item = await memoryStore.update(
        session.tenantId,
        agent.id,
        c.req.param("memId"),
        patch,
      );
      return c.json({
        ...item,
        ...(embeddingWarning ? { embeddingWarning } : {}),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/agents/:id/memory/items/:memId", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    try {
      await memoryStore.remove(session.tenantId, agent.id, c.req.param("memId"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/agents/:id/memory", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const layer = c.req.query("layer") ?? undefined;
    await memoryStore.clear(session.tenantId, agent.id, layer);
    return c.json({ ok: true });
  });

}
