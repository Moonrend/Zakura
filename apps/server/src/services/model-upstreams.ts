import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  OPENAI_COMPATIBLE_PROTOCOLS,
  MODEL_UPSTREAM_PROTOCOLS,
  MODEL_UPSTREAM_PROTOCOL_META,
  applyUpstreamProtocolDefaults,
  type ModelUpstreamProtocol,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import { modelUpstreams, newId, type ModelUpstream } from "../db/schema.js";
import { parseJsonRecord, parseUpstreamConfig } from "../model-router/types.js";

export function isModelUpstreamProtocol(v: string): v is ModelUpstreamProtocol {
  return (MODEL_UPSTREAM_PROTOCOLS as readonly string[]).includes(v);
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "upstream";
}

const OPTIONAL_API_KEY_PROTOCOLS = new Set<ModelUpstreamProtocol>([
  "custom",
  "ollama",
]);

function requiresApiKey(protocol: ModelUpstreamProtocol): boolean {
  return (
    (protocol === "anthropic" ||
      protocol === "gemini" ||
      protocol === "bailian" ||
      (OPENAI_COMPATIBLE_PROTOCOLS as readonly ModelUpstreamProtocol[]).includes(
        protocol,
      )) &&
    !OPTIONAL_API_KEY_PROTOCOLS.has(protocol)
  );
}

export function serializeUpstream(row: ModelUpstream) {
  const protocol = row.protocol as ModelUpstreamProtocol;
  const config = parseUpstreamConfig(parseJsonRecord(row.configJson), protocol);
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    slug: row.slug,
    protocol,
    config: parseJsonRecord(row.configJson),
    resolvedConfig: config,
    status: row.status,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    meta: MODEL_UPSTREAM_PROTOCOL_META[protocol] ?? {
      name: row.protocol,
      description: "",
      fields: ["baseUrl", "apiKey"],
    },
  };
}

export type ModelUpstreamInput = {
  name: string;
  slug?: string;
  protocol: ModelUpstreamProtocol;
  config?: Record<string, unknown>;
};

export class ModelUpstreamsService {
  constructor(
    private readonly db: Db,
    private readonly onMutate?: (tenantId: string) => void,
  ) {}

  meta() {
    return MODEL_UPSTREAM_PROTOCOLS.map((protocol) => ({
      protocol,
      ...MODEL_UPSTREAM_PROTOCOL_META[protocol],
    }));
  }

  async list(tenantId: string) {
    const rows = await this.db
      .select()
      .from(modelUpstreams)
      .where(eq(modelUpstreams.tenantId, tenantId))
      .orderBy(asc(modelUpstreams.createdAt));
    return rows.map(serializeUpstream);
  }

  async get(tenantId: string, id: string) {
    const row = await this.db.query.modelUpstreams.findFirst({
      where: and(eq(modelUpstreams.id, id), eq(modelUpstreams.tenantId, tenantId)),
    });
    return row ? serializeUpstream(row) : null;
  }

  async getRow(tenantId: string, id: string): Promise<ModelUpstream | null> {
    const row = await this.db.query.modelUpstreams.findFirst({
      where: and(eq(modelUpstreams.id, id), eq(modelUpstreams.tenantId, tenantId)),
    });
    return row ?? null;
  }

  validateConfig(
    protocol: ModelUpstreamProtocol,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const parsed = applyUpstreamProtocolDefaults(protocol, config);
    if (!parsed.baseUrl) throw new Error("baseUrl 必填（该类型未配置预设地址）");
    if (protocol === "azure-openai" && !parsed.apiVersion) {
      throw new Error("Azure OpenAI 需要配置 apiVersion");
    }
    if (requiresApiKey(protocol) && !parsed.apiKey) {
      throw new Error(`${MODEL_UPSTREAM_PROTOCOL_META[protocol].name} 需要配置 API Key`);
    }
    return {
      ...config,
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      apiVersion: parsed.apiVersion,
      deploymentId: parsed.deploymentId,
      anthropicVersion: parsed.anthropicVersion,
      rerankBaseUrl: parsed.rerankBaseUrl,
      region: parsed.region,
      extraHeaders: parsed.extraHeaders,
      timeoutMs: parsed.timeoutMs,
    };
  }

  async create(tenantId: string, input: ModelUpstreamInput) {
    if (!isModelUpstreamProtocol(input.protocol)) {
      throw new Error(`不支持的协议: ${input.protocol}`);
    }
    const name = input.name.trim();
    if (!name) throw new Error("name required");

    let slug = (input.slug?.trim() || slugify(name)).toLowerCase();
    for (let i = 0; i < 20; i++) {
      const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
      const clash = await this.db.query.modelUpstreams.findFirst({
        where: and(
          eq(modelUpstreams.tenantId, tenantId),
          eq(modelUpstreams.slug, candidate),
        ),
      });
      if (!clash) {
        slug = candidate;
        break;
      }
      if (i === 19) throw new Error(`slug 已存在: ${slug}`);
    }

    const config = this.validateConfig(input.protocol, input.config ?? {});
    const now = new Date();
    const [row] = await this.db
      .insert(modelUpstreams)
      .values({
        id: newId(),
        tenantId,
        name,
        slug,
        protocol: input.protocol,
        configJson: JSON.stringify(config),
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    this.onMutate?.(tenantId);
    return serializeUpstream(row!);
  }

  async update(
    tenantId: string,
    id: string,
    patch: { name?: string; config?: Record<string, unknown> },
  ) {
    const row = await this.getRow(tenantId, id);
    if (!row) throw new Error("Not found");
    const updates: Partial<ModelUpstream> = { updatedAt: new Date() };
    if (typeof patch.name === "string" && patch.name.trim()) {
      updates.name = patch.name.trim();
    }
    if (patch.config) {
      const protocol = row.protocol as ModelUpstreamProtocol;
      const prev = parseJsonRecord(row.configJson);
      const merged: Record<string, unknown> = { ...prev, ...patch.config };
      if (
        !("apiKey" in patch.config) ||
        patch.config.apiKey === undefined ||
        patch.config.apiKey === ""
      ) {
        merged.apiKey = prev.apiKey;
      }
      updates.configJson = JSON.stringify(this.validateConfig(protocol, merged));
    }
    const [next] = await this.db
      .update(modelUpstreams)
      .set(updates)
      .where(and(eq(modelUpstreams.id, id), eq(modelUpstreams.tenantId, tenantId)))
      .returning();
    this.onMutate?.(tenantId);
    return serializeUpstream(next!);
  }

  async remove(tenantId: string, id: string) {
    await this.db
      .delete(modelUpstreams)
      .where(and(eq(modelUpstreams.id, id), eq(modelUpstreams.tenantId, tenantId)));
    this.onMutate?.(tenantId);
  }

  async removeMany(tenantId: string, ids: string[]) {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) return { deleted: 0 };
    await this.db
      .delete(modelUpstreams)
      .where(
        and(eq(modelUpstreams.tenantId, tenantId), inArray(modelUpstreams.id, unique)),
      );
    this.onMutate?.(tenantId);
    return { deleted: unique.length };
  }

  async healthCheck(tenantId: string, id: string) {
    const row = await this.getRow(tenantId, id);
    if (!row) throw new Error("Not found");
    const protocol = row.protocol as ModelUpstreamProtocol;
    const cfg = parseUpstreamConfig(parseJsonRecord(row.configJson), protocol);
    if (!cfg.baseUrl) {
      return { status: "unhealthy" as const, message: "baseUrl 未配置" };
    }
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (cfg.apiKey) {
        if (protocol === "azure-openai") headers["api-key"] = cfg.apiKey;
        else if (protocol !== "gemini") headers.Authorization = `Bearer ${cfg.apiKey}`;
      }
      let url = `${cfg.baseUrl}/models`;
      if (protocol === "gemini") {
        url = `${cfg.baseUrl}/models?key=${encodeURIComponent(cfg.apiKey ?? "")}`;
      } else if (protocol === "azure-openai") {
        const ver = cfg.apiVersion ?? "2024-08-01-preview";
        url = `${cfg.baseUrl}/openai/models?api-version=${encodeURIComponent(ver)}`;
      } else if (protocol === "anthropic") {
        url = `${cfg.baseUrl}/v1/models`;
      } else if (protocol === "bailian") {
        // 用官方模型列表接口探活，不写死模型名
        const { dashScopeOrigin } = await import(
          "../model-router/adapters/bailian.js"
        );
        const origin = dashScopeOrigin(cfg.baseUrl);
        const probe = await fetch(`${origin}/compatible-mode/v1/models`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${cfg.apiKey ?? ""}`,
          },
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 15000),
        });
        const ok = probe.ok;
        const message = ok
          ? "连接正常（DashScope /models）"
          : `HTTP ${probe.status}`;
        await this.db
          .update(modelUpstreams)
          .set({
            status: ok ? "ready" : "error",
            lastError: ok ? null : message,
            updatedAt: new Date(),
          })
          .where(eq(modelUpstreams.id, id));
        return { status: ok ? ("healthy" as const) : ("unhealthy" as const), message };
      }
      const res = await fetch(url, {
        method: "GET",
        headers: {
          ...headers,
          ...(protocol === "anthropic"
            ? {
                "anthropic-version": cfg.anthropicVersion ?? "2023-06-01",
                "x-api-key": cfg.apiKey ?? "",
              }
            : {}),
        },
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 15000),
      });
      const ok = res.ok || res.status === 404;
      const message = ok ? "连接正常" : `HTTP ${res.status}`;
      await this.db
        .update(modelUpstreams)
        .set({
          status: ok ? "ready" : "error",
          lastError: ok ? null : message,
          updatedAt: new Date(),
        })
        .where(eq(modelUpstreams.id, id));
      return { status: ok ? ("healthy" as const) : ("unhealthy" as const), message };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(modelUpstreams)
        .set({ status: "error", lastError: message, updatedAt: new Date() })
        .where(eq(modelUpstreams.id, id));
      return { status: "unhealthy" as const, message };
    }
  }

  async routeCount(tenantId: string, upstreamId: string): Promise<number> {
    const { modelRoutes } = await import("../db/schema.js");
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(modelRoutes)
      .where(
        and(eq(modelRoutes.tenantId, tenantId), eq(modelRoutes.upstreamId, upstreamId)),
      );
    return rows[0]?.n ?? 0;
  }

  async listRemoteModels(
    tenantId: string,
    id: string,
  ): Promise<{
    models: Array<{
      id: string;
      name?: string;
      ownedBy?: string;
      capability?: string;
    }>;
    message?: string;
  }> {
    const row = await this.getRow(tenantId, id);
    if (!row) throw new Error("Not found");
    const protocol = row.protocol as ModelUpstreamProtocol;
    const cfg = parseUpstreamConfig(parseJsonRecord(row.configJson), protocol);
    if (!cfg.baseUrl) throw new Error("baseUrl 未配置");

    if (protocol === "anthropic") {
      return {
        models: [],
        message:
          "Anthropic 无官方 /models 列表，请手动填写模型名（如 claude-sonnet-4-20250514）",
      };
    }

    if (protocol === "bailian") {
      const { listBailianRemoteModels } = await import(
        "../model-router/adapters/bailian.js"
      );
      return listBailianRemoteModels({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs,
      });
    }

    try {
      if (protocol === "gemini") {
        const url = `${cfg.baseUrl}/models?key=${encodeURIComponent(cfg.apiKey ?? "")}`;
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 20000),
        });
        const data = (await res.json().catch(() => null)) as {
          models?: Array<{ name?: string; displayName?: string }>;
          error?: { message?: string };
        } | null;
        if (!res.ok) {
          throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
        }
        const models = (data?.models ?? [])
          .map((m) => {
            const raw = String(m.name ?? "");
            const mid = raw.replace(/^models\//, "");
            return {
              id: mid,
              name: m.displayName ?? mid,
            };
          })
          .filter((m) => m.id);
        return { models };
      }

      const headers: Record<string, string> = { Accept: "application/json" };
      if (cfg.apiKey) {
        if (protocol === "azure-openai") headers["api-key"] = cfg.apiKey;
        else headers.Authorization = `Bearer ${cfg.apiKey}`;
      }
      let url = `${cfg.baseUrl}/models`;
      if (protocol === "azure-openai") {
        const ver = cfg.apiVersion ?? "2024-08-01-preview";
        url = `${cfg.baseUrl}/openai/models?api-version=${encodeURIComponent(ver)}`;
      }
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 20000),
      });
      const data = (await res.json().catch(() => null)) as {
        data?: Array<{ id?: string; owned_by?: string }>;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      }
      const models = (data?.data ?? [])
        .map((m) => ({
          id: String(m.id ?? ""),
          name: String(m.id ?? ""),
          ownedBy: typeof m.owned_by === "string" ? m.owned_by : undefined,
        }))
        .filter((m) => m.id);
      return { models };
    } catch (err) {
      throw new Error(
        `拉取上游模型失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
