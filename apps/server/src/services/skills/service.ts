/**
 * 技能服务：解析 → 注册表 → 写入 Agent 工作区，三段式。
 *
 * 注册表（skills 表）保存技能内容，安装（agent_skills 表）把文件落到具体 Agent 的
 * 工作区 `/skills/<name>/`。这样同一技能装到多个 Agent 只需下载一次，
 * 离线也能复制到新 Agent。
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { WorkspaceFs } from "@zakura/core";
import {
  AGENT_SKILLS_DIR,
  CURATED_SKILL_REPOS,
  SKILL_MANIFEST_FILE,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  SKILL_STORES,
  type AgentSkillRecord,
  type SkillAutoUpdateStatus,
  type SkillCacheStatus,
  type SkillFile,
  type SkillPackage,
  type SkillRecord,
  type SkillRepoSummary,
  type SkillResolveResult,
  type SkillSearchItem,
  type SkillSearchPage,
  type SkillSource,
  type SkillStoreId,
  type SkillUpdateSummary,
} from "@zakura/shared";
import type { Db } from "../../db/client.js";
import {
  agentSkills,
  agents as agentsTable,
  newId,
  platformSkillRepos,
  settings,
  skills,
  type Agent,
  type AgentSkillRow,
  type SkillRow,
} from "../../db/schema.js";
import type { AgentService } from "../agents.js";
import type { ServerWorkspaceFsProvider } from "../workspace-fs-provider.js";
import { platformEvents } from "../platform-events.js";
import { BUILTIN_SKILLS, builtinToPackage, getBuiltinSkill } from "./builtin.js";
import { fetchSkillPackages, hydratePackage, probeRepoEtag } from "./fetch.js";
import {
  CACHE_FULL_BYTES,
  REPO_REFRESH_BATCH,
  REPO_REFRESH_INTERVAL_MS,
  SkillRepoCache,
  cacheScopeSource,
  curatedRepoBySlug,
  curatedRepoKey,
  repoKeyOf,
  toRepoSummary,
  type CachedRepo,
} from "./cache.js";
import { searchSkillStores, type CuratedSkillEntry } from "./store.js";
import { PLATFORM_SCOPE, SkillTokenStore } from "./tokens.js";
import {
  SkillSourceError,
  normalizeSkillName,
  parseSkillMarkdown,
  parseSkillSource,
  toSkillFrontmatter,
} from "./source.js";
import { TtlCache } from "../../model-router/cache.js";

export { SkillSourceError };

/** 工作区内技能根目录（带前导斜杠，WorkspaceFs 视其为工作区相对路径） */
export const SKILLS_ROOT = `/${AGENT_SKILLS_DIR}`;

/** promptSummary 热路径短缓存（装/卸/启停后失效） */
const PROMPT_SUMMARY_TTL_MS = 30_000;

export function skillWorkspacePath(name: string): string {
  return `${SKILLS_ROOT}/${name}`;
}

/** 同一租户多久才重新扫一遍"哪些 Agent 少装了内置技能" */
const BUILTIN_BACKFILL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 平台级目录/配额用的哨兵 ID，不是 tenants 表里的真实行。
 * market-sync 等会拿它调 skills.search 只为拿商店列表；绝不能往 skills 表写这个 tenant_id
 * （有 FK → tenants.id，会一直 insert 失败并刷屏）。
 */
const PLATFORM_TENANT_SENTINEL = "__platform__";

function isRealTenantId(tenantId: string): boolean {
  return Boolean(tenantId) && tenantId !== PLATFORM_TENANT_SENTINEL;
}

/** 自动更新：settings 表里的键（ownerKey = tenantId） */
const AUTO_UPDATE_KEY = "skills.autoUpdate";
/** 自动更新一轮最多处理多少个租户，避免大站一次性扫全表 */
const AUTO_UPDATE_TENANT_BATCH = 25;

function parseSource(raw: string): SkillSource {
  try {
    return JSON.parse(raw) as SkillSource;
  } catch {
    return { kind: "url" };
  }
}

function parseFiles(raw: string): SkillFile[] {
  try {
    const parsed = JSON.parse(raw) as SkillFile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 按 `-s/--skill`（或 UI 勾选）过滤缓存里的技能；不指定就全要 */
function filterPackages(packages: SkillPackage[], wanted?: string[]): SkillPackage[] {
  if (!wanted?.length || wanted.includes("*")) return packages;
  const keys = new Set(wanted.map((w) => normalizeSkillName(w)));
  const hit = packages.filter(
    (p) =>
      keys.has(normalizeSkillName(p.name)) ||
      keys.has(normalizeSkillName(p.source.path?.split("/").pop() ?? "")),
  );
  // 仓库整组选中：路径里任一段命中也算
  if (hit.length) return hit;
  return packages.filter((p) =>
    (p.source.path ?? "").split("/").some((seg) => keys.has(normalizeSkillName(seg))),
  );
}

function toRecord(row: SkillRow, agentIds: string[], upstreamVersion?: string | null): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    title: row.title || row.name,
    description: row.description,
    version: row.version,
    builtin: row.builtin,
    source: parseSource(row.sourceJson),
    homepage: row.homepage,
    license: row.license,
    fileCount: row.fileCount,
    sizeBytes: row.sizeBytes,
    agentIds,
    repoKey: row.repoKey,
    updateAvailable: Boolean(
      upstreamVersion && row.version && upstreamVersion !== row.version,
    ),
    upstreamVersion: upstreamVersion ?? null,
    autoUpdate: row.builtin ? false : Boolean(row.autoUpdate),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAgentRecord(row: AgentSkillRow, skill?: SkillRow): AgentSkillRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    skillId: row.skillId,
    name: row.name,
    title: skill?.title || skill?.name || row.name,
    description: skill?.description ?? "",
    enabled: row.enabled,
    path: row.path,
    version: row.version,
    status: row.status === "error" ? "error" : "installed",
    error: row.error,
    builtin: skill?.builtin ?? false,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface SkillsServiceDeps {
  db: Db;
  agentService: AgentService;
  fsProvider: ServerWorkspaceFsProvider;
  /** 加密密钥，用于令牌存储 */
  secret?: string | undefined;
  /** GitHub PAT，提升抓取限额（等价于平台级令牌） */
  githubToken?: string | undefined;
  /** 是否启动后台缓存刷新与自动更新（测试里关掉） */
  backgroundRefresh?: boolean;
}

/** settings 表里存的自动更新状态 */
interface StoredAutoUpdate {
  enabled: boolean;
  lastRunAt: string | null;
  lastResult: SkillUpdateSummary | null;
}

export class SkillsService {
  private readonly db: Db;
  private readonly agentService: AgentService;
  private readonly fsProvider: ServerWorkspaceFsProvider;
  private readonly cache: SkillRepoCache;
  private readonly tokens: SkillTokenStore;
  /** 已同步过内置技能的租户，避免每次请求重复写库 */
  private readonly builtinSynced = new Set<string>();
  /** 同一租户并发 syncBuiltins 合并为一次 */
  private readonly builtinSyncInflight = new Map<string, Promise<void>>();
  /** 上次给全部 Agent 补装内置技能的时间 */
  private readonly builtinBackfilled = new Map<string, number>();
  /** 正在抓取的仓库，防止同一仓库被并发重复拉 */
  private readonly inflight = new Map<string, Promise<CachedRepo | null>>();
  /** 正在后台补齐捆绑文件的仓库 */
  private readonly hydrating = new Set<string>();
  /** 一轮后台维护还没跑完时不叠加下一轮 */
  private maintaining = false;
  /** 租户轮转游标：租户数超过单轮批量时，下一轮从上次的位置接着走 */
  private maintenanceCursor = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly promptSummaryCache = new TtlCache<string>(PROMPT_SUMMARY_TTL_MS);

  constructor(deps: SkillsServiceDeps) {
    this.db = deps.db;
    this.agentService = deps.agentService;
    this.fsProvider = deps.fsProvider;
    this.cache = new SkillRepoCache(deps.db);
    this.tokens = new SkillTokenStore({
      db: deps.db,
      secret: deps.secret ?? process.env.ZAKURA_SECRET ?? "zakura-dev-secret",
      envToken: deps.githubToken ?? process.env.GITHUB_TOKEN ?? undefined,
    });
    if (deps.backgroundRefresh !== false) this.startBackgroundRefresh();
  }

  /** 令牌存储（API 层直接用） */
  get tokenStore(): SkillTokenStore {
    return this.tokens;
  }

  get repoCache(): SkillRepoCache {
    return this.cache;
  }

  // —— 注册表 ——

  /**
   * 把内置技能同步进租户注册表（幂等）。
   *
   * 内置技能的版本是内容哈希，所以改了正文就会有新版本；这里只比版本，
   * 一次比较同时覆盖 SKILL.md 与捆绑资源的改动。
   */
  async syncBuiltins(tenantId: string, force = false): Promise<void> {
    // 平台哨兵不是真实租户：skills.tenant_id 有 FK，写库必失败
    if (!isRealTenantId(tenantId)) return;
    if (!force && this.builtinSynced.has(tenantId)) return;
    const inflight = this.builtinSyncInflight.get(tenantId);
    if (inflight && !force) return inflight;

    const run = this.doSyncBuiltins(tenantId)
      .finally(() => {
        if (this.builtinSyncInflight.get(tenantId) === run) {
          this.builtinSyncInflight.delete(tenantId);
        }
      });
    this.builtinSyncInflight.set(tenantId, run);
    return run;
  }

  private async doSyncBuiltins(tenantId: string): Promise<void> {
    try {
      const existing = await this.db
        .select()
        .from(skills)
        .where(and(eq(skills.tenantId, tenantId), eq(skills.builtin, true)));
      const byName = new Map(existing.map((r) => [r.name, r]));

      for (const def of BUILTIN_SKILLS) {
        const pkg = builtinToPackage(def);
        const row = byName.get(pkg.name);
        if (!row || row.version !== pkg.version) {
          await this.upsertPackage(tenantId, pkg, true);
        }
      }
      this.builtinSynced.add(tenantId);
    } catch (err) {
      console.warn(
        "[skills] syncBuiltins:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  async list(tenantId: string): Promise<SkillRecord[]> {
    await this.syncBuiltins(tenantId);
    if (!isRealTenantId(tenantId)) return [];
    const rows = await this.db
      .select()
      .from(skills)
      .where(eq(skills.tenantId, tenantId))
      .orderBy(asc(skills.name));
    if (!rows.length) return [];

    const installs = await this.db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.tenantId, tenantId));
    const bySkill = new Map<string, string[]>();
    for (const inst of installs) {
      const list = bySkill.get(inst.skillId) ?? [];
      list.push(inst.agentId);
      bySkill.set(inst.skillId, list);
    }
    // 平台缓存里的版本，用来标记「有新版本」
    const repoVersions = await this.upstreamVersions(rows);
    return rows.map((row) =>
      toRecord(row, bySkill.get(row.id) ?? [], row.repoKey ? repoVersions.get(row.repoKey) : null),
    );
  }

  /** 批量读出这些技能所属仓库在平台缓存中的版本 */
  private async upstreamVersions(rows: SkillRow[]): Promise<Map<string, string | null>> {
    const keys = [...new Set(rows.map((r) => r.repoKey).filter((k): k is string => Boolean(k)))];
    if (!keys.length) return new Map();
    const cached = await this.db
      .select({ repoKey: platformSkillRepos.repoKey, version: platformSkillRepos.version })
      .from(platformSkillRepos)
      .where(inArray(platformSkillRepos.repoKey, keys));
    return new Map(cached.map((r) => [r.repoKey, r.version]));
  }

  async get(
    tenantId: string,
    idOrName: string,
  ): Promise<{ record: SkillRecord; files: SkillFile[] } | null> {
    const row = await this.findRow(tenantId, idOrName);
    if (!row) return null;
    const installs = await this.db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.tenantId, tenantId), eq(agentSkills.skillId, row.id)));
    return {
      record: toRecord(row, installs.map((i) => i.agentId)),
      files: parseFiles(row.filesJson),
    };
  }

  private async findRow(tenantId: string, idOrName: string): Promise<SkillRow | null> {
    const byId = await this.db.query.skills.findFirst({
      where: and(eq(skills.tenantId, tenantId), eq(skills.id, idOrName)),
    });
    if (byId) return byId;
    const byName = await this.db.query.skills.findFirst({
      where: and(eq(skills.tenantId, tenantId), eq(skills.name, normalizeSkillName(idOrName))),
    });
    return byName ?? null;
  }

  private async upsertPackage(
    tenantId: string,
    pkg: SkillPackage,
    builtin: boolean,
  ): Promise<SkillRow> {
    if (!isRealTenantId(tenantId)) {
      throw new Error(`skills.upsert: invalid tenantId ${tenantId}`);
    }
    const now = new Date();
    const values = {
      tenantId,
      name: pkg.name,
      title: pkg.title || pkg.name,
      description: pkg.description,
      version: pkg.version ?? null,
      builtin,
      sourceJson: JSON.stringify(pkg.source),
      homepage: pkg.homepage ?? null,
      license: pkg.license ?? null,
      filesJson: JSON.stringify(pkg.files),
      fileCount: pkg.files.length,
      sizeBytes: pkg.sizeBytes,
      // 指回平台缓存，用于「上游有没有新版本」的判断
      repoKey: builtin ? null : repoKeyOf(pkg.source),
      // 新装第三方默认开启自动更新；冲突更新时不覆盖用户开关
      autoUpdate: !builtin,
      updatedAt: now,
    };

    // 原子 upsert：并发 syncBuiltins 时 select-then-insert 会撞 skills_tenant_name
    const [row] = await this.db
      .insert(skills)
      .values({ id: newId(), ...values, createdAt: now })
      .onConflictDoUpdate({
        target: [skills.tenantId, skills.name],
        set: {
          title: values.title,
          description: values.description,
          version: values.version,
          builtin: values.builtin,
          sourceJson: values.sourceJson,
          homepage: values.homepage,
          license: values.license,
          filesJson: values.filesJson,
          fileCount: values.fileCount,
          sizeBytes: values.sizeBytes,
          repoKey: values.repoKey,
          updatedAt: now,
          // 有意不碰 autoUpdate / createdAt / id
        },
      })
      .returning();
    if (!row) throw new Error(`skills.upsert failed: ${pkg.name}`);
    return row;
  }

  // —— 解析与预览 ——

  /** 解析来源并抓取内容，但不落库；用于安装前预览 */
  async resolve(tenantId: string, input: string): Promise<SkillResolveResult> {
    const source = parseSkillSource(input);
    // 预览只需要 SKILL.md：一个几十技能的仓库不必先拉几百个捆绑文件
    const { packages, warnings } = await this.loadPackages(source, {
      manifestOnly: true,
      tenantId,
    });
    const existing = await this.db
      .select({ name: skills.name })
      .from(skills)
      .where(eq(skills.tenantId, tenantId));
    const installed = new Set(existing.map((r) => r.name));

    return {
      source,
      warnings,
      skills: packages.map((pkg) => ({
        name: pkg.name,
        title: pkg.title,
        description: pkg.description,
        body: pkg.body,
        files: [
          ...pkg.files.map((f) => ({ path: f.path, size: f.size })),
          ...(pkg.assets ?? []),
        ],
        sizeBytes: pkg.sizeBytes,
        ...(pkg.version ? { version: pkg.version } : {}),
        ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
        ...(pkg.license ? { license: pkg.license } : {}),
        installed: installed.has(pkg.name),
      })),
    };
  }

  private async loadPackages(
    source: SkillSource,
    opts: { manifestOnly?: boolean; tenantId?: string } = {},
  ): Promise<{ packages: SkillPackage[]; warnings: string[] }> {
    if (source.kind === "builtin") {
      const wanted = source.builtinId ?? source.skills?.[0];
      if (!wanted) {
        return { packages: BUILTIN_SKILLS.map(builtinToPackage), warnings: [] };
      }
      const def = getBuiltinSkill(wanted);
      if (!def) throw new SkillSourceError(`未知的内置技能：${wanted}`);
      return { packages: [builtinToPackage(def)], warnings: [] };
    }

    const repoKey = repoKeyOf(source);
    if (!repoKey) {
      // 直链之类无法按仓库缓存，照旧直抓
      const token = await this.tokens.platformToken();
      return fetchSkillPackages(source, {
        githubToken: token,
        ...(opts.manifestOnly ? { manifestOnly: true } : {}),
      });
    }

    const cached = await this.ensureRepo(repoKey, source, opts.tenantId);
    if (!cached) throw new SkillSourceError("技能来源暂时不可用");

    const wanted = filterPackages(cached.packages, source.skills);
    if (!wanted.length) {
      throw new SkillSourceError(
        source.skills?.length
          ? `未找到指定技能：${source.skills.join("、")}。该来源提供：${cached.packages
              .slice(0, 12)
              .map((p) => p.name)
              .join("、")}`
          : "未找到可安装的技能",
      );
    }

    // 预览不需要正文之外的东西；安装才补齐捆绑文件
    const packages = opts.manifestOnly
      ? wanted
      : await Promise.all(
          wanted.map((pkg) =>
            pkg.assets?.length
              ? hydratePackage(pkg, { githubToken: cached.token })
              : Promise.resolve(pkg),
          ),
        );

    return { packages, warnings: cached.warnings };
  }

  /**
   * 取得某个仓库的可用内容：优先平台缓存，其次零配额 ETag 探测，最后才真正抓取。
   * 同一仓库的并发请求合并成一次抓取。
   */
  private async ensureRepo(
    repoKey: string,
    source: SkillSource,
    tenantId?: string,
  ): Promise<(CachedRepo & { token?: string | undefined }) | null> {
    const cached = await this.cache.read(repoKey);
    if (cached?.fresh && cached.packages.length) return cached;

    const pending = this.inflight.get(repoKey);
    if (pending) {
      const done = await pending;
      if (done) return done;
    }

    const task = this.refreshRepo(repoKey, source, tenantId, cached);
    this.inflight.set(repoKey, task);
    try {
      const fresh = await task;
      if (fresh) return fresh;
    } finally {
      this.inflight.delete(repoKey);
    }
    // 抓取失败但有旧内容时降级使用，避免一次网络抖动让所有租户装不了
    return cached?.packages.length ? cached : null;
  }

  private async refreshRepo(
    repoKey: string,
    source: SkillSource,
    tenantId: string | undefined,
    cached: CachedRepo | null,
  ): Promise<CachedRepo | null> {
    const scope = cacheScopeSource(source);
    const platformToken = await this.tokens.platformToken();

    // 有旧内容先探一次 ETag：codeload 的 HEAD 不计 GitHub API 配额
    if (cached?.packages.length && cached.row.upstreamEtag) {
      const etag = await probeRepoEtag(scope, { githubToken: platformToken });
      if (etag && etag === cached.row.upstreamEtag) {
        await this.cache.touch(repoKey, etag);
        return { ...cached, fresh: true };
      }
    }

    try {
      const { packages, warnings, usedTenantToken, token } = await this.fetchWithTokens(
        scope,
        tenantId,
        platformToken,
      );
      const etag = await probeRepoEtag(scope, { githubToken: platformToken });

      if (usedTenantToken) {
        // 私有仓库内容不进共享缓存，只回给当前租户
        const hydrated = await this.hydrateAll(packages, token);
        return {
          row: cached?.row ?? ({} as CachedRepo["row"]),
          packages: hydrated,
          warnings,
          fresh: true,
        };
      }

      // 先把清单写进缓存让预览立刻可用，捆绑文件在后台补——
      // 一个 18 技能的仓库全量水合要 8 秒，不该让第一个用户等着。
      const row = await this.cache.write({
        repoKey,
        source: scope,
        packages,
        warnings,
        etag,
        partial: true,
      });
      this.hydrateLater(repoKey, scope, packages, warnings, etag, token);
      return { row, packages, warnings, fresh: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (cached?.packages.length) {
        await this.cache.markError(repoKey, message);
        return null;
      }
      throw err;
    }
  }

  private async hydrateAll(
    packages: SkillPackage[],
    token: string | undefined,
  ): Promise<SkillPackage[]> {
    return Promise.all(
      packages.map((p) =>
        p.assets?.length ? hydratePackage(p, { githubToken: token }) : Promise.resolve(p),
      ),
    );
  }

  /**
   * 后台补齐捆绑文件并回写缓存。
   * 体积超过预算的仓库保持"仅清单"，安装时再按需拉——两种情况都不耗 API 配额。
   */
  private hydrateLater(
    repoKey: string,
    source: SkillSource,
    packages: SkillPackage[],
    warnings: string[],
    etag: string | null,
    token: string | undefined,
  ): void {
    const assetBytes = packages.reduce(
      (sum, p) => sum + (p.assets ?? []).reduce((s, a) => s + a.size, 0),
      0,
    );
    if (!assetBytes || assetBytes > CACHE_FULL_BYTES) return;
    if (this.hydrating.has(repoKey)) return;
    this.hydrating.add(repoKey);

    void (async () => {
      try {
        const hydrated = await this.hydrateAll(packages, token);
        await this.cache.write({
          repoKey,
          source,
          packages: hydrated,
          warnings,
          etag,
          partial: false,
        });
      } catch (err) {
        console.warn(
          `[skills] hydrate ${repoKey}:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        this.hydrating.delete(repoKey);
      }
    })();
  }

  /**
   * 令牌升级：先用平台令牌（或匿名），404/403 才换租户自备令牌重试。
   * 这样只有平台确实看不到的私有仓库才会用到租户凭据，也就天然做到了隔离。
   */
  private async fetchWithTokens(
    source: SkillSource,
    tenantId: string | undefined,
    platformToken: string | undefined,
  ): Promise<{
    packages: SkillPackage[];
    warnings: string[];
    usedTenantToken: boolean;
    token: string | undefined;
  }> {
    try {
      const res = await fetchSkillPackages(source, {
        githubToken: platformToken,
        manifestOnly: true,
      });
      if (platformToken) void this.tokens.markUsed(PLATFORM_SCOPE, "github");
      return { ...res, usedTenantToken: false, token: platformToken };
    } catch (err) {
      const code = err instanceof SkillSourceError ? err.code : "http";
      if (!tenantId || (code !== "not_found" && code !== "forbidden")) throw err;
      const tenantToken = await this.tokens.tenantToken(tenantId);
      if (!tenantToken) throw err;
      const res = await fetchSkillPackages(source, {
        githubToken: tenantToken,
        manifestOnly: true,
      });
      void this.tokens.markUsed(tenantId, "github");
      return { ...res, usedTenantToken: true, token: tenantToken };
    }
  }

  // —— 平台缓存维护 ——

  /** 官方仓库预置占位，让它们在首次同步前也能出现在商店里 */
  async seedCuratedRepos(): Promise<void> {
    for (const repo of CURATED_SKILL_REPOS) {
      const [owner, name] = repo.slug.split("/");
      if (!owner || !name) continue;
      await this.cache
        .ensurePlaceholder(curatedRepoKey(repo.slug), {
          kind: "github",
          owner,
          repo: name,
          store: "github",
        })
        .catch(() => undefined);
    }
  }

  private startBackgroundRefresh(): void {
    if (this.refreshTimer) return;
    // 启动稍微延后，别和迁移/引导抢资源
    const kick = setTimeout(() => {
      void this.seedCuratedRepos().then(() => this.runMaintenance());
    }, 15_000);
    kick.unref?.();
    this.refreshTimer = setInterval(() => {
      void this.runMaintenance();
    }, REPO_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  stopBackgroundRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * 一轮后台维护：先把平台缓存刷新到最新，再让各租户的技能追上缓存。
   *
   * 顺序很重要——缓存没刷新就去比版本，只会得出"已是最新"的结论。
   */
  async runMaintenance(): Promise<void> {
    if (this.maintaining) return;
    this.maintaining = true;
    try {
      await this.refreshStaleRepos();
      const tenantIds = await this.activeTenantIds(AUTO_UPDATE_TENANT_BATCH);
      for (const tenantId of tenantIds) {
        try {
          // 内置始终同步；第三方只更新各自开启了 autoUpdate 的技能
          await this.autoUpdateTenant(tenantId);
        } catch (err) {
          console.warn(
            `[skills] maintenance ${tenantId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      console.warn("[skills] runMaintenance:", err instanceof Error ? err.message : err);
    } finally {
      this.maintaining = false;
    }
  }

  /** 有 Agent 或有技能的租户才值得维护 */
  private async activeTenantIds(limit: number): Promise<string[]> {
    const [withAgents, withSkills] = await Promise.all([
      this.db.selectDistinct({ tenantId: agentsTable.tenantId }).from(agentsTable),
      this.db.selectDistinct({ tenantId: skills.tenantId }).from(skills),
    ]);
    const ids = new Set<string>();
    for (const row of [...withAgents, ...withSkills]) ids.add(row.tenantId);
    // 轮转起点跟着已处理过的租户走，避免总是只照顾前 N 个
    const all = [...ids].sort();
    if (all.length <= limit) return all;
    const start = this.maintenanceCursor % all.length;
    this.maintenanceCursor = (start + limit) % all.length;
    return [...all.slice(start), ...all.slice(0, start)].slice(0, limit);
  }

  // —— 自动更新 ——

  private async readAutoUpdate(tenantId: string): Promise<StoredAutoUpdate> {
    try {
      const row = await this.db.query.settings.findFirst({
        where: and(eq(settings.ownerKey, tenantId), eq(settings.key, AUTO_UPDATE_KEY)),
      });
      if (!row) return { enabled: true, lastRunAt: null, lastResult: null };
      const parsed = JSON.parse(row.value) as Partial<StoredAutoUpdate>;
      return {
        enabled: parsed.enabled !== false,
        lastRunAt: parsed.lastRunAt ?? null,
        lastResult: parsed.lastResult ?? null,
      };
    } catch {
      return { enabled: true, lastRunAt: null, lastResult: null };
    }
  }

  private async writeAutoUpdate(tenantId: string, next: StoredAutoUpdate): Promise<void> {
    await this.db
      .insert(settings)
      .values({ id: newId(), ownerKey: tenantId, key: AUTO_UPDATE_KEY, value: JSON.stringify(next) })
      .onConflictDoUpdate({
        target: [settings.ownerKey, settings.key],
        set: { value: JSON.stringify(next) },
      });
  }

  /** @deprecated 自动更新已改为单技能开关；保留只为兼容旧 API */
  async autoUpdateEnabled(tenantId: string): Promise<boolean> {
    return (await this.readAutoUpdate(tenantId)).enabled;
  }

  /** @deprecated 请用 setSkillAutoUpdate */
  async setAutoUpdate(tenantId: string, enabled: boolean): Promise<SkillAutoUpdateStatus> {
    const current = await this.readAutoUpdate(tenantId);
    await this.writeAutoUpdate(tenantId, { ...current, enabled });
    // 兼容旧「全局开关」：批量改写该租户第三方技能的单项开关
    await this.db
      .update(skills)
      .set({ autoUpdate: enabled, updatedAt: new Date() })
      .where(and(eq(skills.tenantId, tenantId), eq(skills.builtin, false)));
    return this.autoUpdateStatus(tenantId);
  }

  async setSkillAutoUpdate(
    tenantId: string,
    idOrName: string,
    enabled: boolean,
  ): Promise<SkillRecord> {
    const row = await this.findRow(tenantId, idOrName);
    if (!row) throw new Error("技能不存在");
    if (row.builtin) throw new Error("内置技能不支持自动更新开关");
    await this.db
      .update(skills)
      .set({ autoUpdate: enabled, updatedAt: new Date() })
      .where(eq(skills.id, row.id));
    const records = await this.list(tenantId);
    const found = records.find((r) => r.id === row.id);
    if (!found) throw new Error("技能不存在");
    return found;
  }

  async autoUpdateStatus(tenantId: string): Promise<SkillAutoUpdateStatus> {
    const [stored, registered] = await Promise.all([
      this.readAutoUpdate(tenantId),
      this.list(tenantId),
    ]);
    const thirdParty = registered.filter((s) => !s.builtin);
    const autoOn = thirdParty.filter((s) => s.autoUpdate);
    return {
      // enabled：是否还有至少一个第三方技能开着自动更新（兼容旧 UI）
      enabled: autoOn.length > 0,
      intervalMs: REPO_REFRESH_INTERVAL_MS,
      lastRunAt: stored.lastRunAt,
      lastResult: stored.lastResult,
      pendingCount: registered.filter((s) => s.updateAvailable).length,
    };
  }

  /**
   * 把该租户的技能追到最新：内置始终同步；第三方仅更新开启了 autoUpdate 的。
   *
   * 只处理"平台缓存已经确认上游有变化"的技能——不再逐个技能去打上游，
   * 一轮维护的网络开销就是刷新缓存那几个仓库，与租户数无关。
   */
  async autoUpdateTenant(tenantId: string): Promise<SkillUpdateSummary> {
    const summary: SkillUpdateSummary = {
      updated: [],
      upToDate: 0,
      builtinSynced: 0,
      failed: [],
    };

    summary.builtinSynced = await this.backfillBuiltins(tenantId, { force: true });

    const records = await this.list(tenantId);
    for (const record of records) {
      if (record.builtin) continue;
      if (!record.autoUpdate) continue;
      if (!record.updateAvailable) {
        summary.upToDate++;
        continue;
      }
      try {
        await this.update(tenantId, record.id);
        summary.updated.push(record.name);
      } catch (err) {
        summary.failed.push({
          name: record.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const stored = await this.readAutoUpdate(tenantId);
    await this.writeAutoUpdate(tenantId, {
      ...stored,
      lastRunAt: new Date().toISOString(),
      lastResult: summary,
    });
    return summary;
  }

  /**
   * 手动「立即检查更新」：先把该租户用到的仓库探一遍上游，再按单项开关执行更新。
   *
   * 与后台维护的区别是不等缓存 TTL——用户点了就立刻探上游；
   * 仍只自动应用开启了 autoUpdate 的第三方技能（可在列表里手动点更新）。
   */
  async checkUpdatesNow(tenantId: string): Promise<SkillUpdateSummary> {
    const rows = await this.db
      .select({ repoKey: skills.repoKey, sourceJson: skills.sourceJson })
      .from(skills)
      .where(eq(skills.tenantId, tenantId));
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.repoKey || seen.has(row.repoKey)) continue;
      seen.add(row.repoKey);
      const source = cacheScopeSource(parseSource(row.sourceJson));
      const cached = await this.cache.read(row.repoKey);
      await this.refreshRepo(row.repoKey, source, tenantId, cached).catch((err: unknown) => {
        console.warn(
          `[skills] checkUpdates ${row.repoKey}:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      });
    }
    return this.autoUpdateTenant(tenantId);
  }

  /** 后台刷新一批过期仓库（官方仓库与被引用多的优先） */
  async refreshStaleRepos(limit = REPO_REFRESH_BATCH): Promise<number> {
    let refreshed = 0;
    try {
      const rows = await this.cache.staleRepos(limit);
      for (const row of rows) {
        const source = JSON.parse(row.sourceJson) as SkillSource;
        const cached = await this.cache.read(row.repoKey);
        const res = await this.refreshRepo(row.repoKey, source, undefined, cached).catch(
          (err: unknown) => {
            console.warn(
              `[skills] refresh ${row.repoKey}:`,
              err instanceof Error ? err.message : err,
            );
            return null;
          },
        );
        if (res) refreshed++;
      }
    } catch (err) {
      console.warn("[skills] refreshStaleRepos:", err instanceof Error ? err.message : err);
    }
    return refreshed;
  }

  /** 平台缓存概况 */
  async cacheStatus(): Promise<SkillCacheStatus> {
    const rows = await this.cache.list();
    return {
      repos: rows.map(toRepoSummary),
      totalSkills: rows.reduce((sum, r) => sum + r.skillCount, 0),
      totalBytes: rows.reduce((sum, r) => sum + r.sizeBytes, 0),
      refreshIntervalMs: REPO_REFRESH_INTERVAL_MS,
    };
  }

  /** 商店入口：官方仓库列表（未同步的也列出来，标记 pending） */
  async listRepos(): Promise<SkillRepoSummary[]> {
    const rows = await this.cache.list();
    const byKey = new Map(rows.map((r) => [r.repoKey, r]));
    const out: SkillRepoSummary[] = [];
    for (const repo of CURATED_SKILL_REPOS) {
      const key = curatedRepoKey(repo.slug);
      const row = byKey.get(key);
      byKey.delete(key);
      out.push(
        row
          ? toRepoSummary(row)
          : {
              repoKey: key,
              slug: repo.slug,
              name: repo.name,
              description: repo.description,
              publisher: repo.publisher,
              skillCount: 0,
              sizeBytes: 0,
              version: null,
              checkedAt: null,
              fetchedAt: null,
              partial: false,
              pending: true,
              lastError: null,
            },
      );
    }
    // 其余被租户装过、顺带缓存下来的仓库排在官方之后
    for (const row of byKey.values()) {
      if (row.skillCount > 0) out.push(toRepoSummary(row));
    }
    return out;
  }

  /** 立即同步一个仓库（管理端「立即更新」按钮 / 首次访问触发） */
  async syncRepo(slug: string): Promise<SkillRepoSummary | null> {
    const [owner, name] = slug.split("/");
    if (!owner || !name) throw new SkillSourceError(`仓库标识无效：${slug}`);
    const repoKey = curatedRepoKey(slug);
    const source: SkillSource = { kind: "github", owner, repo: name, store: "github" };
    await this.cache.ensurePlaceholder(repoKey, source);
    const cached = await this.cache.read(repoKey);
    await this.refreshRepo(repoKey, source, undefined, cached);
    const row = await this.cache.read(repoKey);
    return row ? toRepoSummary(row.row) : null;
  }

  /** 商店检索：一次只查一个商店，curated 直接读平台缓存 */
  async search(
    tenantId: string,
    opts: {
      query: string;
      store: SkillStoreId;
      repoSlug?: string | undefined;
      offset?: number;
      limit?: number;
    },
  ): Promise<SkillSearchPage> {
    const registered = await this.list(tenantId);
    const installedNames = new Set(registered.map((s) => s.name.toLowerCase()));
    const curated = opts.store === "curated" ? await this.curatedEntries() : [];
    // 外部商店才需要令牌，本地商店不必为此查一次库
    const githubToken =
      opts.store === "github" ? await this.tokens.platformToken() : undefined;
    return searchSkillStores({
      query: opts.query,
      store: opts.store,
      ...(opts.repoSlug ? { repoSlug: opts.repoSlug } : {}),
      ...(opts.offset != null ? { offset: opts.offset } : {}),
      ...(opts.limit != null ? { limit: opts.limit } : {}),
      installedNames,
      curated,
      githubToken,
    });
  }

  /**
   * 跨商店检索（Agent 的 search_skills 工具用）。
   *
   * UI 一次只看一个商店，模型却是"帮我找个能做 X 的技能"——它需要一次问遍所有商店。
   * 这里复用单商店检索并合并结果，商店本身的实现不必为两种调用方各写一遍。
   */
  async searchAcross(
    tenantId: string,
    opts: { query: string; store?: SkillStoreId | "all"; limit?: number },
  ): Promise<{
    items: SkillSearchItem[];
    errors: Array<{ store: SkillStoreId; error: string }>;
  }> {
    const targets: SkillStoreId[] =
      !opts.store || opts.store === "all"
        ? SKILL_STORES.map((s) => s.id)
        : [opts.store];
    const pages = await Promise.all(
      targets.map((store) =>
        this.search(tenantId, { query: opts.query, store, ...(opts.limit ? { limit: opts.limit } : {}) }).catch(
          (err: unknown): SkillSearchPage => ({
            store,
            items: [],
            total: 0,
            offset: 0,
            limit: opts.limit ?? 0,
            hasMore: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      ),
    );
    const errors: Array<{ store: SkillStoreId; error: string }> = [];
    const items: SkillSearchItem[] = [];
    const seen = new Set<string>();
    // 输入本身就是可安装来源时把直达条目排在最前
    const direct = pages.find((p) => p.direct)?.direct;
    for (const item of [...(direct ? [direct] : []), ...pages.flatMap((p) => p.items)]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    for (const page of pages) {
      if (page.error) errors.push({ store: page.store, error: page.error });
    }
    return { items, errors };
  }

  /** 平台缓存里的技能压平成搜索条目 */
  private async curatedEntries(): Promise<CuratedSkillEntry[]> {
    const rows = await this.cache.listSkills();
    return rows.map(({ slug, pkg }) => ({
      slug,
      name: pkg.name,
      title: pkg.title,
      description: pkg.description,
      publisher: curatedRepoBySlug(slug)?.publisher ?? slug.split("/")[0] ?? "",
    }));
  }

  // —— 安装 ——

  /**
   * 安装技能到指定 Agent。
   * source 与 skillId 二选一：source 会先抓取并注册，skillId 直接复用注册表内容。
   */
  async install(
    tenantId: string,
    opts: {
      source?: string;
      skillId?: string;
      names?: string[];
      agentIds?: string[];
      all?: boolean;
    },
  ): Promise<{ skills: SkillRecord[]; installs: AgentSkillRecord[]; warnings: string[] }> {
    const warnings: string[] = [];
    let rows: SkillRow[] = [];

    if (opts.skillId) {
      const row = await this.findRow(tenantId, opts.skillId);
      if (!row) throw new SkillSourceError("技能不存在");
      rows = [row];
    } else if (opts.source?.trim()) {
      const source = parseSkillSource(opts.source);
      // 用户在预览里勾选了哪些，就只下载哪些的捆绑文件
      const scoped = opts.names?.length ? { ...source, skills: opts.names } : source;
      const loaded = await this.loadPackages(scoped, { tenantId });
      warnings.push(...loaded.warnings);
      const wanted = opts.names?.length
        ? loaded.packages.filter((p) =>
            opts.names!.some((n) => normalizeSkillName(n) === p.name),
          )
        : loaded.packages;
      if (!wanted.length) {
        throw new SkillSourceError(
          `来源中没有匹配的技能：${opts.names?.join(", ") ?? ""}`,
        );
      }
      for (const pkg of wanted) {
        rows.push(await this.upsertPackage(tenantId, pkg, pkg.source.kind === "builtin"));
      }
    } else {
      throw new SkillSourceError("缺少 source 或 skillId");
    }

    const targets = await this.resolveTargets(tenantId, opts.agentIds, opts.all);
    const installs: AgentSkillRecord[] = [];

    for (const agent of targets) {
      for (const row of rows) {
        try {
          installs.push(await this.installToAgent(agent, row));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`${agent.name} 安装 ${row.name} 失败：${message}`);
          installs.push(await this.recordInstall(agent, row, "error", message));
        }
      }
    }

    const records = await Promise.all(
      rows.map(async (row) => {
        const list = await this.db
          .select()
          .from(agentSkills)
          .where(and(eq(agentSkills.tenantId, tenantId), eq(agentSkills.skillId, row.id)));
        return toRecord(row, list.map((i) => i.agentId));
      }),
    );

    return { skills: records, installs, warnings };
  }

  private async resolveTargets(
    tenantId: string,
    agentIds?: string[],
    all?: boolean,
  ): Promise<Agent[]> {
    if (all) return this.agentService.list(tenantId);
    if (!agentIds?.length) return [];
    const found: Agent[] = [];
    for (const id of agentIds) {
      const agent = await this.agentService.get(tenantId, id);
      if (agent) found.push(agent);
    }
    if (!found.length) throw new SkillSourceError("未找到目标 Agent");
    return found;
  }

  /** 写入工作区并登记安装记录 */
  private async installToAgent(agent: Agent, row: SkillRow): Promise<AgentSkillRecord> {
    const files = parseFiles(row.filesJson);
    if (!files.length) throw new Error("技能内容为空");

    const fs = await this.fsProvider.forAgentBinding({
      id: agent.id,
      tenantId: agent.tenantId,
      runtimeNodeId: agent.runtimeNodeId,
    });
    const root = skillWorkspacePath(row.name);

    // 覆盖安装前清掉旧目录，避免残留上一版本的文件
    try {
      if (await fs.exists(root)) await fs.delete(root, true);
    } catch {
      /* 目录不存在或无法删除时继续写入 */
    }
    await fs.mkdir(root);

    for (const file of files) {
      const target = `${root}/${file.path}`.replace(/\/+/g, "/");
      const dir = target.slice(0, target.lastIndexOf("/"));
      if (dir && dir !== root) {
        try {
          await fs.mkdir(dir);
        } catch {
          /* 已存在 */
        }
      }
      if (file.encoding === "base64") {
        await fs.writeBytes(target, Buffer.from(file.content, "base64"));
      } else {
        await fs.write(target, file.content);
      }
    }

    platformEvents.publish(agent.tenantId, {
      type: "agent_fs_changed",
      agentId: agent.id,
      path: root,
    });

    this.forgetPromptSummary(agent.tenantId, agent.id);
    return this.recordInstall(agent, row, "installed", null);
  }

  private async recordInstall(
    agent: Agent,
    row: SkillRow,
    status: "installed" | "error",
    error: string | null,
  ): Promise<AgentSkillRecord> {
    const now = new Date();
    const existing = await this.db.query.agentSkills.findFirst({
      where: and(eq(agentSkills.agentId, agent.id), eq(agentSkills.name, row.name)),
    });
    const values = {
      tenantId: agent.tenantId,
      agentId: agent.id,
      skillId: row.id,
      name: row.name,
      path: skillWorkspacePath(row.name),
      version: row.version,
      status,
      error,
      updatedAt: now,
    };
    if (existing) {
      await this.db.update(agentSkills).set(values).where(eq(agentSkills.id, existing.id));
      return toAgentRecord({ ...existing, ...values }, row);
    }
    const inserted = { id: newId(), enabled: true, createdAt: now, ...values };
    await this.db.insert(agentSkills).values(inserted);
    return toAgentRecord(inserted as AgentSkillRow, row);
  }

  /** 新建 Agent 时装上推荐的内置技能（失败不抛，不阻断建 Agent 流程） */
  async installRecommended(tenantId: string, agentId: string): Promise<void> {
    try {
      await this.syncBuiltins(tenantId);
      const names = BUILTIN_SKILLS.filter((s) => s.recommended).map((s) => s.name);
      if (!names.length) return;
      const rows = await this.db
        .select()
        .from(skills)
        .where(and(eq(skills.tenantId, tenantId), inArray(skills.name, names)));
      const agent = await this.agentService.get(tenantId, agentId);
      if (!agent) return;
      for (const row of rows) {
        try {
          await this.installToAgent(agent, row);
        } catch (err) {
          console.warn(
            `[skills] 默认安装 ${row.name} 到 ${agent.slug} 失败:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      console.warn("[skills] installRecommended:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * 让该租户所有 Agent 的内置技能与注册表保持一致。
   *
   * 两件事：漏装的推荐内置技能补上；已装但版本落后的重写工作区。
   * 后者是内置技能能随平台升级自动生效的关键——内置技能的版本是内容哈希，
   * 改了正文就有新版本，比对安装记录的版本即可知道哪些 Agent 还留着旧文本。
   *
   * 新建 Agent 走 installRecommended；这里覆盖"存量 Agent"、"新增内置技能"、
   * "内置技能内容更新"三种场景。写工作区可能较慢，调用方按需后台触发即可。
   */
  async backfillBuiltins(tenantId: string, opts: { force?: boolean } = {}): Promise<number> {
    const last = this.builtinBackfilled.get(tenantId) ?? 0;
    if (!opts.force && Date.now() - last < BUILTIN_BACKFILL_INTERVAL_MS) return 0;
    this.builtinBackfilled.set(tenantId, Date.now());

    let synced = 0;
    try {
      await this.syncBuiltins(tenantId, opts.force);
      const rows = await this.db
        .select()
        .from(skills)
        .where(and(eq(skills.tenantId, tenantId), eq(skills.builtin, true)));
      if (!rows.length) return 0;

      const agents = await this.agentService.list(tenantId);
      if (!agents.length) return 0;

      const installed = await this.db
        .select({
          agentId: agentSkills.agentId,
          name: agentSkills.name,
          version: agentSkills.version,
          status: agentSkills.status,
        })
        .from(agentSkills)
        .where(
          and(
            eq(agentSkills.tenantId, tenantId),
            inArray(
              agentSkills.name,
              rows.map((r) => r.name),
            ),
          ),
        );
      const have = new Map(
        installed.map((r) => [`${r.agentId}:${r.name}`, r] as const),
      );
      // 只有推荐技能会主动补装；非推荐的内置技能装了才跟着更新
      const recommended = new Set(
        BUILTIN_SKILLS.filter((s) => s.recommended).map((s) => s.name),
      );

      for (const agent of agents) {
        for (const row of rows) {
          const record = have.get(`${agent.id}:${row.name}`);
          if (!record && !recommended.has(row.name)) continue;
          // 版本一致且上次装成功 → 工作区里就是当前内容，跳过
          if (record && record.status !== "error" && record.version === row.version) continue;
          try {
            await this.installToAgent(agent, row);
            synced++;
          } catch (err) {
            console.warn(
              `[skills] ${record ? "更新" : "补装"} ${row.name} 到 ${agent.slug} 失败:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
    } catch (err) {
      console.warn("[skills] backfillBuiltins:", err instanceof Error ? err.message : err);
    }
    return synced;
  }

  // —— Agent 视角 ——

  async listForAgent(tenantId: string, agentId: string): Promise<AgentSkillRecord[]> {
    const rows = await this.db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.tenantId, tenantId), eq(agentSkills.agentId, agentId)))
      .orderBy(asc(agentSkills.name));
    if (!rows.length) return [];
    const skillRows = await this.db
      .select()
      .from(skills)
      .where(inArray(skills.id, [...new Set(rows.map((r) => r.skillId))]));
    const byId = new Map(skillRows.map((r) => [r.id, r]));
    return rows.map((row) => toAgentRecord(row, byId.get(row.skillId)));
  }

  /** 启用中的技能摘要，注入系统提示（渐进式披露的第一层） */
  async promptSummary(tenantId: string, agentId: string): Promise<string> {
    const cacheKey = `${tenantId}:${agentId}`;
    const hit = this.promptSummaryCache.get(cacheKey);
    if (hit !== undefined) return hit;
    try {
      const list = await this.listForAgent(tenantId, agentId);
      const active = list.filter((s) => s.enabled && s.status === "installed");
      const summary = !active.length
        ? ""
        : active
            .map((s) => `- ${s.name}（${s.path}/${SKILL_MANIFEST_FILE}）：${s.description}`)
            .join("\n");
      this.promptSummaryCache.set(cacheKey, summary);
      return summary;
    } catch (err) {
      console.warn("[skills] promptSummary:", err instanceof Error ? err.message : err);
      return "";
    }
  }

  private forgetPromptSummary(tenantId: string, agentId: string): void {
    this.promptSummaryCache.invalidatePrefix(`${tenantId}:${agentId}`);
  }

  async setEnabled(
    tenantId: string,
    agentId: string,
    name: string,
    enabled: boolean,
  ): Promise<AgentSkillRecord | null> {
    const row = await this.db.query.agentSkills.findFirst({
      where: and(
        eq(agentSkills.tenantId, tenantId),
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.name, normalizeSkillName(name)),
      ),
    });
    if (!row) return null;
    await this.db
      .update(agentSkills)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(agentSkills.id, row.id));
    this.forgetPromptSummary(tenantId, agentId);
    const skill = await this.db.query.skills.findFirst({ where: eq(skills.id, row.skillId) });
    return toAgentRecord({ ...row, enabled }, skill);
  }

  /** 从某个 Agent 卸载：删工作区文件 + 删记录 */
  async uninstall(tenantId: string, agentId: string, name: string): Promise<boolean> {
    const normalized = normalizeSkillName(name);
    const row = await this.db.query.agentSkills.findFirst({
      where: and(
        eq(agentSkills.tenantId, tenantId),
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.name, normalized),
      ),
    });
    if (!row) return false;

    const agent = await this.agentService.get(tenantId, agentId);
    if (agent) {
      try {
        const fs = await this.fsProvider.forAgentBinding({
          id: agent.id,
          tenantId: agent.tenantId,
          runtimeNodeId: agent.runtimeNodeId,
        });
        if (await fs.exists(row.path)) await fs.delete(row.path, true);
        platformEvents.publish(tenantId, {
          type: "agent_fs_changed",
          agentId: agent.id,
          path: SKILLS_ROOT,
        });
      } catch (err) {
        console.warn(
          `[skills] 删除 ${row.path} 失败:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    await this.db.delete(agentSkills).where(eq(agentSkills.id, row.id));
    this.forgetPromptSummary(tenantId, agentId);
    return true;
  }

  /** 从注册表删除技能，并从所有 Agent 卸载 */
  async remove(tenantId: string, idOrName: string): Promise<boolean> {
    const row = await this.findRow(tenantId, idOrName);
    if (!row) return false;
    const installs = await this.db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.tenantId, tenantId), eq(agentSkills.skillId, row.id)));
    for (const inst of installs) {
      await this.uninstall(tenantId, inst.agentId, inst.name);
    }
    await this.db.delete(skills).where(eq(skills.id, row.id));
    if (row.builtin) this.builtinSynced.delete(tenantId);
    return true;
  }

  /** 从来源重新抓取并覆盖安装到已装该技能的所有 Agent */
  async update(tenantId: string, idOrName: string): Promise<SkillRecord> {
    const row = await this.findRow(tenantId, idOrName);
    if (!row) throw new SkillSourceError("技能不存在");
    const source = parseSource(row.sourceJson);
    if (source.kind === "builtin") {
      const def = getBuiltinSkill(row.name);
      if (!def) throw new SkillSourceError("内置技能已下线");
      const updated = await this.upsertPackage(tenantId, builtinToPackage(def), true);
      return this.reinstallEverywhere(tenantId, updated);
    }

    const { packages } = await this.loadPackages({ ...source, skills: [row.name] });
    const pkg = packages.find((p) => p.name === row.name) ?? packages[0];
    if (!pkg) throw new SkillSourceError("来源中已找不到该技能");
    const updated = await this.upsertPackage(tenantId, { ...pkg, name: row.name }, false);
    return this.reinstallEverywhere(tenantId, updated);
  }

  private async reinstallEverywhere(tenantId: string, row: SkillRow): Promise<SkillRecord> {
    const installs = await this.db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.tenantId, tenantId), eq(agentSkills.skillId, row.id)));
    for (const inst of installs) {
      const agent = await this.agentService.get(tenantId, inst.agentId);
      if (!agent) continue;
      try {
        await this.installToAgent(agent, row);
      } catch (err) {
        console.warn(
          `[skills] 更新 ${row.name} → ${agent.slug} 失败:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return toRecord(row, installs.map((i) => i.agentId));
  }

  // —— 工作区读写（供 Agent 工具使用）——

  /**
   * 读技能文件。优先读工作区（Agent 可能就地改过），
   * 读不到再回落注册表内容。
   */
  async readSkillFile(
    tenantId: string,
    agent: Agent,
    name: string,
    relPath?: string,
  ): Promise<{ path: string; content: string } | null> {
    const normalized = normalizeSkillName(name);
    const rel = (relPath ?? SKILL_MANIFEST_FILE).replace(/\\/g, "/").replace(/^\/+/, "");
    const relParts = rel.split("/");
    if (!rel || relParts.some((part) => !part || part === "." || part === "..")) {
      return null;
    }
    const full = `${skillWorkspacePath(normalized)}/${rel}`;

    try {
      const fs = await this.fsProvider.forAgentBinding({
        id: agent.id,
        tenantId: agent.tenantId,
        runtimeNodeId: agent.runtimeNodeId,
      });
      if (await fs.exists(full)) {
        const read = await fs.readText(full);
        return { path: full, content: read.content };
      }
    } catch {
      /* 回落注册表 */
    }

    const row = await this.findRow(tenantId, normalized);
    if (!row) return null;
    const file = parseFiles(row.filesJson).find((f) => f.path === rel);
    if (!file) return null;
    return { path: full, content: file.content };
  }

  /**
   * 把 Agent 在工作区里写好的技能目录登记进注册表（skill-creator 流程）。
   * 目录必须含 SKILL.md。
   */
  async registerFromWorkspace(
    tenantId: string,
    agent: Agent,
    dirPath: string,
  ): Promise<SkillRecord> {
    const fs = await this.fsProvider.forAgentBinding({
      id: agent.id,
      tenantId: agent.tenantId,
      runtimeNodeId: agent.runtimeNodeId,
    });
    const root = dirPath.startsWith("/") ? dirPath.replace(/\/+$/, "") : `/${dirPath}`;
    const manifestPath = `${root}/${SKILL_MANIFEST_FILE}`;
    if (!(await fs.exists(manifestPath))) {
      throw new SkillSourceError(`${manifestPath} 不存在，技能目录必须包含 SKILL.md`);
    }

    const manifest = await fs.readText(manifestPath);
    const { frontmatter: rawFm, body } = parseSkillMarkdown(manifest.content);
    const dirName = root.split("/").filter(Boolean).pop() ?? "skill";
    const frontmatter = toSkillFrontmatter(rawFm, dirName);
    if (!frontmatter.description) {
      throw new SkillSourceError("SKILL.md 的 frontmatter 缺少 description");
    }
    const name = normalizeSkillName(frontmatter.name || dirName);

    const files: SkillFile[] = [];
    let total = 0;
    const collect = async (dir: string, prefix: string): Promise<void> => {
      const listed = await fs.list(dir, { recursive: false, limit: 200 });
      for (const entry of listed.entries) {
        if (files.length >= SKILL_MAX_FILES || total >= SKILL_MAX_TOTAL_BYTES) return;
        const childPath = `${dir}/${entry.name}`;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.type === "dir") {
          await collect(childPath, rel);
          continue;
        }
        if (entry.type !== "file") continue;
        try {
          const read = await fs.readText(childPath);
          const size = Buffer.byteLength(read.content, "utf8");
          if (total + size > SKILL_MAX_TOTAL_BYTES) continue;
          files.push({ path: rel, content: read.content, encoding: "utf8", size });
          total += size;
        } catch {
          /* 二进制或不可读文件跳过 */
        }
      }
    };
    await collect(root, "");

    if (!files.some((f) => f.path === SKILL_MANIFEST_FILE)) {
      const size = Buffer.byteLength(manifest.content, "utf8");
      files.unshift({
        path: SKILL_MANIFEST_FILE,
        content: manifest.content,
        encoding: "utf8",
        size,
      });
      total += size;
    }

    const pkg: SkillPackage = {
      name,
      title: typeof rawFm.title === "string" && rawFm.title ? rawFm.title : frontmatter.name,
      description: frontmatter.description,
      frontmatter,
      body,
      files,
      source: {
        kind: "url",
        raw: `workspace:${root}`,
        url: `workspace:${root}`,
      },
      version: new Date().toISOString().slice(0, 19).replace(/[-:T]/g, ""),
      sizeBytes: total,
    };

    const row = await this.upsertPackage(tenantId, pkg, false);
    // 目录名与技能名不一致时，同步到标准路径，保证 /skills/<name> 可预期
    if (root !== skillWorkspacePath(name)) {
      await this.installToAgent(agent, row);
    } else {
      await this.recordInstall(agent, row, "installed", null);
    }
    return toRecord(row, [agent.id]);
  }

  /** 工作区里存在但未登记的技能目录（供 UI 提示"发现未注册技能"） */
  async discoverUnregistered(tenantId: string, agent: Agent): Promise<string[]> {
    try {
      const fs: WorkspaceFs = await this.fsProvider.forAgentBinding({
        id: agent.id,
        tenantId: agent.tenantId,
        runtimeNodeId: agent.runtimeNodeId,
      });
      if (!(await fs.exists(SKILLS_ROOT))) return [];
      const listed = await fs.list(SKILLS_ROOT, { recursive: false, limit: 100 });
      const registered = new Set((await this.listForAgent(tenantId, agent.id)).map((s) => s.name));
      const found: string[] = [];
      for (const entry of listed.entries) {
        if (entry.type !== "dir" || registered.has(entry.name)) continue;
        if (await fs.exists(`${SKILLS_ROOT}/${entry.name}/${SKILL_MANIFEST_FILE}`)) {
          found.push(entry.name);
        }
      }
      return found;
    } catch {
      return [];
    }
  }
}
