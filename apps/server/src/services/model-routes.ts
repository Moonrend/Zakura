import { and, asc, eq } from "drizzle-orm";
import {
  MODEL_CAPABILITIES,
  MODEL_CAPABILITY_META,
  type ModelCapability,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import { modelRoutes, newId, type ModelRoute } from "../db/schema.js";
import { parseJsonRecord, parseRouteOptions } from "../model-router/types.js";
import { serializeUpstream, type ModelUpstreamsService } from "./model-upstreams.js";

export function isModelCapability(v: string): v is ModelCapability {
  return (MODEL_CAPABILITIES as readonly string[]).includes(v);
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "route";
}

export function serializeRoute(row: ModelRoute, upstream?: ReturnType<typeof serializeUpstream>) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    slug: row.slug,
    capability: row.capability as ModelCapability,
    alias: row.alias?.trim() || row.model,
    upstreamId: row.upstreamId,
    model: row.model,
    options: parseRouteOptions(parseJsonRecord(row.optionsJson)),
    priority: Number(row.priority) || 100,
    weight: Number(row.weight) || 100,
    isDefault: row.isDefault,
    status: row.status,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    upstream,
    meta: MODEL_CAPABILITY_META[row.capability as ModelCapability] ?? {
      name: row.capability,
      description: "",
    },
  };
}

export type ModelRouteInput = {
  name: string;
  slug?: string;
  capability: ModelCapability;
  upstreamId: string;
  model: string;
  /** 逻辑别名；多供应商同模型时共用，按 weight 随机 */
  alias?: string;
  options?: Record<string, unknown>;
  priority?: number;
  weight?: number;
  isDefault?: boolean;
};

export class ModelRoutesService {
  constructor(
    private readonly db: Db,
    private readonly upstreams: ModelUpstreamsService,
    private readonly onMutate?: (tenantId: string) => void,
  ) {}

  meta() {
    return MODEL_CAPABILITIES.map((capability) => ({
      capability,
      ...MODEL_CAPABILITY_META[capability],
    }));
  }

  async list(tenantId: string, capability?: ModelCapability) {
    const rows = await this.db
      .select()
      .from(modelRoutes)
      .where(
        capability
          ? and(eq(modelRoutes.tenantId, tenantId), eq(modelRoutes.capability, capability))
          : eq(modelRoutes.tenantId, tenantId),
      )
      .orderBy(asc(modelRoutes.priority), asc(modelRoutes.createdAt));

    const upstreamMap = new Map(
      (await this.upstreams.list(tenantId)).map((u) => [u.id, u]),
    );
    return rows.map((r) =>
      serializeRoute(r, upstreamMap.get(r.upstreamId)),
    );
  }

  async get(tenantId: string, id: string) {
    const row = await this.db.query.modelRoutes.findFirst({
      where: and(eq(modelRoutes.id, id), eq(modelRoutes.tenantId, tenantId)),
    });
    if (!row) return null;
    const upstream = await this.upstreams.get(tenantId, row.upstreamId);
    return serializeRoute(row, upstream ?? undefined);
  }

  async getRow(tenantId: string, id: string): Promise<ModelRoute | null> {
    const row = await this.db.query.modelRoutes.findFirst({
      where: and(eq(modelRoutes.id, id), eq(modelRoutes.tenantId, tenantId)),
    });
    return row ?? null;
  }

  async create(tenantId: string, input: ModelRouteInput) {
    if (!isModelCapability(input.capability)) {
      throw new Error(`不支持的能力: ${input.capability}`);
    }
    const upstream = await this.upstreams.getRow(tenantId, input.upstreamId);
    if (!upstream) throw new Error("上游不存在");

    const name = input.name.trim();
    const model = input.model.trim();
    if (!name) throw new Error("name required");
    if (!model) throw new Error("model required");

    let slug = (input.slug?.trim() || slugify(name)).toLowerCase();
    for (let i = 0; i < 20; i++) {
      const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
      const clash = await this.db.query.modelRoutes.findFirst({
        where: and(
          eq(modelRoutes.tenantId, tenantId),
          eq(modelRoutes.slug, candidate),
        ),
      });
      if (!clash) {
        slug = candidate;
        break;
      }
      if (i === 19) throw new Error(`slug 已存在: ${slug}`);
    }

    const isDefault = input.isDefault === true;
    if (isDefault) await this.clearDefault(tenantId, input.capability);

    const now = new Date();
    const [row] = await this.db
      .insert(modelRoutes)
      .values({
        id: newId(),
        tenantId,
        name,
        slug,
        capability: input.capability,
        alias: (input.alias?.trim() || model).trim(),
        upstreamId: input.upstreamId,
        model,
        optionsJson: JSON.stringify(input.options ?? {}),
        priority: String(input.priority ?? 100),
        weight: String(input.weight ?? 100),
        isDefault,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    this.onMutate?.(tenantId);
    return serializeRoute(row, serializeUpstream(upstream));
  }

  async update(
    tenantId: string,
    id: string,
    patch: {
      name?: string;
      model?: string;
      alias?: string;
      options?: Record<string, unknown>;
      priority?: number;
      weight?: number;
      isDefault?: boolean;
      upstreamId?: string;
    },
  ) {
    const row = await this.getRow(tenantId, id);
    if (!row) throw new Error("Not found");
    if (patch.upstreamId) {
      const upstream = await this.upstreams.getRow(tenantId, patch.upstreamId);
      if (!upstream) throw new Error("上游不存在");
    }
    if (patch.isDefault === true) {
      await this.clearDefault(tenantId, row.capability as ModelCapability);
    }

    const updates: Partial<ModelRoute> = { updatedAt: new Date() };
    if (typeof patch.name === "string" && patch.name.trim()) updates.name = patch.name.trim();
    if (typeof patch.model === "string" && patch.model.trim()) {
      updates.model = patch.model.trim();
      if (patch.alias === undefined) updates.alias = patch.model.trim();
    }
    if (typeof patch.alias === "string" && patch.alias.trim()) {
      updates.alias = patch.alias.trim();
    }
    if (patch.options) updates.optionsJson = JSON.stringify(patch.options);
    if (typeof patch.priority === "number") updates.priority = String(patch.priority);
    if (typeof patch.weight === "number") updates.weight = String(patch.weight);
    if (typeof patch.isDefault === "boolean") updates.isDefault = patch.isDefault;
    if (patch.upstreamId) updates.upstreamId = patch.upstreamId;

    const [next] = await this.db
      .update(modelRoutes)
      .set(updates)
      .where(and(eq(modelRoutes.id, id), eq(modelRoutes.tenantId, tenantId)))
      .returning();
    const upstream = await this.upstreams.get(tenantId, next.upstreamId);
    this.onMutate?.(tenantId);
    return serializeRoute(next, upstream ?? undefined);
  }

  async remove(tenantId: string, id: string) {
    const row = await this.getRow(tenantId, id);
    if (!row) return;
    await this.db
      .delete(modelRoutes)
      .where(and(eq(modelRoutes.id, id), eq(modelRoutes.tenantId, tenantId)));
    if (row.isDefault) {
      const next = await this.db.query.modelRoutes.findFirst({
        where: and(
          eq(modelRoutes.tenantId, tenantId),
          eq(modelRoutes.capability, row.capability),
        ),
        orderBy: [asc(modelRoutes.priority), asc(modelRoutes.createdAt)],
      });
      if (next) {
        await this.db
          .update(modelRoutes)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(modelRoutes.id, next.id));
      }
    }
    this.onMutate?.(tenantId);
  }

  private async clearDefault(tenantId: string, capability: ModelCapability) {
    await this.db
      .update(modelRoutes)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(eq(modelRoutes.tenantId, tenantId), eq(modelRoutes.capability, capability)),
      );
  }

  /** 按能力获取候选路由（默认优先，再按 priority 排序） */
  async listCandidates(tenantId: string, capability: ModelCapability) {
    const rows = await this.db
      .select()
      .from(modelRoutes)
      .where(
        and(eq(modelRoutes.tenantId, tenantId), eq(modelRoutes.capability, capability)),
      )
      .orderBy(asc(modelRoutes.priority), asc(modelRoutes.createdAt));

    const defaultRow = rows.find((r) => r.isDefault);
    const ordered = defaultRow
      ? [defaultRow, ...rows.filter((r) => r.id !== defaultRow.id)]
      : rows;
    return ordered;
  }
}
