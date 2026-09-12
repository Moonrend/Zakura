import { buildCodexAuthJson } from "@zakura/shared";
import { asRecord, str, type JsonHttp } from "../http.js";
import { jwtChatgptAccountId, jwtEmail, jwtExpiryMs, type UpstreamOauthTokens } from "../tokens.js";

export const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_DEFAULT_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "codex-auto-review",
];

const DEFAULT_INTERVAL = 5;

export type CodexUserCode = {
  deviceAuthId: string;
  userCode: string;
  interval: number;
};

export async function requestCodexUserCode(http: JsonHttp): Promise<CodexUserCode> {
  const started = await http.postJson(`${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
    client_id: CODEX_OAUTH_CLIENT_ID,
  });
  if (started.status < 200 || started.status >= 300) {
    throw new Error(`Codex 设备码申请失败（HTTP ${started.status}）`);
  }
  const rec = asRecord(started.json);
  const deviceAuthId = str(rec?.device_auth_id);
  const userCode = str(rec?.user_code) || str(rec?.usercode);
  if (!deviceAuthId || !userCode) throw new Error("Codex 设备码响应缺少 user_code");
  return {
    deviceAuthId,
    userCode,
    interval: Math.max(1, Number(rec?.interval) || DEFAULT_INTERVAL),
  };
}

export async function pollCodexDeviceToken(
  http: JsonHttp,
  input: { deviceAuthId: string; userCode: string },
): Promise<
  | { status: "pending" }
  | { status: "tokens"; tokens: UpstreamOauthTokens }
  | { status: "error"; error: string }
> {
  const polled = await http.postJson(`${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
    device_auth_id: input.deviceAuthId,
    user_code: input.userCode,
  });
  if (polled.status === 403 || polled.status === 404) return { status: "pending" };
  if (polled.status < 200 || polled.status >= 300) {
    return { status: "error", error: `轮询失败（HTTP ${polled.status}）` };
  }
  try {
    const tokens = await exchangeCodexAuthCode(http, asRecord(polled.json) ?? {});
    return { status: "tokens", tokens };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("尚未完成授权")) return { status: "pending" };
    return { status: "error", error: msg };
  }
}

export async function exchangeCodexAuthCode(
  http: JsonHttp,
  codeResp: Record<string, unknown>,
): Promise<UpstreamOauthTokens> {
  const authorizationCode = str(codeResp.authorization_code);
  const codeVerifier = str(codeResp.code_verifier);
  if (!authorizationCode || !codeVerifier) {
    throw new Error("设备码尚未完成授权");
  }
  const exchanged = await http.postJson(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    grant_type: "authorization_code",
    client_id: CODEX_OAUTH_CLIENT_ID,
    code: authorizationCode,
    redirect_uri: `${CODEX_OAUTH_ISSUER}/deviceauth/callback`,
    code_verifier: codeVerifier,
  });
  if (exchanged.status < 200 || exchanged.status >= 300) {
    throw new Error(`换票失败（HTTP ${exchanged.status}）`);
  }
  return parseCodexTokenResponse(exchanged.json);
}

export async function refreshCodexTokens(
  http: JsonHttp,
  refreshToken: string,
): Promise<UpstreamOauthTokens> {
  const exchanged = await http.postJson(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    grant_type: "refresh_token",
    client_id: CODEX_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });
  if (exchanged.status < 200 || exchanged.status >= 300) {
    throw new Error(`Codex refresh 失败（HTTP ${exchanged.status}）`);
  }
  return parseCodexTokenResponse(exchanged.json, refreshToken);
}

function parseCodexTokenResponse(json: unknown, fallbackRefresh?: string): UpstreamOauthTokens {
  const rec = asRecord(json) ?? {};
  const access = str(rec.access_token);
  const refresh = str(rec.refresh_token) || fallbackRefresh;
  const idToken = str(rec.id_token);
  if (!access) throw new Error("换票响应缺少 token");
  const expiresIn = Number(rec.expires_in);
  return {
    access_token: access,
    refresh_token: refresh || undefined,
    id_token: idToken || undefined,
    account_id:
      str(rec.account_id) || (idToken ? jwtChatgptAccountId(idToken) : undefined),
    email: jwtEmail(idToken || access),
    expires_at:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + expiresIn * 1000
        : jwtExpiryMs(access),
  };
}

export function codexAuthJson(tokens: UpstreamOauthTokens): string {
  return buildCodexAuthJson({
    id_token: tokens.id_token ?? "",
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? "",
    account_id: tokens.account_id,
  });
}

export const CODEX_VERIFICATION_URL = `${CODEX_OAUTH_ISSUER}/codex/device`;
