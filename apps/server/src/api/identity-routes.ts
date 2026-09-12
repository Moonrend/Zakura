import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { tenants, users } from "../db/schema.js";
import {
  createUserSession,
  isSessionAdmin,
  type SessionPayload,
} from "../services/auth.js";
import { SecurityAuditService, auditToCsv } from "../services/identity/audit.js";
import {
  changeName,
  changePassword,
  clearUserAvatar,
  completePasswordReset,
  confirmEmailVerification,
  readUserAvatar,
  requestEmailVerification,
  requestPasswordReset,
  saveUserAvatar,
} from "../services/identity/account.js";
import {
  addTenantDomain,
  listTenantDomains,
  removeTenantDomain,
  setDomainJoinMode,
  verifyTenantDomain,
  type JoinMode,
} from "../services/identity/domains.js";
import {
  beginWebauthnLogin,
  beginWebauthnRegistration,
  deleteWebauthnCredential,
  disableTotp,
  enableTotp,
  finishWebauthnLogin,
  finishWebauthnRegistration,
  mfaStatus,
  startTotpSetup,
  verifyUserTotp,
  consumeRecoveryCode,
} from "../services/identity/mfa.js";
import {
  completeOidcSso,
  completeSamlSso,
  discoverSso,
  getTenantSso,
  samlMetadata,
  startOidcSso,
  startSamlSso,
  ssoUrls,
  toPublicSso,
  upsertTenantSso,
} from "../services/identity/sso.js";
import {
  createScimToken,
  listScimTokens,
  patchScimTokenMap,
  revokeScimToken,
} from "../services/identity/scim.js";
import { consumeAuthToken, issueAuthToken, peekAuthToken } from "../services/identity/tokens.js";
import { listUserSessions, revokeAllUserSessions, revokeUserSession, touchLastLogin } from "../services/identity/sessions.js";
import { clientIpFromHeaders } from "../services/identity/util.js";

type SessionVars = { session?: SessionPayload };

function actor(session: SessionPayload, ip: string | null) {
  return { type: "user" as const, id: session.userId, ip };
}

function urls(config: AppConfig) {
  return { webPublicUrl: config.webPublicUrl, publicBaseUrl: config.publicBaseUrl };
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }, fallback: T): Promise<T> {
  const body = await c.req.json().catch(() => fallback);
  return (body ?? fallback) as T;
}

export function registerIdentityRoutes(
  app: Hono<{ Variables: SessionVars }>,
  deps: { db: Db; config: AppConfig; audit: SecurityAuditService },
) {
  const { db, config, audit } = deps;

  app.post("/api/auth/forgot-password", async (c) => {
    const body = await readJson<{ email?: string }>(c, {});
    if (body.email) {
      await requestPasswordReset(db, config.webPublicUrl, body.email);
    }
    return c.json({ ok: true });
  });

  app.post("/api/auth/reset-password", async (c) => {
    const body = await readJson<{ token?: string; password?: string }>(c, {});
    if (!body.token || !body.password) return c.json({ error: "token and password required" }, 400);
    try {
      const ok = await completePasswordReset(db, body.token, body.password);
      if (!ok) return c.json({ error: "链接无效或已过期" }, 400);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/auth/verify-email", async (c) => {
    const body = await readJson<{ token?: string }>(c, {});
    if (!body.token) return c.json({ error: "token required" }, 400);
    const ok = await confirmEmailVerification(db, body.token);
    if (!ok) return c.json({ error: "链接无效或已过期" }, 400);
    return c.json({ ok: true });
  });

  app.post("/api/auth/sso/discover", async (c) => {
    const body = await readJson<{ email?: string }>(c, {});
    if (!body.email) return c.json({ sso: false });
    const found = await discoverSso(db, body.email);
    if (!found) return c.json({ sso: false });
    return c.json({
      sso: found.configured,
      required: found.required,
      protocol: found.protocol,
      tenantSlug: found.tenantSlug,
    });
  });

  app.post("/api/auth/sso/:protocol/start", async (c) => {
    const protocol = c.req.param("protocol");
    const body = await readJson<{ tenantSlug?: string; email?: string }>(c, {});
    let slug = body.tenantSlug?.trim();
    if (!slug && body.email) {
      const found = await discoverSso(db, body.email);
      slug = found?.tenantSlug;
    }
    if (!slug) return c.json({ error: "无法确定团队" }, 400);
    try {
      if (protocol === "oidc") {
        return c.json(await startOidcSso(db, urls(config), slug));
      }
      if (protocol === "saml") {
        return c.json(await startSamlSso(db, config.secret, urls(config), slug));
      }
      return c.json({ error: "unknown protocol" }, 404);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/auth/sso/oidc/callback", async (c) => {
    const body = await readJson<{ code?: string; state?: string }>(c, {});
    try {
      const result = await completeOidcSso(db, config.secret, urls(config), {
        code: body.code ?? "",
        state: body.state ?? "",
      });
      await touchLastLogin(db, result.user.id);
      const ip = clientIpFromHeaders((name) => c.req.header(name));
      const session = await createUserSession(
        db,
        config.secret,
        {
          userId: result.user.id,
          tenantId: result.tenant.id,
          email: result.user.email,
          role: result.membership.role,
          isPlatformAdmin: result.user.isPlatformAdmin,
        },
        { ip, userAgent: c.req.header("user-agent") },
      );
      await audit.append(result.tenant.id, "sso.login", {
        actor: { type: "user", id: result.user.id, ip },
        targetType: "user",
        targetId: result.user.id,
        detail: { protocol: "oidc" },
      });
      return c.json({
        session,
        tenant: {
          id: result.tenant.id,
          slug: result.tenant.slug,
          name: result.tenant.name,
          onboardingCompleted: result.tenant.onboardingCompleted,
        },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/auth/sso/saml/:slug/acs", async (c) => {
    const slug = c.req.param("slug");
    const form = await c.req.parseBody();
    try {
      const result = await completeSamlSso(db, config.secret, urls(config), slug, {
        SAMLResponse: String(form.SAMLResponse ?? ""),
        RelayState: form.RelayState ? String(form.RelayState) : undefined,
      });
      await touchLastLogin(db, result.user.id);
      const ip = clientIpFromHeaders((name) => c.req.header(name));
      const session = await createUserSession(
        db,
        config.secret,
        {
          userId: result.user.id,
          tenantId: result.tenant.id,
          email: result.user.email,
          role: result.membership.role,
          isPlatformAdmin: result.user.isPlatformAdmin,
        },
        { ip, userAgent: c.req.header("user-agent") },
      );
      const ticket = await issueAuthToken(db, {
        kind: "sso_exchange",
        userId: result.user.id,
        meta: { session, tenantOnboarding: result.tenant.onboardingCompleted },
      });
      await audit.append(result.tenant.id, "sso.login", {
        actor: { type: "user", id: result.user.id, ip },
        targetType: "user",
        targetId: result.user.id,
        detail: { protocol: "saml" },
      });
      return c.redirect(
        `${config.webPublicUrl}/console/sso/callback?ticket=${encodeURIComponent(ticket)}`,
      );
    } catch (err) {
      const message = encodeURIComponent(err instanceof Error ? err.message : String(err));
      return c.redirect(`${config.webPublicUrl}/login?sso_error=${message}`);
    }
  });

  app.get("/api/auth/sso/saml/:slug/metadata", async (c) => {
    try {
      const xml = await samlMetadata(db, config.secret, urls(config), c.req.param("slug"));
      return c.body(xml, 200, { "content-type": "application/samlmetadata+xml" });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/auth/sso/ticket", async (c) => {
    const body = await c.req.json<{ ticket?: string }>().catch(() => ({}) as never);
    const consumed = body.ticket ? await consumeAuthToken(db, "sso_exchange", body.ticket) : null;
    const session = typeof consumed?.meta.session === "string" ? consumed.meta.session : null;
    if (!session || !consumed) return c.json({ error: "ticket 无效" }, 400);
    return c.json({
      session,
      next: consumed.meta.tenantOnboarding === false ? "/onboarding" : "/dashboard/agents",
    });
  });

  app.post("/api/auth/mfa/webauthn/options", async (c) => {
    const body = await c.req.json<{ ticket?: string }>().catch(() => ({}) as never);
    const peeked = body.ticket ? await peekAuthToken(db, "mfa_login", body.ticket) : null;
    if (!peeked?.userId) return c.json({ error: "登录已过期" }, 400);
    try {
      const options = await beginWebauthnLogin(db, config.webPublicUrl, peeked.userId, `login:${body.ticket}`);
      return c.json(options);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/auth/mfa/complete", async (c) => {
    const body = await c.req
      .json<{
        ticket?: string;
        totp?: string;
        recoveryCode?: string;
        webauthn?: Parameters<typeof finishWebauthnLogin>[4];
      }>()
      .catch(() => ({}) as never);
    const consumed = body.ticket ? await consumeAuthToken(db, "mfa_login", body.ticket) : null;
    if (!consumed?.userId) return c.json({ error: "登录已过期，请重新登录" }, 400);
    const userId = consumed.userId;
    let ok = false;
    if (body.totp) ok = await verifyUserTotp(db, config.secret, userId, body.totp);
    else if (body.recoveryCode) ok = await consumeRecoveryCode(db, userId, body.recoveryCode);
    else if (body.webauthn && body.ticket) {
      ok = await finishWebauthnLogin(db, config.webPublicUrl, userId, `login:${body.ticket}`, body.webauthn);
    }
    if (!ok) return c.json({ error: "第二因素验证失败" }, 401);
    const tenantId = String(consumed.meta.tenantId ?? "");
    const role = String(consumed.meta.role ?? "member");
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!user || !tenant) return c.json({ error: "账号不存在" }, 400);
    await touchLastLogin(db, user.id);
    const ip = clientIpFromHeaders((name) => c.req.header(name));
    const session = await createUserSession(
      db,
      config.secret,
      {
        userId: user.id,
        tenantId: tenant.id,
        email: user.email,
        role,
        isPlatformAdmin: config.multiTenant && user.isPlatformAdmin,
      },
      { ip, userAgent: c.req.header("user-agent") },
    );
    await audit.append(tenant.id, "auth.mfa", {
      actor: { type: "user", id: user.id, ip },
      targetType: "user",
      targetId: user.id,
    });
    return c.json({
      session,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        onboardingCompleted: tenant.onboardingCompleted,
      },
    });
  });

  app.patch("/api/me", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ error: "API keys cannot update profile" }, 403);
    const body = await c.req.json<{ name?: string }>().catch(() => ({}) as never);
    if (typeof body.name === "string") await changeName(db, session.userId, body.name);
    return c.json({ ok: true });
  });

  app.post("/api/me/avatar", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ error: "API keys cannot update profile" }, 403);
    const buf = new Uint8Array(await c.req.arrayBuffer());
    try {
      const avatarRev = await saveUserAvatar(db, config.dataDir, session.userId, buf);
      return c.json({ ok: true, avatarRev });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/me/avatar", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ error: "API keys cannot update profile" }, 403);
    await clearUserAvatar(db, config.dataDir, session.userId);
    return c.json({ ok: true });
  });

  app.get("/api/users/:id/avatar", async (c) => {
    if (!c.get("session")) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    const file = await readUserAvatar(config.dataDir, id);
    if (!file) return c.body("", 404);
    return new Response(file, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=120",
      },
    });
  });

  app.post("/api/me/password", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ error: "API keys cannot change password" }, 403);
    const body = await c.req.json<{ currentPassword?: string; newPassword?: string }>().catch(() => ({}) as never);
    try {
      await changePassword(db, session.userId, body.currentPassword ?? "", body.newPassword ?? "");
      await audit.append(session.tenantId, "auth.password_change", {
        actor: actor(session, clientIpFromHeaders((name) => c.req.header(name))),
        targetType: "user",
        targetId: session.userId,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/me/verify-email", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ error: "API keys cannot verify email" }, 403);
    const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
    if (!user) return c.json({ error: "not found" }, 404);
    const sent = await requestEmailVerification(db, config.webPublicUrl, user);
    return c.json({ sent });
  });

  app.get("/api/me/sessions", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ sessions: [] });
    return c.json({ sessions: await listUserSessions(db, session.userId, session.sid) });
  });

  app.delete("/api/me/sessions/:id", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ error: "forbidden" }, 403);
    const ok = await revokeUserSession(db, session.userId, c.req.param("id"));
    if (ok) {
      await audit.append(session.tenantId, "auth.session_revoke", {
        actor: actor(session, clientIpFromHeaders((name) => c.req.header(name))),
        targetType: "session",
        targetId: c.req.param("id"),
      });
    }
    return c.json({ ok });
  });

  app.post("/api/me/sessions/revoke-others", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ error: "forbidden" }, 403);
    const count = await revokeAllUserSessions(db, session.userId, session.sid);
    return c.json({ count });
  });

  app.get("/api/me/mfa", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ totp: false, webauthn: false, methods: [], credentials: [] });
    return c.json(await mfaStatus(db, session.userId));
  });

  app.post("/api/me/mfa/totp/start", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ error: "forbidden" }, 403);
    const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
    if (!user) return c.json({ error: "not found" }, 404);
    return c.json(await startTotpSetup(db, config.secret, user));
  });

  app.post("/api/me/mfa/totp/enable", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ code?: string }>().catch(() => ({}) as never);
    try {
      const recoveryCodes = await enableTotp(db, config.secret, session.userId, body.code ?? "");
      await audit.append(session.tenantId, "mfa.totp_enable", {
        actor: actor(session, clientIpFromHeaders((name) => c.req.header(name))),
        targetType: "user",
        targetId: session.userId,
      });
      return c.json({ recoveryCodes });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/me/mfa/totp/disable", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ code?: string }>().catch(() => ({}) as never);
    try {
      await disableTotp(db, session.userId, body.code ?? "", config.secret);
      await audit.append(session.tenantId, "mfa.totp_disable", {
        actor: actor(session, clientIpFromHeaders((name) => c.req.header(name))),
        targetType: "user",
        targetId: session.userId,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/me/mfa/webauthn/register/options", async (c) => {
    const session = c.get("session")!;
    const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
    if (!user) return c.json({ error: "not found" }, 404);
    return c.json(await beginWebauthnRegistration(db, config.webPublicUrl, user));
  });

  app.post("/api/me/mfa/webauthn/register", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ response?: Parameters<typeof finishWebauthnRegistration>[3]; name?: string }>();
    try {
      await finishWebauthnRegistration(db, config.webPublicUrl, session.userId, body.response as never, body.name);
      await audit.append(session.tenantId, "mfa.webauthn_add", {
        actor: actor(session, clientIpFromHeaders((name) => c.req.header(name))),
        targetType: "user",
        targetId: session.userId,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/me/mfa/webauthn/:id", async (c) => {
    const session = c.get("session")!;
    const ok = await deleteWebauthnCredential(db, session.userId, c.req.param("id"));
    return c.json({ ok });
  });

  app.get("/api/tenant/identity/domains", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    return c.json({ domains: await listTenantDomains(db, session.tenantId) });
  });

  app.post("/api/tenant/identity/domains", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = await c.req.json<{ domain?: string; joinMode?: JoinMode }>().catch(() => ({}) as never);
    try {
      const row = await addTenantDomain(db, session.tenantId, body.domain ?? "", body.joinMode);
      await audit.append(session.tenantId, "domain.add", {
        actor: actor(session, clientIpFromHeaders((name) => c.req.header(name))),
        targetType: "domain",
        targetId: row.id,
        detail: { domain: row.domain },
      });
      return c.json({ domain: (await listTenantDomains(db, session.tenantId)).find((d) => d.id === row.id) }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch("/api/tenant/identity/domains/:id", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = await c.req.json<{ joinMode?: JoinMode }>().catch(() => ({}) as never);
    try {
      await setDomainJoinMode(db, session.tenantId, c.req.param("id"), body.joinMode ?? "invite_only");
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/tenant/identity/domains/:id/verify", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    try {
      await verifyTenantDomain(db, session.tenantId, c.req.param("id"));
      await audit.append(session.tenantId, "domain.verify", {
        actor: actor(session, clientIpFromHeaders((name) => c.req.header(name))),
        targetType: "domain",
        targetId: c.req.param("id"),
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/tenant/identity/domains/:id", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    await removeTenantDomain(db, session.tenantId, c.req.param("id"));
    await audit.append(session.tenantId, "domain.remove", {
      actor: actor(session, clientIpFromHeaders((name) => c.req.header(name))),
      targetType: "domain",
      targetId: c.req.param("id"),
    });
    return c.json({ ok: true });
  });

  app.get("/api/tenant/identity/sso", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, session.tenantId) });
    const row = await getTenantSso(db, session.tenantId);
    return c.json({ sso: toPublicSso(row ?? null, ssoUrls(urls(config), tenant?.slug ?? "default")) });
  });

  app.put("/api/tenant/identity/sso", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = await c.req.json().catch(() => ({}) as never);
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, session.tenantId) });
    const row = await upsertTenantSso(db, config.secret, session.tenantId, body);
    await audit.append(session.tenantId, "sso.config", {
      actor: actor(session, clientIpFromHeaders((name) => c.req.header(name))),
      targetType: "sso",
      targetId: row.id,
      detail: { protocol: row.protocol, enabled: row.enabled },
    });
    return c.json({ sso: toPublicSso(row, ssoUrls(urls(config), tenant?.slug ?? "default")) });
  });

  app.get("/api/tenant/identity/scim", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    return c.json({
      tokens: await listScimTokens(db, session.tenantId),
      endpoint: `${config.publicBaseUrl}/scim/v2`,
    });
  });

  app.post("/api/tenant/identity/scim/tokens", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = await c.req.json<{ name?: string; groupRoleMap?: Record<string, string> }>().catch(() => ({}) as never);
    const created = await createScimToken(db, session.tenantId, body);
    await audit.append(session.tenantId, "scim.token_create", {
      actor: actor(session, clientIpFromHeaders((name) => c.req.header(name))),
      targetType: "scim_token",
      targetId: created.id,
    });
    return c.json(created, 201);
  });

  app.patch("/api/tenant/identity/scim/tokens/:id", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = await c.req.json<{ groupRoleMap?: Record<string, string> }>().catch(() => ({}) as never);
    if (body.groupRoleMap) {
      await patchScimTokenMap(db, session.tenantId, c.req.param("id"), body.groupRoleMap);
    }
    return c.json({ ok: true });
  });

  app.delete("/api/tenant/identity/scim/tokens/:id", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    await revokeScimToken(db, session.tenantId, c.req.param("id"));
    await audit.append(session.tenantId, "scim.token_revoke", {
      actor: actor(session, clientIpFromHeaders((name) => c.req.header(name))),
      targetType: "scim_token",
      targetId: c.req.param("id"),
    });
    return c.json({ ok: true });
  });

  app.get("/api/tenant/audit", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session) && !session.isPlatformAdmin) {
      return c.json({ error: "Admin only" }, 403);
    }
    const tenantId = c.req.query("tenantId") && session.isPlatformAdmin
      ? c.req.query("tenantId")!
      : session.tenantId;
    const since = c.req.query("since") ? new Date(c.req.query("since")!) : undefined;
    const until = c.req.query("until") ? new Date(c.req.query("until")!) : undefined;
    const format = c.req.query("format");
    if (format === "csv") {
      const items = await audit.listAll(tenantId, { action: c.req.query("action") ?? undefined, since, until });
      return c.body(auditToCsv(items), 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit.csv"`,
      });
    }
    const result = await audit.list(tenantId, {
      limit: Number(c.req.query("limit") ?? 50),
      offset: Number(c.req.query("offset") ?? 0),
      action: c.req.query("action") ?? undefined,
      actorId: c.req.query("actorId") ?? undefined,
      since,
      until,
    });
    const retentionDays = await audit.retentionDays(tenantId);
    return c.json({ ...result, retentionDays });
  });

  app.put("/api/tenant/audit/retention", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = await c.req.json<{ retentionDays?: number }>().catch(() => ({}) as never);
    const retentionDays = await audit.setRetentionDays(session.tenantId, Number(body.retentionDays ?? 365));
    return c.json({ retentionDays });
  });
}
