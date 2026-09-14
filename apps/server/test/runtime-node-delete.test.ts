import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  agents, componentInstances, managedContainers, portExposures, providerCatalog,
  runtimeNodes, tenants, workspaceMigrations,
} from "../src/db/schema.js";
import type { AppConfig } from "../src/config.js";
import { RuntimeNodeService, getCachedRunnerToken } from "../src/services/runtime-nodes.js";
import { registerRuntimeNodeRoutes } from "../src/api/runtime-node-routes.js";

describe("runtime node deletion with foreign key references", () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let dir: string;
  let nodes: RuntimeNodeService;
  let sequence = 0;
  const config = { secret: "node-delete-test", multiTenant: true } as AppConfig;

  before(async () => {
    process.env.REDIS_URL = "off";
    dir = mkdtempSync(join(tmpdir(), "zakura-node-delete-"));
    const databaseUrl = `pglite:${join(dir, "db")}`;
    await runMigrations(databaseUrl);
    const handle = await createDb({ databaseUrl, dataDir: dir });
    db = handle.db;
    closeDb = handle.close;
    await db.insert(tenants).values([
      { id: "owner", name: "Owner", slug: "owner" },
      { id: "consumer", name: "Consumer", slug: "consumer" },
    ]);
    await db.insert(providerCatalog).values({ id: "stdio-mcp", name: "MCP" });
    nodes = new RuntimeNodeService(db, config);
  });

  after(async () => {
    await closeDb?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function newNode() {
    return (await nodes.create("owner", { name: `Server ${++sequence}`, kind: "server" })).node;
  }

  async function newAgent(tenantId = "owner", runtimeNodeId: string | null = null) {
    const [agent] = await db.insert(agents).values({
      tenantId, name: "Agent", slug: `agent-${++sequence}`, runtimeNodeId,
    }).returning();
    return agent;
  }

  function appFor(tenantId = "owner") {
    const app = new Hono<any>();
    app.use("*", async (c, next) => {
      c.set("session", { tenantId, userId: "member" });
      await next();
    });
    registerRuntimeNodeRoutes(app, { nodes, db, config });
    return app;
  }

  it("deletes a source or target referenced by finished migration history", async () => {
    for (const column of ["sourceNodeId", "targetNodeId"] as const) {
      const node = await newNode();
      const retained = await newNode();
      const agent = await newAgent("owner", retained.id);
      const [job] = await db.insert(workspaceMigrations).values({
        tenantId: "owner", agentId: agent.id,
        sourceNodeId: retained.id, targetNodeId: retained.id,
        [column]: node.id, status: "completed",
      }).returning();
      await db.update(agents).set({ lastMigrationId: job.id }).where(eq(agents.id, agent.id));

      const response = await appFor().request(`/api/runtime-nodes/${node.id}`, { method: "DELETE" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(await nodes.get("owner", node.id), null);
      assert.equal(await db.query.workspaceMigrations.findFirst({ where: eq(workspaceMigrations.id, job.id) }), undefined);
      const remainingAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
      assert.equal(remainingAgent?.lastMigrationId, null);
      assert.equal(remainingAgent?.runtimeNodeId, retained.id);
      assert.ok(await nodes.get("owner", retained.id));
    }
  });

  it("unbinds owned and shared consumers without turning remote resources into local ones", async () => {
    const node = await newNode();
    await db.update(runtimeNodes).set({ isShared: true }).where(eq(runtimeNodes.id, node.id));
    const owned = await newAgent("owner", node.id);
    const consumer = await newAgent("consumer", node.id);
    const untouched = await newAgent("consumer");
    const [instance] = await db.insert(componentInstances).values({
      tenantId: "consumer", name: "MCP", slug: `mcp-${++sequence}`, providerId: "stdio-mcp",
      configEnc: "test-config", runtimeNodeId: node.id, status: "running",
      endpointUrl: "http://remote:1234", healthStatus: "healthy",
    }).returning();
    await db.insert(managedContainers).values([
      { tenantId: "owner", agentId: owned.id, name: "Workspace", image: "workspace", purpose: "workspace", runtimeNodeId: node.id, dockerId: "remote-workspace", status: "running" },
      { tenantId: "consumer", instanceId: instance.id, name: "MCP", image: "mcp", runtimeNodeId: node.id, dockerId: "remote-mcp", status: "running" },
    ]);
    const [localContainer] = await db.insert(managedContainers).values({
      tenantId: "consumer", name: "Local", image: "local", dockerId: "local-container",
    }).returning();
    const [exposure] = await db.insert(portExposures).values({
      tenantId: "consumer", agentId: consumer.id, runtimeNodeId: node.id, port: 8080,
      provider: "quick-tunnel", status: "active", publicUrl: "https://remote.example.com",
    }).returning();

    assert.deepEqual(await nodes.delete("owner", node.id), { ok: true });
    for (const agent of [owned, consumer]) {
      const row = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
      assert.equal(row?.runtimeNodeId, null);
      assert.match(row?.lastError ?? "", /节点.*删除.*重新绑定/);
    }
    assert.equal((await db.query.agents.findFirst({ where: eq(agents.id, untouched.id) }))?.lastError, null);
    assert.deepEqual(await db.query.managedContainers.findMany({ where: eq(managedContainers.runtimeNodeId, node.id) }), []);
    assert.equal((await db.query.managedContainers.findFirst({ where: eq(managedContainers.id, localContainer.id) }))?.dockerId, "local-container");
    assert.equal((await db.query.managedContainers.findMany()).some((row) => row.dockerId?.startsWith("remote-")), false);
    const stopped = await db.query.componentInstances.findFirst({ where: eq(componentInstances.id, instance.id) });
    assert.equal(stopped?.runtimeNodeId, null);
    assert.equal(stopped?.status, "stopped");
    assert.equal(stopped?.endpointUrl, null);
    assert.equal(stopped?.healthStatus, "unknown");
    assert.equal(stopped?.configEnc, "test-config");
    const port = await db.query.portExposures.findFirst({ where: eq(portExposures.id, exposure.id) });
    assert.equal(port?.runtimeNodeId, null);
    assert.equal(port?.status, "stopped");
    assert.equal(port?.publicUrl, null);
    assert.ok(port?.stoppedAt);
    assert.equal(getCachedRunnerToken(node.id), undefined);
  });

  it("rejects deletion during an active migration without partially detaching data", async () => {
    const node = await newNode();
    const target = await newNode();
    const agent = await newAgent("consumer", node.id);
    const [job] = await db.insert(workspaceMigrations).values({
      tenantId: "consumer", agentId: agent.id, sourceNodeId: node.id,
      targetNodeId: target.id, status: "transferring",
    }).returning();
    const response = await appFor().request(`/api/runtime-nodes/${node.id}`, { method: "DELETE" });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /迁移/);
    assert.ok(await nodes.get("owner", node.id));
    assert.equal((await db.query.agents.findFirst({ where: eq(agents.id, agent.id) }))?.runtimeNodeId, node.id);
    assert.equal((await db.query.workspaceMigrations.findFirst({ where: eq(workspaceMigrations.id, job.id) }))?.status, "transferring");
  });

  it("keeps ownership and local-node protection", async () => {
    const node = await newNode();
    await db.update(runtimeNodes).set({ isShared: true }).where(eq(runtimeNodes.id, node.id));
    assert.equal((await appFor("consumer").request(`/api/runtime-nodes/${node.id}`, { method: "DELETE" })).status, 403);
    assert.deepEqual(await nodes.delete("consumer", node.id), { error: "Not found" });
    assert.deepEqual(await nodes.delete("owner", "missing"), { error: "Not found" });
    await db.update(runtimeNodes).set({ kind: "local" }).where(eq(runtimeNodes.id, node.id));
    assert.ok("error" in await nodes.delete("owner", node.id));
    assert.ok(await nodes.get("owner", node.id));
  });

  it("rolls back dependency cleanup if the final delete fails", async () => {
    const node = await newNode();
    const agent = await newAgent("owner", node.id);
    await db.execute(sql`CREATE TABLE node_delete_guard (node_id text REFERENCES runtime_nodes(id))`);
    await db.execute(sql`INSERT INTO node_delete_guard (node_id) VALUES (${node.id})`);
    try {
      await assert.rejects(nodes.delete("owner", node.id));
      assert.equal((await db.query.agents.findFirst({ where: eq(agents.id, agent.id) }))?.runtimeNodeId, node.id);
      assert.equal((await db.query.agents.findFirst({ where: eq(agents.id, agent.id) }))?.lastError, null);
      assert.ok(await nodes.get("owner", node.id));
      assert.ok(getCachedRunnerToken(node.id));
    } finally {
      await db.execute(sql`DROP TABLE node_delete_guard`);
    }
  });
});
