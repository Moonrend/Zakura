/**
 * 每 Routine run 历史：GET /api/agents/:id/routines/:sid/runs 与
 * AgentAutomationService.listRuns 的 scheduleId / limit 过滤。
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import type { AppVariables } from "../src/api/routes.js";
import { ensureTestSpace } from "./helpers/spaces.js";

describe("automation run history", () => {
  let dataDir: string;
  let db: Db;
  let close: () => Promise<void>;
  let automation: import("../src/services/agent-automation.js").AgentAutomationService;
  let app: Hono<{ Variables: AppVariables }>;
  let tenantId: string;
  let agentId: string;
  let scheduleA: string;
  let scheduleB: string;
  let scheduleBulk: string;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-automation-runs-"));
    const databaseUrl = `pglite:${join(dataDir, "db")}`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ZAKURA_DATA_DIR = dataDir;

    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl, dataDir });
    db = created.db;
    close = created.close;

    const { agentAutomationRuns, agents, newId, tenants } = await import("../src/db/schema.js");
    const now = new Date();
    tenantId = newId();
    agentId = newId();
    await db.insert(tenants).values({
      id: tenantId,
      slug: "auto-runs",
      name: "Auto Runs",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    const spaceId = await ensureTestSpace(db, tenantId);
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      spaceId,
      name: "Auto Agent",
      slug: "auto-agent",
      description: "",
      status: "ready",
      enableFs: false,
      enableComputer: false,
      enableMemory: false,
      runtimeNodeId: null,
      workspaceStatus: "ready",
      configJson: "{}",
      createdAt: now,
      updatedAt: now,
    });

    const { AgentAutomationService } = await import("../src/services/agent-automation.js");
    automation = new AgentAutomationService(db, { publicBaseUrl: "http://localhost" });
    scheduleA = (
      await automation.createSchedule(tenantId, agentId, {
        name: "A",
        prompt: "run a",
        pattern: "@hourly",
      })
    ).id;
    scheduleB = (
      await automation.createSchedule(tenantId, agentId, {
        name: "B",
        prompt: "run b",
        pattern: "@hourly",
      })
    ).id;
    scheduleBulk = (
      await automation.createSchedule(tenantId, agentId, {
        name: "Bulk",
        prompt: "run bulk",
        pattern: "@hourly",
      })
    ).id;

    const base = Date.now();
    await db.insert(agentAutomationRuns).values([
      {
        tenantId,
        agentId,
        kind: "schedule",
        scheduleId: scheduleA,
        status: "completed",
        prompt: "a1",
        createdAt: new Date(base - 3000),
      },
      {
        tenantId,
        agentId,
        kind: "schedule",
        scheduleId: scheduleA,
        status: "completed",
        prompt: "a2",
        createdAt: new Date(base - 2000),
      },
      {
        tenantId,
        agentId,
        kind: "schedule",
        scheduleId: scheduleB,
        status: "completed",
        prompt: "b1",
        createdAt: new Date(base - 1000),
      },
      {
        tenantId,
        agentId,
        kind: "heartbeat",
        scheduleId: null,
        status: "completed",
        prompt: "hb",
        createdAt: new Date(base),
      },
    ]);
    await db.insert(agentAutomationRuns).values(
      Array.from({ length: 120 }, (_, i) => ({
        tenantId,
        agentId,
        kind: "schedule" as const,
        scheduleId: scheduleBulk,
        status: "completed",
        prompt: `bulk-${i}`,
        createdAt: new Date(base + i),
      })),
    );

    const config = {
      dataDir,
      databaseUrl,
      secret: "auto-runs-secret",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
    } as AppConfig;
    const { AgentService } = await import("../src/services/agents.js");
    const { registerAutomationRoutes } = await import("../src/api/automation-routes.js");
    const agentService = new AgentService(db, {} as never, config);
    app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("session", {
        userId: "user-1",
        tenantId,
        email: "auto@example.test",
        role: "owner",
      });
      await next();
    });
    registerAutomationRoutes(app, { agentService, automation });
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns only the requested routine's runs", async () => {
    const res = await app.request(`/api/agents/${agentId}/routines/${scheduleA}/runs`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      runs: Array<{ scheduleId: string | null; prompt: string }>;
    };
    assert.equal(body.runs.length, 2);
    assert.deepEqual(
      body.runs.map((r) => r.prompt),
      ["a2", "a1"],
    );
    assert.ok(body.runs.every((r) => r.scheduleId === scheduleA));
  });

  it("returns 404 for an unknown routine", async () => {
    const res = await app.request(`/api/agents/${agentId}/routines/nope/runs`);
    assert.equal(res.status, 404);
  });

  it("clamps the limit to the 1..100 range", async () => {
    const capped = await automation.listRuns(tenantId, agentId, {
      scheduleId: scheduleBulk,
      limit: 500,
    });
    assert.equal(capped.length, 100);

    const floored = await automation.listRuns(tenantId, agentId, {
      scheduleId: scheduleBulk,
      limit: 0,
    });
    assert.equal(floored.length, 1);
  });
});
