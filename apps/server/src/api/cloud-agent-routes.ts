/**
 * Cloud Agent REST + SSE 路由。
 * SSE 使用 fetch（带 Authorization），支持 afterSeq 断点续传与多设备同步。
 */
import type { Hono } from "hono";
import {
  parseCloudAgentConfig,
  parseCloudAgentSessionKind,
  parseCloudAgentSessionOrigin,
  type CloudAgentAttachment,
  type CloudAgentRunOptions,
} from "@zakura/shared";
import type { AppVariables } from "./routes.js";
import type { AgentService } from "../services/agents.js";
import type {
  CloudAgentSessionStore,
  SessionKindFilter,
} from "../services/cloud-agent-session.js";
import type { CloudAgentRuntime } from "../services/cloud-agent-runtime.js";
import type { ModelRouterService } from "../services/model-router.js";
import { parseRouteOptions } from "../model-router/types.js";

function sessionDto(row: {
  id: string;
  agentId: string;
  title: string;
  status: string;
  kind: string;
  originJson: string;
  model: string | null;
  modelRouteId: string | null;
  reasoning: string | null;
  draftText: string;
  lastSeq: number;
  activeRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  let origin: unknown = {};
  try {
    origin = parseCloudAgentSessionOrigin(JSON.parse(row.originJson || "{}"));
  } catch {
    origin = {};
  }
  return {
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    status: row.status,
    kind: row.kind,
    origin,
    model: row.model,
    modelRouteId: row.modelRouteId,
    reasoning: row.reasoning,
    draftText: row.draftText,
    lastSeq: row.lastSeq,
    activeRunId: row.activeRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** kinds 查询参数：逗号分隔的类型列表或 "all"；非法值忽略，缺省 = 仅 chat */
function parseKindsParam(raw: string | undefined): SessionKindFilter | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (v === "all") return "all";
  const kinds = v
    .split(",")
    .map((s) => parseCloudAgentSessionKind(s.trim()))
    .filter((k): k is NonNullable<typeof k> => k !== null);
  return kinds.length > 0 ? kinds : undefined;
}

function parseRunOptions(raw: unknown): CloudAgentRunOptions | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const routeOptions = parseRouteOptions({ reasoning: o.reasoning });
  const out: CloudAgentRunOptions = {};
  if (routeOptions.reasoning) out.reasoning = routeOptions.reasoning;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function registerCloudAgentRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: {
    agentService: AgentService;
    store: CloudAgentSessionStore;
    runtime: {
      startTurn: CloudAgentRuntime["startTurn"];
      compactSession?: CloudAgentRuntime["compactSession"];
      forkSession?: CloudAgentRuntime["forkSession"];
    };
    modelRouter?: ModelRouterService;
  },
) {
  const { agentService, store, runtime, modelRouter } = deps;

  async function requireAgent(tenantId: string, agentId: string) {
    return agentService.get(tenantId, agentId);
  }

  async function isOpenAiGatewaySession(
    tenantId: string,
    agentId: string,
    sessionId: string,
  ): Promise<boolean> {
    const row = await store.getSession(tenantId, agentId, sessionId);
    if (!row) return false;
    try {
      return parseCloudAgentSessionOrigin(JSON.parse(row.originJson || "{}")).channel ===
        "openai-gateway";
    } catch {
      return false;
    }
  }

  app.get("/api/agents/:id/cloud/config", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    let configJson: Record<string, unknown> = {};
    try {
      configJson = JSON.parse(agent.configJson || "{}") as Record<string, unknown>;
    } catch {
      configJson = {};
    }
    const cloud = parseCloudAgentConfig(configJson);
    return c.json({
      cloud,
      hasChatRoute: Boolean(modelRouter),
    });
  });

  app.put("/api/agents/:id/cloud/config", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body = await c.req.json<{
      systemPrompt?: string;
      model?: string | null;
      modelRouteId?: string | null;
      maxToolRounds?: number | null;
      /** 子代理最大嵌套深度（1-5）；null/0 恢复默认（2） */
      maxSubagentDepth?: number | null;
      enableTools?: boolean;
      autoMemory?: boolean;
      autoTitle?: boolean;
      /** Gateway 模型名转发；null/{} 清除 */
      gatewayModelMap?: Record<string, string> | null;
    }>();

    let configJson: Record<string, unknown> = {};
    try {
      configJson = JSON.parse(agent.configJson || "{}") as Record<string, unknown>;
    } catch {
      configJson = {};
    }
    const prev =
      configJson.cloud && typeof configJson.cloud === "object"
        ? (configJson.cloud as Record<string, unknown>)
        : {};
    const next = { ...prev };
    if (body.systemPrompt !== undefined) next.systemPrompt = body.systemPrompt;
    if (body.model !== undefined) {
      if (body.model === null || body.model === "") delete next.model;
      else next.model = body.model;
    }
    if (body.modelRouteId !== undefined) {
      if (body.modelRouteId === null || body.modelRouteId === "") delete next.modelRouteId;
      else next.modelRouteId = body.modelRouteId;
    }
    if (body.maxToolRounds !== undefined) {
      if (body.maxToolRounds == null || body.maxToolRounds <= 0) delete next.maxToolRounds;
      else next.maxToolRounds = body.maxToolRounds;
    }
    if (body.maxSubagentDepth !== undefined) {
      if (body.maxSubagentDepth == null || body.maxSubagentDepth <= 0) {
        delete next.maxSubagentDepth;
      } else {
        next.maxSubagentDepth = body.maxSubagentDepth;
      }
    }
    if (body.enableTools !== undefined) next.enableTools = body.enableTools;
    if (body.autoMemory !== undefined) next.autoMemory = body.autoMemory;
    if (body.autoTitle !== undefined) next.autoTitle = body.autoTitle;
    if (body.gatewayModelMap !== undefined) {
      if (body.gatewayModelMap == null) {
        delete next.gatewayModelMap;
      } else {
        const map: Record<string, string> = {};
        for (const [rawFrom, rawTo] of Object.entries(body.gatewayModelMap)) {
          const from = rawFrom.trim();
          const to = typeof rawTo === "string" ? rawTo.trim() : "";
          if (from && to) map[from] = to;
        }
        if (Object.keys(map).length) next.gatewayModelMap = map;
        else delete next.gatewayModelMap;
      }
    }
    configJson.cloud = next;

    await agentService.update(session.tenantId, agent.id, {
      config: configJson,
    });
    return c.json({ cloud: parseCloudAgentConfig(configJson) });
  });

  /** 跨 Agent 会话搜索（标题 + 消息内容；pg_trgm 可用时叠加模糊标题匹配） */
  app.get("/api/cloud/search", async (c) => {
    const session = c.get("session")!;
    const q = c.req.query("q")?.trim() ?? "";
    if (!q) return c.json({ results: [] });
    const agentId = c.req.query("agentId")?.trim() || undefined;
    const limitRaw = Number(c.req.query("limit") ?? "20");
    const kinds = parseKindsParam(c.req.query("kinds"));
    const hits = await store.searchSessions(session.tenantId, q, {
      agentId,
      limit: Number.isFinite(limitRaw) ? limitRaw : 20,
      ...(kinds ? { kinds } : {}),
    });
    const agents = await agentService.list(session.tenantId);
    const byId = new Map(agents.map((a) => [a.id, a]));
    return c.json({
      results: hits.map((h) => ({
        ...sessionDto(h.session),
        snippet: h.snippet,
        agentName: byId.get(h.session.agentId)?.name ?? null,
        agentSlug: byId.get(h.session.agentId)?.slug ?? null,
      })),
    });
  });

  app.get("/api/agents/:id/cloud/sessions", async (c) => {
    const session = c.get("session")!;
    const agentId = c.req.param("id");
    const agent = await requireAgent(session.tenantId, agentId);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const rows = await store.listSessions(session.tenantId, agentId, {
      includeArchived: c.req.query("all") === "1",
      kinds: parseKindsParam(c.req.query("kinds")),
    });
    return c.json({ sessions: rows.map(sessionDto) });
  });

  app.get("/api/agents/:id/gateway/sessions", async (c) => {
    const session = c.get("session")!;
    const agentId = c.req.param("id");
    const agent = await requireAgent(session.tenantId, agentId);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const rows = await store.listGatewaySessions(session.tenantId, agentId, {
      includeArchived: c.req.query("all") === "1",
    });
    return c.json({ sessions: rows.map(sessionDto) });
  });

  app.post("/api/agents/:id/cloud/sessions", async (c) => {
    const session = c.get("session")!;
    const agentId = c.req.param("id");
    const agent = await requireAgent(session.tenantId, agentId);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body = await c.req
      .json<{ title?: string; kind?: string; origin?: unknown }>()
      .catch(() => ({}) as { title?: string; kind?: string; origin?: unknown });
    const kind = body.kind !== undefined ? parseCloudAgentSessionKind(body.kind) : null;
    if (body.kind !== undefined && !kind) {
      return c.json({ error: `无效的会话类型: ${String(body.kind)}` }, 400);
    }
    // API 创建的非 chat 会话默认标记 source=api（系统集成产生的对话历史）
    const origin = parseCloudAgentSessionOrigin(body.origin);
    if (kind && kind !== "chat" && !origin.source) origin.source = "api";
    const created = await store.createSession({
      tenantId: session.tenantId,
      agentId,
      title: body.title,
      createdByUserId: session.userId === "api-key" ? null : session.userId,
      ...(kind ? { kind } : {}),
      ...(Object.keys(origin).length ? { origin } : {}),
    });
    return c.json(sessionDto(created), 201);
  });

  app.get("/api/agents/:id/cloud/sessions/:sid", async (c) => {
    const session = c.get("session")!;
    const agentId = c.req.param("id");
    const sid = c.req.param("sid");
    const row = await store.getSession(session.tenantId, agentId, sid);
    if (!row) return c.json({ error: "Not found" }, 404);
    const afterSeq = Number(c.req.query("afterSeq") ?? "0");
    const events = await store.listEvents(sid, {
      afterSeq: Number.isFinite(afterSeq) ? afterSeq : 0,
    });
    return c.json({
      session: sessionDto(row),
      events,
    });
  });

  app.patch("/api/agents/:id/cloud/sessions/:sid", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      title?: string;
      status?: "active" | "archived";
      kind?: string;
      model?: string | null;
      modelRouteId?: string | null;
      reasoning?: string | null;
      draftText?: string;
    }>();
    const kind = body.kind !== undefined ? parseCloudAgentSessionKind(body.kind) : null;
    if (body.kind !== undefined && !kind) {
      return c.json({ error: `无效的会话类型: ${String(body.kind)}` }, 400);
    }
    const updated = await store.updateSession(
      session.tenantId,
      c.req.param("id"),
      c.req.param("sid"),
      {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(kind ? { kind } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.modelRouteId !== undefined ? { modelRouteId: body.modelRouteId } : {}),
        ...(body.reasoning !== undefined ? { reasoning: body.reasoning } : {}),
        ...(body.draftText !== undefined ? { draftText: body.draftText } : {}),
      },
    );
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(sessionDto(updated));
  });

  app.delete("/api/agents/:id/cloud/sessions/:sid", async (c) => {
    const session = c.get("session")!;
    const ok = await store.deleteSession(
      session.tenantId,
      c.req.param("id"),
      c.req.param("sid"),
    );
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  /** 发送用户消息并启动 Run；parentRunId 指定分支父节点（编辑重发=兄弟分支） */
  app.post("/api/agents/:id/cloud/sessions/:sid/messages", async (c) => {
    if (!modelRouter) {
      return c.json({ error: "模型路由未启用，请先配置 chat 上游" }, 400);
    }
    const session = c.get("session")!;
    const sourceSession = await store.getSession(
      session.tenantId,
      c.req.param("id"),
      c.req.param("sid"),
    );
    if (!sourceSession) return c.json({ error: "Not found" }, 404);
    if (await isOpenAiGatewaySession(session.tenantId, c.req.param("id"), c.req.param("sid"))) {
      return c.json(
        { error: "OpenAI Gateway 会话只能 fork 后在 Chat 中继续，原会话不会被修改" },
        403,
      );
    }
    const body = await c.req.json<{
      content?: string;
      parentRunId?: string | null;
      attachments?: CloudAgentAttachment[];
      options?: unknown;
    }>();
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (!body.content?.trim() && attachments.length === 0) {
      return c.json({ error: "content 必填" }, 400);
    }
    const options = parseRunOptions(body.options);
    try {
      const result = await runtime.startTurn({
        tenantId: session.tenantId,
        agentId: c.req.param("id"),
        sessionId: c.req.param("sid"),
        content: body.content ?? "",
        ...("parentRunId" in body ? { parentRunId: body.parentRunId ?? null } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(options ? { options } : {}),
      });
      return c.json(result, 202);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** 重新生成：针对某条用户消息再跑一个回答变体（缺省为最后一条） */
  app.post("/api/agents/:id/cloud/sessions/:sid/regenerate", async (c) => {
    if (!modelRouter) {
      return c.json({ error: "模型路由未启用，请先配置 chat 上游" }, 400);
    }
    const session = c.get("session")!;
    if (await isOpenAiGatewaySession(session.tenantId, c.req.param("id"), c.req.param("sid"))) {
      return c.json({ error: "OpenAI Gateway 会话只能 fork 后继续" }, 403);
    }
    const body = await c.req
      .json<{ messageId?: string; options?: unknown }>()
      .catch(() => ({}) as { messageId?: string; options?: unknown });
    const options = parseRunOptions(body.options);
    try {
      const result = await runtime.startTurn({
        tenantId: session.tenantId,
        agentId: c.req.param("id"),
        sessionId: c.req.param("sid"),
        ...(body.messageId
          ? { regenerateOfMessageId: body.messageId }
          : { retry: true }),
        ...(options ? { options } : {}),
      });
      return c.json(result, 202);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** 重试：不追加用户消息，基于现有历史重新运行（用于失败后重来/重新生成） */
  app.post("/api/agents/:id/cloud/sessions/:sid/retry", async (c) => {
    if (!modelRouter) {
      return c.json({ error: "模型路由未启用，请先配置 chat 上游" }, 400);
    }
    const session = c.get("session")!;
    if (await isOpenAiGatewaySession(session.tenantId, c.req.param("id"), c.req.param("sid"))) {
      return c.json({ error: "OpenAI Gateway 会话只能 fork 后继续" }, 403);
    }
    const body = await c.req
      .json<{ options?: unknown }>()
      .catch(() => ({}) as { options?: unknown });
    const options = parseRunOptions(body.options);
    try {
      const result = await runtime.startTurn({
        tenantId: session.tenantId,
        agentId: c.req.param("id"),
        sessionId: c.req.param("sid"),
        retry: true,
        ...(options ? { options } : {}),
      });
      return c.json(result, 202);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/cloud/sessions/:sid/cancel", async (c) => {
    const session = c.get("session")!;
    const sid = c.req.param("sid");
    const row = await store.getSession(session.tenantId, c.req.param("id"), sid);
    if (!row) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json<{ runId?: string }>().catch(() => ({} as { runId?: string }));
    const ok = await store.requestCancel(sid, body.runId ?? row.activeRunId);
    return c.json({ ok, runId: body.runId ?? row.activeRunId });
  });

  /** 手动压缩当前会话上下文；原始事件保留，后续 Run 优先使用摘要。 */
  app.post("/api/agents/:id/cloud/sessions/:sid/compact", async (c) => {
    if (!modelRouter || !runtime.compactSession) {
      return c.json({ error: "模型路由未启用，请先配置 chat 上游" }, 400);
    }
    const session = c.get("session")!;
    if (await isOpenAiGatewaySession(session.tenantId, c.req.param("id"), c.req.param("sid"))) {
      return c.json({ error: "OpenAI Gateway 会话只能 fork，不能修改原会话" }, 403);
    }
    try {
      const result = await runtime.compactSession({
        tenantId: session.tenantId,
        agentId: c.req.param("id"),
        sessionId: c.req.param("sid"),
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /**
   * 从已有会话派生新会话：写入摘要作为早前上下文，便于「续聊」而不污染原会话。
   * Body: { title?: string }
   */
  app.post("/api/agents/:id/cloud/sessions/:sid/fork", async (c) => {
    if (!modelRouter || !runtime.forkSession) {
      return c.json({ error: "模型路由未启用，请先配置 chat 上游" }, 400);
    }
    const session = c.get("session")!;
    const agentId = c.req.param("id");
    const sid = c.req.param("sid");
    const row = await store.getSession(session.tenantId, agentId, sid);
    if (!row) return c.json({ error: "Not found" }, 404);
    const body = await c.req
      .json<{ title?: string }>()
      .catch(() => ({}) as { title?: string });
    try {
      const result = await runtime.forkSession({
        tenantId: session.tenantId,
        agentId,
        sourceSessionId: sid,
        title: body.title,
        createdByUserId: session.userId === "api-key" ? null : session.userId,
      });
      const created = await store.getSession(session.tenantId, agentId, result.sessionId);
      return c.json(
        {
          ...result,
          session: created ? sessionDto(created) : null,
        },
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /**
   * 持久事件流（SSE）。
   * Query: afterSeq — 只推送 seq > afterSeq 的事件；断线重连传上次收到的 seq。
   */
  app.get("/api/agents/:id/cloud/sessions/:sid/events", async (c) => {
    const session = c.get("session")!;
    const agentId = c.req.param("id");
    const sid = c.req.param("sid");
    const row = await store.getSession(session.tenantId, agentId, sid);
    if (!row) return c.json({ error: "Not found" }, 404);

    const afterRaw = Number(c.req.query("afterSeq") ?? "0");
    let cursor = Number.isFinite(afterRaw) ? afterRaw : 0;

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        };

        try {
          const backlog = await store.listEvents(sid, { afterSeq: cursor });
          for (const ev of backlog) {
            send("cloud", ev);
            cursor = Math.max(cursor, ev.seq);
          }
          send("ready", { sessionId: sid, afterSeq: cursor });

          unsubscribe = store.subscribe(sid, (ev) => {
            if (ev.seq <= cursor) return;
            send("cloud", ev);
            cursor = ev.seq;
          });

          heartbeat = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(`: ping\n\n`));
            } catch {
              /* ignore */
            }
          }, 15_000);
        } catch (err) {
          send("error", {
            message: err instanceof Error ? err.message : String(err),
          });
          controller.close();
        }
      },
      cancel() {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
