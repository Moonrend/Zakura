/** Shared MCP HTTP JSON-RPC helpers — Streamable HTTP + session + legacy SSE fallback */

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

/** Google Workspace MCP：OAuth 成功但 tools/call 仍报权限不足时的可操作提示 */
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

const PROTOCOL_CANDIDATES = ["2025-03-26", "2024-11-05"] as const;
const CLIENT_INFO = { name: "zakura", version: "0.4.0" };

type TransportMode = "streamable-http" | "sse-legacy";

type SessionState = {
  /** POST endpoint for JSON-RPC (may differ from user URL for legacy SSE) */
  postUrl: string;
  sessionId?: string;
  protocolVersion: string;
  mode: TransportMode;
  ready: boolean;
};

/** In-memory sessions keyed by normalized URL + auth fingerprint */
const sessions = new Map<string, SessionState>();

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

  // Supabase hosted MCP commonly lives under /mcp
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

function headerGet(res: Response, name: string): string | null {
  return res.headers.get(name) ?? res.headers.get(name.toLowerCase());
}

function isSessionRequiredError(err: unknown): boolean {
  if (!(err instanceof McpHttpError)) return false;
  if (err.status === 400 && /mcp-session-id|session.?id.*required|non-initialization/i.test(err.message)) {
    return true;
  }
  return false;
}

function isSessionLostError(err: unknown, hadSession: boolean): boolean {
  if (!(err instanceof McpHttpError)) return false;
  if (hadSession && err.status === 404) return true;
  if (isSessionRequiredError(err)) return true;
  return false;
}

export function unwrapRpc(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "result" in payload) {
    return (payload as { result: unknown }).result;
  }
  if (payload && typeof payload === "object" && "error" in payload) {
    throw new Error(JSON.stringify((payload as { error: unknown }).error));
  }
  return payload;
}

function parseRpcBody(raw: string, contentType: string | null): unknown {
  const ct = contentType ?? "";
  const trimmed = raw.trim();
  // 仅在明确 SSE 时走 event-stream 解析；避免 JSON 正文含 "data:" 被误判。
  const isSseContentType = ct.includes("text/event-stream");
  const looksLikeSsePayload =
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[") &&
    /(?:^|\n)\s*data:\s*/.test(raw);

  if (isSseContentType || looksLikeSsePayload) {
    const lines = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    // Prefer last JSON-RPC response that has result/error
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]!);
        if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) {
          return unwrapRpc(parsed);
        }
      } catch {
        /* continue */
      }
    }
    const last = lines.at(-1);
    if (!last) {
      // 空 SSE（仅 heartbeat/注释）时尝试按 JSON 回退
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return unwrapRpc(JSON.parse(trimmed));
      }
      throw new McpHttpError(
        "Empty SSE MCP response（上游无有效 JSON-RPC。若该服务同时提供 npm/PyPI/OCI 包，请改用 Stdio 安装）",
        { kind: "parse" },
      );
    }
    return unwrapRpc(JSON.parse(last));
  }
  if (!trimmed) return {};
  return unwrapRpc(JSON.parse(raw));
}

type PostResult = {
  result: unknown;
  sessionId: string | null;
  protocolVersion: string | null;
  status: number;
  wwwAuthenticate: string;
};

async function postJsonRpc(opts: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  sessionId?: string;
  protocolVersion?: string;
  timeoutMs: number;
  /** Accept 202 with empty body (notifications) */
  allowEmptyAccepted?: boolean;
}): Promise<PostResult> {
  const reqHeaders: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (opts.sessionId) {
    reqHeaders["Mcp-Session-Id"] = opts.sessionId;
  }
  if (opts.protocolVersion) {
    reqHeaders["MCP-Protocol-Version"] = opts.protocolVersion;
  }

  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    throw new McpHttpError(
      err instanceof Error ? err.message : `fetch failed: ${String(err)}`,
      { kind: "network", cause: err },
    );
  }

  const raw = await res.text();
  const sessionId = headerGet(res, "mcp-session-id");
  const protocolVersion = headerGet(res, "mcp-protocol-version");
  const wwwAuthenticate = headerGet(res, "www-authenticate") ?? "";

  if (res.status === 202 && opts.allowEmptyAccepted) {
    return {
      result: {},
      sessionId,
      protocolVersion,
      status: res.status,
      wwwAuthenticate,
    };
  }

  if (!res.ok) {
    const hint =
      res.status === 404
        ? "（若为 Notion，请使用 https://mcp.notion.com/mcp；会话过期时客户端会自动重连）"
        : "";
    throw new McpHttpError(`MCP HTTP ${res.status}: ${raw.slice(0, 400)}${hint}`, {
      status: res.status,
      wwwAuthenticate,
      kind: res.status === 401 || res.status === 403 ? "auth" : "http",
    });
  }

  try {
    if (!raw.trim() && opts.allowEmptyAccepted) {
      return { result: {}, sessionId, protocolVersion, status: res.status, wwwAuthenticate };
    }
    const result = parseRpcBody(raw, res.headers.get("content-type"));
    return { result, sessionId, protocolVersion, status: res.status, wwwAuthenticate };
  } catch (err) {
    if (err instanceof McpHttpError) throw err;
    throw new McpHttpError(
      err instanceof Error ? err.message : `Invalid MCP response: ${raw.slice(0, 200)}`,
      { kind: "parse", cause: err },
    );
  }
}

/** Legacy HTTP+SSE: GET /sse → endpoint event → POST messages there */
async function discoverLegacySseEndpoint(
  sseUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(sseUrl, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new McpHttpError(
      err instanceof Error ? err.message : `SSE GET failed: ${String(err)}`,
      { kind: "network", cause: err },
    );
  }

  if (!res.ok) {
    throw new McpHttpError(`Legacy SSE HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, {
      status: res.status,
      wwwAuthenticate: headerGet(res, "www-authenticate") ?? "",
      kind: res.status === 401 || res.status === 403 ? "auth" : "http",
    });
  }

  const reader = res.body?.getReader();
  if (!reader) throw new McpHttpError("Legacy SSE: empty body", { kind: "parse" });

  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + Math.min(timeoutMs, 12000);

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = /(?:^|\n)event:\s*(\S+)/.exec(block)?.[1];
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (event === "endpoint" && data) {
        void reader.cancel().catch(() => undefined);
        try {
          return new URL(data, sseUrl).toString();
        } catch {
          return data;
        }
      }
      // Some servers only send data without event name
      if (!event && data.startsWith("/") ) {
        void reader.cancel().catch(() => undefined);
        return new URL(data, sseUrl).toString();
      }
    }
  }

  void reader.cancel().catch(() => undefined);
  throw new McpHttpError("Legacy SSE: timed out waiting for endpoint event", { kind: "parse" });
}

async function initializeStreamable(
  postUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<SessionState> {
  let lastErr: unknown;
  for (const protocolVersion of PROTOCOL_CANDIDATES) {
    try {
      const init = await postJsonRpc({
        url: postUrl,
        headers,
        timeoutMs,
        body: {
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "initialize",
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          },
        },
      });

      const negotiated =
        (init.result &&
        typeof init.result === "object" &&
        "protocolVersion" in init.result &&
        typeof (init.result as { protocolVersion?: unknown }).protocolVersion === "string"
          ? (init.result as { protocolVersion: string }).protocolVersion
          : null) ||
        init.protocolVersion ||
        protocolVersion;

      const sessionId = init.sessionId ?? undefined;
      const state: SessionState = {
        postUrl,
        sessionId,
        protocolVersion: negotiated,
        mode: "streamable-http",
        ready: true,
      };

      // notifications/initialized (no id)
      try {
        await postJsonRpc({
          url: postUrl,
          headers,
          timeoutMs: Math.min(timeoutMs, 10000),
          sessionId,
          protocolVersion: negotiated,
          allowEmptyAccepted: true,
          body: {
            jsonrpc: "2.0",
            method: "notifications/initialized",
          },
        });
      } catch {
        // Some servers ignore/reject the notification; session may still be usable
      }

      return state;
    } catch (err) {
      lastErr = err;
      // Auth errors shouldn't try other protocol versions
      if (isMcpAuthError(err)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function ensureSession(
  mcpUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<SessionState> {
  const normalized = normalizeMcpHttpUrl(mcpUrl);
  const key = sessionCacheKey(normalized, headers);
  const cached = sessions.get(key);
  if (cached?.ready) return cached;

  try {
    const state = await initializeStreamable(normalized, headers, timeoutMs);
    sessions.set(key, state);
    return state;
  } catch (streamableErr) {
    // Fall back to legacy HTTP+SSE when streamable initialize fails with 404/405
    if (
      streamableErr instanceof McpHttpError &&
      (streamableErr.status === 404 || streamableErr.status === 405)
    ) {
      try {
        const sseUrl = deriveLegacySseUrl(normalized);
        const messageUrl = await discoverLegacySseEndpoint(sseUrl, headers, timeoutMs);
        const state = await initializeStreamable(messageUrl, headers, timeoutMs);
        state.mode = "sse-legacy";
        sessions.set(key, state);
        return state;
      } catch (sseErr) {
        // Prefer original streamable error (often more actionable)
        if (isMcpAuthError(sseErr)) throw sseErr;
        throw streamableErr;
      }
    }
    throw streamableErr;
  }
}

function invalidateSession(mcpUrl: string, headers: Record<string, string>) {
  sessions.delete(sessionCacheKey(normalizeMcpHttpUrl(mcpUrl), headers));
}

export async function mcpHttpRpc(
  mcpUrl: string,
  headers: Record<string, string>,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 20000,
): Promise<unknown> {
  const normalized = normalizeMcpHttpUrl(mcpUrl);

  // Allow direct initialize for OAuth discovery probes
  if (method === "initialize") {
    const init = await postJsonRpc({
      url: normalized,
      headers,
      timeoutMs,
      body: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "initialize",
        params: params ?? {
          protocolVersion: PROTOCOL_CANDIDATES[0],
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      },
    });
    return init.result;
  }

  const run = async (session: SessionState) => {
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
    };
    if (params) body.params = params;

    const res = await postJsonRpc({
      url: session.postUrl,
      headers,
      timeoutMs,
      sessionId: session.sessionId,
      protocolVersion: session.protocolVersion,
      body,
    });

    // Server may rotate session id
    if (res.sessionId && res.sessionId !== session.sessionId) {
      session.sessionId = res.sessionId;
      sessions.set(sessionCacheKey(normalized, headers), session);
    }
    return res.result;
  };

  let session = await ensureSession(normalized, headers, timeoutMs);
  try {
    return await run(session);
  } catch (err) {
    if (isSessionLostError(err, !!session.sessionId) || isSessionRequiredError(err)) {
      invalidateSession(normalized, headers);
      session = await ensureSession(normalized, headers, timeoutMs);
      return await run(session);
    }
    // First request got 404 without us ever having a session — might be wrong path;
    // try once more after invalidating (ensureSession may take SSE fallback)
    if (err instanceof McpHttpError && err.status === 404 && !session.sessionId) {
      invalidateSession(normalized, headers);
      try {
        session = await ensureSession(normalized, headers, timeoutMs);
        return await run(session);
      } catch {
        throw err;
      }
    }
    throw err;
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

/** True when config has usable static key or OAuth access token */
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

/** Clear cached MCP sessions (tests / logout) */
export function clearMcpHttpSessions(): void {
  sessions.clear();
}
