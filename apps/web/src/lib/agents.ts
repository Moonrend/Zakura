import { api } from "@/lib/api";

export type WorkspaceInfo = {
  status: string;
  dockerId: string | null;
  image?: string | null;
  running?: boolean;
};

export type AgentListItem = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  enableComputer: boolean;
  enableMemory: boolean;
  memoryProviderId?: string | null;
  /** Bound runtime node; null = implicit local */
  runtimeNodeId?: string | null;
  workspaceStatus?: string;
  lastError?: string | null;
  mcpAgentUrl: string;
  needsContainer?: boolean;
  config?: Record<string, unknown>;
  workspace?: WorkspaceInfo;
};

export type ProgressEvent = {
  ts: number;
  level: string;
  step: string;
  message: string;
  percent?: number;
};

export type ProgressSnapshot = {
  phase: string;
  percent: number;
  running: boolean;
  done: boolean;
  error: string | null;
  events: ProgressEvent[];
};

export type AgentDetail = AgentListItem & {
  tools: Array<{
    name: string;
    description?: string;
    agentScoped: boolean;
    providerId?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  resources?: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    title?: string;
    providerId?: string;
  }>;
  prompts?: Array<{
    name: string;
    description?: string;
    title?: string;
    arguments?: Array<{ name: string; description?: string; required?: boolean }>;
    providerId?: string;
  }>;
  resourceTemplates?: Array<{
    uriTemplate: string;
    name: string;
    description?: string;
    mimeType?: string;
    title?: string;
    providerId?: string;
  }>;
  desktop?: {
    enabled: boolean;
    novncUrl: string | null;
  };
};

export type AgentProviderOptions = {
  providers: {
    webSearch?: { enabled?: boolean; defaultEngine?: string };
    webFetch?: { enabled?: boolean; defaultBackend?: string };
    mcp?: { mode?: "all" | "selected"; instanceIds?: string[] };
  };
  webSearch: {
    instanceId: string;
    status: string;
    tenantDefaultEngine: string | null;
    engines: Array<{ id: string; name: string; description: string }>;
    agent: { enabled: boolean; defaultEngine: string | null };
  };
  webFetch: {
    instanceId: string;
    status: string;
    tenantDefaultBackend: string | null;
    backends: Array<{ id: string; name: string; description: string }>;
    agent: { enabled: boolean; defaultBackend: string | null };
  };
  mcp: {
    mode: "all" | "selected";
    /** 通过 MCP Resources 暴露云端工作区 */
    exposeWorkspaceFs?: boolean;
    instances: Array<{
      id: string;
      name: string;
      slug: string;
      providerId: string;
      status: string;
      bound: boolean;
    }>;
  };
  memory: {
    enabled: boolean;
    providerId?: string | null;
    note: string;
  };
};

export function statusVariant(s: string) {
  if (s === "running" || s === "ready" || s === "healthy") return "success" as const;
  if (s === "error" || s === "unhealthy") return "danger" as const;
  if (s === "starting" || s === "stopping") return "warn" as const;
  if (s === "idle" || s === "none" || s === "stopped" || s === "removed" || s === "exited") {
    return "secondary" as const;
  }
  return "secondary" as const;
}

export function workspaceStatusLabel(s: string | undefined | null) {
  if (!s || s === "none") return "无容器";
  if (s === "idle") return "未启动";
  if (s === "running") return "运行中";
  if (s === "starting") return "启动中";
  if (s === "stopping") return "停止中";
  if (s === "stopped" || s === "exited" || s === "removed") return "已停止";
  if (s === "error") return "错误";
  return s;
}

export function levelColor(level: string) {
  if (level === "error") return "text-destructive";
  if (level === "ok") return "text-success";
  if (level === "warn") return "text-warning-foreground";
  return "text-muted-foreground";
}

export function needsContainer(a: { enableComputer?: boolean; needsContainer?: boolean }) {
  return a.needsContainer ?? Boolean(a.enableComputer);
}

export function getWorkspaceStatus(a: AgentListItem): string {
  return a.workspace?.status ?? (needsContainer(a) ? "idle" : "none");
}

export async function fetchAgents() {
  return api<AgentListItem[]>("/api/agents");
}

export async function fetchAgent(id: string) {
  return api<AgentDetail>(`/api/agents/${id}`);
}

export async function fetchAgentProviders(id: string) {
  return api<AgentProviderOptions>(`/api/agents/${id}/providers`);
}

export async function saveAgentProviders(
  id: string,
  body: {
    webSearch?: { enabled?: boolean; defaultEngine?: string | null };
    webFetch?: { enabled?: boolean; defaultBackend?: string | null };
    mcp?: {
      mode?: "all" | "selected";
      instanceIds?: string[];
      exposeWorkspaceFs?: boolean;
    };
    enableMemory?: boolean;
  },
) {
  return api<{ options: AgentProviderOptions }>(`/api/agents/${id}/providers`, {
    method: "PUT",
    json: body,
  });
}

export async function fetchAgentProgress(id: string) {
  return api<{
    agent: { lastError: string | null };
    workspace: WorkspaceInfo;
    progress: ProgressSnapshot;
  }>(`/api/agents/${id}/progress`, { cacheTtlMs: false });
}

export const AGENT_SUBNAV = [
  { href: "overview", label: "概况" },
  { href: "settings", label: "设置" },
  { href: "computer", label: "电脑" },
  { href: "web", label: "网页" },
  { href: "memory", label: "记忆" },
  { href: "skills", label: "技能" },
  { href: "mcp", label: "MCP" },
  { href: "platforms", label: "消息平台" },
  { href: "tool-calls", label: "调用记录" },
] as const;
