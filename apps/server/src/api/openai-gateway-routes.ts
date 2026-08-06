import type { Context, Hono } from "hono";
import { randomUUID } from "node:crypto";
import { parseCloudAgentConfig } from "@zakura/shared";
import type { AppVariables } from "./routes.js";
import { authenticateApiKey, extractBearer, hasApiKeyScope } from "../services/auth.js";
import type { AgentService } from "../services/agents.js";
import type { Db } from "../db/client.js";
import type { OpenAiGatewayBody, OpenAiGatewayService } from "../services/openai-gateway.js";
import { resolveClientSessionKey } from "../services/openai-gateway.js";
import type { UpstreamModelsService } from "../services/upstream-models.js";

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
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
  if (!raw) return { response: openAiError(c, "缺少 API Key", 401, "authentication_error") };
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
    const data: Array<{
      id: string;
      object: "model";
      created: number;
      owned_by: string;
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
    return c.json({ object: "list", data });
  });

  app.post("/v1/chat/completions", async (c) => {
    const auth = await authenticateGatewayRequest(c, deps.db);
    if ("response" in auth) return auth.response;
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
    // 仅供控制台/排障观察；客户端无需读取或回传
    c.header("X-Zakura-Session-Id", context.sessionId);

    if (body.stream !== true) {
      try {
        const result = await deps.gateway.invoke(auth.keyed.tenant.id, context);
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
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (payload: unknown) => controller.enqueue(encoder.encode(sse(payload)));
        try {
          const result = await deps.gateway.invoke(auth.keyed.tenant.id, context, {
            onDelta: (text) => {
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
