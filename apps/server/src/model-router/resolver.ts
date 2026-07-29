import { and, asc, eq } from "drizzle-orm";
import type { ModelCapability, ModelRouteStrategy } from "@zakura/shared";
import type { Db } from "../db/client.js";
import { modelRoutes, modelUpstreams, upstreamModels } from "../db/schema.js";
import { TtlCache } from "./cache.js";
import { orderRoutesForStrategy } from "./strategy.js";
import { rowToResolvedRoute, type ResolvedRoute } from "./types.js";

export type RouteResolveQuery = {
  capability: ModelCapability;
  routeId?: string;
  slug?: string;
  alias?: string;
  strategy?: ModelRouteStrategy;
};

/**
 * 解析调用链：优先 upstream_models（按 canonical 聚合），兼容旧 model_routes。
 * 实际调用使用 nativeModel；调度键为 canonicalModel（映射到 alias）。
 */
export class RouteResolver {
  private readonly chainCache = new TtlCache<ResolvedRoute[]>();

  constructor(private readonly db: Db) {}

  invalidateTenant(tenantId: string): void {
    this.chainCache.invalidatePrefix(`${tenantId}:`);
  }

  async resolveChain(
    tenantId: string,
    query: RouteResolveQuery,
  ): Promise<ResolvedRoute[]> {
    if (query.routeId) {
      const one =
        (await this.fetchUpstreamModelById(tenantId, query.routeId, query.capability)) ??
        (await this.fetchLegacyRouteById(tenantId, query.routeId, query.capability));
      return one ? [one] : [];
    }
    if (query.slug) {
      // slug：先当 canonical / 再当旧 route slug
      const byCanonical = await this.fetchUpstreamChain(
        tenantId,
        query.capability,
        query.slug,
      );
      if (byCanonical.length > 0) {
        return orderRoutesForStrategy(
          byCanonical,
          query.strategy ?? "weighted",
          query.slug,
        );
      }
      const one = await this.fetchLegacyBySlug(tenantId, query.slug, query.capability);
      return one ? [one] : [];
    }

    const strategy = query.strategy ?? "weighted";
    const cacheKey = `${tenantId}:chain:${query.capability}:${query.alias ?? "*"}`;
    let chain = this.chainCache.get(cacheKey);
    if (!chain) {
      chain = await this.fetchUpstreamChain(tenantId, query.capability, query.alias);
      if (chain.length === 0) {
        chain = await this.fetchLegacyChain(tenantId, query.capability, query.alias);
      }
      if (chain.length > 0) this.chainCache.set(cacheKey, chain);
    }

    const defaultAlias = await this.findDefaultAlias(tenantId, query.capability);
    const preferred = query.alias ?? defaultAlias;

    return orderRoutesForStrategy(chain, strategy, preferred);
  }

  private async findDefaultAlias(
    tenantId: string,
    capability: ModelCapability,
  ): Promise<string | undefined> {
    const um = await this.db.query.upstreamModels.findFirst({
      where: and(
        eq(upstreamModels.tenantId, tenantId),
        eq(upstreamModels.capability, capability),
        eq(upstreamModels.isDefault, true),
        eq(upstreamModels.enabled, true),
      ),
    });
    if (um) return um.canonicalModel;

    const row = await this.db.query.modelRoutes.findFirst({
      where: and(
        eq(modelRoutes.tenantId, tenantId),
        eq(modelRoutes.capability, capability),
        eq(modelRoutes.isDefault, true),
      ),
    });
    if (!row) return undefined;
    return (row.alias?.trim() || row.model).trim();
  }

  private async fetchUpstreamChain(
    tenantId: string,
    capability: ModelCapability,
    canonicalOrAlias?: string,
  ): Promise<ResolvedRoute[]> {
    const rows = await this.db
      .select({
        id: upstreamModels.id,
        nativeModel: upstreamModels.nativeModel,
        canonicalModel: upstreamModels.canonicalModel,
        capability: upstreamModels.capability,
        weight: upstreamModels.weight,
        optionsJson: upstreamModels.optionsJson,
        metaJson: upstreamModels.metaJson,
        isDefault: upstreamModels.isDefault,
        enabled: upstreamModels.enabled,
        upstreamId: modelUpstreams.id,
        protocol: modelUpstreams.protocol,
        configJson: modelUpstreams.configJson,
      })
      .from(upstreamModels)
      .innerJoin(modelUpstreams, eq(upstreamModels.upstreamId, modelUpstreams.id))
      .where(
        and(
          eq(upstreamModels.tenantId, tenantId),
          eq(upstreamModels.capability, capability),
          eq(upstreamModels.enabled, true),
        ),
      )
      .orderBy(asc(upstreamModels.createdAt));

    let filtered = rows;
    if (canonicalOrAlias?.trim()) {
      const key = canonicalOrAlias.trim();
      filtered = rows.filter(
        (r) =>
          r.canonicalModel === key ||
          r.nativeModel === key ||
          r.canonicalModel.toLowerCase() === key.toLowerCase(),
      );
    }

    const defaultRow = filtered.find((r) => r.isDefault);
    const ordered = defaultRow
      ? [defaultRow, ...filtered.filter((r) => r.id !== defaultRow.id)]
      : filtered;

    return ordered.map((r) =>
      rowToResolvedRoute({
        routeId: r.id,
        routeSlug: r.canonicalModel,
        alias: r.canonicalModel,
        capability: r.capability,
        model: r.nativeModel,
        weight: r.weight,
        optionsJson: r.optionsJson,
        metaJson: r.metaJson,
        upstreamId: r.upstreamId,
        protocol: r.protocol,
        configJson: r.configJson,
      }),
    );
  }

  private async fetchUpstreamModelById(
    tenantId: string,
    id: string,
    capability: ModelCapability,
  ): Promise<ResolvedRoute | null> {
    const rows = await this.db
      .select({
        id: upstreamModels.id,
        nativeModel: upstreamModels.nativeModel,
        canonicalModel: upstreamModels.canonicalModel,
        capability: upstreamModels.capability,
        weight: upstreamModels.weight,
        optionsJson: upstreamModels.optionsJson,
        metaJson: upstreamModels.metaJson,
        enabled: upstreamModels.enabled,
        upstreamId: modelUpstreams.id,
        protocol: modelUpstreams.protocol,
        configJson: modelUpstreams.configJson,
      })
      .from(upstreamModels)
      .innerJoin(modelUpstreams, eq(upstreamModels.upstreamId, modelUpstreams.id))
      .where(
        and(
          eq(upstreamModels.tenantId, tenantId),
          eq(upstreamModels.id, id),
          eq(upstreamModels.capability, capability),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || !row.enabled) return null;
    return rowToResolvedRoute({
      routeId: row.id,
      routeSlug: row.canonicalModel,
      alias: row.canonicalModel,
      capability: row.capability,
      model: row.nativeModel,
      weight: row.weight,
      optionsJson: row.optionsJson,
      metaJson: row.metaJson,
      upstreamId: row.upstreamId,
      protocol: row.protocol,
      configJson: row.configJson,
    });
  }

  private async fetchLegacyChain(
    tenantId: string,
    capability: ModelCapability,
    alias?: string,
  ): Promise<ResolvedRoute[]> {
    const rows = await this.db
      .select({
        routeId: modelRoutes.id,
        routeSlug: modelRoutes.slug,
        alias: modelRoutes.alias,
        capability: modelRoutes.capability,
        model: modelRoutes.model,
        weight: modelRoutes.weight,
        optionsJson: modelRoutes.optionsJson,
        isDefault: modelRoutes.isDefault,
        priority: modelRoutes.priority,
        upstreamId: modelUpstreams.id,
        protocol: modelUpstreams.protocol,
        configJson: modelUpstreams.configJson,
      })
      .from(modelRoutes)
      .innerJoin(modelUpstreams, eq(modelRoutes.upstreamId, modelUpstreams.id))
      .where(
        and(eq(modelRoutes.tenantId, tenantId), eq(modelRoutes.capability, capability)),
      )
      .orderBy(asc(modelRoutes.priority), asc(modelRoutes.createdAt));

    let filtered = rows;
    if (alias) {
      filtered = rows.filter(
        (r) => (r.alias?.trim() || r.model).trim() === alias.trim(),
      );
    }

    const defaultRow = filtered.find((r) => r.isDefault);
    const ordered = defaultRow
      ? [defaultRow, ...filtered.filter((r) => r.routeId !== defaultRow.routeId)]
      : filtered;

    return ordered.map((r) =>
      rowToResolvedRoute({
        routeId: r.routeId,
        routeSlug: r.routeSlug,
        alias: r.alias,
        capability: r.capability,
        model: r.model,
        weight: r.weight,
        optionsJson: r.optionsJson,
        upstreamId: r.upstreamId,
        protocol: r.protocol,
        configJson: r.configJson,
      }),
    );
  }

  private async fetchLegacyRouteById(
    tenantId: string,
    routeId: string,
    capability: ModelCapability,
  ): Promise<ResolvedRoute | null> {
    const rows = await this.db
      .select({
        routeId: modelRoutes.id,
        routeSlug: modelRoutes.slug,
        alias: modelRoutes.alias,
        capability: modelRoutes.capability,
        model: modelRoutes.model,
        weight: modelRoutes.weight,
        optionsJson: modelRoutes.optionsJson,
        upstreamId: modelUpstreams.id,
        protocol: modelUpstreams.protocol,
        configJson: modelUpstreams.configJson,
      })
      .from(modelRoutes)
      .innerJoin(modelUpstreams, eq(modelRoutes.upstreamId, modelUpstreams.id))
      .where(
        and(
          eq(modelRoutes.tenantId, tenantId),
          eq(modelRoutes.id, routeId),
          eq(modelRoutes.capability, capability),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? rowToResolvedRoute(row) : null;
  }

  private async fetchLegacyBySlug(
    tenantId: string,
    slug: string,
    capability: ModelCapability,
  ): Promise<ResolvedRoute | null> {
    const rows = await this.db
      .select({
        routeId: modelRoutes.id,
        routeSlug: modelRoutes.slug,
        alias: modelRoutes.alias,
        capability: modelRoutes.capability,
        model: modelRoutes.model,
        weight: modelRoutes.weight,
        optionsJson: modelRoutes.optionsJson,
        upstreamId: modelUpstreams.id,
        protocol: modelUpstreams.protocol,
        configJson: modelUpstreams.configJson,
      })
      .from(modelRoutes)
      .innerJoin(modelUpstreams, eq(modelRoutes.upstreamId, modelUpstreams.id))
      .where(
        and(
          eq(modelRoutes.tenantId, tenantId),
          eq(modelRoutes.slug, slug),
          eq(modelRoutes.capability, capability),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? rowToResolvedRoute(row) : null;
  }
}
