import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  normalizeCanonicalModelId,
  type ModelCapability,
  type ModelCatalogEntry,
  type ModelRouteOptions,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  modelUpstreams,
  newId,
  upstreamModels,
  type UpstreamModel,
} from "../db/schema.js";
import {
  parseJsonRecord,
  parseRouteOptions,
  parseUpstreamConfig,
} from "../model-router/types.js";
import type { ModelCatalogService } from "./model-catalog.js";
import type { ModelUpstreamsService } from "./model-upstreams.js";
import { isModelCapability } from "./model-routes.js";

function parseWeight(raw: string | number | null | undefined): number {
  const n = typeof raw === "number" ? raw : Number(raw ?? 100);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/** 目录未命中时，按模型名启发式推断能力（如 qwen3.7-text-embedding） */
export function inferCapabilitiesFromModelId(modelId: string): ModelCapability[] {
  const s = modelId.trim().toLowerCase();
  if (!s) return [];
  const caps: ModelCapability[] = [];
  if (s.includes("rerank") || s.includes("ranker")) caps.push("rerank");
  if (s.includes("embed") || s.includes("embedding")) caps.push("embedding");
  if (
    s.includes("dall-e") ||
    s.includes("imagen") ||
    s.includes("flux") ||
    /(?:^|[-_.])image(?:$|[-_.])/.test(s) ||
    s.includes("text2image") ||
    s.includes("t2i")
  ) {
    caps.push("image");
  }
  return caps;
}

export function serializeUpstreamModel(
  row: UpstreamModel,
  upstream?: { id: string; name: string; slug: string; protocol: string } | null,
) {
  const meta = parseJsonRecord(row.metaJson);
  return {
    id: row.id,
    tenantId: row.tenantId,
    upstreamId: row.upstreamId,
    nativeModel: row.nativeModel,
    canonicalModel: row.canonicalModel,
    displayName: row.displayName,
    capability: row.capability as ModelCapability,
    weight: parseWeight(row.weight),
    enabled: row.enabled,
    isDefault: row.isDefault,
    options: parseRouteOptions(parseJsonRecord(row.optionsJson)),
    meta,
    status: row.status,
    lastError: row.lastError,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    upstream: upstream
      ? {
          id: upstream.id,
          name: upstream.name,
          slug: upstream.slug,
          protocol: upstream.protocol,
        }
      : undefined,
  };
}

export type UpstreamModelInput = {
  upstreamId: string;
  nativeModel: string;
  canonicalModel?: string;
  displayName?: string;
  capability: ModelCapability;
  weight?: number;
  enabled?: boolean;
  isDefault?: boolean;
  options?: ModelRouteOptions;
  meta?: Record<string, unknown>;
};

export type UpstreamModelMatchFailure = {
  nativeModel: string;
  displayName?: string;
  canonicalModel: string;
};

function formatUnmatchedModelMessage(unmatchedModels: UpstreamModelMatchFailure[]) {
  if (unmatchedModels.length === 0) return undefined;
  const names = unmatchedModels.map((m) => m.nativeModel);
  const shown = names.slice(0, 8).join("、");
  const more = names.length > 8 ? ` 等 ${names.length} 个` : "";
  return `目录未匹配到 ${shown}${more}，需要手动选数据`;
}

export class UpstreamModelsService {
  constructor(
    private readonly db: Db,
    private readonly upstreams: ModelUpstreamsService,
    private readonly catalog: ModelCatalogService,
    private readonly onMutate?: (tenantId: string) => void,
  ) {}

  async list(
    tenantId: string,
    opts?: { capability?: ModelCapability; upstreamId?: string; enabledOnly?: boolean },
  ) {
    const conditions = [eq(upstreamModels.tenantId, tenantId)];
    if (opts?.capability) {
      conditions.push(eq(upstreamModels.capability, opts.capability));
    }
    if (opts?.upstreamId) {
      conditions.push(eq(upstreamModels.upstreamId, opts.upstreamId));
    }
    if (opts?.enabledOnly) {
      conditions.push(eq(upstreamModels.enabled, true));
    }

    const rows = await this.db
      .select({
        model: upstreamModels,
        upstreamId: modelUpstreams.id,
        upstreamName: modelUpstreams.name,
        upstreamSlug: modelUpstreams.slug,
        upstreamProtocol: modelUpstreams.protocol,
      })
      .from(upstreamModels)
      .innerJoin(modelUpstreams, eq(upstreamModels.upstreamId, modelUpstreams.id))
      .where(and(...conditions))
      .orderBy(
        asc(upstreamModels.canonicalModel),
        asc(upstreamModels.nativeModel),
        asc(upstreamModels.createdAt),
      );

    return rows.map((r) =>
      serializeUpstreamModel(r.model, {
        id: r.upstreamId,
        name: r.upstreamName,
        slug: r.upstreamSlug,
        protocol: r.upstreamProtocol,
      }),
    );
  }

  /** 按规范名聚合：同 canonical + capability 的多上游部署 */
  async listLogical(
    tenantId: string,
    opts?: { capability?: ModelCapability },
  ) {
    const deployments = await this.list(tenantId, opts);
    const map = new Map<
      string,
      {
        canonicalModel: string;
        displayName: string;
        capability: ModelCapability;
        isDefault: boolean;
        deployments: ReturnType<typeof serializeUpstreamModel>[];
      }
    >();

    for (const d of deployments) {
      const key = `${d.capability}::${d.canonicalModel}`;
      let group = map.get(key);
      if (!group) {
        group = {
          canonicalModel: d.canonicalModel,
          displayName: d.displayName?.trim() || d.canonicalModel,
          capability: d.capability,
          isDefault: false,
          deployments: [],
        };
        map.set(key, group);
      }
      group.deployments.push(d);
      if (d.isDefault) group.isDefault = true;
      if (d.displayName?.trim() && group.displayName === group.canonicalModel) {
        group.displayName = d.displayName.trim();
      }
    }

    return [...map.values()].sort((a, b) =>
      a.canonicalModel.localeCompare(b.canonicalModel),
    );
  }

  async get(tenantId: string, id: string) {
    const row = await this.db.query.upstreamModels.findFirst({
      where: and(eq(upstreamModels.id, id), eq(upstreamModels.tenantId, tenantId)),
    });
    if (!row) return null;
    const up = await this.upstreams.get(tenantId, row.upstreamId);
    return serializeUpstreamModel(
      row,
      up
        ? { id: up.id, name: up.name, slug: up.slug, protocol: up.protocol }
        : null,
    );
  }

  async create(tenantId: string, input: UpstreamModelInput) {
    const upstream = await this.upstreams.getRow(tenantId, input.upstreamId);
    if (!upstream) throw new Error("上游不存在");

    const nativeModel = input.nativeModel.trim();
    if (!nativeModel) throw new Error("nativeModel 必填");

    const capability = input.capability;

    const resolved = await this.resolveNames(
      tenantId,
      nativeModel,
      input.canonicalModel,
      undefined,
      this.catalogHintsForUpstream(upstream),
    );
    const now = new Date();

    if (input.isDefault) {
      await this.clearDefault(tenantId, capability);
    }

    const [row] = await this.db
      .insert(upstreamModels)
      .values({
        id: newId(),
        tenantId,
        upstreamId: input.upstreamId,
        nativeModel,
        canonicalModel: resolved.canonicalModel,
        displayName: input.displayName?.trim() || resolved.displayName,
        capability,
        weight: String(input.weight && input.weight > 0 ? Math.floor(input.weight) : 100),
        enabled: input.enabled !== false,
        isDefault: input.isDefault === true,
        optionsJson: JSON.stringify(input.options ?? {}),
        metaJson: JSON.stringify(input.meta ?? resolved.meta ?? {}),
        status: "ready",
        syncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    this.onMutate?.(tenantId);
    const up = await this.upstreams.get(tenantId, input.upstreamId);
    return serializeUpstreamModel(
      row!,
      up
        ? { id: up.id, name: up.name, slug: up.slug, protocol: up.protocol }
        : null,
    );
  }

  async update(
    tenantId: string,
    id: string,
    patch: {
      nativeModel?: string;
      canonicalModel?: string;
      displayName?: string | null;
      weight?: number;
      enabled?: boolean;
      isDefault?: boolean;
      capability?: ModelCapability;
      options?: ModelRouteOptions;
      meta?: Record<string, unknown>;
    },
  ) {
    const existing = await this.db.query.upstreamModels.findFirst({
      where: and(eq(upstreamModels.id, id), eq(upstreamModels.tenantId, tenantId)),
    });
    if (!existing) throw new Error("Not found");

    const capability = patch.capability ?? (existing.capability as ModelCapability);
    if (!isModelCapability(capability)) throw new Error("不支持的能力");
    const isDefault = patch.isDefault ?? existing.isDefault;
    if (isDefault && (patch.isDefault === true || capability !== existing.capability)) {
      await this.clearDefault(tenantId, capability);
    }

    const nativeModel = patch.nativeModel?.trim() ?? existing.nativeModel;
    let canonicalModel = existing.canonicalModel;
    let displayName =
      patch.displayName === null
        ? null
        : patch.displayName !== undefined
          ? patch.displayName.trim() || null
          : existing.displayName;
    let metaJson = existing.metaJson;

    if (patch.canonicalModel?.trim()) {
      canonicalModel = normalizeCanonicalModelId(patch.canonicalModel);
    } else if (patch.nativeModel?.trim() && patch.nativeModel.trim() !== existing.nativeModel) {
      const upstream = await this.upstreams.getRow(tenantId, existing.upstreamId);
      const resolved = await this.resolveNames(
        tenantId,
        nativeModel,
        undefined,
        undefined,
        upstream ? this.catalogHintsForUpstream(upstream) : undefined,
      );
      canonicalModel = resolved.canonicalModel;
      if (displayName == null) displayName = resolved.displayName;
      metaJson = JSON.stringify(resolved.meta ?? {});
    }

    const [row] = await this.db
      .update(upstreamModels)
      .set({
        nativeModel,
        canonicalModel,
        displayName,
        capability,
        weight:
          patch.weight != null && patch.weight > 0
            ? String(Math.floor(patch.weight))
            : existing.weight,
        enabled: patch.enabled ?? existing.enabled,
        isDefault,
        optionsJson:
          patch.options != null
            ? JSON.stringify(patch.options)
            : existing.optionsJson,
        metaJson: patch.meta != null ? JSON.stringify(patch.meta) : metaJson,
        updatedAt: new Date(),
      })
      .where(and(eq(upstreamModels.id, id), eq(upstreamModels.tenantId, tenantId)))
      .returning();

    this.onMutate?.(tenantId);
    const up = await this.upstreams.get(tenantId, row!.upstreamId);
    return serializeUpstreamModel(
      row!,
      up
        ? { id: up.id, name: up.name, slug: up.slug, protocol: up.protocol }
        : null,
    );
  }

  async remove(tenantId: string, id: string) {
    const existing = await this.get(tenantId, id);
    if (!existing) throw new Error("Not found");
    await this.db
      .delete(upstreamModels)
      .where(and(eq(upstreamModels.id, id), eq(upstreamModels.tenantId, tenantId)));
    this.onMutate?.(tenantId);
  }

  async removeMany(tenantId: string, ids: string[]) {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) return { deleted: 0 };
    await this.db
      .delete(upstreamModels)
      .where(
        and(eq(upstreamModels.tenantId, tenantId), inArray(upstreamModels.id, unique)),
      );
    this.onMutate?.(tenantId);
    return { deleted: unique.length };
  }

  async removeByUpstream(tenantId: string, upstreamId: string) {
    await this.db
      .delete(upstreamModels)
      .where(
        and(
          eq(upstreamModels.tenantId, tenantId),
          eq(upstreamModels.upstreamId, upstreamId),
        ),
      );
    this.onMutate?.(tenantId);
  }

  async countByUpstream(tenantId: string, upstreamId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(upstreamModels)
      .where(
        and(
          eq(upstreamModels.tenantId, tenantId),
          eq(upstreamModels.upstreamId, upstreamId),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /**
   * 从上游拉取模型并写入库存；用元数据匹配规范名与能力。
   */
  async syncFromUpstream(
    tenantId: string,
    upstreamId: string,
    opts?: { prune?: boolean; defaultCapability?: ModelCapability },
  ) {
    const upstream = await this.upstreams.getRow(tenantId, upstreamId);
    if (!upstream) throw new Error("上游不存在");

    const remote = await this.upstreams.listRemoteModels(tenantId, upstreamId);
    if (remote.models.length === 0) {
      return {
        synced: 0,
        created: 0,
        updated: 0,
        pruned: 0,
        message: remote.message ?? "上游未返回模型列表，请手填模型",
        models: [] as ReturnType<typeof serializeUpstreamModel>[],
      };
    }

    const now = new Date();
    let created = 0;
    let updated = 0;
    const touchedKeys = new Set<string>();
    const results: UpstreamModel[] = [];
    const unmatchedByNativeModel = new Map<string, UpstreamModelMatchFailure>();

    for (const remoteModel of remote.models) {
      const nativeModel = remoteModel.id.trim();
      if (!nativeModel) continue;

      const resolved = await this.resolveNames(
        tenantId,
        nativeModel,
        undefined,
        remoteModel.name,
        this.catalogHintsForUpstream(upstream),
      );
      if (resolved.matchStatus === "unmatched") {
        unmatchedByNativeModel.set(nativeModel, {
          nativeModel,
          displayName: remoteModel.name,
          canonicalModel: resolved.canonicalModel,
        });
      }
      const inferred = inferCapabilitiesFromModelId(nativeModel);
      const capabilities: ModelCapability[] =
        remoteModel.capability && isModelCapability(remoteModel.capability)
          ? [remoteModel.capability]
          : resolved.capabilities.length > 0
            ? resolved.capabilities
            : inferred.length > 0
              ? inferred
              : ([opts?.defaultCapability ?? "chat"] as ModelCapability[]);

      for (const capability of capabilities) {
        const key = `${nativeModel}::${capability}`;
        touchedKeys.add(key);

        const existing = await this.db.query.upstreamModels.findFirst({
          where: and(
            eq(upstreamModels.tenantId, tenantId),
            eq(upstreamModels.upstreamId, upstreamId),
            eq(upstreamModels.nativeModel, nativeModel),
            eq(upstreamModels.capability, capability),
          ),
        });

        if (existing) {
          const [row] = await this.db
            .update(upstreamModels)
            .set({
              canonicalModel: resolved.canonicalModel,
              displayName: resolved.displayName || existing.displayName,
              metaJson: JSON.stringify(resolved.meta ?? {}),
              status: "ready",
              lastError: null,
              syncedAt: now,
              updatedAt: now,
            })
            .where(eq(upstreamModels.id, existing.id))
            .returning();
          if (row) results.push(row);
          updated += 1;
        } else {
          const [row] = await this.db
            .insert(upstreamModels)
            .values({
              id: newId(),
              tenantId,
              upstreamId,
              nativeModel,
              canonicalModel: resolved.canonicalModel,
              displayName: resolved.displayName,
              capability,
              weight: "100",
              enabled: true,
              isDefault: false,
              optionsJson: "{}",
              metaJson: JSON.stringify(resolved.meta ?? {}),
              status: "ready",
              syncedAt: now,
              createdAt: now,
              updatedAt: now,
            })
            // The existence check above is only an optimization. Two sync
            // requests can still pass it at the same time, so let the
            // database arbitrate on the unique key instead of surfacing a
            // transient duplicate-key error to the caller.
            .onConflictDoUpdate({
              target: [
                upstreamModels.tenantId,
                upstreamModels.upstreamId,
                upstreamModels.nativeModel,
                upstreamModels.capability,
              ],
              set: {
                canonicalModel: resolved.canonicalModel,
                displayName: resolved.displayName,
                metaJson: JSON.stringify(resolved.meta ?? {}),
                status: "ready",
                lastError: null,
                syncedAt: now,
                updatedAt: now,
              },
            })
            .returning();
          if (row) results.push(row);
          created += 1;
        }
      }
    }

    let pruned = 0;
    if (opts?.prune) {
      const existingRows = await this.db
        .select()
        .from(upstreamModels)
        .where(
          and(
            eq(upstreamModels.tenantId, tenantId),
            eq(upstreamModels.upstreamId, upstreamId),
          ),
        );
      const toDelete = existingRows.filter(
        (r) => !touchedKeys.has(`${r.nativeModel}::${r.capability}`),
      );
      if (toDelete.length > 0) {
        await this.db.delete(upstreamModels).where(
          inArray(
            upstreamModels.id,
            toDelete.map((r) => r.id),
          ),
        );
        pruned = toDelete.length;
      }
    }

    this.onMutate?.(tenantId);
    const up = {
      id: upstream.id,
      name: upstream.name,
      slug: upstream.slug,
      protocol: upstream.protocol,
    };
    const unmatchedModels = [...unmatchedByNativeModel.values()];
    return {
      synced: created + updated,
      created,
      updated,
      pruned,
      message: remote.message,
      unmatchedModels,
      models: results.map((r) => serializeUpstreamModel(r, up)),
    };
  }

  /** 元数据刷新后，按最新目录重新匹配规范名 */
  async rematchAll(tenantId: string) {
    const rows = await this.db
      .select()
      .from(upstreamModels)
      .where(eq(upstreamModels.tenantId, tenantId));

    let updated = 0;
    const unmatchedByNativeModel = new Map<string, UpstreamModelMatchFailure>();
    for (const row of rows) {
      const upstream = await this.upstreams.getRow(tenantId, row.upstreamId);
      const resolved = await this.resolveNames(
        tenantId,
        row.nativeModel,
        undefined,
        undefined,
        upstream ? this.catalogHintsForUpstream(upstream) : undefined,
      );
      if (resolved.matchStatus === "unmatched") {
        unmatchedByNativeModel.set(row.nativeModel, {
          nativeModel: row.nativeModel,
          displayName: row.displayName ?? undefined,
          canonicalModel: resolved.canonicalModel,
        });
      }
      if (
        resolved.canonicalModel === row.canonicalModel &&
        (resolved.displayName || null) === (row.displayName || null)
      ) {
        // 仍更新 meta
        await this.db
          .update(upstreamModels)
          .set({
            metaJson: JSON.stringify(resolved.meta ?? {}),
            updatedAt: new Date(),
          })
          .where(eq(upstreamModels.id, row.id));
        continue;
      }
      await this.db
        .update(upstreamModels)
        .set({
          canonicalModel: resolved.canonicalModel,
          displayName: resolved.displayName || row.displayName,
          metaJson: JSON.stringify(resolved.meta ?? {}),
          updatedAt: new Date(),
        })
        .where(eq(upstreamModels.id, row.id));
      updated += 1;
    }
    this.onMutate?.(tenantId);
    const unmatchedModels = [...unmatchedByNativeModel.values()];
    return {
      rematched: rows.length,
      renamed: updated,
      unmatchedModels,
      message: formatUnmatchedModelMessage(unmatchedModels),
    };
  }

  private async clearDefault(tenantId: string, capability: ModelCapability) {
    await this.db
      .update(upstreamModels)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(upstreamModels.tenantId, tenantId),
          eq(upstreamModels.capability, capability),
          eq(upstreamModels.isDefault, true),
        ),
      );
  }

  private async resolveNames(
    tenantId: string,
    nativeModel: string,
    canonicalOverride?: string,
    remoteName?: string,
    hints?: {
      providerId?: string;
      providerName?: string;
      apiBase?: string;
    },
  ): Promise<{
    canonicalModel: string;
    displayName: string;
    capabilities: ModelCapability[];
    meta?: ModelCatalogEntry;
    matchStatus: "override" | "catalog" | "unmatched";
  }> {
    if (canonicalOverride?.trim()) {
      const canonicalModel = normalizeCanonicalModelId(canonicalOverride);
      return {
        canonicalModel,
        displayName: remoteName?.trim() || canonicalOverride.trim(),
        capabilities: [],
        matchStatus: "override",
      };
    }

    const match = await this.catalog.matchBest(tenantId, nativeModel, hints);
    if (match) {
      const fromCatalog = (match.capabilities ?? []).filter(isModelCapability);
      const inferred = inferCapabilitiesFromModelId(nativeModel);
      return {
        canonicalModel: normalizeCanonicalModelId(match.modelId),
        displayName: match.name || remoteName?.trim() || match.modelId,
        capabilities: fromCatalog.length > 0 ? fromCatalog : inferred,
        meta: match,
        matchStatus: "catalog",
      };
    }

    const fallback = normalizeCanonicalModelId(nativeModel);
    return {
      canonicalModel: fallback || nativeModel.trim().toLowerCase(),
      displayName: remoteName?.trim() || nativeModel.trim(),
      capabilities: inferCapabilitiesFromModelId(nativeModel),
      matchStatus: "unmatched",
    };
  }

  private catalogHintsForUpstream(upstream: {
    protocol: string;
    name?: string;
    configJson: string;
  }) {
    const config = parseUpstreamConfig(
      parseJsonRecord(upstream.configJson),
      upstream.protocol as Parameters<typeof parseUpstreamConfig>[1],
    );
    return {
      providerId: upstream.protocol,
      providerName: upstream.name,
      apiBase: config.baseUrl,
    };
  }
}
