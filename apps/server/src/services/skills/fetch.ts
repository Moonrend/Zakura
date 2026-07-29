/**
 * 技能抓取：把 SkillSource 变成可安装的 SkillPackage[]。
 *
 * GitHub 走 git trees API 一次性拿全量文件表，由 discover.ts 按"文件名即标记"
 * 的规则找出 SKILL.md（不再依赖目录白名单）；命中后只下载该技能目录下的文件
 * （受体积与数量上限保护）。一个 SKILL.md 都没有时退化为单文件技能扫描。
 */
import {
  SKILL_MANIFEST_FILE,
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  type SkillFile,
  type SkillPackage,
  type SkillSource,
} from "@zakura/shared";
import {
  SkillSourceError,
  normalizeSkillName,
  parseSkillMarkdown,
  toSkillFrontmatter,
} from "./source.js";
import {
  basename,
  bundlePaths,
  discoverFallbackManifests,
  discoverManifests,
  extname,
  manifestDir,
  markdownHints,
  type FallbackCandidate,
} from "./discover.js";

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "Zakura-Skills/1.0";
/** 单个技能目录下最多下载的捆绑文件数（含 SKILL.md） */
const MAX_BUNDLED_FILES = SKILL_MAX_FILES;
/** 一个来源最多解析出的技能数 */
const MAX_SKILLS_PER_SOURCE = 40;
/** 并发下载数：既压住 raw.githubusercontent 的速率，也别让预览等太久 */
const DOWNLOAD_CONCURRENCY = 8;
/**
 * GitHub API 未鉴权时每小时只有 60 次，而在商店里逐个预览同一仓库的技能
 * 会反复打同一个 tree 接口——按 (owner, repo, ref) 缓存一小段时间。
 */
const TREE_TTL_MS = 5 * 60 * 1000;
const TREE_CACHE_MAX = 64;

interface CachedTree {
  tree: GithubTreeEntry[];
  sha?: string | undefined;
  truncated?: boolean | undefined;
}

const treeCache = new Map<string, { expires: number; value: CachedTree }>();
const defaultBranchCache = new Map<string, { expires: number; value: string }>();

function readCache<T>(store: Map<string, { expires: number; value: T }>, key: string): T | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache<T>(
  store: Map<string, { expires: number; value: T }>,
  key: string,
  value: T,
): void {
  if (store.size >= TREE_CACHE_MAX) store.clear();
  store.set(key, { expires: Date.now() + TREE_TTL_MS, value });
}

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".sh", ".bash",
  ".css", ".html", ".xml", ".sql", ".env", ".ini", ".conf", ".rs", ".go", ".java",
]);
/** 明确跳过的二进制/无关文件 */
const SKIP_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".7z", ".exe", ".dll", ".so", ".dylib", ".mp4", ".mov",
  ".pdf", ".psd", ".sketch", ".woff", ".woff2", ".ttf", ".otf",
]);

export interface FetchOptions {
  /** GitHub PAT，用于提升 API 限额（可选） */
  githubToken?: string | undefined;
  /**
   * 只下载 SKILL.md，捆绑文件仅登记路径与体积（放进 pkg.assets）。
   * 安装前预览用，避免为一个 40 技能的仓库拉几百个文件。
   */
  manifestOnly?: boolean;
  signal?: AbortSignal;
}

export interface FetchResult {
  packages: SkillPackage[];
  warnings: string[];
}

async function httpJson<T>(url: string, opts: FetchOptions, accept = "application/json"): Promise<T> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": USER_AGENT,
  };
  const token = opts.githubToken?.trim();
  if (token && url.includes("api.github.com")) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetchWithTimeout(url, { headers }, opts.signal);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 429 || (res.status === 403 && detail.includes("rate limit"))) {
      throw new SkillSourceError(
        token
          ? "GitHub API 限流：请稍后重试"
          : "GitHub API 限流（未鉴权每小时仅 60 次）：请稍后重试，或为服务端配置 GITHUB_TOKEN 环境变量",
      );
    }
    if (res.status === 404) {
      throw new SkillSourceError(`资源不存在（404）：${url}`);
    }
    throw new SkillSourceError(`请求失败 ${res.status}：${url}`);
  }
  return (await res.json()) as T;
}

async function httpText(url: string, opts: FetchOptions): Promise<string> {
  const res = await fetchWithTimeout(
    url,
    { headers: { "User-Agent": USER_AGENT, Accept: "text/plain, text/markdown, */*" } },
    opts.signal,
  );
  if (!res.ok) throw new SkillSourceError(`下载失败 ${res.status}：${url}`);
  return await res.text();
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  external?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  external?.addEventListener("abort", onAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new SkillSourceError(`请求超时：${url}`);
    throw new SkillSourceError(
      `网络错误：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}

function isTextFile(path: string): boolean {
  const ext = extname(path);
  if (!ext) return true; // 无扩展名的脚本按文本处理
  return TEXT_EXTENSIONS.has(ext);
}

/** -s/--skill 过滤：技能名、目录名、清单路径任一命中即可 */
function matchesRequested(requested: string[] | undefined, ...aliases: string[]): boolean {
  if (!requested?.length || requested.includes("*")) return true;
  const pool = aliases.filter(Boolean).map((a) => a.toLowerCase());
  const normalized = pool.map(normalizeSkillName);
  return requested.some((r) => {
    const wanted = r.trim().toLowerCase();
    if (!wanted) return false;
    return (
      pool.includes(wanted) ||
      normalized.includes(normalizeSkillName(wanted)) ||
      pool.some((a) => a.endsWith(`/${wanted}`))
    );
  });
}

function buildPackage(
  manifestText: string,
  files: SkillFile[],
  source: SkillSource,
  fallbackName: string,
  version?: string,
): SkillPackage {
  const { frontmatter: rawFm, body } = parseSkillMarkdown(manifestText);
  const frontmatter = toSkillFrontmatter(rawFm, fallbackName);
  const name = normalizeSkillName(frontmatter.name || fallbackName);
  const sizeBytes = files.reduce((sum, f) => sum + f.size, 0);
  const title =
    typeof rawFm.title === "string" && rawFm.title.trim()
      ? rawFm.title.trim()
      : frontmatter.name || name;
  const description =
    frontmatter.description ||
    body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"))?.trim() ||
    "";

  return {
    name,
    title,
    description,
    frontmatter,
    body,
    files,
    source,
    ...(version ? { version } : {}),
    sizeBytes,
    ...(typeof frontmatter.homepage === "string" ? { homepage: frontmatter.homepage } : {}),
    ...(typeof frontmatter.license === "string" ? { license: frontmatter.license } : {}),
  };
}

interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha: string;
}

/** 一个待构建技能：清单文件 + 捆绑目录 + 记回 source.path 的定位串 */
interface ManifestPlan {
  manifestPath: string;
  /** 捆绑资源目录；null = 不收，"" = 仓库根 */
  bundleDir: string | null;
  /** frontmatter 缺 name 时的兜底名 */
  fallbackName: string;
  /** 写回 source.path，供后续"更新"精确复现 */
  scopePath: string;
}

interface RepoContext {
  /** 仓库内全部 blob 路径 */
  paths: string[];
  sizeOf: (path: string) => number;
  readText: (path: string) => Promise<string>;
  source: SkillSource;
  /** 版本标识：commit sha 或 ref */
  version: string;
  /** 仓库名，作为最后的兜底技能名 */
  repo: string;
  warnings: string[];
  /** 只取清单，不下载捆绑文件 */
  manifestOnly: boolean;
}

function planFromManifest(manifestPath: string, repo: string): ManifestPlan {
  const dir = manifestDir(manifestPath);
  return {
    manifestPath,
    bundleDir: dir,
    fallbackName: dir.split("/").pop() || repo,
    scopePath: dir,
  };
}

function planFromFallback(candidate: FallbackCandidate, repo: string): ManifestPlan {
  return {
    manifestPath: candidate.path,
    bundleDir: candidate.bundleDir,
    fallbackName: candidate.fallbackName || repo,
    scopePath: candidate.path,
  };
}

/** 有界并发 map：技能仓库动辄几十个文件，串行下载会让预览等到超时 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 按计划下载清单与捆绑文件，产出可安装的技能包 */
async function buildPackages(plans: ManifestPlan[], ctx: RepoContext): Promise<SkillPackage[]> {
  const bundleDirs = plans.map((p) => p.bundleDir);
  const packages: SkillPackage[] = [];
  const skipped: string[] = [];

  const manifestTexts = await mapPool(plans, DOWNLOAD_CONCURRENCY, async (plan) => {
    try {
      return await ctx.readText(plan.manifestPath);
    } catch (err) {
      ctx.warnings.push(`跳过 ${plan.manifestPath}：${err instanceof Error ? err.message : err}`);
      return null;
    }
  });

  for (const [index, plan] of plans.entries()) {
    if (packages.length >= MAX_SKILLS_PER_SOURCE) {
      ctx.warnings.push(`技能数量超过 ${MAX_SKILLS_PER_SOURCE}，已截断`);
      break;
    }

    const manifestText = manifestTexts[index];
    if (manifestText == null) continue;

    const { frontmatter: fm } = parseSkillMarkdown(manifestText);
    const declaredName =
      typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : plan.fallbackName;
    if (
      !matchesRequested(
        ctx.source.skills,
        declaredName,
        plan.fallbackName,
        basename(plan.bundleDir ?? ""),
        plan.scopePath,
        // 单技能仓库常被写成 owner/repo@repo，仓库名也算别名
        plans.length === 1 ? ctx.repo : "",
      )
    ) {
      skipped.push(declaredName);
      continue;
    }
    if (fm.metadata && typeof fm.metadata === "object") {
      const meta = fm.metadata as Record<string, unknown>;
      if (meta.internal === true || meta.internal === "true") continue;
    }

    const files: SkillFile[] = [
      {
        path: SKILL_MANIFEST_FILE,
        content: manifestText,
        encoding: "utf8",
        size: Buffer.byteLength(manifestText, "utf8"),
      },
    ];
    let total = files[0]!.size;

    // 先按文件表里的声明体积筛一遍，再决定下载哪些
    const dir = plan.bundleDir;
    const planned: Array<{ path: string; rel: string; size: number }> = [];
    for (const entryPath of bundlePaths(dir, ctx.paths, plan.manifestPath, bundleDirs)) {
      if (planned.length + 1 >= MAX_BUNDLED_FILES) {
        ctx.warnings.push(`${declaredName}: 捆绑文件超过 ${MAX_BUNDLED_FILES} 个，已截断`);
        break;
      }
      const rel = dir ? entryPath.slice(dir.length + 1) : entryPath;
      if (SKIP_EXTENSIONS.has(extname(rel))) continue;
      if (!isTextFile(rel)) continue;
      const size = ctx.sizeOf(entryPath);
      if (size > SKILL_MAX_FILE_BYTES) {
        ctx.warnings.push(`${declaredName}/${rel}: 单文件超过 512KB，已跳过`);
        continue;
      }
      if (total + size > SKILL_MAX_TOTAL_BYTES) {
        ctx.warnings.push(`${declaredName}: 技能总体积超过上限，剩余文件已跳过`);
        break;
      }
      total += size;
      planned.push({ path: entryPath, rel, size });
    }

    const assets: Array<{ path: string; size: number }> = [];
    if (ctx.manifestOnly) {
      assets.push(...planned.map((p) => ({ path: p.rel, size: p.size })));
    } else {
      const contents = await mapPool(planned, DOWNLOAD_CONCURRENCY, async (entry) => {
        try {
          return await ctx.readText(entry.path);
        } catch (err) {
          ctx.warnings.push(`${entry.rel} 下载失败：${err instanceof Error ? err.message : err}`);
          return null;
        }
      });
      // 声明体积可能缺失（GitLab），按真实体积再兜一次总量
      let actual = files[0]!.size;
      for (const [i, content] of contents.entries()) {
        if (content == null) continue;
        const size = Buffer.byteLength(content, "utf8");
        if (size > SKILL_MAX_FILE_BYTES) continue;
        if (actual + size > SKILL_MAX_TOTAL_BYTES) {
          ctx.warnings.push(`${declaredName}: 技能总体积超过上限，剩余文件已跳过`);
          break;
        }
        files.push({ path: planned[i]!.rel, content, encoding: "utf8", size });
        actual += size;
      }
      total = actual;
    }

    const pkg = buildPackage(
      manifestText,
      files,
      {
        ...ctx.source,
        ...(ctx.source.ref ? { ref: ctx.source.ref } : {}),
        ...(plan.scopePath ? { path: plan.scopePath } : {}),
      },
      plan.fallbackName,
      ctx.version,
    );
    if (assets.length) {
      pkg.assets = assets;
      pkg.sizeBytes += assets.reduce((sum, a) => sum + a.size, 0);
    }
    packages.push(pkg);
  }

  if (!packages.length && ctx.source.skills?.length) {
    throw new SkillSourceError(
      `未找到指定技能：${ctx.source.skills.join("、")}` +
        (skipped.length ? `。该来源提供：${skipped.slice(0, 12).join("、")}` : ""),
    );
  }
  return packages;
}

/** 没有 SKILL.md 时，把带 frontmatter 的普通 Markdown 当单文件技能 */
async function planFallbacks(ctx: RepoContext): Promise<ManifestPlan[]> {
  const candidates = discoverFallbackManifests(ctx.paths, ctx.source.path).filter(
    (c) => ctx.sizeOf(c.path) <= SKILL_MAX_FILE_BYTES,
  );
  const texts = await mapPool(candidates, DOWNLOAD_CONCURRENCY, async (c) => {
    try {
      return await ctx.readText(c.path);
    } catch {
      return null;
    }
  });

  const plans: ManifestPlan[] = [];
  for (const [i, text] of texts.entries()) {
    if (text == null) continue;
    if (plans.length >= MAX_SKILLS_PER_SOURCE) break;
    const { frontmatter } = parseSkillMarkdown(text);
    const named = typeof frontmatter.name === "string" && frontmatter.name.trim();
    const described =
      typeof frontmatter.description === "string" && frontmatter.description.trim();
    if (!named || !described) continue;
    plans.push(planFromFallback(candidates[i]!, ctx.repo));
  }
  if (plans.length) {
    ctx.warnings.push(
      `该来源没有 SKILL.md，已按单文件技能导入：${plans.map((p) => p.manifestPath).join("、")}`,
    );
  }
  return plans;
}

function notFoundError(label: string, ctx: RepoContext): SkillSourceError {
  const hints = markdownHints(ctx.paths);
  const scope = ctx.source.path ? `/${ctx.source.path}` : "";
  return new SkillSourceError(
    `未在 ${label}${scope} 找到 SKILL.md（也没有带 name/description frontmatter 的 Markdown）。` +
      (hints.length
        ? `仓库内的 Markdown：${hints.join("、")}。可用 ${label}/<子目录> 指定技能位置。`
        : ""),
  );
}

async function fetchGithub(source: SkillSource, opts: FetchOptions): Promise<FetchResult> {
  const { owner, repo } = source;
  if (!owner || !repo) throw new SkillSourceError("GitHub 来源缺少 owner/repo");

  const warnings: string[] = [];
  let ref = source.ref;

  if (!ref) {
    const cacheKey = `${owner}/${repo}`;
    ref = readCache(defaultBranchCache, cacheKey) ?? "";
    if (!ref) {
      const info = await httpJson<{ default_branch?: string }>(
        `https://api.github.com/repos/${owner}/${repo}`,
        opts,
      );
      ref = info.default_branch || "main";
      writeCache(defaultBranchCache, cacheKey, ref);
    }
  }

  const treeKey = `${owner}/${repo}@${ref}`;
  let cachedTree = readCache(treeCache, treeKey);
  if (!cachedTree) {
    try {
      const res = await httpJson<{ tree?: GithubTreeEntry[]; sha?: string; truncated?: boolean }>(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        opts,
      );
      cachedTree = { tree: res.tree ?? [], sha: res.sha, truncated: res.truncated };
      writeCache(treeCache, treeKey, cachedTree);
    } catch (err) {
      if (err instanceof SkillSourceError && err.message.includes("404")) {
        throw new SkillSourceError(`仓库或分支不存在：${owner}/${repo}@${ref}`);
      }
      throw err;
    }
  }
  if (cachedTree.truncated) {
    warnings.push("仓库文件过多，GitHub 返回了截断的文件表，可能有技能未被发现");
  }

  const blobs = cachedTree.tree.filter((e) => e.type === "blob");
  const sizes = new Map(blobs.map((e) => [e.path, e.size ?? 0]));
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}`;
  const ctx: RepoContext = {
    paths: blobs.map((e) => e.path),
    sizeOf: (p) => sizes.get(p) ?? 0,
    readText: (p) => httpText(`${rawBase}/${encodeURI(p)}`, opts),
    source: { ...source, ref },
    version: cachedTree.sha?.slice(0, 12) ?? ref,
    repo,
    warnings,
    manifestOnly: opts.manifestOnly ?? false,
  };

  let plans = discoverManifests(ctx.paths, source.path).map((p) => planFromManifest(p, repo));
  if (!plans.length) plans = await planFallbacks(ctx);
  if (!plans.length) throw notFoundError(`${owner}/${repo}`, ctx);

  const packages = await buildPackages(plans, ctx);
  if (!packages.length) throw new SkillSourceError("未找到可安装的技能");
  return { packages, warnings };
}

interface GitlabTreeEntry {
  path: string;
  type: "blob" | "tree";
  name: string;
}

async function fetchGitlab(source: SkillSource, opts: FetchOptions): Promise<FetchResult> {
  const { owner, repo } = source;
  if (!owner || !repo) throw new SkillSourceError("GitLab 来源缺少项目路径");
  const projectId = encodeURIComponent(`${owner}/${repo}`);
  const ref = source.ref || "HEAD";
  const warnings: string[] = [];

  const entries = await httpJson<GitlabTreeEntry[]>(
    `https://gitlab.com/api/v4/projects/${projectId}/repository/tree?recursive=true&per_page=100&ref=${encodeURIComponent(ref)}`,
    opts,
  );

  const rawUrl = (path: string) =>
    `https://gitlab.com/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;

  const ctx: RepoContext = {
    paths: entries.filter((e) => e.type === "blob").map((e) => e.path),
    // GitLab tree 不返回体积，先按 0 计，靠下载后的实际大小兜底
    sizeOf: () => 0,
    readText: (p) => httpText(rawUrl(p), opts),
    source: { ...source, ref },
    version: ref,
    repo,
    warnings,
    manifestOnly: opts.manifestOnly ?? false,
  };

  let plans = discoverManifests(ctx.paths, source.path).map((p) => planFromManifest(p, repo));
  if (!plans.length) plans = await planFallbacks(ctx);
  if (!plans.length) throw notFoundError(`${owner}/${repo}`, ctx);

  const packages = await buildPackages(plans, ctx);
  if (!packages.length) throw new SkillSourceError("未找到可安装的技能");
  return { packages, warnings };
}

/** 直链：把一个 Markdown 文件当作单技能 */
async function fetchUrl(source: SkillSource, opts: FetchOptions): Promise<FetchResult> {
  if (!source.url) throw new SkillSourceError("缺少 URL");
  const text = await httpText(source.url, opts);
  if (Buffer.byteLength(text, "utf8") > SKILL_MAX_FILE_BYTES) {
    throw new SkillSourceError("文件超过 512KB，无法作为技能安装");
  }
  const fallback =
    new URL(source.url).pathname.split("/").filter(Boolean).slice(-2, -1)[0] ?? "skill";
  const files: SkillFile[] = [
    {
      path: SKILL_MANIFEST_FILE,
      content: text,
      encoding: "utf8",
      size: Buffer.byteLength(text, "utf8"),
    },
  ];
  const pkg = buildPackage(text, files, source, normalizeSkillName(fallback));
  if (!pkg.description) {
    return {
      packages: [pkg],
      warnings: ["该文件没有 SKILL.md frontmatter，已按纯 Markdown 技能导入"],
    };
  }
  return { packages: [pkg], warnings: [] };
}

/** 拉取来源中的全部（或指定的）技能 */
export async function fetchSkillPackages(
  source: SkillSource,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  switch (source.kind) {
    case "github":
      return fetchGithub(source, opts);
    case "gitlab":
      return fetchGitlab(source, opts);
    case "url":
      return fetchUrl(source, opts);
    case "git": {
      // git@host:owner/repo.git / https://host/owner/repo.git
      const url = source.url ?? "";
      const match = /(?:github|gitlab)\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(url);
      if (match) {
        const kind = url.toLowerCase().includes("gitlab") ? "gitlab" : "github";
        return fetchSkillPackages(
          { ...source, kind, owner: match[1]!, repo: match[2]! },
          opts,
        );
      }
      throw new SkillSourceError(
        "暂不支持任意 git 仓库克隆安装，请改用 GitHub / GitLab 链接或 SKILL.md 直链",
      );
    }
    case "builtin":
      throw new SkillSourceError("内置技能无需下载");
    default:
      throw new SkillSourceError(`不支持的来源类型：${String(source.kind)}`);
  }
}
