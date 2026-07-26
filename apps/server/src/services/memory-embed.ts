import {
  contentHash,
  embedText,
  parseEmbeddingConfig,
  type EmbeddingConfig,
} from "./embedding-client.js";
import type { ModelRouterService } from "./model-router.js";
import type { MemoryInput } from "./memory-store.js";
import type { MemoryStore } from "./memory-store.js";

export function embeddingConfigFromProvider(
  config: Record<string, unknown>,
): EmbeddingConfig | null {
  return parseEmbeddingConfig(config);
}

async function embedContent(
  cfg: EmbeddingConfig,
  content: string,
  tenantId: string | undefined,
  router: ModelRouterService | null | undefined,
): Promise<{ vector: number[]; model: string }> {
  const preferRouter =
    Boolean(tenantId && router) &&
    (Boolean(cfg.routeId || cfg.routeSlug) || !cfg.baseUrl.trim());

  if (preferRouter && tenantId && router) {
    const result = await router.embed(tenantId, [content.trim()], {
      capability: "embedding",
      routeId: cfg.routeId,
      slug: cfg.routeSlug,
    });
    const vector = result.vectors[0];
    if (!vector?.length) throw new Error("embedding response missing vector");
    return { vector, model: result.model };
  }
  if (!cfg.baseUrl.trim()) {
    throw new Error("未配置 embedding 模型路由，且无可用 Base URL");
  }
  const vector = await embedText(cfg, content.trim());
  return { vector, model: cfg.model };
}

/** Best-effort embed for write path; never blocks write on failure (caller may log). */
export async function withEmbedding(
  input: MemoryInput,
  providerConfig: Record<string, unknown> | null | undefined,
  opts?: { tenantId?: string; modelRouter?: ModelRouterService | null },
): Promise<{ input: MemoryInput; embeddingError?: string }> {
  const cfg = providerConfig ? parseEmbeddingConfig(providerConfig) : null;
  if (!cfg) return { input };

  try {
    const { vector, model } = await embedContent(
      cfg,
      input.content,
      opts?.tenantId,
      opts?.modelRouter,
    );
    return {
      input: {
        ...input,
        embedding: vector,
        embeddingModel: model,
      },
    };
  } catch (err) {
    return {
      input,
      embeddingError: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function reembedAgentMemories(
  store: MemoryStore,
  tenantId: string,
  agentId: string,
  cfg: EmbeddingConfig,
  opts?: { limit?: number; modelRouter?: ModelRouterService | null },
): Promise<{ updated: number; failed: number; errors: string[] }> {
  const missing = await store.listMissingEmbeddings(
    tenantId,
    agentId,
    opts?.limit ?? 100,
  );
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const m of missing) {
    try {
      const { vector, model } = await embedContent(
        cfg,
        m.content,
        tenantId,
        opts?.modelRouter,
      );
      await store.setEmbedding(tenantId, agentId, m.id, vector, model);
      updated++;
    } catch (err) {
      failed++;
      errors.push(
        `${m.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (errors.length >= 5) break;
    }
  }
  return { updated, failed, errors };
}

export { contentHash, embedText, parseEmbeddingConfig };
export type { EmbeddingConfig };
