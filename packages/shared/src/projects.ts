/**
 * 云端 Agent 工作区项目约定：/workspace/projects/<slug>/ 一层子目录即一个项目。
 * 文件系统为真相源；会话与定时任务只存 slug。
 */
import { AGENT_SKILLS_DIR } from "./skills.js";

export const AGENT_WORKSPACE_ROOT = "/workspace";
export const AGENT_PROJECTS_DIR = "projects";
export const AGENT_DATA_DIR = "data";
export const AGENT_OUTPUTS_DIR = "outputs";
export const AGENT_UPLOADS_DIR = "uploads";

/** 平台自动创建的工作区顶层目录 */
export const AGENT_WORKSPACE_LAYOUT_DIRS = [
  AGENT_PROJECTS_DIR,
  AGENT_DATA_DIR,
  AGENT_OUTPUTS_DIR,
  AGENT_UPLOADS_DIR,
  AGENT_SKILLS_DIR,
] as const;

/** 项目根指令文件，优先 AGENTS.md（对齐 Pi / Claude） */
export const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** 项目级技能目录（只扫这些，避免把业务代码里的 skills/ 当技能） */
export const PROJECT_SKILL_DIRS = [".agents/skills", ".claude/skills"] as const;

/** GUI / 平台写入的技能目录 */
export const PROJECT_SKILLS_WRITE_DIR = ".agents/skills";

/** 项目 hooks 候选路径，靠前的优先作为保存目标 */
export const PROJECT_HOOKS_FILES = [
  ".agents/hooks.json",
  ".agents/hooks/hooks.json",
  ".claude/hooks.json",
  "hooks/hooks.json",
] as const;

/** Claude Code settings.json，其中的 hooks 键也会被读取 */
export const PROJECT_CLAUDE_SETTINGS_FILE = ".claude/settings.json";

export const PROJECT_HOOKS_WRITE_FILE = ".agents/hooks.json";

const PROJECT_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidProjectSlug(slug: string): boolean {
  return PROJECT_SLUG_RE.test(slug);
}

/**
 * 解析 API / 工具入参里的 project 字段。
 * omit = 未传；ok+null = 显式解绑；ok+slug = 绑定；invalid = 非法值。
 */
export function parseProjectField(
  raw: unknown,
): { status: "omit" } | { status: "ok"; slug: string | null } | { status: "invalid" } {
  if (raw === undefined) return { status: "omit" };
  if (raw === null) return { status: "ok", slug: null };
  if (typeof raw !== "string") return { status: "invalid" };
  const s = raw.trim();
  if (!s) return { status: "ok", slug: null };
  if (!isValidProjectSlug(s)) return { status: "invalid" };
  return { status: "ok", slug: s };
}

export function projectWorkspacePath(slug: string): string {
  return `${AGENT_WORKSPACE_ROOT}/${AGENT_PROJECTS_DIR}/${slug}`;
}

export function projectRelativePath(slug: string): string {
  return `${AGENT_PROJECTS_DIR}/${slug}`;
}

/** 会话绑定项目时的默认 cwd；未绑定则是工作区根。 */
export function projectDefaultWorkingDir(slug: string | null | undefined): string {
  return slug && isValidProjectSlug(slug) ? projectWorkspacePath(slug) : AGENT_WORKSPACE_ROOT;
}

/** 从 fs.list / listDetailed 一层结果筛出合法项目 slug（忽略隐藏目录与文件）。 */
export function projectSlugsFromList(
  entries: Array<{ name: string; type?: string; isDir?: boolean }>,
): string[] {
  const slugs: string[] = [];
  for (const e of entries) {
    const isDir = e.isDir ?? (e.type ? e.type === "dir" : true);
    if (!isDir) continue;
    const name = e.name.replace(/\\/g, "/").split("/").pop() ?? "";
    if (isValidProjectSlug(name)) slugs.push(name);
  }
  return slugs.sort((a, b) => a.localeCompare(b));
}

export function isSafeGitRemoteUrl(url: string): boolean {
  const u = url.trim();
  if (!u || u.length > 500 || /\s/.test(u)) return false;
  return /^https:\/\//i.test(u) || /^git@[\w.-]+:[\w./-]+(?:\.git)?$/i.test(u);
}

export function workspaceLayoutPromptBlock(): string {
  const root = AGENT_WORKSPACE_ROOT;
  const projects = `${root}/${AGENT_PROJECTS_DIR}`;
  return [
    "# 工作区布局",
    `${root} 是持久家目录。独立项目在 ${projects}/<项目名>/，一层子目录即一个项目。`,
    `克隆仓库必须落到项目目录：git clone <url> ${projects}/<项目名>`,
    `不要把代码、数据或定时任务产物堆在 ${root} 根下。`,
    `约定目录：${projects}/<名>/（项目）、${root}/${AGENT_DATA_DIR}/（输入）、${root}/${AGENT_OUTPUTS_DIR}/（交付）、${root}/${AGENT_UPLOADS_DIR}/（上传）、${root}/${AGENT_SKILLS_DIR}/（技能）。`,
  ].join("\n");
}

export function currentProjectPromptBlock(slug: string | null | undefined): string {
  if (!slug || !isValidProjectSlug(slug)) {
    return [
      "# 当前项目",
      "本会话未绑定项目。写代码或克隆仓库时先在 projects/<名>/ 下建目录再干活，或请用户从侧栏选一个项目。",
    ].join("\n");
  }
  const cwd = projectWorkspacePath(slug);
  return [
    "# 当前项目",
    `本会话绑定项目 \`${slug}\`，默认工作目录：${cwd}`,
    "文件操作、shell、定时任务产物都放在这个目录内。需要跨项目时用绝对路径，不要把文件写到工作区根。",
    "项目指令：根目录 AGENTS.md（或 CLAUDE.md）。项目技能：`.agents/skills/<名>/SKILL.md` 或 `.claude/skills/`。Hooks：`.agents/hooks.json`（也读 `.claude/hooks.json` / `.claude/settings.json`）。",
    "安装技能默认写入本项目 `.agents/skills/`；只有用户明确要求全局/所有项目共用时才用 scope=agent 写到 /skills/。",
  ].join("\n");
}
