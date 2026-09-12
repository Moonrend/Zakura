import { createHash, randomBytes } from "node:crypto";
import { asRecord, str, type JsonHttp } from "../http.js";
import { jwtExpiryMs, type UpstreamOauthTokens } from "../tokens.js";

export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_AUTH_URL = "https://claude.ai/oauth/authorize";
export const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const CLAUDE_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const CLAUDE_SCOPES = "org:create_api_key user:profile user:inference";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

export const CLAUDE_DEFAULT_MODELS = [
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "claude-haiku-4-5",
  "claude-sonnet-4-20250514",
];

export type ClaudePkce = {
  verifier: string;
  challenge: string;
};

export function createClaudePkce(): ClaudePkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function claudeAuthorizeUrl(pkce: ClaudePkce): string {
  const url = new URL(CLAUDE_AUTH_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_REDIRECT_URI);
  url.searchParams.set("scope", CLAUDE_SCOPES);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return url.toString();
}

/** 用户可能粘贴完整 callback URL、code#state 或纯 code */
export function parseClaudeCallback(raw: string): { code: string; state?: string } {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("请粘贴授权码");
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || undefined;
    if (code) return { code, state };
  } catch {
    // not a URL
  }
  const hash = trimmed.split("#");
  if (hash.length >= 2 && hash[0] && hash[1]) {
    return { code: hash[0].trim(), state: hash[1].trim() };
  }
  return { code: trimmed };
}

export async function exchangeClaudeCode(
  http: JsonHttp,
  input: { code: string; verifier: string; state?: string },
): Promise<UpstreamOauthTokens> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: CLAUDE_REDIRECT_URI,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    code_verifier: input.verifier,
  };
  if (input.state) body.state = input.state;
  const exchanged = await http.postJson(CLAUDE_TOKEN_URL, body);
  if (exchanged.status < 200 || exchanged.status >= 300) {
    throw new Error(`Claude 换票失败（HTTP ${exchanged.status}）`);
  }
  return parseClaudeTokens(exchanged.json);
}

export async function refreshClaudeTokens(
  http: JsonHttp,
  refreshToken: string,
): Promise<UpstreamOauthTokens> {
  const exchanged = await http.postJson(CLAUDE_TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
  });
  if (exchanged.status < 200 || exchanged.status >= 300) {
    throw new Error(`Claude refresh 失败（HTTP ${exchanged.status}）`);
  }
  return parseClaudeTokens(exchanged.json, refreshToken);
}

export function setupTokenAsOauth(setupToken: string): UpstreamOauthTokens {
  const token = setupToken.trim();
  if (!token) throw new Error("setup-token 不能为空");
  return { access_token: token };
}

function parseClaudeTokens(json: unknown, fallbackRefresh?: string): UpstreamOauthTokens {
  const rec = asRecord(json) ?? {};
  const access = str(rec.access_token);
  if (!access) throw new Error("Claude 换票响应缺少 access_token");
  const expiresIn = Number(rec.expires_in);
  return {
    access_token: access,
    refresh_token: str(rec.refresh_token) || fallbackRefresh,
    expires_at:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + expiresIn * 1000
        : jwtExpiryMs(access),
  };
}

export function isClaudeCodeRestrictedError(message: string): boolean {
  return /only authorized for use with Claude Code|cannot be used for other API/i.test(
    message,
  );
}
