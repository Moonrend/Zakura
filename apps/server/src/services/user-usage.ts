/**
 * Per-user usage telemetry.
 *
 * This is the product data plane: append-only events + daily rollups,
 * queried by userId. It is not printed and must not be copied onto stdout
 * or Prometheus labels (cardinality + privacy).
 */
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  isUserUsageAction,
  isUserUsageCategory,
  type UserUsageAction,
  type UserUsageActorKind,
  type UserUsageCategory,
  type UserUsageEventDto,
  type UserUsageSessionRowDto,
  type UserUsageSummaryDto,
  type UserUsageTenantRowDto,
} from "@zakura/shared";
import { recordPlatformFault } from "@zakura/core";
import type { Db } from "../db/client.js";
import {
  cloudAgentSessions,
  newId,
  tenantMemberships,
  userUsageDaily,
  userUsageEvents,
  users,
} from "../db/schema.js";

const SUMMARY_MAX = 120;
const EVENT_RETENTION_DAYS = 90;

export type UserUsageRecordInput = {
  tenantId: string;
  userId: string;
  actorKind?: UserUsageActorKind;
  category: UserUsageCategory;
  action: UserUsageAction;
  status?: "ok" | "error";
  durationMs?: number;
  agentId?: string | null;
  sessionId?: string | null;
  resourceKind?: string | null;
  resourceId?: string | null;
  summary?: string;
};

export function utcDay(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export function sanitizeUsageSummary(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX);
}

function isHumanUserId(userId: string | null | undefined): userId is string {
  return !!userId && userId !== "api-key";
}

export class UserUsageStore {
  constructor(private readonly db: Db) {}

  async record(input: UserUsageRecordInput): Promise<void> {
    if (!isHumanUserId(input.userId)) return;
    if (!isUserUsageCategory(input.category) || !isUserUsageAction(input.action)) return;
    const now = new Date();
    const status = input.status ?? "ok";
    const durationMs = Math.max(0, Math.round(input.durationMs ?? 0));
    try {
      await this.db.insert(userUsageEvents).values({
        id: newId(),
        tenantId: input.tenantId,
        userId: input.userId,
        actorKind: input.actorKind ?? "user",
        category: input.category,
        action: input.action,
        status,
        durationMs,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        resourceKind: input.resourceKind ?? null,
        resourceId: input.resourceId ?? null,
        summary: sanitizeUsageSummary(input.summary),
        createdAt: now,
      });
      await this.bumpDaily(input, status, durationMs, now);
    } catch (err) {
      recordPlatformFault("user_usage.record", err, { subsystem: "user_usage" });
    }
  }

  private async bumpDaily(
    input: UserUsageRecordInput,
    status: "ok" | "error",
    durationMs: number,
    now: Date,
  ): Promise<void> {
    const day = utcDay(now);
    const logins = input.action === "login" ? 1 : 0;
    const sessionsStarted = input.action === "session_created" ? 1 : 0;
    const runsOk = input.action === "run_completed" ? 1 : 0;
    const runsError =
      input.action === "run_failed" || input.action === "run_cancelled" ? 1 : 0;
    const toolCalls = input.action === "tool_called" ? 1 : 0;
    const toolErrors = input.action === "tool_called" && status === "error" ? 1 : 0;
    await this.db
      .insert(userUsageDaily)
      .values({
        id: newId(),
        tenantId: input.tenantId,
        userId: input.userId,
        day,
        logins,
        sessionsStarted,
        runsOk,
        runsError,
        toolCalls,
        toolErrors,
        durationMs,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [userUsageDaily.tenantId, userUsageDaily.userId, userUsageDaily.day],
        set: {
          logins: sql`${userUsageDaily.logins} + ${logins}`,
          sessionsStarted: sql`${userUsageDaily.sessionsStarted} + ${sessionsStarted}`,
          runsOk: sql`${userUsageDaily.runsOk} + ${runsOk}`,
          runsError: sql`${userUsageDaily.runsError} + ${runsError}`,
          toolCalls: sql`${userUsageDaily.toolCalls} + ${toolCalls}`,
          toolErrors: sql`${userUsageDaily.toolErrors} + ${toolErrors}`,
          durationMs: sql`${userUsageDaily.durationMs} + ${durationMs}`,
          lastSeenAt: now,
        },
      });
  }

  async listEvents(opts: {
    userId: string;
    tenantId?: string | null;
    category?: UserUsageCategory;
    since?: Date;
    until?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ items: UserUsageEventDto[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const filters = [eq(userUsageEvents.userId, opts.userId)];
    if (opts.tenantId) filters.push(eq(userUsageEvents.tenantId, opts.tenantId));
    if (opts.category) filters.push(eq(userUsageEvents.category, opts.category));
    if (opts.since) filters.push(gte(userUsageEvents.createdAt, opts.since));
    if (opts.until) filters.push(lte(userUsageEvents.createdAt, opts.until));
    const where = and(...filters);
    const [rows, countRow] = await Promise.all([
      this.db
        .select()
        .from(userUsageEvents)
        .where(where)
        .orderBy(desc(userUsageEvents.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(userUsageEvents)
        .where(where),
    ]);
    return {
      items: rows.map(toEventDto),
      total: Number(countRow[0]?.n ?? 0),
    };
  }

  async summarize(opts: {
    userId: string;
    tenantId?: string | null;
    days?: number;
  }): Promise<UserUsageSummaryDto> {
    const days = Math.min(Math.max(opts.days ?? 30, 1), 400);
    const sinceDay = utcDay(new Date(Date.now() - (days - 1) * 86_400_000));
    const filters = [
      eq(userUsageDaily.userId, opts.userId),
      gte(userUsageDaily.day, sinceDay),
    ];
    if (opts.tenantId) filters.push(eq(userUsageDaily.tenantId, opts.tenantId));
    const rows = await this.db
      .select()
      .from(userUsageDaily)
      .where(and(...filters))
      .orderBy(userUsageDaily.day);
    const byDay = new Map<string, UserUsageSummaryDto["series"][number]>();
    for (const row of rows) {
      const cur = byDay.get(row.day) ?? emptyDay(row.day);
      cur.logins += row.logins;
      cur.sessionsStarted += row.sessionsStarted;
      cur.runsOk += row.runsOk;
      cur.runsError += row.runsError;
      cur.toolCalls += row.toolCalls;
      cur.toolErrors += row.toolErrors;
      cur.durationMs += row.durationMs;
      const seen = row.lastSeenAt?.toISOString() ?? null;
      if (seen && (!cur.lastSeenAt || seen > cur.lastSeenAt)) cur.lastSeenAt = seen;
      byDay.set(row.day, cur);
    }
    const series = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    const totals = series.reduce(
      (acc, d) => ({
        logins: acc.logins + d.logins,
        sessionsStarted: acc.sessionsStarted + d.sessionsStarted,
        runsOk: acc.runsOk + d.runsOk,
        runsError: acc.runsError + d.runsError,
        toolCalls: acc.toolCalls + d.toolCalls,
        toolErrors: acc.toolErrors + d.toolErrors,
        durationMs: acc.durationMs + d.durationMs,
      }),
      {
        logins: 0,
        sessionsStarted: 0,
        runsOk: 0,
        runsError: 0,
        toolCalls: 0,
        toolErrors: 0,
        durationMs: 0,
      },
    );
    const lastSeenAt = series.reduce<string | null>((acc, d) => {
      if (!d.lastSeenAt) return acc;
      if (!acc || d.lastSeenAt > acc) return d.lastSeenAt;
      return acc;
    }, null);
    return {
      userId: opts.userId,
      tenantId: opts.tenantId ?? null,
      lastSeenAt,
      days,
      totals,
      series,
    };
  }

  async listTenantUsers(opts: {
    tenantId: string;
    days?: number;
    limit?: number;
  }): Promise<UserUsageTenantRowDto[]> {
    const days = Math.min(Math.max(opts.days ?? 30, 1), 400);
    const sinceDay = utcDay(new Date(Date.now() - (days - 1) * 86_400_000));
    const members = await this.db
      .select({
        userId: tenantMemberships.userId,
        email: users.email,
        name: users.name,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .where(eq(tenantMemberships.tenantId, opts.tenantId));
    if (members.length === 0) return [];
    const ids = members.map((m) => m.userId);
    const rolls = await this.db
      .select({
        userId: userUsageDaily.userId,
        logins: sql<number>`coalesce(sum(${userUsageDaily.logins}), 0)::int`,
        sessionsStarted: sql<number>`coalesce(sum(${userUsageDaily.sessionsStarted}), 0)::int`,
        runsOk: sql<number>`coalesce(sum(${userUsageDaily.runsOk}), 0)::int`,
        runsError: sql<number>`coalesce(sum(${userUsageDaily.runsError}), 0)::int`,
        toolCalls: sql<number>`coalesce(sum(${userUsageDaily.toolCalls}), 0)::int`,
        lastSeenAt: sql<Date | null>`max(${userUsageDaily.lastSeenAt})`,
      })
      .from(userUsageDaily)
      .where(
        and(
          eq(userUsageDaily.tenantId, opts.tenantId),
          inArray(userUsageDaily.userId, ids),
          gte(userUsageDaily.day, sinceDay),
        ),
      )
      .groupBy(userUsageDaily.userId);
    const byUser = new Map(rolls.map((r) => [r.userId, r]));
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    return members
      .map((m) => {
        const r = byUser.get(m.userId);
        return {
          userId: m.userId,
          email: m.email,
          name: m.name,
          lastSeenAt: r?.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : null,
          logins: Number(r?.logins ?? 0),
          sessionsStarted: Number(r?.sessionsStarted ?? 0),
          runsOk: Number(r?.runsOk ?? 0),
          runsError: Number(r?.runsError ?? 0),
          toolCalls: Number(r?.toolCalls ?? 0),
        };
      })
      .sort((a, b) => {
        const at = a.lastSeenAt ?? "";
        const bt = b.lastSeenAt ?? "";
        return bt.localeCompare(at);
      })
      .slice(0, limit);
  }

  async listSessions(opts: {
    userId: string;
    tenantId?: string | null;
    limit?: number;
  }): Promise<UserUsageSessionRowDto[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const filters = [eq(cloudAgentSessions.createdByUserId, opts.userId)];
    if (opts.tenantId) filters.push(eq(cloudAgentSessions.tenantId, opts.tenantId));
    const rows = await this.db
      .select({
        id: cloudAgentSessions.id,
        tenantId: cloudAgentSessions.tenantId,
        agentId: cloudAgentSessions.agentId,
        title: cloudAgentSessions.title,
        kind: cloudAgentSessions.kind,
        status: cloudAgentSessions.status,
        updatedAt: cloudAgentSessions.updatedAt,
      })
      .from(cloudAgentSessions)
      .where(and(...filters))
      .orderBy(desc(cloudAgentSessions.updatedAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      agentId: r.agentId,
      title: r.title,
      kind: r.kind,
      status: r.status,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async purgeExpired(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000);
    await this.db.delete(userUsageEvents).where(lte(userUsageEvents.createdAt, cutoff));
  }
}

function emptyDay(day: string): UserUsageSummaryDto["series"][number] {
  return {
    day,
    logins: 0,
    sessionsStarted: 0,
    runsOk: 0,
    runsError: 0,
    toolCalls: 0,
    toolErrors: 0,
    durationMs: 0,
    lastSeenAt: null,
  };
}

function toEventDto(row: typeof userUsageEvents.$inferSelect): UserUsageEventDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    actorKind: row.actorKind as UserUsageEventDto["actorKind"],
    category: row.category as UserUsageEventDto["category"],
    action: row.action as UserUsageEventDto["action"],
    status: row.status === "error" ? "error" : "ok",
    durationMs: row.durationMs,
    agentId: row.agentId,
    sessionId: row.sessionId,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}

let bound: UserUsageStore | null = null;

export function bindUserUsage(db: Db): UserUsageStore {
  bound = new UserUsageStore(db);
  return bound;
}

export function getUserUsage(): UserUsageStore | null {
  return bound;
}

/** Fire-and-forget. Safe on hot paths. */
export function recordUserUsage(input: UserUsageRecordInput): void {
  if (!bound) return;
  void bound.record(input);
}
