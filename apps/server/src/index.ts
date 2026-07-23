import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { bindProviderRuntime, registerBuiltinProviders } from "./providers/index.js";
import { DockerRuntime } from "./runtime/docker.js";
import { Orchestrator } from "./services/orchestrator.js";
import { McpGateway } from "./services/mcp-gateway.js";
import { AgentService } from "./services/agents.js";
import { AgentBrowserService } from "./services/agent-cdp.js";
import { MemoryStore } from "./services/memory-store.js";
import { MemoryProvidersService } from "./services/memory-providers.js";
import { ToolCallStore } from "./services/tool-call-store.js";
import { OauthService } from "./services/oauth.js";
import { createApiApp } from "./api/routes.js";
import { createMcpHandler } from "./mcp/http.js";
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

async function main() {
  const config = loadConfig();
  registerBuiltinProviders();

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
  const gateway = new McpGateway(db, orchestrator, runtime);
  const runtimeNodes = new RuntimeNodeService(db, config);
  const agentService = new AgentService(db, runtime, config, runtimeNodes);
  const memoryStore = new MemoryStore(db);
  const memoryProviders = new MemoryProvidersService(db);
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
  const browserService = new AgentBrowserService((agentId) =>
    agentService.workspace.resolveCdp(agentId),
  );
  gateway.setAgentService(agentService);
  gateway.setBrowserService(browserService);
  gateway.setMemoryStore(memoryStore);
  gateway.setMemoryProviders(memoryProviders);
  gateway.setToolCallStore(toolCallStore);
  gateway.setWorkspaceFsProvider(workspaceFsProvider);
  gateway.setExposureService(exposures);

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
      toolCallStore,
      oauth,
      runtimeNodes,
      migrations,
      workspaceFsProvider,
      networkSettings,
      securityPolicy,
      exposures,
      networkAudit,
    }),
  );

  const mcpHandler = createMcpHandler({ db, gateway, oauth, config });
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
  console.log(`  Authorize: ${config.publicBaseUrl}/authorize → ${config.webPublicUrl}/oauth/authorize`);
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
