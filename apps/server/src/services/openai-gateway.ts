import type {
  CloudAgentEvent,
  ModelChatContentPart,
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
  ModelToolCall,
  ModelToolChoice,
  ModelToolDefinition,
} from "@zakura/shared";
import { newId, type Agent } from "../db/schema.js";
import type { AgentService } from "./agents.js";
import { agentCloudConfig } from "./cloud-agent/runtime.js";
import type { CloudAgentSessionStore } from "./cloud-agent-session.js";
import { DeltaPublisher } from "./cloud-agent/loop.js";
import type { ModelRouterService } from "./model-router.js";
import { parseRouteOptions } from "../model-router/types.js";
import { readGwClientSession, writeGwClientSession } from "./redis-store.js";

/** 无客户端 session 头时，只在最近空闲窗口内做 messages 归并 */
const GATEWAY_MATCH_IDLE_MS = 2 * 60 * 60 * 1000;

function gatewayTimingEnabled(): boolean {
  return process.env.ZAKURA_HTTP_TIMING === "1" || process.env.ZAKURA_GATEWAY_TIMING === "1";
}

export type OpenAiGatewayBody = {
  model?: unknown;
  stream?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  toolChoice?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  maxTokens?: unknown;
  top_p?: unknown;
  topP?: unknown;
  stop?: unknown;
  presence_penalty?: unknown;
  presencePenalty?: unknown;
  frequency_penalty?: unknown;
  frequencyPenalty?: unknown;
  seed?: unknown;
  n?: unknown;
  response_format?: unknown;
  responseFormat?: unknown;
  stream_options?: unknown;
  streamOptions?: unknown;
  logit_bias?: unknown;
  logitBias?: unknown;
  user?: unknown;
  metadata?: unknown;
  reasoning_effort?: unknown;
  routeOptions?: unknown;
  route_options?: unknown;
  reasoning?: unknown;
  extensions?: unknown;
};

export type OpenAiGatewayContext = {
  agent: Agent;
  sessionId: string;
  runId: string;
  model: string | undefined;
  routeId: string | undefined;
  messages: ModelChatMessage[];
  invokeOptions: ModelChatInvokeOptions;
  /** 会话首轮（用于临时标题 / 自动标题） */
  isFirstTurn: boolean;
};

export type OpenAiGatewayPrepareOptions = {
  clientSessionKey?: string | null;
  apiKeyId?: string | null;
};

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function parseContent(raw: unknown): {
  content: string | null;
  parts?: ModelChatContentPart[];
} {
  if (typeof raw === "string" || raw == null) {
    return { content: typeof raw === "string" ? raw : null };
  }
  if (!Array.isArray(raw)) return { content: null };
  const parts: ModelChatContentPart[] = [];
  for (const item of raw) {
    const part = asRecord(item);
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      const image = asRecord(part.image_url ?? part.imageUrl);
      if (typeof image.url === "string" && image.url.trim()) {
        parts.push({ type: "image_url", imageUrl: { url: image.url } });
      }
    }
  }
  const text = parts
    .filter((part): part is Extract<ModelChatContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return { content: text || null, ...(parts.length ? { parts } : {}) };
}

function parseToolCalls(raw: unknown): ModelToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const calls: ModelToolCall[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const fn = asRecord(record.function);
    if (typeof fn.name !== "string" || !fn.name.trim()) continue;
    calls.push({
      id: typeof record.id === "string" && record.id ? record.id : `call_${calls.length}`,
      type: "function",
      function: {
        name: fn.name,
        arguments:
          typeof fn.arguments === "string"
            ? fn.arguments
            : JSON.stringify(fn.arguments ?? {}),
      },
    });
  }
  return calls.length ? calls : undefined;
}

function parseMessages(raw: unknown): ModelChatMessage[] {
  if (!Array.isArray(raw)) throw new Error("messages 必须是数组");
  const messages: ModelChatMessage[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    // `developer` is part of the current OpenAI Chat Completions contract.
    // The internal router deliberately has one instruction role (`system`), so
    // preserve its ordering and semantics by normalising it at the boundary.
    // In particular Hermes sends developer messages when talking to an
    // OpenAI-compatible endpoint; rejecting them here made Zakura routing
    // fail before a model request was ever attempted.
    const role =
      record.role === "developer"
        ? "system"
        : record.role === "system" ||
            record.role === "user" ||
            record.role === "assistant" ||
            record.role === "tool"
          ? record.role
          : null;
    if (!role) throw new Error("messages 中存在无效 role");
    const parsed = parseContent(record.content);
    messages.push({
      role,
      content: parsed.content,
      ...(parsed.parts ? { parts: parsed.parts } : {}),
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.tool_call_id === "string"
        ? { toolCallId: record.tool_call_id }
        : typeof record.toolCallId === "string"
          ? { toolCallId: record.toolCallId }
          : {}),
      ...(parseToolCalls(record.tool_calls ?? record.toolCalls)
        ? { toolCalls: parseToolCalls(record.tool_calls ?? record.toolCalls) }
        : {}),
    });
  }
  if (messages.length === 0) throw new Error("messages 不能为空");
  return messages;
}

function parseTools(raw: unknown): ModelToolDefinition[] {
  if (!Array.isArray(raw)) return [];
  const tools: ModelToolDefinition[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const fn = asRecord(record.function);
    if (record.type !== "function" || typeof fn.name !== "string" || !fn.name.trim()) continue;
    tools.push({
      type: "function",
      function: {
        name: fn.name.trim().slice(0, 64),
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        parameters:
          fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
            ? (fn.parameters as Record<string, unknown>)
            : { type: "object", properties: {} },
        ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
      },
    });
  }
  return tools;
}

function parseToolChoice(raw: unknown): ModelToolChoice | undefined {
  if (raw === "auto" || raw === "none" || raw === "required") return raw;
  const record = asRecord(raw);
  const fn = asRecord(record.function);
  if (record.type === "function" && typeof fn.name === "string" && fn.name.trim()) {
    return { type: "function", function: { name: fn.name.trim() } };
  }
  return undefined;
}

function parseGatewayExtensions(body: OpenAiGatewayBody): Record<string, unknown> {
  const extensions = { ...asRecord(body.extensions) };
  const aliases: Array<[string, unknown, string]> = [
    ["top_p", body.top_p ?? body.topP, "top_p"],
    ["stop", body.stop, "stop"],
    ["presence_penalty", body.presence_penalty ?? body.presencePenalty, "presence_penalty"],
    ["frequency_penalty", body.frequency_penalty ?? body.frequencyPenalty, "frequency_penalty"],
    ["seed", body.seed, "seed"],
    ["logit_bias", body.logit_bias ?? body.logitBias, "logit_bias"],
    ["user", body.user, "user"],
    ["response_format", body.response_format ?? body.responseFormat, "response_format"],
    // stream_options 只对 stream=true 合法；Gateway 内部常走非流式 chat，绝不能透传
  ];
  for (const [, value, key] of aliases) {
    if (value !== undefined) extensions[key] = value;
  }
  // 显式丢掉客户端带来的 stream_options，避免上游 400
  delete extensions.stream_options;
  delete extensions.streamOptions;
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort.trim()) {
    const reasoning = asRecord(body.reasoning);
    extensions.reasoning = {
      ...reasoning,
      effort: body.reasoning_effort.trim(),
    };
  }
  return extensions;
}

function lastUserContent(messages: ModelChatMessage[]): string {
  const message = [...messages].reverse().find((item) => item.role === "user");
  return message?.content?.trim() || "";
}

function normalizeUserText(content: string | null | undefined): string {
  return (content ?? "").replace(/\s+/g, " ").trim();
}

/** 只取 user 文本序列做会话指纹：忽略 assistant 差异（工具调用/空回复会导致全文前缀对不上） */
export function userContentFingerprint(messages: ModelChatMessage[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = normalizeUserText(message.content);
    if (text) out.push(text);
  }
  return out;
}

/** 两边 user 序列的公共前缀长度 */
export function userFingerprintPrefixLen(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * 判断客户端 messages 是否应归并到已有会话。
 * - 只比 user 内容，避免 assistant/tool 回显不一致导致合不上
 * - 支持「客户端历史更长」（续聊）和「客户端更短」（重试/只发最新一句）
 */
export function scoreGatewayMessageMatch(
  storedUsers: string[],
  clientUsers: string[],
): number {
  if (storedUsers.length === 0 || clientUsers.length === 0) return 0;
  const prefix = userFingerprintPrefixLen(storedUsers, clientUsers);
  if (prefix === 0) return 0;
  // 必须从首条 user 对齐；公共前缀越长越好；完全互相为前缀再加分
  let score = prefix * 100;
  if (prefix === storedUsers.length || prefix === clientUsers.length) score += 10;
  if (storedUsers[storedUsers.length - 1] === clientUsers[clientUsers.length - 1]) {
    score += 1;
  }
  return score;
}

function cleanSessionKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value ? value.slice(0, 200) : null;
}

/** 从 Claude Code metadata.user_id 抽出 session id（兼容 JSON / legacy 字符串格式） */
export function extractClaudeCodeSessionId(userId: unknown): string | null {
  if (typeof userId !== "string" || !userId.trim()) return null;
  const raw = userId.trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    const fromJson = cleanSessionKey(record.session_id ?? record.sessionId);
    if (fromJson) return fromJson;
  } catch {
    /* not JSON */
  }
  const legacy = /_session_(.+)$/.exec(raw);
  return cleanSessionKey(legacy?.[1] ?? null);
}

/**
 * 读取通用客户端已经会发的会话标识，不发明 Zakura 专用协议。
 * 优先级对齐常见网关（Claude Code → Codex → 通用 X-Session-Id → body.metadata）。
 */
export function resolveClientSessionKey(
  headers: Headers | { get(name: string): string | undefined },
  body: OpenAiGatewayBody,
): string | null {
  const headerNames = [
    "x-claude-code-session-id",
    "session-id",
    "session_id",
    "thread-id",
    "thread_id",
    "x-session-id",
    "x-client-session-id",
  ];
  for (const name of headerNames) {
    const value = cleanSessionKey(headers.get(name));
    if (value) return value;
  }

  const metadata = asRecord(body.metadata);
  const fromMeta = cleanSessionKey(metadata.session_id ?? metadata.sessionId);
  if (fromMeta) return fromMeta;

  const fromClaude = extractClaudeCodeSessionId(metadata.user_id ?? metadata.userId);
  if (fromClaude) return fromClaude;

  return null;
}

export function resolveGatewayModel(raw: unknown, fallback?: string): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback?.trim() || undefined;
}

/** O(1) 模型名转发；map 未配置或未命中时原样返回。 */
export function rewriteGatewayModel(
  model: string | undefined,
  map?: Record<string, string>,
): string | undefined {
  if (!model || !map) return model;
  const rewritten = map[model];
  return rewritten?.trim() || model;
}

/**
 * 薄代理：鉴权 / 模型路由 / 会话落库；透传客户端 messages+tools，不注入云端工具、不代执行。
 */
export class OpenAiGatewayService {
  constructor(
    private readonly deps: {
      agentService: AgentService;
      modelRouter: ModelRouterService;
      store: CloudAgentSessionStore;
    },
  ) {}

  async prepare(
    tenantId: string,
    agentId: string,
    body: OpenAiGatewayBody,
    opts?: OpenAiGatewayPrepareOptions,
  ): Promise<OpenAiGatewayContext> {
    const t0 = performance.now();
    const timing = gatewayTimingEnabled();
    const marks: string[] = [];
    const mark = (label: string) => {
      if (timing) marks.push(`${label}=${(performance.now() - t0).toFixed(0)}`);
    };

    const agent = await this.deps.agentService.get(tenantId, agentId);
    if (!agent) throw new Error("Agent 不存在");
    mark("agent");
    const cloud = agentCloudConfig(agent);
    const messages = parseMessages(body.messages);
    const clientTools = parseTools(body.tools);
    const clientModelRaw = resolveGatewayModel(body.model);
    const clientModel = rewriteGatewayModel(clientModelRaw, cloud.gatewayModelMap);
    const model =
      clientModel ??
      rewriteGatewayModel(resolveGatewayModel(undefined, cloud.model), cloud.gatewayModelMap);
    if (body.n !== undefined && body.n !== 1) {
      throw new Error("Gateway 目前只支持 n=1");
    }

    const sessionPromise = this.getOrCreateSession({
      tenantId,
      agent,
      clientSessionKey: opts?.clientSessionKey,
      apiKeyId: opts?.apiKeyId,
      model,
      clientMessages: messages,
    });
    const routeIdForWarm = clientModel ? undefined : cloud.modelRouteId?.trim() || undefined;
    const routeWarmPromise = this.deps.modelRouter
      .resolveRoute(tenantId, {
        capability: "chat",
        ...(routeIdForWarm ? { routeId: routeIdForWarm } : {}),
        ...(model ? { alias: model } : {}),
      })
      .catch(() => null);

    const [session] = await Promise.all([sessionPromise, routeWarmPromise]);
    mark("parallel");

    const routeOptions = parseRouteOptions({
      ...asRecord(body.routeOptions ?? body.route_options),
      ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
      ...(typeof body.max_tokens === "number" ? { maxTokens: body.max_tokens } : {}),
      ...(typeof body.max_completion_tokens === "number"
        ? { maxTokens: body.max_completion_tokens }
        : {}),
      ...(typeof body.maxTokens === "number" ? { maxTokens: body.maxTokens } : {}),
      reasoning: body.reasoning ?? asRecord(body.routeOptions ?? body.route_options).reasoning,
    });
    const extensions = parseGatewayExtensions(body);
    const invokeOptions: ModelChatInvokeOptions = {
      ...(clientTools.length ? { tools: clientTools } : {}),
      ...(parseToolChoice(body.tool_choice ?? body.toolChoice)
        ? { toolChoice: parseToolChoice(body.tool_choice ?? body.toolChoice) }
        : {}),
      ...(Object.keys(routeOptions).length ? { routeOptions } : {}),
      ...(Object.keys(extensions).length ? { extensions } : {}),
    };

    await this.deps.store.warmSession(session.id, {
      tenantId: session.tenantId,
      agentId: session.agentId,
      lastSeq: session.lastSeq,
    });
    const isFirstTurn = session.lastSeq === 0;
    const messageId = newId();
    const runId = newId();
    // skipFlush：热路径不挡首字；parentRunId / 去重指纹读环即可
    const recentEvents = await this.deps.store.listEvents(session.id, {
      limit: 40,
      skipFlush: true,
    });
    const parentRunId = this.extractParentRunId(recentEvents);
    const lastStoredUser = this.extractLastStoredUserContent(recentEvents);
    const userContent = lastUserContent(messages);
    // 同一 user 已落库、助手尚未写出（重试）时不要重复追加
    const skipUserAppend =
      Boolean(userContent) && lastStoredUser !== null && lastStoredUser === userContent;
    let replyToMessageId = messageId;
    if (skipUserAppend) {
      replyToMessageId = this.extractLastUserMessageId(recentEvents) ?? messageId;
    }
    // 模型上下文来自请求体，不依赖这两条落库；串行写但不 await，让 invoke 立刻开流
    void (async () => {
      try {
        if (!skipUserAppend) {
          // 首轮临时标题，跑完后再由 autoTitle 润色
          if (isFirstTurn && session.title === "OpenAI Gateway" && userContent) {
            const title =
              userContent.length > 40 ? `${userContent.slice(0, 40)}…` : userContent;
            await this.deps.store.updateSession(tenantId, agent.id, session.id, { title });
          }
          await this.deps.store.appendEvent({
            sessionId: session.id,
            type: "user_message",
            runId,
            payload: {
              messageId,
              content: userContent,
              parentRunId,
            },
          });
        }
        await this.deps.store.appendEvent({
          sessionId: session.id,
          type: "run_start",
          runId,
          payload: { runId, replyToMessageId },
        });
      } catch (err) {
        console.warn(
          "[openai-gateway] session bookkeeping failed:",
          err instanceof Error ? err.message : err,
        );
      }
    })();
    mark("session");
    if (timing) {
      console.warn(`[gateway] prepare ${marks.join(" ")} total=${(performance.now() - t0).toFixed(0)}ms`);
    }

    return {
      agent,
      sessionId: session.id,
      runId,
      model,
      routeId: clientModel ? undefined : cloud.modelRouteId?.trim() || undefined,
      messages,
      invokeOptions,
      isFirstTurn,
    };
  }

  async invoke(
    tenantId: string,
    context: OpenAiGatewayContext,
    callbacks?: {
      onDelta?: (text: string) => void;
      onReasoningDelta?: (text: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<ModelChatResult> {
    try {
      if (callbacks?.signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }

      const routeQuery = {
        capability: "chat" as const,
        ...(context.routeId ? { routeId: context.routeId } : {}),
        ...(context.model ? { alias: context.model } : {}),
      };

      const messageId = newId();
      const publisher = new DeltaPublisher(
        this.deps.store,
        context.sessionId,
        context.runId,
        messageId,
      );
      const reasoningPublisher = new DeltaPublisher(
        this.deps.store,
        context.sessionId,
        context.runId,
        messageId,
        "reasoning_delta",
      );

      const result = callbacks
        ? await this.deps.modelRouter.chatStream(
            tenantId,
            context.messages,
            routeQuery,
            context.invokeOptions,
            {
              onDelta: (text) => {
                callbacks.onDelta?.(text);
                publisher.push(text);
              },
              onReasoningDelta: (text) => {
                callbacks.onReasoningDelta?.(text);
                reasoningPublisher.push(text);
              },
              signal: callbacks.signal,
            },
          )
        : await this.deps.modelRouter.chat(
            tenantId,
            context.messages,
            routeQuery,
            context.invokeOptions,
          );
      await publisher.drain();
      await reasoningPublisher.drain();
      if (!callbacks && result.content) {
        publisher.push(result.content);
        await publisher.drain();
      }

      await this.deps.store.appendEvent({
        sessionId: context.sessionId,
        type: "assistant_message",
        runId: context.runId,
        payload: {
          messageId,
          content: result.content ?? "",
          ...(result.toolCalls?.length ? { toolCalls: result.toolCalls } : {}),
        },
      });
      await this.deps.store.appendEvent({
        sessionId: context.sessionId,
        type: "run_end",
        runId: context.runId,
        payload: { runId: context.runId, status: "completed" },
      });
      const routeId =
        "routeId" in result && typeof result.routeId === "string" ? result.routeId : null;
      await this.deps.store.updateSession(tenantId, context.agent.id, context.sessionId, {
        model: result.model || context.model || null,
        modelRouteId: routeId,
      });
      if (context.isFirstTurn) {
        void this.maybeAutoTitle({
          tenantId,
          agent: context.agent,
          sessionId: context.sessionId,
          runId: context.runId,
          userContent: lastUserContent(context.messages),
          assistantContent: result.content ?? "",
        });
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.deps.store.appendEvent({
          sessionId: context.sessionId,
          type: "run_error",
          runId: context.runId,
          payload: { runId: context.runId, message },
        });
        await this.deps.store.appendEvent({
          sessionId: context.sessionId,
          type: "run_end",
          runId: context.runId,
          payload: { runId: context.runId, status: "failed" },
        });
      } catch {
        /* 收尾失败不掩盖原始错误 */
      }
      throw err;
    }
  }

  /** 首轮完成后后台生成标题；失败静默，不拖慢 Gateway 响应 */
  private async maybeAutoTitle(input: {
    tenantId: string;
    agent: Agent;
    sessionId: string;
    runId: string;
    userContent: string;
    assistantContent: string;
  }): Promise<void> {
    const cloud = agentCloudConfig(input.agent);
    if (cloud.autoTitle === false || !input.userContent.trim()) return;
    try {
      const res = await this.deps.modelRouter.chat(
        input.tenantId,
        [
          {
            role: "system",
            content:
              "为这段对话生成一个简短标题：中文优先、不超过 16 个字、不含引号和句号，直接输出标题本身。",
          },
          {
            role: "user",
            content: `用户：${input.userContent.slice(0, 800)}\n\n助手：${input.assistantContent.slice(0, 800)}`,
          },
        ],
        {
          capability: "chat",
          ...(cloud.modelRouteId
            ? { routeId: cloud.modelRouteId }
            : cloud.model
              ? { alias: cloud.model }
              : {}),
        },
      );
      const title = (res.content ?? "")
        .trim()
        .replace(/^["'「『]+|["'」』。]+$/g, "")
        .split("\n")[0]
        ?.slice(0, 24);
      if (!title) return;
      await this.deps.store.updateSession(
        input.tenantId,
        input.agent.id,
        input.sessionId,
        { title },
      );
      await this.deps.store.appendEvent({
        sessionId: input.sessionId,
        type: "session_update",
        runId: input.runId,
        payload: { title },
      });
    } catch (err) {
      console.warn(
        "[openai-gateway] autoTitle failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** 从上一条助手消息推断 parentRunId；旧 Gateway 无 runId 时用 orphan: 对齐 UI 合成规则 */
  private extractParentRunId(events: CloudAgentEvent[]): string | null {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]!;
      if (ev.runId) return ev.runId;
      if (ev.type === "assistant_message") {
        const payload = ev.payload as Record<string, unknown>;
        const mid = typeof payload.messageId === "string" ? payload.messageId : ev.id;
        return `orphan:${mid}`;
      }
    }
    return null;
  }

  /** 只取最近 user 文本指纹，避免为匹配会话拉全量历史 */
  private async loadRecentUserFingerprint(sessionId: string): Promise<string[]> {
    const events = await this.deps.store.listEvents(sessionId, {
      limit: 60,
      skipFlush: true,
    });
    const users: string[] = [];
    for (const ev of events) {
      if (ev.type !== "user_message") continue;
      const content = (ev.payload as Record<string, unknown>).content;
      if (typeof content === "string" && content.trim()) users.push(content.trim());
    }
    return users;
  }

  private extractLastStoredUserContent(events: CloudAgentEvent[]): string | null {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]!;
      if (ev.type !== "user_message") continue;
      const content = (ev.payload as Record<string, unknown>).content;
      return typeof content === "string" ? content : "";
    }
    return null;
  }

  private extractLastUserMessageId(events: CloudAgentEvent[]): string | null {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]!;
      if (ev.type !== "user_message") continue;
      const payload = ev.payload as Record<string, unknown>;
      if (typeof payload.messageId === "string") return payload.messageId;
      return ev.id;
    }
    return null;
  }

  private async getOrCreateSession(input: {
    tenantId: string;
    agent: Agent;
    clientSessionKey?: string | null;
    apiKeyId?: string | null;
    model: string | undefined;
    clientMessages: ModelChatMessage[];
  }) {
    const key = cleanSessionKey(input.clientSessionKey);
    const apiKeyId = cleanSessionKey(input.apiKeyId);

    if (key) {
      const cachedId = await readGwClientSession(input.agent.id, key);
      if (cachedId) {
        const cached = await this.deps.store.getSession(
          input.tenantId,
          input.agent.id,
          cachedId,
        );
        if (cached && this.isGatewayOrigin(cached.originJson)) return cached;
      }

      const byId = await this.deps.store.getSession(input.tenantId, input.agent.id, key);
      if (byId && this.isGatewayOrigin(byId.originJson)) {
        void writeGwClientSession(input.agent.id, key, byId.id);
        return byId;
      }

      const byClientKey = await this.findGatewaySession(
        input.tenantId,
        input.agent.id,
        (origin) => origin.clientSessionKey === key,
      );
      if (byClientKey) {
        void writeGwClientSession(input.agent.id, key, byClientKey.id);
        return byClientKey;
      }

      const created = await this.deps.store.createSession({
        tenantId: input.tenantId,
        agentId: input.agent.id,
        title: "OpenAI Gateway",
        createdByUserId: null,
        origin: {
          source: "api",
          channel: "openai-gateway",
          clientSessionKey: key,
          ...(apiKeyId ? { apiKeyId } : {}),
        },
        model: input.model ?? null,
      });
      void writeGwClientSession(input.agent.id, key, created.id);
      return created;
    }

    // ponytail: 无 client session 时最多比对最近 3 个空闲会话的近期 user 指纹（不再 30×2000）
    const clientUsers = userContentFingerprint(input.clientMessages);
    if (clientUsers.length > 0) {
      const recent = await this.deps.store.listGatewaySessions(
        input.tenantId,
        input.agent.id,
        { limit: 3 },
      );
      const candidates = recent.filter((session) => {
        const updated = +new Date(session.updatedAt);
        return Number.isFinite(updated) && Date.now() - updated <= GATEWAY_MATCH_IDLE_MS;
      });
      const fingerprints = await Promise.all(
        candidates.map((session) => this.loadRecentUserFingerprint(session.id)),
      );
      let best: (typeof recent)[number] | null = null;
      let bestScore = 0;
      for (let i = 0; i < candidates.length; i += 1) {
        const score = scoreGatewayMessageMatch(fingerprints[i]!, clientUsers);
        if (score > bestScore) {
          bestScore = score;
          best = candidates[i]!;
        }
      }
      if (best) return best;
    }

    return this.deps.store.createSession({
      tenantId: input.tenantId,
      agentId: input.agent.id,
      title: "OpenAI Gateway",
      createdByUserId: null,
      origin: {
        source: "api",
        channel: "openai-gateway",
        ...(apiKeyId ? { apiKeyId } : {}),
      },
      model: input.model ?? null,
    });
  }

  private isGatewayOrigin(originJson: string | null | undefined): boolean {
    try {
      const origin = JSON.parse(originJson || "{}") as Record<string, unknown>;
      return origin.channel === "openai-gateway";
    } catch {
      return false;
    }
  }

  private async findGatewaySession(
    tenantId: string,
    agentId: string,
    match: (
      origin: Record<string, unknown>,
      session: { id: string; updatedAt: string | Date; originJson: string },
    ) => boolean,
  ) {
    const recent = await this.deps.store.listGatewaySessions(tenantId, agentId, {
      limit: 50,
    });
    for (const session of recent) {
      try {
        const origin = JSON.parse(session.originJson || "{}") as Record<string, unknown>;
        if (origin.channel !== "openai-gateway") continue;
        if (match(origin, session)) return session;
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}
