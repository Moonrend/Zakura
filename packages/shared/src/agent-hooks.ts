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
  "PreCommit",
  "Stop",
  "PreCompact",
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
  /** Claude permission-rule：如 Bash(git commit*)，只在工具事件上过滤 */
  if?: string;
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

function canonicalHookEvent(key: string): AgentHookEvent | undefined {
  if ((AGENT_HOOK_EVENTS as readonly string[]).includes(key)) return key as AgentHookEvent;
  const lower = key.toLowerCase();
  return AGENT_HOOK_EVENTS.find((event) => event.toLowerCase() === lower);
}

function parseHookAction(raw: unknown): AgentHookAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const action = raw as Record<string, unknown>;
  const type: AgentHookActionType = action.type === "prompt" ? "prompt" : "command";
  let timeoutMs: number | undefined;
  if (typeof action.timeoutMs === "number" && Number.isFinite(action.timeoutMs)) {
    timeoutMs = action.timeoutMs;
  } else if (typeof action.timeout === "number" && Number.isFinite(action.timeout)) {
    // Claude / VS Code / Cursor：timeout 单位是秒
    timeoutMs = action.timeout * 1000;
  }
  return {
    type,
    command: typeof action.command === "string" ? action.command : undefined,
    prompt: typeof action.prompt === "string" ? action.prompt : undefined,
    timeoutMs,
    if: typeof action.if === "string" ? action.if : undefined,
  };
}

function parseMatcherGroup(raw: unknown): AgentHookMatcherGroup | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const group = raw as Record<string, unknown>;
  const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
  if (Array.isArray(group.hooks)) {
    const hooks: AgentHookAction[] = [];
    for (const item of group.hooks) {
      const action = parseHookAction(item);
      if (action) hooks.push(action);
    }
    if (!hooks.length) return null;
    return { matcher, hooks };
  }
  // VS Code / Copilot / Cursor：事件数组里直接放 { type, command }，没有 hooks[] 包一层
  const action = parseHookAction(group);
  if (!action || (!action.command?.trim() && !action.prompt?.trim())) return null;
  return { matcher, hooks: [action] };
}

export function normalizeHooksByEvent(raw: unknown): AgentHooksByEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: AgentHooksByEvent = {};
  for (const [key, groups] of Object.entries(src)) {
    const event = canonicalHookEvent(key);
    if (!event || !Array.isArray(groups)) continue;
    const parsed: AgentHookMatcherGroup[] = [];
    for (const g of groups) {
      const group = parseMatcherGroup(g);
      if (group) parsed.push(group);
    }
    if (parsed.length) out[event] = [...(out[event] ?? []), ...parsed];
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

/** Claude Code 工具名 → 本平台工具（含 re_ 前缀与裸名） */
const CLAUDE_TOOL_NAME: Record<string, string> = {
  shell_exec: "Bash",
  fs_write: "Write",
  fs_edit: "Edit",
  fs_read: "Read",
  fs_list: "Glob",
  fs_grep: "Grep",
  apply_patch: "Edit",
};

export function hookToolBareName(toolName: string): string {
  return toolName.startsWith("re_") ? toolName.slice(3) : toolName;
}

/** 写入 hook stdin 的 tool_name：能映射则用 Claude 名，方便现成脚本 */
export function hookStdinToolName(toolName: string): string {
  const bare = hookToolBareName(toolName);
  return CLAUDE_TOOL_NAME[bare] ?? toolName;
}

/** matcher 要试的名字：re_shell_exec / shell_exec / Bash */
export function hookMatchNames(toolName: string): string[] {
  const bare = hookToolBareName(toolName);
  const alias = CLAUDE_TOOL_NAME[bare];
  return [...new Set([toolName, bare, alias].filter((n): n is string => !!n))];
}

export function matcherHits(matcher: string | undefined, toolName: string): boolean {
  if (!matcher?.trim() || matcher.trim() === "*") return true;
  const names = hookMatchNames(toolName);
  const parts = matcher.split(/[|,]/).map((p) => p.trim()).filter(Boolean);
  const exactOnly = /^[A-Za-z0-9_ \-,|]+$/.test(matcher);
  if (exactOnly && parts.length) {
    return names.some((n) => parts.includes(n));
  }
  try {
    const re = new RegExp(matcher);
    return names.some((n) => re.test(n));
  } catch {
    return names.some((n) => n.includes(matcher) || matcher.includes(n));
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function toolArgHaystack(toolName: string, toolArgs?: Record<string, unknown>): string {
  const bare = hookToolBareName(toolName);
  if (bare === "shell_exec" || hookStdinToolName(toolName) === "Bash") {
    return typeof toolArgs?.command === "string" ? toolArgs.command : "";
  }
  if (typeof toolArgs?.path === "string") return toolArgs.path;
  return "";
}

/** Claude `if`: Bash(git commit*) / Edit(*.ts) */
export function hookIfHits(
  rule: string | undefined,
  toolName: string,
  toolArgs?: Record<string, unknown>,
): boolean {
  if (!rule?.trim()) return true;
  const m = rule.trim().match(/^([A-Za-z0-9_]+)\((.*)\)$/);
  if (!m) return matcherHits(rule, toolName);
  const tool = m[1]!;
  const pattern = m[2] ?? "";
  if (!matcherHits(tool, toolName)) return false;
  if (!pattern.trim() || pattern.trim() === "*") return true;
  const hay = toolArgHaystack(toolName, toolArgs).replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/,
    "",
  );
  if (!hay) return false;
  try {
    return globToRegExp(pattern.trim()).test(hay.trim()) || globToRegExp(pattern.trim()).test(hay);
  } catch {
    return hay.includes(pattern.replace(/\*/g, ""));
  }
}

const GIT_COMMIT_RE = /\bgit(?:\s+-[^\s]+)*\s+commit\b/;

export function isGitCommitCommand(toolName: string, toolArgs?: Record<string, unknown>): boolean {
  if (!matcherHits("Bash", toolName)) return false;
  const cmd = typeof toolArgs?.command === "string" ? toolArgs.command : "";
  return GIT_COMMIT_RE.test(cmd);
}
