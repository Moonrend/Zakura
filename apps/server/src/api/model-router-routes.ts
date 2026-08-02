import type { Hono } from "hono";
import {
  MODEL_CATALOG_SOURCES,
  type ModelCatalogSource,
  type ModelChatContentPart,
  type ModelChatInvokeOptions,
  type ModelChatMessage,
  type ModelToolCall,
  type ModelToolDefinition,
} from "@zakura/shared";
import { isModelCapability } from "../services/model-routes.js";
import { isModelUpstreamProtocol } from "../services/model-upstreams.js";
import type { ModelCatalogService } from "../services/model-catalog.js";
import type { ModelRouterService } from "../services/model-router.js";
import type { ModelRoutesService } from "../services/model-routes.js";
import type { ModelUpstreamsService } from "../services/model-upstreams.js";
import type { UpstreamModelsService } from "../services/upstream-models.js";
import { parseRouteOptions } from "../model-router/types.js";

type SessionVars = {
  session?: { userId: string; tenantId: string; email: string; role: string };
};

function isCatalogSource(v: string): v is ModelCatalogSource {
  return (MODEL_CATALOG_SOURCES as readonly string[]).includes(v);
}

export function registerModelRouterRoutes(
  app: Hono<{ Variables: SessionVars }>,
  deps: {
    upstreams: ModelUpstreamsService;
    routes: ModelRoutesService;
    router: ModelRouterService;
    catalog?: ModelCatalogService;
    upstreamModels?: UpstreamModelsService;
  },
): void {
  const { upstreams, routes, router, catalog, upstreamModels } = deps;

  app.get("/api/model-router/meta", async (c) => {
    return c.json({
      protocols: upstreams.meta(),
      capabilities: routes.meta(),
      catalogSources: catalog?.sources() ?? [],
      strategies: [
        {
          id: "weighted",
          name: "加权随机",
          description: "同规范名多上游按 weight 概率选择",
        },
        { id: "priority", name: "优先级", description: "严格按顺序尝试" },
      ],
    });
  });

  // ── 上游 ──────────────────────────────────────────────
  app.get("/api/model-upstreams", async (c) => {
    const session = c.get("session")!;
    const list = await upstreams.list(session.tenantId);
    return c.json({ upstreams: list, protocols: upstreams.meta() });
  });

  app.post("/api/model-upstreams", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      slug?: string;
      protocol?: string;
      config?: Record<string, unknown>;
    }>();
    if (!body.name?.trim() || !body.protocol || !isModelUpstreamProtocol(body.protocol)) {
      return c.json({ error: "name 与有效 protocol 必填" }, 400);
    }
    try {
      const created = await upstreams.create(session.tenantId, {
        name: body.name,
        slug: body.slug,
        protocol: body.protocol,
        config: body.config,
      });
      router.invalidateCache(session.tenantId);
      return c.json(created, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/model-upstreams/:id", async (c) => {
    const session = c.get("session")!;
    const row = await upstreams.get(session.tenantId, c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  });

  app.patch("/api/model-upstreams/:id", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ name?: string; config?: Record<string, unknown> }>();
    try {
      const updated = await upstreams.update(session.tenantId, c.req.param("id"), body);
      router.invalidateCache(session.tenantId);
      return c.json(updated);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/model-upstreams/:id", async (c) => {
    const session = c.get("session")!;
    try {
      await upstreams.remove(session.tenantId, c.req.param("id"));
      router.invalidateCache(session.tenantId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/model-upstreams/batch-delete", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ ids?: string[] }>();
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return c.json({ error: "ids 必填" }, 400);
    }
    try {
      const result = await upstreams.removeMany(session.tenantId, body.ids);
      router.invalidateCache(session.tenantId);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/model-upstreams/:id/health", async (c) => {
    const session = c.get("session")!;
    try {
      const health = await upstreams.healthCheck(session.tenantId, c.req.param("id"));
      return c.json(health);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** 预览：从真实上游拉取模型列表（不入库） */
  app.get("/api/model-upstreams/:id/models", async (c) => {
    const session = c.get("session")!;
    try {
      const result = await upstreams.listRemoteModels(session.tenantId, c.req.param("id"));
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** 同步：拉取上游模型并写入库存（规范名由元数据匹配） */
  if (upstreamModels) {
    app.post("/api/model-upstreams/:id/sync-models", async (c) => {
      const session = c.get("session")!;
      const body = await c.req
        .json<{ prune?: boolean; modelIds?: string[] }>()
        .catch(() => ({}) as { prune?: boolean; modelIds?: string[] });
      try {
        const result = await upstreamModels.syncFromUpstream(
          session.tenantId,
          c.req.param("id"),
          {
            prune: body.prune === true,
            modelIds: Array.isArray(body.modelIds) ? body.modelIds : undefined,
          },
        );
        router.invalidateCache(session.tenantId);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    });

    app.get("/api/upstream-models", async (c) => {
      const session = c.get("session")!;
      const cap = c.req.query("capability");
      const capability = cap && isModelCapability(cap) ? cap : undefined;
      const upstreamId = c.req.query("upstreamId") || undefined;
      const grouped = c.req.query("grouped") === "1" || c.req.query("grouped") === "true";
      if (grouped) {
        const models = await upstreamModels.listLogical(session.tenantId, { capability });
        return c.json({ models, capabilities: routes.meta() });
      }
      const list = await upstreamModels.list(session.tenantId, {
        capability,
        upstreamId,
      });
      return c.json({ models: list, capabilities: routes.meta() });
    });

    app.post("/api/upstream-models", async (c) => {
      const session = c.get("session")!;
      const body = await c.req.json<{
        upstreamId?: string;
        nativeModel?: string;
        canonicalModel?: string;
        displayName?: string;
        capability?: string;
        weight?: number;
        enabled?: boolean;
        isDefault?: boolean;
        options?: Record<string, unknown>;
        meta?: Record<string, unknown>;
      }>();
      if (
        !body.upstreamId ||
        !body.nativeModel?.trim() ||
        !body.capability ||
        !isModelCapability(body.capability)
      ) {
        return c.json({ error: "upstreamId、nativeModel、capability 必填" }, 400);
      }
      try {
        const created = await upstreamModels.create(session.tenantId, {
          upstreamId: body.upstreamId,
          nativeModel: body.nativeModel,
          canonicalModel: body.canonicalModel,
          displayName: body.displayName,
          capability: body.capability,
          weight: body.weight,
          enabled: body.enabled,
          isDefault: body.isDefault,
          options: body.options,
          meta: body.meta,
        });
        router.invalidateCache(session.tenantId);
        return c.json(created, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    });

    app.patch("/api/upstream-models/:id", async (c) => {
      const session = c.get("session")!;
      const body = await c.req.json<{
        nativeModel?: string;
        canonicalModel?: string;
        displayName?: string | null;
        weight?: number;
        enabled?: boolean;
        isDefault?: boolean;
        capability?: string;
        options?: Record<string, unknown>;
        meta?: Record<string, unknown>;
      }>();
      const patch = {
        ...body,
        capability:
          body.capability && isModelCapability(body.capability)
            ? body.capability
            : undefined,
      };
      try {
        const updated = await upstreamModels.update(
          session.tenantId,
          c.req.param("id"),
          patch,
        );
        router.invalidateCache(session.tenantId);
        return c.json(updated);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    });

    app.delete("/api/upstream-models/:id", async (c) => {
      const session = c.get("session")!;
      try {
        await upstreamModels.remove(session.tenantId, c.req.param("id"));
        router.invalidateCache(session.tenantId);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    });

    app.post("/api/upstream-models/batch-delete", async (c) => {
      const session = c.get("session")!;
      const body = await c.req.json<{ ids?: string[] }>();
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return c.json({ error: "ids 必填" }, 400);
      }
      try {
        const result = await upstreamModels.removeMany(session.tenantId, body.ids);
        router.invalidateCache(session.tenantId);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    });
  }

  // ── 模型列表（兼容旧 /api/model-routes，数据来自 upstream_models） ──
  app.get("/api/model-routes", async (c) => {
    const session = c.get("session")!;
    const cap = c.req.query("capability");
    const capability = cap && isModelCapability(cap) ? cap : undefined;

    if (upstreamModels) {
      const list = await upstreamModels.list(session.tenantId, { capability });
      const asRoutes = list.map((m) => ({
        id: m.id,
        name: m.displayName || m.canonicalModel,
        slug: m.canonicalModel,
        capability: m.capability,
        alias: m.canonicalModel,
        upstreamId: m.upstreamId,
        model: m.nativeModel,
        nativeModel: m.nativeModel,
        canonicalModel: m.canonicalModel,
        options: m.options,
        priority: 100,
        weight: m.weight,
        isDefault: m.isDefault,
        status: m.status,
        enabled: m.enabled,
        meta: m.meta,
        upstream: m.upstream,
      }));
      return c.json({ routes: asRoutes, capabilities: routes.meta() });
    }

    const list = await routes.list(session.tenantId, capability);
    return c.json({ routes: list, capabilities: routes.meta() });
  });

  app.post("/api/model-routes", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      slug?: string;
      capability?: string;
      upstreamId?: string;
      model?: string;
      alias?: string;
      options?: Record<string, unknown>;
      priority?: number;
      weight?: number;
      isDefault?: boolean;
    }>();
    if (
      !body.capability ||
      !isModelCapability(body.capability) ||
      !body.upstreamId ||
      !body.model?.trim()
    ) {
      return c.json({ error: "capability、upstreamId、model 必填" }, 400);
    }

    if (upstreamModels) {
      try {
        const created = await upstreamModels.create(session.tenantId, {
          upstreamId: body.upstreamId,
          nativeModel: body.model,
          canonicalModel: body.alias || body.slug,
          displayName: body.name,
          capability: body.capability,
          weight: body.weight,
          isDefault: body.isDefault,
          options: body.options,
        });
        router.invalidateCache(session.tenantId);
        return c.json(
          {
            ...created,
            name: created.displayName || created.canonicalModel,
            slug: created.canonicalModel,
            alias: created.canonicalModel,
            model: created.nativeModel,
          },
          201,
        );
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }

    if (!body.name?.trim()) {
      return c.json({ error: "name、capability、upstreamId、model 必填" }, 400);
    }
    try {
      const created = await routes.create(session.tenantId, {
        name: body.name,
        slug: body.slug,
        capability: body.capability,
        upstreamId: body.upstreamId,
        model: body.model,
        alias: body.alias,
        options: body.options,
        priority: body.priority,
        weight: body.weight,
        isDefault: body.isDefault,
      });
      router.invalidateCache(session.tenantId);
      return c.json(created, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/model-routes/:id", async (c) => {
    const session = c.get("session")!;
    if (upstreamModels) {
      const row = await upstreamModels.get(session.tenantId, c.req.param("id"));
      if (row) {
        return c.json({
          ...row,
          name: row.displayName || row.canonicalModel,
          slug: row.canonicalModel,
          alias: row.canonicalModel,
          model: row.nativeModel,
        });
      }
    }
    const row = await routes.get(session.tenantId, c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  });

  app.patch("/api/model-routes/:id", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      model?: string;
      alias?: string;
      options?: Record<string, unknown>;
      priority?: number;
      weight?: number;
      isDefault?: boolean;
      upstreamId?: string;
      enabled?: boolean;
      canonicalModel?: string;
      nativeModel?: string;
      displayName?: string | null;
      capability?: string;
      meta?: Record<string, unknown>;
    }>();

    if (upstreamModels) {
      const existing = await upstreamModels.get(session.tenantId, c.req.param("id"));
      if (existing) {
        try {
          const updated = await upstreamModels.update(session.tenantId, c.req.param("id"), {
            nativeModel: body.nativeModel ?? body.model,
            canonicalModel: body.canonicalModel ?? body.alias,
            displayName:
              body.displayName !== undefined
                ? body.displayName
                : body.name !== undefined
                  ? body.name
                  : undefined,
            weight: body.weight,
            enabled: body.enabled,
            isDefault: body.isDefault,
            capability:
              body.capability && isModelCapability(body.capability)
                ? body.capability
                : undefined,
            options: body.options,
            meta: body.meta,
          });
          router.invalidateCache(session.tenantId);
          return c.json({
            ...updated,
            name: updated.displayName || updated.canonicalModel,
            slug: updated.canonicalModel,
            alias: updated.canonicalModel,
            model: updated.nativeModel,
          });
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }
    }

    try {
      const updated = await routes.update(session.tenantId, c.req.param("id"), body);
      router.invalidateCache(session.tenantId);
      return c.json(updated);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/model-routes/:id", async (c) => {
    const session = c.get("session")!;
    if (upstreamModels) {
      const existing = await upstreamModels.get(session.tenantId, c.req.param("id"));
      if (existing) {
        try {
          await upstreamModels.remove(session.tenantId, c.req.param("id"));
          router.invalidateCache(session.tenantId);
          return c.json({ ok: true });
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }
    }
    try {
      await routes.remove(session.tenantId, c.req.param("id"));
      router.invalidateCache(session.tenantId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── 元数据（仅刷新，不做用户管理页） ──────────────────
  if (catalog) {
    app.get("/api/model-catalog/match", async (c) => {
      const session = c.get("session")!;
      const model = c.req.query("model")?.trim();
      if (!model) return c.json({ error: "model 查询参数必填" }, 400);
      const source = c.req.query("source");
      const result = await catalog.match(session.tenantId, model, {
        source: source && isCatalogSource(source) ? source : undefined,
        limit: Number(c.req.query("limit") || 10) || 10,
      });
      return c.json(result);
    });

    /** 一键刷新 models.dev + llm-metadata，并重匹配已同步模型的规范名 */
    app.post("/api/model-catalog/refresh", async (c) => {
      const session = c.get("session")!;
      try {
        const imported = await catalog.refreshAll(session.tenantId);
        const rematch = upstreamModels
          ? await upstreamModels.rematchAll(session.tenantId)
          : { rematched: 0, renamed: 0 };
        router.invalidateCache(session.tenantId);
        return c.json({ ...imported, ...rematch });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    });

    app.post("/api/model-catalog/import", async (c) => {
      const session = c.get("session")!;
      const body = await c.req.json<{ source?: string }>();
      if (!body.source || !isCatalogSource(body.source)) {
        return c.json({ error: "source 必须是 models.dev 或 llm-metadata" }, 400);
      }
      try {
        const result = await catalog.importFrom(session.tenantId, body.source);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    });
  }

  // ── 内部调用 ──────────────────────────────────────────
  app.post("/api/model-router/embed", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      texts?: string[];
      text?: string;
      routeId?: string;
      slug?: string;
      alias?: string;
    }>();
    const texts = Array.isArray(body.texts)
      ? body.texts.map(String)
      : typeof body.text === "string"
        ? [body.text]
        : [];
    if (texts.length === 0) return c.json({ error: "texts 或 text 必填" }, 400);
    try {
      const result = await router.embed(session.tenantId, texts, {
        capability: "embedding",
        routeId: body.routeId,
        slug: body.slug,
        alias: body.alias,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/model-router/rerank", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      query?: string;
      documents?: string[];
      routeId?: string;
      slug?: string;
      alias?: string;
    }>();
    if (!body.query || !Array.isArray(body.documents)) {
      return c.json({ error: "query 与 documents 必填" }, 400);
    }
    try {
      const result = await router.rerank(
        session.tenantId,
        body.query,
        body.documents.map(String),
        {
          capability: "rerank",
          routeId: body.routeId,
          slug: body.slug,
          alias: body.alias,
        },
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/model-router/chat", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      messages?: Array<{
        role?: string;
        content?: unknown;
        name?: string;
        toolCalls?: unknown;
        toolCallId?: string;
        tool_calls?: unknown;
        tool_call_id?: string;
        parts?: unknown;
      }>;
      tools?: ModelToolDefinition[];
      toolChoice?: ModelChatInvokeOptions["toolChoice"];
      tool_choice?: ModelChatInvokeOptions["toolChoice"];
      extensions?: Record<string, unknown>;
      reasoning?: unknown;
      routeOptions?: Record<string, unknown>;
      routeId?: string;
      slug?: string;
      alias?: string;
      strategy?: "weighted" | "priority";
    }>();
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ error: "messages 必填" }, 400);
    }

    function parseToolCalls(raw: unknown): ModelToolCall[] | undefined {
      if (!Array.isArray(raw) || raw.length === 0) return undefined;
      const out: ModelToolCall[] = [];
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const fn = o.function;
        if (!fn || typeof fn !== "object") continue;
        const f = fn as Record<string, unknown>;
        if (typeof f.name !== "string") continue;
        out.push({
          id: typeof o.id === "string" ? o.id : `call_${out.length}`,
          type: "function",
          function: {
            name: f.name,
            arguments:
              typeof f.arguments === "string"
                ? f.arguments
                : JSON.stringify(f.arguments ?? {}),
          },
        });
      }
      return out.length ? out : undefined;
    }

    function parseMessageParts(raw: unknown): ModelChatContentPart[] | undefined {
      if (!Array.isArray(raw) || raw.length === 0) return undefined;
      const out: ModelChatContentPart[] = [];
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        if (o.type === "text" && typeof o.text === "string") {
          out.push({ type: "text", text: o.text });
          continue;
        }
        if (o.type !== "image_url") continue;
        const imageUrl = o.imageUrl ?? o.image_url;
        if (!imageUrl || typeof imageUrl !== "object") continue;
        const url = (imageUrl as Record<string, unknown>).url;
        if (typeof url === "string" && url.trim()) {
          out.push({ type: "image_url", imageUrl: { url } });
        }
      }
      return out.length ? out : undefined;
    }

    function parseMessageContent(raw: unknown): string | null {
      if (typeof raw === "string") return raw;
      if (raw == null) return null;
      const parts = parseMessageParts(raw);
      if (!parts) return null;
      const text = parts
        .filter((p): p is Extract<ModelChatContentPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      return text || null;
    }

    const messages: ModelChatMessage[] = body.messages.map((m) => ({
      role: (m.role === "system" ||
      m.role === "assistant" ||
      m.role === "tool" ||
      m.role === "user"
        ? m.role
        : "user") as ModelChatMessage["role"],
      content: parseMessageContent(m.content),
      name: typeof m.name === "string" ? m.name : undefined,
      toolCallId:
        typeof m.toolCallId === "string"
          ? m.toolCallId
          : typeof m.tool_call_id === "string"
            ? m.tool_call_id
            : undefined,
      toolCalls: parseToolCalls(m.toolCalls ?? m.tool_calls),
      parts: parseMessageParts(m.parts) ?? parseMessageParts(m.content),
    }));

    const invokeOptions: ModelChatInvokeOptions = {
      tools: body.tools,
      toolChoice: body.toolChoice ?? body.tool_choice,
      routeOptions: {
        ...parseRouteOptions(body.routeOptions ?? {}),
        ...parseRouteOptions({ reasoning: body.reasoning }),
      },
      extensions: body.extensions,
    };

    try {
      const result = await router.chat(
        session.tenantId,
        messages,
        {
          capability: "chat",
          routeId: body.routeId,
          slug: body.slug,
          alias: body.alias,
          strategy: body.strategy,
        },
        invokeOptions,
      );
      return c.json({
        ...result.openai,
        routeId: result.routeId,
        routeSlug: result.routeSlug,
        alias: result.alias,
        upstreamId: result.upstreamId,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/model-router/image", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      prompt?: string;
      routeId?: string;
      slug?: string;
      alias?: string;
    }>();
    if (!body.prompt?.trim()) return c.json({ error: "prompt 必填" }, 400);
    try {
      const result = await router.generateImage(session.tenantId, body.prompt, {
        capability: "image",
        routeId: body.routeId,
        slug: body.slug,
        alias: body.alias,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
}
