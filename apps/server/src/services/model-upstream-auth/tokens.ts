import { decryptJson, encryptJson } from "@zakura/core";
import type { ModelUpstreamOauthSnapshot } from "@zakura/shared";

export type UpstreamOauthTokens = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  expires_at?: number;
  email?: string;
  api_key?: string;
  project_id?: string;
};

export function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: unknown;
      email?: unknown;
    };
    if (typeof payload.exp === "number" && payload.exp > 0) return payload.exp * 1000;
  } catch {
    return undefined;
  }
  return undefined;
}

export function jwtEmail(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      email?: unknown;
    };
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/** ChatGPT id_token 里的 chatgpt_account_id，Codex 请求头需要 */
export function jwtChatgptAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      chatgpt_account_id?: unknown;
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const nested = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    if (typeof payload.chatgpt_account_id === "string" && payload.chatgpt_account_id.trim()) {
      return payload.chatgpt_account_id.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function encryptTokens(secret: string, tokens: UpstreamOauthTokens): string {
  return encryptJson(secret, tokens);
}

export function decryptTokens(secret: string, enc: string): UpstreamOauthTokens {
  const raw = decryptJson<UpstreamOauthTokens>(secret, enc);
  if (!raw || typeof raw !== "object") throw new Error("订阅凭证损坏");
  const access = raw.access_token || raw.api_key;
  if (!access) throw new Error("订阅凭证缺少 access_token");
  return raw;
}

export function snapshotFromTokens(
  tokens: UpstreamOauthTokens,
  loginKind: string,
): ModelUpstreamOauthSnapshot {
  return {
    loggedIn: true,
    email: tokens.email || jwtEmail(tokens.id_token || tokens.access_token),
    expiresAt: tokens.expires_at ?? jwtExpiryMs(tokens.access_token),
    accountId: tokens.account_id,
    loginKind,
  };
}

export function bearerFromTokens(tokens: UpstreamOauthTokens): string {
  return tokens.api_key || tokens.access_token;
}

let oauthSecret: string | undefined;

export function bindOauthSecret(secret: string): void {
  oauthSecret = secret;
}

export function tryBearerFromConfig(cfg: { apiKey?: string; oauthEnc?: string }): string | undefined {
  if (cfg.apiKey) return cfg.apiKey;
  if (!cfg.oauthEnc || !oauthSecret) return undefined;
  try {
    return bearerFromTokens(decryptTokens(oauthSecret, cfg.oauthEnc));
  } catch {
    return undefined;
  }
}

export function needsRefresh(tokens: UpstreamOauthTokens, leadMs = 60_000): boolean {
  if (!tokens.refresh_token) return false;
  const exp = tokens.expires_at ?? jwtExpiryMs(tokens.access_token);
  if (!exp) return false;
  return Date.now() + leadMs >= exp;
}
