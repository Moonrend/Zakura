/**
 * 工具面辅助：MCP 工具 → 模型工具定义的映射、参数解析与结果转文本。
 * 主对话 / 子代理 / 跨 Agent 委派共用同一份实现。
 */
import { isCreateTaskResult, type ModelChatContentPart, type ModelChatMessage, type ModelToolDefinition } from "@zakura/shared";
import type { ResolvedTool } from "../mcp-gateway.js";
import { MAX_SCREENSHOT_BYTES, pngDimensions } from "../agent-screenshot.js";

export const RESULT_TEXT_LIMIT = 12_000;
/** 跨 Agent 委派工具名（agent loop 内置，非 MCP 工具） */
export const DELEGATE_TOOL_NAME = "delegate_to_agent";

const OPENAI_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function sanitizeToolName(name: string): string {
  if (OPENAI_TOOL_NAME_RE.test(name)) return name;
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "tool";
}

export function mcpResultToModelOutput(result: unknown): { text: string; isError: boolean; parts?: ModelChatContentPart[] } {
  if (isCreateTaskResult(result)) return { text: JSON.stringify({ task: result.task }, null, 2), isError: false };
  if (!result || typeof result !== "object") return { text: String(result ?? ""), isError: false };
  const value = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    structuredContent?: unknown;
  };
  const textParts: string[] = [];
  const images: ModelChatContentPart[] = [];
  let imageBytes = 0;
  const addImage = (data: string, mimeType: string) => {
    const bytes = Buffer.byteLength(data, "base64");
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mimeType) || images.length >= 2 || imageBytes + bytes > MAX_SCREENSHOT_BYTES || !data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
      textParts.push("[Image omitted: unsupported, invalid or exceeds the 8 MiB / 2 image tool limit]");
      return;
    }
    if (mimeType === "image/png") {
      try { pngDimensions(data); }
      catch { textParts.push("[Image omitted: incomplete PNG; capture a new screenshot]"); return; }
    }
    imageBytes += bytes;
    images.push({ type: "image_url", imageUrl: { url: `data:${mimeType};base64,${data}`, detail: "original" } });
  };
  const addText = (text: string) => {
    // Older tools and explicit output=base64 can still return JSON image bytes.
    // Convert those to vision input too; do not send a sliced image as prose.
    try {
      if (text.includes('"base64Full"') || text.includes('"screenshotBase64Full"')) {
        const raw = JSON.parse(text) as Record<string, unknown>;
        const image = raw.base64Full ?? raw.screenshotBase64Full;
        if (typeof image === "string") {
          const { base64Full: _base64, screenshotBase64Full: _screenshot, ...metadata } = raw;
          addImage(image, "image/png");
          textParts.push(JSON.stringify({ ...metadata, base64Length: image.length, base64Preview: `${image.slice(0, 120)}… (preview only)` }));
          return;
        }
      }
    } catch { /* Ordinary tool text is not necessarily JSON. */ }
    textParts.push(text);
  };
  for (const part of Array.isArray(value.content) ? value.content : []) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") addText(part.text);
    else if (part.type === "image" && typeof part.data === "string") addImage(part.data, part.mimeType ?? "image/png");
  }
  if (value.structuredContent !== undefined) addText(JSON.stringify(value.structuredContent, null, 2));
  let text = textParts.join("\n").trim() || (Array.isArray(value.content) ? (images.length ? "Tool returned an image." : "Tool returned no text content.") : JSON.stringify(result));
  if (text.length > RESULT_TEXT_LIMIT) text = `${text.slice(0, RESULT_TEXT_LIMIT)}\n…(truncated)`;
  return { text, isError: value.isError === true, ...(images.length ? { parts: [{ type: "text" as const, text }, ...images] } : {}) };
}

export function mcpResultToText(result: unknown): { text: string; isError: boolean } {
  const { text, isError } = mcpResultToModelOutput(result);
  return { text, isError };
}

/** Keep recent visual state in memory without accumulating images every turn. */
export function pruneToolImages(messages: ModelChatMessage[]): void {
  let count = 0;
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "tool" || !message.parts) continue;
    const images = message.parts.filter((part) => part.type === "image_url");
    if (!images.length) continue;
    const size = images.reduce((sum, part) => sum + (part.imageUrl.url.startsWith("data:")
      ? Buffer.byteLength(part.imageUrl.url.slice(part.imageUrl.url.indexOf(",") + 1), "base64") : 0), 0);
    if (count + images.length > 2 || bytes + size > MAX_SCREENSHOT_BYTES) {
      delete message.parts;
    } else {
      count += images.length;
      bytes += size;
    }
  }
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
        "Virtual desktop GUI: desktop_info readiness and dimensions, screenshots, click/type/key/scroll/move/drag/wait. Requires a container workspace. Use original desktop pixels; observe before acting and after short action groups. Screenshots default to image content with compact metadata.",
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
    // 云端工具一律用 re_ 限定名，避免与本地/短名工具混淆；撞名再加后缀
    let name = sanitizeToolName(t.qualifiedName);
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
