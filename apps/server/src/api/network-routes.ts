import type { Hono } from "hono";
import { isSessionAdmin } from "../services/auth.js";
import type { NetworkSettingsService } from "../services/network-settings.js";
import type { SecurityPolicyService } from "../services/network-security.js";
import type { ExposureService } from "../services/port-exposures.js";
import type { NetworkAuditService } from "../services/network-audit.js";
import type { AgentService } from "../services/agents.js";
import type { AppConfig } from "../config.js";
import type { PlatformHeadscalePatch } from "../services/platform-headscale.js";

type SessionVars = {
  session?: {
    userId: string;
    tenantId: string;
    email: string;
    role: string;
    isPlatformAdmin?: boolean;
  };
};

/** 平台 Headscale：仅 SaaS 超管 */
function canManagePlatformHeadscale(
  session: { role: string; userId: string; isPlatformAdmin?: boolean },
  config: AppConfig,
): boolean {
  if (!config.multiTenant) return false;
  return session.isPlatformAdmin === true;
}

/** 补全 hostJoinsTailscale，避免每次 mesh 响应重建安装包。 */
async function withMeshExtras(
  mesh: Awaited<ReturnType<NetworkSettingsService["getMesh"]>>,
  network: NetworkSettingsService,
) {
  if (mesh.hostJoinsTailscale != null) return mesh;
  return {
    ...mesh,
    hostJoinsTailscale: await network.hostJoinsTailscaleForTenant(mesh.meshProvider ?? null),
  };
}

export function registerNetworkRoutes(
  app: Hono<{ Variables: SessionVars }>,
  deps: {
    network: NetworkSettingsService;
    security: SecurityPolicyService;
    exposures: ExposureService;
    audit: NetworkAuditService;
    agentService: AgentService;
    config: AppConfig;
  },
) {
  const { network, security, exposures, audit, agentService, config } = deps;

  app.get("/api/settings/network/headscale", async (c) => {
    if (!config.multiTenant) {
      return c.json({ error: "平台 Headscale 仅在 SaaS 部署下可用" }, 404);
    }
    const session = c.get("session")!;
    if (!canManagePlatformHeadscale(session, config)) {
      return c.json({ error: "需要平台管理员权限" }, 403);
    }
    return c.json(await network.getPlatformHeadscalePublic());
  });

  app.put("/api/settings/network/headscale", async (c) => {
    if (!config.multiTenant) {
      return c.json({ error: "平台 Headscale 仅在 SaaS 部署下可用" }, 404);
    }
    const session = c.get("session")!;
    if (!canManagePlatformHeadscale(session, config)) {
      return c.json({ error: "需要平台管理员权限" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as PlatformHeadscalePatch;
    try {
      const saved = await network.updatePlatformHeadscale({
        enabled: body.enabled,
        url: body.url,
        apiKey: body.apiKey,
        platformAuthKey: body.platformAuthKey,
      });
      return c.json(saved);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/settings/network/overview", async (c) => {
    const session = c.get("session")!;
    const overview = await network.overview(session.tenantId);
    const meshProvider = await network.resolveMeshProvider(session.tenantId);
    return c.json({
      ...overview,
      meshProvider,
      hostJoinsTailscale: await network.hostJoinsTailscaleForTenant(meshProvider),
    });
  });

  app.get("/api/settings/network/mesh", async (c) => {
    const session = c.get("session")!;
    const mesh = await network.getMesh(session.tenantId);
    return c.json(await withMeshExtras(mesh, network));
  });

  app.post("/api/settings/network/mesh/platform/enable", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    try {
      const mesh = await network.enablePlatformMesh(session.tenantId, {
        actorId: session.userId,
        refreshDevices: true,
      });
      return c.json(await withMeshExtras(mesh, network));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/settings/network/mesh/oauth/start", async (c) => {
    // Tailscale uses OAuth Client Credentials (no browser redirect).
    // Return the admin console URL so the UI can open it for client creation.
    return c.json({
      mode: "client_credentials",
      createClientUrl: "https://login.tailscale.com/admin/settings/oauth",
      aclUrl: "https://login.tailscale.com/admin/acls",
      recommendedScopes: ["devices", "auth_keys", "acl"],
      note:
        "推荐：OAuth Client 勾选 devices + auth_keys + Policy file 写权限，并勾选要用的 tag。连接后 Zakura 会自动把缺失 tag 写入 ACL tagOwners；API 无法代勾 OAuth Client 上的 tag。",
    });
  });

  app.post("/api/settings/network/mesh/oauth/connect", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      clientId?: string;
      clientSecret?: string;
      tags?: string[];
    };
    if (!body.clientId?.trim() || !body.clientSecret?.trim()) {
      return c.json({ error: "clientId and clientSecret are required" }, 400);
    }
    try {
      const mesh = await network.connectTailscaleOAuth(
        session.tenantId,
        {
          clientId: body.clientId,
          clientSecret: body.clientSecret,
          tags: body.tags,
        },
        { actorId: session.userId },
      );
      network.invalidateMeshCache(session.tenantId);
      return c.json(await withMeshExtras(mesh, network));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch("/api/settings/network/mesh/oauth/tags", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { tags?: string[] };
    if (!body.tags?.length) return c.json({ error: "tags is required" }, 400);
    try {
      const mesh = await network.updateTailscaleTags(session.tenantId, body.tags, {
        actorId: session.userId,
      });
      network.invalidateMeshCache(session.tenantId);
      return c.json(await withMeshExtras(mesh, network));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/settings/network/mesh/acl/ensure-tags", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { tags?: string[] };
    try {
      const mesh = await network.ensureTailscaleTagsInAcl(session.tenantId, body.tags, {
        actorId: session.userId,
      });
      return c.json(await withMeshExtras(mesh, network));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/settings/network/mesh/auth-key", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { authKey?: string };
    if (!body.authKey?.trim()) return c.json({ error: "authKey is required" }, 400);
    try {
      const mesh = await network.saveManualAuthKey(session.tenantId, body.authKey, {
        actorId: session.userId,
      });
      network.invalidateMeshCache(session.tenantId);
      return c.json(await withMeshExtras(mesh, network));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/settings/network/mesh/auth-key/generate", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      tags?: string[];
      expirySeconds?: number;
      description?: string;
    };
    try {
      const result = await network.generateTailscaleAuthKey(session.tenantId, {
        tags: body.tags,
        expirySeconds: body.expirySeconds,
        description: body.description,
        actorId: session.userId,
      });
      network.invalidateMeshCache(session.tenantId);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/settings/network/mesh/disconnect", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const mesh = await network.disconnectMesh(session.tenantId, { actorId: session.userId });
    return c.json(await withMeshExtras(mesh, network));
  });

  app.post("/api/settings/network/mesh/sync", async (c) => {
    const session = c.get("session")!;
    try {
      // Prefer live Tailscale API sync when OAuth is connected
      const mesh = await network.syncTailscale(session.tenantId, {
        actorId: session.userId,
      });
      network.invalidateMeshCache(session.tenantId);
      return c.json(await withMeshExtras(mesh, network));
    } catch {
      const mesh = await network.getMesh(session.tenantId, { refresh: true });
      return c.json(await withMeshExtras(mesh, network));
    }
  });

  app.post("/api/settings/network/exposure/providers/cloudflare-named/create-tunnel", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    try {
      const result = await network.createCloudflareNamedTunnel(
        session.tenantId,
        { name: body.name },
        { actorId: session.userId },
      );
      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/settings/network/exposure/providers", async (c) => {
    const session = c.get("session")!;
    const providers = await network.listProviders(session.tenantId);
    return c.json({ providers });
  });

  app.patch("/api/settings/network/exposure/providers/:id", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const provider = c.req.param("id");
    const body = await c.req
      .json<{ enabled?: boolean; isDefault?: boolean; config?: Record<string, unknown> }>()
      .catch(() => ({}));
    try {
      const updated = await network.patchProvider(session.tenantId, provider, body, {
        actorId: session.userId,
      });
      return c.json({ provider: updated });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/settings/network/exposure/providers/:id/test", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const provider = c.req.param("id");
    try {
      const result = await network.testProvider(session.tenantId, provider, {
        actorId: session.userId,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/settings/network/security", async (c) => {
    const session = c.get("session")!;
    const policy = await security.get(session.tenantId);
    return c.json({ policy });
  });

  app.put("/api/settings/network/security", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const body = await c.req.json().catch(() => ({}));
    try {
      const policy = await security.update(session.tenantId, body, {
        updatedBy: session.email,
        actorId: session.userId,
      });
      return c.json({ policy });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/settings/network/audit", async (c) => {
    const session = c.get("session")!;
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const action = c.req.query("action") || undefined;
    const result = await audit.list(session.tenantId, { limit, offset, action });
    return c.json(result);
  });

  app.get("/api/settings/network/active-exposures", async (c) => {
    const session = c.get("session")!;
    try {
      const items = await exposures.listActive(session.tenantId);
      return c.json({ exposures: items });
    } catch (err) {
      console.error("[active-exposures]", err);
      return c.json(
        { error: err instanceof Error ? err.message : String(err), exposures: [] },
        500,
      );
    }
  });

  app.post("/api/settings/network/active-exposures/stop-all", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) return c.json({ error: "Admin only" }, 403);
    const n = await exposures.stopAllActive(session.tenantId, {
      type: "user",
      id: session.userId,
    });
    return c.json({ stopped: n });
  });

  // Agent-scoped exposure CRUD
  app.get("/api/agents/:id/exposures", async (c) => {
    const session = c.get("session")!;
    const agentId = c.req.param("id");
    const agent = await agentService.get(session.tenantId, agentId);
    if (!agent) return c.json({ error: "Not found" }, 404);
    const items = await exposures.listForAgent(session.tenantId, agentId);
    return c.json({ exposures: items });
  });

  app.post("/api/agents/:id/exposures", async (c) => {
    const session = c.get("session")!;
    const agentId = c.req.param("id");
    const agent = await agentService.get(session.tenantId, agentId);
    if (!agent) return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      port?: number;
      provider?: string;
      name?: string;
      ttlMinutes?: number;
      protocol?: "http" | "https" | "tcp";
    };
    if (body.port == null) return c.json({ error: "port is required" }, 400);
    try {
      const exposure = await exposures.create(
        session.tenantId,
        agentId,
        {
          port: body.port,
          provider: body.provider,
          name: body.name,
          ttlMinutes: body.ttlMinutes,
          protocol: body.protocol,
        },
        { type: "user", id: session.userId },
      );
      return c.json({ exposure }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/exposures/:id", async (c) => {
    const session = c.get("session")!;
    const stopped = await exposures.stop(session.tenantId, c.req.param("id"), {
      type: "user",
      id: session.userId,
    });
    if (!stopped) return c.json({ error: "Not found" }, 404);
    return c.json({ exposure: stopped });
  });
}
