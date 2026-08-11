import { eq } from "drizzle-orm";
import type { SaasApp, SaasHostDeps, SaasSession, SaasTenantRole } from "./types.js";
import { RegisterError, registerSaasUser } from "./register-user.js";
import { registerAdminResourceRoutes } from "./admin-routes.js";
import {
  completeOauthLogin,
  isLoginOauthProviderId,
  listAdminOauthProviders,
  loadLoginPolicy,
  loadProviderConfig,
  saveLoginPolicy,
  saveProviderConfig,
  startOauthLogin,
  type OauthSchema,
  type ProviderPatch,
} from "./oauth-login.js";

function handleTenantErr(err: unknown) {
  if (err && typeof err === "object" && "status" in err && "message" in err) {
    const e = err as { status: number; message: string; name?: string };
    if (e.name === "TenantAccessError" || typeof e.status === "number") {
      return {
        status: e.status as 400 | 401 | 403 | 404 | 409 | 500,
        body: { error: e.message },
      };
    }
  }
  return {
    status: 500 as const,
    body: { error: err instanceof Error ? err.message : String(err) },
  };
}

/**
 * Register all SaaS-only HTTP routes onto the host Hono app.
 * Call only when edition === "saas".
 */
export function registerSaasRoutes(
  app: SaasApp,
  deps: SaasHostDeps & { schema: OauthSchema },
) {
  const {
    db: dbUnknown,
    config,
    tenants: tenantService,
    signSession,
    sessionFromLogin,
    switchTenantSession,
    isSessionAdmin,
    ensurePlatformMeta,
    onTenantCreated,
    encryptJson,
    decryptJson,
    schema,
  } = deps;
  // Host drizzle client — kept loose at the package boundary
  const db = dbUnknown as {
    query: {
      tenants: {
        findFirst: (args: unknown) => Promise<{
          id: string;
          slug: string;
          name: string;
          onboardingCompleted: boolean;
        } | null | undefined>;
      };
    };
  };

  const oauthDeps = () => ({
    db: dbUnknown,
    schema,
    secret: config.secret,
    webPublicUrl: config.webPublicUrl,
    encryptJson,
    decryptJson,
    onTenantCreated,
  });

  // ── Public self-registration ──────────────────────────────────────────
  app.post("/api/auth/register", async (c) => {
    try {
      const policy = await loadLoginPolicy(oauthDeps());
      if (policy.effective.disablePasswordLogin) {
        return c.json({ error: "邮箱注册已关闭，请使用 OAuth 登录" }, 403);
      }
    } catch {
      /* ignore */
    }
    const body = await c.req
      .json<{
        email?: string;
        password?: string;
        name?: string;
        tenantName?: string;
      }>()
      .catch(() => ({} as { email?: string; password?: string; name?: string; tenantName?: string }));
    if (!body.email || !body.password) {
      return c.json({ error: "email and password required" }, 400);
    }
    try {
      const result = await registerSaasUser(db, schema, {
        email: body.email,
        password: body.password,
        name: body.name,
        tenantName: body.tenantName,
      });
      await onTenantCreated?.(result.tenant.id).catch(() => undefined);
      const token = sessionFromLogin(config.secret, result);
      return c.json(
        {
          session: token,
          user: {
            id: result.user.id,
            email: result.user.email,
            name: result.user.name,
          },
          tenant: {
            id: result.tenant.id,
            slug: result.tenant.slug,
            name: result.tenant.name,
            onboardingCompleted: result.tenant.onboardingCompleted,
          },
          next: "/onboarding",
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

  // ── Login OAuth providers (public) ────────────────────────────────────
  app.get("/api/auth/oauth/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isLoginOauthProviderId(provider)) {
      return c.json({ error: "unknown oauth provider" }, 404);
    }
    const { public: pub } = await loadProviderConfig(oauthDeps(), provider);
    return c.json({
      provider: pub.id,
      name: pub.name,
      enabled: pub.ready,
      redirectUri: pub.redirectUri,
    });
  });

  app.post("/api/auth/oauth/:provider/start", async (c) => {
    const provider = c.req.param("provider");
    if (!isLoginOauthProviderId(provider)) {
      return c.json({ error: "unknown oauth provider" }, 404);
    }
    try {
      const result = await startOauthLogin(oauthDeps(), provider);
      return c.json(result);
    } catch (err) {
      if (err instanceof RegisterError) {
        return c.json({ error: err.message }, err.status as 400 | 403);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/auth/oauth/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    if (!isLoginOauthProviderId(provider)) {
      return c.json({ error: "unknown oauth provider" }, 404);
    }
    const body = await c.req
      .json<{ code?: string; state?: string }>()
      .catch(() => ({} as { code?: string; state?: string }));
    try {
      const result = await completeOauthLogin(oauthDeps(), provider, {
        code: body.code ?? "",
        state: body.state ?? "",
      });
      const token = sessionFromLogin(config.secret, result);
      return c.json({
        session: token,
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          isPlatformAdmin: result.user.isPlatformAdmin,
        },
        tenant: {
          id: result.tenant.id,
          slug: result.tenant.slug,
          name: result.tenant.name,
          onboardingCompleted: result.tenant.onboardingCompleted,
        },
        next: result.tenant.onboardingCompleted ? "/dashboard/agents" : "/onboarding",
      });
    } catch (err) {
      if (err instanceof RegisterError) {
        return c.json({ error: err.message }, err.status as 400 | 403 | 500);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Multi-tenant: create / switch ─────────────────────────────────────
  app.post("/api/tenants", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") {
      return c.json({ error: "API keys cannot create tenants" }, 403);
    }
    const body = await c.req.json<{ name?: string; slug?: string }>();
    if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
    try {
      const { tenant, membership } = await tenantService.createTenant({
        name: body.name,
        slug: body.slug,
        ownerUserId: session.userId,
      });
      await onTenantCreated?.(tenant.id).catch(() => undefined);
      const newSession = signSession(config.secret, {
        userId: session.userId,
        tenantId: tenant.id,
        email: session.email,
        role: membership.role,
        isPlatformAdmin: session.isPlatformAdmin,
      });
      return c.json(
        {
          tenant: {
            id: tenant.id,
            slug: tenant.slug,
            name: tenant.name,
            onboardingCompleted: tenant.onboardingCompleted,
          },
          session: newSession,
        },
        201,
      );
    } catch (err) {
      const e = handleTenantErr(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/auth/switch-tenant", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") {
      return c.json({ error: "API keys cannot switch tenants" }, 403);
    }
    const body = await c.req.json<{ tenantId?: string }>();
    if (!body.tenantId) return c.json({ error: "tenantId required" }, 400);
    const token = await switchTenantSession(
      db,
      config.secret,
      session.userId,
      body.tenantId,
    );
    if (!token) return c.json({ error: "Not a member of this tenant" }, 403);
    const tenantsTable = schema.tenants as { id: unknown };
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenantsTable.id as never, body.tenantId),
    });
    return c.json({
      session: token,
      tenant: tenant
        ? {
            id: tenant.id,
            slug: tenant.slug,
            name: tenant.name,
            onboardingCompleted: tenant.onboardingCompleted,
          }
        : null,
    });
  });

  // ── Members ───────────────────────────────────────────────────────────
  app.get("/api/tenant/members", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    return c.json({ members: await tenantService.listMembers(session.tenantId) });
  });

  app.patch("/api/tenant/members/:id", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ role?: SaasTenantRole }>();
    if (!body.role || !["admin", "member"].includes(body.role)) {
      return c.json({ error: "role must be admin or member" }, 400);
    }
    try {
      const row = await tenantService.updateMemberRole(
        session.tenantId,
        c.req.param("id"),
        body.role,
        session.userId,
      );
      return c.json(row);
    } catch (err) {
      const e = handleTenantErr(err);
      return c.json(e.body, e.status);
    }
  });

  app.delete("/api/tenant/members/:id", async (c) => {
    const session = c.get("session")!;
    try {
      return c.json(
        await tenantService.removeMember(
          session.tenantId,
          c.req.param("id"),
          session.userId,
        ),
      );
    } catch (err) {
      const e = handleTenantErr(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/tenant/leave", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ error: "Forbidden" }, 403);
    try {
      return c.json(await tenantService.leaveTenant(session.tenantId, session.userId));
    } catch (err) {
      const e = handleTenantErr(err);
      return c.json(e.body, e.status);
    }
  });

  // ── Invites ───────────────────────────────────────────────────────────
  app.get("/api/tenant/invites", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const invites = await tenantService.listInvites(session.tenantId);
    return c.json({
      invites: invites.map((i: { id: string; email: string; role: string; expiresAt: Date; createdAt: Date }) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
    });
  });

  app.post("/api/tenant/invites", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ email?: string; role?: "admin" | "member" }>();
    if (!body.email?.trim()) return c.json({ error: "email required" }, 400);
    try {
      const { invite, token } = await tenantService.createInvite({
        tenantId: session.tenantId,
        email: body.email,
        role: body.role === "admin" ? "admin" : "member",
        invitedByUserId: session.userId,
      });
      const acceptUrl = `${config.webPublicUrl}/invite/${token}`;
      return c.json(
        {
          invite: {
            id: invite.id,
            email: invite.email,
            role: invite.role,
            expiresAt: invite.expiresAt,
          },
          token,
          acceptUrl,
        },
        201,
      );
    } catch (err) {
      const e = handleTenantErr(err);
      return c.json(e.body, e.status);
    }
  });

  app.delete("/api/tenant/invites/:id", async (c) => {
    const session = c.get("session")!;
    try {
      return c.json(
        await tenantService.revokeInvite(
          session.tenantId,
          c.req.param("id"),
          session.userId,
        ),
      );
    } catch (err) {
      const e = handleTenantErr(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/api/invites/:token", async (c) => {
    const found = await tenantService.getInviteByToken(c.req.param("token"));
    if (!found?.invite || !found.tenant) {
      return c.json({ error: "Invalid invite" }, 404);
    }
    const { invite, tenant } = found;
    if (invite.acceptedAt) return c.json({ error: "Invite already used" }, 400);
    if (invite.expiresAt < new Date()) return c.json({ error: "Invite expired" }, 400);
    return c.json({
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      tenant: { name: tenant.name, slug: tenant.slug },
    });
  });

  app.post("/api/invites/:token/accept", async (c) => {
    const session = c.get("session");
    const body = await c.req
      .json<{ email?: string; password?: string; name?: string }>()
      .catch(() => ({} as { email?: string; password?: string; name?: string }));
    try {
      const result = await tenantService.acceptInvite({
        token: c.req.param("token"),
        userId: session?.userId !== "api-key" ? session?.userId : undefined,
        email: body.email,
        password: body.password,
        name: body.name,
      });
      const token = sessionFromLogin(config.secret, result);
      return c.json({
        session: token,
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
        },
        tenant: {
          id: result.tenant.id,
          slug: result.tenant.slug,
          name: result.tenant.name,
          onboardingCompleted: result.tenant.onboardingCompleted,
        },
      });
    } catch (err) {
      const e = handleTenantErr(err);
      return c.json(e.body, e.status);
    }
  });

  // ── Platform admin ────────────────────────────────────────────────────
  const requirePlatformAdmin = async (
    c: {
      get: (k: "session") => SaasSession | undefined;
      json: (body: unknown, status?: number) => Response;
    },
    next: () => Promise<void>,
  ) => {
    const session = c.get("session");
    if (!session || session.userId === "api-key" || !session.isPlatformAdmin) {
      return c.json({ error: "Platform admin only" }, 403);
    }
    await next();
  };

  app.use("/api/admin/*", requirePlatformAdmin as never);

  app.get("/api/admin/platform", async (c) => {
    const meta = await ensurePlatformMeta(db, { multiTenant: true });
    return c.json({
      setupCompleted: meta.setupCompleted,
      mode: meta.mode,
      multiTenant: true,
      edition: "saas" as const,
      version: meta.version,
    });
  });

  app.get("/api/admin/agent-defaults", async (c) => {
    return c.json(await deps.agentDefaults?.get());
  });

  app.put("/api/admin/agent-defaults", async (c) => {
    if (!deps.agentDefaults) return c.json({ error: "Agent defaults unavailable" }, 503);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    try {
      const saved = await deps.agentDefaults.save(body);
      await deps.agentDefaults.syncManaged();
      return c.json(saved);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch("/api/admin/platform", async (c) => {
    return c.json(
      {
        error: "Deployment mode is set by environment (ZAKURA_EDITION)",
      },
      400,
    );
  });

  app.get("/api/admin/oauth/providers", async (c) => {
    const providers = await listAdminOauthProviders(oauthDeps());
    const policy = await loadLoginPolicy(oauthDeps());
    return c.json({
      providers,
      disablePasswordLogin: policy.stored.disablePasswordLogin,
      passwordLoginEnabled: !policy.effective.disablePasswordLogin,
      anyOauthReady: policy.anyOauthReady,
      highlightedMethod: policy.stored.highlightedMethod,
      highlightedMethodEffective: policy.effective.highlightedMethod,
    });
  });

  app.put("/api/admin/oauth/login-policy", async (c) => {
    const body = await c.req
      .json<{ disablePasswordLogin?: boolean; highlightedMethod?: string }>()
      .catch(() => ({} as { disablePasswordLogin?: boolean; highlightedMethod?: string }));
    try {
      const policy = await saveLoginPolicy(oauthDeps(), body);
      return c.json({
        disablePasswordLogin: policy.stored.disablePasswordLogin,
        passwordLoginEnabled: !policy.effective.disablePasswordLogin,
        anyOauthReady: policy.anyOauthReady,
        highlightedMethod: policy.stored.highlightedMethod,
        highlightedMethodEffective: policy.effective.highlightedMethod,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/admin/oauth/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isLoginOauthProviderId(provider)) {
      return c.json({ error: "unknown oauth provider" }, 404);
    }
    const { public: pub, stored } = await loadProviderConfig(oauthDeps(), provider);
    return c.json({
      ...pub,
      enabled: stored.enabled,
      ready: pub.ready,
    });
  });

  app.put("/api/admin/oauth/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isLoginOauthProviderId(provider)) {
      return c.json({ error: "unknown oauth provider" }, 404);
    }
    const body = await c.req.json<ProviderPatch>().catch(() => ({} as ProviderPatch));
    try {
      const pub = await saveProviderConfig(oauthDeps(), provider, body);
      const { stored } = await loadProviderConfig(oauthDeps(), provider);
      return c.json({
        ...pub,
        enabled: stored.enabled,
        ready: pub.ready,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/admin/users/:id/agent-defaults/apply", async (c) => {
    if (!deps.agentDefaults) return c.json({ error: "Agent defaults unavailable" }, 503);
    try {
      return c.json(await deps.agentDefaults.enableForUser(c.req.param("id")));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // 用户 / 团队 / 成员 / 共享 Runner 的列表与 CRUD（含封号）
  registerAdminResourceRoutes(app, deps);
}
