import { and, asc, eq, sql } from "drizzle-orm";
import {
  MEMORY_PROVIDER_KINDS,
  MEMORY_PROVIDER_KIND_META,
  type MemoryProviderKind,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  agents,
  memoryProviders,
  newId,
  type MemoryProvider,
} from "../db/schema.js";

export function isMemoryProviderKind(v: string): v is MemoryProviderKind {
  return (MEMORY_PROVIDER_KINDS as readonly string[]).includes(v);
}

export function parseProviderConfig(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function serializeMemoryProvider(row: MemoryProvider) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    slug: row.slug,
    kind: row.kind as MemoryProviderKind,
    config: parseProviderConfig(row.configJson),
    isDefault: row.isDefault,
    status: row.status,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    meta: MEMORY_PROVIDER_KIND_META[row.kind as MemoryProviderKind] ?? {
      name: row.kind,
      description: "",
      storesLocally: false,
    },
  };
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "memory";
}

export type MemoryProviderInput = {
  name: string;
  kind: MemoryProviderKind;
  slug?: string;
  config?: Record<string, unknown>;
  isDefault?: boolean;
};

export class MemoryProvidersService {
  constructor(private readonly db: Db) {}

  kinds() {
    return MEMORY_PROVIDER_KINDS.map((kind) => ({
      kind,
      ...MEMORY_PROVIDER_KIND_META[kind],
    }));
  }

  async list(tenantId: string) {
    await this.ensureDefault(tenantId);
    const rows = await this.db
      .select()
      .from(memoryProviders)
      .where(eq(memoryProviders.tenantId, tenantId))
      .orderBy(asc(memoryProviders.createdAt));
    return rows.map(serializeMemoryProvider);
  }

  async get(tenantId: string, id: string) {
    const row = await this.db.query.memoryProviders.findFirst({
      where: and(eq(memoryProviders.id, id), eq(memoryProviders.tenantId, tenantId)),
    });
    return row ? serializeMemoryProvider(row) : null;
  }

  async getRow(tenantId: string, id: string): Promise<MemoryProvider | null> {
    const row = await this.db.query.memoryProviders.findFirst({
      where: and(eq(memoryProviders.id, id), eq(memoryProviders.tenantId, tenantId)),
    });
    return row ?? null;
  }

  async getDefault(tenantId: string): Promise<MemoryProvider | null> {
    await this.ensureDefault(tenantId);
    const row = await this.db.query.memoryProviders.findFirst({
      where: and(
        eq(memoryProviders.tenantId, tenantId),
        eq(memoryProviders.isDefault, true),
      ),
    });
    if (row) return row;
    const any = await this.db.query.memoryProviders.findFirst({
      where: eq(memoryProviders.tenantId, tenantId),
      orderBy: [asc(memoryProviders.createdAt)],
    });
    return any ?? null;
  }

  /** Resolve provider for an agent: explicit binding → tenant default */
  async resolveForAgent(
    tenantId: string,
    memoryProviderId: string | null | undefined,
  ): Promise<MemoryProvider | null> {
    if (memoryProviderId) {
      const row = await this.getRow(tenantId, memoryProviderId);
      if (row) return row;
    }
    return this.getDefault(tenantId);
  }

  async ensureDefault(tenantId: string): Promise<MemoryProvider> {
    const existing = await this.db.query.memoryProviders.findFirst({
      where: eq(memoryProviders.tenantId, tenantId),
    });
    if (existing) {
      const def = await this.db.query.memoryProviders.findFirst({
        where: and(
          eq(memoryProviders.tenantId, tenantId),
          eq(memoryProviders.isDefault, true),
        ),
      });
      if (!def) {
        await this.db
          .update(memoryProviders)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(memoryProviders.id, existing.id));
        return { ...existing, isDefault: true };
      }
      return def;
    }

    const now = new Date();
    const [row] = await this.db
      .insert(memoryProviders)
      .values({
        id: newId(),
        tenantId,
        name: "Built-in",
        slug: "builtin",
        kind: "builtin",
        configJson: JSON.stringify({ defaultUserId: "default" }),
        isDefault: true,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  }

  async create(tenantId: string, input: MemoryProviderInput) {
    if (!isMemoryProviderKind(input.kind)) {
      throw new Error(`Unsupported memory provider kind: ${input.kind}`);
    }
    const name = input.name.trim();
    if (!name) throw new Error("name required");

    let slug = (input.slug?.trim() || slugify(name)).toLowerCase();
    for (let i = 0; i < 20; i++) {
      const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
      const clash = await this.db.query.memoryProviders.findFirst({
        where: and(
          eq(memoryProviders.tenantId, tenantId),
          eq(memoryProviders.slug, candidate),
        ),
      });
      if (!clash) {
        slug = candidate;
        break;
      }
      if (i === 19) throw new Error(`slug already exists: ${slug}`);
    }

    const config = this.normalizeConfig(input.kind, input.config ?? {});
    const existingCount = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memoryProviders)
      .where(eq(memoryProviders.tenantId, tenantId));
    const isDefault = input.isDefault === true || (existingCount[0]?.n ?? 0) === 0;

    if (isDefault) await this.clearDefault(tenantId);

    const now = new Date();
    const [row] = await this.db
      .insert(memoryProviders)
      .values({
        id: newId(),
        tenantId,
        name,
        slug,
        kind: input.kind,
        configJson: JSON.stringify(config),
        isDefault,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return serializeMemoryProvider(row);
  }

  async update(
    tenantId: string,
    id: string,
    patch: {
      name?: string;
      config?: Record<string, unknown>;
      isDefault?: boolean;
      status?: string;
      lastError?: string | null;
    },
  ) {
    const existing = await this.getRow(tenantId, id);
    if (!existing) throw new Error("Memory provider not found");

    if (patch.isDefault === true) {
      await this.clearDefault(tenantId);
    }

    const nextConfig =
      patch.config !== undefined
        ? this.normalizeConfig(existing.kind as MemoryProviderKind, {
            ...parseProviderConfig(existing.configJson),
            ...patch.config,
          })
        : undefined;

    const [row] = await this.db
      .update(memoryProviders)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(nextConfig !== undefined ? { configJson: JSON.stringify(nextConfig) } : {}),
        ...(patch.isDefault === true ? { isDefault: true } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(memoryProviders.id, id), eq(memoryProviders.tenantId, tenantId)))
      .returning();
    return serializeMemoryProvider(row);
  }

  async remove(tenantId: string, id: string) {
    const existing = await this.getRow(tenantId, id);
    if (!existing) throw new Error("Memory provider not found");

    const bound = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(eq(agents.tenantId, tenantId), eq(agents.memoryProviderId, id)));
    if ((bound[0]?.n ?? 0) > 0) {
      throw new Error("仍有 Agent 绑定此 Provider，请先在 Agent 记忆页更换");
    }

    const wasDefault = existing.isDefault;
    await this.db
      .delete(memoryProviders)
      .where(and(eq(memoryProviders.id, id), eq(memoryProviders.tenantId, tenantId)));

    if (wasDefault) {
      const next = await this.db.query.memoryProviders.findFirst({
        where: eq(memoryProviders.tenantId, tenantId),
        orderBy: [asc(memoryProviders.createdAt)],
      });
      if (next) {
        await this.db
          .update(memoryProviders)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(memoryProviders.id, next.id));
      }
    }
    return { ok: true as const };
  }

  async usage(tenantId: string) {
    const rows = await this.db
      .select({
        id: agents.id,
        name: agents.name,
        slug: agents.slug,
        enableMemory: agents.enableMemory,
        memoryProviderId: agents.memoryProviderId,
      })
      .from(agents)
      .where(eq(agents.tenantId, tenantId));
    return rows;
  }

  async healthCheck(tenantId: string, id: string) {
    const row = await this.getRow(tenantId, id);
    if (!row) throw new Error("Memory provider not found");
    const config = parseProviderConfig(row.configJson);
    const kind = row.kind as MemoryProviderKind;

    if (kind === "builtin" || kind === "traditional") {
      return { status: "healthy" as const, message: "local store" };
    }

    if (kind === "mem0") {
      const baseUrl = String(config.baseUrl ?? "").trim();
      if (!baseUrl) {
        return { status: "unhealthy" as const, message: "baseUrl required — mem0 无本地模式" };
      }
      try {
        const { Mem0Client } = await import("./mem0-client.js");
        return Mem0Client.fromConfig(config).health();
      } catch (err) {
        return {
          status: "unhealthy" as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (kind === "openviking") {
      const baseUrl = String(config.baseUrl ?? "").replace(/\/$/, "");
      if (!baseUrl) {
        return { status: "unhealthy" as const, message: "baseUrl required" };
      }
      try {
        const res = await fetch(`${baseUrl}/health`, {
          headers: openVikingHeaders(config),
          signal: AbortSignal.timeout(5000),
        });
        return {
          status: res.ok ? ("healthy" as const) : ("unhealthy" as const),
          message: `HTTP ${res.status}`,
        };
      } catch (err) {
        return {
          status: "unhealthy" as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { status: "unknown" as const, message: kind };
  }

  private async clearDefault(tenantId: string) {
    await this.db
      .update(memoryProviders)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(memoryProviders.tenantId, tenantId));
  }

  private normalizeConfig(
    kind: MemoryProviderKind,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    if (kind === "builtin") {
      const embedding =
        config.embedding && typeof config.embedding === "object"
          ? (config.embedding as Record<string, unknown>)
          : {};
      const embEnabled = embedding.enabled === true;
      const baseUrl =
        typeof embedding.baseUrl === "string" ? embedding.baseUrl.trim() : "";
      const model =
        typeof embedding.model === "string" ? embedding.model.trim() : "text-embedding-3-small";
      if (embEnabled && !baseUrl) {
        throw new Error("启用 Built-in 向量检索时需要 embedding.baseUrl（OpenAI 兼容 /v1）");
      }
      return {
        defaultUserId:
          typeof config.defaultUserId === "string" && config.defaultUserId.trim()
            ? config.defaultUserId.trim()
            : "default",
        embedding: {
          enabled: embEnabled,
          baseUrl,
          apiKey: typeof embedding.apiKey === "string" ? embedding.apiKey : "",
          model: model || "text-embedding-3-small",
          dimensions:
            typeof embedding.dimensions === "number" && embedding.dimensions > 0
              ? Math.floor(embedding.dimensions)
              : undefined,
        },
      };
    }
    if (kind === "traditional") {
      const maxChars =
        typeof config.maxChars === "number"
          ? Math.min(200_000, Math.max(1000, config.maxChars))
          : 32_000;
      return { maxChars };
    }
    if (kind === "mem0") {
      const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
      if (!baseUrl) {
        throw new Error(
          "mem0 需要 baseUrl。真正的 mem0 依赖 embedding + 向量库，请部署 mem0 Platform/OSS 后填写地址；Zakura 不提供「无向量的本地 mem0」。需要本地无向量记忆请用 Built-in 或传统记忆。",
        );
      }
      return {
        baseUrl,
        apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
        defaultUserId:
          typeof config.defaultUserId === "string" && config.defaultUserId.trim()
            ? config.defaultUserId.trim()
            : "default",
      };
    }
    if (kind === "openviking") {
      const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
      if (!baseUrl) throw new Error("OpenViking 需要 baseUrl");
      return {
        baseUrl,
        apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
        headerName:
          typeof config.headerName === "string" && config.headerName.trim()
            ? config.headerName.trim()
            : "Authorization",
      };
    }
    return config;
  }
}

function openVikingHeaders(config: Record<string, unknown>): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  const key = typeof config.apiKey === "string" ? config.apiKey : "";
  if (key) {
    const header =
      typeof config.headerName === "string" && config.headerName.trim()
        ? config.headerName.trim()
        : "Authorization";
    h[header] = header.toLowerCase() === "authorization" ? `Bearer ${key}` : key;
  }
  return h;
}
