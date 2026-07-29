import { and, asc, eq, like, or, sql } from "drizzle-orm";
import {
  MODEL_CATALOG_SOURCES,
  normalizeCanonicalModelId,
  type ModelCapability,
  type ModelCatalogEntry,
  type ModelCatalogSource,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  modelCatalogEntries,
  newId,
  type ModelCatalogEntryRow,
} from "../db/schema.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const LLM_METADATA_URL = "https://basellm.github.io/llm-metadata/api/all.json";

function inferCapabilities(model: Record<string, unknown>): ModelCapability[] {
  const caps = new Set<ModelCapability>();
  const id = String(model.id ?? "").toLowerCase();
  const name = String(model.name ?? "").toLowerCase();
  const modalities = model.modalities as
    | { input?: string[]; output?: string[] }
    | undefined;
  const inputs = (modalities?.input ?? []).map((m) => String(m).toLowerCase());
  const outputs = (modalities?.output ?? []).map((m) => String(m).toLowerCase());

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
  if (inputs.includes("image") || outputs.includes("text")) {
    if (!caps.has("embedding") && !caps.has("rerank")) {
      caps.add("chat");
    }
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
  const reasoningOptions = parseReasoningOptions(model.reasoning_options);
  const reasoningLevelsRaw =
    model.reasoningLevels ?? model.reasoning_levels ?? reasoningOptions.levels;
  const reasoningLevels = Array.isArray(reasoningLevelsRaw)
    ? reasoningLevelsRaw.map(String).filter(Boolean)
    : undefined;
  const defaultReasonLevel =
    typeof model.defaultReasonLevel === "string"
      ? model.defaultReasonLevel
      : typeof model.default_reason_level === "string"
        ? model.default_reason_level
        : reasoningOptions.defaultLevel;
  return {
    source,
    providerId,
    providerName,
    modelId,
    name: typeof model.name === "string" ? model.name : modelId,
    description: typeof model.description === "string" ? model.description : undefined,
    family: typeof model.family === "string" ? model.family : undefined,
    capabilities: inferCapabilities({ ...model, id: modelId }),
    reasoning: model.reasoning === true || Boolean(reasoningLevels?.length),
    reasoningLevels,
    defaultReasonLevel,
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
    raw: model,
  };
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function parseReasoningOptions(raw: unknown): {
  levels?: string[];
  defaultLevel?: string;
} {
  if (!Array.isArray(raw)) return {};
  const levels: string[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    if (item.type === "toggle" && !levels.includes("none")) {
      levels.push("none");
    }
    if (item.type === "effort" && Array.isArray(item.values)) {
      for (const value of item.values) {
        const level = String(value).trim();
        if (level && !levels.includes(level)) levels.push(level);
      }
    }
  }
  return {
    ...(levels.length ? { levels } : {}),
    ...(levels.includes("auto") ? { defaultLevel: "auto" } : {}),
  };
}

type CatalogMatchHints = {
  source?: ModelCatalogSource;
  limit?: number;
  providerId?: string;
  providerName?: string;
  apiBase?: string;
};

function lastSlashSegment(raw: string): string | null {
  const trimmed = raw.trim();
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return null;
  const segment = trimmed.slice(idx + 1).trim();
  return segment && segment !== trimmed ? segment : null;
}

function normalizeUrlForMatch(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return raw.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function sameApiBase(a?: string, b?: string): boolean {
  const aa = normalizeUrlForMatch(a);
  const bb = normalizeUrlForMatch(b);
  if (!aa || !bb) return false;
  return aa === bb || aa.startsWith(`${bb}/`) || bb.startsWith(`${aa}/`);
}

function hintRank(entry: ModelCatalogEntry, opts?: CatalogMatchHints): number {
  let score = 0;
  if (opts?.apiBase && sameApiBase(entry.apiBase, opts.apiBase)) score += 40;
  const providerId = opts?.providerId?.trim().toLowerCase();
  if (providerId && entry.providerId.toLowerCase() === providerId) score += 20;
  const providerName = opts?.providerName?.trim().toLowerCase();
  if (providerName) {
    const name = entry.providerName.toLowerCase();
    if (name === providerName) score += 12;
    else if (name.includes(providerName) || providerName.includes(name)) score += 6;
  }
  if (entry.reasoningLevels?.length) score += 2;
  if (entry.raw && Object.keys(entry.raw).length > 0) score += 1;
  return score;
}

function rowsToRankedMatches(
  rows: ModelCatalogEntryRow[],
  opts: CatalogMatchHints | undefined,
  score: number | ((entry: ModelCatalogEntry) => number),
) {
  return rows
    .map((r) => {
      const meta = JSON.parse(r.metaJson) as ModelCatalogEntry;
      return {
        ...meta,
        id: r.id,
        score: typeof score === "function" ? score(meta) : score,
        __rank: hintRank(meta, opts),
      };
    })
    .sort((a, b) => b.__rank - a.__rank || a.providerName.localeCompare(b.providerName))
    .map(({ __rank: _rank, ...item }) => item);
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
  private readonly ensureInFlight = new Map<string, Promise<void>>();

  constructor(private readonly db: Db) {}

  sources() {
    return MODEL_CATALOG_SOURCES.map((source) => ({
      source,
      name: source === "models.dev" ? "models.dev" : "LLM Metadata",
      url:
        source === "models.dev"
          ? MODELS_DEV_URL
          : LLM_METADATA_URL,
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

  private async countSource(
    tenantId: string,
    source: ModelCatalogSource,
  ): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.tenantId, tenantId),
          eq(modelCatalogEntries.source, source),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /**
   * 懒加载模型元数据目录。同步上游模型/匹配规范名时，租户还没有
   * models.dev 或 llm-metadata 缓存就自动拉取，避免必须先手动刷新。
   */
  async ensureTenantCatalog(tenantId: string): Promise<void> {
    const existing = this.ensureInFlight.get(tenantId);
    if (existing) return existing;

    const task = (async () => {
      const errors: string[] = [];
      for (const source of MODEL_CATALOG_SOURCES) {
        const count = await this.countSource(tenantId, source);
        if (count > 0) continue;
        try {
          await this.importFrom(tenantId, source);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${source}: ${message}`);
          console.warn(`[model-catalog] auto import ${source} failed:`, message);
        }
      }
      if (errors.length === MODEL_CATALOG_SOURCES.length) {
        console.warn(`[model-catalog] auto import skipped matching: ${errors.join("; ")}`);
      }
    })();

    this.ensureInFlight.set(tenantId, task);
    try {
      await task;
    } finally {
      this.ensureInFlight.delete(tenantId);
    }
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
    opts?: CatalogMatchHints,
  ) {
    const q = modelQuery.trim();
    if (!q) return { matches: [] as Array<ModelCatalogEntry & { id: string; score: number }> };

    await this.ensureTenantCatalog(tenantId);

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
        matches: rowsToRankedMatches(exact, opts, 1),
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
        matches: rowsToRankedMatches(caseInsensitive, opts, 1),
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
          matches: rowsToRankedMatches(normRows, opts, 0.98),
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
      matches: rowsToRankedMatches(fuzzy, opts, (meta) => {
        const idLower = meta.modelId.toLowerCase();
        const qLower = q.toLowerCase();
        const idNorm = normalizeCanonicalModelId(meta.modelId);
        return (
          idLower === qLower || idNorm === qNorm
            ? 1
            : idNorm.endsWith(`/${qNorm}`) || idNorm.endsWith(`-${qNorm}`)
              ? 0.9
              : idLower.includes(qLower) || idNorm.includes(qNorm)
                ? 0.7
                : 0.5
        );
      }),
    };
  }

  /** 取最佳匹配（score >= 0.7），供同步规范名使用 */
  async matchBest(
    tenantId: string,
    modelQuery: string,
    opts?: Omit<CatalogMatchHints, "limit">,
  ): Promise<(ModelCatalogEntry & { id: string; score: number }) | null> {
    const pickBest = async (query: string) => {
      const { matches } = await this.match(tenantId, query, { ...opts, limit: 5 });
      const best = matches[0];
      return best && best.score >= 0.7 ? best : null;
    };

    const best = await pickBest(modelQuery);
    const fallbackQuery = lastSlashSegment(modelQuery);
    if (!fallbackQuery || (best && best.score >= 0.98)) return best;

    const fallbackBest = await pickBest(fallbackQuery);
    if (fallbackBest && (!best || fallbackBest.score >= best.score)) {
      return fallbackBest;
    }
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
