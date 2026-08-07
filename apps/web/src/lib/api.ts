"use client";

const API_BASE = "";

export type PlatformInfo = {
  setupCompleted: boolean;
  version: string;
  mode: string;
  /** True when SaaS edition is active */
  multiTenant?: boolean;
  /** oss | saas */
  edition?: "oss" | "saas";
  /** Public self-registration (SaaS only) */
  registrationEnabled?: boolean;
  /** 邮箱密码登录；ZeroCat 启用后可由超管关闭 */
  passwordLoginEnabled?: boolean;
  /** Login OAuth providers (SaaS); secrets never included */
  oauthProviders?: Array<{ id: string; name: string; enabled: boolean }>;
};

type ApiInit = RequestInit & {
  json?: unknown;
  /**
   * GET 缓存 TTL（毫秒）。默认 2000；`false` / `0` 仅做 in-flight 去重不落缓存。
   * 轮询类接口（如 progress）请传 `false`。
   */
  cacheTtlMs?: number | false;
};

type CacheEntry = { expires: number; data: unknown };

const inflight = new Map<string, Promise<unknown>>();
const responseCache = new Map<string, CacheEntry>();
const DEFAULT_GET_TTL_MS = 2000;

function getSession(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("zakura_session");
}

export function setSession(token: string | null) {
  if (token) localStorage.setItem("zakura_session", token);
  else localStorage.removeItem("zakura_session");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("zakura_session_changed"));
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 清除 GET 响应缓存。传 path 前缀时仅清除匹配项（如 `/api/agents`）。 */
export function invalidateApiCache(pathPrefix?: string) {
  if (!pathPrefix) {
    responseCache.clear();
    return;
  }
  for (const key of responseCache.keys()) {
    if (key.includes(pathPrefix)) responseCache.delete(key);
  }
}

function requestKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

async function executeRequest<T>(path: string, init?: ApiInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  const session = getSession();
  if (session) headers.set("Authorization", `Bearer ${session}`);
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const { json: _json, cacheTtlMs: _ttl, ...fetchInit } = init ?? {};
  const res = await fetch(`${API_BASE}${path}`, { ...fetchInit, headers, body });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
      res.status,
      data,
    );
  }
  return data as T;
}

export async function api<T = unknown>(path: string, init?: ApiInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isGet =
    method === "GET" && init?.json === undefined && init?.body === undefined;

  if (!isGet) {
    // 写操作后整表失效，避免子页读到陈旧 agent/me 等
    invalidateApiCache();
    return executeRequest<T>(path, init);
  }

  const key = requestKey(method, path);
  const ttl =
    init?.cacheTtlMs === false || init?.cacheTtlMs === 0
      ? 0
      : (init?.cacheTtlMs ?? DEFAULT_GET_TTL_MS);

  if (ttl > 0) {
    const hit = responseCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.data as T;
  }

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = executeRequest<T>(path, init).then((data) => {
    if (ttl > 0) {
      responseCache.set(key, { expires: Date.now() + ttl, data });
    }
    return data;
  });

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}
