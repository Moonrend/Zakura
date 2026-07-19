import type { ProviderPlugin } from "@zakura/core";
import { textResult } from "@zakura/core";
import type {
  HealthResult,
  McpToolDef,
  McpToolResult,
  ProviderConfigSchema,
  RuntimeSpec,
} from "@zakura/shared";
import { mcpAuthHeaders, mcpHttpRpc } from "../lib/mcp-http.js";

/**
 * OpenViking — client only.
 * Point at an existing OpenViking HTTP/MCP endpoint; Zakura does not deploy it.
 */
const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "OpenViking",
  required: ["baseUrl"],
  properties: {
    baseUrl: {
      type: "string",
      title: "OpenViking Base URL",
      format: "url",
      description: "例如 http://127.0.0.1:1933",
    },
    apiKey: {
      type: "string",
      title: "API Key",
      format: "password",
    },
    headerName: {
      type: "string",
      title: "鉴权 Header",
      default: "Authorization",
    },
  },
};

function rootUrl(handle: { endpointUrl?: string | null; config: Record<string, unknown> }): string {
  const fromEndpoint = handle.endpointUrl?.replace(/\/$/, "");
  if (fromEndpoint && !fromEndpoint.startsWith("builtin:")) return fromEndpoint;
  return String(handle.config.baseUrl ?? "").replace(/\/$/, "");
}

function headers(config: Record<string, unknown>) {
  return mcpAuthHeaders({
    apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
    headerName: typeof config.headerName === "string" ? config.headerName : undefined,
  });
}

export function createOpenVikingProvider(): ProviderPlugin {
  return {
    id: "openviking",
    name: "OpenViking",
    description: "上下文文件系统客户端（连接已有 OpenViking，不部署容器）",
    version: "0.3.0",
    category: "context",
    capabilities: ["context-fs", "memory", "mcp-proxy", "tools", "builtin"],
    configSchema,

    validateConfig(config) {
      if (!config.baseUrl || typeof config.baseUrl !== "string") {
        throw new Error("baseUrl is required");
      }
      return config;
    },

    createRuntimeSpec(config): RuntimeSpec {
      return {
        containers: [],
        endpointTemplate: String(config.baseUrl).replace(/\/$/, ""),
      };
    },

    async healthCheck(handle): Promise<HealthResult> {
      try {
        const base = rootUrl(handle);
        const res = await fetch(`${base}/health`, {
          headers: headers(handle.config),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return { status: "healthy", message: `HTTP ${res.status}` };
        // fallback: MCP tools/list
        await mcpHttpRpc(`${base}/mcp`, headers(handle.config), "tools/list");
        return { status: "healthy", message: "MCP ok" };
      } catch (err) {
        return {
          status: "unhealthy",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async listTools(handle): Promise<McpToolDef[]> {
      const mcpUrl = `${rootUrl(handle)}/mcp`;
      try {
        const result = (await mcpHttpRpc(mcpUrl, headers(handle.config), "tools/list")) as {
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
      } catch (err) {
        return [
          {
            name: "health",
            description: `OpenViking 不可达: ${err instanceof Error ? err.message : String(err)}`,
            inputSchema: { type: "object", properties: {} },
          },
        ];
      }
    },

    async callTool(handle, toolName, args): Promise<McpToolResult> {
      const mcpUrl = `${rootUrl(handle)}/mcp`;
      try {
        const result = await mcpHttpRpc(mcpUrl, headers(handle.config), "tools/call", {
          name: toolName,
          arguments: args,
        });
        if (result && typeof result === "object" && "content" in result) {
          return result as McpToolResult;
        }
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  };
}
