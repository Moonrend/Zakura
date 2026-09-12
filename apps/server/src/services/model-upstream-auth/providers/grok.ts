import { asRecord, str, type JsonHttp } from "../http.js";
import { jwtExpiryMs, type UpstreamOauthTokens } from "../tokens.js";

export const GROK_ISSUER = "https://auth.x.ai";
export const GROK_DISCOVERY_URL = `${GROK_ISSUER}/.well-known/openid-configuration`;
export const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const GROK_DEFAULT_MODELS = ["grok-4-1-fast-reasoning", "grok-4", "grok-3"];

export type GrokDeviceStart = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
  tokenEndpoint: string;
};

export async function startGrokDevice(http: JsonHttp): Promise<GrokDeviceStart> {
  const discovery = await http.getJson(GROK_DISCOVERY_URL);
  const rec = asRecord(discovery.json) ?? {};
  const deviceEndpoint = str(rec.device_authorization_endpoint);
  const tokenEndpoint = str(rec.token_endpoint);
  if (!deviceEndpoint || !tokenEndpoint) {
    throw new Error("xAI OIDC 未返回 device/token 端点");
  }
  const started = await http.postForm(deviceEndpoint, {
    client_id: GROK_CLIENT_ID,
    scope: GROK_SCOPE,
  });
  if (started.status < 200 || started.status >= 300) {
    throw new Error(`Grok 设备码申请失败（HTTP ${started.status}）`);
  }
  const body = asRecord(started.json) ?? {};
  const deviceCode = str(body.device_code);
  const userCode = str(body.user_code);
  const verificationUrl =
    str(body.verification_uri_complete) || str(body.verification_uri);
  if (!deviceCode || !userCode || !verificationUrl) {
    throw new Error("Grok 设备码响应缺少 user_code");
  }
  return {
    deviceCode,
    userCode,
    verificationUrl,
    interval: Math.max(1, Number(body.interval) || 5),
    expiresIn: Math.max(30, Number(body.expires_in) || 900),
    tokenEndpoint,
  };
}

export async function pollGrokDevice(
  http: JsonHttp,
  input: { deviceCode: string; tokenEndpoint: string },
): Promise<
  | { status: "pending" }
  | { status: "tokens"; tokens: UpstreamOauthTokens }
  | { status: "error"; error: string }
> {
  const polled = await http.postForm(input.tokenEndpoint, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: input.deviceCode,
    client_id: GROK_CLIENT_ID,
  });
  const rec = asRecord(polled.json) ?? {};
  const err = str(rec.error);
  if (polled.status === 400 && (err === "authorization_pending" || err === "slow_down")) {
    return { status: "pending" };
  }
  if (polled.status < 200 || polled.status >= 300) {
    return {
      status: "error",
      error: str(rec.error_description) || err || `轮询失败（HTTP ${polled.status}）`,
    };
  }
  try {
    return { status: "tokens", tokens: parseGrokTokens(polled.json) };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

export async function refreshGrokTokens(
  http: JsonHttp,
  refreshToken: string,
  tokenEndpoint = `${GROK_ISSUER}/oauth/token`,
): Promise<UpstreamOauthTokens> {
  const exchanged = await http.postForm(tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: GROK_CLIENT_ID,
  });
  if (exchanged.status < 200 || exchanged.status >= 300) {
    throw new Error(`Grok refresh 失败（HTTP ${exchanged.status}）`);
  }
  return parseGrokTokens(exchanged.json, refreshToken);
}

function parseGrokTokens(json: unknown, fallbackRefresh?: string): UpstreamOauthTokens {
  const rec = asRecord(json) ?? {};
  const access = str(rec.access_token);
  if (!access) throw new Error("Grok 换票响应缺少 access_token");
  const expiresIn = Number(rec.expires_in);
  return {
    access_token: access,
    refresh_token: str(rec.refresh_token) || fallbackRefresh,
    id_token: str(rec.id_token) || undefined,
    email: str(rec.email) || undefined,
    expires_at:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + expiresIn * 1000
        : jwtExpiryMs(access),
  };
}
