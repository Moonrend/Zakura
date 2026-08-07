import { textResult, type InstanceHandle, type ProviderPlugin } from "@zakura/core";
import type { McpToolDef, ProviderConfigSchema } from "@zakura/shared";
import { platformEvents } from "../services/platform-events.js";

const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "浏览器通知",
  properties: {
    product: { type: "string" },
    agentId: { type: "string" },
  },
};

const notifyTool: McpToolDef = {
  name: "notify",
  title: "浏览器通知",
  description:
    "向用户浏览器发送系统通知（页面不在前台时弹出）。用于提醒任务完成、需要用户回来查看等情况。",
  inputSchema: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string", description: "通知标题" },
      body: { type: "string", description: "通知正文" },
      url: {
        type: "string",
        description: "点击通知后打开的相对路径，例如 /chat?agent=…",
      },
    },
  },
};

function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key].trim() : "";
}

export function createBrowserNotificationsProvider(): ProviderPlugin {
  return {
    id: "browser-notifications",
    name: "浏览器通知",
    description: "向用户浏览器推送系统通知。",
    version: "0.1.0",
    category: "connector",
    capabilities: ["tools", "builtin"],
    configSchema,

    validateConfig(config) {
      return config;
    },

    createRuntimeSpec() {
      return { containers: [], endpointTemplate: "builtin://browser-notifications" };
    },

    async healthCheck() {
      return { status: "healthy", message: "ok" };
    },

    async listTools(_handle: InstanceHandle): Promise<McpToolDef[]> {
      return [notifyTool];
    },

    async callTool(handle, toolName, args) {
      if (toolName !== "notify") {
        return textResult(`未知工具: ${toolName}`, true);
      }
      const title = str(args, "title");
      if (!title) return textResult("title 必填", true);
      const body = str(args, "body");
      const url = str(args, "url");
      const agentId =
        typeof handle.config.agentId === "string" ? handle.config.agentId.trim() : "";

      platformEvents.publish(handle.tenantId, {
        type: "browser_notify",
        agentId: agentId || "unknown",
        title,
        ...(body ? { body } : {}),
        ...(url ? { url } : {}),
      });

      return textResult(
        JSON.stringify({ ok: true, delivered: "queued", title }),
        false,
      );
    },
  };
}
