import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { networkAuditLogs, newId, type NetworkAuditLog } from "../db/schema.js";
import type { NetworkAuditLogDto } from "@zakura/shared";

function parseDetail(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function serializeAuditLog(row: NetworkAuditLog): NetworkAuditLogDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    detail: parseDetail(row.detailJson),
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  };
}

export type AuditActor = {
  type: "user" | "agent" | "system";
  id?: string | null;
  ip?: string | null;
};

export class NetworkAuditService {
  constructor(private readonly db: Db) {}

  async append(
    tenantId: string,
    action: string,
    opts?: {
      actor?: AuditActor;
      targetType?: string;
      targetId?: string;
      detail?: Record<string, unknown>;
    },
  ): Promise<NetworkAuditLog> {
    const now = new Date();
    const [row] = await this.db
      .insert(networkAuditLogs)
      .values({
        id: newId(),
        tenantId,
        actorType: opts?.actor?.type ?? "system",
        actorId: opts?.actor?.id ?? null,
        action,
        targetType: opts?.targetType ?? null,
        targetId: opts?.targetId ?? null,
        detailJson: JSON.stringify(opts?.detail ?? {}),
        ip: opts?.actor?.ip ?? null,
        createdAt: now,
      })
      .returning();
    return row;
  }

  async list(
    tenantId: string,
    opts?: { limit?: number; offset?: number; action?: string },
  ): Promise<{ items: NetworkAuditLogDto[]; total: number }> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const offset = Math.max(opts?.offset ?? 0, 0);
    const where = opts?.action
      ? and(eq(networkAuditLogs.tenantId, tenantId), eq(networkAuditLogs.action, opts.action))
      : eq(networkAuditLogs.tenantId, tenantId);

    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(networkAuditLogs)
      .where(where);
    const rows = await this.db
      .select()
      .from(networkAuditLogs)
      .where(where)
      .orderBy(desc(networkAuditLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      items: rows.map(serializeAuditLog),
      total: countRow?.count ?? 0,
    };
  }

  async countSince(tenantId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(networkAuditLogs)
      .where(
        and(eq(networkAuditLogs.tenantId, tenantId), gte(networkAuditLogs.createdAt, since)),
      );
    return row?.count ?? 0;
  }
}
