import { and, asc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { agents, cloudAgentSessions, newId, spaces, type Space } from "../db/schema.js";

const GRAPH_MESSAGE_WINDOW_DAYS = 30;

export type SpaceGraphNode = {
  id: string;
  name: string;
  description: string;
  spaceId: string;
  status: "running" | "stopped";
};

export type SpaceGraphEdge = {
  type: "group" | "message";
  a: string;
  b: string;
};

export type SpaceGraph = {
  nodes: SpaceGraphNode[];
  edges: SpaceGraphEdge[];
};

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
    patch: {
      name?: string;
      description?: string;
      enableComputer?: boolean;
      workspaceImage?: string | null;
      runtimeNodeId?: string | null;
      workspaceKind?: "host" | "container";
      workspaceStatus?: string;
      workspaceRevision?: string | null;
      lastMigrationId?: string | null;
      lastError?: string | null;
      configJson?: string;
    },
  ): Promise<Space | null> {
    const space = await this.get(tenantId, id);
    if (!space) return null;
    const [row] = await this.db
      .update(spaces)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
        ...(patch.enableComputer !== undefined ? { enableComputer: patch.enableComputer } : {}),
        ...(patch.workspaceImage !== undefined ? { workspaceImage: patch.workspaceImage } : {}),
        ...(patch.runtimeNodeId !== undefined ? { runtimeNodeId: patch.runtimeNodeId } : {}),
        ...(patch.workspaceKind !== undefined ? { workspaceKind: patch.workspaceKind } : {}),
        ...(patch.workspaceStatus !== undefined ? { workspaceStatus: patch.workspaceStatus } : {}),
        ...(patch.workspaceRevision !== undefined ? { workspaceRevision: patch.workspaceRevision } : {}),
        ...(patch.lastMigrationId !== undefined ? { lastMigrationId: patch.lastMigrationId } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch.configJson !== undefined ? { configJson: patch.configJson } : {}),
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

  async graph(tenantId: string, idOrSlug: string): Promise<SpaceGraph | null> {
    const space = await this.get(tenantId, idOrSlug);
    if (!space) return null;

    const rows = await this.db
      .select({
        id: agents.id,
        name: agents.name,
        description: agents.description,
      })
      .from(agents)
      .where(and(eq(agents.tenantId, tenantId), eq(agents.spaceId, space.id)))
      .orderBy(asc(agents.createdAt));

    const agentIds = rows.map((row) => row.id);
    if (agentIds.length === 0) return { nodes: [], edges: [] };

    const runningRows = await this.db
      .select({ agentId: cloudAgentSessions.agentId })
      .from(cloudAgentSessions)
      .where(
        and(
          eq(cloudAgentSessions.tenantId, tenantId),
          isNotNull(cloudAgentSessions.activeRunId),
          inArray(cloudAgentSessions.agentId, agentIds),
        ),
      );
    const running = new Set(runningRows.map((row) => row.agentId));
    const nodes: SpaceGraphNode[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      spaceId: space.id,
      status: running.has(row.id) ? "running" : "stopped",
    }));

    const edges: SpaceGraphEdge[] = [];
    const seen = new Set<string>();
    const addEdge = (type: SpaceGraphEdge["type"], a: string, b: string) => {
      if (a === b) return;
      const [x, y] = a < b ? [a, b] : [b, a];
      const key = `${type}:${x}:${y}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ type, a: x, b: y });
    };

    const since = new Date(Date.now() - GRAPH_MESSAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const sessions = await this.db
      .select({
        agentId: cloudAgentSessions.agentId,
        originJson: cloudAgentSessions.originJson,
      })
      .from(cloudAgentSessions)
      .where(
        and(
          eq(cloudAgentSessions.tenantId, tenantId),
          inArray(cloudAgentSessions.agentId, agentIds),
          gte(cloudAgentSessions.createdAt, since),
        ),
      );
    const inSpace = new Set(agentIds);
    for (const row of sessions) {
      let caller: string | undefined;
      try {
        const origin = JSON.parse(row.originJson || "{}") as { callerAgentId?: unknown };
        caller = typeof origin.callerAgentId === "string" ? origin.callerAgentId : undefined;
      } catch {
        caller = undefined;
      }
      if (!caller || caller === row.agentId || !inSpace.has(caller)) continue;
      addEdge("message", caller, row.agentId);
    }

    const projectRows = await this.db
      .selectDistinct({
        agentId: cloudAgentSessions.agentId,
        project: cloudAgentSessions.project,
      })
      .from(cloudAgentSessions)
      .where(
        and(
          eq(cloudAgentSessions.tenantId, tenantId),
          inArray(cloudAgentSessions.agentId, agentIds),
          isNotNull(cloudAgentSessions.project),
        ),
      );
    const byProject = new Map<string, string[]>();
    for (const row of projectRows) {
      if (!row.project) continue;
      const members = byProject.get(row.project) ?? [];
      members.push(row.agentId);
      byProject.set(row.project, members);
    }
    for (const members of byProject.values()) {
      const unique = [...new Set(members)];
      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          addEdge("group", unique[i]!, unique[j]!);
        }
      }
    }

    return { nodes, edges };
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
