import { and, asc, eq, inArray } from "drizzle-orm";
import { generateApiKey, recordPlatformFault } from "@zakura/core";
import { LOCAL_RUNTIME_NODE_ID } from "@zakura/shared";
import { rmSync } from "node:fs";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  agentBindings,
  agents,
  apiKeys,
  componentInstances,
  mcpPolicies,
  memoryProviders,
  newId,
  spaces,
  type Agent,
  type Space,
} from "../db/schema.js";
import type { DockerRuntime } from "../runtime/docker.js";
import {
  type AgentProvidersConfig,
  getAgentProviders,
  mergeAgentProviders,
  parseAgentConfig,
} from "./agent-providers.js";
import {
  AgentWorkspaceService,
  agentDataDir,
  resolveStackMode,
} from "./agent-workspace.js";
import { SpaceService } from "./spaces.js";
import { hydrateAgent, type AgentWithSpace } from "./agent-view.js";
import { isComputerEnvEnabled, needsContainer } from "./agent-caps.js";
import {
  ensureCapabilityInstance,
  readInstanceConfig,
} from "./capabilities.js";
import type { Orchestrator } from "./orchestrator.js";
import { enabledEngines, listSearchEngineMeta } from "../capabilities/web-search/index.js";
import { enabledBackends, listFetchBackendMeta } from "../capabilities/web-fetch/index.js";
import type { WebSearchConfig } from "../capabilities/web-search/types.js";
import type { WebFetchConfig } from "../capabilities/web-fetch/types.js";
import { normalizeSlots } from "../capabilities/cred-slots.js";
import { assertNodeBindAllowed } from "./runner-access.js";
import {
  bindDefaultMcpsToAgent,
  ensureDefaultAgentMcps,
} from "./default-mcps.js";
import { effectiveAgentWebDefaults, getAgentWebDefaults } from "./agent-defaults.js";
import { TtlCache } from "../model-router/cache.js";

const ZAKURA_AUTO_NAME = "Zakura 自动";
/** Agent 配置读多写少：热路径短 TTL 进程内缓存 */
const AGENT_CACHE_TTL_MS = 30_000;

/** Platform-only slots surface as「Zakura 自动」so tenants never see jina/firecrawl ids. */
function displayNameForWebService(
  metaName: string,
  cfg: { enabled?: boolean; slots?: unknown[] } | undefined,
): string {
  const slots = normalizeSlots(cfg as any);
  if (slots.length > 0 && slots.every((s) => s.usePlatform)) {
    return ZAKURA_AUTO_NAME;
  }
  return metaName;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || `agent-${Date.now().toString(36)}`
  );
}

export { isComputerEnvEnabled, needsContainer, normalizeCaps } from "./agent-caps.js";

export class AgentService {
  readonly workspace: AgentWorkspaceService;
  readonly spaces: SpaceService;
  private readonly agentCache = new TtlCache<Agent>(AGENT_CACHE_TTL_MS);
  /** 绑定变更时清 Agent 工具缓存（由 McpGateway 注入） */
  private toolsCacheInvalidator: ((agentId: string) => void) | null = null;

  constructor(
    private readonly db: Db,
    runtime: DockerRuntime,
    private readonly config: AppConfig,
    private readonly nodes?: import("./runtime-nodes.js").RuntimeNodeService,
  ) {
    this.workspace = new AgentWorkspaceService(db, runtime, config, nodes);
    this.spaces = new SpaceService(db, config);
  }

  /** 解析 Agent 的所属空间；不存在时报错。 */
  async requireSpace(tenantId: string, spaceId: string): Promise<Space> {
    const space = await this.spaces.get(tenantId, spaceId);
    if (!space) throw new Error("Space not found");
    return space;
  }

  /** Browser/CDP resolver：调用方只有 agentId，这里解析到所属 space。 */
  async resolveCdpForAgent(
    agentId: string,
  ): Promise<Awaited<ReturnType<AgentWorkspaceService["resolveCdp"]>>> {
    const row = await this.db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (!row) {
      return { url: null, reason: "Agent not found", containerStatus: null, chromeInside: false };
    }
    return this.workspace.resolveCdp(row.spaceId);
  }

  /** 把数据库 Agent 行补全为「Agent + Space」视图。 */
  async hydrate(row: Agent): Promise<AgentWithSpace> {
    const space = await this.spaces.get(row.tenantId, row.spaceId);
    if (!space) throw new Error(`Agent ${row.id} 的空间不存在`);
    return hydrateAgent(row, space);
  }

  setToolsCacheInvalidator(fn: (agentId: string) => void): void {
    this.toolsCacheInvalidator = fn;
  }

  private invalidateToolsCache(agentId: string): void {
    this.toolsCacheInvalidator?.(agentId);
  }

  private rememberAgent(agent: Agent): Agent {
    this.agentCache.set(`${agent.tenantId}:${agent.id}`, agent);
    if (agent.slug) this.agentCache.set(`${agent.tenantId}:${agent.slug}`, agent);
    return agent;
  }

  private forgetAgent(agent: Pick<Agent, "tenantId" | "id" | "slug">): void {
    this.agentCache.invalidatePrefix(`${agent.tenantId}:${agent.id}`);
    if (agent.slug) this.agentCache.invalidatePrefix(`${agent.tenantId}:${agent.slug}`);
  }

  async list(tenantId: string, opts?: { spaceId?: string }): Promise<AgentWithSpace[]> {
    const rows = await this.db
      .select()
      .from(agents)
      .where(
        opts?.spaceId
          ? and(eq(agents.tenantId, tenantId), eq(agents.spaceId, opts.spaceId))
          : eq(agents.tenantId, tenantId),
      )
      .orderBy(asc(agents.createdAt));
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  async get(tenantId: string, idOrSlug: string): Promise<AgentWithSpace | null> {
    const hit = this.agentCache.get(`${tenantId}:${idOrSlug}`);
    const raw =
      hit ??
      (await this.db.query.agents.findFirst({
        where: and(eq(agents.tenantId, tenantId), eq(agents.id, idOrSlug)),
      })) ??
      (await this.db.query.agents.findFirst({
        where: and(eq(agents.tenantId, tenantId), eq(agents.slug, idOrSlug)),
      })) ??
      null;
    if (!raw) return null;
    this.rememberAgent(raw);
    return this.hydrate(raw);
  }

  async create(
    tenantId: string,
    input: {
      name: string;
      /** 归属空间；缺省用租户默认空间 */
      spaceId?: string;
      description?: string;
      config?: Record<string, unknown>;
      createApiKey?: boolean;
      /** 默认 true；显式 false 可关闭 */
      enableMemory?: boolean;
      memoryProviderId?: string | null;
      /** @deprecated 电脑/文件能力已迁到 Space；仅为旧调用保持兼容，不再写 Agent 行 */
      enableComputer?: boolean;
      workspaceImage?: string | null;
    },
  ) {
    // Space 承载电脑/工作区；Agent 只保留身份与记忆。
    const space = input.spaceId
      ? await this.requireSpace(tenantId, input.spaceId)
      : await this.spaces.ensureDefault(tenantId);
    const spaceId = space.id;

    let slug = slugify(input.name);
    const now = new Date();

    for (let i = 0; i < 20; i++) {
      const candidate = i === 0 ? slug : `${slug.slice(0, 40)}-${i + 1}`;
      const existing = await this.db.query.agents.findFirst({
        where: and(
          eq(agents.tenantId, tenantId),
          eq(agents.spaceId, spaceId),
          eq(agents.slug, candidate),
        ),
      });
      if (!existing) {
        slug = candidate;
        break;
      }
      if (i === 19) throw new Error(`Agent slug already exists: ${slug}`);
    }

    // MCP 默认对全部 Agent 可用（mode=all）；需要隔离时再切 selected + bindings
    // fx 默认启用并走 Zakura 路由（supportsZakuraRoute=true），开箱即用无需手动 login。
    // provisionAcpZakuraRoutes 会在首次会话启动时自动注入 Gateway key。
    const defaultConfig =
      input.config ??
      ({
        providers: {
          mcp: { mode: "all", instanceIds: [] },
        },
        acp: {
          permissionPolicy: "ask",
          defaultRuntime: "zakura",
          agents: {
            fx: {
              enabled: true,
              setupMode: "api_key",
              managed: {},
              modelProvider: "zakura",
            },
          },
        },
      } satisfies Record<string, unknown>);

    const [row] = await this.db
      .insert(agents)
      .values({
        id: newId(),
        tenantId,
        spaceId,
        name: input.name.trim(),
        slug,
        description: input.description?.trim() ?? "",
        enableMemory: input.enableMemory ?? true,
        memoryProviderId: input.memoryProviderId?.trim() ? input.memoryProviderId.trim() : null,
        configJson: JSON.stringify(defaultConfig),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    this.workspace.ensureLocal(row);

    let rawKey: string | undefined;
    let apiKeyRow: typeof apiKeys.$inferSelect | undefined;
    if (input.createApiKey !== false) {
      const key = generateApiKey();
      const [k] = await this.db
        .insert(apiKeys)
        .values({
          id: newId(),
          tenantId,
          spaceId,
          agentId: row.id,
          name: `agent:${slug}`,
          keyHash: key.hash,
          keyPrefix: key.prefix,
          createdAt: now,
        })
        .returning();
      await this.db.insert(mcpPolicies).values({
        id: newId(),
        tenantId,
        apiKeyId: k.id,
        instanceIds: "[]",
        includeBuiltin: false,
        createdAt: now,
        updatedAt: now,
      });
      rawKey = key.raw;
      apiKeyRow = k;
    }

    // 不再在创建时启动工作区容器；环境由后续配置后显式启动
    return {
      agent: hydrateAgent(row, space),
      space: this.spaces.serialize(space),
      starting: false,
      apiKey: apiKeyRow
        ? { id: apiKeyRow.id, name: apiKeyRow.name, keyPrefix: apiKeyRow.keyPrefix, rawKey }
        : null,
      mcpAgentUrl: `${this.config.publicBaseUrl}/mcp/agents/${row.slug}`,
      workspaceHostPath: this.workspace.hostRoot({ tenantId, spaceId }),
    };
  }

  async duplicate(tenantId: string, id: string, opts?: { name?: string }) {
    const source = await this.get(tenantId, id);
    if (!source) throw new Error("Agent not found");

    const explicit = opts?.name?.trim();
    const root = explicit || source.name;
    let name = explicit || `${root} (copy)`;
    for (let i = 1; i <= 20; i++) {
      const existing = await this.db.query.agents.findFirst({
        where: and(
          eq(agents.tenantId, tenantId),
          eq(agents.spaceId, source.spaceId),
          eq(agents.name, name),
        ),
      });
      if (!existing) break;
      if (i === 20) throw new Error(`Agent name already exists: ${name}`);
      name = `${root} (copy ${i + 1})`;
    }

    let config: Record<string, unknown> | undefined;
    try {
      config = JSON.parse(source.configJson) as Record<string, unknown>;
    } catch {
      config = undefined;
    }

    return this.create(tenantId, {
      name,
      spaceId: source.spaceId,
      description: source.description,
      config,
    });
  }

  /**
   * 启动电脑工作区（非 Agent 本身）。
   * runtimeNodeId：创建/启动时绑定 Runner（null = 本机）；仅影响电脑环境位置。
   */
  async startAsync(
    tenantId: string,
    id: string,
    opts?: { runtimeNodeId?: string | null; userId?: string },
  ): Promise<AgentWithSpace> {
    let agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");

    if (opts && "runtimeNodeId" in opts) {
      let nodeId = opts.runtimeNodeId;
      if (opts.userId) {
        await assertNodeBindAllowed(this.db, this.config, {
          userId: opts.userId,
          tenantId,
          nodeId: nodeId ?? null,
          excludeAgentId: agent.id,
        });
      }
      nodeId = await this.normalizeRuntimeNodeId(tenantId, nodeId);
      if (nodeId) {
        await this.assertNodeAvailable(tenantId, nodeId);
      }
      await this.db
        .update(spaces)
        .set({ runtimeNodeId: nodeId || null, updatedAt: new Date() })
        .where(and(eq(spaces.id, agent.spaceId), eq(spaces.tenantId, tenantId)));
      agent = (await this.get(tenantId, agent.id)) ?? agent;
    } else if (opts?.userId) {
      await assertNodeBindAllowed(this.db, this.config, {
        userId: opts.userId,
        tenantId,
        nodeId: agent.runtimeNodeId,
        excludeAgentId: agent.id,
      });
    }

    // Preflight existing bindings too, before starting a background workspace
    // job. A stale DB "online" flag is not an executable Go connection.
    if (!(opts && "runtimeNodeId" in opts) && agent.runtimeNodeId) {
      await this.assertNodeAvailable(tenantId, agent.runtimeNodeId);
    }

    if (!needsContainer(agent)) {
      return this.workspace.start(agent);
    }
    void this.workspace.start(agent).catch((err) => {
      recordPlatformFault("agent.workspace_start", err, { subsystem: "agent" });
    });
    return agent;
  }

  private async normalizeRuntimeNodeId(tenantId: string, nodeId: string | null | undefined) {
    if (nodeId !== LOCAL_RUNTIME_NODE_ID) return nodeId;
    if (!this.nodes) throw new Error("运行节点服务不可用");
    return (await this.nodes.ensureLocalNode(tenantId)).id;
  }

  private async assertNodeAvailable(tenantId: string, nodeId: string): Promise<void> {
    if (!this.nodes) throw new Error("运行节点服务不可用");
    const { node } = await this.nodes.requireRunnerClient(tenantId, nodeId);
    if (node.status === "draining") {
      throw new Error(`「${node.name}」正在排空，暂不可用于新任务。`);
    }
  }

  async update(
    tenantId: string,
    id: string,
    input: {
      name?: string;
      description?: string;
      /** Space 级：电脑环境开关 */
      enableComputer?: boolean;
      enableMemory?: boolean;
      memoryProviderId?: string | null;
      /** Space 级：工作区镜像 */
      workspaceImage?: string | null;
      /** Space 级：绑定 Runner */
      runtimeNodeId?: string | null;
      /** Space 级：host | container */
      workspaceKind?: "host" | "container";
      config?: Record<string, unknown>;
      avatarColor?: string | null;
      avatarShape?: string | null;
      avatarUrl?: string | null;
      /** Restart workspace after feature change when container-backed */
      restart?: boolean;
      userId?: string;
    },
  ): Promise<AgentWithSpace> {
    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");

    if (input.runtimeNodeId !== undefined && input.userId) {
      await assertNodeBindAllowed(this.db, this.config, {
        userId: input.userId,
        tenantId,
        nodeId: input.runtimeNodeId,
        excludeAgentId: agent.id,
      });
    }
    const runtimeNodeId = await this.normalizeRuntimeNodeId(tenantId, input.runtimeNodeId);
    if (runtimeNodeId && runtimeNodeId !== agent.runtimeNodeId) {
      await this.assertNodeAvailable(tenantId, runtimeNodeId);
    }

    if (input.memoryProviderId) {
      const mp = await this.db.query.memoryProviders.findFirst({
        where: and(
          eq(memoryProviders.id, input.memoryProviderId),
          eq(memoryProviders.tenantId, tenantId),
        ),
      });
      if (!mp) throw new Error("Memory provider not found");
    }

    // 电脑 / 工作区字段写 Space；其余写 Agent。
    const spacePatch: Record<string, unknown> = {};
    if (input.enableComputer !== undefined) spacePatch.enableComputer = Boolean(input.enableComputer);
    if (input.workspaceImage !== undefined) spacePatch.workspaceImage = input.workspaceImage;
    if (runtimeNodeId !== undefined) spacePatch.runtimeNodeId = runtimeNodeId;
    if (input.workspaceKind !== undefined) spacePatch.workspaceKind = input.workspaceKind;
    if (Object.keys(spacePatch).length > 0) {
      spacePatch.updatedAt = new Date();
      await this.db
        .update(spaces)
        .set(spacePatch)
        .where(and(eq(spaces.id, agent.spaceId), eq(spaces.tenantId, tenantId)));
    }

    const agentPatch = {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.enableMemory !== undefined ? { enableMemory: input.enableMemory } : {}),
      ...(input.memoryProviderId !== undefined
        ? { memoryProviderId: input.memoryProviderId }
        : {}),
      ...(input.config !== undefined ? { configJson: JSON.stringify(input.config) } : {}),
      ...(input.avatarColor !== undefined ? { avatarColor: input.avatarColor } : {}),
      ...(input.avatarShape !== undefined ? { avatarShape: input.avatarShape } : {}),
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
    };

    let result = agent;
    if (Object.keys(agentPatch).length > 0) {
      const [updated] = await this.db
        .update(agents)
        .set({ ...agentPatch, updatedAt: new Date() })
        .where(and(eq(agents.id, agent.id), eq(agents.tenantId, tenantId)))
        .returning();
      result = updated ? await this.hydrate(updated) : agent;
    } else if (Object.keys(spacePatch).length > 0) {
      result = (await this.get(tenantId, agent.id)) ?? agent;
    }

    const container = await this.workspace.getWorkspaceContainer(agent.spaceId);
    const workspaceAlive =
      Boolean(container?.dockerId) &&
      container?.status !== "removed" &&
      container?.status !== "exited";
    const stackChanged =
      isComputerEnvEnabled(agent) !== Boolean(result.enableComputer);

    if (input.restart || (workspaceAlive && stackChanged)) {
      if (workspaceAlive) {
        await this.workspace.stop(result);
        result = (await this.get(tenantId, id)) ?? result;
      }
      if (needsContainer(result)) {
        result = await this.workspace.start(result);
      } else {
        const [cleared] = await this.db
          .update(agents)
          .set({ lastError: null, updatedAt: new Date() })
          .where(eq(agents.id, result.id))
          .returning();
        result = cleared ? await this.hydrate(cleared) : result;
      }
    }

    this.rememberAgent(result);
    return result;
  }

  async remove(tenantId: string, id: string, opts?: { purgeData?: boolean }) {
    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");

    const container = await this.workspace.getWorkspaceContainer(agent.id);
    if (container?.dockerId && container.status !== "removed") {
      await this.workspace.stop(agent);
    }

    await this.db.delete(agents).where(and(eq(agents.id, agent.id), eq(agents.tenantId, tenantId)));
    this.forgetAgent(agent);

    if (opts?.purgeData) {
      try {
        rmSync(agentDataDir(this.config, agent.id), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return { ok: true as const };
  }

  async start(tenantId: string, id: string) {
    return this.startAsync(tenantId, id);
  }

  async stop(tenantId: string, id: string) {
    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");
    return this.workspace.stop(agent);
  }

  async listBindings(tenantId: string, agentId: string) {
    const agent = await this.get(tenantId, agentId);
    if (!agent) throw new Error("Agent not found");
    const rows = await this.db
      .select({
        id: agentBindings.id,
        agentId: agentBindings.agentId,
        spaceId: agentBindings.spaceId,
        instanceId: agentBindings.instanceId,
        createdAt: agentBindings.createdAt,
        instanceName: componentInstances.name,
        instanceSlug: componentInstances.slug,
        providerId: componentInstances.providerId,
        status: componentInstances.status,
        endpointUrl: componentInstances.endpointUrl,
      })
      .from(agentBindings)
      .innerJoin(componentInstances, eq(agentBindings.instanceId, componentInstances.id))
      .where(
        and(
          eq(agentBindings.spaceId, agent.spaceId),
          eq(agentBindings.tenantId, tenantId),
        ),
      );
    return rows;
  }

  async bindInstance(tenantId: string, agentId: string, instanceId: string) {
    const agent = await this.get(tenantId, agentId);
    if (!agent) throw new Error("Agent not found");
    const instance = await this.db.query.componentInstances.findFirst({
      where: and(
        eq(componentInstances.id, instanceId),
        eq(componentInstances.tenantId, tenantId),
      ),
    });
    if (!instance) throw new Error("Instance not found");

    const [row] = await this.db
      .insert(agentBindings)
      .values({
        id: newId(),
        tenantId,
        spaceId: agent.spaceId,
        agentId: agent.id,
        instanceId: instance.id,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    this.invalidateToolsCache(agent.id);
    return row ?? (await this.listBindings(tenantId, agent.id)).find((b) => b.instanceId === instanceId);
  }

  /**
   * MCP 安装目标：未指定 agentIds 或 all=true → 租户全部 Agent。
   * all=false 且给出 agentIds → 仅这些 Agent。
   */
  async resolveInstallAgentIds(
    tenantId: string,
    opts?: { agentIds?: string[]; all?: boolean },
  ): Promise<string[]> {
    if (opts?.all === false) {
      if (!opts.agentIds?.length) return [];
      const out: string[] = [];
      for (const id of opts.agentIds) {
        const agent = await this.get(tenantId, id);
        if (agent) out.push(agent.id);
      }
      return out;
    }
    if (opts?.all === true || !opts?.agentIds?.length) {
      return (await this.list(tenantId)).map((a) => a.id);
    }
    const out: string[] = [];
    for (const id of opts.agentIds) {
      const agent = await this.get(tenantId, id);
      if (agent) out.push(agent.id);
    }
    return out;
  }

  /** 将 MCP 实例绑定到多个 Agent，并清工具缓存 */
  async bindInstanceToAgents(
    tenantId: string,
    instanceId: string,
    agentIds: string[],
  ): Promise<void> {
    for (const agentId of agentIds) {
      await this.bindInstance(tenantId, agentId, instanceId).catch(() => undefined);
    }
  }

  async unbindInstance(tenantId: string, agentId: string, instanceId: string) {
    const agent = await this.get(tenantId, agentId);
    if (!agent) throw new Error("Agent not found");
    await this.db
      .delete(agentBindings)
      .where(
        and(
          eq(agentBindings.spaceId, agent.spaceId),
          eq(agentBindings.instanceId, instanceId),
          eq(agentBindings.tenantId, tenantId),
        ),
      );
    this.invalidateToolsCache(agent.id);
    return { ok: true as const };
  }

  /** 合并插件 hook 包到 agent.configJson.hooks */
  async mergeHookPackage(
    tenantId: string,
    agentId: string,
    pkg: import("@zakura/shared").AgentHookPackage,
  ): Promise<Agent> {
    const { mergeHookPackages, parseAgentHookPackages } = await import("@zakura/shared");
    const agent = await this.get(tenantId, agentId);
    if (!agent) throw new Error("Agent not found");
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(agent.configJson) as Record<string, unknown>;
    } catch {
      config = {};
    }
    const existing = parseAgentHookPackages(config.hooks);
    config.hooks = mergeHookPackages(existing, pkg);
    const [updated] = await this.db
      .update(agents)
      .set({ configJson: JSON.stringify(config), updatedAt: new Date() })
      .where(and(eq(agents.id, agent.id), eq(agents.tenantId, tenantId)))
      .returning();
    if (updated) {
      this.rememberAgent(updated);
      return this.hydrate(updated);
    }
    return agent;
  }

  /** Replace MCP bindings when agent uses mode=selected */
  async setMcpBindings(tenantId: string, agentId: string, instanceIds: string[]) {
    const agent = await this.get(tenantId, agentId);
    if (!agent) throw new Error("Agent not found");

    const unique = [...new Set(instanceIds.map((id) => id.trim()).filter(Boolean))];
    if (unique.length) {
      const rows = await this.db
        .select({ id: componentInstances.id, providerId: componentInstances.providerId })
        .from(componentInstances)
        .where(
          and(
            eq(componentInstances.tenantId, tenantId),
            inArray(componentInstances.id, unique),
          ),
        );
      if (rows.length !== unique.length) throw new Error("部分实例不存在或不属于当前租户");
      const blocked = rows.filter(
        (r) => r.providerId === "web-search" || r.providerId === "web-fetch",
      );
      if (blocked.length) {
        throw new Error("网页搜索/抓取/记忆请在对应 Agent 设置页开关，不要作为 MCP 绑定");
      }
    }

    await this.db.delete(agentBindings).where(
      and(eq(agentBindings.spaceId, agent.spaceId), eq(agentBindings.tenantId, tenantId)),
    );
    const now = new Date();
    for (const instanceId of unique) {
      await this.db.insert(agentBindings).values({
        id: newId(),
        tenantId,
        spaceId: agent.spaceId,
        agentId: agent.id,
        instanceId,
        createdAt: now,
      });
    }
    this.invalidateToolsCache(agent.id);
    return this.listBindings(tenantId, agent.id);
  }

  async updateProviders(tenantId: string, agentId: string, patch: AgentProvidersConfig) {
    const agent = await this.get(tenantId, agentId);
    if (!agent) throw new Error("Agent not found");

    const current = parseAgentConfig(agent);
    const next = mergeAgentProviders(current, patch);
    const [updated] = await this.db
      .update(agents)
      .set({
        configJson: JSON.stringify(next),
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agent.id), eq(agents.tenantId, tenantId)))
      .returning();

    if (patch.mcp?.mode === "selected" && Array.isArray(patch.mcp.instanceIds)) {
      await this.setMcpBindings(tenantId, agentId, patch.mcp.instanceIds);
    } else if (patch.mcp) {
      // mode=all / exposeFs 等变更也要丢掉旧的工具聚合缓存
      this.invalidateToolsCache(agent.id);
    }

    if (updated) {
      this.rememberAgent(updated);
      return this.hydrate(updated);
    }
    return agent;
  }

  /** Ensure no-auth default MCPs (currently Grep) are installed, bound, and selected. */
  async ensureDefaultMcpBindings(
    tenantId: string,
    agent: AgentWithSpace,
    orchestrator: Orchestrator,
  ): Promise<AgentWithSpace> {
    const defaultIds = await ensureDefaultAgentMcps(
      this.db,
      orchestrator,
      this.config,
      tenantId,
    );
    if (!defaultIds.length) return agent;

    await bindDefaultMcpsToAgent(this.db, tenantId, agent.spaceId, defaultIds, agent.id);

    const prefs = getAgentProviders(agent);
    if (prefs.mcp?.mode === "all") return agent;

    const current = prefs.mcp?.instanceIds ?? [];
    const selected = [...new Set([...current, ...defaultIds])];
    if (selected.length === current.length && selected.every((id) => current.includes(id))) {
      return agent;
    }

    return this.updateProviders(tenantId, agent.id, {
      mcp: { mode: "selected", instanceIds: selected },
    });
  }

  async getProviderOptions(tenantId: string, agentId: string, orchestrator: Orchestrator) {
    let agent = await this.get(tenantId, agentId);
    if (!agent) throw new Error("Agent not found");
    try {
      agent = await this.ensureDefaultMcpBindings(tenantId, agent, orchestrator);
    } catch (err) {
      recordPlatformFault("agent.default_mcp_bindings", err, { subsystem: "agent" });
    }
    const prefs = getAgentProviders(agent);

    const searchInst = await ensureCapabilityInstance(
      this.db,
      orchestrator,
      tenantId,
      "web-search",
    );
    const fetchInst = await ensureCapabilityInstance(
      this.db,
      orchestrator,
      tenantId,
      "web-fetch",
    );
    const searchCfg = readInstanceConfig<WebSearchConfig>(this.config, searchInst);
    const fetchCfg = readInstanceConfig<WebFetchConfig>(this.config, fetchInst);
    const effective = effectiveAgentWebDefaults(prefs, await getAgentWebDefaults(this.db));
    const searchEnabled = enabledEngines(searchCfg);
    const fetchEnabled = enabledBackends(fetchCfg);

    const allInstances = await this.db
      .select()
      .from(componentInstances)
      .where(eq(componentInstances.tenantId, tenantId))
      .orderBy(asc(componentInstances.createdAt));

    const bound = new Set(await this.boundInstanceIds(tenantId, agent.id));
    const mcpInstances = allInstances
      .filter(
        (i) => i.providerId !== "web-search" && i.providerId !== "web-fetch",
      )
      .map((i) => ({
        id: i.id,
        name: i.name,
        slug: i.slug,
        providerId: i.providerId,
        status: i.status,
        bound: bound.has(i.id),
      }));

    const searchEngines = listSearchEngineMeta()
      .filter((e) => searchEnabled.includes(e.id))
      .map((e) => {
        const name = displayNameForWebService(e.name, searchCfg.engines?.[e.id]);
        return {
          id: e.id,
          name,
          description:
            name === ZAKURA_AUTO_NAME ? "使用平台托管，无需配置" : e.description,
        };
      });
    const fetchBackends = listFetchBackendMeta()
      .filter((b) => fetchEnabled.includes(b.id))
      .map((b) => {
        const name = displayNameForWebService(b.name, fetchCfg.backends?.[b.id]);
        return {
          id: b.id,
          name,
          description:
            name === ZAKURA_AUTO_NAME ? "使用平台托管，无需配置" : b.description,
        };
      });

    const tenantDefaultEngine = searchCfg.defaultEngine ?? null;
    const tenantDefaultBackend = fetchCfg.defaultBackend ?? null;

    return {
      providers: prefs,
      webSearch: {
        instanceId: searchInst.id,
        status: searchInst.status,
        tenantDefaultEngine,
        /** Display label for tenant default (never raw id). */
        tenantDefaultEngineName: tenantDefaultEngine
          ? (searchEngines.find((e) => e.id === tenantDefaultEngine)?.name ??
            listSearchEngineMeta().find((e) => e.id === tenantDefaultEngine)?.name ??
            tenantDefaultEngine)
          : null,
        engines: searchEngines,
        agent: {
          enabled: effective.webSearchEnabled,
          defaultEngine: effective.searchEngine,
        },
      },
      webFetch: {
        instanceId: fetchInst.id,
        status: fetchInst.status,
        tenantDefaultBackend,
        tenantDefaultBackendName: tenantDefaultBackend
          ? (fetchBackends.find((b) => b.id === tenantDefaultBackend)?.name ??
            listFetchBackendMeta().find((b) => b.id === tenantDefaultBackend)?.name ??
            tenantDefaultBackend)
          : null,
        backends: fetchBackends,
        agent: {
          enabled: effective.webFetchEnabled,
          defaultBackend: effective.fetchBackend,
        },
      },
      mcp: {
        mode: prefs.mcp?.mode === "all" ? ("all" as const) : ("selected" as const),
        exposeWorkspaceFs: prefs.mcp?.exposeWorkspaceFs !== false,
        instances: mcpInstances,
      },
      memory: {
        enabled: agent.enableMemory,
        providerId: agent.memoryProviderId,
        note: "在 Agent 记忆页选择 Provider；全局「记忆」页仅配置 Provider 实例",
      },
    };
  }

  async boundInstanceIds(tenantId: string, agentId: string): Promise<string[]> {
    const agent = await this.get(tenantId, agentId);
    if (!agent) throw new Error("Agent not found");
    const rows = await this.db
      .select({ instanceId: agentBindings.instanceId })
      .from(agentBindings)
      .where(
        and(
          eq(agentBindings.spaceId, agentId),
          eq(agentBindings.tenantId, tenantId),
        ),
      );
    return rows.map((r) => r.instanceId);
  }

  async createAgentApiKey(
    tenantId: string,
    agentId: string,
    name?: string,
    opts?: { scopes?: string[]; expiresAt?: Date | null },
  ) {
    const agent = await this.get(tenantId, agentId);
    if (!agent) throw new Error("Agent not found");
    const key = generateApiKey();
    const now = new Date();
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        id: newId(),
        tenantId,
        spaceId: agent.spaceId,
        agentId: agent.id,
        name: name?.trim() || `agent:${agent.slug}`,
        keyHash: key.hash,
        keyPrefix: key.prefix,
        ...(opts?.scopes ? { scopes: JSON.stringify(opts.scopes) } : {}),
        ...(opts?.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
        createdAt: now,
      })
      .returning();
    await this.db.insert(mcpPolicies).values({
      id: newId(),
      tenantId,
      apiKeyId: row.id,
      instanceIds: "[]",
      includeBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
    return { ...row, rawKey: key.raw };
  }

  serialize(
    agent: AgentWithSpace,
    opts?: {
      workspace?: {
        status: string | null;
        dockerId: string | null;
        image?: string | null;
      } | null;
    },
  ) {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(agent.configJson) as Record<string, unknown>;
    } catch {
      config = {};
    }
    const ws = opts?.workspace;
    const workspaceStatus = ws?.status ?? (needsContainer(agent) ? "idle" : "none");
    const stackMode = resolveStackMode(agent);
    return {
      id: agent.id,
      tenantId: agent.tenantId,
      spaceId: agent.spaceId,
      spaceName: agent.spaceName,
      name: agent.name,
      slug: agent.slug,
      description: agent.description,
      enableComputer: isComputerEnvEnabled(agent),
      enableMemory: agent.enableMemory,
      memoryProviderId: agent.memoryProviderId,
      workspaceImage: agent.workspaceImage,
      runtimeNodeId: agent.runtimeNodeId ?? null,
      workspaceKind: agent.workspaceKind ?? "container",
      workspaceStatus: agent.workspaceStatus ?? "ready",
      workspaceRevision: agent.workspaceRevision ?? null,
      lastMigrationId: agent.lastMigrationId ?? null,
      config,
      lastError: agent.lastError,
      avatarColor: agent.avatarColor ?? null,
      avatarShape: agent.avatarShape ?? null,
      avatarUrl: agent.avatarUrl ?? null,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      mcpAgentUrl: `${this.config.publicBaseUrl}/mcp/agents/${agent.slug}`,
      workspaceHostPath: this.workspace.hostRoot(agent),
      needsContainer: needsContainer(agent),
      stackMode,
      workspace: {
        status: workspaceStatus,
        dockerId: ws?.dockerId ?? null,
        image: ws?.image ?? agent.workspaceImage,
        running: workspaceStatus === "running",
        profile: stackMode === "display" ? "full" as const : "lite" as const,
      },
    };
  }
}
