import { and, asc, eq } from "drizzle-orm";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { newId, spaces, type Space } from "../db/schema.js";

/** 回填默认空间时使用的确定性 id 前缀（与 0062 迁移一致） */
export const DEFAULT_SPACE_SLUG = "default";

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || `space-${Date.now().toString(36)}`
  );
}

export function spaceWorkspaceHostPath(config: AppConfig, spaceId: string): string {
  return join(config.dataDir, "spaces", spaceId, "workspace");
}

export class SpaceService {
  constructor(private readonly db: Db, private readonly config: AppConfig) {}

  async list(tenantId: string): Promise<Space[]> {
    return this.db
      .select()
      .from(spaces)
      .where(eq(spaces.tenantId, tenantId))
      .orderBy(asc(spaces.createdAt));
  }

  async get(tenantId: string, idOrSlug: string): Promise<Space | null> {
    const byId = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.tenantId, tenantId), eq(spaces.id, idOrSlug)),
    });
    if (byId) return byId;
    return (
      (await this.db.query.spaces.findFirst({
        where: and(eq(spaces.tenantId, tenantId), eq(spaces.slug, idOrSlug)),
      })) ?? null
    );
  }

  /** 租户默认空间；不存在则创建（幂等）。 */
  async ensureDefault(tenantId: string): Promise<Space> {
    const existing = await this.get(tenantId, DEFAULT_SPACE_SLUG);
    if (existing) return existing;
    const [row] = await this.db
      .insert(spaces)
      .values({
        id: `spc_default_${tenantId}`,
        tenantId,
        name: "默认空间",
        slug: DEFAULT_SPACE_SLUG,
        description: "",
        workspaceKind: "container",
        workspaceStatus: "ready",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const fallback = await this.get(tenantId, DEFAULT_SPACE_SLUG);
    if (!fallback) throw new Error("默认空间创建失败");
    return fallback;
  }

  async create(
    tenantId: string,
    input: { name: string; description?: string; workspaceImage?: string | null },
  ): Promise<Space> {
    if (!input.name?.trim()) throw new Error("name required");
    let slug = slugify(input.name);
    for (let i = 0; i < 20; i++) {
      const candidate = i === 0 ? slug : `${slug.slice(0, 40)}-${i + 1}`;
      const existing = await this.db.query.spaces.findFirst({
        where: and(eq(spaces.tenantId, tenantId), eq(spaces.slug, candidate)),
      });
      if (!existing) {
        slug = candidate;
        break;
      }
      if (i === 19) throw new Error(`Space slug already exists: ${slug}`);
    }
    const now = new Date();
    const [row] = await this.db
      .insert(spaces)
      .values({
        id: newId(),
        tenantId,
        name: input.name.trim(),
        slug,
        description: input.description?.trim() ?? "",
        workspaceImage: input.workspaceImage ?? null,
        workspaceKind: "container",
        workspaceStatus: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  }

  async update(
    tenantId: string,
    id: string,
    patch: { name?: string; description?: string; workspaceImage?: string | null },
  ): Promise<Space | null> {
    const space = await this.get(tenantId, id);
    if (!space) return null;
    const [row] = await this.db
      .update(spaces)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
        ...(patch.workspaceImage !== undefined ? { workspaceImage: patch.workspaceImage } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, space.id)))
      .returning();
    return row ?? null;
  }

  /** 删除 space（级联删除其下 agent）。默认空间不可删除。 */
  async delete(tenantId: string, id: string): Promise<boolean> {
    const space = await this.get(tenantId, id);
    if (!space) return false;
    if (space.slug === DEFAULT_SPACE_SLUG) {
      throw new Error("默认空间不可删除");
    }
    await this.db
      .delete(spaces)
      .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, space.id)));
    return true;
  }

  serialize(space: Space, extra?: { agentCount?: number }) {
    return {
      id: space.id,
      tenantId: space.tenantId,
      name: space.name,
      slug: space.slug,
      description: space.description,
      workspaceImage: space.workspaceImage,
      runtimeNodeId: space.runtimeNodeId ?? null,
      workspaceKind: space.workspaceKind,
      workspaceStatus: space.workspaceStatus,
      workspaceRevision: space.workspaceRevision ?? null,
      workspaceHostPath: spaceWorkspaceHostPath(this.config, space.id),
      isDefault: space.slug === DEFAULT_SPACE_SLUG,
      agentCount: extra?.agentCount ?? 0,
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
    };
  }
}
