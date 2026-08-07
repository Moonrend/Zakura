import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { globalRegistry, textResult, type InstanceHandle } from "@zakura/core";
import type {
  McpCompleteParams,
  McpCompleteResult,
  McpCreateTaskResult,
  McpGetPromptResult,
  McpPromptDef,
  McpReadResourceResult,
  McpToolDef,
  McpToolResult,
  MemoryProviderKind,
} from "@zakura/shared";
import {
  DEFAULT_TASK_OPTIONAL_TOOLS,
  isCreateTaskResult,
  rewriteToolUiMeta,
  SKILL_MANIFEST_FILE,
} from "@zakura/shared";
import type { ZakuraTaskStore } from "./mcp-task-store.js";
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
import { REDIS_KEYS } from "./redis.js";
import { redisGetJson, redisSetJson, REDIS_TTL } from "./redis-store.js";
import { TtlCache } from "../model-router/cache.js";
import { callAgentNativeTool, listAgentNativeTools } from "./agent-tools.js";
import {
  AGENT_NATIVE_PROVIDER_ID,
  getAgentNativePrompt,
  isAgentNativePromptName,
  isAgentNativeResourceUri,
  isWorkspaceFsResourceUri,
  listAgentNativePrompts,
  listAgentNativeResources,
  listAgentNativeResourceTemplates,
  listWorkspaceFsResources,
  readAgentNativeResource,
  readWorkspaceFsResource,
} from "./agent-mcp-primitives.js";
import type { AgentService } from "./agents.js";
import {
  getAgentMcpMode,
  getAgentProviders,
  isPlatformAssistant,
  isWorkspaceFsExposedViaMcp,
} from "./agent-providers.js";
import { effectiveAgentWebDefaults, getAgentWebDefaults } from "./agent-defaults.js";
import { ensureCapabilityInstance } from "./capabilities.js";
import type { MemoryStore } from "./memory-store.js";
import type { MemoryProvidersService } from "./memory-providers.js";
import type { Orchestrator } from "./orchestrator.js";
import { callPlatformAssistantTool, isPlatformAssistantToolName, listPlatformAssistantTools } from "./platform-assistant-tools.js";
import type { ToolCallStore } from "./tool-call-store.js";
import { callSkillTool, isSkillToolName } from "./skills/tools.js";
import type { IntegrationCatalogService } from "./integration-catalog.js";
import { applyConnectorCredentialsToConfig } from "../providers/credential-config.js";

/** Provider ids that are tenant capability panels — not selected via MCP bindings */
const CAPABILITY_PROVIDER_IDS = new Set(["web-search", "web-fetch"]);
const DIRECT_CONNECTOR_PROVIDER_ID = "zakura-connector";

const SKILL_INDEX_RESOURCE_URI = "skill://index.json";
const SKILL_RESOURCE_PREFIX = "skill://";
const SKILL_RESOURCE_TEMPLATE = "skill://{name}/{+path}";
const LEGACY_SKILLS_RESOURCE_URI = "zakura://agent/skills";
const LEGACY_SKILL_RESOURCE_PREFIX = "zakura://agent/skills/";

type InstanceRow = typeof componentInstances.$inferSelect;

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
  execution?: McpToolDef["execution"];
  builtin?: boolean;
  /** Native Zakura agent tool (fs/shell/computer) */
  agentScoped?: boolean;
  agentId?: string;
}

export interface ResolvedResource {
  /** 对外 URI（含实例限定，避免冲突） */
  qualifiedUri: string;
  /** 原生平台资源为 null */
  instanceId: string | null;
  providerId: string;
  /** 上游原始 URI */
  localUri: string;
  name: string;
  description?: string;
  mimeType?: string;
  title?: string;
  _meta?: Record<string, unknown>;
  agentId?: string;
}

export interface ResolvedPrompt {
  qualifiedName: string;
  /** 原生平台 prompt 为 null */
  instanceId: string | null;
  providerId: string;
  localName: string;
  description?: string;
  title?: string;
  arguments?: McpPromptDef["arguments"];
  _meta?: Record<string, unknown>;
  agentId?: string;
}

export interface ResolvedResourceTemplate {
  qualifiedUriTemplate: string;
  /** 原生平台模板为 null */
  instanceId: string | null;
  providerId: string;
  localUriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  title?: string;
  _meta?: Record<string, unknown>;
  agentId?: string;
}

function qualify(instanceSlug: string, toolName: string): string {
  return `${instanceSlug}__${toolName}`;
}

type DirectConnectorTarget = Awaited<
  ReturnType<IntegrationCatalogService["listDirectConnectorTargets"]>
>[number];

function directConnectorHandle(
  tenantId: string,
  target: DirectConnectorTarget,
): InstanceHandle {
  const config: Record<string, unknown> = {
    product: target.product,
    mcpUrl: target.mcpUrl,
    authRequired: false,
    oauthTokenEndpoint: target.discovery.tokenEndpoint,
    ...(target.client
      ? {
          oauthClientId: target.client.clientId,
          ...(target.client.clientSecret
            ? { oauthClientSecret: target.client.clientSecret }
            : {}),
        }
      : {}),
    ...(target.authorization ?? {}),
    ...(target.credentials
      ? applyConnectorCredentialsToConfig(
          {},
          target.auth,
          target.credentials.values,
          target.credentials.settings,
        )
      : {}),
  };
  return {
    id: `connector:${target.connectorRef}:${target.capabilityRef}`,
    tenantId,
    providerId: target.providerId,
    name: target.connectorName,
    slug: target.instanceSlug,
    config,
    endpointUrl: null,
    containers: {},
  };
}

function encodeUriPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function skillResourceUri(name: string, path = SKILL_MANIFEST_FILE): string {
  return `${SKILL_RESOURCE_PREFIX}${encodeURIComponent(name)}/${encodeUriPath(path)}`;
}

function parseSkillResourceUri(
  uri: string,
): { list: true } | { list: false; name: string; path: string } | null {
  if (
    uri === SKILL_INDEX_RESOURCE_URI ||
    uri === LEGACY_SKILLS_RESOURCE_URI ||
    uri === `${LEGACY_SKILLS_RESOURCE_URI}/`
  ) {
    return { list: true };
  }

  const rest = uri.startsWith(LEGACY_SKILL_RESOURCE_PREFIX)
    ? uri.slice(LEGACY_SKILL_RESOURCE_PREFIX.length)
    : uri.startsWith(SKILL_RESOURCE_PREFIX)
      ? uri.slice(SKILL_RESOURCE_PREFIX.length)
      : null;
  if (rest === null) return null;
  if (rest === "index.json") return { list: true };

  const [encodedName, ...pathParts] = rest.split("/");
  if (!encodedName) return null;
  try {
    const name = decodeURIComponent(encodedName);
    const path = pathParts.length
      ? pathParts.map((part) => decodeURIComponent(part)).join("/")
      : SKILL_MANIFEST_FILE;
    return { list: false, name, path };
  } catch {
    return null;
  }
}

function skillMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "text/javascript";
  }
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "text/typescript";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  return "text/plain";
}

/** 云端子代理工具：provider 标识 + 对外名 */
export const SUBAGENT_PROVIDER_ID = "zakura-subagent";
export const SUBAGENT_TOOL_NAME = "spawn_subagent";
export const SUBAGENT_TOOL_QUALIFIED = `re_${SUBAGENT_TOOL_NAME}`;

/**
 * 云端子代理执行器接口：由 CloudAgentRuntime 注入。
 * MCP 客户端与 agent loop 都经此在云端运行隔离上下文的子代理；
 * 每次运行的完整对话都落库为 kind=subagent 的会话（sessionId 返回给调用方）。
 */
export interface CloudSubagentRunner {
  run(
    tenantId: string,
    agent: Agent,
    args: Record<string, unknown>,
    opts: {
      /** 父任务取消检查（MCP 外部调用可缺省） */
      isCancelled?: () => Promise<boolean>;
      /** 进度回调（agent loop 用于 run_log） */
      onProgress?: (message: string, data?: Record<string, unknown>) => void;
      /** 会话来源链接（缺省视为外部 MCP 触发） */
      origin?: import("@zakura/shared").CloudAgentSessionOrigin;
      /** 嵌套深度（缺省 1；子代理再派生时逐级 +1，达配置上限后不可再派生） */
      depth?: number;
    },
  ): Promise<{ text: string; sessionId: string }>;
}

function subagentToolDef(agentId: string): ResolvedTool {
  return {
    qualifiedName: SUBAGENT_TOOL_QUALIFIED,
    instanceId: null,
    providerId: SUBAGENT_PROVIDER_ID,
    localName: SUBAGENT_TOOL_NAME,
    title: "Cloud subagent",
    description: [
      "[Callable now] Spawn a cloud subagent for an independent subtask; the final result is returned by this tool.",
      "The subagent shares this Agent's workspace and full tool surface, but has an isolated context (no current chat/memory).",
      "Use for: parallel subtasks (multiple re_spawn_subagent in one turn run in parallel), research that only needs a conclusion, work whose intermediate steps would fill the main context.",
      "task must be self-contained; put necessary background in context; put desired format in expected_output.",
      "After completion, integrate the returned conclusion into your reply to the user. Subagents may nest within the depth limit; do not nest for simple tasks.",
    ].join(" "),
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description:
            "[Required] Self-contained subtask: goal, scope, acceptance criteria. The subagent cannot see the parent chat — do not write dependencies like \"continue above\".",
        },
        context: {
          type: "string",
          description:
            "Optional background: paths, constraints, prior conclusions, file content summaries. The subagent has no memory — include anything it needs.",
        },
        expected_output: {
          type: "string",
          description:
            "Optional desired output format, e.g. JSON array, Markdown bullets, workspace artifact path list.",
        },
      },
    },
    builtin: true,
    agentId,
  };
}

/** All MCP-exposed tool names use a stable re_ prefix */
export function withRePrefix(name: string): string {
  return name.startsWith("re_") ? name : `re_${name}`;
}

/** 对外资源 URI：zakura://mcp/{slug}/{urlencoded localUri} */
export function qualifyResourceUri(instanceSlug: string, localUri: string): string {
  return `zakura://mcp/${encodeURIComponent(instanceSlug)}/${encodeURIComponent(localUri)}`;
}

export function parseQualifiedResourceUri(
  uri: string,
): { slug: string; localUri: string } | null {
  const m = /^zakura:\/\/mcp\/([^/]+)\/(.+)$/.exec(uri);
  if (!m?.[1] || !m[2]) return null;
  try {
    return {
      slug: decodeURIComponent(m[1]),
      localUri: decodeURIComponent(m[2]),
    };
  } catch {
    return null;
  }
}

export class McpGateway {
  private agentService: AgentService | null = null;
  private browserService: AgentBrowserService | null = null;
  private memoryStore: MemoryStore | null = null;
  private memoryProviders: MemoryProvidersService | null = null;
  private toolCallStore: ToolCallStore | null = null;
  private taskStore: ZakuraTaskStore | null = null;
  private workspaceFsProvider: import("./workspace-fs-provider.js").ServerWorkspaceFsProvider | null =
    null;
  private exposureService: import("./port-exposures.js").ExposureService | null = null;
  private fileShareService: import("./file-shares.js").FileShareService | null = null;
  private subagentRunner: CloudSubagentRunner | null = null;
  private skillsService: import("./skills/service.js").SkillsService | null = null;
  private connectionCatalog: import("./connection-catalog.js").ConnectionCatalogService | null =
    null;
  private integrationCatalog: import("./integration-catalog.js").IntegrationCatalogService | null =
    null;
  private runtimeNodes: import("./runtime-nodes.js").RuntimeNodeService | null = null;
  private instanceMigrations: import("./platform-assistant-tools.js").InstanceMigrationPort | null =
    null;
  /** 工具列表进程内短缓存：Redis 往返也要毫秒级，热路径优先本地命中 */
  private readonly toolsMemCache = new TtlCache<ResolvedTool[]>(30_000);

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

  setTaskStore(store: ZakuraTaskStore): void {
    this.taskStore = store;
  }

  setExposureService(service: import("./port-exposures.js").ExposureService): void {
    this.exposureService = service;
  }

  setFileShareService(service: import("./file-shares.js").FileShareService): void {
    this.fileShareService = service;
  }

  /** 云端子代理执行器（由 CloudAgentRuntime 注入；MCP 客户端可直接调用 re_spawn_subagent） */
  setSubagentRunner(runner: CloudSubagentRunner): void {
    this.subagentRunner = runner;
  }

  /** 技能服务：re_list_skills / re_read_skill / re_search_skills / re_install_skill 的执行方 */
  setSkillsService(service: import("./skills/service.js").SkillsService): void {
    this.skillsService = service;
  }

  /** 平台助手 tools 依赖（ConnectionCatalog / 凭据 / Runner / 可选实例迁移） */
  setPlatformAssistantDeps(deps: {
    connectionCatalog?: import("./connection-catalog.js").ConnectionCatalogService | null;
    integrations?: import("./integration-catalog.js").IntegrationCatalogService | null;
    runtimeNodes?: import("./runtime-nodes.js").RuntimeNodeService | null;
    instanceMigrations?: import("./platform-assistant-tools.js").InstanceMigrationPort | null;
  }): void {
    if ("connectionCatalog" in deps) this.connectionCatalog = deps.connectionCatalog ?? null;
    if ("integrations" in deps) this.integrationCatalog = deps.integrations ?? null;
    if ("runtimeNodes" in deps) this.runtimeNodes = deps.runtimeNodes ?? null;
    if ("instanceMigrations" in deps) this.instanceMigrations = deps.instanceMigrations ?? null;
  }

  /**
   * 解析 Agent 应暴露的 MCP 实例。
   * 热路径只返回已 running 的实例；stopped 的后台拉起，绝不阻塞首字。
   */
  private async resolveAgentMcpInstances(agent: Agent): Promise<InstanceRow[]> {
    if (!this.agentService) return [];
    const mcpMode = getAgentMcpMode(agent);
    const boundIds =
      mcpMode === "selected"
        ? new Set(await this.agentService.boundInstanceIds(agent.id))
        : null;

    const all = await this.db
      .select()
      .from(componentInstances)
      .where(eq(componentInstances.tenantId, agent.tenantId));

    const candidates = all.filter((instance) => {
      if (CAPABILITY_PROVIDER_IDS.has(instance.providerId)) return false;
      if (
        globalRegistry.has(instance.providerId) &&
        globalRegistry.get(instance.providerId).category === "connector"
      ) {
        return false;
      }
      if (boundIds && !boundIds.has(instance.id)) return false;
      return true;
    });

    const running = candidates.filter((i) => i.status === "running");
    const stopped = candidates.filter((i) => i.status !== "running");
    // ponytail: 不在 listTools 热路径 ensureStarted（可卡到 30s）；后台预热下一轮可用
    if (stopped.length) {
      void this.ensureInstancesRunning(agent.tenantId, stopped).catch((err) =>
        console.warn("[mcp] background auto-start:", err),
      );
    }
    return running;
  }

  /** 租户策略下的 MCP 实例列表（热路径不启动） */
  private async resolveTenantMcpInstances(
    tenantId: string,
    allowedInstanceIds: string[] | null,
  ): Promise<InstanceRow[]> {
    const all = await this.db
      .select()
      .from(componentInstances)
      .where(eq(componentInstances.tenantId, tenantId));

    const allow =
      allowedInstanceIds && allowedInstanceIds.length > 0
        ? new Set(allowedInstanceIds)
        : null;

    const candidates = all.filter((instance) => {
      if (CAPABILITY_PROVIDER_IDS.has(instance.providerId)) return false;
      if (
        globalRegistry.has(instance.providerId) &&
        globalRegistry.get(instance.providerId).category === "connector"
      ) {
        return false;
      }
      if (allow && !allow.has(instance.id)) return false;
      return true;
    });

    const running = candidates.filter((i) => i.status === "running");
    const stopped = candidates.filter((i) => i.status !== "running");
    if (stopped.length) {
      void this.ensureInstancesRunning(tenantId, stopped).catch((err) =>
        console.warn("[mcp] background auto-start:", err),
      );
    }
    return running;
  }

  private async ensureInstancesRunning(
    tenantId: string,
    candidates: InstanceRow[],
  ): Promise<InstanceRow[]> {
    const ready: InstanceRow[] = [];
    for (const instance of candidates) {
      if (instance.status === "running") {
        ready.push(instance);
        continue;
      }
      try {
        await this.orchestrator.ensureStarted(tenantId, instance.id);
        const fresh =
          (await this.db.query.componentInstances.findFirst({
            where: and(
              eq(componentInstances.id, instance.id),
              eq(componentInstances.tenantId, tenantId),
            ),
          })) ?? instance;
        if (fresh.status === "running") ready.push(fresh);
      } catch (err) {
        console.warn(
          `[mcp] auto-start ${instance.slug}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return ready;
  }

  private enrichResolvedTool(
    tool: ResolvedTool,
    instanceSlug?: string | null,
  ): ResolvedTool {
    const execution =
      tool.execution ??
      (DEFAULT_TASK_OPTIONAL_TOOLS.has(tool.localName)
        ? { taskSupport: "optional" as const }
        : undefined);
    const _meta =
      instanceSlug && tool._meta
        ? rewriteToolUiMeta(tool._meta, (uri) => qualifyResourceUri(instanceSlug, uri))
        : tool._meta;
    return { ...tool, execution, _meta };
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

    const memHit = this.toolsMemCache.get(agent.id);
    if (memHit) return memHit;

    const cacheKey = REDIS_KEYS.tools(agent.id);
    const cached = await redisGetJson<ResolvedTool[]>(cacheKey);
    if (cached) {
      this.toolsMemCache.set(agent.id, cached);
      return cached;
    }

    const tools = await this.listToolsForAgentUncached(agent);
    this.toolsMemCache.set(agent.id, tools);
    // 短 TTL：对齐 Memoh toolsCacheTTL，避免每轮 Run 重复枚举
    void redisSetJson(cacheKey, tools, REDIS_TTL.tools);
    return tools;
  }

  private async listToolsForAgentUncached(agent: Agent): Promise<ResolvedTool[]> {
    const platformDefaults = await getAgentWebDefaults(this.db);
    const effective = effectiveAgentWebDefaults(getAgentProviders(agent), platformDefaults);

    // ponytail: 热路径绝不 start 容器（ensureCapabilityInstance start:true 可卡 30s+）
    // web-search/web-fetch 仅注入已 running 的实例；未启动的由后台任务拉起
    if (effective.webSearchEnabled || effective.webFetchEnabled) {
      void (async () => {
        try {
          if (effective.webSearchEnabled) {
            await ensureCapabilityInstance(this.db, this.orchestrator, agent.tenantId, "web-search", {
              start: true,
            });
          }
          if (effective.webFetchEnabled) {
            await ensureCapabilityInstance(this.db, this.orchestrator, agent.tenantId, "web-fetch", {
              start: true,
            });
          }
        } catch (err) {
          console.warn(`[mcp] background capability start:`, err);
        }
      })();
    }

    let memoryKind: MemoryProviderKind | null = null;
    if (agent.enableMemory && this.memoryProviders) {
      try {
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

    const tools: ResolvedTool[] = listAgentNativeTools(agent, memoryKind).map((t) =>
      this.enrichResolvedTool({
        ...t,
        agentId: agent.id,
      }),
    );
    if (isPlatformAssistant(agent)) {
      for (const t of listPlatformAssistantTools()) {
        tools.push(
          this.enrichResolvedTool({
            ...t,
            agentId: agent.id,
          }),
        );
      }
    }
    if (this.subagentRunner) {
      tools.push(this.enrichResolvedTool(subagentToolDef(agent.id)));
    }
    const usedNames = new Set(tools.map((t) => t.qualifiedName));

    // 平台连接器直接注入 Agent 工具：不创建实例、不读取 MCP 绑定、不走 MCP 生命周期。
    if (this.integrationCatalog) {
      let directTargets: DirectConnectorTarget[] = [];
      try {
        directTargets = await this.integrationCatalog.listDirectConnectorTargets(agent.tenantId);
      } catch (err) {
        console.warn(
          "[connector] list direct tools:",
          err instanceof Error ? err.message : String(err),
        );
      }
      const connectorListed = await Promise.all(
        directTargets.map(async (target) => {
          if (!globalRegistry.has(target.providerId)) return [] as ResolvedTool[];
          const plugin = globalRegistry.get(target.providerId);
          const handle = directConnectorHandle(agent.tenantId, target);
          try {
            const listed = await plugin.listTools(handle);
            return listed.map((t) => {
              const name = withRePrefix(`${target.connectorRef}__${t.name}`);
              return this.enrichResolvedTool({
                qualifiedName: name,
                instanceId: null,
                providerId: DIRECT_CONNECTOR_PROVIDER_ID,
                localName: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
                title: t.title,
                outputSchema: t.outputSchema,
                annotations: t.annotations,
                securitySchemes: t.securitySchemes,
                _meta: {
                  ...(t._meta ?? {}),
                  connectorRef: target.connectorRef,
                  capabilityRef: target.capabilityRef,
                  providerId: target.providerId,
                  product: target.product,
                },
                execution: t.execution,
                agentScoped: true,
                agentId: agent.id,
              });
            });
          } catch (err) {
            console.warn(
              `[connector] listTools ${target.connectorRef}/${target.capabilityRef}:`,
              err instanceof Error ? err.message : String(err),
            );
            return [] as ResolvedTool[];
          }
        }),
      );
      for (const batch of connectorListed) {
        for (const t of batch) {
          if (usedNames.has(t.qualifiedName)) continue;
          usedNames.add(t.qualifiedName);
          tools.push(t);
        }
      }
    }

    // 能力实例（搜索/抓取）仅在 Agent 显式开启且 running 时注入
    const capabilityInstances = await this.db
      .select()
      .from(componentInstances)
      .where(
        and(
          eq(componentInstances.tenantId, agent.tenantId),
          eq(componentInstances.status, "running"),
          inArray(componentInstances.providerId, ["web-search", "web-fetch"]),
        ),
      );

    const instances = await this.resolveAgentMcpInstances(agent);
    const allInstances = [
      ...capabilityInstances.filter((instance) => {
        if (instance.providerId === "web-search" && !effective.webSearchEnabled) return false;
        if (instance.providerId === "web-fetch" && !effective.webFetchEnabled) return false;
        return true;
      }),
      ...instances,
    ];

    const listedBatches = await Promise.all(
      allInstances.map(async (instance) => {
        if (!globalRegistry.has(instance.providerId)) return [] as ResolvedTool[];
        const plugin = globalRegistry.get(instance.providerId);
        let handle: InstanceHandle;
        try {
          handle = await this.orchestrator.toHandle(agent.tenantId, instance.id);
        } catch {
          return [] as ResolvedTool[];
        }
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
            return [] as ResolvedTool[];
          }
          const listed = await plugin.listTools(handle);
          return listed.map((t) => {
            let name = withRePrefix(t.name);
            // 冲突名在合并阶段再 qualify
            return this.enrichResolvedTool(
              {
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
                execution: t.execution,
                agentId: agent.id,
              },
              instance.slug,
            );
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[mcp] agent listTools ${instance.slug}: ${msg.slice(0, 200)}`);
          return [] as ResolvedTool[];
        }
      }),
    );

    for (const batch of listedBatches) {
      for (const t of batch) {
        let name = t.qualifiedName;
        if (usedNames.has(name) && t.instanceId) {
          const slug =
            allInstances.find((i) => i.id === t.instanceId)?.slug ?? t.instanceId.slice(0, 8);
          name = withRePrefix(qualify(slug, t.localName));
        }
        if (usedNames.has(name)) continue;
        usedNames.add(name);
        tools.push(name === t.qualifiedName ? t : { ...t, qualifiedName: name });
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

    const instances = await this.resolveTenantMcpInstances(tenantId, allowedInstances);

    const tools: ResolvedTool[] = [];
    if (includeBuiltin) {
      tools.push(...this.builtinTools(tenantId).map((t) => this.enrichResolvedTool(t)));
    }

    for (const instance of instances) {
      if (!globalRegistry.has(instance.providerId)) continue;
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
            `[mcp] listTools ${instance.slug}: skipped (UNREACHABLE — 实际调用时会重试)`,
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
        tools.push(
          this.enrichResolvedTool(
            {
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
              execution: t.execution,
            },
            instance.slug,
          ),
        );
      }
    }

    return tools;
  }

  async callTool(
    tenantId: string,
    qualifiedName: string,
    args: Record<string, unknown>,
    opts?: { apiKeyId?: string; agentId?: string | null },
  ): Promise<McpToolResult | McpCreateTaskResult> {
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
    let result: McpToolResult | McpCreateTaskResult;
    try {
      result = await this.dispatchTool(tenantId, tool, args, opts);
    } catch (err) {
      result = textResult(err instanceof Error ? err.message : String(err), true);
    }

    if (isCreateTaskResult(result) && tool.instanceId && this.taskStore) {
      const instance = await this.db.query.componentInstances.findFirst({
        where: and(
          eq(componentInstances.id, tool.instanceId),
          eq(componentInstances.tenantId, tenantId),
        ),
      });
      if (instance) {
        const publicTask = this.taskStore.registerProxyTask({
          tenantId,
          instanceId: instance.id,
          providerId: instance.providerId,
          slug: instance.slug,
          upstream: result.task,
        });
        result = { ...result, task: publicTask };
      }
    }

    if (!isCreateTaskResult(result)) {
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
    }

    return result;
  }

  private async dispatchTool(
    tenantId: string,
    tool: ResolvedTool,
    args: Record<string, unknown>,
    opts?: { apiKeyId?: string; agentId?: string | null },
  ): Promise<McpToolResult | McpCreateTaskResult> {
    void opts;
    // 云端子代理：以隔离上下文 mini-loop 执行子任务（MCP 客户端可直接调用）
    if (tool.providerId === SUBAGENT_PROVIDER_ID && tool.agentId) {
      if (!this.subagentRunner) return textResult("子代理执行器未启用", true);
      const agent = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, tool.agentId), eq(agents.tenantId, tenantId)),
      });
      if (!agent) return textResult("Agent not found", true);
      const answer = await this.subagentRunner.run(tenantId, agent, args, {
        origin: { source: "mcp" },
      });
      return textResult(answer.text, false);
    }
    if (tool.providerId === DIRECT_CONNECTOR_PROVIDER_ID) {
      if (!this.integrationCatalog) return textResult("连接器目录未挂载", true);
      const meta = tool._meta ?? {};
      const connectorRef =
        typeof meta.connectorRef === "string" ? meta.connectorRef : undefined;
      const capabilityRef =
        typeof meta.capabilityRef === "string" ? meta.capabilityRef : undefined;
      if (!connectorRef || !capabilityRef) {
        return textResult("连接器工具缺少目标信息", true);
      }
      const target = (await this.integrationCatalog.listDirectConnectorTargets(tenantId)).find(
        (item) => item.connectorRef === connectorRef && item.capabilityRef === capabilityRef,
      );
      if (!target || !globalRegistry.has(target.providerId)) {
        return textResult("连接器未配置或授权已失效", true);
      }
      const handle = directConnectorHandle(tenantId, target);
      const plugin = globalRegistry.get(target.providerId);
      try {
        return await plugin.callTool(handle, tool.localName, args);
      } finally {
        const accessToken = String(handle.config.oauthAccessToken ?? "").trim();
        if (accessToken && target.authorization) {
          await this.integrationCatalog
            .saveConnectorAuthorization(tenantId, connectorRef, {
              accessToken,
              ...(typeof handle.config.oauthRefreshToken === "string"
                ? { refreshToken: handle.config.oauthRefreshToken }
                : {}),
              ...(typeof handle.config.oauthExpiresAt === "number"
                ? { expiresAt: handle.config.oauthExpiresAt }
                : {}),
            })
            .catch(() => undefined);
        }
      }
    }
    if (tool.agentScoped && tool.agentId && this.agentService) {
      const agent = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, tool.agentId), eq(agents.tenantId, tenantId)),
      });
      if (!agent) return textResult("Agent not found", true);
      if (isPlatformAssistantToolName(tool.localName)) {
        if (!isPlatformAssistant(agent)) {
          return textResult("Platform assistant tools are not enabled for this agent", true);
        }
        return callPlatformAssistantTool(tool.localName, args, {
          tenantId,
          agentId: agent.id,
          connectionCatalog: this.connectionCatalog,
          integrations: this.integrationCatalog,
          runtimeNodes: this.runtimeNodes,
          orchestrator: this.orchestrator,
          instanceMigrations: this.instanceMigrations,
        });
      }
      if (isSkillToolName(tool.localName)) {
        return callSkillTool(this.skillsService, agent, tool.localName, args);
      }
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
        this.fileShareService,
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
        const prefs = effectiveAgentWebDefaults(getAgentProviders(agentRow), await getAgentWebDefaults(this.db));
        if (tool.providerId === "web-search" && typeof args.engine !== "string" && prefs.searchEngine) {
          callArgs = { ...args, engine: prefs.searchEngine };
        }
        if (tool.providerId === "web-fetch" && typeof args.backend !== "string" && prefs.fetchBackend) {
          callArgs = { ...args, backend: prefs.fetchBackend };
        }
      }
    }

    return plugin.callTool(handle, tool.localName, callArgs) as Promise<
      McpToolResult | McpCreateTaskResult
    >;
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

  private async listActiveAgentSkills(agent: Agent) {
    if (!this.skillsService) return [];
    try {
      const list = await this.skillsService.listForAgent(agent.tenantId, agent.id);
      return list.filter((s) => s.enabled && s.status === "installed");
    } catch (err) {
      console.warn(
        `[mcp] agent skill resources ${agent.slug}:`,
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  private async readAgentSkillResource(
    agent: Agent,
    uri: string,
  ): Promise<McpReadResourceResult | null> {
    if (!this.skillsService) return null;
    const parsed = parseSkillResourceUri(uri);
    if (!parsed) return null;

    const active = await this.listActiveAgentSkills(agent);
    if (parsed.list) {
      return {
        contents: [
          {
            uri: SKILL_INDEX_RESOURCE_URI,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                schema: "SEP-2640",
                skills: active.map((s) => ({
                  type: "skill-md",
                  name: s.name,
                  title: s.title,
                  description: s.description,
                  uri: skillResourceUri(s.name),
                  mimeType: "text/markdown",
                  path: s.path,
                  builtin: s.builtin,
                  version: s.version,
                })),
                resourceTemplates: [SKILL_RESOURCE_TEMPLATE],
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const found = active.find((s) => s.name === parsed.name);
    if (!found) return null;
    const file = await this.skillsService.readSkillFile(
      agent.tenantId,
      agent,
      parsed.name,
      parsed.path,
    );
    if (!file) return null;
    return {
      contents: [
        {
          uri,
          mimeType: skillMime(parsed.path),
          text: file.content,
        },
      ],
    };
  }

  // ─── Resources ───────────────────────────────────────────────

  async listResourcesForAgent(agent: Agent): Promise<ResolvedResource[]> {
    if (!this.agentService) throw new Error("AgentService not bound");
    const resources: ResolvedResource[] = [];
    const usedUris = new Set<string>();

    for (const r of listAgentNativeResources(agent)) {
      usedUris.add(r.uri);
      resources.push({
        qualifiedUri: r.uri,
        instanceId: null,
        providerId: AGENT_NATIVE_PROVIDER_ID,
        localUri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
        title: r.title,
        _meta: r._meta,
        agentId: agent.id,
      });
    }

    if (this.skillsService && !usedUris.has(SKILL_INDEX_RESOURCE_URI)) {
      usedUris.add(SKILL_INDEX_RESOURCE_URI);
      resources.push({
        qualifiedUri: SKILL_INDEX_RESOURCE_URI,
        instanceId: null,
        providerId: AGENT_NATIVE_PROVIDER_ID,
        localUri: SKILL_INDEX_RESOURCE_URI,
        name: "agent-skills-index",
        title: "Agent skills index",
        description: "SEP-2640 skill discovery index for enabled installed skills",
        mimeType: "application/json",
        agentId: agent.id,
      });
    }

    if (isWorkspaceFsExposedViaMcp(agent) && this.workspaceFsProvider) {
      try {
        const fs = await this.workspaceFsProvider.forAgentBinding({
          id: agent.id,
          tenantId: agent.tenantId,
          runtimeNodeId: agent.runtimeNodeId,
        });
        for (const r of await listWorkspaceFsResources(fs)) {
          if (usedUris.has(r.uri)) continue;
          usedUris.add(r.uri);
          resources.push({
            qualifiedUri: r.uri,
            instanceId: null,
            providerId: AGENT_NATIVE_PROVIDER_ID,
            localUri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
            title: r.title,
            _meta: r._meta,
            agentId: agent.id,
          });
        }
      } catch (err) {
        console.warn(
          `[mcp] agent workspace fs resources ${agent.slug}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const instances = await this.resolveAgentMcpInstances(agent);

    for (const instance of instances) {
      if (!globalRegistry.has(instance.providerId)) continue;
      const plugin = globalRegistry.get(instance.providerId);
      if (typeof plugin.listResources !== "function") continue;

      let handle: InstanceHandle;
      try {
        handle = await this.orchestrator.toHandle(agent.tenantId, instance.id);
      } catch {
        continue;
      }

      try {
        if (
          handle.config.authRequired === true &&
          !(
            (typeof handle.config.oauthAccessToken === "string" &&
              handle.config.oauthAccessToken.trim()) ||
            (typeof handle.config.apiKey === "string" && handle.config.apiKey.trim())
          )
        ) {
          continue;
        }
        const listed = await plugin.listResources(handle);
        for (const r of listed) {
          const qualifiedUri = qualifyResourceUri(instance.slug, r.uri);
          if (usedUris.has(qualifiedUri)) continue;
          usedUris.add(qualifiedUri);
          resources.push({
            qualifiedUri,
            instanceId: instance.id,
            providerId: instance.providerId,
            localUri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
            title: r.title,
            _meta: r._meta,
            agentId: agent.id,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] agent listResources ${instance.slug}: ${msg.slice(0, 200)}`);
      }
    }

    return resources;
  }

  async listResourcesForTenant(
    tenantId: string,
    opts?: { apiKeyId?: string; agentId?: string | null },
  ): Promise<ResolvedResource[]> {
    if (opts?.agentId && this.agentService) {
      const agent = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, opts.agentId), eq(agents.tenantId, tenantId)),
      });
      if (!agent) return [];
      return this.listResourcesForAgent(agent);
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

    const instances = await this.resolveTenantMcpInstances(tenantId, allowedInstances);
    const resources: ResolvedResource[] = [];

    for (const instance of instances) {
      if (!globalRegistry.has(instance.providerId)) continue;
      const plugin = globalRegistry.get(instance.providerId);
      if (typeof plugin.listResources !== "function") continue;
      let handle: InstanceHandle;
      try {
        handle = await this.orchestrator.toHandle(tenantId, instance.id);
      } catch {
        continue;
      }
      try {
        const listed = await plugin.listResources(handle);
        for (const r of listed) {
          resources.push({
            qualifiedUri: qualifyResourceUri(instance.slug, r.uri),
            instanceId: instance.id,
            providerId: instance.providerId,
            localUri: r.uri,
            name: r.name,
            description: r.description
              ? `[${instance.name}] ${r.description}`
              : undefined,
            mimeType: r.mimeType,
            title: r.title,
            _meta: r._meta,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] listResources ${instance.slug}: ${msg.slice(0, 200)}`);
      }
    }

    return resources;
  }

  async readResource(
    tenantId: string,
    uri: string,
    opts?: { apiKeyId?: string; agentId?: string | null },
  ): Promise<McpReadResourceResult> {
    if (opts?.agentId && isWorkspaceFsResourceUri(uri) && this.workspaceFsProvider) {
      const agent = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, opts.agentId), eq(agents.tenantId, tenantId)),
      });
      if (agent && isWorkspaceFsExposedViaMcp(agent)) {
        const fs = await this.workspaceFsProvider.forAgentBinding({
          id: agent.id,
          tenantId: agent.tenantId,
          runtimeNodeId: agent.runtimeNodeId,
        });
        const native = await readWorkspaceFsResource(fs, uri);
        if (native) return native;
      }
    }

    if (opts?.agentId && parseSkillResourceUri(uri)) {
      const agent = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, opts.agentId), eq(agents.tenantId, tenantId)),
      });
      if (agent) {
        const skill = await this.readAgentSkillResource(agent, uri);
        if (skill) return skill;
      }
    }

    if (opts?.agentId && isAgentNativeResourceUri(uri) && !isWorkspaceFsResourceUri(uri)) {
      const agent = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, opts.agentId), eq(agents.tenantId, tenantId)),
      });
      if (agent) {
        const native = readAgentNativeResource(agent, uri);
        if (native) return native;
      }
    }

    const resources = await this.listResourcesForTenant(tenantId, opts);
    const match =
      resources.find((r) => r.qualifiedUri === uri) ??
      resources.find((r) => r.localUri === uri);

    if (!match) {
      throw Object.assign(new Error(`Resource not found: ${uri}`), {
        code: -32602,
        data: { uri },
      });
    }

    if (match.providerId === AGENT_NATIVE_PROVIDER_ID || !match.instanceId) {
      const agent = match.agentId
        ? await this.db.query.agents.findFirst({
            where: and(eq(agents.id, match.agentId), eq(agents.tenantId, tenantId)),
          })
        : null;
      if (!agent) {
        throw Object.assign(new Error(`Resource not found: ${uri}`), {
          code: -32602,
          data: { uri },
        });
      }
      if (isWorkspaceFsResourceUri(match.localUri)) {
        if (!isWorkspaceFsExposedViaMcp(agent) || !this.workspaceFsProvider) {
          throw Object.assign(new Error(`Resource not found: ${uri}`), {
            code: -32602,
            data: { uri },
          });
        }
        const fs = await this.workspaceFsProvider.forAgentBinding({
          id: agent.id,
          tenantId: agent.tenantId,
          runtimeNodeId: agent.runtimeNodeId,
        });
        const ws = await readWorkspaceFsResource(fs, match.localUri);
        if (!ws) {
          throw Object.assign(new Error(`Resource not found: ${uri}`), {
            code: -32602,
            data: { uri },
          });
        }
        return ws;
      }
      const skill = await this.readAgentSkillResource(agent, match.localUri);
      if (skill) return skill;
      const native = readAgentNativeResource(agent, match.localUri);
      if (!native) {
        throw Object.assign(new Error(`Resource not found: ${uri}`), {
          code: -32602,
          data: { uri },
        });
      }
      return native;
    }

    const handle = await this.orchestrator.toHandle(tenantId, match.instanceId);
    const plugin = globalRegistry.get(match.providerId);
    if (typeof plugin.readResource !== "function") {
      throw new Error(`Provider ${match.providerId} does not support resources/read`);
    }

    const result = await plugin.readResource(handle, match.localUri);
    return {
      ...result,
      contents: result.contents.map((c) => ({
        ...c,
        // 对外回写限定 URI，便于客户端对照 list
        uri: c.uri === match.localUri ? match.qualifiedUri : c.uri,
      })),
    };
  }

  // ─── Prompts ─────────────────────────────────────────────────

  async listPromptsForAgent(agent: Agent): Promise<ResolvedPrompt[]> {
    if (!this.agentService) throw new Error("AgentService not bound");
    const prompts: ResolvedPrompt[] = [];
    const usedNames = new Set<string>();

    for (const p of listAgentNativePrompts(agent)) {
      usedNames.add(p.name);
      prompts.push({
        qualifiedName: p.name,
        instanceId: null,
        providerId: AGENT_NATIVE_PROVIDER_ID,
        localName: p.name,
        description: p.description,
        title: p.title,
        arguments: p.arguments,
        _meta: p._meta,
        agentId: agent.id,
      });
    }

    const instances = await this.resolveAgentMcpInstances(agent);

    for (const instance of instances) {
      if (!globalRegistry.has(instance.providerId)) continue;
      const plugin = globalRegistry.get(instance.providerId);
      if (typeof plugin.listPrompts !== "function") continue;

      let handle: InstanceHandle;
      try {
        handle = await this.orchestrator.toHandle(agent.tenantId, instance.id);
      } catch {
        continue;
      }

      try {
        if (
          handle.config.authRequired === true &&
          !(
            (typeof handle.config.oauthAccessToken === "string" &&
              handle.config.oauthAccessToken.trim()) ||
            (typeof handle.config.apiKey === "string" && handle.config.apiKey.trim())
          )
        ) {
          continue;
        }
        const listed = await plugin.listPrompts(handle);
        for (const p of listed) {
          let name = withRePrefix(p.name);
          if (usedNames.has(name)) {
            name = withRePrefix(qualify(instance.slug, p.name));
          }
          if (usedNames.has(name)) continue;
          usedNames.add(name);
          prompts.push({
            qualifiedName: name,
            instanceId: instance.id,
            providerId: instance.providerId,
            localName: p.name,
            description: p.description,
            title: p.title,
            arguments: p.arguments,
            _meta: p._meta,
            agentId: agent.id,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] agent listPrompts ${instance.slug}: ${msg.slice(0, 200)}`);
      }
    }

    return prompts;
  }

  async listPromptsForTenant(
    tenantId: string,
    opts?: { apiKeyId?: string; agentId?: string | null },
  ): Promise<ResolvedPrompt[]> {
    if (opts?.agentId && this.agentService) {
      const agent = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, opts.agentId), eq(agents.tenantId, tenantId)),
      });
      if (!agent) return [];
      return this.listPromptsForAgent(agent);
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

    const instances = await this.resolveTenantMcpInstances(tenantId, allowedInstances);
    const prompts: ResolvedPrompt[] = [];

    for (const instance of instances) {
      if (!globalRegistry.has(instance.providerId)) continue;
      const plugin = globalRegistry.get(instance.providerId);
      if (typeof plugin.listPrompts !== "function") continue;
      let handle: InstanceHandle;
      try {
        handle = await this.orchestrator.toHandle(tenantId, instance.id);
      } catch {
        continue;
      }
      try {
        const listed = await plugin.listPrompts(handle);
        for (const p of listed) {
          prompts.push({
            qualifiedName: withRePrefix(qualify(instance.slug, p.name)),
            instanceId: instance.id,
            providerId: instance.providerId,
            localName: p.name,
            description: p.description
              ? `[${instance.name}] ${p.description}`
              : undefined,
            title: p.title,
            arguments: p.arguments,
            _meta: p._meta,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] listPrompts ${instance.slug}: ${msg.slice(0, 200)}`);
      }
    }

    return prompts;
  }

  async getPrompt(
    tenantId: string,
    name: string,
    args?: Record<string, string>,
    opts?: { apiKeyId?: string; agentId?: string | null },
  ): Promise<McpGetPromptResult> {
    if (opts?.agentId && isAgentNativePromptName(name)) {
      const agent = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, opts.agentId), eq(agents.tenantId, tenantId)),
      });
      if (agent) {
        const native = getAgentNativePrompt(agent, name, args);
        if (native) return native;
      }
    }

    const prompts = await this.listPromptsForTenant(tenantId, opts);
    const match =
      prompts.find((p) => p.qualifiedName === name) ??
      prompts.find((p) => p.localName === name) ??
      prompts.find((p) => withRePrefix(p.localName) === name);

    if (!match) {
      throw Object.assign(new Error(`Unknown prompt: ${name}`), {
        code: -32602,
        data: { name },
      });
    }

    if (match.providerId === AGENT_NATIVE_PROVIDER_ID || !match.instanceId) {
      const agent = match.agentId
        ? await this.db.query.agents.findFirst({
            where: and(eq(agents.id, match.agentId), eq(agents.tenantId, tenantId)),
          })
        : null;
      if (!agent) {
        throw Object.assign(new Error(`Unknown prompt: ${name}`), {
          code: -32602,
          data: { name },
        });
      }
      const native = getAgentNativePrompt(agent, match.localName, args);
      if (!native) {
        throw Object.assign(new Error(`Unknown prompt: ${name}`), {
          code: -32602,
          data: { name },
        });
      }
      return native;
    }

    const handle = await this.orchestrator.toHandle(tenantId, match.instanceId);
    const plugin = globalRegistry.get(match.providerId);
    if (typeof plugin.getPrompt !== "function") {
      throw new Error(`Provider ${match.providerId} does not support prompts/get`);
    }

    return plugin.getPrompt(handle, match.localName, args);
  }

  // ─── Resource templates ──────────────────────────────────────

  async listResourceTemplatesForAgent(agent: Agent): Promise<ResolvedResourceTemplate[]> {
    if (!this.agentService) throw new Error("AgentService not bound");
    const templates: ResolvedResourceTemplate[] = [];
    const used = new Set<string>();

    for (const t of listAgentNativeResourceTemplates(agent)) {
      used.add(t.uriTemplate);
      templates.push({
        qualifiedUriTemplate: t.uriTemplate,
        instanceId: null,
        providerId: AGENT_NATIVE_PROVIDER_ID,
        localUriTemplate: t.uriTemplate,
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
        title: t.title,
        _meta: t._meta,
        agentId: agent.id,
      });
    }

    if (this.skillsService && !used.has(SKILL_RESOURCE_TEMPLATE)) {
      used.add(SKILL_RESOURCE_TEMPLATE);
      templates.push({
        qualifiedUriTemplate: SKILL_RESOURCE_TEMPLATE,
        instanceId: null,
        providerId: AGENT_NATIVE_PROVIDER_ID,
        localUriTemplate: SKILL_RESOURCE_TEMPLATE,
        name: "agent-skill-file",
        title: "Agent skill files",
        description:
          `Read a file from an enabled installed skill. Use path=${SKILL_MANIFEST_FILE} for the manifest.`,
        mimeType: "text/plain",
        agentId: agent.id,
      });
    }

    const instances = await this.resolveAgentMcpInstances(agent);

    for (const instance of instances) {
      if (!globalRegistry.has(instance.providerId)) continue;
      const plugin = globalRegistry.get(instance.providerId);
      if (typeof plugin.listResourceTemplates !== "function") continue;

      let handle: InstanceHandle;
      try {
        handle = await this.orchestrator.toHandle(agent.tenantId, instance.id);
      } catch {
        continue;
      }

      try {
        if (
          handle.config.authRequired === true &&
          !(
            (typeof handle.config.oauthAccessToken === "string" &&
              handle.config.oauthAccessToken.trim()) ||
            (typeof handle.config.apiKey === "string" && handle.config.apiKey.trim())
          )
        ) {
          continue;
        }
        const listed = await plugin.listResourceTemplates(handle);
        for (const t of listed) {
          const qualifiedUriTemplate = qualifyResourceUri(instance.slug, t.uriTemplate);
          if (used.has(qualifiedUriTemplate)) continue;
          used.add(qualifiedUriTemplate);
          templates.push({
            qualifiedUriTemplate,
            instanceId: instance.id,
            providerId: instance.providerId,
            localUriTemplate: t.uriTemplate,
            name: t.name,
            description: t.description,
            mimeType: t.mimeType,
            title: t.title,
            _meta: t._meta,
            agentId: agent.id,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[mcp] agent listResourceTemplates ${instance.slug}: ${msg.slice(0, 200)}`,
        );
      }
    }

    return templates;
  }

  async listResourceTemplatesForTenant(
    tenantId: string,
    opts?: { apiKeyId?: string; agentId?: string | null },
  ): Promise<ResolvedResourceTemplate[]> {
    if (opts?.agentId && this.agentService) {
      const agent = await this.db.query.agents.findFirst({
        where: and(eq(agents.id, opts.agentId), eq(agents.tenantId, tenantId)),
      });
      if (!agent) return [];
      return this.listResourceTemplatesForAgent(agent);
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

    const instances = await this.resolveTenantMcpInstances(tenantId, allowedInstances);
    const templates: ResolvedResourceTemplate[] = [];

    for (const instance of instances) {
      if (!globalRegistry.has(instance.providerId)) continue;
      const plugin = globalRegistry.get(instance.providerId);
      if (typeof plugin.listResourceTemplates !== "function") continue;
      let handle: InstanceHandle;
      try {
        handle = await this.orchestrator.toHandle(tenantId, instance.id);
      } catch {
        continue;
      }
      try {
        const listed = await plugin.listResourceTemplates(handle);
        for (const t of listed) {
          templates.push({
            qualifiedUriTemplate: qualifyResourceUri(instance.slug, t.uriTemplate),
            instanceId: instance.id,
            providerId: instance.providerId,
            localUriTemplate: t.uriTemplate,
            name: t.name,
            description: t.description
              ? `[${instance.name}] ${t.description}`
              : undefined,
            mimeType: t.mimeType,
            title: t.title,
            _meta: t._meta,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[mcp] listResourceTemplates ${instance.slug}: ${msg.slice(0, 200)}`,
        );
      }
    }

    return templates;
  }

  // ─── Completions ─────────────────────────────────────────────

  async complete(
    tenantId: string,
    params: McpCompleteParams,
    opts?: { apiKeyId?: string; agentId?: string | null },
  ): Promise<McpCompleteResult> {
    const ref = params.ref;
    if (ref.type === "ref/prompt") {
      const prompts = await this.listPromptsForTenant(tenantId, opts);
      const match =
        prompts.find((p) => p.qualifiedName === ref.name) ??
        prompts.find((p) => p.localName === ref.name) ??
        prompts.find((p) => withRePrefix(p.localName) === ref.name);

      if (!match) {
        throw Object.assign(new Error(`Unknown prompt for complete: ${ref.name}`), {
          code: -32602,
          data: { name: ref.name },
        });
      }

      if (match.providerId === AGENT_NATIVE_PROVIDER_ID || !match.instanceId) {
        // 平台 prompts 暂无参数补全词表
        return { completion: { values: [], hasMore: false } };
      }

      const handle = await this.orchestrator.toHandle(tenantId, match.instanceId);
      const plugin = globalRegistry.get(match.providerId);
      if (typeof plugin.complete !== "function") {
        throw new Error(`Provider ${match.providerId} does not support completion/complete`);
      }

      return plugin.complete(handle, {
        ref: { type: "ref/prompt", name: match.localName },
        argument: params.argument,
      });
    }

    const templates = await this.listResourceTemplatesForTenant(tenantId, opts);
    const match =
      templates.find((t) => t.qualifiedUriTemplate === ref.uri) ??
      templates.find((t) => t.localUriTemplate === ref.uri);

    let instanceId: string | undefined;
    let providerId: string | undefined;
    let localUri: string | undefined;

    if (match) {
      if (match.providerId === AGENT_NATIVE_PROVIDER_ID || !match.instanceId) {
        return { completion: { values: [], hasMore: false } };
      }
      instanceId = match.instanceId;
      providerId = match.providerId;
      localUri = match.localUriTemplate;
    } else {
      const parsed = parseQualifiedResourceUri(ref.uri);
      if (parsed) {
        const instances = await this.db
          .select()
          .from(componentInstances)
          .where(
            and(
              eq(componentInstances.tenantId, tenantId),
              eq(componentInstances.slug, parsed.slug),
            ),
          );
        const instance = instances[0];
        if (instance) {
          try {
            await this.orchestrator.ensureStarted(tenantId, instance.id);
          } catch {
            /* fall through — toHandle may still work or complete fails cleanly */
          }
          instanceId = instance.id;
          providerId = instance.providerId;
          localUri = parsed.localUri;
        }
      }
    }

    if (!instanceId || !providerId || !localUri) {
      throw Object.assign(
        new Error(`Unknown resource template for complete: ${ref.uri}`),
        { code: -32602, data: { uri: ref.uri } },
      );
    }

    const handle = await this.orchestrator.toHandle(tenantId, instanceId);
    const plugin = globalRegistry.get(providerId);
    if (typeof plugin.complete !== "function") {
      throw new Error(`Provider ${providerId} does not support completion/complete`);
    }

    return plugin.complete(handle, {
      ref: { type: "ref/resource", uri: localUri },
      argument: params.argument,
    });
  }
}
