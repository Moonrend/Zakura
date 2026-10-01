import type { Agent, Space } from "../db/schema.js";

/**
 * 运行时读取的「作用域」：工作区/电脑配置都在 space 上。
 * Agent 与 Space 行都可直接满足。
 */
export interface WorkspaceScope {
  tenantId: string;
  spaceId: string;
  runtimeNodeId?: string | null;
  workspaceKind?: string | null;
  workspaceImage?: string | null;
  enableComputer?: boolean;
}

/**
 * Agent + 所属 Space 的合并视图。
 *
 * 旧的 Agent 级工作区字段仍然以兼容字段形式暴露（全部来自 space），
 * 让尚未改写完的运行时调用点继续工作；新代码应直接读 `agent.space`。
 */
export type AgentWithSpace = Agent & {
  space: Space;
  spaceName: string;
  /** 兼容字段：space.workspaceStatus */
  status: string;
  workspaceProfile: "files" | "computer";
  enableFs: boolean;
  enableShell: boolean;
  enableComputer: boolean;
  enableBrowser: boolean;
  workspaceImage: string | null;
  runtimeNodeId: string | null;
  workspaceKind: string;
  workspaceStatus: string;
  workspaceRevision: string | null;
  lastMigrationId: string | null;
};

export function hydrateAgent(agent: Agent, space: Space): AgentWithSpace {
  const computer = Boolean(space.enableComputer);
  return {
    ...agent,
    space,
    spaceName: space.name,
    status: space.workspaceStatus,
    workspaceProfile: computer ? "computer" : "files",
    enableFs: computer,
    enableShell: computer,
    enableComputer: computer,
    enableBrowser: computer,
    workspaceImage: space.workspaceImage,
    runtimeNodeId: space.runtimeNodeId,
    workspaceKind: space.workspaceKind,
    workspaceStatus: space.workspaceStatus,
    workspaceRevision: space.workspaceRevision,
    lastMigrationId: space.lastMigrationId,
  };
}
