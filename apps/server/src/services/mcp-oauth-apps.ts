import { and, eq } from "drizzle-orm";
import { encryptJson, decryptJson } from "@zakura/core";
import type { Db } from "../db/client.js";
import { newId, settings } from "../db/schema.js";
import type { AppConfig } from "../config.js";

export const MCP_OAUTH_APPS_KEY = "mcp.oauth.apps";

export type McpOauthAppId = "github" | "google";
export type McpOauthAppScope = "platform" | "tenant";

export type McpOauthAppStored = {
  enabled: boolean;
  clientId: string;
  /** 加密后的 secret；空字符串表示未设置 */
  clientSecretEnc: string;
  /** 可选默认 scopes（空则用各 MCP 产品默认） */
  scopes: string;
};

export type McpOauthAppsMap = Partial<Record<McpOauthAppId, McpOauthAppStored>>;

export type McpOauthAppPublic = {
  id: McpOauthAppId;
  name: string;
  description: string;
  docsUrl: string;
  scope: McpOauthAppScope;
  enabled: boolean;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
  redirectUri: string;
  /** 凭证来自环境变量（仅 platform，未写库时的 fallback） */
  fromEnv: boolean;
  ready: boolean;
  /**
   * Google Workspace MCP 不接受 API Key，必须使用 OAuth 2.0 Client ID/Secret。
   * UI 应提示用户勿填写 Cloud Console 的「API 密钥」。
   */
  credentialKind: "oauth_client";
};

export const MCP_OAUTH_APP_META: Record<
  McpOauthAppId,
  { name: string; description: string; docsUrl: string }
> = {
  github: {
    name: "GitHub",
    description:
      "用于 GitHub Remote MCP。填写 OAuth App / GitHub App 的 Client ID 与 Secret（不是 Personal Access Token；PAT 仅可在安装时作降级）。",
    docsUrl: "https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md",
  },
  google: {
    name: "Google",
    description:
      "用于 Gmail / Drive / Calendar 等 Google Workspace MCP。须在 Google Cloud 创建「OAuth 客户端」（Web 应用），不是 API 密钥（API Key 无法访问用户邮箱/云盘数据）。",
    docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
  },
};

const APP_IDS: McpOauthAppId[] = ["github", "google"];

function emptyStored(): McpOauthAppStored {
  return { enabled: false, clientId: "", clientSecretEnc: "", scopes: "" };
}

export function mcpOauthRedirectUri(config: AppConfig): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/api/mcp/upstream-oauth/callback`;
}

function ownerKeyFor(scope: McpOauthAppScope, tenantId?: string): string {
  if (scope === "platform") return "platform";
  if (!tenantId) throw new Error("tenant scope requires tenantId");
  return tenantId;
}

export async function loadMcpOauthAppsMap(
  db: Db,
  scope: McpOauthAppScope,
  tenantId?: string,
): Promise<McpOauthAppsMap> {
  const ownerKey = ownerKeyFor(scope, tenantId);
  const row = await db.query.settings.findFirst({
    where: and(eq(settings.ownerKey, ownerKey), eq(settings.key, MCP_OAUTH_APPS_KEY)),
  });
  if (!row?.value) return {};
  try {
    return JSON.parse(row.value) as McpOauthAppsMap;
  } catch {
    return {};
  }
}

export async function saveMcpOauthAppsMap(
  db: Db,
  map: McpOauthAppsMap,
  scope: McpOauthAppScope,
  tenantId?: string,
): Promise<void> {
  const ownerKey = ownerKeyFor(scope, tenantId);
  await db
    .insert(settings)
    .values({
      id: newId(),
      ownerKey,
      key: MCP_OAUTH_APPS_KEY,
      value: JSON.stringify(map),
    })
    .onConflictDoUpdate({
      target: [settings.ownerKey, settings.key],
      set: { value: JSON.stringify(map) },
    });
}

/** 从某一 scope 的 map 解析凭证；platform 可回退 env */
export function resolveAppCredentials(
  appId: McpOauthAppId,
  map: McpOauthAppsMap,
  config: AppConfig,
  secret: string,
  opts?: { allowEnvFallback?: boolean },
): {
  clientId: string;
  clientSecret?: string;
  scopes?: string;
  enabled: boolean;
  fromEnv: boolean;
} | null {
  const stored = map[appId];
  if (stored?.enabled && stored.clientId.trim()) {
    let clientSecret: string | undefined;
    if (stored.clientSecretEnc) {
      try {
        const dec = decryptJson<{ secret?: string }>(secret, stored.clientSecretEnc);
        clientSecret = dec.secret?.trim() || undefined;
      } catch {
        clientSecret = undefined;
      }
    }
    return {
      clientId: stored.clientId.trim(),
      clientSecret,
      scopes: stored.scopes?.trim() || undefined,
      enabled: true,
      fromEnv: false,
    };
  }

  if (!opts?.allowEnvFallback) return null;

  if (appId === "github") {
    const clientId = config.mcpOauthClients.githubClientId?.trim();
    if (!clientId) return null;
    return {
      clientId,
      clientSecret: config.mcpOauthClients.githubClientSecret?.trim() || undefined,
      scopes: config.mcpOauthClients.githubScopes?.trim() || undefined,
      enabled: true,
      fromEnv: true,
    };
  }
  if (appId === "google") {
    const clientId = process.env.ZAKURA_GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "";
    if (!clientId) return null;
    return {
      clientId,
      clientSecret: process.env.ZAKURA_GOOGLE_OAUTH_CLIENT_SECRET?.trim() || undefined,
      scopes: process.env.ZAKURA_GOOGLE_OAUTH_SCOPES?.trim() || undefined,
      enabled: true,
      fromEnv: true,
    };
  }
  return null;
}

/**
 * 凭证优先级：租户自建 → 整站平台 → 环境变量。
 * 安装时传入的 BYO 由上层优先处理，不在此函数内。
 */
export async function resolveBestAppCredentials(
  db: Db,
  config: AppConfig,
  appId: McpOauthAppId,
  tenantId: string,
): Promise<{
  clientId: string;
  clientSecret?: string;
  scopes?: string;
  source: "tenant" | "platform" | "env";
} | null> {
  const tenantMap = await loadMcpOauthAppsMap(db, "tenant", tenantId);
  const tenantCreds = resolveAppCredentials(appId, tenantMap, config, config.secret);
  if (tenantCreds) {
    return {
      clientId: tenantCreds.clientId,
      clientSecret: tenantCreds.clientSecret,
      scopes: tenantCreds.scopes,
      source: "tenant",
    };
  }

  const platformMap = await loadMcpOauthAppsMap(db, "platform");
  const platformCreds = resolveAppCredentials(appId, platformMap, config, config.secret, {
    allowEnvFallback: true,
  });
  if (platformCreds) {
    return {
      clientId: platformCreds.clientId,
      clientSecret: platformCreds.clientSecret,
      scopes: platformCreds.scopes,
      source: platformCreds.fromEnv ? "env" : "platform",
    };
  }
  return null;
}

export async function listMcpOauthAppsPublic(
  db: Db,
  config: AppConfig,
  scope: McpOauthAppScope,
  tenantId?: string,
): Promise<McpOauthAppPublic[]> {
  const map = await loadMcpOauthAppsMap(db, scope, tenantId);
  const redirectUri = mcpOauthRedirectUri(config);
  return APP_IDS.map((id) => {
    const meta = MCP_OAUTH_APP_META[id];
    const resolved = resolveAppCredentials(id, map, config, config.secret, {
      allowEnvFallback: scope === "platform",
    });
    const stored = map[id] ?? emptyStored();
    const fromEnv = !!resolved?.fromEnv && !stored.clientId;
    const clientId = fromEnv
      ? resolved!.clientId
      : stored.clientId || resolved?.clientId || "";
    const hasClientSecret = fromEnv
      ? !!resolved?.clientSecret
      : !!stored.clientSecretEnc || !!resolved?.clientSecret;
    const enabled = fromEnv ? true : stored.enabled;
    const scopes = fromEnv ? resolved?.scopes ?? "" : stored.scopes || resolved?.scopes || "";
    return {
      id,
      name: meta.name,
      description: meta.description,
      docsUrl: meta.docsUrl,
      scope,
      enabled,
      clientId: fromEnv && !stored.clientId ? clientId : stored.clientId || clientId,
      hasClientSecret,
      scopes: stored.scopes || scopes,
      redirectUri,
      fromEnv,
      ready: !!(enabled && (stored.clientId || resolved?.clientId)),
      credentialKind: "oauth_client" as const,
    };
  });
}

export type McpOauthAppPatch = {
  enabled?: boolean;
  clientId?: string;
  /** 传空字符串可清除；undefined 表示不改 */
  clientSecret?: string;
  scopes?: string;
};

export async function patchMcpOauthApp(
  db: Db,
  config: AppConfig,
  appId: McpOauthAppId,
  patch: McpOauthAppPatch,
  scope: McpOauthAppScope,
  tenantId?: string,
): Promise<McpOauthAppPublic> {
  if (!APP_IDS.includes(appId)) {
    throw new Error(`未知 OAuth App: ${appId}`);
  }
  const map = await loadMcpOauthAppsMap(db, scope, tenantId);
  const prev = map[appId] ?? emptyStored();
  let clientSecretEnc = prev.clientSecretEnc;
  if (patch.clientSecret !== undefined) {
    if (!patch.clientSecret.trim()) {
      clientSecretEnc = "";
    } else {
      clientSecretEnc = encryptJson(config.secret, { secret: patch.clientSecret.trim() });
    }
  }
  map[appId] = {
    enabled: patch.enabled ?? prev.enabled,
    clientId: patch.clientId !== undefined ? patch.clientId.trim() : prev.clientId,
    clientSecretEnc,
    scopes: patch.scopes !== undefined ? patch.scopes.trim() : prev.scopes,
  };
  await saveMcpOauthAppsMap(db, map, scope, tenantId);
  const list = await listMcpOauthAppsPublic(db, config, scope, tenantId);
  return list.find((a) => a.id === appId)!;
}
