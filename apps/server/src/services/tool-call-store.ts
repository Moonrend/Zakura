import { and, count, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import type { McpToolResult } from "@zakura/shared";
import type { Db } from "../db/client.js";
import { agents, apiKeys, toolCallLogs, type ToolCallLog } from "../db/schema.js";

const MAX_JSON_CHARS = 24_000;

export type ToolCallRecordInput = {
  tenantId: string;
  apiKeyId?: string | null;
  agentId?: string | null;
  qualifiedName: string;
  localName: string;
  providerId: string;
  instanceId?: string | null;
  args: Record<string, unknown>;
  result: McpToolResult;
  durationMs: number;
};

export type ToolCallListFilters = {
  agentId?: string;
  apiKeyId?: string;
  q?: string;
  isError?: boolean;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
};

export type ToolCallListItem = ToolCallLog & {
  agentName: string | null;
  agentSlug: string | null;
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
};

export type ToolCallStats = {
  total: number;
  errors: number;
  avgDurationMs: number;
  last24h: number;
  byAgent: Array<{ agentId: string | null; agentName: string | null; count: number }>;
  byApiKey: Array<{
    apiKeyId: string | null;
    apiKeyName: string | null;
    keyPrefix: string | null;
    count: number;
  }>;
  byTool: Array<{ qualifiedName: string; count: number; errors: number }>;
};

function truncateJson(value: unknown): string {
  try {
    const raw = JSON.stringify(value, (_key, v) => {
      if (typeof v === "string" && v.length > 2_000) {
        return `${v.slice(0, 200)}…(${v.length} chars)`;
      }
      return v;
    });
    if (raw.length <= MAX_JSON_CHARS) return raw;
    return `${raw.slice(0, MAX_JSON_CHARS)}…[truncated]`;
  } catch {
    return '"[unserializable]"';
  }
}

function resultPayload(result: McpToolResult): unknown {
  const texts = (result.content ?? [])
    .map((c) => {
      if (c.type === "text") return c.text;
      if (c.type === "resource") return c.text ?? c.uri;
      return "";
    })
    .filter(Boolean);
  return {
    isError: Boolean(result.isError),
    text: texts.join("\n"),
  };
}

export class ToolCallStore {
  constructor(private readonly db: Db) {}

  /** Fire-and-forget safe: never throws to caller */
  async record(input: ToolCallRecordInput): Promise<void> {
    try {
      await this.db.insert(toolCallLogs).values({
        tenantId: input.tenantId,
        apiKeyId: input.apiKeyId ?? null,
        agentId: input.agentId ?? null,
        qualifiedName: input.qualifiedName,
        localName: input.localName,
        providerId: input.providerId || "",
        instanceId: input.instanceId ?? null,
        argsJson: truncateJson(input.args),
        resultJson: truncateJson(resultPayload(input.result)),
        isError: Boolean(input.result.isError),
        durationMs: Math.max(0, Math.round(input.durationMs)),
      });
    } catch (err) {
      console.error("[tool-call-store] record failed:", err);
    }
  }

  async list(
    tenantId: string,
    filters: ToolCallListFilters = {},
  ): Promise<{ items: ToolCallListItem[]; total: number }> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const where = this.buildWhere(tenantId, filters);

    const [countRow] = await this.db
      .select({ n: count() })
      .from(toolCallLogs)
      .where(where);

    const rows = await this.db
      .select({
        log: toolCallLogs,
        agentName: agents.name,
        agentSlug: agents.slug,
        apiKeyName: apiKeys.name,
        apiKeyPrefix: apiKeys.keyPrefix,
      })
      .from(toolCallLogs)
      .leftJoin(agents, eq(toolCallLogs.agentId, agents.id))
      .leftJoin(apiKeys, eq(toolCallLogs.apiKeyId, apiKeys.id))
      .where(where)
      .orderBy(desc(toolCallLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      total: Number(countRow?.n ?? 0),
      items: rows.map((r) => ({
        ...r.log,
        agentName: r.agentName ?? null,
        agentSlug: r.agentSlug ?? null,
        apiKeyName: r.apiKeyName ?? null,
        apiKeyPrefix: r.apiKeyPrefix ?? null,
      })),
    };
  }

  async get(tenantId: string, id: string): Promise<ToolCallListItem | null> {
    const [row] = await this.db
      .select({
        log: toolCallLogs,
        agentName: agents.name,
        agentSlug: agents.slug,
        apiKeyName: apiKeys.name,
        apiKeyPrefix: apiKeys.keyPrefix,
      })
      .from(toolCallLogs)
      .leftJoin(agents, eq(toolCallLogs.agentId, agents.id))
      .leftJoin(apiKeys, eq(toolCallLogs.apiKeyId, apiKeys.id))
      .where(and(eq(toolCallLogs.tenantId, tenantId), eq(toolCallLogs.id, id)))
      .limit(1);
    if (!row) return null;
    return {
      ...row.log,
      agentName: row.agentName ?? null,
      agentSlug: row.agentSlug ?? null,
      apiKeyName: row.apiKeyName ?? null,
      apiKeyPrefix: row.apiKeyPrefix ?? null,
    };
  }

  async stats(tenantId: string, agentId?: string): Promise<ToolCallStats> {
    const base = agentId
      ? and(eq(toolCallLogs.tenantId, tenantId), eq(toolCallLogs.agentId, agentId))
      : eq(toolCallLogs.tenantId, tenantId);

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [totals] = await this.db
      .select({
        total: count(),
        errors: sql<number>`coalesce(sum(case when ${toolCallLogs.isError} then 1 else 0 end), 0)`,
        avgDurationMs: sql<number>`coalesce(avg(${toolCallLogs.durationMs}), 0)`,
      })
      .from(toolCallLogs)
      .where(base);

    const [last24] = await this.db
      .select({ n: count() })
      .from(toolCallLogs)
      .where(and(base, gte(toolCallLogs.createdAt, since24h)));

    const byAgentRows = await this.db
      .select({
        agentId: toolCallLogs.agentId,
        agentName: agents.name,
        count: count(),
      })
      .from(toolCallLogs)
      .leftJoin(agents, eq(toolCallLogs.agentId, agents.id))
      .where(base)
      .groupBy(toolCallLogs.agentId, agents.name)
      .orderBy(desc(count()))
      .limit(20);

    const byKeyRows = await this.db
      .select({
        apiKeyId: toolCallLogs.apiKeyId,
        apiKeyName: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        count: count(),
      })
      .from(toolCallLogs)
      .leftJoin(apiKeys, eq(toolCallLogs.apiKeyId, apiKeys.id))
      .where(base)
      .groupBy(toolCallLogs.apiKeyId, apiKeys.name, apiKeys.keyPrefix)
      .orderBy(desc(count()))
      .limit(20);

    const byToolRows = await this.db
      .select({
        qualifiedName: toolCallLogs.qualifiedName,
        count: count(),
        errors: sql<number>`coalesce(sum(case when ${toolCallLogs.isError} then 1 else 0 end), 0)`,
      })
      .from(toolCallLogs)
      .where(base)
      .groupBy(toolCallLogs.qualifiedName)
      .orderBy(desc(count()))
      .limit(20);

    return {
      total: Number(totals?.total ?? 0),
      errors: Number(totals?.errors ?? 0),
      avgDurationMs: Math.round(Number(totals?.avgDurationMs ?? 0)),
      last24h: Number(last24?.n ?? 0),
      byAgent: byAgentRows.map((r) => ({
        agentId: r.agentId,
        agentName: r.agentName,
        count: Number(r.count),
      })),
      byApiKey: byKeyRows.map((r) => ({
        apiKeyId: r.apiKeyId,
        apiKeyName: r.apiKeyName,
        keyPrefix: r.keyPrefix,
        count: Number(r.count),
      })),
      byTool: byToolRows.map((r) => ({
        qualifiedName: r.qualifiedName,
        count: Number(r.count),
        errors: Number(r.errors),
      })),
    };
  }

  private buildWhere(tenantId: string, filters: ToolCallListFilters) {
    const parts = [eq(toolCallLogs.tenantId, tenantId)];
    if (filters.agentId) parts.push(eq(toolCallLogs.agentId, filters.agentId));
    if (filters.apiKeyId) parts.push(eq(toolCallLogs.apiKeyId, filters.apiKeyId));
    if (filters.isError === true) parts.push(eq(toolCallLogs.isError, true));
    if (filters.isError === false) parts.push(eq(toolCallLogs.isError, false));
    if (filters.since) parts.push(gte(toolCallLogs.createdAt, filters.since));
    if (filters.until) parts.push(lte(toolCallLogs.createdAt, filters.until));
    if (filters.q?.trim()) {
      const q = `%${filters.q.trim()}%`;
      parts.push(
        sql`(${ilike(toolCallLogs.qualifiedName, q)} or ${ilike(toolCallLogs.localName, q)} or ${ilike(toolCallLogs.providerId, q)})`,
      );
    }
    return and(...parts)!;
  }
}
