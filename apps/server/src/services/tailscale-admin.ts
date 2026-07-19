/**
 * Tailscale Admin API via OAuth client credentials.
 *
 * Tailscale does NOT use browser authorization-code OAuth for third-party apps.
 * Admins create an OAuth client in the Tailscale console (client id + secret),
 * then Zakura exchanges them for short-lived API access tokens.
 *
 * Auth keys created via OAuth MUST use tags that:
 * 1. Exist in the tailnet ACL `tagOwners`, and
 * 2. Were selected on the OAuth client (or owned by those tags).
 *
 * Docs: https://tailscale.com/docs/features/oauth-clients
 */

export type TailscaleOAuthCredentials = {
  clientId: string;
  clientSecret: string;
  /** Tags allowed / required for auth keys created via this client */
  tags?: string[];
  /** Cached access token */
  accessToken?: string;
  /** unix ms */
  accessTokenExpiresAt?: number;
  /** Cached token was issued without requesting tags (safe for ACL bootstrap) */
  accessTokenOmitTags?: boolean;
};

export type TailscaleDevice = {
  id: string;
  name: string;
  hostname: string;
  addresses: string[];
  tags: string[];
  online: boolean;
  user?: string;
  os?: string;
  lastSeen?: string;
};

export type TailscaleAuthKeyResult = {
  key: string;
  id: string;
  description?: string;
  expires?: string;
  reusable: boolean;
  ephemeral: boolean;
  preauthorized: boolean;
  tags: string[];
};

const TOKEN_URL = "https://api.tailscale.com/api/v2/oauth/token";
const API_BASE = "https://api.tailscale.com/api/v2";

function basicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
}

/** Normalize to `tag:foo` form; drop empties. */
export function normalizeTailscaleTags(raw: string[] | undefined | null): string[] {
  if (!raw?.length) return [];
  const out: string[] = [];
  for (const t of raw) {
    const s = t.trim();
    if (!s) continue;
    const tag = s.startsWith("tag:") ? s : `tag:${s}`;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

export function formatTailscaleTagError(message: string, tags: string[]): string {
  if (!/invalid or not permitted/i.test(message) && !/requested tags/i.test(message)) {
    return message;
  }
  const list = tags.length ? tags.join(", ") : "(未指定)";
  return [
    message,
    "",
    `当前请求的 tags：${list}`,
    "",
    "Zakura 会在签发 Key 前自动把缺失 tag 写入 ACL tagOwners（需 OAuth 含 Policy file 写权限）。",
    "若仍失败，请到 Tailscale → Trust credentials 编辑该 OAuth Client，勾选与上方完全相同的 tag（API 无法代勾）。",
    "auth_keys + devices 必选；勾选 tag 后重新「连接」或再点生成 Auth Key。",
  ].join("\n");
}

export type TailscaleAclEnsureResult = {
  added: string[];
  alreadyPresent: string[];
  owners: string[];
};

const DEFAULT_TAG_OWNERS = ["autogroup:admin"] as const;

export class TailscaleAdminClient {
  constructor(private creds: TailscaleOAuthCredentials) {
    this.creds.tags = normalizeTailscaleTags(creds.tags);
  }

  get credentials(): TailscaleOAuthCredentials {
    return this.creds;
  }

  setTags(tags: string[]) {
    this.creds.tags = normalizeTailscaleTags(tags);
    // Force token refresh so new tags are requested on the token endpoint
    this.creds.accessToken = undefined;
    this.creds.accessTokenExpiresAt = undefined;
    this.creds.accessTokenOmitTags = undefined;
  }

  /** Exchange client credentials for an access token (refreshes if near expiry). */
  async ensureAccessToken(opts?: { omitTags?: boolean }): Promise<string> {
    const wantOmit = Boolean(opts?.omitTags);
    const skew = 60_000;
    if (
      this.creds.accessToken &&
      this.creds.accessTokenExpiresAt &&
      this.creds.accessTokenExpiresAt > Date.now() + skew &&
      // Untagged token is fine for omitTags callers; tagged ops need a tagged token
      (wantOmit || !this.creds.accessTokenOmitTags)
    ) {
      return this.creds.accessToken;
    }

    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    // Request tags on the access token so auth_keys create inherits them.
    // Skip when writing ACL for tags that may not exist yet (token would 400).
    if (!wantOmit && this.creds.tags?.length) {
      body.set("tags", this.creds.tags.join(" "));
    }

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth(this.creds.clientId, this.creds.clientSecret)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        formatTailscaleTagError(
          `Tailscale OAuth token failed (${res.status}): ${text.slice(0, 300)}`,
          this.creds.tags ?? [],
        ),
      );
    }

    let json: { access_token?: string; expires_in?: number; token_type?: string };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new Error("Tailscale OAuth token response was not JSON");
    }
    if (!json.access_token) throw new Error("Tailscale OAuth response missing access_token");

    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.creds.accessToken = json.access_token;
    this.creds.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
    this.creds.accessTokenOmitTags = wantOmit;
    return json.access_token;
  }

  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { omitTags?: boolean },
  ): Promise<T> {
    const token = await this.ensureAccessToken({ omitTags: opts?.omitTags });
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const tagsHint =
        body &&
        typeof body === "object" &&
        body !== null &&
        "capabilities" in body
          ? (
              body as {
                capabilities?: { devices?: { create?: { tags?: string[] } } };
              }
            ).capabilities?.devices?.create?.tags ?? this.creds.tags ?? []
          : this.creds.tags ?? [];
      throw new Error(
        formatTailscaleTagError(
          `Tailscale API ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`,
          tagsHint,
        ),
      );
    }
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  /** Verify credentials work and return a human-readable tailnet label. */
  async probe(opts?: { omitTags?: boolean }): Promise<{ displayName: string; deviceCount: number }> {
    const devices = await this.listDevices(opts);
    const sample = devices.find((d) => d.user) ?? devices[0];
    const displayName =
      sample?.user ||
      (devices[0]?.name?.includes(".") ? devices[0].name.split(".").slice(1).join(".") : null) ||
      `tailnet (${this.creds.clientId.slice(0, 12)}…)`;
    return { displayName, deviceCount: devices.length };
  }

  async listDevices(opts?: { omitTags?: boolean }): Promise<TailscaleDevice[]> {
    type Raw = {
      devices?: Array<{
        id?: string;
        nodeId?: string;
        name?: string;
        hostname?: string;
        addresses?: string[];
        tags?: string[];
        authorized?: boolean;
        connectedToControl?: boolean;
        lastSeen?: string;
        os?: string;
        user?: string;
        clientConnectivity?: { connected?: boolean };
      }>;
    };
    const data = await this.api<Raw>("GET", "/tailnet/-/devices", undefined, opts);
    return (data.devices ?? []).map((d) => {
      const online =
        Boolean(d.connectedToControl) ||
        Boolean(d.clientConnectivity?.connected) ||
        false;
      return {
        id: String(d.id ?? d.nodeId ?? d.name ?? ""),
        name: d.name ?? d.hostname ?? "",
        hostname: d.hostname ?? d.name ?? "",
        addresses: d.addresses ?? [],
        tags: d.tags ?? [],
        online,
        user: d.user,
        os: d.os,
        lastSeen: d.lastSeen,
      };
    });
  }

  /**
   * Create a reusable, preauthorized auth key for Runner join.
   * Tags are required for OAuth-owned keys and must match the OAuth client.
   */
  async createAuthKey(opts?: {
    tags?: string[];
    reusable?: boolean;
    ephemeral?: boolean;
    preauthorized?: boolean;
    expirySeconds?: number;
    description?: string;
  }): Promise<TailscaleAuthKeyResult> {
    const tags = normalizeTailscaleTags(opts?.tags?.length ? opts.tags : this.creds.tags);
    if (!tags.length) {
      throw new Error(
        [
          "生成 Auth Key 需要 tags。",
          "请填写与 OAuth Client 完全一致的 tag（且已在 ACL tagOwners 中定义）。",
          "不要使用尚未在 tailnet 声明的 tag:zakura-runner。",
        ].join(" "),
      );
    }

    const payload = {
      capabilities: {
        devices: {
          create: {
            reusable: opts?.reusable ?? true,
            ephemeral: opts?.ephemeral ?? false,
            preauthorized: opts?.preauthorized ?? true,
            tags,
          },
        },
      },
      expirySeconds: opts?.expirySeconds ?? 86_400,
      description: opts?.description ?? "Zakura runner",
    };

    type Raw = {
      key?: string;
      id?: string;
      description?: string;
      expires?: string;
      capabilities?: {
        devices?: {
          create?: {
            reusable?: boolean;
            ephemeral?: boolean;
            preauthorized?: boolean;
            tags?: string[];
          };
        };
      };
    };

    const data = await this.api<Raw>("POST", "/tailnet/-/keys", payload);
    if (!data.key) throw new Error("Tailscale create auth key returned no key");
    const create = data.capabilities?.devices?.create;
    return {
      key: data.key,
      id: data.id ?? "",
      description: data.description,
      expires: data.expires,
      reusable: create?.reusable ?? true,
      ephemeral: create?.ephemeral ?? false,
      preauthorized: create?.preauthorized ?? true,
      tags: create?.tags ?? tags,
    };
  }

  /**
   * Ensure tags exist in ACL `tagOwners` (create missing entries).
   * Requires OAuth scope that can write the policy file (`acl` / Policy file Write).
   * Does NOT attach tags to the OAuth client itself — that remains a console step.
   */
  async ensureTagsInAcl(
    tagsInput: string[],
    opts?: { owners?: string[] },
  ): Promise<TailscaleAclEnsureResult> {
    const tags = normalizeTailscaleTags(tagsInput);
    if (!tags.length) throw new Error("Tags 不能为空");
    const owners = (opts?.owners?.length ? opts.owners : [...DEFAULT_TAG_OWNERS]).map((o) =>
      o.trim(),
    );

    const { policy, etag } = await this.getAclPolicy();
    const tagOwnersKey =
      "tagOwners" in policy || !("TagOwners" in policy) ? "tagOwners" : "TagOwners";
    const rawOwners = policy[tagOwnersKey];
    const tagOwners: Record<string, string[]> =
      rawOwners && typeof rawOwners === "object" && !Array.isArray(rawOwners)
        ? { ...(rawOwners as Record<string, string[]>) }
        : {};

    const added: string[] = [];
    const alreadyPresent: string[] = [];
    for (const tag of tags) {
      if (tag in tagOwners) {
        alreadyPresent.push(tag);
        continue;
      }
      tagOwners[tag] = [...owners];
      added.push(tag);
    }

    if (!added.length) {
      return { added, alreadyPresent, owners };
    }

    const next = { ...policy, [tagOwnersKey]: tagOwners };
    await this.putAclPolicy(next, etag);
    return { added, alreadyPresent, owners };
  }

  private async getAclPolicy(): Promise<{
    policy: Record<string, unknown>;
    etag: string | null;
  }> {
    const token = await this.ensureAccessToken({ omitTags: true });
    const res = await fetch(`${API_BASE}/tailnet/-/acl`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        this.formatAclScopeError(
          `Tailscale API GET /tailnet/-/acl failed (${res.status}): ${text.slice(0, 400)}`,
        ),
      );
    }
    let policy: Record<string, unknown>;
    try {
      policy = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("Tailscale ACL response was not JSON（请勿使用 HuJSON Accept）");
    }
    return { policy, etag: res.headers.get("etag") };
  }

  private async putAclPolicy(
    policy: Record<string, unknown>,
    etag: string | null,
  ): Promise<void> {
    const token = await this.ensureAccessToken({ omitTags: true });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (etag) headers["If-Match"] = etag;

    const res = await fetch(`${API_BASE}/tailnet/-/acl`, {
      method: "POST",
      headers,
      body: JSON.stringify(policy),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        this.formatAclScopeError(
          `Tailscale API POST /tailnet/-/acl failed (${res.status}): ${text.slice(0, 400)}`,
        ),
      );
    }
  }

  private formatAclScopeError(message: string): string {
    if (!/403|401|forbidden|scope|permission|acl|policy/i.test(message)) {
      return message;
    }
    return [
      message,
      "",
      "写入 ACL 需要 OAuth Client 具备 Policy file（acl）写权限。",
      "请到 Tailscale Trust credentials 编辑该 Client，勾选 Policy file → Write，然后重试。",
      "注意：即便 ACL 中已创建 tag，仍须在 OAuth Client 上勾选该 tag 后才能生成 Auth Key。",
    ].join("\n");
  }
}
