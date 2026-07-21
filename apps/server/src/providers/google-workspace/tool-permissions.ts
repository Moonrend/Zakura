/**
 * MCP 内置 tool 权限规则：按「权限 ID」开关一组工具。
 * 未声明权限的工具默认可见；声明了规则的工具按 defaultEnabled / 实例覆盖决定。
 */

import type {
  McpToolPermissionRule,
  McpToolPermissionState,
} from "@zakura/shared";
import type { GoogleWorkspaceProduct } from "./types.js";

export type ToolPermissionRule = McpToolPermissionRule;
export type ToolPermissionState = McpToolPermissionState;

export const GOOGLE_WORKSPACE_TOOL_PERMISSIONS: Record<
  GoogleWorkspaceProduct,
  ToolPermissionRule[]
> = {
  gmail: [
    {
      id: "gmail.send",
      label: "发送邮件",
      description: "允许 send_message / send_draft。默认关闭；开启后 Agent 才能看到发件工具。",
      defaultEnabled: false,
      tools: ["send_message", "send_draft"],
    },
  ],
  drive: [],
  calendar: [],
  people: [],
  chat: [
    {
      id: "chat.send",
      label: "发送 Chat 消息",
      description: "允许 send_message。默认开启。",
      defaultEnabled: true,
      tools: ["send_message"],
    },
  ],
};

function overridesFromConfig(config: Record<string, unknown>): Record<string, boolean> {
  const raw = config.toolPermissions;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export function resolveToolPermissionStates(
  product: GoogleWorkspaceProduct,
  config: Record<string, unknown>,
): ToolPermissionState[] {
  const overrides = overridesFromConfig(config);
  return GOOGLE_WORKSPACE_TOOL_PERMISSIONS[product].map((rule) => ({
    ...rule,
    enabled: overrides[rule.id] ?? rule.defaultEnabled,
  }));
}

/** 某 tool 是否因权限被隐藏（无规则 = 始终可见） */
export function isToolAllowedByPermissions(
  product: GoogleWorkspaceProduct,
  config: Record<string, unknown>,
  toolName: string,
): boolean {
  const states = resolveToolPermissionStates(product, config);
  for (const rule of states) {
    if (rule.tools.includes(toolName)) return rule.enabled;
  }
  return true;
}

export function filterToolsByPermissions<T extends { name: string }>(
  product: GoogleWorkspaceProduct,
  config: Record<string, unknown>,
  tools: T[],
): T[] {
  return tools.filter((t) => isToolAllowedByPermissions(product, config, t.name));
}
