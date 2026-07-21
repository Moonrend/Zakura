import type { ProviderPlugin, InstanceHandle, ProviderContext } from "@zakura/core";
import { textResult } from "@zakura/core";
import type {
  HealthResult,
  McpToolDef,
  McpToolResult,
  ProviderConfigSchema,
  RuntimeSpec,
} from "@zakura/shared";
import { eq } from "drizzle-orm";
import { componentInstances } from "../../db/schema.js";
import { McpUpstreamOauthService } from "../../services/mcp-upstream-oauth.js";
import type { AppConfig } from "../../config.js";
import type { UpstreamOauthDiscovery } from "../../services/mcp-upstream-oauth.js";
import { applyOauthTokensToConfig } from "../generic-mcp.js";
import { GoogleApiError, formatGoogleWorkspaceApiError } from "./client.js";
import { callGmailTool, gmailToolDefs } from "./gmail.js";
import { callDriveTool, driveToolDefs } from "./drive.js";
import { callCalendarTool, calendarToolDefs } from "./calendar.js";
import { callPeopleTool, peopleToolDefs } from "./people.js";
import { callChatTool, chatToolDefs } from "./chat.js";
import {
  googleWorkspaceBuiltinUrl,
  resolveGoogleWorkspaceProduct,
  scopesForProduct,
  type GoogleWorkspaceProduct,
} from "./types.js";
import {
  filterToolsByPermissions,
  isToolAllowedByPermissions,
} from "./tool-permissions.js";

export {
  isGoogleWorkspaceTarget,
  resolveGoogleWorkspaceProduct,
  googleWorkspaceBuiltinUrl,
  scopesForProduct,
  GOOGLE_WORKSPACE_SCOPES,
  type GoogleWorkspaceProduct,
} from "./types.js";

export { translateDriveQuery } from "./drive.js";
export {
  resolveToolPermissionStates,
  GOOGLE_WORKSPACE_TOOL_PERMISSIONS,
} from "./tool-permissions.js";

const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "Google Workspace",
  required: ["product"],
  properties: {
    product: {
      type: "string",
      title: "产品",
      enum: ["gmail", "drive", "calendar", "people", "chat"],
    },
    oauthAccessToken: { type: "string", format: "password" },
    oauthRefreshToken: { type: "string", format: "password" },
    oauthExpiresAt: { type: "number" },
    oauthClientId: { type: "string" },
    oauthClientSecret: { type: "string", format: "password" },
    oauthTokenEndpoint: { type: "string" },
    authRequired: { type: "boolean" },
    toolPermissions: {
      type: "object",
      title: "工具权限",
      description: "按规则开关敏感工具，如 { \"gmail.send\": true }",
    },
  },
};

let appConfigRef: AppConfig | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbRef: any = null;

export function injectGoogleWorkspaceRuntime(config: AppConfig, db: unknown): void {
  appConfigRef = config;
  dbRef = db;
}

/** 标准 Google OAuth（不走 MCP PRM / *mcp.googleapis.com） */
export function googleWorkspaceOauthDiscovery(
  product: GoogleWorkspaceProduct,
): UpstreamOauthDiscovery {
  return {
    mcpUrl: googleWorkspaceBuiltinUrl(product),
    authorizationServers: ["https://accounts.google.com"],
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopesSupported: scopesForProduct(product).split(" "),
    codeChallengeMethodsSupported: ["S256"],
  };
}

function parseProduct(config: Record<string, unknown>): GoogleWorkspaceProduct {
  const raw =
    typeof config.product === "string"
      ? config.product
      : typeof config.mcpUrl === "string"
        ? config.mcpUrl
        : "";
  const product = resolveGoogleWorkspaceProduct(raw);
  if (!product) {
    throw new Error("config.product 须为 gmail | drive | calendar | people | chat");
  }
  return product;
}

function toolDefsFor(product: GoogleWorkspaceProduct): McpToolDef[] {
  if (product === "gmail") return gmailToolDefs;
  if (product === "drive") return driveToolDefs;
  if (product === "calendar") return calendarToolDefs;
  if (product === "people") return peopleToolDefs;
  return chatToolDefs;
}

function runtimeCtx(handle: InstanceHandle): ProviderContext {
  return {
    tenantId: handle.tenantId,
    instanceId: handle.id,
    dataDir: appConfigRef?.dataDir ?? "",
    db: dbRef,
    resolveEndpoint: (port, path = "") =>
      `http://127.0.0.1:${port}${path.startsWith("/") || !path ? path : `/${path}`}`,
    logger: {
      info: (msg, meta) => console.log(`[google-workspace] ${msg}`, meta ?? ""),
      warn: (msg, meta) => console.warn(`[google-workspace] ${msg}`, meta ?? ""),
      error: (msg, meta) => console.error(`[google-workspace] ${msg}`, meta ?? ""),
    },
  };
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
  if (!config.oauthRefreshToken || !config.oauthClientId) return config;
  if (!appConfigRef) return config;

  try {
    const oauth = new McpUpstreamOauthService(appConfigRef);
    const tokens = await oauth.refresh({
      accessToken: String(config.oauthAccessToken ?? ""),
      refreshToken: String(config.oauthRefreshToken),
      tokenEndpoint: String(
        config.oauthTokenEndpoint || "https://oauth2.googleapis.com/token",
      ),
      clientId: String(config.oauthClientId),
      clientSecret:
        typeof config.oauthClientSecret === "string" ? config.oauthClientSecret : undefined,
    });
    config = applyOauthTokensToConfig(config, {
      ...tokens,
      tokenEndpoint: tokens.tokenEndpoint || "https://oauth2.googleapis.com/token",
    });
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

async function requireAccessToken(handle: InstanceHandle): Promise<string> {
  const cfg = await maybeRefreshOauth(handle, runtimeCtx(handle));
  const token =
    typeof cfg.oauthAccessToken === "string" ? cfg.oauthAccessToken.trim() : "";
  if (!token) {
    throw new Error("AUTH_REQUIRED: 请先完成 Google OAuth 授权");
  }
  return token;
}

export function createGoogleWorkspaceProvider(): ProviderPlugin {
  return {
    id: "google-workspace",
    name: "Google Workspace",
    description:
      "本地实现 Gmail / Drive / Calendar 工具（直接调用 Google REST API，不依赖 *mcp.googleapis.com）",
    version: "1.0.0",
    category: "mcp",
    capabilities: ["tools", "builtin"],
    configSchema,

    validateConfig(config) {
      const product = parseProduct(config);
      return {
        ...config,
        product,
        mcpUrl: googleWorkspaceBuiltinUrl(product),
        oauthTokenEndpoint:
          typeof config.oauthTokenEndpoint === "string" && config.oauthTokenEndpoint
            ? config.oauthTokenEndpoint
            : "https://oauth2.googleapis.com/token",
      };
    },

    createRuntimeSpec(config): RuntimeSpec {
      const product = parseProduct(config);
      return {
        containers: [],
        endpointTemplate: googleWorkspaceBuiltinUrl(product),
      };
    },

    async healthCheck(handle): Promise<HealthResult> {
      try {
        if (handle.config.authRequired && !handle.config.oauthAccessToken) {
          return { status: "unhealthy", message: "AUTH_REQUIRED" };
        }
        const token = await requireAccessToken(handle);
        await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        }).then(async (res) => {
          if (!res.ok) throw new Error(await res.text());
        });
        return { status: "healthy", message: `ok (${parseProduct(handle.config)})` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: "unhealthy",
          message: msg.startsWith("AUTH_REQUIRED") ? msg : msg.slice(0, 240),
        };
      }
    },

    async listTools(handle): Promise<McpToolDef[]> {
      const product = parseProduct(handle.config);
      return filterToolsByPermissions(product, handle.config, toolDefsFor(product));
    },

    async callTool(handle, toolName, args): Promise<McpToolResult> {
      try {
        const product = parseProduct(handle.config);
        if (!isToolAllowedByPermissions(product, handle.config, toolName)) {
          return textResult(
            `PERMISSION_DENIED: 工具 ${toolName} 未启用。请在 MCP 实例的「工具权限」中开启对应规则。`,
            true,
          );
        }
        const token = await requireAccessToken(handle);
        let result: unknown;
        if (product === "gmail") result = await callGmailTool(token, toolName, args);
        else if (product === "drive") result = await callDriveTool(token, toolName, args);
        else if (product === "calendar") result = await callCalendarTool(token, toolName, args);
        else if (product === "people") result = await callPeopleTool(token, toolName, args);
        else result = await callChatTool(token, toolName, args);
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof GoogleApiError && (err.status === 401 || err.status === 403)) {
          return textResult(`AUTH_REQUIRED: ${formatGoogleWorkspaceApiError(err)}`, true);
        }
        return textResult(formatGoogleWorkspaceApiError(err), true);
      }
    },
  };
}
