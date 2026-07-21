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
    pathHints: ["zakura://google-workspace/gmail"],
    defaultScopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ].join(" "),
  },
  {
    id: "google-drive",
    oauthAppId: "google",
    hosts: ["drivemcp.googleapis.com"],
    pathHints: ["zakura://google-workspace/drive"],
    defaultScopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ].join(" "),
  },
  {
    id: "google-calendar",
    oauthAppId: "google",
    hosts: ["calendarmcp.googleapis.com"],
    pathHints: ["zakura://google-workspace/calendar"],
    defaultScopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ].join(" "),
  },
  {
    id: "google-people",
    oauthAppId: "google",
    hosts: ["people.googleapis.com"],
    pathHints: ["zakura://google-workspace/people"],
    defaultScopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
    ].join(" "),
  },
  {
    id: "google-chat",
    oauthAppId: "google",
    hosts: ["chatmcp.googleapis.com", "chat.googleapis.com"],
    pathHints: ["zakura://google-workspace/chat"],
    defaultScopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/chat.spaces.readonly",
      "https://www.googleapis.com/auth/chat.memberships.readonly",
      "https://www.googleapis.com/auth/chat.messages.readonly",
      "https://www.googleapis.com/auth/chat.messages.create",
      "https://www.googleapis.com/auth/chat.users.readstate.readonly",
    ].join(" "),
  },
  {
    id: "slack",
    oauthAppId: "slack",
    hosts: ["mcp.slack.com"],
    pathHints: ["https://mcp.slack.com/mcp"],
    defaultScopes: [
      "search:read.public",
      "search:read.private",
      "search:read.mpim",
      "search:read.im",
      "search:read.files",
      "search:read.users",
      "files:read",
      "emoji:read",
      "chat:write",
      "channels:history",
      "groups:history",
      "mpim:history",
      "im:history",
      "channels:read",
      "groups:read",
      "mpim:read",
      "users:read",
      "users:read.email",
      "reactions:write",
      "canvases:read",
      "canvases:write",
      "channels:write",
      "groups:write",
      "im:write",
      "mpim:write",
    ].join(" "),
  },
];

type ProviderDef = {
  id: string;
  oauthAppId: McpOauthAppId;
  hosts: string[];
  pathHints?: string[];
  defaultScopes?: string;
};
function hostnameOf(mcpUrl: string): string | null {
  try {
    return new URL(mcpUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchProvider(mcpUrl: string): ProviderDef | null {
  const normalized = mcpUrl.trim().toLowerCase();
  const byHint = PROVIDERS.find((p) =>
    p.pathHints?.some((h) => normalized === h.toLowerCase() || normalized.startsWith(h.toLowerCase())),
  );
  if (byHint) return byHint;

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
