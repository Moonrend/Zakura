/**
 * 工具面辅助：MCP 工具 → 模型工具定义的映射、参数解析与结果转文本。
 * 主对话 / 子代理 / 跨 Agent 委派共用同一份实现。
 */
import { isCreateTaskResult, type ModelToolDefinition } from "@zakura/shared";
import type { ResolvedTool } from "../mcp-gateway.js";

export const RESULT_TEXT_LIMIT = 12_000;
/** 跨 Agent 委派工具名（agent loop 内置，非 MCP 工具） */
export const DELEGATE_TOOL_NAME = "delegate_to_agent";

const OPENAI_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function sanitizeToolName(name: string): string {
  if (OPENAI_TOOL_NAME_RE.test(name)) return name;
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "tool";
}

export function mcpResultToText(result: unknown): { text: string; isError: boolean } {
  if (isCreateTaskResult(result)) {
    return {
      text: JSON.stringify({ task: result.task }, null, 2),
      isError: false,
    };
  }
  if (!result || typeof result !== "object") {
    return { text: String(result ?? ""), isError: false };
  }
  const r = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const c of r.content) {
      if (c && typeof c.text === "string") parts.push(c.text);
    }
  }
  if (r.structuredContent !== undefined) {
    parts.push(JSON.stringify(r.structuredContent, null, 2));
  }
  let text = parts.join("\n").trim() || JSON.stringify(result);
  if (text.length > RESULT_TEXT_LIMIT) {
    text = `${text.slice(0, RESULT_TEXT_LIMIT)}\n…(truncated)`;
  }
  return { text, isError: r.isError === true };
}

/**
 * zakura-agent 热路径 localName：每轮常驻。
 * computer/memory 里低频工具不在此集合，走 namespace defer。
 */
export const NATIVE_ALWAYS_ON_LOCAL_NAMES = new Set([
  "agent_info",
  "fs_read",
  "fs_write",
  "fs_edit",
  "fs_list",
  "fs_grep",
  "apply_patch",
  "shell_exec",
  "browser_observe",
  "browser_action",
  "list_skills",
  "read_skill",
  "memory_context",
  "search_memory",
  "add_memory",
]);

type NativeDeferNs = { name: string; description: string };

/** 返回 null = 常驻；否则为 defer 命名空间 */
export function nativeDeferredNamespace(localName: string): NativeDeferNs | null {
  if (NATIVE_ALWAYS_ON_LOCAL_NAMES.has(localName)) return null;

  if (localName === "desktop_info" || localName.startsWith("computer_")) {
    return {
      name: "desktop",
      description:
        "Virtual desktop GUI: screenshot, mouse and keyboard (xdotool). Use when operating the full desktop beyond Chromium browser_* tools.",
    };
  }

  if (
    localName === "fs_mkdir" ||
    localName === "fs_delete" ||
    localName === "fs_stat" ||
    localName === "fs_move" ||
    localName === "get_file_url" ||
    localName === "revoke_file_url" ||
    localName === "list_file_urls"
  ) {
    return {
      name: "workspace_files",
      description:
        "Less-common workspace file ops: mkdir/delete/stat/move and temporary public file share URLs.",
    };
  }

  if (
    localName === "list_exposers" ||
    localName === "expose_port" ||
    localName === "unexpose_port" ||
    localName === "list_exposures"
  ) {
    return {
      name: "port_expose",
      description: "Expose workspace ports via tunnel providers (Cloudflare etc.).",
    };
  }

  if (localName === "search_skills" || localName === "install_skill") {
    return {
      name: "skills_store",
      description: "Search skill registries and install new skills into the workspace.",
    };
  }

  if (
    localName === "list_memories" ||
    localName === "get_memory" ||
    localName === "update_memory" ||
    localName === "delete_memory" ||
    localName === "pin_memory" ||
    localName === "memory_stats" ||
    localName === "link_memories" ||
    localName === "memory_graph"
  ) {
    return {
      name: "memory_admin",
      description:
        "Memory CRUD, pin, stats, and graph beyond memory_context/search_memory/add_memory.",
    };
  }

  // 未知原生工具：常驻，避免误伤
  return null;
}

/**
 * 是否每轮直接塞进 tools（不 defer）。
 * zakura-connector 也标 agentScoped，不能靠 agentScoped/builtin。
 */
export function isAlwaysOnResolvedTool(tool: ResolvedTool): boolean {
  if (tool.providerId === "web-search" || tool.providerId === "web-fetch") return true;
  if (tool.providerId === "zakura-subagent") return true;
  if (tool.providerId !== "zakura-agent") return false;
  return nativeDeferredNamespace(tool.localName) === null;
}

/** @deprecated 使用 isAlwaysOnResolvedTool；保留别名以免外部引用断裂 */
export function isZakuraBuiltinTool(tool: ResolvedTool): boolean {
  return isAlwaysOnResolvedTool(tool);
}

/** 从 qualifiedName 抽 slug：re_<slug>__local / <slug>__local */
export function namespaceSlugFromTool(tool: ResolvedTool): string {
  const q = tool.qualifiedName;
  const m = /^(?:re_)?(.+?)__/.exec(q);
  if (m?.[1]) return m[1];
  if (tool.providerId && tool.providerId !== "zakura-connector") {
    return tool.providerId;
  }
  return "external";
}

function deferredNamespaceFor(tool: ResolvedTool): {
  name: string;
  description: string;
} {
  if (tool.providerId === "zakura-agent") {
    return (
      nativeDeferredNamespace(tool.localName) ?? {
        name: "zakura_extra",
        description: "Other Zakura agent tools.",
      }
    );
  }
  const slug = namespaceSlugFromTool(tool);
  const name = sanitizeToolName(slug);
  const kind =
    tool.providerId === "zakura-connector"
      ? "connector"
      : tool.instanceId
        ? "MCP server"
        : "tool provider";
  return {
    name,
    description: `${kind} "${slug}" (${tool.providerId || "unknown"})`,
  };
}

export function toolsToDefinitions(tools: ResolvedTool[]): {
  definitions: ModelToolDefinition[];
  nameMap: Map<string, string>;
} {
  const nameMap = new Map<string, string>();
  const used = new Set<string>();
  const definitions: ModelToolDefinition[] = [];

  for (const t of tools) {
    const alwaysOn = isAlwaysOnResolvedTool(t);
    // 官方：namespace 内用短 function name；撞名再回退到 qualified
    let name = sanitizeToolName(
      !alwaysOn && t.localName ? t.localName : t.qualifiedName,
    );
    if (used.has(name)) {
      name = sanitizeToolName(t.qualifiedName);
    }
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${name.slice(0, 60)}_${i}`)) i += 1;
      name = `${name.slice(0, 60)}_${i}`;
    }
    used.add(name);
    nameMap.set(name, t.qualifiedName);
    definitions.push({
      type: "function",
      function: {
        name,
        description: t.description || t.title || t.qualifiedName,
        parameters:
          t.inputSchema && typeof t.inputSchema === "object"
            ? t.inputSchema
            : { type: "object", properties: {} },
      },
      ...(alwaysOn
        ? {}
        : {
            deferLoading: true,
            namespace: deferredNamespaceFor(t),
          }),
    });
  }
  return { definitions, nameMap };
}

export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}
