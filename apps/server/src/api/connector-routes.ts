/**
 * 连接器（Connectors）API 路由。
 *
 * 从 routes.ts 拆出，覆盖连接器目录读取、共享 OAuth 客户端探测、
 * 连接器 OAuth 授权启动、以及连接器绑定到 Agent 的安装流程。
 */
import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { getTelemetry, recordPlatformFault } from "@zakura/core";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { AgentService } from "../services/agents.js";
import type { SkillsService } from "../services/skills/index.js";
import type { IntegrationCatalogService } from "../services/integration-catalog.js";
import type { McpUpstreamOauthService } from "../services/mcp-upstream-oauth.js";
import type { RemoteAgentIngress } from "../services/remote-agent-ingress.js";
import { canManageMcpOauthApps } from "./route-helpers.js";
import type { AppVariables } from "./routes.js";

export interface ConnectorRouteDeps {
  db: Db;
  config: AppConfig;
  agentService: AgentService;
  skills?: SkillsService;
  integrationCatalog: IntegrationCatalogService;
  upstreamOauth: McpUpstreamOauthService;
  upstreamOauthPending: Map<string, unknown>;
  purgeUpstreamOauthPending: () => void;
  /** 延迟求值：remoteIngress 在 createApiApp 中按条件初始化 */
  getRemoteIngress: () => RemoteAgentIngress | null;
}

/** 连接器授权/撤销时同步捆绑技能到同一 Agent（routes.ts 与本模块共用） */
export function makeSyncConnectorCapabilities(deps: {
  skills?: SkillsService;
  integrationCatalog: IntegrationCatalogService;
}) {
  return async function syncConnectorCapabilities(
    tenantId: string,
    connectorRef: string,
    agentId: string,
    mode: "install" | "uninstall",
  ): Promise<void> {
    const { skills, integrationCatalog } = deps;
    if (!skills) return;
    const connector = (await integrationCatalog.listConnectors(tenantId)).find(
      (item) => item.ref === connectorRef,
    );
    if (!connector) return;
    for (const skill of connector.capabilities.filter((item) => item.kind === "skill")) {
      const source = String(skill.config.source ?? `builtin:${skill.ref}`).trim();
      try {
        if (mode === "install") {
          await skills.install(tenantId, { source, agentIds: [agentId] });
        } else {
          await skills.uninstall(tenantId, agentId, skill.ref);
        }
      } catch {
        getTelemetry().platformFaults.inc({ kind: "connector.sync_skill" });
      }
    }
  };
}

export function registerConnectorRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: ConnectorRouteDeps,
) {
  const {
    config,
    agentService,
    skills,
    integrationCatalog,
    upstreamOauth,
    upstreamOauthPending,
    purgeUpstreamOauthPending,
  } = deps;
  const { getRemoteIngress } = deps;
  const syncConnectorCapabilities = makeSyncConnectorCapabilities(deps);

  /**
   * 上游 MCP OAuth 客户端配置。
   * scope=tenant：任意租户管理员可配本租户自建客户端
   * scope=platform：整站默认（SaaS 超管 / OSS 管理员）
   */
  app.get("/api/connectors", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (scope === "platform" && !canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    if (scope === "tenant") {
      await skills?.syncBuiltins(session.tenantId);
      await integrationCatalog.ensureBrowserNotificationsInstalled(session.tenantId).catch((err) => {
        recordPlatformFault("api.browser_notifications_ensure", err, { subsystem: "api" });
      });
    }
    const scopeKey = scope === "platform" ? "platform" : session.tenantId;
    return c.json({
      connectors: await integrationCatalog.listConnectors(scopeKey),
      scope,
      redirectUri: `${config.publicBaseUrl.replace(/\/$/, "")}/api/mcp/upstream-oauth/callback`,
    });
  });

  app.get("/api/connectors/profiles", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const scopeKey = scope === "platform" ? "platform" : session.tenantId;
    return c.json({ profiles: await integrationCatalog.listProfiles(scopeKey), scope });
  });

  app.put("/api/connectors/profiles/:profileKey", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const body = await c.req.json<{
      enabled?: boolean;
      kind?: "oauth2" | "oauth2_dynamic" | "token" | "custom" | "none";
      label?: string;
      values?: Record<string, unknown>;
    }>();
    try {
      const profile = await integrationCatalog.saveProfile(
        scope === "platform" ? "platform" : session.tenantId,
        c.req.param("profileKey"),
        body,
      );
      return c.json({ profile, scope });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/connectors/profiles/:profileKey", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    try {
      await integrationCatalog.deleteProfile(
        scope === "platform" ? "platform" : session.tenantId,
        c.req.param("profileKey"),
      );
      return c.json({ ok: true, scope });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** 远程 MCP 安装前探测：是否可复用已配置的连接器 OAuth 客户端 */
  app.get("/api/connectors/shared-oauth", async (c) => {
    const session = c.get("session")!;
    const mcpUrl = c.req.query("mcpUrl")?.trim() ?? "";
    const connectorRef = c.req.query("connectorRef")?.trim() || undefined;
    if (!mcpUrl && !connectorRef) {
      return c.json({ error: "mcpUrl or connectorRef required" }, 400);
    }
    const peek = await integrationCatalog.peekSharedOauth(
      session.tenantId,
      mcpUrl,
      connectorRef,
    );
    return c.json(peek);
  });

  /** 平台连接器直接授权：写入指定 Agent 的安装认证资源，不创建 MCP 实例。 */
  app.post("/api/connectors/:ref/oauth/start", async (c) => {
    const session = c.get("session")!;
    const connectorRef = c.req.param("ref");
    const body = await c.req.json<{ agentId?: string }>().catch(() => ({} as { agentId?: string }));
    const agentId = body.agentId?.trim() ?? "";
    if (!agentId) {
      return c.json({ error: "请选择要授权的 Agent" }, 400);
    }
    try {
      const agent = await agentService.get(session.tenantId, agentId);
      if (!agent) return c.json({ error: "Agent 不存在" }, 404);

      const connector = (await integrationCatalog.listConnectors(session.tenantId)).find(
        (item) => item.ref === connectorRef || item.id === connectorRef,
      );
      const capabilities =
        connector?.capabilities.filter(
          (item) => item.kind === "tool" && String(item.config.mcpUrl ?? "").startsWith("zakura://"),
        ) ?? [];
      const capability = capabilities[0];
      const mcpUrl = String(capability?.config.mcpUrl ?? "");
      if (!connector || !mcpUrl) {
        return c.json({ error: "连接器没有可授权的功能" }, 400);
      }
      // 安装记录在授权成功回调时写入；此处不预创建空安装
      const target = await integrationCatalog.resolveConnectorTarget(session.tenantId, mcpUrl, {
        agentId,
      });
      if (!target?.client || !target.discovery.authorizationEndpoint || !target.discovery.tokenEndpoint) {
        return c.json({ error: "请先保存有效的 OAuth 客户端配置" }, 400);
      }
      purgeUpstreamOauthPending();
      const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
      const state = randomBytes(16).toString("hex");
      const scope = [...new Set(
        capabilities.flatMap((item) => String(item.config.scopes ?? "").split(/\s+/).filter(Boolean)),
      )].join(" ");
      const { url, codeVerifier } = upstreamOauth.buildAuthorizeUrl({
        discovery: target.discovery,
        clientId: target.client.clientId,
        redirectUri,
        state,
        scope: upstreamOauth.resolveScope(target.discovery, scope || target.scopes),
        extraParams: target.authorizeParams,
      });
      upstreamOauthPending.set(state, {
        tenantId: session.tenantId,
        connectorRef: connector.ref,
        agentId,
        mcpUrl: target.mcpUrl,
        clientId: target.client.clientId,
        clientSecret: target.client.clientSecret,
        codeVerifier,
        redirectUri,
        tokenEndpoint: target.discovery.tokenEndpoint,
        resource: null,
        createdAt: Date.now(),
      });
      return c.json({ ok: true, authorizeUrl: url });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** 将连接器安装到指定 Agent（认证资源归属 Agent） */
  app.post("/api/connectors/:ref/install", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ agentIds?: string[]; all?: boolean }>();
    try {
      let agentIds = body.agentIds ?? [];
      if (body.all) {
        const list = await agentService.list(session.tenantId);
        agentIds = list.map((item) => item.id);
      } else {
        const verified: string[] = [];
        for (const id of agentIds) {
          const agent = await agentService.get(session.tenantId, id);
          if (!agent) return c.json({ error: `Agent 不存在: ${id}` }, 404);
          verified.push(agent.id);
        }
        agentIds = verified;
      }
      const connector = await integrationCatalog.installConnector(
        session.tenantId,
        c.req.param("ref"),
        agentIds,
      );
      for (const agentId of agentIds) {
        await syncConnectorCapabilities(session.tenantId, c.req.param("ref"), agentId, "install");
      }
      return c.json({ connector });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/connectors/:ref/installations/:agentId", async (c) => {
    const session = c.get("session")!;
    try {
      const connectorRef = c.req.param("ref");
      const agentId = c.req.param("agentId");
      await syncConnectorCapabilities(session.tenantId, connectorRef, agentId, "uninstall");
      const connector = await integrationCatalog.uninstallConnector(
        session.tenantId,
        connectorRef,
        agentId,
      );
      return c.json({ connector });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/agents/:id/connectors", async (c) => {
    const session = c.get("session")!;
    const agent = await agentService.get(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const installations = await integrationCatalog.auth.listInstallations(session.tenantId, {
      agentId: agent.id,
    });
    const connectors = await integrationCatalog.listConnectors(session.tenantId);
    const byRef = new Map(connectors.map((item) => [item.ref, item]));
    return c.json({
      installations: installations.map((row) => ({
        ...row,
        connector: byRef.get(row.connectorRef) ?? null,
      })),
    });
  });

  app.put("/api/connectors/:id/credentials", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const body = await c.req.json<{
      enabled?: boolean;
      values?: Record<string, unknown>;
      settings?: Record<string, unknown>;
    }>();
    try {
      const connector = await integrationCatalog.saveCredentials(
        scope === "platform" ? "platform" : session.tenantId,
        c.req.param("id"),
        body,
      );
      // Email inbound is configured on platform connectors (Amail/Bettermail/…),
      // not on Agent Chat SDK platforms. Bind only the connector just saved.
      if (scope === "tenant" && connector?.ref.startsWith("email-") && getRemoteIngress()) {
        const inboundAgentId =
          typeof body.settings?.inboundAgentId === "string"
            ? String(body.settings.inboundAgentId).trim()
            : "";
        const settings = await integrationCatalog.auth.getSettings(session.tenantId, connector.ref);
        const agentId =
          inboundAgentId ||
          (typeof settings.inboundAgentId === "string" ? settings.inboundAgentId.trim() : "");
        const inboundEnabled =
          settings.inboundEnabled === true ||
          String(settings.inboundEnabled ?? "").toLowerCase() === "true" ||
          body.settings?.inboundEnabled === true ||
          String(body.settings?.inboundEnabled ?? "").toLowerCase() === "true";
        if (agentId && inboundEnabled) {
          await integrationCatalog.auth.ensureInstallations(session.tenantId, connector.ref, [
            agentId,
          ]);
          await getRemoteIngress()!.ensureBinding(session.tenantId, {
            agentId,
            platform: "email",
            profileKey:
              typeof (connector.auth as { profile?: unknown }).profile === "string"
                ? (connector.auth as { profile: string }).profile
                : connector.ref,
            label: connector.name || "邮箱 Agent",
            settings: {
              allowedEmails: String(settings.allowedEmails ?? body.settings?.allowedEmails ?? "")
                .split(/[\s,;\n]+/)
                .map((item) => item.trim())
                .filter(Boolean),
            },
          });
        }
      }
      return c.json({ connector, scope });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.put("/api/connectors/:ref/settings", async (c) => {
    const session = c.get("session")!;
    const scope = c.req.query("scope") === "platform" ? "platform" : "tenant";
    if (!canManageMcpOauthApps(session, config, scope)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const body = await c.req.json<{ values?: Record<string, unknown> }>();
    try {
      const connector = await integrationCatalog.saveConnectorSettings(
        scope === "platform" ? "platform" : session.tenantId,
        c.req.param("ref"),
        body.values ?? {},
      );
      return c.json({ connector, scope });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
}
