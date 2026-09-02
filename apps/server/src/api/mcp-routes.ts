/**
 * MCP HTTP API：工具目录、策略（policy）管理、上游 OAuth 授权流、
 * 内置 store、集成目录（integrations packages）与 Google 专项开通引导。
 *
 * 从 routes.ts 拆出，路由与行为保持不变。
 * 共享的上游 OAuth 中间态见 ./mcp-oauth-state.ts（与 /api/connectors/* 共用）。
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { apiKeys, componentInstances, mcpPolicies, newId } from "../db/schema.js";
import {
  McpStoreService,
  isBuiltinMcpStoreId,
  type McpStoreSourceId,
} from "../services/mcp-store.js";
import type { IntegrationCatalogService } from "../services/integration-catalog.js";
import type { McpUpstreamOauthService } from "../services/mcp-upstream-oauth.js";
import type { UpstreamOauthClientStore } from "../services/upstream-oauth-clients.js";
import type { AgentService } from "../services/agents.js";
import type { Orchestrator } from "../services/orchestrator.js";
import type { McpGateway } from "../services/mcp-gateway.js";
import { applyOauthTokensToConfig } from "../providers/generic-mcp.js";
import { randomBytes } from "node:crypto";
import { decryptJson } from "@zakura/core";
import { isSessionAdmin } from "../services/auth.js";
import { isCimdClientId } from "../services/oauth-cimd.js";
import { buildByoOauthClient } from "../services/mcp-oauth-clients.js";
import type { UpstreamOauthDiscovery } from "../services/mcp-upstream-oauth.js";
import {
  buildGoogleProvisionGuide,
  googleOauthSetupChecklist,
  provisionGoogleWorkspaceMcp,
} from "../services/google-cloud-provision.js";
import { noDcrOauthError, loadInstanceWithContainers } from "./route-helpers.js";
import {
  upstreamOauthPending,
  purgeUpstreamOauthPending,
  resolveUpstreamOauthClient,
} from "./mcp-oauth-state.js";

type SessionVars = {
  session?: {
    userId: string;
    tenantId: string;
    email: string;
    role: string;
    isPlatformAdmin?: boolean;
  };
};

export type McpRouteDeps = {
  db: Db;
  config: AppConfig;
  mcpStore: McpStoreService;
  integrationCatalog: IntegrationCatalogService;
  upstreamOauth: McpUpstreamOauthService;
  upstreamOauthClients: UpstreamOauthClientStore;
  agentService: AgentService;
  orchestrator: Orchestrator;
  gateway: McpGateway;
  /**
   * 同步连接器能力（skill 安装/卸载）。
   *
   * 上游 OAuth 回调 `/api/mcp/upstream-oauth/callback` 同时服务 MCP 实例授权与
   * 平台连接器授权两条流程，后者完成后需要同步 skill。该函数在 createApiApp 内
   * 闭包引用了 skills 服务，无法直接 import，故由调用方注入。
   */
  syncConnectorCapabilities: (
    tenantId: string,
    connectorRef: string,
    agentId: string,
    mode: "install" | "uninstall",
  ) => Promise<void>;
};

function mapPolicy(
  r: {
    id: string;
    apiKeyId: string | null;
    instanceIds: string;
    toolAllowlist: string | null;
    toolDenylist: string | null;
    includeBuiltin: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  },
  apiKey: { id: string; name: string; keyPrefix: string } | null,
  opts?: { timestamps?: boolean },
) {
  const base = {
    id: r.id,
    apiKeyId: r.apiKeyId,
    apiKey,
    instanceIds: JSON.parse(r.instanceIds) as string[],
    toolAllowlist: r.toolAllowlist ? (JSON.parse(r.toolAllowlist) as string[]) : null,
    toolDenylist: r.toolDenylist ? (JSON.parse(r.toolDenylist) as string[]) : null,
    includeBuiltin: r.includeBuiltin,
  };
  if (opts?.timestamps) {
    return { ...base, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
  return base;
}

export function registerMcpRoutes(
  app: Hono<{ Variables: SessionVars }>,
  {
    db,
    config,
    mcpStore,
    integrationCatalog,
    upstreamOauth,
    upstreamOauthClients,
    agentService,
    orchestrator,
    gateway,
    syncConnectorCapabilities,
  }: McpRouteDeps,
): void {
  app.get("/api/mcp/tools", async (c) => {
    const session = c.get("session")!;
    const tools = await gateway.listToolsForTenant(session.tenantId);
    return c.json(tools);
  });

  /** 策略页首屏：policies + api-keys + instances 一次返回 */
  app.get("/api/mcp/policies/bootstrap", async (c) => {
    const session = c.get("session")!;
    const [policyRows, keyRows, instanceRows] = await Promise.all([
      db
        .select()
        .from(mcpPolicies)
        .where(eq(mcpPolicies.tenantId, session.tenantId))
        .orderBy(desc(mcpPolicies.createdAt)),
      db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
        })
        .from(apiKeys)
        .where(eq(apiKeys.tenantId, session.tenantId))
        .orderBy(desc(apiKeys.createdAt)),
      db
        .select({
          id: componentInstances.id,
          name: componentInstances.name,
          slug: componentInstances.slug,
        })
        .from(componentInstances)
        .where(eq(componentInstances.tenantId, session.tenantId))
        .orderBy(desc(componentInstances.createdAt)),
    ]);
    const keyIds = [
      ...new Set(
        policyRows.map((r) => r.apiKeyId).filter((id): id is string => id != null),
      ),
    ];
    const policyKeys =
      keyIds.length > 0
        ? await db
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              keyPrefix: apiKeys.keyPrefix,
            })
            .from(apiKeys)
            .where(inArray(apiKeys.id, keyIds))
        : [];
    const keyMap = new Map(policyKeys.map((k) => [k.id, k]));
    return c.json({
      policies: policyRows.map((r) =>
        mapPolicy(r, r.apiKeyId ? (keyMap.get(r.apiKeyId) ?? null) : null, {
          timestamps: true,
        }),
      ),
      apiKeys: keyRows,
      instances: instanceRows,
    });
  });

  app.get("/api/mcp/policies", async (c) => {
    const session = c.get("session")!;
    const rows = await db
      .select()
      .from(mcpPolicies)
      .where(eq(mcpPolicies.tenantId, session.tenantId))
      .orderBy(desc(mcpPolicies.createdAt));

    const keyIds = [
      ...new Set(rows.map((r) => r.apiKeyId).filter((id): id is string => id != null)),
    ];
    const keys =
      keyIds.length > 0
        ? await db
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              keyPrefix: apiKeys.keyPrefix,
            })
            .from(apiKeys)
            .where(inArray(apiKeys.id, keyIds))
        : [];
    const keyMap = new Map(keys.map((k) => [k.id, k]));

    return c.json(
      rows.map((r) =>
        mapPolicy(r, r.apiKeyId ? (keyMap.get(r.apiKeyId) ?? null) : null, {
          timestamps: true,
        }),
      ),
    );
  });

  app.post("/api/mcp/policies", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      apiKeyId?: string | null;
      instanceIds?: string[];
      toolAllowlist?: string[] | null;
      toolDenylist?: string[] | null;
      includeBuiltin?: boolean;
    }>();

    if (body.apiKeyId) {
      const key = await db.query.apiKeys.findFirst({
        where: and(eq(apiKeys.id, body.apiKeyId), eq(apiKeys.tenantId, session.tenantId)),
      });
      if (!key) return c.json({ error: "apiKey not found" }, 400);
    }

    const now = new Date();
    const [row] = await db
      .insert(mcpPolicies)
      .values({
        id: newId(),
        tenantId: session.tenantId,
        apiKeyId: body.apiKeyId ?? null,
        instanceIds: JSON.stringify(body.instanceIds ?? []),
        toolAllowlist: body.toolAllowlist ? JSON.stringify(body.toolAllowlist) : null,
        toolDenylist: body.toolDenylist ? JSON.stringify(body.toolDenylist) : null,
        includeBuiltin: body.includeBuiltin ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const apiKey = row.apiKeyId
      ? ((
          await db
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              keyPrefix: apiKeys.keyPrefix,
            })
            .from(apiKeys)
            .where(eq(apiKeys.id, row.apiKeyId))
            .limit(1)
        )[0] ?? null)
      : null;

    return c.json(mapPolicy(row, apiKey), 201);
  });

  app.put("/api/mcp/policies/:id", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    const existing = await db.query.mcpPolicies.findFirst({
      where: and(eq(mcpPolicies.id, id), eq(mcpPolicies.tenantId, session.tenantId)),
    });
    if (!existing) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<{
      apiKeyId?: string | null;
      instanceIds?: string[];
      toolAllowlist?: string[] | null;
      toolDenylist?: string[] | null;
      includeBuiltin?: boolean;
    }>();

    const [row] = await db
      .update(mcpPolicies)
      .set({
        ...(body.apiKeyId !== undefined ? { apiKeyId: body.apiKeyId } : {}),
        ...(body.instanceIds !== undefined
          ? { instanceIds: JSON.stringify(body.instanceIds) }
          : {}),
        ...(body.toolAllowlist !== undefined
          ? {
              toolAllowlist: body.toolAllowlist
                ? JSON.stringify(body.toolAllowlist)
                : null,
            }
          : {}),
        ...(body.toolDenylist !== undefined
          ? {
              toolDenylist: body.toolDenylist ? JSON.stringify(body.toolDenylist) : null,
            }
          : {}),
        ...(body.includeBuiltin !== undefined
          ? { includeBuiltin: body.includeBuiltin }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(mcpPolicies.id, id))
      .returning();

    const apiKey = row.apiKeyId
      ? ((
          await db
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              keyPrefix: apiKeys.keyPrefix,
            })
            .from(apiKeys)
            .where(eq(apiKeys.id, row.apiKeyId))
            .limit(1)
        )[0] ?? null)
      : null;

    return c.json(mapPolicy(row, apiKey));
  });

  app.delete("/api/mcp/policies/:id", async (c) => {
    const session = c.get("session")!;
    const id = c.req.param("id");
    const existing = await db.query.mcpPolicies.findFirst({
      where: and(eq(mcpPolicies.id, id), eq(mcpPolicies.tenantId, session.tenantId)),
    });
    if (!existing) return c.json({ error: "Not found" }, 404);
    await db.delete(mcpPolicies).where(eq(mcpPolicies.id, id));
    return c.json({ ok: true });
  });

  /** Probe an upstream MCP without creating an instance */
  app.post("/api/mcp/probe", async (c) => {
    const body = await c.req.json<{
      mcpUrl: string;
      apiKey?: string;
      headerName?: string;
    }>();
    if (!body.mcpUrl) return c.json({ error: "mcpUrl required" }, 400);
    try {
      const { probeMcpTools } = await import("../lib/mcp-http.js");
      const tools = await probeMcpTools(body);
      return c.json({ ok: true, toolCount: tools.length, tools });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /** One-click import: external MCP, or a catalog-declared platform connector capability. */
  app.post("/api/mcp/import", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      mcpUrl: string;
      apiKey?: string;
      headerName?: string;
      name?: string;
      slug?: string;
      start?: boolean;
      /** none = probe & start; apiKey = use key; oauth = create + OAuth 2.1 */
      authMode?: "none" | "apiKey" | "oauth";
      /**
       * 用户自备 OAuth 客户端（Google/GitHub 要求 Client ID/Secret，不是 API Key）。
       * 提供后由本服务自动完成授权码流程。
       */
      oauthClientId?: string;
      oauthClientSecret?: string;
      oauthScopes?: string;
      /** 复用平台连接器 OAuth 客户端（与 hostPatterns / connector.ref 对齐） */
      oauthConnectorRef?: string;
      agentIds?: string[];
      all?: boolean;
    }>();
    if (!body.mcpUrl) return c.json({ error: "mcpUrl required" }, 400);

    const authMode = body.authMode ?? (body.apiKey?.trim() ? "apiKey" : "none");
    const bindImportedMcp = async (instanceId: string) => {
      const agentIds = await agentService.resolveInstallAgentIds(session.tenantId, {
        agentIds: body.agentIds,
        all: body.all,
      });
      if (agentIds.length) {
        await agentService.bindInstanceToAgents(session.tenantId, instanceId, agentIds);
      }
      return agentIds;
    };

    try {
      const connectorTarget = await integrationCatalog.resolveConnectorTarget(
        session.tenantId,
        body.mcpUrl,
      );
      const urlHost = (() => {
        if (connectorTarget) return connectorTarget.product;
        try {
          return new URL(body.mcpUrl).hostname.replace(/\./g, "-");
        } catch {
          return "upstream";
        }
      })();

      const name = body.name?.trim() || (connectorTarget
        ? connectorTarget.product
        : `MCP ${urlHost}`);
      const slug =
        body.slug?.trim() ||
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 32) ||
        `mcp-${Date.now().toString(36)}`;

      // 平台连接器：平台自己调用第三方 API，不代理外部 MCP。
      if (connectorTarget && authMode === "oauth") {
        if (!connectorTarget.discovery.authorizationEndpoint || !connectorTarget.discovery.tokenEndpoint) {
          throw new Error("连接器目录缺少 OAuth authorization_endpoint 或 token_endpoint");
        }
        const mcpUrl = connectorTarget.mcpUrl;
        const connectorConfig = {
          product: connectorTarget.product,
          mcpUrl,
          authRequired: true,
          oauthTokenEndpoint: connectorTarget.discovery.tokenEndpoint,
        };
        const instance = connectorTarget.existingInstance ?? await orchestrator.createInstance({
          tenantId: session.tenantId,
          providerId: connectorTarget.providerId,
          name,
          slug: connectorTarget.instanceSlug,
          config: connectorConfig,
        });
        if (connectorTarget.existingInstance) {
          await orchestrator.updateInstanceConfig(
            session.tenantId,
            connectorTarget.existingInstance.id,
            connectorConfig,
          );
        }
        await bindImportedMcp(instance.id);

        purgeUpstreamOauthPending();
        const discovery = connectorTarget.discovery;
        const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
        const client = body.oauthClientId?.trim()
          ? buildByoOauthClient(mcpUrl, {
              clientId: body.oauthClientId,
              clientSecret: body.oauthClientSecret,
              scopes: body.oauthScopes,
            })
          : connectorTarget.client
            ? {
                providerId: connectorTarget.providerId,
                connectorRef: connectorTarget.providerId,
                clientId: connectorTarget.client.clientId,
                clientSecret: connectorTarget.client.clientSecret,
                scopes: connectorTarget.scopes,
                source: connectorTarget.client.source,
              }
            : null;
        if (!client) {
          return c.json(
            {
              instance: await loadInstanceWithContainers(db, session.tenantId, instance.id),
              authRequired: true,
              oauth: {
                ok: false,
                discovery,
                error: noDcrOauthError(mcpUrl),
                needsByoClient: true,
                needsPatFallback: false,
                redirectUri,
              },
            },
            201,
          );
        }
        const state = randomBytes(16).toString("hex");
        const { url, codeVerifier } = upstreamOauth.buildAuthorizeUrl({
          discovery,
          clientId: client.clientId,
          redirectUri,
          state,
          scope: upstreamOauth.resolveScope(discovery, client.scopes),
          // 平台连接器不是外部 MCP，不传 MCP resource。
          extraParams: connectorTarget.authorizeParams,
        });
        upstreamOauthPending.set(state, {
          tenantId: session.tenantId,
          instanceId: instance.id,
          mcpUrl,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          codeVerifier,
          redirectUri,
          tokenEndpoint: discovery.tokenEndpoint!,
          resource: null,
          createdAt: Date.now(),
        });

        return c.json(
          {
            instance: await loadInstanceWithContainers(db, session.tenantId, instance.id),
            authRequired: true,
            oauth: {
              ok: true,
              authorizeUrl: url,
              state,
              clientId: client.clientId,
              clientSource: client.source,
              discovery,
            },
            started: false,
            tools: [],
            qualifiedPreview: [],
          },
          201,
        );
      }

      const { normalizeMcpHttpUrl } = await import("../lib/mcp-http.js");
      const mcpUrl = normalizeMcpHttpUrl(body.mcpUrl);

      // OAuth 2.1: create instance marked authRequired, then return authorize URL
      if (authMode === "oauth") {
        const discovery = await upstreamOauth.discover(mcpUrl);
        const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
        const hostClient = await integrationCatalog.resolveHostOauthClient(
          session.tenantId,
          mcpUrl,
          { connectorRef: body.oauthConnectorRef },
        );
        const oauthConnectorRef =
          hostClient?.connectorRef || body.oauthConnectorRef?.trim() || undefined;
        const instance = await orchestrator.createInstance({
          tenantId: session.tenantId,
          providerId: "generic-mcp",
          name,
          slug,
          config: {
            mcpUrl,
            apiKey: "",
            headerName: "Authorization",
            authRequired: true,
            ...(oauthConnectorRef ? { oauthConnectorRef } : {}),
            ...(body.oauthClientId?.trim()
              ? {
                  oauthClientId: body.oauthClientId.trim(),
                  ...(body.oauthClientSecret
                    ? { oauthClientSecret: body.oauthClientSecret }
                    : {}),
                }
              : {}),
          },
        });
        await bindImportedMcp(instance.id);

        purgeUpstreamOauthPending();
        const client = await resolveUpstreamOauthClient({
          upstreamOauth,
          discovery,
          mcpUrl,
          redirectUri,
          clientName: name,
          byo: {
            clientId: body.oauthClientId,
            clientSecret: body.oauthClientSecret,
            scopes: body.oauthScopes,
          },
          connectorClient: hostClient,
          record: {
            store: upstreamOauthClients,
            tenantId: session.tenantId,
            instanceId: instance.id,
          },
        });
        if (!client) {
          return c.json(
            {
              instance: await loadInstanceWithContainers(db, session.tenantId, instance.id),
              authRequired: true,
              oauth: {
                ok: false,
                discovery,
                error: noDcrOauthError(mcpUrl),
                needsByoClient: true,
                needsPatFallback: /github/i.test(mcpUrl),
                redirectUri,
                sharedOauth: oauthConnectorRef
                  ? { ready: false, connectorRef: oauthConnectorRef }
                  : undefined,
              },
            },
            201,
          );
        }
        if (!discovery.tokenEndpoint) {
          return c.json({ error: "上游缺少 token_endpoint", discovery }, 400);
        }
        const state = randomBytes(16).toString("hex");
        const { url, codeVerifier } = upstreamOauth.buildAuthorizeUrl({
          discovery,
          clientId: client.clientId,
          redirectUri,
          state,
          scope: upstreamOauth.resolveScope(discovery, client.scopeOverride),
          resource: discovery.resource ?? mcpUrl,
        });
        upstreamOauthPending.set(state, {
          tenantId: session.tenantId,
          instanceId: instance.id,
          mcpUrl,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          codeVerifier,
          redirectUri,
          tokenEndpoint: discovery.tokenEndpoint,
          createdAt: Date.now(),
        });

        return c.json(
          {
            instance: await loadInstanceWithContainers(db, session.tenantId, instance.id),
            authRequired: true,
            oauth: {
              ok: true,
              authorizeUrl: url,
              state,
              clientId: client.clientId,
              clientSource: client.source,
              discovery,
              sharedOauth: hostClient
                ? {
                    ready: true,
                    connectorRef: hostClient.connectorRef,
                    connectorName: hostClient.connectorName,
                    source: hostClient.source,
                  }
                : undefined,
            },
            started: false,
            tools: [],
            qualifiedPreview: [],
          },
          201,
        );
      }

      const { probeMcpTools } = await import("../lib/mcp-http.js");
      let tools: Array<{ name: string; description: string }> = [];
      try {
        tools = await probeMcpTools({
          mcpUrl,
          apiKey: body.apiKey,
          headerName: body.headerName,
        });
      } catch (err) {
        // Allow import even if probe fails when user provided a key (may need OAuth later)
        if (authMode === "none" && !body.apiKey?.trim()) throw err;
      }

      const instance = await orchestrator.createInstance({
        tenantId: session.tenantId,
        providerId: "generic-mcp",
        name,
        slug,
        config: {
          mcpUrl,
          apiKey: body.apiKey ?? "",
          headerName: body.headerName ?? "Authorization",
        },
      });

      let started = false;
      let startError: string | undefined;
      if (body.start !== false) {
        try {
          await orchestrator.startInstance(session.tenantId, instance.id);
          started = true;
        } catch (err) {
          startError = err instanceof Error ? err.message : String(err);
        }
      }

      const boundAgentIds = await bindImportedMcp(instance.id);
      const fresh = await loadInstanceWithContainers(db, session.tenantId, instance.id);
      const authRequired = !!fresh?.lastError?.startsWith("AUTH_REQUIRED");

      return c.json(
        {
          instance: fresh,
          tools,
          started,
          startError,
          authRequired,
          boundAgentIds,
          qualifiedPreview: tools.slice(0, 8).map((t) => `re_${t.name}`),
        },
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Parse & import VS Code / Cursor mcp.json (one or many servers) */
  app.post("/api/mcp/import-vscode", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      config: string | Record<string, unknown>;
      start?: boolean;
      /** Only import these keys; default all */
      keys?: string[];
      agentIds?: string[];
      all?: boolean;
    }>();
    if (body.config == null) return c.json({ error: "config required" }, 400);

    try {
      const { parseEditorMcpConfig, entryToImportBody } = await import(
        "../lib/mcp-install-parse.js"
      );
      let entries = parseEditorMcpConfig(body.config);
      if (body.keys?.length) {
        const allow = new Set(body.keys);
        entries = entries.filter((e) => allow.has(e.key));
      }
      if (!entries.length) return c.json({ error: "没有可导入的条目" }, 400);

      const agentIds = await agentService.resolveInstallAgentIds(session.tenantId, {
        agentIds: body.agentIds,
        all: body.all,
      });

      const results: Array<{
        key: string;
        instance: unknown;
        started: boolean;
        startError?: string;
        providerId: string;
        slug: string;
      }> = [];

      for (const entry of entries) {
        const plan = entryToImportBody(entry);
        const instance = await orchestrator.createInstance({
          tenantId: session.tenantId,
          providerId: plan.providerId,
          name: plan.name,
          slug: plan.slug,
          config: plan.config,
        });
        let started = false;
        let startError: string | undefined;
        if (body.start !== false) {
          try {
            await orchestrator.startInstance(session.tenantId, instance.id);
            started = true;
          } catch (err) {
            startError = err instanceof Error ? err.message : String(err);
          }
        }
        if (agentIds.length) {
          await agentService.bindInstanceToAgents(session.tenantId, instance.id, agentIds);
        }
        results.push({
          key: entry.key,
          instance: await loadInstanceWithContainers(db, session.tenantId, instance.id),
          started,
          startError,
          providerId: plan.providerId,
          slug: plan.slug,
        });
      }

      return c.json({ count: results.length, results, boundAgentIds: agentIds }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/mcp/parse-vscode", async (c) => {
    const body = await c.req.json<{ config: string | Record<string, unknown> }>();
    if (body.config == null) return c.json({ error: "config required" }, 400);
    try {
      const { parseEditorMcpConfig, entryToImportBody } = await import(
        "../lib/mcp-install-parse.js"
      );
      const entries = parseEditorMcpConfig(body.config);
      return c.json({
        entries: entries.map((e) => ({
          ...e,
          importPreview: entryToImportBody(e),
        })),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Schema-aware tool playground — call any tenant-visible tool */
  app.post("/api/mcp/call", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      qualifiedName: string;
      arguments?: Record<string, unknown>;
      agentId?: string;
      task?: { ttl?: number | null; pollInterval?: number };
    }>();
    if (!body.qualifiedName) return c.json({ error: "qualifiedName required" }, 400);
    const result = await gateway.callTool(
      session.tenantId,
      body.qualifiedName.startsWith("re_")
        ? body.qualifiedName
        : `re_${body.qualifiedName}`,
      body.arguments ?? {},
      { agentId: body.agentId },
    );
    if (result && typeof result === "object" && "task" in result && result.task) {
      return c.json({ ok: true, task: true, result });
    }
    return c.json({
      ok: !(result as { isError?: boolean }).isError,
      result,
    });
  });

  /** 读取聚合后的 MCP resource */
  app.post("/api/mcp/resources/read", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ uri?: string; agentId?: string }>();
    if (!body.uri?.trim()) return c.json({ error: "uri required" }, 400);
    try {
      const result = await gateway.readResource(session.tenantId, body.uri.trim(), {
        agentId: body.agentId,
      });
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** 获取聚合后的 MCP prompt */
  app.post("/api/mcp/prompts/get", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      arguments?: Record<string, string>;
      agentId?: string;
    }>();
    if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
    try {
      const result = await gateway.getPrompt(
        session.tenantId,
        body.name.trim(),
        body.arguments,
        { agentId: body.agentId },
      );
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** MCP completion/complete */
  app.post("/api/mcp/complete", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      ref?: { type?: string; name?: string; uri?: string };
      argument?: { name?: string; value?: string };
      agentId?: string;
    }>();
    const refType = body.ref?.type;
    const argName = body.argument?.name;
    const argValue = body.argument?.value;
    if (
      (refType !== "ref/prompt" && refType !== "ref/resource") ||
      typeof argName !== "string" ||
      typeof argValue !== "string"
    ) {
      return c.json({ error: "ref + argument required" }, 400);
    }
    try {
      const result = await gateway.complete(
        session.tenantId,
        {
          ref:
            refType === "ref/prompt"
              ? { type: "ref/prompt", name: String(body.ref?.name ?? "") }
              : { type: "ref/resource", uri: String(body.ref?.uri ?? "") },
          argument: { name: argName, value: argValue },
        },
        { agentId: body.agentId },
      );
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** MCP Store — official registry + curated source links */
  app.get("/api/mcp/store/sources", async (c) => {
    const session = c.get("session")!;
    return c.json({ sources: await mcpStore.listSources(session.tenantId) });
  });

  app.post("/api/mcp/store/sources", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      repository?: string;
      sourceUrl?: string;
      format?: "auto" | "claude" | "codex";
      name?: string;
    }>();
    const input = (body.sourceUrl ?? body.repository ?? "").trim();
    if (!input) return c.json({ error: "repository or sourceUrl required" }, 400);
    try {
      const looksLikeJson =
        /\.json(\?|$)/i.test(input) ||
        input.includes("marketplace.json") ||
        input.includes(".claude-plugin/") ||
        input.includes(".codex-plugin/");
      const source = looksLikeJson
        ? await mcpStore.importSource(session.tenantId, {
            sourceUrl: input,
            format: body.format ?? "auto",
            name: body.name,
          })
        : await mcpStore.importRepository(session.tenantId, input);
      return c.json({ source }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/mcp/store/sources/:id", async (c) => {
    const session = c.get("session")!;
    const deleted = await mcpStore.deleteSource(session.tenantId, decodeURIComponent(c.req.param("id")));
    return deleted ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  });

  app.post("/api/mcp/store/sync", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      force?: boolean;
      maxPages?: number;
      stores?: string[];
      store?: string;
    };
    try {
      const requested = body.stores?.length
        ? body.stores
        : body.store
          ? [body.store]
          : undefined;
      const custom = requested?.filter((store) => store.startsWith("custom:")) ?? [];
      const invalid = requested?.filter((store) => !store.startsWith("custom:") && !isBuiltinMcpStoreId(store)) ?? [];
      if (invalid.length) return c.json({ error: `unknown store: ${invalid.join(", ")}` }, 400);
      if (custom.length) {
        const session = c.get("session")!;
        const results = [];
        for (const store of custom) results.push(await mcpStore.syncCustomSource(session.tenantId, store as McpStoreSourceId));
        return c.json({ results });
      }
      const stores = requested?.filter(isBuiltinMcpStoreId);
      const result = await mcpStore.sync({
        force: body.force === true,
        maxPages: typeof body.maxPages === "number" ? body.maxPages : 25,
        stores,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/api/mcp/store/search", async (c) => {
    const session = c.get("session")!;
    const q = c.req.query("q") ?? "";
    const kind = (c.req.query("kind") as "http" | "stdio" | "all" | undefined) ?? "all";
    const store = (c.req.query("store") as McpStoreSourceId | "all" | undefined) ?? "github-mcp";
    const limit = Number(c.req.query("limit") ?? 40);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await mcpStore.search({ tenantId: session.tenantId, q, kind, store, limit, offset });
    return c.json(result);
  });

  app.get("/api/mcp/store/servers/:name", async (c) => {
    const session = c.get("session")!;
    const name = decodeURIComponent(c.req.param("name"));
    const store = c.req.query("store") as McpStoreSourceId | undefined;
    const server = await mcpStore.getServer(name, store, session.tenantId);
    if (!server) return c.json({ error: "Not found" }, 404);
    const preview = mcpStore.buildInstallPreview(server);
    return c.json({ ...server, preview });
  });

  app.post("/api/mcp/store/install", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name: string;
      store?: McpStoreSourceId;
      prefer?: "http" | "stdio";
      remoteUrl?: string;
      env?: Record<string, string>;
      packageIndex?: number;
      slug?: string;
      displayName?: string;
      start?: boolean;
      agentIds?: string[];
      all?: boolean;
      runtimeNodeId?: string | null;
    }>();
    if (!body.name) return c.json({ error: "name required" }, 400);
    try {
      const server = await mcpStore.getServer(body.name, body.store, session.tenantId);
      if (!server) return c.json({ error: "server not found in registry" }, 404);
      const plan = mcpStore.buildInstallPlan(server, {
        prefer: body.prefer,
        remoteUrl: body.remoteUrl,
        env: body.env,
        packageIndex: body.packageIndex,
      });
      if (body.slug?.trim()) plan.slug = body.slug.trim();
      if (body.displayName?.trim()) plan.name = body.displayName.trim();

      const needsRunner = plan.providerId === "stdio-mcp";
      const instance = await orchestrator.createInstance({
        tenantId: session.tenantId,
        providerId: plan.providerId,
        name: plan.name,
        slug: plan.slug,
        config: plan.config,
        runtimeNodeId: needsRunner ? (body.runtimeNodeId ?? null) : null,
      });

      let started = false;
      let startError: string | undefined;
      if (body.start !== false) {
        try {
          await orchestrator.startInstance(session.tenantId, instance.id);
          started = true;
        } catch (err) {
          startError = err instanceof Error ? err.message : String(err);
        }
      }

      const agentIds = await agentService.resolveInstallAgentIds(session.tenantId, {
        agentIds: body.agentIds,
        all: body.all,
      });
      if (agentIds.length) {
        await agentService.bindInstanceToAgents(session.tenantId, instance.id, agentIds);
      }

      const fresh = await loadInstanceWithContainers(db, session.tenantId, instance.id);
      let authRequired = !!fresh?.lastError?.startsWith("AUTH_REQUIRED");

      // Re-read config flag if afterStart marked authRequired
      if (fresh && plan.providerId === "generic-mcp") {
        try {
          const handle = await orchestrator.toHandle(session.tenantId, fresh.id);
          if (handle.config.authRequired === true) authRequired = true;
        } catch {
          /* ignore */
        }
      }

      return c.json(
        {
          plan,
          instance: fresh,
          started,
          startError,
          authRequired,
          envHints: plan.envHints,
          storeId: server.storeId,
          boundAgentIds: agentIds,
        },
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Import stdio MCP directly (without store) */
  app.post("/api/mcp/import-stdio", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      name?: string;
      slug?: string;
      command: string;
      args?: string[] | string;
      env?: Record<string, string> | string;
      image?: string;
      workingDir?: string;
      packageManager?: "npm" | "pypi" | "oci" | "binary";
      start?: boolean;
      agentIds?: string[];
      all?: boolean;
      runtimeNodeId?: string | null;
    }>();
    if (!body.command?.trim()) return c.json({ error: "command required" }, 400);
    try {
      const name = body.name?.trim() || `Stdio ${body.command}`;
      const slug =
        body.slug?.trim() ||
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 32) ||
        `stdio-${Date.now().toString(36)}`;

      const packageManager =
        body.packageManager === "pypi" ||
        body.packageManager === "oci" ||
        body.packageManager === "binary"
          ? body.packageManager
          : body.command.trim() === "docker" || body.command.trim() === "podman"
            ? "oci"
            : "npm";

      const instance = await orchestrator.createInstance({
        tenantId: session.tenantId,
        providerId: "stdio-mcp",
        name,
        slug,
        config: {
          command: body.command.trim(),
          args: Array.isArray(body.args) ? JSON.stringify(body.args) : (body.args ?? "[]"),
          env:
            typeof body.env === "string"
              ? body.env
              : JSON.stringify(body.env ?? {}),
          image: body.image,
          workingDir: body.workingDir ?? "/data",
          packageManager,
        },
        runtimeNodeId: body.runtimeNodeId ?? null,
      });

      let started = false;
      let startError: string | undefined;
      if (body.start !== false) {
        try {
          await orchestrator.startInstance(session.tenantId, instance.id);
          started = true;
        } catch (err) {
          startError = err instanceof Error ? err.message : String(err);
        }
      }

      const agentIds = await agentService.resolveInstallAgentIds(session.tenantId, {
        agentIds: body.agentIds,
        all: body.all,
      });
      if (agentIds.length) {
        await agentService.bindInstanceToAgents(session.tenantId, instance.id, agentIds);
      }

      return c.json(
        {
          instance: await loadInstanceWithContainers(db, session.tenantId, instance.id),
          started,
          startError,
          boundAgentIds: agentIds,
        },
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Upstream MCP OAuth 2.1 discovery + DCR + authorize URL */
  app.post("/api/mcp/upstream-oauth/start", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      mcpUrl?: string;
      instanceId?: string;
      clientName?: string;
      scope?: string;
      oauthClientId?: string;
      oauthClientSecret?: string;
      oauthConnectorRef?: string;
    }>();

    let mcpUrl = body.mcpUrl?.trim() ?? "";
    let storedConfig: Record<string, unknown> = {};
    if (!mcpUrl && body.instanceId) {
      const existing = await db.query.componentInstances.findFirst({
        where: and(
          eq(componentInstances.id, body.instanceId),
          eq(componentInstances.tenantId, session.tenantId),
        ),
      });
      if (!existing) return c.json({ error: "instance not found" }, 404);
      try {
        const cfg = decryptJson<Record<string, unknown>>(config.secret, existing.configEnc);
        storedConfig = cfg;
        mcpUrl =
          (typeof cfg.mcpUrl === "string" && cfg.mcpUrl) ||
          existing.endpointUrl ||
          "";
      } catch (err) {
        return c.json(
          {
            error:
              err instanceof Error
                ? err.message
                : "实例配置无法解密，请检查 ZAKURA_SECRET / data/secret.key",
          },
          400,
        );
      }
    }
    if (!mcpUrl) return c.json({ error: "mcpUrl required" }, 400);

    try {
      purgeUpstreamOauthPending();
      const connectorTarget = await integrationCatalog.resolveConnectorTarget(
        session.tenantId,
        mcpUrl,
      );
      const discovery = connectorTarget?.discovery ?? await upstreamOauth.discover(mcpUrl);
      const oauthDiscovery = discovery as UpstreamOauthDiscovery;
      const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
      const resolvedUrl = connectorTarget?.mcpUrl ?? mcpUrl;
      const oauthClientId =
        body.oauthClientId?.trim() ||
        (typeof storedConfig.oauthClientId === "string" ? storedConfig.oauthClientId.trim() : "");
      const oauthClientSecret =
        body.oauthClientSecret ??
        (typeof storedConfig.oauthClientSecret === "string" && storedConfig.oauthClientSecret !== "***"
          ? storedConfig.oauthClientSecret
          : undefined);
      const oauthConnectorRef =
        body.oauthConnectorRef?.trim() ||
        (typeof storedConfig.oauthConnectorRef === "string"
          ? storedConfig.oauthConnectorRef.trim()
          : undefined);
      const client = connectorTarget
        ? oauthClientId
          ? buildByoOauthClient(resolvedUrl, {
              clientId: oauthClientId,
              clientSecret: oauthClientSecret,
              scopes: body.scope,
            })
          : connectorTarget.client
            ? {
                providerId: connectorTarget.providerId,
                connectorRef: connectorTarget.providerId,
                clientId: connectorTarget.client.clientId,
                clientSecret: connectorTarget.client.clientSecret,
                scopes: connectorTarget.scopes,
                source: connectorTarget.client.source,
              }
            : null
        : await resolveUpstreamOauthClient({
            upstreamOauth,
            discovery,
            mcpUrl: resolvedUrl,
            redirectUri,
            clientName: body.clientName,
            byo: {
              clientId: oauthClientId,
              clientSecret: oauthClientSecret,
              scopes: body.scope,
            },
            connectorClient: await integrationCatalog.resolveHostOauthClient(
              session.tenantId,
              resolvedUrl,
              { connectorRef: oauthConnectorRef },
            ),
            record: {
              store: upstreamOauthClients,
              tenantId: session.tenantId,
              instanceId: body.instanceId,
            },
          });

      if (!client) {
        return c.json(
          {
            ok: false,
            discovery,
            error: noDcrOauthError(resolvedUrl),
            needsByoClient: true,
            needsPatFallback: /github/i.test(mcpUrl),
            redirectUri,
          },
          400,
        );
      }

      if (!discovery.tokenEndpoint) {
        return c.json({ error: "上游缺少 token_endpoint", discovery }, 400);
      }

      if (body.instanceId) {
        await orchestrator.updateInstanceConfig(session.tenantId, body.instanceId, {
          oauthClientId: client.clientId,
          ...(client.clientSecret ? { oauthClientSecret: client.clientSecret } : {}),
          oauthClientSource: client.source,
          oauthClientMode: isCimdClientId(client.clientId)
            ? "cimd"
            : client.source === "dcr"
              ? "dynamic"
              : "manual",
          oauthRedirectUri: redirectUri,
          oauthRegistrationEndpoint: oauthDiscovery.registrationEndpoint ?? "",
          oauthAuthorizationEndpoint: oauthDiscovery.authorizationEndpoint ?? "",
          oauthTokenEndpoint: oauthDiscovery.tokenEndpoint,
          oauthResourceMetadataUrl: oauthDiscovery.resourceMetadataUrl ?? "",
          oauthScopes: body.scope ?? oauthDiscovery.scopesSupported?.join(" ") ?? "",
        });
      }

      const state = randomBytes(16).toString("hex");
      const { url, codeVerifier } = upstreamOauth.buildAuthorizeUrl({
        discovery,
        clientId: client.clientId,
        redirectUri,
        state,
        scope: upstreamOauth.resolveScope(discovery, body.scope ?? (
          connectorTarget
            ? ("scopes" in client ? client.scopes : undefined)
            : ("scopeOverride" in client ? client.scopeOverride : undefined)
        )),
        resource: connectorTarget
          ? undefined
          : ("resource" in discovery ? discovery.resource : undefined) ?? mcpUrl,
        extraParams: connectorTarget?.authorizeParams,
      });

      upstreamOauthPending.set(state, {
        tenantId: session.tenantId,
        instanceId: body.instanceId,
        mcpUrl: resolvedUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        codeVerifier,
        redirectUri,
        tokenEndpoint: discovery.tokenEndpoint,
        resource: connectorTarget ? null : undefined,
        createdAt: Date.now(),
      });

      return c.json({
        ok: true,
        authorizeUrl: url,
        state,
        discovery,
        clientId: client.clientId,
        clientSource: client.source,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
  app.post("/api/mcp/upstream-oauth/authorize", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{
      mcpUrl: string;
      clientId: string;
      clientSecret?: string;
      instanceId?: string;
      scope?: string;
    }>();
    if (!body.mcpUrl || !body.clientId) {
      return c.json({ error: "mcpUrl and clientId required" }, 400);
    }
    try {
      const discovery = await upstreamOauth.discover(body.mcpUrl);
      if (!discovery.authorizationEndpoint || !discovery.tokenEndpoint) {
        return c.json({ error: "上游 OAuth 元数据不完整", discovery }, 400);
      }
      const redirectUri = `${config.publicBaseUrl}/api/mcp/upstream-oauth/callback`;
      const state = randomBytes(16).toString("hex");
      const { url, codeVerifier } = upstreamOauth.buildAuthorizeUrl({
        discovery,
        clientId: body.clientId,
        redirectUri,
        state,
        scope: upstreamOauth.resolveScope(discovery, body.scope),
        resource: discovery.resource ?? body.mcpUrl,
      });
      upstreamOauthPending.set(state, {
        tenantId: session.tenantId,
        instanceId: body.instanceId,
        mcpUrl: body.mcpUrl,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        codeVerifier,
        redirectUri,
        tokenEndpoint: discovery.tokenEndpoint,
        createdAt: Date.now(),
      });
      return c.json({ ok: true, authorizeUrl: url, state, discovery });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Browser lands here after upstream consent — exchange code & persist tokens */
  app.get("/api/mcp/upstream-oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const err = c.req.query("error");
    if (err) {
      return c.redirect(
        `${config.webPublicUrl}/console/oauth/mcp-upstream/callback?error=${encodeURIComponent(err)}`,
      );
    }
    if (!code || !state) {
      return c.redirect(
        `${config.webPublicUrl}/console/oauth/mcp-upstream/callback?error=missing_code`,
      );
    }
    const pending = upstreamOauthPending.get(state);
    upstreamOauthPending.delete(state);
    if (!pending) {
      return c.redirect(
        `${config.webPublicUrl}/console/oauth/mcp-upstream/callback?error=invalid_state`,
      );
    }
    try {
      const tokens = await upstreamOauth.exchangeCode({
        tokenEndpoint: pending.tokenEndpoint,
        code,
        redirectUri: pending.redirectUri,
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
        codeVerifier: pending.codeVerifier,
        resource: pending.resource === null ? undefined : pending.resource ?? pending.mcpUrl,
      });

      let instanceId = pending.instanceId;
      if (pending.connectorRef) {
        if (!pending.agentId) {
          throw new Error("连接器授权缺少 Agent");
        }
        await integrationCatalog.saveConnectorAuthorization(
          pending.tenantId,
          pending.connectorRef,
          tokens,
          pending.agentId,
        );
        await syncConnectorCapabilities(
          pending.tenantId,
          pending.connectorRef,
          pending.agentId,
          "install",
        );
        return c.redirect(
          `${config.webPublicUrl}/dashboard/connectors?connector=${encodeURIComponent(pending.connectorRef)}&agent=${encodeURIComponent(pending.agentId)}&oauth=1`,
        );
      }
      if (instanceId) {
        const existing = await db.query.componentInstances.findFirst({
          where: and(
            eq(componentInstances.id, instanceId),
            eq(componentInstances.tenantId, pending.tenantId),
          ),
        });
        if (!existing) throw new Error("instance not found");
        const current = decryptJson<Record<string, unknown>>(
          config.secret,
          existing.configEnc,
        );
        await orchestrator.updateInstanceConfig(
          pending.tenantId,
          instanceId,
          applyOauthTokensToConfig(current, tokens),
        );
        // OAuth 凭证到位后补刷 tools 预缓存（此前 AUTH_REQUIRED 会跳过）
        void gateway.refreshInstanceTools(pending.tenantId, instanceId);
      } else {
        const host = (() => {
          try {
            return new URL(pending.mcpUrl).hostname.replace(/\./g, "-");
          } catch {
            return "oauth-mcp";
          }
        })();
        const created = await orchestrator.createInstance({
          tenantId: pending.tenantId,
          providerId: "generic-mcp",
          name: `MCP ${host}`,
          slug: `mcp-${host}`.slice(0, 32),
          config: applyOauthTokensToConfig(
            { mcpUrl: pending.mcpUrl, apiKey: "", headerName: "Authorization" },
            tokens,
          ),
        });
        instanceId = created.id;
        await orchestrator.startInstance(pending.tenantId, created.id);
      }

      return c.redirect(
        `${config.webPublicUrl}/console/oauth/mcp-upstream/callback?ok=1&instanceId=${encodeURIComponent(instanceId)}`,
      );
    } catch (exchangeErr) {
      const msg = exchangeErr instanceof Error ? exchangeErr.message : String(exchangeErr);
      return c.redirect(
        `${config.webPublicUrl}/console/oauth/mcp-upstream/callback?error=${encodeURIComponent(msg)}`,
      );
    }
  });

  // OAuth callback already persists tokens; no health probe is needed here.
  app.post("/api/mcp/upstream-oauth/verify", async (c) => {
    const session = c.get("session")!;
    const body = await c.req.json<{ instanceId: string }>();
    if (!body.instanceId) return c.json({ error: "instanceId required" }, 400);
    const existing = await db.query.componentInstances.findFirst({
      where: and(
        eq(componentInstances.id, body.instanceId),
        eq(componentInstances.tenantId, session.tenantId),
      ),
    });
    if (!existing) return c.json({ error: "Not found" }, 404);
    return c.json({
      ok: true,
      message: "OAuth 凭据已保存，连接状态将在实际调用时确定",
    });
  });


  app.get("/api/mcp/oauth-redirect-uri", async (c) => {
    return c.json({
      redirectUri: `${config.publicBaseUrl.replace(/\/$/, "")}/api/mcp/upstream-oauth/callback`,
      note:
        "部分外部 MCP 不支持动态客户端注册；将此 URI 填入对应 OAuth App。平台连接器凭据请在独立页面管理。",
    });
  });

  /** 平台连接器能力目录。外部 MCP 使用独立商店，不进入这里。 */
  app.get("/api/integrations/packages", async (c) => {
    const session = c.get("session")!;
    return c.json({ packages: await integrationCatalog.list(session.tenantId) });
  });

  app.get("/api/integrations/packages/:slug", async (c) => {
    const session = c.get("session")!;
    const pkg = await integrationCatalog.get(session.tenantId, c.req.param("slug"));
    if (!pkg) return c.json({ error: "Not found" }, 404);
    return c.json({ package: pkg });
  });


  app.get("/api/mcp/google/provision-guide", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const projectId = c.req.query("projectId")?.trim() || "YOUR_PROJECT_ID";
    const productsRaw = c.req.query("products") ?? "gmail,drive,calendar,people,chat";
    const products = productsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is "gmail" | "drive" | "calendar" | "people" | "chat" =>
        s === "gmail" ||
        s === "drive" ||
        s === "calendar" ||
        s === "people" ||
        s === "chat",
      );
    try {
      const guide = buildGoogleProvisionGuide(config, projectId, products);
      return c.json(guide);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /**
   * 使用 Service Account 自动启用 Workspace MCP 相关 Cloud API。
   * 不持久化 SA JSON。OAuth Web 客户端仍须用户在 Console 创建后粘贴回来。
   */
  app.post("/api/mcp/google/provision", async (c) => {
    const session = c.get("session")!;
    if (!isSessionAdmin(session)) {
      return c.json({ error: "需要管理员权限" }, 403);
    }
    const body = await c.req.json<{
      serviceAccountJson: unknown;
      projectId?: string;
      products?: Array<"gmail" | "drive" | "calendar" | "people" | "chat">;
    }>();
    if (body.serviceAccountJson == null) {
      return c.json({ error: "serviceAccountJson required" }, 400);
    }
    try {
      const result = await provisionGoogleWorkspaceMcp({
        config,
        serviceAccountJson: body.serviceAccountJson,
        projectId: body.projectId,
        products: body.products,
      });
      return c.json({
        ...result,
        checklist: result.checklist ?? googleOauthSetupChecklist(result.redirectUri),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

}
