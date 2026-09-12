import { asRecord, str, type JsonHttp } from "../http.js";
import type { UpstreamOauthTokens } from "../tokens.js";

export const GEMINI_CLI_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
export const GEMINI_CLI_CLIENT_SECRET = "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";
export const GEMINI_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GEMINI_DEFAULT_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

export function parseGeminiCliCreds(raw: string): UpstreamOauthTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("oauth_creds 不是合法 JSON");
  }
  const rec = asRecord(parsed) ?? {};
  const nested = asRecord(rec.tokens) ?? asRecord(rec.credentials) ?? rec;
  const access = str(nested.access_token) || str(nested.accessToken);
  const refresh = str(nested.refresh_token) || str(nested.refreshToken);
  if (!access && !refresh) throw new Error("JSON 里需要 access_token 或 refresh_token");
  const expiryRaw =
    nested.expiry_date ?? nested.expiryDate ?? nested.expires_at ?? nested.expiry;
  let expires_at: number | undefined;
  if (typeof expiryRaw === "number" && expiryRaw > 0) {
    expires_at = expiryRaw > 10_000_000_000 ? expiryRaw : expiryRaw * 1000;
  } else if (typeof expiryRaw === "string" && expiryRaw) {
    const t = Date.parse(expiryRaw);
    if (Number.isFinite(t)) expires_at = t;
  }
  return {
    access_token: access || "pending",
    refresh_token: refresh || undefined,
    expires_at,
    email: str(nested.email) || undefined,
    project_id:
      str(nested.project_id) ||
      str(nested.projectId) ||
      str(rec.project_id) ||
      str(rec.projectId) ||
      undefined,
  };
}

export async function refreshGeminiCliTokens(
  http: JsonHttp,
  refreshToken: string,
): Promise<UpstreamOauthTokens> {
  const exchanged = await http.postForm(GEMINI_TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: GEMINI_CLI_CLIENT_ID,
    client_secret: GEMINI_CLI_CLIENT_SECRET,
  });
  if (exchanged.status < 200 || exchanged.status >= 300) {
    throw new Error(`Gemini CLI refresh 失败（HTTP ${exchanged.status}）`);
  }
  const rec = asRecord(exchanged.json) ?? {};
  const access = str(rec.access_token);
  if (!access) throw new Error("Gemini CLI refresh 缺少 access_token");
  const expiresIn = Number(rec.expires_in);
  return {
    access_token: access,
    refresh_token: str(rec.refresh_token) || refreshToken,
    expires_at:
      Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
  };
}
