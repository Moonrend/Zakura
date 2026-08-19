import type { Context, Hono } from "hono";
import { randomUUID } from "node:crypto";
import { parseCloudAgentConfig } from "@zakura/shared";
import type { AppVariables } from "./routes.js";
import { authenticateApiKey, extractBearer, hasApiKeyScope } from "../services/auth.js";
import type { AgentService } from "../services/agents.js";
import type { Db } from "../db/client.js";
import type { OpenAiGatewayBody, OpenAiGatewayService } from "../services/openai-gateway.js";
import { resolveClientSessionKey } from "../services/openai-gateway.js";
import {
  itemId,
  responsesEvent,
  responsesId,
  translateResponsesRequest,
} from "../services/openai-gateway-responses.js";
import type { UpstreamModelsService } from "../services/upstream-models.js";

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * /v1/models 透出的模型元数据子集。字段名沿用 ModelCatalogEntry
 * （contextLimit / outputLimit / reasoning / toolCall / attachment），
 * 由 ACP 适配器侧映射进 opencode.json 的 limit / reasoning。仅在字段
 * 为有限数 / 布尔时写入，避免把空值塞给客户端。
 */
type GatewayModelMetadata = {
  contextLimit?: number;
  outputLimit?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  attachment?: boolean;
};

function pickModelMetadata(
  meta: Record<string, unknown> | undefined,
): { metadata?: GatewayModelMetadata } {
  if (!meta) return {};
  const out: GatewayModelMetadata = {};
  if (typeof meta.contextLimit === "number" && Number.isFinite(meta.contextLimit) && meta.contextLimit > 0) {
    out.contextLimit = meta.contextLimit;
  }
  if (typeof meta.outputLimit === "number" && Number.isFinite(meta.outputLimit) && meta.outputLimit > 0) {
    out.outputLimit = meta.outputLimit;
  }
  if (typeof meta.reasoning === "boolean") out.reasoning = meta.reasoning;
  if (typeof meta.toolCall === "boolean") out.toolCall = meta.toolCall;
  if (typeof meta.attachment === "boolean") out.attachment = meta.attachment;
  return Object.keys(out).length ? { metadata: out } : {};
}

function asRecordBody(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

type GatewayErrorStatus = 400 | 401 | 403 | 404 | 422 | 500;

function openAiError(
  c: Context<{ Variables: AppVariables }>,
  message: string,
  status: GatewayErrorStatus,
  type = status >= 500 ? "server_error" : "invalid_request_error",
  code?: string,
) {
  return c.json(
    {
      error: {
        message,
        type,
        param: null,
        ...(code ? { code } : {}),
      },
    },
    status,
  );
}

/** Gateway 不拆分子权限：任一 gateway scope（或 *）即可访问全部 /v1 接口。 */
function hasGatewayAccess(apiKey: { scopes: string }): boolean {
  return (
    hasApiKeyScope(apiKey, "gateway") ||
    hasApiKeyScope(apiKey, "gateway:models") ||
    hasApiKeyScope(apiKey, "gateway:chat")
  );
}

async function authenticateGatewayRequest(
  c: Context<{ Variables: AppVariables }>,
  db: Db,
) {
  const raw = extractBearer(c.req.header("authorization")) ?? c.req.header("x-api-key");
  if (!raw) {
    if (process.env.ZAKURA_GATEWAY_DEBUG) {
      console.warn("[gateway] missing authentication header", {
        path: new URL(c.req.url).pathname,
        userAgent: c.req.header("user-agent") ?? "",
      });
    }
    return { response: openAiError(c, "缺少 API Key", 401, "authentication_error") };
  }
  const keyed = await authenticateApiKey(db, raw);
  if (!keyed) {
    return { response: openAiError(c, "API Key 无效或已过期", 401, "authentication_error") };
  }
  if (!keyed.apiKey.agentId) {
    return { response: openAiError(c, "该 API Key 未绑定 Agent", 403, "permission_error") };
  }
  if (!hasGatewayAccess(keyed.apiKey)) {
    return {
      response: openAiError(
        c,
        "API Key 缺少 Gateway 权限",
        403,
        "permission_error",
        "insufficient_scope",
      ),
    };
  }
  return { keyed };
}

export function registerOpenAiGatewayRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: {
    db: Db;
    agentService: AgentService;
    gateway: OpenAiGatewayService;
    upstreamModels?: UpstreamModelsService;
  },
) {
  app.get("/v1/models", async (c) => {
    const auth = await authenticateGatewayRequest(c, deps.db);
    if ("response" in auth) return auth.response;
    const agent = await deps.agentService.get(auth.keyed.tenant.id, auth.keyed.apiKey.agentId!);
    if (!agent) return openAiError(c, "Agent 不存在", 404, "not_found_error");

    const configured = deps.upstreamModels
      ? await deps.upstreamModels.list(auth.keyed.tenant.id, { capability: "chat" })
      : [];
    const names = new Set<string>();
    // 按 canonicalModel 索引模型目录元数据，供 /v1/models 透出给 ACP 适配器
    // （OpenCode 据此填充 opencode.json 的 limit.context / reasoning，避免
    // "Model metadata for ... not found" 回退告警）。metaJson 存的是
    // ModelCatalogEntry 形状，含 contextLimit / outputLimit / reasoning 等。
    const metaById = new Map<string, Record<string, unknown>>();
    for (const row of configured) {
      const id = row.canonicalModel.trim();
      if (id && !metaById.has(id)) metaById.set(id, row.meta ?? {});
    }
    const data: Array<{
      id: string;
      object: "model";
      created: number;
      owned_by: string;
      metadata?: GatewayModelMetadata;
    }> = [];
    for (const row of configured) {
      const id = row.canonicalModel.trim();
      if (!id || names.has(id)) continue;
      names.add(id);
      const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
      data.push({
        id,
        object: "model",
        created: Number.isFinite(createdAt.getTime()) ? Math.floor(createdAt.getTime() / 1000) : 0,
        owned_by: "zakura",
        ...pickModelMetadata(metaById.get(id)),
      });
    }
    if (data.length === 0) {
      try {
        const raw = JSON.parse(agent.configJson || "{}") as unknown;
        const model = parseCloudAgentConfig(raw).model?.trim();
        if (model) data.push({ id: model, object: "model", created: 0, owned_by: "zakura" });
      } catch {
        /* malformed Agent config is handled by the empty model list */
      }
    }
    // 暴露转发源名称，便于 Codex 等客户端选到配置的别名
    try {
      const map = parseCloudAgentConfig(JSON.parse(agent.configJson || "{}")).gatewayModelMap;
      if (map) {
        for (const id of Object.keys(map)) {
          if (!id || names.has(id)) continue;
          names.add(id);
          // forward alias：解析到目标 canonical 再取其元数据；解析不到则不带
          const targetCanonical = map[id]?.trim();
          const metaRecord = targetCanonical ? metaById.get(targetCanonical) : undefined;
          data.push({
            id,
            object: "model",
            created: 0,
            owned_by: "zakura",
            ...pickModelMetadata(metaRecord),
          });
        }
      }
    } catch {
      /* ignore */
    }
    return c.json({ object: "list", data });
  });

  app.post("/v1/responses", async (c) => {
    const auth = await authenticateGatewayRequest(c, deps.db);
    if ("response" in auth) return auth.response;
    if (!auth.keyed.apiKey.agentId) {
      return openAiError(c, "该 API Key 未绑定 Agent", 403, "permission_error");
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json<unknown>();
    } catch {
      return openAiError(c, "请求体必须是 JSON", 400);
    }
    // Codex ≥1.2 只说 Responses 协议；翻译成 chat 请求复用既有网关链路。
    const translated = translateResponsesRequest(rawBody);
    let context;
    try {
      context = await deps.gateway.prepare(
        auth.keyed.tenant.id,
        auth.keyed.apiKey.agentId,
        translated,
        {
          clientSessionKey: resolveClientSessionKey(c.req.raw.headers, translated),
          apiKeyId: auth.keyed.apiKey.id,
        },
      );
    } catch (err) {
      return openAiError(c, err instanceof Error ? err.message : String(err), 400);
    }
    c.header("X-Zakura-Session-Id", context.sessionId);
    const responseId = responsesId();
    const createdAt = Math.floor(Date.now() / 1000);
    const model = context.model ?? "zakura";
    const streamRequested = (asRecordBody(rawBody).stream ?? false) === true;

    const usageOf = (result: { usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }) => ({
      input_tokens: result.usage?.promptTokens ?? 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: result.usage?.completionTokens ?? 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens:
        result.usage?.totalTokens ??
        (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
    });

    if (!streamRequested) {
      try {
        const result = await deps.gateway.invoke(auth.keyed.tenant.id, context);
        const output: Array<Record<string, unknown>> = [];
        const text = (result.openai as { choices?: Array<{ message?: { content?: unknown } }> })
          .choices?.[0]?.message?.content;
        const textContent = typeof text === "string" ? text : "";
        if (textContent) {
          output.push({
            id: itemId("msg"),
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: textContent, annotations: [] }],
          });
        }
        for (const call of result.toolCalls ?? []) {
          output.push({
            id: itemId("fc"),
            type: "function_call",
            status: "completed",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        return c.json({
          id: responseId,
          object: "response",
          created_at: createdAt,
          status: "completed",
          model: result.model || model,
          output,
          usage: usageOf(result),
        });
      } catch (err) {
        return openAiError(c, err instanceof Error ? err.message : String(err), 400);
      }
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (payload: unknown) => controller.enqueue(encoder.encode(sse(payload)));
        const outputItems: Array<Record<string, unknown>> = [];
        let outputIndex = -1;
        let reasoningId: string | null = null;
        let reasoningText = "";
        let messageId: string | null = null;
        let messageText = "";
        const closeReasoning = () => {
          if (!reasoningId) return;
          send(
            responsesEvent("response.reasoning_summary_text.done", {
              item_id: reasoningId,
              output_index: outputIndex,
              summary_index: 0,
              text: reasoningText,
            }),
          );
          send(
            responsesEvent("response.reasoning_summary_part.done", {
              item_id: reasoningId,
              output_index: outputIndex,
              summary_index: 0,
              part: { type: "summary_text", text: reasoningText },
            }),
          );
          const item = {
            id: reasoningId,
            type: "reasoning",
            status: "completed",
            summary: [{ type: "summary_text", text: reasoningText }],
          };
          send(responsesEvent("response.output_item.done", { output_index: outputIndex, item }));
          outputItems.push(item);
          reasoningId = null;
        };
        try {
          send(
            responsesEvent("response.created", {
              response: {
                id: responseId,
                object: "response",
                created_at: createdAt,
                status: "in_progress",
                model,
                output: [],
              },
            }),
          );
          const result = await deps.gateway.invoke(auth.keyed.tenant.id, context, {
            onReasoningDelta: (text) => {
              if (!reasoningId) {
                outputIndex += 1;
                reasoningId = itemId("rs");
                send(
                  responsesEvent("response.output_item.added", {
                    output_index: outputIndex,
                    item: { id: reasoningId, type: "reasoning", status: "in_progress", summary: [] },
                  }),
                );
                send(
                  responsesEvent("response.reasoning_summary_part.added", {
                    item_id: reasoningId,
                    output_index: outputIndex,
                    summary_index: 0,
                    part: { type: "summary_text", text: "" },
                  }),
                );
              }
              reasoningText += text;
              send(
                responsesEvent("response.reasoning_summary_text.delta", {
                  item_id: reasoningId,
                  output_index: outputIndex,
                  summary_index: 0,
                  delta: text,
                }),
              );
            },
            onDelta: (text) => {
              closeReasoning();
              if (!messageId) {
                outputIndex += 1;
                messageId = itemId("msg");
                send(
                  responsesEvent("response.output_item.added", {
                    output_index: outputIndex,
                    item: {
                      id: messageId,
                      type: "message",
                      role: "assistant",
                      status: "in_progress",
                      content: [],
                    },
                  }),
                );
                send(
                  responsesEvent("response.content_part.added", {
                    item_id: messageId,
                    output_index: outputIndex,
                    content_index: 0,
                    part: { type: "output_text", text: "", annotations: [] },
                  }),
                );
              }
              messageText += text;
              send(
                responsesEvent("response.output_text.delta", {
                  item_id: messageId,
                  output_index: outputIndex,
                  content_index: 0,
                  delta: text,
                }),
              );
            },
            signal: c.req.raw.signal,
          });
          closeReasoning();
          if (messageId) {
            send(
              responsesEvent("response.output_text.done", {
                item_id: messageId,
                output_index: outputIndex,
                content_index: 0,
                text: messageText,
              }),
            );
            send(
              responsesEvent("response.content_part.done", {
                item_id: messageId,
                output_index: outputIndex,
                content_index: 0,
                part: { type: "output_text", text: messageText, annotations: [] },
              }),
            );
            const messageItem = {
              id: messageId,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: messageText, annotations: [] }],
            };
            send(responsesEvent("response.output_item.done", { output_index: outputIndex, item: messageItem }));
            outputItems.push(messageItem);
          }
          for (const call of result.toolCalls ?? []) {
            outputIndex += 1;
            const fcId = itemId("fc");
            send(
              responsesEvent("response.output_item.added", {
                output_index: outputIndex,
                item: {
                  id: fcId,
                  type: "function_call",
                  status: "in_progress",
                  call_id: call.id,
                  name: call.function.name,
                  arguments: "",
                },
              }),
            );
            if (call.function.arguments) {
              send(
                responsesEvent("response.function_call_arguments.delta", {
                  item_id: fcId,
                  output_index: outputIndex,
                  delta: call.function.arguments,
                }),
              );
            }
            send(
              responsesEvent("response.function_call_arguments.done", {
                item_id: fcId,
                output_index: outputIndex,
                arguments: call.function.arguments,
              }),
            );
            const fnItem = {
              id: fcId,
              type: "function_call",
              status: "completed",
              call_id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
            };
            send(responsesEvent("response.output_item.done", { output_index: outputIndex, item: fnItem }));
            outputItems.push(fnItem);
          }
          const incomplete = result.finishReason === "length";
          const response = {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: incomplete ? "incomplete" : "completed",
            ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
            model: result.model || model,
            output: outputItems,
            usage: usageOf(result),
          };
          send(responsesEvent(incomplete ? "response.incomplete" : "response.completed", { response }));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(
            responsesEvent("response.failed", {
              response: {
                id: responseId,
                object: "response",
                created_at: createdAt,
                status: "failed",
                model,
                output: outputItems,
                error: { code: "server_error", message },
              },
            }),
          );
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Zakura-Session-Id": context.sessionId,
      },
    });
  });

  app.post("/v1/chat/completions", async (c) => {
    const t0 = performance.now();
    const timing =
      process.env.ZAKURA_HTTP_TIMING === "1" || process.env.ZAKURA_GATEWAY_TIMING === "1";
    const auth = await authenticateGatewayRequest(c, deps.db);
    if ("response" in auth) return auth.response;
    const tAuth = performance.now();
    let body: OpenAiGatewayBody;
    try {
      body = await c.req.json<OpenAiGatewayBody>();
    } catch {
      return openAiError(c, "请求体必须是 JSON", 400);
    }
    if (!auth.keyed.apiKey.agentId) {
      return openAiError(c, "该 API Key 未绑定 Agent", 403, "permission_error");
    }

    let context;
    try {
      context = await deps.gateway.prepare(
        auth.keyed.tenant.id,
        auth.keyed.apiKey.agentId,
        body,
        {
          clientSessionKey: resolveClientSessionKey(c.req.raw.headers, body),
          apiKeyId: auth.keyed.apiKey.id,
        },
      );
    } catch (err) {
      return openAiError(c, err instanceof Error ? err.message : String(err), 400);
    }
    const tPrepare = performance.now();
    // 仅供控制台/排障观察；客户端无需读取或回传
    c.header("X-Zakura-Session-Id", context.sessionId);

    if (body.stream !== true) {
      try {
        const result = await deps.gateway.invoke(auth.keyed.tenant.id, context);
        if (timing) {
          console.warn(
            `[gateway] sync auth=${(tAuth - t0).toFixed(0)}ms prepare=${(tPrepare - tAuth).toFixed(0)}ms invoke=${(performance.now() - tPrepare).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`,
          );
        }
        const completionId = `chatcmpl_${randomUUID()}`;
        return c.json({
          ...result.openai,
          id: completionId,
          model: result.model || result.openai.model,
          ...(result.usage && !result.openai.usage
            ? {
                usage: {
                  prompt_tokens: result.usage.promptTokens ?? 0,
                  completion_tokens: result.usage.completionTokens ?? 0,
                  total_tokens:
                    result.usage.totalTokens ??
                    (result.usage.promptTokens ?? 0) + (result.usage.completionTokens ?? 0),
                },
              }
            : {}),
        });
      } catch (err) {
        return openAiError(c, err instanceof Error ? err.message : String(err), 400);
      }
    }

    const encoder = new TextEncoder();
    const completionId = `chatcmpl_${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = context.model ?? "zakura";
    const streamOptions = body.stream_options ?? body.streamOptions;
    const includeUsage =
      streamOptions &&
      typeof streamOptions === "object" &&
      !Array.isArray(streamOptions) &&
      (streamOptions as Record<string, unknown>).include_usage === true;
    let sentRole = false;
    let firstTokenLogged = false;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (payload: unknown) => controller.enqueue(encoder.encode(sse(payload)));
        const noteFirstToken = () => {
          if (!timing || firstTokenLogged) return;
          firstTokenLogged = true;
          console.warn(
            `[gateway] ttft auth=${(tAuth - t0).toFixed(0)}ms prepare=${(tPrepare - tAuth).toFixed(0)}ms first_token=${(performance.now() - tPrepare).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`,
          );
        };
        try {
          const result = await deps.gateway.invoke(auth.keyed.tenant.id, context, {
            onDelta: (text) => {
              noteFirstToken();
              send({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { ...(sentRole ? {} : { role: "assistant" }), content: text },
                    finish_reason: null,
                  },
                ],
              });
              sentRole = true;
            },
            onReasoningDelta: (text) => {
              noteFirstToken();
              send({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { ...(sentRole ? {} : { role: "assistant" }), reasoning_content: text },
                    finish_reason: null,
                  },
                ],
              });
              sentRole = true;
            },
            signal: c.req.raw.signal,
          });
          if (result.toolCalls?.length) {
            for (const [index, call] of result.toolCalls.entries()) {
              send({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: result.model || model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      ...(sentRole ? {} : { role: "assistant" }),
                      tool_calls: [
                        {
                          index,
                          id: call.id,
                          type: "function",
                          function: {
                            name: call.function.name,
                            arguments: "",
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
              sentRole = true;
              if (call.function.arguments) {
                send({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: result.model || model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index,
                            function: { arguments: call.function.arguments },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                });
              }
            }
          }
          if (includeUsage && result.usage) {
            send({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: result.model || model,
              choices: [],
              usage: {
                prompt_tokens: result.usage.promptTokens ?? 0,
                completion_tokens: result.usage.completionTokens ?? 0,
                total_tokens:
                  result.usage.totalTokens ??
                  (result.usage.promptTokens ?? 0) + (result.usage.completionTokens ?? 0),
              },
            });
          }
          send({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: result.model || model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: result.toolCalls?.length ? "tool_calls" : result.finishReason || "stop",
              },
            ],
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          send({
            error: {
              message: err instanceof Error ? err.message : String(err),
              type: "server_error",
              param: null,
            },
          });
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Zakura-Session-Id": context.sessionId,
      },
    });
  });
}
