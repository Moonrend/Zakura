/**
 * Operational-log redaction.
 *
 * Credentials, emails, URLs, and raw tenant/user keys from callers are
 * dropped. Canonical `user.id` / `tenant.id` are injected after sanitize
 * from request context (0 = platform).
 */

const DROPPED_KEYS = new Set([
  "tenantid",
  "tenant_id",
  "agentid",
  "agent_id",
  "sessionid",
  "session_id",
  "userid",
  "user_id",
  "user.id",
  "tenant.id",
  "email",
  "slug",
  "agentslug",
  "agent_slug",
  "path",
  "url",
  "uri",
  "href",
  "endpoint",
  "publicurl",
  "public_url",
  "baseurl",
  "base_url",
  "databaseurl",
  "database_url",
  "redisurl",
  "redis_url",
  "datadir",
  "data_dir",
  "storageroot",
  "storage_root",
  "token",
  "password",
  "secret",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "instanceid",
  "instance_id",
  "runid",
  "run_id",
  "messageid",
  "message_id",
  "clientsecret",
  "client_secret",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "authorizationurl",
  "redirecturi",
  "redirect_uri",
  "mcpurl",
  "mcp_url",
  "hostinfo",
  "host_info",
]);

const URL_RE =
  /\b(?:https?|wss?|redis|rediss|postgres(?:ql)?|pglite|mongodb(?:\+srv)?|amqp|file):\/\/[^\s"'<>]+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_TOKEN_RE =
  /\b(?:Bearer\s+)?(?:zak_|rnr_|sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9._\-\/=+]{8,}/gi;
const SECRET_ASSIGN_RE =
  /((?:password|secret|token|api[_-]?key|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;

export function redactString(input: string): string {
  return input
    .replace(URL_RE, "[url]")
    .replace(EMAIL_RE, "[email]")
    .replace(SECRET_TOKEN_RE, "[secret]")
    .replace(SECRET_ASSIGN_RE, "$1[secret]");
}

export function errorFields(err: unknown): {
  err_name?: string;
  err_message?: string;
  err_code?: string;
} {
  if (err == null) return {};
  if (typeof err === "string") {
    return { err_message: redactString(err).slice(0, 240) };
  }
  if (err instanceof Error) {
    const code =
      "code" in err && (typeof err.code === "string" || typeof err.code === "number")
        ? String(err.code)
        : undefined;
    return {
      err_name: err.name,
      err_message: redactString(err.message).slice(0, 240),
      ...(code ? { err_code: code } : {}),
    };
  }
  return { err_message: redactString(String(err)).slice(0, 240) };
}

function isDroppedKey(key: string): boolean {
  return DROPPED_KEYS.has(key.toLowerCase().replace(/-/g, "_"));
}

export type SanitizedFields = Record<string, string | number | boolean | null>;

/**
 * Drop tenant/secret/URL keys and coerce remaining values to scalars.
 * `err` is flattened to redacted name/message/code.
 */
export function sanitizeFields(
  fields?: Record<string, unknown>,
): SanitizedFields | undefined {
  if (!fields) return undefined;
  const out: SanitizedFields = {};
  for (const [rawKey, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (isDroppedKey(rawKey)) continue;
    if (rawKey === "err" || rawKey === "error") {
      Object.assign(out, errorFields(value));
      continue;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      out[rawKey] = value;
      continue;
    }
    if (typeof value === "string") {
      out[rawKey] = redactString(value).slice(0, 240);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
