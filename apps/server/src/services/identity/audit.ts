import { and, desc, eq, gte, lte, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { newId, securityAuditLogs, settings, tenants } from "../../db/schema.js";
import { parseJsonObject, redactAuditDetail } from "./util.js";

export type SecurityAuditActor = {
  type: "user" | "scim" | "system" | "admin";
  id?: string | null;
  ip?: string | null;
};

export type SecurityAuditLogDto = {
  id: string;
  tenantId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
};

const DEFAULT_RETENTION_DAYS = 365;
const IDENTITY_SETTINGS_KEY = "identity.audit";

export function serializeSecurityAudit(row: {
  id: string;
  tenantId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detailJson: string;
  ip: string | null;
  createdAt: Date;
}): SecurityAuditLogDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    detail: parseJsonObject(row.detailJson),
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  };
}

export class SecurityAuditService {
  constructor(private readonly db: Db) {}

  async append(
    tenantId: string | null | undefined,
    action: string,
    opts?: {
      actor?: SecurityAuditActor;
      targetType?: string;
      targetId?: string;
      detail?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!tenantId) return;
    const detail = redactAuditDetail(opts?.detail ?? {});
    await this.db.insert(securityAuditLogs).values({
      id: newId(),
      tenantId,
      actorType: opts?.actor?.type ?? "system",
      actorId: opts?.actor?.id ?? null,
      action,
      targetType: opts?.targetType ?? null,
      targetId: opts?.targetId ?? null,
      detailJson: JSON.stringify(detail),
      ip: opts?.actor?.ip ?? null,
      createdAt: new Date(),
    });
  }

  async list(
    tenantId: string,
    opts?: {
      limit?: number;
      offset?: number;
      action?: string;
      actorId?: string;
      since?: Date;
      until?: Date;
    },
  ): Promise<{ items: SecurityAuditLogDto[]; total: number }> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const offset = Math.max(opts?.offset ?? 0, 0);
    const filters = [eq(securityAuditLogs.tenantId, tenantId)];
    if (opts?.action) filters.push(eq(securityAuditLogs.action, opts.action));
    if (opts?.actorId) filters.push(eq(securityAuditLogs.actorId, opts.actorId));
    if (opts?.since) filters.push(gte(securityAuditLogs.createdAt, opts.since));
    if (opts?.until) filters.push(lte(securityAuditLogs.createdAt, opts.until));
    const where = and(...filters);

    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(securityAuditLogs)
      .where(where);
    const rows = await this.db
      .select()
      .from(securityAuditLogs)
      .where(where)
      .orderBy(desc(securityAuditLogs.createdAt))
      .limit(limit)
      .offset(offset);
    return { items: rows.map(serializeSecurityAudit), total: countRow?.count ?? 0 };
  }

  async listAll(tenantId: string, opts?: { action?: string; since?: Date; until?: Date }) {
    const filters = [eq(securityAuditLogs.tenantId, tenantId)];
    if (opts?.action) filters.push(eq(securityAuditLogs.action, opts.action));
    if (opts?.since) filters.push(gte(securityAuditLogs.createdAt, opts.since));
    if (opts?.until) filters.push(lte(securityAuditLogs.createdAt, opts.until));
    const rows = await this.db
      .select()
      .from(securityAuditLogs)
      .where(and(...filters))
      .orderBy(desc(securityAuditLogs.createdAt))
      .limit(5000);
    return rows.map(serializeSecurityAudit);
  }

  async retentionDays(tenantId: string): Promise<number> {
    const row = await this.db.query.settings.findFirst({
      where: and(eq(settings.ownerKey, `tenant:${tenantId}`), eq(settings.key, IDENTITY_SETTINGS_KEY)),
    });
    const days = Number(parseJsonObject(row?.value).retentionDays);
    if (!Number.isFinite(days) || days < 7) return DEFAULT_RETENTION_DAYS;
    return Math.min(Math.floor(days), 3650);
  }

  async setRetentionDays(tenantId: string, days: number): Promise<number> {
    const retentionDays = Math.min(Math.max(Math.floor(days), 7), 3650);
    const ownerKey = `tenant:${tenantId}`;
    const existing = await this.db.query.settings.findFirst({
      where: and(eq(settings.ownerKey, ownerKey), eq(settings.key, IDENTITY_SETTINGS_KEY)),
    });
    const value = JSON.stringify({ retentionDays });
    if (existing) {
      await this.db.update(settings).set({ value }).where(eq(settings.id, existing.id));
    } else {
      await this.db.insert(settings).values({
        id: newId(),
        ownerKey,
        key: IDENTITY_SETTINGS_KEY,
        value,
      });
    }
    return retentionDays;
  }

  async purgeExpired(): Promise<number> {
    const rows = await this.db.select({ id: tenants.id }).from(tenants);
    let deleted = 0;
    for (const tenant of rows) {
      const days = await this.retentionDays(tenant.id);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const result = await this.db
        .delete(securityAuditLogs)
        .where(and(eq(securityAuditLogs.tenantId, tenant.id), lt(securityAuditLogs.createdAt, cutoff)))
        .returning();
      deleted += result.length;
    }
    return deleted;
  }
}

export function auditToCsv(items: SecurityAuditLogDto[]): string {
  const header = ["createdAt", "action", "actorType", "actorId", "targetType", "targetId", "ip", "detail"];
  const lines = [header.join(",")];
  for (const item of items) {
    const cells = [
      item.createdAt,
      item.action,
      item.actorType,
      item.actorId ?? "",
      item.targetType ?? "",
      item.targetId ?? "",
      item.ip ?? "",
      JSON.stringify(item.detail),
    ].map(csvCell);
    lines.push(cells.join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}
