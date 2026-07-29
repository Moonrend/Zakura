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
  SKILL_MANIFEST_FILE,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  type AgentSkillRecord,
  type SkillFile,
  type SkillPackage,
  type SkillRecord,
  type SkillResolveResult,
  type SkillSource,
} from "@zakura/shared";
import type { Db } from "../../db/client.js";
import {
  agentSkills,
  newId,
  skills,
  type Agent,
  type AgentSkillRow,
  type SkillRow,
} from "../../db/schema.js";
import type { AgentService } from "../agents.js";
import type { ServerWorkspaceFsProvider } from "../workspace-fs-provider.js";
import { platformEvents } from "../platform-events.js";
import { BUILTIN_SKILLS, builtinToPackage, getBuiltinSkill } from "./builtin.js";
import { fetchSkillPackages } from "./fetch.js";
import {
  SkillSourceError,
  normalizeSkillName,
  parseSkillMarkdown,
  parseSkillSource,
  toSkillFrontmatter,
} from "./source.js";

export { SkillSourceError };

/** 工作区内技能根目录（带前导斜杠，WorkspaceFs 视其为工作区相对路径） */
export const SKILLS_ROOT = `/${AGENT_SKILLS_DIR}`;

export function skillWorkspacePath(name: string): string {
  return `${SKILLS_ROOT}/${name}`;
}

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

function toRecord(row: SkillRow, agentIds: string[]): SkillRecord {
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
  /** GitHub PAT，提升抓取限额 */
  githubToken?: string | undefined;
}

export class SkillsService {
  private readonly db: Db;
  private readonly agentService: AgentService;
  private readonly fsProvider: ServerWorkspaceFsProvider;
  private readonly githubToken: string | undefined;
  /** 已同步过内置技能的租户，避免每次请求重复写库 */
  private readonly builtinSynced = new Set<string>();

  constructor(deps: SkillsServiceDeps) {
    this.db = deps.db;
    this.agentService = deps.agentService;
    this.fsProvider = deps.fsProvider;
    this.githubToken = deps.githubToken ?? process.env.GITHUB_TOKEN ?? undefined;
  }

  // —— 注册表 ——

  /** 把内置技能同步进租户注册表（幂等；内容变更时按 body 更新） */
  async syncBuiltins(tenantId: string): Promise<void> {
    if (this.builtinSynced.has(tenantId)) return;
    try {
      const existing = await this.db
        .select()
        .from(skills)
        .where(and(eq(skills.tenantId, tenantId), eq(skills.builtin, true)));
      const byName = new Map(existing.map((r) => [r.name, r]));

      for (const def of BUILTIN_SKILLS) {
        const pkg = builtinToPackage(def);
        const row = byName.get(pkg.name);
        if (!row) {
          await this.upsertPackage(tenantId, pkg, true);
          continue;
        }
        const manifest = pkg.files.find((f) => f.path === SKILL_MANIFEST_FILE)?.content ?? "";
        const currentManifest =
          parseFiles(row.filesJson).find((f) => f.path === SKILL_MANIFEST_FILE)?.content ?? "";
        if (manifest !== currentManifest) {
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
    return rows.map((row) => toRecord(row, bySkill.get(row.id) ?? []));
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
      updatedAt: now,
    };

    const existing = await this.db.query.skills.findFirst({
      where: and(eq(skills.tenantId, tenantId), eq(skills.name, pkg.name)),
    });
    if (existing) {
      await this.db.update(skills).set(values).where(eq(skills.id, existing.id));
      return { ...existing, ...values, createdAt: existing.createdAt };
    }
    const id = newId();
    const row = { id, ...values, createdAt: now };
    await this.db.insert(skills).values(row);
    return row as SkillRow;
  }

  // —— 解析与预览 ——

  /** 解析来源并抓取内容，但不落库；用于安装前预览 */
  async resolve(tenantId: string, input: string): Promise<SkillResolveResult> {
    const source = parseSkillSource(input);
    // 预览只需要 SKILL.md：一个几十技能的仓库不必先拉几百个捆绑文件
    const { packages, warnings } = await this.loadPackages(source, { manifestOnly: true });
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
    opts: { manifestOnly?: boolean } = {},
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
    return fetchSkillPackages(source, {
      githubToken: this.githubToken,
      ...(opts.manifestOnly ? { manifestOnly: true } : {}),
    });
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
      const loaded = await this.loadPackages(scoped);
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
    try {
      const list = await this.listForAgent(tenantId, agentId);
      const active = list.filter((s) => s.enabled && s.status === "installed");
      if (!active.length) return "";
      return active
        .map((s) => `- ${s.name}（${s.path}/${SKILL_MANIFEST_FILE}）：${s.description}`)
        .join("\n");
    } catch (err) {
      console.warn("[skills] promptSummary:", err instanceof Error ? err.message : err);
      return "";
    }
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
    const rel = (relPath ?? SKILL_MANIFEST_FILE).replace(/^\/+/, "");
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
