/**
 * 技能发现：从一份仓库文件表里挑出真正的 SKILL.md。
 *
 * 早期版本用目录白名单（skills/、.claude/skills/ …）做准入，结果是
 * `yetone/kill-ai-slop` 这类把技能放在 `skill/`（单数）的仓库直接被判定为
 * "未找到 SKILL.md"。实际上 **文件名本身就是标记**：只要叫 SKILL.md 就当技能，
 * 白名单退化成排序权重（越"正规"的位置排越前），噪声目录用黑名单剔除。
 *
 * 仓库里一个 SKILL.md 都没有时，再退一步找"单文件技能"（skills/foo.md、
 * skill/README.md 这种带 frontmatter 的 Markdown），由调用方下载后校验
 * frontmatter 是否含 name + description。
 */
import { SKILL_DISCOVERY_DIRS, SKILL_MANIFEST_FILE } from "@zakura/shared";

/** 一定不是技能的目录：构建产物、依赖、虚拟环境 */
const NOISE_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".venv",
  "venv",
  "__pycache__",
  "site-packages",
  ".turbo",
  ".cache",
  ".pytest_cache",
  "bower_components",
  ".terraform",
]);

/** 路径过深基本是示例/测试夹具，不是要安装的技能 */
const MAX_MANIFEST_DEPTH = 8;

/** 排序权重：命中越靠前的容器目录越"正规" */
const PREFERRED_CONTAINERS: readonly string[] = [
  ...SKILL_DISCOVERY_DIRS,
  "skill",
  "agents",
  ".agents",
  "docs/skills",
];

/** 单文件技能的候选容器 */
const FALLBACK_CONTAINERS: readonly string[] = [
  "skills",
  "skill",
  ".claude/skills",
  ".agents/skills",
  ".agents",
  "agents",
];

/** README 之类不能当技能名的文件 */
const GENERIC_MD = new Set([
  "readme.md",
  "changelog.md",
  "license.md",
  "contributing.md",
  "code_of_conduct.md",
  "security.md",
  "index.md",
  "agents.md",
  "claude.md",
]);

/** 根级技能只从这些子目录里捞捆绑资源，避免把整个仓库塞进技能包 */
const ROOT_BUNDLE_DIRS = ["references", "scripts", "assets", "resources", "templates"];

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function extname(path: string): string {
  const base = basename(path);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx).toLowerCase() : "";
}

/** SKILL.md / skill.md 都认（GitHub 上大小写不一致的仓库不少） */
export function isManifestPath(path: string): boolean {
  return basename(path).toLowerCase() === SKILL_MANIFEST_FILE.toLowerCase();
}

/** SKILL.md 所在目录；仓库根返回空串 */
export function manifestDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

function normalizeScope(explicitPath?: string): string {
  return (explicitPath ?? "").replace(/^\/+|\/+$/g, "");
}

function inScope(dir: string, scope: string): boolean {
  if (!scope) return true;
  return dir === scope || dir.startsWith(`${scope}/`);
}

function hasNoiseSegment(path: string): boolean {
  return path.split("/").slice(0, -1).some((seg) => NOISE_SEGMENTS.has(seg));
}

/** 排序键：容器优先级 → 层级越浅越前 → 字典序 */
function rankKey(path: string): [number, number, string] {
  const dir = manifestDir(path);
  let preferred = PREFERRED_CONTAINERS.length;
  PREFERRED_CONTAINERS.forEach((c, i) => {
    if (i < preferred && (dir === c || dir.startsWith(`${c}/`))) preferred = i;
  });
  return [preferred, dir ? dir.split("/").length : 0, path];
}

function byRank(a: string, b: string): number {
  const ka = rankKey(a);
  const kb = rankKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
}

/** 浅层 SKILL.md 遮蔽其子目录里的（技能自带的示例不算独立技能） */
export function dedupeNested(paths: string[]): string[] {
  const dirs = paths.map(manifestDir);
  return paths.filter((_, i) => {
    const dir = dirs[i]!;
    return !dirs.some((other, j) => j !== i && other !== dir && dir.startsWith(`${other}/`));
  });
}

/**
 * 从全量文件表里发现技能清单。
 * @param paths 仓库内所有 blob 路径
 * @param explicitPath 用户显式指定的子目录（owner/repo/some/dir）
 */
export function discoverManifests(paths: string[], explicitPath?: string): string[] {
  const scope = normalizeScope(explicitPath);
  // 显式指到了某个 .md 文件：只认它
  if (scope.toLowerCase().endsWith(".md")) {
    return paths.includes(scope) && isManifestPath(scope) ? [scope] : [];
  }
  const hits = paths.filter((p) => {
    if (!isManifestPath(p)) return false;
    if (hasNoiseSegment(p)) return false;
    if (p.split("/").length > MAX_MANIFEST_DEPTH) return false;
    return inScope(manifestDir(p), scope);
  });
  return dedupeNested(hits).sort(byRank);
}

export interface FallbackCandidate {
  /** Markdown 文件路径 */
  path: string;
  /** 推导出的技能名（未规范化） */
  fallbackName: string;
  /** 捆绑资源所在目录；null 表示不收捆绑资源，"" 表示仓库根 */
  bundleDir: string | null;
}

/** 路径表里出现过的所有目录（含中间层级，用于判断"是否存在同名资源目录"） */
function collectDirs(paths: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  return dirs;
}

/**
 * 仓库里没有 SKILL.md 时的兜底：可能是"单文件技能"。
 * 只返回候选，是否算技能由调用方按 frontmatter 判定。
 */
export function discoverFallbackManifests(
  paths: string[],
  explicitPath?: string,
  limit = 16,
): FallbackCandidate[] {
  const scope = normalizeScope(explicitPath);
  const dirs = collectDirs(paths);

  // 显式指到了某个 .md 文件：直接当单文件技能
  if (scope.toLowerCase().endsWith(".md")) {
    if (!paths.includes(scope)) return [];
    const stem = basename(scope).replace(/\.md$/i, "");
    const dir = manifestDir(scope);
    const sibling = dir ? `${dir}/${stem}` : stem;
    const generic = GENERIC_MD.has(basename(scope).toLowerCase());
    return [
      {
        path: scope,
        fallbackName: generic ? basename(dir) : stem,
        bundleDir: generic ? dir : dirs.has(sibling) ? sibling : null,
      },
    ];
  }

  const containers = scope ? [scope] : FALLBACK_CONTAINERS;
  const seen = new Set<string>();
  const out: FallbackCandidate[] = [];

  const push = (path: string, fallbackName: string, bundleDir: string | null) => {
    if (seen.has(path) || out.length >= limit) return;
    seen.add(path);
    out.push({ path, fallbackName, bundleDir });
  };

  const md = paths.filter(
    (p) => extname(p) === ".md" && !hasNoiseSegment(p) && inScope(manifestDir(p), scope),
  );

  // 一级：<容器>/<name>.md
  for (const container of containers) {
    const named = md
      .filter((p) => manifestDir(p) === container && !GENERIC_MD.has(basename(p).toLowerCase()))
      .sort();
    for (const p of named) {
      const stem = basename(p).replace(/\.md$/i, "");
      push(p, stem, dirs.has(`${container}/${stem}`) ? `${container}/${stem}` : null);
    }
  }

  // 二级：<容器>/README.md 或 <容器>/<name>/README.md
  for (const p of md.sort(byRank)) {
    if (basename(p).toLowerCase() !== "readme.md") continue;
    const dir = manifestDir(p);
    if (!dir) continue;
    const matches = containers.some((c) => dir === c || dir.startsWith(`${c}/`));
    if (!matches) continue;
    push(p, basename(dir), dir);
  }

  // 三级：仓库根 README.md（很多单技能仓库把说明写在这里）
  if (!scope && md.includes("README.md")) push("README.md", "", "");

  return out;
}

/** 该技能目录下应当一并下载的文件（不含清单本身，不吃掉嵌套技能） */
export function bundlePaths(
  dir: string | null,
  paths: string[],
  manifestPath: string,
  otherManifestDirs: Array<string | null>,
): string[] {
  if (dir === null) return [];
  if (!dir) {
    // 根级技能：只收公认的资源目录
    return paths.filter(
      (p) =>
        p !== manifestPath &&
        ROOT_BUNDLE_DIRS.some((d) => p.startsWith(`${d}/`)) &&
        !otherManifestDirs.some((other) => other && p.startsWith(`${other}/`)),
    );
  }
  return paths.filter(
    (p) =>
      p !== manifestPath &&
      p.startsWith(`${dir}/`) &&
      !otherManifestDirs.some((other) => other && other !== dir && p.startsWith(`${other}/`)),
  );
}

/** 找不到技能时给用户的线索：仓库里最像技能的 Markdown */
export function markdownHints(paths: string[], limit = 5): string[] {
  return paths
    .filter((p) => extname(p) === ".md" && !hasNoiseSegment(p))
    .sort(byRank)
    .slice(0, limit);
}
