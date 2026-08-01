import { createId } from "@paralleldrive/cuid2";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vectorColumn } from "./vector.js";

/** Shared id helper — one place for all primary keys */
export function newId(): string {
  return createId();
}

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const platformMeta = pgTable("platform_meta", {
  id: text("id").primaryKey().default("platform"),
  setupCompleted: boolean("setup_completed").notNull().default(false),
  mode: text("mode").notNull().default("single-tenant"),
  version: text("version").notNull().default("0.1.0"),
  ...timestamps,
});

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey().$defaultFn(newId),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  /** Per-tenant first-run wizard (Agent / computer / memory / MCP). Independent of platform setup. */
  onboardingCompleted: boolean("onboarding_completed").notNull().default(false),
  /** JSON map of wizard steps, e.g. { agentCreated: true, mcpConnected: false } */
  onboardingSteps: text("onboarding_steps").notNull().default("{}"),
  ...timestamps,
});

/**
 * Global login identity. Access to tenants is via tenant_memberships.
 * Email is unique across the platform (one password, many tenants).
 * passwordHash may be null for OAuth-only accounts.
 */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash"),
    /** Platform super-admin (cross-tenant). Independent of tenant membership role. */
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    /**
     * SaaS：是否允许使用本机（Server 内嵌）Local Runner。
     * 自托管单租户下服务端始终放行，不依赖此字段。
     * 平台管理员默认视为已授权。
     */
    canUseLocalRunner: boolean("can_use_local_runner").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email").on(t.email)],
);

/**
 * External IdP identities linked to a global user (SaaS login OAuth, e.g. ZeroCat).
 */
export const oauthIdentities = pgTable(
  "oauth_identities",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    /** Provider id, e.g. "zerocat" */
    provider: text("provider").notNull(),
    /** Stable subject from IdP (openid / sub) */
    providerUserId: text("provider_user_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Last known profile JSON from userinfo */
    profileJson: text("profile_json"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("oauth_identities_provider_user").on(t.provider, t.providerUserId),
    index("oauth_identities_user").on(t.userId),
  ],
);

/** Short-lived PKCE state for browser login OAuth (SaaS). */
export const oauthLoginStates = pgTable(
  "oauth_login_states",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("oauth_login_states_expires").on(t.expiresAt)],
);

/** Membership of a global user in a tenant */
export const tenantMemberships = pgTable(
  "tenant_memberships",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** owner | admin | member */
    role: text("role").notNull().default("member"),
    /** active | suspended */
    status: text("status").notNull().default("active"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tenant_memberships_unique").on(t.tenantId, t.userId),
    index("tenant_memberships_user").on(t.userId),
    index("tenant_memberships_tenant").on(t.tenantId),
  ],
);

/** Email invite to join a tenant */
export const tenantInvites = pgTable(
  "tenant_invites",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** admin | member */
    role: text("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenant_invites_token").on(t.tokenHash),
    index("tenant_invites_tenant_email").on(t.tenantId, t.email),
  ],
);

/**
 * Tenant-scoped memory provider instances.
 * Global settings page manages these; each Agent picks one via memoryProviderId.
 * kind: builtin | traditional | mem0 | openviking
 */
export const memoryProviders = pgTable(
  "memory_providers",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind").notNull(),
    configJson: text("config_json").notNull().default("{}"),
    isDefault: boolean("is_default").notNull().default(false),
    status: text("status").notNull().default("ready"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("memory_providers_tenant_slug").on(t.tenantId, t.slug),
    index("memory_providers_tenant").on(t.tenantId),
  ],
);

/**
 * 模型上游连接（API 端点 + 协议）。
 * 一个上游可承载多种能力的路由。
 */
export const modelUpstreams = pgTable(
  "model_upstreams",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    protocol: text("protocol").notNull(),
    configJson: text("config_json").notNull().default("{}"),
    status: text("status").notNull().default("ready"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("model_upstreams_tenant_slug").on(t.tenantId, t.slug),
    index("model_upstreams_tenant").on(t.tenantId),
  ],
);

/**
 * 模型路由：将能力类型 + 别名映射到上游 + 模型名。
 * 同 alias 多供应商按 weight 加权随机；priority 用于跨 alias / fallback 顺序。
 */
export const modelRoutes = pgTable(
  "model_routes",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    capability: text("capability").notNull(),
    /** 逻辑模型别名；同 alias 可挂多个上游 */
    alias: text("alias"),
    upstreamId: text("upstream_id")
      .notNull()
      .references(() => modelUpstreams.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    optionsJson: text("options_json").notNull().default("{}"),
    priority: text("priority").notNull().default("100"),
    /** 同 alias 内加权随机权重，越大越容易被选中 */
    weight: text("weight").notNull().default("100"),
    isDefault: boolean("is_default").notNull().default(false),
    status: text("status").notNull().default("ready"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("model_routes_tenant_slug").on(t.tenantId, t.slug),
    index("model_routes_tenant").on(t.tenantId),
    index("model_routes_capability").on(t.tenantId, t.capability),
    index("model_routes_alias").on(t.tenantId, t.capability, t.alias),
    index("model_routes_upstream").on(t.upstreamId),
  ],
);

/**
 * 上游模型库存：每个上游同步/手填的模型单独一行。
 * nativeModel = 上游原始调用名；canonicalModel = 系统规范名（聚合调度键）。
 */
export const upstreamModels = pgTable(
  "upstream_models",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    upstreamId: text("upstream_id")
      .notNull()
      .references(() => modelUpstreams.id, { onDelete: "cascade" }),
    /** 上游原始模型名，实际 HTTP 调用时使用 */
    nativeModel: text("native_model").notNull(),
    /** 系统规范名（如 deepseek-v4-flash），同名多上游聚合 */
    canonicalModel: text("canonical_model").notNull(),
    displayName: text("display_name"),
    capability: text("capability").notNull(),
    weight: text("weight").notNull().default("100"),
    enabled: boolean("enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    optionsJson: text("options_json").notNull().default("{}"),
    metaJson: text("meta_json").notNull().default("{}"),
    status: text("status").notNull().default("ready"),
    lastError: text("last_error"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("upstream_models_unique").on(
      t.tenantId,
      t.upstreamId,
      t.nativeModel,
      t.capability,
    ),
    index("upstream_models_tenant").on(t.tenantId),
    index("upstream_models_canonical").on(
      t.tenantId,
      t.capability,
      t.canonicalModel,
    ),
    index("upstream_models_upstream").on(t.upstreamId),
  ],
);

/**
 * 从 models.dev / llm-metadata 导入的模型目录缓存（租户级）。
 */
export const modelCatalogEntries = pgTable(
  "model_catalog_entries",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    providerId: text("provider_id").notNull(),
    providerName: text("provider_name").notNull(),
    modelId: text("model_id").notNull(),
    name: text("name").notNull(),
    metaJson: text("meta_json").notNull().default("{}"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("model_catalog_unique").on(
      t.tenantId,
      t.source,
      t.providerId,
      t.modelId,
    ),
    index("model_catalog_tenant").on(t.tenantId),
    index("model_catalog_provider").on(t.tenantId, t.providerId),
  ],
);

/**
 * Runtime nodes (local implicit Runner + remote Runner Agents).
 * Declared before agents so FK columns can reference it.
 */
export const runtimeNodes = pgTable(
  "runtime_nodes",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** local | runner */
    kind: text("kind").notNull().default("runner"),
    /** online | offline | draining */
    status: text("status").notNull().default("offline"),
    endpoint: text("endpoint"),
    capabilitiesJson: text("capabilities_json").notNull().default("{}"),
    hostInfoJson: text("host_info_json").notNull().default("{}"),
    storageRoot: text("storage_root").notNull(),
    agentVersion: text("agent_version"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /** sha256 of rnr_* token; null for local */
    tokenHash: text("token_hash"),
    labelsJson: text("labels_json").notNull().default("{}"),
    /**
     * 平台共享 Runner：标记后可被任意租户绑定使用。
     * 仅允许管理员创建的远程 runner；使用方受共享策略严格限制。
     */
    isShared: boolean("is_shared").notNull().default(false),
    /** 创建者；共享 runner 必须由平台管理员创建/持有 */
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("runtime_nodes_tenant_slug").on(t.tenantId, t.slug),
    index("runtime_nodes_tenant").on(t.tenantId),
    index("runtime_nodes_shared").on(t.isShared),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    /** unused column; prefer workspaceStatus */
    status: text("status").notNull().default("ready"),
    /** files | computer — mirrored from enableComputer */
    workspaceProfile: text("workspace_profile").notNull().default("files"),
    /** 与 enableComputer 同步；内部闸门用 */
    enableFs: boolean("enable_fs").notNull().default(false),
    enableShell: boolean("enable_shell").notNull().default(false),
    enableComputer: boolean("enable_computer").notNull().default(false),
    enableBrowser: boolean("enable_browser").notNull().default(false),
    /** Per-agent long-term memory (data scoped to this agent); opt-in */
    enableMemory: boolean("enable_memory").notNull().default(false),
    /** Which memory provider this agent uses (null = tenant default) */
    memoryProviderId: text("memory_provider_id").references(() => memoryProviders.id, {
      onDelete: "set null",
    }),
    workspaceImage: text("workspace_image"),
    /** Bound Runner node; null = implicit local */
    runtimeNodeId: text("runtime_node_id").references(() => runtimeNodes.id, {
      onDelete: "set null",
    }),
    /** ready | locked | migrating */
    workspaceStatus: text("workspace_status").notNull().default("ready"),
    workspaceRevision: text("workspace_revision"),
    lastMigrationId: text("last_migration_id"),
    /** JSON bag for future agent extensions (skills, model prefs, etc.) */
    configJson: text("config_json").notNull().default("{}"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("agents_tenant_slug").on(t.tenantId, t.slug),
    index("agents_tenant").on(t.tenantId),
  ],
);

export const workspaceMigrations = pgTable(
  "workspace_migrations",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sourceNodeId: text("source_node_id")
      .notNull()
      .references(() => runtimeNodes.id),
    targetNodeId: text("target_node_id")
      .notNull()
      .references(() => runtimeNodes.id),
    /** pending | exporting | transferring | importing | verifying | completed | failed | cancelled */
    status: text("status").notNull().default("pending"),
    phase: text("phase"),
    progressPct: integer("progress_pct").notNull().default(0),
    message: text("message"),
    manifestJson: text("manifest_json"),
    archivePath: text("archive_path"),
    archiveSize: text("archive_size"),
    archiveSha256: text("archive_sha256"),
    excludePatternsJson: text("exclude_patterns_json").notNull().default("[]"),
    sourceRetained: boolean("source_retained").notNull().default(false),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("workspace_migrations_agent").on(t.agentId),
    index("workspace_migrations_status").on(t.status),
  ],
);

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey().$defaultFn(newId),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** When set, MCP is scoped to this agent's tools + bindings */
  agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  scopes: text("scopes").notNull().default('["*"]'),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const providerCatalog = pgTable("provider_catalog", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  version: text("version").notNull().default("1.0.0"),
  category: text("category").notNull().default("mcp"),
  capabilities: text("capabilities").notNull().default("[]"),
  configSchema: text("config_schema").notNull().default("{}"),
  ...timestamps,
});

export const componentInstances = pgTable(
  "component_instances",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => providerCatalog.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status").notNull().default("stopped"),
    configEnc: text("config_enc").notNull(),
    endpointUrl: text("endpoint_url"),
    healthStatus: text("health_status").notNull().default("unknown"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("instances_tenant_slug").on(t.tenantId, t.slug),
    index("instances_tenant_provider").on(t.tenantId, t.providerId),
  ],
);

export const managedContainers = pgTable(
  "managed_containers",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").references(() => componentInstances.id, {
      onDelete: "set null",
    }),
    /** Agent workspace containers (purpose=workspace) */
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    dockerId: text("docker_id"),
    name: text("name").notNull(),
    image: text("image").notNull(),
    purpose: text("purpose").notNull().default("component"),
    status: text("status").notNull().default("created"),
    labelsJson: text("labels_json").notNull().default("{}"),
    portsJson: text("ports_json").notNull().default("[]"),
    envEnc: text("env_enc"),
    allocatedTo: text("allocated_to"),
    runtimeNodeId: text("runtime_node_id").references(() => runtimeNodes.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    index("containers_tenant_purpose").on(t.tenantId, t.purpose),
    index("containers_docker_id").on(t.dockerId),
    index("containers_agent").on(t.agentId),
  ],
);

/** Bind shared component instances (search/memory/MCP) into an agent tool space */
export const agentBindings = pgTable(
  "agent_bindings",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    instanceId: text("instance_id")
      .notNull()
      .references(() => componentInstances.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_bindings_unique").on(t.agentId, t.instanceId),
    index("agent_bindings_agent").on(t.agentId),
    index("agent_bindings_tenant").on(t.tenantId),
  ],
);

export const settings = pgTable(
  "settings",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    ownerKey: text("owner_key").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => [uniqueIndex("settings_owner_key").on(t.ownerKey, t.key)],
);

/**
 * Host-level shared services (SearXNG / Jina Reader / Firecrawl / Crawl4AI).
 * One row per service_key for the whole deployment — not per-tenant.
 */
export const platformServices = pgTable(
  "platform_services",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    serviceKey: text("service_key").notNull(),
    /** disabled | managed | external */
    mode: text("mode").notNull().default("disabled"),
    /** running | stopped — admin intent when mode=managed */
    desiredState: text("desired_state").notNull().default("stopped"),
    /** stopped | starting | running | stopping | error */
    status: text("status").notNull().default("stopped"),
    healthStatus: text("health_status").notNull().default("unknown"),
    configEnc: text("config_enc").notNull().default("{}"),
    endpointUrl: text("endpoint_url"),
    /** JSON: [{ name, dockerId, role }] */
    containersJson: text("containers_json").notNull().default("[]"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("platform_services_key").on(t.serviceKey)],
);

/**
 * SaaS quotas for platform-managed services.
 * tenantId null / "__platform__" = platform default (use scopeKey).
 */
export const platformServiceQuotas = pgTable(
  "platform_service_quotas",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    /**
     * Tenant id, or "__platform__" for site-wide defaults.
     * Null is avoided so unique index works on all engines.
     */
    scopeKey: text("scope_key").notNull(),
    /** Service key or "*" for all managed services */
    serviceKey: text("service_key").notNull(),
    monthlyLimit: integer("monthly_limit"),
    dailyLimit: integer("daily_limit"),
    ...timestamps,
  },
  (t) => [uniqueIndex("platform_service_quotas_scope").on(t.scopeKey, t.serviceKey)],
);

/** Request counters for managed platform services (SaaS metering). */
export const platformServiceUsage = pgTable(
  "platform_service_usage",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Optional user attribution; empty string when unknown (unique key friendly). */
    userId: text("user_id").notNull().default(""),
    serviceKey: text("service_key").notNull(),
    /** YYYY-MM or YYYY-MM-DD */
    period: text("period").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("platform_service_usage_unique").on(
      t.tenantId,
      t.userId,
      t.serviceKey,
      t.period,
    ),
    index("platform_service_usage_tenant_period").on(t.tenantId, t.period),
  ],
);

export const mcpPolicies = pgTable("mcp_policies", {
  id: text("id").primaryKey().$defaultFn(newId),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "cascade" }),
  instanceIds: text("instance_ids").notNull().default("[]"),
  toolAllowlist: text("tool_allowlist"),
  toolDenylist: text("tool_denylist"),
  includeBuiltin: boolean("include_builtin").notNull().default(true),
  ...timestamps,
});

/**
 * Agent-scoped long-term memory (layers / traditional notes).
 * Rows are isolated by agentId; providerId links to the memory provider that wrote them.
 */
export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").references(() => componentInstances.id, {
      onDelete: "cascade",
    }),
    providerId: text("provider_id").references(() => memoryProviders.id, {
      onDelete: "set null",
    }),
    /** Owning agent — required for isolation */
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    /** identity | preference | project | fact | episode | note (traditional) */
    layer: text("layer").notNull().default("fact"),
    content: text("content").notNull(),
    tagsJson: text("tags_json").notNull().default("[]"),
    pinned: boolean("pinned").notNull().default(false),
    importance: text("importance").notNull().default("3"),
    /** tool | manual | import | system */
    source: text("source").notNull().default("manual"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    /** pgvector embedding (PGlite / Postgres); optional semantic seed for builtin hybrid */
    embedding: vectorColumn("embedding"),
    embeddingModel: text("embedding_model"),
    embeddingDim: integer("embedding_dim"),
    /** sha256 of content used to skip re-embed when unchanged */
    contentHash: text("content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("memories_tenant_user").on(t.tenantId, t.userId),
    index("memories_tenant_agent").on(t.tenantId, t.agentId),
    index("memories_agent_layer").on(t.agentId, t.layer),
    index("memories_instance").on(t.instanceId),
    index("memories_provider").on(t.providerId),
  ],
);

/** Memory graph edges (builtin provider) */
export const memoryEdges = pgTable(
  "memory_edges",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    fromMemoryId: text("from_memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    toMemoryId: text("to_memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    relation: text("relation").notNull().default("related"),
    weight: text("weight").notNull().default("1"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("memory_edges_agent").on(t.agentId),
    index("memory_edges_from").on(t.fromMemoryId),
    index("memory_edges_to").on(t.toMemoryId),
    uniqueIndex("memory_edges_pair_rel").on(t.fromMemoryId, t.toMemoryId, t.relation),
  ],
);

/**
 * MCP tool-call audit log — every tools/call via the gateway.
 * Scoped by tenant; filterable by agent and API key.
 */
export const toolCallLogs = pgTable(
  "tool_call_logs",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** Fully qualified MCP tool name, e.g. agent__fs_read */
    qualifiedName: text("qualified_name").notNull(),
    localName: text("local_name").notNull(),
    providerId: text("provider_id").notNull().default(""),
    instanceId: text("instance_id"),
    /** Truncated JSON of call arguments */
    argsJson: text("args_json").notNull().default("{}"),
    /** Truncated JSON / text of tool result */
    resultJson: text("result_json").notNull().default(""),
    isError: boolean("is_error").notNull().default(false),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tool_calls_tenant_created").on(t.tenantId, t.createdAt),
    index("tool_calls_agent_created").on(t.agentId, t.createdAt),
    index("tool_calls_api_key_created").on(t.apiKeyId, t.createdAt),
    index("tool_calls_qualified").on(t.tenantId, t.qualifiedName),
  ],
);

/** OAuth 2.1 clients — includes RFC 7591 dynamic registration (VS Code etc.) */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    clientId: text("client_id").notNull().unique(),
    /** Null for public clients (token_endpoint_auth_method=none) */
    clientSecretHash: text("client_secret_hash"),
    clientName: text("client_name").notNull().default(""),
    redirectUrisJson: text("redirect_uris_json").notNull().default("[]"),
    grantTypesJson: text("grant_types_json").notNull().default('["authorization_code","refresh_token"]'),
    responseTypesJson: text("response_types_json").notNull().default('["code"]'),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
    scope: text("scope").notNull().default("mcp"),
    /** manual | dynamic | cimd */
    registrationType: text("registration_type").notNull().default("dynamic"),
    /** Optional tenant binding for manually created / DCR clients；CIMD 保持 null（跨租户共享） */
    tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("oauth_clients_tenant").on(t.tenantId)],
);

export const oauthAuthCodes = pgTable(
  "oauth_auth_codes",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    codeHash: text("code_hash").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
    scope: text("scope").notNull().default("mcp"),
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("oauth_codes_client").on(t.clientId)],
);

/** Refresh tokens (access tokens are signed JWTs, not stored) */
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tokenHash: text("token_hash").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("mcp"),
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("oauth_refresh_client").on(t.clientId),
    index("oauth_refresh_user").on(t.userId),
  ],
);

/**
 * Network integrations (Tailscale OAuth / auth keys, named tunnel credentials, etc.)
 */
export const networkIntegrations = pgTable(
  "network_integrations",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** tailscale-oauth | tailscale-authkey | cloudflare-named | ngrok | frp */
    kind: text("kind").notNull(),
    /** disconnected | connected | error */
    status: text("status").notNull().default("disconnected"),
    displayName: text("display_name"),
    credentialsEnc: text("credentials_enc").notNull().default("{}"),
    metaJson: text("meta_json").notNull().default("{}"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("network_integrations_tenant_kind").on(t.tenantId, t.kind),
    index("network_integrations_tenant").on(t.tenantId),
  ],
);

/**
 * Per-tenant tunnel provider enablement / default / config.
 * Seed: cloudflare-quick enabled + is_default.
 */
export const tunnelProviderSettings = pgTable(
  "tunnel_provider_settings",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** cloudflare-quick | cloudflare-named | tailscale-serve | ngrok | frp */
    provider: text("provider").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    configEnc: text("config_enc").notNull().default("{}"),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTestOk: boolean("last_test_ok"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tunnel_provider_settings_tenant_provider").on(t.tenantId, t.provider),
    index("tunnel_provider_settings_tenant").on(t.tenantId),
  ],
);

/**
 * Tenant (or platform) security policy for mesh + port exposure.
 */
export const networkSecurityPolicies = pgTable(
  "network_security_policies",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** platform | tenant */
    scope: text("scope").notNull().default("tenant"),
    enabled: boolean("enabled").notNull().default(true),
    exposureEnabled: boolean("exposure_enabled").notNull().default(true),
    defaultTtlMinutes: integer("default_ttl_minutes").notNull().default(60),
    maxTtlMinutes: integer("max_ttl_minutes").notNull().default(1440),
    maxActivePerAgent: integer("max_active_per_agent").notNull().default(3),
    maxActivePerTenant: integer("max_active_per_tenant").notNull().default(50),
    deniedPortsJson: text("denied_ports_json")
      .notNull()
      .default("[22,2375,2376,5432,6379,27017,5900,6080,9222,8787,7443]"),
    allowDesktopExposure: boolean("allow_desktop_exposure").notNull().default(false),
    allowPublicExposure: boolean("allow_public_exposure").notNull().default(true),
    allowTcpExposure: boolean("allow_tcp_exposure").notNull().default(false),
    agentsCanExpose: boolean("agents_can_expose").notNull().default(true),
    requireUserApproval: boolean("require_user_approval").notNull().default(false),
    requireTailscaleForRemoteRunners: boolean("require_tailscale_for_remote_runners")
      .notNull()
      .default(false),
    auditRetentionDays: integer("audit_retention_days").notNull().default(90),
    updatedBy: text("updated_by"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("network_security_policies_tenant_scope").on(t.tenantId, t.scope),
    index("network_security_policies_tenant").on(t.tenantId),
  ],
);

/**
 * Temporary public download links for workspace files (agent → user share).
 * Raw token is only returned once; DB stores sha256 hash.
 */
export const fileShares = pgTable(
  "file_shares",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** sha256 hex of the raw share token */
    tokenHash: text("token_hash").notNull(),
    /** Workspace-relative path, e.g. /uploads/report.pdf */
    path: text("path").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    /** active | revoked | expired */
    status: text("status").notNull().default("active"),
    ttlMinutes: integer("ttl_minutes").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    downloadCount: integer("download_count").notNull().default(0),
    /** inline | attachment */
    disposition: text("disposition").notNull().default("attachment"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("file_shares_token").on(t.tokenHash),
    index("file_shares_agent").on(t.agentId, t.status),
    index("file_shares_tenant").on(t.tenantId),
    index("file_shares_expires").on(t.expiresAt),
  ],
);

/**
 * Active / historical port exposures (workspace port → public or tailnet URL).
 */
export const portExposures = pgTable(
  "port_exposures",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runtimeNodeId: text("runtime_node_id").references(() => runtimeNodes.id, {
      onDelete: "set null",
    }),
    name: text("name"),
    port: integer("port").notNull(),
    /** http | https | tcp */
    protocol: text("protocol").notNull().default("http"),
    provider: text("provider").notNull(),
    /** starting | active | error | stopped | expired */
    status: text("status").notNull().default("starting"),
    publicUrl: text("public_url"),
    relayHost: text("relay_host"),
    relayPort: integer("relay_port"),
    integrationId: text("integration_id").references(() => networkIntegrations.id, {
      onDelete: "set null",
    }),
    ttlMinutes: integer("ttl_minutes"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** user | agent | system */
    createdByType: text("created_by_type"),
    createdById: text("created_by_id"),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("port_exposures_tenant").on(t.tenantId),
    index("port_exposures_agent").on(t.agentId),
    index("port_exposures_status").on(t.tenantId, t.status),
    index("port_exposures_expires").on(t.expiresAt),
  ],
);

export const networkAuditLogs = pgTable(
  "network_audit_logs",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** user | agent | system */
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    detailJson: text("detail_json").notNull().default("{}"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("network_audit_tenant_time").on(t.tenantId, t.createdAt)],
);

/**
 * Cloud Agent 持久会话：状态与连接解耦，多设备共享同一事件流。
 * 每个 Agent 的会话相互隔离。
 */
export const cloudAgentSessions = pgTable(
  "cloud_agent_sessions",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("新对话"),
    /** active | archived */
    status: text("status").notNull().default("active"),
    /** 会话类型标记，见 CloudAgentSessionKind：chat | subagent | delegate | system */
    kind: text("kind").notNull().default("chat"),
    /** 来源链接（CloudAgentSessionOrigin）：父会话/父 Run/调用方 Agent */
    originJson: text("origin_json").notNull().default("{}"),
    /** 输入框与模型选择等客户端会话状态；null 表示沿用 Agent 默认值 */
    model: text("model"),
    modelRouteId: text("model_route_id"),
    reasoning: text("reasoning"),
    draftText: text("draft_text").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** 单调递增事件序号 */
    lastSeq: integer("last_seq").notNull().default(0),
    activeRunId: text("active_run_id"),
    ...timestamps,
  },
  (t) => [
    index("cloud_agent_sessions_agent").on(t.agentId, t.updatedAt),
    index("cloud_agent_sessions_agent_kind").on(t.agentId, t.kind, t.updatedAt),
    index("cloud_agent_sessions_tenant").on(t.tenantId),
  ],
);

/** 追加写事件日志：断线续传 / 多设备同步的权威源 */
export const cloudAgentEvents = pgTable(
  "cloud_agent_events",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    sessionId: text("session_id")
      .notNull()
      .references(() => cloudAgentSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** 见 CloudAgentEventType */
    type: text("type").notNull(),
    runId: text("run_id"),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cloud_agent_events_session_seq").on(t.sessionId, t.seq),
    index("cloud_agent_events_session").on(t.sessionId, t.seq),
  ],
);

export const cloudAgentRuns = pgTable(
  "cloud_agent_runs",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    sessionId: text("session_id")
      .notNull()
      .references(() => cloudAgentSessions.id, { onDelete: "cascade" }),
    /** queued | running | completed | cancelled | failed */
    status: text("status").notNull().default("queued"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cloud_agent_runs_session").on(t.sessionId, t.createdAt)],
);

/**
 * 租户级技能注册表。技能内容（SKILL.md + 捆绑资源）以 JSON 存在 filesJson，
 * 安装到 Agent 时再写入各自工作区，避免重复下载与外网依赖。
 */
export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 目录名，租户内唯一 */
    name: text("name").notNull(),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    /** commit sha / "builtin" / 抓取时间戳 */
    version: text("version"),
    builtin: boolean("builtin").notNull().default(false),
    /** SkillSource JSON */
    sourceJson: text("source_json").notNull().default("{}"),
    homepage: text("homepage"),
    license: text("license"),
    /** SkillFile[] JSON */
    filesJson: text("files_json").notNull().default("[]"),
    fileCount: integer("file_count").notNull().default(0),
    sizeBytes: integer("size_bytes").notNull().default(0),
    /** 指回 platform_skill_repos.repoKey，用于判断上游是否有新版本 */
    repoKey: text("repo_key"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("skills_tenant_name").on(t.tenantId, t.name),
    index("skills_tenant").on(t.tenantId),
    index("skills_repo_key").on(t.repoKey),
  ],
);

/**
 * 跨租户共享的仓库级技能缓存（全局，无 tenantId）。
 *
 * 同一个技能仓库在 SaaS 下会被多个租户安装，逐租户重新下载既慢又会打爆
 * GitHub 未鉴权的 60 次/小时配额。这里按「仓库 + ref」缓存一份完整内容，
 * 租户安装时优先命中：新鲜就直接装（零网络），过期就先做一次不计配额的
 * ETag 探测（codeload HEAD），没变只更新 checkedAt。
 *
 * 只缓存平台 token / 匿名可见的内容——用租户自备 token 才能读到的私有仓库
 * 不会写进来，避免跨租户泄露。
 */
export const platformSkillRepos = pgTable(
  "platform_skill_repos",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    /** 规范化来源标识，如 github:anthropics/skills@HEAD */
    repoKey: text("repo_key").notNull(),
    /** github | gitlab */
    provider: text("provider").notNull().default("github"),
    /** SkillSource JSON（不含 skills 过滤） */
    sourceJson: text("source_json").notNull().default("{}"),
    /** 解析后的分支/标签 */
    ref: text("ref"),
    /** commit sha 前 12 位，作为版本号 */
    version: text("version"),
    /** codeload tar.gz 的 ETag，用于零配额变更探测 */
    upstreamEtag: text("upstream_etag"),
    /** SkillPackage[] JSON */
    packagesJson: text("packages_json").notNull().default("[]"),
    /** true = 体积超限只存了清单，安装时需按需补齐捆绑文件 */
    partial: boolean("partial").notNull().default(false),
    skillCount: integer("skill_count").notNull().default(0),
    sizeBytes: integer("size_bytes").notNull().default(0),
    /** 抓取时产生的告警 JSON */
    warningsJson: text("warnings_json").notNull().default("[]"),
    /** 最近一次确认与上游一致的时间 */
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    /** 最近一次真正下载内容的时间 */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    /** 被多少租户引用过，用于决定后台刷新优先级 */
    refCount: integer("ref_count").notNull().default(0),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("platform_skill_repos_key").on(t.repoKey),
    index("platform_skill_repos_checked").on(t.checkedAt),
  ],
);

/**
 * 技能来源的访问令牌。scopeKey = "platform"（整站默认）或 tenantId（租户自备）。
 * 明文不出库：值用部署密钥加密后存 tokenEnc，API 只回显掩码。
 */
export const skillSourceTokens = pgTable(
  "skill_source_tokens",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    /** "platform" 或 tenantId */
    scopeKey: text("scope_key").notNull(),
    /** github | gitlab */
    provider: text("provider").notNull().default("github"),
    /** encryptJson({ token }) */
    tokenEnc: text("token_enc").notNull(),
    /** 便于识别的备注，如 "ci-readonly" */
    label: text("label"),
    /** 末 4 位，用于界面回显 */
    hint: text("hint"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("skill_source_tokens_scope").on(t.scopeKey, t.provider)],
);

/** 技能在单个 Agent 上的安装记录（文件已写入该 Agent 工作区） */
export const agentSkills = pgTable(
  "agent_skills",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** 工作区内路径，如 /skills/find-skills */
    path: text("path").notNull(),
    version: text("version"),
    /** installed | error */
    status: text("status").notNull().default("installed"),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("agent_skills_agent_name").on(t.agentId, t.name),
    index("agent_skills_tenant").on(t.tenantId),
    index("agent_skills_skill").on(t.skillId),
  ],
);

export const schema = {
  platformMeta,
  tenants,
  users,
  oauthIdentities,
  oauthLoginStates,
  tenantMemberships,
  tenantInvites,
  memoryProviders,
  modelUpstreams,
  modelRoutes,
  upstreamModels,
  modelCatalogEntries,
  runtimeNodes,
  agents,
  workspaceMigrations,
  apiKeys,
  providerCatalog,
  componentInstances,
  managedContainers,
  agentBindings,
  settings,
  platformServices,
  platformServiceQuotas,
  platformServiceUsage,
  mcpPolicies,
  memories,
  memoryEdges,
  toolCallLogs,
  oauthClients,
  oauthAuthCodes,
  oauthRefreshTokens,
  networkIntegrations,
  tunnelProviderSettings,
  networkSecurityPolicies,
  fileShares,
  portExposures,
  networkAuditLogs,
  cloudAgentSessions,
  cloudAgentEvents,
  cloudAgentRuns,
  skills,
  agentSkills,
  platformSkillRepos,
  skillSourceTokens,
};

export type PlatformMeta = typeof platformMeta.$inferSelect;
export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type OauthIdentity = typeof oauthIdentities.$inferSelect;
export type OauthLoginState = typeof oauthLoginStates.$inferSelect;
export type TenantMembership = typeof tenantMemberships.$inferSelect;
export type TenantInvite = typeof tenantInvites.$inferSelect;
export type MemoryProvider = typeof memoryProviders.$inferSelect;
export type ModelUpstream = typeof modelUpstreams.$inferSelect;
export type ModelRoute = typeof modelRoutes.$inferSelect;
export type UpstreamModel = typeof upstreamModels.$inferSelect;
export type ModelCatalogEntryRow = typeof modelCatalogEntries.$inferSelect;
export type RuntimeNode = typeof runtimeNodes.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type WorkspaceMigration = typeof workspaceMigrations.$inferSelect;
export type AgentBinding = typeof agentBindings.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type ProviderCatalog = typeof providerCatalog.$inferSelect;
export type ComponentInstance = typeof componentInstances.$inferSelect;
export type ManagedContainer = typeof managedContainers.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type PlatformService = typeof platformServices.$inferSelect;
export type PlatformServiceQuota = typeof platformServiceQuotas.$inferSelect;
export type PlatformServiceUsageRow = typeof platformServiceUsage.$inferSelect;
export type McpPolicy = typeof mcpPolicies.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type MemoryEdge = typeof memoryEdges.$inferSelect;
export type ToolCallLog = typeof toolCallLogs.$inferSelect;
export type OauthClient = typeof oauthClients.$inferSelect;
export type OauthAuthCode = typeof oauthAuthCodes.$inferSelect;
export type OauthRefreshToken = typeof oauthRefreshTokens.$inferSelect;
export type NetworkIntegration = typeof networkIntegrations.$inferSelect;
export type TunnelProviderSetting = typeof tunnelProviderSettings.$inferSelect;
export type NetworkSecurityPolicy = typeof networkSecurityPolicies.$inferSelect;
export type FileShare = typeof fileShares.$inferSelect;
export type PortExposure = typeof portExposures.$inferSelect;
export type NetworkAuditLog = typeof networkAuditLogs.$inferSelect;
export type CloudAgentSession = typeof cloudAgentSessions.$inferSelect;
export type CloudAgentEventRow = typeof cloudAgentEvents.$inferSelect;
export type CloudAgentRun = typeof cloudAgentRuns.$inferSelect;
export type SkillRow = typeof skills.$inferSelect;
export type AgentSkillRow = typeof agentSkills.$inferSelect;
export type PlatformSkillRepoRow = typeof platformSkillRepos.$inferSelect;
export type SkillSourceTokenRow = typeof skillSourceTokens.$inferSelect;
