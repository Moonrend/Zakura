/**
 * HTTP client for a real mem0 deployment (Platform or self-hosted OSS).
 *
 * Real mem0 ALWAYS needs an embedder + vector store on *its* side
 * (OpenAI embeddings + Qdrant by default). Zakura does not embed locally
 * and does not run a vector DB — we only proxy HTTP.
 *
 * Docs: https://docs.mem0.ai/
 */

export type Mem0ClientConfig = {
  baseUrl: string;
  apiKey?: string;
  defaultUserId?: string;
};

export type Mem0MemoryItem = {
  id?: string;
  memory?: string;
  content?: string;
  score?: number;
  user_id?: string;
  agent_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
};

function root(cfg: Mem0ClientConfig): string {
  return cfg.baseUrl.replace(/\/$/, "");
}

function headers(cfg: Mem0ClientConfig): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function asResults(data: unknown): Mem0MemoryItem[] {
  if (!data || typeof data !== "object") return [];
  const o = data as Record<string, unknown>;
  const list = (o.results ?? o.memories ?? o.data) as unknown;
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x === "object") as Mem0MemoryItem[];
}

export class Mem0Client {
  constructor(private readonly cfg: Mem0ClientConfig) {
    if (!cfg.baseUrl?.trim()) throw new Error("mem0 baseUrl is required");
  }

  static fromConfig(config: Record<string, unknown>): Mem0Client {
    const baseUrl = String(config.baseUrl ?? "").trim();
    if (!baseUrl) {
      throw new Error(
        "mem0 需要 baseUrl（指向已部署的 mem0 Platform / OSS）。真正的 mem0 依赖 embedding 与向量库，Zakura 不会在本地模拟。",
      );
    }
    return new Mem0Client({
      baseUrl,
      apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
      defaultUserId:
        typeof config.defaultUserId === "string" && config.defaultUserId.trim()
          ? config.defaultUserId.trim()
          : "default",
    });
  }

  async health(): Promise<{ status: "healthy" | "unhealthy"; message: string }> {
    const base = root(this.cfg);
    try {
      const res = await fetch(`${base}/health`, {
        headers: headers(this.cfg),
        signal: AbortSignal.timeout(5000),
      }).catch(async () =>
        fetch(`${base}/`, {
          headers: headers(this.cfg),
          signal: AbortSignal.timeout(5000),
        }),
      );
      return {
        status: res.ok ? "healthy" : "unhealthy",
        message: `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        status: "unhealthy",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async search(opts: {
    query: string;
    agentId: string;
    userId?: string;
    limit?: number;
  }): Promise<{ results: Mem0MemoryItem[]; retrievalMode: "mem0_semantic" }> {
    const base = root(this.cfg);
    const res = await fetch(`${base}/v1/memories/search`, {
      method: "POST",
      headers: headers(this.cfg),
      body: JSON.stringify({
        query: opts.query,
        user_id: opts.userId ?? this.cfg.defaultUserId ?? "default",
        agent_id: opts.agentId,
        limit: opts.limit ?? 10,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await readJson(res);
    if (!res.ok) {
      throw new Error(
        `mem0 search failed HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`,
      );
    }
    return { results: asResults(data), retrievalMode: "mem0_semantic" };
  }

  async add(opts: {
    content: string;
    agentId: string;
    userId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Mem0MemoryItem> {
    const base = root(this.cfg);
    const res = await fetch(`${base}/v1/memories`, {
      method: "POST",
      headers: headers(this.cfg),
      body: JSON.stringify({
        messages: [{ role: "user", content: opts.content }],
        user_id: opts.userId ?? this.cfg.defaultUserId ?? "default",
        agent_id: opts.agentId,
        metadata: opts.metadata ?? {},
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await readJson(res);
    if (!res.ok) {
      throw new Error(
        `mem0 add failed HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`,
      );
    }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const o = data as Record<string, unknown>;
      if (Array.isArray(o.results) && o.results[0]) {
        return o.results[0] as Mem0MemoryItem;
      }
      return o as Mem0MemoryItem;
    }
    return { memory: opts.content };
  }

  async list(opts: {
    agentId: string;
    userId?: string;
    limit?: number;
  }): Promise<{ memories: Mem0MemoryItem[] }> {
    const base = root(this.cfg);
    const params = new URLSearchParams({
      user_id: opts.userId ?? this.cfg.defaultUserId ?? "default",
      agent_id: opts.agentId,
      limit: String(opts.limit ?? 50),
    });
    const res = await fetch(`${base}/v1/memories?${params}`, {
      headers: headers(this.cfg),
      signal: AbortSignal.timeout(15000),
    });
    const data = await readJson(res);
    if (!res.ok) {
      throw new Error(
        `mem0 list failed HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`,
      );
    }
    return { memories: asResults(data) };
  }

  async delete(memoryId: string): Promise<void> {
    const base = root(this.cfg);
    const res = await fetch(`${base}/v1/memories/${encodeURIComponent(memoryId)}`, {
      method: "DELETE",
      headers: headers(this.cfg),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const data = await readJson(res);
      throw new Error(
        `mem0 delete failed HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`,
      );
    }
  }
}

export function formatMem0Context(items: Mem0MemoryItem[]): string {
  const lines = items
    .map((r) => `- ${r.memory ?? r.content ?? ""}`.trim())
    .filter((l) => l.length > 2);
  return lines.length ? `## mem0 语义记忆\n${lines.join("\n")}` : "";
}
