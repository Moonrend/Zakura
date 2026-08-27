/**
 * 技能自动化：内置技能跟随平台版本自动安装/更新，商店检索按商店独立分页。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { WorkspaceFs } from "@zakura/core";

const SCRATCH = process.env.GROK_SCRATCH || join(tmpdir(), "grok-skill-auto");

describe("内置技能自动安装与更新", () => {
  let dataDir: string;
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let service: import("../src/services/skills/service.js").SkillsService;
  let tenantId: string;
  let agentId: string;
  let workspaceRoot: string;
  let fs: WorkspaceFs;

  before(async () => {
    mkdirSync(SCRATCH, { recursive: true });
    dataDir = mkdtempSync(join(SCRATCH, "data-"));
    const pgliteDir = join(dataDir, "pglite");
    process.env.ZAKURA_DATA_DIR = dataDir;
    process.env.DATABASE_URL = `pglite:${pgliteDir}`;

    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(`pglite:${pgliteDir}`);
    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl: `pglite:${pgliteDir}`, dataDir });
    db = created.db;
    close = created.close;

    const { tenants, agents, newId } = await import("../src/db/schema.js");
    const now = new Date();
    tenantId = newId();
    agentId = newId();
    await db.insert(tenants).values({
      id: tenantId,
      slug: "skill-tenant",
      name: "Skills",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      name: "Skill Agent",
      slug: "skill-agent",
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

    workspaceRoot = join(dataDir, "agents", agentId, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    const { LocalWorkspaceFs } = await import("@zakura/core");
    fs = new LocalWorkspaceFs(workspaceRoot);

    const { eq } = await import("drizzle-orm");
    const agentService = {
      list: async (tid: string) =>
        db.select().from(agents).where(eq(agents.tenantId, tid)),
      get: async (_tid: string, id: string) =>
        (await db.query.agents.findFirst({
          where: eq(agents.id, id),
        })) ?? null,
    } as unknown as import("../src/services/agents.js").AgentService;

    const fsProvider = {
      forAgentBinding: async () => fs,
      forAgent: async () => fs,
    } as unknown as import("../src/services/workspace-fs-provider.js").ServerWorkspaceFsProvider;

    const { SkillsService } = await import("../src/services/skills/service.js");
    service = new SkillsService({
      db,
      agentService,
      fsProvider,
      secret: "test-secret",
      backgroundRefresh: false,
    });
  });

  after(async () => {
    service?.stopBackgroundRefresh();
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("内置技能的版本是内容哈希，改了正文就换版本", async () => {
    const { builtinVersion } = await import("../src/services/skills/builtin.js");
    const base = {
      name: "demo",
      title: "Demo",
      description: "描述",
      body: "# Demo\n正文",
    };
    assert.equal(builtinVersion(base), builtinVersion({ ...base }));
    assert.notEqual(builtinVersion(base), builtinVersion({ ...base, body: "# Demo\n改了" }));
    assert.notEqual(
      builtinVersion(base),
      builtinVersion({ ...base, extraFiles: [{ path: "references/a.md", content: "x" }] }),
    );
    assert.match(builtinVersion(base), /^builtin-[0-9a-f]{12}$/);
  });

  it("backfill 把推荐内置技能装进 Agent 工作区", async () => {
    const { BUILTIN_SKILLS } = await import("../src/services/skills/builtin.js");
    const recommended = BUILTIN_SKILLS.filter((s) => s.recommended);
    assert.ok(recommended.length > 0);

    const installed = await service.backfillBuiltins(tenantId, { force: true });
    assert.equal(installed, recommended.length);

    for (const def of recommended) {
      assert.ok(
        await fs.exists(`/skills/${def.name}/SKILL.md`),
        `${def.name} 应写入工作区`,
      );
    }
  });

  it("没有变化时 backfill 不重复写工作区", async () => {
    assert.equal(await service.backfillBuiltins(tenantId, { force: true }), 0);
  });
  it("读取技能文件时优先返回 Agent 工作区里的本地修改", async () => {
    const { BUILTIN_SKILLS } = await import("../src/services/skills/builtin.js");
    const target = BUILTIN_SKILLS.find((s) => s.recommended)!;
    const localManifest = `---\nname: ${target.name}\ndescription: local edit\n---\n\n# Local edit\n`;
    await fs.writeText(`/skills/${target.name}/SKILL.md`, localManifest);

    const { agents } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    assert.ok(agent);

    const file = await service.readSkillFile(tenantId, agent!, target.name, "SKILL.md");
    assert.equal(file?.content, localManifest);
  });

  it("内置技能正文变更后自动重写已安装的 Agent", async () => {
    const { BUILTIN_SKILLS } = await import("../src/services/skills/builtin.js");
    const target = BUILTIN_SKILLS.find((s) => s.recommended)!;
    const original = target.body;
    target.body = `${original}\n\n<!-- 自动更新测试 -->`;
    try {
      const synced = await service.backfillBuiltins(tenantId, { force: true });
      assert.equal(synced, 1, "只有被改动的那个技能需要重写");
      const written = await fs.readText(`/skills/${target.name}/SKILL.md`);
      assert.ok(written.content.includes("自动更新测试"));

      const record = (await service.list(tenantId)).find((s) => s.name === target.name);
      const { builtinVersion } = await import("../src/services/skills/builtin.js");
      assert.equal(record?.version, builtinVersion(target));
    } finally {
      target.body = original;
      await service.backfillBuiltins(tenantId, { force: true });
    }
  });

  it("非推荐的内置技能不会主动装，但装了之后跟着更新", async () => {
    const { BUILTIN_SKILLS } = await import("../src/services/skills/builtin.js");
    const optional = BUILTIN_SKILLS.find((s) => !s.recommended);
    assert.ok(optional, "应至少有一个非推荐内置技能");
    assert.equal(await fs.exists(`/skills/${optional!.name}/SKILL.md`), false);

    await service.install(tenantId, {
      source: `builtin:${optional!.name}`,
      agentIds: [agentId],
    });
    assert.ok(await fs.exists(`/skills/${optional!.name}/SKILL.md`));

    const original = optional!.body;
    optional!.body = `${original}\n\n<!-- 可选技能更新 -->`;
    try {
      assert.equal(await service.backfillBuiltins(tenantId, { force: true }), 1);
      const written = await fs.readText(`/skills/${optional!.name}/SKILL.md`);
      assert.ok(written.content.includes("可选技能更新"));
    } finally {
      optional!.body = original;
      await service.backfillBuiltins(tenantId, { force: true });
    }
  });

  // 自动更新已从「租户级全局开关」改为「每个第三方技能一个开关」。
  // autoUpdateStatus().enabled 现在是派生值：是否至少有一个第三方技能开着自动更新
  // （留给旧 UI 用）。内置技能不参与，所以只装了内置技能的租户读出来就是 false。
  it("autoUpdateStatus.enabled 由第三方技能的单项开关派生", async () => {
    const initial = await service.autoUpdateStatus(tenantId);
    // 这个租户此刻只有内置技能，而内置技能不支持自动更新开关
    assert.equal(initial.enabled, false, "没有第三方技能时应为 false");
    assert.equal(initial.lastRunAt, null);
    assert.equal(typeof initial.pendingCount, "number");

    // 旧的全局 setter 仍要能用：它会批量改写第三方技能的单项开关。
    // 这里没有第三方技能，所以开关打开后派生值依然是 false。
    const on = await service.setAutoUpdate(tenantId, true);
    assert.equal(on.enabled, false, "无第三方技能可开时派生值保持 false");

    const off = await service.setAutoUpdate(tenantId, false);
    assert.equal(off.enabled, false);

    // 一次巡检：没有第三方技能就没有可更新项，但必须留下运行痕迹
    const summary = await service.autoUpdateTenant(tenantId);
    assert.deepEqual(summary.updated, []);
    assert.deepEqual(summary.failed, []);

    const after = await service.autoUpdateStatus(tenantId);
    assert.ok(after.lastRunAt, "巡检后应记录 lastRunAt");
    assert.equal(after.lastResult?.updated.length, 0);
  });

  it("内置技能不接受单项自动更新开关", async () => {
    const builtin = (await service.list(tenantId)).find((s) => s.builtin);
    assert.ok(builtin, "应至少装有一个内置技能");
    await assert.rejects(
      () => service.setSkillAutoUpdate(tenantId, builtin!.name, true),
      /内置技能不支持自动更新开关/,
    );
  });
});

describe("商店检索：单商店独立分页", () => {
  it("内置商店按关键词过滤并精确切片", async () => {
    const { searchSkillStores } = await import("../src/services/skills/store.js");
    const first = await searchSkillStores({ query: "", store: "builtin", limit: 3 });
    assert.equal(first.store, "builtin");
    assert.equal(first.items.length, 3);
    assert.ok(first.total > 3);
    assert.equal(first.hasMore, true);

    const second = await searchSkillStores({
      query: "",
      store: "builtin",
      limit: 3,
      offset: 3,
    });
    assert.equal(second.offset, 3);
    assert.equal(second.total, first.total);
    // 两页之间不应出现重复条目
    const ids = new Set(first.items.map((i) => i.id));
    assert.ok(second.items.every((i) => !ids.has(i.id)));
  });

  it("官方仓库可按仓库收窄，总数跟着收窄", async () => {
    const { searchSkillStores } = await import("../src/services/skills/store.js");
    const curated = [
      { slug: "acme/kit", name: "alpha", title: "Alpha", description: "", publisher: "acme" },
      { slug: "acme/kit", name: "beta", title: "Beta", description: "", publisher: "acme" },
      { slug: "other/kit", name: "gamma", title: "Gamma", description: "", publisher: "other" },
    ];
    const all = await searchSkillStores({ query: "", store: "curated", curated });
    assert.equal(all.total, 3);

    const scoped = await searchSkillStores({
      query: "",
      store: "curated",
      curated,
      repoSlug: "acme/kit",
    });
    assert.equal(scoped.total, 2);
    assert.equal(scoped.items[0]?.installSpec, "acme/kit@alpha");
  });

  it("查询本身是可安装来源时给出直达条目，且不计入分页", async () => {
    const { searchSkillStores } = await import("../src/services/skills/store.js");
    const page = await searchSkillStores({
      query: "acme/kit@alpha",
      store: "builtin",
    });
    assert.ok(page.direct);
    assert.equal(page.direct?.installSpec, "acme/kit@alpha");
    assert.ok(page.items.every((i) => i.id !== page.direct!.id));
  });

  it("浏览具体仓库时不掺直达条目", async () => {
    const { searchSkillStores } = await import("../src/services/skills/store.js");
    const page = await searchSkillStores({
      query: "acme/kit@alpha",
      store: "curated",
      curated: [],
      repoSlug: "acme/kit",
    });
    assert.equal(page.direct, undefined);
  });
});
