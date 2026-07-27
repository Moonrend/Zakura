import type { ProviderPlugin } from "@zakura/core";
import { textResult } from "@zakura/core";
import type {
  HealthResult,
  McpToolDef,
  McpToolResult,
  ProviderConfigSchema,
  RuntimeSpec,
  SearchEngineId,
} from "@zakura/shared";
import { SEARCH_ENGINE_IDS } from "@zakura/shared";
import { normalizeSlots } from "../capabilities/cred-slots.js";
import {
  enabledEngines,
  listSearchEngineMeta,
  mergeWebSearchConfig,
  runWebSearch,
  type EngineRuntimeConfig,
  type WebSearchConfig,
} from "../capabilities/web-search/index.js";

function parseConfig(raw: Record<string, unknown>): WebSearchConfig {
  const enginesIn = (raw.engines as Record<string, EngineRuntimeConfig | undefined>) ?? {};
  const engines: WebSearchConfig["engines"] = {};
  for (const [id, cfg] of Object.entries(enginesIn)) {
    if (!cfg || !SEARCH_ENGINE_IDS.includes(id as SearchEngineId)) continue;
    const slots = normalizeSlots(cfg);
    engines[id as SearchEngineId] = {
      enabled: Boolean(cfg.enabled),
      slots: slots.length
        ? slots.map((s) => ({
            id: s.id,
            label: s.label,
            usePlatform: s.usePlatform,
            apiKey: s.apiKey,
            baseUrl: s.baseUrl,
            extra: s.extra,
          }))
        : undefined,
      // keep legacy fields out of stored form after normalize
    };
  }
  const defaultEngine =
    typeof raw.defaultEngine === "string" &&
    SEARCH_ENGINE_IDS.includes(raw.defaultEngine as SearchEngineId)
      ? (raw.defaultEngine as SearchEngineId)
      : undefined;
  return { defaultEngine, engines };
}

const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "网页搜索",
  required: [],
  properties: {
    defaultEngine: {
      type: "string",
      title: "默认引擎",
      enum: [...SEARCH_ENGINE_IDS],
      description: "在管理台「网页」中配置各引擎后生效",
    },
  },
};

export function createWebSearchProvider(): ProviderPlugin {
  return {
    id: "web-search",
    name: "网页搜索",
    description: "多引擎搜索 API（Tavily / Serper / Brave / SearXNG 等）",
    version: "0.2.0",
    category: "web-search",
    capabilities: ["search", "tools", "builtin"],
    configSchema,

    validateConfig(config) {
      return parseConfig(config) as unknown as Record<string, unknown>;
    },

    createRuntimeSpec(): RuntimeSpec {
      return { containers: [], endpointTemplate: "builtin://web-search" };
    },

    async healthCheck(handle): Promise<HealthResult> {
      const cfg = parseConfig(handle.config);
      const n = enabledEngines(cfg).length;
      return {
        status: n > 0 ? "healthy" : "unhealthy",
        message: n > 0 ? `${n} engine(s) enabled` : "no engines enabled",
      };
    },

    async listTools(handle): Promise<McpToolDef[]> {
      const cfg = parseConfig(handle.config);
      const engines = enabledEngines(cfg);
      const meta = listSearchEngineMeta().filter((e) => engines.includes(e.id));
      return [
        {
          name: "web_search",
          title: "Web Search",
          description: `网页搜索。可用引擎: ${meta.map((e) => e.id).join(", ") || "（未配置）"}`,
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string", description: "搜索词" },
              engine: {
                type: "string",
                enum: engines.length ? engines : [...SEARCH_ENGINE_IDS],
                description: "指定引擎；省略则用默认",
              },
              limit: { type: "number", default: 8 },
              language: { type: "string", description: "如 zh-CN / en" },
            },
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: true,
            idempotentHint: true,
          },
        },
      ];
    },

    async callTool(handle, toolName, args): Promise<McpToolResult> {
      if (toolName !== "web_search") return textResult(`Unknown tool: ${toolName}`, true);
      try {
        const cfg = parseConfig(handle.config);
        const result = await runWebSearch(
          cfg,
          {
            query: String(args.query ?? ""),
            engine: typeof args.engine === "string" ? args.engine : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
            language: typeof args.language === "string" ? args.language : undefined,
          },
          { tenantId: handle.tenantId },
        );
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  };
}

export { mergeWebSearchConfig, parseConfig as parseWebSearchConfig };
