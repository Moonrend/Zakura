import {
  LocalWorkspaceFs,
  type WorkspaceFs,
  type WorkspaceFsProvider,
} from "@zakura/core";
import { LOCAL_RUNTIME_NODE_ID } from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { agentWorkspaceHostPath } from "./agent-workspace.js";
import { type RuntimeNodeService } from "./runtime-nodes.js";

export type AgentFsBinding = {
  id: string;
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
    return this.forAgentBinding({
      id: agent.id,
      tenantId: agent.tenantId,
      runtimeNodeId: agent.runtimeNodeId,
    });
  }

  async forAgentBinding(binding: AgentFsBinding): Promise<WorkspaceFs> {
    const nodeId = binding.runtimeNodeId;
    if (!nodeId || nodeId === LOCAL_RUNTIME_NODE_ID) {
      return this.openLocal(binding.id);
    }

    const cacheKey = `${binding.id}:${nodeId}`;
    const cached = this.runnerFsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.clientFs;
    }

    // 热路径跳过全表心跳刷新；直连 Runner HTTP FS（机器磁盘）
    const { node, client } = await this.nodes.requireRunnerClient(
      binding.tenantId,
      nodeId,
      { skipHeartbeatRefresh: true },
    );
    // local 节点不应走到 requireRunnerClient；双保险
    if (node.kind === "local") {
      return this.openLocal(binding.id);
    }
    const clientFs = client.workspaceFs(binding.id);
    this.runnerFsCache.set(cacheKey, {
      clientFs,
      expiresAt: Date.now() + 30_000,
    });
    return clientFs;
  }

  /** 本机磁盘；LocalWorkspaceFs 构造时会 ensureWorkspaceDir */
  private openLocal(agentId: string): WorkspaceFs {
    const root = agentWorkspaceHostPath(this.config, agentId);
    return new LocalWorkspaceFs(root);
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
  localRoot(agentId: string): string {
    return agentWorkspaceHostPath(this.config, agentId);
  }
}
