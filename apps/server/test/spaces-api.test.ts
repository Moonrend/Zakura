/**
 * Spaces 功能的 HTTP / 帧级集成测试。
 * - /api/spaces 的 CRUD（create / list / get / patch / delete）
 * - POST /api/agents 显式 spaceId、缺省默认空间回退、旧客户端遗留字段兼容
 * - 同空间重名 Agent 的 slug 冲突自动加后缀（不 500）
 * - Zakura Bot roster 帧（WS ready）逐 Agent 携带 spaceId / spaceName / capabilities
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { signSession } from "../src/services/auth.js";
import { zakurabotHarness } from "./helpers/zakurabot.js";

type ApiApp = { request: (input: string, init?: RequestInit) => Promise<Response> };

describe("spaces REST API", () => {
  let dataDir: string;
  let db: Db;
  let close: () => Promise<void>;
  let app: ApiApp;
  let token: string;
  let tenantId: string;

  before(async () => {
    process.env.REDIS_URL = "off";
    dataDir = mkdtempSync(join(tmpdir(), "zakura-spaces-api-"));
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
    await db.insert(tenants).values({ id: tenantId, name: "Spaces API", slug: "spaces-api" });
    await db.insert(users).values({ id: userId, email: "spaces-api@example.test" });
    await db
      .insert(tenantMemberships)
      .values({ tenantId, userId, role: "owner", status: "active" });

    const config = {
      dataDir,
      databaseUrl,
      secret: "spaces-api-secret",
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
      email: "spaces-api@example.test",
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
  const patch = (path: string, body: unknown) =>
    app.request(path, { method: "PATCH", headers: headers(), body: JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers: headers() });
  const del = (path: string) => app.request(path, { method: "DELETE", headers: headers() });

  it("creates, lists, reads, patches and deletes a space", async () => {
    const created = await post("/api/spaces", {
      name: "Team Alpha",
      description: "shared computer",
    });
    assert.equal(created.status, 201, await created.clone().text());
    const space = (await created.json()) as Record<string, unknown>;
    assert.equal(space.slug, "team-alpha");
    assert.equal(space.isDefault, false);
    assert.equal(space.agentCount, 0);

    const listed = (await (await get("/api/spaces")).json()) as Array<Record<string, unknown>>;
    assert.ok(listed.some((s) => s.id === space.id), "created space appears in list");

    const byId = await get(`/api/spaces/${space.id}`);
    assert.equal(byId.status, 200);
    assert.equal(((await byId.json()) as Record<string, unknown>).id, space.id);

    const bySlug = await get("/api/spaces/team-alpha");
    assert.equal(bySlug.status, 200);
    assert.equal(((await bySlug.json()) as Record<string, unknown>).id, space.id);

    const updated = await patch(`/api/spaces/${space.id}`, {
      name: "Team Beta",
      description: "renamed",
      enableComputer: true,
    });
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.equal(((await updated.json()) as Record<string, unknown>).name, "Team Beta");

    const removed = await del(`/api/spaces/${space.id}`);
    assert.equal(removed.status, 200);
    assert.equal((await del(`/api/spaces/${space.id}`)).status, 404);
  });

  it("rejects a space create without a name", async () => {
    const res = await post("/api/spaces", { description: "no name" });
    assert.equal(res.status, 400);
  });

  it("creates an agent inside an explicit space", async () => {
    const spaceRes = await post("/api/spaces", { name: "Explicit Space" });
    const space = (await spaceRes.json()) as Record<string, unknown>;

    const res = await post("/api/agents", {
      name: "Explicit Agent",
      spaceId: space.id,
      createApiKey: false,
    });
    assert.equal(res.status, 201, await res.clone().text());
    const agent = (await res.json()) as Record<string, unknown>;
    assert.equal(agent.spaceId, space.id);
    assert.equal(agent.spaceName, "Explicit Space");

    const filtered = (await (
      await get(`/api/agents?spaceId=${space.id}`)
    ).json()) as Array<Record<string, unknown>>;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.id, agent.id);

    const counts = (await (await get("/api/spaces")).json()) as Array<Record<string, unknown>>;
    assert.equal(counts.find((s) => s.id === space.id)?.agentCount, 1);
  });

  it("falls back to the tenant default space when spaceId is omitted", async () => {
    const res = await post("/api/agents", { name: "Defaulted", createApiKey: false });
    assert.equal(res.status, 201, await res.clone().text());
    const agent = (await res.json()) as Record<string, unknown>;
    assert.equal(agent.spaceId, `spc_default_${tenantId}`);
    assert.equal(agent.spaceName, "默认空间");

    const defaultSpace = await get(`/api/spaces/spc_default_${tenantId}`);
    assert.equal(defaultSpace.status, 200);
    const body = (await defaultSpace.json()) as Record<string, unknown>;
    assert.equal(body.isDefault, true);
    assert.ok((body.agentCount as number) >= 1);
  });

  it("creates an agent against an unknown space without a 500", async () => {
    const res = await post("/api/agents", {
      name: "Orphan",
      spaceId: "does-not-exist",
      createApiKey: false,
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(body.error);
  });

  it("tolerates legacy enableComputer / enableMemory fields", async () => {
    const res = await post("/api/agents", {
      name: "Legacy Client",
      enableComputer: true,
      enableMemory: false,
      createApiKey: false,
    });
    assert.equal(res.status, 201, await res.clone().text());
    const agent = (await res.json()) as Record<string, unknown>;
    assert.ok(agent.id);
    assert.equal(agent.enableMemory, false);
  });

  it("suffixes slugs for duplicate agent names in the same space", async () => {
    const spaceRes = await post("/api/spaces", { name: "Dup Space" });
    const space = (await spaceRes.json()) as Record<string, unknown>;

    const first = await post("/api/agents", {
      name: "Twin",
      spaceId: space.id,
      createApiKey: false,
    });
    assert.equal(first.status, 201, await first.clone().text());
    assert.equal(((await first.json()) as Record<string, unknown>).slug, "twin");

    const second = await post("/api/agents", {
      name: "Twin",
      spaceId: space.id,
      createApiKey: false,
    });
    assert.equal(second.status, 201, await second.clone().text());
    const secondBody = (await second.json()) as Record<string, unknown>;
    assert.equal(secondBody.slug, "twin-2");
    assert.equal(secondBody.spaceId, space.id);
  });

  it("protects the default space from deletion", async () => {
    const res = await del(`/api/spaces/spc_default_${tenantId}`);
    assert.equal(res.status, 400, await res.clone().text());
    assert.equal((await get(`/api/spaces/spc_default_${tenantId}`)).status, 200);
  });
});

describe("zakurabot roster frames", () => {
  it("carries spaceId, spaceName and capabilities for every agent", async () => {
    const harness = await zakurabotHarness({ agentComputer: true });
    try {
      const { token } = await harness.access(2);
      const client = await harness.connect(token);
      try {
        const ready = await client.wait("ready");
        assert.ok(ready.agents.length >= 2, "roster exposes both agents");
        assert.ok(Array.isArray(ready.capabilities));
        for (const agent of ready.agents) {
          assert.equal(typeof agent.spaceId, "string");
          assert.ok((agent.spaceId ?? "").length > 0, "roster agent has a spaceId");
          assert.equal(typeof agent.spaceName, "string");
          assert.ok((agent.spaceName ?? "").length > 0, "roster agent has a spaceName");
          assert.ok(agent.capabilities, "roster agent has capabilities");
          assert.equal(agent.capabilities!.files, true);
          assert.equal(agent.capabilities!.interactions, true);
          assert.equal(agent.capabilities!.desktop, false);
        }
        // 每个 Agent 都归入同一测试空间。
        const spaceIds = new Set(ready.agents.map((agent) => agent.spaceId));
        assert.equal(spaceIds.size, 1);
      } finally {
        await client.close();
      }
    } finally {
      await harness.close();
    }
  });
});
