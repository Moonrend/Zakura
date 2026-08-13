import type { ProviderPlugin, InstanceHandle, ProviderContext } from "@zakura/core";
import { componentLogger, textResult } from "@zakura/core";
import type {
  HealthResult,
  McpCompleteParams,
  McpCompleteResult,
  McpGetPromptResult,
  McpPromptDef,
  McpReadResourceResult,
  McpResourceDef,
  McpResourceTemplateDef,
  McpToolDef,
  McpToolResult,
  ProviderConfigSchema,
  RuntimeSpec,
} from "@zakura/shared";
import {
  normalizeCompleteResult,
  normalizeGetPromptResult,
  normalizePromptDef,
  normalizeReadResourceResult,
  normalizeResourceDef,
  normalizeResourceTemplateDef,
  normalizeToolResult,
  isCreateTaskResult,
  pickUpstreamToolFields,
} from "@zakura/shared";
import { eq } from "drizzle-orm";
import {
  hasMcpCredentials,
  isMcpAuthError,
  mcpAuthHeaders,
  mcpErrorSummary,
  mcpHttpRpc,
  McpHttpError,
  normalizeMcpHttpUrl,
} from "../lib/mcp-http.js";
import { componentInstances } from "../db/schema.js";
import { McpUpstreamOauthService } from "../services/mcp-upstream-oauth.js";
import type { AppConfig } from "../config.js";

/**
 * Generic upstream MCP proxy — drop in any streamable-HTTP MCP endpoint.
 * Supports static API key or OAuth 2.1 access tokens (from upstream DCR flow).
 * Pair with POST /api/mcp/import for one-click onboarding.
 */
const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "Generic MCP",
  required: ["mcpUrl"],
  properties: {
    mcpUrl: {
      type: "string",
      title: "MCP URL",
      format: "url",
      description: "例如 http://127.0.0.1:3000/mcp",
    },
    apiKey: {
      type: "string",
      title: "Bearer / API Key",
      format: "password",
      description: "静态密钥；若已配置 OAuth accessToken 可留空",
    },
    headerName: {
      type: "string",
      title: "鉴权 Header 名",
      default: "Authorization",
      description: "默认 Authorization: Bearer <key>",
    },
    oauthAccessToken: {
      type: "string",
      title: "OAuth Access Token",
      format: "password",
      description: "上游 MCP OAuth 2.1 access_token（优先于 apiKey）",
    },
    oauthRefreshToken: {
      type: "string",
      title: "OAuth Refresh Token",
      format: "password",
    },
    oauthExpiresAt: {
      type: "number",
      title: "Token 过期时间（unix 秒）",
    },
    oauthClientId: {
      type: "string",
      title: "OAuth Client ID",
    },
    oauthClientSecret: {
      type: "string",
      title: "OAuth Client Secret",
      format: "password",
    },
    oauthTokenEndpoint: {
      type: "string",
      title: "Token Endpoint",
      format: "url",
    },
    authRequired: {
      type: "boolean",
      title: "需要上游 OAuth / API Key",
      description: "探测到 401 后自动置位；完成授权后清除",
    },
  },
};

let appConfigRef: AppConfig | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbRef: any = null;

/** Wire AppConfig + DB so generic-mcp can refresh OAuth tokens and persist auth state */
export function injectGenericMcpRuntime(config: AppConfig, db: unknown): void {
  appConfigRef = config;
  dbRef = db;
}

function runtimeCtx(handle: InstanceHandle): ProviderContext {
  return {
    tenantId: handle.tenantId,
    instanceId: handle.id,
    dataDir: appConfigRef?.dataDir ?? "",
    db: dbRef,
    resolveEndpoint: (port, path = "") =>
      `http://127.0.0.1:${port}${path.startsWith("/") || !path ? path : `/${path}`}`,
    logger: componentLogger("generic-mcp"),
  };
}

function authHeaders(config: Record<string, unknown>): Record<string, string> {
  const oauthToken =
    typeof config.oauthAccessToken === "string" ? config.oauthAccessToken.trim() : "";
  if (oauthToken) {
    return { Authorization: `Bearer ${oauthToken}` };
  }
  return mcpAuthHeaders({
    apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
    headerName: typeof config.headerName === "string" ? config.headerName : undefined,
  });
}

function tokenExpiringSoon(config: Record<string, unknown>, skewSec = 120): boolean {
  const exp = config.oauthExpiresAt;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
  return exp <= Math.floor(Date.now() / 1000) + skewSec;
}

async function maybeRefreshOauth(
  handle: InstanceHandle,
  ctx?: ProviderContext,
): Promise<Record<string, unknown>> {
  let config = { ...handle.config };
  if (!tokenExpiringSoon(config) && config.oauthAccessToken) return config;
  if (!config.oauthRefreshToken || !config.oauthTokenEndpoint || !config.oauthClientId) {
    return config;
  }
  if (!appConfigRef) return config;

  try {
    const oauth = new McpUpstreamOauthService(appConfigRef);
    const tokens = await oauth.refresh({
      accessToken: String(config.oauthAccessToken ?? ""),
      refreshToken: String(config.oauthRefreshToken),
      tokenEndpoint: String(config.oauthTokenEndpoint),
      clientId: String(config.oauthClientId),
      clientSecret:
        typeof config.oauthClientSecret === "string" ? config.oauthClientSecret : undefined,
    });
    config = applyOauthTokensToConfig(config, tokens);
    config.authRequired = false;
    handle.config = config;
    if (ctx?.db && appConfigRef) {
      const { encryptJson } = await import("@zakura/core");
      await ctx.db
        .update(componentInstances)
        .set({
          configEnc: encryptJson(appConfigRef.secret, config),
          healthStatus: "healthy",
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(componentInstances.id, handle.id));
    }
  } catch (err) {
    ctx?.logger.warn("oauth refresh failed", {
      instanceId: handle.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return config;
}

async function markInstanceAuthState(
  ctx: ProviderContext | undefined,
  handle: InstanceHandle,
  err: unknown,
): Promise<void> {
  if (!ctx?.db) return;
  const summary = mcpErrorSummary(err);
  const authRequired = isMcpAuthError(err);
  const nextConfig = authRequired
    ? { ...handle.config, authRequired: true }
    : { ...handle.config };

  handle.config = nextConfig;

  try {
    const patch: Record<string, unknown> = {
      healthStatus: "unhealthy",
      lastError: summary,
      updatedAt: new Date(),
    };
    if (authRequired && appConfigRef) {
      const { encryptJson } = await import("@zakura/core");
      patch.configEnc = encryptJson(appConfigRef.secret, nextConfig);
    }
    await ctx.db
      .update(componentInstances)
      .set(patch)
      .where(eq(componentInstances.id, handle.id));
  } catch {
    /* best-effort */
  }
}

async function clearAuthRequired(ctx: ProviderContext | undefined, handle: InstanceHandle) {
  if (!handle.config.authRequired) return;
  const next = { ...handle.config, authRequired: false };
  handle.config = next;
  if (!ctx?.db || !appConfigRef) return;
  try {
    const { encryptJson } = await import("@zakura/core");
    await ctx.db
      .update(componentInstances)
      .set({
        configEnc: encryptJson(appConfigRef.secret, next),
        healthStatus: "healthy",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(componentInstances.id, handle.id));
  } catch {
    /* ignore */
  }
}

async function rpcWithAuth(
  handle: InstanceHandle,
  method: string,
  params?: Record<string, unknown>,
  ctx?: ProviderContext,
): Promise<unknown> {
  const config = await maybeRefreshOauth(handle, ctx);

  // Known auth-required and still no credentials → fail fast without network spam
  if (config.authRequired === true && !hasMcpCredentials(config)) {
    throw new McpHttpError(
      "MCP HTTP 401: missing required Authorization header (请先完成上游 OAuth 或填写 API Key)",
      { status: 401, kind: "auth" },
    );
  }

  try {
    const result = await mcpHttpRpc(
      String(config.mcpUrl),
      authHeaders(config),
      method,
      params,
    );
    await clearAuthRequired(ctx, handle);
    return result;
  } catch (err) {
    // Retry once after refresh on 401 when refresh token exists
    if (
      isMcpAuthError(err) &&
      config.oauthRefreshToken &&
      config.oauthTokenEndpoint &&
      config.oauthClientId
    ) {
      // Force refresh by faking expiry
      handle.config = { ...config, oauthExpiresAt: 0 };
      const refreshed = await maybeRefreshOauth(handle, ctx);
      if (hasMcpCredentials(refreshed)) {
        try {
          const result = await mcpHttpRpc(
            String(refreshed.mcpUrl),
            authHeaders(refreshed),
            method,
            params,
          );
          await clearAuthRequired(ctx, handle);
          return result;
        } catch (retryErr) {
          await markInstanceAuthState(ctx, handle, retryErr);
          throw retryErr;
        }
      }
    }
    await markInstanceAuthState(ctx, handle, err);
    throw err;
  }
}

export function createGenericMcpProvider(): ProviderPlugin {
  return {
    id: "generic-mcp",
    name: "Generic MCP",
    description: "透传任意上游 MCP（HTTP / OAuth 2.1），用于快速接入未内置的组件",
    version: "0.5.0",
    category: "mcp",
    capabilities: ["mcp-proxy", "tools", "resources", "prompts", "completions"],
    configSchema,

    validateConfig(config) {
      if (!config.mcpUrl || typeof config.mcpUrl !== "string") {
        throw new Error("mcpUrl is required");
      }
      config = { ...config, mcpUrl: normalizeMcpHttpUrl(config.mcpUrl) };
      // Normalize empty secrets
      if (typeof config.apiKey === "string" && !config.apiKey.trim()) {
        config = { ...config, apiKey: "" };
      }
      return config;
    },

    createRuntimeSpec(config): RuntimeSpec {
      return {
        containers: [],
        endpointTemplate: String(config.mcpUrl),
      };
    },

    async afterStart(handle, ctx) {
      try {
        await rpcWithAuth(handle, "tools/list", undefined, ctx);
        ctx.logger.info("generic-mcp probe ok", { instanceId: handle.id });
      } catch (err) {
        const summary = mcpErrorSummary(err);
        ctx.logger.warn("generic-mcp probe failed", {
          instanceId: handle.id,
          error: summary,
        });
        // State already persisted in rpcWithAuth / markInstanceAuthState
      }
    },

    async healthCheck(handle): Promise<HealthResult> {
      try {
        await rpcWithAuth(handle, "tools/list", undefined, runtimeCtx(handle));
        return { status: "healthy", message: "tools/list ok" };
      } catch (err) {
        return {
          status: "unhealthy",
          message: mcpErrorSummary(err),
          details: {
            authRequired: isMcpAuthError(err),
          },
        };
      }
    },

    async listTools(handle): Promise<McpToolDef[]> {
      const result = (await rpcWithAuth(
        handle,
        "tools/list",
        undefined,
        runtimeCtx(handle),
      )) as {
        tools?: Array<Record<string, unknown>>;
      };
      return (result.tools ?? []).map((t) => {
        const name = typeof t.name === "string" ? t.name : "unknown";
        return {
          name,
          description:
            typeof t.description === "string" ? t.description : name,
          inputSchema:
            t.inputSchema && typeof t.inputSchema === "object"
              ? (t.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
          ...pickUpstreamToolFields(t),
        };
      });
    },

    async callTool(handle, toolName, args): Promise<McpToolResult> {
      try {
        const result = await rpcWithAuth(
          handle,
          "tools/call",
          { name: toolName, arguments: args },
          runtimeCtx(handle),
        );
        if (isCreateTaskResult(result)) return result as never;
        return normalizeToolResult(result);
      } catch (err) {
        return textResult(mcpErrorSummary(err), true);
      }
    },

    async invokeRaw(handle, method, params) {
      return rpcWithAuth(handle, method, params, runtimeCtx(handle));
    },

    async listResources(handle): Promise<McpResourceDef[]> {
      try {
        const result = (await rpcWithAuth(
          handle,
          "resources/list",
          undefined,
          runtimeCtx(handle),
        )) as { resources?: Array<Record<string, unknown>> };
        return (result.resources ?? [])
          .map((r) => normalizeResourceDef(r))
          .filter((r): r is McpResourceDef => !!r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Method not found|-32601|not support|Zod|Invalid|parse/i.test(msg)) {
          return [];
        }
        throw err;
      }
    },

    async readResource(handle, uri): Promise<McpReadResourceResult> {
      const result = await rpcWithAuth(
        handle,
        "resources/read",
        { uri },
        runtimeCtx(handle),
      );
      return normalizeReadResourceResult(result);
    },

    async listPrompts(handle): Promise<McpPromptDef[]> {
      try {
        const result = (await rpcWithAuth(
          handle,
          "prompts/list",
          undefined,
          runtimeCtx(handle),
        )) as { prompts?: Array<Record<string, unknown>> };
        return (result.prompts ?? [])
          .map((p) => normalizePromptDef(p))
          .filter((p): p is McpPromptDef => !!p);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Method not found|-32601|not support|Zod|Invalid|parse/i.test(msg)) {
          return [];
        }
        throw err;
      }
    },

    async getPrompt(handle, name, args): Promise<McpGetPromptResult> {
      const result = await rpcWithAuth(
        handle,
        "prompts/get",
        { name, ...(args ? { arguments: args } : {}) },
        runtimeCtx(handle),
      );
      return normalizeGetPromptResult(result);
    },

    async listResourceTemplates(handle): Promise<McpResourceTemplateDef[]> {
      try {
        const result = (await rpcWithAuth(
          handle,
          "resources/templates/list",
          undefined,
          runtimeCtx(handle),
        )) as { resourceTemplates?: Array<Record<string, unknown>> };
        return (result.resourceTemplates ?? [])
          .map((r) => normalizeResourceTemplateDef(r))
          .filter((r): r is McpResourceTemplateDef => !!r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Method not found|-32601|not support|Zod|Invalid|parse/i.test(msg)) return [];
        throw err;
      }
    },

    async complete(handle, params: McpCompleteParams): Promise<McpCompleteResult> {
      const result = await rpcWithAuth(
        handle,
        "completion/complete",
        {
          ref: params.ref,
          argument: params.argument,
        },
        runtimeCtx(handle),
      );
      return normalizeCompleteResult(result);
    },
  };
}

/** Apply OAuth tokens into a generic-mcp config bag */
export function applyOauthTokensToConfig(
  config: Record<string, unknown>,
  tokens: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    clientId?: string;
    clientSecret?: string;
    tokenEndpoint?: string;
  },
): Record<string, unknown> {
  return {
    ...config,
    oauthAccessToken: tokens.accessToken,
    oauthRefreshToken: tokens.refreshToken ?? config.oauthRefreshToken,
    oauthExpiresAt: tokens.expiresAt ?? config.oauthExpiresAt,
    oauthClientId: tokens.clientId ?? config.oauthClientId,
    oauthClientSecret: tokens.clientSecret ?? config.oauthClientSecret,
    oauthTokenEndpoint: tokens.tokenEndpoint ?? config.oauthTokenEndpoint,
    authRequired: false,
  };
}

export type { InstanceHandle };
