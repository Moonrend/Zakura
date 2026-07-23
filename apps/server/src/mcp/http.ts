import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import {
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
 * Bare /mcp returns 404 — tenant-level gateway has been removed.
 *
 * Auth (any one):
 * 1. OAuth 2.1 access token — Authorization: Bearer rca_...
 * 2. API Key — Authorization: Bearer zak_... or X-Api-Key
 *
 * Unauthenticated requests get 401 + WWW-Authenticate (RFC 9728 resource_metadata)
 * so ChatGPT / VS Code 可走 CIMD 或 DCR。
 *
 * tools/list 输出对齐 ChatGPT Apps SDK tool descriptor：
 * title / annotations / securitySchemes / _meta
 * @see https://developers.openai.com/apps-sdk/reference#tool-descriptor-parameters
 */
export function createMcpHandler(deps: {
  db: Db;
  gateway: McpGateway;
  oauth: OauthService;
  config: AppConfig;
}) {
  const { db, gateway, oauth, config } = deps;

  return async (c: Context) => {
    const pathSlug = agentSlugFromPath(c.req.path);

    // MCP 仅支持按 Agent 接入：/mcp/agents/:slug（不再提供租户级 /mcp）
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
     * 先前对 MCP 客户端 GET 返回 JSON discovery，会导致 ChatGPT 握手后断开
     * （「连接到 Zakura 时出现问题」）。
     * 浏览器（Accept 含 text/html）仍返回可读 discovery。
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
          authorizationServers: [config.publicBaseUrl.replace(/\/$/, "")],
          resourceMetadata: resourceMetadataUrl(config, resourcePath),
        },
        hint: "Use OAuth 2.1 (ChatGPT CIMD / VS Code DCR) or Authorization: Bearer <agent-api-key>",
        agentSlug: pathSlug,
      });
    }

    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    // Streamable HTTP 会话终止：无状态实现直接确认
    if (c.req.method === "DELETE") {
      return c.body(null, 200);
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

    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.tenantId, auth.tenant.id), eq(agents.slug, pathSlug)),
    });
    if (!agent) {
      return c.json(rpcError(null, -32004, `Unknown agent: ${pathSlug}`), 404);
    }
    if (auth.agentId && auth.agentId !== agent.id) {
      return c.json(rpcError(null, -32001, "Token is bound to a different agent"), 403);
    }
    const agentId = agent.id;

    let body: JsonRpcRequest;
    try {
      body = await c.req.json<JsonRpcRequest>();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }

    const { id, method, params } = body;
    const scope = {
      apiKeyId: auth.apiKeyId ?? undefined,
      agentId,
    };

    const headerProto = c.req.header("mcp-protocol-version") ?? undefined;

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
              "Zakura Agent MCP gateway. Tools require OAuth 2.1 (scope=mcp) or an agent API key. Prefer Agent-scoped URL /mcp/agents/{slug}.",
          }),
        );
      }

      if (method === "notifications/initialized") {
        // JSON-RPC notification：无 id，应答 202
        return c.body(null, 202);
      }

      if (method === "ping") {
        return c.json(rpcResult(id, {}));
      }

      if (method === "tools/list") {
        const tools = await gateway.listToolsForTenant(auth.tenant.id, scope);
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
        const name = String(params?.name ?? "");
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        const result = await gateway.callTool(auth.tenant.id, name, args, scope);
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
