/**
 * Space 项目记录：对话分组与说明。工作区目录可选。
 * 项目归 Space 所有，空间内成员 Agent 共享。
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
import { newId, spaceProjects, type SpaceProjectRow } from "../db/schema.js";

export type AgentProjectDto = {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  hasWorkspace: boolean;
  path: string | null;
};

export function toProjectDto(row: SpaceProjectRow): AgentProjectDto {
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

export async function getSpaceProject(
  db: Db,
  spaceId: string,
  slug: string,
): Promise<SpaceProjectRow | null> {
  const [row] = await db
    .select()
    .from(spaceProjects)
    .where(and(eq(spaceProjects.spaceId, spaceId), eq(spaceProjects.slug, slug)))
    .limit(1);
  return row ?? null;
}

export async function listSpaceProjectRows(db: Db, spaceId: string): Promise<SpaceProjectRow[]> {
  return db.select().from(spaceProjects).where(eq(spaceProjects.spaceId, spaceId));
}

export async function upsertSpaceProject(
  db: Db,
  input: {
    tenantId: string;
    spaceId: string;
    slug: string;
    name?: string;
    description?: string;
    instructions?: string;
    hasWorkspace?: boolean;
  },
): Promise<SpaceProjectRow> {
  const existing = await getSpaceProject(db, input.spaceId, input.slug);
  const now = new Date();
  if (existing) {
    const [row] = await db
      .update(spaceProjects)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.hasWorkspace !== undefined ? { hasWorkspace: input.hasWorkspace } : {}),
        updatedAt: now,
      })
      .where(eq(spaceProjects.id, existing.id))
      .returning();
    return row ?? existing;
  }
  const [row] = await db
    .insert(spaceProjects)
    .values({
      id: newId(),
      tenantId: input.tenantId,
      spaceId: input.spaceId,
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

export async function renameSpaceProjectRow(
  db: Db,
  spaceId: string,
  from: string,
  to: string,
): Promise<SpaceProjectRow | null> {
  const existing = await getSpaceProject(db, spaceId, from);
  if (!existing) return null;
  const now = new Date();
  const [row] = await db
    .update(spaceProjects)
    .set({ slug: to, name: existing.name === from ? to : existing.name, updatedAt: now })
    .where(eq(spaceProjects.id, existing.id))
    .returning();
  return row ?? null;
}

export async function deleteSpaceProjectRow(db: Db, spaceId: string, slug: string): Promise<boolean> {
  const existing = await getSpaceProject(db, spaceId, slug);
  if (!existing) return false;
  await db.delete(spaceProjects).where(eq(spaceProjects.id, existing.id));
  return true;
}

/** 把工作区里已有目录补进记录，并把 hasWorkspace 与实盘对齐 */
export async function syncProjectsFromWorkspace(
  db: Db,
  tenantId: string,
  spaceId: string,
  slugs: string[],
): Promise<void> {
  const rows = await listSpaceProjectRows(db, spaceId);
  const have = new Set(rows.map((r) => r.slug));
  const disk = new Set(slugs);
  for (const slug of slugs) {
    if (!isValidProjectSlug(slug)) continue;
    if (!have.has(slug)) {
      await upsertSpaceProject(db, {
        tenantId,
        spaceId,
        slug,
        hasWorkspace: true,
      });
    } else {
      const row = rows.find((r) => r.slug === slug);
      if (row && !row.hasWorkspace) {
        await upsertSpaceProject(db, { tenantId, spaceId, slug, hasWorkspace: true });
      }
    }
  }
  for (const row of rows) {
    if (row.hasWorkspace && !disk.has(row.slug)) {
      await upsertSpaceProject(db, {
        tenantId,
        spaceId,
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
