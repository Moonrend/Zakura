import { and, asc, eq, like, or, sql } from "drizzle-orm";
import {
  MODEL_CATALOG_SOURCES,
  normalizeCanonicalModelId,
  type ModelCapability,
  type ModelCatalogEntry,
  type ModelCatalogSource,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import { modelCatalogEntries, newId } from "../db/schema.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const LLM_METADATA_URL = "https://basellm.github.io/llm-metadata/api/all.json";

function inferCapabilities(model: Record<string, unknown>): ModelCapability[] {
  const caps = new Set<ModelCapability>();
  const id = String(model.id ?? "").toLowerCase();
  const name = String(model.name ?? "").toLowerCase();
  const modalities = model.modalities as
    | { input?: string[]; output?: string[] }
    | undefined;
  const outputs = modalities?.output ?? [];

  if (
    id.includes("embed") ||
    name.includes("embed") ||
    id.includes("embedding") ||
    name.includes("embedding")
  ) {
    caps.add("embedding");
  }
  if (
    id.includes("rerank") ||
    name.includes("rerank") ||
    id.includes("ranker") ||
    name.includes("ranker")
  ) {
    caps.add("rerank");
  }
  if (
    outputs.includes("image") ||
    id.includes("dall-e") ||
    id.includes("imagen") ||
    id.includes("flux") ||
    name.includes("image")
  ) {
    caps.add("image");
  }
  if (caps.size === 0 || outputs.includes("text") || !outputs.length) {
    if (!caps.has("embedding") && !caps.has("rerank")) {
      caps.add("chat");
    }
  }
  return [...caps];
}

function normalizeEntry(
  source: ModelCatalogSource,
  providerId: string,
  providerName: string,
  modelId: string,
  model: Record<string, unknown>,
  providerMeta?: Record<string, unknown>,
): ModelCatalogEntry {
  const cost = model.cost as ModelCatalogEntry["cost"] | undefined;
  const limit = model.limit as { context?: number; output?: number } | undefined;
  const modalities = model.modalities as ModelCatalogEntry["modalities"] | undefined;
  return {
    source,
    providerId,
    providerName,
    modelId,
    name: typeof model.name === "string" ? model.name : modelId,
    description: typeof model.description === "string" ? model.description : undefined,
    family: typeof model.family === "string" ? model.family : undefined,
    capabilities: inferCapabilities({ ...model, id: modelId }),
    reasoning: model.reasoning === true,
    toolCall: model.tool_call === true || model.toolCall === true,
    attachment: model.attachment === true,
    openWeights: model.open_weights === true || model.openWeights === true,
    contextLimit: limit?.context,
    outputLimit: limit?.output,
    modalities,
    cost,
    releaseDate:
      typeof model.release_date === "string"
        ? model.release_date
        : typeof model.releaseDate === "string"
          ? model.releaseDate
          : undefined,
    knowledge: typeof model.knowledge === "string" ? model.knowledge : undefined,
    apiBase: typeof providerMeta?.api === "string" ? providerMeta.api : undefined,
    npm: typeof providerMeta?.npm === "string" ? providerMeta.npm : undefined,
  };
}

/** 解析 models.dev /api.json：{ [providerId]: { id, name, api, models: { [id]: {...} } } } */
export function parseModelsDevPayload(data: unknown): ModelCatalogEntry[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, Record<string, unknown>>;
  const out: ModelCatalogEntry[] = [];
  for (const [providerId, provider] of Object.entries(root)) {
    if (!provider || typeof provider !== "object") continue;
    const providerName =
      typeof provider.name === "string" ? provider.name : providerId;
    const models = provider.models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, model] of Object.entries(
      models as Record<string, Record<string, unknown>>,
    )) {
      if (!model || typeof model !== "object") continue;
      out.push(
        normalizeEntry(
          "models.dev",
          providerId,
          providerName,
          typeof model.id === "string" ? model.id : modelId,
          model,
          provider,
        ),
      );
    }
  }
  return out;
}

/**
 * llm-metadata /api/all.json 可能是：
 * - { providers: [...], models: [...] }
 * - 或与 models.dev 类似的 provider map
 */
export function parseLlmMetadataPayload(data: unknown): ModelCatalogEntry[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;

  if (Array.isArray(root.models)) {
    const providers = Array.isArray(root.providers)
      ? (root.providers as Array<Record<string, unknown>>)
      : [];
    const providerMap = new Map(
      providers.map((p) => [
        String(p.id ?? ""),
        {
          name: String(p.name ?? p.id ?? ""),
          api: typeof p.api === "string" ? p.api : undefined,
          npm: typeof p.npm === "string" ? p.npm : undefined,
        },
      ]),
    );
    const out: ModelCatalogEntry[] = [];
    for (const m of root.models as Array<Record<string, unknown>>) {
      const providerId = String(m.provider ?? m.providerId ?? "unknown");
      const modelId = String(m.id ?? "");
      if (!modelId) continue;
      const pmeta = providerMap.get(providerId);
      out.push(
        normalizeEntry(
          "llm-metadata",
          providerId,
          pmeta?.name ?? providerId,
          modelId,
          m,
          pmeta,
        ),
      );
    }
    return out;
  }

  // 兼容 provider-map 形态
  return parseModelsDevPayload(data).map((e) => ({
    ...e,
    source: "llm-metadata" as const,
  }));
}

export class ModelCatalogService {
  constructor(private readonly db: Db) {}

  sources() {
    return MODEL_CATALOG_SOURCES.map((source) => ({
      source,
      name: source === "models.dev" ? "models.dev" : "LLM Metadata",
      url: source === "models.dev" ? MODELS_DEV_URL : LLM_METADATA_URL,
    }));
  }

  async list(
    tenantId: string,
    opts?: {
      source?: ModelCatalogSource;
      providerId?: string;
      q?: string;
      capability?: ModelCapability;
      limit?: number;
      offset?: number;
    },
  ) {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const offset = opts?.offset ?? 0;
    const conditions = [eq(modelCatalogEntries.tenantId, tenantId)];
    if (opts?.source) conditions.push(eq(modelCatalogEntries.source, opts.source));
    if (opts?.providerId) {
      conditions.push(eq(modelCatalogEntries.providerId, opts.providerId));
    }
    if (opts?.q?.trim()) {
      const q = `%${opts.q.trim()}%`;
      conditions.push(
        or(
          like(modelCatalogEntries.name, q),
          like(modelCatalogEntries.modelId, q),
          like(modelCatalogEntries.providerName, q),
        )!,
      );
    }

    const rows = await this.db
      .select()
      .from(modelCatalogEntries)
      .where(and(...conditions))
      .orderBy(asc(modelCatalogEntries.providerName), asc(modelCatalogEntries.name))
      .limit(limit)
      .offset(offset);

    let entries = rows.map((r) => {
      const meta = JSON.parse(r.metaJson) as ModelCatalogEntry;
      return { ...meta, id: r.id, updatedAt: r.updatedAt };
    });

    if (opts?.capability) {
      entries = entries.filter((e) => e.capabilities.includes(opts.capability!));
    }

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(modelCatalogEntries)
      .where(and(...conditions));

    return { entries, total: count ?? entries.length, limit, offset };
  }

  async providers(tenantId: string, source?: ModelCatalogSource) {
    const conditions = [eq(modelCatalogEntries.tenantId, tenantId)];
    if (source) conditions.push(eq(modelCatalogEntries.source, source));
    const rows = await this.db
      .select({
        providerId: modelCatalogEntries.providerId,
        providerName: modelCatalogEntries.providerName,
        source: modelCatalogEntries.source,
        count: sql<number>`count(*)::int`,
      })
      .from(modelCatalogEntries)
      .where(and(...conditions))
      .groupBy(
        modelCatalogEntries.providerId,
        modelCatalogEntries.providerName,
        modelCatalogEntries.source,
      )
      .orderBy(asc(modelCatalogEntries.providerName));
    return rows;
  }

  async importFrom(
    tenantId: string,
    source: ModelCatalogSource,
  ): Promise<{ imported: number; source: ModelCatalogSource }> {
    const url = source === "models.dev" ? MODELS_DEV_URL : LLM_METADATA_URL;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      throw new Error(`拉取 ${source} 失败: HTTP ${res.status}`);
    }
    const data = await res.json();
    const entries =
      source === "models.dev"
        ? parseModelsDevPayload(data)
        : parseLlmMetadataPayload(data);

    if (entries.length === 0) {
      throw new Error(`${source} 未解析到模型条目`);
    }

    // 先清同 source 旧数据，再批量写入
    await this.db
      .delete(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.tenantId, tenantId),
          eq(modelCatalogEntries.source, source),
        ),
      );

    const now = new Date();
    const chunkSize = 200;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      await this.db.insert(modelCatalogEntries).values(
        chunk.map((e) => ({
          id: newId(),
          tenantId,
          source: e.source,
          providerId: e.providerId,
          providerName: e.providerName,
          modelId: e.modelId,
          name: e.name,
          metaJson: JSON.stringify(e),
          createdAt: now,
          updatedAt: now,
        })),
      );
    }

    return { imported: entries.length, source };
  }

  async clear(tenantId: string, source?: ModelCatalogSource) {
    if (source) {
      await this.db
        .delete(modelCatalogEntries)
        .where(
          and(
            eq(modelCatalogEntries.tenantId, tenantId),
            eq(modelCatalogEntries.source, source),
          ),
        );
    } else {
      await this.db
        .delete(modelCatalogEntries)
        .where(eq(modelCatalogEntries.tenantId, tenantId));
    }
  }

  /**
   * 按模型 id/名称匹配元数据（与目录「原始提供商」无关）。
   * 同一 modelId 可能在多个 metadata provider 下出现，按精确匹配优先，再模糊。
   */
  async match(
    tenantId: string,
    modelQuery: string,
    opts?: { source?: ModelCatalogSource; limit?: number },
  ) {
    const q = modelQuery.trim();
    if (!q) return { matches: [] as Array<ModelCatalogEntry & { id: string; score: number }> };

    const conditions = [eq(modelCatalogEntries.tenantId, tenantId)];
    if (opts?.source) conditions.push(eq(modelCatalogEntries.source, opts.source));

    const qNorm = normalizeCanonicalModelId(q);
    const exact = await this.db
      .select()
      .from(modelCatalogEntries)
      .where(and(...conditions, eq(modelCatalogEntries.modelId, q)))
      .limit(opts?.limit ?? 20);

    if (exact.length > 0) {
      return {
        matches: exact.map((r) => ({
          ...(JSON.parse(r.metaJson) as ModelCatalogEntry),
          id: r.id,
          score: 1,
        })),
      };
    }

    // 大小写不敏感精确匹配
    const caseInsensitive = await this.db
      .select()
      .from(modelCatalogEntries)
      .where(
        and(
          ...conditions,
          sql`lower(${modelCatalogEntries.modelId}) = ${q.toLowerCase()}`,
        ),
      )
      .limit(opts?.limit ?? 20);

    if (caseInsensitive.length > 0) {
      return {
        matches: caseInsensitive.map((r) => ({
          ...(JSON.parse(r.metaJson) as ModelCatalogEntry),
          id: r.id,
          score: 1,
        })),
      };
    }

    // 规范名匹配（忽略 _ / - / 空格差异）
    if (qNorm) {
      const normRows = await this.db
        .select()
        .from(modelCatalogEntries)
        .where(
          and(
            ...conditions,
            sql`lower(replace(replace(replace(${modelCatalogEntries.modelId}, '_', '-'), ' ', '-'), '/', '-')) = ${qNorm}`,
          ),
        )
        .limit(opts?.limit ?? 20);
      if (normRows.length > 0) {
        return {
          matches: normRows.map((r) => ({
            ...(JSON.parse(r.metaJson) as ModelCatalogEntry),
            id: r.id,
            score: 0.98,
          })),
        };
      }
    }

    const likeQ = `%${q}%`;
    const fuzzy = await this.db
      .select()
      .from(modelCatalogEntries)
      .where(
        and(
          ...conditions,
          or(
            like(modelCatalogEntries.modelId, likeQ),
            like(modelCatalogEntries.name, likeQ),
          )!,
        ),
      )
      .orderBy(asc(modelCatalogEntries.modelId))
      .limit(opts?.limit ?? 20);

    return {
      matches: fuzzy.map((r) => {
        const meta = JSON.parse(r.metaJson) as ModelCatalogEntry;
        const idLower = meta.modelId.toLowerCase();
        const qLower = q.toLowerCase();
        const idNorm = normalizeCanonicalModelId(meta.modelId);
        const score =
          idLower === qLower || idNorm === qNorm
            ? 1
            : idNorm.endsWith(`/${qNorm}`) || idNorm.endsWith(`-${qNorm}`)
              ? 0.9
              : idLower.includes(qLower) || idNorm.includes(qNorm)
                ? 0.7
                : 0.5;
        return { ...meta, id: r.id, score };
      }),
    };
  }

  /** 取最佳匹配（score >= 0.7），供同步规范名使用 */
  async matchBest(
    tenantId: string,
    modelQuery: string,
  ): Promise<(ModelCatalogEntry & { id: string; score: number }) | null> {
    const { matches } = await this.match(tenantId, modelQuery, { limit: 5 });
    const best = matches[0];
    if (!best || best.score < 0.7) return null;
    return best;
  }

  /** 刷新全部元数据源（后台缓存，非用户管理对象） */
  async refreshAll(tenantId: string) {
    const results: Array<{ imported: number; source: ModelCatalogSource }> = [];
    for (const source of MODEL_CATALOG_SOURCES) {
      results.push(await this.importFrom(tenantId, source));
    }
    return {
      results,
      imported: results.reduce((n, r) => n + r.imported, 0),
    };
  }
}
