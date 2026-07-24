import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { hashApiKey } from "@zakura/core";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  agents,
  newId,
  oauthAuthCodes,
  oauthClients,
  oauthRefreshTokens,
  tenants,
  users,
  type OauthClient,
  type Tenant,
} from "../db/schema.js";
import { loginUser } from "./auth.js";
import {
  fetchCimdDocument,
  isCimdClientId,
  pickCimdTokenAuthMethod,
} from "./oauth-cimd.js";
import {
  jwksDocument,
  loadOrCreateOauthSigningKey,
  signJwtRs256,
  type OauthSigningKey,
} from "./oauth-signing.js";

const ACCESS_TTL_SEC = 60 * 60; // 1h
const REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30d
const CODE_TTL_SEC = 60 * 10; // 10m
const ID_TOKEN_TTL_SEC = 60 * 60; // 1h

/** OIDC + MCP 对外声明的 scope */
export const OAUTH_SCOPES_SUPPORTED = [
  "mcp",
  "openid",
  "email",
  "profile",
  "offline_access",
] as const;

/** ChatGPT 声明授权域（siwc）+ 刷新令牌所需 scope；即便请求里只有 mcp 也一并授予 */
const CHATGPT_OIDC_SCOPES = ["openid", "email", "profile", "offline_access"] as const;

export type McpAuthContext = {
  tenant: Tenant;
  /** Present for API-key auth */
  apiKeyId?: string | null;
  /** Present for OAuth user tokens */
  userId?: string | null;
  agentId?: string | null;
  authMethod: "api_key" | "oauth";
  clientId?: string | null;
  scope?: string;
};

export type AccessTokenPayload = {
  typ: "mcp_at";
  sub: string; // userId
  tid: string; // tenantId
  cid: string; // clientId
  aid?: string | null; // agentId
  scope: string;
  resource?: string | null;
  exp: number;
  iat: number;
  jti: string;
};

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function signAccessToken(secret: string, payload: AccessTokenPayload): string {
  const data = b64urlJson(payload);
  const sig = createHmac("sha256", secret).update(`mcp_at.${data}`).digest("base64url");
  return `rca_${data}.${sig}`;
}

export function verifyAccessToken(
  secret: string,
  token: string,
): AccessTokenPayload | null {
  if (!token.startsWith("rca_")) return null;
  const raw = token.slice(4);
  const [data, sig] = raw.split(".");
  if (!data || !sig) return null;
  const expected = createHmac("sha256", secret).update(`mcp_at.${data}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as AccessTokenPayload;
    if (payload.typ !== "mcp_at") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** 合并去重 scope 字符串 */
export function mergeScopes(...parts: Array<string | null | undefined>): string {
  const set = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const s of part.split(/[\s+]+/)) {
      const t = s.trim();
      if (t) set.add(t);
    }
  }
  return [...set].join(" ");
}

function scopeSet(scope: string | null | undefined): Set<string> {
  return new Set(
    (scope ?? "")
      .split(/[\s+]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function isChatgptCimdClient(clientId: string): boolean {
  try {
    const host = new URL(clientId).hostname.toLowerCase();
    return host === "chatgpt.com" || host === "chat.openai.com";
  } catch {
    return false;
  }
}

/**
 * 规范化授权 scope：ChatGPT CIMD 即使只传 mcp，也附带 openid/email/profile，
 * 以便签发 id_token / userinfo 供声明授权域使用。
 */
export function normalizeGrantedScopes(
  requested: string | null | undefined,
  opts?: { clientId?: string | null },
): string {
  let scope = mergeScopes(requested || "mcp");
  if (opts?.clientId && isCimdClientId(opts.clientId) && isChatgptCimdClient(opts.clientId)) {
    scope = mergeScopes(scope, ...CHATGPT_OIDC_SCOPES);
  }
  return scope;
}

type IdTokenClaims = {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  auth_time: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
};

export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") {
      return (
        u.hostname === "127.0.0.1" ||
        u.hostname === "localhost" ||
        u.hostname === "[::1]"
      );
    }
    // VS Code / Cursor custom schemes occasionally used
    if (u.protocol === "vscode:" || u.protocol === "cursor:" || u.protocol === "vscode-insiders:") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 校验 redirect_uri 是否属于该 client。
 * CIMD（ChatGPT/Claude）：文档可能未及时列出新 callback_id，
 * 对受信主机允许官方回调路径前缀匹配；redirect_uris 中以 `/` 结尾的视为前缀。
 */
export function isRedirectUriRegistered(
  client: { registrationType: string; redirectUrisJson: string },
  redirectUri: string,
  clientId?: string,
): boolean {
  let uris: string[] = [];
  try {
    uris = JSON.parse(client.redirectUrisJson) as string[];
  } catch {
    uris = [];
  }
  if (
    uris.some(
      (u) =>
        u === redirectUri ||
        (u.endsWith("/") && redirectUri.startsWith(u)) ||
        // 精确路径条目（无尾斜杠）的「父路径」允许：connector_platform_oauth_redirect
        redirectUri === u,
    )
  ) {
    return true;
  }

  if (client.registrationType !== "cimd") return false;
  try {
    const redirect = new URL(redirectUri);
    const idHost = clientId ? new URL(clientId).hostname.toLowerCase() : "";
    const host = redirect.hostname.toLowerCase();

    // ChatGPT Apps / Connectors
    if (
      (host === "chatgpt.com" || host === "chat.openai.com" || idHost === "chatgpt.com") &&
      (redirect.pathname.startsWith("/connector/oauth/") ||
        redirect.pathname === "/connector_platform_oauth_redirect")
    ) {
      return redirect.protocol === "https:";
    }

    // Claude
    if (
      (host === "claude.ai" || idHost === "claude.ai") &&
      (redirect.pathname.startsWith("/api/mcp/auth_callback") ||
        redirect.pathname.startsWith("/oauth/") ||
        redirect.pathname.includes("callback"))
    ) {
      return redirect.protocol === "https:";
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** AS 声明的 token 端点鉴权方式（CIMD 与 ChatGPT 取交集；优先 none 公开客户端） */
export const TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED = [
  "none",
  "client_secret_post",
  "client_secret_basic",
] as const;

export function authorizationServerMetadata(baseUrl: string) {
  const issuer = baseUrl.replace(/\/$/, "");
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    /**
     * DCR：使用 /oauth/register，避免与 Web SaaS 注册页 GET /register 冲突。
     * （nginx 对 POST /register 的 418 分流在部分环境会表现为客户端看到的 403）
     */
    registration_endpoint: `${issuer}/oauth/register`,
    /** OIDC UserInfo：ChatGPT 用邮箱做声明授权域；缺省时 UI 会显示 https://example.com */
    userinfo_endpoint: `${issuer}/userinfo`,
    /**
     * mcp：MCP 工具授权；openid/email/profile：ChatGPT 声明授权域（siwc）；
     * offline_access：声明可发 refresh_token（实际始终可发，与 scope 对齐）。
     * @see https://developers.openai.com/apps-sdk/build/auth
     */
    scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED],
    revocation_endpoint: `${issuer}/token/revoke`,
    subject_types_supported: ["public"],
    /** 公开客户端（CIMD none）须用 RS256 + jwks_uri 验 id_token；HS256 无法共享 secret */
    id_token_signing_alg_values_supported: ["RS256"],
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    claim_types_supported: ["normal"],
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "email",
      "email_verified",
      "name",
      "preferred_username",
    ],
    /**
     * RFC 9207：授权响应必须带 iss；ChatGPT 等严格客户端缺 iss 会拒绝对话并不换 token。
     * @see https://modelcontextprotocol.io/specification/draft/basic/authorization
     */
    authorization_response_iss_parameter_supported: true,
    /**
     * CIMD：ChatGPT / MCP 规范优先路径。
     * client_id 为 https 元数据 URL 时，AS 拉取并校验文档，无需 DCR。
     * @see https://developers.openai.com/apps-sdk/build/auth
     */
    client_id_metadata_document_supported: true,
  };
}

export function protectedResourceMetadata(baseUrl: string, resourcePath = "/mcp") {
  const issuer = baseUrl.replace(/\/$/, "");
  const resource = `${issuer}${resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`}`;
  return {
    resource,
    authorization_servers: [issuer],
    /** 与 AS scopes 对齐，避免 ChatGPT 只从 PRM 读到 mcp */
    scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
    bearer_methods_supported: ["header"],
    resource_documentation: `${issuer}/`,
  };
}

export class OauthService {
  private readonly signingKey: OauthSigningKey;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {
    this.signingKey = loadOrCreateOauthSigningKey(this.config.dataDir);
  }

  metadata() {
    return authorizationServerMetadata(this.config.publicBaseUrl);
  }

  jwks() {
    return jwksDocument(this.signingKey);
  }

  resourceMetadata(resourcePath = "/mcp") {
    return protectedResourceMetadata(this.config.publicBaseUrl, resourcePath);
  }

  async registerClient(body: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
    scope?: string;
  }): Promise<{
    client_id: string;
    client_secret?: string;
    client_id_issued_at: number;
    client_name: string;
    redirect_uris: string[];
    grant_types: string[];
    response_types: string[];
    token_endpoint_auth_method: string;
    scope: string;
  }> {
    const redirectUris = (body.redirect_uris ?? []).filter(Boolean);
    if (!redirectUris.length) {
      throw new OauthError("invalid_client_metadata", "redirect_uris required", 400);
    }
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri)) {
        throw new OauthError(
          "invalid_redirect_uri",
          `Redirect URI not allowed: ${uri}`,
          400,
        );
      }
    }

    const authMethod = body.token_endpoint_auth_method ?? "none";
    const grantTypes = body.grant_types?.length
      ? body.grant_types
      : ["authorization_code", "refresh_token"];
    const responseTypes = body.response_types?.length ? body.response_types : ["code"];

    const clientId = `ocl_${randomBytes(16).toString("base64url")}`;
    let clientSecret: string | undefined;
    let clientSecretHash: string | null = null;
    if (authMethod !== "none") {
      clientSecret = `ocs_${randomBytes(24).toString("base64url")}`;
      clientSecretHash = hashApiKey(clientSecret);
    }

    await this.db.insert(oauthClients).values({
      clientId,
      clientSecretHash,
      clientName: body.client_name?.trim() || "MCP Client",
      redirectUrisJson: JSON.stringify(redirectUris),
      grantTypesJson: JSON.stringify(grantTypes),
      responseTypesJson: JSON.stringify(responseTypes),
      tokenEndpointAuthMethod: authMethod,
      scope: body.scope?.trim() || "mcp",
      registrationType: "dynamic",
    });

    return {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.client_name?.trim() || "MCP Client",
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: authMethod,
      scope: body.scope?.trim() || "mcp",
    };
  }

  async getClient(clientId: string): Promise<OauthClient | null> {
    return (
      (await this.db.query.oauthClients.findFirst({
        where: eq(oauthClients.clientId, clientId),
      })) ?? null
    );
  }

  /**
   * 解析 OAuth client：本地库优先；若 client_id 为 CIMD URL 则拉取元数据并 upsert。
   * CIMD 客户端跨租户共享，不绑定 tenantId。
   */
  async resolveClient(clientId: string): Promise<OauthClient | null> {
    const existing = await this.getClient(clientId);
    if (existing && existing.registrationType !== "cimd") {
      return existing;
    }
    if (!isCimdClientId(clientId)) {
      return existing;
    }

    let doc;
    try {
      doc = await fetchCimdDocument(clientId);
    } catch (err) {
      if (existing) return existing; // 拉取失败时沿用缓存行
      throw new OauthError(
        "invalid_client",
        err instanceof Error ? err.message : String(err),
        400,
      );
    }

    const authMethod = pickCimdTokenAuthMethod(doc, [
      ...TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED,
    ]);
    // 尚未实现 private_key_jwt 验签：若文档只支持它，降级提示
    if (authMethod === "private_key_jwt") {
      throw new OauthError(
        "invalid_client",
        "当前授权服务器尚未支持 private_key_jwt；请使用 token_endpoint_auth_method=none 的 CIMD 客户端",
        400,
      );
    }

    const values = {
      clientSecretHash: null as string | null,
      clientName: doc.client_name?.trim() || "MCP Client (CIMD)",
      redirectUrisJson: JSON.stringify(doc.redirect_uris),
      grantTypesJson: JSON.stringify(
        doc.grant_types?.length
          ? doc.grant_types
          : ["authorization_code", "refresh_token"],
      ),
      responseTypesJson: JSON.stringify(
        doc.response_types?.length ? doc.response_types : ["code"],
      ),
      tokenEndpointAuthMethod: authMethod,
      scope: doc.scope?.trim() || "mcp",
      registrationType: "cimd" as const,
      tenantId: null as string | null,
    };

    if (existing) {
      await this.db
        .update(oauthClients)
        .set(values)
        .where(eq(oauthClients.clientId, clientId));
    } else {
      await this.db.insert(oauthClients).values({
        clientId,
        ...values,
      });
    }

    return (await this.getClient(clientId))!;
  }

  parseRedirectUris(client: OauthClient): string[] {
    try {
      return JSON.parse(client.redirectUrisJson) as string[];
    } catch {
      return [];
    }
  }

  async resolveAgentId(
    tenantId: string,
    opts: { agentSlug?: string | null; resource?: string | null },
  ): Promise<string | null> {
    let slug = opts.agentSlug?.trim() || null;
    if (!slug && opts.resource) {
      try {
        const u = new URL(opts.resource);
        const m = u.pathname.match(/^\/mcp\/agents\/([^/]+)/);
        if (m?.[1]) slug = decodeURIComponent(m[1]);
      } catch {
        /* ignore */
      }
    }
    if (!slug) return null;
    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.tenantId, tenantId), eq(agents.slug, slug)),
    });
    return agent?.id ?? null;
  }

  async createAuthorizationCode(input: {
    clientId: string;
    userId: string;
    tenantId: string;
    agentId?: string | null;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
    resource?: string | null;
  }): Promise<string> {
    const raw = `ac_${randomBytes(24).toString("base64url")}`;
    await this.db.insert(oauthAuthCodes).values({
      codeHash: hashToken(raw),
      clientId: input.clientId,
      userId: input.userId,
      tenantId: input.tenantId,
      agentId: input.agentId ?? null,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod || "S256",
      scope: input.scope || "mcp",
      resource: input.resource ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_SEC * 1000),
    });
    return raw;
  }

  async consent(input: {
    userId: string;
    tenantId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod?: string;
    scope?: string;
    resource?: string | null;
    agentSlug?: string | null;
  }): Promise<{ code: string; redirectUri: string }> {
    const client = await this.resolveClient(input.clientId);
    if (!client) throw new OauthError("invalid_client", "Unknown client", 400);

    // DCR/手动客户端绑定授权租户；CIMD 为全局身份，不绑定 tenant
    if (client.registrationType !== "cimd") {
      if (client.tenantId && client.tenantId !== input.tenantId) {
        throw new OauthError("access_denied", "Client belongs to another tenant", 403);
      }
      if (!client.tenantId) {
        await this.db
          .update(oauthClients)
          .set({ tenantId: input.tenantId })
          .where(eq(oauthClients.clientId, input.clientId));
      }
    }

    if (!isRedirectUriRegistered(client, input.redirectUri, input.clientId)) {
      throw new OauthError("invalid_request", "redirect_uri mismatch", 400);
    }
    if (!input.codeChallenge) {
      throw new OauthError("invalid_request", "code_challenge required (PKCE)", 400);
    }
    const method = input.codeChallengeMethod || "S256";
    if (method !== "S256") {
      throw new OauthError("invalid_request", "Only S256 PKCE is supported", 400);
    }

    const agentId = await this.resolveAgentId(input.tenantId, {
      agentSlug: input.agentSlug,
      resource: input.resource,
    });

    const code = await this.createAuthorizationCode({
      clientId: input.clientId,
      userId: input.userId,
      tenantId: input.tenantId,
      agentId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: method,
      scope: normalizeGrantedScopes(input.scope || client.scope || "mcp", {
        clientId: input.clientId,
      }),
      resource: input.resource,
    });

    return { code, redirectUri: input.redirectUri };
  }

  async loginAndAuthorize(input: {
    email: string;
    password: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod?: string;
    scope?: string;
    resource?: string | null;
    agentSlug?: string | null;
    tenantSlug?: string;
  }): Promise<{ code: string; redirectUri: string }> {
    const logged = await loginUser(this.db, input.email, input.password, {
      tenantSlug: input.tenantSlug,
    });
    if (!logged) throw new OauthError("access_denied", "Invalid credentials", 401);

    return this.consent({
      userId: logged.user.id,
      tenantId: logged.tenant.id,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      scope: input.scope,
      resource: input.resource,
      agentSlug: input.agentSlug,
    });
  }

  private async verifyClientSecret(
    client: OauthClient,
    secret: string | undefined,
  ): Promise<boolean> {
    if (client.tokenEndpointAuthMethod === "none") return true;
    if (!secret || !client.clientSecretHash) return false;
    return hashApiKey(secret) === client.clientSecretHash;
  }

  async exchangeToken(input: {
    grantType: string;
    code?: string;
    redirectUri?: string;
    codeVerifier?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    resource?: string | null;
  }): Promise<{
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    refresh_token?: string;
    scope: string;
    id_token?: string;
  }> {
    if (input.grantType === "authorization_code") {
      return this.exchangeAuthCode(input);
    }
    if (input.grantType === "refresh_token") {
      return this.exchangeRefresh(input);
    }
    throw new OauthError("unsupported_grant_type", `Unsupported grant: ${input.grantType}`, 400);
  }

  private async exchangeAuthCode(input: {
    code?: string;
    redirectUri?: string;
    codeVerifier?: string;
    clientId?: string;
    clientSecret?: string;
    resource?: string | null;
  }) {
    if (!input.code || !input.redirectUri || !input.codeVerifier || !input.clientId) {
      throw new OauthError(
        "invalid_request",
        "code, redirect_uri, code_verifier, client_id required",
        400,
      );
    }
    const client = await this.resolveClient(input.clientId);
    if (!client) throw new OauthError("invalid_client", "Unknown client", 401);
    if (!(await this.verifyClientSecret(client, input.clientSecret))) {
      throw new OauthError("invalid_client", "Invalid client authentication", 401);
    }

    const row = await this.db.query.oauthAuthCodes.findFirst({
      where: eq(oauthAuthCodes.codeHash, hashToken(input.code)),
    });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw new OauthError("invalid_grant", "Invalid or expired code", 400);
    }
    if (row.clientId !== input.clientId || row.redirectUri !== input.redirectUri) {
      throw new OauthError("invalid_grant", "Code / client / redirect mismatch", 400);
    }
    if (pkceS256(input.codeVerifier) !== row.codeChallenge) {
      throw new OauthError("invalid_grant", "PKCE verification failed", 400);
    }

    await this.db
      .update(oauthAuthCodes)
      .set({ usedAt: new Date() })
      .where(eq(oauthAuthCodes.id, row.id));

    return this.issueTokens({
      clientId: row.clientId,
      userId: row.userId,
      tenantId: row.tenantId,
      agentId: row.agentId,
      scope: row.scope,
      resource: input.resource ?? row.resource,
    });
  }

  private async exchangeRefresh(input: {
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    resource?: string | null;
  }) {
    if (!input.refreshToken || !input.clientId) {
      throw new OauthError("invalid_request", "refresh_token and client_id required", 400);
    }
    const client = await this.resolveClient(input.clientId);
    if (!client) throw new OauthError("invalid_client", "Unknown client", 401);
    if (!(await this.verifyClientSecret(client, input.clientSecret))) {
      throw new OauthError("invalid_client", "Invalid client authentication", 401);
    }

    const row = await this.db.query.oauthRefreshTokens.findFirst({
      where: and(
        eq(oauthRefreshTokens.tokenHash, hashToken(input.refreshToken)),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    });
    if (!row || row.expiresAt < new Date() || row.clientId !== input.clientId) {
      throw new OauthError("invalid_grant", "Invalid refresh token", 400);
    }

    // Rotate refresh token
    await this.db
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthRefreshTokens.id, row.id));

    return this.issueTokens({
      clientId: row.clientId,
      userId: row.userId,
      tenantId: row.tenantId,
      agentId: row.agentId,
      scope: row.scope,
      resource: input.resource ?? row.resource,
    });
  }

  private async issueTokens(input: {
    clientId: string;
    userId: string;
    tenantId: string;
    agentId?: string | null;
    scope: string;
    resource?: string | null;
  }): Promise<{
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    refresh_token?: string;
    scope: string;
    id_token?: string;
  }> {
    const now = Math.floor(Date.now() / 1000);
    const scope = normalizeGrantedScopes(input.scope, { clientId: input.clientId });
    const scopes = scopeSet(scope);
    const access = signAccessToken(this.config.secret, {
      typ: "mcp_at",
      sub: input.userId,
      tid: input.tenantId,
      cid: input.clientId,
      aid: input.agentId ?? null,
      scope,
      resource: input.resource ?? null,
      iat: now,
      exp: now + ACCESS_TTL_SEC,
      jti: newId(),
    });

    const refreshRaw = `rcr_${randomBytes(32).toString("base64url")}`;
    await this.db.insert(oauthRefreshTokens).values({
      tokenHash: hashToken(refreshRaw),
      clientId: input.clientId,
      userId: input.userId,
      tenantId: input.tenantId,
      agentId: input.agentId ?? null,
      scope,
      resource: input.resource ?? null,
      expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
    });

    const out: {
      access_token: string;
      token_type: "Bearer";
      expires_in: number;
      refresh_token?: string;
      scope: string;
      id_token?: string;
    } = {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshRaw,
      scope,
    };

    // OIDC：scope 含 openid 时签发 id_token（ChatGPT siwc / id_token_hint）
    if (scopes.has("openid")) {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, input.userId),
      });
      if (user) {
        const claims: IdTokenClaims = {
          iss: this.config.publicBaseUrl.replace(/\/$/, ""),
          sub: user.id,
          aud: input.clientId,
          iat: now,
          exp: now + ID_TOKEN_TTL_SEC,
          auth_time: now,
        };
        if (scopes.has("email")) {
          claims.email = user.email;
          claims.email_verified = true;
        }
        if (scopes.has("profile")) {
          if (user.name) claims.name = user.name;
          claims.preferred_username = user.email;
        }
        out.id_token = signJwtRs256(this.signingKey, claims);
      }
    }

    return out;
  }

  async revokeRefreshToken(token: string): Promise<void> {
    await this.db
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthRefreshTokens.tokenHash, hashToken(token)));
  }

  /**
   * OIDC UserInfo（OIDC Core §5.3）。
   * ChatGPT 在换票后拉取邮箱用于声明授权域（siwc）。
   * 按 access token 的 scope 过滤返回字段。
   */
  async userInfo(rawToken: string): Promise<{
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    preferred_username?: string;
  }> {
    const at = verifyAccessToken(this.config.secret, rawToken);
    if (!at) {
      throw new OauthError("invalid_token", "Invalid or expired access token", 401);
    }
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, at.sub),
    });
    if (!user) {
      throw new OauthError("invalid_token", "User not found", 401);
    }
    const scopes = scopeSet(at.scope);
    const out: {
      sub: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      preferred_username?: string;
    } = { sub: user.id };
    // 未声明 OIDC scope 时仍返回邮箱：兼容仅请求 mcp 的旧客户端 / ChatGPT
    if (scopes.has("email") || scopes.has("openid") || scopes.has("mcp")) {
      out.email = user.email;
      out.email_verified = true;
    }
    if (scopes.has("profile") || scopes.has("openid")) {
      if (user.name) out.name = user.name;
      out.preferred_username = user.email;
    }
    return out;
  }

  async authenticateBearer(rawToken: string): Promise<McpAuthContext | null> {
    // OAuth access token
    const at = verifyAccessToken(this.config.secret, rawToken);
    if (at) {
      const tenant = await this.db.query.tenants.findFirst({
        where: eq(tenants.id, at.tid),
      });
      if (!tenant) return null;
      return {
        tenant,
        userId: at.sub,
        agentId: at.aid ?? null,
        authMethod: "oauth",
        clientId: at.cid,
        scope: at.scope,
        apiKeyId: null,
      };
    }
    return null;
  }

  async listClients(tenantId: string) {
    const rows = await this.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.tenantId, tenantId))
      .orderBy(asc(oauthClients.createdAt));
    return rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      clientName: r.clientName,
      tokenEndpointAuthMethod: r.tokenEndpointAuthMethod,
      registrationType: r.registrationType,
      redirectUris: this.parseRedirectUris(r),
      scope: r.scope,
      createdAt: r.createdAt,
    }));
  }
}

export class OauthError extends Error {
  constructor(
    public readonly error: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "OauthError";
  }
}
