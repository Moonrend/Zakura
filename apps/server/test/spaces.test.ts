/**
 * M1：Space 模型核心行为。
 * - 默认空间幂等创建；Agent 未指定 spaceId 时自动归入
 * - slug 唯一性按 (tenant, space) 判定，可跨空间重名
 * - 电脑 / 工作区字段写 Space；记忆字段留 Agent
 * - 默认空间不可删除；删除空间级联删除成员 Agent
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";

describe("spaces model", () => {
  let dataDir: string;
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let agentService: import("../src/services/agents.js").AgentService;
  let tenantId: string;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-spaces-"));
    const pgliteDir = join(dataDir, "pglite");
    process.env.ZAKURA_DATA_DIR = dataDir;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(`pglite:${pgliteDir}`);
    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl: `pglite:${pgliteDir}`, dataDir });
    db = created.db;
    close = created.close;

    const { tenants, newId } = await import("../src/db/schema.js");
    tenantId = newId();
    await db.insert(tenants).values({
      id: tenantId,
      slug: "spaces-tenant",
      name: "Spaces",
      isDefault: true,
    });

    const { AgentService } = await import("../src/services/agents.js");
    const config = {
      dataDir,
      hostDataDir: undefined,
      migrationDir: join(dataDir, "migrations"),
      secret: "spaces-test",
      multiTenant: true,
    } as import("../src/config.js").AppConfig;
    agentService = new AgentService(db, {} as never, config);
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates agents in the tenant default space and scopes slugs per space", async () => {
    const first = await agentService.create(tenantId, {
      name: "Alpha",
      createApiKey: false,
    });
    assert.equal(first.agent.spaceId, `spc_default_${tenantId}`);
    assert.equal(first.agent.slug, "alpha");
    assert.equal(first.agent.enableMemory, true);

    const second = await agentService.create(tenantId, {
      name: "Alpha",
      createApiKey: false,
      memoryProviderId: "   ",
    });
    assert.equal(second.agent.slug, "alpha-2", "同空间 slug 冲突自动加后缀");
    assert.equal(second.agent.memoryProviderId, null, "空白 provider id 归一成 null");
    assert.equal(second.agent.spaceId, first.agent.spaceId);

    const other = await agentService.spaces.create(tenantId, { name: "Second Space" });
    const inOther = await agentService.create(tenantId, {
      name: "Alpha",
      spaceId: other.id,
      createApiKey: false,
    });
    assert.equal(inOther.agent.slug, "alpha", "跨空间允许同名 slug");
    assert.equal(inOther.agent.spaceId, other.id);
  });

  it("serializes space identity and uses space-scoped workspace paths", async () => {
    const created = await agentService.create(tenantId, { name: "Serialized", createApiKey: false });
    const serialized = agentService.serialize(created.agent);
    assert.equal(serialized.spaceId, created.agent.spaceId);
    assert.equal(serialized.spaceName, "默认空间");
    assert.match(serialized.workspaceHostPath, /[\\/]spaces[\\/]/);
    assert.equal(serialized.enableComputer, false);
  });

  it("writes computer fields to the space and memory fields to the agent", async () => {
    const created = await agentService.create(tenantId, { name: "Split", createApiKey: false });
    const updated = await agentService.update(tenantId, created.agent.id, {
      enableComputer: true,
      name: "Split Renamed",
      enableMemory: false,
    });
    assert.equal(updated.enableComputer, true);
    assert.equal(updated.enableFs, true);
    assert.equal(updated.name, "Split Renamed");
    assert.equal(updated.enableMemory, false);

    const { spaces } = await import("../src/db/schema.js");
    const spaceRow = await db.query.spaces.findFirst({
      where: eq(spaces.id, created.agent.spaceId),
    });
    assert.equal(spaceRow?.enableComputer, true);

    const { agents } = await import("../src/db/schema.js");
    const agentRow = await db.query.agents.findFirst({ where: eq(agents.id, created.agent.id) });
    assert.equal(agentRow?.name, "Split Renamed");
    assert.equal(agentRow?.enableMemory, false);
  });

  it("filters agents by space and protects the default space from deletion", async () => {
    const space = await agentService.spaces.create(tenantId, { name: "Filterable" });
    await agentService.create(tenantId, { name: "In Filtered", spaceId: space.id, createApiKey: false });
    const inSpace = await agentService.list(tenantId, { spaceId: space.id });
    assert.equal(inSpace.length, 1);
    assert.equal(inSpace[0]!.spaceId, space.id);

    const defaultSpace = await agentService.spaces.get(tenantId, "default");
    assert.ok(defaultSpace);
    await assert.rejects(
      agentService.spaces.delete(tenantId, defaultSpace!.id),
      /默认空间不可删除/,
    );

    const countBefore = (await agentService.list(tenantId, { spaceId: space.id })).length;
    await agentService.spaces.delete(tenantId, space.id);
    assert.equal(countBefore, 1);
    assert.equal((await agentService.list(tenantId, { spaceId: space.id })).length, 0);
  });

  it("rejects an unknown space id", async () => {
    await assert.rejects(
      agentService.create(tenantId, { name: "No Space", spaceId: "does-not-exist", createApiKey: false }),
      /Space not found/,
    );
  });
});
