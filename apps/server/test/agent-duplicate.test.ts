/**
 * POST /api/agents/:id/duplicate 的 HTTP 集成测试。
 * - 复制落在同一空间，name / description / config 一并复制
 * - 复制名冲突时继续追加 " (copy N)"
 * - slug 冲突沿用 create 的自动后缀
 * - 源 Agent 不被改动
 * - 响应携带 spaceId / spaceName，与普通 create 形状一致
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { signSession } from "../src/services/auth.js";

type ApiApp = { request: (input: string, init?: RequestInit) => Promise<Response> };

describe("agent duplicate REST API", () => {
  let dataDir: string;
  let db: Db;
  let close: () => Promise<void>;
  let app: ApiApp;
  let token: string;
  let tenantId: string;

  before(async () => {
    process.env.REDIS_URL = "off";
    dataDir = mkdtempSync(join(tmpdir(), "zakura-agent-dup-api-"));
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
    await db.insert(tenants).values({ id: tenantId, name: "Duplicate API", slug: "duplicate-api" });
    await db.insert(users).values({ id: userId, email: "duplicate-api@example.test" });
    await db
      .insert(tenantMemberships)
      .values({ tenantId, userId, role: "owner", status: "active" });

    const config = {
      dataDir,
      databaseUrl,
      secret: "duplicate-api-secret",
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
      email: "duplicate-api@example.test",
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

  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = (path: string) => app.request(path, { headers: headers() });

  const listAgents = async (spaceId: string) =>
    (await (await get(`/api/agents?spaceId=${spaceId}`)).json()) as Array<Record<string, unknown>>;

  let space: Record<string, unknown>;

  it("duplicates an agent into the same space, copying name/description/config", async () => {
    const spaceRes = await post("/api/spaces", { name: "Dup Space", description: "shared" });
    space = (await spaceRes.json()) as Record<string, unknown>;

    const sourceRes = await post("/api/agents", {
      name: "Alpha",
      spaceId: space.id,
      description: "original description",
      config: { custom: true, providers: { mcp: { mode: "all", instanceIds: [] } } },
      createApiKey: false,
    });
    assert.equal(sourceRes.status, 201, await sourceRes.clone().text());
    const source = (await sourceRes.json()) as Record<string, unknown>;

    const dupRes = await post(`/api/agents/${source.id}/duplicate`);
    assert.equal(dupRes.status, 201, await dupRes.clone().text());
    const dup = (await dupRes.json()) as Record<string, unknown>;

    assert.notEqual(dup.id, source.id);
    assert.equal(dup.name, "Alpha (copy)");
    assert.equal(dup.slug, "alpha-copy");
    assert.equal(dup.description, "original description");
    assert.equal(dup.spaceId, source.spaceId);
    assert.equal(dup.spaceName, "Dup Space");
    assert.deepEqual(dup.config, source.config);

    // source agent is untouched
    const rows = await listAgents(space.id as string);
    const reloaded = rows.find((a) => a.id === source.id)!;
    assert.equal(reloaded.name, "Alpha");
    assert.equal(reloaded.slug, "alpha");
    assert.equal(reloaded.description, "original description");
  });

  it("appends a further suffix when the copied name is already taken", async () => {
    const rows = await listAgents(space.id as string);
    const source = rows.find((a) => a.name === "Alpha")!;

    const second = await post(`/api/agents/${source.id}/duplicate`);
    assert.equal(second.status, 201, await second.clone().text());
    const body = (await second.json()) as Record<string, unknown>;
    assert.equal(body.name, "Alpha (copy 2)");
    assert.equal(body.slug, "alpha-copy-2");

    const third = await post(`/api/agents/${source.id}/duplicate`);
    const thirdBody = (await third.json()) as Record<string, unknown>;
    assert.equal(thirdBody.name, "Alpha (copy 3)");
    assert.equal(thirdBody.slug, "alpha-copy-3");
  });

  it("resolves a slug conflict with the create suffix loop", async () => {
    const spaceRes = await post("/api/spaces", { name: "Slug Conflict Space" });
    const conflictSpace = (await spaceRes.json()) as Record<string, unknown>;

    const sourceRes = await post("/api/agents", {
      name: "Gamma",
      spaceId: conflictSpace.id,
      createApiKey: false,
    });
    const source = (await sourceRes.json()) as Record<string, unknown>;

    // A differently-named agent already occupies the slug the copy would take.
    const decoy = await post("/api/agents", {
      name: "Gamma Copy",
      spaceId: conflictSpace.id,
      createApiKey: false,
    });
    assert.equal(((await decoy.json()) as Record<string, unknown>).slug, "gamma-copy");

    const dupRes = await post(`/api/agents/${source.id}/duplicate`);
    assert.equal(dupRes.status, 201, await dupRes.clone().text());
    const dup = (await dupRes.json()) as Record<string, unknown>;
    assert.equal(dup.name, "Gamma (copy)");
    assert.equal(dup.slug, "gamma-copy-2");
    assert.equal(dup.spaceId, conflictSpace.id);
    assert.equal(dup.spaceName, "Slug Conflict Space");
  });

  it("honors an optional name override", async () => {
    const rows = await listAgents(space.id as string);
    const source = rows.find((a) => a.name === "Alpha")!;

    const res = await post(`/api/agents/${source.id}/duplicate`, { name: "Renamed Copy" });
    assert.equal(res.status, 201, await res.clone().text());
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.name, "Renamed Copy");
    assert.equal(body.slug, "renamed-copy");
    assert.equal(body.spaceId, source.spaceId);
  });

  it("rejects an invalid name override", async () => {
    const rows = await listAgents(space.id as string);
    const source = rows.find((a) => a.name === "Alpha")!;

    const res = await post(`/api/agents/${source.id}/duplicate`, { name: "" });
    assert.equal(res.status, 400);
  });

  it("returns 400 for a missing source agent", async () => {
    const res = await post("/api/agents/does-not-exist/duplicate");
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(body.error);
  });
});
