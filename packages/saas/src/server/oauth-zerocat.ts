import { and, eq, lt } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { RegisterError, registerSaasUser, type RegisterSchema } from "./register-user.js";

export const ZEROCAT_PROVIDER = "zerocat" as const;

export const ZEROCAT_DEFAULTS = {
  authorizeUrl: "https://api.zcservice.houlang.cloud/oauth/authorize",
  tokenUrl: "https://api.zcservice.houlang.cloud/oauth/token",
  userinfoUrl: "https://api.zcservice.houlang.cloud/oauth/userinfo",
  scope: "user:read",
} as const;

export const OAUTH_SETTINGS_KEY = "auth.oauth.zerocat";

export type ZerocatOauthStoredConfig = {
  enabled: boolean;
  clientId: string;
  clientSecretEnc: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  allowRegistration: boolean;
  /** 启用 ZeroCat 后可关闭邮箱密码登录，仅保留 ZeroCat */
  disablePasswordLogin: boolean;
};

export type ZerocatOauthPublicConfig = {
  enabled: boolean;
  clientId: string;
  hasClientSecret: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  allowRegistration: boolean;
  disablePasswordLogin: boolean;
  redirectUri: string;
};

export type ZerocatOauthPatch = {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  scope?: string;
  allowRegistration?: boolean;
  disablePasswordLogin?: boolean;
};

export type ZerocatUserinfo = {
  openid: string;
  username?: string;
  nickname?: string;
  avatar?: string;
  email?: string | boolean | null;
  email_verified?: boolean;
};

export type OauthSchema = RegisterSchema & {
  oauthIdentities: unknown;
  oauthLoginStates: unknown;
  settings: { ownerKey: unknown; key: unknown };
};

export type ZerocatOauthDeps = {
  db: unknown;
  schema: OauthSchema;
  secret: string;
  webPublicUrl: string;
  encryptJson: (secret: string, value: unknown) => string;
  decryptJson: <T = unknown>(secret: string, payload: string) => T;
  onTenantCreated?: (tenantId: string) => Promise<void>;
};

export type OauthLoginResult = {
  user: { id: string; email: string; name: string | null; isPlatformAdmin?: boolean };
  tenant: { id: string; slug: string; name: string; onboardingCompleted: boolean };
  membership: { role: string };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function defaultStored(): ZerocatOauthStoredConfig {
  return {
    enabled: false,
    clientId: "",
    clientSecretEnc: "",
    authorizeUrl: ZEROCAT_DEFAULTS.authorizeUrl,
    tokenUrl: ZEROCAT_DEFAULTS.tokenUrl,
    userinfoUrl: ZEROCAT_DEFAULTS.userinfoUrl,
    scope: ZEROCAT_DEFAULTS.scope,
    allowRegistration: true,
    disablePasswordLogin: false,
  };
}

function resolveEmail(profile: ZerocatUserinfo): string | null {
  if (typeof profile.email === "string" && profile.email.includes("@")) {
    return profile.email.trim().toLowerCase();
  }
  if (profile.username?.trim()) {
    return `${profile.username.trim().toLowerCase()}@zerocat.oauth`;
  }
  if (profile.openid?.trim()) {
    const safe = profile.openid.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
    return `${safe}@zerocat.oauth`;
  }
  return null;
}

function resolveDisplayName(profile: ZerocatUserinfo): string {
  return (
    profile.nickname?.trim() ||
    profile.username?.trim() ||
    (typeof profile.email === "string" ? profile.email.split("@")[0] : "") ||
    "ZeroCat User"
  );
}

export function redirectUriFor(webPublicUrl: string): string {
  return `${webPublicUrl.replace(/\/$/, "")}/console/oauth/zerocat/callback`;
}

export async function loadZerocatConfig(
  deps: Pick<ZerocatOauthDeps, "db" | "schema" | "secret" | "webPublicUrl" | "decryptJson">,
): Promise<{
  stored: ZerocatOauthStoredConfig;
  public: ZerocatOauthPublicConfig;
  clientSecret: string | null;
}> {
  const db = deps.db as AnyDb;
  const settings = deps.schema.settings as AnyDb;
  let stored = defaultStored();

  const rows = await db
    .select()
    .from(settings)
    .where(and(eq(settings.ownerKey, "platform"), eq(settings.key, OAUTH_SETTINGS_KEY)));
  const row = rows[0] as { value?: string } | undefined;
  if (row?.value) {
    try {
      stored = { ...defaultStored(), ...(JSON.parse(row.value) as Partial<ZerocatOauthStoredConfig>) };
    } catch {
      /* keep defaults */
    }
  }

  let clientSecret: string | null = null;
  if (stored.clientSecretEnc) {
    try {
      clientSecret = deps.decryptJson<string>(deps.secret, stored.clientSecretEnc);
    } catch {
      clientSecret = null;
    }
  }

  return {
    stored,
    clientSecret,
    public: {
      enabled: !!(stored.enabled && stored.clientId && clientSecret),
      clientId: stored.clientId,
      hasClientSecret: !!clientSecret,
      authorizeUrl: stored.authorizeUrl || ZEROCAT_DEFAULTS.authorizeUrl,
      tokenUrl: stored.tokenUrl || ZEROCAT_DEFAULTS.tokenUrl,
      userinfoUrl: stored.userinfoUrl || ZEROCAT_DEFAULTS.userinfoUrl,
      scope: stored.scope || ZEROCAT_DEFAULTS.scope,
      allowRegistration: stored.allowRegistration !== false,
      // 仅当 ZeroCat 实际可用时，禁止邮箱登录才生效
      disablePasswordLogin: !!(
        stored.disablePasswordLogin &&
        stored.enabled &&
        stored.clientId &&
        clientSecret
      ),
      redirectUri: redirectUriFor(deps.webPublicUrl),
    },
  };
}

export async function saveZerocatConfig(
  deps: ZerocatOauthDeps,
  patch: ZerocatOauthPatch,
): Promise<ZerocatOauthPublicConfig> {
  const { stored } = await loadZerocatConfig(deps);
  const db = deps.db as AnyDb;
  const settings = deps.schema.settings as AnyDb;

  const next: ZerocatOauthStoredConfig = {
    enabled: patch.enabled ?? stored.enabled,
    clientId: patch.clientId !== undefined ? patch.clientId.trim() : stored.clientId,
    clientSecretEnc: stored.clientSecretEnc,
    authorizeUrl:
      patch.authorizeUrl !== undefined
        ? patch.authorizeUrl.trim() || ZEROCAT_DEFAULTS.authorizeUrl
        : stored.authorizeUrl,
    tokenUrl:
      patch.tokenUrl !== undefined
        ? patch.tokenUrl.trim() || ZEROCAT_DEFAULTS.tokenUrl
        : stored.tokenUrl,
    userinfoUrl:
      patch.userinfoUrl !== undefined
        ? patch.userinfoUrl.trim() || ZEROCAT_DEFAULTS.userinfoUrl
        : stored.userinfoUrl,
    scope: patch.scope !== undefined ? patch.scope.trim() || ZEROCAT_DEFAULTS.scope : stored.scope,
    allowRegistration: patch.allowRegistration ?? stored.allowRegistration,
    disablePasswordLogin: patch.disablePasswordLogin ?? stored.disablePasswordLogin,
  };

  if (patch.clientSecret !== undefined && patch.clientSecret.trim()) {
    next.clientSecretEnc = deps.encryptJson(deps.secret, patch.clientSecret.trim());
  }

  // 关闭 ZeroCat 时强制恢复邮箱登录；开启「禁止邮箱」时要求 ZeroCat 可用
  if (!next.enabled) {
    next.disablePasswordLogin = false;
  } else if (next.disablePasswordLogin) {
    const secretReady = !!(
      next.clientSecretEnc ||
      (patch.clientSecret !== undefined && patch.clientSecret.trim())
    );
    if (!next.clientId.trim() || !secretReady) {
      throw new Error("禁止邮箱登录前请先配置并启用可用的 ZeroCat OAuth（Client ID / Secret）");
    }
  }

  await db
    .insert(settings)
    .values({
      id: deps.schema.newId(),
      ownerKey: "platform",
      key: OAUTH_SETTINGS_KEY,
      value: JSON.stringify(next),
    })
    .onConflictDoUpdate({
      target: [settings.ownerKey, settings.key],
      set: { value: JSON.stringify(next) },
    });

  return (await loadZerocatConfig(deps)).public;
}

export async function startZerocatOauth(
  deps: ZerocatOauthDeps,
): Promise<{ authorizeUrl: string }> {
  const { public: pub, clientSecret, stored } = await loadZerocatConfig(deps);
  if (!stored.enabled || !stored.clientId || !clientSecret) {
    throw new RegisterError("ZeroCat OAuth 尚未配置或未启用", 400);
  }

  const state = randomBytes(24).toString("base64url");
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const db = deps.db as AnyDb;
  const statesTable = deps.schema.oauthLoginStates as AnyDb;

  await db.delete(statesTable).where(lt(statesTable.expiresAt, new Date())).catch(() => undefined);
  await db.insert(statesTable).values({
    id: state,
    provider: ZEROCAT_PROVIDER,
    codeVerifier: verifier,
    expiresAt,
  });

  const url = new URL(pub.authorizeUrl);
  url.searchParams.set("client_id", stored.clientId);
  url.searchParams.set("redirect_uri", pub.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", pub.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return { authorizeUrl: url.toString() };
}

export async function completeZerocatOauth(
  deps: ZerocatOauthDeps,
  input: { code: string; state: string },
): Promise<OauthLoginResult> {
  const { public: pub, clientSecret, stored } = await loadZerocatConfig(deps);
  if (!stored.enabled || !stored.clientId || !clientSecret) {
    throw new RegisterError("ZeroCat OAuth 尚未配置或未启用", 400);
  }
  if (!input.code?.trim() || !input.state?.trim()) {
    throw new RegisterError("code and state required", 400);
  }

  const db = deps.db as AnyDb;
  const oauthLoginStates = deps.schema.oauthLoginStates as AnyDb;
  const oauthIdentities = deps.schema.oauthIdentities as AnyDb;
  const users = deps.schema.users as AnyDb;
  const tenants = deps.schema.tenants as AnyDb;
  const tenantMemberships = deps.schema.tenantMemberships as AnyDb;

  const stateRows = await db
    .select()
    .from(oauthLoginStates)
    .where(eq(oauthLoginStates.id, input.state));
  const stateRow = stateRows[0] as
    | { id: string; codeVerifier: string; expiresAt: Date }
    | undefined;

  if (!stateRow) throw new RegisterError("无效或已过期的 OAuth state", 400);
  if (new Date(stateRow.expiresAt) < new Date()) {
    await db.delete(oauthLoginStates).where(eq(oauthLoginStates.id, input.state));
    throw new RegisterError("OAuth state 已过期", 400);
  }
  await db.delete(oauthLoginStates).where(eq(oauthLoginStates.id, input.state));

  const tokenRes = await fetch(pub.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code.trim(),
      client_id: stored.clientId,
      client_secret: clientSecret,
      redirect_uri: pub.redirectUri,
      code_verifier: stateRow.codeVerifier,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new RegisterError(
      tokenJson.error_description || tokenJson.error || `令牌交换失败 (${tokenRes.status})`,
      400,
    );
  }

  const infoRes = await fetch(pub.userinfoUrl, {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  const profile = (await infoRes.json().catch(() => ({}))) as ZerocatUserinfo;
  if (!infoRes.ok || !profile.openid) {
    throw new RegisterError("获取 ZeroCat 用户信息失败", 400);
  }

  const identityRows = await db
    .select()
    .from(oauthIdentities)
    .where(
      and(
        eq(oauthIdentities.provider, ZEROCAT_PROVIDER),
        eq(oauthIdentities.providerUserId, profile.openid),
      ),
    );
  const existingIdentity = identityRows[0] as { id: string; userId: string } | undefined;
  const now = new Date();
  const profileJson = JSON.stringify(profile);

  let userId: string;
  if (existingIdentity) {
    userId = existingIdentity.userId;
    await db
      .update(oauthIdentities)
      .set({ profileJson, updatedAt: now })
      .where(eq(oauthIdentities.id, existingIdentity.id));
  } else {
    const email = resolveEmail(profile);
    if (!email) throw new RegisterError("ZeroCat 资料缺少可用身份标识", 400);

    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      userId = existingUser.id;
      await db.insert(oauthIdentities).values({
        id: deps.schema.newId(),
        provider: ZEROCAT_PROVIDER,
        providerUserId: profile.openid,
        userId,
        profileJson,
        createdAt: now,
        updatedAt: now,
      });
      if (!existingUser.name) {
        await db
          .update(users)
          .set({ name: resolveDisplayName(profile), updatedAt: now })
          .where(eq(users.id, userId));
      }
    } else if (!stored.allowRegistration) {
      throw new RegisterError("该 ZeroCat 账号尚未关联 Zakura 用户，请先注册或联系管理员", 403);
    } else {
      const result = await registerSaasUser(db, deps.schema, {
        email,
        password: randomBytes(32).toString("base64url"),
        name: resolveDisplayName(profile),
      });
      await db
        .update(users)
        .set({ passwordHash: null, updatedAt: now })
        .where(eq(users.id, result.user.id));
      await db.insert(oauthIdentities).values({
        id: deps.schema.newId(),
        provider: ZEROCAT_PROVIDER,
        providerUserId: profile.openid,
        userId: result.user.id,
        profileJson,
        createdAt: now,
        updatedAt: now,
      });
      await deps.onTenantCreated?.(result.tenant.id).catch(() => undefined);
      return {
        user: result.user,
        tenant: result.tenant,
        membership: result.membership,
      };
    }
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new RegisterError("OAuth 关联后未找到用户", 500);

  const memberships = await db
    .select({
      membership: tenantMemberships,
      tenant: tenants,
    })
    .from(tenantMemberships)
    .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
    .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, "active")));

  if (memberships.length === 0) {
    throw new RegisterError("账号尚未加入任何租户", 403);
  }

  const picked = memberships[0] as {
    membership: { role: string };
    tenant: { id: string; slug: string; name: string; onboardingCompleted: boolean };
  };

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isPlatformAdmin: user.isPlatformAdmin,
    },
    tenant: picked.tenant,
    membership: picked.membership,
  };
}
