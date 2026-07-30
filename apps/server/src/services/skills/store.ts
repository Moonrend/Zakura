/**
 * 技能商店检索。
 *
 * 四个商店（官方仓库 / 内置 / skills.sh / GitHub）各自独立：一次请求只查一个商店，
 * 分页、总数、错误都是该商店自己的。跨商店合并结果曾导致总数漂移与翻页重复，
 * 而且慢商店会拖住快商店——按商店切分后这两个问题都不存在。
 *
 * 本地商店（官方仓库 / 内置）在内存里过滤后精确切片，可以深度翻页；
 * 外部商店（skills.sh / GitHub）按上游一页的量抓取后做 TTL 缓存，避免重复打限流。
 */
import type { SkillSearchItem, SkillSearchPage, SkillStoreId } from "@zakura/shared";
import { BUILTIN_SKILLS } from "./builtin.js";
import { parseSkillSource } from "./source.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT = "Zakura-Skills/1.0";

export const DEFAULT_LIMIT = 24;
export const MAX_LIMIT = 100;
/** 外部商店单次向上游要的条数（本地再按 limit 切片） */
const UPSTREAM_PAGE = 100;

const cache = new Map<string, { expires: number; items: SkillSearchItem[] }>();

function cached(key: string): SkillSearchItem[] | null {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.items;
  if (hit) cache.delete(key);
  return null;
}

function putCache(key: string, items: SkillSearchItem[]): void {
  if (cache.size > 200) cache.clear();
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, items });
}

async function getJson<T>(url: string, token?: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (token && url.includes("api.github.com")) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function titleize(name: string): string {
  return name
    .split(/[-_:]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** 统一的本地匹配规则：名字 / 标题 / 描述 / 来源任一命中 */
function matches(q: string, ...fields: Array<string | undefined>): boolean {
  if (!q) return true;
  return fields.some((f) => f?.toLowerCase().includes(q));
}

// —— 内置 ——

function searchBuiltin(query: string): SkillSearchItem[] {
  const q = query.trim().toLowerCase();
  return BUILTIN_SKILLS.filter(
    (s) =>
      matches(q, s.name, s.title, s.description) ||
      (s.tags ?? []).some((t) => t.toLowerCase().includes(q)),
  ).map<SkillSearchItem>((s) => ({
    id: `builtin:${s.name}`,
    store: "builtin",
    name: s.name,
    title: s.title,
    description: s.description,
    source: "Zakura",
    installSpec: `builtin:${s.name}`,
    cached: true,
  }));
}

// —— 官方仓库（平台缓存）——

/** 平台缓存里的一条技能（由 SkillsService 注入，store 层不碰数据库） */
export interface CuratedSkillEntry {
  slug: string;
  name: string;
  title: string;
  description: string;
  publisher: string;
}

/**
 * 官方仓库：内容已由服务端同步到平台缓存，搜索直接走本地，
 * 既快又带完整描述（skills.sh 的接口是不返回描述的）。
 */
function searchCurated(
  query: string,
  entries: CuratedSkillEntry[],
  repoSlug?: string,
): SkillSearchItem[] {
  const q = query.trim().toLowerCase();
  return entries
    .filter((entry) => {
      if (repoSlug && entry.slug.toLowerCase() !== repoSlug.toLowerCase()) return false;
      return matches(q, entry.name, entry.title, entry.description, entry.slug);
    })
    .map<SkillSearchItem>((entry) => ({
      id: `curated:${entry.slug}/${entry.name}`,
      store: "curated",
      name: entry.name,
      title: entry.title || titleize(entry.name),
      description: entry.description,
      source: entry.slug,
      installSpec: `${entry.slug}@${entry.name}`,
      homepage: `https://github.com/${entry.slug}`,
      cached: true,
      repoSlug: entry.slug,
      publisher: entry.publisher,
    }));
}

// —— skills.sh ——

interface SkillsShHit {
  id: string;
  skillId: string;
  name: string;
  installs?: number;
  source: string;
  description?: string;
}

async function searchSkillsSh(query: string): Promise<SkillSearchItem[]> {
  const q = query.trim();
  // 上游要求至少 2 个字符；空查询回落到几个高安装量的关键词做"推荐"
  const terms = q.length >= 2 ? [q] : ["skills", "agent"];
  const out: SkillSearchItem[] = [];
  const seen = new Set<string>();

  for (const term of terms) {
    const key = `skills-sh:${term}`;
    let items = cached(key);
    if (!items) {
      const res = await getJson<{ skills?: SkillsShHit[] }>(
        `https://skills.sh/api/search?q=${encodeURIComponent(term)}`,
      );
      items = (res?.skills ?? [])
        // 域名托管的条目没有可抓取的公开地址，列出来只会点了报错
        .filter((hit) => hit.source?.includes("/"))
        .map<SkillSearchItem>((hit) => ({
          id: `skills-sh:${hit.id}`,
          store: "skills-sh",
          name: hit.skillId || hit.name,
          title: titleize(hit.skillId || hit.name),
          description: hit.description ?? "",
          source: hit.source,
          installSpec: `${hit.source}@${hit.skillId || hit.name}`,
          ...(typeof hit.installs === "number" ? { installs: hit.installs } : {}),
          homepage: `https://skills.sh/${hit.source}/${hit.skillId || hit.name}`,
        }));
      putCache(key, items);
    }
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }

  return out.sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));
}

// —— GitHub ——

interface GithubRepo {
  full_name: string;
  description?: string | null;
  stargazers_count?: number;
  html_url?: string;
  owner?: { login?: string };
  name?: string;
}

async function searchGithub(query: string, token?: string): Promise<SkillSearchItem[]> {
  const q = query.trim();
  const searchQuery = q
    ? `${q} SKILL.md in:readme,name,description,topics`
    : "topic:agent-skills";
  const key = `github:${searchQuery}`;
  const hit = cached(key);
  if (hit) return hit;

  const res = await getJson<{ items?: GithubRepo[] }>(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=stars&order=desc&per_page=${UPSTREAM_PAGE}`,
    token,
  );
  const items = (res?.items ?? []).map<SkillSearchItem>((repo) => ({
    id: `github:${repo.full_name}`,
    store: "github",
    name: repo.name ?? repo.full_name.split("/").pop() ?? repo.full_name,
    title: titleize(repo.name ?? repo.full_name.split("/").pop() ?? repo.full_name),
    description: repo.description ?? "",
    source: repo.full_name,
    installSpec: repo.full_name,
    ...(typeof repo.stargazers_count === "number" ? { stars: repo.stargazers_count } : {}),
    homepage: repo.html_url ?? `https://github.com/${repo.full_name}`,
  }));
  putCache(key, items);
  return items;
}

/**
 * 输入本身就是一个可安装来源时（owner/repo、URL、npx 命令），
 * 单独给出直达条目——不混进商店结果，免得污染分页与总数。
 */
export function directSkillHit(query: string): SkillSearchItem | null {
  const q = query.trim();
  if (!q || q.length < 3) return null;
  if (!/[/:]/.test(q)) return null;
  try {
    const source = parseSkillSource(q);
    if (source.kind === "builtin") return null;
    const label =
      source.owner && source.repo ? `${source.owner}/${source.repo}` : (source.url ?? q);
    return {
      id: `direct:${label}`,
      store: source.store ?? "github",
      name: source.skills?.[0] ?? source.repo ?? label,
      title: source.skills?.[0] ? titleize(source.skills[0]) : titleize(source.repo ?? label),
      description: "从你输入的来源直接安装",
      source: label,
      installSpec: q,
      ...(source.owner && source.repo
        ? { homepage: `https://github.com/${source.owner}/${source.repo}` }
        : {}),
    };
  } catch {
    return null;
  }
}

export interface SkillSearchOptions {
  query: string;
  /** 一次只查一个商店 */
  store: SkillStoreId;
  githubToken?: string | undefined;
  /** 已注册的技能名，用于标记 installed */
  installedNames?: Set<string>;
  /** 平台缓存里的技能（curated 商店的数据源） */
  curated?: CuratedSkillEntry[];
  /** 只看某个仓库（仅 curated 支持） */
  repoSlug?: string | undefined;
  offset?: number;
  limit?: number;
}

async function fetchStore(opts: SkillSearchOptions): Promise<SkillSearchItem[]> {
  switch (opts.store) {
    case "builtin":
      return searchBuiltin(opts.query);
    case "curated":
      return searchCurated(opts.query, opts.curated ?? [], opts.repoSlug);
    case "skills-sh":
      return searchSkillsSh(opts.query);
    case "github":
      return searchGithub(opts.query, opts.githubToken);
  }
}

export async function searchSkillStores(opts: SkillSearchOptions): Promise<SkillSearchPage> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  // 浏览某个仓库时，直达条目只会碍事
  const direct = opts.repoSlug ? null : directSkillHit(opts.query);

  let all: SkillSearchItem[];
  let error: string | undefined;
  try {
    all = await fetchStore(opts);
  } catch (err) {
    all = [];
    error = err instanceof Error ? err.message : String(err);
  }

  const seen = new Set<string>();
  const deduped = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  const items = deduped.slice(offset, offset + limit);
  if (opts.installedNames?.size) {
    for (const item of [...items, ...(direct ? [direct] : [])]) {
      if (opts.installedNames.has(item.name.toLowerCase())) item.installed = true;
    }
  }

  return {
    store: opts.store,
    items,
    total: deduped.length,
    offset,
    limit,
    hasMore: offset + limit < deduped.length,
    ...(direct ? { direct } : {}),
    ...(error ? { error } : {}),
  };
}
