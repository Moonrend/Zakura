import { and, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  memories,
  memoryEdges,
  newId,
  type Memory,
  type MemoryEdge,
} from "../db/schema.js";
import { toVectorLiteral } from "../db/vector.js";
import { contentHash } from "./embedding-client.js";

export const MEMORY_LAYERS = [
  "identity",
  "preference",
  "project",
  "fact",
  "episode",
  "note",
] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

export function isMemoryLayer(v: string): v is MemoryLayer {
  return (MEMORY_LAYERS as readonly string[]).includes(v);
}

function escapeIlike(s: string): string {
  return s.replace(/[%_]/g, "\\$&");
}

/** Keyword tokens for ILIKE search — English words + CJK bigrams (no embedding). */
export function keywordTokens(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const s = t.trim();
    if (s.length < 1) return;
    if (s.length === 1 && !/[\u4e00-\u9fff]/.test(s)) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  for (const part of q.split(/[\s,，。、；;!?？！]+/)) {
    push(part);
  }
  const cjk = q.replace(/[^\u4e00-\u9fff]/g, "");
  if (cjk.length >= 2 && cjk.length <= 32) {
    for (let i = 0; i < cjk.length - 1 && out.length < 24; i++) {
      push(cjk.slice(i, i + 2));
    }
  }
  return out.slice(0, 16);
}

export type MemoryInput = {
  content: string;
  userId?: string | null;
  layer?: string;
  tags?: string[];
  pinned?: boolean;
  importance?: number;
  source?: string;
  metadata?: Record<string, unknown>;
  providerId?: string | null;
  /** Optional semantic vector (OpenAI-compatible embed); stored as pgvector */
  embedding?: number[] | null;
  embeddingModel?: string | null;
};

export type MemoryListOpts = {
  q?: string;
  layer?: string;
  userId?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
};

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function parseMeta(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseEmbedding(value: number[] | string | null | undefined): number[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.length ? value.map(Number) : null;
  if (typeof value === "string") {
    const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (!inner) return null;
    return inner.split(",").map((s) => Number(s.trim()));
  }
  return null;
}

export function serializeMemory(row: Memory) {
  const emb = parseEmbedding(row.embedding ?? null);
  return {
    id: row.id,
    agentId: row.agentId,
    providerId: row.providerId,
    userId: row.userId,
    layer: row.layer,
    content: row.content,
    tags: parseTags(row.tagsJson),
    pinned: row.pinned,
    importance: Number(row.importance) || 3,
    source: row.source,
    metadata: parseMeta(row.metadataJson),
    hasEmbedding: Boolean(emb),
    embeddingModel: row.embeddingModel,
    embeddingDim: row.embeddingDim,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function serializeEdge(row: MemoryEdge) {
  return {
    id: row.id,
    agentId: row.agentId,
    fromMemoryId: row.fromMemoryId,
    toMemoryId: row.toMemoryId,
    relation: row.relation,
    weight: Number(row.weight) || 1,
    createdAt: row.createdAt,
  };
}

/**
 * Local memory rows (builtin / traditional).
 * Built-in optional pgvector embeddings (PGlite/Postgres) as Memoh-style semantic seeds,
 * fused with keyword + graph expansion. No Qdrant required.
 */
export class MemoryStore {
  constructor(private readonly db: Db) {}

  async add(tenantId: string, agentId: string, input: MemoryInput) {
    const content = input.content.trim();
    if (!content) throw new Error("content required");
    const layer =
      input.layer && isMemoryLayer(input.layer) ? input.layer : "fact";
    const importance = Math.min(5, Math.max(1, input.importance ?? 3));
    const now = new Date();
    const emb = input.embedding ?? null;
    const [row] = await this.db
      .insert(memories)
      .values({
        id: newId(),
        tenantId,
        instanceId: null,
        providerId: input.providerId ?? null,
        agentId,
        userId: input.userId ?? "default",
        layer,
        content,
        tagsJson: JSON.stringify(input.tags ?? []),
        pinned: Boolean(input.pinned),
        importance: String(importance),
        source: input.source ?? "manual",
        metadataJson: JSON.stringify(input.metadata ?? {}),
        embedding: emb ?? null,
        embeddingModel: emb ? (input.embeddingModel ?? null) : null,
        embeddingDim: emb ? emb.length : null,
        contentHash: emb ? contentHash(content) : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return serializeMemory(row);
  }

  async get(tenantId: string, agentId: string, id: string) {
    const row = await this.db.query.memories.findFirst({
      where: and(
        eq(memories.id, id),
        eq(memories.tenantId, tenantId),
        eq(memories.agentId, agentId),
      ),
    });
    return row ? serializeMemory(row) : null;
  }

  async update(
    tenantId: string,
    agentId: string,
    id: string,
    patch: Partial<MemoryInput> & { content?: string },
  ) {
    const existing = await this.get(tenantId, agentId, id);
    if (!existing) throw new Error("Memory not found");

    const content =
      patch.content !== undefined ? patch.content.trim() : undefined;
    const emb = patch.embedding;
    const clearEmb = emb === null;
    const setEmb = Array.isArray(emb) && emb.length > 0;

    const [row] = await this.db
      .update(memories)
      .set({
        ...(content !== undefined ? { content } : {}),
        ...(patch.userId !== undefined ? { userId: patch.userId } : {}),
        ...(patch.layer !== undefined && isMemoryLayer(patch.layer)
          ? { layer: patch.layer }
          : {}),
        ...(patch.tags !== undefined ? { tagsJson: JSON.stringify(patch.tags) } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        ...(patch.importance !== undefined
          ? {
              importance: String(Math.min(5, Math.max(1, patch.importance))),
            }
          : {}),
        ...(patch.metadata !== undefined
          ? { metadataJson: JSON.stringify(patch.metadata) }
          : {}),
        ...(setEmb
          ? {
              embedding: emb,
              embeddingModel: patch.embeddingModel ?? existing.embeddingModel,
              embeddingDim: emb.length,
              contentHash: contentHash(content ?? existing.content),
            }
          : {}),
        ...(clearEmb
          ? {
              embedding: null,
              embeddingModel: null,
              embeddingDim: null,
              contentHash: null,
            }
          : {}),
        // content changed without new embedding → invalidate stale vector
        ...(content !== undefined && emb === undefined
          ? {
              embedding: null,
              embeddingModel: null,
              embeddingDim: null,
              contentHash: null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(memories.id, id),
          eq(memories.tenantId, tenantId),
          eq(memories.agentId, agentId),
        ),
      )
      .returning();
    return serializeMemory(row);
  }

  async remove(tenantId: string, agentId: string, id: string) {
    const existing = await this.get(tenantId, agentId, id);
    if (!existing) throw new Error("Memory not found");
    await this.db
      .delete(memories)
      .where(
        and(
          eq(memories.id, id),
          eq(memories.tenantId, tenantId),
          eq(memories.agentId, agentId),
        ),
      );
    return { ok: true as const };
  }

  async list(tenantId: string, agentId: string, opts: MemoryListOpts = {}) {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);
    const conditions = [
      eq(memories.tenantId, tenantId),
      eq(memories.agentId, agentId),
    ];
    if (opts.q?.trim()) {
      conditions.push(
        ilike(memories.content, `%${opts.q.trim().replace(/[%_]/g, "\\$&")}%`),
      );
    }
    if (opts.layer && isMemoryLayer(opts.layer)) {
      conditions.push(eq(memories.layer, opts.layer));
    }
    if (opts.userId) conditions.push(eq(memories.userId, opts.userId));
    if (opts.pinned === true) conditions.push(eq(memories.pinned, true));

    const rows = await this.db
      .select()
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.pinned), desc(memories.updatedAt))
      .limit(limit)
      .offset(offset);

    return rows.map(serializeMemory);
  }

  /** Traditional provider: return all notes (optionally truncated by char budget). */
  async dumpAll(
    tenantId: string,
    agentId: string,
    opts?: { maxChars?: number },
  ): Promise<{ text: string; count: number; truncated: boolean }> {
    const rows = await this.db
      .select()
      .from(memories)
      .where(and(eq(memories.tenantId, tenantId), eq(memories.agentId, agentId)))
      .orderBy(desc(memories.pinned), desc(memories.updatedAt))
      .limit(500);

    const maxChars = opts?.maxChars ?? 32_000;
    const parts: string[] = [];
    let used = 0;
    let truncated = false;
    for (const r of rows) {
      const line = `- ${r.content.trim()}`;
      if (used + line.length + 1 > maxChars) {
        truncated = true;
        break;
      }
      parts.push(line);
      used += line.length + 1;
    }
    return {
      text: parts.join("\n"),
      count: rows.length,
      truncated,
    };
  }

  /**
   * Keyword recall (PostgreSQL ILIKE). Always available for Built-in.
   * Prefer `hybridSearch` when embedding is enabled.
   */
  async search(tenantId: string, agentId: string, query: string, limit = 10) {
    const q = query.trim();
    if (!q) {
      const items = await this.list(tenantId, agentId, { limit, offset: 0 });
      return items.map((item) => ({
        ...item,
        score: item.pinned ? 2 : 1,
        scoreBreakdown: { keyword: item.pinned ? 2 : 1, semantic: 0 },
      }));
    }
    const tokens = keywordTokens(q);
    const phrase = `%${escapeIlike(q)}%`;
    const conditions = [
      eq(memories.tenantId, tenantId),
      eq(memories.agentId, agentId),
      or(
        ilike(memories.content, phrase),
        ...tokens.map((t) => ilike(memories.content, `%${escapeIlike(t)}%`)),
      )!,
    ];

    const rows = await this.db
      .select()
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.pinned), desc(memories.updatedAt))
      .limit(Math.min(80, Math.max(1, limit * 3)));

    return rows
      .map((r) => {
        const item = serializeMemory(r);
        const lower = r.content.toLowerCase();
        let keyword = r.pinned ? 0.15 : 0;
        if (lower.includes(q.toLowerCase())) keyword += 1;
        for (const t of tokens) {
          if (lower.includes(t.toLowerCase())) keyword += 0.25;
        }
        keyword += (Number(r.importance) || 3) * 0.05;
        // normalize-ish into 0..1+
        const score = Math.min(1.5, keyword);
        return {
          ...item,
          score,
          scoreBreakdown: { keyword: score, semantic: 0 },
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(50, Math.max(1, limit)));
  }

  /**
   * Memoh-style hybrid seed: max(semantic via pgvector, keyword) → graph 1-hop expand.
   * `queryEmbedding` optional; without it falls back to keyword+graph.
   */
  async hybridSearch(
    tenantId: string,
    agentId: string,
    query: string,
    opts?: {
      limit?: number;
      queryEmbedding?: number[] | null;
    },
  ) {
    const limit = Math.min(50, Math.max(1, opts?.limit ?? 10));
    const queryEmb = opts?.queryEmbedding ?? null;

    const keywordHits = await this.search(tenantId, agentId, query, Math.max(limit, 20));
    const scoreMap = new Map<
      string,
      {
        item: ReturnType<typeof serializeMemory>;
        score: number;
        keyword: number;
        semantic: number;
      }
    >();

    for (const hit of keywordHits) {
      scoreMap.set(hit.id, {
        item: hit,
        score: hit.score,
        keyword: hit.scoreBreakdown?.keyword ?? hit.score,
        semantic: 0,
      });
    }

    if (queryEmb && queryEmb.length > 0) {
      if (!queryEmb.every((n) => Number.isFinite(n))) {
        throw new Error("invalid query embedding");
      }
      const vecSql = sql.raw(`'${toVectorLiteral(queryEmb)}'::vector`);
      // pgvector cosine distance <=> ; similarity = 1 - distance
      const semanticRows = await this.db
        .select({
          id: memories.id,
          semantic: sql<number>`(1 - (${memories.embedding} <=> ${vecSql}))`,
        })
        .from(memories)
        .where(
          and(
            eq(memories.tenantId, tenantId),
            eq(memories.agentId, agentId),
            isNotNull(memories.embedding),
          ),
        )
        .orderBy(sql`${memories.embedding} <=> ${vecSql}`)
        .limit(Math.max(limit * 2, 24));

      for (const r of semanticRows) {
        const semantic = Number(r.semantic) || 0;
        if (semantic < 0.25) continue;
        const prev = scoreMap.get(r.id);
        let item = prev?.item;
        if (!item) {
          const full = await this.get(tenantId, agentId, r.id);
          if (!full) continue;
          item = full;
        }
        const keyword = prev?.keyword ?? (item.pinned ? 0.1 : 0);
        const score = Math.max(keyword, semantic) + (item.pinned ? 0.05 : 0);
        scoreMap.set(r.id, { item, score, keyword, semantic });
      }
    }

    const seeds = [...scoreMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const results = seeds.map((s) => ({
      ...s.item,
      score: s.score,
      scoreBreakdown: { keyword: s.keyword, semantic: s.semantic },
    }));

    if (results.length === 0) {
      return {
        results,
        relations: [] as ReturnType<typeof serializeEdge>[],
        retrievalMode: queryEmb ? ("hybrid" as const) : ("keyword_graph" as const),
      };
    }

    const seedIds = results.map((r) => r.id);
    const edgeRows = await this.db
      .select()
      .from(memoryEdges)
      .where(
        and(
          eq(memoryEdges.tenantId, tenantId),
          eq(memoryEdges.agentId, agentId),
          or(
            ...seedIds.map((id) => eq(memoryEdges.fromMemoryId, id)),
            ...seedIds.map((id) => eq(memoryEdges.toMemoryId, id)),
          )!,
        ),
      )
      .limit(100);

    const neighborIds = new Set<string>();
    for (const e of edgeRows) {
      if (!seedIds.includes(e.fromMemoryId)) neighborIds.add(e.fromMemoryId);
      if (!seedIds.includes(e.toMemoryId)) neighborIds.add(e.toMemoryId);
    }

    const extras = [];
    for (const nid of neighborIds) {
      if (results.some((r) => r.id === nid)) continue;
      const item = await this.get(tenantId, agentId, nid);
      if (item) {
        extras.push({
          ...item,
          score: 0.35,
          scoreBreakdown: { keyword: 0, semantic: 0 },
        });
      }
    }

    return {
      results: [...results, ...extras].slice(0, Math.min(50, limit + extras.length)),
      relations: edgeRows.map(serializeEdge),
      retrievalMode: queryEmb ? ("hybrid" as const) : ("keyword_graph" as const),
    };
  }

  /** @deprecated use hybridSearch — kept for call sites */
  async searchWithGraph(
    tenantId: string,
    agentId: string,
    query: string,
    limit = 10,
  ) {
    return this.hybridSearch(tenantId, agentId, query, { limit });
  }

  async setEmbedding(
    tenantId: string,
    agentId: string,
    id: string,
    embedding: number[],
    model: string,
  ) {
    const existing = await this.get(tenantId, agentId, id);
    if (!existing) throw new Error("Memory not found");
    const [row] = await this.db
      .update(memories)
      .set({
        embedding,
        embeddingModel: model,
        embeddingDim: embedding.length,
        contentHash: contentHash(existing.content),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(memories.id, id),
          eq(memories.tenantId, tenantId),
          eq(memories.agentId, agentId),
        ),
      )
      .returning();
    return serializeMemory(row);
  }

  async listMissingEmbeddings(tenantId: string, agentId: string, limit = 200) {
    const rows = await this.db
      .select()
      .from(memories)
      .where(and(eq(memories.tenantId, tenantId), eq(memories.agentId, agentId)))
      .orderBy(desc(memories.updatedAt))
      .limit(limit);
    return rows
      .filter((r) => !r.embedding || r.contentHash !== contentHash(r.content))
      .map(serializeMemory);
  }

  async embeddingStats(tenantId: string, agentId: string) {
    const rows = await this.db
      .select({
        id: memories.id,
        content: memories.content,
        contentHash: memories.contentHash,
        hasEmb: sql<boolean>`(${memories.embedding} IS NOT NULL)`,
      })
      .from(memories)
      .where(and(eq(memories.tenantId, tenantId), eq(memories.agentId, agentId)))
      .limit(2000);
    let withEmb = 0;
    let stale = 0;
    for (const r of rows) {
      if (r.hasEmb) {
        withEmb++;
        if (r.contentHash !== contentHash(r.content)) stale++;
      }
    }
    return {
      total: rows.length,
      withEmbedding: withEmb,
      missing: rows.length - withEmb,
      stale,
    };
  }

  async stats(tenantId: string, agentId: string) {
    const rows = await this.db
      .select({
        layer: memories.layer,
        n: sql<number>`count(*)::int`,
      })
      .from(memories)
      .where(and(eq(memories.tenantId, tenantId), eq(memories.agentId, agentId)))
      .groupBy(memories.layer);

    const pinnedRows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memories)
      .where(
        and(
          eq(memories.tenantId, tenantId),
          eq(memories.agentId, agentId),
          eq(memories.pinned, true),
        ),
      );

    const byLayer: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byLayer[r.layer] = r.n;
      total += r.n;
    }
    return {
      total,
      pinned: pinnedRows[0]?.n ?? 0,
      byLayer,
    };
  }

  async clear(tenantId: string, agentId: string, layer?: string) {
    const conditions = [
      eq(memories.tenantId, tenantId),
      eq(memories.agentId, agentId),
    ];
    if (layer && isMemoryLayer(layer)) conditions.push(eq(memories.layer, layer));
    await this.db.delete(memories).where(and(...conditions));
    return { ok: true as const };
  }

  async link(
    tenantId: string,
    agentId: string,
    fromId: string,
    toId: string,
    relation = "related",
  ) {
    if (fromId === toId) throw new Error("cannot link memory to itself");
    const a = await this.get(tenantId, agentId, fromId);
    const b = await this.get(tenantId, agentId, toId);
    if (!a || !b) throw new Error("Memory not found");

    const existing = await this.db.query.memoryEdges.findFirst({
      where: and(
        eq(memoryEdges.fromMemoryId, fromId),
        eq(memoryEdges.toMemoryId, toId),
        eq(memoryEdges.relation, relation),
      ),
    });
    if (existing) return serializeEdge(existing);

    const [row] = await this.db
      .insert(memoryEdges)
      .values({
        id: newId(),
        tenantId,
        agentId,
        fromMemoryId: fromId,
        toMemoryId: toId,
        relation: relation.trim() || "related",
        weight: "1",
        createdAt: new Date(),
      })
      .returning();
    return serializeEdge(row);
  }

  async unlink(tenantId: string, agentId: string, edgeId: string) {
    await this.db
      .delete(memoryEdges)
      .where(
        and(
          eq(memoryEdges.id, edgeId),
          eq(memoryEdges.tenantId, tenantId),
          eq(memoryEdges.agentId, agentId),
        ),
      );
    return { ok: true as const };
  }

  async listEdges(tenantId: string, agentId: string) {
    const rows = await this.db
      .select()
      .from(memoryEdges)
      .where(and(eq(memoryEdges.tenantId, tenantId), eq(memoryEdges.agentId, agentId)))
      .orderBy(desc(memoryEdges.createdAt))
      .limit(500);
    return rows.map(serializeEdge);
  }

  async graph(tenantId: string, agentId: string) {
    const [nodes, edges] = await Promise.all([
      this.list(tenantId, agentId, { limit: 200 }),
      this.listEdges(tenantId, agentId),
    ]);
    return { nodes, edges };
  }
}
