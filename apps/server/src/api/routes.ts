import { Hono, type Context } from "hono";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import {
  decryptJson,
  encryptJson,
  generateApiKey,
  getTelemetry,
  globalRegistry,
  idsFromSession,
  log,
  recordPlatformFault,
  withLogContext,
} from "@zakura/core";
import { mountPlatformProbes } from "../observability.js";
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
  LoginBlockedError,
  sessionFromLogin,
  signSession,
  switchTenantSession,
  verifySession,
} from "../services/auth.js";
import {
  checkSessionSuspended,
  invalidateTenantSuspension,
  invalidateUserSuspension,
  suspensionMessage,
} from "../services/account-status.js";
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
import type { MemoryStore } from "../services/memory-store.js";
import type { MemoryProvidersService } from "../services/memory-providers.js";
import type { ToolCallStore } from "../services/tool-call-store.js";
import { OauthError, isRedirectUriRegistered, type OauthService } from "../services/oauth.js";
import { isCimdClientId } from "../services/oauth-cimd.js";
import { PROVIDER_CATEGORY_META, hasImageProbeErrors } from "@zakura/shared";
import { registerAgentFsRoutes } from "./agent-fs-routes.js";
import { registerFileShareRoutes } from "./file-share-routes.js";
import { registerModelRouterRoutes } from "./model-router-routes.js";
import { registerCloudAgentRoutes } from "./cloud-agent-routes.js";
import { registerAcpRoutes } from "./acp-routes.js";
import { AcpRegistryService } from "../services/acp/registry.js";
import { AcpSessionService } from "../services/acp/session.js";
import { registerAutomationRoutes } from "./automation-routes.js";
import { registerRuntimeNodeRoutes } from "./runtime-node-routes.js";
import { CloudAgentSessionStore } from "../services/cloud-agent-session.js";
import { CloudAgentRuntime } from "../services/cloud-agent-runtime.js";
import { AgentAutomationService } from "../services/agent-automation.js";
import { EmailInboundService } from "../services/email-inbound.js";
import { ConnectorAuthService } from "../services/connector-auth.js";
import { RemoteAgentIngress } from "../services/remote-agent-ingress.js";
import { RemoteChannelRuntime, REMOTE_PLATFORMS } from "../services/remote-channel-runtime.js";
import { OpenAiGatewayService } from "../services/openai-gateway.js";
import { registerTenantRoutes } from "./tenant-routes.js";
import { registerUsageRoutes } from "./usage-routes.js";
import { registerOtelRoutes } from "./otel-routes.js";
import { bindUserUsage } from "../services/user-usage.js";
import { TenantService } from "../services/tenants.js";
import { registerMigrationRoutes } from "./migration-routes.js";
import { registerSkillRoutes } from "./skill-routes.js";
import { registerNetworkRoutes } from "./network-routes.js";
import { registerConnectionRoutes } from "./connection-routes.js";
import { registerOpenAiGatewayRoutes } from "./openai-gateway-routes.js";
import { signWorkspaceConnectionTicket } from "../services/desktop-ticket.js";
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
import { McpStoreService } from "../services/mcp-store.js";
import { IntegrationCatalogService } from "../services/integration-catalog.js";
import { McpUpstreamOauthService } from "../services/mcp-upstream-oauth.js";
import { UpstreamOauthClientStore } from "../services/upstream-oauth-clients.js";
import {
  resolveGoogleWorkspaceProduct,
  resolveToolPermissionStates,
} from "../providers/google-workspace/index.js";
import {
  AGENT_DEFAULTS_KEY,
  enableWebForUserAgents,
  getAgentWebDefaults,
  saveAgentWebDefaults,
} from "../services/agent-defaults.js";
import { bindTransactionalEmail } from "../services/transactional-email.js";
import {
  getPlatformTransactionalEmailPublic,
  patchPlatformTransactionalEmail,
  type PlatformTransactionalEmailPatch,
} from "../services/platform-transactional-email.js";

/** MCP / Connector 共享的上游 OAuth 中间态，见 ./mcp-oauth-state.ts */
import { upstreamOauthPending, purgeUpstreamOauthPending } from "./mcp-oauth-state.js";
import { registerMemoryRoutes } from "./memory-routes.js";
import { canManageMcpOauthApps, loadInstanceWithContainers } from "./route-helpers.js";
import {
  makeSyncConnectorCapabilities,
  registerConnectorRoutes,
} from "./connector-routes.js";
import { registerMcpRoutes } from "./mcp-routes.js";

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



/** 系统发信：SaaS 超管；OSS 租户管理员 */
function canManageTransactionalEmail(
  session: { role: string; userId: string; isPlatformAdmin?: boolean },
  config: AppConfig,
): boolean {
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

function workspaceSocketUrl(
  publicBaseUrl: string,
  agentId: string,
  kind: "desktop" | "terminal",
  ticket: string,
): string {
  const url = new URL(publicBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/agents/${encodeURIComponent(agentId)}/${kind}-proxy`;
  url.search = new URLSearchParams({ token: ticket }).toString();
  return url.toString();
}


function instanceErrorStatus(err: unknown): 404 | 500 {
  return err instanceof InstanceNotFoundError ? 404 : 500;
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
  /**
   * 云端会话事件存储。必须由调用方注入并全进程唯一 —— 本地事件投递走进程内
   * emit()，多实例会导致同进程产生的事件互相收不到（Redis 那条路会被
   * INSTANCE_ID 自过滤）。实时网关与本模块共用同一个实例。
   */
  cloudSessionStore: CloudAgentSessionStore;
  imageUpdateChecker?: import("../services/image-update-checker.js").ImageUpdateChecker;
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
    cloudSessionStore,
    imageUpdateChecker,
  } = deps;
  const mcpStore = new McpStoreService(db, config);
  const upstreamOauth = new McpUpstreamOauthService(config);
  const upstreamOauthClients = new UpstreamOauthClientStore(db, config);
  const integrationCatalog = new IntegrationCatalogService(db, config);
  const connectorAuth = new ConnectorAuthService(db, config);
  const tenantService = new TenantService(db);
  const app = new Hono<{ Variables: AppVariables }>();

  // 全局错误兜底：未在路由内 try/catch 的异常统一转结构化 JSON。
  // 节点掉线 / 排空 / 未注册 / 鉴权失效映射到 503，让前端能区分"上游暂时不可用"
  // 与"代码缺陷"，且 OpenAI 兼容客户端会按 503 重试；其余返回 500 并记 fault。
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    const offline = /当前离线|正在排空|尚未完成注册|鉴权信息失效|节点已不存在|需要远程运行节点/.test(
      message,
    );
    const status = offline ? 503 : 500;
    // 503 是预期的节点不可用，记 warn 即可；只有真正的 500 才记 fault。
    if (status >= 500 && !offline) {
      recordPlatformFault(
        "api.unhandled_error",
        err instanceof Error ? err : new Error(message),
        { subsystem: "api" },
      );
    }
    if (offline) log.warn("api.node_unavailable", { path: c.req.path, err_message: message });
    else log.error("api.unhandled_error", { path: c.req.path, status, err_message: message });
    return c.json({ error: message }, status);
  });

  bindTransactionalEmail({ db, secret: config.secret });
  let emailInbound: EmailInboundService | null = null;
  let remoteIngress: RemoteAgentIngress | null = null;
  let remoteRuntime: RemoteChannelRuntime | null = null;
  let cloudAgentRuntime: CloudAgentRuntime | null = null;
  const automation = new AgentAutomationService(db);

  mountPlatformProbes(app as unknown as import("hono").Hono);

  app.use("/api/*", async (c, next) => {
    const publicPaths = new Set([
      "/api/health",
      "/api/livez",
      "/api/ready",
      "/api/readyz",
      "/api/metrics",
      "/api/platform",
      "/api/setup",
      "/api/auth/login",
      "/api/oauth/authorize-info",
      "/api/mcp/upstream-oauth/callback",
      "/api/runtime-nodes/register",
      "/api/otel/config",
      "/api/otel/v1/logs",
    ]);
    const isEmailInbound = /^\/api\/email\/inbound\/[^/]+$/.test(c.req.path);
    const isRemoteWebhook = /^\/api\/remote-channels\/[^/]+\/[^/]+\/webhook$/.test(c.req.path);
    if (config.edition === "saas") {
      publicPaths.add("/api/auth/register");
    }
    const path = c.req.path;
    const isOauthLoginPublic =
      config.edition === "saas" &&
      /^\/api\/auth\/oauth\/[^/]+(\/(start|callback))?$/.test(path);
    const isInvitePublic =
      config.edition === "saas" &&
      (/^\/api\/invites\/[^/]+$/.test(path) ||
        /^\/api\/invites\/[^/]+\/accept$/.test(path));
    const isFileSharePublic = /^\/api\/files\/shared\/[^/]+$/.test(path);

    // probe/import require auth — intentional
    if (
      publicPaths.has(path) ||
      isOauthLoginPublic ||
      isInvitePublic ||
      isFileSharePublic ||
      isEmailInbound ||
      isRemoteWebhook
    ) {
      // Optional session for invite accept
      if (isInvitePublic) {
        const auth = c.req.header("authorization");
        const token = extractBearer(auth) ?? c.req.header("x-zakura-session") ?? undefined;
        if (token) {
          const session = verifySession(config.secret, token);
          if (session) c.set("session", session);
        }
      }
      if (path === "/api/otel/config" || path === "/api/otel/v1/logs") {
        const auth = c.req.header("authorization");
        const token = extractBearer(auth) ?? c.req.header("x-zakura-session") ?? undefined;
        if (token) {
          const session = verifySession(config.secret, token);
          if (session) c.set("session", session);
        }
      }
      await withLogContext(idsFromSession(c.get("session")), next);
      return;
    }
    // Runner heartbeat uses rnr_* bearer (handled in route)
    if (
      c.req.method === "POST" &&
      /^\/api\/runtime-nodes\/[^/]+\/heartbeat$/.test(c.req.path)
    ) {
      await withLogContext(idsFromSession(c.get("session")), next);
      return;
    }
    // Host-served bootstrap script (token in query; validated in route)
    if (
      c.req.method === "GET" &&
      /^\/api\/runtime-nodes\/[^/]+\/bootstrap\.sh$/.test(c.req.path)
    ) {
      await withLogContext(idsFromSession(c.get("session")), next);
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
      // 会话是无状态签名的，封号后旧 token 仍能通过签名校验 → 每请求回查一次（带 TTL 缓存）
      const suspended = await checkSessionSuspended(db, session);
      if (suspended) {
        return c.json(
          { error: suspensionMessage(suspended), code: "account_suspended" },
          403,
        );
      }
      c.set("session", session);
      await withLogContext(idsFromSession(session), next);
      return;
    }

    const { authenticateApiKey } = await import("../services/auth.js");
    const keyed = await authenticateApiKey(db, token);
    if (keyed) {
      const suspended = await checkSessionSuspended(db, {
        userId: "api-key",
        tenantId: keyed.tenant.id,
      });
      if (suspended) {
        return c.json(
          { error: suspensionMessage(suspended), code: "account_suspended" },
          403,
        );
      }
      c.set("session", {
        userId: "api-key",
        tenantId: keyed.tenant.id,
        email: keyed.apiKey.name,
        // API keys are machine credentials — not tenant admins
        role: "api_key",
      });
      await withLogContext(
        idsFromSession({ userId: "api-key", tenantId: keyed.tenant.id }),
        next,
      );
      return;
    }

    return c.json({ error: "Unauthorized" }, 401);
  });

  registerOtelRoutes(app);

  const handleEmailInbound = async (c: Context<{ Variables: AppVariables }>) => {
    if (!emailInbound) return c.json({ error: "邮箱入站服务未启用" }, 503);
    const tenantId = c.req.param("tenantId");
    if (!tenantId) return c.json({ error: "tenantId required" }, 400);
    const supplied = c.req.header("x-email-inbound-secret") ?? "";
    const rawConnectorId = c.req.param("connectorId")?.trim() || "";
    // Accept platform connector refs (email-amail) or legacy instance ids.
    const connectorRef = rawConnectorId
      ? rawConnectorId.startsWith("email-")
        ? rawConnectorId
        : `email-instance-${rawConnectorId}`
      : undefined;
    if (!(await emailInbound.verifyWebhookSecret(tenantId, supplied, connectorRef))) {
      return c.json({ error: "Invalid inbound secret" }, 401);
    }

    const contentType = c.req.header("content-type") ?? "";
    let body: Record<string, unknown> = {};
    if (contentType.includes("application/json")) {
      body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    } else {
      const form = await c.req.parseBody().catch(() => ({}));
      body = Object.fromEntries(
        Object.entries(form).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
      );
    }
    const nested =
      body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? (body.data as Record<string, unknown>)
        : body;
    const value = (...keys: string[]) =>
      keys.map((key) => nested[key] ?? body[key]).find((item) => typeof item === "string") as
        | string
        | undefined;
    const accepted = await emailInbound.handleWebhook(
      tenantId,
      {
        id: value("id", "messageId"),
        receivedAt: value("receivedAt", "date"),
        from: value("from", "sender"),
        to: value("to", "recipient"),
        subject: value("subject"),
        text: value("text", "body-plain"),
        html: value("html", "body-html"),
      },
      supplied,
      connectorRef,
    );
    return c.json({ ok: true, accepted });
  };
  app.post("/api/email/inbound/:tenantId", handleEmailInbound);
  app.post("/api/email/inbound/:tenantId/:connectorId", handleEmailInbound);

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
    let highlightedLoginMethod: string = "auto";
    if (config.edition === "saas") {
      try {
        const saas = await loadSaasServer();
        const oauthDeps = {
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
        };
        if (saas?.listPublicOauthProviders && saas?.loadLoginPolicy) {
          oauthProviders.push(...(await saas.listPublicOauthProviders(oauthDeps)));
          const policy = await saas.loadLoginPolicy(oauthDeps);
          if (policy.effective.disablePasswordLogin) {
            passwordLoginEnabled = false;
          }
          if (policy.effective.highlightedMethod) {
            highlightedLoginMethod = policy.effective.highlightedMethod;
          }
        } else if (saas?.loadZerocatConfig) {
          const { public: pub } = await saas.loadZerocatConfig(oauthDeps);
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
      highlightedLoginMethod,
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
        const oauthDeps = {
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
        };
        if (saas?.loadLoginPolicy) {
          const policy = await saas.loadLoginPolicy(oauthDeps);
          if (policy.effective.disablePasswordLogin) {
            return c.json({ error: "邮箱密码登录已关闭，请使用 OAuth 登录" }, 403);
          }
        } else if (saas?.loadZerocatConfig) {
          const { public: pub } = await saas.loadZerocatConfig(oauthDeps);
          if (pub.disablePasswordLogin) {
            return c.json({ error: "邮箱密码登录已关闭，请使用 OAuth 登录" }, 403);
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
    let result;
    try {
      result = await loginUser(db, body.email, body.password, {
        tenantSlug: body.tenantSlug?.trim() || undefined,
      });
    } catch (err) {
      if (err instanceof LoginBlockedError) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      throw err;
    }
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
    // SaaS: only surface admin-selected platform defaults (shown as「Zakura 自动」).
    // OSS: all healthy/running managed services remain available.
    const exposedManaged = config.multiTenant
      ? managed.filter((s) => platformAgentDefaults.autoManagedServices.includes(s.key))
      : managed;
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
      platformServices: exposedManaged.map((s) => ({
        key: s.key,
        name: s.name,
        mode: s.mode,
        healthStatus: s.healthStatus,
        mapsTo: s.mapsTo,
        // SaaS tenants never receive host addresses or raw service names for managed endpoints.
        ...(config.multiTenant ? {} : { endpointUrl: s.endpointUrl }),
      })),
      // multiTenant also gets which platform defaults are enabled (for「Zakura 自动」 UI).
      platformDefaults: {
        autoManagedServices: platformAgentDefaults.autoManagedServices,
        multiTenant: config.multiTenant,
      },
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
        recordPlatformFault("api.default_mcp_install", err, { subsystem: "api" });
      }
      try {
        await integrationCatalog.auth.ensureInstallations(
          session.tenantId,
          "browser-notifications",
          [result.agent.id],
        );
      } catch (err) {
        recordPlatformFault("api.browser_notifications_install", err, { subsystem: "api" });
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
      } catch {
        getTelemetry().mcpErrors.inc({ kind: "api_list_tools" });
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
      } catch {
        getTelemetry().mcpErrors.inc({ kind: "api_list_resources" });
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
      } catch {
        getTelemetry().mcpErrors.inc({ kind: "api_list_prompts" });
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
      } catch {
        getTelemetry().mcpErrors.inc({ kind: "api_list_resource_templates" });
      }

      const container = await agentService.workspace.getWorkspaceContainer(agent.id);
      let desktop: Awaited<ReturnType<typeof agentService.workspace.getDesktopInfo>>;
      try {
        desktop = await agentService.workspace.getDesktopInfo(agent);
      } catch {
        getTelemetry().platformFaults.inc({ kind: "api.desktop_info" });
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
      recordPlatformFault("api.agent_get", err, { subsystem: "api" });
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/agents/:id/desktop", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    return c.json(await agentService.workspace.getDesktopInfo(agent));
  });

  app.post("/api/agents/:id/desktop-ticket", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    if (!agent.enableComputer) return c.json({ error: "Desktop is disabled" }, 409);
    const ticket = signWorkspaceConnectionTicket(
      config.secret,
      session.tenantId,
      agent.id,
      "desktop",
    );
    return c.json({
      ticket,
      url: workspaceSocketUrl(config.publicBaseUrl, agent.id, "desktop", ticket),
    });
  });

  app.post("/api/agents/:id/terminal-ticket", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const ticket = signWorkspaceConnectionTicket(
      config.secret,
      session.tenantId,
      agent.id,
      "terminal",
    );
    return c.json({
      ticket,
      url: workspaceSocketUrl(config.publicBaseUrl, agent.id, "terminal", ticket),
    });
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
    return c.json(await agentService.listBindings(session.tenantId, agent.id));
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
  // Agent workspace filesystem — routes via WorkspaceFsProvider (local or remote)
  if (workspaceFsProvider) {
    registerAgentFsRoutes(app, agentService, workspaceFsProvider, db);
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

  // Cloud Agent：持久会话 + MCP 工具注入推理循环
  {
    const cloudStore = cloudSessionStore;
    // Registry-backed adapter catalogue + on-demand install. Shared by the ACP
    // session boot (to provision before launch) and the ACP routes (to browse the
    // catalogue and report per-adapter disk usage / updates).
    const acpRegistry = new AcpRegistryService(agentService.workspace);
    const acpSessions = new AcpSessionService({
      agentService,
      store: cloudStore,
      workspace: agentService.workspace,
      workspaceFs: workspaceFsProvider,
      publicBaseUrl: config.publicBaseUrl,
      maxConcurrentAcpPerTenant: config.maxConcurrentAcpPerTenant || 8,
      acpRegistry,
    });
    registerAcpRoutes(app, {
      agentService,
      acp: acpSessions,
      acpRegistry,
      publicBaseUrl: config.publicBaseUrl,
    });
    remoteIngress = new RemoteAgentIngress(
      db,
      agentService,
      cloudStore,
      {
        startTurn: async (input) => {
          if (!cloudAgentRuntime) {
            throw new Error("模型路由未启用，请先配置 chat 上游");
          }
          return cloudAgentRuntime.startTurn(input);
        },
      },
      config,
    );
    // 进程重启会丢掉内存中的 agent loop：把 DB 里仍标记运行中的 Run 收尾，
    // 否则这些会话在 UI 上会永远显示「进行中」且无法发送新消息
    void cloudStore
      .recoverInterruptedRuns()
      .then((n) => {
        if (n > 0) log.info("boot.cloud_agent_recovered", { count: n });
      })
      .catch((err) =>
        recordPlatformFault("cloud_agent.recover_interrupted", err, {
          subsystem: "cloud_agent",
        }),
      );
    if (modelRouter) {
      const { AgentHooksService } = await import("../services/agent-hooks.js");
      const agentHooks = new AgentHooksService(agentService.workspace);
      remoteRuntime = new RemoteChannelRuntime(
        config,
        connectorAuth,
        remoteIngress!,
        cloudStore,
      );
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
        remoteChannels: remoteRuntime.sessions,
        automation,
        acp: acpSessions,
      });
      cloudAgentRuntime = cloudRuntime;
      automation.setRunner({
        startAutomationTurn: (input) => cloudRuntime.startAutomationTurn(input),
      });
      automation.start();
      void db
        .select({ id: tenants.id })
        .from(tenants)
        .then((rows) => Promise.all(rows.map((row) => remoteRuntime?.startTenant(row.id))))
        .catch((error) => {
          recordPlatformFault("remote_agent.start_bindings", error, {
            subsystem: "remote_agent",
          });
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
        gateway,
        skills,
        acp: acpSessions,
      });
      registerAutomationRoutes(app, { agentService, automation });
      emailInbound = new EmailInboundService(
        db,
        integrationCatalog,
        agentService,
        cloudStore,
        cloudRuntime,
        remoteIngress!,
      );
      emailInbound.start();
    }
    if (!modelRouter) {
      // 无模型路由：注册只读会话 API，发消息时返回明确错误
      const unavailable = async (): Promise<never> => {
        throw new Error("模型路由未启用，请先配置 chat 上游");
      };
      registerCloudAgentRoutes(app, {
        agentService,
        store: cloudStore,
        runtime: {
          startTurn: unavailable,
          enqueueFollowUp: unavailable,
          interruptWithQueued: unavailable,
          startNextQueued: async () => {},
        },
        modelRouter,
        gateway,
        skills,
        acp: acpSessions,
      });
      // 自动化 CRUD 仍可配置；触发会失败直至模型路由可用
      registerAutomationRoutes(app, { agentService, automation });
    }
  }

  if (modelRouter) {
    const openAiGateway = new OpenAiGatewayService({
      agentService,
      modelRouter,
      store: cloudSessionStore,
    });
    registerOpenAiGatewayRoutes(app, {
      db,
      agentService,
      gateway: openAiGateway,
      upstreamModels,
    });
  }

  function remoteBindingView(binding: Awaited<ReturnType<RemoteAgentIngress["getBinding"]>>) {
    return remoteIngress ? remoteIngress.toBindingView(binding) : null;
  }

  app.get("/api/email-connectors", async (c) => {
    const session = c.get("session")!;
    return c.json({ connectors: await integrationCatalog.emailInstances.list(session.tenantId) });
  });

  app.post("/api/email-connectors", async (c) => {
    const session = c.get("session")!;
    if (!canManageMcpOauthApps(session, config, "tenant")) {
      return c.json({ error: "需要租户管理员权限" }, 403);
    }
    try {
      const body = await c.req.json<{
        name?: string;
        product?: string;
        config?: Record<string, unknown>;
        enabled?: boolean;
      }>();
      const connector = await integrationCatalog.emailInstances.create(session.tenantId, body);
      return c.json({ connector }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch("/api/email-connectors/:id", async (c) => {
    const session = c.get("session")!;
    if (!canManageMcpOauthApps(session, config, "tenant")) {
      return c.json({ error: "需要租户管理员权限" }, 403);
    }
    try {
      const body = await c.req.json<{
        name?: string;
        config?: Record<string, unknown>;
        enabled?: boolean;
      }>();
      const connector = await integrationCatalog.emailInstances.update(
        session.tenantId,
        c.req.param("id"),
        body,
      );
      return c.json({ connector });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/email-connectors/:id", async (c) => {
    const session = c.get("session")!;
    if (!canManageMcpOauthApps(session, config, "tenant")) {
      return c.json({ error: "需要租户管理员权限" }, 403);
    }
    const id = c.req.param("id");
    const removed = await integrationCatalog.emailInstances.remove(session.tenantId, id);
    if (!removed) return c.json({ error: "邮箱连接不存在" }, 404);
    if (remoteIngress) {
      const binding = (
        await remoteIngress.listBindings(session.tenantId, "email")
      ).find((item) => item.profileKey === `email-instance-${id}`);
      if (binding) await remoteIngress.deleteBinding(session.tenantId, binding.id);
    }
    return c.json({ ok: true });
  });

  app.get("/api/remote-channels", async (c) => {
    const session = c.get("session")!;
    const platform = c.req.query("platform")?.trim() || undefined;
    const bindings = remoteIngress
      ? await remoteIngress.listBindings(session.tenantId, platform)
      : [];
    return c.json({
      platforms: REMOTE_PLATFORMS,
      initialized: Boolean(remoteIngress),
      webhookBaseUrl: `${config.publicBaseUrl.replace(/\/$/, "")}/api/remote-channels/${session.tenantId}`,
      emailWebhookUrl: `${config.publicBaseUrl.replace(/\/$/, "")}/api/email/inbound/${session.tenantId}`,
      bindings: bindings.map((binding) => remoteBindingView(binding)),
    });
  });

  app.post("/api/remote-channels", async (c) => {
    const session = c.get("session")!;
    if (!canManageMcpOauthApps(session, config, "tenant")) {
      return c.json({ error: "需要租户管理员权限" }, 403);
    }
    if (!remoteIngress) return c.json({ error: "远程 Agent 通路未初始化" }, 503);
    const body = await c.req.json<{
      agentId?: string;
      platform?: string;
      profileKey?: string;
      label?: string;
      enabled?: boolean;
      settings?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
      credentialsEnabled?: boolean;
    }>();
    if (!body.agentId || !body.platform) {
      return c.json({ error: "agentId、platform 必填" }, 400);
    }
    if (!(REMOTE_PLATFORMS as readonly string[]).includes(body.platform)) {
      return c.json({ error: "不支持的远程平台" }, 400);
    }
    try {
      const binding = await remoteIngress.saveBinding(session.tenantId, {
        agentId: body.agentId,
        platform: body.platform,
        profileKey: body.profileKey ?? `remote-${body.platform}`,
        label: body.label,
        enabled: body.enabled,
        settings: body.settings,
        credentials: body.credentials,
        credentialsEnabled: body.credentialsEnabled,
      });
      if (binding.enabled) await remoteRuntime?.startBinding(session.tenantId, binding.id);
      return c.json({ binding: remoteBindingView(binding) }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch("/api/remote-channels/:id", async (c) => {
    const session = c.get("session")!;
    if (!canManageMcpOauthApps(session, config, "tenant")) {
      return c.json({ error: "需要租户管理员权限" }, 403);
    }
    if (!remoteIngress) return c.json({ error: "远程 Agent 通路未初始化" }, 503);
    const body = await c.req.json<{
      agentId?: string;
      platform?: string;
      profileKey?: string;
      label?: string;
      enabled?: boolean;
      settings?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
      credentialsEnabled?: boolean;
    }>();
    const current = await remoteIngress.getBinding(session.tenantId, c.req.param("id"));
    if (!current) return c.json({ error: "远程连接不存在" }, 404);
    try {
      if (body.platform && !(REMOTE_PLATFORMS as readonly string[]).includes(body.platform)) {
        return c.json({ error: "不支持的远程平台" }, 400);
      }
      let settings = body.settings;
      if (settings === undefined) {
        try {
          settings = JSON.parse(current.settingsJson) as Record<string, unknown>;
        } catch {
          settings = {};
        }
      }
      const binding = await remoteIngress.saveBinding(session.tenantId, {
        id: current.id,
        agentId: body.agentId ?? current.agentId,
        platform: body.platform ?? current.platform,
        profileKey: body.profileKey ?? current.profileKey,
        label: body.label ?? current.label,
        enabled: body.enabled ?? current.enabled,
        settings,
        credentials: body.credentials,
        credentialsEnabled: body.credentialsEnabled,
      });
      await remoteRuntime?.invalidate(current.id);
      if (binding.enabled) await remoteRuntime?.startBinding(session.tenantId, binding.id);
      return c.json({ binding: remoteBindingView(binding) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/remote-channels/:id", async (c) => {
    const session = c.get("session")!;
    if (!canManageMcpOauthApps(session, config, "tenant")) {
      return c.json({ error: "需要租户管理员权限" }, 403);
    }
    if (!remoteIngress) return c.json({ error: "远程 Agent 通路未初始化" }, 503);
    const id = c.req.param("id");
    await remoteRuntime?.invalidate(id);
    return c.json({ ok: await remoteIngress.deleteBinding(session.tenantId, id) });
  });

  app.post("/api/remote-channels/:id/access/approve", async (c) => {
    const session = c.get("session")!;
    if (!canManageMcpOauthApps(session, config, "tenant")) {
      return c.json({ error: "需要租户管理员权限" }, 403);
    }
    if (!remoteIngress) return c.json({ error: "远程 Agent 通路未初始化" }, 503);
    const body = await c.req.json<{ userKey?: string }>();
    if (!body.userKey?.trim()) return c.json({ error: "userKey 必填" }, 400);
    try {
      const result = await remoteIngress.approveUser(
        session.tenantId,
        c.req.param("id"),
        body.userKey,
      );
      const binding = await remoteIngress.getBinding(session.tenantId, c.req.param("id"));
      return c.json({ ok: result.ok, binding: remoteBindingView(binding), settings: result.settings });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/remote-channels/:id/access/deny", async (c) => {
    const session = c.get("session")!;
    if (!canManageMcpOauthApps(session, config, "tenant")) {
      return c.json({ error: "需要租户管理员权限" }, 403);
    }
    if (!remoteIngress) return c.json({ error: "远程 Agent 通路未初始化" }, 503);
    const body = await c.req.json<{ userKey?: string }>();
    if (!body.userKey?.trim()) return c.json({ error: "userKey 必填" }, 400);
    try {
      const result = await remoteIngress.denyUser(
        session.tenantId,
        c.req.param("id"),
        body.userKey,
      );
      const binding = await remoteIngress.getBinding(session.tenantId, c.req.param("id"));
      return c.json({ ok: result.ok, binding: remoteBindingView(binding), settings: result.settings });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.all("/api/remote-channels/:tenantId/:bindingId/webhook", async (c) => {
    if (!remoteRuntime) return c.json({ error: "远程 Agent 通路未启用" }, 503);
    try {
      return await remoteRuntime.handleWebhook(
        c.req.param("tenantId"),
        c.req.param("bindingId"),
        c.req.raw,
      );
    } catch (err) {
      recordPlatformFault("remote_agent.webhook", err, { subsystem: "remote_agent" });
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

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
    registerUsageRoutes(app as never, { db, usage: bindUserUsage(db) });
  }

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
        invalidateSuspension: (kind: "user" | "tenant", id: string) => {
          if (kind === "user") invalidateUserSuspension(id);
          else invalidateTenantSuspension(id);
        },
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
      imageUpdateChecker,
    });
  }
  if (migrations) {
    registerMigrationRoutes(app, { migrations, agentService });
  }
  if (skills) {
    registerSkillRoutes(app, { skills, agentService, multiTenant: config.multiTenant });
  }
  registerMemoryRoutes(app, { memoryStore, memoryProviders, agentService, modelRouter });
  const syncConnectorCapabilities = makeSyncConnectorCapabilities({
    skills,
    integrationCatalog,
  });
  registerMcpRoutes(app, {
    db,
    config,
    mcpStore,
    integrationCatalog,
    upstreamOauth,
    upstreamOauthClients,
    agentService,
    orchestrator,
    gateway,
    syncConnectorCapabilities,
  });
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
    const body = await c.req.json<{
      name: string;
      agentId?: string | null;
      scopes?: unknown;
      expiresAt?: unknown;
    }>();
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter(
          (scope): scope is string => typeof scope === "string" && scope.trim().length > 0,
        )
      : undefined;
    let expiresAt: Date | null | undefined;
    if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== "") {
      expiresAt = new Date(String(body.expiresAt));
      if (!Number.isFinite(expiresAt.getTime())) {
        return c.json({ error: "expiresAt 无效" }, 400);
      }
    } else if (body.expiresAt === null || body.expiresAt === "") {
      expiresAt = null;
    }
    if (body.agentId) {
      const agent = await agentService.get(session.tenantId, body.agentId);
      if (!agent) return c.json({ error: "agent not found" }, 400);
      const key = await agentService.createAgentApiKey(
        session.tenantId,
        agent.id,
        body.name,
        { ...(scopes ? { scopes } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) },
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
        ...(scopes ? { scopes: JSON.stringify(scopes) } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
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

  app.delete("/api/api-keys/:id", async (c) => {
    const session = c.get("session")!;
    const row = await db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.tenantId, session.tenantId)),
    });
    if (!row) return c.json({ error: "API Key not found" }, 404);
    await db.delete(apiKeys).where(eq(apiKeys.id, row.id));
    return c.json({ ok: true });
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

  registerConnectorRoutes(app, {
    db,
    config,
    agentService,
    skills,
    integrationCatalog,
    upstreamOauth,
    upstreamOauthPending,
    purgeUpstreamOauthPending,
    getRemoteIngress: () => remoteIngress,
  });

  /**
   * Google Cloud 供应引导（无需 SA）：返回 Console 链接、scopes、限制说明。
   * 完整自动创建 Web OAuth 客户端被 Google 官方限制，见 limitation 字段。
   */
  app.get("/api/settings/email/transactional", async (c) => {
    const session = c.get("session")!;
    if (!canManageTransactionalEmail(session, config)) {
      return c.json({ error: "需要平台管理员权限" }, 403);
    }
    return c.json(await getPlatformTransactionalEmailPublic(db, config.secret));
  });

  app.put("/api/settings/email/transactional", async (c) => {
    const session = c.get("session")!;
    if (!canManageTransactionalEmail(session, config)) {
      return c.json({ error: "需要平台管理员权限" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as PlatformTransactionalEmailPatch;
    try {
      const saved = await patchPlatformTransactionalEmail(db, config.secret, {
        enabled: body.enabled,
        fromEmail: body.fromEmail,
        baseUrl: body.baseUrl,
        providerId: body.providerId,
        apiToken: body.apiToken,
      });
      return c.json(saved);
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

  // ── Global image update status (for banners across UI) ──────────────
  if (imageUpdateChecker && runtimeNodes) {
    // 按 tenantId 过滤缓存中的节点状态，并附加节点元数据（name/status/kind/access），
    // 避免跨租户泄露 nodeId —— checker 后台轮询是跨租户的，缓存含所有节点。
    const decorate = (
      s: import("../services/image-update-checker.js").NodeImageUpdateStatus,
      meta: { name: string; status: string; kind: string; access: "owned" | "shared" },
    ) => ({
      ...s,
      nodeName: meta.name,
      nodeStatus: meta.status,
      nodeKind: meta.kind,
      access: meta.access,
    });

    app.get("/api/system/image-updates", async (c) => {
      const session = c.get("session")!;
      const accessible = await runtimeNodes.listAccessible(session.tenantId);
      const metaMap = new Map(
        accessible.map((n) => [
          n.id,
          {
            name: n.name,
            status: n.status,
            kind: n.kind,
            access: n.access,
          },
        ]),
      );
      const nodes = imageUpdateChecker
        .getAllStatuses()
        .filter((s) => metaMap.has(s.nodeId))
        .map((s) => decorate(s, metaMap.get(s.nodeId)!));
      const hasUpdates = nodes.some((s) => s.hasUpdates);
      const hasRunningStale = nodes.some((s) => s.hasRunningStale);
      // 探测失败 ≠ 已是最新：前端要能把「未知」和「最新」区分开。
      const hasErrors = nodes.some((s) => hasImageProbeErrors(s));
      return c.json({ hasUpdates, hasRunningStale, hasErrors, nodes });
    });

    app.post("/api/system/image-updates/check", async (c) => {
      const session = c.get("session")!;
      const body = (await c.req.json().catch(() => ({}))) as { nodeId?: string };
      if (!body.nodeId?.trim()) return c.json({ error: "nodeId is required" }, 400);
      const nodeId = body.nodeId.trim();
      const node = await runtimeNodes.getAccessible(session.tenantId, nodeId);
      if (!node) return c.json({ error: "Not found" }, 404);
      try {
        // 用户点的「检查」允许最后退回 docker pull 取摘要（后台巡检永远不会）。
        const status = await imageUpdateChecker.checkNode(nodeId, {
          allowPullFallback: true,
        });
        return c.json(
          decorate(status, {
            name: node.name,
            status: node.status,
            kind: node.kind,
            access:
              node.isShared && node.tenantId !== session.tenantId
                ? "shared"
                : "owned",
          }),
        );
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          502,
        );
      }
    });

    app.post("/api/system/image-updates/check-all", async (c) => {
      const session = c.get("session")!;
      const accessible = await runtimeNodes.listAccessible(session.tenantId);
      // 检查所有在线节点（local + 远程 runner），串行避免突发负载。
      const toCheck = accessible.filter((n) => n.status === "online");
      const nodes = [];
      for (const node of toCheck) {
        try {
          const status = await imageUpdateChecker.checkNode(node.id);
          nodes.push(
            decorate(status, {
              name: node.name,
              status: node.status,
              kind: node.kind,
              access: node.access,
            }),
          );
        } catch (err) {
          nodes.push({
            nodeId: node.id,
            nodeName: node.name,
            nodeStatus: node.status,
            nodeKind: node.kind,
            access: node.access,
            checkedAt: Date.now(),
            entries: [],
            hasUpdates: false,
            hasRunningStale: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const hasUpdates = nodes.some((s) => s.hasUpdates);
      const hasRunningStale = nodes.some((s) => s.hasRunningStale);
      const hasErrors = nodes.some((s) => hasImageProbeErrors(s));
      return c.json({ hasUpdates, hasRunningStale, hasErrors, nodes });
    });
  }

  return app;
}
