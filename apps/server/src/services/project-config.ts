/**
 * 项目级配置：AGENTS.md / CLAUDE.md、hooks、项目技能。
 * 文件系统为真相源，不写数据库。
 */
import type { WorkspaceFs } from "@zakura/core";
import {
  isValidProjectSlug,
  parseHooksJson,
  projectRelativePath,
  projectWorkspacePath,
  PROJECT_CLAUDE_SETTINGS_FILE,
  PROJECT_HOOKS_FILES,
  PROJECT_HOOKS_WRITE_FILE,
  PROJECT_INSTRUCTION_FILES,
  PROJECT_SKILL_DIRS,
  PROJECT_SKILLS_WRITE_DIR,
  type AgentHookPackage,
  type AgentHooksByEvent,
} from "@zakura/shared";
import { buildSkillMarkdown, normalizeSkillName, parseSkillMarkdown, toSkillFrontmatter } from "./skills/source.js";

const INSTRUCTION_MAX = 16_000;
const SKILL_DESC_MAX = 240;

export type ProjectInstructionFile = (typeof PROJECT_INSTRUCTION_FILES)[number];

export type ProjectSkillMeta = {
  name: string;
  path: string;
  description: string;
  title: string;
};

export type ProjectHooksSource = {
  file: string;
  events: AgentHooksByEvent;
};

export type ProjectConfigSnapshot = {
  slug: string;
  exists: boolean;
  instructions: {
    file: ProjectInstructionFile | null;
    content: string;
    claudeFallback: boolean;
  };
  skills: ProjectSkillMeta[];
  hooks: {
    file: string | null;
    events: AgentHooksByEvent;
    sources: ProjectHooksSource[];
  };
};

export type LoadedProjectContext = {
  instructions?: string;
  skillsSummary: string;
  skills: ProjectSkillMeta[];
  hookPackages: AgentHookPackage[];
};

async function readOptionalText(fs: WorkspaceFs, rel: string): Promise<string | null> {
  try {
    if (!(await fs.exists(rel))) return null;
    const read = await fs.readText(rel);
    return read.content;
  } catch {
    return null;
  }
}

function joinRel(base: string, child: string): string {
  return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

export async function loadProjectInstructionsText(
  fs: WorkspaceFs,
  slug: string,
): Promise<{ file: ProjectInstructionFile; text: string } | null> {
  const base = projectRelativePath(slug);
  for (const file of PROJECT_INSTRUCTION_FILES) {
    const raw = await readOptionalText(fs, joinRel(base, file));
    const text = raw?.trim();
    if (!text) continue;
    const clipped = text.length > INSTRUCTION_MAX ? `${text.slice(0, INSTRUCTION_MAX)}\n…(truncated)` : text;
    return { file, text: clipped };
  }
  return null;
}

export async function listProjectSkills(fs: WorkspaceFs, slug: string): Promise<ProjectSkillMeta[]> {
  const base = projectRelativePath(slug);
  const out: ProjectSkillMeta[] = [];
  const seen = new Set<string>();
  for (const dir of PROJECT_SKILL_DIRS) {
    const root = joinRel(base, dir);
    let listed: { entries: Array<{ name: string; type?: string }> };
    try {
      if (!(await fs.exists(root))) continue;
      listed = await fs.list(root);
    } catch {
      continue;
    }
    for (const entry of listed.entries) {
      if (entry.type && entry.type !== "dir") continue;
      const dirName = entry.name.replace(/\\/g, "/").split("/").pop() ?? "";
      if (!dirName || dirName.startsWith(".")) continue;
      const manifest = joinRel(root, `${dirName}/SKILL.md`);
      const raw = await readOptionalText(fs, manifest);
      if (!raw) continue;
      const { frontmatter: rawFm } = parseSkillMarkdown(raw);
      const fm = toSkillFrontmatter(rawFm, dirName);
      const name = normalizeSkillName(fm.name || dirName);
      if (seen.has(name)) continue;
      seen.add(name);
      const title =
        typeof rawFm.title === "string" && rawFm.title.trim() ? rawFm.title.trim() : name;
      out.push({
        name,
        path: `/${manifest}`,
        description: (fm.description || "").slice(0, SKILL_DESC_MAX),
        title,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function parseHooksContent(raw: string): AgentHooksByEvent {
  try {
    return parseHooksJson(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

function hooksNonEmpty(events: AgentHooksByEvent): boolean {
  return Object.values(events).some((g) => (g?.length ?? 0) > 0);
}

export async function loadProjectHooks(
  fs: WorkspaceFs,
  slug: string,
): Promise<{ file: string | null; sources: ProjectHooksSource[] }> {
  const base = projectRelativePath(slug);
  const sources: ProjectHooksSource[] = [];
  for (const file of PROJECT_HOOKS_FILES) {
    const raw = await readOptionalText(fs, joinRel(base, file));
    if (!raw?.trim()) continue;
    const events = parseHooksContent(raw);
    if (!hooksNonEmpty(events)) continue;
    sources.push({ file, events });
  }
  const settingsRaw = await readOptionalText(fs, joinRel(base, PROJECT_CLAUDE_SETTINGS_FILE));
  if (settingsRaw?.trim()) {
    const events = parseHooksContent(settingsRaw);
    if (hooksNonEmpty(events)) {
      sources.push({ file: PROJECT_CLAUDE_SETTINGS_FILE, events });
    }
  }
  return { file: sources[0]?.file ?? null, sources };
}

export function mergeHookEvents(sources: ProjectHooksSource[]): AgentHooksByEvent {
  const out: AgentHooksByEvent = {};
  for (const src of sources) {
    for (const [event, groups] of Object.entries(src.events)) {
      if (!groups?.length) continue;
      const key = event as keyof AgentHooksByEvent;
      out[key] = [...(out[key] ?? []), ...groups];
    }
  }
  return out;
}

export function hookPackagesFromSources(slug: string, sources: ProjectHooksSource[]): AgentHookPackage[] {
  const projectDir = `/workspace/projects/${slug}`;
  return sources.map((src) => ({
    id: `project:${slug}:${src.file}`,
    name: `${slug} ${src.file}`,
    source: `project:${src.file}`,
    enabled: true,
    events: src.events,
    pluginRoot: projectDir,
  }));
}

export async function loadProjectConfig(fs: WorkspaceFs, slug: string): Promise<ProjectConfigSnapshot> {
  const base = projectRelativePath(slug);
  const exists = await fs.exists(base);
  if (!exists) {
    return {
      slug,
      exists: false,
      instructions: { file: null, content: "", claudeFallback: false },
      skills: [],
      hooks: { file: null, events: {}, sources: [] },
    };
  }
  const agentsRaw = await readOptionalText(fs, joinRel(base, "AGENTS.md"));
  const claudeRaw = await readOptionalText(fs, joinRel(base, "CLAUDE.md"));
  const hasAgents = Boolean(agentsRaw?.trim());
  const hasClaude = Boolean(claudeRaw?.trim());
  const instructions = hasAgents
    ? { file: "AGENTS.md" as const, content: agentsRaw ?? "", claudeFallback: false }
    : hasClaude
      ? { file: "CLAUDE.md" as const, content: claudeRaw ?? "", claudeFallback: true }
      : { file: null, content: "", claudeFallback: false };
  const skills = await listProjectSkills(fs, slug);
  const hooksLoaded = await loadProjectHooks(fs, slug);
  return {
    slug,
    exists: true,
    instructions,
    skills,
    hooks: {
      file: hooksLoaded.file,
      events: mergeHookEvents(hooksLoaded.sources),
      sources: hooksLoaded.sources,
    },
  };
}

export async function loadProjectContext(fs: WorkspaceFs, slug: string): Promise<LoadedProjectContext> {
  const inst = await loadProjectInstructionsText(fs, slug);
  const skills = await listProjectSkills(fs, slug);
  const hooks = await loadProjectHooks(fs, slug);
  const skillsSummary = skills
    .map((s) => `- ${s.name}（${s.path}）：${s.description || "（无描述）"}`)
    .join("\n");
  return {
    instructions: inst
      ? `# 项目指令（${inst.file}）\n${inst.text}`
      : undefined,
    skillsSummary,
    skills,
    hookPackages: hookPackagesFromSources(slug, hooks.sources),
  };
}

export async function saveProjectInstructions(
  fs: WorkspaceFs,
  slug: string,
  content: string,
  file: ProjectInstructionFile = "AGENTS.md",
): Promise<{ file: ProjectInstructionFile; path: string }> {
  const rel = joinRel(projectRelativePath(slug), file);
  await fs.write(rel, content);
  return { file, path: `/${rel}` };
}

export async function saveProjectHooks(
  fs: WorkspaceFs,
  slug: string,
  events: AgentHooksByEvent,
  file?: string | null,
): Promise<{ file: string; path: string }> {
  const base = projectRelativePath(slug);
  const target =
    file && (PROJECT_HOOKS_FILES as readonly string[]).includes(file)
      ? file
      : file === PROJECT_CLAUDE_SETTINGS_FILE
        ? PROJECT_CLAUDE_SETTINGS_FILE
        : PROJECT_HOOKS_WRITE_FILE;
  const rel = joinRel(base, target);
  if (target === PROJECT_CLAUDE_SETTINGS_FILE) {
    let existing: Record<string, unknown> = {};
    const raw = await readOptionalText(fs, rel);
    if (raw?.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        existing = {};
      }
    }
    existing.hooks = events;
    await fs.write(rel, `${JSON.stringify(existing, null, 2)}\n`);
  } else {
    await fs.write(rel, `${JSON.stringify({ hooks: events }, null, 2)}\n`);
  }
  return { file: target, path: `/${rel}` };
}

export async function createProjectSkill(
  fs: WorkspaceFs,
  slug: string,
  input: { name: string; description: string; body?: string },
): Promise<ProjectSkillMeta> {
  const name = normalizeSkillName(input.name);
  if (name === "skill" && !input.name.trim()) {
    throw Object.assign(new Error("技能名无效"), { status: 400 });
  }
  const existing = await listProjectSkills(fs, slug);
  if (existing.some((s) => s.name === name)) {
    throw Object.assign(new Error("技能已存在"), { status: 409 });
  }
  const dir = joinRel(projectRelativePath(slug), `${PROJECT_SKILLS_WRITE_DIR}/${name}`);
  await fs.mkdir(dir);
  const desc = input.description.trim() || "项目级技能";
  const body =
    input.body?.trim() ||
    `# ${name}\n\n在当前项目内使用。用 \`re_read_skill\` 读取本文件后按步骤执行。\n`;
  const content = buildSkillMarkdown({ name, description: desc }, body);
  const manifest = joinRel(dir, "SKILL.md");
  await fs.write(manifest, content);
  return {
    name,
    path: `/${manifest}`,
    description: desc.slice(0, SKILL_DESC_MAX),
    title: name,
  };
}

export async function saveProjectSkillFile(
  fs: WorkspaceFs,
  slug: string,
  name: string,
  content: string,
): Promise<{ path: string }> {
  const meta = (await listProjectSkills(fs, slug)).find((s) => s.name === normalizeSkillName(name));
  const rel = meta
    ? meta.path.replace(/^\//, "")
    : joinRel(projectRelativePath(slug), `${PROJECT_SKILLS_WRITE_DIR}/${normalizeSkillName(name)}/SKILL.md`);
  await fs.write(rel, content);
  return { path: `/${rel}` };
}

export async function readProjectSkillFile(
  fs: WorkspaceFs,
  slug: string,
  name: string,
  relPath?: string,
): Promise<{ path: string; content: string } | null> {
  const normalized = normalizeSkillName(name);
  const meta = (await listProjectSkills(fs, slug)).find((s) => s.name === normalized);
  if (!meta) return null;
  const dir = meta.path.replace(/^\//, "").replace(/\/SKILL\.md$/i, "");
  const file = (relPath ?? "SKILL.md").replace(/\\/g, "/").replace(/^\/+/, "");
  if (file.includes("..")) return null;
  const rel = joinRel(dir, file);
  const raw = await readOptionalText(fs, rel);
  if (raw == null) return null;
  return { path: `/${rel}`, content: raw };
}

export async function deleteProjectSkill(fs: WorkspaceFs, slug: string, name: string): Promise<boolean> {
  const meta = (await listProjectSkills(fs, slug)).find((s) => s.name === normalizeSkillName(name));
  if (!meta) return false;
  const dir = meta.path.replace(/^\//, "").replace(/\/SKILL\.md$/i, "");
  await fs.delete(dir, true);
  return true;
}

export class ProjectFsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "ProjectFsError";
  }
}

/** 真实改名 `projects/<from>` → `projects/<to>`。 */
export async function renameProject(
  fs: WorkspaceFs,
  from: string,
  to: string,
): Promise<{ name: string; path: string }> {
  if (!isValidProjectSlug(from) || !isValidProjectSlug(to)) {
    throw new ProjectFsError("无效的项目名（字母数字开头，可含 . _ -）", 400);
  }
  if (from === to) return { name: to, path: projectWorkspacePath(to) };
  const src = projectRelativePath(from);
  const dest = projectRelativePath(to);
  if (!(await fs.exists(src))) throw new ProjectFsError("项目不存在", 404);
  if (await fs.exists(dest)) throw new ProjectFsError("目标项目已存在", 409);
  await fs.move(src, dest);
  return { name: to, path: projectWorkspacePath(to) };
}

/** 递归删除 `projects/<slug>`。目录不存在返回 false。 */
export async function deleteProject(fs: WorkspaceFs, slug: string): Promise<boolean> {
  if (!isValidProjectSlug(slug)) throw new ProjectFsError("无效的项目名", 400);
  const rel = projectRelativePath(slug);
  if (!(await fs.exists(rel))) return false;
  await fs.delete(rel, true);
  return true;
}
