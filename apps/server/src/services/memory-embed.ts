import {
  contentHash,
  embedText,
  parseEmbeddingConfig,
  type EmbeddingConfig,
} from "./embedding-client.js";
import type { MemoryInput } from "./memory-store.js";
import type { MemoryStore } from "./memory-store.js";

export function embeddingConfigFromProvider(
  config: Record<string, unknown>,
): EmbeddingConfig | null {
  return parseEmbeddingConfig(config);
}

/** Best-effort embed for write path; never blocks write on failure (caller may log). */
export async function withEmbedding(
  input: MemoryInput,
  providerConfig: Record<string, unknown> | null | undefined,
): Promise<{ input: MemoryInput; embeddingError?: string }> {
  const cfg = providerConfig ? parseEmbeddingConfig(providerConfig) : null;
  if (!cfg) return { input };

  try {
    const vector = await embedText(cfg, input.content.trim());
    return {
      input: {
        ...input,
        embedding: vector,
        embeddingModel: cfg.model,
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
  opts?: { limit?: number },
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
      const vector = await embedText(cfg, m.content);
      await store.setEmbedding(tenantId, agentId, m.id, vector, cfg.model);
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
