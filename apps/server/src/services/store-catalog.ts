/**
 * 商店目录索引：只索引名称/描述，供 pg_trgm 模糊搜索。
 * 平台条目 tenantId=null；租户自定义市场有 tenantId。不缓存技能正文 / MCP 包内容。
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "../db/client.js";
import { newId, storeCatalogEntries } from "../db/schema.js";

export type StoreCatalogKind = "mcp" | "skill" | "plugin" | "curated" | "platform" | "skill-repo";

export type StoreCatalogMeta = {
  installRef?: string;
  detailId?: string;
  publisher?: string;
  needsRunner?: boolean;
  counts?: Record<string, number>;
  icon?: string;
  version?: string;
};

export type StoreCatalogHit = {
  id: string;
  sourceId: string;
  kind: StoreCatalogKind;
  ref: string;
  name: string;
  description: string;
  meta: StoreCatalogMeta;
  score: number;
};

function entryId(sourceId: string, ref: string, tenantId: string | null): string {
  return createHash("sha256")
    .update(`${tenantId ?? ""}|${sourceId}|${ref}`)
    .digest("hex")
    .slice(0, 32);
}

export class StoreCatalogService {
  private trgmReady: Promise<boolean> | null = null;

  constructor(private readonly db: Db) {}

  private async ensureTrgm(): Promise<boolean> {
    if (!this.trgmReady) {
      this.trgmReady = this.db
        .execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`)
        .then((r) => (r as { rows?: unknown[] }).rows?.length === 1 || Array.isArray(r) && (r as unknown[]).length >= 1)
        .catch(() => false);
    }
    return this.trgmReady;
  }

  /** 替换某一 source 下的全部索引行（平台或某租户自定义源） */
  async replaceSource(
    sourceId: string,
    entries: Array<{
      kind: StoreCatalogKind;
      ref: string;
      name: string;
      description?: string;
      meta?: StoreCatalogMeta;
    }>,
    tenantId: string | null = null,
  ): Promise<number> {
    await this.db
      .delete(storeCatalogEntries)
      .where(
        and(
          eq(storeCatalogEntries.sourceId, sourceId),
          tenantId ? eq(storeCatalogEntries.tenantId, tenantId) : isNull(storeCatalogEntries.tenantId),
        ),
      );

    if (!entries.length) return 0;
    const now = new Date();
    const rows = entries.map((e) => ({
      id: entryId(sourceId, e.ref, tenantId) || newId(),
      tenantId,
      sourceId,
      kind: e.kind,
      ref: e.ref,
      name: e.name.slice(0, 240),
      description: (e.description ?? "").slice(0, 2000),
      metaJson: JSON.stringify(e.meta ?? {}),
      updatedAt: now,
    }));

    // 分批写入，避免超大 insert
    const chunk = 200;
    for (let i = 0; i < rows.length; i += chunk) {
      await this.db.insert(storeCatalogEntries).values(rows.slice(i, i + chunk));
    }
    return rows.length;
  }

  async search(opts: {
    tenantId: string;
    q: string;
    sourceId?: string;
    limit?: number;
  }): Promise<StoreCatalogHit[]> {
    const q = opts.q.trim();
    if (!q) return [];
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
    const trgmOk = await this.ensureTrgm();

    const visibility = or(
      isNull(storeCatalogEntries.tenantId),
      eq(storeCatalogEntries.tenantId, opts.tenantId),
    )!;

    const sourceFilter = opts.sourceId && opts.sourceId !== "all"
      ? eq(storeCatalogEntries.sourceId, opts.sourceId)
      : undefined;

    if (trgmOk) {
      const scoreExpr = sql<number>`GREATEST(
        similarity(${storeCatalogEntries.name}, ${q}),
        word_similarity(${q}, ${storeCatalogEntries.name}),
        similarity(${storeCatalogEntries.description}, ${q}) * 0.6
      )`;
      const like = `%${q.replace(/[%_]/g, "")}%`;
      const rows = await this.db
        .select({
          id: storeCatalogEntries.id,
          sourceId: storeCatalogEntries.sourceId,
          kind: storeCatalogEntries.kind,
          ref: storeCatalogEntries.ref,
          name: storeCatalogEntries.name,
          description: storeCatalogEntries.description,
          metaJson: storeCatalogEntries.metaJson,
          score: scoreExpr,
        })
        .from(storeCatalogEntries)
        .where(
          and(
            visibility,
            sourceFilter,
            or(
              sql`${scoreExpr} > 0.12`,
              sql`${storeCatalogEntries.name} ILIKE ${like}`,
              sql`${storeCatalogEntries.description} ILIKE ${like}`,
            ),
          ),
        )
        .orderBy(sql`${scoreExpr} DESC`)
        .limit(limit);

      return rows.map((r) => ({
        id: r.id,
        sourceId: r.sourceId,
        kind: r.kind as StoreCatalogKind,
        ref: r.ref,
        name: r.name,
        description: r.description,
        meta: safeMeta(r.metaJson),
        score: Number(r.score) || 0,
      }));
    }

    const like = `%${q.replace(/[%_]/g, "")}%`;
    const rows = await this.db
      .select()
      .from(storeCatalogEntries)
      .where(
        and(
          visibility,
          sourceFilter,
          or(
            sql`${storeCatalogEntries.name} ILIKE ${like}`,
            sql`${storeCatalogEntries.description} ILIKE ${like}`,
          ),
        ),
      )
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      kind: r.kind as StoreCatalogKind,
      ref: r.ref,
      name: r.name,
      description: r.description,
      meta: safeMeta(r.metaJson),
      score: 0,
    }));
  }
}

function safeMeta(raw: string): StoreCatalogMeta {
  try {
    return JSON.parse(raw) as StoreCatalogMeta;
  } catch {
    return {};
  }
}
