import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { signSession } from "../src/services/auth.js";

type ApiApp = { request: (input: string, init?: RequestInit) => Promise<Response> };

type GraphNode = {
  id: string;
  name: string;
  description: string;
  spaceId: string;
  status: string;
};
type GraphEdge = { type: string; a: string; b: string };
type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

describe("space graph API", () => {
  let dataDir: string;
  let db: Db;
  let close: () => Promise<void>;
  let app: ApiApp;
  let token: string;
  let tenantId: string;

  before(async () => {
    process.env.REDIS_URL = "off";
    dataDir = mkdtempSync(join(tmpdir(), "zakura-space-graph-"));
    const databaseUrl = `pglite:${join(dataDir, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl, dataDir });
    db = created.db;
    close = created.close;

    const { tenants, users, tenantMemberships, newId } = await import("../src/db/schema.js");
    tenantId = newId();
    const userId = newId();
    await db.insert(tenants).values({ id: tenantId, name: "Space Graph", slug: "space-graph" });
    await db.insert(users).values({ id: userId, email: "space-graph@example.test" });
    await db
      .insert(tenantMemberships)
      .values({ tenantId, userId, role: "owner", status: "active" });

    const config = {
      dataDir,
      databaseUrl,
      secret: "space-graph-secret",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
    } as AppConfig;

    const { AgentService } = await import("../src/services/agents.js");
    const { OauthService } = await import("../src/services/oauth.js");
    const { CloudAgentSessionStore } = await import("../src/services/cloud-agent-session.js");
    const { createApiApp } = await import("../src/api/routes.js");
    const agentService = new AgentService(db, {} as never, config);
    app = (await createApiApp({
      db,
      config,
      agentService,
      orchestrator: {} as never,
      gateway: {} as never,
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
      email: "space-graph@example.test",
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
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers: headers() });

  it("returns 404 for an unknown space", async () => {
    const res = await get("/api/spaces/does-not-exist/graph");
    assert.equal(res.status, 404);
  });

  it("returns one node per agent and derives message/group edges", async () => {
    const { newId, cloudAgentSessions } = await import("../src/db/schema.js");

    const spaceRes = await post("/api/spaces", { name: "Graph Space" });
    assert.equal(spaceRes.status, 201, await spaceRes.clone().text());
    const space = (await spaceRes.json()) as Record<string, unknown>;

    const alphaRes = await post("/api/agents", {
      name: "Alpha",
      spaceId: space.id,
      createApiKey: false,
    });
    assert.equal(alphaRes.status, 201, await alphaRes.clone().text());
    const alpha = (await alphaRes.json()) as Record<string, unknown>;

    const betaRes = await post("/api/agents", {
      name: "Beta",
      spaceId: space.id,
      createApiKey: false,
    });
    assert.equal(betaRes.status, 201, await betaRes.clone().text());
    const beta = (await betaRes.json()) as Record<string, unknown>;

    const emptyRes = await get(`/api/spaces/${space.id}/graph`);
    assert.equal(emptyRes.status, 200, await emptyRes.clone().text());
    const empty = (await emptyRes.json()) as Graph;
    assert.equal(empty.nodes.length, 2);
    assert.equal(empty.edges.length, 0);
    for (const node of empty.nodes) {
      assert.equal(node.spaceId, space.id);
      assert.equal(node.status, "stopped");
      assert.equal(typeof node.name, "string");
      assert.equal(typeof node.description, "string");
    }

    const now = new Date();

    await db.insert(cloudAgentSessions).values({
      id: newId(),
      tenantId,
      agentId: beta.id as string,
      title: "delegated",
      kind: "delegate",
      originJson: JSON.stringify({
        source: "agent_loop",
        callerAgentId: alpha.id,
        callerAgentName: "Alpha",
      }),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(cloudAgentSessions).values({
      id: newId(),
      tenantId,
      agentId: alpha.id as string,
      title: "alpha project work",
      project: "shared-project",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(cloudAgentSessions).values({
      id: newId(),
      tenantId,
      agentId: beta.id as string,
      title: "beta project work",
      project: "shared-project",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(cloudAgentSessions).values({
      id: newId(),
      tenantId,
      agentId: alpha.id as string,
      title: "live run",
      activeRunId: "run-live",
      createdAt: now,
      updatedAt: now,
    });

    const res = await get(`/api/spaces/${space.id}/graph`);
    assert.equal(res.status, 200, await res.clone().text());
    const graph = (await res.json()) as Graph;

    assert.equal(graph.nodes.length, 2);
    const alphaNode = graph.nodes.find((n) => n.id === alpha.id);
    const betaNode = graph.nodes.find((n) => n.id === beta.id);
    assert.equal(alphaNode?.status, "running");
    assert.equal(betaNode?.status, "stopped");

    const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
    const [lo, hi] = pair(alpha.id as string, beta.id as string);

    assert.ok(
      graph.edges.some((e) => e.type === "message" && e.a === lo && e.b === hi),
      "message edge between host and target",
    );
    assert.ok(
      graph.edges.some((e) => e.type === "group" && e.a === lo && e.b === hi),
      "group edge for shared project",
    );
    assert.ok(
      graph.edges.every((e) => e.a !== e.b),
      "no self edges",
    );
  });
});
