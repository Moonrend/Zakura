import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";

export type UpstreamOauthDiscovery = {
  mcpUrl: string;
  resourceMetadataUrl?: string;
  /** RFC 8707 resource identifier from PRM (prefer over mcpUrl when present) */
  resource?: string;
  authorizationServers: string[];
  authorizationServerMetadata?: Record<string, unknown>;
  scopesSupported?: string[];
  registrationEndpoint?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  codeChallengeMethodsSupported?: string[];
};

export type UpstreamOauthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
};

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** MCP / OAuth 2.0：按规范尝试多种 PRM well-known 路径 */
function prmFallbackUrls(mcpUrl: string): string[] {
  const u = new URL(mcpUrl);
  const path = u.pathname.replace(/\/$/, "") || "";
  const urls = [
    path ? `${u.origin}/.well-known/oauth-protected-resource${path}` : null,
    `${u.origin}/.well-known/oauth-protected-resource`,
    path ? `${u.origin}${path}/.well-known/oauth-protected-resource` : null,
  ];
  return [...new Set(urls.filter(Boolean) as string[])];
}

/**
 * RFC 8414 / MCP：authorization_servers 可能是带路径的 issuer（如 github.com/login/oauth）。
 * 正确探测顺序含「路径插入」：origin/.well-known/.../path
 * （GitHub 需要这个，后缀拼接会 404）
 */
function asMetadataCandidates(asBase: string): string[] {
  if (asBase.includes("/.well-known/")) return [asBase];
  let u: URL;
  try {
    u = new URL(asBase);
  } catch {
    return [`${asBase.replace(/\/$/, "")}/.well-known/oauth-authorization-server`];
  }
  const origin = u.origin;
  const path = u.pathname.replace(/\/$/, "");
  const urls = [
    path ? `${origin}/.well-known/oauth-authorization-server${path}` : null,
    path ? `${origin}/.well-known/openid-configuration${path}` : null,
    `${asBase.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
    `${asBase.replace(/\/$/, "")}/.well-known/openid-configuration`,
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}/.well-known/openid-configuration`,
    path ? `${origin}${path}/.well-known/openid-configuration` : null,
  ];
  return [...new Set(urls.filter(Boolean) as string[])];
}

async function fetchFirstJson(urls: string[]): Promise<{
  url: string;
  json: Record<string, unknown>;
} | null> {
  for (const url of urls) {
    try {
      const json = await fetchJson(url);
      return { url, json };
    } catch {
      /* try next */
    }
  }
  return null;
}

function resolveExpiresAt(expiresIn: unknown): number | undefined {
  const n = typeof expiresIn === "number" ? expiresIn : Number(expiresIn);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(Date.now() / 1000) + n;
}

/**
 * MCP OAuth 2.1 client helpers (RFC 9728 PRM + RFC 8414 AS metadata + RFC 7591 DCR + PKCE).
 * Used when connecting TO upstream MCP servers that require OAuth.
 */
export class McpUpstreamOauthService {
  constructor(private readonly config: AppConfig) {}

  /** Probe 401 WWW-Authenticate / well-known metadata for an upstream MCP URL */
  async discover(mcpUrl: string): Promise<UpstreamOauthDiscovery> {
    let resourceMetadataUrl: string | undefined;
    let wwwAuthenticate = "";

    try {
      const probe = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "zakura", version: "0.4.0" },
          },
        }),
        signal: AbortSignal.timeout(12000),
      });
      wwwAuthenticate = probe.headers.get("www-authenticate") ?? "";
      const match = /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate);
      if (match?.[1]) resourceMetadataUrl = match[1];
    } catch {
      // continue with well-known fallbacks
    }

    let authorizationServers: string[] = [];
    let scopesSupported: string[] | undefined;
    let resource: string | undefined;

    const prmCandidates = resourceMetadataUrl
      ? [resourceMetadataUrl, ...prmFallbackUrls(mcpUrl).filter((u) => u !== resourceMetadataUrl)]
      : prmFallbackUrls(mcpUrl);

    const prmHit = await fetchFirstJson(prmCandidates);
    if (prmHit) {
      resourceMetadataUrl = prmHit.url;
      const prm = prmHit.json;
      if (typeof prm.resource === "string" && prm.resource) {
        resource = prm.resource;
      }
      const servers = prm.authorization_servers;
      if (Array.isArray(servers)) {
        authorizationServers = servers.map(String);
      }
      if (Array.isArray(prm.scopes_supported)) {
        scopesSupported = prm.scopes_supported.map(String);
      }
    }

    if (!authorizationServers.length) {
      // 不要静默 fallback 到 mcp.origin（GitHub 会错成 api.githubcopilot.com）
      throw new Error(
        `无法发现 authorization_servers（PRM 失败）。已尝试：${prmCandidates.join(", ")}`,
      );
    }

    const asBase = authorizationServers[0]!;
    const asHit = await fetchFirstJson(asMetadataCandidates(asBase));
    const authorizationServerMetadata = asHit?.json;

    if (!authorizationServerMetadata) {
      throw new Error(
        `无法获取授权服务器元数据。AS=${asBase}；已尝试：${asMetadataCandidates(asBase).join(", ")}`,
      );
    }

    return {
      mcpUrl,
      resourceMetadataUrl,
      resource,
      authorizationServers,
      authorizationServerMetadata,
      scopesSupported,
      registrationEndpoint:
        typeof authorizationServerMetadata.registration_endpoint === "string"
          ? authorizationServerMetadata.registration_endpoint
          : undefined,
      authorizationEndpoint:
        typeof authorizationServerMetadata.authorization_endpoint === "string"
          ? authorizationServerMetadata.authorization_endpoint
          : undefined,
      tokenEndpoint:
        typeof authorizationServerMetadata.token_endpoint === "string"
          ? authorizationServerMetadata.token_endpoint
          : undefined,
      codeChallengeMethodsSupported: Array.isArray(
        authorizationServerMetadata.code_challenge_methods_supported,
      )
        ? (authorizationServerMetadata.code_challenge_methods_supported as string[])
        : undefined,
    };
  }

  /** Prefer PRM scopes; never invent a fake "mcp" scope */
  resolveScope(discovery: UpstreamOauthDiscovery, override?: string): string | undefined {
    if (override?.trim()) return override.trim();
    if (discovery.scopesSupported?.length) return discovery.scopesSupported.join(" ");
    return undefined;
  }

  /** RFC 7591 dynamic client registration against upstream AS */
  async registerClient(discovery: UpstreamOauthDiscovery, opts?: {
    clientName?: string;
    redirectUris?: string[];
  }): Promise<{ clientId: string; clientSecret?: string; raw: Record<string, unknown> }> {
    if (!discovery.registrationEndpoint) {
      throw new Error("上游授权服务器不支持动态客户端注册（缺少 registration_endpoint）");
    }
    const redirectUris = opts?.redirectUris ?? [
      `${this.config.publicBaseUrl}/api/mcp/upstream-oauth/callback`,
    ];
    const res = await fetch(discovery.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: opts?.clientName ?? "Zakura MCP Gateway",
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_uri: this.config.webPublicUrl,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        `DCR failed HTTP ${res.status}: ${JSON.stringify(raw).slice(0, 300)}`,
      );
    }
    const clientId = String(raw.client_id ?? "");
    if (!clientId) throw new Error("DCR response missing client_id");
    return {
      clientId,
      clientSecret: typeof raw.client_secret === "string" ? raw.client_secret : undefined,
      raw,
    };
  }

  buildAuthorizeUrl(input: {
    discovery: UpstreamOauthDiscovery;
    clientId: string;
    redirectUri: string;
    state: string;
    scope?: string;
    resource?: string;
    /** 额外查询参数（如 Google access_type=offline） */
    extraParams?: Record<string, string>;
  }): { url: string; codeVerifier: string } {
    if (!input.discovery.authorizationEndpoint) {
      throw new Error("缺少 authorization_endpoint");
    }
    const codeVerifier = pkceVerifier();
    const challenge = pkceChallenge(codeVerifier);
    const u = new URL(input.discovery.authorizationEndpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", input.clientId);
    u.searchParams.set("redirect_uri", input.redirectUri);
    u.searchParams.set("state", input.state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    if (input.scope) u.searchParams.set("scope", input.scope);
    if (input.resource) u.searchParams.set("resource", input.resource);
    if (input.extraParams) {
      for (const [k, v] of Object.entries(input.extraParams)) {
        if (v) u.searchParams.set(k, v);
      }
    }
    return { url: u.toString(), codeVerifier };
  }

  async exchangeCode(input: {
    tokenEndpoint: string;
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    codeVerifier: string;
    resource?: string;
  }): Promise<UpstreamOauthTokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
    });
    if (input.clientSecret) body.set("client_secret", input.clientSecret);
    if (input.resource) body.set("resource", input.resource);

    const res = await fetch(input.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`token exchange failed: ${JSON.stringify(raw).slice(0, 300)}`);
    }
    const accessToken = String(raw.access_token ?? "");
    if (!accessToken) throw new Error("token response missing access_token");
    return {
      accessToken,
      refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : undefined,
      expiresAt: resolveExpiresAt(raw.expires_in),
      tokenType: typeof raw.token_type === "string" ? raw.token_type : "Bearer",
      scope: typeof raw.scope === "string" ? raw.scope : undefined,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      tokenEndpoint: input.tokenEndpoint,
    };
  }

  async refresh(tokens: UpstreamOauthTokens): Promise<UpstreamOauthTokens> {
    if (!tokens.refreshToken || !tokens.tokenEndpoint || !tokens.clientId) {
      throw new Error("无法刷新：缺少 refresh_token / tokenEndpoint / clientId");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
    });
    if (tokens.clientSecret) body.set("client_secret", tokens.clientSecret);

    const res = await fetch(tokens.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`refresh failed: ${JSON.stringify(raw).slice(0, 300)}`);
    }
    const accessToken = String(raw.access_token ?? "");
    if (!accessToken) throw new Error("refresh response missing access_token");
    return {
      ...tokens,
      accessToken,
      refreshToken:
        typeof raw.refresh_token === "string" ? raw.refresh_token : tokens.refreshToken,
      expiresAt: resolveExpiresAt(raw.expires_in) ?? tokens.expiresAt,
      tokenType: typeof raw.token_type === "string" ? raw.token_type : tokens.tokenType,
      scope: typeof raw.scope === "string" ? raw.scope : tokens.scope,
    };
  }
}
