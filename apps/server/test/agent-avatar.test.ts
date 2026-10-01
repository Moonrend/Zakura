import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { signSession } from "../src/services/auth.js";
import { zakurabotHarness } from "./helpers/zakurabot.js";

type ApiApp = { request: (input: string, init?: RequestInit) => Promise<Response> };

describe("agent avatar REST API", () => {
  let dataDir: string;
  let db: Db;
  let close: () => Promise<void>;
  let app: ApiApp;
  let token: string;
  let tenantId: string;
  let agentId: string;

  before(async () => {
    process.env.REDIS_URL = "off";
    dataDir = mkdtempSync(join(tmpdir(), "zakura-agent-avatar-"));
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
    await db.insert(tenants).values({ id: tenantId, name: "Avatar API", slug: "avatar-api" });
    await db.insert(users).values({ id: userId, email: "avatar-api@example.test" });
    await db
      .insert(tenantMemberships)
      .values({ tenantId, userId, role: "owner", status: "active" });

    const config = {
      dataDir,
      databaseUrl,
      secret: "avatar-api-secret",
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
      email: "avatar-api@example.test",
      role: "owner",
    });

    const createdAgent = await post("/api/agents", {
      name: "Avatar Agent",
      createApiKey: false,
    });
    assert.equal(createdAgent.status, 201, await createdAgent.clone().text());
    agentId = ((await createdAgent.json()) as Record<string, unknown>).id as string;
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
  const patch = (path: string, body: unknown) =>
    app.request(path, { method: "PATCH", headers: headers(), body: JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers: headers() });

  it("sets a single avatar field and reflects it via GET", async () => {
    const res = await patch(`/api/agents/${agentId}`, { avatarColor: "#1f6feb" });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.avatarColor, "#1f6feb");
    assert.equal(body.avatarShape, null);
    assert.equal(body.avatarUrl, null);

    const fetched = (await (await get(`/api/agents/${agentId}`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(fetched.avatarColor, "#1f6feb");
  });

  it("sets all three avatar fields", async () => {
    const res = await patch(`/api/agents/${agentId}`, {
      avatarColor: "#ff8800",
      avatarShape: "squircle",
      avatarUrl: "https://cdn.example.test/avatar.png",
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.avatarColor, "#ff8800");
    assert.equal(body.avatarShape, "squircle");
    assert.equal(body.avatarUrl, "https://cdn.example.test/avatar.png");

    const fetched = (await (await get(`/api/agents/${agentId}`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(fetched.avatarShape, "squircle");
    assert.equal(fetched.avatarUrl, "https://cdn.example.test/avatar.png");
  });

  it("rejects a non-http(s) avatarUrl", async () => {
    const res = await patch(`/api/agents/${agentId}`, {
      avatarUrl: "ftp://example.test/avatar.png",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(body.error);
  });

  it("rejects an oversized avatarUrl", async () => {
    const res = await patch(`/api/agents/${agentId}`, {
      avatarUrl: `https://example.test/${"a".repeat(2100)}`,
    });
    assert.equal(res.status, 400);
  });

  it("rejects an oversized avatarColor", async () => {
    const res = await patch(`/api/agents/${agentId}`, { avatarColor: "c".repeat(65) });
    assert.equal(res.status, 400);
  });
});

describe("zakurabot roster avatar frames", () => {
  it("carries avatarColor, avatarShape and avatarUrl for the agent", async () => {
    const harness = await zakurabotHarness({ agentComputer: true });
    try {
      const { bindings, token } = await harness.access(1);
      const rosterAgentId = bindings[0]!.agentId;
      const { agents } = await import("../src/db/schema.js");
      await harness.db
        .update(agents)
        .set({
          avatarColor: "#123456",
          avatarShape: "hexagon",
          avatarUrl: "https://cdn.example.test/agent.png",
        })
        .where(eq(agents.id, rosterAgentId));

      const client = await harness.connect(token);
      try {
        const ready = await client.wait("ready");
        const agent = ready.agents.find((a) => a.id === rosterAgentId);
        assert.ok(agent, "roster contains the agent");
        assert.equal(agent!.avatarColor, "#123456");
        assert.equal(agent!.avatarShape, "hexagon");
        assert.equal(agent!.avatarUrl, "https://cdn.example.test/agent.png");
      } finally {
        await client.close();
      }
    } finally {
      await harness.close();
    }
  });
});
