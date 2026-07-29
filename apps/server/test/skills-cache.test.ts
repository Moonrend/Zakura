/**
 * 平台级技能缓存与来源令牌：跨租户共享一份内容 + 密文令牌隔离。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { SkillPackage, SkillSource } from "@zakura/shared";

const SCRATCH = process.env.GROK_SCRATCH || join(tmpdir(), "grok-skill-cache");

function pkg(name: string, dir: string, version = "abc123"): SkillPackage {
  const body = `# ${name}\n正文`;
  return {
    name,
    title: name,
    description: `${name} 描述`,
    frontmatter: { name, description: `${name} 描述` },
    body,
    files: [{ path: "SKILL.md", content: body, encoding: "utf8", size: body.length }],
    source: { kind: "github", owner: "acme", repo: "kit", ref: "HEAD", path: dir },
    version,
    sizeBytes: body.length,
  };
}

describe("平台技能缓存", () => {
  let dataDir: string;
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let cache: import("../src/services/skills/cache.js").SkillRepoCache;
  let mod: typeof import("../src/services/skills/cache.js");

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

    mod = await import("../src/services/skills/cache.js");
    cache = new mod.SkillRepoCache(db);
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("缓存键包含 ref 与子路径", () => {
    const base: SkillSource = { kind: "github", owner: "acme", repo: "kit" };
    assert.equal(mod.repoKeyOf(base), "github:acme/kit@HEAD");
    assert.equal(mod.repoKeyOf({ ...base, ref: "dev" }), "github:acme/kit@dev");
    // 子路径抓到的只是切片，不能和整仓缓存混用
    assert.equal(mod.repoKeyOf({ ...base, path: "skills/pdf" }), "github:acme/kit@HEAD#skills/pdf");
    assert.equal(mod.repoKeyOf({ kind: "url", url: "https://x/SKILL.md" }), null);
  });

  it("技能过滤不进缓存键", () => {
    const scoped = mod.cacheScopeSource({
      kind: "github",
      owner: "acme",
      repo: "kit",
      skills: ["a"],
      raw: "acme/kit@a",
    });
    assert.equal(scoped.skills, undefined);
    assert.equal(scoped.raw, undefined);
  });

  it("写入后可读回，且在 TTL 内视为新鲜", async () => {
    const source: SkillSource = { kind: "github", owner: "acme", repo: "kit", ref: "HEAD" };
    const key = mod.repoKeyOf(source)!;
    await cache.write({
      repoKey: key,
      source,
      packages: [pkg("alpha", "skills/alpha"), pkg("beta", "skills/beta")],
      warnings: ["注意"],
      etag: 'W/"tag-1"',
      partial: false,
    });

    const read = await cache.read(key);
    assert.ok(read);
    assert.equal(read.fresh, true);
    assert.equal(read.packages.length, 2);
    assert.equal(read.row.skillCount, 2);
    assert.equal(read.row.upstreamEtag, 'W/"tag-1"');
    assert.deepEqual(read.warnings, ["注意"]);
  });

  it("重复写入同一 repoKey 只更新不新增", async () => {
    const source: SkillSource = { kind: "github", owner: "acme", repo: "kit", ref: "HEAD" };
    const key = mod.repoKeyOf(source)!;
    await cache.write({
      repoKey: key,
      source,
      packages: [pkg("alpha", "skills/alpha", "def456")],
      warnings: [],
      etag: 'W/"tag-2"',
      partial: true,
    });
    const rows = await cache.list();
    assert.equal(rows.filter((r) => r.repoKey === key).length, 1);
    const read = await cache.read(key);
    assert.equal(read?.row.partial, true);
    assert.equal(read?.row.version, "def456");
  });

  it("touch 只推进 checkedAt，内容保持不变", async () => {
    const key = "github:acme/kit@HEAD";
    const before = await cache.read(key);
    await cache.touch(key, 'W/"tag-3"');
    const after = await cache.read(key);
    assert.equal(after?.packages.length, before?.packages.length);
    assert.equal(after?.row.upstreamEtag, 'W/"tag-3"');
    assert.ok(after!.row.checkedAt.getTime() >= before!.row.checkedAt.getTime());
  });

  it("占位记录立刻进入待刷新队列", async () => {
    await cache.ensurePlaceholder("github:anthropics/skills@HEAD", {
      kind: "github",
      owner: "anthropics",
      repo: "skills",
    });
    const stale = await cache.staleRepos(5);
    assert.ok(stale.some((r) => r.repoKey === "github:anthropics/skills@HEAD"));
    // 刚写过的仓库不算过期
    assert.ok(!stale.some((r) => r.repoKey === "github:acme/kit@HEAD"));
  });

  it("占位不覆盖已有内容", async () => {
    await cache.ensurePlaceholder("github:acme/kit@HEAD", {
      kind: "github",
      owner: "acme",
      repo: "kit",
    });
    const read = await cache.read("github:acme/kit@HEAD");
    assert.equal(read?.packages.length, 1);
  });

  it("listSkills 压平出可供商店检索的条目", async () => {
    const entries = await cache.listSkills();
    const alpha = entries.find((e) => e.pkg.name === "alpha");
    assert.ok(alpha);
    assert.equal(alpha.slug, "acme/kit");
  });

  it("抓取失败保留旧内容，只记录错误", async () => {
    await cache.markError("github:acme/kit@HEAD", "GitHub API 限流");
    const read = await cache.read("github:acme/kit@HEAD");
    assert.equal(read?.row.lastError, "GitHub API 限流");
    assert.equal(read?.packages.length, 1);
  });
});

describe("技能来源令牌", () => {
  let dataDir: string;
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let store: import("../src/services/skills/tokens.js").SkillTokenStore;
  const tenantA = "tenant-a";
  const tenantB = "tenant-b";

  before(async () => {
    mkdirSync(SCRATCH, { recursive: true });
    dataDir = mkdtempSync(join(SCRATCH, "tok-"));
    const pgliteDir = join(dataDir, "pglite");
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(`pglite:${pgliteDir}`);
    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl: `pglite:${pgliteDir}`, dataDir });
    db = created.db;
    close = created.close;
    const { SkillTokenStore } = await import("../src/services/skills/tokens.js");
    store = new SkillTokenStore({ db, secret: "test-secret-0123456789" });
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("平台令牌与租户令牌互不干扰", async () => {
    await store.set({
      scope: "platform",
      tenantId: tenantA,
      provider: "github",
      token: "ghp_platform_token",
    });
    await store.set({
      scope: "tenant",
      tenantId: tenantA,
      provider: "github",
      token: "ghp_tenant_a_token",
    });

    assert.equal(await store.platformToken("github"), "ghp_platform_token");
    assert.equal(await store.tenantToken(tenantA), "ghp_tenant_a_token");
    assert.equal(await store.tenantToken(tenantB), undefined);
  });

  it("明文不入库，只回显末四位", async () => {
    const { skillSourceTokens } = await import("../src/db/schema.js");
    const rows = await db.select().from(skillSourceTokens);
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.ok(!row.tokenEnc.includes("ghp_"), "密文里不应出现明文");
    }
    const infos = await store.list(tenantA, true);
    const tenant = infos.find((i) => i.scope === "tenant");
    assert.equal(tenant?.hint, "oken");
  });

  it("非管理员看不到平台令牌", async () => {
    const infos = await store.list(tenantA, false);
    assert.ok(infos.every((i) => i.scope === "tenant"));
  });

  it("重复配置同一 scope 走更新", async () => {
    await store.set({
      scope: "tenant",
      tenantId: tenantA,
      provider: "github",
      token: "ghp_rotated_9999",
      label: "rotated",
    });
    const infos = await store.list(tenantA, false);
    assert.equal(infos.length, 1);
    assert.equal(infos[0]?.label, "rotated");
    assert.equal(await store.tenantToken(tenantA), "ghp_rotated_9999");
  });

  it("删除后回落到无令牌", async () => {
    await store.remove("tenant", tenantA, "github");
    assert.equal(await store.tenantToken(tenantA), undefined);
    // 平台令牌不受影响
    assert.equal(await store.platformToken("github"), "ghp_platform_token");
  });

  it("环境变量兜底平台令牌", async () => {
    const { SkillTokenStore } = await import("../src/services/skills/tokens.js");
    const envStore = new SkillTokenStore({
      db,
      secret: "test-secret-0123456789",
      envToken: "ghp_from_env",
    });
    await envStore.remove("platform", tenantA, "github");
    assert.equal(await envStore.platformToken("github"), "ghp_from_env");
    const infos = await envStore.list(tenantA, true);
    assert.ok(infos.some((i) => i.scope === "platform" && i.hint === "_env"));
  });
});
