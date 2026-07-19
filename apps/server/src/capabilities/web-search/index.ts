import type { SearchEngineId } from "@zakura/shared";
import { getSearchEngine, listSearchEngineMeta } from "./engines.js";
import type { SearchHit, WebSearchConfig } from "./types.js";

export { listSearchEngineMeta, getSearchEngine };
export type { WebSearchConfig, SearchHit } from "./types.js";

export function enabledEngines(config: WebSearchConfig): SearchEngineId[] {
  const ids: SearchEngineId[] = [];
  for (const [id, cfg] of Object.entries(config.engines ?? {})) {
    if (cfg?.enabled) ids.push(id as SearchEngineId);
  }
  return ids;
}

export function resolveEngineId(
  config: WebSearchConfig,
  requested?: string,
): SearchEngineId {
  const enabled = enabledEngines(config);
  if (!enabled.length) {
    throw new Error("未启用任何搜索引擎，请先在「网页搜索」中配置");
  }
  if (requested) {
    if (!enabled.includes(requested as SearchEngineId)) {
      throw new Error(`引擎未启用: ${requested}`);
    }
    return requested as SearchEngineId;
  }
  if (config.defaultEngine && enabled.includes(config.defaultEngine)) {
    return config.defaultEngine;
  }
  return enabled[0]!;
}

export async function runWebSearch(
  config: WebSearchConfig,
  args: { query: string; engine?: string; limit?: number; language?: string },
): Promise<{ engine: SearchEngineId; results: SearchHit[] }> {
  const query = args.query?.trim();
  if (!query) throw new Error("query is required");

  const engineId = resolveEngineId(config, args.engine);
  const engine = getSearchEngine(engineId);
  if (!engine) throw new Error(`Unknown engine: ${engineId}`);

  const creds = config.engines?.[engineId] ?? { enabled: true };
  const results = await engine.search(
    { query, limit: args.limit, language: args.language },
    {
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      extra: creds.extra,
    },
  );
  return { engine: engineId, results };
}
