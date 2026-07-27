import type { ProviderPlugin } from "@zakura/core";
import { textResult } from "@zakura/core";
import type {
  FetchBackendId,
  HealthResult,
  McpToolDef,
  McpToolResult,
  ProviderConfigSchema,
  RuntimeSpec,
} from "@zakura/shared";
import { FETCH_BACKEND_IDS } from "@zakura/shared";
import { normalizeSlots } from "../capabilities/cred-slots.js";
import {
  enabledBackends,
  listFetchBackendMeta,
  mergeWebFetchConfig,
  runWebFetch,
  type BackendRuntimeConfig,
  type WebFetchConfig,
} from "../capabilities/web-fetch/index.js";

function parseConfig(raw: Record<string, unknown>): WebFetchConfig {
  const backendsIn =
    (raw.backends as Record<string, BackendRuntimeConfig | undefined>) ?? {};
  const backends: WebFetchConfig["backends"] = {};
  for (const [id, cfg] of Object.entries(backendsIn)) {
    if (!cfg || !FETCH_BACKEND_IDS.includes(id as FetchBackendId)) continue;
    const slots = normalizeSlots(cfg);
    backends[id as FetchBackendId] = {
      enabled: Boolean(cfg.enabled),
      slots: slots.length
        ? slots.map((s) => ({
            id: s.id,
            label: s.label,
            usePlatform: s.usePlatform,
            apiKey: s.apiKey,
            baseUrl: s.baseUrl,
          }))
        : undefined,
    };
  }
  const defaultBackend =
    typeof raw.defaultBackend === "string" &&
    FETCH_BACKEND_IDS.includes(raw.defaultBackend as FetchBackendId)
      ? (raw.defaultBackend as FetchBackendId)
      : undefined;
  return { defaultBackend, backends };
}

const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "网页抓取",
  required: [],
  properties: {
    defaultBackend: {
      type: "string",
      title: "默认后端",
      enum: [...FETCH_BACKEND_IDS],
      description: "在管理台「网页」中配置各后端后生效",
    },
  },
};

export function createWebFetchProvider(): ProviderPlugin {
  return {
    id: "web-fetch",
    name: "网页抓取",
    description: "web_fetch：Native / Jina Reader / Firecrawl / Crawl4AI / Cloudflare Markdown",
    version: "0.2.0",
    category: "web-fetch",
    capabilities: ["fetch", "tools", "builtin"],
    configSchema,

    validateConfig(config) {
      return parseConfig(config) as unknown as Record<string, unknown>;
    },

    createRuntimeSpec(): RuntimeSpec {
      return { containers: [], endpointTemplate: "builtin://web-fetch" };
    },

    async healthCheck(handle): Promise<HealthResult> {
      const cfg = parseConfig(handle.config);
      const n = enabledBackends(cfg).length;
      return {
        status: n > 0 ? "healthy" : "unhealthy",
        message: n > 0 ? `${n} backend(s) enabled` : "no backends enabled",
      };
    },

    async listTools(handle): Promise<McpToolDef[]> {
      const cfg = parseConfig(handle.config);
      const backends = enabledBackends(cfg);
      const meta = listFetchBackendMeta().filter((b) => backends.includes(b.id));
      return [
        {
          name: "web_fetch",
          title: "Web Fetch",
          description: `读取网页正文。可用后端: ${meta.map((b) => b.id).join(", ") || "（未配置）"}`,
          inputSchema: {
            type: "object",
            required: ["url"],
            properties: {
              url: { type: "string", description: "http(s) URL" },
              backend: {
                type: "string",
                enum: backends.length ? backends : [...FETCH_BACKEND_IDS],
                description: "指定后端；省略则用默认",
              },
              timeout_ms: { type: "number", default: 25000 },
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
      if (toolName !== "web_fetch") return textResult(`Unknown tool: ${toolName}`, true);
      try {
        const cfg = parseConfig(handle.config);
        const result = await runWebFetch(
          cfg,
          {
            url: String(args.url ?? ""),
            backend: typeof args.backend === "string" ? args.backend : undefined,
            timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
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

export { mergeWebFetchConfig, parseConfig as parseWebFetchConfig };
