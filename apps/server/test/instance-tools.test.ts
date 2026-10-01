import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { decryptJson, encryptJson, globalRegistry } from "@zakura/core";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { signSession } from "../src/services/auth.js";

type ApiApp = { request: (input: string, init?: RequestInit) => Promise<Response> };

const PROVIDER_ID = "test-instance-tools";

describe("instance per-tool enable/disable", () => {
  let dataDir: string;
  let db: Db;
  let close: () => Promise<void>;
  let app: ApiApp;
  let token: string;
  let tenantId: string;
  let instanceId: string;
  let gateway: import("../src/services/mcp-gateway.js").McpGateway;

  before(async () => {
    process.env.REDIS_URL = "off";
    dataDir = mkdtempSync(join(tmpdir(), "zakura-instance-tools-"));
    const databaseUrl = `pglite:${join(dataDir, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl, dataDir });
    db = created.db;
    close = created.close;

    const {
      tenants,
      users,
      tenantMemberships,
      componentInstances,
      providerCatalog,
      newId,
    } = await import("../src/db/schema.js");
    tenantId = newId();
    const userId = newId();
    await db.insert(tenants).values({ id: tenantId, name: "Instance Tools", slug: "instance-tools" });
    await db.insert(users).values({ id: userId, email: "instance-tools@example.test" });
    await db
      .insert(tenantMemberships)
      .values({ tenantId, userId, role: "owner", status: "active" });

    const config = {
      dataDir,
      databaseUrl,
      secret: "instance-tools-secret",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
    } as AppConfig;

    globalRegistry.register(
      () =>
        ({
          id: PROVIDER_ID,
          name: "Test MCP",
          description: "",
          version: "1.0.0",
          category: "mcp",
          capabilities: ["tools"],
          configSchema: { type: "object", properties: {} },
          createRuntimeSpec: () => ({ containers: [], endpointTemplate: "http://localhost" }),
          healthCheck: async () => ({ status: "healthy", message: "ok" }),
          listTools: async () => [
            {
              name: "alpha",
              description: "Alpha tool",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "beta",
              description: "Beta tool",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          callTool: async (_handle: unknown, toolName: string, args: unknown) => ({
            content: [{ type: "text", text: JSON.stringify({ toolName, args }) }],
          }),
        }) as never,
    );

    const now = new Date();
    await db
      .insert(providerCatalog)
      .values({
        id: PROVIDER_ID,
        name: "Test MCP",
        description: "",
        version: "1.0.0",
        category: "mcp",
        capabilities: "[]",
        configSchema: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    instanceId = newId();
    await db.insert(componentInstances).values({
      id: instanceId,
      tenantId,
      providerId: PROVIDER_ID,
      name: "Test Instance",
      slug: "tools-demo",
      status: "running",
      configEnc: encryptJson(config.secret, { mcpUrl: "https://example.test/mcp" }),
      endpointUrl: "https://example.test/mcp",
      healthStatus: "healthy",
      createdAt: now,
      updatedAt: now,
    });

    const loadRow = (id: string) =>
      db.query.componentInstances.findFirst({
        where: and(eq(componentInstances.id, id), eq(componentInstances.tenantId, tenantId)),
      });
    const toHandle = async (id: string) => {
      const row = await loadRow(id);
      if (!row) throw new Error("instance not found");
      return {
        id: row.id,
        tenantId: row.tenantId,
        providerId: row.providerId,
        name: row.name,
        slug: row.slug,
        config: decryptJson<Record<string, unknown>>(config.secret, row.configEnc),
        endpointUrl: row.endpointUrl,
        containers: {},
      };
    };
    const orchestrator = {
      toHandle: async (_tenantId: string, id: string) => toHandle(id),
      updateInstanceConfig: async (
        _tenantId: string,
        id: string,
        patch: Record<string, unknown>,
      ) => {
        const row = await loadRow(id);
        if (!row) throw new Error("instance not found");
        const current = decryptJson<Record<string, unknown>>(config.secret, row.configEnc);
        await db
          .update(componentInstances)
          .set({
            configEnc: encryptJson(config.secret, { ...current, ...patch }),
            updatedAt: new Date(),
          })
          .where(eq(componentInstances.id, id));
        return toHandle(id);
      },
      ensureStarted: async () => undefined,
      startInstance: async () => undefined,
    };

    const { DockerRuntime } = await import("../src/runtime/docker.js");
    const { AgentService } = await import("../src/services/agents.js");
    const { McpGateway } = await import("../src/services/mcp-gateway.js");
    const { OauthService } = await import("../src/services/oauth.js");
    const { CloudAgentSessionStore } = await import("../src/services/cloud-agent-session.js");
    const { createApiApp } = await import("../src/api/routes.js");
    const agentService = new AgentService(db, {} as never, config);
    gateway = new McpGateway(db, orchestrator as never, new DockerRuntime());
    app = (await createApiApp({
      db,
      config,
      agentService,
      orchestrator: orchestrator as never,
      gateway,
      runtime: {} as never,
      memoryStore: {} as never,
      memoryProviders: {} as never,
      toolCallStore: {} as never,
      oauth: new OauthService(db, config),
      cloudSessionStore: new CloudAgentSessionStore(db),
    })) as unknown as ApiApp;

    token = signSession(config.secret, {
      userId,
      tenantId,
      email: "instance-tools@example.test",
      role: "owner",
    });
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const headers = () => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
  const get = (path: string) => app.request(path, { headers: headers() });
  const patch = (path: string, body: unknown) =>
    app.request(path, { method: "PATCH", headers: headers(), body: JSON.stringify(body) });

  it("lists every tool with its current enabled state", async () => {
    const res = await get(`/api/instances/${instanceId}/tools`);
    assert.equal(res.status, 200, await res.clone().text());
    const tools = (await res.json()) as Array<{
      name: string;
      description?: string;
      enabled: boolean;
    }>;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["alpha", "beta"],
    );
    assert.ok(tools.every((t) => t.enabled === true));
    assert.equal(tools.find((t) => t.name === "alpha")?.description, "Alpha tool");
  });

  it("persists a disable, drops it from listings and rejects the call", async () => {
    const res = await patch(`/api/instances/${instanceId}/tools/beta`, { enabled: false });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { name: "beta", enabled: false });

    const tools = (await (await get(`/api/instances/${instanceId}/tools`)).json()) as Array<{
      name: string;
      enabled: boolean;
    }>;
    assert.equal(tools.find((t) => t.name === "beta")?.enabled, false);
    assert.equal(tools.find((t) => t.name === "alpha")?.enabled, true);

    const listed = await gateway.listToolsForTenant(tenantId);
    assert.deepEqual(
      listed.map((t) => t.localName).sort(),
      ["alpha"],
    );

    const rejected = await gateway.callTool(tenantId, "re_tools-demo__beta", {});
    assert.equal(rejected.isError, true);
    assert.match((rejected.content[0] as { text: string }).text, /Unknown tool/);

    const allowed = await gateway.callTool(tenantId, "re_tools-demo__alpha", {});
    assert.equal(allowed.isError, undefined);
  });

  it("re-enabling restores the tool", async () => {
    const res = await patch(`/api/instances/${instanceId}/tools/beta`, { enabled: true });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { name: "beta", enabled: true });

    const listed = await gateway.listToolsForTenant(tenantId);
    assert.deepEqual(
      listed.map((t) => t.localName).sort(),
      ["alpha", "beta"],
    );
  });

  it("rejects an unknown tool with 404", async () => {
    const res = await patch(`/api/instances/${instanceId}/tools/nope`, { enabled: false });
    assert.equal(res.status, 404);
  });

  it("rejects a non-boolean enabled flag with 400", async () => {
    const res = await patch(`/api/instances/${instanceId}/tools/alpha`, { enabled: "yes" });
    assert.equal(res.status, 400);
  });

  it("returns 404 for an unknown instance", async () => {
    assert.equal((await get("/api/instances/does-not-exist/tools")).status, 404);
    const res = await patch("/api/instances/does-not-exist/tools/alpha", { enabled: false });
    assert.equal(res.status, 404);
  });
});
