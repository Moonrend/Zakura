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
    text = `${text.slice(0, RESULT_TEXT_LIMIT)}\n…(截断)`;
  }
  return { text, isError: r.isError === true };
}

export function toolsToDefinitions(tools: ResolvedTool[]): {
  definitions: ModelToolDefinition[];
  nameMap: Map<string, string>;
} {
  const nameMap = new Map<string, string>();
  const used = new Set<string>();
  const definitions: ModelToolDefinition[] = [];

  for (const t of tools) {
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
