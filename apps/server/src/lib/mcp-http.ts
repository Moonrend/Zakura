/**
 * 上游 MCP HTTP 客户端 — 基于 @modelcontextprotocol/sdk
 * Streamable HTTP 优先，失败时回退 legacy SSE。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  CallToolResultSchema,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

export class McpHttpError extends Error {
  readonly status: number;
  readonly wwwAuthenticate: string;
  readonly kind: "auth" | "network" | "http" | "parse";

  constructor(
    message: string,
    opts: {
      status?: number;
      wwwAuthenticate?: string;
      kind?: McpHttpError["kind"];
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = "McpHttpError";
    this.status = opts.status ?? 0;
    this.wwwAuthenticate = opts.wwwAuthenticate ?? "";
    this.kind =
      opts.kind ??
      (opts.status === 401 || opts.status === 403
        ? "auth"
        : opts.status
          ? "http"
          : "network");
  }
}

export function isMcpAuthError(err: unknown): boolean {
  if (err instanceof McpHttpError) return err.kind === "auth";
  if (err instanceof UnauthorizedError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b401\b|\b403\b|unauthorized|authorization header|authentication required|auth_required/i.test(
    msg,
  );
}

export function isMcpNetworkError(err: unknown): boolean {
  if (err instanceof McpHttpError) return err.kind === "network";
  if (!(err instanceof Error)) return false;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  const code = cause?.code ?? "";
  return (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|AbortError/i.test(err.message)
  );
}

export function mcpErrorSummary(err: unknown): string {
  if (err instanceof McpHttpError) {
    if (err.kind === "auth") return `AUTH_REQUIRED: ${err.message.slice(0, 180)}`;
    if (err.kind === "network") return `UNREACHABLE: ${err.message.slice(0, 180)}`;
    return annotateGoogleMcpPermission(err.message).slice(0, 320);
  }
  if (isMcpAuthError(err)) {
    return `AUTH_REQUIRED: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240);
  }
  if (isMcpNetworkError(err)) {
    const cause =
      err instanceof Error
        ? (err as Error & { cause?: { hostname?: string; code?: string } }).cause
        : undefined;
    const host = cause?.hostname ? ` (${cause.hostname})` : "";
    return `UNREACHABLE${host}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240);
  }
  const raw = err instanceof Error ? err.message : String(err);
  return annotateGoogleMcpPermission(raw).slice(0, 320);
}

function annotateGoogleMcpPermission(message: string): string {
  if (/Chat app not found|configure the app in the Google Cloud console/i.test(message)) {
    return (
      "Google Chat 应用未配置：请在 GCP 打开 Chat API → Configuration，填写 App name 并保存。" +
      " 链接：https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat" +
      ` 原始错误：${message.slice(0, 120)}`
    );
  }
  if (!/does not have permission|PERMISSION_DENIED|caller does not have permission/i.test(message)) {
    return message;
  }
  return (
    "Google API 权限不足。请确认 OAuth 同意屏幕已添加对应 scopes，且 GCP 项目已启用 gmail/drive/calendar/people/chat API。" +
    ` 原始错误：${message}`
  );
}

const CLIENT_INFO = { name: "zakura", version: "0.4.0" } as const;

type TransportMode = "streamable-http" | "sse-legacy";

type SessionEntry = {
  client: Client;
  mode: TransportMode;
  mcpUrl: string;
};

const sessions = new Map<string, SessionEntry>();

function authFingerprint(headers: Record<string, string>): string {
  const auth =
    headers.Authorization ??
    headers.authorization ??
    headers["X-Api-Key"] ??
    headers["x-api-key"] ??
    "";
  return auth ? auth.slice(0, 48) : "";
}

function sessionCacheKey(mcpUrl: string, headers: Record<string, string>): string {
  return `${normalizeMcpHttpUrl(mcpUrl)}\0${authFingerprint(headers)}`;
}

/**
 * Normalize common remote MCP URLs:
 * - Notion: /sse → /mcp, bare host → /mcp
 * - Trailing slash trim
 */
export function normalizeMcpHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }

  const host = url.hostname.toLowerCase();
  let path = url.pathname.replace(/\/+$/, "") || "/";

  if (host === "mcp.notion.com") {
    if (path === "/" || path === "") path = "/mcp";
    else if (path === "/sse") path = "/mcp";
  }

  if (host === "mcp.supabase.com" && (path === "/" || path === "")) {
    path = "/mcp";
  }

  url.pathname = path;
  return url.toString().replace(/\/$/, path === "/" ? "/" : "");
}

function deriveLegacySseUrl(streamableUrl: string): string {
  try {
    const u = new URL(streamableUrl);
    const path = u.pathname.replace(/\/+$/, "");
    if (path.endsWith("/mcp")) {
      u.pathname = `${path.slice(0, -4)}/sse`;
    } else if (path === "" || path === "/") {
      u.pathname = "/sse";
    } else if (!path.endsWith("/sse")) {
      u.pathname = `${path}/sse`;
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return streamableUrl.replace(/\/mcp\/?$/, "/sse");
  }
}

function rethrowAsMcpHttpError(err: unknown): never {
  if (err instanceof McpHttpError) throw err;
  if (err instanceof UnauthorizedError) {
    throw new McpHttpError(err.message || "Unauthorized", {
      status: 401,
      kind: "auth",
      cause: err,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  const statusMatch = /\b(401|403|404|405|500)\b/.exec(msg);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  if (status === 401 || status === 403 || /unauthorized/i.test(msg)) {
    throw new McpHttpError(msg, { status: status || 401, kind: "auth", cause: err });
  }
  if (isMcpNetworkError(err)) {
    throw new McpHttpError(msg, { kind: "network", cause: err });
  }
  throw new McpHttpError(msg, {
    status,
    kind: status ? "http" : "parse",
    cause: err,
  });
}

async function connectStreamable(
  url: string,
  headers: Record<string, string>,
): Promise<SessionEntry> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { ...headers } },
  });
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);
  return { client, mode: "streamable-http", mcpUrl: url };
}

async function connectLegacySse(
  streamableUrl: string,
  headers: Record<string, string>,
): Promise<SessionEntry> {
  const sseUrl = deriveLegacySseUrl(streamableUrl);
  const transport = new SSEClientTransport(new URL(sseUrl), {
    requestInit: { headers: { ...headers } },
  });
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);
  return { client, mode: "sse-legacy", mcpUrl: streamableUrl };
}

function isFallbackWorthy(err: unknown): boolean {
  if (err instanceof McpHttpError) {
    return err.status === 404 || err.status === 405;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b|\b405\b|Method Not Allowed|not found/i.test(msg);
}

async function ensureClient(
  mcpUrl: string,
  headers: Record<string, string>,
): Promise<SessionEntry> {
  const normalized = normalizeMcpHttpUrl(mcpUrl);
  const key = sessionCacheKey(normalized, headers);
  const cached = sessions.get(key);
  if (cached) return cached;

  try {
    const entry = await connectStreamable(normalized, headers);
    sessions.set(key, entry);
    return entry;
  } catch (streamableErr) {
    if (isMcpAuthError(streamableErr)) rethrowAsMcpHttpError(streamableErr);
    if (!isFallbackWorthy(streamableErr)) rethrowAsMcpHttpError(streamableErr);
    try {
      const entry = await connectLegacySse(normalized, headers);
      sessions.set(key, entry);
      return entry;
    } catch (sseErr) {
      if (isMcpAuthError(sseErr)) rethrowAsMcpHttpError(sseErr);
      rethrowAsMcpHttpError(streamableErr);
    }
  }
}

async function invalidateAndReconnect(
  mcpUrl: string,
  headers: Record<string, string>,
): Promise<SessionEntry> {
  const normalized = normalizeMcpHttpUrl(mcpUrl);
  const key = sessionCacheKey(normalized, headers);
  const old = sessions.get(key);
  sessions.delete(key);
  if (old) {
    await old.client.close().catch(() => undefined);
  }
  return ensureClient(normalized, headers);
}

function isSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /session|mcp-session-id|404/i.test(msg);
}

/** @deprecated 保留兼容；SDK Client 已自动 unwrap JSON-RPC */
export function unwrapRpc(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "result" in payload) {
    return (payload as { result: unknown }).result;
  }
  if (payload && typeof payload === "object" && "error" in payload) {
    throw new Error(JSON.stringify((payload as { error: unknown }).error));
  }
  return payload;
}

export async function mcpHttpRpc(
  mcpUrl: string,
  headers: Record<string, string>,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 20000,
): Promise<unknown> {
  const normalized = normalizeMcpHttpUrl(mcpUrl);
  const requestOpts = { timeout: timeoutMs };

  // OAuth / 探测：一次性连接，返回 initialize 结果后关闭
  if (method === "initialize") {
    try {
      const entry = await connectStreamable(normalized, headers).catch(async (err) => {
        if (isMcpAuthError(err)) rethrowAsMcpHttpError(err);
        if (isFallbackWorthy(err)) return connectLegacySse(normalized, headers);
        rethrowAsMcpHttpError(err);
      });
      const result = {
        protocolVersion: "2025-11-25",
        capabilities: entry.client.getServerCapabilities() ?? {},
        serverInfo: entry.client.getServerVersion() ?? CLIENT_INFO,
        instructions: undefined as string | undefined,
      };
      await entry.client.close().catch(() => undefined);
      return result;
    } catch (err) {
      rethrowAsMcpHttpError(err);
    }
  }

  const run = async (entry: SessionEntry) => {
    if (method === "tools/list") {
      return entry.client.listTools(
        params as { cursor?: string } | undefined,
        requestOpts,
      );
    }
    if (method === "tools/call") {
      return entry.client.callTool(
        {
          name: String(params?.name ?? ""),
          arguments: (params?.arguments as Record<string, unknown>) ?? {},
        },
        CallToolResultSchema,
        requestOpts,
      );
    }
    // resources / prompts 列表用宽松 ResultSchema：
    // 上游常缺 name、带 nextCursor:null 等，严格 List*ResultSchema 会导致整表失败，
    // Inspector / 聚合网关表现为「拿不到 resources/prompts」（tools 仍有原生工具可显示）。
    if (method === "resources/list") {
      return entry.client.request(
        { method: "resources/list", params },
        ResultSchema,
        requestOpts,
      );
    }
    if (method === "resources/read") {
      return entry.client.readResource(
        { uri: String(params?.uri ?? "") },
        requestOpts,
      );
    }
    if (method === "resources/templates/list") {
      return entry.client.request(
        { method: "resources/templates/list", params },
        ResultSchema,
        requestOpts,
      );
    }
    if (method === "prompts/list") {
      return entry.client.request(
        { method: "prompts/list", params },
        ResultSchema,
        requestOpts,
      );
    }
    if (method === "prompts/get") {
      return entry.client.getPrompt(
        {
          name: String(params?.name ?? ""),
          arguments: params?.arguments as Record<string, string> | undefined,
        },
        requestOpts,
      );
    }
    if (method === "completion/complete") {
      return entry.client.complete(
        params as Parameters<Client["complete"]>[0],
        requestOpts,
      );
    }
    if (method === "ping") {
      await entry.client.ping(requestOpts);
      return {};
    }
    return entry.client.request(
      { method, params } as Parameters<Client["request"]>[0],
      ResultSchema,
      requestOpts,
    );
  };

  try {
    const entry = await ensureClient(normalized, headers);
    try {
      return await run(entry);
    } catch (err) {
      if (isSessionError(err) || isMcpAuthError(err) === false && /404|session/i.test(String(err))) {
        const fresh = await invalidateAndReconnect(normalized, headers);
        return await run(fresh);
      }
      rethrowAsMcpHttpError(err);
    }
  } catch (err) {
    rethrowAsMcpHttpError(err);
  }
}

export function mcpAuthHeaders(opts: {
  apiKey?: string;
  headerName?: string;
}): Record<string, string> {
  const h: Record<string, string> = {};
  const key = opts.apiKey?.trim();
  if (!key) return h;
  const name = opts.headerName?.trim() || "Authorization";
  h[name] = name.toLowerCase() === "authorization" ? `Bearer ${key}` : key;
  return h;
}

export function hasMcpCredentials(config: Record<string, unknown>): boolean {
  const oauth =
    typeof config.oauthAccessToken === "string" ? config.oauthAccessToken.trim() : "";
  if (oauth) return true;
  const key = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  return key.length > 0;
}

export type ProbedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export async function probeMcpTools(opts: {
  mcpUrl: string;
  apiKey?: string;
  headerName?: string;
  oauthAccessToken?: string;
}): Promise<ProbedTool[]> {
  const headers = opts.oauthAccessToken?.trim()
    ? { Authorization: `Bearer ${opts.oauthAccessToken.trim()}` }
    : mcpAuthHeaders(opts);
  const result = (await mcpHttpRpc(
    normalizeMcpHttpUrl(opts.mcpUrl),
    headers,
    "tools/list",
  )) as {
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
  };

  return (result.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
  }));
}

export function clearMcpHttpSessions(): void {
  for (const entry of sessions.values()) {
    void entry.client.close().catch(() => undefined);
  }
  sessions.clear();
}
