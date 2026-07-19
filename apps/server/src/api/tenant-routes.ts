import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { tenants } from "../db/schema.js";
import { isSessionAdmin } from "../services/auth.js";
import { NetworkSettingsService } from "../services/network-settings.js";
import { RuntimeNodeService } from "../services/runtime-nodes.js";
import {
  TenantAccessError,
  TenantService,
  type TenantOnboardingSteps,
} from "../services/tenants.js";

type SessionVars = {
  session?: {
    userId: string;
    tenantId: string;
    email: string;
    role: string;
    isPlatformAdmin?: boolean;
  };
};

function handleTenantErr(err: unknown) {
  if (err instanceof TenantAccessError) {
    return { status: err.status as 400 | 401 | 403 | 404, body: { error: err.message } };
  }
  return {
    status: 500 as const,
    body: { error: err instanceof Error ? err.message : String(err) },
  };
}

/**
 * Open-source tenant routes: current tenant + onboarding only.
 * Multi-tenant create/switch, members, invites, and platform admin live in `@zakura/saas`.
 */
export function registerTenantRoutes(
  app: Hono<{ Variables: SessionVars }>,
  deps: {
    db: Db;
    config: AppConfig;
    tenants: TenantService;
    runtimeNodes?: RuntimeNodeService;
    networkSettings?: NetworkSettingsService;
  },
) {
  const { db, config, tenants: tenantService } = deps;

  /** Tenants the current user can access (OSS: always the single default). */
  app.get("/api/tenants", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") {
      return c.json({ error: "API keys cannot list tenants" }, 403);
    }
    const list = await tenantService.listForUser(session.userId);
    return c.json({
      currentTenantId: session.tenantId,
      tenants: list,
      multiTenant: config.multiTenant,
      edition: config.edition,
    });
  });

  app.get("/api/tenant/current", async (c) => {
    const session = c.get("session")!;
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, session.tenantId),
    });
    if (!tenant) return c.json({ error: "Not found" }, 404);
    const membership =
      session.userId === "api-key"
        ? null
        : await tenantService.getMembership(session.tenantId, session.userId);
    return c.json({
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      isDefault: tenant.isDefault,
      onboardingCompleted: tenant.onboardingCompleted,
      onboardingSteps: JSON.parse(tenant.onboardingSteps || "{}"),
      role: membership?.role ?? session.role,
    });
  });

  app.patch("/api/tenant/current", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = await c.req.json<{ name?: string }>();
    try {
      const tenant = await tenantService.updateTenant(session.tenantId, body);
      return c.json({
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
      });
    } catch (err) {
      const e = handleTenantErr(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/api/tenant/onboarding", async (c) => {
    const session = c.get("session")!;
    try {
      return c.json(await tenantService.getOnboarding(session.tenantId));
    } catch (err) {
      const e = handleTenantErr(err);
      return c.json(e.body, e.status);
    }
  });

  app.patch("/api/tenant/onboarding", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ error: "Forbidden" }, 403);
    const body = await c.req.json<{
      steps?: TenantOnboardingSteps;
      complete?: boolean;
    }>();
    try {
      return c.json(await tenantService.patchOnboarding(session.tenantId, body));
    } catch (err) {
      const e = handleTenantErr(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/tenant/onboarding/complete", async (c) => {
    const session = c.get("session")!;
    if (session.userId === "api-key") return c.json({ error: "Forbidden" }, 403);
    try {
      return c.json(
        await tenantService.patchOnboarding(session.tenantId, { complete: true }),
      );
    } catch (err) {
      const e = handleTenantErr(err);
      return c.json(e.body, e.status);
    }
  });
}
