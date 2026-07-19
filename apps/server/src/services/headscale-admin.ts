/**
 * Headscale REST API client for platform-managed Tailscale mesh.
 *
 * Auth: Authorization: Bearer <API_KEY>
 * Docs: https://headscale.net/stable/ref/api/
 */

export type HeadscaleUser = {
  id: string;
  name: string;
  createdAt?: string;
  displayName?: string;
  email?: string;
};

export type HeadscaleNode = {
  id: string;
  name: string;
  givenName?: string;
  hostname: string;
  addresses: string[];
  tags: string[];
  online: boolean;
  user?: string;
  userId?: string;
  os?: string;
  lastSeen?: string;
  expiry?: string;
};

export type HeadscalePreAuthKey = {
  id: string;
  key: string;
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiration?: string;
  createdAt?: string;
  aclTags: string[];
  user?: HeadscaleUser | null;
};

export type HeadscaleAdminConfig = {
  /** Public HTTPS login-server URL, e.g. https://headscale.example.com */
  url: string;
  apiKey: string;
};

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function tenantUserName(tenantId: string): string {
  const safe = tenantId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // Headscale ACL aliases require users to contain "@"
  return `tenant-${safe || "default"}@`;
}

export function headscaleTenantUserName(tenantId: string): string {
  return tenantUserName(tenantId);
}

export const HEADSCALE_PLATFORM_USER = "platform@";
export const HEADSCALE_PLATFORM_TAG = "tag:platform";

export class HeadscaleAdminClient {
  readonly loginServer: string;
  private readonly apiKey: string;
  private readonly apiBase: string;

  constructor(cfg: HeadscaleAdminConfig) {
    this.loginServer = normalizeBase(cfg.url);
    this.apiKey = cfg.apiKey.trim();
    this.apiBase = `${this.loginServer}/api/v1`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = { raw: text };
      }
    }
    if (!res.ok) {
      const msg =
        json && typeof json === "object" && "message" in json
          ? String((json as { message: unknown }).message)
          : json && typeof json === "object" && "error" in json
            ? String((json as { error: unknown }).error)
            : text || res.statusText;
      throw new Error(`Headscale API ${method} ${path}: ${res.status} ${msg}`);
    }
    return json as T;
  }

  async listUsers(): Promise<HeadscaleUser[]> {
    const data = await this.request<{ users?: HeadscaleUser[]; user?: HeadscaleUser[] }>(
      "GET",
      "/user",
    );
    return data.users ?? data.user ?? [];
  }

  async getUserByName(name: string): Promise<HeadscaleUser | null> {
    const data = await this.request<{
      users?: HeadscaleUser[];
      user?: HeadscaleUser | HeadscaleUser[];
    }>("GET", `/user?name=${encodeURIComponent(name)}`);
    if (Array.isArray(data.users) && data.users.length) return data.users[0]!;
    if (Array.isArray(data.user) && data.user.length) return data.user[0]!;
    if (data.user && !Array.isArray(data.user) && data.user.id) return data.user;
    // Fallback: list and filter
    const all = await this.listUsers();
    return all.find((u) => u.name === name) ?? null;
  }

  async createUser(name: string): Promise<HeadscaleUser> {
    const data = await this.request<{ user: HeadscaleUser }>("POST", "/user", {
      name,
    });
    return data.user;
  }

  /** Ensure Headscale user `tenant-<tenantId>` exists. */
  async ensureTenantUser(tenantId: string): Promise<HeadscaleUser> {
    const name = tenantUserName(tenantId);
    const existing = await this.getUserByName(name);
    if (existing) return existing;
    try {
      return await this.createUser(name);
    } catch (err) {
      // Race: another request created it
      const again = await this.getUserByName(name);
      if (again) return again;
      throw err;
    }
  }

  /** Ensure the platform control-plane user exists. */
  async ensurePlatformUser(): Promise<HeadscaleUser> {
    const existing = await this.getUserByName(HEADSCALE_PLATFORM_USER);
    if (existing) return existing;
    try {
      return await this.createUser(HEADSCALE_PLATFORM_USER);
    } catch (err) {
      const again = await this.getUserByName(HEADSCALE_PLATFORM_USER);
      if (again) return again;
      throw err;
    }
  }

  async createPreAuthKey(opts: {
    /** Numeric user id as string, or omit when using aclTags only */
    userId?: string;
    reusable?: boolean;
    ephemeral?: boolean;
    /** ISO expiration; default +90d */
    expiration?: string;
    aclTags?: string[];
  }): Promise<HeadscalePreAuthKey> {
    const expiration =
      opts.expiration ??
      new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const body: Record<string, unknown> = {
      reusable: opts.reusable ?? true,
      ephemeral: opts.ephemeral ?? false,
      expiration,
    };
    if (opts.userId) body.user = String(opts.userId);
    if (opts.aclTags?.length) body.aclTags = opts.aclTags;

    const data = await this.request<{ preAuthKey: HeadscalePreAuthKey }>(
      "POST",
      "/preauthkey",
      body,
    );
    return data.preAuthKey;
  }

  /** Preauth for a tenant Runner (user-owned, no tags — autogroup:self). */
  async createTenantPreAuthKey(
    tenantId: string,
    opts?: { reusable?: boolean; ephemeral?: boolean; expirySeconds?: number },
  ): Promise<HeadscalePreAuthKey> {
    const user = await this.ensureTenantUser(tenantId);
    const expirySeconds = opts?.expirySeconds ?? 90 * 24 * 3600;
    return this.createPreAuthKey({
      userId: user.id,
      reusable: opts?.reusable ?? true,
      ephemeral: opts?.ephemeral ?? false,
      expiration: new Date(Date.now() + expirySeconds * 1000).toISOString(),
      // no aclTags — keep user identity for autogroup:self
    });
  }

  /** Preauth for Zakura Server host (tag:platform). */
  async createPlatformPreAuthKey(opts?: {
    reusable?: boolean;
    expirySeconds?: number;
  }): Promise<HeadscalePreAuthKey> {
    const user = await this.ensurePlatformUser();
    const expirySeconds = opts?.expirySeconds ?? 365 * 24 * 3600;
    return this.createPreAuthKey({
      userId: user.id,
      reusable: opts?.reusable ?? true,
      ephemeral: false,
      expiration: new Date(Date.now() + expirySeconds * 1000).toISOString(),
      aclTags: [HEADSCALE_PLATFORM_TAG],
    });
  }

  async listNodes(userId?: string): Promise<HeadscaleNode[]> {
    const q = userId ? `?user=${encodeURIComponent(userId)}` : "";
    const data = await this.request<{ nodes?: unknown[]; node?: unknown[] }>(
      "GET",
      `/node${q}`,
    );
    const raw = data.nodes ?? data.node ?? [];
    return raw.map((n) => this.normalizeNode(n));
  }

  async listTenantNodes(tenantId: string): Promise<HeadscaleNode[]> {
    const user = await this.ensureTenantUser(tenantId);
    return this.listNodes(user.id);
  }

  async deleteNode(nodeId: string): Promise<void> {
    await this.request("DELETE", `/node/${encodeURIComponent(nodeId)}`);
  }

  async expirePreAuthKey(opts: { userId: string; key: string }): Promise<void> {
    await this.request("POST", "/preauthkey/expire", {
      user: opts.userId,
      key: opts.key,
    });
  }

  /** Probe connectivity / version. */
  async probe(): Promise<{ ok: true; userCount: number; nodeCount: number }> {
    const users = await this.listUsers();
    const nodes = await this.listNodes();
    return { ok: true, userCount: users.length, nodeCount: nodes.length };
  }

  private normalizeNode(raw: unknown): HeadscaleNode {
    const n = (raw ?? {}) as Record<string, unknown>;
    const userObj =
      n.user && typeof n.user === "object"
        ? (n.user as Record<string, unknown>)
        : null;
    const addresses = Array.isArray(n.ipAddresses)
      ? (n.ipAddresses as string[])
      : Array.isArray(n.addresses)
        ? (n.addresses as string[])
        : [];
    const tags = Array.isArray(n.tags)
      ? (n.tags as string[])
      : Array.isArray(n.forcedTags)
        ? (n.forcedTags as string[])
        : [];
    const name =
      String(n.name ?? n.givenName ?? n.hostname ?? n.id ?? "node");
    return {
      id: String(n.id ?? ""),
      name,
      givenName: n.givenName != null ? String(n.givenName) : undefined,
      hostname: String(n.hostname ?? n.givenName ?? name),
      addresses,
      tags,
      online: Boolean(n.online ?? n.connected),
      user: userObj?.name != null ? String(userObj.name) : undefined,
      userId: userObj?.id != null ? String(userObj.id) : undefined,
      os: n.os != null ? String(n.os) : undefined,
      lastSeen: n.lastSeen != null ? String(n.lastSeen) : undefined,
      expiry: n.expiry != null ? String(n.expiry) : undefined,
    };
  }
}

