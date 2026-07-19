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
import { ensureWorkspaceDir } from "./agent-fs.js";

/** Routes FS ops to local disk or remote Runner based on agents.runtime_node_id. */
export class ServerWorkspaceFsProvider implements WorkspaceFsProvider {
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

    const nodeId = agent.runtimeNodeId;
    if (!nodeId || nodeId === LOCAL_RUNTIME_NODE_ID) {
      const root = agentWorkspaceHostPath(this.config, agentId);
      ensureWorkspaceDir(root);
      return new LocalWorkspaceFs(root);
    }

    // Remote binding — require live Runner client (throws if offline / no token)
    const { node, client } = await this.nodes.requireRunnerClient(
      agent.tenantId,
      nodeId,
    );
    if (node.kind === "local") {
      const root = agentWorkspaceHostPath(this.config, agentId);
      ensureWorkspaceDir(root);
      return new LocalWorkspaceFs(root);
    }
    return client.workspaceFs(agentId);
  }

  /** Local path helper (local runner only). */
  localRoot(agentId: string): string {
    return agentWorkspaceHostPath(this.config, agentId);
  }
}
