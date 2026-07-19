import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  resolveBestAppCredentials,
  type McpOauthAppId,
} from "./mcp-oauth-apps.js";

export type PreRegisteredOauthClient = {
  /** 产品级 id：github / google-gmail / … */
  providerId: string;
  /** 凭证所属 OAuth App：github | google */
  oauthAppId: McpOauthAppId;
  clientId: string;
  clientSecret?: string;
  /** 覆盖 PRM scopes；空则用上游 discovery 或产品默认 */
  scopes?: string;
  source: "byo" | "tenant" | "platform" | "env";
};

type ProviderDef = {
  id: string;
  oauthAppId: McpOauthAppId;
  hosts: string[];
  /** 产品默认 scopes（Google Workspace MCP） */
  defaultScopes?: string;
};

const PROVIDERS: ProviderDef[] = [
  {
    id: "github",
    oauthAppId: "github",
    hosts: ["api.githubcopilot.com"],
  },
  {
    id: "google-gmail",
    oauthAppId: "google",
    hosts: ["gmailmcp.googleapis.com"],
    defaultScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ].join(" "),
  },
  {
    id: "google-drive",
    oauthAppId: "google",
    hosts: ["drivemcp.googleapis.com"],
    defaultScopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ].join(" "),
  },
  {
    id: "google-calendar",
    oauthAppId: "google",
    hosts: ["calendarmcp.googleapis.com"],
    defaultScopes: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ].join(" "),
  },
];

function hostnameOf(mcpUrl: string): string | null {
  try {
    return new URL(mcpUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchProvider(mcpUrl: string): ProviderDef | null {
  const host = hostnameOf(mcpUrl);
  if (!host) return null;
  return (
    PROVIDERS.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ??
    null
  );
}

/** 按 MCP URL 解析预注册 OAuth 凭证（租户 → 平台 → env） */
export async function resolvePreRegisteredOauthClient(
  mcpUrl: string,
  config: AppConfig,
  db: Db,
  tenantId: string,
): Promise<PreRegisteredOauthClient | null> {
  const provider = matchProvider(mcpUrl);
  if (!provider) return null;

  const creds = await resolveBestAppCredentials(db, config, provider.oauthAppId, tenantId);
  if (!creds) return null;

  return {
    providerId: provider.id,
    oauthAppId: provider.oauthAppId,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    scopes: creds.scopes || provider.defaultScopes,
    source: creds.source,
  };
}

/** 安装时用户直接提交的 OAuth Client（Google/GitHub 官方要求的形态） */
export function buildByoOauthClient(
  mcpUrl: string,
  byo: { clientId: string; clientSecret?: string; scopes?: string },
): PreRegisteredOauthClient | null {
  const provider = matchProvider(mcpUrl);
  const clientId = byo.clientId.trim();
  if (!clientId) return null;
  return {
    providerId: provider?.id ?? "byo",
    oauthAppId: provider?.oauthAppId ?? "google",
    clientId,
    clientSecret: byo.clientSecret?.trim() || undefined,
    scopes: byo.scopes?.trim() || provider?.defaultScopes,
    source: "byo",
  };
}

export function oauthAppIdForMcpUrl(mcpUrl: string): McpOauthAppId | null {
  return matchProvider(mcpUrl)?.oauthAppId ?? null;
}

export function defaultScopesForMcpUrl(mcpUrl: string): string | undefined {
  return matchProvider(mcpUrl)?.defaultScopes;
}
