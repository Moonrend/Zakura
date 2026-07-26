import type { ModelUpstreamConfig, ModelUpstreamProtocol } from "@zakura/shared";

export function buildHeaders(
  cfg: ModelUpstreamConfig,
  protocol: ModelUpstreamProtocol,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(cfg.extraHeaders ?? {}),
  };
  if (cfg.apiKey) {
    if (protocol === "azure-openai") {
      headers["api-key"] = cfg.apiKey;
    } else if (protocol !== "gemini") {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
    }
  }
  return headers;
}

export async function httpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const timeoutMs = init.timeoutMs ?? 60000;
  const { timeoutMs: _drop, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: T | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = null;
    }
  }
  return { ok: res.ok, status: res.status, data, text };
}

export function apiError(prefix: string, status: number, data: unknown, text: string): Error {
  const msg =
    data && typeof data === "object" && data !== null && "error" in data
      ? String((data as { error?: { message?: string } }).error?.message ?? text)
      : text.slice(0, 500);
  return new Error(`${prefix} HTTP ${status}: ${msg}`);
}

/** 限制并发，避免 Gemini 逐条 embed 时打满连接 */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, concurrency);
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
