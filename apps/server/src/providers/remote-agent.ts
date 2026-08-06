import { textResult } from "@zakura/core";
import type { InstanceHandle, ProviderPlugin } from "@zakura/core";
import type { McpToolDef, ProviderConfigSchema } from "@zakura/shared";

const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "远程 Agent 通道",
  required: ["platform", "profileKey"],
  properties: {
    platform: { type: "string" },
    profileKey: { type: "string" },
  },
};

export function createRemoteAgentProvider(): ProviderPlugin {
  return {
    id: "remote-agent",
    name: "远程 Agent 通道",
    description:
      "通过 Chat SDK 接入外部消息平台。入站自动 👀/Typing，最终答复跨适配器流式发出；chat_* 工具用于进度与额外消息。",
    version: "1.2.0",
    category: "connector",
    capabilities: ["builtin"],
    configSchema,
    validateConfig(config) {
      const platform = typeof config.platform === "string" ? config.platform.trim().toLowerCase() : "";
      const profileKey = typeof config.profileKey === "string" ? config.profileKey.trim() : "";
      if (!platform || !profileKey) throw new Error("远程 Agent 通道缺少 platform 或 profileKey");
      return { ...config, platform, profileKey, mcpUrl: `zakura://remote-agent/${platform}` };
    },
    createRuntimeSpec(config) {
      return {
        containers: [],
        endpointTemplate: `zakura://remote-agent/${String(config.platform)}`,
      };
    },
    async healthCheck(handle) {
      return {
        status: handle.config.platform && handle.config.profileKey ? "healthy" : "unhealthy",
        message: handle.config.platform && handle.config.profileKey ? "ok" : "缺少通道配置",
      };
    },
    async listTools(): Promise<McpToolDef[]> {
      // 工具由云端 runtime 按会话注入（chat_*），不经 provider MCP 面暴露
      return [];
    },
    async callTool(_handle: InstanceHandle, toolName: string) {
      return textResult(`远程通道工具请在云端会话中调用：${toolName}`, true);
    },
  };
}
