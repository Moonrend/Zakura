/**
 * Agent Hooks：对齐 Claude Code / Codex 插件 hooks.json 的核心事件子集。
 * 存在 agent.configJson.hooks，由插件安装合并或手动配置。
 */

export const AGENT_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
] as const;

export type AgentHookEvent = (typeof AGENT_HOOK_EVENTS)[number];

export type AgentHookActionType = "command" | "prompt";

export type AgentHookAction = {
  type: AgentHookActionType;
  /** shell 命令（支持 ${CLAUDE_PLUGIN_ROOT} / ${ZAKURA_PLUGIN_ROOT}） */
  command?: string;
  /** 直接注入上下文的提示文本 */
  prompt?: string;
  timeoutMs?: number;
};

export type AgentHookMatcherGroup = {
  /** 工具名正则；缺省匹配全部 */
  matcher?: string;
  hooks: AgentHookAction[];
};

export type AgentHooksByEvent = Partial<Record<AgentHookEvent, AgentHookMatcherGroup[]>>;

/** 一条已安装的 hook 包（通常来自一个插件） */
export type AgentHookPackage = {
  id: string;
  /** 展示名 */
  name: string;
  /** plugin:slug / manual / store:... */
  source: string;
  enabled: boolean;
  events: AgentHooksByEvent;
  /** 插件根路径（工作区内），用于替换 ${CLAUDE_PLUGIN_ROOT} */
  pluginRoot?: string;
};

export function parseAgentHookPackages(raw: unknown): AgentHookPackage[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentHookPackage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string") continue;
    const events = normalizeHooksByEvent(row.events);
    out.push({
      id: row.id,
      name: row.name,
      source: typeof row.source === "string" ? row.source : "manual",
      enabled: row.enabled !== false,
      events,
      pluginRoot: typeof row.pluginRoot === "string" ? row.pluginRoot : undefined,
    });
  }
  return out;
}

export function normalizeHooksByEvent(raw: unknown): AgentHooksByEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: AgentHooksByEvent = {};
  for (const event of AGENT_HOOK_EVENTS) {
    const groups = src[event];
    if (!Array.isArray(groups)) continue;
    const parsed: AgentHookMatcherGroup[] = [];
    for (const g of groups) {
      if (!g || typeof g !== "object" || Array.isArray(g)) continue;
      const group = g as Record<string, unknown>;
      const hooksRaw = group.hooks;
      if (!Array.isArray(hooksRaw)) continue;
      const hooks: AgentHookAction[] = [];
      for (const h of hooksRaw) {
        if (!h || typeof h !== "object" || Array.isArray(h)) continue;
        const action = h as Record<string, unknown>;
        const type = action.type === "prompt" ? "prompt" : "command";
        hooks.push({
          type,
          command: typeof action.command === "string" ? action.command : undefined,
          prompt: typeof action.prompt === "string" ? action.prompt : undefined,
          timeoutMs: typeof action.timeoutMs === "number" ? action.timeoutMs : undefined,
        });
      }
      if (!hooks.length) continue;
      parsed.push({
        matcher: typeof group.matcher === "string" ? group.matcher : undefined,
        hooks,
      });
    }
    if (parsed.length) out[event] = parsed;
  }
  return out;
}

/** 解析 Claude hooks.json 根对象 → AgentHooksByEvent */
export function parseHooksJson(raw: unknown): AgentHooksByEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const root = raw as Record<string, unknown>;
  // 常见形态：{ hooks: { PreToolUse: [...] } } 或直接 { PreToolUse: [...] }
  const body = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks)
    ? root.hooks
    : root;
  return normalizeHooksByEvent(body);
}

export function mergeHookPackages(
  existing: AgentHookPackage[],
  incoming: AgentHookPackage,
): AgentHookPackage[] {
  const idx = existing.findIndex((p) => p.id === incoming.id || p.source === incoming.source);
  if (idx < 0) return [...existing, incoming];
  const next = existing.slice();
  next[idx] = { ...existing[idx]!, ...incoming, events: incoming.events };
  return next;
}

export function matcherHits(matcher: string | undefined, toolName: string): boolean {
  if (!matcher?.trim()) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return toolName.includes(matcher);
  }
}
