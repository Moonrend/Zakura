/**
 * 平台级技能缓存：一个技能仓库全站只拉一份。
 *
 * SaaS 下同一个仓库会被很多租户安装，逐租户现拉既慢又会打爆 GitHub
 * 未鉴权的 60 次/小时配额。这里按「仓库 + ref + 子路径」缓存整仓内容：
 *
 *   命中且新鲜        → 零网络，直接装
 *   命中但过期        → codeload HEAD 探一次 ETag（不计 API 配额），没变只刷新 checkedAt
 *   未命中 / 确有变更 → 真正抓一次（1 次 API 调用），写回缓存供所有租户复用
 *
 * 体积控制：小仓库连捆绑文件一起存（安装完全离线）；大仓库只存 SKILL.md
 * 与资源清单，安装时再按清单从 raw.githubusercontent 补齐——同样不耗配额。
 */
import { asc, desc, eq, sql } from "drizzle-orm";
import {
  CURATED_SKILL_REPOS,
  type SkillPackage,
  type SkillRepoSummary,
  type SkillSource,
} from "@zakura/shared";
import type { Db } from "../../db/client.js";
import {
  newId,
  platformSkillRepos,
  type PlatformSkillRepoRow,
} from "../../db/schema.js";

/** 缓存多久内视为"与上游一致"，期间安装零网络 */
export const REPO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** 后台刷新的轮询间隔 */
export const REPO_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
/** 每轮后台刷新最多处理几个仓库，避免启动风暴 */
export const REPO_REFRESH_BATCH = 4;
/** 整仓内容（含捆绑文件）不超过这个体积才整份缓存 */
export const CACHE_FULL_BYTES = 4 * 1024 * 1024;

export interface CachedRepo {
  row: PlatformSkillRepoRow;
  packages: SkillPackage[];
  warnings: string[];
  /** checkedAt 在 TTL 内 */
  fresh: boolean;
}

/**
 * 缓存键。子路径参与构键：`owner/repo/some/dir` 抓到的只是仓库的一个切片，
 * 不能和整仓缓存混用，否则整仓请求会拿到不完整的结果。
 */
export function repoKeyOf(source: SkillSource): string | null {
  if (source.kind !== "github" && source.kind !== "gitlab") return null;
  if (!source.owner || !source.repo) return null;
  const ref = source.ref || "HEAD";
  const scope = source.path ? `#${source.path.replace(/^\/+|\/+$/g, "")}` : "";
  return `${source.kind}:${source.owner}/${source.repo}@${ref}${scope}`;
}

/** 缓存查询用的来源：去掉技能过滤，缓存的永远是该 scope 下的全部技能 */
export function cacheScopeSource(source: SkillSource): SkillSource {
  const scoped = { ...source };
  delete scoped.skills;
  delete scoped.raw;
  return scoped;
}

function parsePackages(raw: string): SkillPackage[] {
  try {
    const parsed = JSON.parse(raw) as SkillPackage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseWarnings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function slugOf(repoKey: string): string {
  const match = /^[a-z]+:([^@#]+)/.exec(repoKey);
  return match?.[1] ?? repoKey;
}

export function curatedRepoBySlug(slug: string) {
  return CURATED_SKILL_REPOS.find((r) => r.slug.toLowerCase() === slug.toLowerCase());
}

/** 官方仓库的规范缓存键（整仓、默认分支） */
export function curatedRepoKey(slug: string): string {
  return `github:${slug}@HEAD`;
}

export class SkillRepoCache {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async read(repoKey: string): Promise<CachedRepo | null> {
    const row = await this.db.query.platformSkillRepos.findFirst({
      where: eq(platformSkillRepos.repoKey, repoKey),
    });
    if (!row) return null;
    return {
      row,
      packages: parsePackages(row.packagesJson),
      warnings: parseWarnings(row.warningsJson),
      fresh: Date.now() - row.checkedAt.getTime() < REPO_CACHE_TTL_MS,
    };
  }

  /** 写入/更新一份仓库缓存 */
  async write(opts: {
    repoKey: string;
    source: SkillSource;
    packages: SkillPackage[];
    warnings: string[];
    etag?: string | null;
    partial: boolean;
  }): Promise<PlatformSkillRepoRow> {
    const now = new Date();
    const sizeBytes = opts.packages.reduce((sum, p) => sum + p.sizeBytes, 0);
    const values = {
      repoKey: opts.repoKey,
      provider: opts.source.kind === "gitlab" ? "gitlab" : "github",
      sourceJson: JSON.stringify(cacheScopeSource(opts.source)),
      ref: opts.source.ref ?? null,
      version: opts.packages[0]?.version ?? null,
      upstreamEtag: opts.etag ?? null,
      packagesJson: JSON.stringify(opts.packages),
      partial: opts.partial,
      skillCount: opts.packages.length,
      sizeBytes,
      warningsJson: JSON.stringify(opts.warnings.slice(0, 20)),
      checkedAt: now,
      fetchedAt: now,
      lastError: null,
      updatedAt: now,
    };

    const existing = await this.db.query.platformSkillRepos.findFirst({
      where: eq(platformSkillRepos.repoKey, opts.repoKey),
    });
    if (existing) {
      await this.db
        .update(platformSkillRepos)
        .set(values)
        .where(eq(platformSkillRepos.id, existing.id));
      return { ...existing, ...values };
    }
    const row = { id: newId(), ...values, refCount: 0, createdAt: now };
    await this.db.insert(platformSkillRepos).values(row);
    return row as PlatformSkillRepoRow;
  }

  /** 上游没变：只推进 checkedAt，内容原样复用 */
  async touch(repoKey: string, etag?: string | null): Promise<void> {
    await this.db
      .update(platformSkillRepos)
      .set({
        checkedAt: new Date(),
        ...(etag ? { upstreamEtag: etag } : {}),
        lastError: null,
      })
      .where(eq(platformSkillRepos.repoKey, repoKey));
  }

  /** 抓取失败：记下原因但保留旧内容，避免一次网络抖动让所有租户装不了 */
  async markError(repoKey: string, message: string): Promise<void> {
    await this.db
      .update(platformSkillRepos)
      .set({ lastError: message.slice(0, 500), checkedAt: new Date() })
      .where(eq(platformSkillRepos.repoKey, repoKey));
  }

  async bumpRefCount(repoKey: string): Promise<void> {
    await this.db
      .update(platformSkillRepos)
      .set({ refCount: sql`${platformSkillRepos.refCount} + 1` })
      .where(eq(platformSkillRepos.repoKey, repoKey));
  }

  /** 预置一条空记录，让官方仓库在首次同步前也能出现在商店里 */
  async ensurePlaceholder(repoKey: string, source: SkillSource): Promise<void> {
    const existing = await this.db.query.platformSkillRepos.findFirst({
      where: eq(platformSkillRepos.repoKey, repoKey),
    });
    if (existing) return;
    const now = new Date();
    await this.db.insert(platformSkillRepos).values({
      id: newId(),
      repoKey,
      provider: "github",
      sourceJson: JSON.stringify(cacheScopeSource(source)),
      ref: source.ref ?? null,
      version: null,
      upstreamEtag: null,
      packagesJson: "[]",
      partial: false,
      skillCount: 0,
      sizeBytes: 0,
      warningsJson: "[]",
      // 让它立刻进入待刷新队列
      checkedAt: new Date(0),
      fetchedAt: new Date(0),
      refCount: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** 后台刷新候选：最久没检查的优先，官方仓库与被引用多的排前面 */
  async staleRepos(limit: number): Promise<PlatformSkillRepoRow[]> {
    const rows = await this.db
      .select()
      .from(platformSkillRepos)
      .orderBy(asc(platformSkillRepos.checkedAt))
      .limit(limit * 4);
    const cutoff = Date.now() - REPO_CACHE_TTL_MS;
    return rows
      .filter((r) => r.checkedAt.getTime() < cutoff)
      .sort((a, b) => {
        const ac = curatedRepoBySlug(slugOf(a.repoKey)) ? 1 : 0;
        const bc = curatedRepoBySlug(slugOf(b.repoKey)) ? 1 : 0;
        return bc - ac || b.refCount - a.refCount;
      })
      .slice(0, limit);
  }

  async list(): Promise<PlatformSkillRepoRow[]> {
    return this.db
      .select()
      .from(platformSkillRepos)
      .orderBy(desc(platformSkillRepos.refCount), asc(platformSkillRepos.repoKey));
  }

  /** 所有已缓存仓库里的技能（商店浏览用；不含内容体，只留元信息） */
  async listSkills(): Promise<
    Array<{ repoKey: string; slug: string; pkg: SkillPackage }>
  > {
    const rows = await this.list();
    const out: Array<{ repoKey: string; slug: string; pkg: SkillPackage }> = [];
    for (const row of rows) {
      const slug = slugOf(row.repoKey);
      for (const pkg of parsePackages(row.packagesJson)) {
        out.push({ repoKey: row.repoKey, slug, pkg });
      }
    }
    return out;
  }
}

export function toRepoSummary(row: PlatformSkillRepoRow): SkillRepoSummary {
  const slug = slugOf(row.repoKey);
  const curated = curatedRepoBySlug(slug);
  const pending = row.fetchedAt.getTime() === 0 || row.skillCount === 0;
  return {
    repoKey: row.repoKey,
    slug,
    name: curated?.name ?? slug,
    description: curated?.description ?? "",
    publisher: curated?.publisher ?? slug.split("/")[0] ?? "",
    skillCount: row.skillCount,
    sizeBytes: row.sizeBytes,
    version: row.version,
    checkedAt: row.checkedAt.getTime() ? row.checkedAt.toISOString() : null,
    fetchedAt: row.fetchedAt.getTime() ? row.fetchedAt.toISOString() : null,
    partial: row.partial,
    pending,
    lastError: row.lastError,
  };
}
