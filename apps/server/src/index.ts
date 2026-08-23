import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  log,
  observabilityHttpMiddleware,
  otlpExportEnabled,
  recordPlatformFault,
} from "@zakura/core";
import { loadConfig } from "./config.js";
import {
  initServerTelemetry,
  mountPlatformProbes,
  registerServerHealthChecks,
  SERVER_VERSION,
} from "./observability.js";
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
import { CloudAgentSessionStore } from "./services/cloud-agent-session.js";
import { OauthService } from "./services/oauth.js";
import { createApiApp } from "./api/routes.js";
import { createSocketGateway } from "./realtime/socket-gateway.js";
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
import { IntegrationCatalogService } from "./services/integration-catalog.js";
import { McpStoreService } from "./services/mcp-store.js";
import { ConnectionCatalogService } from "./services/connection-catalog.js";
import { InstanceMigrationService } from "./services/instance-migration.js";
import { StoreCatalogService } from "./services/store-catalog.js";
import { MarketSyncService } from "./services/market-sync.js";
import { ImageUpdateChecker } from "./services/image-update-checker.js";
import { createDesktopProxyGateway } from "./services/desktop-proxy.js";

async function main() {
  const config = loadConfig();
  const telemetry = initServerTelemetry();

  // 全局兜底：任何逃逸的 promise rejection / 同步异常都记录为 fault，
  // 绝不让单个请求或后台任务把整个服务进程拖垮。Node 22 默认对 unhandled
  // rejection 执行 process.exit，正是 fx 节点掉线时反复 502 重启的根因。
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    recordPlatformFault("process.unhandled_rejection", err, { subsystem: "process" });
    log.error("process.unhandled_rejection", { err_message: err.message });
  });
  process.on("uncaughtException", (err) => {
    recordPlatformFault("process.uncaught_exception", err, { subsystem: "process" });
    log.error("process.uncaught_exception", { err_message: err.message });
  });

  registerBuiltinProviders();
  registerBuiltinModelAdapters();

  await runMigrations(config.databaseUrl);

  const { db, kind } = await createDb({
    databaseUrl: config.databaseUrl,
    dataDir: config.dataDir,
  });
  log.info("boot.db_open", { db_kind: kind });
  bindProviderRuntime(db, config);
  const integrationCatalogBootstrap = new IntegrationCatalogService(db, config);
  await integrationCatalogBootstrap.sync();
  await integrationCatalogBootstrap.migrateLegacyEmailProfiles();
  await integrationCatalogBootstrap.migrateConfiguredEmailProfiles();
  log.info("boot.catalog_sync");
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
    telemetry.recordFault("platform_services.ensure_rows", err, {
      subsystem: "platform_services",
    });
  });
  void platformServices
    .ensureDesired()
    .then((r) => {
      if (r.started || r.failed) {
        log.info("boot.platform_services", { started: r.started, failed: r.failed });
      }
    })
    .catch((err) => {
      telemetry.recordFault("platform_services.ensure_desired", err, {
        subsystem: "platform_services",
      });
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
  // 全进程唯一：API 路由与实时网关共用，否则本地 emit 投递互相收不到
  const cloudSessionStore = new CloudAgentSessionStore(db);
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
      telemetry.recordFault("headscale.load_config", err, { subsystem: "headscale" });
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
      telemetry.recordFault("runtime_nodes.seed_local", err, {
        subsystem: "runtime_nodes",
      });
    });
    await networkSettings.ensureTenantDefaults(defaultTenant.id).catch((err) => {
      telemetry.recordFault("network.seed_defaults", err, { subsystem: "network" });
    });
  }
  const orphaned = await reconcileOrphanExposures(db).catch(() => 0);
  if (orphaned > 0) {
    log.warn("boot.orphan_exposures", { count: orphaned });
  }
  // MCP 服务器（含远程 HTTP）统一自动启动；远程无本地进程，status 表示启用
  void orchestrator
    .autoStartMcpInstances()
    .then((r) => {
      if (r.started || r.failed) {
        log.info("boot.mcp_autostart", {
          started: r.started,
          failed: r.failed,
          skipped: r.skipped,
        });
      }
    })
    .catch((err) => {
      telemetry.recordFault("mcp.autostart", err, { subsystem: "mcp" });
    });
  const browserService = new AgentBrowserService((agentId) =>
    agentService.workspace.resolveCdp(agentId),
  );
  gateway.setAgentService(agentService);
  agentService.setToolsCacheInvalidator((agentId) => gateway.invalidateToolsCache(agentId));
  orchestrator.setOnInstanceReady((tenantId, instanceId) => {
    void gateway.refreshInstanceTools(tenantId, instanceId);
  });
  orchestrator.setOnInstanceStopped((_tenantId, instanceId) => {
    gateway.clearInstanceToolsCache(instanceId);
  });
  // 已 running 的实例不会再走 start → 启动时补刷 tools 预缓存
  void gateway
    .warmRunningInstanceTools()
    .then((n) => {
      if (n > 0) log.info("boot.mcp_tools_warmed", { count: n });
    })
    .catch((err) => {
      telemetry.recordFault("mcp.warm_tools", err, { subsystem: "mcp" });
    });
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

  const integrationCatalog = new IntegrationCatalogService(db, config);
  const mcpStore = new McpStoreService(db, config);
  const storeCatalog = new StoreCatalogService(db);
  const connectionCatalog = new ConnectionCatalogService(
    db,
    config,
    mcpStore,
    skillsService,
    integrationCatalog,
    orchestrator,
    agentService,
    storeCatalog,
  );
  const marketSync = new MarketSyncService(mcpStore, storeCatalog, skillsService);
  marketSync.start();
  const imageUpdateChecker = new ImageUpdateChecker(db, runtimeNodes, runtime);
  imageUpdateChecker.start();
  orchestrator.setRuntimeNodes(runtimeNodes);
  const instanceMigrations = new InstanceMigrationService(
    db,
    config,
    runtimeNodes,
    orchestrator,
  );
  gateway.setPlatformAssistantDeps({
    connectionCatalog,
    integrations: integrationCatalog,
    runtimeNodes,
    instanceMigrations,
  });

  const app = new Hono();
  registerServerHealthChecks({ db, runtime });
  mountPlatformProbes(app);
  app.use("*", observabilityHttpMiddleware());
  app.use(
    "*",
    cors({
      origin: (origin) => origin || "*",
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Api-Key",
        "X-Claude-Code-Session-Id",
        "session-id",
        "session_id",
        "thread-id",
        "thread_id",
        "X-Session-Id",
        "X-Client-Session-Id",
        "X-Zakura-Session-Id",
        "MCP-Protocol-Version",
        "Mcp-Session-Id",
        "Last-Event-ID",
        "Accept",
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: [
        "WWW-Authenticate",
        "MCP-Protocol-Version",
        "Mcp-Session-Id",
        "X-Zakura-Session-Id",
      ],
    }),
  );

  app.route("/", createOauthApp({ db, config, oauth }));

  log.info("boot.api_app");
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
      connections: connectionCatalog,
      instanceMigrations,
      cloudSessionStore,
      imageUpdateChecker,
    }),
  );
  log.info("boot.api_app_ok");

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
        openai: "/v1",
        agentMcp: "/mcp/agents/:slug",
        authorize: "/authorize",
        token: "/token",
        register: "/oauth/register",
        oauthMetadata: "/.well-known/oauth-authorization-server",
        resourceMetadata: "/.well-known/oauth-protected-resource",
        health: "/livez",
        ready: "/readyz",
        metrics: "/metrics",
        cimd: "client_id_metadata_document_supported",
      },
    }),
  );

  if (config.redisUrl) {
    log.info("boot.redis_connect");
    const { requireRedis } = await import("./services/redis.js");
    await requireRedis();
  }

  telemetry.health.setReady(true);
  log.info("process.ready", {
    edition: config.edition,
    multi_tenant: config.multiTenant,
    bind_host: config.host,
    bind_port: config.port,
    db_kind: kind,
    redis: config.redisUrl ? "on" : "off",
    otel: otlpExportEnabled() ? "on" : "off",
    version: SERVER_VERSION,
  });

  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });

  // 实时网关与 Hono 共用同一个 http.Server：非 /api/socket.io 的请求照常透传。
  createSocketGateway(server as import("node:http").Server, {
    db,
    config,
    store: cloudSessionStore,
  });
  createDesktopProxyGateway(server as import("node:http").Server, {
    config,
    agentService,
  });
}

main().catch((err) => {
  log.fatal("process.fatal", { err });
  process.exit(1);
});
