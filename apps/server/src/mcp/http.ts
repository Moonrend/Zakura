import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
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

function wwwAuthenticate(config: AppConfig, resourcePath: string): string {
  const base = config.publicBaseUrl.replace(/\/$/, "");
  const resourceMeta =
    resourcePath === "/mcp"
      ? `${base}/.well-known/oauth-protected-resource`
      : `${base}/.well-known/oauth-protected-resource${resourcePath}`;
  return `Bearer FAKESECRET_g3h4i5j6k7l8m9n0o1p2="${resourceMeta}", scope="mcp"`;
}

function unauthorized(c: Context, config: AppConfig, resourcePath: string, message: string) {
  c.header("WWW-Authenticate", wwwAuthenticate(config, resourcePath));
  return c.json(rpcError(null, -32001, message), 401);
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
 * so VS Code / MCP clients can start OAuth + dynamic client registration.
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

    if (c.req.method === "GET") {
      c.header("WWW-Authenticate", wwwAuthenticate(config, resourcePath));
      return c.json({
        name: `Zakura Agent MCP (${pathSlug})`,
        transport: "streamable-http",
        auth: {
          methods: ["oauth2.1", "api_key"],
          authorizationServers: [config.publicBaseUrl.replace(/\/$/, "")],
          resourceMetadata: `${config.publicBaseUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource${resourcePath}`,
        },
        hint: "Use OAuth 2.1 (VS Code) or Authorization: Bearer <agent-api-key>",
        agentSlug: pathSlug,
      });
    }

    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
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

    try {
      if (method === "initialize") {
        return c.json(
          rpcResult(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "zakura-agent",
              version: "0.2.0",
            },
          }),
        );
      }

      if (method === "notifications/initialized" || method === "ping") {
        return c.json(rpcResult(id, {}));
      }

      if (method === "tools/list") {
        const tools = await gateway.listToolsForTenant(auth.tenant.id, scope);
        return c.json(
          rpcResult(id, {
            tools: tools.map((t) => ({
              name: t.qualifiedName,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
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
