/**
 * 读写 agent.configJson.acp：profile 启用、凭证掩码、合并更新。
 */
import type { Agent } from "../../db/schema.js";
import {
  acpConfigToJson,
  builtinAcpProfiles,
  mergeAcpConfigUpdate,
  parseAcpAgentConfig,
  publicProfileForSetup,
  scrubAcpConfigForResponse,
  supportsAcpZakuraRoute,
  type AcpAgentConfig,
  type AcpPublicProfile,
} from "@zakura/shared";
import type { AgentService } from "../agents.js";

export function readAgentAcpConfig(agent: Agent): AcpAgentConfig {
  try {
    return parseAcpAgentConfig(JSON.parse(agent.configJson || "{}"));
  } catch {
    return parseAcpAgentConfig({});
  }
}

/**
 * configJson 整体损坏时 readAgentAcpConfig 会静默降级为空配置——页面看起来
 * 像“所有 Agent 都未配置”，用户一旦保存就覆盖掉残留数据。把解析错误显式
 * 透出给前端提示，保存一次即可自动修复为合法 JSON。
 */
export function agentAcpConfigError(agent: Agent): string | null {
  try {
    JSON.parse(agent.configJson || "{}");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function catalogForConfig(config: AcpAgentConfig): AcpPublicProfile[] {
  const byId = new Map<string, AcpPublicProfile>();
  for (const profile of builtinAcpProfiles()) byId.set(profile.id, profile);
  for (const setup of Object.values(config.agents)) {
    byId.set(setup.id, publicProfileForSetup(setup, byId.get(setup.id)));
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function parseAgentConfigJson(agent: Agent): Record<string, unknown> {
  try {
    const parsed = JSON.parse(agent.configJson || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function saveAgentAcpConfig(
  agentService: AgentService,
  tenantId: string,
  agent: Agent,
  incoming: AcpAgentConfig,
): Promise<AcpAgentConfig> {
  const existing = readAgentAcpConfig(agent);
  const merged = mergeAcpConfigUpdate(existing, incoming);
  const configJson = parseAgentConfigJson(agent);
  configJson.acp = acpConfigToJson(merged);
  await agentService.update(tenantId, agent.id, { config: configJson });
  return merged;
}

/** 为选择 Zakura 路由的 ACP profile 建立 Agent 绑定的最小权限 Gateway 凭证。 */
export async function provisionAcpZakuraRoutes(
  agentService: AgentService,
  tenantId: string,
  agent: Agent,
  config: AcpAgentConfig,
  publicBaseUrl: string,
): Promise<AcpAgentConfig> {
  let changed = false;
  for (const setup of Object.values(config.agents)) {
    if (setup.modelProvider !== "zakura") continue;
    const profile = publicProfileForSetup(setup);
    if (!supportsAcpZakuraRoute(profile)) {
      // Do not leave an unusable route selection persisted for native-only
      // adapters such as Claude Code, Gemini CLI and Copilot.
      setup.modelProvider = "native";
      delete setup.managed.zakura_base_url;
      delete setup.managed.zakura_api_key;
      changed = true;
      continue;
    }
    const baseUrl = `${publicBaseUrl.replace(/\/$/, "")}/v1`;
    if (setup.managed.zakura_base_url !== baseUrl) {
      setup.managed.zakura_base_url = baseUrl;
      changed = true;
    }
    if (!setup.managed.zakura_api_key?.trim()) {
      const key = await agentService.createAgentApiKey(
        tenantId,
        agent.id,
        `acp:${setup.id}:zakura-route`,
        { scopes: ["gateway:models", "gateway:chat"] },
      );
      setup.managed.zakura_api_key = key.rawKey;
      changed = true;
    }
  }
  return changed
    ? saveAgentAcpConfig(agentService, tenantId, agent, config)
    : config;
}

export function acpConfigResponse(config: AcpAgentConfig, configError?: string | null) {
  return {
    config: scrubAcpConfigForResponse(config),
    profiles: catalogForConfig(config),
    ...(configError ? { configError } : {}),
  };
}
