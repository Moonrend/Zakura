import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { bindProviderRuntime, registerBuiltinProviders } from "./providers/index.js";
import { registerBuiltinModelAdapters } from "./model-router/index.js";
import { DockerRuntime } from "./runtime/docker.js";
import { Orchestrator } from "./services/orchestrator.js";
import { McpGateway } from "./services/mcp-gateway.js";
import { AgentService } from "./services/agents.js";
import { AgentBrowserService } from "./services/agent-cdp.js";
import { MemoryStore } from "./services/memory-store.js";
import { MemoryProvidersService } from "./services/memory-providers.js";
import { ModelRouterService } from "./services/model-router.js";
import { ModelRoutesService } from "./services/model-routes.js";
import { ModelUpstreamsService } from "./services/model-upstreams.js";
import { ModelCatalogService } from "./services/model-catalog.js";
import { UpstreamModelsService } from "./services/upstream-models.js";
import { ToolCallStore } from "./services/tool-call-store.js";
import { OauthService } from "./services/oauth.js";
import { createApiApp } from "./api/routes.js";
import { createMcpHandler } from "./mcp/http.js";
import { createAgentTaskInfrastructure } from "./services/mcp-task-store.js";
import { createOauthApp } from "./oauth/http.js";
import {
  ensurePlatformMeta,
  ensureSaasPlatformAdmin,
  syncProviderCatalog,
  getDefaultTenant,
} from "./services/bootstrap.js";
import { runMigrations } from "./db/migrate.js";
import { RuntimeNodeService } from "./services/runtime-nodes.js";
import { MigrationService } from "./services/migration-service.js";
import { ServerWorkspaceFsProvider } from "./services/workspace-fs-provider.js";
import { NetworkAuditService } from "./services/network-audit.js";
import { SecurityPolicyService } from "./services/network-security.js";
import { NetworkSettingsService } from "./services/network-settings.js";
import {
  ExposureService,
  reconcileOrphanExposures,
} from "./services/port-exposures.js";
import { FileShareService } from "./services/file-shares.js";
import { SkillsService } from "./services/skills/index.js";
import { PlatformServiceManager } from "./services/platform-services.js";
import { PlatformServiceUsageService } from "./services/platform-service-usage.js";
import { bindPlatformServiceRuntime } from "./platform-services/runtime-bind.js";

async function main() {
  const config = loadConfig();
  registerBuiltinProviders();
  registerBuiltinModelAdapters();

  await runMigrations(config.databaseUrl);

  const { db, kind } = await createDb({
    databaseUrl: config.databaseUrl,
    dataDir: config.dataDir,
  });
  bindProviderRuntime(db, config);
  await ensurePlatformMeta(db, { multiTenant: config.multiTenant });
  if (config.multiTenant) {
    await ensureSaasPlatformAdmin(db);
  }
  await syncProviderCatalog(db);

  const runtime = new DockerRuntime();
  const orchestrator = new Orchestrator(db, runtime, config);
  const platformServices = new PlatformServiceManager(db, runtime, config);
  const platformServiceUsage = new PlatformServiceUsageService(db, config);
  bindPlatformServiceRuntime(platformServices, platformServiceUsage);
  await platformServices.ensureRows().catch((err) => {
    console.warn("[platform-services] ensure rows:", err);
  });
  void platformServices
    .ensureDesired()
    .then((r) => {
      if (r.started || r.failed) {
        console.log(
          `[platform-services] ensure on boot: started=${r.started} failed=${r.failed}`,
        );
      }
    })
    .catch((err) => {
      console.warn("[platform-services] ensure on boot failed:", err);
    });
  const gateway = new McpGateway(db, orchestrator, runtime);
  const runtimeNodes = new RuntimeNodeService(db, config);
  const agentService = new AgentService(db, runtime, config, runtimeNodes);
  const memoryStore = new MemoryStore(db);
  const memoryProviders = new MemoryProvidersService(db);
  const modelRouter = new ModelRouterService(db);
  const modelUpstreams = new ModelUpstreamsService(db, (tenantId) =>
    modelRouter.invalidateCache(tenantId),
  );
  const modelRoutes = new ModelRoutesService(db, modelUpstreams, (tenantId) =>
    modelRouter.invalidateCache(tenantId),
  );
  const modelCatalog = new ModelCatalogService(db);
  const upstreamModelsSvc = new UpstreamModelsService(
    db,
    modelUpstreams,
    modelCatalog,
    (tenantId) => modelRouter.invalidateCache(tenantId),
  );
  const toolCallStore = new ToolCallStore(db);
  const oauth = new OauthService(db, config);
  const workspaceFsProvider = new ServerWorkspaceFsProvider(db, config, runtimeNodes);
  const migrations = new MigrationService(db, config, runtimeNodes);
  const networkAudit = new NetworkAuditService(db);
  const securityPolicy = new SecurityPolicyService(db, networkAudit);
  const networkSettings = new NetworkSettingsService(
    db,
    config,
    securityPolicy,
    networkAudit,
  );
  if (config.multiTenant) {
    await networkSettings.refreshPlatformHeadscale().catch((err) => {
      console.warn("[headscale] load config failed:", err);
    });
  }
  const exposures = new ExposureService(
    db,
    config,
    runtime,
    agentService.workspace,
    networkSettings,
    securityPolicy,
    networkAudit,
  );
  exposures.setRuntimeNodes(runtimeNodes);
  // Seed implicit local runner when a tenant already exists
  const defaultTenant = await getDefaultTenant(db);
  if (defaultTenant) {
    await runtimeNodes.ensureLocalNode(defaultTenant.id).catch((err) => {
      console.warn("[runtime-nodes] seed local failed:", err);
    });
    await networkSettings.ensureTenantDefaults(defaultTenant.id).catch((err) => {
      console.warn("[network] seed defaults failed:", err);
    });
  }
  const orphaned = await reconcileOrphanExposures(db).catch(() => 0);
  if (orphaned > 0) {
    console.warn(`[network] marked ${orphaned} orphan exposure(s) after restart`);
  }
  // MCP 服务器（含远程 HTTP）统一自动启动；远程无本地进程，status 表示启用
  void orchestrator
    .autoStartMcpInstances()
    .then((r) => {
      if (r.started || r.failed) {
        console.log(
          `[mcp] auto-start on boot: started=${r.started} failed=${r.failed} skipped=${r.skipped}`,
        );
      }
    })
    .catch((err) => {
      console.warn("[mcp] auto-start on boot failed:", err);
    });
  const browserService = new AgentBrowserService((agentId) =>
    agentService.workspace.resolveCdp(agentId),
  );
  gateway.setAgentService(agentService);
  gateway.setBrowserService(browserService);
  gateway.setMemoryStore(memoryStore);
  gateway.setMemoryProviders(memoryProviders);
  gateway.setToolCallStore(toolCallStore);
  const { taskStore, taskMessageQueue } = createAgentTaskInfrastructure(orchestrator);
  gateway.setTaskStore(taskStore);
  gateway.setWorkspaceFsProvider(workspaceFsProvider);
  gateway.setExposureService(exposures);
  const fileShares = new FileShareService(db, config);
  gateway.setFileShareService(fileShares);
  const skillsService = new SkillsService({
    db,
    agentService,
    fsProvider: workspaceFsProvider,
    secret: config.secret,
  });
  gateway.setSkillsService(skillsService);

  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: (origin) => origin || "*",
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Api-Key",
        "X-Zakura-Session",
        "MCP-Protocol-Version",
        "Mcp-Session-Id",
        "Last-Event-ID",
        "Accept",
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["WWW-Authenticate", "MCP-Protocol-Version", "Mcp-Session-Id"],
    }),
  );

  app.route("/", createOauthApp({ db, config, oauth }));

  app.route(
    "/",
    await createApiApp({
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
      upstreamModels: upstreamModelsSvc,
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
      skills: skillsService,
    }),
  );

  const mcpHandler = createMcpHandler({
    db,
    gateway,
    oauth,
    config,
    taskStore,
    taskMessageQueue,
  });
  app.all("/mcp", mcpHandler);
  app.all("/mcp/*", mcpHandler);

  app.get("/", (c) =>
    c.json({
      name: "Zakura",
      version: "0.2.0",
      docs: "Multi-agent MCP gateway: isolated FS/shell/computer + component tools (agent-scoped only)",
      endpoints: {
        api: "/api",
        agentMcp: "/mcp/agents/:slug",
        authorize: "/authorize",
        token: "/token",
        register: "/oauth/register",
        oauthMetadata: "/.well-known/oauth-authorization-server",
        resourceMetadata: "/.well-known/oauth-protected-resource",
        health: "/api/health",
        cimd: "client_id_metadata_document_supported",
      },
    }),
  );

  console.log(`Zakura listening on http://${config.host}:${config.port}`);
  console.log(`  edition  : ${config.edition}${config.multiTenant ? " (multi-tenant)" : " (single-account)"}`);
  console.log(`  data dir : ${config.dataDir}`);
  console.log(`  database : ${config.databaseUrl} (${kind})`);
  console.log(`  Agent MCP: ${config.publicBaseUrl}/mcp/agents/{slug}`);
  console.log(`  Web UI   : ${config.webPublicUrl}`);
  console.log(`  Authorize: ${config.publicBaseUrl}/authorize → ${config.webPublicUrl}/console/oauth/authorize`);
  if (config.aptMirror) {
    console.log(`  APT mirror: ${config.aptMirror}`);
  }

  serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
