import { Hono } from "hono";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { generateApiKey, globalRegistry, decryptJson, encryptJson } from "@zakura/core";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  apiKeys,
  componentInstances,
  managedContainers,
  mcpPolicies,
  newId,
  oauthIdentities,
  oauthLoginStates,
  providerCatalog,
  settings,
  tenantMemberships,
  tenants,
  users,
} from "../db/schema.js";
import {
  ensurePlatformMeta,
  runSetup,
  syncProviderCatalog,
} from "../services/bootstrap.js";
import {
  extractBearer,
  isSessionAdmin,
  loginUser,
  sessionFromLogin,
  signSession,
  switchTenantSession,
  verifySession,
} from "../services/auth.js";
import { InstanceNotFoundError, type Orchestrator } from "../services/orchestrator.js";
import { qualifyResourceUri, type McpGateway } from "../services/mcp-gateway.js";
import type { AgentService } from "../services/agents.js";
import type { DockerRuntime } from "../runtime/docker.js";
import {
  ensureCapabilityInstance,
  readInstanceConfig,
  saveCapabilityConfig,
  syncPlatformManagedWebDefaults,
} from "../services/capabilities.js";
import {
  listSearchEngineMeta,
  mergeWebSearchConfig,
  redactWebSearchConfig,
  type WebSearchConfig,
} from "../capabilities/web-search/index.js";
import {
  listFetchBackendMeta,
  mergeWebFetchConfig,
  redactWebFetchConfig,
  type WebFetchConfig,
} from "../capabilities/web-fetch/index.js";
import { MEMORY_LAYERS, type MemoryStore } from "../services/memory-store.js";
import {
  isMemoryProviderKind,
  type MemoryProvidersService,
} from "../services/memory-providers.js";
import { resolveAgentMemory } from "../services/memory-runtime.js";
import type { ToolCallStore } from "../services/tool-call-store.js";
import { OauthError, isRedirectUriRegistered, type OauthService } from "../services/oauth.js";
import { isCimdClientId } from "../services/oauth-cimd.js";
import { PROVIDER_CATEGORY_META } from "@zakura/shared";
import { registerAgentFsRoutes } from "./agent-fs-routes.js";
import { registerFileShareRoutes } from "./file-share-routes.js";
import { registerModelRouterRoutes } from "./model-router-routes.js";
import { registerCloudAgentRoutes } from "./cloud-agent-routes.js";
import { registerRuntimeNodeRoutes } from "./runtime-node-routes.js";
import { CloudAgentSessionStore } from "../services/cloud-agent-session.js";
import { platformEvents } from "../services/platform-events.js";
import { CloudAgentRuntime } from "../services/cloud-agent-runtime.js";
import { registerTenantRoutes } from "./tenant-routes.js";
import { TenantService } from "../services/tenants.js";
import { registerMigrationRoutes } from "./migration-routes.js";
import { registerSkillRoutes } from "./skill-routes.js";
import { registerNetworkRoutes } from "./network-routes.js";
import { registerConnectionRoutes } from "./connection-routes.js";
import { loadSaasServer } from "../saas-loader.js";
import type { RuntimeNodeService } from "../services/runtime-nodes.js";
import type { MigrationService } from "../services/migration-service.js";
import type { ServerWorkspaceFsProvider } from "../services/workspace-fs-provider.js";
import type { NetworkSettingsService } from "../services/network-settings.js";
import type { SecurityPolicyService } from "../services/network-security.js";
import type { ExposureService } from "../services/port-exposures.js";
import type { FileShareService } from "../services/file-shares.js";
import type { NetworkAuditService } from "../services/network-audit.js";
import type { PlatformServiceManager } from "../services/platform-services.js";
import type { PlatformServiceUsageService } from "../services/platform-service-usage.js";
import { registerPlatformServiceRoutes } from "./platform-service-routes.js";
import { McpStoreService, isBuiltinMcpStoreId, type McpStoreSourceId } from "../services/mcp-store.js";
import { IntegrationCatalogService } from "../services/integration-catalog.js";
import {
  McpUpstreamOauthService,
  type UpstreamOauthDiscovery,
} from "../services/mcp-upstream-oauth.js";
import {
  buildByoOauthClient,
} from "../services/mcp-oauth-clients.js";
import { UpstreamOauthClientStore } from "../services/upstream-oauth-clients.js";
import {
  buildGoogleProvisionGuide,
  googleOauthSetupChecklist,
  provisionGoogleWorkspaceMcp,
} from "../services/google-cloud-provision.js";
import { applyOauthTokensToConfig } from "../providers/generic-mcp.js";
import {
  resolveGoogleWorkspaceProduct,
  resolveToolPermissionStates,
} from "../providers/google-workspace/index.js";
import { randomBytes } from "node:crypto";
import {
  AGENT_DEFAULTS_KEY,
  enableWebForUserAgents,
  getAgentWebDefaults,
  saveAgentWebDefaults,
} from "../services/agent-defaults.js";

/** Short-lived upstream OAuth PKCE state (in-memory) */
const upstreamOauthPending = new Map<
  string,
  {
    tenantId: string;
    instanceId?: string;
    connectorRef?: string;
    mcpUrl: string;
    clientId: string;
    clientSecret?: string;
    codeVerifier: string;
    redirectUri: string;
    tokenEndpoint: string;
    /** null = platform connector, do not send RFC 8707 MCP resource */
    resource?: string | null;
    createdAt: number;
  }
>();

function purgeUpstreamOauthPending() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of upstreamOauthPending) {
    if (v.createdAt < cutoff) upstreamOauthPending.delete(k);
  }
}

function redactConfigValue(key: string, value: unknown): unknown {
  if (/secret|token|password|apikey|api_key|refresh/i.test(key)) {
    return value == null || value === "" ? value : "***";
  }
  if (key === "env" && typeof value === "string") {
    try {
      return JSON.stringify(redactConfigValue(key, JSON.parse(value)));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => redactConfigValue(key, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactConfigValue(childKey, childValue),
      ]),
    );
  }
  return value;
}

/** Throttle live Docker inspect on GET /api/containers?sync=1 */
const containerListSyncAt = new Map<string, number>();
const CONTAINER_LIST_SYNC_TTL_MS = 15_000;

/**
 * Client 获取顺序：
 * 1. 请求体 BYO（用户自备 OAuth Client ID/Secret）
 * 2. 连接器预配（管理员/团队配置的 OAuth Client，按 hostPatterns 匹配）
 * 3. DCR（上游支持时）
 * dcr / byo 成功后写入 upstream_oauth_clients 供设置页列出。
 */
async function resolveUpstreamOauthClient(opts: {
  upstreamOauth: McpUpstreamOauthService;
  discovery: UpstreamOauthDiscovery;
  mcpUrl: string;
  redirectUri: string;
  clientName?: string;
  /** 用户安装时直接提供的 OAuth 客户端（非 API Key） */
  byo?: { clientId?: string; clientSecret?: string; scopes?: string };
  /** 平台/团队预配的连接器 OAuth 客户端 */
  connectorClient?: {
    clientId: string;
    clientSecret?: string;
    scopes?: string;
  } | null;
  /** 持久化 dcr/byo 记录 */
  record?: {
    store: UpstreamOauthClientStore;
    tenantId: string;
    instanceId?: string | null;
  };
}): Promise<{
  clientId: string;
  clientSecret?: string;
  scopeOverride?: string;
  source: "dcr" | "byo" | "platform" | "tenant";
} | null> {
  let result: {
    clientId: string;
    clientSecret?: string;
    scopeOverride?: string;
    source: "dcr" | "byo" | "platform" | "tenant";
  } | null = null;

  if (opts.byo?.clientId?.trim()) {
    const byo = buildByoOauthClient(opts.mcpUrl, {
      clientId: opts.byo.clientId,
      clientSecret: opts.byo.clientSecret,
      scopes: opts.byo.scopes,
    });
    if (byo) {
      result = {
        clientId: byo.clientId,
        clientSecret: byo.clientSecret,
        scopeOverride: byo.scopes,
        source: "byo",
      };
    }
  } else if (opts.connectorClient?.clientId?.trim()) {
    result = {
      clientId: opts.connectorClient.clientId.trim(),
      clientSecret: opts.connectorClient.clientSecret?.trim() || undefined,
      scopeOverride: opts.connectorClient.scopes?.trim() || undefined,
      source: "platform",
    };
  } else if (opts.discovery.registrationEndpoint) {
    const registered = await opts.upstreamOauth.registerClient(opts.discovery, {
      clientName: opts.clientName,
      redirectUris: [opts.redirectUri],
    });
    result = {
      clientId: registered.clientId,
      clientSecret: registered.clientSecret,
      source: "dcr",
    };
  }

  if (
    result &&
    opts.record &&
    (result.source === "dcr" || result.source === "byo")
  ) {
    try {
      await opts.record.store.record({
        tenantId: opts.record.tenantId,
        mcpUrl: opts.mcpUrl,
        clientId: result.clientId,
        clientSecret: result.clientSecret,
        clientName: opts.clientName,
        source: result.source,
        registrationEndpoint: opts.discovery.registrationEndpoint,
        scope: result.scopeOverride,
        instanceId: opts.record.instanceId,
      });
    } catch (err) {
      console.warn(
        "[oauth] persist upstream client failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return result;
}

function noDcrOauthError(mcpUrl: string): string {
  const host = (() => {
    try {
      return new URL(mcpUrl).hostname;
    } catch {
      return mcpUrl;
    }
  })();
  return `${host} 不支持动态客户端注册。请填写该 MCP 自己的 OAuth Client ID/Secret。`;
}

/** 租户管理员可管本租户；整站仅超管（OSS 下管理员可管整站） */
function canManageMcpOauthApps(
  session: { role: string; userId: string; isPlatformAdmin?: boolean },
  config: AppConfig,
  scope: "platform" | "tenant",
): boolean {
  if (scope === "tenant") return isSessionAdmin(session);
  if (config.multiTenant) return session.isPlatformAdmin === true;
  return isSessionAdmin(session);
}

export type AppVariables = {
  session?: {
    userId: string;
    tenantId: string;
    email: string;
    role: string;
    isPlatformAdmin?: boolean;
  };
};

async function loadInstanceWithContainers(db: Db, tenantId: string, id: string) {
  const instance = await db.query.componentInstances.findFirst({
    where: and(eq(componentInstances.id, id), eq(componentInstances.tenantId, tenantId)),
  });
  if (!instance) return null;
  const [containers, provider] = await Promise.all([
    db
      .select()
      .from(managedContainers)
      .where(
        and(eq(managedContainers.instanceId, id), eq(managedContainers.tenantId, tenantId)),
      ),
    db.query.providerCatalog.findFirst({
      where: eq(providerCatalog.id, instance.providerId),
    }),
  ]);
  return { ...instance, provider: provider ?? null, containers };
}

function instanceErrorStatus(err: unknown): 404 | 500 {
  return err instanceof InstanceNotFoundError ? 404 : 500;
}

function mapPolicy(
  r: {
    id: string;
    apiKeyId: string | null;
    instanceIds: string;
    toolAllowlist: string | null;
    toolDenylist: string | null;
    includeBuiltin: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  },
  apiKey: { id: string; name: string; keyPrefix: string } | null,
  opts?: { timestamps?: boolean },
) {
  const base = {
    id: r.id,
    apiKeyId: r.apiKeyId,
    apiKey,
    instanceIds: JSON.parse(r.instanceIds) as string[],
    toolAllowlist: r.toolAllowlist ? (JSON.parse(r.toolAllowlist) as string[]) : null,
    toolDenylist: r.toolDenylist ? (JSON.parse(r.toolDenylist) as string[]) : null,
    includeBuiltin: r.includeBuiltin,
  };
  if (opts?.timestamps) {
    return { ...base, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
  return base;
}

export async function createApiApp(deps: {
  db: Db;
  config: AppConfig;
  orchestrator: Orchestrator;
  gateway: McpGateway;
  runtime: DockerRuntime;
  agentService: AgentService;
  memoryStore: MemoryStore;
  memoryProviders: MemoryProvidersService;
  modelRouter?: import("../services/model-router.js").ModelRouterService;
  modelUpstreams?: import("../services/model-upstreams.js").ModelUpstreamsService;
  modelRoutes?: import("../services/model-routes.js").ModelRoutesService;
  modelCatalog?: import("../services/model-catalog.js").ModelCatalogService;
  upstreamModels?: import("../services/upstream-models.js").UpstreamModelsService;
  toolCallStore: ToolCallStore;
  oauth: OauthService;
  runtimeNodes?: RuntimeNodeService;
  migrations?: MigrationService;
  workspaceFsProvider?: ServerWorkspaceFsProvider;
  networkSettings?: NetworkSettingsService;
  securityPolicy?: SecurityPolicyService;
  exposures?: ExposureService;
  fileShares?: FileShareService;
  networkAudit?: NetworkAuditService;
  platformServices?: PlatformServiceManager;
  platformServiceUsage?: PlatformServiceUsageService;
  skills?: import("../services/skills/index.js").SkillsService;
  connections?: import("../services/connection-catalog.js").ConnectionCatalogService;
  instanceMigrations?: import("../services/instance-migration.js").InstanceMigrationService | null;
}) {
  const {
    db,
    config,
    orchestrator,
    gateway,
    runtime,
    agentService,
    memoryStore,
    memoryProviders,
    modelRouter,
    modelUpstreams,
    modelRoutes,
    modelCatalog,
    upstreamModels,
    toolCallStore,
    oauth,
    runtimeNodes,
    migrations,
    workspaceFsProvider,
    networkSettings,
    securityPolicy,
    exposures,
    fileShares,
    networkAudit,
    platformServices,
    platformServiceUsage,
    skills,
    connections,
    instanceMigrations,
  } = deps;
  const mcpStore = new McpStoreService(db, config);
  const upstreamOauth = new McpUpstreamOauthService(config);
  const upstreamOauthClients = new UpstreamOauthClientStore(db, config);
  const integrationCatalog = new IntegrationCatalogService(db, config);
  const tenantService = new TenantService(db);
  const app = new Hono<{ Variables: AppVariables }>();

  // Request timing: log any /api call > 300ms (or all when ZAKURA_HTTP_TIMING=1)
  app.use("/api/*", async (c, next) => {
    const t0 = performance.now();
    await next();
    const ms = performance.now() - t0;
    const always = process.env.ZAKURA_HTTP_TIMING === "1";
    if (always || ms >= 300) {
      console.warn(
        `[http] ${c.req.method} ${c.req.path} ${ms.toFixed(0)}ms status=${c.res.status}`,
      );
    }
  });

  app.use("/api/*", async (c, next) => {
    const publicPaths = new Set([
      "/api/health",
      "/api/platform",
      "/api/setup",
      "/api/auth/login",
      "/api/oauth/authorize-info",
      "/api/mcp/upstream-oauth/callback",
      "/api/runtime-nodes/register",
    ]);
    if (config.edition === "saas") {
      publicPaths.add("/api/auth/register");
      publicPaths.add("/api/auth/oauth/zerocat");
      publicPaths.add("/api/auth/oauth/zerocat/start");
      publicPaths.add("/api/auth/oauth/zerocat/callback");
    }
    const path = c.req.path;
    const isInvitePublic =
      config.edition === "saas" &&
      (/^\/api\/invites\/[^/]+$/.test(path) ||
        /^\/api\/invites\/[^/]+\/accept$/.test(path));
    const isFileSharePublic = /^\/api\/files\/shared\/[^/]+$/.test(path);

    // probe/import require auth — intentional
    if (publicPaths.has(path) || isInvitePublic || isFileSharePublic) {
      // Optional session for invite accept
      if (isInvitePublic) {
        const auth = c.req.header("authorization");
        const token = extractBearer(auth) ?? c.req.header("x-zakura-session") ?? undefined;
        if (token) {
          const session = verifySession(config.secret, token);
          if (session) c.set("session", session);
        }
      }
      await next();
      return;
    }
    // Runner heartbeat uses rnr_* bearer (handled in route)
    if (
      c.req.method === "POST" &&
      /^\/api\/runtime-nodes\/[^/]+\/heartbeat$/.test(c.req.path)
    ) {
      await next();
      return;
    }
    // Host-served bootstrap script (token in query; validated in route)
    if (
      c.req.method === "GET" &&
      /^\/api\/runtime-nodes\/[^/]+\/bootstrap\.sh$/.test(c.req.path)
    ) {
      await next();
      return;
    }

    const auth = c.req.header("authorization");
    const token = extractBearer(auth) ?? c.req.header("x-zakura-session") ?? undefined;
    if (!token) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // session token or API key both accepted for API
    const session = verifySession(config.secret, token);
    if (session) {
      c.set("session", session);
      await next();
      return;
    }

    const { authenticateApiKey } = await import("../services/auth.js");
    const keyed = await authenticateApiKey(db, token);
    if (keyed) {
      c.set("session", {
        userId: "api-key",
        tenantId: keyed.tenant.id,
        email: keyed.apiKey.name,
        // API keys are machine credentials — not tenant admins
        role: "api_key",
      });
      await next();
      return;
    }

    return c.json({ error: "Unauthorized" }, 401);
  });

  app.get("/api/health", (c) => c.json({ status: "ok", service: "zakura" }));

  if (platformServices && platformServiceUsage) {
    registerPlatformServiceRoutes(app as never, {
      config,
      platformServices,
      platformServiceUsage,
    });
  }

  app.get("/api/runtime/docker", async (c) => {
    const ping = await runtime.ping();
    if (!ping.ok) {
      return c.json({ ok: false, error: ping.error, network: config.dockerNetwork });
    }
    return c.json({ ok: true, version: ping.version, network: config.dockerNetwork });
  });

  app.get("/api/platform", async (c) => {
    const meta = await ensurePlatformMeta(db, { multiTenant: config.multiTenant });
    const oauthProviders: Array<{ id: string; name: string; enabled: boolean }> = [];
    let passwordLoginEnabled = true;
    if (config.edition === "saas") {
      try {
        const saas = await loadSaasServer();
        if (saas?.loadZerocatConfig) {
          const { public: pub } = await saas.loadZerocatConfig({
            db,
            schema: {
              users,
              tenants,
              tenantMemberships,
              oauthIdentities,
              oauthLoginStates,
              settings,
              newId,
            },
            secret: config.secret,
            webPublicUrl: config.webPublicUrl,
            decryptJson,
          });
          oauthProviders.push({
            id: "zerocat",
            name: "ZeroCat",
            enabled: pub.enabled,
          });
          if (pub.disablePasswordLogin) {
            passwordLoginEnabled = false;
          }
        }
      } catch {
        /* ignore — login still works with password */
      }
    }
    return c.json({
      setupCompleted: meta.setupCompleted,
      version: meta.version,
      mode: meta.mode,
      multiTenant: config.multiTenant,
      edition: config.edition,
      registrationEnabled: config.edition === "saas" && passwordLoginEnabled,
      passwordLoginEnabled,
      oauthProviders,
    });
  });

  app.post("/api/setup", async (c) => {
    const body = await c.req.json<{
      adminEmail: string;
      adminPassword: string;
      adminName?: string;
      tenantName?: string;
    }>();
    if (!body.adminEmail || !body.adminPassword) {
      return c.json({ error: "adminEmail and adminPassword required" }, 400);
    }
    try {
      await ensurePlatformMeta(db, { multiTenant: config.multiTenant });
      await syncProviderCatalog(db);
      const result = await runSetup(db, body);
      const session = signSession(config.secret, {
        userId: result.user.id,
        tenantId: result.tenant.id,
        email: result.user.email,
        role: "owner",
        isPlatformAdmin: config.multiTenant && result.user.isPlatformAdmin,
      });
      return c.json({
        ok: true,
        session,
        tenant: {
          id: result.tenant.id,
          slug: result.tenant.slug,
          name: result.tenant.name,
          onboardingCompleted: result.tenant.onboardingCompleted,
        },
        // Always continue to tenant onboarding after system setup
        next: "/onboarding",
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/auth/login", async (c) => {
    if (config.edition === "saas") {
      try {
        const saas = await loadSaasServer();
        if (saas?.loadZerocatConfig) {
          const { public: pub } = await saas.loadZerocatConfig({
            db,
            schema: {
              users,
              tenants,
              tenantMemberships,
              oauthIdentities,
              oauthLoginStates,
              settings,
              newId,
            },
            secret: config.secret,
            webPublicUrl: config.webPublicUrl,
            decryptJson,
          });
          if (pub.disablePasswordLogin) {
            return c.json({ error: "邮箱密码登录已关闭，请使用 ZeroCat 登录" }, 403);
          }
        }
      } catch {
        /* ignore */
      }
    }
    const body = await c.req
      .json<{ email?: string; password?: string; tenantSlug?: string }>()
      .catch(() => ({} as { email?: string; password?: string; tenantSlug?: string }));
    if (!body.email || !body.password) {
      return c.json({ error: "email and password required" }, 400);
    }
    const result = await loginUser(db, body.email, body.password, {
      tenantSlug: body.tenantSlug?.trim() || undefined,
    });
    if (!result) return c.json({ error: "Invalid credentials" }, 401);
    const session = signSession(config.secret, {
      userId: result.user.id,
      tenantId: result.tenant.id,
      email: result.user.email,
      role: result.membership.role,
      isPlatformAdmin: config.multiTenant && result.user.isPlatformAdmin,
    });
    return c.json({
      session,
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        isPlatformAdmin: config.multiTenant && result.user.isPlatformAdmin,
      },
      tenant: {
        id: result.tenant.id,
        slug: result.tenant.slug,
        name: result.tenant.name,
        onboardingCompleted: result.tenant.onboardingCompleted,
      },
      role: result.membership.role,
      multiTenant: config.multiTenant,
      edition: config.edition,
    });
  });

  app.get("/api/me", async (c) => {
    const session = c.get("session")!;
    const user =
      session.userId === "api-key"
        ? null
        : await db.query.users.findFirst({ where: eq(users.id, session.userId) });
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, session.tenantId),
    });
    if (!tenant) throw new Error(`Tenant not found: ${session.tenantId}`);
    const { userCanUseLocalRunner } = await import("../services/runner-access.js");
    const canUseLocalRunner = await userCanUseLocalRunner(db, config, session.userId);
    return c.json({
      user: user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            isPlatformAdmin: user.isPlatformAdmin,
            canUseLocalRunner: user.canUseLocalRunner || user.isPlatformAdmin || !config.multiTenant,
          }
        : { id: "api-key", email: session.email, isPlatformAdmin: false, canUseLocalRunner: false },
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        isDefault: tenant.isDefault,
        onboardingCompleted: tenant.onboardingCompleted,
        onboardingSteps: JSON.parse(tenant.onboardingSteps || "{}"),
      },
      role: session.role,
      isPlatformAdmin:
        config.multiTenant &&
        (session.isPlatformAdmin === true || user?.isPlatformAdmin === true),
      canUseLocalRunner,
      multiTenant: config.multiTenant,
      edition: config.edition,
      registrationEnabled: config.edition === "saas",
      connect: {
        agentMcpPattern: `${config.publicBaseUrl}/mcp/agents/{slug}`,
        authorizeUrl: `${config.webPublicUrl}/console/oauth/authorize`,
        tokenUrl: `${config.publicBaseUrl}/token`,
        registerUrl: `${config.publicBaseUrl}/oauth/register`,
        oauthMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-authorization-server`,
        resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
        webPublicUrl: config.webPublicUrl,
        clientIdMetadataDocumentSupported: true,
      },
    });
  });

  app.get("/api/connect", async (c) => {
    const session = c.get("session")!;
    const agentRows = await agentService.list(session.tenantId);
    return c.json({
      publicBaseUrl: config.publicBaseUrl,
      agentMcpPattern: `${config.publicBaseUrl}/mcp/agents/{slug}`,
      authorizationServer: oauth.metadata(),
      agents: agentRows.map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        mcpUrl: `${config.publicBaseUrl}/mcp/agents/${a.slug}`,
      })),
      authMethods: [
        {
          id: "oauth21",
          name: "OAuth 2.1 + PKCE",
          description: "VS Code 等支持动态客户端注册的客户端；打开 Agent MCP URL 后自动完成注册与登录授权",
        },
        {
          id: "api_key",
          name: "API Key",
          description: "使用 Agent 作用域 API Key：Authorization: Bearer <api-key>，适合 Cursor / Claude Desktop / 脚本",
        },
      ],
    });
  });

  app.get("/api/oauth/clients", async (c) => {
    const session = c.get("session")!;
    const [inbound, outbound] = await Promise.all([
      oauth.listClients(session.tenantId),
      upstreamOauthClients.list(session.tenantId),
    ]);
    return c.json({
      inbound,
      outbound,
      dcr: outbound.filter((r) => r.source === "dcr"),
      byo: outbound.filter((r) => r.source === "byo"),
    });
  });

  /** Preview OAuth authorize request for the web console UI */
  app.get("/api/oauth/authorize-info", async (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const responseType = c.req.query("response_type") ?? "code";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const scope = c.req.query("scope") ?? "mcp";
    const resource = c.req.query("resource") ?? "";
    const agent = c.req.query("agent") ?? "";

    if (responseType !== "code") {
      return c.json({ error: "仅支持 response_type=code" }, 400);
    }
    if (!clientId || !redirectUri || !codeChallenge) {
      return c.json({ error: "缺少 client_id / redirect_uri / code_challenge" }, 400);
    }

    let client;
    try {
      client = await oauth.resolveClient(clientId);
    } catch (err) {
      if (err instanceof OauthError) {
        return c.json({ error: err.message }, err.status as 400);
      }
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
    if (!client) {
      return c.json(
        {
          error: isCimdClientId(clientId)
            ? "无法加载 CIMD 客户端元数据，请检查 client_id URL 是否可访问"
            : "未知客户端，请先完成动态注册或使用支持 CIMD 的客户端",
        },
        400,
      );
    }
    const uris = oauth.parseRedirectUris(client);
    if (!isRedirectUriRegistered(client, redirectUri, clientId)) {
      return c.json({ error: "redirect_uri 未登记" }, 400);
    }

    return c.json({
      client: {
        clientId: client.clientId,
        clientName: client.clientName || "MCP Client",
        registrationType: client.registrationType,
      },
      redirectUri,
      scope,
      resource: resource || null,
      agent: agent || null,
      codeChallengeMethod: c.req.query("code_challenge_method") || "S256",
      registeredRedirectUris: uris,
    });
  });

  /** Complete OAuth consent using an already-authenticated console session */
  app.post("/api/oauth/consent", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") {
      return c.json({ error: "请使用控制台账号登录后再授权" }, 403);
    }
    const body = await c.req.json<{
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      code_challenge_method?: string;
      scope?: string;
      resource?: string | null;
      agent?: string | null;
      state?: string;
    }>();

    try {
      const { code, redirectUri } = await oauth.consent({
        userId: session.userId,
        tenantId: session.tenantId,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method,
        scope: body.scope,
        resource: body.resource,
        agentSlug: body.agent,
      });
      const url = new URL(redirectUri);
      url.searchParams.set("code", code);
      if (body.state) url.searchParams.set("state", body.state);
      // RFC 9207 / MCP：ChatGPT 校验 iss；缺失会 403 且不调用 /token
      url.searchParams.set("iss", config.publicBaseUrl.replace(/\/$/, ""));
      return c.json({ redirect: url.toString() });
    } catch (err) {
      if (err instanceof OauthError) {
        return c.json({ error: err.message, code: err.error }, err.status as 400);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/providers", async (c) => {
    await syncProviderCatalog(db);
    const rows = await db.select().from(providerCatalog).orderBy(asc(providerCatalog.name));
    return c.json(
      rows.map((r) => ({
        ...r,
        capabilities: JSON.parse(r.capabilities),
        configSchema: JSON.parse(r.configSchema),
        categoryMeta:
          PROVIDER_CATEGORY_META[r.category as keyof typeof PROVIDER_CATEGORY_META] ?? null,
      })),
    );
  });

  app.get("/api/capabilities/web-search", async (c) => {
    const session = c.get("session")!;
    const instance = await ensureCapabilityInstance(
      db,
      orchestrator,
      session.tenantId,
      "web-search",
    );
    const capabilityConfig = readInstanceConfig<WebSearchConfig>(config, instance);
    return c.json({
      instance: {
        id: instance.id,
        status: instance.status,
        healthStatus: instance.healthStatus,
        lastError: instance.lastError,
        slug: instance.slug,
      },
      engines: listSearchEngineMeta(),
      // Secrets never leave the server (tenant isolation)
      config: redactWebSearchConfig(capabilityConfig),
    });
  });

  /** 网页能力聚合：一次返回 web-search + web-fetch，供设置页首屏 */
  app.get("/api/capabilities", async (c) => {
    const session = c.get("session")!;
    const [searchInst, fetchInst] = await Promise.all([
      ensureCapabilityInstance(db, orchestrator, session.tenantId, "web-search"),
      ensureCapabilityInstance(db, orchestrator, session.tenantId, "web-fetch"),
    ]);
    const managed =
      platformServices != null
        ? (await platformServices.list()).filter(
            (s) => s.mode !== "disabled" && (s.healthStatus === "healthy" || s.status === "running"),
          )
        : [];
    const platformAgentDefaults = await getAgentWebDefaults(db);
    await syncPlatformManagedWebDefaults(db, orchestrator, config, session.tenantId, platformAgentDefaults, managed);
    return c.json({
      webSearch: {
        instance: {
          id: searchInst.id,
          status: searchInst.status,
          healthStatus: searchInst.healthStatus,
          lastError: searchInst.lastError,
          slug: searchInst.slug,
        },
        engines: listSearchEngineMeta(),
        config: redactWebSearchConfig(
          readInstanceConfig<WebSearchConfig>(config, searchInst),
        ),
      },
      webFetch: {
        instance: {
          id: fetchInst.id,
          status: fetchInst.status,
          healthStatus: fetchInst.healthStatus,
          lastError: fetchInst.lastError,
          slug: fetchInst.slug,
        },
        backends: listFetchBackendMeta(),
        config: redactWebFetchConfig(
          readInstanceConfig<WebFetchConfig>(config, fetchInst),
        ),
      },
      platformServices: managed.map((s) => ({
        key: s.key,
        name: s.name,
        mode: s.mode,
        healthStatus: s.healthStatus,
        mapsTo: s.mapsTo,
        // SaaS users may select a managed service but never receive its host address.
        ...(config.multiTenant ? {} : { endpointUrl: s.endpointUrl }),
      })),
      agentDefaults: config.multiTenant ? undefined : platformAgentDefaults,
    });
  });

  app.put("/api/capabilities/web-search", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<Record<string, unknown>>();
    try {
      // Merge secrets under this tenant only — never accept other tenants' data
      const existing = await ensureCapabilityInstance(
        db,
        orchestrator,
        session.tenantId,
        "web-search",
      );
      const previous = readInstanceConfig<WebSearchConfig>(config, existing);
      const merged = mergeWebSearchConfig(body, previous);
      const instance = await saveCapabilityConfig(
        db,
        orchestrator,
        config,
        session.tenantId,
        "web-search",
        merged as unknown as Record<string, unknown>,
      );
      return c.json({
        ok: true,
        instance,
        config: instance
          ? redactWebSearchConfig(readInstanceConfig<WebSearchConfig>(config, instance))
          : redactWebSearchConfig(merged),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/capabilities/web-fetch", async (c) => {
    const session = c.get("session")!;
    const instance = await ensureCapabilityInstance(
      db,
      orchestrator,
      session.tenantId,
      "web-fetch",
    );
    const capabilityConfig = readInstanceConfig<WebFetchConfig>(config, instance);
    return c.json({
      instance: {
        id: instance.id,
        status: instance.status,
        healthStatus: instance.healthStatus,
        lastError: instance.lastError,
        slug: instance.slug,
      },
      backends: listFetchBackendMeta(),
      config: redactWebFetchConfig(capabilityConfig),
    });
  });

  app.put("/api/capabilities/web-fetch", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<Record<string, unknown>>();
    try {
      const existing = await ensureCapabilityInstance(
        db,
        orchestrator,
        session.tenantId,
        "web-fetch",
      );
      const previous = readInstanceConfig<WebFetchConfig>(config, existing);
      const merged = mergeWebFetchConfig(body, previous);
      const instance = await saveCapabilityConfig(
        db,
        orchestrator,
        config,
        session.tenantId,
        "web-fetch",
        merged as unknown as Record<string, unknown>,
      );
      return c.json({
        ok: true,
        instance,
        config: instance
          ? redactWebFetchConfig(readInstanceConfig<WebFetchConfig>(config, instance))
          : redactWebFetchConfig(merged),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── Memory providers (tenant config only; Agent picks which to use) ───
  app.get("/api/memory-providers/meta", async (c) => {
    return c.json({ kinds: memoryProviders.kinds() });
  });

  app.get("/api/memory-providers", async (c) => {
    const session = c.get("session")!;
    const [list, usage] = await Promise.all([
      memoryProviders.list(session.tenantId),
      memoryProviders.usage(session.tenantId),
    ]);
    return c.json({
      providers: list,
      agents: usage,
      kinds: memoryProviders.kinds(),
      note: "本页仅管理记忆 Provider；各 Agent 在记忆页选择使用哪一个。",
    });
  });

  app.post("/api/memory-providers", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      kind?: string;
      slug?: string;
      config?: Record<string, unknown>;
      isDefault?: boolean;
    }>();
    try {
      if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
      if (!body.kind || !isMemoryProviderKind(body.kind)) {
        return c.json({ error: "invalid kind" }, 400);
      }
      const created = await memoryProviders.create(session.tenantId, {
        name: body.name,
        kind: body.kind,
        slug: body.slug,
        config: body.config,
        isDefault: body.isDefault,
      });
      return c.json(created, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/memory-providers/:id", async (c) => {
    const session = c.get("session")!;
    const row = await memoryProviders.get(session.tenantId, c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  });

  app.patch("/api/memory-providers/:id", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      config?: Record<string, unknown>;
      isDefault?: boolean;
    }>();
    try {
      const updated = await memoryProviders.update(session.tenantId, c.req.param("id"), body);
      return c.json(updated);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/memory-providers/:id", async (c) => {
    const session = c.get("session")!;
    try {
      await memoryProviders.remove(session.tenantId, c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/memory-providers/:id/health", async (c) => {
    const session = c.get("session")!;
    try {
      const health = await memoryProviders.healthCheck(session.tenantId, c.req.param("id"));
      return c.json(health);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/instances", async (c) => {
    const session = c.get("session")!;
    const allRows = await db
      .select()
      .from(componentInstances)
      .where(eq(componentInstances.tenantId, session.tenantId))
      .orderBy(desc(componentInstances.createdAt));

    const providerIds = [...new Set(allRows.map((r) => r.providerId))];
    const providers =
      providerIds.length > 0
        ? await db.select().from(providerCatalog).where(inArray(providerCatalog.id, providerIds))
        : [];
    const providerMap = new Map(providers.map((p) => [p.id, p]));
    const rows = allRows.filter((row) => providerMap.get(row.providerId)?.category !== "connector");

    const instanceIds = rows.map((r) => r.id);
    const containers =
      instanceIds.length > 0
        ? await db
            .select()
            .from(managedContainers)
            .where(inArray(managedContainers.instanceId, instanceIds))
        : [];
    const containersByInstance = new Map<string, typeof containers>();
    for (const container of containers) {
      if (!container.instanceId) continue;
      const list = containersByInstance.get(container.instanceId) ?? [];
      list.push(container);
      containersByInstance.set(container.instanceId, list);
    }

    return c.json(
      rows.map((r) => ({
        ...r,
        provider: providerMap.get(r.providerId) ?? null,
        containers: containersByInstance.get(r.id) ?? [],
      })),
    );
  });

  app.post("/api/instances", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      providerId: string;
      name: string;
      slug?: string;
      config?: Record<string, unknown>;
      start?: boolean;
    }>();

    if (!globalRegistry.has(body.providerId)) {
      return c.json({ error: `Unknown provider: ${body.providerId}` }, 400);
    }

    const slug =
      body.slug ??
      body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

    const instance = await orchestrator.createInstance({
      tenantId: session.tenantId,
      providerId: body.providerId,
      name: body.name,
      slug,
      config: body.config ?? {},
    });

    if (body.start) {
      try {
        await orchestrator.startInstance(session.tenantId, instance.id);
      } catch (err) {
        return c.json(
          {
            instance,
            error: err instanceof Error ? err.message : String(err),
          },
          201,
        );
      }
    }

    const fresh = await loadInstanceWithContainers(db, session.tenantId, instance.id);
    return c.json(fresh, 201);
  });

  app.post("/api/instances/:id/start", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    try {
      await orchestrator.startInstance(session.tenantId, id);
      const fresh = await loadInstanceWithContainers(db, session.tenantId, id);
      return c.json(fresh);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        instanceErrorStatus(err),
      );
    }
  });

  app.post("/api/instances/:id/stop", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    try {
      await orchestrator.stopInstance(session.tenantId, id);
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        instanceErrorStatus(err),
      );
    }
  });

  app.delete("/api/instances/:id", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    const instance = await db.query.componentInstances.findFirst({
      where: and(eq(componentInstances.id, id), eq(componentInstances.tenantId, session.tenantId)),
    });
    if (!instance) return c.json({ error: "Not found" }, 404);
    if (instance.status === "running" || instance.status === "starting") {
      await orchestrator.stopInstance(session.tenantId, id);
    }
    await db
      .delete(componentInstances)
      .where(and(eq(componentInstances.id, id), eq(componentInstances.tenantId, session.tenantId)));
    return c.json({ ok: true });
  });

  app.get("/api/instances/:id", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    let fresh = await loadInstanceWithContainers(db, session.tenantId, id);
    if (!fresh) {
      return c.json({ error: "Not found" }, 404);
    }

    // MCP 服务器（含远程 HTTP）访问详情时自动启动，避免长期 stopped 无法看工具
    if (
      fresh.providerId !== "web-search" &&
      fresh.providerId !== "web-fetch" &&
      fresh.status !== "running" &&
      fresh.status !== "starting"
    ) {
      try {
        await orchestrator.ensureStarted(session.tenantId, id);
        fresh =
          (await loadInstanceWithContainers(db, session.tenantId, id)) ?? fresh;
      } catch {
        /* 保持当前状态，下方仍返回实例信息 */
      }
    }

    let handle: Awaited<ReturnType<typeof orchestrator.toHandle>> | null = null;
    let decryptError: string | null = null;
    try {
      handle = await orchestrator.toHandle(session.tenantId, id);
    } catch (err) {
      decryptError = err instanceof Error ? err.message : String(err);
    }

    const safeConfig: Record<string, unknown> = handle
      ? Object.fromEntries(
          Object.entries(handle.config).map(([key, value]) => [
            key,
            redactConfigValue(key, value),
          ]),
        )
      : {};
    let tools: Awaited<ReturnType<typeof gateway.listToolsForTenant>> = [];
    let resources: Array<{
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
      title?: string;
    }> = [];
    let prompts: Array<{
      name: string;
      description?: string;
      title?: string;
      arguments?: Array<{ name: string; description?: string; required?: boolean }>;
    }> = [];
    let resourceTemplates: Array<{
      uriTemplate: string;
      name: string;
      description?: string;
      mimeType?: string;
      title?: string;
    }> = [];
    let toolPermissions: ReturnType<typeof resolveToolPermissionStates> | undefined;
    if (fresh.status === "running" && handle) {
      const plugin = globalRegistry.get(fresh.providerId);
      try {
        const defs = await plugin.listTools(handle);
        tools = defs.map((t) => ({
          qualifiedName: `re_${fresh.slug}__${t.name}`,
          instanceId: fresh.id,
          providerId: fresh.providerId,
          localName: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      } catch {
        tools = [];
      }
      if (typeof plugin.listResources === "function") {
        try {
          const listed = await plugin.listResources(handle);
          resources = listed.map((r) => ({
            uri: qualifyResourceUri(fresh.slug, r.uri),
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
            title: r.title,
          }));
        } catch {
          resources = [];
        }
      }
      if (typeof plugin.listPrompts === "function") {
        try {
          const listed = await plugin.listPrompts(handle);
          prompts = listed.map((p) => ({
            name: `re_${fresh.slug}__${p.name}`,
            description: p.description,
            title: p.title,
            arguments: p.arguments,
          }));
        } catch {
          prompts = [];
        }
      }
      if (typeof plugin.listResourceTemplates === "function") {
        try {
          const listed = await plugin.listResourceTemplates(handle);
          resourceTemplates = listed.map((t) => ({
            uriTemplate: qualifyResourceUri(fresh.slug, t.uriTemplate),
            name: t.name,
            description: t.description,
            mimeType: t.mimeType,
            title: t.title,
          }));
        } catch {
          resourceTemplates = [];
        }
      }
    }
    if (fresh.providerId === "google-workspace" && handle) {
      try {
        const product = resolveGoogleWorkspaceProduct(
          typeof handle.config.product === "string"
            ? handle.config.product
            : typeof handle.config.mcpUrl === "string"
              ? handle.config.mcpUrl
              : "",
        );
        if (product) {
          toolPermissions = resolveToolPermissionStates(product, handle.config);
        }
      } catch {
        /* ignore */
      }
    }
    return c.json({
      ...fresh,
      config: safeConfig,
      tools,
      resources,
      prompts,
      resourceTemplates,
      toolPermissions,
      lastError: decryptError ?? fresh.lastError,
    });
  });

  app.patch("/api/instances/:id", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    const existing = await db.query.componentInstances.findFirst({
      where: and(eq(componentInstances.id, id), eq(componentInstances.tenantId, session.tenantId)),
    });
    if (!existing) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json<{
      name?: string;
      config?: Record<string, unknown>;
      replaceConfig?: boolean;
    }>();
    if (body.name?.trim()) {
      await db
        .update(componentInstances)
        .set({ name: body.name.trim(), updatedAt: new Date() })
        .where(eq(componentInstances.id, id));
    }
    if (body.config) {
      // Don't overwrite secrets with "***" placeholders from UI
      const cleaned = { ...body.config };
      for (const [k, v] of Object.entries(cleaned)) {
        if (v === "***") delete cleaned[k];
      }
      await orchestrator.updateInstanceConfig(session.tenantId, id, cleaned, {
        replace: body.replaceConfig === true,
      });
    }
    return c.json(await loadInstanceWithContainers(db, session.tenantId, id));
  });

  app.get("/api/instances/:id/runtime", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    const instance = await db.query.componentInstances.findFirst({
      where: and(eq(componentInstances.id, id), eq(componentInstances.tenantId, session.tenantId)),
    });
    if (!instance) return c.json({ error: "Not found" }, 404);
    const rows = await db
      .select()
      .from(managedContainers)
      .where(and(eq(managedContainers.instanceId, id), eq(managedContainers.tenantId, session.tenantId)));
    let live: Awaited<ReturnType<DockerRuntime["list"]>> = [];
    try {
      live = await runtime.list({ tenantId: session.tenantId, instanceId: id });
    } catch {
      // Keep the persisted container state visible when Docker is unavailable.
    }
    const byDockerId = new Map(live.map((item) => [item.id, item]));
    return c.json({
      containers: rows.map((row) => ({
        id: row.id,
        runtime: row.dockerId ? byDockerId.get(row.dockerId) ?? null : null,
      })),
    });
  });

  app.get("/api/instances/:id/containers/:containerId/logs", async (c) => {
    const session = c.get("session")!;
    const row = await db.query.managedContainers.findFirst({
      where: and(
        eq(managedContainers.id, c.req.param("containerId")),
        eq(managedContainers.instanceId, c.req.param("id")),
        eq(managedContainers.tenantId, session.tenantId),
      ),
    });
    if (!row) return c.json({ error: "Not found" }, 404);
    if (!row.dockerId) return c.json({ logs: "" });
    try {
      const tail = Math.min(1000, Math.max(1, Number(c.req.query("tail") ?? 200)));
      return c.json({ logs: await runtime.logs(row.dockerId, tail) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/containers", async (c) => {
    const session = c.get("session")!;
    const rows = await db
      .select()
      .from(managedContainers)
      .where(eq(managedContainers.tenantId, session.tenantId))
      .orderBy(desc(managedContainers.createdAt));

    // Live Docker sync only on ?sync=1 (throttled). Default serves DB state.
    const syncLive = c.req.query("sync") === "1";
    if (!syncLive) {
      return c.json(rows);
    }

    const syncKey = session.tenantId;
    const prev = containerListSyncAt.get(syncKey) ?? 0;
    if (Date.now() - prev < CONTAINER_LIST_SYNC_TTL_MS) {
      return c.json(rows);
    }
    containerListSyncAt.set(syncKey, Date.now());

    const synced = [];
    for (const row of rows) {
      if (!row.dockerId || row.status === "removed") {
        synced.push(row);
        continue;
      }
      try {
        const live = await runtime.inspect(row.dockerId);
        if (!live) {
          const [updated] = await db
            .update(managedContainers)
            .set({ status: "exited", dockerId: null, updatedAt: new Date() })
            .where(eq(managedContainers.id, row.id))
            .returning();
          synced.push(updated ?? { ...row, status: "exited", dockerId: null });
        } else if (live.status !== row.status) {
          const [updated] = await db
            .update(managedContainers)
            .set({
              status: live.status,
              portsJson: JSON.stringify(live.ports),
              updatedAt: new Date(),
            })
            .where(eq(managedContainers.id, row.id))
            .returning();
          synced.push(updated ?? { ...row, status: live.status });
        } else {
          synced.push(row);
        }
      } catch {
        synced.push(row);
      }
    }
    return c.json(synced);
  });

  app.post("/api/containers/allocate", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      image: string;
      name?: string;
      purpose?: "workspace" | "ephemeral";
      allocatedTo?: string;
      env?: Record<string, string>;
      command?: string[];
    }>();
    try {
      const row = await orchestrator.allocateContainer({
        tenantId: session.tenantId,
        ...body,
      });
      return c.json(row, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/containers/:id/stop", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    const body = await c.req.json<{ remove?: boolean }>().catch(() => ({ remove: true }));
    const row = await db.query.managedContainers.findFirst({
      where: and(eq(managedContainers.id, id), eq(managedContainers.tenantId, session.tenantId)),
    });
    if (!row) return c.json({ error: "Not found" }, 404);
    try {
      if (row.dockerId) {
        await runtime.stop(row.dockerId);
        if (body.remove !== false) {
          await runtime.remove(row.dockerId, true);
          await db
            .update(managedContainers)
            .set({ status: "removed", dockerId: null, updatedAt: new Date() })
            .where(eq(managedContainers.id, row.id));
        } else {
          await db
            .update(managedContainers)
            .set({ status: "exited", updatedAt: new Date() })
            .where(eq(managedContainers.id, row.id));
        }
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Agents (multi-agent isolated tool spaces) ──────────────────────────
  app.get("/api/agents", async (c) => {
    const session = c.get("session")!;
    const rows = await agentService.list(session.tenantId);
    const serialized = await Promise.all(
      rows.map(async (a) => {
        const container = await agentService.workspace.getWorkspaceContainer(a.id);
        return agentService.serialize(a, {
          workspace: container
            ? {
                status: container.status,
                dockerId: container.dockerId,
                image: container.image,
              }
            : null,
        });
      }),
    );
    return c.json(serialized);
  });

  app.post("/api/agents", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name: string;
      description?: string;
      workspaceImage?: string | null;
      config?: Record<string, unknown>;
      createApiKey?: boolean;
    }>();
    if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
    try {
      let result = await agentService.create(session.tenantId, body);
      // 无鉴权官方 MCP（如 Grep）：安装到租户并绑定到新 Agent
      try {
        const agent = await agentService.ensureDefaultMcpBindings(
          session.tenantId,
          result.agent,
          orchestrator,
        );
        result = { ...result, agent };
      } catch (err) {
        console.warn(
          "[api] default MCP auto-install failed:",
          err instanceof Error ? err.message : err,
        );
      }
      return c.json(
        {
          ...agentService.serialize(result.agent),
          starting: false,
          apiKey: result.apiKey,
          mcpAgentUrl: result.mcpAgentUrl,
        },
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/agents/:id", async (c) => {
    const session = c.get("session")!;
    try {
      const agent = await agentService.get(session.tenantId, c.req.param("id"));
      if (!agent) return c.json({ error: "Not found" }, 404);

      let tools: Array<{
        name: string;
        description: string;
        agentScoped: boolean;
        providerId?: string;
        inputSchema?: Record<string, unknown>;
      }> = [];
      let resources: Array<{
        uri: string;
        name: string;
        description?: string;
        mimeType?: string;
        title?: string;
        providerId?: string;
      }> = [];
      let prompts: Array<{
        name: string;
        description?: string;
        title?: string;
        arguments?: Array<{ name: string; description?: string; required?: boolean }>;
        providerId?: string;
      }> = [];
      let resourceTemplates: Array<{
        uriTemplate: string;
        name: string;
        description?: string;
        mimeType?: string;
        title?: string;
        providerId?: string;
      }> = [];
      try {
        const listed = await gateway.listToolsForAgent(agent);
        tools = listed.map((t) => ({
          name: t.qualifiedName,
          description: t.description,
          agentScoped: Boolean(t.agentScoped),
          providerId: t.providerId,
          inputSchema: t.inputSchema,
        }));
      } catch (err) {
        console.warn(`[api] listToolsForAgent ${agent.slug}:`, err);
      }
      try {
        const listed = await gateway.listResourcesForAgent(agent);
        resources = listed.map((r) => ({
          uri: r.qualifiedUri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
          title: r.title,
          providerId: r.providerId,
        }));
      } catch (err) {
        console.warn(`[api] listResourcesForAgent ${agent.slug}:`, err);
      }
      try {
        const listed = await gateway.listPromptsForAgent(agent);
        prompts = listed.map((p) => ({
          name: p.qualifiedName,
          description: p.description,
          title: p.title,
          arguments: p.arguments,
          providerId: p.providerId,
        }));
      } catch (err) {
        console.warn(`[api] listPromptsForAgent ${agent.slug}:`, err);
      }
      try {
        const listed = await gateway.listResourceTemplatesForAgent(agent);
        resourceTemplates = listed.map((t) => ({
          uriTemplate: t.qualifiedUriTemplate,
          name: t.name,
          description: t.description,
          mimeType: t.mimeType,
          title: t.title,
          providerId: t.providerId,
        }));
      } catch (err) {
        console.warn(`[api] listResourceTemplatesForAgent ${agent.slug}:`, err);
      }

      const container = await agentService.workspace.getWorkspaceContainer(agent.id);
      let desktop: Awaited<ReturnType<typeof agentService.workspace.getDesktopInfo>>;
      try {
        desktop = await agentService.workspace.getDesktopInfo(agent);
      } catch (err) {
        console.warn(`[api] getDesktopInfo ${agent.slug}:`, err);
        desktop = {
          enabled: false,
          computer: false,
          browser: false,
          containerStatus: container?.status ?? null,
          dockerId: container?.dockerId ?? null,
          novncUrl: null,
          novncPort: null,
          cdpUrl: null,
          cdpPort: null,
          vncPort: null,
          width: 1280,
          height: 720,
        };
      }

      return c.json({
        ...agentService.serialize(agent, {
          workspace: container
            ? {
                status: container.status,
                dockerId: container.dockerId,
                image: container.image,
              }
            : null,
        }),
        tools,
        resources,
        prompts,
        resourceTemplates,
        workspaceContainer: container,
        desktop,
      });
    } catch (err) {
      console.error("[api] GET /api/agents/:id", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/agents/:id/desktop", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    return c.json(await agentService.workspace.getDesktopInfo(agent));
  });

  app.patch("/api/agents/:id", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      description?: string;
      enableComputer?: boolean;
      enableMemory?: boolean;
      memoryProviderId?: string | null;
      workspaceImage?: string | null;
      runtimeNodeId?: string | null;
      config?: Record<string, unknown>;
      restart?: boolean;
    }>();
    try {
      const agent = await agentService.update(session.tenantId, c.req.param("id"), {
        ...body,
        userId: session.userId,
      });
      return c.json(agentService.serialize(agent));
    } catch (err) {
      const status = err && typeof err === "object" && "status" in err
        ? Number((err as { status: number }).status) || 400
        : 400;
      return c.json({ error: err instanceof Error ? err.message : String(err) }, status as 400);
    }
  });

  app.delete("/api/agents/:id", async (c) => {
    const session = c.get("session")!;
    const purge = c.req.query("purge") === "1" || c.req.query("purge") === "true";
    try {
      await agentService.remove(session.tenantId, c.req.param("id"), { purgeData: purge });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/start", async (c) => {
    const session = c.get("session")!;
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        runtimeNodeId?: string | null;
      };
      const agent = await agentService.startAsync(session.tenantId, c.req.param("id"), {
        ...(Object.prototype.hasOwnProperty.call(body, "runtimeNodeId")
          ? { runtimeNodeId: body.runtimeNodeId ?? null }
          : {}),
        userId: session.userId,
      });
      const container = await agentService.workspace.getWorkspaceContainer(agent.id);
      return c.json({
        ...agentService.serialize(agent, {
          workspace: container
            ? {
                status: container?.status ?? "starting",
                dockerId: container.dockerId,
                image: container.image,
              }
            : { status: "starting", dockerId: null },
        }),
        starting: true,
      });
    } catch (err) {
      const status =
        err && typeof err === "object" && "status" in err
          ? Number((err as { status: number }).status) || 500
          : 500;
      return c.json({ error: err instanceof Error ? err.message : String(err) }, status as 500);
    }
  });

  app.get("/api/agents/:id/progress", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const { getAgentProgress } = await import("../services/agent-progress.js");
    const container = await agentService.workspace.getWorkspaceContainer(agent.id);
    const progress = getAgentProgress(agent.id);
    const needsWs = agent.enableComputer;
    const workspaceStatus = progress.running
      ? "starting"
      : progress.error
        ? "error"
        : (container?.status ?? (needsWs ? "idle" : "none"));
    return c.json({
      agent: {
        id: agent.id,
        lastError: agent.lastError,
      },
      workspace: {
        status: workspaceStatus,
        dockerId: container?.dockerId ?? null,
        image: container?.image ?? agent.workspaceImage,
        running: container?.status === "running",
      },
      progress,
    });
  });

  app.post("/api/agents/:id/stop", async (c) => {
    const session = c.get("session")!;
    try {
      const agent = await agentService.stop(session.tenantId, c.req.param("id"));
      const container = await agentService.workspace.getWorkspaceContainer(agent.id);
      return c.json(
        agentService.serialize(agent, {
          workspace: container
            ? {
                status: container.status,
                dockerId: container.dockerId,
                image: container.image,
              }
            : { status: "stopped", dockerId: null },
        }),
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/agents/:id/bindings", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    return c.json(await agentService.listBindings(agent.id));
  });

  app.post("/api/agents/:id/bindings", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ instanceId: string }>();
    if (!body.instanceId) return c.json({ error: "instanceId required" }, 400);
    try {
      const row = await agentService.bindInstance(
        session.tenantId,
        c.req.param("id"),
        body.instanceId,
      );
      return c.json(row, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/agents/:id/bindings/:instanceId", async (c) => {
    const session = c.get("session")!;
    try {
      await agentService.unbindInstance(
        session.tenantId,
        c.req.param("id"),
        c.req.param("instanceId"),
      );
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Per-agent provider selections (search/fetch/MCP bindings) */
  app.get("/api/agents/:id/providers", async (c) => {
    const session = c.get("session")!;
    try {
      return c.json(
        await agentService.getProviderOptions(session.tenantId, c.req.param("id"), orchestrator),
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.put("/api/agents/:id/providers", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      webSearch?: { enabled?: boolean; defaultEngine?: string | null };
      webFetch?: { enabled?: boolean; defaultBackend?: string | null };
      mcp?: { mode?: "all" | "selected"; instanceIds?: string[]; exposeWorkspaceFs?: boolean };
      enableMemory?: boolean;
      memoryProviderId?: string | null;
    }>();
    try {
      const patch: {
        webSearch?: { enabled?: boolean; defaultEngine?: string };
        webFetch?: { enabled?: boolean; defaultBackend?: string };
        mcp?: { mode?: "all" | "selected"; instanceIds?: string[]; exposeWorkspaceFs?: boolean };
      } = {};

      if (body.webSearch) {
        patch.webSearch = {};
        if (typeof body.webSearch.enabled === "boolean") {
          patch.webSearch.enabled = body.webSearch.enabled;
        }
        if ("defaultEngine" in body.webSearch) {
          patch.webSearch.defaultEngine =
            body.webSearch.defaultEngine === null ? "" : (body.webSearch.defaultEngine ?? "");
        }
      }
      if (body.webFetch) {
        patch.webFetch = {};
        if (typeof body.webFetch.enabled === "boolean") {
          patch.webFetch.enabled = body.webFetch.enabled;
        }
        if ("defaultBackend" in body.webFetch) {
          patch.webFetch.defaultBackend =
            body.webFetch.defaultBackend === null ? "" : (body.webFetch.defaultBackend ?? "");
        }
      }
      if (body.mcp) patch.mcp = body.mcp;

      let agent = await agentService.updateProviders(session.tenantId, c.req.param("id"), patch);

      if (typeof body.enableMemory === "boolean" || body.memoryProviderId !== undefined) {
        agent = await agentService.update(session.tenantId, agent.id, {
          ...(typeof body.enableMemory === "boolean"
            ? { enableMemory: body.enableMemory }
            : {}),
          ...(body.memoryProviderId !== undefined
            ? { memoryProviderId: body.memoryProviderId }
            : {}),
        });
      }

      // 显式启用能力时再启动对应租户实例
      if (body.webSearch?.enabled === true) {
        await ensureCapabilityInstance(db, orchestrator, session.tenantId, "web-search", {
          start: true,
        });
      }
      if (body.webFetch?.enabled === true) {
        await ensureCapabilityInstance(db, orchestrator, session.tenantId, "web-fetch", {
          start: true,
        });
      }
      if (body.enableMemory === true) {
        await memoryProviders.ensureDefault(session.tenantId);
      }

      return c.json({
        ...agentService.serialize(agent),
        options: await agentService.getProviderOptions(session.tenantId, agent.id, orchestrator),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/keys", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
    try {
      const key = await agentService.createAgentApiKey(
        session.tenantId,
        c.req.param("id"),
        body.name,
      );
      return c.json(key, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── Per-agent memory (data isolated by agentId) ───────────────────────
  app.get("/api/agents/:id/memory", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const [stats, providers, resolved] = await Promise.all([
      memoryStore.stats(session.tenantId, agent.id),
      memoryProviders.list(session.tenantId),
      resolveAgentMemory(memoryProviders, agent),
    ]);
    let embedding: {
      enabled: boolean;
      model: string | null;
      stats: Awaited<ReturnType<typeof memoryStore.embeddingStats>>;
    } | null = null;
    if (resolved?.kind === "builtin") {
      const emb = (await import("../services/embedding-client.js")).parseEmbeddingConfig(
        resolved.config,
      );
      const embStats = await memoryStore.embeddingStats(session.tenantId, agent.id);
      embedding = {
        enabled: Boolean(emb),
        model: emb?.model ?? null,
        stats: embStats,
      };
    }
    return c.json({
      enabled: agent.enableMemory,
      memoryProviderId: agent.memoryProviderId,
      provider: resolved
        ? {
            id: resolved.provider.id,
            name: resolved.provider.name,
            kind: resolved.kind,
            config: resolved.config,
            storesLocally: resolved.storesLocally,
          }
        : null,
      providers,
      layers: MEMORY_LAYERS,
      stats,
      embedding,
    });
  });

  app.get("/api/agents/:id/memory/items", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const items = await memoryStore.list(session.tenantId, agent.id, {
      q: c.req.query("q") ?? undefined,
      layer: c.req.query("layer") ?? undefined,
      userId: c.req.query("userId") ?? undefined,
      pinned:
        c.req.query("pinned") === "1" || c.req.query("pinned") === "true"
          ? true
          : undefined,
      limit: Number(c.req.query("limit") ?? 50) || 50,
      offset: Number(c.req.query("offset") ?? 0) || 0,
    });
    return c.json({ items, layers: MEMORY_LAYERS });
  });

  app.get("/api/agents/:id/memory/search", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const q = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit") ?? 10) || 10;
    const results = await memoryStore.search(session.tenantId, agent.id, q, limit);
    return c.json({ results });
  });

  app.post("/api/agents/:id/memory/items", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json<{
      content: string;
      layer?: string;
      tags?: string[];
      pinned?: boolean;
      importance?: number;
      userId?: string;
    }>();
    try {
      const resolved = await resolveAgentMemory(memoryProviders, agent);
      const { withEmbedding } = await import("../services/memory-embed.js");
      const base = {
        content: body.content,
        layer: body.layer ?? (resolved?.kind === "traditional" ? "note" : "fact"),
        tags: body.tags,
        pinned: body.pinned,
        importance: body.importance,
        userId: body.userId,
        source: "manual" as const,
        providerId: resolved?.provider.id ?? agent.memoryProviderId,
      };
      const { input, embeddingError } = await withEmbedding(
        base,
        resolved?.kind === "builtin" ? resolved.config : null,
        { tenantId: session.tenantId, modelRouter },
      );
      const item = await memoryStore.add(session.tenantId, agent.id, input);
      return c.json(
        { ...item, ...(embeddingError ? { embeddingWarning: embeddingError } : {}) },
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/agents/:id/memory/reembed", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    try {
      const resolved = await resolveAgentMemory(memoryProviders, agent);
      if (!resolved || resolved.kind !== "builtin") {
        return c.json({ error: "仅 Built-in Provider 支持本地向量重建" }, 400);
      }
      const { parseEmbeddingConfig, reembedAgentMemories } = await import(
        "../services/memory-embed.js"
      );
      const cfg = parseEmbeddingConfig(resolved.config);
      if (!cfg) {
        return c.json({ error: "请先在记忆 Provider 中启用 embedding，并配置路由或 baseUrl/model" }, 400);
      }
      const result = await reembedAgentMemories(
        memoryStore,
        session.tenantId,
        agent.id,
        cfg,
        { limit: 100, modelRouter },
      );
      const stats = await memoryStore.embeddingStats(session.tenantId, agent.id);
      return c.json({ ...result, stats });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/agents/:id/memory/embedding-stats", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const resolved = await resolveAgentMemory(memoryProviders, agent);
    const emb =
      resolved?.kind === "builtin"
        ? (await import("../services/embedding-client.js")).parseEmbeddingConfig(
            resolved.config,
          )
        : null;
    const stats = await memoryStore.embeddingStats(session.tenantId, agent.id);
    return c.json({
      enabled: Boolean(emb),
      model: emb?.model ?? null,
      baseUrl: emb?.baseUrl ?? null,
      stats,
    });
  });

  app.get("/api/agents/:id/memory/graph", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    return c.json(await memoryStore.graph(session.tenantId, agent.id));
  });

  app.post("/api/agents/:id/memory/edges", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json<{
      fromId: string;
      toId: string;
      relation?: string;
    }>();
    try {
      const edge = await memoryStore.link(
        session.tenantId,
        agent.id,
        body.fromId,
        body.toId,
        body.relation ?? "related",
      );
      return c.json(edge, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/agents/:id/memory/edges/:edgeId", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    await memoryStore.unlink(session.tenantId, agent.id, c.req.param("edgeId"));
    return c.json({ ok: true });
  });

  app.patch("/api/agents/:id/memory/items/:memId", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json<Record<string, unknown>>();
    try {
      const resolved = await resolveAgentMemory(memoryProviders, agent);
      const patch: {
        content?: string;
        layer?: string;
        tags?: string[];
        pinned?: boolean;
        importance?: number;
        userId?: string;
        embedding?: number[] | null;
        embeddingModel?: string | null;
      } = {
        content: typeof body.content === "string" ? body.content : undefined,
        layer: typeof body.layer === "string" ? body.layer : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
        importance: typeof body.importance === "number" ? body.importance : undefined,
        userId: typeof body.userId === "string" ? body.userId : undefined,
      };
      let embeddingWarning: string | undefined;
      if (typeof body.content === "string" && resolved?.kind === "builtin") {
        const { withEmbedding } = await import("../services/memory-embed.js");
        const { input, embeddingError } = await withEmbedding(
          { content: body.content },
          resolved.config,
          { tenantId: session.tenantId, modelRouter },
        );
        if (input.embedding) {
          patch.embedding = input.embedding;
          patch.embeddingModel = input.embeddingModel;
        }
        embeddingWarning = embeddingError;
      }
      const item = await memoryStore.update(
        session.tenantId,
        agent.id,
        c.req.param("memId"),
        patch,
      );
      return c.json({
        ...item,
        ...(embeddingWarning ? { embeddingWarning } : {}),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/agents/:id/memory/items/:memId", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    try {
      await memoryStore.remove(session.tenantId, agent.id, c.req.param("memId"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/agents/:id/memory", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const layer = c.req.query("layer") ?? undefined;
    await memoryStore.clear(session.tenantId, agent.id, layer);
    return c.json({ ok: true });
  });

  // Agent workspace filesystem — routes via WorkspaceFsProvider (local or remote)
  if (workspaceFsProvider) {
    registerAgentFsRoutes(app, agentService, workspaceFsProvider);
    if (fileShares) {
      registerFileShareRoutes(app, fileShares, agentService, workspaceFsProvider);
    }
  }

  if (modelRouter && modelUpstreams && modelRoutes) {
    registerModelRouterRoutes(app, {
      upstreams: modelUpstreams,
      routes: modelRoutes,
      router: modelRouter,
      catalog: modelCatalog,
      upstreamModels,
    });
  }

  /**
   * 平台事件（SSE）：MCP 实例状态与安装进度、Agent 工作区进度、
   * Runner 心跳、工作区文件变更。瞬态信号不落库；断线重连后
   * 前端应重新拉一次对应快照接口对齐状态。
   */
  app.get("/api/events", async (c) => {
    const session = c.get("session")!;
    const tenantId = session.tenantId;
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch {
            /* stream closed */
          }
        };
        send("ready", { ts: Date.now() });
        unsubscribe = platformEvents.subscribe(tenantId, (ev) => send("platform", ev));
        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            /* ignore */
          }
        }, 15_000);
      },
      cancel() {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // Cloud Agent：持久会话 + MCP 工具注入推理循环
  {
    const cloudStore = new CloudAgentSessionStore(db);
    // 进程重启会丢掉内存中的 agent loop：把 DB 里仍标记运行中的 Run 收尾，
    // 否则这些会话在 UI 上会永远显示「进行中」且无法发送新消息
    void cloudStore
      .recoverInterruptedRuns()
      .then((n) => {
        if (n > 0) console.log(`[cloud-agent] recovered ${n} interrupted run(s)`);
      })
      .catch((err) => console.warn("[cloud-agent] recover interrupted runs failed:", err));
    if (modelRouter) {
      const { AgentHooksService } = await import("../services/agent-hooks.js");
      const agentHooks = new AgentHooksService(agentService.workspace);
      const cloudRuntime = new CloudAgentRuntime({
        store: cloudStore,
        gateway,
        modelRouter,
        agentService,
        memoryStore,
        memoryProviders,
        workspaceFsProvider,
        skills,
        agentHooks,
      });
      // MCP 客户端可经 re_spawn_subagent 在云端运行子代理
      gateway.setSubagentRunner({
        run: (tenantId, agent, args, opts) =>
          cloudRuntime.runSubagent(tenantId, agent, args, opts),
      });
      registerCloudAgentRoutes(app, {
        agentService,
        store: cloudStore,
        runtime: cloudRuntime,
        modelRouter,
      });
    } else {
      // 无模型路由：注册只读会话 API，发消息时返回明确错误
      registerCloudAgentRoutes(app, {
        agentService,
        store: cloudStore,
        runtime: {
          startTurn: async () => {
            throw new Error("模型路由未启用，请先配置 chat 上游");
          },
        },
        modelRouter,
      });
    }
  }

  registerTenantRoutes(app, {
    db,
    config,
    tenants: tenantService,
    agentService,
    memoryProviders,
    orchestrator,
    runtimeNodes,
    networkSettings,
  });

  if (config.edition === "saas") {
    const saas = await loadSaasServer();
    if (saas) {
      saas.registerSaasRoutes(app, {
        db,
        config: {
          secret: config.secret,
          webPublicUrl: config.webPublicUrl,
          multiTenant: true,
          edition: "saas",
        },
        encryptJson,
        decryptJson,
        tenants: tenantService,
        signSession,
        sessionFromLogin,
        switchTenantSession,
        isSessionAdmin,
        ensurePlatformMeta,
        schema: {
          users,
          tenants,
          tenantMemberships,
          oauthIdentities,
          oauthLoginStates,
          settings,
          newId,
        },
        onTenantCreated: async (tenantId: string) => {
          await runtimeNodes?.ensureLocalNode(tenantId).catch(() => undefined);
          await networkSettings?.ensureTenantDefaults(tenantId).catch(() => undefined);
          const defaults = await getAgentWebDefaults(db);
          const services = platformServices
            ? (await platformServices.list()).filter((s) => s.mode !== "disabled")
            : [];
          await syncPlatformManagedWebDefaults(db, orchestrator, config, tenantId, defaults, services);
        },
        runtimeNodes: runtimeNodes
          ? {
              listAllRemote: () => runtimeNodes.listAllRemote(),
              setShared: (
                nodeId: string,
                isShared: boolean,
                actor: { userId: string; isPlatformAdmin: boolean },
              ) => runtimeNodes.setShared(nodeId, isShared, actor),
            }
          : undefined,
        agentDefaults: {
          get: () => getAgentWebDefaults(db),
          save: (value: Record<string, unknown>) => saveAgentWebDefaults(db, value),
          enableForUser: (userId: string) => enableWebForUserAgents(db, orchestrator, userId),
          syncManaged: async () => {
            const defaults = await getAgentWebDefaults(db);
            const serviceList = platformServices
              ? (await platformServices.list()).filter((s) => s.mode !== "disabled")
              : [];
            const allTenants = await db.select({ id: tenants.id }).from(tenants);
            for (const tenant of allTenants) {
              await syncPlatformManagedWebDefaults(
                db,
                orchestrator,
                config,
                tenant.id,
                defaults,
                serviceList,
              );
            }
            return { tenants: allTenants.length };
          },
        },
      });
    }
  }

  if (runtimeNodes) {
    registerRuntimeNodeRoutes(app, {
      nodes: runtimeNodes,
      db,
      config,
      network: networkSettings,
      orchestrator,
      runtime,
    });
  }
  if (migrations) {
    registerMigrationRoutes(app, { migrations, agentService });
  }
  if (skills) {
    registerSkillRoutes(app, { skills, agentService, multiTenant: config.multiTenant });
  }
  if (connections) {
    const mcpStoreForConnections = new McpStoreService(db, config);
    registerConnectionRoutes(app, {
      config,
      connections,
      mcpStore: mcpStoreForConnections,
      orchestrator,
      instanceMigrations: instanceMigrations ?? null,
    });
  }
  if (networkSettings && securityPolicy && exposures && networkAudit) {
    registerNetworkRoutes(app, {
      network: networkSettings,
      security: securityPolicy,
      exposures,
      audit: networkAudit,
      agentService,
      config,
    });
  }

  // ── Tool call tracking ────────────────────────────────────────────────
  function parseToolCallFilters(c: {
    req: { query: (k: string) => string | undefined };
  }, forcedAgentId?: string) {
    const sinceRaw = c.req.query("since");
    const untilRaw = c.req.query("until");
    const errRaw = c.req.query("isError");
    return {
      agentId: forcedAgentId ?? c.req.query("agentId") ?? undefined,
      apiKeyId: c.req.query("apiKeyId") ?? undefined,
      q: c.req.query("q") ?? undefined,
      isError:
        errRaw === "1" || errRaw === "true"
          ? true
          : errRaw === "0" || errRaw === "false"
            ? false
            : undefined,
      since: sinceRaw ? new Date(sinceRaw) : undefined,
      until: untilRaw ? new Date(untilRaw) : undefined,
      limit: Number(c.req.query("limit") ?? 50) || 50,
      offset: Number(c.req.query("offset") ?? 0) || 0,
    };
  }

  app.get("/api/tool-calls", async (c) => {
    const session = c.get("session")!;
    const filters = parseToolCallFilters(c);
    const result = await toolCallStore.list(session.tenantId, filters);
    return c.json(result);
  });

  app.get("/api/tool-calls/stats", async (c) => {
    const session = c.get("session")!;
    const agentId = c.req.query("agentId") ?? undefined;
    const stats = await toolCallStore.stats(session.tenantId, agentId);
    return c.json(stats);
  });

  app.get("/api/tool-calls/:id", async (c) => {
    const session = c.get("session")!;
    const item = await toolCallStore.get(session.tenantId, c.req.param("id"));
    if (!item) return c.json({ error: "Not found" }, 404);
    return c.json(item);
  });

  app.get("/api/agents/:id/tool-calls", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const filters = parseToolCallFilters(c, agent.id);
    const result = await toolCallStore.list(session.tenantId, filters);
    return c.json(result);
  });

  app.get("/api/agents/:id/tool-calls/stats", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const stats = await toolCallStore.stats(session.tenantId, agent.id);
    return c.json(stats);
  });

  app.get("/api/api-keys", async (c) => {
    const session = c.get("session")!;
    const rows = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        agentId: apiKeys.agentId,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, session.tenantId))
      .orderBy(desc(apiKeys.createdAt));
    return c.json(rows);
  });

  app.post("/api/api-keys", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ name: string; agentId?: string | null }>();
    if (body.agentId) {
      const agent = await agentService.get(session.tenantId, body.agentId);
      if (!agent) return c.json({ error: "agent not found" }, 400);
      const key = await agentService.createAgentApiKey(
        session.tenantId,
        agent.id,
        body.name,
      );
      return c.json(key, 201);
    }
    const key = generateApiKey();
    const now = new Date();
    const [row] = await db
      .insert(apiKeys)
      .values({
        id: newId(),
        tenantId: session.tenantId,
        name: body.name || "default",
        keyHash: key.hash,
        keyPrefix: key.prefix,
        createdAt: now,
      })
      .returning();
    await db.insert(mcpPolicies).values({
      id: newId(),
      tenantId: session.tenantId,
      apiKeyId: row.id,
      instanceIds: "[]",
        includeBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ ...row, rawKey: key.raw }, 201);
  });

  app.get("/api/mcp/tools", async (c) => {
    const session = c.get("session")!;
    const tools = await gateway.listToolsForTenant(session.tenantId);
    return c.json(tools);
  });

  /** 策略页首屏：policies + api-keys + instances 一次返回 */
  app.get("/api/mcp/policies/bootstrap", async (c) => {
    const session = c.get("session")!;
    const [policyRows, keyRows, instanceRows] = await Promise.all([
      db
        .select()
        .from(mcpPolicies)
        .where(eq(mcpPolicies.tenantId, session.tenantId))
        .orderBy(desc(mcpPolicies.createdAt)),
      db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
        })
        .from(apiKeys)
        .where(eq(apiKeys.tenantId, session.tenantId))
        .orderBy(desc(apiKeys.createdAt)),
      db
        .select({
          id: componentInstances.id,
          name: componentInstances.name,
          slug: componentInstances.slug,
        })
        .from(componentInstances)
        .where(eq(componentInstances.tenantId, session.tenantId))
        .orderBy(desc(componentInstances.createdAt)),
    ]);
    const keyIds = [
      ...new Set(
        policyRows.map((r) => r.apiKeyId).filter((id): id is string => id != null),
      ),
    ];
    const policyKeys =
      keyIds.length > 0
        ? await db
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              keyPrefix: apiKeys.keyPrefix,
            })
            .from(apiKeys)
            .where(inArray(apiKeys.id, keyIds))
        : [];
    const keyMap = new Map(policyKeys.map((k) => [k.id, k]));
    return c.json({
      policies: policyRows.map((r) =>
        mapPolicy(r, r.apiKeyId ? (keyMap.get(r.apiKeyId) ?? null) : null, {
          timestamps: true,
        }),
      ),
      apiKeys: keyRows,
      instances: instanceRows,
    });
  });

  app.get("/api/mcp/policies", async (c) => {
    const session = c.get("session")!;
    const rows = await db
      .select()
      .from(mcpPolicies)
      .where(eq(mcpPolicies.tenantId, session.tenantId))
      .orderBy(desc(mcpPolicies.createdAt));

    const keyIds = [
      ...new Set(rows.map((r) => r.apiKeyId).filter((id): id is string => id != null)),
    ];
    const keys =
      keyIds.length > 0
        ? await db
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              keyPrefix: apiKeys.keyPrefix,
            })
            .from(apiKeys)
            .where(inArray(apiKeys.id, keyIds))
        : [];
    const keyMap = new Map(keys.map((k) => [k.id, k]));

    return c.json(
      rows.map((r) =>
        mapPolicy(r, r.apiKeyId ? (keyMap.get(r.apiKeyId) ?? null) : null, {
          timestamps: true,
        }),
      ),
    );
  });

  app.post("/api/mcp/policies", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      apiKeyId?: string | null;
      instanceIds?: string[];
      toolAllowlist?: string[] | null;
      toolDenylist?: string[] | null;
      includeBuiltin?: boolean;
    }>();

    if (body.apiKeyId) {
      const key = await db.query.apiKeys.findFirst({
        where: and(eq(apiKeys.id, body.apiKeyId), eq(apiKeys.tenantId, session.tenantId)),
      });
      if (!key) return c.json({ error: "apiKey not found" }, 400);
    }

    const now = new Date();
    const [row] = await db
      .insert(mcpPolicies)
      .values({
        id: newId(),
        tenantId: session.tenantId,
        apiKeyId: body.apiKeyId ?? null,
        instanceIds: JSON.stringify(body.instanceIds ?? []),
        toolAllowlist: body.toolAllowlist ? JSON.stringify(body.toolAllowlist) : null,
        toolDenylist: body.toolDenylist ? JSON.stringify(body.toolDenylist) : null,
        includeBuiltin: body.includeBuiltin ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const apiKey = row.apiKeyId
      ? ((
          await db
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              keyPrefix: apiKeys.keyPrefix,
            })
            .from(apiKeys)
            .where(eq(apiKeys.id, row.apiKeyId))
            .limit(1)
        )[0] ?? null)
      : null;

    return c.json(mapPolicy(row, apiKey), 201);
  });

  app.put("/api/mcp/policies/:id", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    const existing = await db.query.mcpPolicies.findFirst({
      where: and(eq(mcpPolicies.id, id), eq(mcpPolicies.tenantId, session.tenantId)),
    });
    if (!existing) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<{
      apiKeyId?: string | null;
      instanceIds?: string[];
      toolAllowlist?: string[] | null;
      toolDenylist?: string[] | null;
      includeBuiltin?: boolean;
    }>();

    const [row] = await db
      .update(mcpPolicies)
      .set({
        ...(body.apiKeyId !== undefined ? { apiKeyId: body.apiKeyId } : {}),
        ...(body.instanceIds !== undefined
          ? { instanceIds: JSON.stringify(body.instanceIds) }
          : {}),
        ...(body.toolAllowlist !== undefined
          ? {
              toolAllowlist: body.toolAllowlist
                ? JSON.stringify(body.toolAllowlist)
                : null,
            }
          : {}),
        ...(body.toolDenylist !== undefined
          ? {
              toolDenylist: body.toolDenylist ? JSON.stringify(body.toolDenylist) : null,
            }
          : {}),
        ...(body.includeBuiltin !== undefined
          ? { includeBuiltin: body.includeBuiltin }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(mcpPolicies.id, id))
      .returning();

    const apiKey = row.apiKeyId
      ? ((
          await db
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              keyPrefix: apiKeys.keyPrefix,
            })
            .from(apiKeys)
            .where(eq(apiKeys.id, row.apiKeyId))
            .limit(1)
        )[0] ?? null)
      : null;

    return c.json(mapPolicy(row, apiKey));
  });

  app.delete("/api/mcp/policies/:id", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    const existing = await db.query.mcpPolicies.findFirst({
      where: and(eq(mcpPolicies.id, id), eq(mcpPolicies.tenantId, session.tenantId)),
    });
    if (!existing) return c.json({ error: "Not found" }, 404);
    await db.delete(mcpPolicies).where(eq(mcpPolicies.id, id));
    return c.json({ ok: true });
  });

  /** Probe an upstream MCP without creating an instance */
  app.post("/api/mcp/probe", async (c) => {
    const body = await c.req.json<{
      mcpUrl: string;
      apiKey?: string;
      headerName?: string;
    }>();
    if (!body.mcpUrl) return c.json({ error: "mcpUrl required" }, 400);
    try {
      const { probeMcpTools } = await import("../lib/mcp-http.js");
      const tools = await probeMcpTools(body);
      return c.json({ ok: true, toolCount: tools.length, tools });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /** One-click import: external MCP, or a catalog-declared platform connector capability. */
  app.post("/api/mcp/import", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      mcpUrl: string;
      apiKey?: string;
      headerName?: string;
      name?: string;
      slug?: string;
      start?: boolean;
      /** none = probe & start; apiKey = use key; oauth = create + OAuth 2.1 */
      authMode?: "none" | "apiKey" | "oauth";
      /**
       * 用户自备 OAuth 客户端（Google/GitHub 要求 Client ID/Secret，不是 API Key）。
       * 提供后由本服务自动完成授权码流程。
       */
      oauthClientId?: string;
      oauthClientSecret?: string;
      oauthScopes?: string;
      /** 复用平台连接器 OAuth 客户端（与 hostPatterns / connector.ref 对齐） */
      oauthConnectorRef?: string;
    }>();
    if (!body.mcpUrl) return c.json({ error: "mcpUrl required" }, 400);

    const authMode = body.authMode ?? (body.apiKey?.trim() ? "apiKey" : "none");

    try {
      const connectorTarget = await integrationCatalog.resolveConnectorTarget(
        session.tenantId,
        body.mcpUrl,
      );
      const urlHost = (() => {
        if (connectorTarget) return connectorTarget.product;
        try {
          return new URL(body.mcpUrl).hostname.replace(/\./g, "-");
        } catch {
          return "upstream";
        }
      })();

      const name = body.name?.trim() || (connectorTarget
        ? connectorTarget.product
        : `MCP ${urlHost}`);
      const slug =
        body.slug?.trim() ||
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 32) ||
        `mcp-${Date.now().toString(36)}`;

      // 平台连接器：平台自己调用第三方 API，不代理外部 MCP。
      if (connectorTarget && authMode === "oauth") {
        if (!connectorTarget.discovery.authorizationEndpoint || !connectorTarget.discovery.tokenEndpoint) {
          throw new Error("连接器目录缺少 OAuth authorization_endpoint 或 token_endpoint");
        }
        const mcpUrl = connectorTarget.mcpUrl;
        const connectorConfig = {
          product: connectorTarget.product,
          mcpUrl,
          authRequired: true,
          oauthTokenEndpoint: connectorTarget.discovery.tokenEndpoint,
        };
        const instance = connectorTarget.existingInstance ?? await orchestrator.createInstance({
          tenantId: session.tenantId,
          providerId: connectorTarget.providerId,
          name,
          slug: connectorTarget.instanceSlug,
          config: connectorConfig,
        });
        if (connectorTarget.existingInstance) {
          await orchestrator.updateInstanceConfig(
            session.tenantId,
            connectorTarget.existingInstance.id,
            connectorConfig,
          );
        }

        purgeUpstreamOauthPending();
        const discovery = connectorTarget.discovery;
        const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
        const client = body.oauthClientId?.trim()
          ? buildByoOauthClient(mcpUrl, {
              clientId: body.oauthClientId,
              clientSecret: body.oauthClientSecret,
              scopes: body.oauthScopes,
            })
          : connectorTarget.client
            ? {
                providerId: connectorTarget.providerId,
                connectorRef: connectorTarget.providerId,
                clientId: connectorTarget.client.clientId,
                clientSecret: connectorTarget.client.clientSecret,
                scopes: connectorTarget.scopes,
                source: connectorTarget.client.source,
              }
            : null;
        if (!client) {
          return c.json(
            {
              instance: await loadInstanceWithContainers(db, session.tenantId, instance.id),
              authRequired: true,
              oauth: {
                ok: false,
                discovery,
                error: noDcrOauthError(mcpUrl),
                needsByoClient: true,
                needsPatFallback: false,
                redirectUri,
              },
            },
            201,
          );
        }
        const state = randomBytes(16).toString("hex");
        const { url, codeVerifier } = upstreamOauth.buildAuthorizeUrl({
          discovery,
          clientId: client.clientId,
          redirectUri,
          state,
          scope: upstreamOauth.resolveScope(discovery, client.scopes),
          // 平台连接器不是外部 MCP，不传 MCP resource。
          extraParams: connectorTarget.authorizeParams,
        });
        upstreamOauthPending.set(state, {
          tenantId: session.tenantId,
          instanceId: instance.id,
          mcpUrl,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          codeVerifier,
          redirectUri,
          tokenEndpoint: discovery.tokenEndpoint!,
          resource: null,
          createdAt: Date.now(),
        });

        return c.json(
          {
            instance: await loadInstanceWithContainers(db, session.tenantId, instance.id),
            authRequired: true,
            oauth: {
              ok: true,
              authorizeUrl: url,
              state,
              clientId: client.clientId,
              clientSource: client.source,
              discovery,
            },
            started: false,
            tools: [],
            qualifiedPreview: [],
          },
          201,
        );
      }

      const { normalizeMcpHttpUrl } = await import("../lib/mcp-http.js");
      const mcpUrl = normalizeMcpHttpUrl(body.mcpUrl);

      // OAuth 2.1: create instance marked authRequired, then return authorize URL
      if (authMode === "oauth") {
        const discovery = await upstreamOauth.discover(mcpUrl);
        const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
        const hostClient = await integrationCatalog.resolveHostOauthClient(
          session.tenantId,
          mcpUrl,
          { connectorRef: body.oauthConnectorRef },
        );
        const oauthConnectorRef =
          hostClient?.connectorRef || body.oauthConnectorRef?.trim() || undefined;
        const instance = await orchestrator.createInstance({
          tenantId: session.tenantId,
          providerId: "generic-mcp",
          name,
          slug,
          config: {
            mcpUrl,
            apiKey: "",
            headerName: "Authorization",
            authRequired: true,
            ...(oauthConnectorRef ? { oauthConnectorRef } : {}),
            ...(body.oauthClientId?.trim()
              ? {
                  oauthClientId: body.oauthClientId.trim(),
                  ...(body.oauthClientSecret
                    ? { oauthClientSecret: body.oauthClientSecret }
                    : {}),
                }
              : {}),
          },
        });

        purgeUpstreamOauthPending();
        const client = await resolveUpstreamOauthClient({
          upstreamOauth,
          discovery,
          mcpUrl,
          redirectUri,
          clientName: name,
          byo: {
            clientId: body.oauthClientId,
            clientSecret: body.oauthClientSecret,
            scopes: body.oauthScopes,
          },
          connectorClient: hostClient,
          record: {
            store: upstreamOauthClients,
            tenantId: session.tenantId,
            instanceId: instance.id,
          },
        });
        if (!client) {
          return c.json(
            {
              instance: await loadInstanceWithContainers(db, session.tenantId, instance.id),
              authRequired: true,
              oauth: {
                ok: false,
                discovery,
                error: noDcrOauthError(mcpUrl),
                needsByoClient: true,
                needsPatFallback: /github/i.test(mcpUrl),
                redirectUri,
                sharedOauth: oauthConnectorRef
                  ? { ready: false, connectorRef: oauthConnectorRef }
                  : undefined,
              },
            },
            201,
          );
        }
        if (!discovery.tokenEndpoint) {
          return c.json({ error: "上游缺少 token_endpoint", discovery }, 400);
        }
        const state = randomBytes(16).toString("hex");
        const { url, codeVerifier } = upstreamOauth.buildAuthorizeUrl({
          discovery,
          clientId: client.clientId,
          redirectUri,
          state,
          scope: upstreamOauth.resolveScope(discovery, client.scopeOverride),
          resource: discovery.resource ?? mcpUrl,
        });
        upstreamOauthPending.set(state, {
          tenantId: session.tenantId,
          instanceId: instance.id,
          mcpUrl,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          codeVerifier,
          redirectUri,
          tokenEndpoint: discovery.tokenEndpoint,
          createdAt: Date.now(),
        });

        return c.json(
          {
            instance: await loadInstanceWithContainers(db, session.tenantId, instance.id),
            authRequired: true,
            oauth: {
              ok: true,
              authorizeUrl: url,
              state,
              clientId: client.clientId,
              clientSource: client.source,
              discovery,
              sharedOauth: hostClient
                ? {
                    ready: true,
                    connectorRef: hostClient.connectorRef,
                    connectorName: hostClient.connectorName,
                    source: hostClient.source,
                  }
                : undefined,
            },
            started: false,
            tools: [],
            qualifiedPreview: [],
          },
          201,
        );
      }

      const { probeMcpTools } = await import("../lib/mcp-http.js");
      let tools: Array<{ name: string; description: string }> = [];
      try {
        tools = await probeMcpTools({
          mcpUrl,
          apiKey: body.apiKey,
          headerName: body.headerName,
        });
      } catch (err) {
        // Allow import even if probe fails when user provided a key (may need OAuth later)
        if (authMode === "none" && !body.apiKey?.trim()) throw err;
      }

      const instance = await orchestrator.createInstance({
        tenantId: session.tenantId,
        providerId: "generic-mcp",
        name,
        slug,
        config: {
          mcpUrl,
          apiKey: body.apiKey ?? "",
          headerName: body.headerName ?? "Authorization",
        },
      });

      let started = false;
      let startError: string | undefined;
      if (body.start !== false) {
        try {
          await orchestrator.startInstance(session.tenantId, instance.id);
          started = true;
        } catch (err) {
          startError = err instanceof Error ? err.message : String(err);
        }
      }

      const fresh = await loadInstanceWithContainers(db, session.tenantId, instance.id);
      const authRequired = !!fresh?.lastError?.startsWith("AUTH_REQUIRED");

      return c.json(
        {
          instance: fresh,
          tools,
          started,
          startError,
          authRequired,
          qualifiedPreview: tools.slice(0, 20).map((t) => `${slug}__${t.name}`),
        },
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Parse & import VS Code / Cursor mcp.json (one or many servers) */
  app.post("/api/mcp/import-vscode", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      config: string | Record<string, unknown>;
      start?: boolean;
      /** Only import these keys; default all */
      keys?: string[];
    }>();
    if (body.config == null) return c.json({ error: "config required" }, 400);

    try {
      const { parseEditorMcpConfig, entryToImportBody } = await import(
        "../lib/mcp-install-parse.js"
      );
      let entries = parseEditorMcpConfig(body.config);
      if (body.keys?.length) {
        const allow = new Set(body.keys);
        entries = entries.filter((e) => allow.has(e.key));
      }
      if (!entries.length) return c.json({ error: "没有可导入的条目" }, 400);

      const results: Array<{
        key: string;
        instance: unknown;
        started: boolean;
        startError?: string;
        providerId: string;
        slug: string;
      }> = [];

      for (const entry of entries) {
        const plan = entryToImportBody(entry);
        const instance = await orchestrator.createInstance({
          tenantId: session.tenantId,
          providerId: plan.providerId,
          name: plan.name,
          slug: plan.slug,
          config: plan.config,
        });
        let started = false;
        let startError: string | undefined;
        if (body.start !== false) {
          try {
            await orchestrator.startInstance(session.tenantId, instance.id);
            started = true;
          } catch (err) {
            startError = err instanceof Error ? err.message : String(err);
          }
        }
        results.push({
          key: entry.key,
          instance: await loadInstanceWithContainers(db, session.tenantId, instance.id),
          started,
          startError,
          providerId: plan.providerId,
          slug: plan.slug,
        });
      }

      return c.json({ count: results.length, results }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/mcp/parse-vscode", async (c) => {
    const body = await c.req.json<{ config: string | Record<string, unknown> }>();
    if (body.config == null) return c.json({ error: "config required" }, 400);
    try {
      const { parseEditorMcpConfig, entryToImportBody } = await import(
        "../lib/mcp-install-parse.js"
      );
      const entries = parseEditorMcpConfig(body.config);
      return c.json({
        entries: entries.map((e) => ({
          ...e,
          importPreview: entryToImportBody(e),
        })),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Schema-aware tool playground — call any tenant-visible tool */
  app.post("/api/mcp/call", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      qualifiedName: string;
      arguments?: Record<string, unknown>;
      agentId?: string;
      task?: { ttl?: number | null; pollInterval?: number };
    }>();
    if (!body.qualifiedName) return c.json({ error: "qualifiedName required" }, 400);
    const result = await gateway.callTool(
      session.tenantId,
      body.qualifiedName.startsWith("re_")
        ? body.qualifiedName
        : `re_${body.qualifiedName}`,
      body.arguments ?? {},
      { agentId: body.agentId },
    );
    if (result && typeof result === "object" && "task" in result && result.task) {
      return c.json({ ok: true, task: true, result });
    }
    return c.json({
      ok: !(result as { isError?: boolean }).isError,
      result,
    });
  });

  /** 读取聚合后的 MCP resource */
  app.post("/api/mcp/resources/read", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ uri?: string; agentId?: string }>();
    if (!body.uri?.trim()) return c.json({ error: "uri required" }, 400);
    try {
      const result = await gateway.readResource(session.tenantId, body.uri.trim(), {
        agentId: body.agentId,
      });
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** 获取聚合后的 MCP prompt */
  app.post("/api/mcp/prompts/get", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      arguments?: Record<string, string>;
      agentId?: string;
    }>();
    if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
    try {
      const result = await gateway.getPrompt(
        session.tenantId,
        body.name.trim(),
        body.arguments,
        { agentId: body.agentId },
      );
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** MCP completion/complete */
  app.post("/api/mcp/complete", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      ref?: { type?: string; name?: string; uri?: string };
      argument?: { name?: string; value?: string };
      agentId?: string;
    }>();
    const refType = body.ref?.type;
    const argName = body.argument?.name;
    const argValue = body.argument?.value;
    if (
      (refType !== "ref/prompt" && refType !== "ref/resource") ||
      typeof argName !== "string" ||
      typeof argValue !== "string"
    ) {
      return c.json({ error: "ref + argument required" }, 400);
    }
    try {
      const result = await gateway.complete(
        session.tenantId,
        {
          ref:
            refType === "ref/prompt"
              ? { type: "ref/prompt", name: String(body.ref?.name ?? "") }
              : { type: "ref/resource", uri: String(body.ref?.uri ?? "") },
          argument: { name: argName, value: argValue },
        },
        { agentId: body.agentId },
      );
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** MCP Store — official registry + curated source links */
  app.get("/api/mcp/store/sources", async (c) => {
    const session = c.get("session")!;
    return c.json({ sources: await mcpStore.listSources(session.tenantId) });
  });

  app.post("/api/mcp/store/sources", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      repository?: string;
      sourceUrl?: string;
      format?: "auto" | "claude" | "codex";
      name?: string;
    }>();
    const input = (body.sourceUrl ?? body.repository ?? "").trim();
    if (!input) return c.json({ error: "repository or sourceUrl required" }, 400);
    try {
      const looksLikeJson =
        /\.json(\?|$)/i.test(input) ||
        input.includes("marketplace.json") ||
        input.includes(".claude-plugin/") ||
        input.includes(".codex-plugin/");
      const source = looksLikeJson
        ? await mcpStore.importSource(session.tenantId, {
            sourceUrl: input,
            format: body.format ?? "auto",
            name: body.name,
          })
        : await mcpStore.importRepository(session.tenantId, input);
      return c.json({ source }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/mcp/store/sources/:id", async (c) => {
    const session = c.get("session")!;
    const deleted = await mcpStore.deleteSource(session.tenantId, decodeURIComponent(c.req.param("id")));
    return deleted ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  });

  app.post("/api/mcp/store/sync", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      force?: boolean;
      maxPages?: number;
      stores?: string[];
      store?: string;
    };
    try {
      const requested = body.stores?.length
        ? body.stores
        : body.store
          ? [body.store]
          : undefined;
      const custom = requested?.filter((store) => store.startsWith("custom:")) ?? [];
      const invalid = requested?.filter((store) => !store.startsWith("custom:") && !isBuiltinMcpStoreId(store)) ?? [];
      if (invalid.length) return c.json({ error: `unknown store: ${invalid.join(", ")}` }, 400);
      if (custom.length) {
        const session = c.get("session")!;
        const results = [];
        for (const store of custom) results.push(await mcpStore.syncCustomSource(session.tenantId, store as McpStoreSourceId));
        return c.json({ results });
      }
      const stores = requested?.filter(isBuiltinMcpStoreId);
      const result = await mcpStore.sync({
        force: body.force === true,
        maxPages: typeof body.maxPages === "number" ? body.maxPages : 25,
        stores,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/api/mcp/store/search", async (c) => {
    const session = c.get("session")!;
    const q = c.req.query("q") ?? "";
    const kind = (c.req.query("kind") as "http" | "stdio" | "all" | undefined) ?? "all";
    const store = (c.req.query("store") as McpStoreSourceId | "all" | undefined) ?? "github-mcp";
    const limit = Number(c.req.query("limit") ?? 40);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await mcpStore.search({ tenantId: session.tenantId, q, kind, store, limit, offset });
    return c.json(result);
  });

  app.get("/api/mcp/store/servers/:name", async (c) => {
    const session = c.get("session")!;
    const name = decodeURIComponent(c.req.param("name"));
    const store = c.req.query("store") as McpStoreSourceId | undefined;
    const server = await mcpStore.getServer(name, store, session.tenantId);
    if (!server) return c.json({ error: "Not found" }, 404);
    const preview = mcpStore.buildInstallPreview(server);
    return c.json({ ...server, preview });
  });

  app.post("/api/mcp/store/install", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name: string;
      store?: McpStoreSourceId;
      prefer?: "http" | "stdio";
      remoteUrl?: string;
      env?: Record<string, string>;
      packageIndex?: number;
      slug?: string;
      displayName?: string;
      start?: boolean;
    }>();
    if (!body.name) return c.json({ error: "name required" }, 400);
    try {
      const server = await mcpStore.getServer(body.name, body.store, session.tenantId);
      if (!server) return c.json({ error: "server not found in registry" }, 404);
      const plan = mcpStore.buildInstallPlan(server, {
        prefer: body.prefer,
        remoteUrl: body.remoteUrl,
        env: body.env,
        packageIndex: body.packageIndex,
      });
      if (body.slug?.trim()) plan.slug = body.slug.trim();
      if (body.displayName?.trim()) plan.name = body.displayName.trim();

      const instance = await orchestrator.createInstance({
        tenantId: session.tenantId,
        providerId: plan.providerId,
        name: plan.name,
        slug: plan.slug,
        config: plan.config,
      });

      let started = false;
      let startError: string | undefined;
      if (body.start !== false) {
        try {
          await orchestrator.startInstance(session.tenantId, instance.id);
          started = true;
        } catch (err) {
          startError = err instanceof Error ? err.message : String(err);
        }
      }

      const fresh = await loadInstanceWithContainers(db, session.tenantId, instance.id);
      let authRequired = !!fresh?.lastError?.startsWith("AUTH_REQUIRED");

      // Re-read config flag if afterStart marked authRequired
      if (fresh && plan.providerId === "generic-mcp") {
        try {
          const handle = await orchestrator.toHandle(session.tenantId, fresh.id);
          if (handle.config.authRequired === true) authRequired = true;
        } catch {
          /* ignore */
        }
      }

      return c.json(
        {
          plan,
          instance: fresh,
          started,
          startError,
          authRequired,
          envHints: plan.envHints,
          storeId: server.storeId,
        },
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Import stdio MCP directly (without store) */
  app.post("/api/mcp/import-stdio", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      slug?: string;
      command: string;
      args?: string[] | string;
      env?: Record<string, string> | string;
      image?: string;
      workingDir?: string;
      packageManager?: "npm" | "pypi" | "oci" | "binary";
      start?: boolean;
    }>();
    if (!body.command?.trim()) return c.json({ error: "command required" }, 400);
    try {
      const name = body.name?.trim() || `Stdio ${body.command}`;
      const slug =
        body.slug?.trim() ||
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 32) ||
        `stdio-${Date.now().toString(36)}`;

      const packageManager =
        body.packageManager === "pypi" ||
        body.packageManager === "oci" ||
        body.packageManager === "binary"
          ? body.packageManager
          : body.command.trim() === "docker" || body.command.trim() === "podman"
            ? "oci"
            : "npm";

      const instance = await orchestrator.createInstance({
        tenantId: session.tenantId,
        providerId: "stdio-mcp",
        name,
        slug,
        config: {
          command: body.command.trim(),
          args: Array.isArray(body.args) ? JSON.stringify(body.args) : (body.args ?? "[]"),
          env:
            typeof body.env === "string"
              ? body.env
              : JSON.stringify(body.env ?? {}),
          image: body.image,
          workingDir: body.workingDir ?? "/data",
          packageManager,
        },
      });

      let started = false;
      let startError: string | undefined;
      if (body.start !== false) {
        try {
          await orchestrator.startInstance(session.tenantId, instance.id);
          started = true;
        } catch (err) {
          startError = err instanceof Error ? err.message : String(err);
        }
      }

      return c.json(
        { instance: await loadInstanceWithContainers(db, session.tenantId, instance.id), started, startError },
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Upstream MCP OAuth 2.1 discovery + DCR + authorize URL */
  app.post("/api/mcp/upstream-oauth/start", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      mcpUrl?: string;
      instanceId?: string;
      clientName?: string;
      scope?: string;
      oauthClientId?: string;
      oauthClientSecret?: string;
      oauthConnectorRef?: string;
    }>();

    let mcpUrl = body.mcpUrl?.trim() ?? "";
    let storedConfig: Record<string, unknown> = {};
    if (!mcpUrl && body.instanceId) {
      const existing = await db.query.componentInstances.findFirst({
        where: and(
          eq(componentInstances.id, body.instanceId),
          eq(componentInstances.tenantId, session.tenantId),
        ),
      });
      if (!existing) return c.json({ error: "instance not found" }, 404);
      try {
        const cfg = decryptJson<Record<string, unknown>>(config.secret, existing.configEnc);
        storedConfig = cfg;
        mcpUrl =
          (typeof cfg.mcpUrl === "string" && cfg.mcpUrl) ||
          existing.endpointUrl ||
          "";
      } catch (err) {
        return c.json(
          {
            error:
              err instanceof Error
                ? err.message
                : "实例配置无法解密，请检查 ZAKURA_SECRET / data/secret.key",
          },
          400,
        );
      }
    }
    if (!mcpUrl) return c.json({ error: "mcpUrl required" }, 400);

    try {
      purgeUpstreamOauthPending();
      const connectorTarget = await integrationCatalog.resolveConnectorTarget(
        session.tenantId,
        mcpUrl,
      );
      const discovery = connectorTarget?.discovery ?? await upstreamOauth.discover(mcpUrl);
      const oauthDiscovery = discovery as UpstreamOauthDiscovery;
      const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
      const resolvedUrl = connectorTarget?.mcpUrl ?? mcpUrl;
      const oauthClientId =
        body.oauthClientId?.trim() ||
        (typeof storedConfig.oauthClientId === "string" ? storedConfig.oauthClientId.trim() : "");
      const oauthClientSecret =
        body.oauthClientSecret ??
        (typeof storedConfig.oauthClientSecret === "string" && storedConfig.oauthClientSecret !== "***"
          ? storedConfig.oauthClientSecret
          : undefined);
      const oauthConnectorRef =
        body.oauthConnectorRef?.trim() ||
        (typeof storedConfig.oauthConnectorRef === "string"
          ? storedConfig.oauthConnectorRef.trim()
          : undefined);
      const client = connectorTarget
        ? oauthClientId
          ? buildByoOauthClient(resolvedUrl, {
              clientId: oauthClientId,
              clientSecret: oauthClientSecret,
              scopes: body.scope,
            })
          : connectorTarget.client
            ? {
                providerId: connectorTarget.providerId,
                connectorRef: connectorTarget.providerId,
                clientId: connectorTarget.client.clientId,
                clientSecret: connectorTarget.client.clientSecret,
                scopes: connectorTarget.scopes,
                source: connectorTarget.client.source,
              }
            : null
        : await resolveUpstreamOauthClient({
            upstreamOauth,
            discovery,
            mcpUrl: resolvedUrl,
            redirectUri,
            clientName: body.clientName,
            byo: {
              clientId: oauthClientId,
              clientSecret: oauthClientSecret,
              scopes: body.scope,
            },
            connectorClient: await integrationCatalog.resolveHostOauthClient(
              session.tenantId,
              resolvedUrl,
              { connectorRef: oauthConnectorRef },
            ),
            record: {
              store: upstreamOauthClients,
              tenantId: session.tenantId,
              instanceId: body.instanceId,
            },
          });

      if (!client) {
        return c.json(
          {
            ok: false,
            discovery,
            error: noDcrOauthError(resolvedUrl),
            needsByoClient: true,
            needsPatFallback: /github/i.test(mcpUrl),
            redirectUri,
          },
          400,
        );
      }

      if (!discovery.tokenEndpoint) {
        return c.json({ error: "上游缺少 token_endpoint", discovery }, 400);
      }

      if (body.instanceId) {
        await orchestrator.updateInstanceConfig(session.tenantId, body.instanceId, {
          oauthClientId: client.clientId,
          ...(client.clientSecret ? { oauthClientSecret: client.clientSecret } : {}),
          oauthClientSource: client.source,
          oauthClientMode: isCimdClientId(client.clientId)
            ? "cimd"
            : client.source === "dcr"
              ? "dynamic"
              : "manual",
          oauthRedirectUri: redirectUri,
          oauthRegistrationEndpoint: oauthDiscovery.registrationEndpoint ?? "",
          oauthAuthorizationEndpoint: oauthDiscovery.authorizationEndpoint ?? "",
          oauthTokenEndpoint: oauthDiscovery.tokenEndpoint,
          oauthResourceMetadataUrl: oauthDiscovery.resourceMetadataUrl ?? "",
          oauthScopes: body.scope ?? oauthDiscovery.scopesSupported?.join(" ") ?? "",
        });
      }

      const state = randomBytes(16).toString("hex");
      const { url, codeVerifier } = upstreamOauth.buildAuthorizeUrl({
        discovery,
        clientId: client.clientId,
        redirectUri,
        state,
        scope: upstreamOauth.resolveScope(discovery, body.scope ?? (
          connectorTarget
            ? ("scopes" in client ? client.scopes : undefined)
            : ("scopeOverride" in client ? client.scopeOverride : undefined)
        )),
        resource: connectorTarget
          ? undefined
          : ("resource" in discovery ? discovery.resource : undefined) ?? mcpUrl,
        extraParams: connectorTarget?.authorizeParams,
      });

      upstreamOauthPending.set(state, {
        tenantId: session.tenantId,
        instanceId: body.instanceId,
        mcpUrl: resolvedUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        codeVerifier,
        redirectUri,
        tokenEndpoint: discovery.tokenEndpoint,
        resource: connectorTarget ? null : undefined,
        createdAt: Date.now(),
      });

      return c.json({
        ok: true,
        authorizeUrl: url,
        state,
        discovery,
        clientId: client.clientId,
        clientSource: client.source,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
  app.post("/api/mcp/upstream-oauth/authorize", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      mcpUrl: string;
      clientId: string;
      clientSecret?: string;
      instanceId?: string;
      scope?: string;
    }>();
    if (!body.mcpUrl || !body.clientId) {
      return c.json({ error: "mcpUrl and clientId required" }, 400);
    }
    try {
      const discovery = await upstreamOauth.discover(body.mcpUrl);
      if (!discovery.authorizationEndpoint || !discovery.tokenEndpoint) {
        return c.json({ error: "上游 OAuth 元数据不完整", discovery }, 400);
      }
      const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
      const state = randomBytes(16).toString("hex");
      const { url, codeVerifier } = upstreamOauth.buildAuthorizeUrl({
        discovery,
        clientId: body.clientId,
        redirectUri,
        state,
        scope: upstreamOauth.resolveScope(discovery, body.scope),
        resource: discovery.resource ?? body.mcpUrl,
      });
      upstreamOauthPending.set(state, {
        tenantId: session.tenantId,
        instanceId: body.instanceId,
        mcpUrl: body.mcpUrl,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        codeVerifier,
        redirectUri,
        tokenEndpoint: discovery.tokenEndpoint,
        createdAt: Date.now(),
      });
      return c.json({ ok: true, authorizeUrl: url, state, discovery });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Browser lands here after upstream consent — exchange code & persist tokens */
  app.get("/api/mcp/upstream-oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const err = c.req.query("error");
    if (err) {
      return c.redirect(
        `${config.webPublicUrl}/console/oauth/mcp-upstream/callback?error=${encodeURIComponent(err)}`,
      );
    }
    if (!code || !state) {
      return c.redirect(
        `${config.webPublicUrl}/console/oauth/mcp-upstream/callback?error=missing_code`,
      );
    }
    const pending = upstreamOauthPending.get(state);
    upstreamOauthPending.delete(state);
    if (!pending) {
      return c.redirect(
        `${config.webPublicUrl}/console/oauth/mcp-upstream/callback?error=invalid_state`,
      );
    }
    try {
      const tokens = await upstreamOauth.exchangeCode({
        tokenEndpoint: pending.tokenEndpoint,
        code,
        redirectUri: pending.redirectUri,
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
        codeVerifier: pending.codeVerifier,
        resource: pending.resource === null ? undefined : pending.resource ?? pending.mcpUrl,
      });

      let instanceId = pending.instanceId;
      if (pending.connectorRef) {
        await integrationCatalog.saveConnectorAuthorization(pending.tenantId, pending.connectorRef, tokens);
        return c.redirect(
          `${config.webPublicUrl}/dashboard/connectors?connector=${encodeURIComponent(pending.connectorRef)}&oauth=1`,
        );
      }
      if (instanceId) {
        const existing = await db.query.componentInstances.findFirst({
          where: and(
            eq(componentInstances.id, instanceId),
            eq(componentInstances.tenantId, pending.tenantId),
          ),
        });
        if (!existing) throw new Error("instance not found");
        const current = decryptJson<Record<string, unknown>>(
          config.secret,
          existing.configEnc,
        );
        await orchestrator.updateInstanceConfig(
          pending.tenantId,
          instanceId,
          applyOauthTokensToConfig(current, tokens),
        );
      } else {
        const host = (() => {
          try {
            return new URL(pending.mcpUrl).hostname.replace(/\./g, "-");
          } catch {
            return "oauth-mcp";
          }
        })();
        const created = await orchestrator.createInstance({
          tenantId: pending.tenantId,
          providerId: "generic-mcp",
          name: `MCP ${host}`,
          slug: `mcp-${host}`.slice(0, 32),
          config: applyOauthTokensToConfig(
            { mcpUrl: pending.mcpUrl, apiKey: "", headerName: "Authorization" },
            tokens,
          ),
        });
        instanceId = created.id;
        await orchestrator.startInstance(pending.tenantId, created.id);
      }

      return c.redirect(
        `${config.webPublicUrl}/console/oauth/mcp-upstream/callback?ok=1&instanceId=${encodeURIComponent(instanceId)}`,
      );
    } catch (exchangeErr) {
      const msg = exchangeErr instanceof Error ? exchangeErr.message : String(exchangeErr);
      return c.redirect(
        `${config.webPublicUrl}/console/oauth/mcp-upstream/callback?error=${encodeURIComponent(msg)}`,
      );
    }
  });

  // OAuth callback already persists tokens; no health probe is needed here.
  app.post("/api/mcp/upstream-oauth/verify", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ instanceId: string }>();
    if (!body.instanceId) return c.json({ error: "instanceId required" }, 400);
    const existing = await db.query.componentInstances.findFirst({
      where: and(
        eq(componentInstances.id, body.instanceId),
        eq(componentInstances.tenantId, session.tenantId),
      ),
    });
    if (!existing) return c.json({ error: "Not found" }, 404);
    return c.json({
      ok: true,
      message: "OAuth 凭据已保存，连接状态将在实际调用时确定",
    });
  });

  app.get("/api/settings", async (c) => {
    const session = c.get("session")!;
    const rows = await db
      .select()
      .from(settings)
      .where(or(eq(settings.ownerKey, "platform"), eq(settings.ownerKey, session.tenantId)));
    const result = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    if (config.multiTenant) delete result[AGENT_DEFAULTS_KEY];
    return c.json(result);
  });

  /**
   * 上游 MCP OAuth 客户端配置。
   * scope=tenant：任意租户管理员可配本租户自建客户端
   * scope=platform：整站默认（SaaS 超管 / OSS 管理员）
   */
  app.get("/api/mcp/oauth-redirect-uri", async (c) => {
    return c.json({
      redirectUri: `${config.publicBaseUrl.replace(/\/$/, "")}/api/mcp/upstream-oauth/callback`,
      note:
        "部分外部 MCP 不支持动态客户端注册；将此 URI 填入对应 OAuth App。平台连接器凭据请在独立页面管理。",
    });
  });

  /** 平台连接器能力目录。外部 MCP 使用独立商店，不进入这里。 */
  app.get("/api/integrations/packages", async (c) => {
    const session = c.get("session")!;
    return c.json({ packages: await integrationCatalog.list(session.tenantId) });
  });

  app.get("/api/integrations/packages/:slug", async (c) => {
    const session = c.get("session")!;
    const pkg = await integrationCatalog.get(session.tenantId, c.req.param("slug"));
    if (!pkg) return c.json({ error: "Not found" }, 404);
    return c.json({ package: pkg });
  });

  app.get("/api/connectors", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (scope === "platform" && !canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    if (scope === "tenant") await skills?.syncBuiltins(session.tenantId);
    const scopeKey = scope === "platform" ? "platform" : session.tenantId;
    return c.json({
      connectors: await integrationCatalog.listConnectors(scopeKey),
      scope,
      redirectUri: `${config.publicBaseUrl.replace(/\/$/, "")}/api/mcp/upstream-oauth/callback`,
    });
  });

  app.get("/api/connectors/profiles", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const scopeKey = scope === "platform" ? "platform" : session.tenantId;
    return c.json({ profiles: await integrationCatalog.listProfiles(scopeKey), scope });
  });

  app.put("/api/connectors/profiles/:profileKey", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const body = await c.req.json<{
      enabled?: boolean;
      kind?: "oauth2" | "oauth2_dynamic" | "token" | "custom" | "none";
      label?: string;
      values?: Record<string, unknown>;
    }>();
    try {
      const profile = await integrationCatalog.saveProfile(
        scope === "platform" ? "platform" : session.tenantId,
        c.req.param("profileKey"),
        body,
      );
      return c.json({ profile, scope });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/connectors/profiles/:profileKey", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    try {
      await integrationCatalog.deleteProfile(
        scope === "platform" ? "platform" : session.tenantId,
        c.req.param("profileKey"),
      );
      return c.json({ ok: true, scope });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** 远程 MCP 安装前探测：是否可复用已配置的连接器 OAuth 客户端 */
  app.get("/api/connectors/shared-oauth", async (c) => {
    const session = c.get("session")!;
    const mcpUrl = c.req.query("mcpUrl")?.trim() ?? "";
    const connectorRef = c.req.query("connectorRef")?.trim() || undefined;
    if (!mcpUrl && !connectorRef) {
      return c.json({ error: "mcpUrl or connectorRef required" }, 400);
    }
    const peek = await integrationCatalog.peekSharedOauth(
      session.tenantId,
      mcpUrl,
      connectorRef,
    );
    return c.json(peek);
  });

  /** 平台连接器直接授权：只保存连接器授权，不创建 MCP 实例。 */
  app.post("/api/connectors/:ref/oauth/start", async (c) => {
    const session = c.get("session")!;
    const connectorRef = c.req.param("ref");
    try {
      const connector = (await integrationCatalog.listConnectors(session.tenantId)).find(
        (item) => item.ref === connectorRef || item.id === connectorRef,
      );
      const capabilities =
        connector?.capabilities.filter(
          (item) => item.kind === "tool" && String(item.config.mcpUrl ?? "").startsWith("zakura://"),
        ) ?? [];
      const capability = capabilities[0];
      const mcpUrl = String(capability?.config.mcpUrl ?? "");
      if (!connector || !mcpUrl) {
        return c.json({ error: "连接器没有可授权的功能" }, 400);
      }
      const target = await integrationCatalog.resolveConnectorTarget(session.tenantId, mcpUrl);
      if (!target?.client || !target.discovery.authorizationEndpoint || !target.discovery.tokenEndpoint) {
        return c.json({ error: "请先保存有效的 OAuth 客户端配置" }, 400);
      }
      purgeUpstreamOauthPending();
      const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
      const state = randomBytes(16).toString("hex");
      const scope = [...new Set(
        capabilities.flatMap((item) => String(item.config.scopes ?? "").split(/\s+/).filter(Boolean)),
      )].join(" ");
      const { url, codeVerifier } = upstreamOauth.buildAuthorizeUrl({
        discovery: target.discovery,
        clientId: target.client.clientId,
        redirectUri,
        state,
        scope: upstreamOauth.resolveScope(target.discovery, scope || target.scopes),
        extraParams: target.authorizeParams,
      });
      upstreamOauthPending.set(state, {
        tenantId: session.tenantId,
        connectorRef: connector.ref,
        mcpUrl: target.mcpUrl,
        clientId: target.client.clientId,
        clientSecret: target.client.clientSecret,
        codeVerifier,
        redirectUri,
        tokenEndpoint: target.discovery.tokenEndpoint,
        resource: null,
        createdAt: Date.now(),
      });
      return c.json({ ok: true, authorizeUrl: url });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.put("/api/connectors/:id/credentials", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const body = await c.req.json<{
      enabled?: boolean;
      values?: Record<string, unknown>;
      settings?: Record<string, unknown>;
    }>();
    try {
      const connector = await integrationCatalog.saveCredentials(
        scope === "platform" ? "platform" : session.tenantId,
        c.req.param("id"),
        body,
      );
      return c.json({ connector, scope });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.put("/api/connectors/:ref/settings", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const body = await c.req.json<{ values?: Record<string, unknown> }>();
    try {
      const connector = await integrationCatalog.saveConnectorSettings(
        scope === "platform" ? "platform" : session.tenantId,
        c.req.param("ref"),
        body.values ?? {},
      );
      return c.json({ connector, scope });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /**
   * Google Cloud 供应引导（无需 SA）：返回 Console 链接、scopes、限制说明。
   * 完整自动创建 Web OAuth 客户端被 Google 官方限制，见 limitation 字段。
   */
  app.get("/api/mcp/google/provision-guide", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const projectId = c.req.query("projectId")?.trim() || "YOUR_PROJECT_ID";
    const productsRaw = c.req.query("products") ?? "gmail,drive,calendar,people,chat";
    const products = productsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is "gmail" | "drive" | "calendar" | "people" | "chat" =>
        s === "gmail" ||
        s === "drive" ||
        s === "calendar" ||
        s === "people" ||
        s === "chat",
      );
    try {
      const guide = buildGoogleProvisionGuide(config, projectId, products);
      return c.json(guide);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /**
   * 使用 Service Account 自动启用 Workspace MCP 相关 Cloud API。
   * 不持久化 SA JSON。OAuth Web 客户端仍须用户在 Console 创建后粘贴回来。
   */
  app.post("/api/mcp/google/provision", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const body = await c.req.json<{
      serviceAccountJson: unknown;
      projectId?: string;
      products?: Array<"gmail" | "drive" | "calendar" | "people" | "chat">;
    }>();
    if (body.serviceAccountJson == null) {
      return c.json({ error: "serviceAccountJson required" }, 400);
    }
    try {
      const result = await provisionGoogleWorkspaceMcp({
        config,
        serviceAccountJson: body.serviceAccountJson,
        projectId: body.projectId,
        products: body.products,
      });
      return c.json({
        ...result,
        checklist: result.checklist ?? googleOauthSetupChecklist(result.redirectUri),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.put("/api/settings/:key", async (c) => {
    const session = c.get("session")!;
    const key = c.req.param("key");
    const body = await c.req.json<{ value: unknown; scope?: "platform" | "tenant" }>();
    if (body.scope === "platform") {
      if (!session.isPlatformAdmin) {
        return c.json({ error: "Platform settings require platform admin" }, 403);
      }
    }
    const ownerKey = body.scope === "platform" ? "platform" : session.tenantId;
    const [row] = await db
      .insert(settings)
      .values({
        id: newId(),
        ownerKey,
        key,
        value: JSON.stringify(body.value),
      })
      .onConflictDoUpdate({
        target: [settings.ownerKey, settings.key],
        set: { value: JSON.stringify(body.value) },
      })
      .returning();
    return c.json({ key: row.key, value: JSON.parse(row.value) });
  });

  return app;
}
