/**
 * listEventsAround：跟随协同指针时按 user_message 开窗。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRATCH =
  process.env.GROK_SCRATCH || join(tmpdir(), "grok-events-around");

describe("listEventsAround", () => {
  let dataDir: string;
  let close: () => Promise<void>;
  let store: import("../src/services/cloud-agent-session.js").CloudAgentSessionStore;
  let tenantId: string;
  let agentId: string;
  let sessionId: string;

  before(async () => {
    process.env.REDIS_URL = "off";
    mkdirSync(SCRATCH, { recursive: true });
    dataDir = mkdtempSync(join(SCRATCH, "data-"));
    const pgliteDir = join(dataDir, "pglite");
    process.env.ZAKURA_DATA_DIR = dataDir;
    process.env.DATABASE_URL = `pglite:${pgliteDir}`;

    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(`pglite:${pgliteDir}`);
    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl: `pglite:${pgliteDir}`, dataDir });
    close = created.close;

    const { tenants, agents, newId } = await import("../src/db/schema.js");
    const now = new Date();
    tenantId = newId();
    agentId = newId();
    await created.db.insert(tenants).values({
      id: tenantId,
      name: "t",
      slug: `t-${tenantId.slice(0, 8)}`,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await created.db.insert(agents).values({
      id: agentId,
      tenantId,
      name: "a",
      slug: `a-${agentId.slice(0, 8)}`,
      description: "",
      status: "ready",
      enableFs: true,
      enableComputer: false,
      enableMemory: false,
      runtimeNodeId: null,
      workspaceStatus: "ready",
      configJson: "{}",
      createdAt: now,
      updatedAt: now,
    });
    const { CloudAgentSessionStore } = await import(
      "../src/services/cloud-agent-session.js"
    );
    store = new CloudAgentSessionStore(created.db);
    const session = await store.createSession({
      tenantId,
      agentId,
      title: "around",
    });
    sessionId = session.id;

    for (let i = 0; i < 8; i++) {
      await store.appendEvent({
        sessionId,
        type: "user_message",
        payload: { messageId: `m${i}`, content: `q${i}` },
      });
      await store.appendEvent({
        sessionId,
        type: "assistant_message",
        payload: { messageId: `a${i}`, content: `ans${i}` },
      });
    }
  });

  after(async () => {
    await close?.();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("around 中间 seq 返回包含该条的窗口", async () => {
    const page = await store.listEventsAround(sessionId, {
      aroundSeq: 7,
      keepUserMessages: 4,
    });
    assert.ok(page.events.some((e) => e.seq === 7));
    assert.ok(page.events.length > 0);
    assert.equal(typeof page.hasMore, "boolean");
    assert.equal(typeof page.hasMoreAfter, "boolean");
  });
});
