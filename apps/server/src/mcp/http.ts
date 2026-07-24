/**
 * Zakura Agent MCP — Streamable HTTP Server（@modelcontextprotocol/sdk）
 *
 * 仅暴露 /mcp/agents/:slug；鉴权后由 SDK 传输层处理 initialize / tools / ping / 会话。
 */
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
/** 与 MCP SDK 一致：RequestSchema 为 zod/v4，不可混用 `import { z } from "zod"` */
import * as z from "zod/v4";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  GetTaskRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  PingRequestSchema,
  ReadResourceRequestSchema,
  RequestSchema,
  isInitializeRequest,
  type CallToolResult,
  type CompleteResult,
  type CreateTaskResult,
  type GetPromptResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { TaskMessageQueue, TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import {
  buildWwwAuthenticateChallenge,
  isCreateTaskResult,
  toPublicToolDescriptor,
} from "@zakura/shared";
import { textResult } from "@zakura/core";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import { authenticateApiKey, extractBearer } from "../services/auth.js";
import type { McpGateway } from "../services/mcp-gateway.js";
import type { ZakuraTaskStore } from "../services/mcp-task-store.js";
import type { McpAuthContext, OauthService } from "../services/oauth.js";
import {
  buildAgentMcpCapabilities,
  buildDiscoverResult,
  toolNeedsHostedConfirm,
} from "./agent-capabilities.js";

/** 2026 Tasks 扩展：tasks/update（SDK 1.x 尚未内置） */
const UpdateTaskRequestSchema = RequestSchema.extend({
  method: z.literal("tasks/update"),
  params: z.object({
    taskId: z.string(),
    inputResponses: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** 2026-07-28 server/discover */
const DiscoverRequestSchema = RequestSchema.extend({
  method: z.literal("server/discover"),
  params: z.record(z.string(), z.unknown()).optional(),
});

function agentSlugFromPath(path: string): string | null {
  const m = path.match(/^\/mcp\/agents\/([^/]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function rpcMethodOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body)) return rpcMethodOf(body[0]);
  const method = (body as { method?: unknown }).method;
  return typeof method === "string" ? method : null;
}

function rpcIdOf(body: unknown): string | number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

/** 单条或纯 ping 批处理均可直接 pong，无需会话 */
function isPingOnlyRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.length > 0 && body.every((m) => rpcMethodOf(m) === "ping");
  }
  return rpcMethodOf(body) === "ping";
}

function pingJsonRpcResponse(body: unknown) {
  if (Array.isArray(body)) {
    return body.map((msg) => ({
      jsonrpc: "2.0" as const,
      id: rpcIdOf(msg),
      result: {},
    }));
  }
  return {
    jsonrpc: "2.0" as const,
    id: rpcIdOf(body),
    result: {},
  };
}

/**
 * SDK 1.29 尚未将 2026-07-28 列入 SUPPORTED_PROTOCOL_VERSIONS；
 * 传输层会 400。前向兼容：映射为 2025-11-25 再交给 SDK。
 */
function withCompatibleProtocolVersion(req: Request): Request {
  const ver = req.headers.get("mcp-protocol-version");
  if (ver !== "2026-07-28") return req;
  const headers = new Headers(req.headers);
  headers.set("mcp-protocol-version", "2025-11-25");
  return new Request(req, { headers });
}

function wants2026Protocol(c: Context, body: unknown): boolean {
  const ver =
    c.req.header("mcp-protocol-version") ??
    c.req.header("MCP-Protocol-Version") ??
    "";
  if (ver === "2026-07-28") return true;
  return rpcMethodOf(body) === "server/discover";
}

function resourceMetadataUrl(config: AppConfig, resourcePath: string): string {
  const base = config.publicBaseUrl.replace(/\/$/, "");
  return resourcePath === "/mcp"
    ? `${base}/.well-known/oauth-protected-resource`
    : `${base}/.well-known/oauth-protected-resource${resourcePath}`;
}

function wwwAuthenticate(config: AppConfig, resourcePath: string): string {
  return buildWwwAuthenticateChallenge({
    resourceMetadataUrl: resourceMetadataUrl(config, resourcePath),
    scope: "mcp",
  });
}

function unauthorized(c: Context, config: AppConfig, resourcePath: string, message: string) {
  c.header("WWW-Authenticate", wwwAuthenticate(config, resourcePath));
  return c.json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message } },
    401,
  );
}

type AgentSession = {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  agentSlug: string;
  tenantId: string;
  agentId: string;
  apiKeyId?: string;
};

const sessions = new Map<string, AgentSession>();

function createAgentMcpServer(opts: {
  gateway: McpGateway;
  pathSlug: string;
  tenantId: string;
  agentId: string;
  apiKeyId?: string;
  taskStore: ZakuraTaskStore;
  taskMessageQueue: TaskMessageQueue;
}): Server {
  const { gateway, pathSlug, tenantId, agentId, apiKeyId, taskStore, taskMessageQueue } = opts;
  const scope = { apiKeyId, agentId };

  const server = new Server(
    {
      name: "zakura-agent",
      version: "0.2.0",
      title: `Zakura Agent (${pathSlug})`,
    },
    {
      capabilities: buildAgentMcpCapabilities({ pathSlug }),
      instructions:
        "Zakura Agent MCP gateway. Tools / resources / prompts / completions / tasks. Long-running or destructive tools may return CreateTaskResult; poll tasks/get and submit input via tasks/update when status is input_required. Extensions: io.modelcontextprotocol/tasks, io.modelcontextprotocol/apps.",
      taskStore: taskStore as TaskStore,
      taskMessageQueue,
    },
  );

  server.setRequestHandler(DiscoverRequestSchema, async () =>
    buildDiscoverResult({ pathSlug }),
  );

  // 显式注册 ping（SDK Protocol 默认也有；再挂一次避免被覆盖/热更新丢 handler）
  server.setRequestHandler(PingRequestSchema, async () => ({}));

  // 覆盖默认 getTask：附带托管 inputRequests
  server.setRequestHandler(GetTaskRequestSchema, async (request) => {
    const task = await taskStore.getTask(request.params.taskId);
    if (!task) {
      throw new McpError(ErrorCode.InvalidParams, "Failed to retrieve task: Task not found");
    }
    return { ...task };
  });

  server.setRequestHandler(UpdateTaskRequestSchema, async (request) => {
    try {
      const task = await taskStore.applyTaskUpdate(
        request.params.taskId,
        request.params.inputResponses as Record<string, unknown> | undefined,
      );
      return { ...task };
    } catch (err) {
      throw new McpError(
        ErrorCode.InvalidParams,
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await gateway.listToolsForTenant(tenantId, scope);
    return {
      tools: tools.map((t) =>
        toPublicToolDescriptor(
          {
            name: t.localName,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            outputSchema: t.outputSchema,
            annotations: t.annotations,
            securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
            _meta: t._meta,
            execution: t.execution,
          },
          { publicName: t.qualifiedName },
        ),
      ),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = (request.params.arguments as Record<string, unknown>) ?? {};
    const taskParams = request.params.task;

    // 客户端请求 task-augmented：立即返回 CreateTaskResult，后台执行（可 input_required）
    if (taskParams && extra.taskStore) {
      const task = await extra.taskStore.createTask({
        ttl: taskParams.ttl ?? 3_600_000,
        pollInterval: 1000,
      });
      void (async () => {
        try {
          const tools = await gateway.listToolsForTenant(tenantId, scope);
          const tool = tools.find((t) => t.qualifiedName === name);
          if (tool && toolNeedsHostedConfirm(tool)) {
            const responses = await taskStore.requestHostedInput(
              task.taskId,
              {
                confirm: {
                  type: "elicitation",
                  mode: "form",
                  message: `确认执行工具 ${name}？此操作可能修改系统或数据。`,
                  requestedSchema: {
                    type: "object",
                    required: ["confirm"],
                    properties: {
                      confirm: {
                        type: "boolean",
                        description: "设为 true 以继续执行",
                      },
                    },
                  },
                },
              },
              `Confirm before running ${name}`,
            );
            if (responses.confirm !== true) {
              await extra.taskStore!.storeTaskResult(
                task.taskId,
                "failed",
                textResult("Cancelled: confirmation not granted", true) as never,
              );
              return;
            }
          }

          const result = await gateway.callTool(tenantId, name, args, scope);
          if (isCreateTaskResult(result)) {
            await extra.taskStore!.storeTaskResult(
              task.taskId,
              "failed",
              textResult(
                `Upstream returned nested task ${result.task.taskId}; use sync call or wait on proxied id`,
                true,
              ) as never,
            );
            return;
          }
          await extra.taskStore!.storeTaskResult(
            task.taskId,
            result.isError ? "failed" : "completed",
            result as never,
          );
        } catch (err) {
          await extra.taskStore!.storeTaskResult(
            task.taskId,
            "failed",
            textResult(err instanceof Error ? err.message : String(err), true) as never,
          );
        }
      })();
      return { task } as CreateTaskResult;
    }

    const result = await gateway.callTool(tenantId, name, args, scope);
    if (isCreateTaskResult(result)) {
      return result as CreateTaskResult;
    }
    return result as CallToolResult;
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const resources = await gateway.listResourcesForTenant(tenantId, scope);
      return {
        resources: resources.map((r) => {
          const item: {
            uri: string;
            name: string;
            description?: string;
            mimeType?: string;
            title?: string;
            _meta?: Record<string, unknown>;
          } = {
            uri: r.qualifiedUri,
            name: r.name || r.qualifiedUri,
          };
          if (r.description) item.description = r.description;
          if (r.mimeType) item.mimeType = r.mimeType;
          if (r.title) item.title = r.title;
          if (r._meta) item._meta = r._meta;
          return item;
        }),
      };
    } catch (err) {
      console.warn(
        `[mcp] resources/list ${pathSlug}:`,
        err instanceof Error ? err.message : err,
      );
      return { resources: [] };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      const result = await gateway.readResource(tenantId, request.params.uri, scope);
      return result as ReadResourceResult;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? Number((err as { code: unknown }).code)
          : undefined;
      if (code === -32602) {
        throw new McpError(
          ErrorCode.InvalidParams,
          err instanceof Error ? err.message : String(err),
          { uri: request.params.uri },
        );
      }
      throw err;
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    try {
      const prompts = await gateway.listPromptsForTenant(tenantId, scope);
      return {
        prompts: prompts.map((p) => {
          const item: {
            name: string;
            description?: string;
            title?: string;
            arguments?: typeof p.arguments;
            _meta?: Record<string, unknown>;
          } = { name: p.qualifiedName };
          if (p.description) item.description = p.description;
          if (p.title) item.title = p.title;
          if (p.arguments?.length) item.arguments = p.arguments;
          if (p._meta) item._meta = p._meta;
          return item;
        }),
      };
    } catch (err) {
      console.warn(
        `[mcp] prompts/list ${pathSlug}:`,
        err instanceof Error ? err.message : err,
      );
      return { prompts: [] };
    }
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    try {
      const args = request.params.arguments as Record<string, string> | undefined;
      const result = await gateway.getPrompt(
        tenantId,
        request.params.name,
        args,
        scope,
      );
      return result as GetPromptResult;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? Number((err as { code: unknown }).code)
          : undefined;
      if (code === -32602) {
        throw new McpError(
          ErrorCode.InvalidParams,
          err instanceof Error ? err.message : String(err),
          { name: request.params.name },
        );
      }
      throw err;
    }
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    try {
      const templates = await gateway.listResourceTemplatesForTenant(tenantId, scope);
      return {
        resourceTemplates: templates.map((t) => {
          const item: {
            uriTemplate: string;
            name: string;
            description?: string;
            mimeType?: string;
            title?: string;
            _meta?: Record<string, unknown>;
          } = {
            uriTemplate: t.qualifiedUriTemplate,
            name: t.name || t.qualifiedUriTemplate,
          };
          if (t.description) item.description = t.description;
          if (t.mimeType) item.mimeType = t.mimeType;
          if (t.title) item.title = t.title;
          if (t._meta) item._meta = t._meta;
          return item;
        }),
      };
    } catch (err) {
      console.warn(
        `[mcp] resources/templates/list ${pathSlug}:`,
        err instanceof Error ? err.message : err,
      );
      return { resourceTemplates: [] };
    }
  });

  server.setRequestHandler(CompleteRequestSchema, async (request) => {
    try {
      const ref = request.params.ref;
      const argument = request.params.argument;
      const result = await gateway.complete(
        tenantId,
        {
          ref:
            ref.type === "ref/prompt"
              ? { type: "ref/prompt", name: ref.name }
              : { type: "ref/resource", uri: ref.uri },
          argument: {
            name: argument.name,
            value: argument.value,
          },
        },
        scope,
      );
      return result as CompleteResult;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? Number((err as { code: unknown }).code)
          : undefined;
      if (code === -32602) {
        throw new McpError(
          ErrorCode.InvalidParams,
          err instanceof Error ? err.message : String(err),
        );
      }
      throw err;
    }
  });

  return server;
}

/**
 * Streamable HTTP MCP endpoint at /mcp/agents/:slug only.
 *
 * 鉴权：OAuth 2.1 Bearer / API Key；未鉴权 → 401 + RFC 9728 WWW-Authenticate。
 */
export function createMcpHandler(deps: {
  db: Db;
  gateway: McpGateway;
  oauth: OauthService;
  config: AppConfig;
  taskStore: ZakuraTaskStore;
  taskMessageQueue: TaskMessageQueue;
}) {
  const { db, gateway, oauth, config, taskStore, taskMessageQueue } = deps;

  return async (c: Context) => {
    const pathSlug = agentSlugFromPath(c.req.path);

    if (!pathSlug) {
      if (c.req.method === "OPTIONS") return c.body(null, 204);
      return c.json(
        {
          error: "tenant_mcp_removed",
          message:
            "Zakura 仅支持按 Agent 接入 MCP。请使用 /mcp/agents/{slug}，并在控制台为 Agent 绑定上游服务器。",
          agentMcpPattern: `${config.publicBaseUrl.replace(/\/$/, "")}/mcp/agents/{slug}`,
        },
        404,
      );
    }

    const resourcePath = `/mcp/agents/${pathSlug}`;

    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    // 浏览器打开时返回可读元数据；MCP 客户端走鉴权后的 SDK 传输
    if (c.req.method === "GET") {
      const accept = (c.req.header("accept") ?? "").toLowerCase();
      const isBrowser =
        accept.includes("text/html") || accept.includes("application/xhtml");
      if (isBrowser) {
        c.header("WWW-Authenticate", wwwAuthenticate(config, resourcePath));
        return c.json({
          name: `Zakura Agent MCP (${pathSlug})`,
          transport: "streamable-http",
          sdk: "@modelcontextprotocol/sdk",
          auth: {
            methods: ["oauth2.1", "api_key"],
            authorizationServers: [config.publicBaseUrl.replace(/\/$/, "")],
            resourceMetadata: resourceMetadataUrl(config, resourcePath),
          },
          hint: "Use OAuth 2.1 (ChatGPT CIMD / VS Code DCR) or Authorization: Bearer <agent-api-key>",
          agentSlug: pathSlug,
        });
      }
    }

    const rawToken =
      extractBearer(c.req.header("authorization")) ??
      c.req.header("x-api-key") ??
      null;

    if (!rawToken) {
      return unauthorized(c, config, resourcePath, "Unauthorized: missing credentials");
    }

    let auth: McpAuthContext | null = await oauth.authenticateBearer(rawToken);
    if (!auth) {
      const keyed = await authenticateApiKey(db, rawToken);
      if (keyed) {
        auth = {
          tenant: keyed.tenant,
          apiKeyId: keyed.apiKey.id,
          agentId: keyed.apiKey.agentId ?? null,
          authMethod: "api_key",
          userId: null,
        };
      }
    }

    if (!auth) {
      return unauthorized(c, config, resourcePath, "Unauthorized: invalid token");
    }

    // Apps SDK：校验 access token 的 resource/aud 与当前 MCP 资源一致
    if (auth.authMethod === "oauth" && auth.resource) {
      const expectedResource = `${config.publicBaseUrl.replace(/\/$/, "")}${resourcePath}`;
      if (auth.resource !== expectedResource) {
        return unauthorized(
          c,
          config,
          resourcePath,
          `Unauthorized: token audience mismatch (got ${auth.resource})`,
        );
      }
    }

    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.tenantId, auth.tenant.id), eq(agents.slug, pathSlug)),
    });
    if (!agent) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32004, message: `Unknown agent: ${pathSlug}` },
        },
        404,
      );
    }
    if (auth.agentId && auth.agentId !== agent.id) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "Token is bound to a different agent" },
        },
        403,
      );
    }

    const sessionIdHeader = c.req.header("mcp-session-id") ?? undefined;

    try {
      if (sessionIdHeader && sessions.has(sessionIdHeader)) {
        const session = sessions.get(sessionIdHeader)!;
        if (session.agentSlug !== pathSlug || session.tenantId !== auth.tenant.id) {
          return c.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32001, message: "Session does not match agent" },
            },
            403,
          );
        }
        return session.transport.handleRequest(withCompatibleProtocolVersion(c.req.raw));
      }

      if (c.req.method === "POST") {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            },
            400,
          );
        }

        // ping：不依赖会话，直接 pong（Inspector / 健康探测常用）
        if (isPingOnlyRequest(body)) {
          return c.json(pingJsonRpcResponse(body));
        }

        // 2025：initialize → 有状态会话
        if (!sessionIdHeader && isInitializeRequest(body)) {
          const server = createAgentMcpServer({
            gateway,
            pathSlug,
            tenantId: auth.tenant.id,
            agentId: agent.id,
            apiKeyId: auth.apiKeyId ?? undefined,
            taskStore,
            taskMessageQueue,
          });

          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              sessions.set(sid, {
                transport,
                server,
                agentSlug: pathSlug,
                tenantId: auth!.tenant.id,
                agentId: agent.id,
                apiKeyId: auth!.apiKeyId ?? undefined,
              });
            },
            onsessionclosed: (sid) => {
              const s = sessions.get(sid);
              if (s) {
                void s.server.close().catch(() => undefined);
                sessions.delete(sid);
              }
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && sessions.has(sid)) {
              const s = sessions.get(sid)!;
              void s.server.close().catch(() => undefined);
              sessions.delete(sid);
            }
          };

          await server.connect(transport);
          return transport.handleRequest(withCompatibleProtocolVersion(c.req.raw), {
            parsedBody: body,
          });
        }

        // 2026 / sessionless：无会话的一次性请求（含 server/discover）
        if (!sessionIdHeader || wants2026Protocol(c, body)) {
          const server = createAgentMcpServer({
            gateway,
            pathSlug,
            tenantId: auth.tenant.id,
            agentId: agent.id,
            apiKeyId: auth.apiKeyId ?? undefined,
            taskStore,
            taskMessageQueue,
          });
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          await server.connect(transport);
          try {
            return await transport.handleRequest(withCompatibleProtocolVersion(c.req.raw), {
              parsedBody: body,
            });
          } finally {
            void server.close().catch(() => undefined);
          }
        }
      }

      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message: "Invalid or missing session ID",
          },
        },
        400,
      );
    } catch (err) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        },
        500,
      );
    }
  };
}
