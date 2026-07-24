import type { Agent } from "../db/schema.js";

/** Per-agent selection of tenant-managed providers / defaults */
export type AgentProvidersConfig = {
  webSearch?: {
    /** When false, web_search tools are not exposed to this agent */
    enabled?: boolean;
    /** Override tenant default engine (must be globally enabled) */
    defaultEngine?: string;
  };
  webFetch?: {
    enabled?: boolean;
    defaultBackend?: string;
  };
  /**
   * Extra MCP / component instances (generic-mcp, openviking, …).
   * - mode "all": inherit every running non-capability instance
   * - mode "selected": only instances listed in agent_bindings / instanceIds (default)
   */
  mcp?: {
    mode?: "all" | "selected";
    instanceIds?: string[];
    /**
     * 通过 MCP Resources / Resource Templates 暴露 Agent 云端工作区文件系统。
     * 默认开启；显式设为 false 可关闭。
     * Resources = 可枚举的具体 URI；Templates = `zakura://agent/fs/{+path}` 按需读任意路径。
     */
    exposeWorkspaceFs?: boolean;
  };
};

export type AgentConfigBag = {
  providers?: AgentProvidersConfig;
  [key: string]: unknown;
};

export function parseAgentConfig(agent: Agent | { configJson: string }): AgentConfigBag {
  try {
    const raw = JSON.parse(agent.configJson) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as AgentConfigBag;
  } catch {
    return {};
  }
}

export function getAgentProviders(agent: Agent | { configJson: string }): AgentProvidersConfig {
  return parseAgentConfig(agent).providers ?? {};
}

/** Capability tools are opt-in — must be explicitly enabled per agent */
export function isWebSearchEnabledForAgent(agent: Agent): boolean {
  return getAgentProviders(agent).webSearch?.enabled === true;
}

export function isWebFetchEnabledForAgent(agent: Agent): boolean {
  return getAgentProviders(agent).webFetch?.enabled === true;
}

export function getAgentMcpMode(agent: Agent): "all" | "selected" {
  const mode = getAgentProviders(agent).mcp?.mode;
  return mode === "all" ? "all" : "selected";
}

/** 是否通过 MCP Resources 暴露云端工作区 FS（默认开启） */
export function isWorkspaceFsExposedViaMcp(agent: Agent): boolean {
  return getAgentProviders(agent).mcp?.exposeWorkspaceFs !== false;
}

export function mergeAgentProviders(
  current: AgentConfigBag,
  patch: AgentProvidersConfig,
): AgentConfigBag {
  const prev = current.providers ?? {};
  const next: AgentProvidersConfig = { ...prev };

  if (patch.webSearch) {
    next.webSearch = { ...prev.webSearch };
    if (patch.webSearch.enabled !== undefined) next.webSearch.enabled = patch.webSearch.enabled;
    if ("defaultEngine" in patch.webSearch) {
      const v = patch.webSearch.defaultEngine;
      if (v === undefined || v === "") delete next.webSearch.defaultEngine;
      else next.webSearch.defaultEngine = v;
    }
  }
  if (patch.webFetch) {
    next.webFetch = { ...prev.webFetch };
    if (patch.webFetch.enabled !== undefined) next.webFetch.enabled = patch.webFetch.enabled;
    if ("defaultBackend" in patch.webFetch) {
      const v = patch.webFetch.defaultBackend;
      if (v === undefined || v === "") delete next.webFetch.defaultBackend;
      else next.webFetch.defaultBackend = v;
    }
  }
  if (patch.mcp) {
    next.mcp = {
      ...prev.mcp,
      ...patch.mcp,
    };
  }

  return {
    ...current,
    providers: next,
  };
}
