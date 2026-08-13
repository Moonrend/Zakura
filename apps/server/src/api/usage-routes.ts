import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { isUserUsageCategory } from "@zakura/shared";
import { isSessionAdmin } from "../services/auth.js";
import { tenantMemberships } from "../db/schema.js";
import type { Db } from "../db/client.js";
import type { UserUsageStore } from "../services/user-usage.js";

type Session = {
  userId: string;
  tenantId: string;
  role: string;
  isPlatformAdmin?: boolean;
};

function parseDays(raw: string | undefined, fallback = 30): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), 400);
}

export function registerUsageRoutes(
  app: Hono<{ Variables: { session: Session } }>,
  deps: { db: Db; usage: UserUsageStore },
): void {
  const { db, usage } = deps;

  async function assertCanReadUser(session: Session, userId: string, scopeAll: boolean) {
    if (session.userId === "api-key") return { ok: false as const, status: 403 as const };
    if (session.userId === userId && !scopeAll) return { ok: true as const, tenantId: session.tenantId };
    if (scopeAll) {
      if (!session.isPlatformAdmin) return { ok: false as const, status: 403 as const };
      return { ok: true as const, tenantId: null };
    }
    if (!isSessionAdmin(session)) return { ok: false as const, status: 403 as const };
    const member = await db.query.tenantMemberships.findFirst({
      where: and(
        eq(tenantMemberships.tenantId, session.tenantId),
        eq(tenantMemberships.userId, userId),
      ),
    });
    if (!member) return { ok: false as const, status: 404 as const };
    return { ok: true as const, tenantId: session.tenantId };
  }

  app.get("/api/usage/me", async (c) => {
    const session = c.get("session");
    if (session.userId === "api-key") return c.json({ error: "User session required" }, 403);
    const days = parseDays(c.req.query("days"));
    const category = c.req.query("category");
    const [summary, events, sessions] = await Promise.all([
      usage.summarize({ userId: session.userId, tenantId: session.tenantId, days }),
      usage.listEvents({
        userId: session.userId,
        tenantId: session.tenantId,
        category: category && isUserUsageCategory(category) ? category : undefined,
        limit: 50,
      }),
      usage.listSessions({ userId: session.userId, tenantId: session.tenantId, limit: 20 }),
    ]);
    return c.json({ summary, events: events.items, eventTotal: events.total, sessions });
  });

  app.get("/api/usage/users", async (c) => {
    const session = c.get("session");
    if (!isSessionAdmin(session) && !session.isPlatformAdmin) {
      return c.json({ error: "Admin only" }, 403);
    }
    const days = parseDays(c.req.query("days"));
    const rows = await usage.listTenantUsers({ tenantId: session.tenantId, days });
    return c.json({ days, users: rows });
  });

  app.get("/api/usage/users/:userId", async (c) => {
    const session = c.get("session");
    const userId = c.req.param("userId");
    const scopeAll = c.req.query("scope") === "all";
    const access = await assertCanReadUser(session, userId, scopeAll);
    if (!access.ok) return c.json({ error: "Forbidden" }, access.status);
    const days = parseDays(c.req.query("days"));
    const category = c.req.query("category");
    const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const [summary, events, sessions] = await Promise.all([
      usage.summarize({ userId, tenantId: access.tenantId, days }),
      usage.listEvents({
        userId,
        tenantId: access.tenantId,
        category: category && isUserUsageCategory(category) ? category : undefined,
        limit,
        offset,
      }),
      usage.listSessions({ userId, tenantId: access.tenantId, limit: 20 }),
    ]);
    return c.json({ summary, events: events.items, eventTotal: events.total, sessions });
  });
}
