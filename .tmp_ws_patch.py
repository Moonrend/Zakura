import re
p = 'apps/server/src/services/agent-workspace.ts'
s = open(p, encoding='utf-8').read()


def rep(a, b, count=1):
    global s
    if a not in s:
        raise SystemExit("MISSING: " + a[:120])
    s = s.replace(a, b, count)


rep('/** agentId:containerPort → host tunnel', '/** spaceId:containerPort → host tunnel')
s = s.replace('withStartLock<T>(agentId: string', 'withStartLock<T>(spaceId: string')
s = s.replace('this.startLocks.get(agentId)', 'this.startLocks.get(spaceId)')
s = s.replace('this.startLocks.set(agentId, next)', 'this.startLocks.set(spaceId, next)')
s = s.replace('this.startLocks.delete(agentId)', 'this.startLocks.delete(spaceId)')
rep('''  hostRoot(agent: WorkspaceTarget): string {
    return agentWorkspaceHostPath(this.config, agent.id);''', '''  hostRoot(agent: WorkspaceTarget): string {
    return spaceWorkspaceHostPath(this.config, agent.spaceId);''')
rep('return (agent as Agent & { workspaceKind?: string }).workspaceKind === "host";',
    'return agent.workspaceKind === "host";')
rep('''  async getWorkspaceContainer(agentId: string) {
    const rows = await this.db
      .select()
      .from(managedContainers)
      .where(
        and(
          eq(managedContainers.agentId, agentId),''', '''  async getWorkspaceContainer(spaceId: string) {
    const rows = await this.db
      .select()
      .from(managedContainers)
      .where(
        and(
          eq(managedContainers.spaceId, spaceId),''')
rep('''  private closeTunnelsForAgent(agentId: string) {
    for (const [key, tunnel] of this.tunnels) {
      if (key.startsWith(`${agentId}:`)) {''', '''  private closeTunnels(spaceId: string) {
    for (const [key, tunnel] of this.tunnels) {
      if (key.startsWith(`${spaceId}:`)) {''')
s = s.replace('closeTunnelsForAgent(', 'closeTunnels(')
rep('''  async getCdpBaseUrl(agentId: string): Promise<string | null> {
    const resolved = await this.resolveCdp(agentId);''', '''  async getCdpBaseUrl(agent: WorkspaceTarget): Promise<string | null> {
    const resolved = await this.resolveCdp(agent);''')
rep('  async resolveCdp(agentId: string): Promise<{', '  async resolveCdp(agent: WorkspaceTarget): Promise<{')
rep('''    return this.withStartLock(agentId, async () => {
      const row = await this.getWorkspaceContainer(agentId);
      const unavailable = (reason: string, status: string | null = row?.status ?? null) => ({ url: null, reason, containerStatus: status, chromeInside: false });
      const agent = await this.db.query.agents.findFirst({ where: eq(agents.id, agentId) });
      if (!agent || !this.hasRuntimeNode(agent))''', '''    const spaceId = agent.spaceId;
    return this.withStartLock(spaceId, async () => {
      const row = await this.getWorkspaceContainer(spaceId);
      const unavailable = (reason: string, status: string | null = row?.status ?? null) => ({ url: null, reason, containerStatus: status, chromeInside: false });
      if (!this.hasRuntimeNode(agent))''')
i = s.index('    const spaceId = agent.spaceId;\n    return this.withStartLock(spaceId')
j = s.index('  /**\n   * 轻量桌面信息')
s = s[:i] + s[i:j].replace('agentId', 'spaceId') + s[j:]

s = s.replace('logAgentProgress(agent.id', 'logSpaceProgress(agent.spaceId')
s = s.replace('beginAgentProgress(agent.id', 'beginSpaceProgress(agent.spaceId')
s = s.replace('finishAgentProgress(agent.id', 'finishSpaceProgress(agent.spaceId')

rep('''      await client.mkdir(agent.id, "/");
      log("fs", "已在所选节点准备目录", 100, "ready");
      const [updated] = await this.db
        .update(agents)
        .set({ lastError: null, updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning();
      finishSpaceProgress(agent.spaceId, { ok: true, message: "就绪" });
      return updated ?? agent;
    }

    // 仅清理上次错误；不把 Agent 标成 starting/running（状态在 managedContainers）
    await this.db
      .update(agents)
      .set({ lastError: null, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
''', '''      await client.mkdir(agent.spaceId, "/");
      log("fs", "已在所选节点准备目录", 100, "ready");
      await this.setComputerError(agent, null);
      finishSpaceProgress(agent.spaceId, { ok: true, message: "就绪" });
      return;
    }

    // 仅清理上次错误；运行状态在 managedContainers
    await this.setComputerError(agent, null);
''')
rep('''      const tenant = await this.db.query.tenants.findFirst({
        where: eq(tenants.id, agent.tenantId),
      });
      if (!tenant) throw new Error("Tenant not found");

''', '')
rep('''        agentId: agent.id,
        agentSlug: agent.slug,
        tenantSlug: tenant.slug,
        spaceId: agent.spaceId,
        image,''', '''        spaceId: agent.spaceId,
        image,''')
rep('''        labels: {
          "zakura.agent": agent.id,
          "zakura.agent_slug": agent.slug,
        },
      });''', '''      });''')
rep('''        tenantId: agent.tenantId,
        agentId: agent.id,
        dockerId: ws.dockerId,
        name: ws.name,
        image: ws.image,
        purpose: "workspace",''', '''        tenantId: agent.tenantId,
        spaceId: agent.spaceId,
        dockerId: ws.dockerId,
        name: ws.name,
        image: ws.image,
        purpose: "workspace",''')
rep('''      const [updated] = await this.db
        .update(agents)
        .set({ lastError: null, updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning();
      finishSpaceProgress(agent.spaceId, { ok: true, message: "工作区运行中" });
      return updated ?? agent;''', '''      await this.setComputerError(agent, null);
      finishSpaceProgress(agent.spaceId, { ok: true, message: "工作区运行中" });''')
rep('''      const [updated] = await this.db
        .update(agents)
        .set({ lastError: message, updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning();
      throw Object.assign(err instanceof Error ? err : new Error(message), {
        agent: updated,
      });''', '''      await this.setComputerError(agent, message);
      throw err instanceof Error ? err : new Error(message);''')
rep('''          const [updated] = await this.db
            .update(agents)
            .set({ lastError: msg, updatedAt: new Date() })
            .where(eq(agents.id, agent.id))
            .returning();
          throw Object.assign(
            remoteErr instanceof Error ? remoteErr : new Error(msg),
            { agent: updated },
          );''', '''          await this.setComputerError(agent, msg);
          throw remoteErr instanceof Error ? remoteErr : new Error(msg);''')
rep('''    const [updated] = await this.db
      .update(agents)
      .set({ lastError: null, updatedAt: new Date() })
      .where(eq(agents.id, agent.id))
      .returning();
    return updated ?? agent;
  }

  async resolveDockerId''', '''    await this.setComputerError(agent, null);
  }

  private async setComputerError(agent: WorkspaceTarget, message: string | null): Promise<void> {
    await this.db
      .update(spaces)
      .set({ lastError: message, updatedAt: new Date() })
      .where(eq(spaces.id, agent.spaceId));
  }

  async resolveDockerId''')
rep('''    const result = await client.ensureAcpSidecar({
      agentId: agent.id,''', '''    const result = await client.ensureAcpSidecar({
      spaceId: agent.spaceId,''')
s = s.replace('"zakura.agent": agent.id', '"zakura.space": agent.spaceId')
s = s.replace('''        agentId: agent.id,
        dest: file.dest,''', '''        spaceId: agent.spaceId,
        dest: file.dest,''')
s = s.replace('''      agentId: agent.id,
      seedFrom,''', '''      spaceId: agent.spaceId,
      seedFrom,''')
rep('.where(and(eq(managedContainers.agentId, agent.id), eq(managedContainers.name, row.name)));',
    '.where(and(eq(managedContainers.spaceId, agent.spaceId), eq(managedContainers.name, row.name)));')
rep('''      tenantId: agent.tenantId,
      agentId: agent.id,
      dockerId: row.dockerId,''', '''      tenantId: agent.tenantId,
      spaceId: agent.spaceId,
      dockerId: row.dockerId,''')
rep('and(eq(managedContainers.agentId, agent.id), eq(managedContainers.purpose, "acp-adapter")),',
    'and(eq(managedContainers.spaceId, agent.spaceId), eq(managedContainers.purpose, "acp-adapter")),')
s = s.replace('allocatedTo: agent.id,', 'allocatedTo: agent.spaceId,')
s = re.sub(r'\bagent\.id\b', 'agent.spaceId', s)
open(p, 'w', encoding='utf-8').write(s)
print("ok")
