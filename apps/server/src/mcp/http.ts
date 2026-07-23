import type { Context } from "hono";
import { and, asc, eq } from "drizzle-orm";
import {
  authRequiredToolResult,
  buildWwwAuthenticateChallenge,
  toPublicToolDescriptor,
} from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import { authenticateApiKey, extractBearer } from "../services/auth.js";
import type { McpGateway } from "../services/mcp-gateway.js";
import type { McpAuthContext, OauthService } from "../services/oauth.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** ChatGPT / 新版 MCP 客户端优先；保留 2024-11-05 兼容 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

/** 免鉴权：连接器扫描 / 工具枚举。tools/call 仍需 OAuth（调用时挑战）。 */
const ANON_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
]);

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function agentSlugFromPath(path: string): string | null {
  const m = path.match(/^\/mcp\/agents\/([^/]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
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
  return c.json(rpcError(null, -32001, message), 401);
}

function negotiateProtocolVersion(
  requested: unknown,
  headerVersion: string | undefined,
): string {
  const candidates = [requested, headerVersion].filter(
    (v): v is string => typeof v === "string" && !!v.trim(),
  );
  for (const v of candidates) {
    if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v)) return v;
  }
  return DEFAULT_PROTOCOL_VERSION;
}

/**
 * Streamable HTTP MCP endpoint at /mcp/agents/:slug only.
 *
 * Auth 模型（对齐 ChatGPT Apps SDK「匿名发现、调用时鉴权」）：
 * - initialize / ping / tools/list：可无凭证（便于连接器扫描，避开卡死的授权弹窗）
 * - tools/call：需 OAuth access token 或 API Key；否则返回带
 *   `_meta["mcp/www_authenticate"]` 的工具级挑战
 *
 * @see https://developers.openai.com/apps-sdk/build/auth
 * @see https://community.openai.com/t/apps-sdk-submission-blocked-mcp-oauth-code-issued-but-chatgpt-never-calls-token-authorize-mcp-modal-hangs/1385089
 */
export function createMcpHandler(deps: {
  db: Db;
  gateway: McpGateway;
  oauth: OauthService;
  config: AppConfig;
}) {
  const { db, gateway, oauth, config } = deps;

  async function resolveAgentBySlug(pathSlug: string, tenantId?: string) {
    if (tenantId) {
      return (
        (await db.query.agents.findFirst({
          where: and(eq(agents.tenantId, tenantId), eq(agents.slug, pathSlug)),
        })) ?? null
      );
    }
    // 匿名：按 slug 取最早创建的 Agent（公开 MCP URL 建议全局唯一 slug）
    return (
      (await db.query.agents.findFirst({
        where: eq(agents.slug, pathSlug),
        orderBy: [asc(agents.createdAt)],
      })) ?? null
    );
  }

  async function resolveAuth(rawToken: string | null): Promise<McpAuthContext | null> {
    if (!rawToken) return null;
    const oauthAuth = await oauth.authenticateBearer(rawToken);
    if (oauthAuth) return oauthAuth;
    const keyed = await authenticateApiKey(db, rawToken);
    if (!keyed) return null;
    return {
      tenant: keyed.tenant,
      apiKeyId: keyed.apiKey.id,
      agentId: keyed.apiKey.agentId ?? null,
      authMethod: "api_key",
      userId: null,
    };
  }

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

    /**
     * Streamable HTTP：GET 只能返回 text/event-stream，或不支持时 405。
     * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
     */
    if (c.req.method === "GET") {
      const accept = (c.req.header("accept") ?? "").toLowerCase();
      const isBrowser =
        accept.includes("text/html") || accept.includes("application/xhtml");
      if (!isBrowser) {
        c.header("Allow", "POST, OPTIONS");
        c.header("WWW-Authenticate", wwwAuthenticate(config, resourcePath));
        return c.json(
          {
            error: "method_not_allowed",
            message:
              "This MCP endpoint is Streamable HTTP (POST JSON-RPC only). GET SSE is not supported.",
            agentSlug: pathSlug,
            resourceMetadata: resourceMetadataUrl(config, resourcePath),
          },
          405,
        );
      }
      c.header("WWW-Authenticate", wwwAuthenticate(config, resourcePath));
      return c.json({
        name: `Zakura Agent MCP (${pathSlug})`,
        transport: "streamable-http",
        protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        auth: {
          methods: ["oauth2.1", "api_key"],
          discovery: "anonymous",
          authorizationServers: [config.publicBaseUrl.replace(/\/$/, "")],
          resourceMetadata: resourceMetadataUrl(config, resourcePath),
        },
        hint: "initialize/tools/list 可匿名；tools/call 需 OAuth 2.1 (scope=mcp) 或 Agent API Key",
        agentSlug: pathSlug,
      });
    }

    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    if (c.req.method === "DELETE") {
      return c.body(null, 200);
    }

    let body: JsonRpcRequest;
    try {
      body = await c.req.json<JsonRpcRequest>();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }

    const { id, method, params } = body;
    const headerProto = c.req.header("mcp-protocol-version") ?? undefined;
    const rawToken =
      extractBearer(c.req.header("authorization")) ??
      c.req.header("x-api-key") ??
      null;
    const auth = await resolveAuth(rawToken);
    const allowAnon = !!method && ANON_METHODS.has(method);

    if (!auth && !allowAnon) {
      if (method === "tools/call") {
        c.header("WWW-Authenticate", wwwAuthenticate(config, resourcePath));
        return c.json(
          rpcResult(
            id,
            authRequiredToolResult({
              resourceMetadataUrl: resourceMetadataUrl(config, resourcePath),
              message: "调用工具需要先完成 OAuth 授权（scope=mcp）或提供 Agent API Key。",
            }),
          ),
        );
      }
      return unauthorized(
        c,
        config,
        resourcePath,
        rawToken ? "Unauthorized: invalid token" : "Unauthorized: missing credentials",
      );
    }

    const agent = await resolveAgentBySlug(pathSlug, auth?.tenant.id);
    if (!agent) {
      return c.json(rpcError(id, -32004, `Unknown agent: ${pathSlug}`), 404);
    }
    if (auth?.agentId && auth.agentId !== agent.id) {
      return c.json(rpcError(id, -32001, "Token is bound to a different agent"), 403);
    }

    const tenantId = auth?.tenant.id ?? agent.tenantId;
    const scope = {
      apiKeyId: auth?.apiKeyId ?? undefined,
      agentId: agent.id,
    };

    try {
      if (method === "initialize") {
        const protocolVersion = negotiateProtocolVersion(
          params?.protocolVersion,
          headerProto,
        );
        c.header("MCP-Protocol-Version", protocolVersion);
        return c.json(
          rpcResult(id, {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: "zakura-agent",
              version: "0.2.0",
              title: `Zakura Agent (${pathSlug})`,
            },
            instructions:
              "Zakura Agent MCP：可匿名 initialize/tools/list；tools/call 需 OAuth 2.1 (scope=mcp) 或 Agent API Key。",
          }),
        );
      }

      if (method === "notifications/initialized") {
        return c.body(null, 202);
      }

      if (method === "ping") {
        return c.json(rpcResult(id, {}));
      }

      if (method === "tools/list") {
        const tools = await gateway.listToolsForTenant(tenantId, scope);
        return c.json(
          rpcResult(id, {
            tools: tools.map((t) =>
              toPublicToolDescriptor(
                {
                  name: t.localName,
                  title: t.title,
                  description: t.description,
                  inputSchema: t.inputSchema,
                  outputSchema: t.outputSchema,
                  annotations: t.annotations,
                  // 对外始终声明 Zakura OAuth；上游 scheme 不覆盖网关鉴权语义
                  securitySchemes: undefined,
                  _meta: t._meta,
                },
                { publicName: t.qualifiedName },
              ),
            ),
          }),
        );
      }

      if (method === "tools/call") {
        // 此处必有 auth（未授权已在上方返回挑战）
        const name = String(params?.name ?? "");
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        const result = await gateway.callTool(tenantId, name, args, scope);
        return c.json(rpcResult(id, result));
      }

      return c.json(rpcError(id, -32601, `Method not found: ${method}`));
    } catch (err) {
      return c.json(
        rpcError(id, -32000, err instanceof Error ? err.message : String(err)),
        500,
      );
    }
  };
}
