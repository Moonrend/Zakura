import { createHash } from "node:crypto";

/**
 * OpenAI-compatible embeddings client for Built-in memory semantic seeds.
 * Mirrors Memoh's optional pgvector path: embedding is optional; keyword+graph
 * still works when disabled. Vectors use the `vector` extension (PGlite + Postgres).
 */

export type EmbeddingConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Optional output dimensions (e.g. text-embedding-3-* supports this) */
  dimensions?: number;
};

export function parseEmbeddingConfig(
  config: Record<string, unknown>,
): EmbeddingConfig | null {
  const raw = config.embedding;
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.enabled !== true) return null;
  const baseUrl = typeof e.baseUrl === "string" ? e.baseUrl.trim().replace(/\/$/, "") : "";
  const model = typeof e.model === "string" ? e.model.trim() : "";
  if (!baseUrl || !model) return null;
  const dimensions =
    typeof e.dimensions === "number" && e.dimensions > 0
      ? Math.floor(e.dimensions)
      : undefined;
  return {
    enabled: true,
    baseUrl,
    apiKey: typeof e.apiKey === "string" ? e.apiKey : undefined,
    model,
    dimensions,
  };
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export async function embedTexts(
  cfg: EmbeddingConfig,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const url = `${cfg.baseUrl}/embeddings`;
  const body: Record<string, unknown> = {
    model: cfg.model,
    input: texts.length === 1 ? texts[0] : texts,
  };
  if (cfg.dimensions) body.dimensions = cfg.dimensions;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = (await res.json().catch(() => null)) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
    error?: { message?: string };
  } | null;
  if (!res.ok) {
    throw new Error(
      `embedding failed HTTP ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 300)}`,
    );
  }
  const rows = [...(data?.data ?? [])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  if (rows.length !== texts.length) {
    throw new Error(
      `embedding count mismatch: expected ${texts.length}, got ${rows.length}`,
    );
  }
  return rows.map((r) => {
    const v = r.embedding;
    if (!Array.isArray(v) || v.length === 0) {
      throw new Error("embedding response missing vector");
    }
    return v.map(Number);
  });
}

export async function embedText(
  cfg: EmbeddingConfig,
  text: string,
): Promise<number[]> {
  const [v] = await embedTexts(cfg, [text]);
  return v!;
}
