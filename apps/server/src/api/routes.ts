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
  LoginAmbiguousError,
  loginUser,
  sessionFromLogin,
  signSession,
  switchTenantSession,
  verifySession,
} from "../services/auth.js";
import { InstanceNotFoundError, type Orchestrator } from "../services/orchestrator.js";
import type { McpGateway } from "../services/mcp-gateway.js";
import type { AgentService } from "../services/agents.js";
import type { DockerRuntime } from "../runtime/docker.js";
import {
  ensureCapabilityInstance,
  readInstanceConfig,
  saveCapabilityConfig,
} from "../services/capabilities.js";
import { listSearchEngineMeta } from "../capabilities/web-search/index.js";
import { listFetchBackendMeta } from "../capabilities/web-fetch/index.js";
import { MEMORY_LAYERS, type MemoryStore } from "../services/memory-store.js";
import {
  isMemoryProviderKind,
  type MemoryProvidersService,
} from "../services/memory-providers.js";
import { resolveAgentMemory } from "../services/memory-runtime.js";
import type { ToolCallStore } from "../services/tool-call-store.js";
import { OauthError, type OauthService } from "../services/oauth.js";
import { PROVIDER_CATEGORY_META } from "@zakura/shared";
import { registerAgentFsRoutes } from "./agent-fs-routes.js";
import { registerRuntimeNodeRoutes } from "./runtime-node-routes.js";
import { registerTenantRoutes } from "./tenant-routes.js";
import { TenantService } from "../services/tenants.js";
import { registerMigrationRoutes } from "./migration-routes.js";
import { registerNetworkRoutes } from "./network-routes.js";
import { loadSaasServer } from "../saas-loader.js";
import type { RuntimeNodeService } from "../services/runtime-nodes.js";
import type { MigrationService } from "../services/migration-service.js";
import type { ServerWorkspaceFsProvider } from "../services/workspace-fs-provider.js";
import type { NetworkSettingsService } from "../services/network-settings.js";
import type { SecurityPolicyService } from "../services/network-security.js";
import type { ExposureService } from "../services/port-exposures.js";
import type { NetworkAuditService } from "../services/network-audit.js";
import { McpStoreService } from "../services/mcp-store.js";
import {
  McpUpstreamOauthService,
  type UpstreamOauthDiscovery,
} from "../services/mcp-upstream-oauth.js";
import {
  buildByoOauthClient,
  oauthAppIdForMcpUrl,
  resolvePreRegisteredOauthClient,
} from "../services/mcp-oauth-clients.js";
import {
  listMcpOauthAppsPublic,
  patchMcpOauthApp,
  type McpOauthAppId,
  type McpOauthAppScope,
} from "../services/mcp-oauth-apps.js";
import {
  buildGoogleProvisionGuide,
  googleOauthSetupChecklist,
  provisionGoogleWorkspaceMcp,
} from "../services/google-cloud-provision.js";
import { applyOauthTokensToConfig } from "../providers/generic-mcp.js";
import { randomBytes } from "node:crypto";

/** Short-lived upstream OAuth PKCE state (in-memory) */
const upstreamOauthPending = new Map<
  string,
  {
    tenantId: string;
    instanceId?: string;
    mcpUrl: string;
    clientId: string;
    clientSecret?: string;
    codeVerifier: string;
    redirectUri: string;
    tokenEndpoint: string;
    createdAt: number;
  }
>();

function purgeUpstreamOauthPending() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of upstreamOauthPending) {
    if (v.createdAt < cutoff) upstreamOauthPending.delete(k);
  }
}

/** Throttle live Docker inspect on GET /api/containers?sync=1 */
const containerListSyncAt = new Map<string, number>();
const CONTAINER_LIST_SYNC_TTL_MS = 15_000;

/**
 * Client 获取顺序：
 * 1. 请求体 BYO（用户自备 OAuth Client ID/Secret）
 * 2. DCR（上游支持时）
 * 3. 租户自建 → 整站平台 → 环境变量
 */
async function resolveUpstreamOauthClient(opts: {
  upstreamOauth: McpUpstreamOauthService;
  config: AppConfig;
  db: Db;
  tenantId: string;
  discovery: UpstreamOauthDiscovery;
  mcpUrl: string;
  redirectUri: string;
  clientName?: string;
  /** 用户安装时直接提供的 OAuth 客户端（非 API Key） */
  byo?: { clientId?: string; clientSecret?: string; scopes?: string };
}): Promise<{
  clientId: string;
  clientSecret?: string;
  scopeOverride?: string;
  source: "dcr" | "byo" | "tenant" | "platform" | "env";
} | null> {
  if (opts.byo?.clientId?.trim()) {
    const byo = buildByoOauthClient(opts.mcpUrl, {
      clientId: opts.byo.clientId,
      clientSecret: opts.byo.clientSecret,
      scopes: opts.byo.scopes,
    });
    if (byo) {
      return {
        clientId: byo.clientId,
        clientSecret: byo.clientSecret,
        scopeOverride: byo.scopes,
        source: "byo",
      };
    }
  }

  if (opts.discovery.registrationEndpoint) {
    const registered = await opts.upstreamOauth.registerClient(opts.discovery, {
      clientName: opts.clientName,
      redirectUris: [opts.redirectUri],
    });
    return {
      clientId: registered.clientId,
      clientSecret: registered.clientSecret,
      source: "dcr",
    };
  }

  const pre = await resolvePreRegisteredOauthClient(
    opts.mcpUrl,
    opts.config,
    opts.db,
    opts.tenantId,
  );
  if (pre) {
    return {
      clientId: pre.clientId,
      clientSecret: pre.clientSecret,
      scopeOverride: pre.scopes,
      source: pre.source,
    };
  }
  return null;
}

async function noDcrOauthError(
  mcpUrl: string,
  config: AppConfig,
  db: Db,
  tenantId: string,
): Promise<string> {
  const pre = await resolvePreRegisteredOauthClient(mcpUrl, config, db, tenantId);
  if (pre) return "";
  const host = (() => {
    try {
      return new URL(mcpUrl).hostname;
    } catch {
      return mcpUrl;
    }
  })();
  if (host.includes("github")) {
    return "GitHub Remote MCP 不支持动态注册。请填写你自己的 OAuth App Client ID/Secret，或在「设置 → OAuth 应用」保存后重试；也可改用 PAT。";
  }
  if (host.includes("googleapis.com") || host.includes("google")) {
    return "Google Workspace MCP 不接受 API Key，必须使用 OAuth 2.0 Client ID/Secret。请在安装时填写自建客户端，或在「设置 → OAuth 应用」配置后重试。";
  }
  return "上游不支持动态客户端注册。请填写自备 OAuth Client ID/Secret，或在「设置 → OAuth 应用」配置。";
}

/** 租户管理员可管本租户；整站仅超管（OSS 下管理员可管整站） */
function canManageMcpOauthApps(
  session: { role: string; userId: string; isPlatformAdmin?: boolean },
  config: AppConfig,
  scope: McpOauthAppScope,
): boolean {
  if (scope === "tenant") return isSessionAdmin(session);
  if (config.multiTenant) return session.isPlatformAdmin === true;
  return isSessionAdmin(session);
}

function upstreamAuthorizeExtra(mcpUrl: string): Record<string, string> | undefined {
  const appId = oauthAppIdForMcpUrl(mcpUrl);
  if (appId === "google") {
    return { access_type: "offline", prompt: "consent" };
  }
  return undefined;
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
  const containers = await db
    .select()
    .from(managedContainers)
    .where(
      and(eq(managedContainers.instanceId, id), eq(managedContainers.tenantId, tenantId)),
    );
  return { ...instance, containers };
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
  toolCallStore: ToolCallStore;
  oauth: OauthService;
  runtimeNodes?: RuntimeNodeService;
  migrations?: MigrationService;
  workspaceFsProvider?: ServerWorkspaceFsProvider;
  networkSettings?: NetworkSettingsService;
  securityPolicy?: SecurityPolicyService;
  exposures?: ExposureService;
  networkAudit?: NetworkAuditService;
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
    toolCallStore,
    oauth,
    runtimeNodes,
    migrations,
    workspaceFsProvider,
    networkSettings,
    securityPolicy,
    exposures,
    networkAudit,
  } = deps;
  const mcpStore = new McpStoreService(config);
  const upstreamOauth = new McpUpstreamOauthService(config);
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

    // probe/import require auth — intentional
    if (publicPaths.has(path) || isInvitePublic) {
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
      registrationEnabled: config.edition === "saas",
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
    const body = await c.req
      .json<{ email?: string; password?: string; tenantSlug?: string }>()
      .catch(() => ({} as { email?: string; password?: string; tenantSlug?: string }));
    if (!body.email || !body.password) {
      return c.json({ error: "email and password required" }, 400);
    }
    try {
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
    } catch (err) {
      if (err instanceof LoginAmbiguousError) {
        return c.json(
          {
            error: "tenant_required",
            message: err.message,
            tenants: err.tenants,
          },
          400,
        );
      }
      throw err;
    }
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
    return c.json({
      user: user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            isPlatformAdmin: user.isPlatformAdmin,
          }
        : { id: "api-key", email: session.email, isPlatformAdmin: false },
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
      multiTenant: config.multiTenant,
      edition: config.edition,
      registrationEnabled: config.edition === "saas",
      connect: {
        agentMcpPattern: `${config.publicBaseUrl}/mcp/agents/{slug}`,
        authorizeUrl: `${config.webPublicUrl}/oauth/authorize`,
        tokenUrl: `${config.publicBaseUrl}/token`,
        registerUrl: `${config.publicBaseUrl}/register`,
        oauthMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-authorization-server`,
        resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
        webPublicUrl: config.webPublicUrl,
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
    return c.json(await oauth.listClients(session.tenantId));
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

    const client = await oauth.getClient(clientId);
    if (!client) return c.json({ error: "未知客户端，请先完成动态注册" }, 400);
    const uris = oauth.parseRedirectUris(client);
    if (!uris.includes(redirectUri)) {
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
    const capabilityConfig = readInstanceConfig(config, instance);
    return c.json({
      instance: {
        id: instance.id,
        status: instance.status,
        healthStatus: instance.healthStatus,
        lastError: instance.lastError,
        slug: instance.slug,
      },
      engines: listSearchEngineMeta(),
      config: capabilityConfig,
    });
  });

  /** 网页能力聚合：一次返回 web-search + web-fetch，供设置页首屏 */
  app.get("/api/capabilities", async (c) => {
    const session = c.get("session")!;
    const [searchInst, fetchInst] = await Promise.all([
      ensureCapabilityInstance(db, orchestrator, session.tenantId, "web-search"),
      ensureCapabilityInstance(db, orchestrator, session.tenantId, "web-fetch"),
    ]);
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
        config: readInstanceConfig(config, searchInst),
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
        config: readInstanceConfig(config, fetchInst),
      },
    });
  });

  app.put("/api/capabilities/web-search", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<Record<string, unknown>>();
    try {
      const instance = await saveCapabilityConfig(
        db,
        orchestrator,
        config,
        session.tenantId,
        "web-search",
        body,
      );
      return c.json({
        ok: true,
        instance,
        config: instance ? readInstanceConfig(config, instance) : body,
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
    const capabilityConfig = readInstanceConfig(config, instance);
    return c.json({
      instance: {
        id: instance.id,
        status: instance.status,
        healthStatus: instance.healthStatus,
        lastError: instance.lastError,
        slug: instance.slug,
      },
      backends: listFetchBackendMeta(),
      config: capabilityConfig,
    });
  });

  app.put("/api/capabilities/web-fetch", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<Record<string, unknown>>();
    try {
      const instance = await saveCapabilityConfig(
        db,
        orchestrator,
        config,
        session.tenantId,
        "web-fetch",
        body,
      );
      return c.json({
        ok: true,
        instance,
        config: instance ? readInstanceConfig(config, instance) : body,
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

  /** @deprecated Prefer /api/memory-providers */
  app.get("/api/capabilities/memory", async (c) => {
    const session = c.get("session")!;
    const [list, usage] = await Promise.all([
      memoryProviders.list(session.tenantId),
      memoryProviders.usage(session.tenantId),
    ]);
    const def = list.find((p) => p.isDefault) ?? list[0];
    return c.json({
      providers: list,
      config: def
        ? {
            enabled: true,
            defaultUserId:
              typeof def.config.defaultUserId === "string"
                ? def.config.defaultUserId
                : "default",
            provider: def.kind,
            defaultProviderId: def.id,
          }
        : { enabled: true, defaultUserId: "default", provider: "builtin" },
      instance: def
        ? { id: def.id, status: def.status, slug: def.slug }
        : { id: "", status: "ready", slug: "" },
      layers: MEMORY_LAYERS,
      agents: usage,
      note: "请改用 /api/memory-providers",
    });
  });

  app.put("/api/capabilities/memory", async (c) => {
    return c.json(
      {
        ok: false,
        error: "已弃用：请在记忆页创建多个 Provider，并在 Agent 记忆页选择。",
      },
      410,
    );
  });

  app.get("/api/instances", async (c) => {
    const session = c.get("session")!;
    const rows = await db
      .select()
      .from(componentInstances)
      .where(eq(componentInstances.tenantId, session.tenantId))
      .orderBy(desc(componentInstances.createdAt));

    const providerIds = [...new Set(rows.map((r) => r.providerId))];
    const providers =
      providerIds.length > 0
        ? await db.select().from(providerCatalog).where(inArray(providerCatalog.id, providerIds))
        : [];
    const providerMap = new Map(providers.map((p) => [p.id, p]));

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

  app.post("/api/instances/:id/health", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    try {
      const result = await orchestrator.refreshHealth(session.tenantId, id);
      return c.json(result);
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
    const fresh = await loadInstanceWithContainers(db, session.tenantId, id);
    if (!fresh) {
      return c.json({ error: "Not found" }, 404);
    }
    const handle = await orchestrator.toHandle(session.tenantId, id);
    const safeConfig = { ...handle.config };
    for (const key of Object.keys(safeConfig)) {
      if (
        /secret|token|password|apikey|api_key|refresh/i.test(key) &&
        typeof safeConfig[key] === "string" &&
        String(safeConfig[key]).length > 0
      ) {
        safeConfig[key] = "***";
      }
    }
    let tools: Awaited<ReturnType<typeof gateway.listToolsForTenant>> = [];
    try {
      if (fresh.status === "running") {
        const plugin = globalRegistry.get(fresh.providerId);
        const defs = await plugin.listTools(handle);
        tools = defs.map((t) => ({
          qualifiedName: `re_${fresh.slug}__${t.name}`,
          instanceId: fresh.id,
          providerId: fresh.providerId,
          localName: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      }
    } catch {
      tools = [];
    }
    return c.json({ ...fresh, config: safeConfig, tools });
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
      const result = await agentService.create(session.tenantId, body);
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
      }> = [];
      try {
        const listed = await gateway.listToolsForAgent(agent);
        tools = listed.map((t) => ({
          name: t.qualifiedName,
          description: t.description,
          agentScoped: Boolean(t.agentScoped),
          providerId: t.providerId,
        }));
      } catch (err) {
        console.warn(`[api] listToolsForAgent ${agent.slug}:`, err);
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
      enableFs?: boolean;
      enableShell?: boolean;
      enableComputer?: boolean;
      enableBrowser?: boolean;
      enableMemory?: boolean;
      memoryProviderId?: string | null;
      workspaceImage?: string | null;
      runtimeNodeId?: string | null;
      config?: Record<string, unknown>;
      restart?: boolean;
    }>();
    try {
      const agent = await agentService.update(session.tenantId, c.req.param("id"), body);
      return c.json(agentService.serialize(agent));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
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
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/agents/:id/progress", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Not found" }, 404);
    const { getAgentProgress } = await import("../services/agent-progress.js");
    const container = await agentService.workspace.getWorkspaceContainer(agent.id);
    const progress = getAgentProgress(agent.id);
    const needsWs =
      agent.enableShell || agent.enableComputer || agent.enableBrowser;
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
      mcp?: { mode?: "all" | "selected"; instanceIds?: string[] };
      enableMemory?: boolean;
      memoryProviderId?: string | null;
    }>();
    try {
      const patch: {
        webSearch?: { enabled?: boolean; defaultEngine?: string };
        webFetch?: { enabled?: boolean; defaultBackend?: string };
        mcp?: { mode?: "all" | "selected"; instanceIds?: string[] };
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
        return c.json({ error: "请先在记忆 Provider 中启用 embedding 并填写 baseUrl/model" }, 400);
      }
      const result = await reembedAgentMemories(
        memoryStore,
        session.tenantId,
        agent.id,
        cfg,
        { limit: 100 },
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
  }

  registerTenantRoutes(app, {
    db,
    config,
    tenants: tenantService,
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

  /** One-click import: probe + create generic-mcp instance */
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
    }>();
    if (!body.mcpUrl) return c.json({ error: "mcpUrl required" }, 400);

    const authMode = body.authMode ?? (body.apiKey?.trim() ? "apiKey" : "none");

    try {
      const urlHost = (() => {
        try {
          return new URL(body.mcpUrl).hostname.replace(/\./g, "-");
        } catch {
          return "upstream";
        }
      })();

      const name = body.name?.trim() || `MCP ${urlHost}`;
      const slug =
        body.slug?.trim() ||
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 32) ||
        `mcp-${Date.now().toString(36)}`;

      const { normalizeMcpHttpUrl } = await import("../lib/mcp-http.js");
      const mcpUrl = normalizeMcpHttpUrl(body.mcpUrl);

      // OAuth 2.1: create instance marked authRequired, then return authorize URL
      if (authMode === "oauth") {
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
          },
        });

        purgeUpstreamOauthPending();
        const discovery = await upstreamOauth.discover(mcpUrl);
        const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
        const client = await resolveUpstreamOauthClient({
          upstreamOauth,
          config,
          db,
          tenantId: session.tenantId,
          discovery,
          mcpUrl,
          redirectUri,
          clientName: name,
          byo: {
            clientId: body.oauthClientId,
            clientSecret: body.oauthClientSecret,
            scopes: body.oauthScopes,
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
                error: await noDcrOauthError(mcpUrl, config, db, session.tenantId),
                needsByoClient: true,
                needsPatFallback: /github/i.test(mcpUrl),
                redirectUri,
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
          extraParams: upstreamAuthorizeExtra(mcpUrl),
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
    return c.json({ ok: !result.isError, result });
  });

  /** MCP Store — official registry + curated source links */
  app.get("/api/mcp/store/sources", async (c) => {
    return c.json({ sources: mcpStore.listSources() });
  });

  app.post("/api/mcp/store/sync", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      force?: boolean;
      maxPages?: number;
      stores?: Array<"github-mcp" | "official-registry" | "mcpservers-org" | "awesome-mcp">;
      store?: "github-mcp" | "official-registry" | "mcpservers-org" | "awesome-mcp";
    };
    try {
      const stores = body.stores?.length
        ? body.stores
        : body.store
          ? [body.store]
          : undefined;
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
    const q = c.req.query("q") ?? "";
    const kind = (c.req.query("kind") as "http" | "stdio" | "all" | undefined) ?? "all";
    const store =
      (c.req.query("store") as
        | "github-mcp"
        | "official-registry"
        | "mcpservers-org"
        | "awesome-mcp"
        | "all"
        | undefined) ?? "github-mcp";
    const limit = Number(c.req.query("limit") ?? 40);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await mcpStore.search({ q, kind, store, limit, offset });
    return c.json(result);
  });

  app.get("/api/mcp/store/servers/:name", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const store = c.req.query("store") as
      | "github-mcp"
      | "official-registry"
      | "mcpservers-org"
      | "awesome-mcp"
      | undefined;
    const server = await mcpStore.getServer(name, store);
    if (!server) return c.json({ error: "Not found" }, 404);
    const preview = mcpStore.buildInstallPreview(server);
    return c.json({ ...server, preview });
  });

  app.post("/api/mcp/store/install", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name: string;
      store?: "github-mcp" | "official-registry" | "mcpservers-org" | "awesome-mcp";
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
      const server = await mcpStore.getServer(body.name, body.store);
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
    }>();

    let mcpUrl = body.mcpUrl?.trim() ?? "";
    if (!mcpUrl && body.instanceId) {
      const existing = await db.query.componentInstances.findFirst({
        where: and(
          eq(componentInstances.id, body.instanceId),
          eq(componentInstances.tenantId, session.tenantId),
        ),
      });
      if (!existing) return c.json({ error: "instance not found" }, 404);
      const cfg = decryptJson<Record<string, unknown>>(config.secret, existing.configEnc);
      mcpUrl =
        (typeof cfg.mcpUrl === "string" && cfg.mcpUrl) ||
        existing.endpointUrl ||
        "";
    }
    if (!mcpUrl) return c.json({ error: "mcpUrl required" }, 400);

    try {
      purgeUpstreamOauthPending();
      const discovery = await upstreamOauth.discover(mcpUrl);
      const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
      const client = await resolveUpstreamOauthClient({
        upstreamOauth,
        config,
        db,
        tenantId: session.tenantId,
        discovery,
        mcpUrl,
        redirectUri,
        clientName: body.clientName,
        byo: {
          clientId: body.oauthClientId,
          clientSecret: body.oauthClientSecret,
          scopes: body.scope,
        },
      });

      if (!client) {
        return c.json(
          {
            ok: false,
            discovery,
            error: await noDcrOauthError(mcpUrl, config, db, session.tenantId),
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

      const state = randomBytes(16).toString("hex");
      const { url, codeVerifier } = upstreamOauth.buildAuthorizeUrl({
        discovery,
        clientId: client.clientId,
        redirectUri,
        state,
        scope: upstreamOauth.resolveScope(discovery, body.scope ?? client.scopeOverride),
        resource: discovery.resource ?? mcpUrl,
        extraParams: upstreamAuthorizeExtra(mcpUrl),
      });

      upstreamOauthPending.set(state, {
        tenantId: session.tenantId,
        instanceId: body.instanceId,
        mcpUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        codeVerifier,
        redirectUri,
        tokenEndpoint: discovery.tokenEndpoint,
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
        extraParams: upstreamAuthorizeExtra(body.mcpUrl),
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
        `${config.webPublicUrl}/oauth/mcp-upstream/callback?error=${encodeURIComponent(err)}`,
      );
    }
    if (!code || !state) {
      return c.redirect(
        `${config.webPublicUrl}/oauth/mcp-upstream/callback?error=missing_code`,
      );
    }
    const pending = upstreamOauthPending.get(state);
    upstreamOauthPending.delete(state);
    if (!pending) {
      return c.redirect(
        `${config.webPublicUrl}/oauth/mcp-upstream/callback?error=invalid_state`,
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
        resource: pending.mcpUrl,
      });

      let instanceId = pending.instanceId;
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
        `${config.webPublicUrl}/oauth/mcp-upstream/callback?ok=1&instanceId=${encodeURIComponent(instanceId)}`,
      );
    } catch (exchangeErr) {
      const msg = exchangeErr instanceof Error ? exchangeErr.message : String(exchangeErr);
      return c.redirect(
        `${config.webPublicUrl}/oauth/mcp-upstream/callback?error=${encodeURIComponent(msg)}`,
      );
    }
  });

  // NOTE: after successful upstream OAuth the instance config already has tokens;
  // refresh health so UI flips off AUTH_REQUIRED
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
    try {
      const result = await orchestrator.refreshHealth(session.tenantId, body.instanceId);
      return c.json({ ok: result.status === "healthy", health: result });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.get("/api/settings", async (c) => {
    const session = c.get("session")!;
    const rows = await db
      .select()
      .from(settings)
      .where(or(eq(settings.ownerKey, "platform"), eq(settings.ownerKey, session.tenantId)));
    return c.json(
      Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])),
    );
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
        "Google Workspace MCP 须使用 OAuth Client ID/Secret（不是 API Key）。将此 URI 填入你的 OAuth App。",
    });
  });

  app.get("/api/mcp/oauth-apps", async (c) => {
    const session = c.get("session")!;
    const scopeParam = (c.req.query("scope") ?? "tenant") as McpOauthAppScope;
    const scope: McpOauthAppScope = scopeParam === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const apps = await listMcpOauthAppsPublic(
      db,
      config,
      scope,
      scope === "tenant" ? session.tenantId : undefined,
    );
    return c.json({
      apps,
      scope,
      redirectUri: `${config.publicBaseUrl.replace(/\/$/, "")}/api/mcp/upstream-oauth/callback`,
      note:
        "Google Workspace MCP 不支持 API Key，请填写 OAuth 2.0 Client ID/Secret；安装时可临时传入自备客户端，由本服务自动完成授权。",
    });
  });

  app.put("/api/mcp/oauth-apps/:id", async (c) => {
    const session = c.get("session")!;
    const scopeParam = (c.req.query("scope") ?? "tenant") as McpOauthAppScope;
    const scope: McpOauthAppScope = scopeParam === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const id = c.req.param("id") as McpOauthAppId;
    if (id !== "github" && id !== "google") {
      return c.json({ error: "未知应用" }, 404);
    }
    const body = await c.req.json<{
      enabled?: boolean;
      clientId?: string;
      clientSecret?: string;
      scopes?: string;
    }>();
    try {
      const app = await patchMcpOauthApp(
        db,
        config,
        id,
        body,
        scope,
        scope === "tenant" ? session.tenantId : undefined,
      );
      return c.json({ app, scope });
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
    const productsRaw = c.req.query("products") ?? "gmail,drive,calendar";
    const products = productsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is "gmail" | "drive" | "calendar" =>
        s === "gmail" || s === "drive" || s === "calendar",
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
      products?: Array<"gmail" | "drive" | "calendar">;
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

  /** @deprecated use GET /api/tenant/current */
  app.get("/api/tenant/default", async (c) => {
    const session = c.get("session")!;
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, session.tenantId),
    });
    if (!tenant) return c.json({ error: "Not found" }, 404);
    return c.json({
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      isDefault: tenant.isDefault,
      onboardingCompleted: tenant.onboardingCompleted,
    });
  });

  return app;
}
