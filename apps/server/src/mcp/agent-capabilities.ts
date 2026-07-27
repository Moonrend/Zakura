/**
 * Agent MCP 对外能力声明（2025-11-25 core + 2026-07-28 extensions 前向兼容）
 */
import { buildAgentMcpInstructions } from "./instructions.js";

export { buildAgentMcpInstructions } from "./instructions.js";
export type { AgentMcpInstructionsOpts } from "./instructions.js";

export const AGENT_MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2026-07-28"] as const;

/** 官方扩展 ID（SEP-2133 / SEP-2663 / SEP-1865） */
export const EXT_TASKS = "io.modelcontextprotocol/tasks";
export const EXT_APPS = "io.modelcontextprotocol/apps";

export function buildAgentMcpCapabilities(opts?: { pathSlug?: string }) {
  void opts;
  return {
    // 用 {} 宣告能力即可；Inspector 以 capability 存在与否门控 list RPC
    tools: {},
    resources: {},
    prompts: {},
    completions: {},
    // 部分客户端（Claude / 旧 Inspector）在未检查 capability 时也会发 logging/setLevel
    logging: {},
    // 2025-11-25 experimental tasks（旧客户端）
    tasks: {
      list: {},
      cancel: {},
      requests: {
        tools: { call: {} },
      },
    },
    // 2026-07-28 extensions map（新客户端 / server/discover）
    extensions: {
      [EXT_TASKS]: {},
      [EXT_APPS]: {},
    },
  };
}

export function buildDiscoverResult(opts: {
  pathSlug: string;
  instructions?: string;
  agentName?: string;
}) {
  const capabilities = buildAgentMcpCapabilities({ pathSlug: opts.pathSlug });
  return {
    resultType: "complete" as const,
    supportedVersions: [...AGENT_MCP_PROTOCOL_VERSIONS],
    capabilities,
    instructions:
      opts.instructions ??
      buildAgentMcpInstructions({
        pathSlug: opts.pathSlug,
        agentName: opts.agentName,
        detail: "brief",
      }),
    ttlMs: 3_600_000,
    cacheScope: "private" as const,
    _meta: {
      "io.modelcontextprotocol/serverInfo": {
        name: "zakura-agent",
        version: "0.2.0",
        title: `Zakura Agent (${opts.pathSlug})`,
      },
    },
  };
}

export type HostedInputRequest = {
  type: "elicitation";
  mode?: "form" | "url";
  message: string;
  requestedSchema?: Record<string, unknown>;
  url?: string;
};

/** 从 tools/list annotations 判断是否需要托管确认 */
export function toolNeedsHostedConfirm(tool: {
  localName: string;
  annotations?: { destructiveHint?: boolean; openWorldHint?: boolean } | null;
}): boolean {
  if (tool.annotations?.destructiveHint) return true;
  const base = tool.localName.replace(/^re_/, "").replace(/^.*__/, "");
  return (
    base.includes("delete") ||
    base.includes("remove") ||
    base === "shell_exec" ||
    base.startsWith("containers_")
  );
}
