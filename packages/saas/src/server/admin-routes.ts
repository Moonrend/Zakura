/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { RegisterError, registerSaasUser } from "./register-user.js";
import type { SaasApp, SaasHostDeps, SaasSession } from "./types.js";
import type { OauthSchema } from "./oauth-zerocat.js";

/**
 * 平台超管后台的资源型 API：用户 / 团队 / 共享 Runner 的列表（服务端分页 + 搜索 +
 * 排序 + 筛选）与 CRUD，外加封号（suspend）。
 *
 * 表结构由宿主注入（deps.schema），这里刻意保持鸭子类型，避免 @zakura/saas
 * 反向依赖 @zakura/server。
 */

type AnyDb = any;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export type AdminListQuery = {
  q: string;
  page: number;
  pageSize: number;
  sort: string;
  order: "asc" | "desc";
  status: string;
  offset: number;
};

/** 统一解析列表参数；page 从 1 开始 */
export function parseListQuery(
  url: URL,
  opts: { sortable: readonly string[]; defaultSort: string; defaultOrder?: "asc" | "desc" },
): AdminListQuery {
  const rawPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const rawSize = Number.parseInt(url.searchParams.get("pageSize") ?? "", 10);
  const pageSize = Number.isFinite(rawSize)
    ? Math.min(Math.max(rawSize, 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  const requestedSort = url.searchParams.get("sort") ?? "";
  const sort = opts.sortable.includes(requestedSort) ? requestedSort : opts.defaultSort;

  const requestedOrder = url.searchParams.get("order");
  const order: "asc" | "desc" =
    requestedOrder === "asc" || requestedOrder === "desc"
      ? requestedOrder
      : (opts.defaultOrder ?? "desc");

  return {
    q: (url.searchParams.get("q") ?? "").trim(),
    page,
    pageSize,
    sort,
    order,
    status: (url.searchParams.get("status") ?? "all").trim() || "all",
    offset: (page - 1) * pageSize,
  };
}

function likeTerm(q: string): string {
  // 转义 LIKE 通配符，避免用户输入的 % / _ 变成通配
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function orderBy(column: unknown, order: "asc" | "desc") {
  return order === "asc" ? asc(column as never) : desc(column as never);
}

function mapSuspension(row: {
  suspendedAt?: Date | null;
  suspendedReason?: string | null;
  suspendedByUserId?: string | null;
}) {
  return {
    suspended: !!row.suspendedAt,
    suspendedAt: row.suspendedAt ? row.suspendedAt.toISOString() : null,
    suspendedReason: row.suspendedReason ?? null,
    suspendedByUserId: row.suspendedByUserId ?? null,
  };
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

export type AdminRoutesDeps = SaasHostDeps & {
  schema: OauthSchema;
};

export function registerAdminResourceRoutes(app: SaasApp, deps: AdminRoutesDeps) {
  const db = deps.db as AnyDb;
  const users = deps.schema.users as AnyDb;
  const tenants = deps.schema.tenants as AnyDb;
  const tenantMemberships = deps.schema.tenantMemberships as AnyDb;
  const oauthIdentities = deps.schema.oauthIdentities as AnyDb;
  const newId = deps.schema.newId;
  const tenantService = deps.tenants;

  const bumpUser = (id: string) => deps.invalidateSuspension?.("user", id);
  const bumpTenant = (id: string) => deps.invalidateSuspension?.("tenant", id);

  /** 平台至少保留一个未封禁的管理员 */
  async function otherActiveAdminCount(excludeUserId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(users)
      .where(
        and(
          eq(users.isPlatformAdmin, true),
          isNull(users.suspendedAt),
          ne(users.id, excludeUserId),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async function membershipSummary(
    userIds: string[],
  ): Promise<Map<string, Array<{ tenantId: string; slug: string; name: string; role: string }>>> {
    const byUser = new Map<
      string,
      Array<{ tenantId: string; slug: string; name: string; role: string }>
    >();
    if (!userIds.length) return byUser;
    const rows = await db
      .select({
        userId: tenantMemberships.userId,
        role: tenantMemberships.role,
        tenantId: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        tenantSuspendedAt: tenants.suspendedAt,
      })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(
        and(
          inArray(tenantMemberships.userId, userIds),
          eq(tenantMemberships.status, "active"),
        ),
      );
    for (const r of rows as Array<Record<string, any>>) {
      const list = byUser.get(r.userId) ?? [];
      list.push({ tenantId: r.tenantId, slug: r.slug, name: r.name, role: r.role });
      byUser.set(r.userId, list);
    }
    return byUser;
  }

  // ── 概览统计 ──────────────────────────────────────────────────────────
  app.get("/api/admin/stats", async (c) => {
    const since = daysAgo(7);
    const [
      [userTotal],
      [userSuspended],
      [userAdmins],
      [userNew],
      [tenantTotal],
      [tenantSuspended],
      [tenantNew],
    ] = await Promise.all([
      db.select({ n: count() }).from(users),
      db.select({ n: count() }).from(users).where(isNotNull(users.suspendedAt)),
      db.select({ n: count() }).from(users).where(eq(users.isPlatformAdmin, true)),
      db.select({ n: count() }).from(users).where(sql`${users.createdAt} >= ${since}`),
      db.select({ n: count() }).from(tenants),
      db.select({ n: count() }).from(tenants).where(isNotNull(tenants.suspendedAt)),
      db.select({ n: count() }).from(tenants).where(sql`${tenants.createdAt} >= ${since}`),
    ]);

    let runners = { total: 0, shared: 0, online: 0 };
    if (deps.runtimeNodes) {
      const rows = await deps.runtimeNodes.listAllRemote().catch(() => []);
      runners = {
        total: rows.length,
        shared: rows.filter((r) => r.isShared).length,
        online: rows.filter((r) => r.status === "online" || r.status === "ready").length,
      };
    }

    return c.json({
      users: {
        total: Number(userTotal?.n ?? 0),
        suspended: Number(userSuspended?.n ?? 0),
        admins: Number(userAdmins?.n ?? 0),
        newLast7d: Number(userNew?.n ?? 0),
      },
      tenants: {
        total: Number(tenantTotal?.n ?? 0),
        suspended: Number(tenantSuspended?.n ?? 0),
        newLast7d: Number(tenantNew?.n ?? 0),
      },
      runners,
    });
  });

  // ── 用户列表 ──────────────────────────────────────────────────────────
  const USER_SORTABLE = ["email", "name", "createdAt"] as const;
  const userSortColumn: Record<string, unknown> = {
    email: users.email,
    name: users.name,
    createdAt: users.createdAt,
  };

  app.get("/api/admin/users", async (c) => {
    const url = new URL(c.req.url);
    const query = parseListQuery(url, {
      sortable: USER_SORTABLE,
      defaultSort: "createdAt",
    });
    const role = url.searchParams.get("role") ?? "all";
    const tenantId = url.searchParams.get("tenantId")?.trim() || "";

    const filters: unknown[] = [];
    if (query.q) {
      const term = likeTerm(query.q);
      filters.push(or(ilike(users.email, term), ilike(users.name, term)));
    }
    if (query.status === "suspended") filters.push(isNotNull(users.suspendedAt));
    else if (query.status === "active") filters.push(isNull(users.suspendedAt));
    if (role === "admin") filters.push(eq(users.isPlatformAdmin, true));
    else if (role === "user") filters.push(eq(users.isPlatformAdmin, false));
    if (tenantId) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${tenantMemberships} m WHERE m.user_id = ${users.id} AND m.tenant_id = ${tenantId} AND m.status = 'active')`,
      );
    }
    const where = filters.length ? and(...(filters as never[])) : undefined;

    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(users)
        .where(where as never)
        .orderBy(orderBy(userSortColumn[query.sort], query.order))
        .limit(query.pageSize)
        .offset(query.offset),
      db
        .select({ n: count() })
        .from(users)
        .where(where as never),
    ]);

    const list = rows as Array<Record<string, any>>;
    const byUser = await membershipSummary(list.map((u) => u.id));

    return c.json({
      items: list.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        isPlatformAdmin: u.isPlatformAdmin,
        canUseLocalRunner: u.canUseLocalRunner || u.isPlatformAdmin,
        hasPassword: !!u.passwordHash,
        tenants: byUser.get(u.id) ?? [],
        createdAt: u.createdAt.toISOString(),
        ...mapSuspension(u),
      })),
      total: Number(totalRow?.n ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.post("/api/admin/users", async (c) => {
    const body = await c.req
      .json<{
        email?: string;
        password?: string;
        name?: string;
        tenantName?: string;
        isPlatformAdmin?: boolean;
        canUseLocalRunner?: boolean;
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.email || !body.password) {
      return c.json({ error: "email 与 password 必填" }, 400);
    }
    try {
      const result = await registerSaasUser(deps.db, deps.schema, {
        email: body.email,
        password: body.password,
        name: body.name,
        tenantName: body.tenantName,
      });
      const isAdmin = body.isPlatformAdmin === true;
      if (isAdmin || body.canUseLocalRunner === true) {
        await db
          .update(users)
          .set({
            isPlatformAdmin: isAdmin,
            canUseLocalRunner: isAdmin || body.canUseLocalRunner === true,
            updatedAt: new Date(),
          })
          .where(eq(users.id, result.user.id));
      }
      await deps.onTenantCreated?.(result.tenant.id).catch(() => undefined);
      return c.json(
        {
          user: {
            id: result.user.id,
            email: result.user.email,
            name: result.user.name,
            isPlatformAdmin: isAdmin,
          },
          tenant: result.tenant,
        },
        201,
      );
    } catch (err) {
      if (err instanceof RegisterError) {
        return c.json({ error: err.message }, err.status as 400 | 409);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/admin/users/:id", async (c) => {
    const id = c.req.param("id");
    const user = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (!user) return c.json({ error: "Not found" }, 404);

    const [memberships, identities] = await Promise.all([
      db
        .select({
          membershipId: tenantMemberships.id,
          role: tenantMemberships.role,
          status: tenantMemberships.status,
          joinedAt: tenantMemberships.createdAt,
          tenantId: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          tenantSuspendedAt: tenants.suspendedAt,
        })
        .from(tenantMemberships)
        .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
        .where(eq(tenantMemberships.userId, id))
        .orderBy(asc(tenantMemberships.createdAt)),
      db
        .select({ provider: oauthIdentities.provider, createdAt: oauthIdentities.createdAt })
        .from(oauthIdentities)
        .where(eq(oauthIdentities.userId, id)),
    ]);

    let runners: Array<{ id: string; name: string; status: string; isShared: boolean }> = [];
    if (deps.runtimeNodes) {
      const all = await deps.runtimeNodes.listAllRemote().catch(() => []);
      runners = all
        .filter((n) => n.createdByUserId === id)
        .map((n) => ({ id: n.id, name: n.name, status: n.status, isShared: n.isShared }));
    }

    let suspendedBy: { id: string; email: string } | null = null;
    if (user.suspendedByUserId) {
      const actor = await db.query.users.findFirst({
        where: eq(users.id, user.suspendedByUserId),
      });
      if (actor) suspendedBy = { id: actor.id, email: actor.email };
    }

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPlatformAdmin: user.isPlatformAdmin,
        canUseLocalRunner: user.canUseLocalRunner || user.isPlatformAdmin,
        hasPassword: !!user.passwordHash,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
        ...mapSuspension(user),
        suspendedBy,
      },
      memberships: (memberships as Array<Record<string, any>>).map((m) => ({
        membershipId: m.membershipId,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt.toISOString(),
        tenantId: m.tenantId,
        slug: m.slug,
        name: m.name,
        tenantSuspended: !!m.tenantSuspendedAt,
      })),
      identities: (identities as Array<Record<string, any>>).map((i) => ({
        provider: i.provider,
        createdAt: i.createdAt.toISOString(),
      })),
      runners,
    });
  });

  app.patch("/api/admin/users/:id", async (c) => {
    const session = c.get("session") as SaasSession;
    const id = c.req.param("id");
    const body = await c.req
      .json<{
        name?: string | null;
        email?: string;
        password?: string;
        canUseLocalRunner?: boolean;
        isPlatformAdmin?: boolean;
      }>()
      .catch(() => ({}) as Record<string, never>);

    const target = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (!target) return c.json({ error: "Not found" }, 404);

    if (body.isPlatformAdmin === false && target.id === session.userId) {
      return c.json({ error: "不能取消自己的平台管理员身份" }, 400);
    }
    if (
      body.isPlatformAdmin === false &&
      target.isPlatformAdmin &&
      (await otherActiveAdminCount(target.id)) === 0
    ) {
      return c.json({ error: "至少保留一个平台管理员" }, 400);
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (body.email !== undefined) {
      const email = body.email.trim().toLowerCase();
      if (!email.includes("@")) return c.json({ error: "邮箱格式不正确" }, 400);
      if (email !== target.email) {
        const clash = await db.query.users.findFirst({ where: eq(users.email, email) });
        if (clash) return c.json({ error: "该邮箱已被占用" }, 409);
        patch.email = email;
      }
    }
    if (body.name !== undefined) patch.name = body.name?.trim() || null;
    if (body.password !== undefined) {
      if (body.password.length < 8) return c.json({ error: "密码至少 8 位" }, 400);
      patch.passwordHash = await bcrypt.hash(body.password, 12);
    }

    const nextAdmin =
      body.isPlatformAdmin !== undefined ? body.isPlatformAdmin : target.isPlatformAdmin;
    let nextLocal =
      body.canUseLocalRunner !== undefined ? body.canUseLocalRunner : target.canUseLocalRunner;
    // 平台管理员始终视为已授权 Local Runner
    if (nextAdmin) nextLocal = true;
    patch.isPlatformAdmin = nextAdmin;
    patch.canUseLocalRunner = nextLocal;

    const [updated] = await db
      .update(users)
      .set(patch)
      .where(eq(users.id, target.id))
      .returning();
    if (!updated) return c.json({ error: "Update failed" }, 500);

    bumpUser(target.id);
    return c.json({
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        isPlatformAdmin: updated.isPlatformAdmin,
        canUseLocalRunner: updated.canUseLocalRunner || updated.isPlatformAdmin,
        hasPassword: !!updated.passwordHash,
        ...mapSuspension(updated),
      },
    });
  });

  // ── 封号 / 解封 ───────────────────────────────────────────────────────
  app.post("/api/admin/users/:id/suspend", async (c) => {
    const session = c.get("session") as SaasSession;
    const id = c.req.param("id");
    const body = await c.req
      .json<{ reason?: string }>()
      .catch(() => ({}) as { reason?: string });

    const target = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (!target) return c.json({ error: "Not found" }, 404);
    if (target.id === session.userId) return c.json({ error: "不能封禁自己" }, 400);
    if (target.isPlatformAdmin && (await otherActiveAdminCount(target.id)) === 0) {
      return c.json({ error: "至少保留一个未封禁的平台管理员" }, 400);
    }
    if (target.suspendedAt) return c.json({ error: "该用户已被封禁" }, 409);

    const now = new Date();
    const [updated] = await db
      .update(users)
      .set({
        suspendedAt: now,
        suspendedReason: body.reason?.trim() || null,
        suspendedByUserId: session.userId,
        updatedAt: now,
      })
      .where(eq(users.id, target.id))
      .returning();

    bumpUser(target.id);
    return c.json({ user: { id: updated.id, ...mapSuspension(updated) } });
  });

  app.post("/api/admin/users/:id/unsuspend", async (c) => {
    const id = c.req.param("id");
    const target = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (!target) return c.json({ error: "Not found" }, 404);

    const [updated] = await db
      .update(users)
      .set({
        suspendedAt: null,
        suspendedReason: null,
        suspendedByUserId: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, target.id))
      .returning();

    bumpUser(target.id);
    return c.json({ user: { id: updated.id, ...mapSuspension(updated) } });
  });

  app.delete("/api/admin/users/:id", async (c) => {
    const session = c.get("session") as SaasSession;
    const id = c.req.param("id");
    const target = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (!target) return c.json({ error: "Not found" }, 404);
    if (target.id === session.userId) return c.json({ error: "不能删除自己" }, 400);
    if (target.isPlatformAdmin && (await otherActiveAdminCount(target.id)) === 0) {
      return c.json({ error: "至少保留一个平台管理员" }, 400);
    }

    // 该用户独占（唯一 owner 且无其他成员）的团队一并删除，否则会留下无人可管的孤儿团队
    const owned = await db
      .select({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.userId, id), eq(tenantMemberships.role, "owner")));

    const orphanTenantIds: string[] = [];
    for (const row of owned as Array<{ tenantId: string }>) {
      const [other] = await db
        .select({ n: count() })
        .from(tenantMemberships)
        .where(
          and(
            eq(tenantMemberships.tenantId, row.tenantId),
            ne(tenantMemberships.userId, id),
          ),
        );
      if (Number(other?.n ?? 0) === 0) orphanTenantIds.push(row.tenantId);
    }

    await db.delete(users).where(eq(users.id, id));
    if (orphanTenantIds.length) {
      await db
        .delete(tenants)
        .where(and(inArray(tenants.id, orphanTenantIds), eq(tenants.isDefault, false)));
      for (const tid of orphanTenantIds) bumpTenant(tid);
    }

    bumpUser(id);
    return c.json({ ok: true, deletedTenants: orphanTenantIds.length });
  });

  // ── 团队列表 ──────────────────────────────────────────────────────────
  const TENANT_SORTABLE = ["name", "slug", "createdAt"] as const;
  const tenantSortColumn: Record<string, unknown> = {
    name: tenants.name,
    slug: tenants.slug,
    createdAt: tenants.createdAt,
  };

  app.get("/api/admin/tenants", async (c) => {
    const url = new URL(c.req.url);
    const query = parseListQuery(url, {
      sortable: TENANT_SORTABLE,
      defaultSort: "createdAt",
    });
    const onboarding = url.searchParams.get("onboarding") ?? "all";

    const filters: unknown[] = [];
    if (query.q) {
      const term = likeTerm(query.q);
      filters.push(or(ilike(tenants.name, term), ilike(tenants.slug, term)));
    }
    if (query.status === "suspended") filters.push(isNotNull(tenants.suspendedAt));
    else if (query.status === "active") filters.push(isNull(tenants.suspendedAt));
    if (onboarding === "completed") filters.push(eq(tenants.onboardingCompleted, true));
    else if (onboarding === "pending") filters.push(eq(tenants.onboardingCompleted, false));
    const where = filters.length ? and(...(filters as never[])) : undefined;

    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(tenants)
        .where(where as never)
        .orderBy(orderBy(tenantSortColumn[query.sort], query.order))
        .limit(query.pageSize)
        .offset(query.offset),
      db
        .select({ n: count() })
        .from(tenants)
        .where(where as never),
    ]);

    const list = rows as Array<Record<string, any>>;
    const ids = list.map((t) => t.id);
    const counts = new Map<string, number>();
    if (ids.length) {
      const grouped = await db
        .select({ tenantId: tenantMemberships.tenantId, n: count() })
        .from(tenantMemberships)
        .where(
          and(
            inArray(tenantMemberships.tenantId, ids),
            eq(tenantMemberships.status, "active"),
          ),
        )
        .groupBy(tenantMemberships.tenantId);
      for (const g of grouped as Array<{ tenantId: string; n: number }>) {
        counts.set(g.tenantId, Number(g.n));
      }
    }

    return c.json({
      items: list.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        isDefault: t.isDefault,
        onboardingCompleted: t.onboardingCompleted,
        memberCount: counts.get(t.id) ?? 0,
        createdAt: t.createdAt.toISOString(),
        ...mapSuspension(t),
      })),
      total: Number(totalRow?.n ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.post("/api/admin/tenants", async (c) => {
    const session = c.get("session") as SaasSession;
    const body = await c.req
      .json<{ name?: string; slug?: string; ownerUserId?: string; ownerEmail?: string }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.name?.trim()) return c.json({ error: "团队名称必填" }, 400);

    let ownerUserId = body.ownerUserId?.trim() || "";
    if (!ownerUserId && body.ownerEmail?.trim()) {
      const owner = await db.query.users.findFirst({
        where: eq(users.email, body.ownerEmail.trim().toLowerCase()),
      });
      if (!owner) return c.json({ error: "找不到该邮箱对应的用户" }, 404);
      ownerUserId = owner.id;
    }
    if (!ownerUserId) ownerUserId = session.userId;

    const owner = await db.query.users.findFirst({ where: eq(users.id, ownerUserId) });
    if (!owner) return c.json({ error: "Owner 用户不存在" }, 404);

    try {
      const created = await tenantService.createTenant({
        name: body.name.trim(),
        slug: body.slug?.trim() || undefined,
        ownerUserId,
      });
      await deps.onTenantCreated?.(created.tenant.id).catch(() => undefined);
      return c.json({ tenant: created.tenant }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/admin/tenants/:id", async (c) => {
    const id = c.req.param("id");
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
    if (!tenant) return c.json({ error: "Not found" }, 404);

    const members = await db
      .select({
        membershipId: tenantMemberships.id,
        role: tenantMemberships.role,
        status: tenantMemberships.status,
        joinedAt: tenantMemberships.createdAt,
        userId: users.id,
        email: users.email,
        name: users.name,
        userSuspendedAt: users.suspendedAt,
        isPlatformAdmin: users.isPlatformAdmin,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .where(eq(tenantMemberships.tenantId, id))
      .orderBy(asc(tenantMemberships.createdAt));

    let runners: Array<{ id: string; name: string; status: string; isShared: boolean }> = [];
    if (deps.runtimeNodes) {
      const all = await deps.runtimeNodes.listAllRemote().catch(() => []);
      runners = all
        .filter((n) => n.tenantId === id)
        .map((n) => ({ id: n.id, name: n.name, status: n.status, isShared: n.isShared }));
    }

    let suspendedBy: { id: string; email: string } | null = null;
    if (tenant.suspendedByUserId) {
      const actor = await db.query.users.findFirst({
        where: eq(users.id, tenant.suspendedByUserId),
      });
      if (actor) suspendedBy = { id: actor.id, email: actor.email };
    }

    return c.json({
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        isDefault: tenant.isDefault,
        onboardingCompleted: tenant.onboardingCompleted,
        createdAt: tenant.createdAt.toISOString(),
        ...mapSuspension(tenant),
        suspendedBy,
      },
      members: (members as Array<Record<string, any>>).map((m) => ({
        membershipId: m.membershipId,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt.toISOString(),
        user: {
          id: m.userId,
          email: m.email,
          name: m.name,
          suspended: !!m.userSuspendedAt,
          isPlatformAdmin: m.isPlatformAdmin,
        },
      })),
      runners,
    });
  });

  app.patch("/api/admin/tenants/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req
      .json<{ name?: string }>()
      .catch(() => ({}) as { name?: string });
    if (!body.name?.trim()) return c.json({ error: "团队名称必填" }, 400);
    try {
      const updated = await tenantService.updateTenant(id, { name: body.name.trim() });
      return c.json({ tenant: { id: updated.id, name: updated.name, slug: updated.slug } });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/admin/tenants/:id/suspend", async (c) => {
    const session = c.get("session") as SaasSession;
    const id = c.req.param("id");
    const body = await c.req
      .json<{ reason?: string }>()
      .catch(() => ({}) as { reason?: string });

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
    if (!tenant) return c.json({ error: "Not found" }, 404);
    if (tenant.isDefault) return c.json({ error: "默认团队不可封禁" }, 400);
    if (tenant.id === session.tenantId) {
      return c.json({ error: "不能封禁自己当前所在的团队" }, 400);
    }
    if (tenant.suspendedAt) return c.json({ error: "该团队已被封禁" }, 409);

    const now = new Date();
    const [updated] = await db
      .update(tenants)
      .set({
        suspendedAt: now,
        suspendedReason: body.reason?.trim() || null,
        suspendedByUserId: session.userId,
        updatedAt: now,
      })
      .where(eq(tenants.id, id))
      .returning();

    bumpTenant(id);
    return c.json({ tenant: { id: updated.id, ...mapSuspension(updated) } });
  });

  app.post("/api/admin/tenants/:id/unsuspend", async (c) => {
    const id = c.req.param("id");
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
    if (!tenant) return c.json({ error: "Not found" }, 404);

    const [updated] = await db
      .update(tenants)
      .set({
        suspendedAt: null,
        suspendedReason: null,
        suspendedByUserId: null,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, id))
      .returning();

    bumpTenant(id);
    return c.json({ tenant: { id: updated.id, ...mapSuspension(updated) } });
  });

  app.delete("/api/admin/tenants/:id", async (c) => {
    const session = c.get("session") as SaasSession;
    const id = c.req.param("id");
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
    if (!tenant) return c.json({ error: "Not found" }, 404);
    if (tenant.isDefault) return c.json({ error: "默认团队不可删除" }, 400);
    if (tenant.id === session.tenantId) {
      return c.json({ error: "不能删除自己当前所在的团队" }, 400);
    }
    await db.delete(tenants).where(eq(tenants.id, id));
    bumpTenant(id);
    return c.json({ ok: true });
  });

  // ── 团队成员 ──────────────────────────────────────────────────────────
  app.post("/api/admin/tenants/:id/members", async (c) => {
    const tenantId = c.req.param("id");
    const body = await c.req
      .json<{ userId?: string; email?: string; role?: string }>()
      .catch(() => ({}) as Record<string, never>);

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!tenant) return c.json({ error: "Not found" }, 404);

    let user: Record<string, any> | null | undefined;
    if (body.userId?.trim()) {
      user = await db.query.users.findFirst({ where: eq(users.id, body.userId.trim()) });
    } else if (body.email?.trim()) {
      user = await db.query.users.findFirst({
        where: eq(users.email, body.email.trim().toLowerCase()),
      });
    }
    if (!user) return c.json({ error: "找不到该用户" }, 404);

    const role = body.role === "owner" || body.role === "admin" ? body.role : "member";
    const existing = await db.query.tenantMemberships.findFirst({
      where: and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, user.id),
      ),
    });
    if (existing) return c.json({ error: "该用户已在团队中" }, 409);

    const now = new Date();
    await db.insert(tenantMemberships).values({
      id: newId(),
      tenantId,
      userId: user.id,
      role,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ ok: true }, 201);
  });

  app.patch("/api/admin/tenants/:id/members/:membershipId", async (c) => {
    const tenantId = c.req.param("id");
    const membershipId = c.req.param("membershipId");
    const body = await c.req
      .json<{ role?: string; status?: string }>()
      .catch(() => ({}) as Record<string, never>);

    const membership = await db.query.tenantMemberships.findFirst({
      where: and(
        eq(tenantMemberships.id, membershipId),
        eq(tenantMemberships.tenantId, tenantId),
      ),
    });
    if (!membership) return c.json({ error: "Not found" }, 404);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.role) {
      if (!["owner", "admin", "member"].includes(body.role)) {
        return c.json({ error: "role 必须是 owner / admin / member" }, 400);
      }
      // 降级最后一个 owner 会让团队失去管理者
      if (membership.role === "owner" && body.role !== "owner") {
        const [other] = await db
          .select({ n: count() })
          .from(tenantMemberships)
          .where(
            and(
              eq(tenantMemberships.tenantId, tenantId),
              eq(tenantMemberships.role, "owner"),
              ne(tenantMemberships.id, membershipId),
            ),
          );
        if (Number(other?.n ?? 0) === 0) {
          return c.json({ error: "团队至少保留一个 owner" }, 400);
        }
      }
      patch.role = body.role;
    }
    if (body.status) {
      if (!["active", "suspended"].includes(body.status)) {
        return c.json({ error: "status 必须是 active / suspended" }, 400);
      }
      patch.status = body.status;
    }

    const [updated] = await db
      .update(tenantMemberships)
      .set(patch)
      .where(eq(tenantMemberships.id, membershipId))
      .returning();
    return c.json({ membership: { id: updated.id, role: updated.role, status: updated.status } });
  });

  app.delete("/api/admin/tenants/:id/members/:membershipId", async (c) => {
    const tenantId = c.req.param("id");
    const membershipId = c.req.param("membershipId");
    const membership = await db.query.tenantMemberships.findFirst({
      where: and(
        eq(tenantMemberships.id, membershipId),
        eq(tenantMemberships.tenantId, tenantId),
      ),
    });
    if (!membership) return c.json({ error: "Not found" }, 404);

    if (membership.role === "owner") {
      const [other] = await db
        .select({ n: count() })
        .from(tenantMemberships)
        .where(
          and(
            eq(tenantMemberships.tenantId, tenantId),
            eq(tenantMemberships.role, "owner"),
            ne(tenantMemberships.id, membershipId),
          ),
        );
      if (Number(other?.n ?? 0) === 0) {
        return c.json({ error: "团队至少保留一个 owner" }, 400);
      }
    }

    await db.delete(tenantMemberships).where(eq(tenantMemberships.id, membershipId));
    return c.json({ ok: true });
  });

  // ── 共享 Runner ───────────────────────────────────────────────────────
  const RUNNER_SORTABLE = ["name", "status", "createdAt", "lastSeenAt"] as const;

  app.get("/api/admin/runners", async (c) => {
    if (!deps.runtimeNodes) {
      return c.json({ error: "Runtime nodes unavailable" }, 503);
    }
    const url = new URL(c.req.url);
    const query = parseListQuery(url, {
      sortable: RUNNER_SORTABLE,
      defaultSort: "createdAt",
    });
    const shared = url.searchParams.get("shared") ?? "all";

    const rows = await deps.runtimeNodes.listAllRemote();
    const [allUsers, allTenants] = await Promise.all([
      db.select({ id: users.id, email: users.email, isPlatformAdmin: users.isPlatformAdmin }).from(users),
      db.select({ id: tenants.id, slug: tenants.slug, name: tenants.name }).from(tenants),
    ]);
    const userById = new Map(
      (allUsers as Array<Record<string, any>>).map((u) => [u.id, u]),
    );
    const tenantById = new Map(
      (allTenants as Array<Record<string, any>>).map((t) => [t.id, t]),
    );

    let mapped = rows.map((n) => {
      const owner = n.createdByUserId ? userById.get(n.createdByUserId) : null;
      const tenant = tenantById.get(n.tenantId);
      return {
        id: n.id,
        name: n.name,
        slug: n.slug,
        status: n.status,
        isShared: n.isShared,
        tenantId: n.tenantId,
        tenantSlug: tenant?.slug ?? null,
        tenantName: tenant?.name ?? null,
        createdByUserId: n.createdByUserId,
        createdByEmail: owner?.email ?? null,
        ownerIsPlatformAdmin: owner?.isPlatformAdmin ?? false,
        lastSeenAt: n.lastSeenAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      };
    });

    // Runner 列表来自内存，筛选/排序/分页在这里做（数量级远小于用户表）
    if (query.q) {
      const needle = query.q.toLowerCase();
      mapped = mapped.filter((r) =>
        [r.name, r.slug, r.tenantName, r.tenantSlug, r.createdByEmail]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)),
      );
    }
    if (shared === "shared") mapped = mapped.filter((r) => r.isShared);
    else if (shared === "private") mapped = mapped.filter((r) => !r.isShared);
    if (query.status !== "all") mapped = mapped.filter((r) => r.status === query.status);

    const dir = query.order === "asc" ? 1 : -1;
    mapped.sort((a, b) => {
      const key = query.sort as keyof typeof a;
      const av = a[key] ?? "";
      const bv = b[key] ?? "";
      return av === bv ? 0 : (av < bv ? -1 : 1) * dir;
    });

    const total = mapped.length;
    return c.json({
      items: mapped.slice(query.offset, query.offset + query.pageSize),
      total,
      page: query.page,
      pageSize: query.pageSize,
      limits: {
        maxActiveWorkspacesPerTenant: 1,
        maxActiveWorkspacesTotal: 40,
        allowPortExposure: true,
        allowContainerAllocate: false,
        allowArchive: false,
      },
    });
  });

  app.patch("/api/admin/runners/:id", async (c) => {
    const session = c.get("session") as SaasSession;
    if (!deps.runtimeNodes) {
      return c.json({ error: "Runtime nodes unavailable" }, 503);
    }
    const body = await c.req
      .json<{ isShared?: boolean }>()
      .catch(() => ({}) as { isShared?: boolean });
    if (typeof body.isShared !== "boolean") {
      return c.json({ error: "isShared boolean required" }, 400);
    }
    try {
      const updated = await deps.runtimeNodes.setShared(c.req.param("id"), body.isShared, {
        userId: session.userId,
        isPlatformAdmin: true,
      });
      return c.json({
        runner: {
          id: updated.id,
          name: updated.name,
          tenantId: updated.tenantId,
          isShared: updated.isShared,
          createdByUserId: updated.createdByUserId,
        },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
}
