/**
 * 连接器凭据 → 实例 config 的映射。
 *
 * OAuth 连接器把令牌写到 oauth* 字段（见 generic-mcp.applyOauthTokensToConfig）；
 * token / custom 型连接器没有授权跳转，凭据在安装时直接写入实例。
 * 两种形态在 provider 侧用同一个读取入口，provider 无需知道自己属于哪一种。
 */
import type { ConnectorAuthSpec } from "@zakura/shared";

/** 把档案凭据与连接器设置写入实例 config */
export function applyConnectorCredentialsToConfig(
  config: Record<string, unknown>,
  auth: ConnectorAuthSpec,
  values: Record<string, unknown>,
  settings: Record<string, unknown> = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config, ...settings };
  const tokenKey = auth.tokenField;
  for (const [key, value] of Object.entries(values)) {
    if (key === tokenKey) continue;
    next[key] = value;
  }
  const token = tokenKey ? String(values[tokenKey] ?? "").trim() : "";
  if (token) {
    next.apiToken = token;
    if (auth.tokenHeader) next.tokenHeader = auth.tokenHeader;
    if (auth.tokenScheme !== undefined) next.tokenScheme = auth.tokenScheme;
    next.authRequired = false;
  }
  return next;
}

/**
 * 实例当前可用的令牌。
 * OAuth 令牌优先（会被刷新流程更新），否则回退安装时写入的静态令牌。
 */
export function readInstanceToken(config: Record<string, unknown>): string {
  const oauth = String(config.oauthAccessToken ?? "").trim();
  if (oauth) return oauth;
  return String(config.apiToken ?? "").trim();
}

/** 静态令牌实例不需要 refresh_token 也算已授权 */
export function hasStaticToken(config: Record<string, unknown>): boolean {
  return String(config.apiToken ?? "").trim().length > 0;
}
