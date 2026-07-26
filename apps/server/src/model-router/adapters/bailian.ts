import type {
  ModelCapability,
  ModelEmbeddingResult,
  ModelRerankResult,
} from "@zakura/shared";
import type { ModelProtocolAdapter } from "../adapter.js";
import { apiError, httpJson } from "../http.js";
import type { ResolvedRoute } from "../types.js";

export type BailianRemoteModel = {
  id: string;
  name: string;
  capability: Extract<ModelCapability, "embedding" | "rerank">;
};

function timeout(route: ResolvedRoute): number {
  return route.upstream.config.timeoutMs ?? 60000;
}

function authHeaders(route: ResolvedRoute): Record<string, string> {
  const apiKey = route.upstream.config.apiKey?.trim();
  if (!apiKey) throw new Error("阿里云百炼 DashScope 需要配置 API Key");
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(route.upstream.config.extraHeaders ?? {}),
  };
}

function dashScopeBase(route: ResolvedRoute): string {
  return route.upstream.config.baseUrl.replace(/\/$/, "");
}

/** 从 baseUrl 解析 DashScope 站点根（兼容 api/v1 与自定义路径） */
export function dashScopeOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl
      .replace(/\/api\/v1\/?$/i, "")
      .replace(/\/compatible-mode\/v1\/?$/i, "")
      .replace(/\/$/, "");
  }
}

/**
 * 从模型名推断百炼适配器支持的能力。
 * 例：qwen3.7-text-embedding → embedding；qwen3-rerank → rerank
 */
export function inferBailianCapability(
  modelId: string,
): Extract<ModelCapability, "embedding" | "rerank"> | null {
  const s = modelId.trim().toLowerCase();
  if (!s) return null;
  if (/(?:^|[-_.])rerank(?:$|[-_.])|ranker/.test(s) || s.includes("rerank")) {
    return "rerank";
  }
  if (s.includes("embed") || s.includes("embedding")) {
    return "embedding";
  }
  return null;
}

function upsertModel(
  byId: Map<string, BailianRemoteModel>,
  idRaw: string,
  name?: string,
) {
  const id = idRaw.trim();
  if (!id || byId.has(id)) return;
  // 百炼适配器仅 embedding / rerank，其它类型（chat 等）直接丢弃
  const capability = inferBailianCapability(id);
  if (!capability) return;
  byId.set(id, {
    id,
    name: (name ?? id).trim() || id,
    capability,
  });
}

/**
 * 仅从 DashScope 官方接口实时拉取 Embedding / Rerank 并去重（无本地硬编码模型表）：
 * 1) GET /compatible-mode/v1/models
 * 2) GET /api/v1/deployments/models（base + custom，分页）
 * chat 等非 embedding/rerank 模型会被过滤。
 */
export async function listBailianRemoteModels(opts: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<{ models: BailianRemoteModel[]; message?: string }> {
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) throw new Error("阿里云百炼 DashScope 需要配置 API Key");

  const origin = dashScopeOrigin(opts.baseUrl);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const timeoutMs = opts.timeoutMs ?? 20000;
  const byId = new Map<string, BailianRemoteModel>();
  const sources: string[] = [];
  const errors: string[] = [];
  let compatibleTotal = 0;
  let compatibleKept = 0;
  let deploymentsTotal = 0;
  let deploymentsKept = 0;

  // 1) compatible-mode /models
  try {
    const res = await fetch(`${origin}/compatible-mode/v1/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => null)) as {
      data?: Array<{ id?: string; model?: string; model_name?: string }>;
      error?: { message?: string };
      message?: string;
    } | null;
    if (res.ok) {
      const rows = Array.isArray(data?.data) ? data.data : [];
      compatibleTotal = rows.length;
      for (const m of rows) {
        const id =
          (typeof m.id === "string" && m.id) ||
          (typeof m.model === "string" && m.model) ||
          (typeof m.model_name === "string" && m.model_name) ||
          "";
        const before = byId.size;
        upsertModel(byId, id, id);
        if (byId.size > before) compatibleKept += 1;
      }
      sources.push(`compatible-mode:${compatibleKept}/${compatibleTotal}`);
    } else {
      const err =
        data?.error?.message ?? data?.message ?? `HTTP ${res.status}`;
      errors.push(`compatible-mode: ${err}`);
      console.warn(`[bailian-sync] compatible-mode/models ${err}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`compatible-mode: ${msg}`);
    console.warn(`[bailian-sync] compatible-mode/models failed: ${msg}`);
  }

  // 2) deployments/models（系统 + 自定义）
  for (const modelSource of ["base", "custom"] as const) {
    let page = 1;
    let fetchedAny = false;
    let sourceTotal = 0;
    let sourceKept = 0;
    while (page <= 30) {
      const url = new URL(`${origin}/api/v1/deployments/models`);
      url.searchParams.set("page_no", String(page));
      url.searchParams.set("page_size", "100");
      url.searchParams.set("model_source", modelSource);
      url.searchParams.set("version", "v1.0");
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: { ...headers, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = (await res.json().catch(() => null)) as {
          output?: {
            models?: Array<{ model_name?: string; model?: string }>;
            page_no?: number;
            page_size?: number;
            total?: number;
          };
          models?: Array<{ model_name?: string; model?: string }>;
          code?: string;
          message?: string;
        } | null;
        if (!res.ok) {
          const err = data?.message ?? data?.code ?? `HTTP ${res.status}`;
          errors.push(`deployments/${modelSource}: ${err}`);
          console.warn(
            `[bailian-sync] deployments/models(${modelSource}) ${err}`,
          );
          break;
        }
        const rows = data?.output?.models ?? data?.models ?? [];
        if (rows.length === 0) break;
        fetchedAny = true;
        for (const m of rows) {
          const id =
            (typeof m.model_name === "string" && m.model_name) ||
            (typeof m.model === "string" && m.model) ||
            "";
          sourceTotal += 1;
          const before = byId.size;
          upsertModel(byId, id, id);
          if (byId.size > before) sourceKept += 1;
        }
        const pageSize = data?.output?.page_size ?? 100;
        if (rows.length < pageSize) break;
        page += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`deployments/${modelSource}: ${msg}`);
        console.warn(
          `[bailian-sync] deployments/models(${modelSource}) failed: ${msg}`,
        );
        break;
      }
    }
    if (fetchedAny) {
      deploymentsTotal += sourceTotal;
      deploymentsKept += sourceKept;
      sources.push(`deployments:${modelSource}:${sourceKept}/${sourceTotal}`);
    }
  }

  const models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (models.length === 0) {
    const detail = errors.length > 0 ? errors.join("；") : "官方接口未返回 Embedding/Rerank 模型";
    console.warn(`[bailian-sync] empty: ${detail}`);
    return {
      models: [],
      message: `DashScope 未返回 Embedding/Rerank 模型：${detail}`,
    };
  }

  const message = `DashScope 实时拉取 Embedding/Rerank 并去重：共 ${models.length} 个（${sources.join(" · ")}）`;
  console.info(
    `[bailian-sync] ${message}; compatible=${compatibleKept}/${compatibleTotal}, deployments=${deploymentsKept}/${deploymentsTotal}`,
  );
  return { models, message };
}

/**
 * DashScope 原生 Text Embedding：
 * POST /api/v1/services/embeddings/text-embedding/text-embedding
 */
async function embed(
  route: ResolvedRoute,
  texts: string[],
): Promise<ModelEmbeddingResult> {
  const body: Record<string, unknown> = {
    model: route.model,
    input: { texts },
  };
  if (route.options.dimensions) {
    body.parameters = { dimension: route.options.dimensions };
  }

  const res = await httpJson<{
    output?: {
      embeddings?: Array<{ embedding?: number[]; text_index?: number }>;
    };
    code?: string;
    message?: string;
  }>(`${dashScopeBase(route)}/services/embeddings/text-embedding/text-embedding`, {
    method: "POST",
    headers: authHeaders(route),
    body: JSON.stringify(body),
    timeoutMs: timeout(route),
  });

  if (!res.ok) {
    const msg =
      res.data?.message ??
      (res.data as { error?: { message?: string } } | null)?.error?.message ??
      res.text;
    throw apiError("dashscope embedding", res.status, res.data, msg || res.text);
  }
  if (res.data?.code && res.data.code !== "Success") {
    throw new Error(`dashscope embedding: ${res.data.message ?? res.data.code}`);
  }

  const rows = [...(res.data?.output?.embeddings ?? [])].sort(
    (a, b) => (a.text_index ?? 0) - (b.text_index ?? 0),
  );
  if (rows.length !== texts.length) {
    throw new Error(
      `embedding count mismatch: expected ${texts.length}, got ${rows.length}`,
    );
  }

  return {
    vectors: rows.map((r) => {
      const v = r.embedding;
      if (!Array.isArray(v) || v.length === 0) {
        throw new Error("dashscope embedding response missing vector");
      }
      return v.map(Number);
    }),
    model: route.model,
  };
}

/**
 * DashScope 原生 Text Rerank：
 * POST /api/v1/services/rerank/text-rerank/text-rerank
 */
async function rerank(
  route: ResolvedRoute,
  query: string,
  documents: string[],
): Promise<ModelRerankResult> {
  const parameters: Record<string, unknown> = {
    return_documents: true,
  };
  if (route.options.topN != null) parameters.top_n = route.options.topN;
  if (route.options.instruct) parameters.instruct = route.options.instruct;

  const body = {
    model: route.model,
    input: { query, documents },
    parameters,
  };

  const res = await httpJson<{
    output?: {
      results?: Array<{
        index?: number;
        relevance_score?: number;
        document?: { text?: string } | string;
      }>;
    };
    code?: string;
    message?: string;
  }>(`${dashScopeBase(route)}/services/rerank/text-rerank/text-rerank`, {
    method: "POST",
    headers: authHeaders(route),
    body: JSON.stringify(body),
    timeoutMs: timeout(route),
  });

  if (!res.ok) {
    const msg =
      res.data?.message ??
      (res.data as { error?: { message?: string } } | null)?.error?.message ??
      res.text;
    throw apiError("dashscope rerank", res.status, res.data, msg || res.text);
  }
  if (res.data?.code && res.data.code !== "Success") {
    throw new Error(`dashscope rerank: ${res.data.message ?? res.data.code}`);
  }

  const results = res.data?.output?.results ?? [];
  return {
    results: results.map((r, i) => {
      const idx = r.index ?? i;
      const doc = r.document;
      const text =
        typeof doc === "string"
          ? doc
          : doc?.text ?? documents[idx];
      return {
        index: idx,
        score: r.relevance_score ?? 0,
        text,
      };
    }),
    model: route.model,
  };
}

/** 阿里云百炼 DashScope：仅 embedding + rerank */
export const bailianAdapter: ModelProtocolAdapter = {
  protocol: "bailian",
  supportedCapabilities: ["embedding", "rerank"],
  embed,
  rerank,
};
