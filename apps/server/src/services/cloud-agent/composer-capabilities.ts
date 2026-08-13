/**
 * Composer 加号菜单的能力清单：已装技能 + 可开关的工具组。
 * 分组按「功能 / 连接器 / MCP 实例」，关掉一组就展开成 disabledTools。
 */
import type { ComposerCapabilities, ComposerToolGroup } from "@zakura/shared";
import { DELEGATE_TOOL_NAME } from "./tools.js";
import {
  CREATE_SCHEDULE_TOOL,
  DELETE_SCHEDULE_TOOL,
  LIST_AUTOMATION_RUNS_TOOL,
  LIST_SCHEDULES_TOOL,
  RUN_SCHEDULE_TOOL,
  UPDATE_SCHEDULE_TOOL,
} from "./automation-tools.js";
import {
  GET_MESSAGES_TOOL,
  IMPORT_SESSION_TOOL,
  LIST_SESSIONS_TOOL,
  SEARCH_SESSIONS_TOOL,
} from "./session-tools.js";
import { CRISIS_SUPPORT_TOOL } from "./crisis-support-tools.js";
import {
  SUBAGENT_PROVIDER_ID,
  SUBAGENT_TOOL_QUALIFIED,
} from "../mcp-gateway.js";

const DIRECT_CONNECTOR_PROVIDER_ID = "zakura-connector";

export type ComposerToolInput = {
  qualifiedName: string;
  providerId: string;
  instanceId?: string | null;
  localName?: string;
  description?: string;
  agentScoped?: boolean;
  _meta?: Record<string, unknown>;
};

const CHAT_EXTRA_GROUPS: ComposerToolGroup[] = [
  {
    id: "builtin:sessions",
    kind: "builtin",
    label: "会话",
    tools: [LIST_SESSIONS_TOOL, SEARCH_SESSIONS_TOOL, GET_MESSAGES_TOOL, IMPORT_SESSION_TOOL],
  },
  {
    id: "builtin:automation",
    kind: "builtin",
    label: "自动化",
    tools: [
      LIST_SCHEDULES_TOOL,
      CREATE_SCHEDULE_TOOL,
      UPDATE_SCHEDULE_TOOL,
      DELETE_SCHEDULE_TOOL,
      RUN_SCHEDULE_TOOL,
      LIST_AUTOMATION_RUNS_TOOL,
    ],
  },
  {
    id: "builtin:delegate",
    kind: "builtin",
    label: "委派 Agent",
    tools: [DELEGATE_TOOL_NAME],
  },
];

const KIND_ORDER: Record<ComposerToolGroup["kind"], number> = {
  builtin: 0,
  connector: 1,
  mcp: 2,
};

export function stripToolPrefix(name: string): string {
  return name.startsWith("re_") ? name.slice(3) : name;
}

/** 从 re_{slug}__local 里取出实例 slug；对不上则退回整段 */
export function instanceSlugFromName(qualifiedName: string, localName?: string): string {
  const rest = stripToolPrefix(qualifiedName);
  if (localName) {
    const suffix = `__${localName}`;
    if (rest.endsWith(suffix)) return rest.slice(0, -suffix.length);
  }
  const sep = rest.indexOf("__");
  return sep > 0 ? rest.slice(0, sep) : rest;
}

function builtinBucket(local: string): { id: string; label: string } | null {
  if (
    local.startsWith("fs_") ||
    local === "apply_patch" ||
    local.startsWith("shell_") ||
    local === "get_file_url" ||
    local === "revoke_file_url" ||
    local === "list_file_urls"
  ) {
    return { id: "builtin:computer", label: "电脑环境" };
  }
  if (local.startsWith("computer_") || local === "desktop_info") {
    return { id: "builtin:desktop", label: "桌面控制" };
  }
  if (local.startsWith("browser_")) {
    return { id: "builtin:browser", label: "浏览器" };
  }
  if (local.includes("memory")) {
    return { id: "builtin:memory", label: "记忆" };
  }
  if (local.includes("skill")) {
    return { id: "builtin:skills", label: "技能工具" };
  }
  if (local.includes("expos")) {
    return { id: "builtin:expose", label: "端口暴露" };
  }
  if (local === "agent_info" || local === "list_exposers") {
    return null;
  }
  return { id: "builtin:other", label: "其他内置" };
}

function classifyTool(tool: ComposerToolInput): { id: string; kind: ComposerToolGroup["kind"]; label: string } | null {
  const name = tool.qualifiedName;
  if (!name || name === CRISIS_SUPPORT_TOOL) return null;

  const meta = tool._meta ?? {};
  const connectorRef = typeof meta.connectorRef === "string" ? meta.connectorRef.trim() : "";
  if (tool.providerId === DIRECT_CONNECTOR_PROVIDER_ID || connectorRef) {
    const ref = connectorRef || instanceSlugFromName(name, tool.localName);
    const label =
      (typeof meta.connectorName === "string" && meta.connectorName.trim()) || ref || "连接器";
    return { id: `connector:${ref}`, kind: "connector", label };
  }

  if (tool.providerId === "web-search") {
    return { id: "builtin:web-search", kind: "builtin", label: "网页搜索" };
  }
  if (tool.providerId === "web-fetch") {
    return { id: "builtin:web-fetch", kind: "builtin", label: "网页抓取" };
  }
  if (tool.providerId === SUBAGENT_PROVIDER_ID || name === SUBAGENT_TOOL_QUALIFIED) {
    return { id: "builtin:subagent", kind: "builtin", label: "子代理" };
  }

  if (tool.providerId === "zakura-agent") {
    const bucket = builtinBucket(stripToolPrefix(tool.localName || name));
    return bucket ? { ...bucket, kind: "builtin" } : null;
  }

  if (tool.instanceId) {
    const slug = instanceSlugFromName(name, tool.localName);
    const fromDesc = tool.description?.match(/^\[([^\]]+)\]/)?.[1]?.trim();
    return { id: `mcp:${tool.instanceId}`, kind: "mcp", label: fromDesc || slug };
  }

  const bucket = builtinBucket(stripToolPrefix(tool.localName || name));
  return bucket ? { ...bucket, kind: "builtin" } : null;
}

export function groupComposerTools(tools: ComposerToolInput[]): ComposerToolGroup[] {
  const byId = new Map<string, ComposerToolGroup>();
  const seenTools = new Set<string>();

  const add = (group: { id: string; kind: ComposerToolGroup["kind"]; label: string }, toolName: string) => {
    if (!toolName || seenTools.has(toolName) || toolName === CRISIS_SUPPORT_TOOL) return;
    seenTools.add(toolName);
    const existing = byId.get(group.id);
    if (existing) {
      if (!existing.tools.includes(toolName)) existing.tools.push(toolName);
      return;
    }
    byId.set(group.id, { id: group.id, kind: group.kind, label: group.label, tools: [toolName] });
  };

  for (const tool of tools) {
    const bucket = classifyTool(tool);
    if (!bucket) continue;
    add(bucket, tool.qualifiedName);
  }

  for (const extra of CHAT_EXTRA_GROUPS) {
    if (!byId.has(extra.id)) {
      byId.set(extra.id, { ...extra, tools: [...extra.tools] });
    }
  }

  return [...byId.values()].sort((a, b) => {
    const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (kind !== 0) return kind;
    return a.label.localeCompare(b.label, "zh-CN");
  });
}

export function expandDisabledGroups(
  groups: ComposerToolGroup[],
  disabledGroupIds: readonly string[],
): string[] {
  if (!disabledGroupIds.length) return [];
  const disabled = new Set(disabledGroupIds);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!disabled.has(group.id)) continue;
    for (const name of group.tools) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export function toComposerCapabilities(input: {
  skills?: Array<{ name: string; title?: string; description?: string; enabled?: boolean; status?: string }>;
  tools: ComposerToolInput[];
}): ComposerCapabilities {
  const skills = (input.skills ?? [])
    .filter((s) => s.enabled !== false && s.status !== "error")
    .map((s) => ({
      name: s.name,
      title: s.title?.trim() || s.name,
      description: s.description ?? "",
    }));
  return { skills, groups: groupComposerTools(input.tools) };
}
