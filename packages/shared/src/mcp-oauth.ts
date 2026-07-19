/**
 * Upstream MCP OAuth 接入契约。
 * Tier A：支持 DCR/CIMD，一键授权
 * Tier B：无 DCR，需预注册 App（如 GitHub）或 PAT
 * Tier C：必须自备 App 凭证（如 Google），可选 oauth-bridge
 */

/** 如何获取上游 OAuth client_id */
export type McpOauthClientStrategy =
  | "dcr"
  | "pre_registered"
  | "byo"
  | "bridge";

export type McpOauthAuthTier = "A" | "B" | "C";

export type McpOauthContract = {
  tier: McpOauthAuthTier;
  /** 按优先级尝试的 client 获取策略 */
  strategies: McpOauthClientStrategy[];
  /** 允许 PAT / API Key 降级 */
  allowPatFallback?: boolean;
  /** 服务端预注册凭证匹配 id（如 github） */
  providerId?: string;
  /** oauth-bridge 上游提供商标识（如 google） */
  bridgeProvider?: string;
};

export const MCP_OAUTH_TIER_META: Record<
  McpOauthAuthTier,
  { label: string; short: string }
> = {
  A: { label: "一键 OAuth", short: "OAuth" },
  B: { label: "预注册 App", short: "App OAuth" },
  C: { label: "自备凭证", short: "BYO" },
};
