export type PreRegisteredOauthClient = {
  providerId: string;
  connectorRef: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string;
  source: "byo";
};

/** 安装时临时提供的 OAuth Client，无需猜测它属于哪个固定平台。 */
export function buildByoOauthClient(
  mcpUrl: string,
  byo: { clientId: string; clientSecret?: string; scopes?: string },
): PreRegisteredOauthClient | null {
  const clientId = byo.clientId.trim();
  if (!clientId) return null;
  let providerId = "custom";
  try { providerId = new URL(mcpUrl).hostname || providerId; } catch { /* custom scheme */ }
  return {
    providerId,
    connectorRef: providerId,
    clientId,
    clientSecret: byo.clientSecret?.trim() || undefined,
    scopes: byo.scopes?.trim() || undefined,
    source: "byo",
  };
}
