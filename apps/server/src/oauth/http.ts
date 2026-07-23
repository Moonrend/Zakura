import type { Context } from "hono";
import { Hono } from "hono";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { OauthError, type OauthService } from "../services/oauth.js";

function parseBasicAuth(header: string | undefined): { id: string; secret: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { id: decoded.slice(0, i), secret: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

async function readTokenParams(c: Context): Promise<Record<string, string>> {
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = await c.req.json<Record<string, unknown>>();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v != null) out[k] = String(v);
    }
    return out;
  }
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Forward OAuth authorize query to the web console UI */
function authorizeFrontendUrl(config: AppConfig, reqUrl: string): string {
  const incoming = new URL(reqUrl);
  const target = new URL("/oauth/authorize", config.webPublicUrl);
  incoming.searchParams.forEach((value, key) => {
    target.searchParams.set(key, value);
  });
  return target.toString();
}

/**
 * OAuth 2.1 Authorization Server for MCP:
 * metadata、CIMD、DCR (/oauth/register)、/authorize → frontend、/token
 */
export function createOauthApp(deps: {
  db: Db;
  config: AppConfig;
  oauth: OauthService;
}) {
  const { oauth, config } = deps;
  void deps.db;
  const app = new Hono();

  app.get("/.well-known/oauth-authorization-server", (c) => c.json(oauth.metadata()));
  app.get("/.well-known/oauth-authorization-server/*", (c) => c.json(oauth.metadata()));

  app.get("/.well-known/oauth-protected-resource", (c) => {
    return c.json(oauth.resourceMetadata("/mcp"));
  });
  app.get("/.well-known/oauth-protected-resource/*", (c) => {
    const suffix = c.req.path.replace(/^\/\.well-known\/oauth-protected-resource/, "") || "/mcp";
    const path = suffix.startsWith("/mcp") ? suffix : `/mcp${suffix}`;
    return c.json(oauth.resourceMetadata(path));
  });

  const registerHandler = async (c: Context) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const result = await oauth.registerClient({
        client_name: typeof body.client_name === "string" ? body.client_name : undefined,
        redirect_uris: Array.isArray(body.redirect_uris)
          ? body.redirect_uris.map(String)
          : undefined,
        grant_types: Array.isArray(body.grant_types) ? body.grant_types.map(String) : undefined,
        response_types: Array.isArray(body.response_types)
          ? body.response_types.map(String)
          : undefined,
        token_endpoint_auth_method:
          typeof body.token_endpoint_auth_method === "string"
            ? body.token_endpoint_auth_method
            : undefined,
        scope: typeof body.scope === "string" ? body.scope : undefined,
      });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof OauthError) {
        return c.json({ error: err.error, error_description: err.message }, err.status as 400);
      }
      return c.json(
        {
          error: "server_error",
          error_description: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  };

  app.post("/register", registerHandler);
  app.post("/oauth/register", registerHandler);

  /** Browser clients land here, then redirect into the web console authorize UI */
  const authorizeRedirect = (c: Context) => {
    return c.redirect(authorizeFrontendUrl(config, c.req.url), 302);
  };

  app.get("/authorize", authorizeRedirect);
  app.get("/oauth/authorize", authorizeRedirect);

  const tokenHandler = async (c: Context) => {
    try {
      const params = await readTokenParams(c);
      const basic = parseBasicAuth(c.req.header("authorization"));
      const clientId = params.client_id || basic?.id;
      const clientSecret = params.client_secret || basic?.secret;

      const result = await oauth.exchangeToken({
        grantType: params.grant_type,
        code: params.code,
        redirectUri: params.redirect_uri,
        codeVerifier: params.code_verifier,
        refreshToken: params.refresh_token,
        clientId,
        clientSecret,
        resource: params.resource || null,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof OauthError) {
        return c.json(
          { error: err.error, error_description: err.message },
          err.status as 400,
        );
      }
      return c.json(
        {
          error: "server_error",
          error_description: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  };

  app.post("/token", tokenHandler);
  app.post("/oauth/token", tokenHandler);

  app.post("/token/revoke", async (c) => {
    const params = await readTokenParams(c);
    const token = params.token || params.refresh_token;
    if (token) await oauth.revokeRefreshToken(token);
    return c.json({ revoked: true });
  });

  app.get("/oauth/discovery", (c) => {
    return c.json({
      publicBaseUrl: config.publicBaseUrl,
      webPublicUrl: config.webPublicUrl,
      agentMcpPattern: `${config.publicBaseUrl}/mcp/agents/{slug}`,
      authorizationServer: oauth.metadata(),
      authMethods: [
        {
          id: "oauth21",
          name: "OAuth 2.1 + PKCE",
          description:
            "ChatGPT / VS Code 等：优先 CIMD（client_id 为元数据 URL），兼容 DCR + PKCE；请使用 Agent MCP URL",
        },
        {
          id: "api_key",
          name: "API Key",
          description: "Authorization: Bearer <agent-api-key> 或 X-Api-Key",
        },
      ],
    });
  });

  return app;
}
