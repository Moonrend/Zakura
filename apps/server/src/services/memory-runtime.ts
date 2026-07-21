import type { MemoryProviderKind } from "@zakura/shared";
import type { Agent, MemoryProvider } from "../db/schema.js";
import {
  parseProviderConfig,
  type MemoryProvidersService,
} from "./memory-providers.js";
import type { MemoryStore } from "./memory-store.js";
import { Mem0Client, formatMem0Context } from "./mem0-client.js";
import { embedText, parseEmbeddingConfig } from "./embedding-client.js";

export type ResolvedMemory = {
  provider: MemoryProvider;
  kind: MemoryProviderKind;
  config: Record<string, unknown>;
  /** Local PG rows (builtin / traditional). mem0 & openviking are remote. */
  storesLocally: boolean;
};

export async function resolveAgentMemory(
  providers: MemoryProvidersService,
  agent: Agent,
): Promise<ResolvedMemory | null> {
  const row = await providers.resolveForAgent(agent.tenantId, agent.memoryProviderId);
  if (!row) return null;
  const kind = row.kind as MemoryProviderKind;
  const config = parseProviderConfig(row.configJson);
  const storesLocally = kind === "builtin" || kind === "traditional";
  return { provider: row, kind, config, storesLocally };
}

/**
 * Pack memory into a context string when the agent calls `memory_context`.
 *
 * Built-in retrieval:
 * - keyword ILIKE (+ CJK bigrams)
 * - optional semantic seeds via OpenAI-compatible embeddings stored in pgvector
 * - 1-hop graph expansion
 * Uses PGlite/Postgres `vector` extension (no Qdrant). Disable embedding → keyword+graph only.
 */
export async function buildMemoryContext(
  memory: MemoryStore | null,
  resolved: ResolvedMemory,
  agent: Agent,
  query?: string,
): Promise<{
  text: string;
  retrievalMode: string;
  count: number;
  truncated?: boolean;
  note?: string;
}> {
  const { kind, config, provider } = resolved;

  if (kind === "traditional") {
    if (!memory) {
      return { text: "", retrievalMode: "full_dump", count: 0, note: "local store missing" };
    }
    const dump = await memory.dumpAll(agent.tenantId, agent.id, {
      maxChars: typeof config.maxChars === "number" ? config.maxChars : 32_000,
    });
    const header = dump.count
      ? `## 传统记忆（全部 ${dump.count} 条${dump.truncated ? "，已截断" : ""}）\n`
      : "";
    return {
      text: dump.count ? `${header}${dump.text}` : "",
      retrievalMode: "full_dump",
      count: dump.count,
      truncated: dump.truncated,
      note: "传统记忆无向量检索；调用 memory_context 即整包返回。",
    };
  }

  if (kind === "builtin") {
    if (!memory) {
      return { text: "", retrievalMode: "keyword_graph", count: 0, note: "local store missing" };
    }
    const embCfg = parseEmbeddingConfig(config);
    if (query?.trim()) {
      let queryEmbedding: number[] | null = null;
      let embNote = "";
      if (embCfg) {
        try {
          queryEmbedding = await embedText(embCfg, query.trim());
        } catch (err) {
          embNote = `；语义种子失败已降级关键词：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      const packed = await memory.hybridSearch(agent.tenantId, agent.id, query.trim(), {
        limit: 12,
        queryEmbedding,
      });
      const lines = packed.results.map((r) => {
        const sem = r.scoreBreakdown?.semantic
          ? ` sem=${r.scoreBreakdown.semantic.toFixed(2)}`
          : "";
        return `- [${r.layer}] ${r.content}${r.pinned ? " ★" : ""}${sem}`;
      });
      const rel =
        packed.relations.length > 0
          ? `\n关系: ${packed.relations.map((e) => `${e.fromMemoryId} -[${e.relation}]-> ${e.toMemoryId}`).join("; ")}`
          : "";
      const modeLabel =
        packed.retrievalMode === "hybrid" ? "hybrid 语义+关键词+图谱" : "关键词+图谱";
      return {
        text: lines.length
          ? `## 记忆检索（${provider.name} · ${modeLabel}）\n${lines.join("\n")}${rel}`
          : "",
        retrievalMode: packed.retrievalMode,
        count: packed.results.length,
        note: embCfg
          ? `Built-in hybrid：pgvector 语义种子 + 关键词 + 图谱${embNote}`
          : "未启用 embedding；仅关键词 + 图谱。可在记忆 Provider 中开启向量。",
      };
    }
    const pinned = await memory.list(agent.tenantId, agent.id, {
      pinned: true,
      limit: 20,
    });
    const recent = await memory.list(agent.tenantId, agent.id, { limit: 15 });
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const r of [...pinned, ...recent]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      lines.push(`- [${r.layer}] ${r.content}`);
    }
    return {
      text: lines.length
        ? `## 记忆（${provider.name} · 钉选/最近）\n${lines.join("\n")}`
        : "",
      retrievalMode: "pinned_recent",
      count: lines.length,
      note: "无 query 时返回钉选 + 最近条目（聚焦召回请传 query）。",
    };
  }

  if (kind === "mem0") {
    try {
      const client = Mem0Client.fromConfig(config);
      const { results } = await client.search({
        query: query?.trim() || "preferences facts context",
        agentId: agent.id,
        userId:
          typeof config.defaultUserId === "string" ? config.defaultUserId : "default",
        limit: 12,
      });
      const text = formatMem0Context(results);
      return {
        text,
        retrievalMode: "mem0_semantic",
        count: results.length,
        note: "语义检索由外部 mem0 完成（其侧需 embedder + 向量库）。",
      };
    } catch (err) {
      return {
        text: "",
        retrievalMode: "mem0_error",
        count: 0,
        note: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (kind === "openviking") {
    return {
      text: "",
      retrievalMode: "openviking",
      count: 0,
      note: "OpenViking 请通过其自身 MCP/API 浏览上下文；此处不整包注入。",
    };
  }

  return { text: "", retrievalMode: "none", count: 0 };
}
