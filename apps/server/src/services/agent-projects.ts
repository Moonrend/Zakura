/**
 * Agent 项目记录：对话分组与说明。工作区目录可选。
 */
import { and, eq } from "drizzle-orm";
import {
  AGENT_PROJECTS_DIR,
  isValidProjectSlug,
  projectSlugsFromList,
  projectWorkspacePath,
} from "@zakura/shared";
import type { WorkspaceFs } from "@zakura/core";
import type { Db } from "../db/client.js";
import { agentProjects, newId, type AgentProjectRow } from "../db/schema.js";

export type AgentProjectDto = {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  hasWorkspace: boolean;
  path: string | null;
};

export function toProjectDto(row: AgentProjectRow): AgentProjectDto {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    hasWorkspace: row.hasWorkspace,
    path: row.hasWorkspace ? projectWorkspacePath(row.slug) : null,
  };
}

/** DB 说明与目录 AGENTS.md 叠加；都空则不注入 */
export function mergeProjectInstructions(
  dbInstructions: string,
  fsInstructions?: string,
): string | undefined {
  const db = dbInstructions.trim();
  const fs = fsInstructions?.trim();
  const parts = [db ? `# 项目说明\n${db}` : "", fs ?? ""].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

export async function getAgentProject(
  db: Db,
  agentId: string,
  slug: string,
): Promise<AgentProjectRow | null> {
  const [row] = await db
    .select()
    .from(agentProjects)
    .where(and(eq(agentProjects.agentId, agentId), eq(agentProjects.slug, slug)))
    .limit(1);
  return row ?? null;
}

export async function listAgentProjectRows(db: Db, agentId: string): Promise<AgentProjectRow[]> {
  return db.select().from(agentProjects).where(eq(agentProjects.agentId, agentId));
}

export async function upsertAgentProject(
  db: Db,
  input: {
    tenantId: string;
    agentId: string;
    slug: string;
    name?: string;
    description?: string;
    instructions?: string;
    hasWorkspace?: boolean;
  },
): Promise<AgentProjectRow> {
  const existing = await getAgentProject(db, input.agentId, input.slug);
  const now = new Date();
  if (existing) {
    const [row] = await db
      .update(agentProjects)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.hasWorkspace !== undefined ? { hasWorkspace: input.hasWorkspace } : {}),
        updatedAt: now,
      })
      .where(eq(agentProjects.id, existing.id))
      .returning();
    return row ?? existing;
  }
  const [row] = await db
    .insert(agentProjects)
    .values({
      id: newId(),
      tenantId: input.tenantId,
      agentId: input.agentId,
      slug: input.slug,
      name: input.name ?? input.slug,
      description: input.description ?? "",
      instructions: input.instructions ?? "",
      hasWorkspace: input.hasWorkspace ?? false,
    })
    .returning();
  if (!row) throw new Error("创建项目失败");
  return row;
}

export async function renameAgentProjectRow(
  db: Db,
  agentId: string,
  from: string,
  to: string,
): Promise<AgentProjectRow | null> {
  const existing = await getAgentProject(db, agentId, from);
  if (!existing) return null;
  const now = new Date();
  const [row] = await db
    .update(agentProjects)
    .set({ slug: to, name: existing.name === from ? to : existing.name, updatedAt: now })
    .where(eq(agentProjects.id, existing.id))
    .returning();
  return row ?? null;
}

export async function deleteAgentProjectRow(db: Db, agentId: string, slug: string): Promise<boolean> {
  const existing = await getAgentProject(db, agentId, slug);
  if (!existing) return false;
  await db.delete(agentProjects).where(eq(agentProjects.id, existing.id));
  return true;
}

/** 把工作区里已有目录补进记录，并把 hasWorkspace 与实盘对齐 */
export async function syncProjectsFromWorkspace(
  db: Db,
  tenantId: string,
  agentId: string,
  slugs: string[],
): Promise<void> {
  const rows = await listAgentProjectRows(db, agentId);
  const have = new Set(rows.map((r) => r.slug));
  const disk = new Set(slugs);
  for (const slug of slugs) {
    if (!isValidProjectSlug(slug)) continue;
    if (!have.has(slug)) {
      await upsertAgentProject(db, {
        tenantId,
        agentId,
        slug,
        hasWorkspace: true,
      });
    } else {
      const row = rows.find((r) => r.slug === slug);
      if (row && !row.hasWorkspace) {
        await upsertAgentProject(db, { tenantId, agentId, slug, hasWorkspace: true });
      }
    }
  }
  for (const row of rows) {
    if (row.hasWorkspace && !disk.has(row.slug)) {
      await upsertAgentProject(db, {
        tenantId,
        agentId,
        slug: row.slug,
        hasWorkspace: false,
      });
    }
  }
}

export async function listWorkspaceSlugs(fs: WorkspaceFs): Promise<string[]> {
  if (!(await fs.exists(AGENT_PROJECTS_DIR))) return [];
  const listed = await fs.list(AGENT_PROJECTS_DIR);
  return projectSlugsFromList(listed.entries);
}
