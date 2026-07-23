/**
 * OAuth Client ID Metadata Document (CIMD) — MCP / ChatGPT 推荐的客户端注册方式。
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document
 * @see https://developers.openai.com/apps-sdk/build/auth
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type CimdDocument = {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  /** 单值（旧式 / 部分客户端） */
  token_endpoint_auth_method?: string;
  /**
   * ChatGPT CIMD 用 RP Metadata Choices：声明客户端支持的鉴权方式。
   * AS 侧与自身 `token_endpoint_auth_methods_supported` 取交集。
   */
  token_endpoint_auth_methods_supported?: string[];
  scope?: string;
  jwks_uri?: string;
  client_uri?: string;
  logo_uri?: string;
};

type CacheEntry = {
  doc: CimdDocument;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/** CIMD client_id 必须是带 path 的 https URL（无 fragment / userinfo / .|.. 段） */
export function isCimdClientId(clientId: string): boolean {
  try {
    // 在 URL 规范化前检查原始路径中的 . / .. 段
    if (
      clientId.includes("/../") ||
      clientId.includes("/./") ||
      /\/\.\.?(?:[?#]|$)/.test(clientId)
    ) {
      return false;
    }
    const u = new URL(clientId);
    if (u.protocol !== "https:") return false;
    if (!u.pathname || u.pathname === "/") return false;
    if (u.username || u.password) return false;
    if (u.hash) return false;
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.some((s) => s === "." || s === "..")) return false;
    return true;
  } catch {
    return false;
  }
}

function isPrivateOrLocalIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("fe80:")) return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if (isIP(mapped) === 4) return isPrivateOrLocalIp(mapped);
    }
    return false;
  }
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "metadata.google.internal"
  ) {
    return true;
  }
  if (isIP(h) && isPrivateOrLocalIp(h)) return true;
  return false;
}

/** 解析主机并拒绝私网 / 回环，降低 SSRF 风险 */
async function assertPublicHttpsTarget(url: URL): Promise<void> {
  if (url.protocol !== "https:") {
    throw new Error("CIMD client_id 必须使用 https");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error(`CIMD 主机不允许: ${url.hostname}`);
  }
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length) {
    throw new Error(`无法解析 CIMD 主机: ${url.hostname}`);
  }
  for (const r of records) {
    if (isPrivateOrLocalIp(r.address)) {
      throw new Error(`CIMD 主机解析到私网地址，已拒绝: ${r.address}`);
    }
  }
}

function parseCacheControlMaxAge(header: string | null): number | null {
  if (!header) return null;
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(header);
  if (!m?.[1]) return null;
  return Number(m[1]);
}

function clampTtlMs(sec: number | null): number {
  if (sec == null || !Number.isFinite(sec)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, sec * 1000));
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && !!x.trim());
  return out.length ? out : undefined;
}

export function parseCimdDocument(raw: unknown, expectedClientId: string): CimdDocument {
  if (!raw || typeof raw !== "object") {
    throw new Error("CIMD 文档不是 JSON 对象");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.client_id !== "string" || obj.client_id !== expectedClientId) {
    throw new Error("CIMD 文档 client_id 必须与文档 URL 完全一致");
  }
  const redirectUris = asStringArray(obj.redirect_uris);
  if (!redirectUris?.length) {
    throw new Error("CIMD 文档缺少 redirect_uris");
  }

  const authMethods = asStringArray(obj.token_endpoint_auth_methods_supported);
  const authMethod =
    typeof obj.token_endpoint_auth_method === "string"
      ? obj.token_endpoint_auth_method
      : undefined;

  // 禁止对称密钥类方法（CIMD 无法建立共享密钥）
  const forbidden = new Set([
    "client_secret_post",
    "client_secret_basic",
    "client_secret_jwt",
  ]);
  if (authMethod && forbidden.has(authMethod)) {
    throw new Error(`CIMD 不支持 token_endpoint_auth_method=${authMethod}`);
  }
  if (authMethods) {
    const allowed = authMethods.filter((m) => !forbidden.has(m));
    if (!allowed.length) {
      throw new Error("CIMD 未声明可用的公开客户端鉴权方式");
    }
  }

  if ("client_secret" in obj || "client_secret_expires_at" in obj) {
    throw new Error("CIMD 文档不得包含 client_secret");
  }

  return {
    client_id: obj.client_id,
    client_name: typeof obj.client_name === "string" ? obj.client_name : undefined,
    redirect_uris: redirectUris,
    grant_types: asStringArray(obj.grant_types),
    response_types: asStringArray(obj.response_types),
    token_endpoint_auth_method: authMethod,
    token_endpoint_auth_methods_supported: authMethods,
    scope: typeof obj.scope === "string" ? obj.scope : undefined,
    jwks_uri: typeof obj.jwks_uri === "string" ? obj.jwks_uri : undefined,
    client_uri: typeof obj.client_uri === "string" ? obj.client_uri : undefined,
    logo_uri: typeof obj.logo_uri === "string" ? obj.logo_uri : undefined,
  };
}

const TRUSTED_CIMD_HOSTS: Record<
  string,
  { client_name: string; redirect_uri_prefixes: string[] }
> = {
  "chatgpt.com": {
    client_name: "ChatGPT",
    redirect_uri_prefixes: [
      "https://chatgpt.com/connector/oauth/",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chat.openai.com/connector/oauth/",
    ],
  },
  "chat.openai.com": {
    client_name: "ChatGPT",
    redirect_uri_prefixes: [
      "https://chatgpt.com/connector/oauth/",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chat.openai.com/connector/oauth/",
    ],
  },
  "claude.ai": {
    client_name: "Claude",
    redirect_uri_prefixes: [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.ai/oauth/",
    ],
  },
};

/** Cloudflare WAF 等导致 CIMD 拉取失败时，对受信主机回退为前缀 allowlist */
export function trustedCimdFallback(clientId: string): CimdDocument | null {
  if (!isCimdClientId(clientId)) return null;
  try {
    const host = new URL(clientId).hostname.toLowerCase();
    const trusted = TRUSTED_CIMD_HOSTS[host];
    if (!trusted) return null;
    return {
      client_id: clientId,
      client_name: trusted.client_name,
      redirect_uris: trusted.redirect_uri_prefixes,
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  } catch {
    return null;
  }
}

/**
 * 从 ChatGPT / Claude 等托管的 CIMD URL 拉取元数据。
 * 不跟随重定向（防 SSRF）。受信主机拉取失败时回退 allowlist。
 */
export async function fetchCimdDocument(
  clientId: string,
  opts?: {
    fetchImpl?: typeof fetch;
    skipCache?: boolean;
    /** 仅测试：跳过 DNS/私网校验 */
    skipSsrfCheck?: boolean;
  },
): Promise<CimdDocument> {
  if (!isCimdClientId(clientId)) {
    throw new Error("client_id 不是合法的 CIMD URL");
  }

  if (!opts?.skipCache) {
    const hit = cache.get(clientId);
    if (hit && hit.expiresAt > Date.now()) return hit.doc;
  }

  const url = new URL(clientId);
  if (!opts?.skipSsrfCheck) {
    await assertPublicHttpsTarget(url);
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(clientId, {
      method: "GET",
      redirect: "manual",
      signal: ac.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Zakura-MCP-OAuth/1.0 (CIMD)",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    const fallback = trustedCimdFallback(clientId);
    if (fallback) {
      cache.set(clientId, { doc: fallback, expiresAt: Date.now() + DEFAULT_TTL_MS });
      return fallback;
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }

  // 3xx：规范实现通常不跟随；拒绝以防跳到内网
  if (res.status >= 300 && res.status < 400) {
    const fallback = trustedCimdFallback(clientId);
    if (fallback) {
      cache.set(clientId, { doc: fallback, expiresAt: Date.now() + DEFAULT_TTL_MS });
      return fallback;
    }
    throw new Error(`CIMD 拉取被重定向（HTTP ${res.status}），已拒绝`);
  }
  if (!res.ok) {
    const fallback = trustedCimdFallback(clientId);
    if (fallback) {
      cache.set(clientId, { doc: fallback, expiresAt: Date.now() + DEFAULT_TTL_MS });
      return fallback;
    }
    throw new Error(`CIMD 拉取失败: HTTP ${res.status}`);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    const fallback = trustedCimdFallback(clientId);
    if (fallback) {
      cache.set(clientId, { doc: fallback, expiresAt: Date.now() + DEFAULT_TTL_MS });
      return fallback;
    }
    throw new Error("CIMD 响应不是合法 JSON");
  }

  const doc = parseCimdDocument(raw, clientId);
  const maxAge = parseCacheControlMaxAge(res.headers.get("cache-control"));
  cache.set(clientId, {
    doc,
    expiresAt: Date.now() + clampTtlMs(maxAge),
  });
  return doc;
}

/** 在 AS 支持的方法与 CIMD 声明之间选择鉴权方式（偏好 private_key_jwt，否则 none） */
export function pickCimdTokenAuthMethod(
  doc: CimdDocument,
  asSupported: string[],
): string {
  const clientMethods =
    doc.token_endpoint_auth_methods_supported ??
    (doc.token_endpoint_auth_method ? [doc.token_endpoint_auth_method] : ["none"]);
  const asSet = new Set(asSupported);
  const intersection = clientMethods.filter((m) => asSet.has(m));
  if (intersection.includes("private_key_jwt")) return "private_key_jwt";
  if (intersection.includes("none")) return "none";
  if (intersection.length) return intersection[0]!;
  // 文档未声明时，按公开客户端处理
  if (asSet.has("none")) return "none";
  throw new Error("CIMD 与授权服务器无共同的 token_endpoint_auth_method");
}

/** 测试用：清空内存缓存 */
export function clearCimdCache(): void {
  cache.clear();
}
