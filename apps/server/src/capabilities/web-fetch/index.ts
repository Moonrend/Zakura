import type { FetchBackendId } from "@zakura/shared";
import { getFetchBackend, listFetchBackendMeta } from "./backends.js";
import type { FetchResult, WebFetchConfig } from "./types.js";

export { listFetchBackendMeta, getFetchBackend };
export type { WebFetchConfig, FetchResult } from "./types.js";

export function enabledBackends(config: WebFetchConfig): FetchBackendId[] {
  const ids: FetchBackendId[] = [];
  for (const [id, cfg] of Object.entries(config.backends ?? {})) {
    if (cfg?.enabled) ids.push(id as FetchBackendId);
  }
  return ids;
}

export function resolveBackendId(
  config: WebFetchConfig,
  requested?: string,
): FetchBackendId {
  const enabled = enabledBackends(config);
  if (!enabled.length) {
    throw new Error("未启用任何抓取后端，请先在「网页抓取」中配置");
  }
  if (requested) {
    if (!enabled.includes(requested as FetchBackendId)) {
      throw new Error(`后端未启用: ${requested}`);
    }
    return requested as FetchBackendId;
  }
  if (config.defaultBackend && enabled.includes(config.defaultBackend)) {
    return config.defaultBackend;
  }
  return enabled[0]!;
}

export async function runWebFetch(
  config: WebFetchConfig,
  args: { url: string; backend?: string; timeoutMs?: number },
): Promise<FetchResult> {
  const url = args.url?.trim();
  if (!url) throw new Error("url is required");
  const backendId = resolveBackendId(config, args.backend);
  const backend = getFetchBackend(backendId);
  if (!backend) throw new Error(`Unknown backend: ${backendId}`);
  const creds = config.backends?.[backendId] ?? { enabled: true };
  return backend.fetch(
    { url, timeoutMs: args.timeoutMs },
    { apiKey: creds.apiKey, baseUrl: creds.baseUrl },
  );
}
