import re
base = 'apps/server/src/'


def patch(path, pairs):
    p = base + path
    s = open(p, encoding='utf-8').read()
    for a, b in pairs:
        if a not in s:
            raise SystemExit(f"MISSING in {path}: {a[:140]}")
        s = s.replace(a, b, 1)
    open(p, 'w', encoding='utf-8').write(s)


patch('api/routes.ts', [(
    '''    const { getAgentProgress } = await import("../services/agent-progress.js");
    const container = await agentService.workspace.getWorkspaceContainer(agent.id);
    const progress = getAgentProgress(agent.id);''',
    '''    const { getSpaceProgress } = await import("../services/space-progress.js");
    const container = await agentService.workspace.getWorkspaceContainer(agent.spaceId);
    const progress = getSpaceProgress(agent.spaceId);'''), (
    '''        id: agent.id,
        lastError: agent.lastError,
      },
      workspace: {
        status: workspaceStatus,''',
    '''        id: agent.id,
        lastError: agent.computerError,
      },
      workspace: {
        status: workspaceStatus,''')])

patch('api/runtime-node-routes.ts', [(
    'import { agentWorkspaceHostPath } from "../services/agent-workspace.js";',
    'import { spaceWorkspaceHostPath } from "../services/agent-workspace.js";'), (
    '''  app.delete("/api/runtime-nodes/:nodeId/agents/:agentId/workspace-residual", async (c) => {
    const session = c.get("session")!;
    const nodeId = c.req.param("nodeId");
    const agentId = c.req.param("agentId");
    const node = await nodes.get(session.tenantId, nodeId);
    if (!node) return c.json({ error: "Node not found" }, 404);
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.tenantId, session.tenantId), eq(agents.id, agentId)),
    });
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    // Only allow deleting residual when agent is no longer bound to this node
    if (agent.runtimeNodeId === node.id) {
      return c.json({ error: "Agent still bound to this node; unbind or migrate first" }, 400);
    }
    if (node.kind === "local") {
      const root = agentWorkspaceHostPath(config, agentId);''',
    '''  app.delete("/api/runtime-nodes/:nodeId/spaces/:spaceId/workspace-residual", async (c) => {
    const session = c.get("session")!;
    const nodeId = c.req.param("nodeId");
    const spaceId = c.req.param("spaceId");
    const node = await nodes.get(session.tenantId, nodeId);
    if (!node) return c.json({ error: "Node not found" }, 404);
    const space = await db.query.spaces.findFirst({
      where: and(eq(spaces.tenantId, session.tenantId), eq(spaces.id, spaceId)),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);
    // Only allow deleting residual when the space is no longer bound to this node
    if (space.runtimeNodeId === node.id) {
      return c.json({ error: "Space still bound to this node; unbind or migrate first" }, 400);
    }
    if (node.kind === "local") {
      const root = spaceWorkspaceHostPath(config, spaceId);'''), (
    'hint: join(node.storageRoot, "agents", agentId, "workspace"),',
    'hint: join(node.storageRoot, "spaces", spaceId, "workspace"),')])

patch('services/agent-workspace.ts', [(
    '''          await this.waitUntilReady(agent, client, require);
        }
        return agent;
      }
      return this.startUnlocked(agent, { require });''',
    '''          await this.waitUntilReady(agent, client, require);
        }
        return;
      }
      return this.startUnlocked(agent, { require });''')])

patch('services/image-update-checker.ts', [(
    ''' * Images worth probing for a node: workspace default plus any per-agent override.''',
    ''' * Images worth probing for a node: workspace default plus any per-space override.'''), (
    '''    .select({ workspaceImage: agents.workspaceImage })
    .from(agents)
    .where(eq(agents.runtimeNodeId, nodeId));''',
    '''    .select({ workspaceImage: spaces.workspaceImage })
    .from(spaces)
    .where(eq(spaces.runtimeNodeId, nodeId));''')])

patch('services/orchestrator.ts', [(
    '''  /** stdio MCP 跑在当前绑定 Agent 所选 runner 上，不读 instance.runtime_node_id。 */
  async resolveStdioRuntimeNodeId(tenantId: string, instance: ComponentInstance): Promise<string> {
    const bound = await this.db
      .select({ runtimeNodeId: agents.runtimeNodeId, workspaceKind: agents.workspaceKind })
      .from(agentBindings)
      .innerJoin(agents, eq(agents.spaceId, agentBindings.spaceId))
      .where(and(eq(agentBindings.instanceId, instance.id), eq(agentBindings.tenantId, tenantId)));
    const fromAgent = bound.map((b) => b.runtimeNodeId).find((id) => id && !isLocalRuntimeNodeId(id));
    if (fromAgent) return fromAgent;
    throw new Error("请先把该 MCP 绑定到一台已选择电脑/服务器的 Agent");''',
    '''  /** stdio MCP 跑在绑定空间所选的 runner 上，不读 instance.runtime_node_id。 */
  async resolveStdioRuntimeNodeId(tenantId: string, instance: ComponentInstance): Promise<string> {
    const bound = await this.db
      .select({ runtimeNodeId: spaces.runtimeNodeId })
      .from(agentBindings)
      .innerJoin(spaces, eq(spaces.id, agentBindings.spaceId))
      .where(and(eq(agentBindings.instanceId, instance.id), eq(agentBindings.tenantId, tenantId)));
    const fromSpace = bound.map((b) => b.runtimeNodeId).find((id) => id && !isLocalRuntimeNodeId(id));
    if (fromSpace) return fromSpace;
    throw new Error("请先把该 MCP 绑定到一个已选择电脑/服务器的空间");''')])
print('ok')
