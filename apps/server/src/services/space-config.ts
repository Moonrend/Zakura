/**
 * 空间级配置：一个 Space 只存一份，成员 Agent 读取时叠加上去，不再各存一份。
 * 目前归空间所有的键：acp、mcp（原 providers.mcp）。
 */
import type { AgentRow } from "../db/schema.js";

export function parseConfigJson(raw: string | null | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* 损坏的 JSON 交给调用方按空配置处理 */
  }
  return {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 把空间配置叠到 Agent 的 configJson 上，供仍按 Agent 读取的运行时使用。 */
export function overlaySpaceConfig(agentConfigRaw: string, spaceConfig: Record<string, unknown>): string {
  const cfg = parseConfigJson(agentConfigRaw);
  let changed = false;
  if ("acp" in spaceConfig) {
    cfg.acp = spaceConfig.acp;
    changed = true;
  }
  if ("mcp" in spaceConfig) {
    const providers = asRecord(cfg.providers) ?? {};
    providers.mcp = spaceConfig.mcp;
    cfg.providers = providers;
    changed = true;
  }
  return changed ? JSON.stringify(cfg) : agentConfigRaw;
}

export function overlayAgentConfig<T extends Pick<AgentRow, "configJson">>(
  agent: T,
  spaceConfig: Record<string, unknown>,
): T {
  const configJson = overlaySpaceConfig(agent.configJson, spaceConfig);
  if (configJson === agent.configJson) return agent;
  return { ...agent, configJson };
}

/**
 * 从一份 Agent 配置里拆出归空间所有的键。
 * 只拆出现过的键，避免一次局部写入把空间上已有的 ACP/MCP 清掉。
 */
export function splitAgentConfig(config: Record<string, unknown>): {
  agent: Record<string, unknown>;
  spacePatch: Record<string, unknown>;
} {
  const agent = { ...config };
  const spacePatch: Record<string, unknown> = {};
  if ("acp" in agent) {
    spacePatch.acp = agent.acp;
    delete agent.acp;
  }
  const providers = asRecord(agent.providers);
  if (providers && "mcp" in providers) {
    spacePatch.mcp = providers.mcp;
    const next = { ...providers };
    delete next.mcp;
    agent.providers = next;
  }
  return { agent, spacePatch };
}

function acpScore(config: Record<string, unknown>): number {
  const acp = asRecord(config.acp);
  if (!acp) return 0;
  return JSON.stringify(acp).length;
}

function mcpScore(config: Record<string, unknown>): number {
  const providers = asRecord(config.providers);
  const mcp = asRecord(providers?.mcp);
  if (!mcp) return 0;
  const ids = Array.isArray(mcp.instanceIds) ? mcp.instanceIds.length : 0;
  return (mcp.mode === "selected" ? 100 : 1) + ids;
}

/** 同一空间里挑一份已有 ACP（内容更完整的优先），没有则返回 null。 */
export function pickSpaceAcp(configs: Record<string, unknown>[]): unknown | null {
  let best: unknown = null;
  let bestScore = 0;
  for (const config of configs) {
    const score = acpScore(config);
    if (score > bestScore) {
      best = config.acp;
      bestScore = score;
    }
  }
  return best;
}

/** 同一空间里挑一份 MCP 选择；都没有时用 mode=all，避免剥掉后变成“未绑定”。 */
export function pickSpaceMcp(configs: Record<string, unknown>[]): Record<string, unknown> {
  let best: Record<string, unknown> | null = null;
  let bestScore = 0;
  for (const config of configs) {
    const score = mcpScore(config);
    if (score > bestScore) {
      const providers = asRecord(config.providers);
      best = asRecord(providers?.mcp);
      bestScore = score;
    }
  }
  return best ?? { mode: "all", instanceIds: [] };
}

/** 从 Agent 配置里删掉已迁到空间的键。返回 null 表示不用写回。 */
export function stripSpaceOwnedKeys(config: Record<string, unknown>): Record<string, unknown> | null {
  let dirty = false;
  const next = { ...config };
  if ("acp" in next) {
    delete next.acp;
    dirty = true;
  }
  const providers = asRecord(next.providers);
  if (providers && "mcp" in providers) {
    const providersNext = { ...providers };
    delete providersNext.mcp;
    next.providers = providersNext;
    dirty = true;
  }
  return dirty ? next : null;
}
