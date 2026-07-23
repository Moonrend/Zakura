import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { globalRegistry, textResult, type InstanceHandle } from "@zakura/core";
import type { McpToolDef, McpToolResult, MemoryProviderKind } from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  agents,
  componentInstances,
  managedContainers,
  mcpPolicies,
  type Agent,
} from "../db/schema.js";
import type { DockerRuntime } from "../runtime/docker.js";
import type { AgentBrowserService } from "./agent-cdp.js";
import { callAgentNativeTool, listAgentNativeTools } from "./agent-tools.js";
import type { AgentService } from "./agents.js";
import {
  getAgentMcpMode,
  getAgentProviders,
  isWebFetchEnabledForAgent,
  isWebSearchEnabledForAgent,
} from "./agent-providers.js";
import { ensureCapabilityInstance } from "./capabilities.js";
import type { MemoryStore } from "./memory-store.js";
import type { MemoryProvidersService } from "./memory-providers.js";
import type { Orchestrator } from "./orchestrator.js";
import type { ToolCallStore } from "./tool-call-store.js";

/** Provider ids that are tenant capability panels — not selected via MCP bindings */
const CAPABILITY_PROVIDER_IDS = new Set(["web-search", "web-fetch"]);

export interface ResolvedTool {
  qualifiedName: string;
  instanceId: string | null;
  providerId: string;
  localName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  title?: string;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolDef["annotations"];
  securitySchemes?: McpToolDef["securitySchemes"];
  _meta?: Record<string, unknown>;
  builtin?: boolean;
  /** Native Zakura agent tool (fs/shell/computer) */
  agentScoped?: boolean;
  agentId?: string;
}

function qualify(instanceSlug: string, toolName: string): string {
  return `${instanceSlug}__${toolName}`;
}

/** All MCP-exposed tool names use a stable re_ prefix */
export function withRePrefix(name: string): string {
  return name.startsWith("re_") ? name : `re_${name}`;
}

export class McpGateway {
  private agentService: AgentService | null = null;
  private browserService: AgentBrowserService | null = null;
  private memoryStore: MemoryStore | null = null;
  private memoryProviders: MemoryProvidersService | null = null;
  private toolCallStore: ToolCallStore | null = null;
  private workspaceFsProvider: import("./workspace-fs-provider.js").ServerWorkspaceFsProvider | null =
    null;
  private exposureService: import("./port-exposures.js").ExposureService | null = null;

  constructor(
    private readonly db: Db,
    private readonly orchestrator: Orchestrator,
    private readonly runtime: DockerRuntime,
  ) {}

  /** Late-bind to avoid circular ctor deps */
  setAgentService(service: AgentService): void {
    this.agentService = service;
  }

  setBrowserService(service: AgentBrowserService): void {
    this.browserService = service;
  }

  setMemoryStore(store: MemoryStore): void {
    this.memoryStore = store;
  }

  setWorkspaceFsProvider(
    provider: import("./workspace-fs-provider.js").ServerWorkspaceFsProvider,
  ): void {
    this.workspaceFsProvider = provider;
  }

  setMemoryProviders(service: MemoryProvidersService): void {
    this.memoryProviders = service;
  }

  setToolCallStore(store: ToolCallStore): void {
    this.toolCallStore = store;
  }

  setExposureService(service: import("./port-exposures.js").ExposureService): void {
    this.exposureService = service;
  }

  private builtinTools(tenantId: string): ResolvedTool[] {
    void tenantId;
    return [
      {
        qualifiedName: withRePrefix("containers_list"),
        instanceId: null,
        providerId: "zakura",
        localName: "containers_list",
        description: "列出当前租户由 Zakura 管理的容器",
        inputSchema: {
          type: "object",
          properties: {
            purpose: {
              type: "string",
              enum: ["component", "workspace", "ephemeral"],
            },
          },
        },
        builtin: true,
      },
      {
        qualifiedName: withRePrefix("containers_create"),
        instanceId: null,
        providerId: "zakura",
        localName: "containers_create",
        description: "为 Agent 分配一个工作区/临时容器",
        inputSchema: {
          type: "object",
          required: ["image"],
          properties: {
            image: { type: "string", description: "Docker 镜像" },
            name: { type: "string" },
            purpose: { type: "string", enum: ["workspace", "ephemeral"], default: "ephemeral" },
            allocated_to: { type: "string", description: "Agent / session 标识" },
            command: { type: "array", items: { type: "string" } },
            env: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        builtin: true,
      },
      {
        qualifiedName: withRePrefix("containers_exec"),
        instanceId: null,
        providerId: "zakura",
        localName: "containers_exec",
        description: "在已分配的容器中执行命令",
        inputSchema: {
          type: "object",
          required: ["container_id", "command"],
          properties: {
            container_id: { type: "string" },
            command: { type: "array", items: { type: "string" } },
            working_dir: { type: "string" },
          },
        },
        builtin: true,
      },
      {
        qualifiedName: withRePrefix("containers_stop"),
        instanceId: null,
        providerId: "zakura",
        localName: "containers_stop",
        description: "停止并移除容器",
        inputSchema: {
          type: "object",
          required: ["container_id"],
          properties: {
            container_id: { type: "string" },
            remove: { type: "boolean", default: true },
          },
        },
        builtin: true,
      },
      {
        qualifiedName: withRePrefix("containers_logs"),
        instanceId: null,
        providerId: "zakura",
        localName: "containers_logs",
        description: "获取容器日志",
        inputSchema: {
          type: "object",
          required: ["container_id"],
          properties: {
            container_id: { type: "string" },
            tail: { type: "number", default: 200 },
          },
        },
        builtin: true,
      },
      {
        qualifiedName: withRePrefix("instances_list"),
        instanceId: null,
        providerId: "zakura",
        localName: "instances_list",
        description: "列出已编排的组件实例及其健康状态",
        inputSchema: { type: "object", properties: {} },
        builtin: true,
      },
      {
        qualifiedName: withRePrefix("agents_list"),
        instanceId: null,
        providerId: "zakura",
        localName: "agents_list",
        description: "列出当前租户的 Agent 配置（不含工具细节）",
        inputSchema: { type: "object", properties: {} },
        builtin: true,
      },
    ];
  }

  /**
   * Agent tool universe:
   * 1) native tools gated by enableComputer / enableMemory
   * 2) web-search / web-fetch when agent providers.*.enabled === true
   * 3) other component instances: all running (mcp.mode=all) or agent_bindings (selected)
   */
  async listToolsForAgent(agent: Agent): Promise<ResolvedTool[]> {
    if (!this.agentService) throw new Error("AgentService not bound");

    // 仅在 Agent 显式启用时才 ensure+start 能力实例（默认不启容器）
    if (isWebSearchEnabledForAgent(agent)) {
      try {
        await ensureCapabilityInstance(this.db, this.orchestrator, agent.tenantId, "web-search", {
          start: true,
        });
      } catch (err) {
        console.warn(`[mcp] web-search capability:`, err);
      }
    }
    if (isWebFetchEnabledForAgent(agent)) {
      try {
        await ensureCapabilityInstance(this.db, this.orchestrator, agent.tenantId, "web-fetch", {
          start: true,
        });
      } catch (err) {
        console.warn(`[mcp] web-fetch capability:`, err);
      }
    }
    let memoryKind: MemoryProviderKind | null = null;
    if (agent.enableMemory && this.memoryProviders) {
      try {
        await this.memoryProviders.ensureDefault(agent.tenantId);
        const resolved = await this.memoryProviders.resolveForAgent(
          agent.tenantId,
          agent.memoryProviderId,
        );
        memoryKind = (resolved?.kind as MemoryProviderKind) ?? "builtin";
      } catch (err) {
        console.warn(`[mcp] memory provider:`, err);
        memoryKind = "builtin";
      }
    }

    const tools: ResolvedTool[] = listAgentNativeTools(agent, memoryKind).map((t) => ({
      ...t,
      agentId: agent.id,
    }));
    const usedNames = new Set(tools.map((t) => t.qualifiedName));

    const mcpMode = getAgentMcpMode(agent);
    const boundIds =
      mcpMode === "selected" ? new Set(await this.agentService.boundInstanceIds(agent.id)) : null;

    const instances = await this.db
      .select()
      .from(componentInstances)
      .where(
        and(
          eq(componentInstances.tenantId, agent.tenantId),
          eq(componentInstances.status, "running"),
        ),
      );

    for (const instance of instances) {
      if (instance.providerId === "web-search" && !isWebSearchEnabledForAgent(agent)) continue;
      if (instance.providerId === "web-fetch" && !isWebFetchEnabledForAgent(agent)) continue;

      // Non-capability MCP/plugins: respect bindings when mode=selected
      if (!CAPABILITY_PROVIDER_IDS.has(instance.providerId)) {
        if (boundIds && !boundIds.has(instance.id)) continue;
      }

      if (!globalRegistry.has(instance.providerId)) continue;
      const plugin = globalRegistry.get(instance.providerId);
      let handle: InstanceHandle;
      try {
        handle = await this.orchestrator.toHandle(agent.tenantId, instance.id);
      } catch {
        continue;
      }
      let listed: McpToolDef[] = [];
      try {
        if (
          handle.config.authRequired === true &&
          !(
            (typeof handle.config.oauthAccessToken === "string" &&
              handle.config.oauthAccessToken.trim()) ||
            (typeof handle.config.apiKey === "string" && handle.config.apiKey.trim())
          )
        ) {
          console.warn(
            `[mcp] agent listTools ${instance.slug}: skipped (AUTH_REQUIRED)`,
          );
          continue;
        }
        listed = await plugin.listTools(handle);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] agent listTools ${instance.slug}: ${msg.slice(0, 200)}`);
        continue;
      }
      for (const t of listed) {
        let name = withRePrefix(t.name);
        if (usedNames.has(name)) {
          name = withRePrefix(qualify(instance.slug, t.name));
        }
        if (usedNames.has(name)) continue;
        usedNames.add(name);
        tools.push({
          qualifiedName: name,
          instanceId: instance.id,
          providerId: instance.providerId,
          localName: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          title: t.title,
          outputSchema: t.outputSchema,
          annotations: t.annotations,
          securitySchemes: t.securitySchemes,
          _meta: t._meta,
          agentId: agent.id,
        });
      }
    }

    return tools;
  }

  async listToolsForTenant(
    tenantId: string,
    opts?: { apiKeyId?: string; includeBuiltin?: boolean; agentId?: string | null },
  ): Promise<ResolvedTool[]> {
    // Agent-scoped key or explicit agent → only that agent's world
    if (opts?.agentId && this.agentService) {
      const agent = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, opts.agentId), eq(agents.tenantId, tenantId)),
      });
      if (!agent) return [];
      return this.listToolsForAgent(agent);
    }

    const policyResolved = opts?.apiKeyId
      ? await this.db.query.mcpPolicies.findFirst({
          where: and(
            eq(mcpPolicies.tenantId, tenantId),
            eq(mcpPolicies.apiKeyId, opts.apiKeyId),
          ),
        })
      : await this.db.query.mcpPolicies.findFirst({
          where: and(eq(mcpPolicies.tenantId, tenantId), isNull(mcpPolicies.apiKeyId)),
        });

    const allowedInstances: string[] | null = policyResolved
      ? (JSON.parse(policyResolved.instanceIds) as string[])
      : null;
    const allowlist = policyResolved?.toolAllowlist
      ? (JSON.parse(policyResolved.toolAllowlist) as string[])
      : null;
    const denylist = policyResolved?.toolDenylist
      ? (JSON.parse(policyResolved.toolDenylist) as string[])
      : null;
    const includeBuiltin = opts?.includeBuiltin ?? policyResolved?.includeBuiltin ?? false;

    const whereClause =
      allowedInstances && allowedInstances.length > 0
        ? and(
            eq(componentInstances.tenantId, tenantId),
            eq(componentInstances.status, "running"),
            inArray(componentInstances.id, allowedInstances),
          )
        : and(
            eq(componentInstances.tenantId, tenantId),
            eq(componentInstances.status, "running"),
          );

    const instances = await this.db.select().from(componentInstances).where(whereClause);

    const tools: ResolvedTool[] = [];
    if (includeBuiltin) {
      tools.push(...this.builtinTools(tenantId));
    }

    for (const instance of instances) {
      const plugin = globalRegistry.get(instance.providerId);
      let handle: InstanceHandle;
      try {
        handle = await this.orchestrator.toHandle(tenantId, instance.id);
      } catch {
        continue;
      }
      let listed: McpToolDef[] = [];
      try {
        const lastError = instance.lastError ?? "";
        const hasCreds =
          (typeof handle.config.oauthAccessToken === "string" &&
            handle.config.oauthAccessToken.trim().length > 0) ||
          (typeof handle.config.apiKey === "string" && handle.config.apiKey.trim().length > 0);
        const authBlocked =
          (handle.config.authRequired === true || lastError.startsWith("AUTH_REQUIRED")) &&
          !hasCreds;
        const unreachable = lastError.startsWith("UNREACHABLE");

        if (authBlocked) {
          console.warn(
            `[mcp] listTools ${instance.slug}: skipped (AUTH_REQUIRED — 请完成上游 OAuth 或填写 API Key)`,
          );
          continue;
        }
        if (unreachable) {
          console.warn(
            `[mcp] listTools ${instance.slug}: skipped (UNREACHABLE — 可点「健康检查」重试)`,
          );
          continue;
        }
        listed = await plugin.listTools(handle);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] listTools ${instance.slug}: ${msg.slice(0, 200)}`);
        continue;
      }
      for (const t of listed) {
        const rawQualified = qualify(instance.slug, t.name);
        const qualifiedName = withRePrefix(rawQualified);
        const bare = withRePrefix(t.name);
        if (
          allowlist &&
          !allowlist.includes(qualifiedName) &&
          !allowlist.includes(bare) &&
          !allowlist.includes(t.name) &&
          !allowlist.includes(rawQualified)
        ) {
          continue;
        }
        if (
          denylist &&
          (denylist.includes(qualifiedName) ||
            denylist.includes(bare) ||
            denylist.includes(t.name) ||
            denylist.includes(rawQualified))
        ) {
          continue;
        }
        tools.push({
          qualifiedName,
          instanceId: instance.id,
          providerId: instance.providerId,
          localName: t.name,
          description: `[${instance.name}] ${t.description}`,
          inputSchema: t.inputSchema,
          title: t.title,
          outputSchema: t.outputSchema,
          annotations: t.annotations,
          securitySchemes: t.securitySchemes,
          _meta: t._meta,
        });
      }
    }

    return tools;
  }

  async callTool(
    tenantId: string,
    qualifiedName: string,
    args: Record<string, unknown>,
    opts?: { apiKeyId?: string; agentId?: string | null },
  ): Promise<McpToolResult> {
    const tools = await this.listToolsForTenant(tenantId, opts);
    const tool = tools.find((t) => t.qualifiedName === qualifiedName);
    if (!tool) {
      const missing = textResult(`Unknown tool: ${qualifiedName}`, true);
      void this.toolCallStore?.record({
        tenantId,
        apiKeyId: opts?.apiKeyId,
        agentId: opts?.agentId,
        qualifiedName,
        localName: qualifiedName,
        providerId: "",
        args,
        result: missing,
        durationMs: 0,
      });
      return missing;
    }

    const started = Date.now();
    let result: McpToolResult;
    try {
      result = await this.dispatchTool(tenantId, tool, args, opts);
    } catch (err) {
      result = textResult(err instanceof Error ? err.message : String(err), true);
    }

    void this.toolCallStore?.record({
      tenantId,
      apiKeyId: opts?.apiKeyId,
      agentId: opts?.agentId ?? tool.agentId ?? null,
      qualifiedName: tool.qualifiedName,
      localName: tool.localName,
      providerId: tool.providerId,
      instanceId: tool.instanceId,
      args,
      result,
      durationMs: Date.now() - started,
    });

    return result;
  }

  private async dispatchTool(
    tenantId: string,
    tool: ResolvedTool,
    args: Record<string, unknown>,
    opts?: { apiKeyId?: string; agentId?: string | null },
  ): Promise<McpToolResult> {
    void opts;
    if (tool.agentScoped && tool.agentId && this.agentService) {
      const agent = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, tool.agentId), eq(agents.tenantId, tenantId)),
      });
      if (!agent) return textResult("Agent not found", true);
      return callAgentNativeTool(
        agent,
        this.agentService.workspace,
        tool.localName,
        args,
        this.browserService,
        this.memoryStore,
        this.memoryProviders,
        this.workspaceFsProvider,
        this.exposureService,
      );
    }

    if (tool.builtin) {
      return this.callBuiltin(tenantId, tool.localName, args);
    }

    if (!tool.instanceId) {
      return textResult("Tool missing instance", true);
    }

    const handle = await this.orchestrator.toHandle(tenantId, tool.instanceId);
    const plugin = globalRegistry.get(tool.providerId);

    // Inject per-agent default engine/backend when the model omitted them
    let callArgs = args;
    if (tool.agentId) {
      const agentRow = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, tool.agentId), eq(agents.tenantId, tenantId)),
      });
      if (agentRow) {
        const prefs = getAgentProviders(agentRow);
        if (tool.providerId === "web-search" && typeof args.engine !== "string" && prefs.webSearch?.defaultEngine) {
          callArgs = { ...args, engine: prefs.webSearch.defaultEngine };
        }
        if (tool.providerId === "web-fetch" && typeof args.backend !== "string" && prefs.webFetch?.defaultBackend) {
          callArgs = { ...args, backend: prefs.webFetch.defaultBackend };
        }
      }
    }

    return plugin.callTool(handle, tool.localName, callArgs);
  }

  private async callBuiltin(
    tenantId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    try {
      if (name === "containers_list") {
        const purpose = typeof args.purpose === "string" ? args.purpose : undefined;
        const rows = await this.db
          .select()
          .from(managedContainers)
          .where(
            purpose
              ? and(eq(managedContainers.tenantId, tenantId), eq(managedContainers.purpose, purpose))
              : eq(managedContainers.tenantId, tenantId),
          )
          .orderBy(desc(managedContainers.createdAt));
        return textResult(JSON.stringify(rows, null, 2));
      }

      if (name === "containers_create") {
        const row = await this.orchestrator.allocateContainer({
          tenantId,
          image: String(args.image),
          name: typeof args.name === "string" ? args.name : undefined,
          purpose: (args.purpose as "workspace" | "ephemeral") ?? "ephemeral",
          allocatedTo: typeof args.allocated_to === "string" ? args.allocated_to : undefined,
          env: (args.env as Record<string, string>) ?? undefined,
          command: Array.isArray(args.command) ? (args.command as string[]) : undefined,
        });
        return textResult(JSON.stringify(row, null, 2));
      }

      if (name === "containers_exec") {
        const dockerId = await this.resolveDockerId(tenantId, String(args.container_id));
        const result = await this.runtime.exec(dockerId, args.command as string[], {
          workingDir: typeof args.working_dir === "string" ? args.working_dir : undefined,
        });
        return textResult(JSON.stringify(result, null, 2));
      }

      if (name === "containers_stop") {
        const row = await this.findContainer(tenantId, String(args.container_id));
        if (row.dockerId) {
          await this.runtime.stop(row.dockerId);
          if (args.remove !== false) {
            await this.runtime.remove(row.dockerId, true);
            await this.db
              .update(managedContainers)
              .set({ status: "removed", dockerId: null, updatedAt: new Date() })
              .where(eq(managedContainers.id, row.id));
          } else {
            await this.db
              .update(managedContainers)
              .set({ status: "exited", updatedAt: new Date() })
              .where(eq(managedContainers.id, row.id));
          }
        }
        return textResult(JSON.stringify({ ok: true, id: row.id }));
      }

      if (name === "containers_logs") {
        const dockerId = await this.resolveDockerId(tenantId, String(args.container_id));
        const logs = await this.runtime.logs(
          dockerId,
          typeof args.tail === "number" ? args.tail : 200,
        );
        return textResult(logs);
      }

      if (name === "instances_list") {
        const rows = await this.db
          .select({
            id: componentInstances.id,
            name: componentInstances.name,
            slug: componentInstances.slug,
            providerId: componentInstances.providerId,
            status: componentInstances.status,
            healthStatus: componentInstances.healthStatus,
            endpointUrl: componentInstances.endpointUrl,
          })
          .from(componentInstances)
          .where(eq(componentInstances.tenantId, tenantId));
        return textResult(JSON.stringify(rows, null, 2));
      }

      if (name === "agents_list") {
        const rows = await this.db
          .select({
            id: agents.id,
            name: agents.name,
            slug: agents.slug,
            workspaceStatus: agents.workspaceStatus,
            enableComputer: agents.enableComputer,
            enableMemory: agents.enableMemory,
          })
          .from(agents)
          .where(eq(agents.tenantId, tenantId));
        return textResult(JSON.stringify(rows, null, 2));
      }

      return textResult(`Unknown builtin tool: ${name}`, true);
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  }

  private async findContainer(tenantId: string, idOrDocker: string) {
    const rows = await this.db
      .select()
      .from(managedContainers)
      .where(
        and(
          eq(managedContainers.tenantId, tenantId),
          or(
            eq(managedContainers.id, idOrDocker),
            eq(managedContainers.dockerId, idOrDocker),
            eq(managedContainers.name, idOrDocker),
          ),
        ),
      );
    const row = rows[0];
    if (!row) throw new Error(`Container not found: ${idOrDocker}`);
    return row;
  }

  private async resolveDockerId(tenantId: string, idOrDocker: string): Promise<string> {
    const row = await this.findContainer(tenantId, idOrDocker);
    if (!row.dockerId) throw new Error(`Container has no docker id: ${row.id}`);
    return row.dockerId;
  }
}
