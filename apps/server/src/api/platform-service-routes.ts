import { Hono } from "hono";
import type { AppConfig } from "../config.js";
import type { PlatformServiceManager } from "../services/platform-services.js";
import {
  PLATFORM_QUOTA_SCOPE,
  type PlatformServiceUsageService,
} from "../services/platform-service-usage.js";
import { isPlatformServiceKey } from "../platform-services/catalog.js";
import type { PlatformServiceMode } from "@zakura/shared";
import { PLATFORM_SERVICE_MODES } from "@zakura/shared";
import { isSessionAdmin } from "../services/auth.js";

type Session = {
  userId: string;
  tenantId: string;
  role: string;
  isPlatformAdmin?: boolean;
};

/** SaaS: platform admin only. OSS: tenant admin. */
function canAccessPlatformServices(config: AppConfig, session: Session): boolean {
  if (config.multiTenant) return session.isPlatformAdmin === true;
  return isSessionAdmin(session);
}

export function registerPlatformServiceRoutes(
  app: Hono,
  deps: {
    config: AppConfig;
    platformServices: PlatformServiceManager;
    platformServiceUsage: PlatformServiceUsageService;
  },
) {
  const { config, platformServices, platformServiceUsage } = deps;

  const getSession = (c: {
    get: (k: "session") => Session | undefined;
  }): Session | null => c.get("session") ?? null;

  app.get("/api/platform-services", async (c) => {
    const session = getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    // SaaS: not exposed to tenant users — platform admin only
    if (!canAccessPlatformServices(config, session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const list = await platformServices.list();
    return c.json({
      services: list,
      catalog: platformServices.catalogMeta(),
      canManage: true,
      multiTenant: config.multiTenant,
    });
  });

  app.get("/api/platform-services/meta/quotas", async (c) => {
    const session = getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!canAccessPlatformServices(config, session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const scope = c.req.query("scope") ?? PLATFORM_QUOTA_SCOPE;
    const quotas = await platformServiceUsage.listQuotas(scope);
    return c.json({ quotas, scope });
  });

  app.put("/api/platform-services/meta/quotas", async (c) => {
    const session = getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!canAccessPlatformServices(config, session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const body = await c.req
      .json<{
        scopeKey?: string;
        serviceKey?: string;
        monthlyLimit?: number | null;
        dailyLimit?: number | null;
      }>()
      .catch(() => ({} as Record<string, never>));
    if (!body.serviceKey) return c.json({ error: "serviceKey required" }, 400);
    const scopeKey = body.scopeKey?.trim() || PLATFORM_QUOTA_SCOPE;
    try {
      const quota = await platformServiceUsage.upsertQuota({
        scopeKey,
        serviceKey: body.serviceKey,
        monthlyLimit: body.monthlyLimit,
        dailyLimit: body.dailyLimit,
      });
      return c.json({ ok: true, quota });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/platform-services/meta/usage", async (c) => {
    const session = getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!canAccessPlatformServices(config, session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const admin = true;
    const tenantId =
      c.req.query("tenantId") && config.multiTenant
        ? c.req.query("tenantId")!
        : session.tenantId;
    void admin;
    const rows = await platformServiceUsage.usageSummary({
      tenantId,
      serviceKey: c.req.query("serviceKey") ?? undefined,
      periodPrefix: c.req.query("period") ?? undefined,
    });
    const quota = await platformServiceUsage.resolveQuota(
      tenantId,
      c.req.query("serviceKey") ?? "*",
    );
    return c.json({ usage: rows, quota });
  });

  app.get("/api/platform-services/:key", async (c) => {
    const session = getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!canAccessPlatformServices(config, session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const key = c.req.param("key");
    if (!isPlatformServiceKey(key)) return c.json({ error: "Unknown service" }, 404);
    const svc = await platformServices.get(key);
    if (!svc) return c.json({ error: "Not found" }, 404);
    return c.json({
      service: svc,
      canManage: true,
    });
  });

  app.get("/api/platform-services/:key/progress", async (c) => {
    const session = getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!canAccessPlatformServices(config, session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const key = c.req.param("key");
    if (!isPlatformServiceKey(key)) return c.json({ error: "Unknown service" }, 404);
    return c.json({ progress: platformServices.getProgress(key) });
  });

  /** Real docker logs for running containers */
  app.get("/api/platform-services/:key/logs", async (c) => {
    const session = getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!canAccessPlatformServices(config, session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const key = c.req.param("key");
    if (!isPlatformServiceKey(key)) return c.json({ error: "Unknown service" }, 404);
    try {
      const tail = Number(c.req.query("tail") ?? 200);
      const logs = await platformServices.getContainerLogs(
        key,
        Number.isFinite(tail) ? Math.min(Math.max(tail, 20), 2000) : 200,
      );
      return c.json({ logs });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Config only — never auto-starts */
  app.patch("/api/platform-services/:key", async (c) => {
    const session = getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!canAccessPlatformServices(config, session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const key = c.req.param("key");
    if (!isPlatformServiceKey(key)) return c.json({ error: "Unknown service" }, 404);
    const body = await c.req
      .json<{
        mode?: string;
        config?: {
          image?: string;
          hostPort?: number;
          externalUrl?: string;
          apiKey?: string;
          clearApiKey?: boolean;
          env?: Record<string, string>;
          images?: Record<string, string>;
        };
      }>()
      .catch(() => ({} as Record<string, never>));

    try {
      const mode =
        typeof body.mode === "string" &&
        (PLATFORM_SERVICE_MODES as readonly string[]).includes(body.mode)
          ? (body.mode as PlatformServiceMode)
          : undefined;
      const service = await platformServices.patch(key, {
        mode,
        config: body.config,
      });
      return c.json({ ok: true, service });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Lifecycle actions — async where long-running */
  app.post("/api/platform-services/:key/deploy", async (c) => {
    const session = getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!canAccessPlatformServices(config, session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const key = c.req.param("key");
    if (!isPlatformServiceKey(key)) return c.json({ error: "Unknown service" }, 404);
    try {
      const service = await platformServices.deploy(key);
      return c.json({ ok: true, accepted: true, service });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/platform-services/:key/connect", async (c) => {
    const session = getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!canAccessPlatformServices(config, session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const key = c.req.param("key");
    if (!isPlatformServiceKey(key)) return c.json({ error: "Unknown service" }, 404);
    const body = await c.req
      .json<{ externalUrl?: string }>()
      .catch(() => ({} as { externalUrl?: string }));
    try {
      const service = await platformServices.connectExternal(key, body.externalUrl);
      return c.json({ ok: true, accepted: true, service });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/platform-services/:key/disable", async (c) => {
    const session = getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!canAccessPlatformServices(config, session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const key = c.req.param("key");
    if (!isPlatformServiceKey(key)) return c.json({ error: "Unknown service" }, 404);
    try {
      const service = await platformServices.disable(key);
      return c.json({ ok: true, service });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  for (const action of ["start", "stop", "restart", "health"] as const) {
    app.post(`/api/platform-services/:key/${action}`, async (c) => {
      const session = getSession(c);
      if (!session) return c.json({ error: "Unauthorized" }, 401);
      if (!canAccessPlatformServices(config, session)) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const key = c.req.param("key");
      if (!isPlatformServiceKey(key)) return c.json({ error: "Unknown service" }, 404);
      try {
        let service;
        if (action === "start") service = await platformServices.startAsync(key);
        else if (action === "stop") service = await platformServices.stop(key);
        else if (action === "restart") service = await platformServices.restart(key);
        else service = await platformServices.refreshHealth(key);
        return c.json({
          ok: true,
          accepted: action === "start" || action === "restart" || action === "stop",
          service,
        });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    });
  }
}
