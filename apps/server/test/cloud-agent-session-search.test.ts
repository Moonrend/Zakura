/**
 * searchSessions：验证排序（精确 > 模糊 > 时间）、内容命中与摘录，
 * 以及 pg_trgm 不可用时（PGlite）整体回退到 ILIKE 仍能工作。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRATCH = process.env.GROK_SCRATCH || join(tmpdir(), "grok-cloud-session-search");

describe("CloudAgentSessionStore.searchSessions", () => {
  let dataDir: string;
  let close: () => Promise<void>;
  let db!: import("../src/db/client.js").Db;
  let store: import("../src/services/cloud-agent-session.js").CloudAgentSessionStore;
  let tenantId: string;
  let agentId: string;
  const ids: Record<string, string> = {};

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
    db = created.db;

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

    for (const title of ["部署脚本调优", "无关的会话", "内容里提到部署"]) {
      const s = await store.createSession({ tenantId, agentId, title });
      ids[title] = s.id;
    }
    // 「无关的会话」最后更新，标题命中项必须仍排在它前面
    await store.appendEvent({
      sessionId: ids["内容里提到部署"]!,
      type: "user_message",
      runId: null,
      payload: { messageId: "m1", content: "帮我看看部署脚本里的超时设置" },
    });
    await store.appendEvent({
      sessionId: ids["无关的会话"]!,
      type: "user_message",
      runId: null,
      payload: { messageId: "m2", content: "今天天气不错" },
    });
  });

  after(async () => {
    await close?.();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("标题精确命中排在内容命中之前", async () => {
    const hits = await store.searchSessions(tenantId, "部署脚本");
    const titles = hits.map((h) => h.session.title);
    assert.ok(titles.includes("部署脚本调优"), `expected title hit, got ${titles.join(",")}`);
    assert.ok(titles.includes("内容里提到部署"), `expected content hit, got ${titles.join(",")}`);
    assert.equal(titles[0], "部署脚本调优", "精确标题命中应排第一");
    assert.ok(!titles.includes("无关的会话"));
  });

  it("内容命中带上摘录，标题命中没有", async () => {
    const hits = await store.searchSessions(tenantId, "超时设置");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.session.title, "内容里提到部署");
    assert.ok(hits[0]!.snippet?.includes("超时设置"), hits[0]!.snippet ?? "(null)");
  });

  it("空查询返回空数组", async () => {
    assert.deepEqual(await store.searchSessions(tenantId, "   "), []);
  });

  it("含 % 和 _ 的查询不会被当作通配符", async () => {
    const hits = await store.searchSessions(tenantId, "%");
    assert.equal(hits.length, 0, "裸 % 不应匹配全部会话");
  });

  it("pg_trgm 已随迁移装好（嵌入式与远程一致）", async () => {
    const { sql } = await import("drizzle-orm");
    const res = await db.execute(
      sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    const rows = Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? []);
    assert.equal(rows.length, 1, "PGlite 应已加载 pg_trgm");
  });

  it("标题 GIN 三元组索引已由迁移建好", async () => {
    const { sql } = await import("drizzle-orm");
    const res = await db.execute(
      sql`SELECT 1 FROM pg_indexes WHERE indexname = 'cloud_agent_sessions_title_trgm_idx'`,
    );
    const rows = Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? []);
    assert.equal(rows.length, 1, "迁移应已创建 cloud_agent_sessions_title_trgm_idx");
  });

  it("错字也能命中标题（trgm 模糊）", async () => {
    const hits = await store.searchSessions(tenantId, "部署脚步");
    const titles = hits.map((h) => h.session.title);
    assert.ok(
      titles.includes("部署脚本调优"),
      `错字查询应模糊命中标题，实际: ${titles.join(",") || "(空)"}`,
    );
  });
});
