/** JSON Schema-like config descriptor for provider forms */
export type JsonSchemaType = "string" | "number" | "boolean" | "object" | "array";

export interface ConfigFieldSchema {
  type: JsonSchemaType;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: "password" | "url" | "text" | "textarea" | "json";
  required?: boolean;
  properties?: Record<string, ConfigFieldSchema>;
}

export interface ProviderConfigSchema {
  type: "object";
  title?: string;
  required?: string[];
  properties: Record<string, ConfigFieldSchema>;
}

export type InstanceStatus =
  | "pending"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export type ContainerPurpose = "component" | "workspace" | "ephemeral";

export type HealthStatus = "healthy" | "unhealthy" | "unknown";

export interface PortBinding {
  containerPort: number;
  hostPort?: number;
  /** Prefer 127.0.0.1 for CDP; omit for all interfaces */
  hostIp?: string;
  protocol?: "tcp" | "udp";
}

export interface VolumeBinding {
  hostPath?: string;
  volumeName?: string;
  containerPath: string;
  readOnly?: boolean;
}

/** Declarative container spec produced by a provider */
export interface ContainerSpec {
  name: string;
  image: string;
  purpose?: ContainerPurpose;
  env?: Record<string, string>;
  ports?: PortBinding[];
  volumes?: VolumeBinding[];
  command?: string[];
  /** Container working directory (defaults to image WORKDIR) */
  workingDir?: string;
  network?: string;
  labels?: Record<string, string>;
  /** Docker HostConfig.ShmSize in bytes (e.g. Crawl4AI needs ~1g) */
  shmSize?: number;
  healthcheck?: {
    test: string[];
    intervalMs?: number;
    timeoutMs?: number;
    retries?: number;
  };
  restartPolicy?: "no" | "always" | "unless-stopped" | "on-failure";
}

export interface RuntimeSpec {
  containers: ContainerSpec[];
  /** Primary HTTP endpoint template, e.g. http://{host}:{port} */
  endpointTemplate?: string;
  primaryContainer?: string;
}

export interface HealthResult {
  status: HealthStatus;
  message?: string;
  details?: Record<string, unknown>;
}

export type {
  McpToolAnnotations,
  McpSecurityScheme,
  McpToolDef,
  McpToolResult,
} from "./mcp-tool-descriptor.js";

export type {
  McpResourceDef,
  McpResourceTemplateDef,
  McpResourceContents,
  McpReadResourceResult,
  McpPromptArgumentDef,
  McpPromptDef,
  McpPromptMessageContent,
  McpPromptMessage,
  McpGetPromptResult,
  McpCompleteRef,
  McpCompleteArgument,
  McpCompleteParams,
  McpCompleteResult,
} from "./mcp-resource-prompt.js";
export {
  normalizeResourceDef,
  normalizeResourceTemplateDef,
  normalizePromptDef,
  normalizeReadResourceResult,
  normalizeGetPromptResult,
  normalizeCompleteResult,
} from "./mcp-resource-prompt.js";

export type ProviderCapability =
  | "mcp-proxy"
  | "tools"
  | "resources"
  | "prompts"
  | "completions"
  | "memory"
  | "search"
  | "fetch"
  | "context-fs"
  | "containers"
  | "builtin"
  | "agent"
  | "filesystem"
  | "shell"
  | "computer"
  | "browser";

/** Feature partitions shown in the console */
export type ProviderCategory =
  | "web-search"
  | "web-fetch"
  | "memory"
  | "context"
  | "mcp"
  | "runtime"
  | "agent";

export const PROVIDER_CATEGORY_META: Record<
  ProviderCategory,
  { name: string; description: string }
> = {
  "web-search": { name: "网页搜索", description: "接入各大搜索引擎 API，供 Agent 检索" },
  "web-fetch": { name: "网页抓取", description: "读取网页正文，供 web_fetch 工具使用" },
  memory: { name: "记忆", description: "多 Provider 长期记忆（Built-in / 传统 / mem0 / OpenViking）" },
  context: { name: "上下文", description: "OpenViking 等上下文文件系统客户端" },
  mcp: { name: "MCP", description: "上游 MCP（HTTP / Stdio 容器）导入、商店与 OAuth" },
  runtime: { name: "运行时", description: "容器与工作区" },
  agent: { name: "Agent", description: "隔离的多 Agent 配置与工具空间" },
};

/** Memory provider kinds managed on the global Memory page */
export const MEMORY_PROVIDER_KINDS = [
  "builtin",
  "traditional",
  "mem0",
  "openviking",
] as const;
export type MemoryProviderKind = (typeof MEMORY_PROVIDER_KINDS)[number];

export {
  MODEL_UPSTREAM_PROTOCOLS,
  OPENAI_COMPATIBLE_PROTOCOLS,
  MODEL_CAPABILITIES,
  MODEL_ROUTE_STRATEGIES,
  MODEL_CATALOG_SOURCES,
  MODEL_REASONING_EFFORTS,
  MODEL_UPSTREAM_PROTOCOL_META,
  MODEL_UPSTREAM_DEFAULT_BASE_URLS,
  BAILIAN_ENDPOINTS,
  MODEL_CAPABILITY_META,
  MODEL_UPSTREAM_FORM_FIELDS,
  applyUpstreamProtocolDefaults,
  type ModelUpstreamProtocol,
  type ModelCapability,
  type ModelRouteStrategy,
  type ModelCatalogSource,
  type ModelReasoningEffort,
  type ModelReasoningOptions,
  type ModelUpstreamConfig,
  type ModelUpstreamFormField,
  type ModelUpstreamRegion,
  type ModelUpstreamProtocolMeta,
  type ModelRouteOptions,
  type ModelToolDefinition,
  type ModelToolCall,
  type ModelToolChoice,
  type ModelChatMessage,
  type ModelChatContentPart,
  type ModelChatInvokeOptions,
  type OpenAIChatCompletion,
  type OpenAIChatCompletionChoice,
  type ModelChatResult,
  type ModelEmbeddingResult,
  type ModelRerankResult,
  type ModelRerankDocument,
  type ModelImageResult,
  type ModelCatalogEntry,
  type UpstreamModelRecord,
  type LogicalModelGroup,
  normalizeCanonicalModelId,
} from "./model-router.js";

export const MEMORY_PROVIDER_KIND_META: Record<
  MemoryProviderKind,
  { name: string; description: string; storesLocally: boolean }
> = {
  builtin: {
    name: "Built-in",
    description:
      "本地分层记忆 + 关键词/图谱；可选 OpenAI 兼容 embedding + pgvector 混合召回（PGlite/Postgres 均可）",
    storesLocally: true,
  },
  traditional: {
    name: "传统记忆",
    description: "纯文本笔记；调用 memory_context 时整包返回（无检索）",
    storesLocally: true,
  },
  mem0: {
    name: "mem0",
    description:
      "连接已部署的 mem0（Platform/OSS）。语义检索依赖 mem0 侧的 embedding + 向量库，Zakura 只做 HTTP 代理",
    storesLocally: false,
  },
  openviking: {
    name: "OpenViking",
    description: "连接 OpenViking 上下文文件系统（不在本地存记忆行）",
    storesLocally: false,
  },
};

/** 工作区容器等内置环境的运行状态（非 Agent 自身状态） */
export type WorkspaceEnvStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "exited"
  | "removed"
  | "error";

/** Optional agent capabilities — computer env bundles fs/shell/browser/desktop. */
export interface AgentCapabilities {
  /** 电脑环境（含文件系统、Shell、浏览器、桌面） */
  computer: boolean;
  filesystem?: boolean;
  shell?: boolean;
  browser?: boolean;
  memory?: boolean;
}

/** Default Docker image for any container-backed capability (prebaked xvfb+chromium). */
export const DEFAULT_WORKSPACE_IMAGE = "sunwuyuan/zakura-workspace-dev:debian";

/** Local / published workspace image (docker/workspace → Docker Hub *-dev). */
export const WORKSPACE_IMAGE_LOCAL = "sunwuyuan/zakura-workspace-dev:debian";

export const AGENT_WORKSPACE_ROOT = "/workspace";

/** Container ports for desktop / browser stack */
export const AGENT_PORT_NOVNC = 6080;
export const AGENT_PORT_CDP = 9222;
export const AGENT_PORT_VNC = 5900;

export const AGENT_DISPLAY = ":99";
export const AGENT_DESKTOP_WIDTH = 1280;
export const AGENT_DESKTOP_HEIGHT = 720;

export const SEARCH_ENGINE_IDS = [
  "yandex",
  "duckduckgo",
  "bocha",
  "exa",
  "jina",
  "searxng",
  "serper",
  "sogou",
  "tavily",
  "google",
  "bing",
  "brave",
] as const;
export type SearchEngineId = (typeof SEARCH_ENGINE_IDS)[number];

export const FETCH_BACKEND_IDS = [
  "native",
  "jina-reader",
  "cloudflare-markdown",
  "firecrawl",
  "crawl4ai",
] as const;
export type FetchBackendId = (typeof FETCH_BACKEND_IDS)[number];

/** Host-level shared services managed by Zakura (one instance per deployment). */
export const PLATFORM_SERVICE_KEYS = [
  "searxng",
  "jina-reader",
  "firecrawl",
  "crawl4ai",
] as const;
export type PlatformServiceKey = (typeof PLATFORM_SERVICE_KEYS)[number];

export const PLATFORM_SERVICE_MODES = ["disabled", "managed", "external"] as const;
export type PlatformServiceMode = (typeof PLATFORM_SERVICE_MODES)[number];

export const BUILTIN_PROVIDER_IDS = [
  "web-search",
  "web-fetch",
  "mem0",
  "openviking",
  "generic-mcp",
  "google-workspace",
] as const;
export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

export interface SetupPayload {
  adminEmail: string;
  adminPassword: string;
  adminName?: string;
  tenantName?: string;
}

/** Deployment edition — oss is single-account; saas adds multi-tenant + registration. */
export type ZakuraEdition = "oss" | "saas";

export interface PublicPlatformInfo {
  setupCompleted: boolean;
  version: string;
  mode: "single-tenant" | "multi-tenant";
  /** True when SaaS edition is active. */
  multiTenant?: boolean;
  /** oss | saas — source of truth for feature gating */
  edition?: ZakuraEdition;
  /** Public self-registration is available (SaaS only) */
  registrationEnabled?: boolean;
}

/** Persisted MCP tool-call audit row (truncated args/result) */
export interface ToolCallLogDto {
  id: string;
  tenantId: string;
  apiKeyId: string | null;
  agentId: string | null;
  qualifiedName: string;
  localName: string;
  providerId: string;
  instanceId: string | null;
  argsJson: string;
  resultJson: string;
  isError: boolean;
  durationMs: number;
  createdAt: string;
  agentName?: string | null;
  agentSlug?: string | null;
  apiKeyName?: string | null;
  apiKeyPrefix?: string | null;
}

export interface ToolCallStatsDto {
  total: number;
  errors: number;
  avgDurationMs: number;
  last24h: number;
  byAgent: Array<{ agentId: string | null; agentName: string | null; count: number }>;
  byApiKey: Array<{
    apiKeyId: string | null;
    apiKeyName: string | null;
    keyPrefix: string | null;
    count: number;
  }>;
  byTool: Array<{ qualifiedName: string; count: number; errors: number }>;
}

export {
  LOCAL_RUNTIME_NODE_ID,
  DEFAULT_MIGRATION_EXCLUDE_PATTERNS,
  buildRunnerComposeSnippet,
  buildRunnerInstallPackage,
} from "./runner.js";
export type {
  RuntimeNodeKind,
  RuntimeNodeStatus,
  WorkspaceStatus,
  MigrationJobStatus,
  RunnerNetworkInterface,
  RunnerTailscaleInfo,
  RunnerHostInfo,
  RuntimeNodeDto,
  MigrationManifestFile,
  MigrationManifest,
  WorkspaceMigrationDto,
  RunnerComposeOpts,
  RunnerInstallPackage,
} from "./runner.js";

export {
  TUNNEL_PROVIDER_IDS,
  TUNNEL_PROVIDER_META,
  DEFAULT_DENIED_PORTS,
} from "./network.js";
export type {
  TunnelProviderId,
  NetworkIntegrationKind,
  MeshProviderId,
  NetworkIntegrationStatus,
  PortExposureStatus,
  PortExposureProtocol,
  TailscaleHostInfo,
  NetworkSecurityPolicyDto,
  TunnelProviderSettingDto,
  PortExposureDto,
  NetworkOverviewDto,
  NetworkAuditLogDto,
} from "./network.js";

export { MCP_OAUTH_TIER_META } from "./mcp-oauth.js";
export type {
  McpOauthClientStrategy,
  McpOauthAuthTier,
  McpOauthContract,
} from "./mcp-oauth.js";

export {
  DEFAULT_AGENT_AUTO_INSTALL_MCPS,
  rankInstallPreview,
  pickPreferredInstallPreview,
} from "./mcp-config.js";
export type {
  McpAuthMode,
  McpPackageManager,
  McpInstallKind,
  McpEnvHint,
  McpToolPermissionRule,
  McpToolPermissionState,
  UnifiedMcpConfig,
  StoreInstallPreview,
  StoreServerLike,
} from "./mcp-config.js";

export {
  DEFAULT_MCP_OAUTH_SCHEMES,
  inferToolAnnotations,
  humanizeToolTitle,
  toPublicToolDescriptor,
  pickUpstreamToolFields,
  buildWwwAuthenticateChallenge,
  authRequiredToolResult,
  normalizeToolResult,
  isCreateTaskResult,
  rewriteToolUiMeta,
  DEFAULT_TASK_OPTIONAL_TOOLS,
} from "./mcp-tool-descriptor.js";
export type { McpCreateTaskResult } from "./mcp-tool-descriptor.js";
export type { PublicMcpToolDescriptor } from "./mcp-tool-descriptor.js";

export {
  AGENT_SKILLS_DIR,
  SKILL_MANIFEST_FILE,
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  SKILL_DISCOVERY_DIRS,
  SKILL_STORES,
  CURATED_SKILL_REPOS,
} from "./skills.js";
export type {
  SkillStoreId,
  SkillStoreMeta,
  CuratedSkillRepo,
  SkillSourceKind,
  SkillSource,
  SkillFrontmatter,
  SkillFile,
  SkillPackage,
  SkillRecord,
  AgentSkillStatus,
  AgentSkillRecord,
  SkillSearchItem,
  SkillSearchPage,
  SkillRepoSummary,
  SkillTokenScope,
  SkillTokenProvider,
  SkillTokenInfo,
  SkillCacheStatus,
  SkillResolveResult,
  SkillInstallRequest,
  SkillInstallResult,
} from "./skills.js";

export {
  CLOUD_AGENT_EVENT_TYPES,
  CLOUD_AGENT_SESSION_KINDS,
  parseCloudAgentConfig,
  parseCloudAgentSessionKind,
  parseCloudAgentSessionOrigin,
} from "./cloud-agent.js";
export type {
  CloudAgentEventType,
  CloudAgentRunStatus,
  CloudAgentSessionStatus,
  CloudAgentSessionKind,
  CloudAgentSessionOrigin,
  CloudAgentUserMessagePayload,
  CloudAgentRunStartPayload,
  CloudAgentReasoningDeltaPayload,
  CloudAgentAssistantDeltaPayload,
  CloudAgentAssistantMessagePayload,
  CloudAgentAssistantRollbackPayload,
  CloudAgentAttachment,
  CloudAgentToolCallStartPayload,
  CloudAgentToolCallArgsPayload,
  CloudAgentToolCallResultPayload,
  CloudAgentRunStatusPayload,
  CloudAgentRunEndPayload,
  CloudAgentRunErrorPayload,
  CloudAgentRunLogPayload,
  CloudAgentMemoryUpdatedPayload,
  CloudAgentContextSourceKind,
  CloudAgentContextSourceItem,
  CloudAgentContextSourcesPayload,
  CloudAgentSessionUpdatePayload,
  CloudAgentEventPayload,
  CloudAgentEvent,
  CloudAgentConfig,
  CloudAgentRunOptions,
} from "./cloud-agent.js";
