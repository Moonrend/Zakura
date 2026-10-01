import {
  type WorkspaceFs,
  type WorkspaceFsProvider,
} from "@zakura/core";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { agents, spaces } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { agentWorkspaceHostPath } from "./agent-workspace.js";
import { type RuntimeNodeService } from "./runtime-nodes.js";

export type AgentFsBinding = {
  /** 工作区归 Space 所有；这里传 spaceId（不是 agentId） */
  spaceId: string;
  tenantId: string;
  runtimeNodeId?: string | null;
};

/**
 * Routes FS ops to local disk or remote Runner based on agents.runtime_node_id.
 * Hot path（列表/读写）应优先 forAgentBinding，避免重复查 agents 表。
 */
export class ServerWorkspaceFsProvider implements WorkspaceFsProvider {
  /** 短时缓存 Runner 客户端，减少节点鉴权/心跳刷新开销 */
  private readonly runnerFsCache = new Map<
    string,
    { clientFs: WorkspaceFs; expiresAt: number }
  >();

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly nodes: RuntimeNodeService,
  ) {}

  async forAgent(agentId: string, tenantId: string): Promise<WorkspaceFs> {
    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)),
    });
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    const space = await this.db.query.spaces.findFirst({
      where: eq(spaces.id, agent.spaceId),
    });
    if (!space) throw new Error(`Space not found for agent: ${agentId}`);
    return this.forAgentBinding({
      spaceId: space.id,
      tenantId: agent.tenantId,
      runtimeNodeId: space.runtimeNodeId,
    });
  }

  async forAgentBinding(binding: AgentFsBinding): Promise<WorkspaceFs> {
    const nodeId = binding.runtimeNodeId;
    if (!nodeId) {
      throw new Error("该空间未绑定运行节点，无法访问工作区文件");
    }

    const cacheKey = `${binding.spaceId}:${nodeId}`;
    const cached = this.runnerFsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.clientFs;
    }

    // Local clients use the server filesystem; remote clients require a live Hub.
    const { client } = await this.nodes.requireRunnerClient(
      binding.tenantId,
      nodeId,
      { skipHeartbeatRefresh: true },
    );
    const clientFs = client.workspaceFs(binding.spaceId);
    this.runnerFsCache.set(cacheKey, {
      clientFs,
      expiresAt: Date.now() + 30_000,
    });
    return clientFs;
  }

  /** Invalidate cached Runner FS (e.g. after migrate / rebind). */
  invalidate(agentId: string): void {
    for (const key of this.runnerFsCache.keys()) {
      if (key === agentId || key.startsWith(`${agentId}:`)) {
        this.runnerFsCache.delete(key);
      }
    }
  }

  /** Local path helper (local runner only). */
  localRoot(spaceId: string): string {
    return agentWorkspaceHostPath(this.config, spaceId);
  }
}
