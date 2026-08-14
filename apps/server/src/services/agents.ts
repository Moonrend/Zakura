import { and, asc, eq, inArray } from "drizzle-orm";
import { generateApiKey, recordPlatformFault } from "@zakura/core";
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
  type Agent,
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
  agentWorkspaceHostPath,
} from "./agent-workspace.js";
import { isComputerEnvEnabled, needsContainer, normalizeCaps } from "./agent-caps.js";
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
import {
  assertNodeBindAllowed,
  resolveAccessibleNode,
} from "./runner-access.js";
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
  private readonly agentCache = new TtlCache<Agent>(AGENT_CACHE_TTL_MS);
  /** 绑定变更时清 Agent 工具缓存（由 McpGateway 注入） */
  private toolsCacheInvalidator: ((agentId: string) => void) | null = null;

  constructor(
    private readonly db: Db,
    runtime: DockerRuntime,
    private readonly config: AppConfig,
    nodes?: import("./runtime-nodes.js").RuntimeNodeService,
  ) {
    this.workspace = new AgentWorkspaceService(db, runtime, config, nodes);
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

  async list(tenantId: string): Promise<Agent[]> {
    return this.db
      .select()
      .from(agents)
      .where(eq(agents.tenantId, tenantId))
      .orderBy(asc(agents.createdAt));
  }

  async get(tenantId: string, idOrSlug: string): Promise<Agent | null> {
    const hit = this.agentCache.get(`${tenantId}:${idOrSlug}`);
    if (hit) return hit;
    const byId = await this.db.query.agents.findFirst({
      where: and(eq(agents.tenantId, tenantId), eq(agents.id, idOrSlug)),
    });
    if (byId) return this.rememberAgent(byId);
    const bySlug =
      (await this.db.query.agents.findFirst({
        where: and(eq(agents.tenantId, tenantId), eq(agents.slug, idOrSlug)),
      })) ?? null;
    return bySlug ? this.rememberAgent(bySlug) : null;
  }

  async create(
    tenantId: string,
    input: {
      name: string;
      description?: string;
      workspaceImage?: string | null;
      config?: Record<string, unknown>;
      createApiKey?: boolean;
      /** 默认 false；onboarding 可显式打开 */
      enableComputer?: boolean;
      /** 默认 false；onboarding 可显式打开 */
      enableMemory?: boolean;
      memoryProviderId?: string | null;
    },
  ) {
    // 默认零能力；Slug 由名称自动生成；冲突时自动加后缀
    const caps = normalizeCaps({
      enableComputer: input.enableComputer,
      enableMemory: input.enableMemory,
    });
    let slug = slugify(input.name);
    const now = new Date();

    for (let i = 0; i < 20; i++) {
      const candidate = i === 0 ? slug : `${slug.slice(0, 40)}-${i + 1}`;
      const existing = await this.db.query.agents.findFirst({
        where: and(eq(agents.tenantId, tenantId), eq(agents.slug, candidate)),
      });
      if (!existing) {
        slug = candidate;
        break;
      }
      if (i === 19) throw new Error(`Agent slug already exists: ${slug}`);
    }

    // MCP 默认对全部 Agent 可用（mode=all）；需要隔离时再切 selected + bindings
    const defaultConfig =
      input.config ??
      ({
        providers: {
          mcp: { mode: "all", instanceIds: [] },
        },
      } satisfies Record<string, unknown>);

    const [row] = await this.db
      .insert(agents)
      .values({
        id: newId(),
        tenantId,
        name: input.name.trim(),
        slug,
        description: input.description?.trim() ?? "",
        status: "ready",
        workspaceProfile: caps.workspaceProfile,
        enableFs: caps.enableFs,
        enableShell: caps.enableShell,
        enableComputer: caps.enableComputer,
        enableBrowser: caps.enableBrowser,
        enableMemory: caps.enableMemory,
        memoryProviderId: input.memoryProviderId ?? null,
        workspaceImage: input.workspaceImage ?? null,
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
      agent: row,
      starting: false,
      apiKey: apiKeyRow
        ? { id: apiKeyRow.id, name: apiKeyRow.name, keyPrefix: apiKeyRow.keyPrefix, rawKey }
        : null,
      mcpAgentUrl: `${this.config.publicBaseUrl}/mcp/agents/${row.slug}`,
      workspaceHostPath: agentWorkspaceHostPath(this.config, row.id),
    };
  }

  /**
   * 启动电脑工作区（非 Agent 本身）。
   * runtimeNodeId：创建/启动时绑定 Runner（null = 本机）；仅影响电脑环境位置。
   */
  async startAsync(
    tenantId: string,
    id: string,
    opts?: { runtimeNodeId?: string | null; userId?: string },
  ): Promise<Agent> {
    let agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");

    if (opts && "runtimeNodeId" in opts) {
      const nodeId = opts.runtimeNodeId;
      if (opts.userId) {
        await assertNodeBindAllowed(this.db, this.config, {
          userId: opts.userId,
          tenantId,
          nodeId: nodeId ?? null,
          excludeAgentId: agent.id,
        });
      }
      if (nodeId) {
        const node = await resolveAccessibleNode(this.db, tenantId, nodeId);
        if (!node) throw new Error("Runner 节点不存在");
        if (node.kind === "runner") {
          if (node.status === "offline") {
            throw new Error(
              `「${node.name}」当前离线，无法启动。请等待节点上线，或选择其他可用节点。`,
            );
          }
          if (node.status === "draining") {
            throw new Error(`「${node.name}」正在排空，暂不可用于新任务。`);
          }
          if (!node.endpoint) {
            throw new Error(
              `「${node.name}」尚未完成注册，请先在该设备启动 Runner。`,
            );
          }
        }
      }
      const [updated] = await this.db
        .update(agents)
        .set({
          runtimeNodeId: nodeId || null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agent.id))
        .returning();
      agent = updated ? this.rememberAgent(updated) : agent;
    } else if (opts?.userId) {
      await assertNodeBindAllowed(this.db, this.config, {
        userId: opts.userId,
        tenantId,
        nodeId: agent.runtimeNodeId,
        excludeAgentId: agent.id,
      });
    }

    if (!needsContainer(agent)) {
      return this.workspace.start(agent);
    }
    void this.workspace.start(agent).catch((err) => {
      recordPlatformFault("agent.workspace_start", err, { subsystem: "agent" });
    });
    return agent;
  }

  async update(
    tenantId: string,
    id: string,
    input: {
      name?: string;
      description?: string;
      enableComputer?: boolean;
      enableMemory?: boolean;
      memoryProviderId?: string | null;
      workspaceImage?: string | null;
      /** Bind agent to a runtime node; null = local */
      runtimeNodeId?: string | null;
      config?: Record<string, unknown>;
      /** Restart workspace after feature change when container-backed */
      restart?: boolean;
      userId?: string;
    },
  ): Promise<Agent> {
    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");

    if (input.runtimeNodeId !== undefined && input.userId) {
      await assertNodeBindAllowed(this.db, this.config, {
        userId: input.userId,
        tenantId,
        nodeId: input.runtimeNodeId,
        excludeAgentId: agent.id,
      });
      if (input.runtimeNodeId) {
        const node = await resolveAccessibleNode(this.db, tenantId, input.runtimeNodeId);
        if (!node) throw new Error("Runner 节点不存在");
      }
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

    const computerTouched = input.enableComputer !== undefined;

    const caps = computerTouched
      ? normalizeCaps({
          enableComputer: Boolean(input.enableComputer),
          enableMemory: input.enableMemory ?? agent.enableMemory,
        })
      : {
          workspaceProfile: agent.workspaceProfile,
          enableFs: agent.enableFs,
          enableShell: agent.enableShell,
          enableComputer: agent.enableComputer,
          enableBrowser: agent.enableBrowser,
          enableMemory: input.enableMemory ?? agent.enableMemory,
        };

    const [updated] = await this.db
      .update(agents)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        workspaceProfile: caps.workspaceProfile,
        enableFs: caps.enableFs,
        enableShell: caps.enableShell,
        enableComputer: caps.enableComputer,
        enableBrowser: caps.enableBrowser,
        enableMemory: caps.enableMemory,
        ...(input.memoryProviderId !== undefined
          ? { memoryProviderId: input.memoryProviderId }
          : {}),
        ...(input.workspaceImage !== undefined
          ? { workspaceImage: input.workspaceImage }
          : {}),
        ...(input.runtimeNodeId !== undefined
          ? { runtimeNodeId: input.runtimeNodeId }
          : {}),
        ...(input.config !== undefined ? { configJson: JSON.stringify(input.config) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agent.id))
      .returning();

    let result = updated!;

    const container = await this.workspace.getWorkspaceContainer(agent.id);
    const workspaceAlive =
      Boolean(container?.dockerId) &&
      container?.status !== "removed" &&
      container?.status !== "exited";
    const stackChanged =
      isComputerEnvEnabled(agent) !== isComputerEnvEnabled(caps);

    if (input.restart || (workspaceAlive && stackChanged)) {
      if (workspaceAlive) {
        await this.workspace.stop(result);
        result = (await this.get(tenantId, id)) ?? result;
      }
      if (needsContainer(caps)) {
        result = await this.workspace.start(result);
      } else {
        const [cleared] = await this.db
          .update(agents)
          .set({ lastError: null, updatedAt: new Date() })
          .where(eq(agents.id, result.id))
          .returning();
        result = cleared ?? result;
      }
    }

    return this.rememberAgent(result);
  }

  async remove(tenantId: string, id: string, opts?: { purgeData?: boolean }) {
    const agent = await this.get(tenantId, id);
    if (!agent) throw new Error("Agent not found");

    const container = await this.workspace.getWorkspaceContainer(agent.id);
    if (container?.dockerId && container.status !== "removed") {
      await this.workspace.stop(agent);
    }

    await this.db.delete(agents).where(eq(agents.id, agent.id));
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

  async listBindings(agentId: string) {
    const rows = await this.db
      .select({
        id: agentBindings.id,
        agentId: agentBindings.agentId,
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
      .where(eq(agentBindings.agentId, agentId));
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
        agentId: agent.id,
        instanceId: instance.id,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    this.invalidateToolsCache(agent.id);
    return row ?? (await this.listBindings(agent.id)).find((b) => b.instanceId === instanceId);
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
      .where(and(eq(agentBindings.agentId, agent.id), eq(agentBindings.instanceId, instanceId)));
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
    return this.rememberAgent(updated ?? agent);
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

    await this.db.delete(agentBindings).where(eq(agentBindings.agentId, agent.id));
    const now = new Date();
    for (const instanceId of unique) {
      await this.db.insert(agentBindings).values({
        id: newId(),
        tenantId,
        agentId: agent.id,
        instanceId,
        createdAt: now,
      });
    }
    this.invalidateToolsCache(agent.id);
    return this.listBindings(agent.id);
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
      .where(eq(agents.id, agent.id))
      .returning();

    if (patch.mcp?.mode === "selected" && Array.isArray(patch.mcp.instanceIds)) {
      await this.setMcpBindings(tenantId, agentId, patch.mcp.instanceIds);
    } else if (patch.mcp) {
      // mode=all / exposeFs 等变更也要丢掉旧的工具聚合缓存
      this.invalidateToolsCache(agent.id);
    }

    return this.rememberAgent(updated ?? agent);
  }

  /** Ensure no-auth default MCPs (currently Grep) are installed, bound, and selected. */
  async ensureDefaultMcpBindings(
    tenantId: string,
    agent: Agent,
    orchestrator: Orchestrator,
  ): Promise<Agent> {
    const defaultIds = await ensureDefaultAgentMcps(
      this.db,
      orchestrator,
      this.config,
      tenantId,
    );
    if (!defaultIds.length) return agent;

    await bindDefaultMcpsToAgent(this.db, tenantId, agent.id, defaultIds);

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

    const bound = new Set(await this.boundInstanceIds(agent.id));
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

  async boundInstanceIds(agentId: string): Promise<string[]> {
    const rows = await this.db
      .select({ instanceId: agentBindings.instanceId })
      .from(agentBindings)
      .where(eq(agentBindings.agentId, agentId));
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
    agent: Agent,
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
    return {
      id: agent.id,
      tenantId: agent.tenantId,
      name: agent.name,
      slug: agent.slug,
      description: agent.description,
      enableComputer: isComputerEnvEnabled(agent),
      enableMemory: agent.enableMemory,
      memoryProviderId: agent.memoryProviderId,
      workspaceImage: agent.workspaceImage,
      runtimeNodeId: agent.runtimeNodeId ?? null,
      workspaceStatus: agent.workspaceStatus ?? "ready",
      workspaceRevision: agent.workspaceRevision ?? null,
      lastMigrationId: agent.lastMigrationId ?? null,
      config,
      lastError: agent.lastError,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      mcpAgentUrl: `${this.config.publicBaseUrl}/mcp/agents/${agent.slug}`,
      workspaceHostPath: agentWorkspaceHostPath(this.config, agent.id),
      needsContainer: needsContainer(agent),
      workspace: {
        status: workspaceStatus,
        dockerId: ws?.dockerId ?? null,
        image: ws?.image ?? agent.workspaceImage,
        running: workspaceStatus === "running",
      },
    };
  }
}
