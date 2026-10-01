import re
p = 'apps/server/src/services/agents.ts'
s = open(p, encoding='utf-8').read()


def rep(a, b, count=1):
    global s
    if a not in s:
        raise SystemExit("MISSING: " + a[:160])
    s = s.replace(a, b, count)


rep('''  newId,
  spaces,
  type Agent,
} from "../db/schema.js";''', '''  newId,
  spaces,
  type Agent,
  type AgentRow,
  type Space,
} from "../db/schema.js";''')
rep('''import {
  AgentWorkspaceService,
  agentDataDir,
  agentWorkspaceHostPath,
  resolveStackMode,
} from "./agent-workspace.js";
import { isComputerEnvEnabled, needsContainer, normalizeCaps } from "./agent-caps.js";''', '''import {
  AgentWorkspaceService,
  agentDataDir,
  resolveStackMode,
  spaceComputer,
  spaceWorkspaceHostPath,
  spaceWorkspaceTarget,
  type WorkspaceTarget,
} from "./agent-workspace.js";
import { isComputerEnvEnabled, needsContainer } from "./agent-caps.js";''')
rep('''export { isComputerEnvEnabled, needsContainer, normalizeCaps } from "./agent-caps.js";''',
    '''export { isComputerEnvEnabled, needsContainer } from "./agent-caps.js";

/** 电脑配置写入口：Agent 级和 Space 级接口都走这里，落在 Space 上 */
export type SpaceComputerPatch = {
  enableComputer?: boolean;
  workspaceImage?: string | null;
  runtimeNodeId?: string | null;
  workspaceKind?: "host" | "container";
  /** 配置变化后重启电脑 */
  restart?: boolean;
  userId?: string;
};''')
rep('''  private readonly agentCache = new TtlCache<Agent>(AGENT_CACHE_TTL_MS);
  /** 空间级 ACP / MCP。Agent 行不再存副本，读取时叠加上去。 */
  private readonly spaceConfigCache = new TtlCache<Record<string, unknown>>(AGENT_CACHE_TTL_MS);''',
    '''  private readonly agentCache = new TtlCache<AgentRow>(AGENT_CACHE_TTL_MS);
  /** 空间行（电脑 + ACP / MCP 配置）。Agent 行不存副本，读取时叠加上去。 */
  private readonly spaceCache = new TtlCache<Space>(AGENT_CACHE_TTL_MS);''')
rep('''  private rememberAgent(agent: Agent): Agent {''', '''  private rememberAgent(agent: AgentRow): AgentRow {''')
rep('''  private forgetAgent(agent: Pick<Agent, "tenantId" | "id" | "slug">): void {''',
    '''  private forgetAgent(agent: Pick<AgentRow, "tenantId" | "id" | "slug">): void {''')

# loadSpaceConfig / mergeSpaceConfig / applySpaceConfig(s)
i = s.index('  private async loadSpaceConfig(spaceId: string)')
j = s.index('  private async invalidateSpaceTools(')
s = s[:i] + '''  /** 空间行，短 TTL 缓存；写空间后必须 forgetSpace */
  async loadSpace(spaceId: string): Promise<Space | null> {
    const hit = this.spaceCache.get(spaceId);
    if (hit) return hit;
    const row = await this.db.query.spaces.findFirst({ where: eq(spaces.id, spaceId) });
    if (row) this.spaceCache.set(spaceId, row);
    return row ?? null;
  }

  forgetSpace(spaceId: string): void {
    this.spaceCache.delete(spaceId);
  }

  private async loadSpaceConfig(spaceId: string): Promise<Record<string, unknown>> {
    return parseConfigJson((await this.loadSpace(spaceId))?.configJson);
  }

  private async mergeSpaceConfig(spaceId: string, patch: Record<string, unknown>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    const row = await this.db.query.spaces.findFirst({ where: eq(spaces.id, spaceId) });
    if (!row) return;
    const next = { ...parseConfigJson(row.configJson), ...patch };
    await this.db
      .update(spaces)
      .set({ configJson: JSON.stringify(next), updatedAt: new Date() })
      .where(eq(spaces.id, spaceId));
    this.forgetSpace(spaceId);
  }

  private overlay(row: AgentRow, space: Space | null): Agent {
    const withConfig = overlayAgentConfig(row, parseConfigJson(space?.configJson));
    if (space) return { ...withConfig, ...spaceComputer(space) };
    // 空间已删（级联中）：按关电脑处理
    return {
      ...withConfig,
      enableComputer: false,
      enableFs: false,
      enableShell: false,
      enableBrowser: false,
      workspaceProfile: "files",
      workspaceImage: null,
      runtimeNodeId: null,
      workspaceKind: "container",
      workspaceStatus: "ready",
      workspaceRevision: null,
      lastMigrationId: null,
      computerError: null,
    };
  }

  private async applySpaceConfig(row: AgentRow): Promise<Agent> {
    return this.overlay(row, await this.loadSpace(row.spaceId));
  }

  private async applySpaceConfigs(rows: AgentRow[]): Promise<Agent[]> {
    const ids = [...new Set(rows.map((row) => row.spaceId))];
    const byId = new Map<string, Space | null>();
    await Promise.all(
      ids.map(async (id) => {
        byId.set(id, await this.loadSpace(id));
      }),
    );
    return rows.map((row) => this.overlay(row, byId.get(row.spaceId) ?? null));
  }

  /** 成员 Agent（已叠空间配置） */
  async listBySpace(tenantId: string, spaceId: string): Promise<Agent[]> {
    const rows = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.tenantId, tenantId), eq(agents.spaceId, spaceId)))
      .orderBy(asc(agents.createdAt));
    return this.applySpaceConfigs(rows);
  }

''' + s[j:]

# create
rep('''    // 默认零能力；Slug 由名称自动生成；冲突时自动加后缀
    const caps = normalizeCaps({
      enableComputer: input.enableComputer,
      enableMemory: input.enableMemory,
    });
    const space = await this.resolveSpace(tenantId, input.spaceId);''', '''    // Slug 由名称自动生成；冲突时自动加后缀。电脑属于空间，这里只在显式要求时打开
    const space = await this.resolveSpace(tenantId, input.spaceId);
    const computerPatch: Partial<typeof spaces.$inferInsert> = {};
    if (input.enableComputer && !space.enableComputer) computerPatch.enableComputer = true;
    if (input.workspaceImage !== undefined && input.workspaceImage !== null) {
      computerPatch.workspaceImage = input.workspaceImage;
    }
    if (Object.keys(computerPatch).length > 0) {
      await this.db
        .update(spaces)
        .set({ ...computerPatch, updatedAt: new Date() })
        .where(eq(spaces.id, space.id));
      this.forgetSpace(space.id);
    }''')
rep('''        description: input.description?.trim() ?? "",
        status: "ready",
        workspaceProfile: caps.workspaceProfile,
        enableFs: caps.enableFs,
        enableShell: caps.enableShell,
        enableComputer: caps.enableComputer,
        enableBrowser: caps.enableBrowser,
        enableMemory: caps.enableMemory,
        memoryProviderId: input.memoryProviderId ?? null,
        workspaceImage: input.workspaceImage ?? null,
        configJson: JSON.stringify(agentOnlyConfig),''', '''        description: input.description?.trim() ?? "",
        enableMemory: Boolean(input.enableMemory),
        memoryProviderId: input.memoryProviderId ?? null,
        configJson: JSON.stringify(agentOnlyConfig),''')
rep('''      .returning();

    this.workspace.ensureLocal(row);
''', '''      .returning();
''')
rep('''          tenantId,
          agentId: row.id,
          name: `agent:${slug}`,''', '''          tenantId,
          spaceId: space.id,
          agentId: row.id,
          name: `agent:${slug}`,''')
rep('''      workspaceHostPath: agentWorkspaceHostPath(this.config, row.id),
    };
  }''', '''      workspaceHostPath: spaceWorkspaceHostPath(this.config, space.id),
    };
  }''')

# startAsync → computer on space
i = s.index('''  /**
   * 启动电脑工作区（非 Agent 本身）。''')
j = s.index('  private async normalizeRuntimeNodeId(')
s = s[:i] + '''  /** 启动 Agent 所在空间的电脑 */
  async startAsync(
    tenantId: string,
    id: string,
    opts?: { runtimeNodeId?: string | null; userId?: string },
  ): Promise<Agent> {
    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");
    await this.startSpaceComputer(tenantId, agent.spaceId, opts);
    return (await this.get(tenantId, id)) ?? agent;
  }

  /**
   * 启动空间电脑。
   * runtimeNodeId：同时改绑 Runner；仅影响电脑位置。
   */
  async startSpaceComputer(
    tenantId: string,
    spaceId: string,
    opts?: { runtimeNodeId?: string | null; userId?: string },
  ): Promise<WorkspaceTarget> {
    let space = await this.requireSpace(tenantId, spaceId);

    if (opts && "runtimeNodeId" in opts) {
      let nodeId = opts.runtimeNodeId;
      if (opts.userId) {
        await assertNodeBindAllowed(this.db, this.config, {
          userId: opts.userId,
          tenantId,
          nodeId: nodeId ?? null,
          excludeSpaceId: space.id,
        });
      }
      nodeId = await this.normalizeRuntimeNodeId(tenantId, nodeId);
      if (nodeId) {
        await this.assertNodeAvailable(tenantId, nodeId);
      }
      space = await this.writeSpaceComputer(space, { runtimeNodeId: nodeId || null });
    } else {
      if (opts?.userId) {
        await assertNodeBindAllowed(this.db, this.config, {
          userId: opts.userId,
          tenantId,
          nodeId: space.runtimeNodeId,
          excludeSpaceId: space.id,
        });
      }
      // Preflight existing bindings too, before starting a background workspace
      // job. A stale DB "online" flag is not an executable Go connection.
      if (space.runtimeNodeId) {
        await this.assertNodeAvailable(tenantId, space.runtimeNodeId);
      }
    }

    const target = spaceWorkspaceTarget(space);
    if (!needsContainer(target)) {
      await this.workspace.start(target);
      return target;
    }
    void this.workspace.start(target).catch((err) => {
      recordPlatformFault("space.workspace_start", err, { subsystem: "agent" });
    });
    return target;
  }

  async stopSpaceComputer(tenantId: string, spaceId: string): Promise<void> {
    const space = await this.requireSpace(tenantId, spaceId);
    await this.workspace.stop(spaceWorkspaceTarget(space));
  }

  /** 改空间电脑配置（开关 / 镜像 / 节点 / 类型），按需重启 */
  async updateSpaceComputer(
    tenantId: string,
    spaceId: string,
    input: SpaceComputerPatch,
  ): Promise<WorkspaceTarget> {
    const space = await this.requireSpace(tenantId, spaceId);

    if (input.runtimeNodeId !== undefined && input.userId) {
      await assertNodeBindAllowed(this.db, this.config, {
        userId: input.userId,
        tenantId,
        nodeId: input.runtimeNodeId,
        excludeSpaceId: space.id,
      });
    }
    const runtimeNodeId = await this.normalizeRuntimeNodeId(tenantId, input.runtimeNodeId);
    if (runtimeNodeId && runtimeNodeId !== space.runtimeNodeId) {
      await this.assertNodeAvailable(tenantId, runtimeNodeId);
    }

    const before = spaceWorkspaceTarget(space);
    const updated = await this.writeSpaceComputer(space, {
      ...(input.enableComputer !== undefined ? { enableComputer: input.enableComputer } : {}),
      ...(input.workspaceImage !== undefined ? { workspaceImage: input.workspaceImage } : {}),
      ...(runtimeNodeId !== undefined ? { runtimeNodeId } : {}),
      ...(input.workspaceKind !== undefined ? { workspaceKind: input.workspaceKind } : {}),
    });
    let target = spaceWorkspaceTarget(updated);

    const container = await this.workspace.getWorkspaceContainer(space.id);
    const workspaceAlive =
      Boolean(container?.dockerId) &&
      container?.status !== "removed" &&
      container?.status !== "exited";
    const stackChanged = isComputerEnvEnabled(before) !== isComputerEnvEnabled(target);

    if (input.restart || (workspaceAlive && stackChanged)) {
      if (workspaceAlive) await this.workspace.stop(before);
      if (needsContainer(target)) await this.workspace.start(target);
      const fresh = await this.loadSpace(space.id);
      if (fresh) target = spaceWorkspaceTarget(fresh);
    }
    return target;
  }

  private async requireSpace(tenantId: string, spaceId: string): Promise<Space> {
    const space = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.id, spaceId), eq(spaces.tenantId, tenantId)),
    });
    if (!space) throw new Error("Space not found");
    return space;
  }

  private async writeSpaceComputer(
    space: Space,
    patch: Partial<Pick<Space, "enableComputer" | "workspaceImage" | "runtimeNodeId" | "workspaceKind">>,
  ): Promise<Space> {
    if (Object.keys(patch).length === 0) return space;
    const [row] = await this.db
      .update(spaces)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(spaces.id, space.id))
      .returning();
    this.forgetSpace(space.id);
    return row ?? space;
  }

''' + s[j:]

# update(): split computer fields to space
i = s.index('''    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");

    if (input.runtimeNodeId !== undefined && input.userId) {''')
j = s.index('  async remove(tenantId: string, id: string')
s = s[:i] + '''    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");

    if (input.memoryProviderId) {
      const mp = await this.db.query.memoryProviders.findFirst({
        where: and(
          eq(memoryProviders.id, input.memoryProviderId),
          eq(memoryProviders.tenantId, tenantId),
        ),
      });
      if (!mp) throw new Error("Memory provider not found");
    }

    let configToStore: string | undefined;
    if (input.config !== undefined) {
      const { agent: agentConfig, spacePatch } = splitAgentConfig(input.config);
      if (Object.keys(spacePatch).length > 0) {
        await this.mergeSpaceConfig(agent.spaceId, spacePatch);
      }
      configToStore = JSON.stringify(agentConfig);
    }

    const computerTouched =
      input.enableComputer !== undefined ||
      input.workspaceImage !== undefined ||
      input.runtimeNodeId !== undefined ||
      input.workspaceKind !== undefined ||
      input.restart === true;
    if (computerTouched) {
      await this.updateSpaceComputer(tenantId, agent.spaceId, {
        enableComputer: input.enableComputer,
        workspaceImage: input.workspaceImage,
        runtimeNodeId: input.runtimeNodeId,
        workspaceKind: input.workspaceKind,
        restart: input.restart,
        userId: input.userId,
      });
    }

    const [updated] = await this.db
      .update(agents)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.enableMemory !== undefined ? { enableMemory: input.enableMemory } : {}),
        ...(input.memoryProviderId !== undefined
          ? { memoryProviderId: input.memoryProviderId }
          : {}),
        ...(configToStore !== undefined ? { configJson: configToStore } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agent.id), eq(agents.tenantId, tenantId)))
      .returning();

    this.rememberAgent(updated!);
    return this.applySpaceConfig(updated!);
  }

''' + s[j:]

# remove(): never stop the shared computer
rep('''    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");

    const container = await this.workspace.getWorkspaceContainer(agent.id);
    if (container?.dockerId && container.status !== "removed") {
      await this.workspace.stop(agent);
    }

    await this.db.delete(agents)''', '''    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");

    // 电脑是空间共用的，删 Agent 不动它
    await this.db.delete(agents)''')
rep('''    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");
    return this.workspace.stop(agent);
  }''', '''    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");
    await this.workspace.stop(agent);
    return (await this.get(tenantId, id)) ?? agent;
  }''')

# serialize
rep('''      workspaceKind: (agent as Agent & { workspaceKind?: string }).workspaceKind ?? "container",
      workspaceStatus: agent.workspaceStatus ?? "ready",''', '''      workspaceKind: agent.workspaceKind,
      workspaceStatus: agent.workspaceStatus ?? "ready",''')
rep('''      lastError: agent.lastError,
      createdAt: agent.createdAt,''', '''      lastError: agent.lastError ?? agent.computerError,
      computerError: agent.computerError,
      createdAt: agent.createdAt,''')
rep('''      workspaceHostPath: agentWorkspaceHostPath(this.config, agent.id),
      needsContainer''', '''      workspaceHostPath: spaceWorkspaceHostPath(this.config, agent.spaceId),
      needsContainer''')
open(p, 'w', encoding='utf-8').write(s)
print('ok')
